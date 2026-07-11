import { loadConfig } from "../config.js";
import { refreshSde } from "../fetchers/sde.js";
import { purgeMissionsAgentsEdge } from "../lib/cloudflare-purge.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("refresh-sde", async (db) => {
  const result = await refreshSde(db);
  // Nothing changed: no new build, so no edge state to invalidate.
  if (!result.imported) return { ...result, cloudflare_purge: null };
  // A new build touched agent/system/type data behind /api/agents and /api/missions (24h backstop
  // TTL). Purge the /api/ prefix so a manual refresh goes live without a deploy; the subsequent
  // compute separately purges /lp/api/. Mirrors the import-sde CLI.
  const cloudflare_purge = await purgeMissionsAgentsEdge(db, loadConfig().appUrl);
  return { ...result, cloudflare_purge };
});
