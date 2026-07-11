import type { FastifyReply, FastifyRequest } from "fastify";
import { applyLpPerHour } from "./response-materialize.js";
import { DEFAULT_LP_PER_HOUR, type Basis } from "../calc/ratio.js";
import type { CachedResponse } from "./response-cache.js";

export const apiCacheControl = "public, max-age=60, stale-while-revalidate=1800";
export const cdnCacheControl = "public, s-maxage=900, stale-while-revalidate=1800";
export const healthCacheControl = "public, max-age=5, stale-while-revalidate=10";
const missionsCacheControl = "public, max-age=30, stale-while-revalidate=120";

export function setApiCacheHeaders(reply: FastifyReply, etag: string): void {
  reply.header("Cache-Control", apiCacheControl);
  reply.header("CDN-Cache-Control", cdnCacheControl);
  reply.header("Vary", "Accept-Encoding");
  reply.header("ETag", etag);
}

export function setHealthCacheHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", healthCacheControl);
}

/** Set the browser (Cache-Control) and edge (CDN-Cache-Control) policies for a
 * purge-invalidated import/data endpoint. `vary` adds Vary: Accept-Encoding for
 * endpoints that serve pre-brotli'd bodies (fits); others omit it. */
function setEdgeCacheHeaders(reply: FastifyReply, browser: string, edge: string, vary = false): void {
  reply.header("Cache-Control", browser);
  reply.header("CDN-Cache-Control", edge);
  if (vary) reply.header("Vary", "Accept-Encoding");
}

// Mission, arc and agent data carries no dynamic component — it changes only on a deploy or an
// explicit `import-missions`/`import-sde`, and BOTH of those purge the /api/ edge prefix (see
// purgeMissionsAgentsEdge / canonicalMissionsPurgePrefixes). So invalidation is purge-driven; the
// 24-hour edge TTL is only a backstop that self-heals a missed purge or a lost tiered-cache
// re-seed race within a day. A lost-race stale entry here is merely outdated data, not a broken
// page, so it does not need the static assets' tighter 1-hour bound (staticCdnCacheControl). The
// browser TTL stays short (missionsCacheControl, 30 s) so a user picks up post-purge data
// near-instantly. Requires the matching /api Cache Rule from docs/CLOUDFLARE.md to be cache-eligible.
const importDataCdnCacheControl = "public, s-maxage=86400, stale-while-revalidate=86400";

export function setMissionsCacheHeaders(reply: FastifyReply): void {
  setEdgeCacheHeaders(reply, missionsCacheControl, importDataCdnCacheControl);
}

export function setAgentsCacheHeaders(reply: FastifyReply): void {
  // Same purge-invalidated 24h-backstop edge hold as missions (requires /api/agents in the Cache
  // Rule). Agent data changes only on SDE import/deploy, both of which purge /api/.
  setEdgeCacheHeaders(reply, missionsCacheControl, importDataCdnCacheControl);
}

export function setBurnersCacheHeaders(reply: FastifyReply): void {
  // Same purge-invalidated 24h-backstop edge hold as missions/agents (requires /api/burners in
  // the Cache Rule). The burners guide JSON changes only on deploy, which zone-purges
  // (scripts/deploy.sh -> purge_everything), so the 24h TTL is only a staleness backstop.
  setEdgeCacheHeaders(reply, missionsCacheControl, importDataCdnCacheControl);
}

const contractPricesCdnCacheControl = "public, s-maxage=1800, stale-while-revalidate=3600";

export function setContractPricesCacheHeaders(reply: FastifyReply): void {
  // Contract prices refresh on the daily contract scan (13:00 UTC); the 30-minute edge hold is
  // just a staleness backstop (requires /api/contract-prices in the Cache Rule from docs/CLOUDFLARE.md).
  setEdgeCacheHeaders(reply, missionsCacheControl, contractPricesCdnCacheControl);
}

const fitsCdnCacheControl = "public, s-maxage=600, stale-while-revalidate=1800";

export function setFitsCacheHeaders(reply: FastifyReply): void {
  // Trending fits change on the daily killmail ingest, the daily contract scan (competition), and
  // the cold price cadence; a short browser TTL plus a ~10-minute edge hold keeps it fresh.
  // Owner-only/low-traffic, so even if /api/fits is absent from the Cloudflare cache rule
  // (origin-served), this is harmless. Vary: Accept-Encoding — fits serves pre-brotli'd bodies.
  setEdgeCacheHeaders(reply, missionsCacheControl, fitsCdnCacheControl, true);
}

export function isNotModified(request: FastifyRequest, etag: string): boolean {
  const header = request.headers["if-none-match"];
  return typeof header === "string" && header.split(",").map((part) => part.trim()).includes(etag);
}

export function sendCachedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  cached: CachedResponse,
  options: {
    lpPerHour?: number;
    basis?: Basis;
    contentDisposition?: string;
    etag?: string;
    /** Sets the cache-policy headers (and ETag). Defaults to the LP offers policy;
     * other endpoints (e.g. /api/agents) pass their own edge/browser TTLs. */
    setHeaders?: (reply: FastifyReply, etag: string) => void;
  } = {}
): FastifyReply {
  // Prefer a per-request ETag that fingerprints the served body (query shape +
  // lpPerHour). cached.etag is generation-only and collides across bodies that share
  // a generation, which would let an If-None-Match replayed across query params 304
  // onto the wrong body. Falls back to cached.etag when no override is supplied.
  const etag = options.etag ?? cached.etag;
  const setHeaders = options.setHeaders ?? setApiCacheHeaders;
  if (isNotModified(request, etag)) {
    setHeaders(reply, etag);
    return reply.status(304).send();
  }

  let body = cached.body;
  let useBrotli = false;
  if (
    cached.contentType.startsWith("application/json") &&
    options.lpPerHour !== undefined &&
    options.lpPerHour !== DEFAULT_LP_PER_HOUR
  ) {
    const applied = applyLpPerHour(body, options.lpPerHour, options.basis);
    body = applied.body;
  } else if (cached.brotli && /\bbr\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
    body = cached.brotli;
    useBrotli = true;
  }

  setHeaders(reply, etag);
  reply.header("Content-Type", cached.contentType);
  if (options.contentDisposition) reply.header("Content-Disposition", options.contentDisposition);
  if (useBrotli) reply.header("Content-Encoding", "br");
  return reply.send(body);
}
