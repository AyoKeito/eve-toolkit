import { loadConfig } from "../config.js";
import { importMissionsFromSeed } from "../fetchers/missions-seed.js";
import { purgeMissionsAgentsEdge } from "../lib/cloudflare-purge.js";
import { argValue } from "./args.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("import-missions", async (db) => {
  const summary = await importMissionsFromSeed(
    db,
    argValue(process.argv.slice(2), "dir") ?? undefined
  );
  // Mission/arc edge entries are purge-invalidated (24h TTL is only a backstop, see
  // importDataCdnCacheControl), so a standalone import is invisible until the /api/ prefix is
  // purged. Do it here so an import without a full redeploy still goes live; no-ops cleanly when
  // CF creds are unset (local dev).
  const cloudflare_purge = await purgeMissionsAgentsEdge(db, loadConfig().appUrl);
  return { ...summary, cloudflare_purge };
});
