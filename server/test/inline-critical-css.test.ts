import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { inlineCriticalCss } from "../src/lib/inline-critical-css.js";

// The navigated HTML shells (everything except the LP app, which already ships one bundled
// lp.css link). Each links the shared theme + base sheets plus its own page sheet, and the
// page sheet is the cold straggler that caused the /agents/ FOUC.
const shells = [
  "web/agents/index.html",
  "web/fits/index.html",
  "web/missions/index.html",
  "web/missions/browse.html",
  "web/missions/detail.html",
  "web/missions/arc.html"
];

const localStylesheetLink = /<link rel="stylesheet" href="\/[^"]+"\s*\/>/g;

test("navigated shells inline every local stylesheet so the page is styled at first paint", async () => {
  for (const rel of shells) {
    const html = fs.readFileSync(path.resolve(rel), "utf8");
    const out = await inlineCriticalCss(html);

    const originalLinks = [...html.matchAll(localStylesheetLink)];
    assert.ok(originalLinks.length > 0, `${rel} should start with render-blocking stylesheet links`);

    // No render-blocking local stylesheet <link> survives — they all become inline <style>.
    assert.doesNotMatch(out, localStylesheetLink, `${rel} still has a render-blocking stylesheet link`);
    const inlinedStyles = [...out.matchAll(/<style data-inlined-from="[^"]+">/g)];
    assert.equal(inlinedStyles.length, originalLinks.length, `${rel} inlined a wrong number of stylesheets`);
  }
});

test("inlined agents shell carries the actual stylesheet contents, including the layout grid", async () => {
  const html = fs.readFileSync(path.resolve("web/agents/index.html"), "utf8");
  const out = await inlineCriticalCss(html);

  for (const cssFile of ["web/lp/theme.css", "web/shared/base.css", "web/agents/style.css"]) {
    const css = fs.readFileSync(path.resolve(cssFile), "utf8").trimEnd();
    assert.ok(out.includes(css), `expected inlined contents of ${cssFile}`);
  }
  // The exact rule whose absence produced the FOUC (the two-column shell grid) is now inline.
  assert.match(out, /\.agents-shell\s*\{[\s\S]*?grid-template-columns/);
});

test("inlining preserves cascade order: theme, then shared base, then the page sheet", async () => {
  const html = fs.readFileSync(path.resolve("web/agents/index.html"), "utf8");
  const out = await inlineCriticalCss(html);

  const themeIdx = out.indexOf('data-inlined-from="/lp/theme.css"');
  const baseIdx = out.indexOf('data-inlined-from="/shared/base.css"');
  const styleIdx = out.indexOf('data-inlined-from="/agents/style.css"');
  assert.ok(themeIdx >= 0, "theme.css was not inlined");
  assert.ok(baseIdx > themeIdx, "shared base.css must stay after theme.css");
  assert.ok(styleIdx > baseIdx, "the page sheet must stay after shared base.css");
});

test("non-stylesheet links and remote stylesheets are left untouched", async () => {
  const html = [
    '<link rel="preload" href="/lp/assets/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />',
    '<link rel="modulepreload" href="/agents/app.js" />',
    '<link rel="stylesheet" href="https://example.com/remote.css" />',
    '<link rel="stylesheet" href="/agents/style.css" />'
  ].join("\n");
  const out = await inlineCriticalCss(html);

  assert.match(out, /<link rel="preload" href="\/lp\/assets\/fonts\/inter-var\.woff2"/);
  assert.match(out, /<link rel="modulepreload" href="\/agents\/app\.js"/);
  // A remote stylesheet can't be read from disk, so it stays a link…
  assert.match(out, /<link rel="stylesheet" href="https:\/\/example\.com\/remote\.css"/);
  // …while the local page sheet is inlined.
  assert.match(out, /<style data-inlined-from="\/agents\/style\.css">/);
});

test("a missing local stylesheet keeps its <link> as a working fallback", async () => {
  const html = '<link rel="stylesheet" href="/agents/does-not-exist.css" />';
  const out = await inlineCriticalCss(html);
  assert.equal(out, html);
});
