// In-place, idempotent repair of NPC combat stats in data/missions/seed/*.json.
//
// Two historical bugs corrupted committed seed data:
//   1. The entity rate-of-fire sentinel (attr 506 == 1.0) was used as a literal
//      1ms cycle time, inflating turret/missile DPS by ~2500x.
//   2. The scraper's parseNumber treated the meters unit "m" as mega (x1e6),
//      inflating some turret_range / missile_range values by 1,000,000x.
// EWAR arrays were also N-fold duplicated by table rowspans.
//
// This script:
//   (a) recomputes turret_dps_* / missile_dps_* from the SDE using the SAME
//       corrected formula as scripts/enrich-missions.mjs (keep them in sync),
//   (b) divides turret_range / missile_range by 1e6 when > 1e6,
//   (c) dedupes ewar arrays by type+text.
// Hand-curated fields (faction, notes, ship_class, missile_range when sane,
// orbit_distance, etc.) are preserved. Re-running on clean data is a no-op.
//
// Usage: node scripts/repair-npc-stats.mjs [--sde=data/sde/sqlite-latest.sqlite] [--dry]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgParser } from "./lib/args.mjs";
import { ATTR_IDS, makeSqlRunner, inList, resolveMissileDamage, computeDps } from "./lib/npc-stats-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const { arg } = makeArgParser(argv);
const dryRun = argv.includes("--dry");
const sdePath = arg("sde", path.resolve(here, "../data/sde/sqlite-latest.sqlite"));
const seedDir = arg("dir", path.resolve(here, "../data/missions/seed"));

const sql = makeSqlRunner(sdePath);

// 1. Load every seed file and collect the NPC type ids that need stats.
const files = fs.readdirSync(seedDir).filter((f) => f.endsWith(".json"));
const seeds = files.map((file) => ({ file, data: JSON.parse(fs.readFileSync(path.join(seedDir, file), "utf8")) }));

const eachNpc = function* () {
  for (const { file, data } of seeds)
    for (const m of data.missions ?? [])
      for (const p of m.pockets ?? [])
        for (const g of p.groups ?? [])
          for (const npc of g.npcs ?? []) yield { file, npc };
};

const typeIds = new Set();
for (const { npc } of eachNpc()) if (typeof npc.type_id === "number") typeIds.add(npc.type_id);

// 2. Pull combat attributes for those types.
const attrs = new Map(); // typeId -> {attrId: value}
if (typeIds.size) {
  for (const row of sql(
    `SELECT typeID id, attributeID a, COALESCE(valueFloat,valueInt) v
     FROM dgmTypeAttributes WHERE typeID IN (${inList([...typeIds])}) AND attributeID IN (${inList(ATTR_IDS)})`
  )) {
    if (!attrs.has(row.id)) attrs.set(row.id, {});
    attrs.get(row.id)[row.a] = row.v;
  }
}

// 3. Pull launched-missile per-type damage for missile rats.
const { missileTypeIds, missileDmg } = resolveMissileDamage(sql, attrs);

// 4. Recompute stats per NPC (DPS formula shared with enrich via npc-stats-lib).
const fixRange = (v) => (typeof v === "number" && v > 1e6 ? Math.trunc(v / 1e6) : v);

function dedupeEwar(ewar) {
  if (!Array.isArray(ewar)) return ewar;
  const seen = new Set();
  const out = [];
  for (const e of ewar) {
    const key = `${e?.type} ${e?.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

let changed = 0;
let touchedFiles = new Set();
for (const { file, npc } of eachNpc()) {
  const before = JSON.stringify(npc);

  if (typeof npc.type_id === "number" && attrs.has(npc.type_id)) {
    Object.assign(npc, computeDps(attrs.get(npc.type_id), missileDmg));
  }
  if ("turret_range" in npc) npc.turret_range = fixRange(npc.turret_range);
  if ("missile_range" in npc) npc.missile_range = fixRange(npc.missile_range);
  if (Array.isArray(npc.ewar)) npc.ewar = dedupeEwar(npc.ewar);

  if (JSON.stringify(npc) !== before) {
    changed += 1;
    touchedFiles.add(file);
  }
}

// 5. Write back the files that changed (stable 2-space JSON + trailing newline).
if (!dryRun) {
  for (const { file, data } of seeds) {
    if (touchedFiles.has(file)) {
      fs.writeFileSync(path.join(seedDir, file), `${JSON.stringify(data, null, 2)}\n`);
    }
  }
}

console.log(
  JSON.stringify(
    { dryRun, npcsChanged: changed, filesChanged: [...touchedFiles].sort(), types: typeIds.size, missiles: missileTypeIds.size },
    null,
    2
  )
);
