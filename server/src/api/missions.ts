import type { FastifyInstance, FastifyRequest } from "fastify";
import { countRows, type Db } from "../db.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { setHealthCacheHeaders, setMissionsCacheHeaders } from "../lib/api-cache-headers.js";
import { missionShipClass } from "../missions/ship-class.js";
import { parseInteger } from "../lib/parse.js";
import { pushToMapList, sqlPlaceholders } from "../lib/sql.js";
import { escapeLike, first, type QueryRecord, type QueryValue } from "./query.js";
const maxMissionRows = 500;

interface MissionListRow {
  mission_id: number;
  name: string;
  level: number;
  mission_type: string;
  faction: string | null;
  arc_id: number | null;
  arc_name: string | null;
  arc_position: number | null;
  damage_to_deal: string | null;
  damage_to_resist: string | null;
  recommended_ship: string | null;
  space_risk: string | null;
  reward_isk: number | null;
  reward_lp: number | null;
  bonus_time_seconds: number | null;
}

interface MissionRow extends MissionListRow {
  prev_mission_id: number | null;
  next_mission_id: number | null;
  is_epic_arc: number;
  briefing_html: string | null;
  objective_html: string | null;
  objective_notes: string | null;
  reward_bonus_isk: number | null;
  source_url: string | null;
  imported_at: string;
}

interface ArcRow {
  arc_id: number;
  name: string;
  faction: string;
  level: number;
  starting_agent: string | null;
  starting_system: string | null;
  description: string | null;
  source_url: string | null;
  imported_at: string;
}

interface MissionPocketRow {
  pocket_id: number;
  mission_id: number;
  pocket_index: number;
  name: string | null;
  notes: string | null;
}

interface MissionGroupRow {
  group_id: number;
  pocket_id: number;
  group_index: number;
  label: string | null;
  distance_text: string | null;
  trigger_text: string | null;
  optional: number;
}

interface MissionNpcRow {
  npc_id: number;
  group_id: number;
  ewar_json: string;
  type_name: string;
  ship_class: string | null;
  type_group_name: string | null;
  [key: string]: unknown;
}

function query(request: FastifyRequest): QueryRecord {
  return request.query as QueryRecord;
}

function parseIntegerQuery(value: QueryValue): number | null {
  return parseInteger(first(value));
}

function parseLimit(value: QueryValue): number {
  const parsed = parseIntegerQuery(value);
  if (parsed === null || parsed <= 0) return 200;
  return Math.min(parsed, maxMissionRows);
}

function textFilter(value: QueryValue): string | null {
  const raw = first(value)?.trim();
  return raw ? raw : null;
}

function parseEwar(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const ewarTypeOrder = ["WEB", "SCRAMBLE", "DISRUPT", "DRAIN", "SENSOR_DAMP", "PAINTING", "ECM", "TRACKING_DISRUPT"];

function ewarOrderValue(type: string): number {
  const index = ewarTypeOrder.indexOf(type);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function orderedEwarTypes(types: Iterable<string>): string[] {
  return [...types].sort((a, b) => ewarOrderValue(a) - ewarOrderValue(b) || a.localeCompare(b));
}

function arcEwarTypesByMission(db: Db, arcId: number): Map<number, string[]> {
  const rows = db
    .prepare(
      `
        SELECT p.mission_id, n.ewar_json
        FROM mission_pockets p
        JOIN missions m ON m.mission_id = p.mission_id
        JOIN mission_groups g ON g.pocket_id = p.pocket_id
        JOIN mission_npcs n ON n.group_id = g.group_id
        WHERE m.arc_id=?
      `
    )
    .all(arcId) as Array<{ mission_id: number; ewar_json: string }>;
  const typesByMission = new Map<number, Set<string>>();

  for (const row of rows) {
    for (const effect of parseEwar(row.ewar_json)) {
      if (typeof effect !== "object" || effect === null || !("type" in effect) || typeof effect.type !== "string") continue;
      const rowsForMission = typesByMission.get(row.mission_id) ?? new Set<string>();
      rowsForMission.add(effect.type);
      typesByMission.set(row.mission_id, rowsForMission);
    }
  }

  return new Map([...typesByMission].map(([missionId, types]) => [missionId, orderedEwarTypes(types)]));
}

function unwrapObjectiveItemLinks(html: string | null): string | null {
  return html?.replace(/<a\b(?=[^>]*\bhref=["']item\.php\?type_id=\d+["'])[^>]*>([\s\S]*?)<\/a>/gi, "$1") ?? null;
}

function missionListRows(db: Db, request: FastifyRequest): MissionListRow[] {
  const q = query(request);
  const where: string[] = [];
  const params: Array<string | number> = [];
  const level = parseIntegerQuery(q.level);
  const arcId = parseIntegerQuery(q.arc);
  const faction = textFilter(q.faction);
  const type = textFilter(q.type);
  const search = textFilter(q.search);
  const limit = parseLimit(q.n);

  if (level !== null) {
    where.push("m.level = ?");
    params.push(level);
  }
  if (arcId !== null) {
    where.push("m.arc_id = ?");
    params.push(arcId);
  }
  if (faction) {
    where.push("m.faction LIKE ? COLLATE NOCASE ESCAPE '\\'");
    params.push(`%${escapeLike(faction)}%`);
  }
  if (type) {
    where.push("m.mission_type = ? COLLATE NOCASE");
    params.push(type);
  }
  if (search) {
    where.push(
      "(m.name LIKE ? COLLATE NOCASE ESCAPE '\\' OR m.faction LIKE ? COLLATE NOCASE ESCAPE '\\' OR m.objective_html LIKE ? COLLATE NOCASE ESCAPE '\\')"
    );
    const pattern = `%${escapeLike(search)}%`;
    params.push(pattern, pattern, pattern);
  }

  const sql = `
    SELECT
      m.mission_id, m.name, m.level, m.mission_type, m.faction, m.arc_id, a.name AS arc_name,
      m.arc_position, m.damage_to_deal, m.damage_to_resist, m.recommended_ship, m.space_risk,
      m.reward_isk, m.reward_lp, m.bonus_time_seconds
    FROM missions m
    LEFT JOIN mission_arcs a ON a.arc_id = m.arc_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.name COLLATE NOCASE ASC, m.arc_position IS NULL ASC, m.arc_position ASC, m.name COLLATE NOCASE ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit) as MissionListRow[];
}

function missionNeighbor(db: Db, id: number | null): { id: number; name: string } | null {
  if (id === null) return null;
  const row = db.prepare("SELECT mission_id AS id, name FROM missions WHERE mission_id=?").get(id) as
    | { id: number; name: string }
    | undefined;
  return row ?? null;
}

interface MissionNextOption {
  id: number;
  name: string;
  label: string | null;
  mission_type: string;
  space_risk: string | null;
}

// All outgoing arc edges from this mission. `next_mission_id` is a single linear
// pointer, so on a fork ("Choose your path") it picks one branch arbitrarily —
// mission_links holds the real fan-out, with per-path labels where the seed has them.
function missionNextOptions(db: Db, mission: MissionRow): MissionNextOption[] {
  if (mission.arc_id === null) return [];
  return db
    .prepare(
      `
        SELECT l.to_mission_id AS id, m.name, l.label, m.mission_type, m.space_risk
        FROM mission_links l
        JOIN missions m ON m.mission_id = l.to_mission_id
        WHERE l.arc_id=? AND l.from_mission_id=?
        ORDER BY l.to_mission_id ASC
      `
    )
    .all(mission.arc_id, mission.mission_id) as MissionNextOption[];
}

function missionDetail(db: Db, missionId: number): Record<string, unknown> | null {
  const mission = db
    .prepare(
      `
        SELECT
          m.*, a.name AS arc_name, a.faction AS arc_faction, a.level AS arc_level,
          a.starting_agent AS arc_starting_agent, a.starting_system AS arc_starting_system,
          a.description AS arc_description, a.source_url AS arc_source_url
        FROM missions m
        LEFT JOIN mission_arcs a ON a.arc_id = m.arc_id
        WHERE m.mission_id=?
      `
    )
    .get(missionId) as (MissionRow & Record<string, unknown>) | undefined;
  if (!mission) return null;

  const objectiveItems = db
    .prepare(
      "SELECT mission_id, type_id, type_name, quantity, volume_m3, role FROM mission_objective_items WHERE mission_id=? ORDER BY role, type_name COLLATE NOCASE"
    )
    .all(missionId);
  const pockets = db
    .prepare("SELECT * FROM mission_pockets WHERE mission_id=? ORDER BY pocket_index ASC, pocket_id ASC")
    .all(missionId) as MissionPocketRow[];
  const pocketIds = pockets.map((pocket) => pocket.pocket_id);
  const groups =
    pocketIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT * FROM mission_groups WHERE pocket_id IN (${sqlPlaceholders(pocketIds.length)}) ORDER BY pocket_id, group_index, group_id`
          )
          .all(...pocketIds) as MissionGroupRow[]);
  const groupIds = groups.map((group) => group.group_id);
  const npcs =
    groupIds.length === 0
      ? []
      : (db
          .prepare(
            `
              SELECT n.*, t.group_name AS type_group_name
              FROM mission_npcs n
              LEFT JOIN types t ON t.type_id = n.type_id
              WHERE n.group_id IN (${sqlPlaceholders(groupIds.length)})
              ORDER BY n.group_id, n.npc_id
            `
          )
          .all(...groupIds) as MissionNpcRow[]);

  const npcsByGroup = new Map<number, Array<Record<string, unknown>>>();
  for (const npc of npcs) {
    const { ewar_json, type_group_name, ...npcPayload } = npc;
    const mapped = {
      ...npcPayload,
      ship_class: missionShipClass(npc.type_name, type_group_name, npc.ship_class),
      ewar: parseEwar(ewar_json)
    };
    pushToMapList(npcsByGroup, npc.group_id, mapped);
  }

  const nextOptions = missionNextOptions(db, mission);
  const groupsByPocket = new Map<number, Array<Record<string, unknown>>>();
  for (const group of groups) {
    pushToMapList(groupsByPocket, group.pocket_id, { ...group, optional: group.optional === 1, npcs: npcsByGroup.get(group.group_id) ?? [] });
  }

  return {
    ...mission,
    objective_html: unwrapObjectiveItemLinks(mission.objective_html),
    type: mission.mission_type,
    arc: mission.arc_id
      ? {
          arc_id: mission.arc_id,
          name: mission.arc_name,
          faction: mission.arc_faction,
          level: mission.arc_level,
          starting_agent: mission.arc_starting_agent,
          starting_system: mission.arc_starting_system,
          description: mission.arc_description,
          source_url: mission.arc_source_url
        }
      : null,
    objective_items: objectiveItems,
    pockets: pockets.map((pocket) => ({ ...pocket, groups: groupsByPocket.get(pocket.pocket_id) ?? [] })),
    neighbors: {
      prev: missionNeighbor(db, mission.prev_mission_id),
      next: missionNeighbor(db, mission.next_mission_id),
      next_options: nextOptions.length > 1 ? nextOptions : null
    }
  };
}

function arcDetail(db: Db, arcId: number): Record<string, unknown> | null {
  const arc = db.prepare("SELECT * FROM mission_arcs WHERE arc_id=?").get(arcId) as ArcRow | undefined;
  if (!arc) return null;
  // The arc table stores the staging system by name only; resolve security and
  // region from the SDE tables so the hero can render "Josameto 0.7 · The Forge".
  const staging = arc.starting_system
    ? (db
        .prepare(
          `
            SELECT s.security_status, r.name AS region_name
            FROM systems s
            LEFT JOIN regions r ON r.region_id = s.region_id
            WHERE s.name = ? COLLATE NOCASE
          `
        )
        .get(arc.starting_system) as { security_status: number | null; region_name: string | null } | undefined)
    : undefined;
  const missions = db
    .prepare(
      `
        WITH pocket_dps AS (
          SELECT
            p.mission_id,
            p.pocket_id,
            SUM(n.quantity * (COALESCE(n.turret_dps_em, 0) + COALESCE(n.missile_dps_em, 0))) AS dps_em,
            SUM(n.quantity * (COALESCE(n.turret_dps_therm, 0) + COALESCE(n.missile_dps_therm, 0))) AS dps_therm,
            SUM(n.quantity * (COALESCE(n.turret_dps_kin, 0) + COALESCE(n.missile_dps_kin, 0))) AS dps_kin,
            SUM(n.quantity * (COALESCE(n.turret_dps_exp, 0) + COALESCE(n.missile_dps_exp, 0))) AS dps_exp,
            SUM(
              n.quantity * (
                COALESCE(n.turret_dps_em, 0) +
                COALESCE(n.turret_dps_therm, 0) +
                COALESCE(n.turret_dps_kin, 0) +
                COALESCE(n.turret_dps_exp, 0) +
                COALESCE(n.missile_dps_em, 0) +
                COALESCE(n.missile_dps_therm, 0) +
                COALESCE(n.missile_dps_kin, 0) +
                COALESCE(n.missile_dps_exp, 0)
              )
            ) AS dps
          FROM mission_pockets p
          JOIN missions pm ON pm.mission_id = p.mission_id
          JOIN mission_groups g ON g.pocket_id = p.pocket_id
          JOIN mission_npcs n ON n.group_id = g.group_id
          WHERE pm.arc_id=?
          GROUP BY p.mission_id, p.pocket_id
        ),
        ranked_pocket_dps AS (
          SELECT
            mission_id, pocket_id, dps, dps_em, dps_therm, dps_kin, dps_exp,
            ROW_NUMBER() OVER (PARTITION BY mission_id ORDER BY dps DESC, pocket_id ASC) AS rn
          FROM pocket_dps
        ),
        mission_peak_dps AS (
          SELECT
            mission_id,
            NULLIF(ROUND(dps, 3), 0) AS peak_dps,
            NULLIF(ROUND(dps_em, 3), 0) AS peak_dps_em,
            NULLIF(ROUND(dps_therm, 3), 0) AS peak_dps_therm,
            NULLIF(ROUND(dps_kin, 3), 0) AS peak_dps_kin,
            NULLIF(ROUND(dps_exp, 3), 0) AS peak_dps_exp
          FROM ranked_pocket_dps
          WHERE rn = 1
        )
        SELECT
          m.mission_id, m.prev_mission_id, m.next_mission_id, m.name, m.arc_position,
          m.reward_isk, m.reward_lp, m.reward_bonus_isk, m.bonus_time_seconds,
          m.faction, m.mission_type, m.space_risk,
          mp.peak_dps, mp.peak_dps_em, mp.peak_dps_therm, mp.peak_dps_kin, mp.peak_dps_exp
        FROM missions m
        LEFT JOIN mission_peak_dps mp ON mp.mission_id = m.mission_id
        WHERE m.arc_id=?
        ORDER BY m.arc_position IS NULL ASC, m.arc_position ASC, m.mission_id ASC
      `
    )
    .all(arcId, arcId) as Array<{
    mission_id: number;
    reward_isk: number | null;
    reward_lp: number | null;
    reward_bonus_isk: number | null;
    prev_mission_id: number | null;
    next_mission_id: number | null;
    space_risk: string | null;
    peak_dps: number | null;
    peak_dps_em: number | null;
    peak_dps_therm: number | null;
    peak_dps_kin: number | null;
    peak_dps_exp: number | null;
  }>;
  const ewarTypesByMission = arcEwarTypesByMission(db, arcId);
  const missionsWithIntel = missions.map((mission) => {
    const { peak_dps_em, peak_dps_therm, peak_dps_kin, peak_dps_exp, ...rest } = mission;
    return {
      ...rest,
      peak_dps_by_type:
        peak_dps_em == null && peak_dps_therm == null && peak_dps_kin == null && peak_dps_exp == null
          ? null
          : {
              em: peak_dps_em ?? 0,
              therm: peak_dps_therm ?? 0,
              kin: peak_dps_kin ?? 0,
              exp: peak_dps_exp ?? 0
            },
      ewar_types: ewarTypesByMission.get(mission.mission_id) ?? []
    };
  });
  const edges = db
    .prepare(
      'SELECT from_mission_id AS "from", to_mission_id AS "to", label FROM mission_links WHERE arc_id=? ORDER BY from_mission_id, to_mission_id'
    )
    .all(arcId) as Array<{ from: number; to: number; label: string | null }>;
  return {
    ...arc,
    starting_system_security: staging?.security_status ?? null,
    starting_system_region: staging?.region_name ?? null,
    missions: missionsWithIntel,
    edges,
    total_reward_isk: missions.reduce((sum, mission) => sum + (mission.reward_isk ?? 0), 0),
    total_reward_lp: missions.reduce((sum, mission) => sum + (mission.reward_lp ?? 0), 0),
    total_bonus_isk: missions.reduce((sum, mission) => sum + (mission.reward_bonus_isk ?? 0), 0)
  };
}

export async function registerMissionRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/missions", apiReadRateLimit, async (request, reply) => {
    setMissionsCacheHeaders(reply);
    return { rows: missionListRows(db, request) };
  });

  app.get("/api/missions/health", apiReadRateLimit, async (_request, reply) => {
    // Health stays origin-fresh like /api/health — never edge-cached for 900 s.
    setHealthCacheHeaders(reply);
    const source = db
      .prepare("SELECT imported_at FROM source_imports WHERE source='missions-seed'")
      .get() as { imported_at: string } | undefined;
    return {
      last_import: source?.imported_at ?? null,
      mission_count: countRows(db, "missions"),
      arc_count: countRows(db, "mission_arcs")
    };
  });

  app.get<{ Params: { id: string } }>("/api/missions/:id", apiReadRateLimit, async (request, reply) => {
    setMissionsCacheHeaders(reply);
    const missionId = parseInteger(request.params.id);
    if (missionId === null) {
      reply.status(400);
      return { error: "invalid_mission_id" };
    }
    const row = missionDetail(db, missionId);
    if (!row) {
      reply.status(404);
      return { error: "not_found" };
    }
    return row;
  });

  app.get("/api/arcs", apiReadRateLimit, async (_request, reply) => {
    setMissionsCacheHeaders(reply);
    const rows = db
      .prepare(
        `
          SELECT
            a.arc_id, a.name, a.faction, a.level,
            a.starting_agent, a.starting_system, a.description,
            COUNT(m.mission_id) AS mission_count
          FROM mission_arcs a
          LEFT JOIN missions m ON m.arc_id = a.arc_id
          GROUP BY a.arc_id
          ORDER BY a.level DESC, a.name COLLATE NOCASE ASC
        `
      )
      .all();
    return { rows };
  });

  app.get<{ Params: { id: string } }>("/api/arcs/:id", apiReadRateLimit, async (request, reply) => {
    setMissionsCacheHeaders(reply);
    const arcId = parseInteger(request.params.id);
    if (arcId === null) {
      reply.status(400);
      return { error: "invalid_arc_id" };
    }
    const row = arcDetail(db, arcId);
    if (!row) {
      reply.status(404);
      return { error: "not_found" };
    }
    return row;
  });
}
