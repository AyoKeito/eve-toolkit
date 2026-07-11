import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { contractScanRegions, esiFetchConcurrency } from "../config.js";
import { createEsiClient, getAllPages, isEsiClientError, type EsiClient } from "../lib/esi.js";
import { runFetcher } from "../lib/fetcher.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { rebuildContractPrices } from "../calc/contract-prices.js";
import { hashFit } from "./killmails.js";

/**
 * Public-contracts fetcher. Each cycle: page the
 * region listing (30-min ESI cache), diff against known contracts to detect
 * disappearances, fetch items once for new item_exchange contracts (contents are
 * immutable; 404 = vanished between listing and fetch), then rebuild the
 * contract_prices rollup. Couriers are skipped at ingest; auctions are recorded
 * but never priced in v1 (price is a starting bid, not an ask).
 */

interface EsiPublicContract {
  contract_id: number;
  type?: string;
  price?: number;
  date_issued?: string;
  date_expired?: string;
  start_location_id?: number;
}

interface EsiContractItem {
  is_included?: boolean;
  is_blueprint_copy?: boolean;
  quantity?: number;
  record_id?: number;
  runs?: number;
  material_efficiency?: number;
  time_efficiency?: number;
  type_id?: number;
}

export interface ContractsFetchSummary {
  contracts_listed: number;
  new_contracts: number;
  gone_marked: number;
  items_fetched: number;
  items_vanished: number;
  /** Per-contract fetch errors left for retry on the next cycle. */
  items_failed: number;
  priced_types: number;
}

/** A contract that vanishes well before expiry was probably accepted (sold);
 * one withdrawn or expiring naturally was not. 6h buffer absorbs clock skew
 * and the listing cache window. */
const goneBeforeExpiryBufferMs = 6 * 60 * 60 * 1000;

function goneBeforeExpiry(dateExpired: string, nowMs: number): number {
  const expiry = Date.parse(dateExpired);
  return Number.isFinite(expiry) && expiry - nowMs > goneBeforeExpiryBufferMs ? 1 : 0;
}

async function fetchRegionPages(esi: EsiClient, regionId: number): Promise<EsiPublicContract[]> {
  return getAllPages<EsiPublicContract>(
    esi,
    (page) => `/latest/contracts/public/${regionId}/?datasource=tranquility&page=${page}`
  );
}

async function fetchContractItems(esi: EsiClient, contractId: number): Promise<EsiContractItem[]> {
  return getAllPages<EsiContractItem>(
    esi,
    (page) => `/latest/contracts/public/items/${contractId}/?datasource=tranquility&page=${page}`,
    { store: false },
    // Item-less / expired contracts legitimately 204 here; tolerate empty pages
    // rather than aborting (the region-listing scan keeps the fail-closed default).
    { allowEmptyPages: true }
  );
}

interface ItemsDenormalization {
  hasExcluded: boolean;
  singleType: { typeId: number; quantity: number; isBpc: boolean; runs: number | null } | null;
}

/** Single-TYPE rule: all included lines share one type_id ("3x same BPC" bundles
 * count, unit price = price / total copies); BPC lines must agree on runs. */
export function denormalizeItems(items: EsiContractItem[]): ItemsDenormalization {
  const included = items.filter((item) => item.is_included !== false && typeof item.type_id === "number");
  const excluded = items.filter((item) => item.is_included === false);
  const typeIds = new Set(included.map((item) => item.type_id));
  if (included.length === 0 || typeIds.size !== 1) {
    return { hasExcluded: excluded.length > 0, singleType: null };
  }
  const isBpc = included.some((item) => item.is_blueprint_copy === true);
  const runsSet = new Set(included.map((item) => item.runs ?? null));
  if (isBpc && runsSet.size !== 1) {
    return { hasExcluded: excluded.length > 0, singleType: null };
  }
  const quantity = included.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  return {
    hasExcluded: excluded.length > 0,
    singleType: {
      typeId: included[0]!.type_id!,
      quantity: quantity > 0 ? quantity : 1,
      isBpc,
      runs: included[0]!.runs ?? null
    }
  };
}

/**
 * Category-based fit fingerprint for a fitted-ship contract — the supply side of the /fits/
 * competition check. A public contract's items carry NO slot flags (unlike a killmail), so the
 * fitted set is identified by CATEGORY: exactly one single-unit hull (cat 6) plus its modules/rigs
 * (cat 7) and subsystems (cat 32); charges (8), drones (18) and anything in cargo we cannot
 * distinguish are excluded. For a CLEAN pre-fit this aggregates to the same (hull, type:qty) map a
 * killmail of the same ship produces, so `hashFit` yields an IDENTICAL fit_hash. A build-kit (hull
 * + spare modules in cargo) simply hashes to something no killmail matches — conservative, never a
 * false match. Returns null unless there is exactly one single-unit hull among the included items.
 */
export function computeContractFit(
  items: EsiContractItem[],
  category: (typeId: number) => number | undefined
): { fitHash: string; shipTypeId: number } | null {
  const included = items.filter((item) => item.is_included !== false && typeof item.type_id === "number");
  const hulls = included.filter((item) => category(item.type_id!) === 6);
  if (hulls.length !== 1) return null; // 0 hulls (e.g. a BPC ask) or a multi-ship bundle
  const hull = hulls[0]!;
  if ((hull.quantity ?? 1) !== 1) return null; // multiple copies of the hull — not a single pre-fit
  const byType = new Map<number, number>();
  for (const item of included) {
    if (item === hull) continue;
    const cat = category(item.type_id!);
    if (cat !== 7 && cat !== 32) continue; // keep modules/rigs + subsystems; drop charges/drones/cargo
    byType.set(item.type_id!, (byType.get(item.type_id!) ?? 0) + (item.quantity ?? 1));
  }
  const { fitHash } = hashFit(hull.type_id!, byType);
  return { fitHash, shipTypeId: hull.type_id! };
}

export async function fetchContracts(db: Db): Promise<ContractsFetchSummary> {
  const esi = createEsiClient(db);
  return runFetcher(db, "esi-contracts", async () => {
    const summary: ContractsFetchSummary = {
      contracts_listed: 0,
      new_contracts: 0,
      gone_marked: 0,
      items_fetched: 0,
      items_vanished: 0,
      items_failed: 0,
      priced_types: 0
    };
    let firstItemsError: unknown = null;

    const upsert = db.prepare(`
      INSERT INTO contracts(
        contract_id, region_id, contract_type, price, date_issued, date_expired,
        start_location_id, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contract_id) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,
        gone_at=NULL,
        gone_before_expiry=NULL
    `);
    const markGone = db.prepare("UPDATE contracts SET gone_at=?, gone_before_expiry=? WHERE contract_id=?");
    const markVanishedBeforeItems = db.prepare(
      "UPDATE contracts SET gone_at=?, gone_before_expiry=?, items_fetched=1 WHERE contract_id=?"
    );
    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO contract_items(
        contract_id, record_id, type_id, quantity, is_included, is_blueprint_copy, runs, me, te
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const finishItems = db.prepare(`
      UPDATE contracts SET
        items_fetched=1,
        single_item_type_id=?,
        single_item_quantity=?,
        single_item_is_bpc=?,
        single_item_runs=?,
        has_excluded_items=?,
        fit_hash=?,
        fit_ship_type_id=?
      WHERE contract_id=?
    `);

    // Type -> category lookup for fit fingerprinting, loaded once. Only ship/module/subsystem
    // categories matter (6 hull, 7 modules+rigs, 32 subsystems); everything else reads undefined
    // and is correctly dropped from the fit. Cheap: ~few thousand rows.
    const fitCategoryByType = new Map<number, number>(
      (
        db.prepare("SELECT type_id, category_id FROM types WHERE category_id IN (6, 7, 32)").all() as Array<{
          type_id: number;
          category_id: number;
        }>
      ).map((row) => [row.type_id, row.category_id])
    );
    const categoryOf = (typeId: number): number | undefined => fitCategoryByType.get(typeId);

    for (const regionId of contractScanRegions()) {
      const listed = (await fetchRegionPages(esi, regionId)).filter(
        (contract) => Number.isInteger(contract.contract_id) && contract.type !== "courier"
      );
      summary.contracts_listed += listed.length;
      const nowTs = nowIso();
      const nowMs = Date.parse(nowTs);

      const known = new Set(
        (db.prepare("SELECT contract_id FROM contracts WHERE region_id=?").all(regionId) as Array<{ contract_id: number }>).map(
          (row) => row.contract_id
        )
      );
      const active = (
        db.prepare("SELECT contract_id, date_expired FROM contracts WHERE region_id=? AND gone_at IS NULL").all(regionId) as Array<{
          contract_id: number;
          date_expired: string;
        }>
      );

      const listedIds = new Set(listed.map((contract) => contract.contract_id));
      const upsertTx = db.transaction(() => {
        for (const contract of listed) {
          if (!known.has(contract.contract_id)) summary.new_contracts += 1;
          upsert.run(
            contract.contract_id,
            regionId,
            contract.type ?? "unknown",
            contract.price ?? 0,
            contract.date_issued ?? nowTs,
            contract.date_expired ?? nowTs,
            contract.start_location_id ?? null,
            nowTs,
            nowTs
          );
        }
        for (const row of active) {
          if (listedIds.has(row.contract_id)) continue;
          markGone.run(nowTs, goneBeforeExpiry(row.date_expired, nowMs), row.contract_id);
          summary.gone_marked += 1;
        }
      });
      upsertTx();

      const pending = db
        .prepare(
          `
        SELECT contract_id, date_expired FROM contracts
        WHERE region_id=? AND gone_at IS NULL AND contract_type='item_exchange' AND items_fetched=0
        ORDER BY contract_id
      `
        )
        .all(regionId) as Array<{ contract_id: number; date_expired: string }>;

      // Chunked fetch + persist: a 34k-contract initial sweep must keep its progress
      // when one contract misbehaves. Per-contract errors are skipped (retried next
      // cycle); the run only fails when nothing succeeds at all.
      const chunkSize = 500;
      for (let offset = 0; offset < pending.length; offset += chunkSize) {
        const chunk = pending.slice(offset, offset + chunkSize);
        const fetched = await mapWithConcurrency(chunk, esiFetchConcurrency(), async (row) => {
          try {
            return { row, items: await fetchContractItems(esi, row.contract_id) };
          } catch (error) {
            if (isEsiClientError(error, 404)) return { row, items: null };
            if (firstItemsError === null) firstItemsError = error;
            summary.items_failed += 1;
            return { row, items: undefined };
          }
        });

        const itemsTx = db.transaction(() => {
          const itemsNowTs = nowIso();
          const itemsNowMs = Date.parse(itemsNowTs);
          for (const result of fetched) {
            if (result.items === undefined) continue;
            if (result.items === null) {
              markVanishedBeforeItems.run(itemsNowTs, goneBeforeExpiry(result.row.date_expired, itemsNowMs), result.row.contract_id);
              summary.items_vanished += 1;
              continue;
            }
            for (const [index, item] of result.items.entries()) {
              if (typeof item.type_id !== "number") continue;
              insertItem.run(
                result.row.contract_id,
                item.record_id ?? index,
                item.type_id,
                item.quantity ?? 1,
                item.is_included === false ? 0 : 1,
                item.is_blueprint_copy === true ? 1 : 0,
                item.runs ?? null,
                item.material_efficiency ?? null,
                item.time_efficiency ?? null
              );
            }
            const denorm = denormalizeItems(result.items);
            const fit = computeContractFit(result.items, categoryOf);
            finishItems.run(
              denorm.singleType?.typeId ?? null,
              denorm.singleType?.quantity ?? null,
              denorm.singleType ? (denorm.singleType.isBpc ? 1 : 0) : null,
              denorm.singleType?.runs ?? null,
              denorm.hasExcluded ? 1 : 0,
              fit?.fitHash ?? null,
              fit?.shipTypeId ?? null,
              result.row.contract_id
            );
            summary.items_fetched += 1;
          }
        });
        itemsTx();
      }
    }

    if (firstItemsError !== null && summary.items_fetched === 0 && summary.items_failed > 0) {
      throw firstItemsError;
    }

    pruneGoneContracts(db);
    summary.priced_types = rebuildContractPrices(db);
    return summary;
  });
}

function pruneGoneContracts(db: Db, now = new Date()): void {
  // FK cascade is on in prod but off in raw test DBs — delete items explicitly.
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM contract_items WHERE contract_id IN (SELECT contract_id FROM contracts WHERE gone_at < ?)").run(cutoff);
  db.prepare("DELETE FROM contracts WHERE gone_at < ?").run(cutoff);
}
