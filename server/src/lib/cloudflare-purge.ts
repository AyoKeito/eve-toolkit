import type { Db } from "../db.js";
import { readKvString, writeKv } from "./compute-generation.js";
import { errorMessage } from "./parse.js";
import { sleep } from "./timers.js";

export interface CloudflarePurgeOptions {
  zoneId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

export type CloudflarePurgeBody =
  | { files: Array<string | { url: string; headers?: Record<string, string> }> }
  | { prefixes: string[] }
  | { purge_everything: true };

export type CloudflarePurgeResult =
  | { status: "skipped"; reason: "missing_zone_id" | "missing_api_token" | "empty_payload" }
  | { status: "ok"; statusCode: number; method?: string }
  | { status: "error"; statusCode?: number; error?: string; method?: string };

export interface CloudflarePurgeRecord {
  status: CloudflarePurgeResult["status"];
  status_code: number | null;
  error: string | null;
  reason: string | null;
  method?: string;
  at: string;
}

const apiPurgePaths = [
  "/api/offers/top?n=100",
  "/api/offers/top?n=200",
  "/api/offers/top?n=500",
  "/api/offers/top.csv?n=100",
  "/api/corps"
];

// Absolute, query-less site-origin paths for every static asset the browser actually
// fetches (now that ?v= stamps are gone). Cloudflare keys cache by full URL, so these must
// match the served URLs exactly. Spans all four namespaces: /lp, /shared, /missions, /agents.
// The list may exceed 30 entries — purgeCloudflare() chunks file purges into requests of 30
// (Cloudflare's per-request cap on purge-by-files).
const staticPurgePaths = [
  // Landing hub at the site root, then the LP app. Shells are purged at their canonical
  // navigated URLs ("/", "/lp/", "/agents/", "/missions/", "/missions/browse"), NOT
  // "*/index.html" — Cloudflare keys by URL and those are the keys users hit. theme.css is
  // also linked directly by the missions and agents pages.
  "/",
  "/favicon.ico",
  "/lp/",
  "/lp/about.html",
  "/lp/favicon.svg",
  "/lp/lp.css",
  "/lp/theme.css",
  "/lp/app.js",
  "/lp/ui-model.js",
  "/lp/diagnostics.js",
  // Shared ES modules + base stylesheet imported by both apps.
  "/shared/diagnostics.js",
  "/shared/utils.js",
  "/shared/base.css",
  // Agent finder app.
  "/agents/",
  "/agents/app.js",
  "/agents/style.css",
  // Missions app. The shell is purged at its canonical navigated URL "/missions/" (served by
  // GET /missions/). The per-id detail/arc pages (/missions/:id, /missions/arc/:id) cannot be
  // enumerated; they self-heal via the revalidatable ETag headers instead of purging.
  "/missions/",
  "/missions/browse",
  "/missions/burners",
  "/missions/style.css",
  "/missions/detail.css",
  "/missions/burners.css",
  "/missions/app.js",
  "/missions/arc-meta.js",
  "/missions/beta-notice.js",
  "/missions/browse.js",
  "/missions/burners.js",
  "/missions/burners-util.js",
  "/missions/arc.js",
  "/missions/arc-graph.js",
  "/missions/arc-order.js",
  "/missions/combat-stats.js",
  "/missions/detail.js",
  "/missions/diagnostics.js",
  "/missions/dom-util.js",
  "/missions/fit-profile.js",
  "/missions/formatters.js",
  "/missions/missions-ewar.js",
  "/missions/missions-util.js"
];

function configuredAppUrl(appUrl?: string): string {
  const resolved = appUrl?.trim() || process.env.APP_URL?.trim() || "";
  if (!resolved) throw new Error("APP_URL is required to build Cloudflare purge URLs");
  return resolved;
}

function lpBaseUrl(appUrl?: string): string {
  const parsed = new URL(configuredAppUrl(appUrl));
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/lp") ? path : `${path}/lp`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

// Site origin with no /lp suffix — static assets live under /lp, /shared and /missions, so
// they are addressed from the bare origin, not the LP subpath.
function siteOriginUrl(appUrl?: string): string {
  const parsed = new URL(configuredAppUrl(appUrl));
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function canonicalPurgeStaticUrls(appUrl?: string): string[] {
  const origin = siteOriginUrl(appUrl);
  return staticPurgePaths.map((path) => `${origin}${path}`);
}

// Convenience union of the materialized LP API responses (under /lp/api) and every static
// asset. Production purges these two groups separately — the API by prefix via
// canonicalPurgePrefixes() (after each compute) and static assets via
// canonicalPurgeStaticUrls() (on deploy, `npm run cf:purge-static`).
export function canonicalPurgeUrls(appUrl?: string): string[] {
  const lpBase = lpBaseUrl(appUrl);
  return [...apiPurgePaths.map((path) => `${lpBase}${path}`), ...canonicalPurgeStaticUrls(appUrl)];
}

export function canonicalPurgePrefixes(appUrl?: string): string[] {
  const apiUrl = new URL(`${lpBaseUrl(appUrl)}/api/`);
  return [`${apiUrl.host}${apiUrl.pathname}`];
}

// Missions, arcs and agents are served under the bare-origin /api/ root (not /lp/api/) and only
// change on a data import or a deploy. Their edge entries are purge-invalidated (the 24h TTL in
// importDataCdnCacheControl is just a backstop), so the standalone `import-missions`/`import-sde`
// CLIs must purge this prefix or the edge could serve the pre-import data for up to a day. The
// bypassed health paths (/api/health, /api/missions/health) sit under the same prefix but are
// never edge-cached, so purging them is a harmless no-op.
export function canonicalMissionsPurgePrefixes(appUrl?: string): string[] {
  const apiUrl = new URL(`${siteOriginUrl(appUrl)}/api/`);
  return [`${apiUrl.host}${apiUrl.pathname}`];
}

// Purge + record the missions/agents edge prefix after a data import. Mirrors the compute path's
// LP-API purge so a standalone import self-invalidates the purge-driven (24h-backstop) edge entries.
export async function purgeMissionsAgentsEdge(
  db: Db,
  appUrl?: string,
  options: CloudflarePurgeOptions = {}
): Promise<CloudflarePurgeResult> {
  const result = await purgeCloudflareWithRetries({ prefixes: canonicalMissionsPurgePrefixes(appUrl) }, options);
  recordCloudflarePurge(db, result);
  return result;
}

// Detects whether a Cloudflare error response indicates that prefix purge is
// unavailable for the zone's plan (Enterprise-only feature). Matches by CF
// error code 9035 or common message fragments — permissive to handle CF
// wording changes without silently breaking the fallback.
function isPrefixPurgeUnavailableError(responseBody: string): boolean {
  // CF error code 9035: "This zone does not have access to purge by prefix"
  // Also match "prefix" + "not" / "unavailable" / "enterprise" loosely.
  return /\b9035\b/.test(responseBody) || /prefix[^\n]{0,80}(unavailable|not (available|supported|allowed)|enterprise)/i.test(responseBody);
}

// Cloudflare caps purge-by-files at 30 URLs per request; longer lists are split into
// sequential requests. A slice would silently leave entries 31+ edge-stale forever.
const purgeFilesPerRequest = 30;

function chunkFiles<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export interface CloudflarePurgeRetryOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Base backoff before the 2nd attempt; doubles each retry (default 2000ms). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * purgeCloudflare with retry-on-transient-failure. Only a `status: "error"` result
 * (network blip / 5xx) is retried with exponential backoff; `skipped` (missing
 * config) and `ok` return immediately. A stale edge would otherwise persist until
 * s-maxage (~15 min) expires, so a couple of quick retries close the common window.
 * Stays fully async — callers run it off the recompute critical path.
 */
export async function purgeCloudflareWithRetries(
  purge: string[] | CloudflarePurgeBody,
  options: CloudflarePurgeOptions = {},
  retry: CloudflarePurgeRetryOptions = {}
): Promise<CloudflarePurgeResult> {
  const attempts = Math.max(1, retry.attempts ?? 3);
  const baseDelayMs = Math.max(0, retry.baseDelayMs ?? 2000);
  const sleepFn = retry.sleep ?? sleep;
  let result = await purgeCloudflare(purge, options);
  for (let attempt = 2; attempt <= attempts && result.status === "error"; attempt++) {
    await sleepFn(baseDelayMs * 2 ** (attempt - 2));
    result = await purgeCloudflare(purge, options);
  }
  return result;
}

export async function purgeCloudflare(
  purge: string[] | CloudflarePurgeBody,
  options: CloudflarePurgeOptions = {}
): Promise<CloudflarePurgeResult> {
  const zoneId = options.zoneId ?? process.env.CF_ZONE_ID?.trim() ?? "";
  const apiToken = options.apiToken ?? process.env.CF_API_TOKEN?.trim() ?? "";
  const bodies: CloudflarePurgeBody[] = Array.isArray(purge)
    ? chunkFiles(purge, purgeFilesPerRequest).map((files) => ({ files }))
    : [purge];
  const itemCount = bodies.reduce(
    (count, body) => count + ("files" in body ? body.files.length : "prefixes" in body ? body.prefixes.length : 1),
    0
  );
  if (!zoneId) return { status: "skipped", reason: "missing_zone_id" };
  if (!apiToken) return { status: "skipped", reason: "missing_api_token" };
  if (itemCount === 0) return { status: "skipped", reason: "empty_payload" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
  const authHeaders = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json"
  };

  // Sequential requests; the first failure is returned and later chunks are skipped (the
  // recorded result then mirrors what actually reached Cloudflare).
  let lastOk: CloudflarePurgeResult = { status: "ok", statusCode: 200 };
  for (const body of bodies) {
    const result = await sendPurgeBody(body, purgeUrl, authHeaders, fetchImpl);
    if (result.status !== "ok") return result;
    lastOk = result;
  }
  return lastOk;
}

async function sendPurgeBody(
  body: CloudflarePurgeBody,
  purgeUrl: string,
  authHeaders: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<CloudflarePurgeResult> {
  try {
    const response = await fetchImpl(purgeUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body)
    });
    if (response.ok) return { status: "ok", statusCode: response.status };
    const responseBody = await response.text().catch(() => "");

    // Prefix purge is an Enterprise-only feature. When CF rejects it, fall back
    // to purge_everything so API responses are not left edge-stale. The fallback
    // result is tagged method:"purge_everything-fallback" in the recorded payload
    // so /api/health and logs show what happened.
    if ("prefixes" in body && isPrefixPurgeUnavailableError(responseBody)) {
      try {
        const fallbackResponse = await fetchImpl(purgeUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ purge_everything: true })
        });
        if (fallbackResponse.ok) {
          return { status: "ok", statusCode: fallbackResponse.status, method: "purge_everything-fallback" };
        }
        const fallbackBody = await fallbackResponse.text().catch(() => "");
        return { status: "error", statusCode: fallbackResponse.status, error: fallbackBody.slice(0, 300) || undefined, method: "purge_everything-fallback" };
      } catch (fallbackError) {
        return { status: "error", error: errorMessage(fallbackError), method: "purge_everything-fallback" };
      }
    }

    return { status: "error", statusCode: response.status, error: responseBody.slice(0, 300) || undefined };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

export function recordCloudflarePurge(db: Db, result: CloudflarePurgeResult, now = new Date()): CloudflarePurgeRecord {
  const record: CloudflarePurgeRecord = {
    status: result.status,
    status_code: "statusCode" in result && result.statusCode !== undefined ? result.statusCode : null,
    error: result.status === "error" ? result.error ?? null : null,
    reason: result.status === "skipped" ? result.reason : null,
    ...("method" in result && result.method !== undefined ? { method: result.method } : {}),
    at: now.toISOString()
  };
  const line = JSON.stringify({ component: "cloudflare-purge", ...record });
  if (record.status === "error") console.warn(line);
  else console.log(line);
  if (db.open) {
    writeKv(db, "cloudflare_purge_last", JSON.stringify(record));
  }
  return record;
}

export function readLastCloudflarePurge(db: Db): CloudflarePurgeRecord | null {
  const raw = readKvString(db, "cloudflare_purge_last");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CloudflarePurgeRecord;
    return parsed && typeof parsed === "object" && typeof parsed.at === "string" ? parsed : null;
  } catch {
    return null;
  }
}
