import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { getBlueprintRecipe } from "../calc/manufacture.js";
import { isEsiClientError, createEsiClient } from "../lib/esi.js";
import { runFetcher } from "../lib/fetcher.js";

interface EsiRequiredItem {
  type_id?: number;
  item_type_id?: number;
  quantity: number;
}

interface EsiLpOffer {
  offer_id: number;
  type_id: number;
  quantity: number;
  lp_cost: number;
  isk_cost: number;
  required_items?: EsiRequiredItem[];
  ak_cost?: number;
}

export async function fetchLpOffers(db: Db): Promise<number> {
  const esi = createEsiClient(db);
  const corps = db.prepare("SELECT corp_id FROM corporations WHERE has_lp_store=1 AND has_earnable_lp_source=1 ORDER BY corp_id").all() as {
    corp_id: number;
  }[];
  const fetchedAt = nowIso();
  let count = 0;

  const upsertOffer = db.prepare(`
    INSERT INTO offers(offer_id, esi_offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(offer_id) DO UPDATE SET
      esi_offer_id=excluded.esi_offer_id,
      corp_id=excluded.corp_id,
      lp_cost=excluded.lp_cost,
      isk_cost=excluded.isk_cost,
      fetched_at=excluded.fetched_at,
      raw_json=excluded.raw_json
  `);
  const deleteProducts = db.prepare("DELETE FROM offer_products WHERE offer_id=?");
  const deleteRequired = db.prepare("DELETE FROM offer_required_items WHERE offer_id=?");
  const deleteMarketTypes = db.prepare("DELETE FROM offer_market_types WHERE offer_id=?");
  const deleteCorpOffers = db.prepare("DELETE FROM offers WHERE corp_id=?");
  const insertProduct = db.prepare("INSERT OR REPLACE INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)");
  const insertRequired = db.prepare("INSERT OR REPLACE INTO offer_required_items(offer_id, type_id, quantity) VALUES (?, ?, ?)");
  const insertMarketType = db.prepare("INSERT OR IGNORE INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, ?)");
  const insertMeta = db.prepare(`
    INSERT INTO offer_meta(offer_id, required_standing, is_fw)
    VALUES (?, NULL, 0)
    ON CONFLICT(offer_id) DO NOTHING
  `);

  const persist = db.transaction((corpId: number, offers: EsiLpOffer[]) => {
    if (offers.length === 0) return;
    deleteCorpOffers.run(corpId);
    for (const offer of offers) {
      const offerId = corpId * 1_000_000 + offer.offer_id;
      upsertOffer.run(offerId, offer.offer_id, corpId, offer.lp_cost, offer.isk_cost, fetchedAt, JSON.stringify(offer));
      deleteProducts.run(offerId);
      deleteRequired.run(offerId);
      deleteMarketTypes.run(offerId);
      insertProduct.run(offerId, offer.type_id, offer.quantity);
      insertMarketType.run(offerId, offer.type_id, "PRODUCT");
      const recipe = getBlueprintRecipe(db, offer.type_id);
      if (recipe) {
        insertMarketType.run(offerId, recipe.product_type_id, "BUILD_PRODUCT");
        for (const material of recipe.materials) {
          insertMarketType.run(offerId, material.type_id, "BUILD_MATERIAL");
        }
      }
      for (const item of offer.required_items ?? []) {
        const typeId = item.type_id ?? item.item_type_id;
        if (typeId) {
          insertRequired.run(offerId, typeId, item.quantity);
          insertMarketType.run(offerId, typeId, "REQUIRED_ITEM");
        }
      }
      insertMeta.run(offerId);
      count += 1;
    }
  });

  return runFetcher(db, "esi-lp", async () => {
    for (const corp of corps) {
      try {
        const offers = await esi.getJson<EsiLpOffer[]>(`/latest/loyalty/stores/${corp.corp_id}/offers/?datasource=tranquility`);
        persist(corp.corp_id, offers);
      } catch (error) {
        if (isEsiClientError(error, 400, 404)) continue;
        throw error;
      }
    }
    return count;
  });
}
