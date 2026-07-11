import type { Basis, OfferCalc, SortBy } from "./offer-types.js";

// ---------------------------------------------------------------------------
// Single source of truth for offer ordering.
//
// Three code paths order the offer list and MUST agree, or the same query can be
// served in different orders depending on which path answers it:
//   1. the live full-compute path (offer-list.listOfferCalcs) sorts OfferCalc rows
//      in JS via `sortValue` below;
//   2. the cached candidate scan (offer-list.cachedCandidateIds) orders persisted
//      `calc` rows in SQL via `sortExpr`;
//   3. the materialization query (response-materialize.canonicalOfferRows) also
//      orders persisted `calc` rows in SQL via `sortExpr`.
// `sortExpr` is the one SQL builder for (2) and (3); `sortValue` is its row-level
// JS mirror for (1). Keep the two in lockstep — the SQL and JS branches below are
// deliberately parallel so a new sort key can never be added to one and not the
// other. The SQL references the persisted `calc` table (alias `calc`) joined to
// `offers` (alias `o`), matching both query sites.
// ---------------------------------------------------------------------------

/** SQL expression for the `iskPerLp` ratio under a given valuation basis. */
export function basisSortExpr(basis: Basis): string {
  switch (basis) {
    case "instantSell":
      return "calc.isk_per_lp_instant";
    case "patientSell":
      return "calc.isk_per_lp_patient";
    case "best":
      return `
        CASE
          WHEN calc.isk_per_lp_instant IS NULL THEN calc.isk_per_lp_patient
          WHEN calc.isk_per_lp_patient IS NULL THEN calc.isk_per_lp_instant
          WHEN calc.isk_per_lp_instant >= calc.isk_per_lp_patient THEN calc.isk_per_lp_instant
          ELSE calc.isk_per_lp_patient
        END
      `;
  }
}

/** SQL expression for ROI under a given valuation basis. Best basis picks the
 * higher of the two ROIs, mirroring `basisSortExpr`'s instant/patient selection. */
function roiSortExpr(basis: Basis): string {
  switch (basis) {
    case "instantSell":
      return "calc.roi_instant";
    case "patientSell":
      return "calc.roi_patient";
    case "best":
      return `
        CASE
          WHEN calc.roi_instant IS NULL THEN calc.roi_patient
          WHEN calc.roi_patient IS NULL THEN calc.roi_instant
          WHEN calc.roi_instant >= calc.roi_patient THEN calc.roi_instant
          ELSE calc.roi_patient
        END
      `;
  }
}

/**
 * SQL ordering expression over the persisted `calc` table for a (sortBy, basis)
 * pair. Total over `SortBy` — every sort is cache-eligible. Both the cached
 * candidate scan and the materialization query wrap it as
 * `(<expr>) IS NULL ASC, <expr> <dir>, calc.isk_per_lp_instant DESC, calc.offer_id ASC`.
 */
export function sortExpr(sortBy: SortBy, basis: Basis): string {
  switch (sortBy) {
    case "rank":
    case "instant":
      return "calc.isk_per_lp_instant";
    case "patient":
      return "calc.isk_per_lp_patient";
    case "iskPerLp":
      return basisSortExpr(basis);
    case "lp":
      return "o.lp_cost";
    case "isk":
      return "o.isk_cost";
    case "roi":
      return roiSortExpr(basis);
    case "iskPerHour":
      // Contract-priced rows have no hourly rate (isk_per_hour is null); NULL sorts
      // them last via the `(expr) IS NULL ASC` prefix in the ORDER BY.
      return `CASE WHEN calc.contract_priced=1 THEN NULL ELSE (${basisSortExpr(basis)}) END`;
    case "volume":
      return "calc.avg_daily_volume_28d";
    case "daysOfSupply":
      return "calc.days_of_supply";
  }
}

export type SortValue = number | string | null;

/**
 * Row-level JS mirror of `sortExpr`: the value used to order a fully-computed
 * OfferCalc in the live path. Every branch here matches the corresponding SQL
 * branch above (roi best = higher of instant/patient; volume = bare column).
 */
export function sortValue(row: OfferCalc, sortBy: SortBy, basis: Basis): SortValue {
  switch (sortBy) {
    case "lp":
      return row.lp_cost;
    case "isk":
      return row.isk_cost;
    case "iskPerLp":
      return row.isk_per_lp;
    case "patient":
      return row.isk_per_lp_patient;
    case "roi":
      if (basis === "patientSell") return row.roi_patient;
      if (basis === "best") {
        const i = row.roi_instant, p = row.roi_patient;
        if (i === null) return p;
        if (p === null) return i;
        return Math.max(i, p);
      }
      return row.roi_instant;
    case "iskPerHour":
      return row.isk_per_hour;
    case "volume":
      return row.avg_daily_volume_28d;
    case "daysOfSupply":
      return row.days_of_supply;
    case "rank":
    case "instant":
    default:
      return row.isk_per_lp_instant;
  }
}
