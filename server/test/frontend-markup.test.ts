import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.resolve("web/lp/index.html"), "utf8");
const aboutHtml = fs.readFileSync(path.resolve("web/lp/about.html"), "utf8");
const appJs = fs.readFileSync(path.resolve("web/lp/app.js"), "utf8");
const diagnosticsJs = fs.readFileSync(path.resolve("web/lp/diagnostics.js"), "utf8");
const sharedDiagnosticsJs = fs.readFileSync(path.resolve("web/shared/diagnostics.js"), "utf8");
const sharedUtilsJs = fs.readFileSync(path.resolve("web/shared/utils.js"), "utf8");
// LP frontend modules split out of app.js: flag chips, detail drawer, floating table chrome.
const flagsJs = fs.readFileSync(path.resolve("web/lp/flags.js"), "utf8");
const detailDrawerJs = fs.readFileSync(path.resolve("web/lp/detail-drawer.js"), "utf8");
const floatingTableJs = fs.readFileSync(path.resolve("web/lp/floating-table.js"), "utf8");
const mobileCss = fs.readFileSync(path.resolve("web/lp/mobile.css"), "utf8");

function htmlBlock(pattern: RegExp): string {
  const match = html.match(pattern);
  assert.ok(match, `Missing HTML block for ${pattern}`);
  return match[0];
}

function sortHeader(sort: string): string {
  return htmlBlock(new RegExp(`<th[^>]*data-sort="${sort}"[^>]*>[\\s\\S]*?<\\/th>`));
}

function headerCell(label: string): string {
  return htmlBlock(new RegExp(`<th[^>]*>[\\s\\S]*?${label}[\\s\\S]*?<\\/th>`));
}

test("index page exposes the desktop workstation shell regions", () => {
  assert.match(html, /class="[^"]*\bworkstation\b/);
  assert.match(html, /<aside id="filtersPanel" class="[^"]*\bfilters\b/);
  assert.match(html, /class="[^"]*\bresults\b/);
  assert.doesNotMatch(html, /class="[^"]*\bintelligence-rail\b/);
});

test("index page references critical LP assets query-less (purge-driven cache busting)", () => {
  assert.match(html, /href="\/lp\/lp\.css"/);
  assert.match(html, /src="\/lp\/app\.js"/);
  assert.match(appJs, /from "\.\/ui-model\.js"/);
});

test("LP pages keep render-blocking styles to one bundle", () => {
  for (const pageHtml of [html, aboutHtml]) {
    const stylesheets = pageHtml.match(/<link rel="stylesheet" href="[^"]+" \/>/g) ?? [];
    assert.deepEqual(stylesheets, [`<link rel="stylesheet" href="/lp/lp.css" />`]);
  }
});

test("LP script and module assets are referenced query-less", () => {
  assert.match(html, /src="\/lp\/app\.js"/);
  assert.match(appJs, /from "\.\/ui-model\.js"/);
  assert.match(appJs, /from "\.\/diagnostics\.js"/);
});

test("LP pages expose the placeholder favicon", () => {
  for (const pageHtml of [html, aboutHtml]) {
    assert.match(pageHtml, /<link rel="icon" type="image\/svg\+xml" href="\/lp\/favicon\.svg" \/>/);
  }
});

test("LP frontend references carry no ?v= cache-bust queries (purge-driven)", () => {
  // Match ?v= only inside a string/template literal (an actual asset ref), not prose comments.
  for (const source of [html, aboutHtml, appJs, diagnosticsJs, sharedDiagnosticsJs, mobileCss]) {
    assert.doesNotMatch(source, /["'`][^"'`\n]*\?v=/);
  }
});

test("LP pages expose canonical URLs and search result descriptions", () => {
  assert.match(html, /<meta name="google-site-verification" content="zsgdSA30xvsiOoyB7EXHyMDsppZXFHh9xxyfQ0In6oo" \/>/);
  assert.match(html, /<meta name="description" content="EVE Online LP store calculator ranking loyalty point offers by ISK per LP using Jita market data, fees, volume, and access-risk filters\." \/>/);
  assert.match(html, /<meta name="robots" content="index,follow" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/lp\/" \/>/);
  assert.match(html, /<meta property="og:title" content="EVE LP Store Calculator" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/lp\/" \/>/);

  assert.match(aboutHtml, /<meta name="robots" content="index,follow" \/>/);
  assert.match(aboutHtml, /<meta name="description" content="Methodology for the EVE LP Store Calculator, including pricing formulas, data sources, refresh cadence, cache behavior, and leaderboard guardrails\." \/>/);
  assert.match(aboutHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/lp\/about\.html" \/>/);
  assert.match(aboutHtml, /<meta property="og:title" content="Methodology - EVE LP Store Calculator" \/>/);
  assert.match(aboutHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/lp\/about\.html" \/>/);
});

test("index page exposes metric strip and compact topbar status hooks", () => {
  for (const id of [
    "metricBestInstant",
    "metricBestPatient",
    "metricMedianIskPerLp",
    "metricLpVolume",
    "metricIskVolume",
    "metricPriceHealth",
    "metricPriceHealthNote",
    "metricBestIskHour",
    "resultsLoadingState",
    "stalePrices",
    "staleLp",
    "staleHealth",
    "stalePurge",
    "clientIdChip"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(htmlBlock(/<header class="topbar">[\s\S]*?<\/header>/), /id="resultsLoadingState"/);
  assert.match(html, /Median ISK\/LP/);
  assert.doesNotMatch(html, /Avg ISK\/LP \(Instant\)/);
  assert.doesNotMatch(html, /id="summaryOfferCount"/);
  assert.doesNotMatch(html, /id="totalExtractable"/);
  assert.doesNotMatch(html, /id="metricTotalOffers"/);
  assert.doesNotMatch(html, /id="selectedOfferPanel"/);
});

test("index page keeps required user actions visible", () => {
  for (const id of ["copyPermalink", "exportCsv"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="themeToggle"/);
  assert.doesNotMatch(html, /Toggle theme/);
  assert.match(html, /href="(?:\/lp)?\/about\.html"/);
});

test("frontend exposes only the client diagnostic ID and sends client IDs with API calls", () => {
  assert.match(html, /class="[^"]*\bdiagnostic-chips\b/);
  assert.match(html, /id="clientIdChip"/);
  assert.doesNotMatch(html, /id="requestIdChip"/);
  assert.match(appJs, /from "\.\/diagnostics\.js"/);
  assert.match(appJs, /initializeDiagnostics\(\)/);
  assert.match(appJs, /apiFetch\(`/);
  assert.doesNotMatch(appJs, /fetch\(`/);
});

test("initial LP row request is not blocked by non-critical metadata fetches", () => {
  assert.match(appJs, /function loadInitialData\(\)/);
  assert.match(appJs, /void loadRows\(\)\.catch\(renderLoadError\)\.finally\(\(\) => \{/);
  assert.match(appJs, /scheduleNonCriticalStartup\(\)/);
  assert.doesNotMatch(appJs, /Promise\.allSettled\(\[loadCorpOptions\(\), loadRows\(\)\.catch\(renderLoadError\), loadHealth\(\)\]\)/);
});

test("table chrome measurement is scheduled after row DOM mutations", () => {
  assert.match(appJs, /function renderRows\(rows\)[\s\S]*scheduleTableChrome\(\);[\s\S]*function renderLoadingRows/);
  assert.match(appJs, /function renderLoadingRows\(\)[\s\S]*scheduleTableChrome\(\);[\s\S]*function setRowsLoading/);
  assert.doesNotMatch(appJs, /function renderRows\(rows\)[\s\S]*syncTableChrome\(\);[\s\S]*function renderLoadingRows/);
});

test("frontend keeps the dark theme fixed without persisted theme state", () => {
  assert.doesNotMatch(appJs, /localStorage\.getItem\("theme"\)/);
  assert.doesNotMatch(appJs, /localStorage\.setItem\("theme"/);
  assert.doesNotMatch(appJs, /dataset\.theme/);
});

test("copy permalink handler tolerates missing Clipboard API", () => {
  assert.match(appJs, /function copyPermalink/);
  assert.match(appJs, /navigator\.clipboard\?\.writeText/);
  assert.match(appJs, /document\.execCommand\("copy"\)/);
});

test("index page exposes concept-faithful above-fold table without movers", () => {
  assert.doesNotMatch(html, /data-sort="risk"/);
  assert.doesNotMatch(html, /<th>Risk<\/th>/);
  assert.match(html, /data-sort="iskPerLp"/);
  assert.match(html, /data-cell="iskPerLp"/);
  assert.doesNotMatch(html, /data-cell="risk"/);
  assert.doesNotMatch(html, /data-cell="health"/);
  assert.doesNotMatch(html, />Health<\/th>/);
  assert.match(html, /colspan="13"/);
  assert.doesNotMatch(html, /colspan="14"/);
  assert.doesNotMatch(html, /colspan="15"/);
  assert.doesNotMatch(appJs, /colspan="14"/);
  assert.doesNotMatch(html, /class="[^"]*\bterminal-controls\b/);
  assert.doesNotMatch(html, /class="[^"]*\bterminal-icon\b/);
  assert.doesNotMatch(html, /class="[^"]*\bmenu-icon\b/);
  assert.doesNotMatch(html, /class="[^"]*\bgrid-icon\b/);
  assert.doesNotMatch(html, /id="moversPanel"/);
  assert.doesNotMatch(html, /class="[^"]*\bmover-tabs\b/);
  assert.doesNotMatch(html, />Movers</);
  assert.match(appJs, /autoSelectFirstRow/);
  assert.match(detailDrawerJs, /summarizeDetailDrawer/);
  assert.doesNotMatch(appJs, /summarizeMovers/);
  assert.doesNotMatch(appJs, /loadMovers/);
  assert.doesNotMatch(appJs, /data-mover-tab/);
  assert.doesNotMatch(appJs, /shouldKeepMoverPanelOpen/);
});

test("leaderboard exposes an aria-hidden floating horizontal scrollbar proxy", () => {
  const tableWrap = htmlBlock(/<div id="tableWrap" class="table-wrap">[\s\S]*?<\/table>\s*<\/div>/);

  assert.match(
    tableWrap,
    /<div class="floating-hscroll" aria-hidden="true">\s*<div class="floating-hscroll-inner"><\/div>\s*<\/div>/
  );
  assert.ok(tableWrap.indexOf("floating-hscroll") < tableWrap.indexOf("<table>"));
  assert.match(floatingTableJs, /function initializeFloatingScrollbar/);
  assert.match(floatingTableJs, /function syncFloatingScrollbar/);
  assert.match(floatingTableJs, /new ResizeObserver/);
  assert.match(floatingTableJs, /new IntersectionObserver/);
  assert.match(floatingTableJs, /getBoundingClientRect\(\)/);
  assert.match(floatingTableJs, /tableWrap\.classList\.toggle\("is-scrolled",\s*tableWrap\.scrollLeft > 0\)/);
  assert.match(floatingTableJs, /floatBar\.setAttribute\("aria-hidden",\s*"true"\)/);
});

test("leaderboard initializes an aria-hidden fixed table header for vertical scroll", () => {
  assert.match(floatingTableJs, /function initializeFloatingTableHeader/);
  assert.match(floatingTableJs, /document\.createElement\("div"\)/);
  assert.match(floatingTableJs, /className\s*=\s*"floating-table-header"/);
  assert.match(floatingTableJs, /setAttribute\("aria-hidden",\s*"true"\)/);
  assert.match(floatingTableJs, /querySelector\("thead"\)\?\.cloneNode\(true\)/);
  assert.match(appJs, /function activateSortHeader/);
  assert.match(appJs, /handleSortHeaderClick/);
  assert.match(floatingTableJs, /topbar\?\.getBoundingClientRect\(\)\.bottom/);
  assert.match(floatingTableJs, /tableWrap\.scrollLeft/);
});

test("floating table header copies intrinsic source column widths", () => {
  assert.match(floatingTableJs, /function syncFloatingHeaderColumnWidths\(\)/);
  assert.match(floatingTableJs, /const sourceCells = \[\.\.\.sourceHead\.querySelectorAll\("th"\)\]/);
  assert.match(floatingTableJs, /const cloneCells = \[\.\.\.clonedHead\.querySelectorAll\("th"\)\]/);
  assert.match(floatingTableJs, /sourceCells\[index\]\.getBoundingClientRect\(\)\.width/);
  assert.match(floatingTableJs, /cloneCells\[index\]\.style\.width = width/);
  assert.match(floatingTableJs, /syncFloatingHeaderColumnWidths\(\);\s*setFloatingHeaderActive\(true\)/);
});

test("leaderboard coalesces resize chrome sync into animation frames", () => {
  assert.match(floatingTableJs, /function createFrameScheduler/);
  assert.match(floatingTableJs, /const scheduleFloatingScrollbar\s*=\s*createFrameScheduler\(syncFloatingScrollbar\)/);
  assert.match(floatingTableJs, /const scheduleFloatingTableHeader\s*=\s*createFrameScheduler\(syncFloatingTableHeader\)/);
  assert.match(floatingTableJs, /function scheduleTableChrome\(\)/);
  assert.match(floatingTableJs, /new ResizeObserver\(\(\) => scheduleFloatingScrollbar\(\)\)/);
  assert.match(floatingTableJs, /new ResizeObserver\(\(\) => scheduleFloatingTableHeader\(\)\)/);
  assert.match(floatingTableJs, /window\.addEventListener\("resize",\s*scheduleFloatingTableHeader/);
  assert.doesNotMatch(floatingTableJs, /window\.addEventListener\("resize",\s*syncFloatingTableHeader/);
  assert.doesNotMatch(floatingTableJs, /new ResizeObserver\(\(\) => syncFloatingTableHeader\(\)\)/);
});

test("leaderboard table omits the standing column", () => {
  assert.doesNotMatch(html, /data-sort="standing"/);
  assert.doesNotMatch(html, /data-cell="standing"/);
  assert.doesNotMatch(appJs, /cells\.standing/);
});

test("leaderboard table keeps flags visible but not sortable", () => {
  assert.doesNotMatch(html, /<option value="flags">Flags<\/option>/);
  assert.doesNotMatch(html, /<th[^>]*data-sort="flags"/);
  assert.doesNotMatch(appJs, /flags:\s*"asc"/);
  assert.match(
    html,
    /<th[^>]*class="[^"]*\bflags-header\b[^"]*"[^>]*title="Liquidity, price-quality, cargo-volume, access-risk, vanity, and stale-data warnings\."[^>]*>Flags<\/th>/
  );
});

test("leaderboard table keeps corp and offer visible but not sortable", () => {
  for (const sort of ["corp", "offer"]) {
    assert.doesNotMatch(html, new RegExp(`<option value="${sort}">`));
    assert.doesNotMatch(html, new RegExp(`<th[^>]*data-sort="${sort}"`));
  }
  assert.match(
    html,
    /<th[^>]*class="[^"]*\bcorp-header\b[^"]*"[^>]*title="NPC corporation that owns the LP store; non-highsec risk is flagged\."[^>]*>Corp<\/th>/
  );
  assert.match(
    html,
    /<th[^>]*class="[^"]*\boffer-header\b[^"]*"[^>]*title="LP store offer name\."[^>]*>Offer<\/th>/
  );
});

test("leaderboard table puts offer before corporation so horizontal scroll pins the offer identity", () => {
  const headerRow = htmlBlock(/<thead>[\s\S]*?<tr>[\s\S]*?<\/tr>[\s\S]*?<\/thead>/);
  assert.match(
    headerRow,
    /<th[^>]*class="[^"]*\brank-header\b[^"]*"[^>]*>Rank<\/th>[\s\S]*?<th[^>]*class="[^"]*\boffer-header\b[^"]*"[^>]*>Offer<\/th>[\s\S]*?<th[^>]*class="[^"]*\bcorp-header\b[^"]*"[^>]*>Corp<\/th>[\s\S]*?<th[^>]*data-sort="lp"/
  );

  const rowTemplate = htmlBlock(/<template id="rowTemplate">[\s\S]*?<\/template>/);
  assert.match(
    rowTemplate,
    /<td[^>]*data-cell="rank"[^>]*data-label="Rank"[^>]*><\/td>[\s\S]*?<td[^>]*data-cell="offer"[^>]*data-label="Offer"[^>]*><\/td>[\s\S]*?<td[^>]*data-cell="corp"[^>]*data-label="Corp"[^>]*><\/td>[\s\S]*?<td[^>]*data-cell="lp"/
  );
});

test("leaderboard sorting changes only the active sort key", () => {
  assert.doesNotMatch(html, /id="sortDir"/);
  assert.doesNotMatch(appJs, /sortDir/);
  assert.doesNotMatch(appJs, /aria-sort"[\s\S]*ascending/);
  assert.doesNotMatch(appJs, /===\s*"asc"\s*\?\s*"desc"\s*:\s*"asc"/);
  assert.doesNotMatch(appJs, /sortDefaults/);
});

test("leaderboard keeps rank as a compact static indicator column", () => {
  const rankHeader = headerCell("Rank");

  assert.doesNotMatch(html, /<option value="rank">Rank<\/option>/);
  assert.doesNotMatch(rankHeader, /data-sort="rank"/);
  assert.doesNotMatch(rankHeader, /class="[^"]*\bsort-header\b/);
  assert.doesNotMatch(rankHeader, /sort-indicator/);
  assert.match(
    rankHeader,
    /<th[^>]*class="[^"]*\brank-header\b[^"]*"[^>]*title="Leaderboard position after the active filters and sort\."[^>]*>Rank<\/th>/
  );
});

test("leaderboard table columns expose explanatory hover tooltips", () => {
  const expected = new Map([
    ["lp", "LP required for one run or the feasible run count."],
    ["isk", "ISK required by the LP store before market inputs."],
    ["iskPerLp", "Displayed ISK per LP for the active ranking basis."],
    ["instant", "ISK per LP after selling to buy orders, net of tax."],
    ["patient", "ISK per LP from sell-order listings, net of tax and broker fees."],
    ["roi", "Buy-order profit divided by required capital."],
    ["iskPerHour", "ISK per hour using the active valuation basis and LP/hour input."],
    [
      "volume",
      "28-day average daily Jita market volume for the primary output item."
    ]
  ]);

  for (const [sort, title] of expected) {
    assert.match(sortHeader(sort), new RegExp(`title="${title.replaceAll("/", "\\/")}"`), sort);
  }
  assert.doesNotMatch(html, /<option value="cargo">m3<\/option>/);
  assert.doesNotMatch(html, /<th[^>]*data-sort="cargo"/);
  assert.match(html, /<th[^>]*class="[^"]*\bvolume-header\b[^"]*"[^>]*title="Packaged cargo volume for the products\."[^>]*>m3<\/th>/);
});

test("leaderboard shows sold-per-day market volume instead of volume days", () => {
  assert.match(sortHeader("volume"), />Sold\/day</);
  assert.doesNotMatch(sortHeader("volume"), />Vol days</);
  assert.match(html, /<option value="volume">Sold\/day<\/option>/);
  assert.doesNotMatch(html, /<option value="daysOfSupply">Volume days<\/option>/);
  assert.match(html, /data-cell="supply" data-label="Sold\/day"/);
  assert.match(appJs, /row\.avg_daily_volume_28d/);
  assert.match(appJs, /formatDailyVolume\(row\.avg_daily_volume_28d\)/);
  assert.match(mobileCss, /content:\s*attr\(data-label\)/);
});

test("phone leaderboard cards keep four key metrics and collapse filters by default", () => {
  // card grid: offer + corp header, ISK/LP, ROI, ISK/hr, Sold/day, flags
  assert.match(mobileCss, /grid-template-areas:[\s\S]*"ratio roi"[\s\S]*"rate supply"/);
  // the other numeric columns are desktop-only; without an explicit hide the legacy
  // 1%-width column rule shrinks them to unreadable 12px slivers
  for (const cellName of ["rank", "lp", "isk", "instant", "patient", "cargo"]) {
    assert.match(mobileCss, new RegExp(`\\.data-row td\\[data-cell="${cellName}"\\]`), cellName);
  }
  // the polish layer's 5-column 286px-capped detail animation must not leak into phones
  assert.match(mobileCss, /\.detail-row:not\(\[hidden\]\) \.detail-grid/);
  // phones start with the filter panel collapsed unless the user chose otherwise
  assert.match(appJs, /matchMedia\("\(max-width: 700px\)"\)\.matches/);
  // the collapsed-filters toggle floats bottom-left on phones — fixed at the top
  // it overlaps card titles once the static topbar scrolls away
  assert.match(mobileCss, /\.workstation\.filters-collapsed \.filter-edge-toggle\s*\{[\s\S]*bottom:\s*12px/);
});

test("dense filters and status chips expose explanatory hover tooltips", () => {
  for (const tooltip of [
    "Search item and offer names in the loaded leaderboard.",
    "Type a corporation or faction name, then pick a matching LP store owner.",
    "Hide rows below this 28-day average daily market volume.",
    "Hide rows above this packaged cargo volume.",
    "Runs scales LP, ISK, input, build, and market-depth calculations.",
    "Calculate ISK/hr from the active valuation basis and your LP earning rate.",
    "Require every output, required input, and build material sell price to have its cheapest order in Jita 4-4.",
    "Hide rows with strong warnings or multiple warning flags.",
    "Exclude skins and other vanity offers from the leaderboard.",
    "Hide corporations with no normal level 4 or 5 Security agents.",
    "Include faction warfare LP-store offers.",
    "Market prices: hot every 15 minutes, cold hourly.",
    "Highest buy-order ISK per LP in the loaded rows."
  ]) {
    assert.match(html, new RegExp(`title="${tooltip.replaceAll("/", "\\/")}"`), tooltip);
  }
});

test("volume filter defaults to showing low-volume rows", () => {
  const scopeBlock = htmlBlock(/<section class="filter-group">\s*<label>\s*Search item[\s\S]*?<\/section>/);
  const rankingBlock = htmlBlock(/<section class="filter-group">\s*<h2>Ranking<\/h2>[\s\S]*?<\/section>/);

  assert.doesNotMatch(scopeBlock, /id="minVolume"/);
  assert.match(rankingBlock, /<input id="minVolume" name="minVolume" type="number" min="0" step="10" placeholder="Any"/);
  assert.doesNotMatch(rankingBlock, /id="minVolume"[^>]*value="0"/);
  assert.match(rankingBlock, /class="[^"]*\branking-limits\b/);
  assert.match(rankingBlock, /id="lpPerHour"[\s\S]*id="minVolume"/);
  assert.match(rankingBlock, /<input id="maxM3" name="maxM3" type="number" min="0" step="1" placeholder="Any"/);
  assert.match(rankingBlock, /<input id="lpBudget" name="lpBudget" type="number" min="0" step="1000" placeholder="Any"/);
  assert.match(rankingBlock, /<input id="iskBudget" name="iskBudget" type="number" min="0" step="1000000" placeholder="Any"/);
  assert.match(appJs, /"maxM3"/);
});

test("fees and skills section is a normal filter category with skill inputs paired", () => {
  const block = htmlBlock(/<section class="filter-group fees-skills">\s*<h2>Fees & skills<\/h2>[\s\S]*?<\/section>/);

  assert.doesNotMatch(block, /<details/);
  assert.doesNotMatch(block, /<summary/);
  assert.match(block, /class="[^"]*\bskill-grid\b/);
  assert.match(block, /class="[^"]*\bgrid-two\b[^"]*\bskill-grid\b/);
  assert.match(block, /id="acc"[\s\S]*id="bro"/);
});

test("corp filter is a name autocomplete backed by a hidden corporation id", () => {
  assert.match(html, /<input id="corp" name="corp" type="hidden"/);
  assert.match(html, /<input id="corpSearch"[^>]*type="search"[^>]*list="corpOptions"/);
  assert.match(html, /<datalist id="corpOptions"><\/datalist>/);
  assert.doesNotMatch(html, /<input id="corp" name="corp" type="number"/);
  assert.match(appJs, /loadCorpOptions/);
  assert.match(appJs, /\/api\/corps/);
  assert.match(appJs, /resolveCorpSelection/);
});

// Regression: a type=hidden input's `value` IDL attribute is in "default" mode,
// so setting `.value` also writes the content attribute — making `.value` and
// `.defaultValue` identical. controlDefaultValue() falls back to `.defaultValue`,
// so without an explicit data-default-value the resolved corp id always equals
// its own "default" and buildParams drops it, never sending corp= to the API.
test("corp hidden input declares an explicit empty serialization default", () => {
  assert.match(html, /<input id="corp" name="corp" type="hidden" value="" data-default-value="" \/>/);
  assert.match(appJs, /function controlDefaultValue/);
  assert.match(appJs, /dataset\.defaultValue/);
});

test("every hidden filter control carries an explicit data-default-value", () => {
  // type=hidden mirrors .value into its content attribute; each one used as a
  // URL-backed control must pin its default explicitly or it can never serialize.
  const controlsArrayMatch = appJs.match(/const controls\s*=\s*\[[\s\S]*?\]/);
  assert.ok(controlsArrayMatch, "controls array not found");
  const controlIds = [...controlsArrayMatch[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const id of controlIds) {
    const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`));
    if (!tag || !/type="hidden"/.test(tag[0])) continue;
    assert.match(tag[0], /data-default-value="/, `hidden control ${id} is missing data-default-value`);
  }
});

test("corp autocomplete resolves typed text before URL params are built", () => {
  assert.match(appJs, /function buildParams\(\)\s*\{[\s\S]*resolveCorpSelection\(\)/);
  assert.match(appJs, /function setCorpOptions\(rows\)\s*\{[\s\S]*resolveCorpSelection\(\)[\s\S]*debouncedLoad\(\)/);
});

// Regression: Chrome renders a datalist option's value, but Firefox renders its
// label — setting label to corp_id leaked raw ids into the Firefox dropdown.
// Options must show the name (value + textContent) and never a separate id label.
test("corp datalist options display names cross-browser, not corp ids", () => {
  assert.match(appJs, /option\.value = corpDisplayName\(corp\)/);
  assert.match(appJs, /option\.textContent = corpDisplayName\(corp\)/);
  assert.doesNotMatch(appJs, /option\.label\s*=/);
});

test("truncated corp and offer cells keep full text available as a tooltip", () => {
  assert.match(appJs, /function cellText\(text,\s*title\s*=\s*text\)/);
  assert.match(appJs, /span\.title\s*=\s*title\s*\|\|\s*text/);
  assert.match(appJs, /cells\.corp\.replaceChildren\(cellText\(storeLabel\(row\),\s*storeTitle\(row\)\)\)/);
  assert.match(appJs, /cells\.offer\.replaceChildren\(cellText\(row\.offer_name\)\)/);
});

test("leaderboard can reveal duplicate store rows on demand", () => {
  assert.match(html, /<input id="showDuplicateStores" name="showDuplicateStores" type="checkbox" hidden \/>/);
  assert.match(html, /data-quality-toggle="showDuplicateStores"[^>]*aria-label="Show duplicate stores"/);
  assert.match(appJs, /"showDuplicateStores"/);
  assert.match(appJs, /function storeLabel/);
  assert.match(appJs, /row\.store_count/);
  assert.match(appJs, /function storeTitle/);
});

test("leaderboard table does not spam row-level stale flags", () => {
  assert.doesNotMatch(appJs, /cells\.health/);
  assert.doesNotMatch(appJs, /rowHealthFlag/);
  assert.match(appJs, /renderFlags\(row\.flags,\s*cargoFlag\(row\),\s*vanityFlag\(row\),\s*riskFlag\(row\.access_risk_tier\)\)/);
});

test("leaderboard surfaces non-highsec risk through accessible icon chips", () => {
  assert.match(flagsJs, /function riskFlag/);
  assert.match(flagsJs, /const flagIcons\s*=\s*\{/);
  assert.match(flagsJs, /LOW_VOLUME:\s*"bar-chart"/);
  assert.match(flagsJs, /RISK_LOWSEC:\s*"triangle-alert"/);
  assert.match(flagsJs, /RISK_NULLSEC:\s*"shield-alert"/);
  assert.doesNotMatch(flagsJs, /RISK_WORMHOLE/);
  assert.match(flagsJs, /function iconChip/);
  assert.match(flagsJs, /setAttribute\("aria-label"/);
  assert.doesNotMatch(flagsJs, /HIGHSEC:\s*"H"/);
  assert.doesNotMatch(flagsJs, /LOWSEC:\s*"L"/);
  assert.doesNotMatch(flagsJs, /NULLSEC:\s*"N"/);
  assert.match(flagsJs, /tier\s*===\s*"WORMHOLE"\s*\?\s*"NULLSEC"\s*:\s*tier/);
  assert.match(flagsJs, /if\s*\(tier\s*===\s*"HIGHSEC"\)\s*return null/);
});

test("leaderboard surfaces cargo volume through heavy flag chips", () => {
  assert.match(appJs, /cargoFlag/);
  assert.match(flagsJs, /HEAVY:\s*"package"/);
  assert.match(flagsJs, /VERY_HEAVY:\s*"package"/);
  assert.match(flagsJs, /HEAVY:\s*"Heavy cargo"/);
  assert.match(flagsJs, /VERY_HEAVY:\s*"Very heavy cargo"/);
});

test("filter console exposes reset and space risk ribbon controls", () => {
  assert.match(html, /id="toggleFilters"/);
  assert.match(html, /aria-controls="filtersPanel"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="Collapse filters"/);
  assert.match(appJs, /function setFilterPanelCollapsed/);
  assert.match(appJs, /filters-collapsed/);
  assert.match(appJs, /setAttribute\("aria-label",\s*collapsed \? "Show filters" : "Collapse filters"\)/);
  assert.match(appJs, /localStorage\.setItem\("filtersCollapsed"/);
  assert.match(html, /id="resetFilters"/);
  assert.match(html, /class="[^"]*\bfilters-head\b/);
  assert.match(html, /<span class="field-label"[^>]*>Space<\/span>/);
  assert.match(html, /<input id="maxRiskTier" name="maxRiskTier" type="hidden" value="NULLSEC" data-default-value="NULLSEC" \/>/);
  assert.match(html, /class="[^"]*\brisk-tier-filter\b/);
  assert.match(html, /data-risk-filter="HIGHSEC"[^>]*aria-label="Highsec access"/);
  assert.match(html, /data-risk-filter="NULLSEC"[^>]*aria-label="All access"/);
  assert.doesNotMatch(html, /data-risk-filter="LOWSEC"/);
  assert.doesNotMatch(html, /data-risk-filter="WORMHOLE"/);
  assert.doesNotMatch(html, /aria-label="Highsec and lowsec"/);
  assert.match(html, /class="[^"]*\btier-icon\b/);
  assert.match(appJs, /resetFilters/);
  assert.match(appJs, /syncRiskTierFilter/);
});

test("ranking filters expose a three-way valuation basis control before sort", () => {
  assert.match(html, /<span class="field-label" title="Choose which market exit path drives ISK\/LP, ISK\/hr, and default ranking\.">Valuation<\/span>/);
  assert.match(html, /<input id="basis" name="basis" type="hidden" value="best" data-default-value="best" \/>/);
  assert.match(html, /data-basis-filter="instantSell"[^>]*aria-label="Buy-order valuation"/);
  assert.match(html, /data-basis-filter="patientSell"[^>]*aria-label="Sell-order valuation"/);
  assert.match(html, /data-basis-filter="best"[^>]*aria-label="Highest valuation"/);
  assert.match(html, /data-basis-filter="best"[\s\S]*?<span>Highest<\/span>[\s\S]*?<label>\s*Sort By/);
  assert.match(appJs, /"basis"/);
  assert.match(appJs, /function syncBasisFilter/);
});

test("filter toggle lives beside the filter panel instead of in the topbar", () => {
  const topbarBlock = htmlBlock(/<header class="topbar">[\s\S]*?<\/header>/);
  const workstationOpen = html.match(/<main class="workstation">[\s\S]*?<section class="results"[^>]*>/);
  assert.ok(workstationOpen, "Missing workstation opening block");
  const workstationBlock = workstationOpen[0];

  assert.doesNotMatch(topbarBlock, /id="toggleFilters"/);
  assert.match(workstationBlock, /<div class="filters-anchor">/);
  assert.match(workstationBlock, /<aside id="filtersPanel" class="[^"]*\bfilters\b/);
  assert.match(workstationBlock, /<button id="toggleFilters" class="[^"]*\bfilter-edge-toggle\b/);
  assert.ok(
    workstationBlock.indexOf('id="filtersPanel"') < workstationBlock.indexOf('id="toggleFilters"'),
    "Toggle should follow the filter panel so it can sit on the panel edge"
  );
});

test("filter panel no longer exposes max standing", () => {
  assert.doesNotMatch(html, /id="maxStanding"/);
  assert.doesNotMatch(html, /Max standing/);
  assert.doesNotMatch(appJs, /"maxStanding"/);
});

test("space risk hidden input keeps nullsec as the stable serialization default", () => {
  assert.match(html, /<input id="maxRiskTier" name="maxRiskTier" type="hidden" value="NULLSEC" data-default-value="NULLSEC" \/>/);
  assert.match(appJs, /function controlDefaultValue/);
  assert.match(appJs, /dataset\.defaultValue/);
});

test("space risk ribbon fills the sidebar with visible labels", () => {
  const block = htmlBlock(/<div class="risk-tier-filter"[\s\S]*?<\/div>/);

  for (const label of ["Highsec access", "All access"]) {
    assert.match(block, new RegExp(`aria-label="${label}"`));
  }
  assert.match(block, /data-risk-filter="HIGHSEC"[\s\S]*<span>Highsec<\/span>/);
  assert.match(block, /data-risk-filter="NULLSEC"[\s\S]*<span>All<\/span>/);
  assert.doesNotMatch(block, />\s*Lowsec\s*</);
  assert.doesNotMatch(block, />\s*Nullsec\s*</);
  assert.match(block, /title="Only show highsec-accessible LP stores\."/);
  assert.match(block, /title="Show all LP stores regardless of access risk\."/);
});

test("filter console keeps level 5 missions as a ribbon control", () => {
  assert.match(html, /<span class="field-label"[^>]*>Level 5 Missions<\/span>/);
  assert.match(html, /<input id="level5Missions" name="level5Missions" type="hidden" value="show" data-default-value="show" \/>/);
  assert.match(html, /class="[^"]*\blevel5-missions-filter\b/);
  assert.match(html, /data-level5-filter="only"[^>]*aria-label="Only level 5 mission corporations"/);
  assert.match(html, /data-level5-filter="hide"[^>]*aria-label="Hide level 5 mission corporations"/);
  assert.match(html, /data-level5-filter="show"[^>]*aria-label="Show all corporations regardless of level 5 missions"/);
  assert.match(appJs, /"level5Missions"/);
  assert.match(appJs, /syncLevel5MissionFilter/);
});

test("level 5 missions hidden input keeps show as the stable serialization default", () => {
  assert.match(html, /<input id="level5Missions" name="level5Missions" type="hidden" value="show" data-default-value="show" \/>/);
  assert.match(appJs, /function controlDefaultValue/);
  assert.match(appJs, /dataset\.defaultValue/);
});

test("quality filters are visible labeled buttons backed by hidden checkbox state", () => {
  const block = htmlBlock(/<section class="filter-group quality-filters">[\s\S]*?<\/section>/);

  assert.match(block, /<h2>Quality<\/h2>/);
  assert.doesNotMatch(block, /<details/);
  assert.doesNotMatch(block, /class="[^"]*\bcheck-list\b/);
  assert.match(block, /class="[^"]*\bquality-state-inputs\b/);
  assert.match(block, /class="[^"]*\bquality-toggle-grid\b/);
  assert.match(block, /role="group" aria-label="Quality filters"/);
  for (const id of [
    "jita44Only",
    "hideSuspicious",
    "hideVanity",
    "hideNoSecurity",
    "includeFW",
    "includeSpecial",
    "showDuplicateStores"
  ]) {
    assert.match(block, new RegExp(`<input id="${id}" name="${id}" type="checkbox"[^>]*hidden`), id);
    assert.match(block, new RegExp(`data-quality-toggle="${id}"`), id);
  }
  for (const [id, label] of new Map([
    ["jita44Only", "Jita"],
    ["hideSuspicious", "No warns"],
    ["hideVanity", "No vanity"],
    ["hideNoSecurity", "Sec L4\\+"],
    ["includeFW", "FW"],
    ["includeSpecial", "Special"],
    ["showDuplicateStores", "Dupes"]
  ])) {
    assert.match(block, new RegExp(`data-quality-toggle="${id}"[\\s\\S]*?<span class="quality-label">${label}<\\/span>`), id);
  }
  assert.match(block, /<input id="hideVanity" name="hideVanity" type="checkbox" checked hidden \/>/);
  assert.match(block, /data-quality-toggle="hideVanity"[^>]*aria-label="Hide vanity"[^>]*aria-pressed="true"/);
  assert.match(block, /<input id="hideSuspicious" name="hideSuspicious" type="checkbox" checked hidden \/>/);
  assert.match(block, /data-quality-toggle="hideSuspicious"[^>]*aria-label="Hide suspicious"[^>]*aria-pressed="true"/);
  assert.match(block, /<input id="hideNoSecurity" name="hideNoSecurity" type="checkbox" checked hidden \/>/);
  assert.match(block, /data-quality-toggle="hideNoSecurity"[^>]*aria-label="Hide no Security L4\+"[^>]*aria-pressed="true"/);
  assert.match(appJs, /syncQualityToggleButtons/);
  assert.match(appJs, /data-quality-toggle/);
  assert.match(appJs, /dataset\.qualityToggle/);
});

test("quality filters expose a checked vanity exclusion control", () => {
  assert.match(html, /<input id="hideVanity" name="hideVanity" type="checkbox" checked hidden \/>/);
  assert.match(html, /data-quality-toggle="hideVanity"[^>]*aria-label="Hide vanity"/);
  assert.match(appJs, /"hideVanity"/);
  assert.match(flagsJs, /function vanityFlag/);
  assert.match(flagsJs, /VANITY:\s*"sparkles"/);
});

test("quality filters expose a checked level 4 or 5 Security agent exclusion control", () => {
  assert.match(html, /<input id="hideNoSecurity" name="hideNoSecurity" type="checkbox" checked hidden \/>/);
  assert.match(html, /data-quality-toggle="hideNoSecurity"[^>]*aria-label="Hide no Security L4\+"/);
  assert.match(appJs, /"hideNoSecurity"/);
});

test("quality filters expose a special LP store opt-in control", () => {
  assert.match(html, /<input id="includeSpecial" name="includeSpecial" type="checkbox" hidden \/>/);
  assert.match(html, /data-quality-toggle="includeSpecial"[^>]*aria-label="Include special LP"/);
  assert.match(appJs, /"includeSpecial"/);
});

test("quality filters expose an opt-in Jita-priced rows control", () => {
  assert.match(html, /<input id="jita44Only" name="jita44Only" type="checkbox" hidden \/>/);
  assert.match(html, /data-quality-toggle="jita44Only"[^>]*aria-label="Jita-priced only"/);
});

test("quality filters expose BPC rows as a four-position ribbon control defaulting to none", () => {
  const block = htmlBlock(/<section class="filter-group quality-filters">[\s\S]*?<\/section>/);

  assert.doesNotMatch(html, /includeManufacturedBpc/);
  assert.match(block, /<span class="field-label"[^>]*>BPC<\/span>/);
  assert.match(block, /<input id="bpc" name="bpc" type="hidden" value="none" data-default-value="none" \/>/);
  assert.match(block, /class="[^"]*\bbpc-filter\b/);
  assert.match(block, /role="group" aria-label="Blueprint copy rows"/);
  assert.match(block, /data-bpc-filter="none"[^>]*aria-label="Hide blueprint copy rows"[^>]*aria-pressed="true"/);
  assert.match(block, /data-bpc-filter="sell"[^>]*aria-label="Show blueprint sell rows"[^>]*aria-pressed="false"/);
  assert.match(block, /data-bpc-filter="manufacture"[^>]*aria-label="Show blueprint manufacture rows"[^>]*aria-pressed="false"/);
  assert.match(block, /data-bpc-filter="all"[^>]*aria-label="Show all blueprint rows"[^>]*aria-pressed="false"/);
  assert.match(block, /data-bpc-filter="manufacture"[\s\S]*?<span>Build<\/span>/);
  assert.match(appJs, /"bpc"/);
  assert.match(appJs, /syncBpcFilter/);
  assert.match(appJs, /dataset\.bpcFilter/);
});

test("quality filters no longer expose a level 5 agent checkbox", () => {
  const block = htmlBlock(/<section class="filter-group quality-filters">[\s\S]*?<\/section>/);

  assert.doesNotMatch(block, /id="hasLevel5Agent"/);
  assert.doesNotMatch(block, /Level 5 agents/);
  assert.match(html, /Level 5 Missions/);
});

test("leaderboard shows skeleton rows and reuses session-cached responses while fetching", () => {
  assert.match(appJs, /function renderLoadingRows/);
  assert.match(appJs, /const rowsCachePrefix = "eve-lp-offers:v4-basis:"/);
  assert.match(appJs, /sessionStorage\.getItem/);
  assert.match(appJs, /sessionStorage\.setItem/);
});

test("leaderboard guards offer rows from API with Array.isArray", () => {
  assert.doesNotMatch(appJs, /function normalizeOfferRow/);
  assert.doesNotMatch(appJs, /avg_daily_volume_30d/);
  assert.match(appJs, /avg_daily_volume_28d/);
  assert.match(appJs, /const rows = Array\.isArray\(data\.rows\)\s*\?\s*data\.rows\s*:\s*\[\]/);
  assert.match(appJs, /renderRows\(rows\)/);
  assert.match(appJs, /writeCachedRows\(key,\s*rows\)/);
});

test("leaderboard exposes a refresh state for cached filter changes", () => {
  assert.match(html, /<span id="resultsLoadingState" class="loading-state" hidden>Updating<\/span>/);
  assert.match(htmlBlock(/<header class="topbar">[\s\S]*?<\/header>/), /id="resultsLoadingState"/);
  assert.doesNotMatch(html, /id="refresh"/);
  assert.match(appJs, /function setRowsLoading/);
  assert.match(appJs, /setRowsLoading\(true,\s*\{\s*cached:\s*Boolean\(cachedRows\)\s*\}\)/);
  assert.match(appJs, /results\?\.classList\.toggle\("is-refreshing",\s*loading\)/);
  assert.match(appJs, /tableWrap\?\.setAttribute\("aria-busy",\s*String\(loading\)\)/);
});

test("leaderboard ignores stale filter responses", () => {
  assert.match(appJs, /let rowsRequestSeq\s*=\s*0/);
  assert.match(appJs, /const requestSeq\s*=\s*\+\+rowsRequestSeq/);
  assert.match(appJs, /function isCurrentRowsRequest/);
  assert.match(appJs, /if \(!isCurrentRowsRequest\(requestSeq\)\) return/);
});

test("initial leaderboard loads do not block the browser page load event", () => {
  assert.match(appJs, /void Promise\.allSettled\(/);
  assert.doesNotMatch(appJs, /await Promise\.allSettled\(/);
});

test("space risk buttons start row refresh without debounce", () => {
  assert.match(
    appJs,
    /for \(const button of document\.querySelectorAll\("\[data-risk-filter\]"\)\) \{[\s\S]*syncRiskTierFilter\(\);\s*loadRows\(\)\.catch\(renderLoadError\);/
  );
  assert.doesNotMatch(appJs, /data-risk-filter[\s\S]{0,250}debouncedLoad\(\)/);
});

test("load failure row renders error messages as text content", () => {
  assert.match(appJs, /function renderLoadError/);
  assert.match(appJs, /messageCell\.textContent\s*=/);
  assert.doesNotMatch(appJs, /\$\(?.*rows.*\)?\.innerHTML\s*=\s*`<tr><td colspan="13" class="error">\$\{error\.message\}/);
});

test("leaderboard warns users when the API rate limit is hit", () => {
  assert.match(sharedDiagnosticsJs, /function apiErrorMessage/);
  assert.match(sharedDiagnosticsJs, /error\?\.status\s*===\s*429/);
  assert.match(sharedDiagnosticsJs, /rate-limited/i);
  assert.match(sharedDiagnosticsJs, /Retry-After/);
  assert.doesNotMatch(sharedDiagnosticsJs, /Request ID:/);
  assert.match(diagnosticsJs, /export \* from "\/shared\/diagnostics\.js/);
  assert.match(appJs, /messageCell\.textContent\s*=\s*apiErrorMessage\(error\)/);
});

test("numeric table and metric values expose semantic tone classes", () => {
  for (const tone of ["profit", "success", "info", "cost"]) {
    assert.match(html, new RegExp(`data-value-tone="${tone}"`));
  }
  for (const className of ["value-lp", "value-cost", "value-instant", "value-patient", "value-roi", "value-volume"]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${className}\\b`));
  }
});

test("detail drawer summarizes build sections by visible counts", () => {
  assert.match(detailDrawerJs, /detailSectionTitle/);
  assert.match(detailDrawerJs, /summary\.buildMaterials\.total/);
  assert.match(detailDrawerJs, /summary\.buildMaterials\.names/);
  assert.match(detailDrawerJs, /summary\.buildMaterials\.totalCost/);
  assert.doesNotMatch(detailDrawerJs, /summary\.buildMaterials,[\s\S]*showRemaining:\s*false/);
});

test("diagnostics exports escapeHtml that escapes HTML special characters", () => {
  // escapeHtml is defined once in /shared/utils.js and re-exported from lp/diagnostics.js
  // so the lp modules keep importing it from ./diagnostics.js unchanged.
  assert.match(diagnosticsJs, /export \{[^}]*escapeHtml[^}]*\} from "\/shared\/utils\.js"/);
  assert.match(sharedUtilsJs, /export function escapeHtml/);
  assert.match(sharedUtilsJs, /replaceAll\("&",\s*"&amp;"\)/);
  assert.match(sharedUtilsJs, /replaceAll\("<",\s*"&lt;"\)/);
  assert.match(sharedUtilsJs, /replaceAll\(">",\s*"&gt;"\)/);
});

test("detail-drawer.js imports and uses escapeHtml for SDE item names and store names in innerHTML", () => {
  assert.match(detailDrawerJs, /import \{[^}]*escapeHtml[^}]*\} from "\.\/diagnostics\.js"/);
  assert.match(detailDrawerJs, /escapeHtml\(item\.name\)/);
  assert.match(detailDrawerJs, /escapeHtml\(summary\.store\.corpName\)/);
  assert.match(detailDrawerJs, /escapeHtml\(summary\.store\.station\)/);
  assert.match(detailDrawerJs, /escapeHtml\(summary\.store\.system\)/);
});

test("corpSearch fires only a single debounced load path, not doubled via controls loop", () => {
  const controlsArrayMatch = appJs.match(/const controls\s*=\s*\[[\s\S]*?\]/);
  assert.ok(controlsArrayMatch, "controls array not found");
  assert.doesNotMatch(controlsArrayMatch[0], /"corpSearch"/);
  assert.match(appJs, /\$\("corpSearch"\)\?\.addEventListener\("input"/);
  assert.match(appJs, /\$\("corpSearch"\)\?\.addEventListener\("change"/);
});

test("flag chips expand on tap into their label with a methodology link", () => {
  assert.match(flagsJs, /span\.setAttribute\("role", "button"\)/);
  assert.match(flagsJs, /text\.className = "flag-label"/);
  assert.match(flagsJs, /link\.className = "flag-doc-link"/);
  assert.match(flagsJs, /\/lp\/about\.html#quality-flags/);
  assert.match(flagsJs, /\/lp\/about\.html#risk-and-access/);
  assert.match(flagsJs, /span\.classList\.toggle\("open"\)/);
  assert.match(flagsJs, /span\.setAttribute\("aria-expanded", String\(open\)\)/);
});

test("methodology page exposes a TOC and section anchors for deep links", () => {
  assert.match(aboutHtml, /<nav class="methodology-toc"/);
  for (const id of [
    "what-this-tool-ranks",
    "data-sources",
    "refresh-cadence",
    "core-calculation",
    "fees-and-skills",
    "depth-walking",
    "patient-fill-realism",
    "bpc-manufacturing",
    "risk-and-access",
    "quality-flags",
    "search-and-grouping",
    "frontend-diagnostics",
    "api-and-health",
    "known-limitations"
  ]) {
    assert.match(aboutHtml, new RegExp(`<h2 id="${id}"`), `missing section anchor #${id}`);
    assert.match(aboutHtml, new RegExp(`<a href="#${id}"`), `missing TOC link to #${id}`);
  }
});

test("realistic patient toggle and Advanced Broker Relations filter are URL-backed", () => {
  assert.match(html, /<input id="realisticPatient" name="realisticPatient" type="checkbox" hidden \/>/);
  assert.match(html, /data-quality-toggle="realisticPatient"/);
  assert.match(html, /<input id="advBro" name="advBro" type="number" min="0" max="5"/);
  const controlsArrayMatch = appJs.match(/const controls\s*=\s*\[[\s\S]*?\]/);
  assert.ok(controlsArrayMatch, "controls array not found");
  assert.match(controlsArrayMatch[0], /"realisticPatient"/);
  assert.match(controlsArrayMatch[0], /"advBro"/);
});

test("detail drawer surfaces the estimated patient fill", () => {
  assert.match(detailDrawerJs, /function fillEstimateText\(row\)/);
  assert.match(detailDrawerJs, /Est\. patient fill/);
  assert.match(detailDrawerJs, /fillEstimate\.className = "fill-estimate"/);
  assert.match(detailDrawerJs, /row\?\.days_to_fill/);
  assert.match(detailDrawerJs, /row\?\.fill_queue_ahead/);
});

test("ISK/hour column blanks contract-priced rows with an explanatory tooltip", () => {
  assert.match(appJs, /row\.contract_priced/);
  assert.match(appJs, /no sustainable hourly rate exists/i);
});

test("flag codes stay in sync across calc, frontend labels, and methodology", () => {
  const calcFlags = fs.readFileSync(path.resolve("server/src/calc/flags.ts"), "utf8");
  const calcCodes = [...new Set([...calcFlags.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]))];
  assert.ok(calcCodes.length >= 7, "expected at least the seven market-quality flag codes in flags.ts");

  const namesBlock = flagsJs.match(/const flagNames = \{([\s\S]*?)\};/)?.[1] ?? "";
  const iconsBlock = flagsJs.match(/const flagIcons = \{([\s\S]*?)\};/)?.[1] ?? "";
  const frontendCodes = [...namesBlock.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(frontendCodes.length >= calcCodes.length, "flags.js flagNames block not found or too small");

  for (const code of calcCodes) {
    assert.ok(frontendCodes.includes(code), `${code} from flags.ts is missing in flags.js flagNames`);
  }
  for (const code of frontendCodes) {
    assert.match(iconsBlock, new RegExp(`\\b${code}:`), `${code} has no icon in flags.js flagIcons`);
    assert.ok(aboutHtml.includes(`<code>${code}</code>`), `${code} is not documented on the methodology page`);
  }
});
