// Assemble "Angel Sound" (Angel Cartel L3 epic arc, arc_id 6) seed.
//
// chruker has 13 of the 18 missions (228-240, 243); the other five —
// Headhunted (third entry), the Heaven-path tail (Ride to the Rescue, The Best
// Kind of Revenge, Wrath of Angels) and Breaking the Lock — exist only on the
// EVE University wiki and were hand-built as skeletons in
// tmp_arcs/angel_wiki/*.json with synthetic 1100-block ids (SDE enrichment
// fills their NPC stats). Structure and per-mission metadata come from the
// wiki overlay tmp_arcs/wiki_angel.json — the wiki is authoritative.
//
// Usage: node scripts/assemble-angel-sound.mjs   (then SDE-enrich on the Linux host)
import fs from "node:fs";

const OUT = "tmp_arcs/seed_angel.json";

const main = JSON.parse(fs.readFileSync("tmp_arcs/angel_main.json", "utf8"));
const byId = new Map();
for (const m of main.missions) byId.set(m.mission_id, m);
for (const id of [228, 233, 240]) {
  const part = JSON.parse(fs.readFileSync(`tmp_arcs/angel_${id}.json`, "utf8"));
  for (const m of part.missions) if (!byId.has(m.mission_id)) byId.set(m.mission_id, m);
}

// Wiki-built skeletons -> synthetic ids (chruker has no pages for these).
const WIKI_BUILT = {
  1101: "headhunted",
  1102: "ride-to-the-rescue",
  1103: "the-best-kind-of-revenge",
  1104: "wrath-of-angels",
  1105: "breaking-the-lock"
};
for (const [id, file] of Object.entries(WIKI_BUILT)) {
  const s = JSON.parse(fs.readFileSync(`tmp_arcs/angel_wiki/${file}.json`, "utf8"));
  byId.set(Number(id), {
    mission_id: Number(id),
    name: s.name,
    level: 3,
    mission_type: s.mission_type,
    faction: s.faction ?? null,
    is_epic_arc: true,
    damage_to_deal: s.damage_to_deal ?? null,
    damage_to_resist: s.damage_to_resist ?? null,
    recommended_ship: s.recommended_ship ?? null,
    briefing_html: s.briefing_html ?? null,
    objective_html: s.objective_html ?? null,
    reward_isk: s.reward_isk ?? null,
    reward_lp: s.reward_lp ?? null,
    reward_bonus_isk: s.reward_bonus_isk ?? null,
    bonus_time_seconds: s.bonus_time_seconds ?? null,
    source_url: `https://wiki.eveuniversity.org/${s.wiki_page.replace(/ /g, "_")}`,
    objective_items: s.objective_items ?? [],
    pockets: s.pockets ?? []
  });
}

const overlay = new Map();
for (const o of JSON.parse(fs.readFileSync("tmp_arcs/wiki_angel.json", "utf8")))
  overlay.set(Number(String(o.id).replace(/^W/, "")), o);

// Depth = layout row. Three alternate entries share row 1; Heaven and Utopia
// share rows 4-7; the asymmetric Chapter 3 paths share row 10 (Path B's single
// mission sits beside Path A's first).
const DEPTH = {
  228: 1, 229: 1, 1101: 1,
  230: 2, 231: 3,
  233: 4, 1102: 5, 1103: 6, 1104: 7, // Heaven
  232: 4, 234: 5, 235: 6, 236: 7, // Utopia
  237: 8, 238: 9,
  240: 10, 1105: 11, // stealth path
  239: 10, // assault path
  243: 12
};

const HEAVEN = "Heaven";
const UTOPIA = "Utopia";
const STEALTH = "Stealth path";
const ASSAULT = "Assault path";
const EDGES = [
  [228, 230, "Minmatar start"], [229, 230, "Amarr start"], [1101, 230, "Angel Cartel start"],
  [230, 231, null],
  [231, 233, HEAVEN], [233, 1102, HEAVEN], [1102, 1103, HEAVEN], [1103, 1104, HEAVEN], [1104, 237, HEAVEN],
  [231, 232, UTOPIA], [232, 234, UTOPIA], [234, 235, UTOPIA], [235, 236, UTOPIA], [236, 237, UTOPIA],
  [237, 238, null],
  [238, 240, STEALTH], [240, 1105, STEALTH], [1105, 243, STEALTH],
  [238, 239, ASSAULT], [239, 243, ASSAULT]
];

const BRANCH = new Set([231, 238]);

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
  arc_id: 6,
  name: "Angel Sound",
  faction: "ANGEL CARTEL",
  level: 3,
  starting_agent: "Abdiel Verat",
  starting_system: "K-QWHE",
  description:
    "Angel Cartel level 3 epic arc set in Curse nullsec. Three alternate entry agents (Minmatar, Amarr, or Cartel standings) funnel to K-QWHE; rewards +30% base Angel Cartel standing and a Cynabal blueprint copy.",
  source_url: "https://wiki.eveuniversity.org/Angel_Sound",
  missions
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, missions: missions.length, edges: EDGES.length }, null, 2));
