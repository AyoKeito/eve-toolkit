import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setStaticCacheHeaders } from "../src/lib/static-cache.js";

const lpWebDir = path.resolve("web/lp");
const missionsWebDir = path.resolve("web/missions");

test("LP frontend assets live under the lp web namespace", () => {
  for (const fileName of ["index.html", "about.html", "favicon.svg", "app.js", "diagnostics.js", "ui-model.js", "theme.css", "style.css", "mobile.css", "polish.css", "lp.css"]) {
    assert.ok(fs.existsSync(path.join(lpWebDir, fileName)), `missing web/lp/${fileName}`);
  }
});

test("landing hub page exists and is self-contained (no scripts to preload)", () => {
  const landingPath = path.resolve("web/landing/index.html");
  assert.ok(fs.existsSync(landingPath), "missing web/landing/index.html");
  const landingHtml = fs.readFileSync(landingPath, "utf8");
  assert.doesNotMatch(landingHtml, /<script/);
  assert.match(landingHtml, /href="\/lp\/"/);
  assert.match(landingHtml, /href="\/missions\/"/);
  assert.match(landingHtml, /href="\/agents\/"/);
});

test("server exposes the agent finder under the /agents route namespace", () => {
  const configTs = fs.readFileSync(path.resolve("server/src/config.ts"), "utf8");
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(configTs, /agentsWebDir/);
  assert.match(indexTs, /app\.get\("\/agents"/);
  assert.match(indexTs, /reply\.redirect\("\/agents\/"/);
  assert.match(indexTs, /app\.get\("\/agents\/"/);
  assert.match(indexTs, /sendAgentsPage\(reply\)/);
  assert.match(indexTs, /prefix:\s*"\/agents\/"/);
  // The agents shell is buffer-served with revalidatable headers + an ETag, and the
  // asset plugin applies the same purge-driven cache policy.
  assert.match(indexTs, /function sendAgentsPage[\s\S]*?setStaticCacheHeaders\(reply, filePath\)/);
  assert.match(indexTs, /root:\s*agentsWebDir,[\s\S]*?setHeaders:\s*setStaticCacheHeaders/);
  // The agents API rides registerApiRoutes (root /api only, like missions).
  assert.match(indexTs, /registerAgentRoutes\(target, db\)/);

  for (const fileName of ["index.html", "app.js", "style.css"]) {
    assert.ok(fs.existsSync(path.resolve(`web/agents/${fileName}`)), `missing web/agents/${fileName}`);
  }
});

test("server exposes LP frontend and API under the /lp route namespace", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(indexTs, /prefix:\s*"\/lp\/"/);
  assert.match(indexTs, /prefix:\s*"\/lp"/);
  assert.match(indexTs, /app\.get\("\/"/);
  assert.match(indexTs, /sendLandingPage\(reply\)/);
  assert.match(indexTs, /app\.get\("\/about"/);
  assert.match(indexTs, /reply\.redirect\("\/lp\/about\.html"/);
  // Firefox probes /favicon.ico at the origin root regardless of <link rel="icon">; a redirect
  // to the SVG keeps that probe out of the 404 log.
  assert.match(indexTs, /app\.get\("\/favicon\.ico"/);
  assert.match(indexTs, /reply\.redirect\("\/lp\/favicon\.svg"/);
});

test("server exposes root SEO discovery files for crawlers", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(indexTs, /const siteOrigin\s*=/);
  assert.match(indexTs, /app\.get\("\/robots\.txt"/);
  assert.match(indexTs, /type\("text\/plain; charset=utf-8"\)/);
  assert.match(indexTs, /Sitemap: \$\{siteOrigin\}\/sitemap\.xml/);
  assert.match(indexTs, /app\.get\("\/sitemap\.xml"/);
  assert.match(indexTs, /type\("application\/xml; charset=utf-8"\)/);
  for (const pathName of ["/", "/lp/", "/lp/about.html", "/missions/", "/agents/"]) {
    assert.match(indexTs, new RegExp(`\\$\\{siteOrigin\\}${pathName.replaceAll("/", "\\/")}`));
  }
});

test("server exposes an llms text site guide", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(indexTs, /app\.get\("\/llms\.txt"/);
  assert.match(indexTs, /type\("text\/markdown; charset=utf-8"\)/);
  assert.match(indexTs, /# EVE Tools/);
  assert.match(indexTs, /Top LP Offers CSV/);
  assert.match(indexTs, /\$\{siteOrigin\}\/api\/offers\/top\.csv/);
});

test("static cache policy is purge-driven: every asset is revalidatable, never immutable", () => {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return reply;
    }
  };

  for (const filePath of [
    "/fake/web/lp/app.js",
    "/fake/web/lp/lp.css.br",
    "/fake/web/lp/assets/fonts/inter-var.woff2",
    "/fake/web/missions/app.js",
    "/fake/web/missions/assets/damage/em.png",
    "/fake/web/shared/diagnostics.js"
  ]) {
    headers.clear();
    setStaticCacheHeaders(reply, filePath);
    assert.equal(headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.doesNotMatch(headers.get("cache-control") ?? "", /immutable/);
    // Browsers revalidate every load, but Cloudflare may answer those revalidations from
    // the edge for an hour — deploys purge it via cf:purge-static.
    assert.equal(headers.get("cdn-cache-control"), "public, max-age=3600");
  }

  // HTML shells carry no dynamic data and change only on deploy (which runs purge_everything),
  // so the edge holds them a full day — turning navigations into edge HITs instead of DYNAMIC
  // origin round trips. The browser still revalidates every load. Requires the
  // eve-html-shell-cache Cache Rule to mark the extensionless HTML routes cache-eligible.
  for (const filePath of [
    "/fake/web/landing/index.html",
    "/fake/web/lp/index.html",
    "/fake/web/lp/about.html",
    "/fake/web/missions/detail.html",
    "/fake/web/missions/arc.html",
    "/fake/web/agents/index.html"
  ]) {
    headers.clear();
    setStaticCacheHeaders(reply, filePath);
    assert.equal(headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(headers.get("cdn-cache-control"), "public, s-maxage=86400, stale-while-revalidate=86400");
  }
});

test("LP Inter font is a small self-hosted subset", () => {
  const fontPath = path.join(lpWebDir, "assets/fonts/inter-var.woff2");
  const size = fs.statSync(fontPath).size;

  assert.ok(size < 120 * 1024, `expected subset font under 120 KiB, got ${size} bytes`);
});

test("LP static server enables precompressed assets and custom cache headers", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(indexTs, /setHeaders:\s*setStaticCacheHeaders/);
  assert.match(indexTs, /preCompressed:\s*true/);
});

test("missions frontend assets live under the missions web namespace", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");
  const topLevelAssets = [
    "index.html",
    "style.css",
    "diagnostics.js",
    "app.js",
    "arc-meta.js",
    "beta-notice.js",
    "browse.html",
    "browse.js",
    "arc-graph.js",
    "arc-order.js",
    "formatters.js",
    "missions-ewar.js",
    "missions-util.js",
    "dom-util.js",
    "detail.html",
    "detail.js",
    "detail.css",
    "arc.html",
    "arc.js"
  ];
  for (const fileName of topLevelAssets) {
    assert.ok(fs.existsSync(path.join(missionsWebDir, fileName)), `missing web/missions/${fileName}`);
    assert.match(indexTs, new RegExp(`"${fileName.replace(".", "\\.")}"`));
  }
  for (const fileName of [
    "assets/damage/em.png",
    "assets/damage/thermal.png",
    "assets/damage/kinetic.png",
    "assets/damage/explosive.png",
    "assets/tank/shield.png",
    "assets/tank/armor.png",
    "assets/tank/hull.png",
    "assets/ewar/target-painter.png",
    "assets/ewar/stasis-webifier.png",
    "assets/ewar/warp-scrambler.png",
    "assets/ewar/warp-disruptor.png",
    "assets/ewar/energy-neutralizer.png",
    "assets/ewar/sensor-dampener.png",
    "assets/ewar/ecm.png",
    "assets/ewar/tracking-disruptor.png"
  ]) {
    assert.ok(fs.existsSync(path.join(missionsWebDir, fileName)), `missing web/missions/${fileName}`);
  }
});

test("missions shell does not expose theme switching", () => {
  const missionsHtml = fs.readFileSync(path.resolve("web/missions/index.html"), "utf8");
  const missionsAppJs = fs.readFileSync(path.resolve("web/missions/app.js"), "utf8");

  assert.doesNotMatch(missionsHtml, /id="themeToggle"/);
  assert.doesNotMatch(missionsHtml, /Toggle theme/);
  assert.doesNotMatch(missionsAppJs, /localStorage\.getItem\("theme"\)/);
  assert.doesNotMatch(missionsAppJs, /localStorage\.setItem\("theme"/);
  assert.doesNotMatch(missionsAppJs, /dataset\.theme/);
});

test("server exposes the missions frontend under the /missions route namespace", () => {
  const configTs = fs.readFileSync(path.resolve("server/src/config.ts"), "utf8");
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(configTs, /missionsWebDir/);
  assert.match(indexTs, /app\.get\("\/missions"/);
  assert.match(indexTs, /reply\.redirect\("\/missions\/"/);
  assert.match(indexTs, /app\.get\("\/missions\/"/);
  assert.match(indexTs, /sendMissionPage\(reply, "index\.html"\)/);
  assert.match(indexTs, /app\.get\("\/missions\/browse"/);
  assert.match(indexTs, /sendMissionPage\(reply, "browse\.html"\)/);
  assert.match(indexTs, /missionAssetFiles/);
  assert.match(indexTs, /"diagnostics\.js"/);
  assert.doesNotMatch(indexTs, /missionAssetCacheControl/);
  assert.doesNotMatch(indexTs, /no-cache, no-store, must-revalidate/);
  assert.match(indexTs, /app\.get<\{ Params: \{ file: string \} \}>\("\/missions\/:file"/);
  assert.match(indexTs, /app\.get<\{ Params: \{ id: string \} \}>\("\/missions\/arc\/:id"/);
  assert.match(indexTs, /\/\^\\d\+\$\/\.test\(request\.params\.file\)/);
  assert.match(indexTs, /prefix:\s*"\/missions\/"/);
  // Mission files served by the explicit route get revalidatable cache headers + an ETag.
  assert.match(indexTs, /function sendMissionFile[\s\S]*?setStaticCacheHeaders\(reply, filePath\)/);
  // The nested-asset fallback plugin applies the same revalidatable headers.
  assert.match(indexTs, /root:\s*missionsWebDir,[\s\S]*?setHeaders:\s*setStaticCacheHeaders/);
});

test("server exposes shared front-end modules under the /shared route namespace", () => {
  const configTs = fs.readFileSync(path.resolve("server/src/config.ts"), "utf8");
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");

  assert.match(configTs, /sharedWebDir/);
  assert.match(indexTs, /sharedWebDir/);
  assert.match(indexTs, /prefix:\s*"\/shared\/"/);
  // Shared modules are served purge-driven: revalidatable headers via setStaticCacheHeaders.
  assert.match(indexTs, /root:\s*sharedWebDir,[\s\S]*?setHeaders:\s*setStaticCacheHeaders/);

  for (const fileName of ["diagnostics.js", "utils.js", "base.css"]) {
    assert.ok(fs.existsSync(path.resolve(`web/shared/${fileName}`)), `missing web/shared/${fileName}`);
  }
  for (const shim of ["web/lp/diagnostics.js", "web/missions/diagnostics.js"]) {
    const source = fs.readFileSync(path.resolve(shim), "utf8");
    assert.match(source, /export \* from "\/shared\/diagnostics\.js"/, `${shim} should re-export the shared module`);
  }
});

test("shared base.css is loaded by both apps before their local styles", () => {
  // lp bundles shared/base.css into lp.css (after theme.css) at build time.
  const precompress = fs.readFileSync(path.resolve("scripts/precompress-assets.mjs"), "utf8");
  assert.match(precompress, /shared\/base\.css/);

  // missions links it directly, after theme.css and before its local style.css.
  for (const page of ["web/missions/index.html", "web/missions/browse.html", "web/missions/detail.html", "web/missions/arc.html"]) {
    const html = fs.readFileSync(path.resolve(page), "utf8");
    const themeIdx = html.indexOf("/lp/theme.css");
    const baseIdx = html.indexOf("/shared/base.css");
    const styleIdx = html.indexOf("/missions/style.css");
    assert.ok(baseIdx > themeIdx && baseIdx < styleIdx, `${page} must load /shared/base.css after theme and before local style`);
  }
});
