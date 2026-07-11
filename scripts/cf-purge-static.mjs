import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const purgeModulePath = path.join(root, "dist/server/src/lib/cloudflare-purge.js");

let purgeModule;
try {
  purgeModule = await import(pathToFileURL(purgeModulePath).href);
} catch (error) {
  console.error("Cloudflare static purge requires a compiled build. Run npm run build before npm run cf:purge-static.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { canonicalPurgeStaticUrls, purgeCloudflare } = purgeModule;
const urls = canonicalPurgeStaticUrls();
const result = await purgeCloudflare(urls);

console.log(JSON.stringify({ ...result, files: urls.length, pass: 1 }));

if (result.status === "error") {
  process.exitCode = 1;
} else if (result.status === "ok") {
  // Second pass after a settle delay: with Smart Tiered Cache, a request that lands
  // between the purge and tier propagation can re-seed a colo with the pre-purge asset
  // (observed 2026-06-10: a stale module survived the first purge with its Age intact).
  // A delayed re-purge evicts anything that was re-pulled from a stale upper tier.
  const settleMs = Number(process.env.CF_PURGE_SETTLE_MS ?? 25_000);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const second = await purgeCloudflare(urls);
  console.log(JSON.stringify({ ...second, files: urls.length, pass: 2 }));
  if (second.status === "error") process.exitCode = 1;
}
