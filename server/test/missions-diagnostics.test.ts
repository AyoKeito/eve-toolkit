import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const indexHtml = fs.readFileSync(path.resolve("web/missions/index.html"), "utf8");
const browseHtml = fs.readFileSync(path.resolve("web/missions/browse.html"), "utf8");
const detailHtml = fs.readFileSync(path.resolve("web/missions/detail.html"), "utf8");
const arcHtml = fs.readFileSync(path.resolve("web/missions/arc.html"), "utf8");
const appJs = fs.readFileSync(path.resolve("web/missions/app.js"), "utf8");
const browseJs = fs.readFileSync(path.resolve("web/missions/browse.js"), "utf8");
const detailJs = fs.readFileSync(path.resolve("web/missions/detail.js"), "utf8");
const arcJs = fs.readFileSync(path.resolve("web/missions/arc.js"), "utf8");

test("missions pages expose only the visible diagnostic client id", () => {
  for (const html of [indexHtml, browseHtml, detailHtml, arcHtml]) {
    assert.match(html, /class="[^"]*\bdiagnostic-chips\b/);
    assert.match(html, /id="clientIdChip"/);
    assert.doesNotMatch(html, /id="requestIdChip"/);
  }
});

test("missions fetches send diagnostic client ids without surfacing request ids", () => {
  for (const js of [appJs, browseJs, detailJs, arcJs]) {
    assert.match(js, /from "\.\/diagnostics\.js"/);
    assert.match(js, /initializeDiagnostics\(\)/);
    // apiFetch wraps all API calls (string or template literal); raw fetch must not be used
    assert.match(js, /apiFetch\(/);
    assert.doesNotMatch(js, /fetch\(`/);
  }
});
