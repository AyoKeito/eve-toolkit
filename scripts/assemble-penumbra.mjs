// Assemble the Penumbra (Caldari L4 epic arc) seed skeleton from the per-mission
// extraction files in tmp_penumbra/, wiring the branch DAG with explicit links +
// path labels, synthetic 901-block mission_ids, depth (arc_position), BRANCH types,
// and space_risk. Output is a skeleton seed; run scripts/enrich-missions.mjs after.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "tmp_penumbra");
const OUT = path.join(root, "tmp_penumbra_skeleton.json");

// order index -> file (id = 900 + index)
const FILES = {
  1: "01-the-intermediary.json", 2: "02-trust-and-discretion.json", 3: "03-their-loss-our-profit.json",
  4: "04-the-paths-that-are-hidden.json", 5: "05-an-honorable-betrayal.json", 6: "06-proof-of-intent.json",
  7: "07-return-to-isha.json", 8: "08-re-examining-options.json", 9: "09-two-steps-into-hell.json",
  10: "10-playing-it-safer.json", 11: "11-almost-unmasked.json", 12: "12-some-light-theatrics.json",
  13: "13-untouchable.json", 14: "14-too-close-for-comfort.json", 15: "15-the-crimson-decoy.json",
  16: "16-pre-emptive-opportunities.json", 17: "17-a-generals-best-friend.json", 18: "18-meet-sinas.json",
  19: "19-right-tool-for-the-job.json", 20: "20-the-breakout.json", 21: "21-whisper-of-a-conspiracy.json",
  22: "22-practical-solutions.json", 23: "23-forewarning.json", 24: "24-the-knowledge-to-act.json",
  25: "25-slipping-away.json", 26: "26-across-the-line.json", 27: "27-a-difference-of-opinion.json",
  28: "28-learning-by-doing.json", 29: "29-the-price-of-silence.json", 30: "30-home-in-peace.json"
};
const id = (idx) => 900 + idx;

// depth (layer) per mission_id — used as arc_position for layered layout.
const DEPTH = {
  901: 1, 902: 2, 903: 3, 904: 4, 905: 5, 906: 6, 907: 7, 908: 8,
  909: 9, 910: 9, 911: 10, 914: 10, 912: 11, 915: 11, 916: 11, 913: 12, 917: 13,
  918: 14, 919: 15, 920: 16, 921: 17, 922: 18, 923: 19,
  924: 20, 927: 20, 925: 21, 928: 21, 930: 21, 926: 22, 929: 22
};

// Story-arc branch (decision) missions -> mission_type BRANCH.
const BRANCH = new Set([904, 908, 914, 924, 927]);
const SPACE_RISK = { 909: "NULLSEC", 910: "LOWSEC" };

// Explicit DAG edges: [from, to, label]. label colours the path in the renderer.
const EDGES = [
  [901, 902, null], [902, 903, null], [903, 904, null],
  // Chapter 1 branch at The Paths That Are Hidden (904)
  [904, 905, "Hyasyoda"], [904, 909, "Nugoeihuvi"], [904, 910, "Nugoeihuvi"],
  [905, 906, "Hyasyoda"], [906, 907, "Hyasyoda"], [907, 908, "Hyasyoda"],
  [908, 909, "Hyasyoda"], [908, 910, "Hyasyoda"],
  // shared null/low choice feeds both corp continuations
  [909, 911, "Hyasyoda"], [910, 911, "Hyasyoda"],
  [909, 914, "Nugoeihuvi"], [910, 914, "Nugoeihuvi"],
  [911, 912, "Hyasyoda"], [912, 913, "Hyasyoda"], [913, 917, "Hyasyoda"],
  [914, 915, "Nugoeihuvi"], [914, 916, "Nugoeihuvi"], [915, 917, "Nugoeihuvi"], [916, 917, "Nugoeihuvi"],
  // merge -> Chapter 2 (linear)
  [917, 918, null], [918, 919, null], [919, 920, null], [920, 921, null], [921, 922, null], [922, 923, null],
  // Chapter 3 branch by allegiance, with Caldari-State "Home In Peace" alternate
  [923, 924, "Hyasyoda"], [923, 927, "Nugoeihuvi"],
  [924, 925, "Hyasyoda"], [924, 930, "Caldari State"],
  [925, 926, "Hyasyoda"],
  [927, 928, "Nugoeihuvi"], [927, 930, "Caldari State"],
  [928, 929, "Nugoeihuvi"]
];

// primary prev/next for backward-compat (detail-page neighbours).
const primaryNext = new Map();
const primaryPrev = new Map();
for (const [from, to] of EDGES) {
  if (!primaryNext.has(from)) primaryNext.set(from, to);
  if (!primaryPrev.has(to)) primaryPrev.set(to, from);
}
const linksByFrom = new Map();
for (const [from, to, label] of EDGES) {
  if (!linksByFrom.has(from)) linksByFrom.set(from, []);
  linksByFrom.get(from).push({ to, label });
}

const missions = [];
for (let idx = 1; idx <= 30; idx += 1) {
  const m = JSON.parse(fs.readFileSync(`${SRC}/${FILES[idx]}`, "utf8"));
  const mid = id(idx);
  missions.push({
    mission_id: mid,
    arc_position: DEPTH[mid],
    prev_mission_id: primaryPrev.get(mid) ?? null,
    next_mission_id: primaryNext.get(mid) ?? null,
    links: linksByFrom.get(mid) ?? [],
    name: m.name,
    level: 4,
    mission_type: BRANCH.has(mid) ? "BRANCH" : m.mission_type,
    faction: m.faction ?? null,
    is_epic_arc: true,
    damage_to_deal: m.damage_to_deal ?? null,
    damage_to_resist: m.damage_to_resist ?? null,
    recommended_ship: m.recommended_ship ?? null,
    space_risk: SPACE_RISK[mid] ?? null,
    briefing_html: m.briefing_html ?? null,
    objective_html: m.objective_html ?? null,
    reward_isk: m.reward_isk ?? null,
    reward_lp: m.reward_lp ?? null,
    reward_bonus_isk: m.reward_bonus_isk ?? null,
    bonus_time_seconds: m.bonus_time_seconds ?? null,
    source_url: `https://wiki.eveuniversity.org/${m.wiki_page.replace(/ /g, "_")}`,
    objective_items: m.objective_items ?? [],
    pockets: m.pockets ?? []
  });
}

const seed = {
  arc_id: 3,
  name: "Penumbra",
  faction: "CALDARI",
  level: 4,
  starting_agent: "Aursa Kunivuri",
  starting_system: "Josameto",
  description: "Caldari level 4 epic arc.",
  source_url: "https://wiki.eveuniversity.org/Penumbra",
  missions
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, missions: missions.length, edges: EDGES.length }, null, 2));
