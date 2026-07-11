import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("environment examples document Cloudflare purge credentials and rate-limit override", () => {
  const envExample = fs.readFileSync(path.resolve(".env.example"), "utf8");

  assert.match(envExample, /CF_ZONE_ID=/);
  assert.match(envExample, /CF_API_TOKEN=/);
  assert.match(envExample, /API_READ_RATE_LIMIT_MAX=180/);
  // Token split: the operator-only ruleset token is documented and kept out of the container env.
  assert.match(envExample, /CF_RULESET_API_TOKEN/);
});

test("Cloudflare runbook documents cache rules, tiered cache, and token scope", () => {
  const runbookPath = path.resolve("docs/CLOUDFLARE.md");
  assert.ok(fs.existsSync(runbookPath), "missing docs/CLOUDFLARE.md");

  const runbook = fs.readFileSync(runbookPath, "utf8");
  // The three deployed cache rules, including the missions API and /shared statics.
  assert.match(runbook, /eve-api-cache-bypass/);
  assert.match(runbook, /eve-public-api-cache/);
  assert.match(runbook, /eve-static-assets-cache/);
  assert.match(runbook, /eve-html-shell-cache/);
  assert.match(runbook, /"\/api\/missions" "\/api\/arcs"/);
  assert.match(runbook, /\/shared\/\*\.js/);
  assert.match(runbook, /ne "\/api\/missions\/health"/);
  assert.match(runbook, /Smart Tiered Caching Topology/);
  assert.match(runbook, /Zone:Cache Purge:Edit/);
  assert.match(runbook, /CF_ZONE_ID/);
  assert.match(runbook, /CF_API_TOKEN/);
  assert.match(runbook, /npm run cf:purge-static/);
  // Deploys purge zone-wide: targeted purges repeatedly left a stale tiered-cache variant.
  assert.match(runbook, /npm run cf:purge-all/);
  assert.match(runbook, /purge_everything/);
});

test("package exposes a static Cloudflare purge deploy helper", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  const scriptPath = path.resolve("scripts/cf-purge-static.mjs");

  assert.equal(packageJson.scripts["cf:purge-static"], "node scripts/cf-purge-static.mjs");
  assert.ok(fs.existsSync(scriptPath), "missing scripts/cf-purge-static.mjs");
  assert.match(fs.readFileSync(scriptPath, "utf8"), /canonicalPurgeStaticUrls/);
});

test("package exposes a zone-wide Cloudflare purge for deploys", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  const scriptPath = path.resolve("scripts/cf-purge-all.mjs");

  assert.equal(packageJson.scripts["cf:purge-all"], "node scripts/cf-purge-all.mjs");
  assert.ok(fs.existsSync(scriptPath), "missing scripts/cf-purge-all.mjs");
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /purge_everything: true/);
  // A deploy purge that silently skips (missing creds) must fail the deploy flow.
  assert.match(script, /result\.status !== "ok"/);
});

test("package chains the deploy purge so it cannot be skipped by hand", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  const scriptPath = path.resolve("scripts/deploy.sh");

  assert.equal(packageJson.scripts["deploy"], "bash scripts/deploy.sh");
  assert.ok(fs.existsSync(scriptPath), "missing scripts/deploy.sh");
  const script = fs.readFileSync(scriptPath, "utf8");
  // Rebuild → health-gate → purge, all in one committed command that fails loud (set -e).
  assert.match(script, /docker compose up -d --build/);
  assert.match(script, /cf-purge-all\.mjs/);
  assert.match(script, /set -euo pipefail/);
});

test("package versions the Cloudflare cache ruleset and exposes pull/diff/apply tooling", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };

  assert.equal(packageJson.scripts["cf:ruleset:pull"], "node scripts/cf-ruleset.mjs pull");
  assert.equal(packageJson.scripts["cf:ruleset:diff"], "node scripts/cf-ruleset.mjs diff");
  assert.equal(packageJson.scripts["cf:ruleset:apply"], "node scripts/cf-ruleset.mjs apply");
  assert.ok(fs.existsSync(path.resolve("scripts/cf-ruleset.mjs")), "missing scripts/cf-ruleset.mjs");

  const helper = fs.readFileSync(path.resolve("scripts/cf-ruleset.mjs"), "utf8");
  // Uses the dedicated operator token, not the always-on purge token.
  assert.match(helper, /CF_RULESET_API_TOKEN/);
  // Refuses to PUT the hand-reconstructed seed until a real pull captures the live ruleset.
  assert.match(helper, /_unverified_reconstruction/);

  const rulesetPath = path.resolve("infra/cf-cache-ruleset.json");
  assert.ok(fs.existsSync(rulesetPath), "missing infra/cf-cache-ruleset.json");
  const ruleset = JSON.parse(fs.readFileSync(rulesetPath, "utf8")) as {
    _unverified_reconstruction?: boolean;
    rules: Array<{ description: string }>;
  };
  // The committed seed is now the applied live snapshot captured via `cf:ruleset:pull`, so it is
  // no longer flagged as an unverified hand reconstruction.
  assert.notEqual(ruleset._unverified_reconstruction, true, "committed seed must be the applied live snapshot, not an unverified reconstruction");
  assert.equal(ruleset.rules.length, 4, "the four documented cache rules must be present");
  // Match the live rule descriptions (the applied snapshot uses human-readable descriptions):
  // bypass for health/refresh, the public LP API cache, static assets, and the HTML shells.
  for (const fragment of ["health and refresh", "canonical LP API", "frontend static assets", "HTML shells"]) {
    assert.ok(ruleset.rules.some((rule) => rule.description.includes(fragment)), `ruleset must include the "${fragment}" rule`);
  }
});

test("Cloudflare runbook documents the deploy wrapper, ruleset tooling, and token split", () => {
  const runbook = fs.readFileSync(path.resolve("docs/CLOUDFLARE.md"), "utf8");

  assert.match(runbook, /npm run deploy/);
  assert.match(runbook, /cf:ruleset:pull/);
  assert.match(runbook, /infra\/cf-cache-ruleset\.json/);
  assert.match(runbook, /CF_RULESET_API_TOKEN/);
  // The runtime token is least-privilege (purge only).
  assert.match(runbook, /Zone:Cache Purge:Edit ONLY/);
});
