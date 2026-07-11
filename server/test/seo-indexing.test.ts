import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const publicHtmlPages = [
  "web/landing/index.html",
  "web/lp/index.html",
  "web/lp/about.html",
  "web/agents/index.html",
  "web/missions/index.html",
  "web/missions/browse.html",
  "web/missions/detail.html",
  "web/missions/arc.html"
];

function readText(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

test("Google indexing pages explicitly permit indexing and do not contain noindex", () => {
  for (const filePath of publicHtmlPages) {
    const html = readText(filePath);
    assert.match(html, /<meta name="robots" content="index,follow" \/>/, filePath);
    assert.doesNotMatch(html.toLowerCase(), /\bnoindex\b/, filePath);
  }
});

test("Google indexing canonical landing page is the non-redirecting site root", () => {
  const landingHtml = readText("web/landing/index.html");
  const lpIndexHtml = readText("web/lp/index.html");
  const indexTs = readText("server/src/index.ts");

  // The landing hub owns the site root: canonical /, Search Console verification meta.
  assert.match(landingHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/" \/>/);
  assert.match(landingHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/" \/>/);
  assert.match(landingHtml, /<meta name="google-site-verification"/);
  // The LP calculator's canonical home moved to /lp/.
  assert.match(lpIndexHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/lp\/" \/>/);
  assert.match(lpIndexHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/lp\/" \/>/);
  // All six sitemap entries must be present (order-independent; the array may be multiline).
  assert.match(indexTs, /sitemapUrls/);
  assert.match(indexTs, /\$\{siteOrigin\}\//);
  assert.match(indexTs, /\$\{siteOrigin\}\/lp\//);
  assert.match(indexTs, /\$\{siteOrigin\}\/lp\/about\.html/);
  assert.match(indexTs, /\$\{siteOrigin\}\/missions\//);
  assert.match(indexTs, /\$\{siteOrigin\}\/missions\/browse/);
  assert.match(indexTs, /\$\{siteOrigin\}\/agents\//);
  // Root serves the landing hub; only legacy LP permalinks (query strings) 301 to /lp/.
  assert.match(indexTs, /return sendLandingPage\(reply\);/);
  assert.match(indexTs, /reply\.redirect\(`\/lp\/\?\$\{query\}`, 301\)/);

  // browse.html has its own canonical at /missions/browse
  const browseHtml = readText("web/missions/browse.html");
  assert.match(browseHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/missions\/browse" \/>/);
  assert.match(browseHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/missions\/browse" \/>/);
  // missions/index.html canonical is unchanged
  const missionsIndexHtml = readText("web/missions/index.html");
  assert.match(missionsIndexHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/missions\/" \/>/)

  // The agent finder's canonical home is /agents/.
  const agentsHtml = readText("web/agents/index.html");
  assert.match(agentsHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/agents\/" \/>/);
  assert.match(agentsHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/agents\/" \/>/);
});
