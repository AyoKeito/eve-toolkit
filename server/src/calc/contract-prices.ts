import type { Db } from "../db.js";
import { contractPriceRegions } from "../config.js";
import { prepareCached } from "../lib/prepare-cache.js";
import { median } from "../lib/stats.js";
import { getBlueprintRecipe } from "./manufacture.js";

/**
 * Ask-price rollup for contract-only types.
 *
 * Qualifying asks: active item_exchange contracts whose included items collapse
 * to a single type (the fetcher's single_item_* denormalization), nothing asked
 * in return, price > 0, not past expiry. BPC asks are normalized to PRICE PER RUN
 * (price / copies / runs) — LP stores express a 1000-run blueprint as offer
 * quantity 1000, so per-run is the unit the calc multiplies back up; it also
 * makes asks with different runs counts directly comparable. Non-BPC asks are
 * per item. Scam filtering is two-layered: a recipe cap (a BPC's per-run value
 * cannot exceed its built product's market value) discards absurd decoys even
 * when they are the only asks, then the band anchors on the MINIMUM surviving
 * ask — decoys are always high, and a median anchor flips to the scam side as
 * soon as decoys outnumber honest asks. A type publishes only with >= 2
 * survivors — a lone contract is as likely a troll listing as a price.
 *
 * Rows persist when a type's asks drop below the floor (thin BPC supply churns
 * on a timescale of days); consumers filter on updated_at instead. Stale rows
 * are pruned after CONTRACT_PRICE_RETENTION_DAYS.
 */

export const contractPriceFreshDays = 30;
export const contractPriceRetentionDays = 90;
export const contractPriceMinAsks = 2;
const outlierBandFactor = 4;
const recipeCapSlack = 2;

interface AskRow {
  single_item_type_id: number;
  price: number;
  single_item_quantity: number;
  single_item_is_bpc: number;
  single_item_runs: number | null;
}

interface Ask {
  unitPrice: number;
  isBpc: boolean;
  runs: number | null;
}

function modalRuns(asks: Ask[]): number | null {
  const counts = new Map<number | null, number>();
  for (const ask of asks) counts.set(ask.runs, (counts.get(ask.runs) ?? 0) + 1);
  let best: { runs: number | null; n: number } | null = null;
  for (const [runs, n] of counts) {
    if (!best || n > best.n) best = { runs, n };
  }
  return best?.runs ?? null;
}

export interface ContractPriceStats {
  ask_count: number;
  ask_min: number;
  ask_median: number;
  is_bpc: boolean;
  runs_modal: number | null;
}

/** Pure rollup of one type's asks (unitPrice already per-run for BPCs);
 * exported for unit tests. capPerRun, when given, discards any ask above it —
 * the recipe cap that screens decoys with no honest ask to anchor on. */
export function rollupAsks(asks: Ask[], capPerRun: number | null = null): ContractPriceStats | null {
  const bpc = asks.some((ask) => ask.isBpc);
  // Per-run normalization makes mixed-runs BPC asks comparable; runs_modal is
  // kept as reference data only.
  let candidates = bpc ? asks.filter((ask) => ask.isBpc) : asks;
  if (capPerRun !== null && capPerRun > 0) {
    candidates = candidates.filter((ask) => ask.unitPrice <= capPerRun);
  }
  if (candidates.length === 0) return null;
  const runsModal = bpc ? modalRuns(candidates) : null;
  // Anchor on the minimum: asks are one-sided, decoys are always high, and the
  // cheapest active contract is by definition a buyable price.
  const minAsk = Math.min(...candidates.map((ask) => ask.unitPrice));
  const survivors = candidates.filter((ask) => ask.unitPrice <= minAsk * outlierBandFactor);
  if (survivors.length < contractPriceMinAsks) return null;
  const unitPrices = survivors.map((ask) => ask.unitPrice);
  return {
    ask_count: survivors.length,
    ask_min: minAsk,
    // survivors.length >= contractPriceMinAsks (>= 2), so unitPrices is non-empty.
    ask_median: median(unitPrices)!,
    is_bpc: bpc,
    runs_modal: runsModal
  };
}

/** Upper bound on a BPC's per-run value: what one run's output sells for on the
 * market, with slack for thin product books. Null when the type has no recipe
 * or the product has no market price (then only the min-anchor band protects). */
function recipeCapPerRun(db: Db, typeId: number): number | null {
  const recipe = getBlueprintRecipe(db, typeId);
  if (!recipe) return null;
  const price = db.prepare("SELECT sell_min FROM prices WHERE type_id=?").get(recipe.product_type_id) as
    | { sell_min: number | null }
    | undefined;
  if (!price || price.sell_min === null || price.sell_min <= 0) return null;
  return price.sell_min * recipe.runs * recipeCapSlack;
}

/** Rebuilds contract_prices from active asks. Returns the number of types (re)published. */
export function rebuildContractPrices(db: Db, now = new Date()): number {
  const nowTs = now.toISOString();
  // Scope the rollup to the PRICE regions (default The Forge). The contract scan may also cover
  // warzone regions for the /fits/ saturation check; those asks must never feed BPC prices.
  const priceRegions = contractPriceRegions();
  const regionPh = priceRegions.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
    SELECT single_item_type_id, price, single_item_quantity, single_item_is_bpc, single_item_runs
    FROM contracts
    WHERE gone_at IS NULL
      AND region_id IN (${regionPh})
      AND contract_type = 'item_exchange'
      AND items_fetched = 1
      AND single_item_type_id IS NOT NULL
      AND has_excluded_items = 0
      AND price > 0
      AND date_expired > ?
  `
    )
    .all(...priceRegions, nowTs) as AskRow[];

  const byType = new Map<number, Ask[]>();
  for (const row of rows) {
    const quantity = row.single_item_quantity > 0 ? row.single_item_quantity : 1;
    const isBpc = row.single_item_is_bpc === 1;
    const runs = isBpc && row.single_item_runs && row.single_item_runs > 0 ? row.single_item_runs : 1;
    let list = byType.get(row.single_item_type_id);
    if (!list) byType.set(row.single_item_type_id, (list = []));
    list.push({
      unitPrice: row.price / quantity / runs,
      isBpc,
      runs: row.single_item_runs
    });
  }

  const upsert = db.prepare(`
    INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      ask_count=excluded.ask_count,
      ask_min=excluded.ask_min,
      ask_median=excluded.ask_median,
      is_bpc=excluded.is_bpc,
      runs_modal=excluded.runs_modal,
      updated_at=excluded.updated_at
  `);

  let published = 0;
  const cutoff = new Date(now.getTime() - contractPriceRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const dropRow = db.prepare("DELETE FROM contract_prices WHERE type_id=?");
  const tx = db.transaction(() => {
    for (const [typeId, asks] of byType) {
      const stats = rollupAsks(asks, recipeCapPerRun(db, typeId));
      if (!stats) {
        // Active asks exist but cannot support a price (scam-only book, or one
        // lone ask): the freshest evidence beats any previously published row.
        // Retention only protects types whose asks vanished entirely.
        dropRow.run(typeId);
        continue;
      }
      upsert.run(typeId, stats.ask_count, stats.ask_min, stats.ask_median, stats.is_bpc ? 1 : 0, stats.runs_modal, nowTs);
      published += 1;
    }
    db.prepare("DELETE FROM contract_prices WHERE updated_at < ?").run(cutoff);
  });
  tx();
  return published;
}

export interface ContractPriceRow {
  ask_min: number;
  ask_median: number;
  ask_count: number;
  updated_at: string;
}

/** Applies the read-time freshness cutoff to an already-fetched row. Split out so
 * the market snapshot can replace only the row fetch and keep the cutoff logic
 * (computed against `now` per read, so snapshot vintage never affects staleness). */
export function freshContractPrice(row: ContractPriceRow | null | undefined, now = new Date()): ContractPriceRow | null {
  if (!row) return null;
  const freshCutoff = now.getTime() - contractPriceFreshDays * 24 * 60 * 60 * 1000;
  if (Date.parse(row.updated_at) < freshCutoff) return null;
  return row;
}

/** Fresh contract price for a type, or null when absent/stale. For BPC rows
 * (is_bpc=1) ask_min/ask_median are PER RUN, matching the offer-quantity-as-runs
 * convention of LP blueprint offers. */
export function getContractPrice(db: Db, typeId: number, now = new Date()): ContractPriceRow | null {
  const row = prepareCached(db, "SELECT ask_min, ask_median, ask_count, updated_at FROM contract_prices WHERE type_id=?")
    .get(typeId) as ContractPriceRow | undefined;
  return freshContractPrice(row, now);
}
