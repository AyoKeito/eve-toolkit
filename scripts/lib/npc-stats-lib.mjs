// Shared NPC combat-stat helpers for the SDE-driven mission scripts.
//
// enrich-missions.mjs builds a seed from a skeleton; repair-npc-stats.mjs re-derives
// the same DPS fields in place. Both must use the IDENTICAL attribute IDs + formula or
// committed seed data drifts — keeping them here is the single source of truth.

import { execFileSync } from "node:child_process";

// Attribute IDs (verified against the SDE). This is the superset; repair only reads the
// DPS-related subset, so the extra ids it pulls are harmless unused columns in its query.
export const A = {
  shieldHp: 263, armorHp: 265, hullHp: 9,
  shEm: 271, shTh: 274, shKin: 273, shExp: 272,
  arEm: 267, arTh: 270, arKin: 269, arExp: 268,
  sig: 552, maxVel: 37, orbitVel: 508, orbitRange: 2223, bounty: 481,
  dmgMult: 64, dEm: 114, dTh: 118, dKin: 117, dExp: 116,
  rofEntity: 506, rofTurret: 51, maxRange: 54, falloff: 158,
  missileBonus: 212, missileType: 507
};
export const ATTR_IDS = [...new Set(Object.values(A))];

// Build a SQL runner bound to one SDE path (sqlite3 CLI, JSON output, empty -> []).
export function makeSqlRunner(sdePath) {
  return function sql(query) {
    const out = execFileSync("sqlite3", ["-json", sdePath, query], { encoding: "utf8", maxBuffer: 1 << 28 });
    return out.trim() ? JSON.parse(out) : [];
  };
}

// SQL IN-list builder: numbers verbatim, strings single-quoted with '' escaping.
export const inList = (vals) =>
  vals.map((v) => (typeof v === "number" ? v : `'${String(v).replace(/'/g, "''")}'`)).join(",");

// Round to 2 decimals, preserving null.
export const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Resolve launched-missile per-type damage for the missile rats present in `attrs`
// (typeId -> {attrId: value}). Returns { missileTypeIds:Set, missileDmg:Map }.
export function resolveMissileDamage(sql, attrs) {
  const missileTypeIds = new Set();
  for (const at of attrs.values()) {
    const mt = at?.[A.missileType];
    if (mt) missileTypeIds.add(mt);
  }
  const missileDmg = new Map();
  if (missileTypeIds.size) {
    const tmp = new Map();
    for (const row of sql(
      `SELECT typeID id, attributeID a, COALESCE(valueFloat,valueInt) v
       FROM dgmTypeAttributes WHERE typeID IN (${inList([...missileTypeIds])})
         AND attributeID IN (${A.dEm},${A.dTh},${A.dKin},${A.dExp})`
    )) {
      if (!tmp.has(row.id)) tmp.set(row.id, {});
      tmp.get(row.id)[row.a] = row.v;
    }
    for (const [id, d] of tmp)
      missileDmg.set(id, { em: d[A.dEm] ?? 0, th: d[A.dTh] ?? 0, kin: d[A.dKin] ?? 0, exp: d[A.dExp] ?? 0 });
  }
  return { missileTypeIds, missileDmg };
}

// Turret + missile DPS for one type's attribute map `at`, given the resolved
// `missileDmg` map. Mirrors the corrected formula (entity-RoF sentinel guard at
// attr 506 == 1, per-type missile damage). Returns the 8 *_dps_* fields.
export function computeDps(at, missileDmg) {
  const r506 = at[A.rofEntity];
  const rof = r506 != null && r506 > 1 ? r506 : at[A.rofTurret] ?? null; // ms
  const mult = at[A.dmgMult] && at[A.dmgMult] > 0 ? at[A.dmgMult] : 1;

  const turretRaw = { em: at[A.dEm] ?? 0, th: at[A.dTh] ?? 0, kin: at[A.dKin] ?? 0, exp: at[A.dExp] ?? 0 };
  const turretSum = turretRaw.em + turretRaw.th + turretRaw.kin + turretRaw.exp;
  const tdps = (d) => (rof && turretSum > 0 ? r2((d * mult * 1000) / rof) : null);

  const mt = at[A.missileType];
  const md = mt ? missileDmg.get(mt) : null;
  const mBonus = at[A.missileBonus] ?? 1;
  const mdps = (d) => (rof && md ? r2((d * mBonus * 1000) / rof) : null);

  return {
    turret_dps_em: tdps(turretRaw.em),
    turret_dps_therm: tdps(turretRaw.th),
    turret_dps_kin: tdps(turretRaw.kin),
    turret_dps_exp: tdps(turretRaw.exp),
    missile_dps_em: mdps(md?.em ?? 0),
    missile_dps_therm: mdps(md?.th ?? 0),
    missile_dps_kin: mdps(md?.kin ?? 0),
    missile_dps_exp: mdps(md?.exp ?? 0)
  };
}
