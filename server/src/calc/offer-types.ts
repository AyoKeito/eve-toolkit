import type { feeRates, FeeParams } from "./fees.js";
import type { WalkResult } from "./depth.js";
import type { QualityFlag } from "./flags.js";
import type { RiskTier } from "./risk.js";

export type Basis = "instantSell" | "patientSell" | "best";
export type LpSourceTier = "STANDARD" | "SPECIAL";
export type Level5MissionsMode = "show" | "only" | "hide";
/** Which blueprint-copy rows to show: direct contract sale rows ("sell"),
 * manufacture conversion rows ("manufacture"), both ("all"), or neither ("none"). */
export type BpcMode = "none" | "sell" | "manufacture" | "all";
export type SortBy =
  | "rank"
  | "lp"
  | "isk"
  | "iskPerLp"
  | "instant"
  | "patient"
  | "roi"
  | "iskPerHour"
  | "volume"
  | "daysOfSupply";
export type SortDir = "asc" | "desc";

export interface OfferQuery extends Partial<FeeParams> {
  n?: number;
  all?: boolean;
  basis?: Basis;
  corp?: number;
  minLp?: number;
  maxRiskTier?: RiskTier;
  minVolume?: number;
  maxM3?: number;
  jita44Only?: boolean;
  hideSuspicious?: boolean;
  hideVanity?: boolean;
  hideNoSecurity?: boolean;
  /** Blueprint-copy row mode. Default "sell". */
  bpc?: BpcMode;
  includeSpecial?: boolean;
  level5Missions?: Level5MissionsMode;
  hasLevel5Agent?: boolean;
  showDuplicateStores?: boolean;
  maxStanding?: number;
  includeFW?: boolean;
  runs?: number;
  lpBudget?: number;
  iskBudget?: number;
  lpPerHour?: number;
  /** Discount patient valuations by estimated fill time and relist fees. Default off. */
  realisticPatient?: boolean;
  /** Sell via item-exchange contract instead of the market: zeroes sales tax + broker
   * fee (the skill sliders floor at ~3.375% tax / 1% broker and can never reach 0).
   * Models the channel serious LP farmers actually use for high-value faction items. */
  noMarketFees?: boolean;
  /** Manufacturer-mode facility preset ("npc" | "highsec-t2" | "null-t2"). Drives the
   * Material Efficiency multiplier on build materials. Default/absent = "npc" (ME 0). */
  facility?: string;
  /** Manufacturing system cost index as a percent (0–100). Drives the job-installation
   * fee. Default/absent = the conservative house default. */
  costIndex?: number;
  /** Advanced Broker Relations level (0-5); discounts relist fees in realistic-patient mode. */
  advBro?: number;
  sortBy?: SortBy;
  sortDir?: SortDir;
  search?: string;
  corpSearch?: string;
}

export interface BreakdownLine {
  type_id: number;
  name: string;
  quantity: number;
  walk: WalkResult;
}

export interface SalesTarget extends BreakdownLine {
  source_type_id: number;
  source_name: string;
  is_bpc: boolean;
}

export interface StoreOption {
  corp_id: number;
  corp_name: string;
  risk_tier: RiskTier;
  access_risk_tier: RiskTier;
  corp_system: string | null;
  corp_station: string | null;
  corp_security: number | null;
}

export interface OfferCalc {
  rank?: number;
  offer_id: number;
  corp_id: number;
  corp_name: string;
  store_count?: number;
  store_options?: StoreOption[];
  risk_tier: RiskTier;
  access_risk_tier: RiskTier;
  corp_system: string | null;
  corp_station: string | null;
  corp_security: number | null;
  lp_source_tier: LpSourceTier;
  has_level5_agent: boolean;
  offer_name: string;
  lp_cost: number;
  isk_cost: number;
  runs: number;
  required_standing: number | null;
  is_fw: boolean;
  is_vanity: boolean;
  products: OfferItem[];
  required_items: OfferItem[];
  sales_targets: SalesTarget[];
  instant_targets: SalesTarget[];
  input_lines: BreakdownLine[];
  build_lines: BreakdownLine[];
  product_value_instant: number;
  product_value_patient: number;
  input_cost: number;
  build_cost: number;
  /** Manufacturing job installation fee (EIV-based). 0 for non-manufacture rows.
   * Real ISK the builder fronts, so it deducts from net profit AND adds to capital. */
  job_cost: number;
  /** Null when no instant channel exists (contract-priced outputs have no bid book). */
  net_profit_instant: number | null;
  net_profit_patient: number;
  isk_per_lp: number | null;
  isk_per_lp_instant: number | null;
  isk_per_lp_patient: number | null;
  capital_required: number;
  roi_instant: number | null;
  roi_patient: number | null;
  days_of_supply: number | null;
  /** Estimated days for a patient listing of the primary output to fill (queue-aware). */
  days_to_fill: number | null;
  /** Sell-book units listed at or below the patient walk's average price for the primary output. */
  fill_queue_ahead: number | null;
  avg_daily_volume_28d: number | null;
  cargo_m3: number;
  /** True when any sales target is valued from contract asks. Such rows have no
   * sustainable sale velocity, so isk_per_hour stays null — extrapolating the
   * contract price by LP/hour would invent income the market cannot absorb. */
  contract_priced: boolean;
  isk_per_hour: number | null;
  fees: ReturnType<typeof feeRates>;
  flags: QualityFlag[];
  fetched_at: string;
  computed_at: string;
}

// OfferItem is part of the OfferCalc public surface (OfferCalc.products / required_items).
// Kept here so OfferCalc does not need to import from offer-calc.
export interface OfferItem {
  type_id: number;
  type_name: string;
  quantity: number;
  group_id: number | null;
  group_name: string | null;
  category_id: number | null;
  category_name: string | null;
  packaged_volume: number | null;
}

// SummaryLine / SummaryGroup / OfferDetailSummary are internal to summarizeOfferCalc
// but must live here because OfferSummary (exported) references OfferDetailSummary.
// They are exported so offer-calc.ts can use them without re-declaring them.
export interface SummaryLine {
  name: string;
  quantity: number | null;
  totalValue: number | null;
  avgPrice: number | null;
  locationId?: number | null;
  insufficientDepth: boolean;
}

export interface SummaryGroup {
  items: SummaryLine[];
  remaining: number;
  total: number;
  names: string;
  totalCost: number;
}

export interface OfferDetailSummary {
  store: {
    corpName: string;
    station: string;
    system: string;
    security: number | null;
    runs: number;
    capitalRequired: number;
    buildCost: number;
    jobCost: number;
    storeCount: number;
    storeNames: string;
  };
  products: SummaryGroup;
  requiredItems: SummaryGroup;
  buildMaterials: SummaryGroup;
  sourceOrders: SummaryGroup;
}

export type OfferSummary = Omit<
  OfferCalc,
  | "products"
  | "required_items"
  | "sales_targets"
  | "instant_targets"
  | "input_lines"
  | "build_lines"
  | "fees"
  | "computed_at"
> & {
  detail_summary: OfferDetailSummary;
};

// ---------------------------------------------------------------------------
// Shared pure helpers used by both offer-list and offer-persist.
// ---------------------------------------------------------------------------

export function valuationBasis(query: OfferQuery): Basis {
  return query.basis ?? "best";
}

/** Default LP/hour rate assumed when a request supplies none. The isk_per_hour
 * rewrite treats an absent or exactly-default rate as "no rewrite", so this value
 * is load-bearing for the response cache key / ETag (see api/offers, query). */
export const DEFAULT_LP_PER_HOUR = 30000;

/** Highest of the supplied finite ratios, or null when none are finite. */
export function bestRatio(...values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}

/** The isk_per_lp ratio a given valuation basis selects (best = higher of the two). */
export function ratioForBasis(instant: number | null, patient: number | null, basis: Basis): number | null {
  switch (basis) {
    case "instantSell":
      return instant;
    case "patientSell":
      return patient;
    case "best":
      return bestRatio(instant, patient);
  }
}

/**
 * ISK/hour for a row: the basis ratio times the LP/hour rate. Null when the row is
 * contract-priced (no sustainable sale velocity, so extrapolating by LP/hour would
 * invent income the market cannot absorb), when the ratio is absent, or when the
 * rate is non-positive/non-finite. Single source of truth for the rule otherwise
 * duplicated across the live calc, materialization, and post-hoc rewrite paths.
 */
export function iskPerHour(ratio: number | null, rate: number, contractPriced: boolean): number | null {
  if (contractPriced || ratio === null) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return ratio * rate;
}

export function lineSignature(lines: BreakdownLine[]): string[] {
  return lines
    .map((line) => `${line.type_id}:${line.quantity}`)
    .sort((a, b) => a.localeCompare(b));
}

export function targetSignature(lines: SalesTarget[]): string[] {
  return lines
    .map((line) => `${line.source_type_id}:${line.type_id}:${line.quantity}:${line.is_bpc ? 1 : 0}`)
    .sort((a, b) => a.localeCompare(b));
}

export function storeOption(row: OfferCalc): StoreOption {
  return {
    corp_id: row.corp_id,
    corp_name: row.corp_name,
    risk_tier: row.risk_tier,
    access_risk_tier: row.access_risk_tier,
    corp_system: row.corp_system,
    corp_station: row.corp_station,
    corp_security: row.corp_security
  };
}
