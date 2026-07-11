import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { nowIso, recordSourceImport as recordSourceImportDb } from "../db.js";
import { dataDir } from "../config.js";
import { missionShipClass } from "../missions/ship-class.js";

interface MissionSeedImportSummary {
  arcs: number;
  missions: number;
  pockets: number;
  groups: number;
  npcs: number;
  objectiveItems: number;
}

interface MissionObjectiveItemSeed {
  type_id?: number | null;
  type_name: string;
  quantity: number;
  volume_m3?: number | null;
  role: string;
}

interface MissionNpcSeed {
  quantity: number;
  type_id?: number | null;
  type_name: string;
  ship_class?: string | null;
  bounty_isk?: number | null;
  signature_radius?: number | null;
  max_velocity?: number | null;
  orbit_velocity?: number | null;
  orbit_distance?: number | null;
  shield_hp?: number | null;
  armor_hp?: number | null;
  hull_hp?: number | null;
  resist_shield_em?: number | null;
  resist_shield_therm?: number | null;
  resist_shield_kin?: number | null;
  resist_shield_exp?: number | null;
  resist_armor_em?: number | null;
  resist_armor_therm?: number | null;
  resist_armor_kin?: number | null;
  resist_armor_exp?: number | null;
  turret_dps_em?: number | null;
  turret_dps_therm?: number | null;
  turret_dps_kin?: number | null;
  turret_dps_exp?: number | null;
  turret_range?: number | null;
  missile_dps_em?: number | null;
  missile_dps_therm?: number | null;
  missile_dps_kin?: number | null;
  missile_dps_exp?: number | null;
  missile_range?: number | null;
  defender_chance_pct?: number | null;
  ewar?: unknown[];
  notes?: string | null;
}

interface MissionGroupSeed {
  group_index: number;
  label?: string | null;
  distance_text?: string | null;
  trigger_text?: string | null;
  optional?: boolean | number;
  npcs?: MissionNpcSeed[];
}

interface MissionPocketSeed {
  pocket_index: number;
  name?: string | null;
  notes?: string | null;
  groups?: MissionGroupSeed[];
}

interface MissionSeed {
  mission_id: number;
  arc_position?: number | null;
  prev_mission_id?: number | null;
  next_mission_id?: number | null;
  name: string;
  level: number;
  mission_type: string;
  faction?: string | null;
  is_epic_arc?: boolean | number;
  damage_to_deal?: string | null;
  damage_to_resist?: string | null;
  recommended_ship?: string | null;
  space_risk?: string | null;
  briefing_html?: string | null;
  objective_html?: string | null;
  objective_notes?: string | null;
  reward_isk?: number | null;
  reward_lp?: number | null;
  reward_bonus_isk?: number | null;
  bonus_time_seconds?: number | null;
  source_url?: string | null;
  links?: Array<{ to: number; label?: string | null }>;
  objective_items?: MissionObjectiveItemSeed[];
  pockets?: MissionPocketSeed[];
}

interface MissionArcSeed {
  arc_id: number;
  name: string;
  faction: string;
  level: number;
  starting_agent?: string | null;
  starting_system?: string | null;
  description?: string | null;
  source_url?: string | null;
  missions?: MissionSeed[];
}

const defaultSeedDir = path.join(dataDir, "missions", "seed");

function seedArchiveLabel(dir: string): string {
  return `missions-seed:${path.basename(path.resolve(dir)) || "seed"}`;
}

function asInteger(value: number | boolean | null | undefined): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function boolToInt(value: boolean | number | null | undefined): number {
  return asInteger(value) === 1 ? 1 : 0;
}

function spaceRisk(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "LOWSEC" || normalized === "NULLSEC" || normalized === "WORMHOLE" ? normalized : null;
}

function readSeedFile(filePath: string): MissionArcSeed {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as MissionArcSeed;
}

// Build the arc's edge list. Use explicit per-mission `links` (with path labels)
// when any mission provides them; otherwise derive edges from the prev/next
// pointers so legacy seeds (no links) still render as a graph.
function arcLinkRows(arc: MissionArcSeed): Array<{ from: number; to: number; label: string | null }> {
  const missions = arc.missions ?? [];
  const hasExplicit = missions.some((mission) => (mission.links?.length ?? 0) > 0);
  const seen = new Set<string>();
  const rows: Array<{ from: number; to: number; label: string | null }> = [];
  const push = (from: number, to: number, label: string | null): void => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ from, to, label });
  };

  if (hasExplicit) {
    for (const mission of missions)
      for (const link of mission.links ?? []) push(mission.mission_id, link.to, link.label ?? null);
    return rows;
  }

  for (const mission of missions) {
    if (mission.prev_mission_id != null) push(mission.prev_mission_id, mission.mission_id, null);
    if (mission.next_mission_id != null) push(mission.mission_id, mission.next_mission_id, null);
  }
  return rows;
}

function seedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => path.join(dir, fileName));
}

function recordSourceImport(db: Db, dir: string, files: string[], importedAt: string, summary: MissionSeedImportSummary): void {
  recordSourceImportDb(
    db,
    "missions-seed",
    seedArchiveLabel(dir),
    importedAt,
    JSON.stringify({ files: files.map((file) => path.basename(file)), counts: summary }),
    null,
    null,
    { updateBuildInfo: false }
  );
}

export async function importMissionsFromSeed(db: Db, dir = defaultSeedDir): Promise<MissionSeedImportSummary> {
  const files = seedFiles(dir);
  const importedAt = nowIso();
  const summary: MissionSeedImportSummary = { arcs: 0, missions: 0, pockets: 0, groups: 0, npcs: 0, objectiveItems: 0 };

  const upsertArc = db.prepare(`
    INSERT INTO mission_arcs(
      arc_id, name, faction, level, starting_agent, starting_system, description, source_url, imported_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(arc_id) DO UPDATE SET
      name=excluded.name,
      faction=excluded.faction,
      level=excluded.level,
      starting_agent=excluded.starting_agent,
      starting_system=excluded.starting_system,
      description=excluded.description,
      source_url=excluded.source_url,
      imported_at=excluded.imported_at
  `);
  const deleteArcMissions = db.prepare("DELETE FROM missions WHERE arc_id=?");
  const deleteArcLinks = db.prepare("DELETE FROM mission_links WHERE arc_id=?");
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO mission_links(arc_id, from_mission_id, to_mission_id, label) VALUES (?, ?, ?, ?)"
  );
  const insertMission = db.prepare(`
    INSERT INTO missions(
      mission_id, arc_id, arc_position, prev_mission_id, next_mission_id, name, level, mission_type,
      faction, is_epic_arc, damage_to_deal, damage_to_resist, recommended_ship, space_risk, briefing_html,
      objective_html, objective_notes, reward_isk, reward_lp, reward_bonus_isk, bonus_time_seconds, source_url, imported_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mission_id) DO UPDATE SET
      arc_id=excluded.arc_id,
      arc_position=excluded.arc_position,
      prev_mission_id=excluded.prev_mission_id,
      next_mission_id=excluded.next_mission_id,
      name=excluded.name,
      level=excluded.level,
      mission_type=excluded.mission_type,
      faction=excluded.faction,
      is_epic_arc=excluded.is_epic_arc,
      damage_to_deal=excluded.damage_to_deal,
      damage_to_resist=excluded.damage_to_resist,
      recommended_ship=excluded.recommended_ship,
      space_risk=excluded.space_risk,
      briefing_html=excluded.briefing_html,
      objective_html=excluded.objective_html,
      objective_notes=excluded.objective_notes,
      reward_isk=excluded.reward_isk,
      reward_lp=excluded.reward_lp,
      reward_bonus_isk=excluded.reward_bonus_isk,
      bonus_time_seconds=excluded.bonus_time_seconds,
      source_url=excluded.source_url,
      imported_at=excluded.imported_at
  `);
  const insertObjectiveItem = db.prepare(`
    INSERT INTO mission_objective_items(mission_id, type_id, type_name, quantity, volume_m3, role)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPocket = db.prepare(`
    INSERT INTO mission_pockets(mission_id, pocket_index, name, notes)
    VALUES (?, ?, ?, ?)
  `);
  const insertGroup = db.prepare(`
    INSERT INTO mission_groups(pocket_id, group_index, label, distance_text, trigger_text, optional)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertNpc = db.prepare(`
    INSERT INTO mission_npcs(
      group_id, quantity, type_id, type_name, ship_class, bounty_isk, signature_radius, max_velocity,
      orbit_velocity, orbit_distance, shield_hp, armor_hp, hull_hp,
      resist_shield_em, resist_shield_therm, resist_shield_kin, resist_shield_exp,
      resist_armor_em, resist_armor_therm, resist_armor_kin, resist_armor_exp,
      turret_dps_em, turret_dps_therm, turret_dps_kin, turret_dps_exp, turret_range,
      missile_dps_em, missile_dps_therm, missile_dps_kin, missile_dps_exp, missile_range,
      defender_chance_pct, ewar_json, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const typeGroup = db.prepare("SELECT group_name FROM types WHERE type_id=?");

  const tx = db.transaction(() => {
    for (const file of files) {
      const arc = readSeedFile(file);
      upsertArc.run(
        arc.arc_id,
        arc.name,
        arc.faction,
        arc.level,
        arc.starting_agent ?? null,
        arc.starting_system ?? null,
        arc.description ?? null,
        arc.source_url ?? null,
        importedAt
      );
      deleteArcMissions.run(arc.arc_id);
      deleteArcLinks.run(arc.arc_id);
      for (const link of arcLinkRows(arc)) insertLink.run(arc.arc_id, link.from, link.to, link.label);
      summary.arcs += 1;

      for (const mission of arc.missions ?? []) {
        insertMission.run(
          mission.mission_id,
          arc.arc_id,
          asInteger(mission.arc_position),
          asInteger(mission.prev_mission_id),
          asInteger(mission.next_mission_id),
          mission.name,
          mission.level,
          mission.mission_type,
          mission.faction ?? null,
          boolToInt(mission.is_epic_arc),
          mission.damage_to_deal ?? null,
          mission.damage_to_resist ?? null,
          mission.recommended_ship ?? null,
          spaceRisk(mission.space_risk),
          mission.briefing_html ?? null,
          mission.objective_html ?? null,
          mission.objective_notes ?? null,
          asInteger(mission.reward_isk),
          asInteger(mission.reward_lp),
          asInteger(mission.reward_bonus_isk),
          asInteger(mission.bonus_time_seconds),
          mission.source_url ?? null,
          importedAt
        );
        summary.missions += 1;

        for (const item of mission.objective_items ?? []) {
          insertObjectiveItem.run(
            mission.mission_id,
            asInteger(item.type_id),
            item.type_name,
            asInteger(item.quantity) ?? 0,
            item.volume_m3 ?? null,
            item.role
          );
          summary.objectiveItems += 1;
        }

        for (const pocket of mission.pockets ?? []) {
          const pocketResult = insertPocket.run(mission.mission_id, pocket.pocket_index, pocket.name ?? null, pocket.notes ?? null);
          const pocketId = Number(pocketResult.lastInsertRowid);
          summary.pockets += 1;

          for (const group of pocket.groups ?? []) {
            const groupResult = insertGroup.run(
              pocketId,
              group.group_index,
              group.label ?? null,
              group.distance_text ?? null,
              group.trigger_text ?? null,
              boolToInt(group.optional)
            );
            const groupId = Number(groupResult.lastInsertRowid);
            summary.groups += 1;

            for (const npc of group.npcs ?? []) {
              const typeId = asInteger(npc.type_id);
              const typeRow =
                typeId === null ? null : (typeGroup.get(typeId) as { group_name: string | null } | undefined | null);
              insertNpc.run(
                groupId,
                asInteger(npc.quantity) ?? 1,
                typeId,
                npc.type_name,
                missionShipClass(npc.type_name, typeRow?.group_name, npc.ship_class),
                asInteger(npc.bounty_isk),
                npc.signature_radius ?? null,
                npc.max_velocity ?? null,
                npc.orbit_velocity ?? null,
                npc.orbit_distance ?? null,
                asInteger(npc.shield_hp),
                asInteger(npc.armor_hp),
                asInteger(npc.hull_hp),
                npc.resist_shield_em ?? null,
                npc.resist_shield_therm ?? null,
                npc.resist_shield_kin ?? null,
                npc.resist_shield_exp ?? null,
                npc.resist_armor_em ?? null,
                npc.resist_armor_therm ?? null,
                npc.resist_armor_kin ?? null,
                npc.resist_armor_exp ?? null,
                npc.turret_dps_em ?? null,
                npc.turret_dps_therm ?? null,
                npc.turret_dps_kin ?? null,
                npc.turret_dps_exp ?? null,
                npc.turret_range ?? null,
                npc.missile_dps_em ?? null,
                npc.missile_dps_therm ?? null,
                npc.missile_dps_kin ?? null,
                npc.missile_dps_exp ?? null,
                npc.missile_range ?? null,
                npc.defender_chance_pct ?? null,
                JSON.stringify(npc.ewar ?? []),
                npc.notes ?? null
              );
              summary.npcs += 1;
            }
          }
        }
      }
    }
    recordSourceImport(db, dir, files, importedAt, summary);
  });

  tx();
  return summary;
}
