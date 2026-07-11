import type { Db } from "../db.js";
import { snapshotDataVersion } from "../lib/compute-generation.js";
import type { ContractPriceRow } from "./contract-prices.js";
import type { OrderLevel } from "./depth.js";
import { buildRecipe, parseManufactureRow } from "./manufacture.js";
import type { BlueprintRecipe, MaterialLine } from "./manufacture.js";
import type { OfferBase, HistoryRow, PriceRow } from "./offer-calc.js";
import type { OfferItem } from "./offer-types.js";

// Process-wide in-memory mirror of every table the per-offer calc hot loop reads,
// so a non-cacheEligible /lp query runs pure-JS with zero SQL in the loop. Bulk
// loaded with a handful of statements; single-threaded runtime means no locking.

export interface SnapshotTypeRow {
  type_id: number;
  name: string;
  group_id: number | null;
  group_name: string | null;
  category_id: number | null;
  category_name: string | null;
  packaged_volume: number | null;
  volume: number | null;
}

export interface MarketSnapshot {
  /** Validity token — a change forces a synchronous rebuild (see snapshotToken). */
  token: string;
  prices: Map<number, PriceRow>;
  /** Raw order-book levels (pre-fallback) keyed `${type_id}:${side}`. */
  books: Map<string, OrderLevel[]>;
  history: Map<number, HistoryRow>;
  adjustedPrice: Map<number, number | null>;
  contractPrice: Map<number, ContractPriceRow>;
  recipe: Map<number, BlueprintRecipe>;
  types: Map<number, SnapshotTypeRow>;
  offerBase: Map<number, OfferBase>;
  offerProducts: Map<number, OfferItem[]>;
  offerRequiredItems: Map<number, OfferItem[]>;
}

// Per-connection so distinct DBs (tests) never collide on an identical token;
// prod runs a single connection, so this is the intended process-wide singleton.
const snapshots = new WeakMap<Db, MarketSnapshot>();

// The snapshot mirrors market/offer/type data, which at runtime changes only via
// ingest jobs — every one of which bumps snapshotDataVersion (markComputeDirty). So
// this single monotonic counter is the exact staleness signal: it does NOT move on
// recompute, dirty-marker clears, Cloudflare purge records, or esi_cache/fetcher_status
// writes, so the snapshot built during recompute survives for the post-recompute
// serving path instead of being rebuilt on the next unrelated write. The invariant
// this relies on: any write to a snapshot-mirrored table goes through markComputeDirty
// (verified for all scheduled ingest; SDE type/blueprint writes happen only at boot,
// before the first recompute, when the snapshot cache is empty anyway).
function snapshotToken(db: Db): string {
  return String(snapshotDataVersion(db));
}

export function getMarketSnapshot(db: Db): MarketSnapshot {
  const token = snapshotToken(db);
  const existing = snapshots.get(db);
  if (existing && existing.token === token) return existing;
  const built = buildSnapshot(db, token);
  snapshots.set(db, built);
  return built;
}

function loadRecipes(db: Db): Map<number, BlueprintRecipe> {
  const recipes = new Map<number, BlueprintRecipe>();

  const materialsByBlueprint = new Map<number, MaterialLine[]>();
  const materialRows = db
    .prepare(
      "SELECT blueprint_type_id, material_type_id AS type_id, quantity FROM blueprint_materials ORDER BY blueprint_type_id, material_type_id"
    )
    .all() as Array<{ blueprint_type_id: number; type_id: number; quantity: number }>;
  for (const row of materialRows) {
    let list = materialsByBlueprint.get(row.blueprint_type_id);
    if (!list) materialsByBlueprint.set(row.blueprint_type_id, (list = []));
    list.push({ type_id: row.type_id, quantity: row.quantity });
  }

  // blueprint_products wins over bp_manufacture (mirrors getBlueprintRecipe); the
  // ORDER BY + first-seen keeps the ORDER BY product_type_id LIMIT 1 semantics.
  const productRows = db
    .prepare(
      "SELECT blueprint_type_id, product_type_id, quantity AS runs FROM blueprint_products ORDER BY blueprint_type_id, product_type_id"
    )
    .all() as Array<{ blueprint_type_id: number; product_type_id: number; runs: number }>;
  for (const row of productRows) {
    if (recipes.has(row.blueprint_type_id)) continue;
    recipes.set(
      row.blueprint_type_id,
      buildRecipe(
        row.blueprint_type_id,
        row.product_type_id,
        row.runs,
        materialsByBlueprint.get(row.blueprint_type_id) ?? []
      )
    );
  }

  const manufactureRows = db
    .prepare("SELECT blueprint_type_id, product_type_id, runs, materials_json FROM bp_manufacture")
    .all() as Array<{ blueprint_type_id: number; product_type_id: number; runs: number; materials_json: string }>;
  for (const row of manufactureRows) {
    if (recipes.has(row.blueprint_type_id)) continue;
    recipes.set(row.blueprint_type_id, parseManufactureRow(row));
  }

  return recipes;
}

function loadBooks(db: Db): Map<string, OrderLevel[]> {
  const books = new Map<string, OrderLevel[]>();
  const rows = db
    .prepare(
      "SELECT type_id, side, price, qty, order_id, location_id, system_id, is_jita44 FROM prices_book ORDER BY type_id, side, rank"
    )
    .all() as Array<{
    type_id: number;
    side: string;
    price: number;
    qty: number;
    order_id: number | null;
    location_id: number | null;
    system_id: number | null;
    is_jita44: number | null;
  }>;
  for (const row of rows) {
    const key = `${row.type_id}:${row.side}`;
    let list = books.get(key);
    if (!list) books.set(key, (list = []));
    list.push({
      price: row.price,
      qty: row.qty,
      order_id: row.order_id,
      location_id: row.location_id,
      system_id: row.system_id,
      is_jita44: row.is_jita44
    });
  }
  return books;
}

function loadOfferItems(db: Db, table: "offer_products" | "offer_required_items"): Map<number, OfferItem[]> {
  const byOffer = new Map<number, OfferItem[]>();
  const rows = db
    .prepare(
      `
      SELECT
        oi.offer_id,
        oi.type_id,
        COALESCE(t.name, 'Type ' || oi.type_id) AS type_name,
        oi.quantity,
        t.group_id,
        t.group_name,
        t.category_id,
        t.category_name,
        t.packaged_volume
      FROM ${table} oi
      LEFT JOIN types t ON t.type_id=oi.type_id
      ORDER BY oi.offer_id, oi.type_id
    `
    )
    .all() as Array<OfferItem & { offer_id: number }>;
  for (const row of rows) {
    let list = byOffer.get(row.offer_id);
    if (!list) byOffer.set(row.offer_id, (list = []));
    list.push({
      type_id: row.type_id,
      type_name: row.type_name,
      quantity: row.quantity,
      group_id: row.group_id,
      group_name: row.group_name,
      category_id: row.category_id,
      category_name: row.category_name,
      packaged_volume: row.packaged_volume
    });
  }
  return byOffer;
}

function buildSnapshot(db: Db, token: string): MarketSnapshot {
  const startedAt = Date.now();

  const prices = new Map<number, PriceRow>();
  for (const row of db.prepare("SELECT * FROM prices").all() as PriceRow[]) {
    prices.set(row.type_id, row);
  }

  const history = new Map<number, HistoryRow>();
  for (const row of db.prepare("SELECT * FROM history").all() as HistoryRow[]) {
    history.set(row.type_id, row);
  }

  const adjustedPrice = new Map<number, number | null>();
  for (const row of db.prepare("SELECT type_id, adjusted_price FROM adjusted_prices").all() as Array<{
    type_id: number;
    adjusted_price: number | null;
  }>) {
    adjustedPrice.set(row.type_id, row.adjusted_price ?? null);
  }

  const contractPrice = new Map<number, ContractPriceRow>();
  for (const row of db
    .prepare("SELECT type_id, ask_min, ask_median, ask_count, updated_at FROM contract_prices")
    .all() as Array<ContractPriceRow & { type_id: number }>) {
    contractPrice.set(row.type_id, {
      ask_min: row.ask_min,
      ask_median: row.ask_median,
      ask_count: row.ask_count,
      updated_at: row.updated_at
    });
  }

  const types = new Map<number, SnapshotTypeRow>();
  for (const row of db
    .prepare(
      "SELECT type_id, name, group_id, group_name, category_id, category_name, packaged_volume, volume FROM types"
    )
    .all() as SnapshotTypeRow[]) {
    types.set(row.type_id, row);
  }

  const offerBase = new Map<number, OfferBase>();
  for (const row of db
    .prepare(
      `
      SELECT
        o.offer_id,
        o.corp_id,
        c.name AS corp_name,
        o.lp_cost,
        o.isk_cost,
        o.fetched_at,
        c.risk_tier,
        COALESCE(NULLIF(c.access_risk_tier, ''), c.risk_tier) AS access_risk_tier,
        c.hq_station_name,
        c.hq_system_name,
        c.hq_security_status,
        c.lp_source_tier,
        c.has_level5_agent,
        om.required_standing,
        COALESCE(om.is_fw, 0) AS is_fw
      FROM offers o
      JOIN corporations c ON c.corp_id=o.corp_id
      LEFT JOIN offer_meta om ON om.offer_id=o.offer_id
      WHERE c.has_earnable_lp_source=1
    `
    )
    .all() as OfferBase[]) {
    offerBase.set(row.offer_id, row);
  }

  const books = loadBooks(db);
  const recipe = loadRecipes(db);
  const offerProducts = loadOfferItems(db, "offer_products");
  const offerRequiredItems = loadOfferItems(db, "offer_required_items");

  const snapshot: MarketSnapshot = {
    token,
    prices,
    books,
    history,
    adjustedPrice,
    contractPrice,
    recipe,
    types,
    offerBase,
    offerProducts,
    offerRequiredItems
  };

  console.log(
    JSON.stringify({
      component: "snapshot",
      build_ms: Date.now() - startedAt,
      prices: prices.size,
      books: books.size,
      history: history.size,
      adjusted_prices: adjustedPrice.size,
      contract_prices: contractPrice.size,
      recipes: recipe.size,
      types: types.size,
      offers: offerBase.size,
      offer_products: offerProducts.size,
      offer_required_items: offerRequiredItems.size
    })
  );

  return snapshot;
}
