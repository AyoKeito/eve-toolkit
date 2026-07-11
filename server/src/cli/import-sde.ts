import { loadConfig } from "../config.js";
import { importSde } from "../fetchers/sde.js";
import { purgeMissionsAgentsEdge } from "../lib/cloudflare-purge.js";
import { runCliJob } from "./run-cli-job.js";

await runCliJob("import-sde", async (db) => {
  const summary = await importSde(db);
  // import-sde changes agent (and system/type) data behind /api/agents and /api/missions, whose
  // edge entries are purge-invalidated (24h backstop TTL). Purge the /api/ prefix so a standalone
  // SDE import goes live without a deploy; the subsequent `compute` separately purges /lp/api/.
  const cloudflare_purge = await purgeMissionsAgentsEdge(db, loadConfig().appUrl);
  return { ...summary, cloudflare_purge };
});
