import type { Db } from "../db.js";
import { escapeLike } from "../api/query.js";
import { prepareCached } from "../lib/prepare-cache.js";
import { sqlPlaceholders } from "../lib/sql.js";
import { sortExpr, sortValue } from "./offer-sort.js";
import { suspicious } from "./flags.js";
import { getMarketSnapshot } from "./market-snapshot.js";
import { riskAllowed, type RiskTier } from "./risk.js";
import {
  lineSignature,
  targetSignature,
  storeOption,
  valuationBasis,
  type Basis,
  type Level5MissionsMode,
  type OfferCalc,
  type OfferQuery,
  type SortBy,
  type SortDir
} from "./offer-types.js";
import {
  calculateOffer,
  calcRowsExist,
  createOfferCalcMemo,
  getHistory,
  getPrice,
  SELL_VARIANT_OFFSET,
  withStoreOptions,
  type OfferCalcMemo
} from "./offer-calc.js";

// ---------------------------------------------------------------------------
// Private helpers — sort / group
// ---------------------------------------------------------------------------

function level5MissionsMode(query: OfferQuery): Level5MissionsMode {
  if (query.level5Missions) return query.level5Missions;
  return query.hasLevel5Agent ? "only" : "show";
}

function hideNoSecurityCorps(query: OfferQuery): boolean {
  return query.hideNoSecurity ?? true;
}

function defaultSortDir(): SortDir {
  return "desc";
}

function defaultSortByForBasis(basis: Basis): SortBy {
  switch (basis) {
    case "instantSell":
      return "instant";
    case "patientSell":
      return "patient";
    case "best":
      return "iskPerLp";
  }
}

function compareRows(a: OfferCalc, b: OfferCalc, sortBy: SortBy, sortDir: SortDir, basis: Basis): number {
  const av = sortValue(a, sortBy, basis);
  const bv = sortValue(b, sortBy, basis);
  const direction = sortDir === "asc" ? 1 : -1;

  if (av === null && bv === null) return (b.isk_per_lp_instant ?? 0) - (a.isk_per_lp_instant ?? 0);
  if (av === null) return 1;
  if (bv === null) return -1;

  const primary =
    typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
  if (primary !== 0) return primary * direction;
  // Tie-break: always descending by instant ratio regardless of sortDir.
  // This is intentional — it provides a canonical, stable ranking for equal
  // primary values without inverting for ascending sorts (e.g. ascending by LP cost
  // should still break ties in favour of the better earner, not the worse one).
  return (b.isk_per_lp_instant ?? 0) - (a.isk_per_lp_instant ?? 0);
}

function groupDuplicateStores(query: OfferQuery): boolean {
  return !query.all && query.corp === undefined && !query.showDuplicateStores;
}

function offerEconomicsSignature(row: OfferCalc): string {
  return JSON.stringify({
    lpCost: row.lp_cost,
    iskCost: row.isk_cost,
    runs: row.runs,
    requiredStanding: row.required_standing,
    isFw: row.is_fw,
    lpSourceTier: row.lp_source_tier,
    products: targetSignature(row.sales_targets),
    inputs: lineSignature(row.input_lines),
    build: lineSignature(row.build_lines)
  });
}

function addGroupedRow(groups: Map<string, OfferCalc>, row: OfferCalc): void {
  const key = offerEconomicsSignature(row);
  const existing = groups.get(key);
  if (!existing) {
    groups.set(key, withStoreOptions(row, [storeOption(row)]));
    return;
  }

  groups.set(key, withStoreOptions(existing, [...(existing.store_options ?? [storeOption(existing)]), storeOption(row)]));
}

function groupedRows(rows: OfferCalc[]): OfferCalc[] {
  const groups = new Map<string, OfferCalc>();
  for (const row of rows) addGroupedRow(groups, row);
  return [...groups.values()];
}

function rankRows(rows: OfferCalc[]): OfferCalc[] {
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function customFees(query: OfferQuery): boolean {
  // noMarketFees zeroes both fee rates — the persisted calc rows assume the default
  // skill-floored fees, so this must force the live path just like any custom skill.
  if (query.noMarketFees) return true;
  return [query.acc, query.bro, query.factionStand, query.corpStand].some(
    (value) => value !== undefined && Number(value) !== 0
  );
}

/** Manufacturer-mode facility overrides (a non-NPC ME preset, or a custom system
 * cost index) change build_cost / job_cost away from the persisted default-view
 * rows, so they must force the live path just like custom fees. */
function customFacility(query: OfferQuery): boolean {
  const facility = query.facility;
  if (facility !== undefined && facility !== "" && facility !== "npc") return true;
  return query.costIndex !== undefined;
}

function ftsPrefixQuery(value: string): string | null {
  const terms = value
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}

function allowedRiskTiers(maxRiskTier: RiskTier): RiskTier[] {
  switch (maxRiskTier) {
    case "HIGHSEC":
      return ["HIGHSEC"];
    case "LOWSEC":
      return ["HIGHSEC", "LOWSEC"];
    case "NULLSEC":
    case "WORMHOLE":
      return ["HIGHSEC", "LOWSEC", "NULLSEC", "WORMHOLE"];
  }
}

function cacheEligible(query: OfferQuery): boolean {
  return (
    !query.all &&
    query.runs === undefined &&
    query.lpBudget === undefined &&
    query.iskBudget === undefined &&
    !customFees(query) &&
    !customFacility(query) &&
    // realistic-patient valuations shift patient/best ratios away from the
    // persisted optimistic values the cached candidate ordering relies on
    !query.realisticPatient
    // Every SortBy maps to a sortExpr, so all sorts are cache-eligible.
  );
}

// ---------------------------------------------------------------------------
// Exported: buildCoreFilterClauses
// ---------------------------------------------------------------------------

/**
 * Builds the WHERE clauses and bound params shared between the live path
 * (baseOfferIds, which reads om.required_standing / om.is_fw / c.lp_source_tier)
 * and the cached path (cachedCandidateIds, which reads calc.* equivalents).
 *
 * Per-mode column map:
 *   filter          | live expr                              | cached expr
 *   corp_id         | o.corp_id=?                            | calc.corp_id=?
 *   maxStanding     | (om.required_standing IS NULL OR ...)  | (calc.required_standing IS NULL OR ...)
 *   includeFW       | COALESCE(om.is_fw, 0)=0               | calc.is_fw=0
 *   includeSpecial  | c.lp_source_tier!='SPECIAL'           | calc.lp_source_tier!='SPECIAL'
 *
 * Filters that only exist in the cached path (hideSuspicious, maxM3, riskTiers,
 * FTS search) are NOT included here — they remain in cachedCandidateIds.
 */
export function buildCoreFilterClauses(
  query: OfferQuery,
  source: "live" | "cached",
  corpNeedle: string | undefined
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = ["c.has_earnable_lp_source=1"];
  const params: unknown[] = [];

  if (query.corp !== undefined) {
    clauses.push(source === "live" ? "o.corp_id=?" : "calc.corp_id=?");
    params.push(query.corp);
  }
  if (query.corp === undefined && corpNeedle) {
    clauses.push("c.name LIKE ? COLLATE NOCASE ESCAPE '\\'");
    params.push(`%${escapeLike(corpNeedle)}%`);
  }
  if (query.minLp !== undefined) {
    clauses.push("o.lp_cost>=?");
    params.push(query.minLp);
  }
  if (query.maxStanding !== undefined && query.maxStanding !== 0) {
    clauses.push(
      source === "live"
        ? "(om.required_standing IS NULL OR om.required_standing<=?)"
        : "(calc.required_standing IS NULL OR calc.required_standing<=?)"
    );
    params.push(query.maxStanding);
  }
  // An explicit corp/faction selection scopes results to that one owner, so show
  // its full catalog regardless of the global discovery toggles — FW militias,
  // SPECIAL stores, and no-security corps alike. Without this, picking e.g. the
  // 24th Imperial Crusade (an FW, no-security-agent militia) returns an empty
  // table unless the user also flips includeFW on and hideNoSecurity off. SPECIAL
  // already relaxed this way; FW and no-security now match it.
  const corpScoped = query.corp !== undefined || Boolean(corpNeedle);
  if (!query.includeFW && !corpScoped) {
    clauses.push(source === "live" ? "COALESCE(om.is_fw, 0)=0" : "calc.is_fw=0");
  }
  if (!query.includeSpecial && !corpScoped) {
    clauses.push(source === "live" ? "c.lp_source_tier!='SPECIAL'" : "calc.lp_source_tier!='SPECIAL'");
  }
  if (hideNoSecurityCorps(query) && !corpScoped) {
    clauses.push("c.has_l4_l5_security_agent=1");
  }
  const level5Mode = level5MissionsMode(query);
  if (level5Mode === "only") {
    clauses.push("c.has_level5_agent=1");
  } else if (level5Mode === "hide") {
    clauses.push("c.has_level5_agent=0");
  }

  return { clauses, params };
}

function baseOfferIds(db: Db, query: OfferQuery): number[] {
  const corpNeedle = query.corpSearch?.trim();
  const { clauses, params } = buildCoreFilterClauses(query, "live", corpNeedle);

  // Blueprints-only manufacturer mode: restrict the candidate scan to manufacture
  // rows (has_manufactured_bpc, persisted in calc) so the live path computes only
  // buildable offers instead of the whole catalog. A LEFT JOIN with the IS NULL
  // escape keeps this output-identical to the full scan: offers calc has positively
  // classified as non-manufacture are filtered out in SQL, but an offer fetched since
  // the last recompute (present in `offers`, absent from `calc`) still passes through
  // to calculateOffer + rowMatchesQuery — which remains the authoritative buildables
  // filter — rather than being silently hidden until the next compute. No join before
  // the first compute populates calc; rowMatchesQuery alone filters then.
  let manufactureJoin = "";
  if (query.bpc === "manufacture" && calcRowsExist(db)) {
    manufactureJoin = "LEFT JOIN calc cm ON cm.offer_id=o.offer_id";
    clauses.push("(cm.offer_id IS NULL OR cm.has_manufactured_bpc=1)");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = prepareCached(db, `
    SELECT o.offer_id
    FROM offers o
    JOIN corporations c ON c.corp_id=o.corp_id
    LEFT JOIN offer_meta om ON om.offer_id=o.offer_id
    ${manufactureJoin}
    ${where}
    ORDER BY o.offer_id
  `).all(...params) as { offer_id: number }[];
  return rows.map((row) => row.offer_id);
}

/**
 * Offer ids that can possibly yield a valid "(sell)" variant: those with at least
 * one product whose type is a blueprint (has a recipe). A valid sell variant
 * requires a recipe-bearing, directly-sellable product, so this is a strict
 * superset — calculateOffer stays authoritative for whether the variant exists.
 * Expanding only these skips the guaranteed-null base pass for the ~90% of offers
 * that have no blueprint product.
 */
function sellVariantCandidateIds(db: Db): Set<number> {
  const rows = prepareCached(db, `
    SELECT DISTINCT op.offer_id
    FROM offer_products op
    WHERE op.type_id IN (SELECT blueprint_type_id FROM blueprint_products)
       OR op.type_id IN (SELECT blueprint_type_id FROM bp_manufacture)
  `).all() as { offer_id: number }[];
  return new Set(rows.map((row) => row.offer_id));
}

function cachedCandidateIds(
  db: Db,
  query: OfferQuery,
  maxRiskTier: RiskTier,
  sortBy: SortBy,
  sortDir: SortDir,
  limit: number,
  offset: number
): number[] {
  const corpNeedle = query.corpSearch?.trim();
  const { clauses, params } = buildCoreFilterClauses(query, "cached", corpNeedle);

  if (query.hideSuspicious) {
    clauses.push("calc.is_suspicious=0");
  }
  if (query.maxM3 !== undefined) {
    clauses.push("COALESCE(calc.cargo_m3, 0)<=?");
    params.push(query.maxM3);
  }
  if ((query.bpc ?? "none") === "manufacture") {
    // Blueprints-only manufacturer mode — scan only manufacture rows so the
    // candidate pagination fills the page without churning the whole catalog.
    // Mirrors the rowMatchesQuery blueprints-only filter (the authoritative one).
    clauses.push("calc.has_manufactured_bpc=1");
  }

  const riskTiers = allowedRiskTiers(maxRiskTier);
  clauses.push(`COALESCE(NULLIF(calc.access_risk_tier, ''), calc.risk_tier) IN (${sqlPlaceholders(riskTiers.length)})`);
  params.push(...riskTiers);

  const search = query.search?.trim();
  const fts = search ? ftsPrefixQuery(search) : null;
  if (fts) {
    clauses.push("calc.offer_id IN (SELECT rowid FROM offer_search_fts WHERE offer_search_fts MATCH ?)");
    params.push(`{offer_name product_names} : ${fts}`);
  }

  const orderExpr = sortExpr(sortBy, valuationBasis(query));
  const direction = sortDir === "asc" ? "ASC" : "DESC";
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = prepareCached(db, `
    SELECT calc.offer_id
    FROM calc
    JOIN offers o ON o.offer_id=(CASE WHEN calc.offer_id >= ${SELL_VARIANT_OFFSET} THEN calc.offer_id - ${SELL_VARIANT_OFFSET} ELSE calc.offer_id END)
    JOIN corporations c ON c.corp_id=o.corp_id
    ${where}
    ORDER BY (${orderExpr}) IS NULL ASC, ${orderExpr} ${direction}, calc.isk_per_lp_instant DESC, calc.offer_id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as { offer_id: number }[];
  return rows.map((row) => row.offer_id);
}

function rowMatchesQuery(
  db: Db,
  row: OfferCalc,
  query: OfferQuery,
  maxRiskTier: RiskTier,
  hideVanity: boolean,
  memo: OfferCalcMemo
): boolean {
  if (!riskAllowed(row.access_risk_tier, maxRiskTier)) return false;
  if (hideVanity && row.is_vanity) return false;
  const level5Mode = level5MissionsMode(query);
  if (level5Mode === "only" && !row.has_level5_agent) return false;
  if (level5Mode === "hide" && row.has_level5_agent) return false;
  const bpcMode = query.bpc ?? "none";
  if (bpcMode !== "all") {
    // Manufacture rows convert a blueprint via its recipe; sell rows are the
    // synthetic direct-contract-sale variants living above SELL_VARIANT_OFFSET.
    const isSellVariant = row.offer_id >= SELL_VARIANT_OFFSET;
    const isManufactureRow = !isSellVariant && row.sales_targets.some((target) => target.is_bpc);
    if (bpcMode === "manufacture") {
      // Manufacturer mode is a buildables-only lens: the facility / ME / job-cost /
      // no-fees controls only act on rows built from an LP-store blueprint, so plain
      // direct-item offers (no blueprint to build) and (sell) variants are excluded
      // here — they remain in the default view.
      if (!isManufactureRow) return false;
    } else {
      // none / sell: hide manufacture conversions; (sell) variants surface only in sell mode.
      if (isManufactureRow) return false;
      if (bpcMode !== "sell" && isSellVariant) return false;
    }
  }
  const corpNeedle = query.corpSearch?.trim().toLowerCase();
  if (
    !query.includeSpecial &&
    query.corp === undefined &&
    !corpNeedle &&
    row.lp_source_tier === "SPECIAL"
  ) {
    return false;
  }

  const search = query.search?.trim().toLowerCase();
  if (search && !row.offer_name.toLowerCase().includes(search)) {
    return false;
  }

  if (corpNeedle && query.corp === undefined && !row.corp_name.toLowerCase().includes(corpNeedle)) {
    return false;
  }

  if (query.minVolume !== undefined) {
    const primary = row.sales_targets[0];
    if (!primary) return false;
    const history = getHistory(db, primary.type_id, memo);
    if ((history?.avg_daily_volume_28d ?? 0) < query.minVolume) return false;
  }

  if (query.maxM3 !== undefined && row.cargo_m3 > query.maxM3) {
    return false;
  }

  if (query.jita44Only) {
    const sellPricedLines = [...row.sales_targets, ...row.input_lines, ...row.build_lines];
    if (sellPricedLines.length === 0) return false;
    if (sellPricedLines.some((line) => getPrice(db, line.type_id, memo)?.sell_min_at_jita_44 !== 1)) return false;
  }

  return !query.hideSuspicious || !suspicious(row.flags);
}

function listCachedOfferCalcs(
  db: Db,
  query: OfferQuery,
  maxRiskTier: RiskTier,
  sortBy: SortBy,
  sortDir: SortDir,
  hideVanity: boolean
): OfferCalc[] | null {
  if (!cacheEligible(query) || !calcRowsExist(db)) return null;

  const wanted = Math.max(1, Math.min(query.n ?? 100, 1000));
  const rows: OfferCalc[] = [];
  const groups = new Map<string, OfferCalc>();
  const shouldGroup = groupDuplicateStores(query);
  const seen = new Set<number>();
  const memo = createOfferCalcMemo(getMarketSnapshot(db));
  let offset = 0;
  const chunkSize = Math.max(250, wanted * 10);

  while ((shouldGroup ? groups.size : rows.length) < wanted) {
    const ids = cachedCandidateIds(db, query, maxRiskTier, sortBy, sortDir, chunkSize, offset);
    if (ids.length === 0) break;
    offset += ids.length;

    for (const offerId of ids) {
      // `seen` deduplicates offer IDs across chunk boundaries, so a signature group
      // whose constituent offers span two pages is never double-counted.
      if (seen.has(offerId)) continue;
      seen.add(offerId);
      const row = calculateOffer(db, offerId, query, memo);
      if (row && rowMatchesQuery(db, row, query, maxRiskTier, hideVanity, memo)) {
        if (shouldGroup) addGroupedRow(groups, row);
        else rows.push(row);
      }
      if ((shouldGroup ? groups.size : rows.length) >= wanted) break;
    }
  }

  return rankRows(shouldGroup ? [...groups.values()] : rows);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export function listOfferCalcs(db: Db, query: OfferQuery = {}): OfferCalc[] {
  const maxRiskTier = query.maxRiskTier ?? "NULLSEC";
  const sortBy = query.sortBy ?? defaultSortByForBasis(valuationBasis(query));
  const sortDir = defaultSortDir();
  const hideVanity = query.hideVanity ?? true;

  const cachedRows = listCachedOfferCalcs(db, query, maxRiskTier, sortBy, sortDir, hideVanity);
  if (cachedRows) return cachedRows;

  const memo = createOfferCalcMemo(getMarketSnapshot(db));
  // Each base offer may carry a "(sell)" variant (direct contract sale of a BPC),
  // but only blueprint-product offers can — expand just those; calculateOffer
  // returns null for offers where the variant does not exist.
  const sellVariantIds = sellVariantCandidateIds(db);
  const rows = baseOfferIds(db, query)
    .flatMap((offerId) =>
      sellVariantIds.has(offerId) ? [offerId, offerId + SELL_VARIANT_OFFSET] : [offerId]
    )
    .map((offerId) => calculateOffer(db, offerId, query, memo))
    .filter((row): row is OfferCalc => row !== null)
    .filter((row) => rowMatchesQuery(db, row, query, maxRiskTier, hideVanity, memo))
    .sort((a, b) => compareRows(a, b, sortBy, sortDir, valuationBasis(query)));

  const displayRows = groupDuplicateStores(query) ? groupedRows(rows) : rows;
  const limited = query.all ? displayRows : displayRows.slice(0, Math.max(1, Math.min(query.n ?? 100, 1000)));
  return rankRows(limited);
}
