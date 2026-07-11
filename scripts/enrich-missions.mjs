// Enrich a mission "skeleton" seed with NPC combat stats pulled from the local SDE.
//
// Mission *content* (briefings, objectives, pockets, spawn structure, branches) is
// NOT in the SDE and must be hand-authored in the skeleton. NPC *stats* (HP, resists,
// signature, velocity, bounty, DPS) ARE in dgmTypeAttributes, so we resolve each rat's
// type_name -> type_id -> stats here. Output matches data/missions/seed/*.json schema.
//
// Usage:
//   node scripts/enrich-missions.mjs --in=<skeleton.json> --out=<seed.json> [--sde=data/sde/sqlite-latest.sqlite]
//
// In the skeleton, each NPC needs at minimum { quantity, type_name }. Optional fields
// (ewar, notes, orbit_distance, etc.) are preserved. Everything else is filled here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgParser } from "./lib/args.mjs";
import { A, ATTR_IDS, makeSqlRunner, inList, r2, resolveMissileDamage, computeDps } from "./lib/npc-stats-lib.mjs";
import { missionShipClass } from "./lib/ship-class.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const { arg } = makeArgParser(process.argv.slice(2));

const inPath = arg("in");
const outPath = arg("out");
const sdePath = arg("sde", path.resolve(here, "../data/sde/sqlite-latest.sqlite"));
if (!inPath || !outPath) {
  console.error("Usage: node scripts/enrich-missions.mjs --in=skeleton.json --out=seed.json [--sde=...]");
  process.exit(2);
}

const sql = makeSqlRunner(sdePath);

const seed = JSON.parse(fs.readFileSync(inPath, "utf8"));

// 1. Collect distinct rat names.
const names = new Set();
for (const m of seed.missions ?? [])
  for (const p of m.pockets ?? [])
    for (const g of p.groups ?? [])
      for (const npc of g.npcs ?? []) if (npc.type_name) names.add(npc.type_name);

// 2. Resolve names -> type_id (+ group name for ship_class).
const nameToType = new Map();
if (names.size) {
  for (const row of sql(
    `SELECT t.typeID id, t.typeName name, g.groupName grp
     FROM invTypes t LEFT JOIN invGroups g ON g.groupID=t.groupID
     WHERE t.typeName IN (${inList([...names])})`
  )) {
    nameToType.set(row.name, { id: row.id, group: row.grp });
  }
}
// Non-resolving names are usually structures/containers (objectives, not rats):
// keep them with null stats + a note rather than failing the whole build.
const missing = [...names].filter((n) => !nameToType.has(n));
if (missing.length) {
  console.warn(`WARN: ${missing.length} type_name(s) not in SDE invTypes (kept as no-stat entries):\n  ${missing.join("\n  ")}`);
}

// 3. Pull attributes for every resolved type.
const typeIds = [...nameToType.values()].map((v) => v.id);
const attrs = new Map(); // typeId -> {attrId: value}
if (typeIds.length) {
  for (const row of sql(
    `SELECT typeID id, attributeID a, COALESCE(valueFloat,valueInt) v
     FROM dgmTypeAttributes WHERE typeID IN (${inList(typeIds)}) AND attributeID IN (${inList(ATTR_IDS)})`
  )) {
    if (!attrs.has(row.id)) attrs.set(row.id, {});
    attrs.get(row.id)[row.a] = row.v;
  }
}

// 4. For missile rats, pull the launched missile's per-type damage.
const { missileTypeIds, missileDmg } = resolveMissileDamage(sql, attrs);

const resist = (resonance) => (resonance == null ? null : Math.round((1 - resonance) * 100));
const tInt = (n) => (n == null ? null : Math.trunc(n));

// 5. Enrich each NPC in place (preserve any author-provided fields).
let filled = 0;
for (const m of seed.missions ?? [])
  for (const p of m.pockets ?? [])
    for (const g of p.groups ?? [])
      for (const npc of g.npcs ?? []) {
        if (!npc.type_name) continue;
        const resolved = nameToType.get(npc.type_name);
        if (!resolved) {
          // Structure/container/objective entity not in invTypes: keep name + count, no stats.
          npc.ship_class = npc.ship_class ?? null;
          npc.notes = npc.notes ?? "Non-combat structure (no SDE stats)";
          continue;
        }
        const { id, group } = resolved;
        const at = attrs.get(id) ?? {};
        // Turret + missile DPS share the corrected entity-RoF formula (see npc-stats-lib).
        const dps = computeDps(at, missileDmg);

        const enriched = {
          quantity: npc.quantity ?? 1,
          type_id: id,
          type_name: npc.type_name,
          ship_class: missionShipClass(npc.type_name, group, npc.ship_class),
          bounty_isk: tInt(at[A.bounty]),
          signature_radius: at[A.sig] != null ? r2(at[A.sig]) : null,
          max_velocity: at[A.maxVel] != null ? r2(at[A.maxVel]) : null,
          orbit_velocity: at[A.orbitVel] != null ? r2(at[A.orbitVel]) : null,
          orbit_distance: npc.orbit_distance ?? (at[A.orbitRange] != null ? tInt(at[A.orbitRange]) : null),
          shield_hp: tInt(at[A.shieldHp]),
          armor_hp: tInt(at[A.armorHp]),
          hull_hp: tInt(at[A.hullHp]),
          resist_shield_em: resist(at[A.shEm]),
          resist_shield_therm: resist(at[A.shTh]),
          resist_shield_kin: resist(at[A.shKin]),
          resist_shield_exp: resist(at[A.shExp]),
          resist_armor_em: resist(at[A.arEm]),
          resist_armor_therm: resist(at[A.arTh]),
          resist_armor_kin: resist(at[A.arKin]),
          resist_armor_exp: resist(at[A.arExp]),
          turret_range: at[A.maxRange] != null ? tInt(at[A.maxRange]) : null,
          turret_dps_em: dps.turret_dps_em,
          turret_dps_therm: dps.turret_dps_therm,
          turret_dps_kin: dps.turret_dps_kin,
          turret_dps_exp: dps.turret_dps_exp,
          missile_range: npc.missile_range ?? null,
          missile_dps_em: dps.missile_dps_em,
          missile_dps_therm: dps.missile_dps_therm,
          missile_dps_kin: dps.missile_dps_kin,
          missile_dps_exp: dps.missile_dps_exp,
          defender_chance_pct: npc.defender_chance_pct ?? null,
          ewar: npc.ewar ?? [],
          notes: npc.notes ?? null
        };
        // Replace the npc's contents in place to keep array order/object identity.
        for (const k of Object.keys(npc)) delete npc[k];
        Object.assign(npc, enriched);
        filled += 1;
      }

// 6. Resolve objective-item type_ids (any category) by name.
const itemNames = new Set();
for (const m of seed.missions ?? [])
  for (const it of m.objective_items ?? []) if (it.type_name && it.type_id == null) itemNames.add(it.type_name);
if (itemNames.size) {
  const itemMap = new Map();
  for (const row of sql(`SELECT typeID id, typeName name, volume FROM invTypes WHERE typeName IN (${inList([...itemNames])})`))
    itemMap.set(row.name, { id: row.id, volume: row.volume });
  for (const m of seed.missions ?? [])
    for (const it of m.objective_items ?? []) {
      const hit = itemMap.get(it.type_name);
      if (hit) {
        it.type_id = it.type_id ?? hit.id;
        if (it.volume_m3 == null && hit.volume != null) it.volume_m3 = hit.volume;
      } else if (it.type_id === undefined) {
        it.type_id = null;
      }
    }
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(seed, null, 2)}\n`);
console.log(JSON.stringify({ out: outPath, npcs: filled, types: nameToType.size, missiles: missileTypeIds.size }, null, 2));
