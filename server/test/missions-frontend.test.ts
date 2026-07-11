import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const indexHtml = fs.readFileSync(path.resolve("web/missions/index.html"), "utf8");
const indexJs = fs.readFileSync(path.resolve("web/missions/app.js"), "utf8");
const browseHtml = fs.readFileSync(path.resolve("web/missions/browse.html"), "utf8");
const browseJs = fs.readFileSync(path.resolve("web/missions/browse.js"), "utf8");
const detailHtml = fs.existsSync(path.resolve("web/missions/detail.html"))
  ? fs.readFileSync(path.resolve("web/missions/detail.html"), "utf8")
  : "";
const detailJs = fs.existsSync(path.resolve("web/missions/detail.js"))
  ? fs.readFileSync(path.resolve("web/missions/detail.js"), "utf8")
  : "";
const detailCss = fs.existsSync(path.resolve("web/missions/detail.css"))
  ? fs.readFileSync(path.resolve("web/missions/detail.css"), "utf8")
  : "";
const arcHtml = fs.existsSync(path.resolve("web/missions/arc.html"))
  ? fs.readFileSync(path.resolve("web/missions/arc.html"), "utf8")
  : "";
const arcJs = fs.existsSync(path.resolve("web/missions/arc.js"))
  ? fs.readFileSync(path.resolve("web/missions/arc.js"), "utf8")
  : "";
const diagnosticsJs = fs.readFileSync(path.resolve("web/missions/diagnostics.js"), "utf8");
const sharedDiagnosticsJs = fs.readFileSync(path.resolve("web/shared/diagnostics.js"), "utf8");
const css = fs.readFileSync(path.resolve("web/missions/style.css"), "utf8");
const domUtilJs = fs.readFileSync(path.resolve("web/missions/dom-util.js"), "utf8");
const arcMetaJs = fs.readFileSync(path.resolve("web/missions/arc-meta.js"), "utf8");
const combatStatsJs = fs.existsSync(path.resolve("web/missions/combat-stats.js"))
  ? fs.readFileSync(path.resolve("web/missions/combat-stats.js"), "utf8")
  : "";

interface ArcMissionFixture {
  mission_id: number;
  name: string;
  arc_position: number | null;
  peak_dps?: number | null;
  ewar_types?: string[];
  mission_type?: string;
  faction?: string | null;
  space_risk?: string | null;
  level?: number | null;
}

interface ArcOrderModule {
  arcMissionPositionLabels: (missions: ArcMissionFixture[]) => Map<number, string>;
  orderedArcMissions: (missions: ArcMissionFixture[]) => ArcMissionFixture[];
}

interface ArcEdgeFixture {
  from: number;
  to: number;
  label?: string | null;
}

interface ArcGraphModule {
  arcGraphSteps: (missions: ArcMissionFixture[]) => Array<{ label: string; missions: ArcMissionFixture[] }>;
  missionMeta: (arc: { level?: number | null } | null, mission: ArcMissionFixture) => string;
  dagLayout: (
    missions: ArcMissionFixture[],
    edges: ArcEdgeFixture[]
  ) => { layers: Array<{ depth: number; missionIds: number[] }>; colors: Array<[string, string]> };
}

test("missions index exposes a canonical URL and search result description", () => {
  assert.match(indexHtml, /<meta name="description" content="EVE Online mission guides: every epic arc with branch diagrams, factions, damage profiles, rewards, and per-mission combat intel\." \/>/);
  assert.match(indexHtml, /<link rel="canonical" href="https:\/\/eve\.ayokei\.to\/missions\/" \/>/);
  assert.match(indexHtml, /<meta property="og:title" content="EVE Mission Reference" \/>/);
  assert.match(indexHtml, /<meta property="og:url" content="https:\/\/eve\.ayokei\.to\/missions\/" \/>/);
});

test("missions pages reference the shared LP theme asset query-less", () => {
  for (const pageHtml of [indexHtml, browseHtml, detailHtml, arcHtml]) {
    assert.match(pageHtml, /href="\/lp\/theme\.css"/);
  }
});

test("missions frontend references carry no ?v= cache-bust queries (purge-driven)", () => {
  // Match ?v= only inside a string/template literal (an actual asset ref), not prose comments.
  for (const source of [indexHtml, browseHtml, detailHtml, arcHtml, indexJs, browseJs, detailJs, arcJs, diagnosticsJs, css, domUtilJs]) {
    assert.doesNotMatch(source, /["'`][^"'`\n]*\?v=/);
  }
});

test("missions codex landing renders the rail, search, nav items with planned tags, arc groups, and browse link", () => {
  // Rail structure
  assert.match(indexHtml, /class="codex-shell"/);
  assert.match(indexHtml, /class="codex-rail"/);
  assert.match(indexHtml, /id="arcSearch"/);
  assert.match(indexHtml, /type="search"/);
  assert.match(indexHtml, /class="codex-nav"/);
  // Active nav item (epic arcs)
  assert.match(indexHtml, /class="codex-nav-item active"/);
  assert.match(indexHtml, /id="arcNavCount"/);
  // Planned items with tags
  assert.match(indexHtml, /COSMOS/);
  assert.match(indexHtml, /Anomic burners/);
  assert.match(indexHtml, /Data centers/);
  assert.match(indexHtml, /class="codex-nav-tag"[^>]*>Planned/);
  // Arc groups container
  assert.match(indexHtml, /id="arcGroups"/);
  assert.match(indexHtml, /class="codex-groups"/);
  // COSMOS planned aside block in codex-main
  assert.match(indexHtml, /class="codex-coming"/);
  // Browse link
  assert.match(indexHtml, /href="\/missions\/browse"/);
  assert.match(indexHtml, /href="\/missions\/style\.css"/);
  assert.match(indexHtml, /src="\/missions\/app\.js"/);
  // No filter IDs or table in the codex landing
  assert.doesNotMatch(indexHtml, /id="missionSearch"/);
  assert.doesNotMatch(indexHtml, /id="missionRows"/);
  assert.doesNotMatch(indexHtml, /<th>Mission<\/th>/);
});

test("missions app.js imports arc-meta, fetches /api/arcs, and hands search to browse", () => {
  assert.match(indexJs, /from "\.\/arc-meta\.js"/);
  assert.match(indexJs, /ARC_PRESENTATION/);
  // The faction emblem (imagery + monogram fallback) now lives in arc-meta.js's arcEmblem,
  // which app.js imports and renders — the faction id maps moved there with it.
  assert.match(indexJs, /arcEmblem\(/);
  assert.match(arcMetaJs, /FACTION_IMAGE_IDS/);
  assert.match(arcMetaJs, /FACTION_MONOGRAMS/);
  assert.match(indexJs, /LEVEL_GROUP_NAMES/);
  assert.match(indexJs, /\/api\/arcs/);
  assert.doesNotMatch(indexJs, /\/api\/missions/);
  assert.doesNotMatch(indexJs, /history\.replaceState/);
  // Enter in search navigates to browse with query
  assert.match(indexJs, /\/missions\/browse/);
  assert.match(indexJs, /encodeURIComponent/);
  // Renders level groups and arc rows
  assert.match(indexJs, /function levelGroup/);
  assert.match(indexJs, /function arcRow/);
  // app.js selects #arcNavCount to update count
  assert.match(indexJs, /#arcNavCount/);
  // Status line format
  assert.match(indexJs, /epic arcs.*missions indexed/);
  // Error paths
  assert.match(indexJs, /apiErrorMessage/);
  assert.match(indexJs, /codex-empty error/);
  // No arc-graph import (that lives on arc.html/browse)
  assert.doesNotMatch(indexJs, /arc-graph\.js/);
  assert.doesNotMatch(indexJs, /renderArcDiagram/);
});

test("missions browse page exposes live filters, summary slots, and row navigation hooks", () => {
  for (const id of [
    "missionSearch",
    "levelFilter",
    "factionFilter",
    "typeFilter",
    "arcFilter",
    "missionRows",
    "missionCount",
    "arcCount",
    "filteredCount"
  ]) {
    assert.match(browseHtml, new RegExp(`id="${id}"`));
  }
  assert.match(browseHtml, /<th>Mission<\/th>/);
  assert.match(browseHtml, /<th>Deal<\/th>/);
  assert.match(browseHtml, /<th>Resist<\/th>/);
  assert.match(browseHtml, /<th>Ship<\/th>/);
  assert.match(browseJs, /\/api\/missions/);
  assert.match(browseJs, /\/api\/arcs/);
  assert.match(browseJs, /history\.replaceState/);
  assert.match(browseJs, /location\.href\s*=\s*`\/missions\/\$\{mission\.mission_id\}`/);
  assert.match(browseHtml, /<option value="BRANCH">Branch<\/option>/);
  assert.match(browseHtml, /<option value="TRAVEL">Travel<\/option>/);
  assert.doesNotMatch(browseHtml, /<th>ISK<\/th>|<th>LP<\/th>|<th>Bonus time<\/th>/);
  assert.doesNotMatch(browseJs, /reward_isk|reward_lp|bonus_time_seconds|formatTime/);
  assert.match(browseHtml, /href="\/missions\/style\.css"/);
  assert.match(browseHtml, /src="\/missions\/browse\.js"/);
  // browse carries a link back to the missions home
  assert.match(browseHtml, /href="\/missions\/"/);
  // URL state writes to /missions/browse path
  assert.match(browseJs, /\/missions\/browse/);
});

test("missions codex landing renders arc rows with emblem, body, stats, and CTA", () => {
  // These come from app.js rendering the /api/arcs response — verify CSS classes exist in style.css
  assert.match(css, /\.arc-row/);
  assert.match(css, /\.arc-emblem/);
  assert.match(css, /\.arc-stats/);
  assert.match(css, /\.arc-body/);
  // Level group structure
  assert.match(css, /\.level-group/);
  assert.match(css, /\.level-heading/);
  // App renders arc row elements including links to /missions/arc/<id>
  assert.match(indexJs, /href.*\/missions\/arc\/\$\{arc\.arc_id\}/);
  // Faction image from evetech CDN — rendered by arcEmblem in arc-meta.js
  assert.match(arcMetaJs, /images\.evetech\.net\/corporations\/\$\{factionId\}\/logo/);
  // Risk badge rendered from ARC_PRESENTATION meta
  assert.match(indexJs, /badge-risk/);
  // arc-graph.js is NOT imported by app.js (the codex landing doesn't render diagrams inline)
  assert.doesNotMatch(indexJs, /arc-graph\.js/);
});

test("mission arc helpers label duplicate final choices as branch options", async () => {
  const { arcMissionPositionLabels, orderedArcMissions } = await import(
    pathToFileURL(path.resolve("web/missions/arc-order.js")).href
  ) as ArcOrderModule;
  const ordered = orderedArcMissions([
    { mission_id: 208, name: "Retraction", arc_position: 18 },
    { mission_id: 207, name: "With Great Power", arc_position: 17 },
    { mission_id: 209, name: "Revelation", arc_position: 18 }
  ]);
  const labels = arcMissionPositionLabels(ordered);

  assert.deepEqual(
    ordered.map((mission) => mission.name),
    ["With Great Power", "Retraction", "Revelation"]
  );
  assert.deepEqual(
    ordered.map((mission) => labels.get(mission.mission_id)),
    ["17", "18a", "18b"]
  );
});

test("mission arc helpers label Syndication branch choices in EVE University order", async () => {
  const { arcMissionPositionLabels, orderedArcMissions } = await import(
    pathToFileURL(path.resolve("web/missions/arc-order.js")).href
  ) as ArcOrderModule;
  const ordered = orderedArcMissions([
    { mission_id: 79, name: "Safe Return", arc_position: 19 },
    { mission_id: 73, name: "Oldest Profession", arc_position: 14 },
    { mission_id: 78, name: "Everybody Has a Price", arc_position: 19 },
    { mission_id: 71, name: "Octomet Plantation", arc_position: 14 },
    { mission_id: 72, name: "Little Fingers", arc_position: 14 }
  ]);
  const labels = arcMissionPositionLabels(ordered);

  assert.deepEqual(
    ordered.map((mission) => mission.name),
    ["Octomet Plantation", "Little Fingers", "Oldest Profession", "Everybody Has a Price", "Safe Return"]
  );
  assert.deepEqual(
    ordered.map((mission) => labels.get(mission.mission_id)),
    ["14a", "14b", "14c", "19a", "19b"]
  );
});

test("mission arc graph groups same-step choices into diagram branches", async () => {
  const { arcGraphSteps } = await import(
    pathToFileURL(path.resolve("web/missions/arc-graph.js")).href
  ) as ArcGraphModule;
  const steps = arcGraphSteps([
    { mission_id: 208, name: "Retraction", arc_position: 18 },
    { mission_id: 207, name: "With Great Power", arc_position: 17 },
    { mission_id: 209, name: "Revelation", arc_position: 18 }
  ]);

  assert.deepEqual(
    steps.map((step) => step.label),
    ["17", "18"]
  );
  assert.deepEqual(
    steps.map((step) => step.missions.map((mission) => mission.name)),
    [["With Great Power"], ["Retraction", "Revelation"]]
  );
});

test("mission arc DAG layout groups depth layers and colours paths by authored edge order", async () => {
  const { dagLayout } = (await import(
    pathToFileURL(path.resolve("web/missions/arc-graph.js")).href
  )) as ArcGraphModule;

  const { layers, colors } = dagLayout(
    [
      { mission_id: 1, name: "Start", arc_position: 1 },
      { mission_id: 2, name: "Hyasyoda", arc_position: 2 },
      { mission_id: 3, name: "Nugoeihuvi", arc_position: 2 },
      { mission_id: 4, name: "Merge", arc_position: 3 }
    ],
    [
      { from: 1, to: 2, label: "Hyasyoda" },
      { from: 1, to: 3, label: "Nugoeihuvi" },
      { from: 2, to: 4, label: "Hyasyoda" },
      { from: 3, to: 4, label: "Nugoeihuvi" }
    ]
  );

  assert.deepEqual(
    layers.map((layer) => layer.missionIds),
    [[1], [2, 3], [4]]
  );
  assert.deepEqual(
    colors.map(([label]) => label),
    ["Hyasyoda", "Nugoeihuvi"]
  );
});

test("mission arc graph metadata includes peak DPS when available", async () => {
  const { missionMeta } = await import(
    pathToFileURL(path.resolve("web/missions/arc-graph.js")).href
  ) as ArcGraphModule;

  assert.equal(
    missionMeta({
      level: 4
    }, {
      mission_id: 201,
      name: "Combat",
      arc_position: 7,
      mission_type: "ENCOUNTER",
      faction: "Angel Cartel",
      peak_dps: 90,
      ewar_types: ["WEB", "SCRAMBLE"]
    }),
    "L4 · ENCOUNTER · Angel Cartel · Peak 90 DPS · EWAR Web, Scram"
  );
  assert.equal(
    missionMeta({
      level: 4
    }, {
      mission_id: 200,
      name: "Travel",
      arc_position: 6,
      mission_type: "TRAVEL",
      peak_dps: null,
      space_risk: "LOWSEC"
    }),
    "L4 · TRAVEL · Lowsec risk"
  );
});

test("missions pages reference scripts and stylesheets query-less", () => {
  assert.match(indexHtml, /href="\/missions\/style\.css"/);
  assert.match(indexHtml, /src="\/missions\/app\.js"/);
  assert.doesNotMatch(indexHtml, /\?v=/);
  assert.match(browseHtml, /href="\/missions\/style\.css"/);
  assert.match(browseHtml, /src="\/missions\/browse\.js"/);
  assert.doesNotMatch(browseHtml, /\?v=/);
});

test("mission pages warn users when the API rate limit is hit", () => {
  for (const source of [indexJs, browseJs, detailJs, arcJs]) {
    assert.match(source, /apiErrorMessage/);
  }
  assert.match(sharedDiagnosticsJs, /function apiErrorMessage/);
  assert.match(sharedDiagnosticsJs, /error\?\.status\s*===\s*429/);
  assert.match(sharedDiagnosticsJs, /rate-limited/i);
  assert.match(sharedDiagnosticsJs, /Retry-After/);
  assert.doesNotMatch(sharedDiagnosticsJs, /Request ID:/);
  assert.match(diagnosticsJs, /export \* from "\/shared\/diagnostics\.js/);
});

test("mission detail page renders mission metadata, intel summary, objectives, pocket groups, NPC stats, and source link", () => {
  for (const id of ["missionTitle", "missionMeta", "missionRoot", "sourceLink", "prevMission", "nextMission"]) {
    assert.match(detailHtml, new RegExp(`id="${id}"`));
  }
  assert.ok(detailJs.includes(`apiFetch(\`/api/missions/\${missionId}\`)`));
  assert.doesNotMatch(detailHtml, /rewardStrip/);
  assert.doesNotMatch(detailJs, /reward_isk|reward_lp|reward_bonus_isk|bonus_time_seconds|Bonus time/);
  assert.match(detailJs, /computeSummary/);
  assert.match(detailJs, /buildHero/);
  assert.match(domUtilJs, /Object\.entries\(props \?\? \{\}\)/);
  assert.match(detailJs, /Tank against/);
  assert.match(detailJs, /Deal these/);
  assert.match(detailJs, /from "\.\/fit-profile\.js"/);
  // The DOM-free combat math lives in combat-stats.js; detail.js imports and wires it.
  assert.match(detailJs, /from "\.\/combat-stats\.js"/);
  assert.match(combatStatsJs, /export function aggregateCombatStats/);
  assert.match(combatStatsJs, /function aggregateNeutPressure/);
  assert.match(detailJs, /aggregateCombatStats\(flattenNpcs\(/);
  assert.match(detailJs, /computeSummary\(mission/);
  assert.match(detailJs, /parseEwarText/);
  assert.match(detailJs, /HP-weighted avg resist/);
  assert.match(detailJs, /function buildDamageChart/);
  assert.match(detailJs, /function buildResistChart/);
  assert.match(detailJs, /tank-summary-chart/);
  assert.match(detailJs, /deal-spectrum/);
  assert.match(detailJs, /npc-resist-chart/);
  assert.match(detailJs, /npc-dps-chart/);
  assert.match(detailJs, /function buildObjective/);
  assert.match(detailJs, /objective-notes/);
  assert.match(detailJs, /Heads up/);
  assert.match(detailJs, /mission\.objective_notes/);
  assert.doesNotMatch(detailJs, /CCPEVE\.showInfo/);
  assert.doesNotMatch(detailJs, /function itemLink/);
  assert.match(detailJs, /a\[href\^="item\.php\?type_id="\]/);
  assert.match(detailJs, /buildNpcRow/);
  assert.match(detailJs, /buildNpcImage/);
  assert.match(detailJs, /images\.evetech\.net\/types\/\$\{npc\.type_id\}\/icon\?size=64/);
  assert.match(detailJs, /loading:\s*"lazy"/);
  assert.match(detailJs, /addEventListener\("error"/);
  assert.match(detailJs, /npc-resists/);
  assert.match(detailJs, /npc-dps/);
  assert.match(detailJs, /npc-ewar/);
  // damage icon paths live in the shared missions-util module (imported by detail + fit-profile)
  assert.match(
    detailJs,
    /import \{ DAMAGE_COLORS, DAMAGE_ICON_PATHS, DAMAGE_TYPES, EWAR_ICON_PATHS, describeSpaceRisk \} from "\.\/missions-util\.js"/
  );
  const missionsUtilJs = fs.readFileSync(path.resolve("web/missions/missions-util.js"), "utf8");
  assert.match(missionsUtilJs, /\/missions\/assets\/damage\/em\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/damage\/thermal\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/damage\/kinetic\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/damage\/explosive\.png/);
  assert.match(detailJs, /TANK_LAYER_ICONS/);
  assert.match(detailJs, /\/missions\/assets\/tank\/shield\.png/);
  assert.match(detailJs, /\/missions\/assets\/tank\/armor\.png/);
  assert.match(detailJs, /\/missions\/assets\/tank\/hull\.png/);
  assert.match(detailJs, /EWAR_ICON_PATHS/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/target-painter\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/stasis-webifier\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/warp-scrambler\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/warp-disruptor\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/energy-neutralizer\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/sensor-dampener\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/ecm\.png/);
  assert.match(missionsUtilJs, /\/missions\/assets\/ewar\/tracking-disruptor\.png/);
  assert.doesNotMatch(detailJs, /function damageIconSvg/);
  assert.doesNotMatch(detailJs, /function ewarIconSvg/);
  assert.doesNotMatch(detailJs, /hpLayer\("S"/);
  assert.doesNotMatch(detailJs, /hpLayer\("A"/);
  assert.doesNotMatch(detailJs, /hpLayer\("H"/);
  assert.doesNotMatch(detailJs, /class:\s*"row-label",\s*text:\s*"S"/);
  assert.doesNotMatch(detailJs, /class:\s*"row-label",\s*text:\s*"A"/);
  assert.match(detailJs, /resist_shield_/);
  assert.match(detailJs, /resist_armor_/);
  // The raw per-NPC DPS formula (turret + missile) is encapsulated in combat-stats.js's npcRawDps.
  assert.match(combatStatsJs, /turret_dps_/);
  assert.match(combatStatsJs, /missile_dps_/);
  assert.match(detailJs, /prevMission/);
  assert.match(detailJs, /nextMission/);
  assert.match(detailHtml, /href="\/missions\/style\.css"/);
  assert.match(detailHtml, /src="\/missions\/detail\.js"/);
  assert.match(detailHtml, /href="\/missions\/detail\.css"/);
  assert.match(detailCss, /@media\s*\(max-width:\s*700px\)[\s\S]*\.missions-topbar\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(detailCss, /\.damage-chart\s*\{[\s\S]*display:\s*grid/);
  assert.match(detailCss, /\.chart-row\s*\{[\s\S]*grid-template-columns:\s*16px\s+minmax\(0,\s*1fr\)\s+42px/);
  assert.match(detailCss, /\.chart-track\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(detailCss, /\.npc-resist-chart\s*\{[\s\S]*display:\s*grid/);
  assert.match(
    detailCss,
    /\.npc-resist-chart\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(detailCss, /\.npc-dps-chart\s*\{[\s\S]*display:\s*grid/);
  assert.match(
    detailCss,
    /\.npc-dps-chart\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(detailCss, /\.npc-dps-chart \.chart-row\s*\{[\s\S]*grid-template-areas:[\s\S]*"icon value"[\s\S]*"bar bar"/);
  // live redesign chip layout: 18px icon + label column, params span the full width
  assert.match(detailCss, /\.npc-ewar \.chip\s*\{\s*grid-template-columns:\s*18px\s+minmax\(0,\s*1fr\)/);
  assert.match(detailCss, /\.npc-ewar \.ewar-params\s*\{\s*grid-column:\s*1 \/ -1/);
  // the pre-redesign chip layout and its .detail column must stay dead
  assert.doesNotMatch(detailCss, /\.npc-ewar \.chip \.detail/);
  assert.doesNotMatch(detailCss, /grid-template-columns:\s*20px\s+max-content/);
  assert.doesNotMatch(detailCss, /grid-auto-columns:\s*max-content/);
});

test("missions EWAR taxonomy maps DRAIN to the energy neutralizer kind", async () => {
  const { ewarMapping } = (await import(
    pathToFileURL(path.resolve("web/missions/missions-ewar.js")).href
  )) as { ewarMapping: (rawType: string, text?: string) => { kind: string; label: string } };
  assert.deepEqual(ewarMapping("DRAIN"), { kind: "neut", label: "Neut" });
});

test("missions EWAR taxonomy disambiguates chruker DISRUPT/SCRAMBLE types", async () => {
  const { ewarMapping, normalizeEwarType } = (await import(
    pathToFileURL(path.resolve("web/missions/missions-ewar.js")).href
  )) as {
    ewarMapping: (rawType: string, text?: string) => { kind: string; label: string };
    normalizeEwarType: (rawType: string) => string;
  };
  // chruker's ewar_disrupt class marks tracking disruptors, not warp points
  assert.equal(normalizeEwarType("DISRUPT"), "td");
  assert.deepEqual(ewarMapping("DISRUPT", "Tracking Disrupt (-50%, 55 km, 1.5% chance, 30s)"), {
    kind: "td",
    label: "TD"
  });
  // ewar_scramble covers all warp tackle — the "N pt." text splits scram vs point
  assert.deepEqual(ewarMapping("SCRAMBLE", "Warp Disrupt (7.5 km, 2 pt., 25% chance, 10s)"), {
    kind: "scramble",
    label: "Scram"
  });
  assert.deepEqual(ewarMapping("SCRAMBLE", "Warp Disrupt (20 km, 1 pt., 25% chance, 10s)"), {
    kind: "disrupt",
    label: "Point"
  });
  assert.deepEqual(ewarMapping("SCRAMBLE", "point=yes"), { kind: "disrupt", label: "Point" });
  // type-only callers (arc chips) keep the worst-case scram reading
  assert.deepEqual(ewarMapping("SCRAMBLE"), { kind: "scramble", label: "Scram" });
});

test("parseEwarText extracts structured params from chruker effect text and tolerates bare labels", async () => {
  const { parseEwarText } = (await import(
    pathToFileURL(path.resolve("web/missions/missions-ewar.js")).href
  )) as { parseEwarText: (text: string) => Record<string, number | null> };

  assert.deepEqual(parseEwarText("Energy Neutralize (20.0 GJ/s, 30 km, 75% chance)"), {
    gjPerSec: 20,
    rangeKm: 30,
    rangeKmMin: null,
    chancePct: 75,
    strengthPct: null,
    points: null,
    durationS: null
  });
  assert.deepEqual(parseEwarText("Webbing (10 km, -50%, 25% chance, 5s)"), {
    gjPerSec: null,
    rangeKm: 10,
    rangeKmMin: null,
    chancePct: 25,
    strengthPct: -50,
    points: null,
    durationS: 5
  });
  assert.deepEqual(parseEwarText("Warp Disrupt (7.5 km, 2 pt., 25% chance, 10s)"), {
    gjPerSec: null,
    rangeKm: 7.5,
    rangeKmMin: null,
    chancePct: 25,
    strengthPct: null,
    points: 2,
    durationS: 10
  });
  // "min-max km" range expressions keep both ends (max stays in rangeKm)
  assert.deepEqual(parseEwarText("Sensor Dampening (-60%, 25-75 km, 45% chance, 10s)"), {
    gjPerSec: null,
    rangeKm: 75,
    rangeKmMin: 25,
    chancePct: 45,
    strengthPct: -60,
    points: null,
    durationS: 10
  });
  // bare label → all null, no throw
  assert.deepEqual(parseEwarText("Damp"), {
    gjPerSec: null,
    rangeKm: null,
    rangeKmMin: null,
    chancePct: null,
    strengthPct: null,
    points: null,
    durationS: null
  });
});

test("mission detail offers compact + dense NPC layouts with structured EWAR and neut totals", () => {
  // compact row + dense table renderers and the persisted toggle
  assert.match(detailJs, /function buildNpcRow/);
  assert.match(detailJs, /function buildDenseRow/);
  assert.match(detailJs, /function buildDenseHeader/);
  assert.match(detailJs, /function installDensityToggle/);
  assert.match(detailJs, /localStorage\.getItem\("missions-row-style"\)/);
  assert.match(detailJs, /localStorage\.setItem\("missions-row-style"/);
  // structured EWAR params + mission-level neut pressure
  assert.match(detailJs, /ewar-params/);
  assert.match(combatStatsJs, /function aggregateNeutPressure/);
  assert.match(detailJs, /neutGjPerSec/);
  assert.match(detailJs, /combat-ribbon-neut/);
  // reworked hero pieces + inline physical
  assert.match(detailJs, /ewar-cards/);
  assert.match(detailJs, /function buildDealSpectrum/);
  assert.match(detailJs, /deal-spectrum/);
  assert.match(detailJs, /ds-marker/);
  assert.match(detailJs, /function buildPhysSection/);
  assert.match(detailJs, /npc-phys-inline/);
  // deal spectrum ranks relatively (best→worst to deal), not by absolute classifyResist
  assert.match(detailJs, /function dealRankClasses/);
  // mission overview cell labels the recommended ship correctly (not "Mission")
  assert.match(detailJs, /Recommended ship/);
  // the deleted per-NPC "Best: X" deal-hint must be gone
  assert.doesNotMatch(detailJs, /deal-hint/);

  // matching CSS for the new building blocks
  for (const selector of [
    "\\.npc-dense",
    "\\.npc-dense-head",
    "\\.dense-resist",
    "\\.dense-ewar-chip",
    "\\.ewar-card",
    "\\.deal-spectrum",
    "\\.ds-rail",
    "\\.ds-marker\\.r0",
    "\\.ewar-params",
    "\\.combat-ribbon-neut",
    "\\.mission-objective",
    "\\.npc-phys-inline"
  ]) {
    assert.match(detailCss, new RegExp(selector));
  }
});

test("mission arc page renders the hero cards and ordered mission diagram", () => {
  for (const id of ["arcTitle", "arcMeta", "arcHero", "arcGraph"]) {
    assert.match(arcHtml, new RegExp(`id="${id}"`));
  }
  assert.match(arcJs, /\/api\/arcs\/\$\{arcId\}/);
  assert.match(arcJs, /arc-graph\.js/);
  assert.match(arcJs, /renderArcDiagram/);
  // Identity card: editorial copy, staging intel, payout totals (every block
  // degrades to hidden when the seed lacks the data, so only sources matter here).
  assert.match(arcJs, /from "\.\/arc-meta\.js"/);
  assert.match(arcJs, /ARC_PRESENTATION/);
  assert.match(arcJs, /starting_system_region/);
  assert.match(arcJs, /total_reward_isk/);
  assert.match(arcJs, /total_bonus_isk/);
  assert.match(arcJs, /evemaps\.dotlan\.net\/system/);
  // Intel card: aggregated damage spectrum, EWAR chips, toughest fight
  assert.match(arcJs, /Combat intel/);
  assert.match(arcJs, /peak_dps_by_type/);
  assert.match(arcJs, /Toughest fight/);
  assert.match(arcJs, /EWAR_ICON_PATHS/);
  assert.match(arcHtml, /href="\/missions\/style\.css"/);
  assert.match(arcHtml, /src="\/missions\/arc\.js"/);
});

test("missions CSS includes responsive cards for filters, arc diagrams, EWAR, and codex landing", () => {
  for (const selector of [
    ".mission-filters",
    ".mission-row",
    ".ewar-chip",
    ".arc-graph",
    ".arc-graph-node",
    ".arc-graph-branches",
    ".codex-shell",
    ".codex-rail",
    ".codex-nav",
    ".codex-nav-item",
    ".codex-main",
    ".arc-row",
    ".arc-emblem",
    ".arc-stats",
    ".level-group",
    ".badge-risk",
    ".arc-hero",
    ".arc-hero-facts",
    ".arc-hero-payout",
    ".arc-dmg-row",
    ".arc-intel-block"
  ]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
  // Two mobile breakpoints: existing 700px block and the new codex phone layout
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /@media\s*\(max-width:\s*1280px\)/);
  assert.doesNotMatch(css, /\.detail-layout\s*\{/);
  assert.doesNotMatch(css, /\.detail-card\s*\{/);
  assert.doesNotMatch(css, /\.detail-main\s*\{/);
  assert.doesNotMatch(css, /\.detail-side\b/);
  assert.doesNotMatch(css, /\.mission-intel\s*\{/);
  assert.doesNotMatch(css, /\.intel-detail\s*\{/);
  assert.doesNotMatch(css, /\.mission-summary\.compact\s*\{/);
  assert.doesNotMatch(css, /\.pocket-list\s*\{/);
  assert.doesNotMatch(css, /\.pocket-card\s*\{/);
  assert.doesNotMatch(css, /\.group-card\s*\{/);
  assert.doesNotMatch(css, /\.npc-card\s*\{/);
  assert.doesNotMatch(css, /\.npc-icon\s*\{/);
  assert.doesNotMatch(css, /\.npc-stat-grid\s*\{/);
  assert.doesNotMatch(css, /\.npc-stat-section\s*\{/);
  assert.doesNotMatch(css, /\.resist-grid\s*\{/);
  assert.doesNotMatch(css, /\.resist-pair\s*\{/);
  assert.doesNotMatch(css, /\.dps-grid\s*\{/);
  assert.doesNotMatch(css, /\.ewar-list\s*\{/);
  assert.doesNotMatch(css, /\.trigger-text\s*\{/);
  assert.doesNotMatch(css, /\.source-link\s*\{/);
  assert.doesNotMatch(css, /\.rich-text\s*\{/);
  assert.doesNotMatch(css, /\.objective-items\s*\{/);
  assert.doesNotMatch(css, /\.objective-item\s*\{/);
  assert.doesNotMatch(css, /\.mini-dl\s*\{/);
});

test("mission arc split choices stay side by side without sibling connector", () => {
  assert.match(
    css,
    /\.arc-graph-branches\.is-split\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(240px,\s*1fr\)\)/
  );
  assert.match(
    css,
    /\.arc-graph-branches\.is-split::before\s*\{[\s\S]*left:\s*max\(18%,\s*36px\)[\s\S]*right:\s*max\(18%,\s*36px\)[\s\S]*height:\s*10px[\s\S]*border-top:\s*2px solid/
  );
  assert.doesNotMatch(css, /\.arc-graph-branches\.is-split::before\s*\{[\s\S]*right:\s*8px[\s\S]*left:\s*8px[\s\S]*height:\s*1px/);
  assert.doesNotMatch(css, /\.arc-graph-node\.is-choice::before/);
});

test("browse shell fetches arcs and missions in parallel on first load", () => {
  // The two endpoints are independent; a serial loadArcs().then(loadMissions()) chain
  // doubles the time before any rows render.
  assert.match(browseJs, /Promise\.all\(\[loadArcs\(\), loadMissions\(\)\]\)/);
  assert.doesNotMatch(browseJs, /loadArcs\(\)\s*\n?\s*\.then\(\(\) => loadMissions\(\)\)/);
});

test("mission detail prefetches chain neighbors once after the initial load", () => {
  // Low-priority warmup of prev/next mission JSON so chain navigation renders instantly.
  assert.match(detailJs, /function prefetchNeighbors\(neighbors\)[\s\S]*?apiFetch\(`\/api\/missions\/\$\{neighbor\.id\}`, \{ priority: "low" \}\)\.catch/);
  assert.match(detailJs, /renderMission\(mission\);\s*\n\s*prefetchNeighbors\(mission\.neighbors\);/);
  // Fork missions warm every branch, not just the arbitrary linear next.
  assert.match(detailJs, /\[neighbors\?\.prev, neighbors\?\.next, \.\.\.\(neighbors\?\.next_options \?\? \[\]\)\]/);
  // renderMission re-runs on every fit-profile change; the prefetch must not live there.
  assert.doesNotMatch(detailJs, /function renderMission\(mission\)[\s\S]*?prefetchNeighbors[\s\S]*?\n\}\n\nfunction renderError/);
});

test("mission detail renders an explicit chooser on fork missions", () => {
  // The fork fan-out (neighbors.next_options) renders as one linked card per branch…
  assert.match(detailJs, /function buildPathChoice\(options\)/);
  assert.match(detailJs, /class: "mission-card path-choice", id: "pathChoice"/);
  assert.match(detailJs, /class: "path-option", href: `\/missions\/\$\{option\.id\}`/);
  assert.match(detailJs, /if \(nextOptions\?\.length > 1\) root\.append\(buildPathChoice\(nextOptions\)\)/);
  // …and the top-nav "Next" stops picking a branch arbitrarily: it deep-links the chooser.
  assert.match(detailJs, /elements\.nextMission\.href = "#pathChoice";\s*\n\s*elements\.nextMission\.textContent = "Choose path";/);
  // The chooser styling exists (accent card + branch cards).
  assert.match(detailCss, /\.mission-card\.path-choice\s*\{/);
  assert.match(detailCss, /\.path-choice \.path-option\s*\{/);
});

test("mission detail trims stray <br> runs and keeps the dense EWAR column narrow", () => {
  // Seed prose often ends in <br> runs — untrimmed they render as a dead band in the objective card.
  assert.match(detailJs, /function trimBreaks/);
  assert.match(detailJs, /trimBreaks\(mission\.objective_html\)/);
  assert.match(detailJs, /trimBreaks\(mission\.briefing_html\)/);
  // Dense table: EWAR is empty on most rows, so its flex share stays small to keep stats near the chevron.
  assert.match(detailCss, /\.npc-dense, \.npc-dense-head[\s\S]{0,300}minmax\(140px, 0\.7fr\)/);
});

test("mission hero: 3-col strip with an adaptive objective + EWAR bottom band", () => {
  // EWAR card count varies 0..5+ per mission — a content-sized cell beside the flexing
  // objective scales where a fixed column can't, and the objective card folds into the hero.
  assert.match(detailJs, /mission-hero-strip hero-3/);
  assert.match(detailJs, /hero-bottom/);
  assert.match(detailJs, /buildHero\(mission, summary, buildObjective\(mission\)\)/);
  assert.doesNotMatch(detailJs, /hero-4/);
  assert.match(detailCss, /\.mission-hero-strip\.hero-3 \{ grid-template-columns: 1\.3fr 1\.9fr 1\.3fr; \}/);
  assert.match(detailCss, /\.hero-bottom > \.mission-objective\.mission-card \{ border: 0/);
  assert.match(detailCss, /\.hero-bottom \.neut-meter/);
  // Footer lines pin to the strip bottom so uneven columns read as full.
  assert.match(detailJs, /class: "label cell-foot"/);
  assert.match(detailCss, /\.cell-foot \{ margin-top: auto/);
  // Spectrum end labels live in side gutters — above the rail they collide with edge pins.
  assert.match(detailCss, /\.ds-end \{ position: absolute; top: 30px/);
  // formatN rolls thousands up to millions (100M HP used to render as "100033K").
  assert.match(detailJs, /1000000\) \+ "M"/);
});

test("phones get mission cards, a static topbar, and a single-column hero", () => {
  // list rows render as cards: name, context chips, labeled combat lines; "n/a" cells vanish
  assert.match(css, /tbody \.mission-row \{\s*display: flex/);
  assert.match(css, /\.mission-row td\.na \{\s*display: none/);
  assert.match(browseJs, /classList\.add\("na"\)/);
  // the topbar scrolls away instead of pinning ~150px of a phone viewport
  assert.match(css, /\.missions-topbar \{\s*position: static/);
  // hero strip needs the .hero-3 selector weight, or the base 3-column template wins:
  // two columns under 900px, one column under 700px
  assert.match(detailCss, /\.mission-hero-strip\.hero-3 \{ grid-template-columns: 1fr 1fr; \}/);
  assert.match(detailCss, /\.mission-hero-strip\.hero-3 \{ grid-template-columns: 1fr; \}/);
  // arc timeline nodes take the full row instead of centering at 260px
  assert.match(css, /\.arc-dag-row \.arc-graph-node \{\s*flex: 1 1 100%;\s*max-width: none/);
  // hero EWAR threats render as adaptive tiles that fill the row, not
  // content-sized chips inside a 46%-capped cell (the cap must be lifted in the
  // trailing block — the redesign section outranks the mid-file media queries)
  assert.match(detailCss, /\.hero-bottom \.ewar-cards \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(150px, 1fr\)\); \}/);
  // dense view drops the 760px sideways scroller for a stacked two-line row,
  // with the EWAR line reserved only for rows that have EWAR
  assert.match(detailCss, /\.npc-dense, \.npc-dense-head \{ min-width: 0; \}/);
  assert.match(detailCss, /"img r1 r2 r3 r4 chev"/);
  assert.match(detailCss, /\.npc-dense:not\(\.has-ewar\) > :nth-child\(12\) \{ display: none; \}/);
  // the npc-row grid-area names attach to section classes reused inside
  // .dense-detail — without a reset all five sections overlap on one cell
  assert.match(detailCss, /\.dense-detail > section \{ grid-area: auto; \}/);
});
