import { Db, nowIso } from "../db.js";
import {
  buildUserAgent,
  esiCacheMaxRows,
  esiFetchAgentConnections,
  esiFetchAgentPipelining,
  esiRequestTimeoutMs,
  loadConfig
} from "../config.js";
import { Agent, fetch as undiciFetch } from "undici";
import { sleep } from "./timers.js";

const esiBaseUrl = "https://esi.evetech.net";
const fallbackCacheTtlMs = 5 * 60 * 1000;

// ESI 5xx — especially the 504 gateway timeouts CCP emits under load — are
// retried with exponential backoff (2s, 4s, 8s). A single transient 5xx used to
// abort the whole fail-fast hot-price batch (mapWithConcurrency), freezing
// esi-prices-hot freshness and flipping /api/health to "degraded" even though
// every other type fetched fine. Longer waits ride out a slow ESI recovery and
// are cheap against the 15-minute hot cadence.
const serverErrorRetryLimit = 3;
const defaultServerErrorBackoffMs = 2000;

export interface EsiClient {
  getJson<T>(pathOrUrl: string, options?: EsiRequestOptions): Promise<T>;
  getJsonWithMeta<T>(pathOrUrl: string, options?: EsiRequestOptions): Promise<EsiResponse<T>>;
  getStats(): EsiClientStats;
}

export interface EsiRequestOptions {
  /**
   * false = bypass esi_cache entirely (no read, no write). For one-shot bulk
   * endpoints (e.g. contract items, fetched once per contract ever) whose bodies
   * would otherwise evict the hot market pages out of the bounded cache.
   */
  store?: boolean;
}

export interface EsiResponse<T> {
  data: T;
  xPages: number | null;
}

export interface EsiClientStats {
  cache_hits: number;
  network_requests: number;
  network_ms: number;
  backoff_ms: number;
  retry_count: number;
}

export interface EsiClientOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Base for the exponential 5xx-retry backoff (base * 2**attempt). Tests override it to keep retries instant. */
  serverErrorBackoffMs?: number;
}

let esiAgent: Agent | null = null;
let sharedBackoff: { untilMs: number; promise: Promise<void> } | null = null;
const nativeFetch = globalThis.fetch;

function getEsiAgent(): Agent {
  if (!esiAgent) {
    esiAgent = new Agent({
      connections: esiFetchAgentConnections(),
      pipelining: esiFetchAgentPipelining()
    });
  }
  return esiAgent;
}

/**
 * Returns true if `error` is an ESI client error whose HTTP status matches
 * one of the given numeric status codes.
 *
 * ESI errors are thrown as `Error` objects with messages of the form
 * `"ESI <status> <statusText> for <url>"`.  The regex anchors on the `ESI `
 * prefix so it cannot false-match unrelated messages.
 *
 * Example: isEsiClientError(error, 400, 404)
 */
export function isEsiClientError(error: unknown, ...statuses: number[]): boolean {
  if (!(error instanceof Error)) return false;
  const pattern = new RegExp(`^ESI (${statuses.join("|")})\\b`);
  return pattern.test(error.message);
}

export function cleanupExpiredEsiCache(db: Db, now = new Date()): number {
  let removed = db.prepare("DELETE FROM esi_cache WHERE expires_at<=?").run(now.toISOString()).changes;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM esi_cache").get() as { n: number }).n;
  const maxRows = esiCacheMaxRows();
  if (count > maxRows) {
    removed += db
      .prepare(
        `
        DELETE FROM esi_cache WHERE rowid IN (
          SELECT rowid FROM esi_cache ORDER BY expires_at ASC LIMIT ?
        )
      `
      )
      .run(count - maxRows).changes;
  }
  return removed;
}

async function trackedSleep(ms: number, stats: EsiClientStats): Promise<void> {
  const start = Date.now();
  await sleep(ms);
  stats.backoff_ms += Date.now() - start;
}

function setSharedBackoff(ms: number): Promise<void> {
  const duration = Math.max(0, ms);
  const untilMs = Date.now() + duration;
  if (sharedBackoff && sharedBackoff.untilMs >= untilMs) return sharedBackoff.promise;
  const promise = sleep(duration).finally(() => {
    if (sharedBackoff?.promise === promise) sharedBackoff = null;
  });
  sharedBackoff = { untilMs, promise };
  return promise;
}

async function waitForSharedBackoff(stats: EsiClientStats): Promise<void> {
  const pending = sharedBackoff;
  if (!pending) return;
  const start = Date.now();
  await pending.promise;
  stats.backoff_ms += Date.now() - start;
}

function absoluteUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  return `${esiBaseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export function createEsiClient(db: Db, options: EsiClientOptions = {}): EsiClient {
  const config = loadConfig({ requireEsiIdentity: true });
  const userAgent = buildUserAgent(config);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch !== nativeFetch ? globalThis.fetch : (undiciFetch as unknown as typeof fetch));
  const usePackageFetch = options.fetchImpl === undefined && globalThis.fetch === nativeFetch;
  const requestTimeout = options.requestTimeoutMs ?? esiRequestTimeoutMs();
  const serverErrorBackoffMs = options.serverErrorBackoffMs ?? defaultServerErrorBackoffMs;
  const stats: EsiClientStats = {
    cache_hits: 0,
    network_requests: 0,
    network_ms: 0,
    backoff_ms: 0,
    retry_count: 0
  };

  function timeoutError(url: string, cause: unknown): Error {
    return new Error(`ESI request timed out after ${requestTimeout}ms for ${url}`, { cause });
  }

  interface TimedFetch {
    response: Response;
    controller: AbortController;
    /**
     * Disarms the request-timeout timer. Must be called once the response body has been fully
     * read or cancelled — the timer stays armed until then so a stalled BODY read is aborted too.
     * Clearing it at header-arrival time (the old behaviour) left body consumption unbounded, so a
     * response whose headers arrived but whose body never finished streamed past the timeout.
     * Idempotent.
     */
    done: () => void;
  }

  async function fetchWithTimeout(url: string): Promise<TimedFetch> {
    await waitForSharedBackoff(stats);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const done = (): void => clearTimeout(timer);
    const init: RequestInit = {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent
      },
      signal: controller.signal
    };
    if (usePackageFetch) {
      (init as Record<string, unknown>).dispatcher = getEsiAgent();
    }
    const start = Date.now();
    stats.network_requests += 1;
    try {
      const response = await fetchImpl(url, init);
      stats.network_ms += Date.now() - start;
      return { response, controller, done };
    } catch (error) {
      stats.network_ms += Date.now() - start;
      done();
      if (controller.signal.aborted) throw timeoutError(url, error);
      throw error;
    }
  }

  function cachedHeaders(headersJson: string | null | undefined): Pick<EsiResponse<unknown>, "xPages"> {
    if (!headersJson) return { xPages: null };
    try {
      const parsed = JSON.parse(headersJson) as { xPages?: unknown };
      return { xPages: typeof parsed.xPages === "number" && Number.isFinite(parsed.xPages) ? parsed.xPages : null };
    } catch {
      return { xPages: null };
    }
  }

  function responseHeaders(response: Response): Pick<EsiResponse<unknown>, "xPages"> {
    const xPages = Number.parseInt(response.headers.get("x-pages") ?? "", 10);
    return { xPages: Number.isFinite(xPages) && xPages > 0 ? xPages : null };
  }

  function expiresAtIso(expires: string | null): string {
    const timestamp = expires ? Date.parse(expires) : NaN;
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(Date.now() + fallbackCacheTtlMs).toISOString();
  }

  function parseEsiJson<T>(text: string, url: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`invalid JSON from ESI for ${url}`);
    }
  }

  async function requestWithMeta<T>(pathOrUrl: string, options: EsiRequestOptions = {}, attempt = 0): Promise<EsiResponse<T>> {
    const url = absoluteUrl(pathOrUrl);
    const store = options.store !== false;
    if (store) {
      const cached = db.prepare("SELECT expires_at, body, headers_json FROM esi_cache WHERE cache_key=?").get(url) as
        | { expires_at: string; body: string; headers_json?: string | null }
        | undefined;
      if (cached && Date.parse(cached.expires_at) > Date.now()) {
        stats.cache_hits += 1;
        return { data: JSON.parse(cached.body) as T, ...cachedHeaders(cached.headers_json) };
      }
    }

    const { response, controller, done } = await fetchWithTimeout(url);
    const metadata = responseHeaders(response);
    const remain = Number.parseInt(response.headers.get("x-esi-error-limit-remain") ?? "100", 10);
    const resetSeconds = Number.parseInt(response.headers.get("x-esi-error-limit-reset") ?? "0", 10);
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);

    if (response.status === 420 && attempt < 1) {
      done();
      stats.retry_count += 1;
      await response.body?.cancel();
      await trackedSleep(Math.max(resetSeconds, 1) * 1000, stats);
      return requestWithMeta<T>(pathOrUrl, options, attempt + 1);
    }

    // 429 Too Many Requests — ESI's rate-limited routes (e.g. market history) return this with a
    // Retry-After header. Honor it (falling back to the error-limit reset, then 1s) via the shared
    // backoff so every in-flight request slows, then retry within the same budget as 5xx. Left
    // unhandled, a 429 threw immediately and hammered the endpoint straight through the limit.
    if (response.status === 429 && attempt < serverErrorRetryLimit) {
      done();
      stats.retry_count += 1;
      await response.body?.cancel();
      const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.max(resetSeconds, 1);
      const start = Date.now();
      await setSharedBackoff(waitSeconds * 1000);
      stats.backoff_ms += Date.now() - start;
      return requestWithMeta<T>(pathOrUrl, options, attempt + 1);
    }

    if (response.status >= 500 && attempt < serverErrorRetryLimit) {
      done();
      stats.retry_count += 1;
      await response.body?.cancel();
      await trackedSleep(serverErrorBackoffMs * 2 ** attempt, stats);
      return requestWithMeta<T>(pathOrUrl, options, attempt + 1);
    }

    if (!response.ok) {
      done();
      await response.body?.cancel();
      // A 4xx (or a 429/5xx that exhausted its retries) still decremented the ESI error-limit
      // budget, so apply the same near-empty-budget slowdown the success path applies below —
      // otherwise a burst of client errors races past the budget without ever backing off.
      // Fire-and-forget so the caller sees the failure immediately while later requests wait.
      if (remain < 10 && resetSeconds > 0) void setSharedBackoff(resetSeconds * 1000);
      throw new Error(`ESI ${response.status} ${response.statusText} for ${url}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      done();
      if (controller.signal.aborted) throw timeoutError(url, error);
      throw error;
    }
    done();

    // 204 No Content — or ESI's occasional 200 with Content-Length: 0 (seen on
    // public contract items): nothing to parse or cache, surface as null data.
    if (response.status === 204 || text.trim() === "") {
      return { data: null as T, ...metadata };
    }
    const data = parseEsiJson<T>(text, url);
    if (store) {
      const expiresAt = expiresAtIso(response.headers.get("expires"));
      db.prepare(`
        INSERT INTO esi_cache(cache_key, expires_at, body, headers_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          expires_at=excluded.expires_at,
          body=excluded.body,
          headers_json=excluded.headers_json,
          updated_at=excluded.updated_at
      `).run(url, expiresAt, text, JSON.stringify(metadata), nowIso());
    }

    if (remain < 10 && resetSeconds > 0) {
      const start = Date.now();
      await setSharedBackoff(resetSeconds * 1000);
      stats.backoff_ms += Date.now() - start;
    }

    return { data, ...metadata };
  }

  async function request<T>(pathOrUrl: string, options: EsiRequestOptions = {}): Promise<T> {
    return (await requestWithMeta<T>(pathOrUrl, options)).data;
  }

  function getStats(): EsiClientStats {
    return { ...stats };
  }

  return { getJson: request, getJsonWithMeta: requestWithMeta, getStats };
}

/**
 * Page an ESI list endpoint until its `x-pages` header is exhausted, concatenating
 * every page's rows in order. `buildUrl(page)` supplies the 1-based per-page path and
 * `options` is forwarded to each request. A null `x-pages` (header absent) stops after
 * the first page.
 *
 * Empty-body handling differs by caller, so it is explicit: by default a null body
 * (204 / empty 200) on a list page is treated as anomalous and THROWS (fail-closed) —
 * the region-contracts scan relies on this, because silently treating a null page as an
 * empty region would make it mark every live contract in that region gone. Callers that
 * legitimately receive empty bodies (the contract-items endpoint, which 204s for
 * item-less/expired contracts) pass `allowEmptyPages: true` to skip such pages instead.
 */
export async function getAllPages<T>(
  esi: EsiClient,
  buildUrl: (page: number) => string,
  options?: EsiRequestOptions,
  { allowEmptyPages = false }: { allowEmptyPages?: boolean } = {}
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let totalPages: number | null = null;
  while (true) {
    const { data, xPages } = await esi.getJsonWithMeta<T[] | null>(buildUrl(page), options);
    if (data) {
      rows.push(...data);
    } else if (!allowEmptyPages) {
      throw new Error(`ESI returned an empty body for ${buildUrl(page)}`);
    }
    if (xPages !== null) totalPages = xPages;
    if (totalPages === null || page >= totalPages) break;
    page += 1;
  }
  return rows;
}
