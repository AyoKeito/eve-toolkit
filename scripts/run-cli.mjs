import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliNames = new Set([
  "import-sde",
  "refresh-sde",
  "fetch-lp",
  "fetch-prices",
  "fetch-adjusted-prices",
  "fetch-history",
  "fetch-contracts",
  "fetch-killmails",
  "compute",
  "snapshot",
  "import-missions",
  "scrape-missions"
]);
const script = process.argv[2];
const forwardedArgs = process.argv.slice(3);

if (!script || !cliNames.has(script)) {
  console.error(`Usage: node scripts/run-cli.mjs <${[...cliNames].join("|")}> [args...]`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "server", "src", "cli", `${script}.js`);
const sourceEntry = path.join(root, "server", "src", "cli", `${script}.ts`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (fs.existsSync(distEntry)) {
  run(process.execPath, [distEntry, ...forwardedArgs]);
}

const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
if (!fs.existsSync(tsxBin)) {
  console.error("Built CLI entrypoint is missing and local tsx is not installed. Run npm run build or install dev dependencies.");
  process.exit(1);
}

run(tsxBin, [sourceEntry, ...forwardedArgs], { shell: process.platform === "win32" });
