import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { sendCachedResponse, setFitsCacheHeaders } from "../lib/api-cache-headers.js";
import { ResponseCache, jsonCachedResponse } from "../lib/response-cache.js";
import { responseEtag, snapshotDataVersion } from "../lib/compute-generation.js";
import { parseInteger } from "../lib/parse.js";
import { chunk, pushToMapList, sqlPlaceholders } from "../lib/sql.js";
import { contractSaturationRegions, contractPriceRegions } from "../config.js";
import { first, type QueryRecord } from "./query.js";

/**
 * Trending lowsec faction-warfare fits derived from killmails, ranked by losses and valued
 * against the live Jita market (docs: killmails ingest). Powers the owner-only /fits/ page,
 * which exists to decide which fully-fit ships to build and sell pre-assembled in contracts.
 * No market for an assembled fit exists, so "value" is the acquisition (build) cost of hull +
 * modules at Jita sell_min, falling back to the ESI average price where no live order exists.
 */

// Non-combat ship groups excluded from the sellable ranking: Capsule (29), Shuttle (31),
// Rookie ship (237). These are category_id 6 (Ship) in the live SDE — NOT categories 7/8 — so
// they must be filtered by group_id. module_count >= MIN_MODULES drops empty/naked hulls.
export const EXCLUDED_SHIP_GROUPS = [29, 31, 237] as const;
export const MIN_MODULES = 3;

// EVE's repackaged (hauling) volume is a fixed constant per ship hull class and is NOT in the
// SDE types dump — that only carries assembled volume, so the import stores assembled into BOTH
// volume columns for ships (a Catalyst reads 55,000 m³, not its true packaged 5,000). Modules and
// charges repackage 1:1, so their stored volume is already correct. Values validated against ESI
// packaged_volume; keyed by ship group_id. Hulls outside this map fall back to the stored volume.
const SHIP_PACKAGED_M3: Record<number, number> = {
  // Frigate class — 2,500
  25: 2500, 324: 2500, 830: 2500, 831: 2500, 834: 2500, 893: 2500, 1283: 2500, 1527: 2500,
  // Destroyer class — 5,000
  420: 5000, 541: 5000, 1305: 5000, 1534: 5000,
  // Cruiser class — 10,000
  26: 10000, 358: 10000, 832: 10000, 833: 10000, 894: 10000, 906: 10000, 963: 10000, 1972: 10000,
  // Battlecruiser class — 15,000
  419: 15000, 540: 15000, 1201: 15000,
  // Battleship class — 50,000
  27: 50000, 898: 50000, 900: 50000,
  // Mining barge / exhumer — 3,750
  463: 3750, 543: 3750,
  // Industrials / transports — 20,000
  28: 20000, 380: 20000, 1202: 20000
};
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const DEFAULT_MIN_LOSSES = 2;

type PriceSource = "jita" | "est" | "none";
type Trend = "rising" | "falling" | "steady";

// Momentum classifier: compare losses in the recent half of the covered window to the prior
// half. A 15% band keeps small fluctuations from reading as a trend. prior == 0 with any recent
// loss means the fit is brand new in this window (no baseline to divide by) — surfaced as a rise.
const MOMENTUM_BAND = 0.15;
function classifyTrend(recent: number, prior: number): { trend: Trend; pct: number | null } {
  if (prior === 0) return recent > 0 ? { trend: "rising", pct: null } : { trend: "steady", pct: 0 };
  const pct = (recent - prior) / prior;
  if (pct >= MOMENTUM_BAND) return { trend: "rising", pct };
  if (pct <= -MOMENTUM_BAND) return { trend: "falling", pct };
  return { trend: "steady", pct };
}

export interface TrendingParams {
  windowDays: number | null; // null = all available data
  limit: number;
  minLosses: number;
  shipClass: string | null; // types.group_name filter, e.g. "Destroyer"
}

interface ModuleLine {
  type_id: number;
  name: string;
  qty: number;
  unit_price: number;
  line_value: number;
  source: PriceSource;
}

interface SystemHotspot {
  system_id: number;
  name: string;
  region: string | null;
  count: number; // losses of this fit in this system within the window
}

interface TrendingFit {
  rank: number;
  fit_hash: string;
  ship_type_id: number;
  ship_name: string;
  group_name: string | null;
  losses: number;
  losses_lifetime: number;
  pilots: number; // distinct victim characters who lost this exact fit (demand robustness)
  systems: number; // distinct solar systems it was lost in (spread)
  corps: number; // distinct victim corporations — breadth of demand (many corps = open market)
  top_corp_share: number; // 0..1, the single dominant corp's share of losses; high = self-supplied doctrine
  recent_losses: number; // losses in the recent half of the covered window
  prior_losses: number; // losses in the prior half — the momentum baseline
  trend: Trend;
  momentum_pct: number | null; // (recent - prior) / prior; null when prior was 0 (new this window)
  losses_per_day: number; // losses / covered span in days — a sales-velocity proxy
  first_seen: string | null;
  last_seen: string | null;
  module_count: number;
  hull_price: number;
  hull_source: PriceSource;
  build_cost: number;
  volume_m3: number; // packaged components volume to haul (hull packaged + modules)
  isk_per_m3: number; // build_cost / volume_m3, for hauling value density
  value_priced_share: number; // 0..1 fraction of build_cost backed by live Jita orders
  hull_contracts: number; // active warzone contracts selling this hull — supply, the robust floor
  exact_contracts: number; // active warzone contracts selling this EXACT fit (clean pre-fits only)
  cheapest_ask: number | null; // MIN ask among the hull contracts — the price you'd compete with
  jita_contracts: number; // active Forge contracts selling this hull — the "only seller in Jita?" check
  top_systems: SystemHotspot[]; // where it dies most — site sell contracts near here
  modules: ModuleLine[];
}

export interface TrendingResponse {
  generated_at: string | null;
  window_days: number | null;
  window_span_days: number; // actual days of data covered by the window (denominator for /day rates)
  data_range: { from: string | null; to: string | null; days_available: number };
  total_kills_in_window: number;
  count: number;
  fits: TrendingFit[];
}

interface RankRow {
  fit_hash: string;
  ship_type_id: number;
  ship_name: string | null;
  group_name: string | null;
  group_id: number | null;
  module_list_json: string;
  module_count: number;
  losses_lifetime: number;
  first_seen: string | null;
  last_seen: string | null;
  losses: number;
  pilots: number;
  systems: number;
  corps: number;
  recent_losses: number;
}

function clampInt(value: number | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function computeTrending(db: Db, params: TrendingParams): TrendingResponse {
  const span = db
    .prepare(
      "SELECT MIN(killmail_time) AS mn, MAX(killmail_time) AS mx, COUNT(DISTINCT substr(killmail_time, 1, 10)) AS days FROM killmails"
    )
    .get() as { mn: string | null; mx: string | null; days: number };
  // Anchor the window to the freshest killmail, NOT wall-clock now: daily ingest lags real
  // time, so "last 24h" must mean the last 24h of available data or it would read empty.
  const anchorMs = span.mx ? Date.parse(span.mx) : Date.now();
  const minMs = span.mn ? Date.parse(span.mn) : anchorMs;
  const cutoff =
    params.windowDays == null
      ? "0000-00-00T00:00:00Z"
      : new Date(anchorMs - params.windowDays * 86_400_000).toISOString();
  // The actually-covered span: clamp the nominal window to where data exists. Drives both the
  // /day rate denominator and the momentum midpoint, so a window wider than the data still
  // splits the real data in half instead of dumping everything into "recent".
  const cutoffMs = params.windowDays == null ? minMs : anchorMs - params.windowDays * 86_400_000;
  const startMs = Math.max(cutoffMs, minMs);
  const spanDays = Math.max(1, (anchorMs - startMs) / 86_400_000);
  const midIso = new Date((anchorMs + startMs) / 2).toISOString();
  const totalKills = (
    db.prepare("SELECT COUNT(*) AS n FROM killmails WHERE killmail_time >= ?").get(cutoff) as { n: number }
  ).n;

  const classFilter = params.shipClass ? "AND t.group_name = @class" : "";
  const rows = db
    .prepare(
      `SELECT f.fit_hash, f.ship_type_id, t.name AS ship_name, t.group_name, t.group_id,
              f.module_list_json, f.module_count, f.loss_count AS losses_lifetime,
              f.first_seen, f.last_seen,
              COUNT(km.killmail_id) AS losses,
              COUNT(DISTINCT km.victim_character_id) AS pilots,
              COUNT(DISTINCT km.solar_system_id) AS systems,
              COUNT(DISTINCT km.victim_corporation_id) AS corps,
              SUM(CASE WHEN km.killmail_time >= @mid THEN 1 ELSE 0 END) AS recent_losses
       FROM fits f
       JOIN types t ON t.type_id = f.ship_type_id
       JOIN killmails km ON km.fit_hash = f.fit_hash AND km.killmail_time >= @cutoff
       WHERE t.category_id = 6
         AND t.group_id NOT IN (${EXCLUDED_SHIP_GROUPS.join(",")})
         AND f.module_count >= ${MIN_MODULES}
         ${classFilter}
       GROUP BY f.fit_hash
       HAVING losses >= @minLosses
       ORDER BY losses DESC, losses_lifetime DESC, f.fit_hash
       LIMIT @limit`
    )
    .all({
      cutoff,
      mid: midIso,
      minLosses: params.minLosses,
      limit: params.limit,
      ...(params.shipClass ? { class: params.shipClass } : {})
    }) as RankRow[];

  // Batch every hull + module type_id once for names + prices.
  const parsedModules = new Map<string, Array<{ type_id: number; qty: number }>>();
  const ids = new Set<number>();
  for (const row of rows) {
    ids.add(row.ship_type_id);
    let mods: Array<{ type_id: number; qty: number }> = [];
    try {
      mods = (JSON.parse(row.module_list_json) as Array<{ type_id: number; qty: number }>).filter(
        (m) => m && Number.isInteger(m.type_id) && Number.isFinite(m.qty)
      );
    } catch {
      mods = [];
    }
    parsedModules.set(row.fit_hash, mods);
    for (const m of mods) ids.add(m.type_id);
  }

  const nameMap = new Map<number, string>();
  const volMap = new Map<number, number>();
  const pkgVolMap = new Map<number, number>();
  const sellMap = new Map<number, number>();
  const avgMap = new Map<number, number>();
  for (const idChunk of chunk([...ids], 900)) {
    const ph = sqlPlaceholders(idChunk.length);
    for (const r of db
      .prepare(`SELECT type_id, name, volume, packaged_volume FROM types WHERE type_id IN (${ph})`)
      .all(...idChunk) as Array<{ type_id: number; name: string | null; volume: number | null; packaged_volume: number | null }>) {
      if (r.name) nameMap.set(r.type_id, r.name);
      if (r.volume != null) volMap.set(r.type_id, r.volume);
      if (r.packaged_volume != null) pkgVolMap.set(r.type_id, r.packaged_volume);
    }
    for (const r of db.prepare(`SELECT type_id, sell_min FROM prices WHERE type_id IN (${ph})`).all(...idChunk) as Array<{
      type_id: number;
      sell_min: number | null;
    }>) {
      if (r.sell_min != null && r.sell_min > 0) sellMap.set(r.type_id, r.sell_min);
    }
    for (const r of db
      .prepare(`SELECT type_id, average_price FROM adjusted_prices WHERE type_id IN (${ph})`)
      .all(...idChunk) as Array<{ type_id: number; average_price: number | null }>) {
      if (r.average_price != null && r.average_price > 0) avgMap.set(r.type_id, r.average_price);
    }
  }

  const priceOf = (typeId: number): { unit: number; source: PriceSource } => {
    const sell = sellMap.get(typeId);
    if (sell) return { unit: sell, source: "jita" };
    const avg = avgMap.get(typeId);
    if (avg) return { unit: avg, source: "est" };
    return { unit: 0, source: "none" };
  };

  // Where each fit dies: top systems by loss count in the window, so sell contracts can be
  // sited at the frontline hubs where the demand actually is (not Jita).
  const systemsByFit = new Map<string, SystemHotspot[]>();
  if (rows.length > 0) {
    const ph = sqlPlaceholders(rows.length);
    const locRows = db
      .prepare(
        `SELECT km.fit_hash AS fit_hash, km.solar_system_id AS system_id,
                s.name AS sys_name, r.name AS region_name, COUNT(*) AS count
         FROM killmails km
         LEFT JOIN systems s ON s.system_id = km.solar_system_id
         LEFT JOIN regions r ON r.region_id = km.region_id
         WHERE km.fit_hash IN (${ph}) AND km.killmail_time >= ?
         GROUP BY km.fit_hash, km.solar_system_id`
      )
      .all(...rows.map((r) => r.fit_hash), cutoff) as Array<{
      fit_hash: string;
      system_id: number | null;
      sys_name: string | null;
      region_name: string | null;
      count: number;
    }>;
    for (const lr of locRows) {
      if (lr.system_id == null) continue;
      pushToMapList(systemsByFit, lr.fit_hash, {
        system_id: lr.system_id,
        name: lr.sys_name ?? `#${lr.system_id}`,
        region: lr.region_name,
        count: lr.count
      });
    }
    for (const [hash, list] of systemsByFit) {
      list.sort((a, b) => b.count - a.count);
      systemsByFit.set(hash, list.slice(0, 5));
    }
  }

  // Competition / saturation: how much fitted-ship SUPPLY already sits on the shelf for each
  // ranked fit. hull_contracts (robust floor — any contract selling the hull) and cheapest_ask are
  // computed per warzone region set; exact_contracts matches the fit_hash (clean pre-fits only).
  // Measured against CURRENT contracts (wall-clock now), independent of the killmail window.
  const shipIds = [...new Set(rows.map((r) => r.ship_type_id))];
  const fitHashes = rows.map((r) => r.fit_hash);
  const nowTs = new Date().toISOString();
  const satRegions = contractSaturationRegions();
  const priceRegions = contractPriceRegions();

  interface Supply {
    contracts: number;
    cheapest: number | null;
  }
  // Active contracts in `regions` whose included items contain each ranked hull, with the cheapest
  // whole-contract ask (the price a competing fitted-ship seller is listing — what you'd undercut).
  const hullSupply = (regions: number[]): Map<number, Supply> => {
    const out = new Map<number, Supply>();
    if (shipIds.length === 0 || regions.length === 0) return out;
    const regionPh = sqlPlaceholders(regions.length);
    const shipPh = sqlPlaceholders(shipIds.length);
    for (const r of db
      .prepare(
        // price > 0 AND has_excluded_items = 0 mirror the qualifying-ask filter in
        // rebuildContractPrices: a barter/scam contract (price 0, or one that asks items in return)
        // is not a real cash ask, and MIN(price) over it collapsed the cheapest hull ask to 0.
        `SELECT ci.type_id AS ship, COUNT(DISTINCT co.contract_id) AS contracts, MIN(co.price) AS cheapest
         FROM contract_items ci
         JOIN contracts co ON co.contract_id = ci.contract_id
           AND co.gone_at IS NULL AND co.contract_type = 'item_exchange'
           AND co.price > 0 AND co.has_excluded_items = 0
           AND co.date_expired > ? AND co.region_id IN (${regionPh})
         WHERE ci.is_included = 1 AND ci.type_id IN (${shipPh})
         GROUP BY ci.type_id`
      )
      .all(nowTs, ...regions, ...shipIds) as Array<{ ship: number; contracts: number; cheapest: number | null }>) {
      out.set(r.ship, { contracts: r.contracts, cheapest: r.cheapest });
    }
    return out;
  };
  const warzoneSupply = hullSupply(satRegions);
  const jitaSupply = hullSupply(priceRegions);

  const exactByFit = new Map<string, number>();
  if (fitHashes.length > 0 && satRegions.length > 0) {
    const regionPh = sqlPlaceholders(satRegions.length);
    const fitPh = sqlPlaceholders(fitHashes.length);
    for (const r of db
      .prepare(
        `SELECT fit_hash, COUNT(*) AS contracts
         FROM contracts
         WHERE gone_at IS NULL AND contract_type = 'item_exchange'
           AND date_expired > ? AND region_id IN (${regionPh})
           AND fit_hash IN (${fitPh})
         GROUP BY fit_hash`
      )
      .all(nowTs, ...satRegions, ...fitHashes) as Array<{ fit_hash: string; contracts: number }>) {
      exactByFit.set(r.fit_hash, r.contracts);
    }
  }

  // Demand breadth / doctrine detector: `corps` (distinct losing corporations) comes from the main
  // query; here we find the SINGLE dominant corp's loss count per fit. A fit whose losses are mostly
  // one corp is a self-supplied fleet doctrine — those losses are resupplied internally and never
  // become open-market contract sales, so it looks like demand on raw loss count but is a poor
  // build-and-sell target. top_corp_share = dominant corp losses / total losses.
  const topCorpByFit = new Map<string, number>();
  if (rows.length > 0) {
    const ph = sqlPlaceholders(rows.length);
    for (const r of db
      .prepare(
        `SELECT fit_hash, MAX(c) AS top FROM (
           SELECT fit_hash, victim_corporation_id, COUNT(*) AS c
           FROM killmails
           WHERE fit_hash IN (${ph}) AND killmail_time >= ? AND victim_corporation_id IS NOT NULL
           GROUP BY fit_hash, victim_corporation_id
         ) GROUP BY fit_hash`
      )
      .all(...rows.map((r) => r.fit_hash), cutoff) as Array<{ fit_hash: string; top: number }>) {
      topCorpByFit.set(r.fit_hash, r.top);
    }
  }

  const fits: TrendingFit[] = rows.map((row, index) => {
    const hull = priceOf(row.ship_type_id);
    let total = hull.unit;
    let priced = hull.source === "jita" ? hull.unit : 0;
    // Components haul volume: PACKAGED hull (by ship class) + each module's volume.
    let volume =
      (row.group_id != null ? SHIP_PACKAGED_M3[row.group_id] : undefined) ??
      pkgVolMap.get(row.ship_type_id) ??
      volMap.get(row.ship_type_id) ??
      0;
    const modules: ModuleLine[] = (parsedModules.get(row.fit_hash) ?? []).map((m) => {
      const p = priceOf(m.type_id);
      const line = p.unit * m.qty;
      total += line;
      if (p.source === "jita") priced += line;
      volume += (volMap.get(m.type_id) ?? 0) * m.qty;
      return {
        type_id: m.type_id,
        name: nameMap.get(m.type_id) ?? `#${m.type_id}`,
        qty: m.qty,
        unit_price: Math.round(p.unit),
        line_value: Math.round(line),
        source: p.source
      };
    });
    modules.sort((a, b) => b.line_value - a.line_value);
    const buildCost = Math.round(total);
    const volM3 = Math.round(volume * 100) / 100;
    const recent = row.recent_losses ?? 0;
    const prior = row.losses - recent;
    const { trend, pct } = classifyTrend(recent, prior);
    return {
      rank: index + 1,
      fit_hash: row.fit_hash,
      ship_type_id: row.ship_type_id,
      ship_name: row.ship_name ?? `#${row.ship_type_id}`,
      group_name: row.group_name,
      losses: row.losses,
      losses_lifetime: row.losses_lifetime,
      pilots: row.pilots,
      systems: row.systems,
      corps: row.corps,
      top_corp_share: row.losses > 0 ? Math.round(((topCorpByFit.get(row.fit_hash) ?? 0) / row.losses) * 100) / 100 : 0,
      recent_losses: recent,
      prior_losses: prior,
      trend,
      momentum_pct: pct == null ? null : Math.round(pct * 100) / 100,
      losses_per_day: Math.round((row.losses / spanDays) * 10) / 10,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      module_count: row.module_count,
      hull_price: Math.round(hull.unit),
      hull_source: hull.source,
      build_cost: buildCost,
      volume_m3: volM3,
      isk_per_m3: volM3 > 0 ? Math.round(buildCost / volM3) : 0,
      value_priced_share: total > 0 ? Math.round((priced / total) * 100) / 100 : 0,
      hull_contracts: warzoneSupply.get(row.ship_type_id)?.contracts ?? 0,
      exact_contracts: exactByFit.get(row.fit_hash) ?? 0,
      cheapest_ask: warzoneSupply.get(row.ship_type_id)?.cheapest != null
        ? Math.round(warzoneSupply.get(row.ship_type_id)!.cheapest!)
        : null,
      jita_contracts: jitaSupply.get(row.ship_type_id)?.contracts ?? 0,
      top_systems: systemsByFit.get(row.fit_hash) ?? [],
      modules
    };
  });

  return {
    generated_at: span.mx,
    window_days: params.windowDays,
    window_span_days: Math.round(spanDays * 10) / 10,
    data_range: {
      from: span.mn ? span.mn.slice(0, 10) : null,
      to: span.mx ? span.mx.slice(0, 10) : null,
      days_available: span.days
    },
    total_kills_in_window: totalKills,
    count: fits.length,
    fits
  };
}

function setFitsResponseHeaders(reply: FastifyReply, etag: string): void {
  // setFitsCacheHeaders already sets Cache-Control/CDN-Cache-Control/Vary; add the ETag.
  setFitsCacheHeaders(reply);
  reply.header("ETag", etag);
}

export async function registerFitRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // One cache per app instance (see /api/agents): production registers once, tests are
  // isolated. computeTrending is a ~320ms multi-query build over killmails/contracts/
  // prices; cache it keyed by snapshot_data_version — bumped by every ingest that feeds
  // it (prices, contracts, killmails all go through runFetcher) — so an origin cache-miss
  // is a sub-ms hit instead of a ~300ms event-loop stall, and rebuilds only when the
  // underlying data changes.
  const fitsCache = new ResponseCache<string>({ maxEntries: 64, ttlMs: 60 * 60 * 1000 });

  app.get("/api/fits/trending", apiReadRateLimit, async (request: FastifyRequest, reply) => {
    const query = request.query as QueryRecord;

    const windowRaw = first(query.window)?.trim();
    let windowDays: number | null = null;
    if (windowRaw !== undefined && windowRaw !== "") {
      const parsed = parseInteger(windowRaw);
      if (parsed === null) return reply.status(400).send({ error: "invalid_window" });
      windowDays = parsed > 0 ? parsed : null; // 0 / negative => all available
    }

    const limit = clampInt(parseInteger(first(query.limit)), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const minLosses = clampInt(parseInteger(first(query.min_losses)), DEFAULT_MIN_LOSSES, 1, 100_000);
    const shipClass = first(query.class)?.trim() || null;

    const cacheKey = `${snapshotDataVersion(db)}|w=${windowDays ?? "all"}|l=${limit}|m=${minLosses}|c=${shipClass ?? ""}`;
    const cached = await fitsCache.getOrCreate(cacheKey, () =>
      jsonCachedResponse(
        computeTrending(db, { windowDays, limit, minLosses, shipClass }),
        responseEtag(0, `fits|${cacheKey}`)
      )
    );
    return sendCachedResponse(request, reply, cached, { setHeaders: setFitsResponseHeaders });
  });
}
