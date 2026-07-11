import type { FastifyInstance, FastifyReply } from "fastify";
import { countRows, type Db } from "../db.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { sendCachedResponse, setAgentsCacheHeaders } from "../lib/api-cache-headers.js";
import { ResponseCache, jsonCachedResponse } from "../lib/response-cache.js";
import { responseEtag } from "../lib/compute-generation.js";
import { prepareCached } from "../lib/prepare-cache.js";
import { parseInteger } from "../lib/parse.js";
import { sqlPlaceholders } from "../lib/sql.js";
import { first, type QueryRecord, type QueryValue } from "./query.js";

const basicAgentTypeId = 2;
const maxAgentTypeId = 13;

interface AgentApiRow {
  agent_id: number;
  agent_name: string;
  level: number;
  is_locator: number;
  in_space: number;
  station_id: number | null;
  station_name: string | null;
  system_id: number;
  system_name: string | null;
  security_status: number | null;
  risk_tier: string | null;
  region_id: number | null;
  region_name: string | null;
  constellation_id: number | null;
  constellation_name: string | null;
  division_id: number | null;
  division_name: string | null;
  agent_type_id: number;
  agent_type_name: string | null;
  // corp identity travels with every row so the "all corporations" view can group agents from
  // different corps in one system/station and label each one. In corp-scoped mode every row
  // carries the same corp, mirroring the top-level corp_id/corp_name.
  corp_id: number;
  corp_name: string | null;
  arc_id: number | null;
  arc_name: string | null;
}

/**
 * Parses the optional `type` filter ("2" or "2,6,7") into validated agent type ids.
 * Defaults to BasicAgent only — the v1 UI never sends the parameter; it exists so
 * research/storyline views can be added without an API change.
 */
function parseAgentTypeIds(value: QueryValue): number[] {
  const raw = first(value)?.trim();
  if (!raw) return [basicAgentTypeId];
  const ids = raw
    .split(",")
    .map((part) => parseInteger(part.trim()))
    .filter((id): id is number => id !== null && id >= 1 && id <= maxAgentTypeId);
  return ids.length > 0 ? [...new Set(ids)] : [basicAgentTypeId];
}

/** Version token for the agents response cache: agent data (and every reference table
 * it joins) changes only on import-sde, which rewrites this row and purges the edge. A
 * new imported_at rotates every cache key, so an import against a running server (a
 * separate process writing the shared DB) invalidates the in-process cache too. */
function sdeImportVersion(db: Db): string {
  const row = prepareCached(db, "SELECT imported_at FROM source_imports WHERE source='ccp-jsonl-sde'").get() as
    | { imported_at: string }
    | undefined;
  return row?.imported_at ?? "none";
}

function setAgentsResponseHeaders(reply: FastifyReply, etag: string): void {
  setAgentsCacheHeaders(reply);
  reply.header("Vary", "Accept-Encoding");
  reply.header("ETag", etag);
}

export async function registerAgentRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // One cache per app instance: production registers routes once, so this persists for
  // the process; each test gets its own isolated cache. The all-corporations view is a
  // ~5.6MB / ~100ms build+serialize+compress; caching it (keyed by SDE import version)
  // turns every origin cache-miss from a full event-loop stall into a sub-ms hit.
  const agentsCache = new ResponseCache<string>({ maxEntries: 64, ttlMs: 6 * 60 * 60 * 1000 });

  app.get("/api/agents", apiReadRateLimit, async (request, reply) => {
    const query = request.query as QueryRecord;

    // The corp param is optional. Present → corp-scoped view (validated). Absent → the
    // "all corporations" view that ranks dense agent hubs across every corp at once; the UI
    // enters it simply by clearing the corporation field. Validation errors are returned
    // uncached (before the cache lookup) so a bad corp id never poisons a cache entry.
    const corpRaw = first(query.corp)?.trim();
    let corp: { corp_id: number; name: string } | null = null;
    if (corpRaw) {
      const corpId = parseInteger(corpRaw);
      if (corpId === null) return reply.status(400).send({ error: "invalid_corp_id" });
      corp =
        (prepareCached(db, "SELECT corp_id, name FROM corporations WHERE corp_id=?").get(corpId) as
          | { corp_id: number; name: string }
          | undefined) ?? null;
      if (!corp) return reply.status(404).send({ error: "corp_not_found" });
    }

    const typeIds = parseAgentTypeIds(query.type);
    const includeInSpace = first(query.in_space) === "true";
    const cacheKey = `${sdeImportVersion(db)}|corp=${corp?.corp_id ?? "all"}|type=${typeIds.join(",")}|space=${includeInSpace}`;

    const cached = await agentsCache.getOrCreate(cacheKey, () => {
      const placeholders = sqlPlaceholders(typeIds.length);
      // Bind order matches the placeholder order in the SQL: type ids first, optional corp id last.
      const params: number[] = [...typeIds];
      if (corp) params.push(corp.corp_id);
      const agents = prepareCached(
        db,
        `
          SELECT
            a.agent_id,
            a.name AS agent_name,
            a.level,
            a.is_locator,
            a.in_space,
            a.station_id,
            st.name AS station_name,
            a.system_id,
            sy.name AS system_name,
            sy.security_status,
            sy.risk_tier,
            sy.region_id,
            r.name AS region_name,
            sy.constellation_id,
            c.name AS constellation_name,
            a.division_id,
            d.name AS division_name,
            a.agent_type_id,
            aty.name AS agent_type_name,
            a.corp_id,
            corp.name AS corp_name,
            ma.arc_id AS arc_id,
            ma.name AS arc_name
          FROM npc_agents a
          LEFT JOIN stations st ON st.station_id = a.station_id
          LEFT JOIN systems sy ON sy.system_id = a.system_id
          LEFT JOIN regions r ON r.region_id = sy.region_id
          LEFT JOIN constellations c ON c.constellation_id = sy.constellation_id
          LEFT JOIN npc_corp_divisions d ON d.division_id = a.division_id
          LEFT JOIN npc_agent_types aty ON aty.agent_type_id = a.agent_type_id
          LEFT JOIN corporations corp ON corp.corp_id = a.corp_id
          -- EpicArcAgent (type 10) rows carry the arc they start, matched by name, so the
          -- agent finder can deep-link to /missions/arc/<id>. Null for every other agent.
          LEFT JOIN mission_arcs ma ON ma.starting_agent = a.name AND a.agent_type_id = 10
          WHERE a.agent_type_id IN (${placeholders})
            ${corp ? "AND a.corp_id = ?" : ""}
            -- The SDE flags many EpicArcAgents (type 10) as in-space even when stationed
            -- (e.g. Karde Romu / Right to Rule), so always surface them; the in-space filter
            -- only hides COSMOS-style basic/storyline agents.
            ${includeInSpace ? "" : "AND (a.in_space = 0 OR a.agent_type_id = 10)"}
          ORDER BY sy.name, a.level DESC, a.agent_id
        `
      ).all(...params) as AgentApiRow[];

      return jsonCachedResponse(
        {
          scope: corp ? "corp" : "all",
          corp_id: corp?.corp_id ?? null,
          corp_name: corp?.name ?? null,
          // Distinguishes "this corp has no agents" from "agent data was never imported" so the
          // UI can show a clear message on deployments that have not re-run import-sde yet.
          empty_reason: agents.length === 0 && countRows(db, "npc_agents") === 0 ? "no_agent_data" : null,
          agents
        },
        responseEtag(0, `agents|${cacheKey}`)
      );
    });

    return sendCachedResponse(request, reply, cached, { setHeaders: setAgentsResponseHeaders });
  });

  // Corporation list for the agent-finder picker. Distinct corps that actually have agents —
  // a superset of the LP-store list at /api/corps (which filters has_lp_store=1), so every
  // corporation the /api/agents view can surface is selectable. Keyed by SDE import version like
  // the agents view above, and cheap (~a couple hundred rows).
  app.get("/api/agents/corps", apiReadRateLimit, async (request, reply) => {
    const cacheKey = `corps|${sdeImportVersion(db)}`;
    const cached = await agentsCache.getOrCreate(cacheKey, () => {
      const rows = prepareCached(
        db,
        `
          SELECT DISTINCT a.corp_id AS corp_id, corp.name AS name
          FROM npc_agents a
          JOIN corporations corp ON corp.corp_id = a.corp_id
          WHERE corp.name IS NOT NULL
          ORDER BY corp.name
        `
      ).all() as Array<{ corp_id: number; name: string }>;
      return jsonCachedResponse({ rows }, responseEtag(0, `agents-corps|${cacheKey}`));
    });
    return sendCachedResponse(request, reply, cached, { setHeaders: setAgentsResponseHeaders });
  });
}
