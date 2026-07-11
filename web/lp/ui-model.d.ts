export interface OfferFlag {
  code?: string;
  severity?: string;
  message?: string;
}

export interface OfferRow {
  offer_id?: number;
  corp_id?: number;
  corp_name?: string;
  store_count?: number;
  store_options?: StoreOption[];
  offer_name?: string;
  isk_per_lp?: number | null;
  isk_per_lp_instant?: number | null;
  isk_per_lp_patient?: number | null;
  roi_instant?: number | null;
  rank?: number;
  roi_patient?: number | null;
  lp_cost?: number;
  isk_cost?: number;
  runs?: number;
  required_standing?: number | null;
  is_fw?: boolean;
  is_vanity?: boolean;
  product_value_instant?: number;
  product_value_patient?: number;
  input_cost?: number;
  capital_required?: number;
  build_cost?: number;
  net_profit_instant?: number | null;
  net_profit_patient?: number;
  isk_per_hour?: number | null;
  cargo_m3?: number;
  days_of_supply?: number;
  days_to_fill?: number | null;
  fill_queue_ahead?: number | null;
  avg_daily_volume_28d?: number | null;
  risk_tier?: string;
  access_risk_tier?: string;
  corp_station?: string;
  corp_system?: string;
  corp_security?: number;
  computed_at?: string;
  fetched_at?: string;
  flags?: OfferFlag[];
  sales_targets?: OfferLine[];
  input_lines?: OfferLine[];
  build_lines?: OfferLine[];
}

export interface StoreOption {
  corp_id?: number;
  corp_name: string;
  risk_tier?: string;
  access_risk_tier?: string;
  corp_system?: string | null;
  corp_station?: string | null;
  corp_security?: number | null;
}

export interface OfferLine {
  name?: string;
  type_name?: string;
  quantity?: number;
  walk?: {
    total_value?: number;
    avg_price?: number;
    insufficient_depth?: boolean;
    orders?: Array<{
      consumed_qty?: number;
      qty?: number;
      price?: number;
      location_id?: number;
    }>;
  };
}

export interface OfferMetrics {
  offerCount: number;
  bestInstant: OfferRow | null;
  bestPatient: OfferRow | null;
  bestIskPerHour: number | null;
  medianIskPerLp: number | null;
  totalOffers: number;
  totalLpVolume: number | null;
  totalIskVolume: number | null;
  priceHealth: {
    label: string;
    tone: "good" | "warn" | "bad" | "muted";
    note: string;
  };
}

export interface HealthPayload {
  status?: string;
  issues?: string[];
  cloudflare_purge?: CloudflarePurgeRecord | null;
}

export interface CloudflarePurgeRecord {
  status: "ok" | "skipped" | "error";
  status_code?: number | null;
  error?: string | null;
  reason?: string | null;
  at?: string | null;
}

export interface CloudflarePurgeClassification {
  label: "Edge purged" | "Edge purge stale" | "Edge purge failing" | "Edge purge off" | "Edge purge -";
  tone: "good" | "warn" | "bad" | "muted";
  detail: string;
}

export interface HealthClassification {
  label: "Healthy" | "Needs attention" | "Unavailable";
  tone: "good" | "bad" | "muted";
}

export interface FetcherStatus {
  name: string;
  last_success?: string | null;
  last_error_at?: string | null;
  last_error_msg?: string | null;
}

export interface FetcherFreshnessClassification {
  tone: "good" | "bad";
  issue: string | null;
}

export interface DetailDrawerSummary {
  store: {
    corpName: string;
    station: string;
    system: string;
    security: number | null;
    runs: number | null;
    capitalRequired: number | null;
    buildCost: number | null;
    storeCount: number;
  };
  products: DetailLineGroup;
  requiredItems: DetailLineGroup;
  buildMaterials: DetailLineGroup;
  sourceOrders: DetailLineGroup;
}

export interface DetailLineGroup {
  items: Array<{
    name: string;
    quantity: number | null;
    totalValue?: number | null;
    avgPrice?: number | null;
    locationId?: number | null;
    insufficientDepth?: boolean;
  }>;
  remaining: number;
  total: number;
  names: string;
  totalCost: number | null;
}

export interface CorpOption {
  corp_id: number;
  name: string;
  risk_tier?: string;
  lp_source_tier?: string;
}

export type ValuationBasis = "instantSell" | "patientSell" | "best";

export function deriveOfferMetrics(
  rows: OfferRow[] | null | undefined,
  lpPerHourValue: string,
  basisValue?: ValuationBasis
): OfferMetrics;
export function isNoValue(value: unknown): boolean;
export function compactMagnitude(value: number, format: (value: number) => string, suffix?: string): string;
export function formatDailyVolume(value: number | null | undefined): string;
export function offerIskPerLp(row: OfferRow | null | undefined, basisValue?: ValuationBasis): number | null;
export function offerRoi(row: OfferRow | null | undefined, basisValue?: ValuationBasis): number | null;
export function cargoFlag(row: OfferRow | null | undefined): OfferFlag | null;
export function summarizeDetailDrawer(row: OfferRow | null | undefined): DetailDrawerSummary | null;
export function resolveCorpOption(options: CorpOption[] | null | undefined, value: string | null | undefined): CorpOption | null;
export function classifyHealth(health: HealthPayload | null | undefined): HealthClassification;
export function classifyCloudflarePurge(
  purge: CloudflarePurgeRecord | null | undefined,
  nowMs?: number
): CloudflarePurgeClassification;
export function selectLatestFetcherStatus(fetchers: FetcherStatus[] | null | undefined, names: string[]): FetcherStatus | null;
export function classifyFetcherFreshness(
  fetcher: FetcherStatus | null | undefined,
  maxAgeMs: number,
  nowMs?: number
): FetcherFreshnessClassification;
