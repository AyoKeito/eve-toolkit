import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const theme = fs.readFileSync(path.resolve("web/lp/theme.css"), "utf8");
const style = fs.readFileSync(path.resolve("web/lp/style.css"), "utf8");
const mobile = fs.readFileSync(path.resolve("web/lp/mobile.css"), "utf8");
const polish = fs.readFileSync(path.resolve("web/lp/polish.css"), "utf8");
const base = fs.readFileSync(path.resolve("web/shared/base.css"), "utf8");
const aboutHtml = fs.readFileSync(path.resolve("web/lp/about.html"), "utf8");
const interFontPath = path.resolve("web/lp/assets/fonts/inter-var.woff2");

function columnWidth(column: number): number {
  const match = style.match(
    new RegExp(`th:nth-child\\(${column}\\),\\s*td:nth-child\\(${column}\\)\\s*\\{[\\s\\S]*?width:\\s*(\\d+)px`)
  );
  assert.ok(match, `Missing width for table column ${column}`);
  return Number(match[1]);
}

test("theme exposes workstation design tokens", () => {
  for (const token of ["--profit", "--success", "--warning", "--danger", "--panel-3"]) {
    assert.match(theme, new RegExp(token.replace("-", "\\-")));
  }
  assert.doesNotMatch(theme, /--glow\s*:/);
  assert.doesNotMatch(theme, /--purple\s*:/);
  assert.doesNotMatch(theme, /:root\[data-theme="light"\]/);
  assert.doesNotMatch(theme, /color-scheme:\s*light/);
});

test("desktop CSS self-hosts Inter as the LP UI font", () => {
  assert.ok(fs.existsSync(interFontPath), "Missing self-hosted Inter font asset");
  const fontSize = fs.statSync(interFontPath).size;
  assert.ok(fontSize > 40_000, "Inter subset font asset looks truncated");
  assert.ok(fontSize < 120_000, "Inter font asset should be a Latin subset");
  // The @font-face for Inter + the metric-matched fallback live in the shared base.css (used by
  // lp via the lp.css bundle, and by missions/agents directly), so all three apps share one
  // Inter definition. The lp body font stack still lives in style.css.
  assert.match(base, /@font-face\s*\{[\s\S]*font-family:\s*"Inter"/);
  assert.match(base, /@font-face\s*\{[\s\S]*src:\s*url\("\/lp\/assets\/fonts\/inter-var\.woff2"\)\s+format\("woff2"\)/);
  assert.match(base, /@font-face\s*\{[\s\S]*font-display:\s*swap/);
  assert.match(base, /@font-face\s*\{[\s\S]*font-family:\s*"Inter Fallback"[\s\S]*size-adjust:\s*107\.12%/);
  assert.match(style, /font:\s*13px\/1\.45\s+"Inter",\s*"Inter Fallback",\s*system-ui/);
});

test("desktop CSS defines the two-zone workstation shell", () => {
  assert.match(style, /\.workstation\s*\{/);
  assert.match(style, /grid-template-columns:\s*minmax\(240px,\s*280px\)\s+minmax\(0,\s*1fr\)/);
  assert.match(style, /\.workstation\.filters-collapsed\s*\{/);
  assert.match(style, /\.workstation\.filters-collapsed\s+\.filters\s*\{/);
  assert.match(style, /\.filters-anchor\s*\{/);
  assert.match(style, /\.filter-edge-toggle\s*\{/);
  assert.doesNotMatch(style, /\.intelligence-rail\s*\{/);
  assert.match(style, /\.staleness-chips\s*\{/);
  assert.match(style, /\.metric-strip\s*\{/);
});

test("desktop CSS overlays the filter toggle without reserving table width", () => {
  assert.match(style, /\.filters-anchor\s*\{[\s\S]*position:\s*sticky[\s\S]*top:\s*78px/);
  assert.match(style, /\.filter-edge-toggle\s*\{[\s\S]*position:\s*absolute[\s\S]*right:\s*-16px/);
  assert.match(style, /\.filter-edge-toggle\s*\{[\s\S]*z-index:\s*6/);
  assert.match(style, /\.workstation\.filters-collapsed\s+\.filters-anchor\s*\{[\s\S]*display:\s*contents/);
  assert.match(style, /\.workstation\.filters-collapsed\s+\.filter-edge-toggle\s*\{[\s\S]*position:\s*fixed[\s\S]*left:\s*0/);
  assert.doesNotMatch(style, /\.workstation\.filters-collapsed\s*\{[\s\S]*grid-template-columns:\s*minmax\([^)]*34px/);
  assert.match(mobile, /\.filter-edge-toggle\s*\{[\s\S]*position:\s*static/);
});

test("desktop CSS avoids resize-expensive backdrop filters on sticky chrome", () => {
  assert.doesNotMatch(style, /backdrop-filter/);
  assert.match(style, /\.topbar\s*\{[\s\S]*background:\s*var\(--bg-elevated\)/);
});

test("desktop CSS keeps the full filter sidebar compact for 1080px tall viewports", () => {
  assert.match(style, /\.filters\s*\{[\s\S]*max-height:\s*calc\(100vh - 82px\)/);
  assert.match(style, /\.filters\s*\{[\s\S]*gap:\s*8px[\s\S]*padding:\s*10px/);
  assert.match(style, /\.filter-group\s*\{[\s\S]*gap:\s*7px/);
  assert.match(style, /\.filter-group\s+\+\s+\.filter-group\s*\{[\s\S]*padding-top:\s*8px/);
  assert.match(style, /button,\s*\.button,\s*input,\s*select\s*\{[\s\S]*min-height:\s*30px/);
  assert.match(style, /label\s*\{[\s\S]*gap:\s*4px/);
  assert.doesNotMatch(style, /(^|\n)summary\s*\{/);
});

test("desktop CSS fits the concept metric strip and compact detail drawer above the fold", () => {
  assert.match(style, /\.metric-strip\s*\{[\s\S]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(style, /:root\s*\{[\s\S]*--detail-cols:\s*1\.25fr\s+1fr\s+1fr\s+1\.45fr\s+1fr/);
  assert.match(style, /\.detail-grid\s*\{[\s\S]*grid-template-columns:\s*var\(--detail-cols\)/);
  assert.match(style, /\.detail-grid\s*\{[\s\S]*max-height:\s*286px/);
  assert.doesNotMatch(style, /\.terminal-controls\s*\{/);
  assert.doesNotMatch(style, /\.terminal-icon\s*\{/);
  assert.doesNotMatch(style, /\.menu-icon\s*\{/);
  assert.doesNotMatch(style, /\.grid-icon\s*\{/);
  assert.doesNotMatch(style, /\.health-cell\s*\{/);
  assert.doesNotMatch(style, /\.movers-panel\s*\{/);
  assert.doesNotMatch(style, /\.collapsible-movers/);
  assert.doesNotMatch(style, /\.mover-tabs\s*\{/);
  assert.doesNotMatch(style, /--space-lowsec\s*:/);
  assert.doesNotMatch(style, /\.check-list\s*\{/);
  assert.doesNotMatch(style, /#statusLine\.ok::before\s*\{/);
});

test("desktop CSS lets LP-store details and material summaries wrap cleanly", () => {
  assert.match(style, /\.mini-dl div\s*\{[\s\S]*grid-template-columns:\s*70px\s+minmax\(0,\s*1fr\)/);
  assert.match(style, /\.material-summary\s*\{[\s\S]*white-space:\s*normal/);
  assert.match(style, /\.material-summary-cost\s*\{[\s\S]*color:\s*var\(--warning\)/);
});

test("desktop CSS gives detail section count labels right-side breathing room", () => {
  assert.match(style, /h3 span\s*\{[\s\S]*padding-inline:\s*1px\s+4px/);
  assert.match(style, /h3 span\s*\{[\s\S]*box-sizing:\s*border-box/);
});

test("desktop CSS removes the risk column and keeps flags readable", () => {
  assert.match(style, /table\s*\{[\s\S]*table-layout:\s*auto/);
  assert.match(style, /table\s*\{[\s\S]*width:\s*max-content[\s\S]*min-width:\s*100%/);
  assert.doesNotMatch(style, /table\s*\{[\s\S]*min-width:\s*1546px/);
  assert.equal(columnWidth(13), 164);
  assert.doesNotMatch(style, /\.risk-cell\s*\{/);
  assert.doesNotMatch(style, /th:nth-child\(14\),\s*td:nth-child\(14\)/);
});

test("desktop CSS provides pinned horizontal scroll and sticky row identity columns", () => {
  assert.match(style, /th,\s*td\s*\{[\s\S]*padding:\s*6px\s+10px/);
  assert.match(style, /th:nth-child\(1\),\s*td:nth-child\(1\)\s*\{[\s\S]*position:\s*sticky[\s\S]*left:\s*0/);
  assert.match(style, /th:nth-child\(1\),\s*td:nth-child\(1\)\s*\{[\s\S]*padding-inline:\s*4px/);
  assert.match(style, /th:nth-child\(2\),\s*td:nth-child\(2\)\s*\{[\s\S]*position:\s*sticky[\s\S]*left:\s*44px/);
  assert.match(style, /thead th:nth-child\(1\),\s*thead th:nth-child\(2\)\s*\{[\s\S]*z-index:\s*4/);
  assert.match(style, /td:nth-child\(2\)::before,\s*th:nth-child\(2\)::before\s*\{[\s\S]*linear-gradient\(90deg,\s*rgba\(0,\s*0,\s*0,\s*0\.25\),\s*transparent\)/);
  assert.match(
    style,
    /\.table-wrap\.is-scrolled\s+td:nth-child\(2\)::before,\s*\.table-wrap\.is-scrolled\s+th:nth-child\(2\)::before\s*\{[\s\S]*opacity:\s*1/
  );
  assert.match(
    style,
    /\.data-row:hover\s+td:nth-child\(1\),\s*\.data-row:hover\s+td:nth-child\(2\),\s*\.data-row\.expanded\s+td:nth-child\(1\),\s*\.data-row\.expanded\s+td:nth-child\(2\)\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--profit\)\s+12%,\s*var\(--panel-2\)\)/
  );
  assert.match(style, /\.floating-hscroll\s*\{[\s\S]*position:\s*fixed[\s\S]*bottom:\s*0[\s\S]*overflow-x:\s*auto[\s\S]*display:\s*none/);
  assert.match(style, /\.floating-hscroll\.is-active\s*\{[\s\S]*display:\s*block/);
  assert.match(style, /\.floating-hscroll-inner\s*\{[\s\S]*height:\s*1px/);
});

test("desktop CSS provides a fixed floating table header for long vertical scrolls", () => {
  assert.match(style, /\.floating-table-header\s*\{[\s\S]*position:\s*fixed[\s\S]*overflow:\s*hidden[\s\S]*z-index:\s*45[\s\S]*display:\s*none/);
  assert.match(style, /\.floating-table-header\.is-active\s*\{[\s\S]*display:\s*block/);
  assert.match(style, /\.floating-table-header\s+table\s*\{[\s\S]*table-layout:\s*auto[\s\S]*width:\s*max-content[\s\S]*min-width:\s*100%/);
  assert.match(style, /\.floating-table-header\s+th\s*\{[\s\S]*top:\s*0[\s\S]*box-shadow:\s*0\s+1px\s+0\s+var\(--line\)/);
  assert.match(style, /\.floating-table-header\s+th:nth-child\(1\),\s*\.floating-table-header\s+th:nth-child\(2\)\s*\{[\s\S]*position:\s*sticky/);
});

test("about page methodology table is not styled like the fixed leaderboard table", () => {
  assert.match(aboutHtml, /<table class="methodology-table">/);
  assert.match(aboutHtml, /<td data-label="Flag">[^<]*<span class="chip flag warn"[\s\S]*?<code>LOW_VOLUME<\/code><\/td>/);
  assert.match(aboutHtml, /<td data-label="Rule">28-day average daily volume is below 100 units and below 250m ISK[^<]*<\/td>/);
  assert.match(aboutHtml, /<td data-label="Severity">Warn; shown as a yellow flag\.<\/td>/);
  assert.match(aboutHtml, /<span class="chip flag warn"[\s\S]*?<code>HEAVY<\/code><\/td>/);
  assert.match(aboutHtml, /<td data-label="Rule">Packaged cargo volume is above 100 m3 and at or below 500 m3\.<\/td>/);
  assert.match(aboutHtml, /<span class="chip flag strong"[\s\S]*?<code>VERY_HEAVY<\/code><\/td>/);
  assert.match(aboutHtml, /<td data-label="Rule">Packaged cargo volume is above 500 m3\.<\/td>/);
  // the base leaderboard table is width: max-content — the methodology table must pin to its column
  assert.match(style, /\.methodology-table\s*\{[\s\S]*table-layout:\s*auto[\s\S]*width:\s*100%[\s\S]*min-width:\s*0/);
  assert.match(style, /\.methodology-table\s+th,\s*\.methodology-table\s+td\s*\{[\s\S]*white-space:\s*normal/);
  assert.match(style, /@media\s*\(max-width:\s*700px\)\s*\{[\s\S]*\.methodology-table\s+thead\s*\{[\s\S]*display:\s*none/);
  assert.match(style, /\.methodology-table\s+td::before\s*\{[\s\S]*content:\s*attr\(data-label\)/);
  // formula <pre> blocks are wider than a phone viewport — they scroll instead of bleeding
  assert.match(style, /pre\s*\{[\s\S]*overflow-x:\s*auto/);
});

test("flag chips expand to show labels and the methodology grows a TOC", () => {
  assert.match(style, /\.chip\.flag\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(style, /\.chip\.flag \.flag-label\s*\{\s*display:\s*none;\s*\}/);
  assert.match(style, /\.chip\.flag\.open \.flag-label\s*\{[\s\S]*?display:\s*inline[\s\S]*?white-space:\s*normal/);
  assert.match(style, /\.flag-doc-link\s*\{/);
  assert.match(style, /\.methodology-toc\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  // anchor jumps must not bury the heading under the sticky desktop topbar
  assert.match(style, /\.summary-strip h2\[id\]\s*\{[\s\S]*?scroll-margin-top/);
});

test("detail drawer styles the estimated patient fill line", () => {
  assert.match(style, /\.fill-estimate\s*\{[\s\S]*?color:\s*var\(--muted\)/);
});

test("about page documents current leaderboard defaults and freshness chips", () => {
  assert.match(aboutHtml, /all access-risk tiers/i);
  assert.match(aboutHtml, /Level 5 mission corporations are shown by default/i);
  assert.match(aboutHtml, /hot market prices every 15 minutes/i);
  assert.match(aboutHtml, /persistent browser client ID/i);
  assert.doesNotMatch(aboutHtml, /highsec stores only/i);
});

test("desktop CSS sizes numeric leaderboard columns by intrinsic content", () => {
  assert.equal(columnWidth(1), 44);
  assert.equal(columnWidth(2), 300);
  assert.equal(columnWidth(3), 220);
  assert.equal(columnWidth(13), 164);
  assert.match(
    style,
    /th:nth-child\(n \+ 4\):nth-child\(-n \+ 12\),\s*td:nth-child\(n \+ 4\):nth-child\(-n \+ 12\)\s*\{[\s\S]*width:\s*1%[\s\S]*white-space:\s*nowrap/
  );

  for (let column = 4; column <= 12; column += 1) {
    assert.doesNotMatch(
      style,
      new RegExp(`th:nth-child\\(${column}\\),\\s*td:nth-child\\(${column}\\)\\s*\\{[\\s\\S]*?width:\\s*\\d+px`),
      `Column ${column} should not reserve a fixed pixel width`
    );
  }
});

test("desktop CSS keeps compact numeric columns from wrapping", () => {
  assert.match(
    style,
    /th:nth-child\(n \+ 4\):nth-child\(-n \+ 12\),\s*td:nth-child\(n \+ 4\):nth-child\(-n \+ 12\)\s*\{[\s\S]*padding-inline:\s*6px[\s\S]*text-align:\s*right[\s\S]*white-space:\s*nowrap/
  );
  assert.doesNotMatch(style, /th:nth-child\(12\),\s*td:nth-child\(12\)\s*\{[\s\S]*width:\s*96px/);
});

test("desktop CSS gives corp more room without increasing row height", () => {
  assert.match(
    style,
    /td:nth-child\(2\)\s*\{[\s\S]*white-space:\s*normal[\s\S]*word-break:\s*break-word/
  );
  assert.match(
    style,
    /td:nth-child\(2\)\s+\.cell-text\s*\{[\s\S]*display:\s*-webkit-box[\s\S]*-webkit-line-clamp:\s*2[\s\S]*-webkit-box-orient:\s*vertical/
  );
  assert.match(style, /td:nth-child\(3\)\s*\{[\s\S]*white-space:\s*nowrap[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(style, /td:nth-child\(3\)\s+\.cell-text\s*\{[\s\S]*display:\s*block[\s\S]*overflow:\s*hidden[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(style, /th:nth-child\(2\)\s+\.sort-header,\s*th:nth-child\(3\)\s+\.sort-header\s*\{[\s\S]*justify-content:\s*flex-start/);
});

test("desktop CSS keeps corp and offer cells in the table layout", () => {
  assert.doesNotMatch(style, /td:nth-child\(2\),\s*td:nth-child\(3\)\s*\{[^}]*display:\s*-webkit-box/);
});

test("polish affordance follows the pinned offer column", () => {
  assert.match(polish, /\.data-row:hover\s+td:nth-child\(2\)::after\s*\{[\s\S]*opacity:\s*0\.6/);
  assert.match(polish, /\.data-row\.expanded\s+td:nth-child\(2\)::after\s*\{[\s\S]*transform:\s*rotate\(45deg\)/);
  assert.doesNotMatch(polish, /\.data-row\s+td:nth-child\(2\)\s*\{[\s\S]*position:/);
  assert.doesNotMatch(polish, /\.data-row\s+td:nth-child\(3\)::after/);
});

test("polish layer does not run paint-heavy ambient animations during resize", () => {
  assert.doesNotMatch(polish, /@keyframes\s+lp-pulse/);
  assert.doesNotMatch(polish, /#statusLine::before\s*\{[\s\S]*animation:/);
  assert.doesNotMatch(polish, /box-shadow:[\s\S]*@keyframes/);
});

test("desktop CSS applies concept numeric color tones", () => {
  for (const selector of [".value-isk-lp", ".value-instant", ".value-patient", ".value-roi", ".value-cost", ".value-lp", ".value-volume"]) {
    assert.match(style, new RegExp(selector.replace(".", "\\.") + "\\s*\\{[\\s\\S]*color:"));
  }
  assert.match(style, /\.metric-card\[data-value-tone="profit"\]\s+strong\s*\{/);
  assert.match(style, /\.metric-card\[data-value-tone="cost"\]\s+strong\s*\{/);
});

test("desktop CSS exposes space risk, valuation, level 5 missions, and BPC as segmented ribbon filters", () => {
  assert.match(style, /\.risk-tier-filter\s*\{/);
  assert.match(style, /\.risk-tier-filter,\s*\.level5-missions-filter,\s*\.basis-filter,\s*\.bpc-filter\s*\{[\s\S]*width:\s*100%/);
  assert.match(style, /\.risk-tier-filter\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(style, /\.risk-tier-filter\s*\{[^}]*width:\s*max-content/);
  assert.doesNotMatch(style, /\.risk-tier-filter\s+button\s*\{[^}]*width:\s*31px/);
  assert.doesNotMatch(style, /\.risk-tier-filter\s+button\s*\{[^}]*gap:\s*0[^}]*padding:\s*0/);
  assert.match(style, /\.level5-missions-filter,\s*\.basis-filter\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  // four-position BPC ribbon: 4 columns with tighter icons so labels fit the sidebar
  assert.match(style, /\.bpc-filter\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(style, /\.bpc-filter\s+\.tier-icon\s*\{[\s\S]*width:\s*13px/);
  assert.match(
    style,
    /\.risk-tier-filter\s+button\[aria-pressed="true"\],\s*\.level5-missions-filter\s+button\[aria-pressed="true"\],\s*\.basis-filter\s+button\[aria-pressed="true"\],\s*\.bpc-filter\s+button\[aria-pressed="true"\]\s*\{/
  );
  assert.match(style, /\.tier-icon\s*\{[\s\S]*width:\s*16px[\s\S]*height:\s*16px/);
});

test("desktop CSS colors space risk icons by space tier", () => {
  assert.match(style, /--space-highsec:\s*#3b82f6/);
  assert.match(style, /--space-nullsec:\s*#ef4444/);
  assert.doesNotMatch(style, /--space-lowsec\s*:/);
  assert.match(style, /\.risk-tier-filter button\[data-risk-filter="HIGHSEC"\]\s*\{[\s\S]*--tier-color:\s*var\(--space-highsec\)/);
  assert.match(style, /\.risk-tier-filter button\[data-risk-filter="NULLSEC"\]\s*\{[\s\S]*--tier-color:\s*var\(--space-nullsec\)/);
  assert.doesNotMatch(style, /data-risk-filter="LOWSEC"/);
  assert.doesNotMatch(style, /data-risk-filter="WORMHOLE"/);
  assert.match(style, /\.risk-tier-filter\s+\.tier-icon\s*\{[\s\S]*color:\s*var\(--tier-color\)/);
});

test("desktop CSS keeps paired ranking numeric filters equal width", () => {
  assert.match(style, /\.ranking-limits\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(style, /\.ranking-limits\s+input\s*\{[\s\S]*padding:\s*0\s+6px/);
  assert.match(mobile, /\.ranking-limits\s*\{[\s\S]*grid-template-columns:\s*1fr\s+1fr/);
});

test("desktop CSS keeps the three skill inputs on one row, two on mobile", () => {
  assert.match(style, /\.skill-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobile, /\.skill-grid\s*\{[\s\S]*grid-template-columns:\s*1fr\s+1fr/);
});

test("desktop CSS exposes visible quality filters as compact labeled buttons", () => {
  assert.match(style, /\.quality-toggle-grid\s*\{/);
  // eight toggles fit two even rows of four
  assert.match(style, /\.quality-toggle-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(style, /\.quality-state-inputs\s*\{[\s\S]*display:\s*none/);
  assert.match(style, /\.quality-toggle-grid\s+button\s*\{[\s\S]*min-height:\s*38px[\s\S]*padding:\s*2px\s+1px/);
  assert.match(style, /\.quality-toggle-grid\s+button\[aria-pressed="true"\]\s*\{/);
  assert.match(style, /\.quality-label\s*\{[\s\S]*overflow:\s*hidden[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(style, /\.quality-icon\s*\{[\s\S]*width:\s*14px[\s\S]*height:\s*14px/);
});

test("mobile CSS stacks the workstation without a movers block", () => {
  assert.match(mobile, /@media\s*\(max-width:\s*900px\)/);
  assert.match(mobile, /\.workstation\s*\{/);
  assert.doesNotMatch(mobile, /\.movers-panel\s*\{/);
  assert.doesNotMatch(mobile, /\.movers-list\s*\{/);
  assert.doesNotMatch(mobile, /\.collapsible-movers/);
});

test("flag chips wrap in dense leaderboard rows instead of clipping", () => {
  assert.match(style, /\.flag-wrap\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(style, /\.flag-wrap\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(style, /\.flag-wrap\s+\.chip\s*\{[\s\S]*flex:\s*0 0 auto/);
  assert.match(style, /\.chip-icon\s*\{[\s\S]*width:\s*14px[\s\S]*height:\s*14px/);
  assert.match(style, /\.chip\.flag\s*\{[\s\S]*width:\s*28px[\s\S]*justify-content:\s*center/);
});

test("desktop CSS includes non-shifting skeleton rows for loading state", () => {
  assert.match(style, /\.skeleton-row\s+td\s*\{/);
  assert.match(style, /\.skeleton-bar\s*\{/);
  assert.equal(columnWidth(13), 164);
});

test("desktop CSS keeps cached rows visible while marking refresh state", () => {
  assert.match(style, /\.loading-state\s*\{/);
  assert.match(style, /\.loading-state\[hidden\]\s*\{[\s\S]*display:\s*none/);
  assert.match(style, /\.results\.is-refreshing\s+\.table-wrap::after\s*\{/);
  assert.match(style, /\.results\.is-refreshing\s+tbody\s+\.data-row\s*\{/);
  assert.match(style, /animation:\s*loadingPulse/);
});

test("mobile cards override desktop table column widths and expose flags", () => {
  // the card cell rule needs :nth-child(n) to tie the desktop 1%-width column rule's
  // specificity (td:nth-child(n+4):nth-child(-n+12)) — a bare .data-row td loses and
  // the numeric cells collapse to 12px slivers
  assert.match(mobile, /\.data-row td:nth-child\(n\)\s*\{[\s\S]*width:\s*auto/);
  assert.match(mobile, /tbody \.data-row\s*\{[\s\S]*display:\s*grid/);
  assert.match(mobile, /\.floating-hscroll\s*\{[\s\S]*display:\s*none\s*!important/);
  assert.match(mobile, /\.floating-table-header\s*\{[\s\S]*display:\s*none\s*!important/);
  assert.match(mobile, /th:nth-child\(1\),\s*td:nth-child\(1\),\s*th:nth-child\(2\),\s*td:nth-child\(2\)\s*\{[\s\S]*position:\s*static[\s\S]*left:\s*auto/);
  assert.match(mobile, /\.flag-wrap\s*\{[\s\S]*flex-wrap:\s*wrap/);
});
