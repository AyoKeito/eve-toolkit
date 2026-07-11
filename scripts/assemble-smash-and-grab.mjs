// Assemble "Smash and Grab" (Guristas L3 epic arc, arc_id 7) seed.
//
// chruker has all 19 missions (ids 244-262); the main chain scrape misses the
// two alternate entries (249, 250), the Brassy Faced Bastard branch (248) and
// the Kori/Eroma path (257, 261, 262), scraped individually into tmp_arcs/.
// Structure and per-mission metadata come from the EVE University overlay
// tmp_arcs/wiki_sg.json — the wiki is authoritative. The two Chapter 3 paths
// never merge: the arc has two endings (260 Passing the Buck, 262 Spy Games).
//
// Usage: node scripts/assemble-smash-and-grab.mjs   (then SDE-enrich on the Linux host)
import fs from "node:fs";

const OUT = "tmp_arcs/seed_sg.json";

const main = JSON.parse(fs.readFileSync("tmp_arcs/sg_main.json", "utf8"));
const byId = new Map();
for (const m of main.missions) byId.set(m.mission_id, m);
for (const id of [248, 249, 250, 257, 261, 262]) {
  const part = JSON.parse(fs.readFileSync(`tmp_arcs/sg_${id}.json`, "utf8"));
  for (const m of part.missions) if (!byId.has(m.mission_id)) byId.set(m.mission_id, m);
}

const overlay = new Map();
for (const o of JSON.parse(fs.readFileSync("tmp_arcs/wiki_sg.json", "utf8"))) overlay.set(Number(o.id), o);

// Depth = layout row. Three alternate entries share row 1; the Sabotage/Brassy
// alternatives share row 4; the non-merging Chapter 3 paths share rows 10+.
const DEPTH = {
  244: 1, 249: 1, 250: 1,
  245: 2, 246: 3,
  247: 4, 248: 4,
  251: 5, 252: 6, 253: 7, 254: 8, 255: 9,
  256: 10, 258: 11, 259: 12, 260: 13, // Irichi's trail
  257: 10, 261: 11, 262: 12 // Kori's trail (Eroma Eralen)
};

const STEALTH = "Sabotage";
const ASSAULT = "Frontal assault";
const IRICHI = "Irichi's trail";
const KORI = "Kori's trail";
const EDGES = [
  [244, 245, "Gallente start"], [249, 245, "Guristas start"], [250, 245, "Caldari start"],
  [245, 246, null],
  [246, 247, STEALTH], [247, 251, STEALTH],
  [246, 248, ASSAULT], [248, 251, ASSAULT],
  [251, 252, null], [252, 253, null], [253, 254, null], [254, 255, null],
  [255, 256, IRICHI], [256, 258, IRICHI], [258, 259, IRICHI], [259, 260, IRICHI],
  [255, 257, KORI], [257, 261, KORI], [261, 262, KORI]
];

const BRANCH = new Set([246, 255]);

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
    mission_type: BRANCH.has(id) ? "BRANCH" : o.mission_type ?? m.mission_type,
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
  arc_id: 7,
  name: "Smash and Grab",
  faction: "GURISTAS",
  level: 3,
  starting_agent: "Kori Latamaki",
  starting_system: "H-PA29",
  description:
    "Guristas level 3 epic arc set in Venal nullsec. Three alternate entry agents (Gallente, Caldari, or Guristas standings) funnel to H-PA29; two non-merging endings reward +30% base Guristas standing and a Gila blueprint copy.",
  source_url: "https://wiki.eveuniversity.org/Smash_and_Grab",
  missions
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, missions: missions.length, edges: EDGES.length }, null, 2));
