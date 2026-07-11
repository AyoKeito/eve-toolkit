import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { effectiveRuns } from "./budget.js";
import { freshContractPrice, getContractPrice } from "./contract-prices.js";
import { walkOrders, type OrderLevel } from "./depth.js";
import type { MarketSnapshot } from "./market-snapshot.js";
import { feeRates } from "./fees.js";
import {
  effectivePatientNet,
  emptyFillEstimate,
  estimateDaysToFill,
  expectedRelists,
  relistDiscount,
  type FillEstimate
} from "./fill.js";
import { qualityFlags, type QualityFlag } from "./flags.js";
import { jobInstallationCost, resolveFacility, type Facility } from "./job-cost.js";
import { getBlueprintRecipe, type BlueprintRecipe, type MaterialLine } from "./manufacture.js";
import { leastRiskTier, normalizeRiskTier, type RiskTier } from "./risk.js";
import { isVanityType, type VanityTypeInput } from "./vanity.js";
import {
  iskPerHour,
  ratioForBasis,
  storeOption,
  valuationBasis,
  type Basis,
  type BreakdownLine,
  type LpSourceTier,
  type OfferCalc,
  type OfferItem,
  type OfferQuery,
  type OfferSummary,
  type SalesTarget,
  type StoreOption,
  type SummaryLine,
  type SummaryGroup
} from "./offer-types.js";
import { uniqueStoreOptionsByCorpId } from "../lib/offer-grouping.js";

// ---------------------------------------------------------------------------
// Private interfaces
// ---------------------------------------------------------------------------

export interface OfferBase {
  offer_id: number;
  corp_id: number;
  corp_name: string;
  lp_cost: number;
  isk_cost: number;
  fetched_at: string;
  risk_tier: RiskTier;
  access_risk_tier: RiskTier;
  hq_station_name: string | null;
  hq_system_name: string | null;
  hq_security_status: number | null;
  lp_source_tier: LpSourceTier;
  has_level5_agent: number;
  required_standing: number | null;
  is_fw: number;
}

// Exported so OfferCalcMemo (also exported) can reference them without
// triggering declaration-emit errors. Consumers should treat them as opaque.
export interface PriceRow {
  type_id: number;
  sell_min: number | null;
  buy_max: number | null;
  sell_order_count: number;
  buy_order_count: number;
  sell_top_qty_share: number | null;
  sell_min_at_jita_44: number;
  updated_at: string | null;
}

export interface HistoryRow {
  type_id: number;
  avg_daily_volume_28d: number | null;
  median_price_28d: number | null;
  max_price_28d: number | null;
  days: number;
  updated_at: string | null;
}

interface RatioStatements {
  offerBase: ReturnType<Db["prepare"]>;
  offerProducts: ReturnType<Db["prepare"]>;
  offerRequiredItems: ReturnType<Db["prepare"]>;
  typeName: ReturnType<Db["prepare"]>;
  vanityType: ReturnType<Db["prepare"]>;
  packagedVolume: ReturnType<Db["prepare"]>;
  price: ReturnType<Db["prepare"]>;
  history: ReturnType<Db["prepare"]>;
  adjustedPrice: ReturnType<Db["prepare"]>;
  book: ReturnType<Db["prepare"]>;
  calcRowsExist: ReturnType<Db["prepare"]>;
}

export interface OfferCalcMemo {
  price: Map<number, PriceRow | null>;
  history: Map<number, HistoryRow | null>;
  packagedVolume: Map<number, number>;
  vanityType: Map<number, VanityTypeInput>;
  contractPrice: Map<number, ContractPriceHit | null>;
  /** CCP daily reference price per type (job-cost EIV basis); null when unpriced. */
  adjustedPrice: Map<number, number | null>;
  /** Order-book levels keyed by `${type_id}:${side}` (post-fallback). */
  book: Map<string, OrderLevel[]>;
  /** Blueprint recipe per blueprint type_id; null caches the no-recipe result. */
  recipe: Map<number, BlueprintRecipe | null>;
  /** Types whose sell book actually came from the contract-ask fallback. */
  contractPricedBooks: Set<number>;
  /** Process-wide in-memory mirror; when set, per-offer getters read it instead
   * of issuing SQL. Absent for standalone calculateOffer callers (falls back to SQL). */
  snapshot?: MarketSnapshot;
}

type ContractPriceHit = NonNullable<ReturnType<typeof getContractPrice>>;

/** "sell" = the synthetic direct-contract-sale row for blueprint offers;
 * "base" = the normal row (manufacture conversion when a recipe exists). */
type OfferVariant = "base" | "sell";

/**
 * Sell-variant rows live at offer_id + this offset, far above the corpId*1e6
 * namespace (max ~2e12) and well within safe-integer range. calculateOffer
 * decodes the offset natively, so the calc table, FTS rowids, candidate-id
 * scans, and the /api/offers/:id detail route all handle variant rows with no
 * special cases.
 */
export const SELL_VARIANT_OFFSET = 500_000_000_000_000;

// ---------------------------------------------------------------------------
// Statements cache
// ---------------------------------------------------------------------------

const ratioStatements = new WeakMap<Db, RatioStatements>();

function prepareOfferItemStmt(db: Db, table: string): ReturnType<Db["prepare"]> {
  return db.prepare(`
    SELECT
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
    WHERE oi.offer_id=?
    ORDER BY oi.type_id
  `);
}

function statements(db: Db): RatioStatements {
  const cached = ratioStatements.get(db);
  if (cached) return cached;

  const prepared = {
    offerBase: db.prepare(`
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
      WHERE o.offer_id=?
        AND c.has_earnable_lp_source=1
    `),
    offerProducts: prepareOfferItemStmt(db, "offer_products"),
    offerRequiredItems: prepareOfferItemStmt(db, "offer_required_items"),
    typeName: db.prepare("SELECT name FROM types WHERE type_id=?"),
    vanityType: db.prepare(`
      SELECT type_id, name, group_id, group_name, category_id, category_name
      FROM types
      WHERE type_id=?
    `),
    packagedVolume: db.prepare("SELECT packaged_volume, volume FROM types WHERE type_id=?"),
    price: db.prepare("SELECT * FROM prices WHERE type_id=?"),
    history: db.prepare("SELECT * FROM history WHERE type_id=?"),
    adjustedPrice: db.prepare("SELECT adjusted_price FROM adjusted_prices WHERE type_id=?"),
    book: db.prepare(`
      SELECT price, qty, order_id, location_id, system_id, is_jita44
      FROM prices_book
      WHERE type_id=? AND side=?
      ORDER BY rank
    `),
    calcRowsExist: db.prepare("SELECT 1 FROM calc LIMIT 1")
  };
  ratioStatements.set(db, prepared);
  return prepared;
}

export function createOfferCalcMemo(snapshot?: MarketSnapshot): OfferCalcMemo {
  return {
    price: new Map(),
    history: new Map(),
    packagedVolume: new Map(),
    vanityType: new Map(),
    contractPrice: new Map(),
    adjustedPrice: new Map(),
    book: new Map(),
    recipe: new Map(),
    contractPricedBooks: new Set(),
    snapshot
  };
}

// ---------------------------------------------------------------------------
// Private data-access helpers
// ---------------------------------------------------------------------------

// Snapshot rows/arrays are shared read-only across offers (nothing here mutates
// them), matching the getBook convention — no defensive copy.
function getOfferBase(db: Db, offerId: number, memo: OfferCalcMemo): OfferBase | null {
  if (memo.snapshot) return memo.snapshot.offerBase.get(offerId) ?? null;
  return (statements(db).offerBase.get(offerId) as OfferBase | undefined) ?? null;
}

function getOfferItems(
  db: Db,
  table: "offer_products" | "offer_required_items",
  offerId: number,
  memo: OfferCalcMemo
): OfferItem[] {
  if (memo.snapshot) {
    const src = table === "offer_products" ? memo.snapshot.offerProducts : memo.snapshot.offerRequiredItems;
    return src.get(offerId) ?? [];
  }
  const stmt = table === "offer_products" ? statements(db).offerProducts : statements(db).offerRequiredItems;
  return stmt.all(offerId) as OfferItem[];
}

function getTypeName(db: Db, typeId: number, memo: OfferCalcMemo): string {
  if (memo.snapshot) return memo.snapshot.types.get(typeId)?.name ?? `Type ${typeId}`;
  const row = statements(db).typeName.get(typeId) as { name: string } | undefined;
  return row?.name ?? `Type ${typeId}`;
}

function getVanityType(db: Db, typeId: number, fallbackName: string, memo: OfferCalcMemo): VanityTypeInput {
  const cached = memo.vanityType.get(typeId);
  if (cached) return cached;
  let row: VanityTypeInput | undefined;
  if (memo.snapshot) {
    const t = memo.snapshot.types.get(typeId);
    row = t
      ? {
          type_id: t.type_id,
          name: t.name,
          group_id: t.group_id,
          group_name: t.group_name,
          category_id: t.category_id,
          category_name: t.category_name
        }
      : undefined;
  } else {
    row = statements(db).vanityType.get(typeId) as VanityTypeInput | undefined;
  }
  const value = row ?? { type_id: typeId, name: fallbackName };
  memo.vanityType.set(typeId, value);
  return value;
}

function getPackagedVolume(db: Db, typeId: number, memo: OfferCalcMemo): number {
  const cached = memo.packagedVolume.get(typeId);
  if (cached !== undefined) return cached;
  const row = memo.snapshot
    ? memo.snapshot.types.get(typeId)
    : (statements(db).packagedVolume.get(typeId) as { packaged_volume: number | null; volume: number | null } | undefined);
  const value = asNumber(row?.packaged_volume ?? row?.volume, 0);
  memo.packagedVolume.set(typeId, value);
  return value;
}

export function getPrice(db: Db, typeId: number, memo: OfferCalcMemo): PriceRow | null {
  if (memo.price.has(typeId)) return memo.price.get(typeId) ?? null;
  const value = memo.snapshot
    ? memo.snapshot.prices.get(typeId) ?? null
    : (statements(db).price.get(typeId) as PriceRow | undefined) ?? null;
  memo.price.set(typeId, value);
  return value;
}

export function getHistory(db: Db, typeId: number, memo: OfferCalcMemo): HistoryRow | null {
  if (memo.history.has(typeId)) return memo.history.get(typeId) ?? null;
  const value = memo.snapshot
    ? memo.snapshot.history.get(typeId) ?? null
    : (statements(db).history.get(typeId) as HistoryRow | undefined) ?? null;
  memo.history.set(typeId, value);
  return value;
}

/** CCP daily reference price for a type (job-cost EIV basis), or null when CCP
 * does not publish one — callers skip the material's EIV contribution. */
function getAdjustedPrice(db: Db, typeId: number, memo: OfferCalcMemo): number | null {
  if (memo.adjustedPrice.has(typeId)) return memo.adjustedPrice.get(typeId) ?? null;
  let value: number | null;
  if (memo.snapshot) {
    value = memo.snapshot.adjustedPrice.get(typeId) ?? null;
  } else {
    const row = statements(db).adjustedPrice.get(typeId) as { adjusted_price: number | null } | undefined;
    value = row?.adjusted_price ?? null;
  }
  memo.adjustedPrice.set(typeId, value);
  return value;
}

function getContractPriceMemo(db: Db, typeId: number, memo: OfferCalcMemo): ContractPriceHit | null {
  if (memo.contractPrice.has(typeId)) return memo.contractPrice.get(typeId) ?? null;
  const value = memo.snapshot
    ? freshContractPrice(memo.snapshot.contractPrice.get(typeId) ?? null)
    : getContractPrice(db, typeId);
  memo.contractPrice.set(typeId, value);
  return value;
}

// Callers (walkOrders, estimateDaysToFill) only read the returned rows — none
// mutates the array or its row objects — so a single memoized array is shared
// safely across the ~8-9 getBook calls per offer without a defensive copy.
function getBook(db: Db, typeId: number, side: "sell" | "buy", memo: OfferCalcMemo): OrderLevel[] {
  const key = `${typeId}:${side}`;
  const cached = memo.book.get(key);
  if (cached !== undefined) return cached;
  const value = computeBook(db, typeId, side, memo);
  memo.book.set(key, value);
  return value;
}

function computeBook(db: Db, typeId: number, side: "sell" | "buy", memo: OfferCalcMemo): OrderLevel[] {
  // Snapshot holds raw (pre-fallback) levels; the fallback decisions below run
  // identically against snapshot-sourced price/contract data.
  const rows = memo.snapshot
    ? memo.snapshot.books.get(`${typeId}:${side}`) ?? []
    : (statements(db).book.all([typeId, side]) as OrderLevel[]);
  if (rows.length > 0) return rows;

  const price = getPrice(db, typeId, memo);
  const fallback = side === "sell" ? price?.sell_min : price?.buy_max;
  if (fallback && fallback > 0) {
    return [{ price: fallback, qty: Number.MAX_SAFE_INTEGER, location_id: null }];
  }

  // Contract-only types (no market group => never any orders): fresh contract asks
  // stand in as the patient sell level. No bid book exists, so the buy side stays
  // empty and the instant basis remains unpriced.
  if (side === "sell") {
    const contract = getContractPriceMemo(db, typeId, memo);
    if (contract && contract.ask_min > 0) {
      memo.contractPricedBooks.add(typeId);
      return [{ price: contract.ask_min, qty: Number.MAX_SAFE_INTEGER, location_id: null }];
    }
  }
  return [];
}

function getRecipe(db: Db, blueprintTypeId: number, memo: OfferCalcMemo): BlueprintRecipe | null {
  if (memo.recipe.has(blueprintTypeId)) return memo.recipe.get(blueprintTypeId) ?? null;
  const value = memo.snapshot
    ? memo.snapshot.recipe.get(blueprintTypeId) ?? null
    : getBlueprintRecipe(db, blueprintTypeId);
  memo.recipe.set(blueprintTypeId, value);
  return value;
}

/** True when the type has no usable market price — the precondition for valuing
 * it from contract asks instead. */
function lacksMarketPrice(db: Db, typeId: number, memo: OfferCalcMemo): boolean {
  const price = getPrice(db, typeId, memo);
  return !price || ((price.sell_min === null || price.sell_min <= 0) && (price.buy_max === null || price.buy_max <= 0));
}

// ---------------------------------------------------------------------------
// Private math helpers
// ---------------------------------------------------------------------------

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function lineCost(
  db: Db,
  typeId: number,
  name: string,
  quantity: number,
  side: "sell" | "buy",
  memo: OfferCalcMemo
): BreakdownLine {
  const walk = walkOrders(getBook(db, typeId, side, memo), quantity);
  return { type_id: typeId, name, quantity, walk };
}

const costLegFlagShareThreshold = 0.05;

function lineQualityFlags(
  db: Db,
  line: BreakdownLine,
  label: string,
  memo: OfferCalcMemo,
  includeInsufficientDepth = false,
  queueAheadQty: number | null = null
): QualityFlag[] {
  const price = getPrice(db, line.type_id, memo);
  const history = getHistory(db, line.type_id, memo);
  return qualityFlags({
    productQty: line.quantity,
    avgDailyVolume28d: history?.avg_daily_volume_28d ?? null,
    historyDays: history?.days ?? 0,
    medianPrice28d: history?.median_price_28d ?? null,
    sellMin: price?.sell_min ?? null,
    buyMax: price?.buy_max ?? null,
    sellOrderCount: price?.sell_order_count ?? 0,
    sellTopQtyShare: price?.sell_top_qty_share ?? null,
    sellMinAtJita44: price?.sell_min_at_jita_44 === 1,
    insufficientDepth: includeInsufficientDepth && line.walk.insufficient_depth,
    queueAheadQty
  }).map((flag) => ({ ...flag, message: `${label} ${line.name}: ${flag.message}` }));
}

function materialCostLineFlags(
  db: Db,
  lines: BreakdownLine[],
  label: string,
  capitalRequired: number,
  memo: OfferCalcMemo
): QualityFlag[] {
  if (capitalRequired <= 0) return [];
  const flags: QualityFlag[] = [];
  const offHubNames: string[] = [];

  for (const line of lines) {
    if (line.walk.total_value / capitalRequired < costLegFlagShareThreshold) continue;
    for (const flag of lineQualityFlags(db, line, label, memo, false)) {
      if (flag.code === "OFF_HUB") {
        offHubNames.push(line.name);
      } else if (flag.code === "BUY_SPIKE") {
        // cost legs are bought from sell orders — a buy-side spike only distorts
        // valuations where we sell into the buy book, i.e. the output leg
        continue;
      } else {
        flags.push(flag);
      }
    }
  }

  if (offHubNames.length === 1) {
    flags.push({
      code: "OFF_HUB",
      severity: "warn",
      message: `${label} ${offHubNames[0]}: Cheapest sell order is not at Jita 4-4.`
    });
  } else if (offHubNames.length > 1) {
    flags.push({
      code: "OFF_HUB",
      severity: "strong",
      message: `${offHubNames.length} ${costLegLabelPlural(label)} have cheapest sell orders outside Jita 4-4: ${offHubNames.join(", ")}.`
    });
  }

  return flags;
}

function costLegLabelPlural(label: string): string {
  if (label === "Required input") return "required inputs";
  if (label === "Build material") return "build materials";
  return `${label.toLowerCase()}s`;
}

/** True when a recipe-bearing blueprint can be sold directly instead of built:
 * it has no market price of its own (a seeded BPO's sell_min is not the LP copy's
 * value) and a fresh contract ask exists. */
function directBpcSellable(db: Db, typeId: number, memo: OfferCalcMemo): boolean {
  return lacksMarketPrice(db, typeId, memo) && getContractPriceMemo(db, typeId, memo) !== null;
}

interface TargetsAndMaterials {
  targets: SalesTarget[];
  /** Material-efficiency–reduced quantities — what the builder actually consumes
   * and pays for (drives build_cost). Equals baseMaterials when meMult is 1. */
  materials: MaterialLine[];
  /** ME-0 base quantities — what CCP's job-cost EIV is computed from (job fees
   * ignore material efficiency). */
  baseMaterials: MaterialLine[];
  /** False when a requested sell variant does not exist for this offer. */
  valid: boolean;
}

/** Round to 2 decimals, then ceil — EVE's per-material ME consumption rule. */
function applyMaterialEfficiency(baseQty: number, runs: number, meMult: number): number {
  if (meMult >= 1) return baseQty;
  return Math.max(runs, Math.ceil(Math.round(baseQty * meMult * 100) / 100));
}

function buildTargetsAndMaterials(
  db: Db,
  products: OfferItem[],
  runs: number,
  memo: OfferCalcMemo,
  variant: OfferVariant,
  meMult = 1
): TargetsAndMaterials {
  const targets: SalesTarget[] = [];
  const materialMap = new Map<number, number>();
  const baseMaterialMap = new Map<number, number>();
  let sellableRecipeProducts = 0;

  for (const product of products) {
    const recipe = getRecipe(db, product.type_id, memo);
    const directSellable = recipe !== null && directBpcSellable(db, product.type_id, memo);

    // The "(sell)" variant flips every recipe-bearing product to a direct contract
    // sale of the blueprint itself; it only exists when all of them are sellable.
    if (variant === "sell" && recipe && !directSellable) {
      return { targets: [], materials: [], baseMaterials: [], valid: false };
    }

    if (!recipe || (variant === "sell" && directSellable)) {
      if (directSellable) sellableRecipeProducts += 1;
      const quantity = product.quantity * runs;
      const walk = walkOrders(getBook(db, product.type_id, "buy", memo), quantity);
      targets.push({
        type_id: product.type_id,
        name: product.type_name,
        quantity,
        walk,
        source_type_id: product.type_id,
        source_name: product.type_name,
        is_bpc: false
      });
      continue;
    }

    const quantity = product.quantity * recipe.runs * runs;
    const productName = getTypeName(db, recipe.product_type_id, memo);
    const walk = walkOrders(getBook(db, recipe.product_type_id, "buy", memo), quantity);
    targets.push({
      type_id: recipe.product_type_id,
      name: productName,
      quantity,
      walk,
      source_type_id: product.type_id,
      source_name: product.type_name,
      is_bpc: true
    });

    // EVE applies the ME formula per (blueprint, material) per job, then jobs are
    // consumed independently — so transform each term before summing. The job-run
    // count for this product (the ME floor: ≥1 unit per run) is product.quantity*runs.
    const jobRuns = product.quantity * runs;
    for (const material of recipe.materials) {
      const baseTerm = material.quantity * jobRuns;
      materialMap.set(
        material.type_id,
        (materialMap.get(material.type_id) ?? 0) + applyMaterialEfficiency(baseTerm, jobRuns, meMult)
      );
      baseMaterialMap.set(material.type_id, (baseMaterialMap.get(material.type_id) ?? 0) + baseTerm);
    }
  }

  // A sell variant that flips nothing would duplicate the base row.
  const valid = variant === "sell" ? sellableRecipeProducts > 0 : true;
  return {
    targets,
    materials: [...materialMap.entries()].map(([type_id, quantity]) => ({ type_id, quantity })),
    baseMaterials: [...baseMaterialMap.entries()].map(([type_id, quantity]) => ({ type_id, quantity })),
    valid
  };
}

function capitalPerRun(
  db: Db,
  offer: OfferBase,
  products: OfferItem[],
  required: OfferItem[],
  memo: OfferCalcMemo,
  facility: Facility,
  variant: OfferVariant
): number {
  // Budget capital uses the ME-reduced materials (matching displayed build_cost); the BPC
  // opportunity cost is not ISK the player fronts, so it stays out of the affordable-runs math.
  const { targets, materials, baseMaterials } = buildTargetsAndMaterials(db, products, 1, memo, "base", facility.meMult);
  let inputCost = 0;
  for (const item of required) {
    inputCost += lineCost(db, item.type_id, item.type_name, item.quantity, "sell", memo).walk.total_value;
  }
  let buildCost = 0;
  for (const material of materials) {
    buildCost += lineCost(
      db,
      material.type_id,
      getTypeName(db, material.type_id, memo),
      material.quantity,
      "sell",
      memo
    ).walk.total_value;
  }
  // The manufacturing job installation fee is real ISK the builder fronts, so it must be part of
  // the per-run capital the affordable-runs cap divides the budget by — otherwise runs*perRunCapital
  // sits under the budget while capital_required (which DOES include the fee) comes out over it, and
  // a 1,000 ISK budget could return a 1,081 ISK requirement. Manufacture rows only; mirrors the
  // isManufacture / eiv / jobCost path in calculateOffer.
  const isManufacture = variant === "base" && targets.some((target) => target.is_bpc);
  const eiv = isManufacture
    ? baseMaterials.reduce((sum, material) => {
        const adjusted = getAdjustedPrice(db, material.type_id, memo);
        return adjusted !== null ? sum + material.quantity * adjusted : sum;
      }, 0)
    : 0;
  const jobCost = isManufacture ? jobInstallationCost(eiv, facility.cost) : 0;
  return offer.isk_cost + inputCost + buildCost + jobCost;
}

function capitalRequiredForRuns(
  db: Db,
  offer: OfferBase,
  products: OfferItem[],
  required: OfferItem[],
  query: OfferQuery,
  memo: OfferCalcMemo,
  facility: Facility,
  variant: OfferVariant
): number {
  return query.iskBudget === undefined ? 0 : capitalPerRun(db, offer, products, required, memo, facility, variant);
}

function offerHasVanityTarget(db: Db, products: OfferItem[], targets: SalesTarget[], memo: OfferCalcMemo): boolean {
  const candidates = new Map<number, VanityTypeInput>();
  for (const product of products) {
    candidates.set(product.type_id, {
      type_id: product.type_id,
      name: product.type_name,
      group_id: product.group_id,
      group_name: product.group_name,
      category_id: product.category_id,
      category_name: product.category_name
    });
  }
  for (const target of targets) {
    candidates.set(target.type_id, getVanityType(db, target.type_id, target.name, memo));
    candidates.set(target.source_type_id, getVanityType(db, target.source_type_id, target.source_name, memo));
  }
  return [...candidates.values()].some(isVanityType);
}

// ---------------------------------------------------------------------------
// summarizeOfferCalc helpers
// ---------------------------------------------------------------------------

function summaryLine(line: BreakdownLine): SummaryLine {
  return {
    name: line.name,
    quantity: line.quantity,
    totalValue: line.walk.total_value,
    avgPrice: line.walk.avg_price,
    insufficientDepth: line.walk.insufficient_depth
  };
}

function summaryGroup(lines: SummaryLine[], limit: number): SummaryGroup {
  const totalCost = lines.reduce((sum, line) => sum + (line.totalValue ?? 0), 0);
  return {
    items: lines.slice(0, limit),
    remaining: Math.max(0, lines.length - limit),
    total: lines.length,
    names: lines.map((line) => line.name).join(", "),
    totalCost
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export function summarizeOfferCalc(row: OfferCalc, basis: Basis = "patientSell"): OfferSummary {
  const displayTargets = basis === "instantSell" ? row.instant_targets : row.sales_targets;
  const sourceOrders: SummaryLine[] = [];
  for (const target of displayTargets) {
    for (const order of target.walk.orders) {
      if (order.is_phantom) continue;
      sourceOrders.push({
        name: target.name,
        quantity: order.consumed_qty,
        totalValue: order.consumed_qty * order.price,
        avgPrice: order.price,
        locationId: order.location_id,
        insufficientDepth: false
      });
    }
  }

  const {
    products: _products,
    required_items: _requiredItems,
    sales_targets: _salesTargets,
    instant_targets: _instantTargets,
    input_lines: _inputLines,
    build_lines: _buildLines,
    fees: _fees,
    computed_at: _computedAt,
    ...summary
  } = row;

  return {
    ...summary,
    detail_summary: {
      store: {
        corpName: row.corp_name,
        station: row.corp_station ?? "Unknown station",
        system: row.corp_system ?? "unknown system",
        security: row.corp_security,
        runs: row.runs,
        capitalRequired: row.capital_required,
        buildCost: row.build_cost,
        jobCost: row.job_cost,
        storeCount: row.store_count ?? row.store_options?.length ?? 1,
        storeNames: (row.store_options ?? [storeOption(row)]).map((store) => store.corp_name).join(", ")
      },
      products: summaryGroup(displayTargets.map(summaryLine), 2),
      requiredItems: summaryGroup(row.input_lines.map(summaryLine), 3),
      buildMaterials: summaryGroup(row.build_lines.map(summaryLine), row.build_lines.length),
      sourceOrders: summaryGroup(sourceOrders, 4)
    }
  };
}

export function calculateOffer(
  db: Db,
  offerId: number,
  query: OfferQuery = {},
  memo: OfferCalcMemo = createOfferCalcMemo()
): OfferCalc | null {
  const variant: OfferVariant = offerId >= SELL_VARIANT_OFFSET ? "sell" : "base";
  const baseOfferId = variant === "sell" ? offerId - SELL_VARIANT_OFFSET : offerId;
  const offer = getOfferBase(db, baseOfferId, memo);
  if (!offer) return null;

  const products = getOfferItems(db, "offer_products", baseOfferId, memo);
  const requiredItems = getOfferItems(db, "offer_required_items", baseOfferId, memo);
  // Manufacturer-mode facility: material efficiency (build_cost) + job-cost params.
  // Default/absent resolves to the NPC, ME-0, house-default-index facility, so the
  // default-view rows are identical to the persisted calc table (no recompute needed).
  const facility = resolveFacility(query);
  const perRunCapital = capitalRequiredForRuns(db, offer, products, requiredItems, query, memo, facility, variant);
  const runs = effectiveRuns(offer.lp_cost, perRunCapital, query);
  if (runs <= 0) return null;

  const { targets, materials, baseMaterials, valid } = buildTargetsAndMaterials(
    db,
    products,
    runs,
    memo,
    variant,
    facility.meMult
  );
  if (!valid) return null;
  const patientTargets: SalesTarget[] = targets.map((target) => ({
    ...target,
    walk: walkOrders(getBook(db, target.type_id, "sell", memo), target.quantity)
  }));

  const inputLines = requiredItems.map((item) =>
    lineCost(db, item.type_id, item.type_name, item.quantity * runs, "sell", memo)
  );
  const buildLines = materials.map((material) =>
    lineCost(db, material.type_id, getTypeName(db, material.type_id, memo), material.quantity, "sell", memo)
  );

  const productValueInstant = targets.reduce((sum, target) => sum + target.walk.total_value, 0);
  const productValuePatient = patientTargets.reduce((sum, target) => sum + target.walk.total_value, 0);
  const inputCost = inputLines.reduce((sum, line) => sum + line.walk.total_value, 0);
  const buildCost = buildLines.reduce((sum, line) => sum + line.walk.total_value, 0);
  const iskCost = offer.isk_cost * runs;
  const lpCost = offer.lp_cost * runs;

  // Manufacturing job installation fee, manufacture rows only (the (sell) variant
  // runs no job, and non-BPC rows have no materials). EIV uses the ME-0 base
  // quantities (job fees ignore material efficiency) against CCP adjusted prices;
  // materials CCP does not price are skipped, so job cost is understated, never wrong.
  const isManufacture = variant === "base" && targets.some((target) => target.is_bpc);
  const eiv = isManufacture
    ? baseMaterials.reduce((sum, material) => {
        const adjusted = getAdjustedPrice(db, material.type_id, memo);
        return adjusted !== null ? sum + material.quantity * adjusted : sum;
      }, 0)
    : 0;
  const jobCost = isManufacture ? jobInstallationCost(eiv, facility.cost) : 0;
  // Contract-sale channel: zero market fees. The skill-driven feeRates() floor at
  // ~3.375% tax / 1% broker, so this is the only way to model the ~0-fee item-exchange
  // contract path that high-value faction LP items are actually sold through.
  const fees = query.noMarketFees ? { salesTaxRate: 0, brokerFeeRate: 0 } : feeRates(query);

  // Contract-priced targets have no bid book — public contracts are ask-only.
  // When every output is contract-priced the instant channel does not exist,
  // and pretending it nets -isk_cost would just rank honest rows as losses.
  const contractPriced = (target: SalesTarget): boolean => memo.contractPricedBooks.has(target.type_id);
  const hasInstantChannel = targets.length === 0 || targets.some((target) => !contractPriced(target));
  const netInstant = hasInstantChannel
    ? productValueInstant * (1 - fees.salesTaxRate) - iskCost - inputCost - buildCost - jobCost
    : null;
  // The consumed BPC was paid for in LP, not ISK: it is neither deducted from net
  // profit nor counted as deployed capital. The alternative of selling it instead
  // of building is represented by the separate (sell) variant row, not here. The job
  // installation fee, by contrast, IS real ISK the builder fronts — it deducts from
  // net (above and below) and counts toward deployed capital.
  const capitalRequired = iskCost + inputCost + buildCost + jobCost;
  const primaryTarget = targets[0];
  const primaryPatient = patientTargets[0];
  const primaryHistory = primaryTarget ? getHistory(db, primaryTarget.type_id, memo) : null;
  const avgDailyVolume = primaryHistory?.avg_daily_volume_28d ?? null;
  const fill: FillEstimate = primaryPatient
    ? estimateDaysToFill(
        getBook(db, primaryPatient.type_id, "sell", memo),
        primaryPatient.walk.avg_price,
        primaryPatient.quantity,
        avgDailyVolume
      )
    : emptyFillEstimate;

  // Contract-priced product value skips the percentage market fees: item-exchange
  // contracts pay a flat creation fee (~10k ISK, noise at BPC price scale) and no
  // sales tax. Market-priced product value keeps the normal tax + broker model.
  const contractValuePatient = patientTargets.reduce(
    (sum, target) => (memo.contractPricedBooks.has(target.type_id) ? sum + target.walk.total_value : sum),
    0
  );
  const marketValuePatient = productValuePatient - contractValuePatient;
  let netPatient =
    marketValuePatient * (1 - fees.salesTaxRate - fees.brokerFeeRate) +
    contractValuePatient -
    iskCost -
    inputCost -
    buildCost -
    jobCost;
  if (query.realisticPatient && fill.daysToFill !== null && netInstant !== null) {
    const relistCost =
      expectedRelists(fill.daysToFill) *
      (1 - relistDiscount(query.advBro ?? 0)) *
      fees.brokerFeeRate *
      marketValuePatient;
    netPatient = effectivePatientNet(netInstant, netPatient - relistCost, fill.daysToFill);
  }

  // Contract-priced targets have no order book BY DEFINITION — an empty buy side
  // is not "insufficient depth" and zero orders are not a "thin book". Their one
  // honest signal is the CONTRACT_PRICED flag below; market-microstructure flags
  // would make every such row suspicious-by-construction and hide it.
  const insufficientDepth =
    targets.some((target) => !contractPriced(target) && target.walk.insufficient_depth) ||
    patientTargets.some((target) => !contractPriced(target) && target.walk.insufficient_depth) ||
    inputLines.some((line) => line.walk.insufficient_depth) ||
    buildLines.some((line) => line.walk.insufficient_depth);

  const flags = [
    ...(primaryTarget && !contractPriced(primaryTarget)
      ? lineQualityFlags(db, primaryTarget, "Output", memo, insufficientDepth, fill.queueAhead)
      : []),
    ...materialCostLineFlags(db, inputLines, "Required input", capitalRequired, memo),
    ...materialCostLineFlags(db, buildLines, "Build material", capitalRequired, memo)
  ];
  const contractPricedRow = patientTargets.some((target) => memo.contractPricedBooks.has(target.type_id));
  for (const target of patientTargets) {
    if (!memo.contractPricedBooks.has(target.type_id)) continue;
    const contract = memo.contractPrice.get(target.type_id);
    if (!contract) continue;
    flags.push({
      code: "CONTRACT_PRICED",
      severity: "warn",
      message: `Output ${target.name}: Valued from ${contract.ask_count} public-contract asks (as of ${contract.updated_at.slice(0, 10)}); sells via contracts only, no instant-sell channel.`
    });
    // A contract-priced BPC competes for a market that consumes the BUILT product.
    // When one copy covers half a day or more of the product's entire Jita volume,
    // global demand for fresh copies is a handful per day — say so with numbers.
    const recipe = getRecipe(db, target.type_id, memo);
    const dailyVolume = recipe ? getHistory(db, recipe.product_type_id, memo)?.avg_daily_volume_28d : null;
    if (recipe && dailyVolume && dailyVolume > 0) {
      const daysOfDemand = (target.quantity * recipe.runs) / dailyVolume;
      if (daysOfDemand >= 0.5) {
        flags.push({
          code: "NICHE_DEMAND",
          severity: "warn",
          message:
            `Output ${target.name}: One ${target.quantity}-run copy ≈ ${daysOfDemand.toFixed(1)} days of total Jita demand for ` +
            `${getTypeName(db, recipe.product_type_id, memo)} (~${Math.round(dailyVolume).toLocaleString("en-US")}/day); sale velocity, not LP/hour, is the bottleneck.`
        });
      }
    }
  }

  const cargo = targets.reduce((sum, target) => sum + getPackagedVolume(db, target.type_id, memo) * target.quantity, 0);
  const daysOfSupply = primaryTarget && avgDailyVolume && avgDailyVolume > 0 ? primaryTarget.quantity / avgDailyVolume : null;
  const instantRatio = lpCost > 0 && netInstant !== null ? netInstant / lpCost : null;
  const patientRatio = lpCost > 0 ? netPatient / lpCost : null;
  const selectedRatio = ratioForBasis(instantRatio, patientRatio, valuationBasis(query));
  const isVanity = offerHasVanityTarget(db, products, targets, memo);

  // (sell) rows flip the BPC to a direct contract sale: the only ISK "capital" is
  // the token LP-store fee (no materials, no build), so net / fee balloons into the
  // thousands of percent and means nothing — the row's real cost is LP, which ROI
  // can't express. Suppress it like isk_per_hour; isk_per_lp carries the signal.
  const roiInstant =
    variant === "sell" || capitalRequired <= 0 || netInstant === null ? null : netInstant / capitalRequired;
  const roiPatient = variant === "sell" || capitalRequired <= 0 ? null : netPatient / capitalRequired;

  return {
    offer_id: variant === "sell" ? offer.offer_id + SELL_VARIANT_OFFSET : offer.offer_id,
    corp_id: offer.corp_id,
    corp_name: offer.corp_name,
    risk_tier: normalizeRiskTier(offer.risk_tier),
    access_risk_tier: normalizeRiskTier(offer.access_risk_tier),
    corp_system: offer.hq_system_name,
    corp_station: offer.hq_station_name,
    corp_security: offer.hq_security_status,
    lp_source_tier: offer.lp_source_tier,
    has_level5_agent: offer.has_level5_agent === 1,
    offer_name: targets
      .map((target) => {
        if (target.is_bpc) return `${target.source_name} (manufacture)`;
        if (variant === "sell") return `${target.name} (sell)`;
        return target.name;
      })
      .join(" + "),
    lp_cost: lpCost,
    isk_cost: iskCost,
    runs,
    required_standing: offer.required_standing,
    is_fw: offer.is_fw === 1,
    is_vanity: isVanity,
    products,
    required_items: requiredItems,
    sales_targets: patientTargets,
    instant_targets: targets,
    input_lines: inputLines,
    build_lines: buildLines,
    product_value_instant: productValueInstant,
    product_value_patient: productValuePatient,
    input_cost: inputCost,
    build_cost: buildCost,
    job_cost: jobCost,
    net_profit_instant: netInstant,
    net_profit_patient: netPatient,
    isk_per_lp: selectedRatio,
    isk_per_lp_instant: instantRatio,
    isk_per_lp_patient: patientRatio,
    capital_required: capitalRequired,
    roi_instant: roiInstant,
    roi_patient: roiPatient,
    days_of_supply: daysOfSupply,
    days_to_fill: fill.daysToFill,
    fill_queue_ahead: primaryPatient ? fill.queueAhead : null,
    avg_daily_volume_28d: avgDailyVolume,
    cargo_m3: cargo,
    contract_priced: contractPricedRow,
    // Contract-priced rows: isk_per_lp is a real marginal rate, but no hourly
    // rate exists — demand caps at a handful of contracts per day, not LP/hour.
    // No rate on this path (persist/compute) yields null, matching the old
    // `query.lpPerHour &&` truthiness (undefined/0 rate → null).
    isk_per_hour: iskPerHour(selectedRatio, query.lpPerHour ?? 0, contractPricedRow),
    fees,
    flags,
    fetched_at: offer.fetched_at,
    computed_at: nowIso()
  };
}

// ---------------------------------------------------------------------------
// calcRowsExist — used by offer-list only, exported for it
// ---------------------------------------------------------------------------

export function calcRowsExist(db: Db): boolean {
  return Boolean(statements(db).calcRowsExist.get([]));
}

// ---------------------------------------------------------------------------
// withStoreOptions — used by offer-list for store grouping
// ---------------------------------------------------------------------------

export function withStoreOptions(row: OfferCalc, options: StoreOption[]): OfferCalc {
  const storeOptions = uniqueStoreOptionsByCorpId(options);
  return {
    ...row,
    access_risk_tier: leastRiskTier(storeOptions.map((store) => store.access_risk_tier)),
    store_count: storeOptions.length,
    store_options: storeOptions
  };
}
