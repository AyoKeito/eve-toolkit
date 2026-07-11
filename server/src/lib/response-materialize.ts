import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { compressBrotli } from "./compress.js";
import { type Basis, type OfferQuery, type OfferSummary, type SortBy } from "../calc/ratio.js";
// Value imports come from the leaf modules, not the ratio.js barrel: the barrel
// re-exports offer-persist, which value-imports this module, so routing a value
// through it would create a partial-export init cycle. (The ratio.js imports above
// are type-only and erased at runtime, so they carry no such edge.)
import { listOfferCalcs } from "../calc/offer-list.js";
import { SELL_VARIANT_OFFSET, summarizeOfferCalc } from "../calc/offer-calc.js";
// Value imports from the leaf modules (not the ratio.js barrel — see note above).
import { DEFAULT_LP_PER_HOUR, iskPerHour, ratioForBasis } from "../calc/offer-types.js";
import { sortExpr } from "../calc/offer-sort.js";
import { leastRiskTier, normalizeRiskTier, type RiskTier } from "../calc/risk.js";
import { uniqueStoreOptionsByCorpId } from "./offer-grouping.js";
import { computeGenerationEtag, currentComputeGeneration } from "./compute-generation.js";
import type { CachedResponse } from "./response-cache.js";

type ResponseCacheRow = {
  generation: number;
  content_type: string;
  body: Buffer;
  body_brotli: Buffer | null;
  etag: string;
};

interface BuiltResponseCacheRecord {
  cacheKey: string;
  generation: number;
  contentType: string;
  body: Buffer;
  bodyBrotli: Buffer;
  etag: string;
  computedAt: string;
}

type SummaryCacheRow = {
  summary: string | null;
  offer_id: number;
  corp_id: number;
  corp_name: string;
  risk_tier: string;
  access_risk_tier: string;
  lp_source_tier: string;
  offer_name: string;
  product_signature: string;
  required_signature: string;
  required_standing: number | null;
  is_fw: number;
  lp_cost: number;
  isk_cost: number;
  isk_per_lp_instant: number | null;
  isk_per_lp_patient: number | null;
  roi_instant: number | null;
  avg_daily_volume_28d: number | null;
  days_to_fill: number | null;
  cargo_m3: number | null;
  flags_json: string;
};

export function normalizeOfferQuery(query: OfferQuery): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (query.n !== undefined && query.n !== 100) out.n = query.n;
  if (query.basis !== undefined && query.basis !== "best") out.basis = query.basis;
  if (query.corp !== undefined) out.corp = query.corp;
  if (query.minLp !== undefined) out.minLp = query.minLp;
  if (query.maxRiskTier !== undefined && query.maxRiskTier !== "NULLSEC") out.maxRiskTier = query.maxRiskTier;
  if (query.minVolume !== undefined && query.minVolume !== 0) out.minVolume = query.minVolume;
  if (query.maxM3 !== undefined) out.maxM3 = query.maxM3;
  if (query.jita44Only) out.jita44Only = true;
  if (query.hideSuspicious === false) out.hideSuspicious = false;
  if (query.hideVanity === false) out.hideVanity = false;
  if (query.hideNoSecurity === false) out.hideNoSecurity = false;
  if (query.bpc !== undefined && query.bpc !== "none") out.bpc = query.bpc;
  if (query.includeSpecial) out.includeSpecial = true;
  if (query.level5Missions !== undefined && query.level5Missions !== "show") out.level5Missions = query.level5Missions;
  if (query.showDuplicateStores) out.showDuplicateStores = true;
  if (query.acc !== undefined && query.acc !== 0) out.acc = query.acc;
  if (query.bro !== undefined && query.bro !== 0) out.bro = query.bro;
  if (query.realisticPatient) out.realisticPatient = true;
  // Manufacturer-mode overrides change the live-computed economics (fees, ME,
  // job cost) away from the persisted/materialized default-view rows, so they MUST
  // participate in the response cache key or an override request short-circuits to
  // the materialized default body before the live-path guards in offer-list run.
  if (query.noMarketFees) out.noMarketFees = true;
  if (query.facility !== undefined && query.facility !== "npc") out.facility = query.facility;
  if (query.costIndex !== undefined) out.costIndex = query.costIndex;
  if (query.advBro !== undefined && query.advBro !== 0) out.advBro = query.advBro;
  if (query.factionStand !== undefined && query.factionStand !== 0) out.factionStand = query.factionStand;
  if (query.corpStand !== undefined && query.corpStand !== 0) out.corpStand = query.corpStand;
  if (query.maxStanding !== undefined && query.maxStanding !== 0) out.maxStanding = query.maxStanding;
  if (query.includeFW) out.includeFW = true;
  if (query.runs !== undefined) out.runs = query.runs;
  if (query.lpBudget !== undefined) out.lpBudget = query.lpBudget;
  if (query.iskBudget !== undefined) out.iskBudget = query.iskBudget;
  if (query.sortBy !== undefined && query.sortBy !== "iskPerLp") out.sortBy = query.sortBy;
  if (query.search?.trim()) out.search = query.search.trim();
  if (query.corpSearch?.trim()) out.corpSearch = query.corpSearch.trim();
  return out;
}

export function responseCacheKey(path: string, query: OfferQuery | Record<string, unknown>): string {
  const normalized = normalizeOfferQuery(query as OfferQuery);
  const keys = Object.keys(normalized).sort();
  // encodeURIComponent both sides so a free-text value containing "&" or "=" (only search /
  // corpSearch can) cannot merge into an adjacent pair. Without this, {corpSearch:"x&search=y"}
  // and {corpSearch:"x", search:"y"} produced the identical key and served one query's cached
  // body + ETag for the other. Numeric/enum/boolean values encode to themselves, so the common
  // materialized keys stay byte-identical (no cache migration).
  return `${path} ${keys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(normalized[key]))}`)
    .join("&")}`;
}

export function readMaterializedResponse(db: Db, key: string): CachedResponse | null {
  const row = db
    .prepare("SELECT generation, content_type, body, body_brotli, etag FROM response_cache WHERE cache_key=?")
    .get(key) as ResponseCacheRow | undefined;
  if (!row) return null;
  if (row.generation !== currentComputeGeneration(db)) return null;
  if (row.etag !== computeGenerationEtag(row.generation)) return null;
  return {
    body: row.body,
    brotli: row.body_brotli ?? undefined,
    etag: row.etag,
    contentType: row.content_type
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]|^[=+\-@\t\r]/.test(text) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

export function offerRowsToCsv(rows: OfferSummary[]): string {
  const headers = [
    "rank",
    "offer_id",
    "corp",
    "stores",
    "risk_tier",
    "access_risk_tier",
    "offer",
    "lp_cost",
    "isk_cost",
    "isk_per_lp",
    "isk_per_lp_instant",
    "isk_per_lp_patient",
    "roi_instant",
    "avg_daily_volume_28d",
    "days_to_fill",
    "cargo_m3",
    "flags"
  ];
  return `${[
    headers.join(","),
    ...rows.map((row) =>
      [
        row.rank,
        row.offer_id,
        row.corp_name,
        row.store_count ?? 1,
        row.risk_tier,
        row.access_risk_tier,
        row.offer_name,
        row.lp_cost,
        row.isk_cost,
        row.isk_per_lp,
        row.isk_per_lp_instant,
        row.isk_per_lp_patient,
        row.roi_instant,
        row.avg_daily_volume_28d,
        row.days_to_fill,
        row.cargo_m3,
        row.flags.map((flag) => flag.code).join("|")
      ]
        .map(csvCell)
        .join(",")
    )
  ].join("\n")}\n`;
}

function fallbackSummary(row: SummaryCacheRow, basis: Basis = "best"): OfferSummary {
  const flags = currentFlags(row);
  const selectedRatio = ratioForBasis(row.isk_per_lp_instant, row.isk_per_lp_patient, basis);
  return {
    rank: undefined,
    offer_id: row.offer_id,
    corp_id: row.corp_id,
    corp_name: row.corp_name,
    risk_tier: normalizeRiskTier(row.risk_tier as RiskTier) as OfferSummary["risk_tier"],
    access_risk_tier: normalizeRiskTier(row.access_risk_tier as RiskTier) as OfferSummary["access_risk_tier"],
    corp_system: null,
    corp_station: null,
    corp_security: null,
    lp_source_tier: row.lp_source_tier as OfferSummary["lp_source_tier"],
    has_level5_agent: false,
    offer_name: row.offer_name,
    lp_cost: row.lp_cost,
    isk_cost: row.isk_cost,
    runs: 1,
    required_standing: row.required_standing,
    is_fw: row.is_fw === 1,
    is_vanity: false,
    product_value_instant: 0,
    product_value_patient: 0,
    input_cost: 0,
    build_cost: 0,
    job_cost: 0,
    net_profit_instant: 0,
    net_profit_patient: 0,
    isk_per_lp: selectedRatio,
    isk_per_lp_instant: row.isk_per_lp_instant,
    isk_per_lp_patient: row.isk_per_lp_patient,
    capital_required: 0,
    roi_instant: row.roi_instant,
    roi_patient: null,
    days_of_supply: null,
    days_to_fill: row.days_to_fill,
    fill_queue_ahead: null,
    avg_daily_volume_28d: row.avg_daily_volume_28d,
    cargo_m3: row.cargo_m3 ?? 0,
    contract_priced: false,
    isk_per_hour: iskPerHour(selectedRatio, DEFAULT_LP_PER_HOUR, false),
    flags,
    fetched_at: "",
    detail_summary: {
      store: {
        corpName: row.corp_name,
        station: "Unknown station",
        system: "unknown system",
        security: null,
        runs: 1,
        capitalRequired: 0,
        buildCost: 0,
        jobCost: 0,
        storeCount: 1,
        storeNames: row.corp_name
      },
      products: { items: [], remaining: 0, total: 0, names: row.offer_name, totalCost: 0 },
      requiredItems: { items: [], remaining: 0, total: 0, names: "", totalCost: 0 },
      buildMaterials: { items: [], remaining: 0, total: 0, names: "", totalCost: 0 },
      sourceOrders: { items: [], remaining: 0, total: 0, names: "", totalCost: 0 }
    }
  };
}

function currentFlags(row: SummaryCacheRow): OfferSummary["flags"] {
  return JSON.parse(row.flags_json || "[]") as OfferSummary["flags"];
}

function storeOption(row: OfferSummary): NonNullable<OfferSummary["store_options"]>[number] {
  return {
    corp_id: row.corp_id,
    corp_name: row.corp_name,
    risk_tier: normalizeRiskTier(row.risk_tier as RiskTier) as OfferSummary["risk_tier"],
    access_risk_tier: normalizeRiskTier((row.access_risk_tier ?? row.risk_tier) as RiskTier) as OfferSummary["access_risk_tier"],
    corp_system: row.corp_system,
    corp_station: row.corp_station,
    corp_security: row.corp_security
  };
}

function groupSignature(row: SummaryCacheRow): string {
  return JSON.stringify({
    lpCost: row.lp_cost,
    iskCost: row.isk_cost,
    requiredStanding: row.required_standing,
    isFw: row.is_fw,
    lpSourceTier: row.lp_source_tier,
    products: row.product_signature,
    required: row.required_signature
  });
}

function uniqueStoreOptions(options: NonNullable<OfferSummary["store_options"]>): NonNullable<OfferSummary["store_options"]> {
  return uniqueStoreOptionsByCorpId(options);
}

const hotSorts100: SortBy[] = ["iskPerLp", "instant", "patient", "lp", "isk", "roi", "iskPerHour", "volume"];
const hotSortsDeep: SortBy[] = ["iskPerLp", "instant", "patient", "volume"];

function canonicalOfferRows(db: Db, limit: number, sortBy: SortBy = "iskPerLp", basis: Basis = "best"): OfferSummary[] {
  const orderExpr = sortExpr(sortBy, basis);
  const rows = db.prepare(`
    SELECT
      calc.api_summary_json AS summary,
      calc.offer_id,
      calc.corp_id,
      corp.name AS corp_name,
      calc.risk_tier,
      COALESCE(NULLIF(calc.access_risk_tier, ''), calc.risk_tier) AS access_risk_tier,
      calc.lp_source_tier,
      calc.offer_name,
      calc.product_signature,
      calc.required_signature,
      calc.required_standing,
      calc.is_fw,
      o.lp_cost,
      o.isk_cost,
      calc.isk_per_lp_instant,
      calc.isk_per_lp_patient,
      calc.roi_instant,
      calc.avg_daily_volume_28d,
      calc.days_to_fill,
      calc.cargo_m3,
      calc.flags_json
    FROM calc
    JOIN offers o ON o.offer_id=(CASE WHEN calc.offer_id >= ${SELL_VARIANT_OFFSET} THEN calc.offer_id - ${SELL_VARIANT_OFFSET} ELSE calc.offer_id END)
    JOIN corporations corp ON corp.corp_id=calc.corp_id
    WHERE calc.lp_source_tier!='SPECIAL'
      AND calc.is_fw=0
      AND calc.is_vanity=0
      AND calc.is_suspicious=0
      AND corp.has_earnable_lp_source=1
      AND corp.has_l4_l5_security_agent=1
      AND calc.has_manufactured_bpc=0
      AND calc.offer_id < ${SELL_VARIANT_OFFSET}
      AND COALESCE(calc.avg_daily_volume_28d, 0)>=0
    ORDER BY (${orderExpr}) IS NULL ASC, ${orderExpr} DESC, calc.isk_per_lp_instant DESC, calc.offer_id ASC
    LIMIT ?
  `).all(Math.max(250, limit * 20)) as SummaryCacheRow[];

  const groups = new Map<string, { row: SummaryCacheRow; summary: OfferSummary }>();
  for (const row of rows) {
    const parsed = row.summary ? (JSON.parse(row.summary) as OfferSummary) : fallbackSummary(row, basis);
    const selectedRatio = ratioForBasis(row.isk_per_lp_instant, row.isk_per_lp_patient, basis);
    parsed.flags = currentFlags(row);
    parsed.isk_per_lp = selectedRatio;
    parsed.isk_per_lp_instant = row.isk_per_lp_instant;
    parsed.isk_per_lp_patient = row.isk_per_lp_patient;
    parsed.risk_tier = normalizeRiskTier(parsed.risk_tier as RiskTier) as OfferSummary["risk_tier"];
    parsed.access_risk_tier = normalizeRiskTier(
      (parsed.access_risk_tier ?? row.access_risk_tier) as RiskTier
    ) as OfferSummary["access_risk_tier"];
    const key = groupSignature(row);
    const existing = groups.get(key);
    if (!existing) {
      parsed.store_count = 1;
      parsed.store_options = [storeOption(parsed)];
      parsed.isk_per_hour = iskPerHour(selectedRatio, DEFAULT_LP_PER_HOUR, parsed.contract_priced);
      groups.set(key, { row, summary: parsed });
    } else {
      const storeOptions = uniqueStoreOptions([...(existing.summary.store_options ?? [storeOption(existing.summary)]), storeOption(parsed)]);
      existing.summary.store_count = storeOptions.length;
      existing.summary.store_options = storeOptions;
      existing.summary.access_risk_tier = leastRiskTier(storeOptions.map((option) => option.access_risk_tier));
      existing.summary.detail_summary.store.storeCount = storeOptions.length;
      existing.summary.detail_summary.store.storeNames = storeOptions.map((option) => option.corp_name).join(", ");
    }
    if (groups.size >= limit) break;
  }

  return [...groups.values()].slice(0, limit).map(({ summary }, index) => ({ ...summary, rank: index + 1 }));
}

export function canonicalCorps(db: Db): { rows: unknown[] } {
  return {
    rows: db.prepare(`
      SELECT corp_id, name, risk_tier, COALESCE(NULLIF(access_risk_tier, ''), risk_tier) AS access_risk_tier, lp_source_tier
      FROM corporations
      WHERE has_lp_store=1
        AND has_earnable_lp_source=1
      ORDER BY name COLLATE NOCASE ASC, corp_id ASC
    `).all()
  };
}

function buildResponseRecord(
  cacheKey: string,
  generation: number,
  contentType: string,
  bodyText: string,
  onCompressMs: (ms: number) => void
): BuiltResponseCacheRecord {
  const body = Buffer.from(bodyText);
  const compressStart = Date.now();
  const bodyBrotli = compressBrotli(body);
  onCompressMs(Date.now() - compressStart);
  return {
    cacheKey,
    generation,
    contentType,
    body,
    bodyBrotli,
    etag: computeGenerationEtag(generation),
    computedAt: nowIso()
  };
}

function offerQueryFor(n: number, sortBy: SortBy): OfferQuery {
  return sortBy === "iskPerLp" ? { n } : { n, sortBy };
}

// The manufacturer-mode landing combo (web/lp/app.js setMfgMode): contract-sale
// fees off + null-sec T2 facility + blueprints-only build rows. These overrides force
// the live calc path, so without materialization every cold request recomputes the
// catalog; baking the landing state here serves it from response_cache like the
// default view. Other facility / cost-index / sort combos still fall through to live.
//
// hideSuspicious and lpPerHour mirror the defaults parseOfferQuery applies to the
// landing request (which sets neither explicitly): without hideSuspicious the cached
// body would keep suspicious rows the live path drops, and without lpPerHour every row
// would serve isk_per_hour=null. Neither field participates in normalizeOfferQuery, so
// the response cache key stays identical to the live request's.
const MANUFACTURER_PRESET: OfferQuery = {
  bpc: "manufacture",
  noMarketFees: true,
  facility: "null-t2",
  hideSuspicious: true,
  lpPerHour: DEFAULT_LP_PER_HOUR
};

function materializeManufacturerPreset(
  db: Db,
  addResponse: (cacheKey: string, contentType: string, bodyText: string) => void
): void {
  // One live pass at the deepest n + landing sort; the shallower n bodies are slices
  // of the same iskPerLp-sorted, grouped, ranked list (listOfferCalcs groups before
  // the n-slice, so slicing the n=500 list yields exactly the n=100 / n=200 lists).
  // baseOfferIds restricts to manufacture rows, so this computes only buildable offers.
  const ranked = listOfferCalcs(db, { ...MANUFACTURER_PRESET, n: 500, sortBy: "iskPerLp" });
  for (const n of [100, 200, 500]) {
    const rows = ranked.slice(0, n).map((row, index) => summarizeOfferCalc({ ...row, rank: index + 1 }));
    const key = responseCacheKey("/api/offers/top", { ...MANUFACTURER_PRESET, n, sortBy: "iskPerLp" });
    addResponse(key, "application/json; charset=utf-8", JSON.stringify({ rows }));
  }
}

export function materializeCanonicalResponses(db: Db, generation = currentComputeGeneration(db)): string[] {
  const startedAt = Date.now();
  let compressMs = 0;
  const records: BuiltResponseCacheRecord[] = [];
  const keys: string[] = [];

  function addResponse(cacheKey: string, contentType: string, bodyText: string): void {
    keys.push(cacheKey);
    records.push(
      buildResponseRecord(cacheKey, generation, contentType, bodyText, (ms) => {
        compressMs += ms;
      })
    );
  }

  for (const n of [100, 200, 500]) {
    const sorts = n === 100 ? hotSorts100 : hotSortsDeep;
    let iskPerLpRows: OfferSummary[] | null = null;
    for (const sortBy of sorts) {
      const rows = canonicalOfferRows(db, n, sortBy);
      const key = responseCacheKey("/api/offers/top", offerQueryFor(n, sortBy));
      addResponse(key, "application/json; charset=utf-8", JSON.stringify({ rows }));
      if (n === 100 && sortBy === "iskPerLp") {
        iskPerLpRows = rows;
      }
    }
    if (n === 100 && iskPerLpRows) {
      const csvKey = responseCacheKey("/api/offers/top.csv", { n });
      addResponse(csvKey, "text/csv; charset=utf-8", offerRowsToCsv(iskPerLpRows));
    }
  }
  const corpsKey = responseCacheKey("/api/corps", {});
  addResponse(corpsKey, "application/json; charset=utf-8", JSON.stringify(canonicalCorps(db)));

  materializeManufacturerPreset(db, addResponse);

  const buildAndCompressMs = Date.now() - startedAt;
  const insert = db.prepare(`
    INSERT INTO response_cache(cache_key, generation, content_type, body, body_brotli, etag, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      generation=excluded.generation,
      content_type=excluded.content_type,
      body=excluded.body,
      body_brotli=excluded.body_brotli,
      etag=excluded.etag,
      computed_at=excluded.computed_at
  `);
  const dbStart = Date.now();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM response_cache").run();
    for (const record of records) {
      insert.run(
        record.cacheKey,
        record.generation,
        record.contentType,
        record.body,
        record.bodyBrotli,
        record.etag,
        record.computedAt
      );
    }
  });
  tx();
  const dbMs = Date.now() - dbStart;
  console.log(
    JSON.stringify({
      component: "response_materialize",
      keys: keys.length,
      build_ms: Math.max(0, buildAndCompressMs - compressMs),
      compress_ms: compressMs,
      db_ms: dbMs,
      duration_ms: Date.now() - startedAt
    })
  );
  return keys;
}

export function applyLpPerHour(body: Buffer, lpPerHour: number | undefined, basis: Basis = "best"): { body: Buffer; changed: boolean } {
  const rate = lpPerHour ?? DEFAULT_LP_PER_HOUR;
  if (!Number.isFinite(rate) || rate <= 0) return { body, changed: false };
  try {
    const payload = JSON.parse(body.toString("utf8")) as { rows?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.rows)) return { body, changed: false };
    let changed = false;
    for (const row of payload.rows) {
      const instant = typeof row.isk_per_lp_instant === "number" && Number.isFinite(row.isk_per_lp_instant)
        ? row.isk_per_lp_instant
        : null;
      const patient = typeof row.isk_per_lp_patient === "number" && Number.isFinite(row.isk_per_lp_patient)
        ? row.isk_per_lp_patient
        : null;
      const hourly = iskPerHour(ratioForBasis(instant, patient, basis), rate, row.contract_priced === true);
      if (hourly !== null) {
        row.isk_per_hour = hourly;
        changed = true;
      }
    }
    return changed ? { body: Buffer.from(JSON.stringify(payload)), changed } : { body, changed: false };
  } catch {
    return { body, changed: false };
  }
}
