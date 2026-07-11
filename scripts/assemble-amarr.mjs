// Assemble the Amarr "Right to Rule" epic arc (arc_id 4) seed.
//
// chruker's combat DB supplies all 24 missions and full NPC stats, but the
// scraper only follows the primary next_mission_id chain. So we scrape twice
// (main chain + the "Nation's Path" branch) and merge here, then layer on the
// DAG metadata the renderer needs: depth (arc_position), the BRANCH decision
// node, corrected per-mission faction/damage, and labelled path edges.
//
// Usage: node scripts/assemble-amarr.mjs
import fs from "node:fs";

const MAIN = "data/missions/seed/amarr-l4-right-to-rule.json";
const BRANCH = "tmp_amarr_branch.json";
const OUT = "data/missions/seed/amarr-l4-right-to-rule.json";

const main = JSON.parse(fs.readFileSync(MAIN, "utf8"));
const branch = JSON.parse(fs.readFileSync(BRANCH, "utf8"));

// Merge: main has 341-360 (Old Guard ending), branch adds 355,361-364 (Alike Minds).
const byId = new Map();
for (const m of [...main.missions, ...branch.missions]) if (!byId.has(m.mission_id)) byId.set(m.mission_id, m);

// Depth = layout row. Trunk 1-13; the two Chapter 3 branches share rows 14+.
const DEPTH = {
  341: 1, 342: 2, 343: 3, 344: 4, 345: 5, 346: 6, 347: 7, 348: 8, 349: 9, 350: 10, 351: 11, 352: 12, 353: 13,
  354: 14, 356: 15, 357: 16, 358: 17, 359: 18, 360: 19, // The Old Guard
  355: 14, 361: 15, 362: 16, 363: 17, 364: 18 // Alike Minds
};

// Dominant faction per mission (classified from the actual NPC roster).
// Sansha and Amarr loyalists both deal EM/Thermal; Mordus mercenaries Kin/Therm.
const SANSHA = { faction: "Sansha's Nation", deal: "EM/Thermal", resist: "EM/Thermal" };
const AMARR = { faction: "Amarr Empire", deal: "EM/Thermal", resist: "EM/Thermal" };
const MERC = { faction: "Mercenaries", deal: "Kinetic/Thermal", resist: "Kinetic/Thermal" };
const NONE = { faction: null, deal: null, resist: null };
const FACTION = {
  341: NONE, 342: SANSHA, 343: SANSHA, 344: SANSHA, 345: SANSHA, 346: NONE, 347: SANSHA, 348: AMARR,
  349: NONE, 350: MERC, 351: AMARR, 352: SANSHA, 353: NONE,
  354: SANSHA, 356: AMARR, 357: NONE, 358: NONE, 359: SANSHA, 360: SANSHA, // Old Guard
  355: NONE, 361: AMARR, 362: AMARR, 363: AMARR, 364: AMARR // Alike Minds
};

// Explicit DAG edges with path labels. Trunk edges stay unlabelled (neutral);
// the two branches are coloured by label. 353 is the decision node.
const OLD_GUARD = "The Old Guard";
const ALIKE_MINDS = "Alike Minds";
const LINKS = {};
// Trunk 341->...->353 (neutral)
for (let id = 341; id <= 352; id += 1) LINKS[id] = [{ to: id + 1, label: null }];
// Decision
LINKS[353] = [{ to: 354, label: OLD_GUARD }, { to: 355, label: ALIKE_MINDS }];
// Old Guard chain
LINKS[354] = [{ to: 356, label: OLD_GUARD }];
LINKS[356] = [{ to: 357, label: OLD_GUARD }];
LINKS[357] = [{ to: 358, label: OLD_GUARD }];
LINKS[358] = [{ to: 359, label: OLD_GUARD }];
LINKS[359] = [{ to: 360, label: OLD_GUARD }];
LINKS[360] = []; // ending
// Alike Minds chain
LINKS[355] = [{ to: 361, label: ALIKE_MINDS }];
LINKS[361] = [{ to: 362, label: ALIKE_MINDS }];
LINKS[362] = [{ to: 363, label: ALIKE_MINDS }];
LINKS[363] = [{ to: 364, label: ALIKE_MINDS }];
LINKS[364] = []; // ending

const ordered = [...byId.keys()].sort((a, b) => DEPTH[a] - DEPTH[b] || a - b);
const missions = ordered.map((id) => {
  const m = byId.get(id);
  const f = FACTION[id] ?? NONE;
  return {
    ...m,
    arc_position: DEPTH[id],
    mission_type: id === 353 ? "BRANCH" : m.mission_type,
    faction: f.faction,
    is_epic_arc: true,
    damage_to_deal: f.deal,
    damage_to_resist: f.resist,
    links: LINKS[id] ?? []
  };
});

const seed = {
  arc_id: 4,
  name: "Right to Rule",
  faction: "AMARR",
  level: 4,
  starting_agent: "Karde Romu",
  starting_system: "Kor-Azor Prime",
  description: "Amarr level 4 epic arc. Investigate a Sansha incursion into Amarr nobility, then choose to serve the Empire (The Old Guard) or the Nation (Alike Minds).",
  source_url: main.source_url ?? null,
  missions
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, missions: missions.length, branches: 2 }, null, 2));
