import type { Db } from "../db.js";
import { nowIso, recordFetcherSuccess } from "../db.js";
import { esiFetchConcurrency } from "../config.js";
import { cleanupExpiredEsiCache, createEsiClient, type EsiClient, type EsiClientStats } from "../lib/esi.js";
import { runFetcher } from "../lib/fetcher.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { errorMessage } from "../lib/parse.js";
import { chunk, sqlPlaceholders } from "../lib/sql.js";

const jita44 = 60003760;
const jitaSystemId = 30000142;

interface EsiOrder {
  is_buy_order?: boolean;
  location_id: number;
  order_id: number;
  price: number;
  range?: string;
  system_id: number;
  type_id: number;
  volume_remain: number;
}

// Instant-sale valuation cashes a product out into Jita buy orders, so only buy orders a seller
// standing at Jita 4-4 can actually fill may count. We fetch The Forge (region 10000002) only, so a
// region-range order always reaches Jita 4-4; station-/solarsystem-range orders reach it only when
// co-located with Jita 4-4 / the Jita system. Numeric jump ranges ("1".."40") can't be verified
// without a system jump-distance map, so they're kept (best-effort). Accepting every order
// regardless of range let a remote station-range order inflate the instant-sale price above the
// real Jita buy. (ESI per-order min_volume is not enforced here — that needs the sale quantity,
// known only at walk time — so an order demanding a larger minimum fill than the sold quantity can
// still be counted.)
function buyReachesJita44(order: EsiOrder): boolean {
  switch (order.range) {
    case "station":
      return order.location_id === jita44;
    case "solarsystem":
      return order.system_id === jitaSystemId;
    default:
      // "region" reaches the whole (Jita-containing) region; numeric ranges kept best-effort.
      return true;
  }
}

type Tier = "hot" | "cold";
type FetchStrategy = "per-type" | "region-bulk" | "per-type-fallback";

interface FetchOrderPagesResult {
  orders: EsiOrder[];
  pages: number;
}

interface FetchPricesResult {
  count: number;
  dbMs: number;
  pagesTotal: number;
  strategy: FetchStrategy;
}

function filterKnownTypeIds(db: Db, typeIds: number[]): number[] {
  const known = new Set<number>();
  for (const batch of chunk(typeIds, 900)) {
    const placeholders = sqlPlaceholders(batch.length);
    const rows = db.prepare(`SELECT type_id FROM types WHERE type_id IN (${placeholders})`).all(...batch) as Array<{
      type_id: number;
    }>;
    for (const row of rows) {
      known.add(row.type_id);
    }
  }
  return typeIds.filter((typeId) => known.has(typeId));
}

function collectTypeIds(db: Db, tier: Tier): number[] {
  if (tier === "hot") {
    const hot = db.prepare("SELECT type_id FROM prices WHERE rank_hot IS NOT NULL ORDER BY rank_hot LIMIT 500").all() as {
      type_id: number;
    }[];
    if (hot.length > 0) return hot.map((row) => row.type_id);
  }

  const rows = db.prepare("SELECT DISTINCT type_id FROM offer_market_types ORDER BY type_id").all() as Array<{
    type_id: number;
  }>;
  return filterKnownTypeIds(
    db,
    rows.map((row) => row.type_id)
  );
}

/**
 * Hull + fitted-module type_ids referenced by the killmail `fits` dictionary. The cold
 * region-bulk fetch already downloads the entire Jita order book, so adding these to the
 * kept-type universe gives the trending-fits page live sell prices at no extra ESI cost —
 * it just widens which buckets are persisted. Deliberately NOT folded into
 * `collectTypeIds`/`referencedTypeIds`, because those also drive the per-type history
 * fetcher (`esi-history`); fit modules want spot prices, not a history-call explosion.
 */
function fitMarketTypeIds(db: Db): number[] {
  try {
    const rows = db.prepare("SELECT ship_type_id, module_list_json FROM fits").all() as Array<{
      ship_type_id: number;
      module_list_json: string;
    }>;
    const ids = new Set<number>();
    for (const row of rows) {
      if (Number.isInteger(row.ship_type_id)) ids.add(row.ship_type_id);
      try {
        const mods = JSON.parse(row.module_list_json) as Array<{ type_id?: number }>;
        for (const mod of mods) {
          if (mod && Number.isInteger(mod.type_id)) ids.add(mod.type_id as number);
        }
      } catch {
        // Skip a fit with malformed module JSON rather than abort the whole price run.
      }
    }
    return filterKnownTypeIds(db, [...ids]);
  } catch {
    // `fits` table absent (e.g. a minimal unit-test db) — nothing extra to price.
    return [];
  }
}

function mergeUniqueTypeIds(base: number[], extra: number[]): number[] {
  return [...new Set([...base, ...extra])];
}

async function fetchAllOrderPages(esi: EsiClient, typeId: number): Promise<FetchOrderPagesResult> {
  const orders: EsiOrder[] = [];
  let page = 1;
  let totalPages: number | null = null;
  let pages = 0;

  while (true) {
    const url = `/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${page}`;
    const { data: rows, xPages } = await esi.getJsonWithMeta<EsiOrder[]>(url);
    pages += 1;
    if (xPages !== null) totalPages = xPages;
    orders.push(...rows);
    if (rows.length < 1000) break;
    if (totalPages !== null && page >= totalPages) break;
    page += 1;
  }
  return { orders, pages };
}

function writeOrdersForType(db: Db, typeId: number, orders: EsiOrder[], updatedAt: string): void {
  const sell = orders
    .filter((order) => !order.is_buy_order)
    .sort((a, b) => a.price - b.price || b.volume_remain - a.volume_remain);
  const buy = orders
    .filter((order) => order.is_buy_order && buyReachesJita44(order))
    .sort((a, b) => b.price - a.price || b.volume_remain - a.volume_remain);
  const sellQty = sell.reduce((sum, order) => sum + order.volume_remain, 0);
  const sellTopQtyShare = sellQty > 0 ? sell[0]!.volume_remain / sellQty : null;
  const sellMin = sell[0]?.price ?? null;
  const buyMax = buy[0]?.price ?? null;
  const sellMinAtJita44 = sell[0]?.location_id === jita44 ? 1 : 0;

  db.prepare(`
    INSERT INTO prices(
      type_id, sell_min, buy_max, sell_order_count, buy_order_count,
      sell_top_qty_share, sell_min_at_jita_44, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      sell_min=excluded.sell_min,
      buy_max=excluded.buy_max,
      sell_order_count=excluded.sell_order_count,
      buy_order_count=excluded.buy_order_count,
      sell_top_qty_share=excluded.sell_top_qty_share,
      sell_min_at_jita_44=excluded.sell_min_at_jita_44,
      updated_at=excluded.updated_at
  `).run(typeId, sellMin, buyMax, sell.length, buy.length, sellTopQtyShare, sellMinAtJita44, updatedAt);

  db.prepare("DELETE FROM prices_book WHERE type_id=?").run(typeId);
  const insertBook = db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  sell
    .slice(0, 50)
    .forEach((order, ix) =>
      insertBook.run(
        typeId,
        "sell",
        ix,
        order.order_id,
        order.price,
        order.volume_remain,
        order.location_id,
        order.system_id,
        order.location_id === jita44 ? 1 : 0
      )
    );
  buy
    .slice(0, 50)
    .forEach((order, ix) =>
      insertBook.run(
        typeId,
        "buy",
        ix,
        order.order_id,
        order.price,
        order.volume_remain,
        order.location_id,
        order.system_id,
        order.location_id === jita44 ? 1 : 0
      )
    );
}

function persistOrdersBatch(db: Db, entries: Array<{ typeId: number; orders: EsiOrder[] }>): void {
  const updatedAt = nowIso();
  const tx = db.transaction(() => {
    for (const entry of entries) writeOrdersForType(db, entry.typeId, entry.orders, updatedAt);
  });
  tx();
}

async function fetchPricesPerType(
  db: Db,
  esi: EsiClient,
  typeIds: number[],
  strategy: FetchStrategy
): Promise<FetchPricesResult> {
  let dbMs = 0;
  const results = await mapWithConcurrency(typeIds, esiFetchConcurrency(), async (typeId) => {
    const { orders, pages } = await fetchAllOrderPages(esi, typeId);
    const dbStart = Date.now();
    persistOrdersBatch(db, [{ typeId, orders }]);
    dbMs += Date.now() - dbStart;
    return { pages };
  });

  return {
    count: results.length,
    dbMs,
    pagesTotal: results.reduce((sum, result) => sum + result.pages, 0),
    strategy
  };
}

function bucketKnownOrders(ordersByType: Map<number, EsiOrder[]>, knownTypeIds: Set<number>, rows: EsiOrder[]): void {
  for (const order of rows) {
    if (!knownTypeIds.has(order.type_id)) continue;
    let bucket = ordersByType.get(order.type_id);
    if (!bucket) {
      bucket = [];
      ordersByType.set(order.type_id, bucket);
    }
    bucket.push(order);
  }
}

async function fetchRegionBulkPage(esi: EsiClient, page: number): Promise<{ rows: EsiOrder[]; xPages: number | null }> {
  const url = `/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&page=${page}`;
  const { data: rows, xPages } = await esi.getJsonWithMeta<EsiOrder[]>(url);
  return { rows, xPages };
}

async function fetchPricesRegionBulk(db: Db, esi: EsiClient, typeIds: number[]): Promise<FetchPricesResult> {
  const knownTypeIds = new Set(typeIds);
  const ordersByType = new Map<number, EsiOrder[]>();
  let pagesTotal = 0;
  let dbMs = 0;

  const first = await fetchRegionBulkPage(esi, 1);
  pagesTotal += 1;
  if (!first.xPages) throw new Error("region bulk market orders response missing x-pages");
  bucketKnownOrders(ordersByType, knownTypeIds, first.rows);

  const remainingPages = Array.from({ length: Math.max(0, first.xPages - 1) }, (_, index) => index + 2);
  const pageResults = await mapWithConcurrency(remainingPages, esiFetchConcurrency(), (page) => fetchRegionBulkPage(esi, page));
  for (const result of pageResults) {
    pagesTotal += 1;
    bucketKnownOrders(ordersByType, knownTypeIds, result.rows);
  }

  const entries = typeIds.map((typeId) => ({ typeId, orders: ordersByType.get(typeId) ?? [] }));
  for (let index = 0; index < entries.length; index += 100) {
    const dbStart = Date.now();
    persistOrdersBatch(db, entries.slice(index, index + 100));
    dbMs += Date.now() - dbStart;
  }

  return { count: typeIds.length, dbMs, pagesTotal, strategy: "region-bulk" };
}

function logFetchPrices(
  tier: Tier,
  result: FetchPricesResult,
  stats: EsiClientStats,
  startedAt: number,
  extraDbMs = 0
): void {
  console.log(
    JSON.stringify({
      component: "fetch_prices",
      tier,
      strategy: result.strategy,
      types_total: result.count,
      pages_total: result.pagesTotal,
      duration_ms: Date.now() - startedAt,
      db_ms: result.dbMs + extraDbMs,
      net_ms: stats.network_ms,
      backoff_ms: stats.backoff_ms,
      cache_hits: stats.cache_hits,
      network_requests: stats.network_requests,
      retry_count: stats.retry_count
    })
  );
}

function logBulkFallback(tier: Tier, error: unknown): void {
  console.warn(
    JSON.stringify({
      component: "fetch_prices",
      tier,
      strategy: "region-bulk",
      event: "fallback",
      error: errorMessage(error)
    })
  );
}

export async function fetchPrices(db: Db, tier: Tier = "cold", limit?: number): Promise<number> {
  const name = tier === "hot" ? "esi-prices-hot" : "esi-prices-cold";
  // Cold runs price the full offer universe plus the killmail fit hulls/modules so the
  // trending-fits valuation reads live Jita sell orders; hot stays the lean offer-hot list.
  const baseTypeIds = collectTypeIds(db, tier);
  const universe = tier === "cold" ? mergeUniqueTypeIds(baseTypeIds, fitMarketTypeIds(db)) : baseTypeIds;
  const typeIds = universe.slice(0, limit ?? Number.POSITIVE_INFINITY);
  const startedAt = Date.now();
  if (typeIds.length === 0) {
    // Early-return path: record success + log without entering the main fetch loop.
    // Cleanup timing is measured here since runFetcher is not used for this path.
    const cleanupStart = Date.now();
    cleanupExpiredEsiCache(db);
    const cleanupDbMs = Date.now() - cleanupStart;
    recordFetcherSuccess(db, name);
    logFetchPrices(
      tier,
      { count: 0, dbMs: 0, pagesTotal: 0, strategy: tier === "cold" && limit === undefined ? "region-bulk" : "per-type" },
      { cache_hits: 0, network_requests: 0, network_ms: 0, backoff_ms: 0, retry_count: 0 },
      startedAt,
      cleanupDbMs
    );
    return 0;
  }

  const esi = createEsiClient(db);
  return runFetcher(db, name, async () => {
    let result: FetchPricesResult;
    if (tier === "cold" && limit === undefined) {
      try {
        result = await fetchPricesRegionBulk(db, esi, typeIds);
      } catch (error) {
        logBulkFallback(tier, error);
        result = await fetchPricesPerType(db, esi, typeIds, "per-type-fallback");
      }
    } else {
      result = await fetchPricesPerType(db, esi, typeIds, "per-type");
    }
    // Note: runFetcher calls cleanupExpiredEsiCache after this work function returns,
    // so cleanupDbMs is not measured separately here.
    logFetchPrices(tier, result, esi.getStats(), startedAt);
    return result.count;
  });
}

export function referencedTypeIds(db: Db): number[] {
  return collectTypeIds(db, "cold");
}
