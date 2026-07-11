import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("ops scripts expose safe stray runtime inspection and cleanup commands", () => {
  assert.equal(packageJson.scripts["ops:ps"], "node scripts/ops-processes.mjs list");
  assert.equal(packageJson.scripts["ops:kill-extras"], "node scripts/ops-processes.mjs kill");
  assert.ok(fs.existsSync(path.resolve("scripts/ops-processes.mjs")));
});

test("ops process helper defaults to the current checkout root", () => {
  const source = fs.readFileSync(path.resolve("scripts/ops-processes.mjs"), "utf8");

  assert.match(source, /const repoRoot = path\.resolve/);
  assert.match(source, /\/proc/);
  assert.match(source, /readlink/);
  assert.match(source, /process\.kill/);
  assert.match(source, /npm start|node dist\/server\/src\/index\.js|tsx server\/src\/index\.ts/);
});

test("timed dev and runtime image expose operator debugging helpers", () => {
  assert.equal(packageJson.scripts["dev:timed"], "node scripts/run-timed-dev.mjs");
  assert.ok(fs.existsSync(path.resolve("scripts/run-timed-dev.mjs")));

  const dockerfile = fs.readFileSync(path.resolve("Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG APT_MIRROR=http:\/\/deb\.debian\.org\/debian/);
  assert.match(dockerfile, /ARG APT_SECURITY_MIRROR=http:\/\/deb\.debian\.org\/debian-security/);
  for (const tool of ["curl", "iproute2", "jq", "procps", "sqlite3"]) {
    assert.match(dockerfile, new RegExp(`apt-get install[\\s\\S]*\\b${tool}\\b`), tool);
  }
  assert.match(dockerfile, /CMD \["node", "dist\/server\/src\/index\.js"\]/);
});
