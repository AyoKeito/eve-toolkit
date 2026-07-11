import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("data bootstrap scripts use the runtime-safe CLI wrapper", () => {
  for (const script of [
    "import-sde",
    "fetch-lp",
    "fetch-prices",
    "fetch-adjusted-prices",
    "fetch-history",
    "compute",
    "snapshot",
    "import-missions",
    "scrape-missions"
  ]) {
    assert.equal(packageJson.scripts[script], `node scripts/run-cli.mjs ${script}`);
    assert.doesNotMatch(packageJson.scripts[script], /\btsx\b/);
  }
  assert.ok(fs.existsSync(path.resolve("scripts/run-cli.mjs")));
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (/\.(ts|js|json)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("production runtime has no Fuzzwork or SQLite SDE knobs", () => {
  const forbidden = /seed-fuzzwork|seedPricesFromFuzzwork|market\.fuzzwork\.co\.uk|sqlite-latest\.sqlite|SDE_SQLITE_URL|SDE_SQLITE_PATH/;
  const files = [...sourceFiles(path.resolve("server/src")), path.resolve("package.json")];
  const offenders = files.filter((file) => forbidden.test(fs.readFileSync(file, "utf8")));

  assert.deepEqual(offenders.map((file) => path.relative(process.cwd(), file)), []);
});
