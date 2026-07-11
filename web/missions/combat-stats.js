// DOM-free combat math for the mission detail page: per-NPC DPS/quantity helpers,
// structure detection, and the aggregate/summary reducers that feed the hero ribbon and
// the pocket/group chrome. Split out of detail.js so the numbers can be reasoned about
// (and tested) without a DOM. This module holds no mutable app state — the active fit
// profile is threaded in explicitly by every caller.
import { DAMAGE_TYPES } from "./missions-util.js";
import { effectiveMultiplier } from "./fit-profile.js";
import { ewarMapping, EWAR_META, parseEwarText } from "./missions-ewar.js";

export function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function npcQty(npc) {
  const n = Number(npc.quantity);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Raw (profile-agnostic) DPS of one NPC for a damage type: turret + missile. Callers
// multiply by quantity where a group total is needed.
export function npcRawDps(npc, key) {
  return numOrZero(npc[`turret_dps_${key}`]) + numOrZero(npc[`missile_dps_${key}`]);
}

// Heuristic structure detection — no DB flag, so infer.
export function isStructure(npc) {
  const totalHp = numOrZero(npc.shield_hp) + numOrZero(npc.armor_hp) + numOrZero(npc.hull_hp);
  const totalDps = DAMAGE_TYPES.reduce((s, t) => s + npcRawDps(npc, t.key), 0);
  if (totalDps > 0) return false;
  const cls = String(npc.ship_class || "").toLowerCase();
  if (/(structure|stargate|station|gate|beacon|container|wreck|monument|outpost|asteroid|deposit|tower|warehouse)/.test(cls)) return true;
  if (totalHp === 0) return true;
  return false;
}

// Total incoming cap-neutralisation (GJ/s) across the given NPCs × quantity. null when none.
export function aggregateNeutPressure(npcs) {
  let total = 0;
  for (const npc of npcs ?? []) {
    const qty = npcQty(npc);
    const seen = new Set();
    for (const effect of npc.ewar || []) {
      const map = ewarMapping(effect?.type, effect?.text);
      if (map.kind !== "neut") continue;
      const key = `${effect?.type}|${effect?.text || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = parseEwarText(effect?.text || "");
      if (p.gjPerSec != null) total += p.gjPerSec * qty;
    }
  }
  return total > 0 ? total : null;
}

const SEVERITY_ORDER = { danger: 0, warning: 1, info: 2 };

export function aggregateCombatStats(npcs, profile) {
  const dpsTotals = { em: 0, therm: 0, kin: 0, exp: 0 };
  const rawTotals = { em: 0, therm: 0, kin: 0, exp: 0 };
  const ewarCounts = new Map();
  let totalDps = 0;
  let totalRawDps = 0;
  for (const npc of npcs ?? []) {
    const qty = npcQty(npc);
    for (const t of DAMAGE_TYPES) {
      const raw = npcRawDps(npc, t.key) * qty;
      const eff = raw * effectiveMultiplier(profile, t.key);
      dpsTotals[t.key] += eff;
      rawTotals[t.key] += raw;
      totalDps += eff;
      totalRawDps += raw;
    }
    const seenKinds = new Set();
    for (const effect of npc.ewar || []) {
      const map = ewarMapping(effect?.type, effect?.text);
      const p = parseEwarText(effect?.text || "");
      // Count each NPC once per kind, but let every effect compete for the
      // worst-case params (an NPC can carry two neuts with different GJ/s).
      const firstOfKind = !seenKinds.has(map.kind);
      seenKinds.add(map.kind);
      const existing = ewarCounts.get(map.kind);
      if (existing) {
        if (firstOfKind) existing.count += qty;
        if (p.rangeKm != null) existing.worstRange = Math.max(existing.worstRange ?? 0, p.rangeKm);
        // "Worst" = strongest effect, i.e. largest magnitude. Painters carry a positive
        // strength (+75% signature bloom is worse than +38%), webs/damps/TDs a negative one
        // (-75% is worse than -50%), so the strongest is the largest ABSOLUTE value — a plain
        // Math.min silently picked the weakest painter, and Math.max would pick the weakest web.
        if (p.strengthPct != null) {
          existing.worstStr =
            existing.worstStr == null || Math.abs(p.strengthPct) > Math.abs(existing.worstStr)
              ? p.strengthPct
              : existing.worstStr;
        }
        if (p.gjPerSec != null) existing.worstGj = Math.max(existing.worstGj ?? 0, p.gjPerSec);
        if (p.points != null) existing.worstPts = Math.max(existing.worstPts ?? 0, p.points);
        if (p.chancePct != null) existing.worstChance = Math.max(existing.worstChance ?? 0, p.chancePct);
      } else {
        ewarCounts.set(map.kind, {
          kind: map.kind,
          label: map.label,
          count: qty,
          severity: EWAR_META[map.kind]?.severity ?? "warning",
          worstRange: p.rangeKm,
          worstStr: p.strengthPct,
          worstGj: p.gjPerSec,
          worstPts: p.points,
          worstChance: p.chancePct
        });
      }
    }
  }
  const dpsByType = DAMAGE_TYPES.map((t) => ({
    key: t.key,
    label: t.label,
    full: t.full,
    value: dpsTotals[t.key],
    raw: rawTotals[t.key],
    pct: totalDps > 0 ? Math.round((100 * dpsTotals[t.key]) / totalDps) : 0
  }));
  const ewar = [...ewarCounts.values()].sort((a, b) => {
    const sev = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return sev !== 0 ? sev : b.count - a.count;
  });
  return { totalDps, totalRawDps, dpsByType, ewar, neutGjPerSec: aggregateNeutPressure(npcs) };
}

export function flattenNpcs(scope) {
  const out = [];
  for (const pocket of scope.pockets || []) {
    for (const group of pocket.groups || []) {
      for (const npc of group.npcs || []) out.push(npc);
    }
  }
  for (const group of scope.groups || []) {
    for (const npc of group.npcs || []) out.push(npc);
  }
  return out;
}

export function computeSummary(mission, profile) {
  let peakDps = 0;
  let peakPocket = "—";
  let peakNeut = 0;
  let totalGroups = 0;
  let totalShips = 0;
  let totalHp = 0;
  const dealAccum = { em: 0, therm: 0, kin: 0, exp: 0 };
  let dealWeight = 0;

  for (const pocket of mission.pockets || []) {
    let pocketDps = 0;
    for (const group of pocket.groups || []) {
      totalGroups += 1;
      for (const npc of group.npcs || []) {
        const qty = npcQty(npc);
        totalShips += qty;
        totalHp += qty * (numOrZero(npc.shield_hp) + numOrZero(npc.armor_hp) + numOrZero(npc.hull_hp));
        const structure = isStructure(npc);
        for (const t of DAMAGE_TYPES) {
          const raw = npcRawDps(npc, t.key) * qty;
          pocketDps += raw * effectiveMultiplier(profile, t.key);
        }
        if (!structure) {
          const shieldHp = numOrZero(npc.shield_hp);
          const armorHp = numOrZero(npc.armor_hp);
          const tankHp = shieldHp + armorHp;
          if (tankHp > 0) {
            for (const t of DAMAGE_TYPES) {
              dealAccum[t.key] +=
                qty *
                (shieldHp * numOrZero(npc[`resist_shield_${t.key}`]) + armorHp * numOrZero(npc[`resist_armor_${t.key}`]));
            }
            dealWeight += qty * tankHp;
          }
        }
      }
    }
    if (pocketDps > peakDps) {
      peakDps = pocketDps;
      peakPocket = pocket.name || `Pocket ${(pocket.pocket_index ?? 0) + 1}`;
    }
    const pocketNeut = aggregateNeutPressure(flattenNpcs({ pockets: [pocket] })) ?? 0;
    if (pocketNeut > peakNeut) peakNeut = pocketNeut;
  }

  const missionStats = aggregateCombatStats(flattenNpcs(mission), profile);
  const tank = missionStats.dpsByType.filter((x) => x.pct >= 5).sort((a, b) => b.pct - a.pct);
  const deal = DAMAGE_TYPES.map((t) => ({
    key: t.key,
    label: t.full,
    short: t.label,
    avg: dealWeight > 0 ? dealAccum[t.key] / dealWeight : 0
  })).sort((a, b) => a.avg - b.avg);

  return {
    tank,
    deal,
    dealWeight,
    peakDps,
    peakPocket,
    totalGroups,
    totalShips,
    totalHp,
    ewar: missionStats.ewar,
    neutGjPerSec: peakNeut > 0 ? peakNeut : null
  };
}
