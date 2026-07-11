// Assemble "The Blood-Stained Stars" (SOE L1 epic arc, arc_id 5) seed.
//
// chruker supplies all 58 missions (ids 84-141) but its chain skips the
// Tracking branch (109-111) and the post-fork tail (137-141), scraped
// individually into tmp_arcs/. chruker also models Our Man Dagan as two empire
// variants (140 Caldari / 514 Amarr); the wiki — the authoritative source —
// models ONE converging mission, so we keep 140 and rename it. Structure
// (types, factions, damage, risk, notes, ship recs) comes from the EVE
// University overlay in tmp_arcs/wiki_bss_{1,2}.json.
//
// Usage: node scripts/assemble-bss.mjs   (then SDE-enrich on the Linux host)
import fs from "node:fs";

const MAIN = "tmp_arcs/bss_main.json";
const SINGLES = [109, 110, 111, 137, 138, 139, 140, 141];
const OVERLAYS = ["tmp_arcs/wiki_bss_1.json", "tmp_arcs/wiki_bss_2.json"];
const OUT = "tmp_arcs/seed_bss.json";

const main = JSON.parse(fs.readFileSync(MAIN, "utf8"));
const byId = new Map();
for (const m of main.missions) byId.set(m.mission_id, m);
for (const id of SINGLES) {
  const part = JSON.parse(fs.readFileSync(`tmp_arcs/bss_${id}.json`, "utf8"));
  for (const m of part.missions) if (!byId.has(m.mission_id)) byId.set(m.mission_id, m);
}

const overlay = new Map();
for (const file of OVERLAYS)
  for (const o of JSON.parse(fs.readFileSync(file, "utf8"))) overlay.set(Number(o.id), o);

// chruker's "Our Man Dagan (Caldari)" (140) becomes the single wiki-canonical node.
byId.get(140).name = "Our Man Dagan";

// Depth = layout row. Trunk 1-24; Tracking/Scanning branches share rows 25-27;
// trunk 28-49; the four commanders share row 50; Dagan 51; finale 52.
const DEPTH = {};
for (let id = 84; id <= 107; id += 1) DEPTH[id] = id - 83;
Object.assign(DEPTH, { 109: 25, 110: 26, 111: 27, 108: 25, 112: 26, 113: 27 });
for (let id = 114; id <= 135; id += 1) DEPTH[id] = id - 86;
Object.assign(DEPTH, { 136: 50, 137: 50, 138: 50, 139: 50, 140: 51, 141: 52 });

// Explicit DAG edges with path labels (wiki structure). 107 and 135 are the
// two permanent decisions; both branches converge again.
const TRACK = "Tracking";
const SCAN = "Scanning";
const EDGES = [];
for (let id = 84; id <= 106; id += 1) EDGES.push([id, id + 1, null]);
EDGES.push(
  [107, 109, TRACK], [109, 110, TRACK], [110, 111, TRACK], [111, 114, TRACK],
  [107, 108, SCAN], [108, 112, SCAN], [112, 113, SCAN], [113, 114, SCAN]
);
for (let id = 114; id <= 134; id += 1) EDGES.push([id, id + 1, null]);
EDGES.push(
  [135, 136, "Gallente"], [135, 137, "Minmatar"], [135, 138, "Caldari"], [135, 139, "Amarr"],
  [136, 140, "Gallente"], [137, 140, "Minmatar"], [138, 140, "Caldari"], [139, 140, "Amarr"],
  [140, 141, null]
);

const linksByFrom = new Map();
const primaryNext = new Map();
const primaryPrev = new Map();
for (const [from, to, label] of EDGES) {
  if (!linksByFrom.has(from)) linksByFrom.set(from, []);
  linksByFrom.get(from).push({ to, label });
  if (!primaryNext.has(from)) primaryNext.set(from, to);
  if (!primaryPrev.has(to)) primaryPrev.set(to, from);
}

const ordered = [...byId.keys()].filter((id) => DEPTH[id] != null).sort((a, b) => DEPTH[a] - DEPTH[b] || a - b);
const missions = ordered.map((id) => {
  const m = byId.get(id);
  const o = overlay.get(id) ?? {};
  return {
    ...m,
    arc_position: DEPTH[id],
    prev_mission_id: primaryPrev.get(id) ?? null,
    next_mission_id: primaryNext.get(id) ?? null,
    links: linksByFrom.get(id) ?? [],
    mission_type: o.mission_type ?? m.mission_type,
    faction: o.faction ?? null,
    is_epic_arc: true,
    damage_to_deal: o.damage_to_deal ?? null,
    damage_to_resist: o.damage_to_resist ?? null,
    recommended_ship: o.recommended_ship ?? null,
    space_risk: o.space_risk ?? null,
    objective_notes: o.objective_notes ?? null
  };
});

const seed = {
  arc_id: 5,
  name: "The Blood-Stained Stars",
  faction: "SISTERS OF EVE",
  level: 1,
  starting_agent: "Sister Alitura",
  starting_system: "Arnon",
  description:
    "Sisters of EVE level 1 epic arc — 52 missions across 7 chapters hunting the Society spy Dagan. Open to all; ends with a permanent choice of which empire receives the +0.7 faction standing.",
  source_url: "https://wiki.eveuniversity.org/The_Blood-Stained_Stars",
  missions
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, missions: missions.length, edges: EDGES.length }, null, 2));
