import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { dataDir } from "../config.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { sendCachedResponse, setBurnersCacheHeaders } from "../lib/api-cache-headers.js";
import { ResponseCache, jsonCachedResponse, type CachedResponse } from "../lib/response-cache.js";
import { responseEtag } from "../lib/compute-generation.js";

// Deliberately NOT under data/missions/seed/ — the arc importer (scripts/run-cli.mjs
// import-missions) globs that directory for arc seed files, and this editorial guide is not
// one, so it lives one level up where the importer never looks.
const burnersJsonPath = path.join(dataDir, "missions", "burners.json");

// Fixed cache key: unlike /api/agents or /api/fits, this route has no DB-backed version to key
// on (no DB involvement at all — see below), so a single constant key is all "get-or-fill once"
// needs.
const burnersCacheKey = "burners";

function setBurnersResponseHeaders(reply: FastifyReply, etag: string): void {
  setBurnersCacheHeaders(reply);
  reply.header("Vary", "Accept-Encoding");
  reply.header("ETag", etag);
}

/**
 * Serves the "Anomic burners" guide: a static editorial JSON seed (data/missions/burners.json)
 * with no calc/DB involvement. The file reaches the container via the ./data volume mount and
 * only ever changes together with a deploy (which restarts the process) — so it is read once at
 * first request and cached in-process for the process lifetime, mirroring the /api/agents cache (see registerAgentRoutes
 * in ./agents.ts) for headers/etag/compression consistency, minus the DB version key that
 * route needs and this one doesn't.
 */
export async function registerBurnerRoutes(app: FastifyInstance): Promise<void> {
  // One cache per app instance (see /api/agents): production registers routes once, so this
  // persists for the process; each test gets its own isolated cache. ttlMs is set to ~a year
  // (effectively "for the process lifetime") rather than reusing agents'/fits' multi-hour TTLs,
  // since there is no import job that could ever change this file out from under a running
  // process — only a deploy (new image, new process) does, and that clears the cache for free.
  const burnersCache = new ResponseCache<string>({ maxEntries: 1, ttlMs: 365 * 24 * 60 * 60 * 1000 });

  app.get("/api/burners", apiReadRateLimit, async (request, reply) => {
    let cached: CachedResponse;
    try {
      cached = await burnersCache.getOrCreate(burnersCacheKey, async () => {
        const raw = await fs.promises.readFile(burnersJsonPath, "utf8");
        // Fingerprint the actual file content, not the constant path — responseEtag hashes the
        // signature. A constant ETag meant an edited burners.json (which ships via deploy, so the
        // process re-reads it) still handed returning clients a 304 and the stale guide forever.
        return jsonCachedResponse(JSON.parse(raw) as unknown, responseEtag(0, `burners|${raw}`));
      });
    } catch (error) {
      // A missing seed file is a deploy/packaging problem, not a per-request condition — but
      // report it as a clean 404 rather than a 500, mirroring how the other file-backed static
      // pages behave when their asset is absent. Anything else (bad JSON, permissions) is
      // unexpected and rethrown for Fastify's default error handler to log + 500.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reply.status(404);
        return { error: "not_found" };
      }
      throw error;
    }

    return sendCachedResponse(request, reply, cached, { setHeaders: setBurnersResponseHeaders });
  });
}
