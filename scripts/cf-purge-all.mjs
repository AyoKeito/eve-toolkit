import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const purgeModulePath = path.join(root, "dist/server/src/lib/cloudflare-purge.js");

let purgeModule;
try {
  purgeModule = await import(pathToFileURL(purgeModulePath).href);
} catch (error) {
  console.error("Cloudflare zone purge requires a compiled build. Run npm run build before npm run cf:purge-all.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { purgeCloudflare } = purgeModule;

// Zone-wide purge for deploys. Targeted URL purges (cf:purge-static, even with its
// two-pass settle) have repeatedly — 4× as of 2026-06-10 — left one Smart Tiered Cache
// variant serving a stale JS module across hard reloads while curl saw the new file;
// only purge_everything reliably evicts the flapping variant. The zone serves a single
// low-traffic site, so the full eviction is cheap and the edge re-fills on demand.
const result = await purgeCloudflare({ purge_everything: true });
console.log(JSON.stringify({ ...result, method: "purge_everything" }));

// Unlike compute-time purges, a deploy purge that silently skips (missing creds) means
// stale assets WILL be served — fail loudly so the deploy flow surfaces it.
if (result.status !== "ok") process.exitCode = 1;
