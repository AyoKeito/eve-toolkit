import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { countRows, type Db } from "../db.js";
import { loadConfig } from "../config.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { setHealthCacheHeaders } from "../lib/api-cache-headers.js";
import { readLastCloudflarePurge } from "../lib/cloudflare-purge.js";

const requiredFetchers = [
  { name: "esi-lp", maxAgeMs: 48 * 60 * 60 * 1000 },
  { name: "esi-prices-hot", maxAgeMs: 30 * 60 * 1000 },
  { name: "esi-prices-cold", maxAgeMs: 2 * 60 * 60 * 1000 },
  { name: "esi-history", maxAgeMs: 48 * 60 * 60 * 1000 }
];
const requiredTables = ["corporations", "offers", "prices", "prices_book", "history", "calc"] as const;

type FetcherStatus = {
  name: string;
  last_success: string | null;
  last_error_at: string | null;
  last_error_msg: string | null;
};

type SdeStatus = {
  source: string;
  build_number: number | null;
  release_date: string | null;
  imported_at: string;
};

export async function registerHealthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/health", apiReadRateLimit, async (_request, reply) => {
    setHealthCacheHeaders(reply);
    const config = loadConfig();
    const fetchers = db.prepare("SELECT * FROM fetcher_status ORDER BY name").all() as FetcherStatus[];
    const lastFullCompute = db.prepare("SELECT MAX(computed_at) AS computed_at FROM calc").get() as { computed_at: string | null };
    const sde = db
      .prepare(
        "SELECT source, build_number, release_date, imported_at FROM source_imports WHERE source='ccp-jsonl-sde'"
      )
      .get() as SdeStatus | undefined;
    const dbSizeMb = fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size / 1024 / 1024 : 0;
    const now = Date.now();
    const issues: string[] = [];
    const fetcherByName = new Map(fetchers.map((fetcher) => [fetcher.name, fetcher]));

    for (const fetcher of requiredFetchers) {
      const status = fetcherByName.get(fetcher.name);
      if (!status) {
        issues.push(`missing_fetcher_status:${fetcher.name}`);
        continue;
      }
      if (status.last_error_at) issues.push(`fetcher_failed:${fetcher.name}`);
      if (!status.last_success) {
        issues.push(`missing_fetcher_success:${fetcher.name}`);
        continue;
      }
      const lastSuccessMs = Date.parse(status.last_success);
      if (!Number.isFinite(lastSuccessMs)) {
        issues.push(`invalid_fetcher_success:${fetcher.name}`);
      } else if (now - lastSuccessMs > fetcher.maxAgeMs) {
        issues.push(`stale_fetcher:${fetcher.name}`);
      }
    }

    for (const table of requiredTables) {
      if (countRows(db, table) <= 0) issues.push(`empty_table:${table}`);
    }

    const cloudflarePurge = readLastCloudflarePurge(db);
    if (cloudflarePurge?.status === "error") issues.push("cloudflare_purge_failed");

    return {
      status: issues.length > 0 ? "degraded" : "ok",
      issues,
      fetcher_status: fetchers,
      db_size_mb: Number(dbSizeMb.toFixed(2)),
      last_full_compute: lastFullCompute.computed_at,
      cloudflare_purge: cloudflarePurge,
      sde: sde ?? null
    };
  });
}
