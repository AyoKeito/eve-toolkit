import type { FastifyRequest } from "fastify";
import type { Basis, BpcMode, Level5MissionsMode, OfferQuery, SortBy } from "../calc/ratio.js";
import { DEFAULT_LP_PER_HOUR } from "../calc/offer-types.js";
import type { RiskTier } from "../calc/risk.js";

/** A raw parsed query-string value (Fastify gives repeated params as arrays). */
export type QueryValue = string | string[] | undefined;
export type QueryRecord = Record<string, QueryValue>;
const maxRuns = 10_000;

/**
 * Escape SQLite LIKE special characters (%, _, and the backslash escape char)
 * so that user-supplied search terms are treated as literals.
 * The corresponding SQL must use `LIKE ? ESCAPE '\'`.
 */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function int(value: string | undefined): number | undefined {
  const parsed = num(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

// LP/hour drives the isk_per_hour rewrite (selectedRatio * rate). A non-positive or
// unparseable rate is meaningless: applyLpPerHour() no-ops on rate <= 0, which would still
// pin the canonical 30000-rate body under a personalized edge key (e.g. ?lpPerHour=0). Clamp
// anything that isn't a positive number to the default so only real rates reach the cache path.
function positiveRate(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function boundedInt(value: string | undefined, min: number, max: number): number | undefined {
  const parsed = int(value);
  if (parsed === undefined) return undefined;
  return Math.max(min, Math.min(parsed, max));
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return undefined;
}

function basis(value: string | undefined): Basis | undefined {
  if (value === "buy" || value === "instant" || value === "instantSell") return "instantSell";
  if (value === "sell" || value === "patient" || value === "patientSell") return "patientSell";
  if (value === "highest" || value === "best") return "best";
  return undefined;
}

function risk(value: string | undefined): RiskTier | undefined {
  if (value === "WORMHOLE") return "NULLSEC";
  if (value === "HIGHSEC" || value === "LOWSEC" || value === "NULLSEC") return value;
  return undefined;
}

function level5Missions(value: string | undefined): Level5MissionsMode | undefined {
  if (value === "show" || value === "only" || value === "hide") return value;
  return undefined;
}

function bpcMode(value: string | undefined): BpcMode | undefined {
  if (value === "none" || value === "sell" || value === "manufacture" || value === "all") return value;
  if (value === "build" || value === "make") return "manufacture";
  return undefined;
}

function facility(value: string | undefined): string | undefined {
  // Manufacturer-mode facility preset. "npc" is the default/no-op; aliases map onto
  // the canonical preset names the calc resolves. Unknown values fall through to
  // undefined so the default NPC facility applies.
  if (value === "npc" || value === "highsec-t2" || value === "null-t2") return value;
  if (value === "highsec" || value === "hs-t2") return "highsec-t2";
  if (value === "null" || value === "nullsec" || value === "ns-t2" || value === "wh-t2") return "null-t2";
  return undefined;
}

function sortBy(value: string | undefined): SortBy | undefined {
  if (
    value === "rank" ||
    value === "lp" ||
    value === "isk" ||
    value === "iskPerLp" ||
    value === "instant" ||
    value === "patient" ||
    value === "roi" ||
    value === "iskPerHour" ||
    value === "volume" ||
    value === "daysOfSupply"
  ) {
    return value === "daysOfSupply" ? "volume" : value;
  }
  return undefined;
}

export function parseOfferQuery(request: FastifyRequest): OfferQuery {
  const query = request.query as QueryRecord;
  return {
    n: int(first(query.n)),
    basis: basis(first(query.basis)),
    corp: int(first(query.corp)),
    minLp: int(first(query.minLp)),
    maxRiskTier: risk(first(query.maxRiskTier)) ?? "NULLSEC",
    minVolume: num(first(query.minVolume)) ?? 0,
    maxM3: num(first(query.maxM3)),
    jita44Only: bool(first(query.jita44Only)) ?? false,
    hideSuspicious: bool(first(query.hideSuspicious)) ?? true,
    hideVanity: bool(first(query.hideVanity)) ?? true,
    hideNoSecurity: bool(first(query.hideNoSecurity)) ?? true,
    bpc: bpcMode(first(query.bpc)),
    includeSpecial: bool(first(query.includeSpecial)),
    level5Missions: level5Missions(first(query.level5Missions)) ?? (bool(first(query.hasLevel5Agent)) ? "only" : "show"),
    hasLevel5Agent: bool(first(query.hasLevel5Agent)),
    showDuplicateStores: bool(first(query.showDuplicateStores)),
    acc: int(first(query.acc)),
    bro: int(first(query.bro)),
    advBro: boundedInt(first(query.advBro), 0, 5),
    realisticPatient: bool(first(query.realisticPatient)) ?? false,
    noMarketFees: bool(first(query.noMarketFees)) ?? false,
    facility: facility(first(query.facility)),
    costIndex: num(first(query.costIndex)),
    factionStand: num(first(query.factionStand)),
    corpStand: num(first(query.corpStand)),
    maxStanding: num(first(query.maxStanding)),
    includeFW: bool(first(query.includeFW)),
    runs: boundedInt(first(query.runs), 1, maxRuns),
    lpBudget: num(first(query.lpBudget)),
    iskBudget: num(first(query.iskBudget)),
    lpPerHour: positiveRate(num(first(query.lpPerHour)), DEFAULT_LP_PER_HOUR),
    sortBy: sortBy(first(query.sortBy)),
    search: first(query.search),
    corpSearch: first(query.corpSearch)
  };
}
