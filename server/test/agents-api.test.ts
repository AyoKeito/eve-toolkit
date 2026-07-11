import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate, type Db } from "../src/db.js";
import { registerAgentRoutes } from "../src/api/agents.js";

function seededDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO regions(region_id, name) VALUES (10000042, 'Metropolis');
    INSERT INTO constellations(constellation_id, name) VALUES (20000372, 'Ani');
    INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id)
    VALUES
      (30002544, 'Lanngisi', 0.46, 'HIGHSEC', 10000042, 20000372),
      (30002053, 'Hek', 0.45, 'HIGHSEC', 10000042, NULL);
    INSERT INTO stations(station_id, name, system_id)
    VALUES (60011866, 'Lanngisi III - Moon 1 - Sisters of EVE Bureau', 30002544);
    INSERT INTO corporations(corp_id, name) VALUES (1000130, 'Sisters of EVE'), (1000051, 'No Agents Corp');
    INSERT INTO npc_corp_divisions(division_id, name) VALUES (22, 'Distribution'), (24, 'Security');
    INSERT INTO npc_agent_types(agent_type_id, name) VALUES (2, 'BasicAgent'), (6, 'GenericStorylineMissionAgent');
    INSERT INTO npc_agents(agent_id, name, corp_id, station_id, system_id, level, division_id, agent_type_id, is_locator, in_space)
    VALUES
      (1, 'Station Agent', 1000130, 60011866, 30002544, 4, 24, 2, 1, 0),
      (2, 'System Agent', 1000130, NULL, 30002053, 3, 22, 2, 0, 0),
      (3, 'Cosmos Agent', 1000130, NULL, 30002053, 1, 22, 2, 0, 1),
      (4, 'Storyline Agent', 1000130, NULL, 30002053, 3, 22, 6, 0, 0);
  `);
  return db;
}

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAgentRoutes(app, db);
  return app;
}

test("agents endpoint validates the corp parameter", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  // No corp param is no longer an error: it selects the cross-corp "all corporations" view.
  const missing = await app.inject("/api/agents");
  assert.equal(missing.statusCode, 200);
  const missingBody = missing.json() as { scope: string; corp_id: number | null; agents: unknown[] };
  assert.equal(missingBody.scope, "all");
  assert.equal(missingBody.corp_id, null);
  assert.ok(missingBody.agents.length > 0, "all-corporations view returns agents");

  const invalid = await app.inject("/api/agents?corp=sisters");
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: "invalid_corp_id" });

  const unknown = await app.inject("/api/agents?corp=999999");
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "corp_not_found" });

  await app.close();
  db.close();
});

test("agents endpoint aggregates across corps and labels each agent's corp in the all view", async () => {
  const db = seededDb();
  // A second corp with its own station agent in the same system, so the all-corporations view
  // must surface agents from both corps and carry each one's corp identity.
  db.exec(`
    INSERT INTO npc_agents(agent_id, name, corp_id, station_id, system_id, level, division_id, agent_type_id, is_locator, in_space)
    VALUES (20, 'Rival Agent', 1000051, 60011866, 30002544, 4, 24, 2, 0, 0);
  `);
  const app = await buildApp(db);

  const response = await app.inject("/api/agents");
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    scope: string;
    corp_id: number | null;
    corp_name: string | null;
    agents: Array<{ agent_name: string; corp_id: number; corp_name: string | null }>;
  };

  assert.equal(body.scope, "all");
  assert.equal(body.corp_id, null);
  assert.equal(body.corp_name, null);

  const byName = new Map(body.agents.map((agent) => [agent.agent_name, agent]));
  assert.deepEqual(
    { corp_id: byName.get("Station Agent")?.corp_id, corp_name: byName.get("Station Agent")?.corp_name },
    { corp_id: 1000130, corp_name: "Sisters of EVE" }
  );
  assert.deepEqual(
    { corp_id: byName.get("Rival Agent")?.corp_id, corp_name: byName.get("Rival Agent")?.corp_name },
    { corp_id: 1000051, corp_name: "No Agents Corp" },
    "the all view carries each agent's own corp identity"
  );

  await app.close();
  db.close();
});

test("agents endpoint returns joined BasicAgent rows excluding in-space agents by default", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const response = await app.inject("/api/agents?corp=1000130");
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    scope: string;
    corp_id: number;
    corp_name: string;
    empty_reason: string | null;
    agents: Array<Record<string, unknown>>;
  };

  assert.equal(body.scope, "corp");
  assert.equal(body.corp_id, 1000130);
  assert.equal(body.corp_name, "Sisters of EVE");
  assert.equal(body.empty_reason, null);
  assert.deepEqual(
    body.agents.map((agent) => agent.agent_name),
    ["System Agent", "Station Agent"],
    "ordered by system name, in-space and non-basic agents excluded"
  );
  assert.deepEqual(body.agents[1], {
    agent_id: 1,
    agent_name: "Station Agent",
    level: 4,
    is_locator: 1,
    in_space: 0,
    station_id: 60011866,
    station_name: "Lanngisi III - Moon 1 - Sisters of EVE Bureau",
    system_id: 30002544,
    system_name: "Lanngisi",
    security_status: 0.46,
    risk_tier: "HIGHSEC",
    region_id: 10000042,
    region_name: "Metropolis",
    constellation_id: 20000372,
    constellation_name: "Ani",
    division_id: 24,
    division_name: "Security",
    agent_type_id: 2,
    agent_type_name: "BasicAgent",
    corp_id: 1000130,
    corp_name: "Sisters of EVE",
    arc_id: null,
    arc_name: null
  });

  await app.close();
  db.close();
});

test("agents endpoint supports in_space and type filters reserved for later views", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const withSpace = await app.inject("/api/agents?corp=1000130&in_space=true");
  const spaceNames = (withSpace.json() as { agents: Array<{ agent_name: string }> }).agents.map(
    (agent) => agent.agent_name
  );
  assert.ok(spaceNames.includes("Cosmos Agent"), "in_space=true must include in-space agents");

  const storyline = await app.inject("/api/agents?corp=1000130&type=6");
  assert.deepEqual(
    (storyline.json() as { agents: Array<{ agent_name: string }> }).agents.map((agent) => agent.agent_name),
    ["Storyline Agent"]
  );

  const junkType = await app.inject("/api/agents?corp=1000130&type=junk");
  assert.deepEqual(
    (junkType.json() as { agents: Array<{ agent_name: string }> }).agents.map((agent) => agent.agent_name),
    ["System Agent", "Station Agent"],
    "unparseable type filter falls back to BasicAgent"
  );

  await app.close();
  db.close();
});

test("agents endpoint attaches arc identity to EpicArcAgent rows by starting-agent name", async () => {
  const db = seededDb();
  db.exec(`
    INSERT INTO npc_agent_types(agent_type_id, name) VALUES (10, 'EpicArcAgent');
    INSERT INTO mission_arcs(arc_id, name, faction, level, starting_agent, imported_at)
    VALUES (4, 'Right to Rule', 'AMARR', 4, 'Karde Romu', '2026-06-21');
    INSERT INTO npc_agents(agent_id, name, corp_id, station_id, system_id, level, division_id, agent_type_id, is_locator, in_space)
    VALUES
      (10, 'Karde Romu', 1000130, 60011866, 30002544, 4, 24, 10, 0, 1),
      (11, 'Mid Arc Agent', 1000130, 60011866, 30002544, 4, 24, 10, 0, 0);
  `);
  const app = await buildApp(db);

  // No in_space param: epic agents must surface anyway (Karde Romu is flagged in-space).
  const response = await app.inject("/api/agents?corp=1000130&type=10");
  const agents = (response.json() as { agents: Array<{ agent_name: string; arc_id: number | null; arc_name: string | null }> }).agents;
  assert.ok(
    agents.some((agent) => agent.agent_name === "Karde Romu"),
    "an in-space epic agent is not hidden by the default in-space filter"
  );
  const starter = agents.find((agent) => agent.agent_name === "Karde Romu");
  const midArc = agents.find((agent) => agent.agent_name === "Mid Arc Agent");
  assert.deepEqual(
    { arc_id: starter?.arc_id, arc_name: starter?.arc_name },
    { arc_id: 4, arc_name: "Right to Rule" },
    "an arc-starting epic agent carries its arc identity"
  );
  assert.deepEqual(
    { arc_id: midArc?.arc_id, arc_name: midArc?.arc_name },
    { arc_id: null, arc_name: null },
    "an epic agent that starts no arc carries no arc identity"
  );

  await app.close();
  db.close();
});

test("agents endpoint distinguishes corps without agents from missing agent data", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const noAgents = await app.inject("/api/agents?corp=1000051");
  assert.equal(noAgents.statusCode, 200);
  assert.equal((noAgents.json() as { empty_reason: string | null }).empty_reason, null);
  assert.deepEqual((noAgents.json() as { agents: unknown[] }).agents, []);
  await app.close();
  db.close();

  const emptyDb = new Database(":memory:");
  migrate(emptyDb);
  emptyDb.prepare("INSERT INTO corporations(corp_id, name) VALUES (1000130, 'Sisters of EVE')").run();
  const emptyApp = await buildApp(emptyDb);
  const empty = await emptyApp.inject("/api/agents?corp=1000130");
  assert.equal(empty.statusCode, 200);
  assert.equal((empty.json() as { empty_reason: string | null }).empty_reason, "no_agent_data");
  await emptyApp.close();
  emptyDb.close();
});

test("agents endpoint advertises browser and purge-invalidated 24h edge cache headers", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const response = await app.inject("/api/agents?corp=1000130");
  assert.equal(response.headers["cache-control"], "public, max-age=30, stale-while-revalidate=120");
  // Agent data changes only on SDE import/deploy (both purge the /api/ prefix), so invalidation is
  // purge-driven; the 24h edge TTL is a backstop that self-heals a missed purge within a day.
  assert.equal(response.headers["cdn-cache-control"], "public, s-maxage=86400, stale-while-revalidate=86400");
  assert.equal(response.headers.vary, "Accept-Encoding");
  assert.match(response.headers.etag as string, /^W\/"gen-0-v\d+-[0-9a-f]{16}"$/);

  await app.close();
  db.close();
});

test("agents response is cached in-process and rebuilt only when the SDE import version changes", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const first = (await app.inject("/api/agents?corp=1000130")).json() as { agents: unknown[] };
  const baseCount = first.agents.length;

  // A mirrored write WITHOUT a new import must keep serving the cached body (static-between-imports).
  db.prepare(
    "INSERT INTO npc_agents(agent_id, name, corp_id, system_id, level, division_id, agent_type_id, is_locator, in_space) VALUES (99, 'Late Agent', 1000130, 30002053, 4, 22, 2, 0, 0)"
  ).run();
  const stale = (await app.inject("/api/agents?corp=1000130")).json() as { agents: unknown[] };
  assert.equal(stale.agents.length, baseCount, "served from cache until the import version rotates");

  // Simulate import-sde: a new source_imports.imported_at rotates the cache key.
  db.prepare(
    "INSERT INTO source_imports(source, archive_url, imported_at, metadata_json) VALUES ('ccp-jsonl-sde', 'x', ?, '{}') ON CONFLICT(source) DO UPDATE SET imported_at=excluded.imported_at"
  ).run(new Date().toISOString());
  const fresh = (await app.inject("/api/agents?corp=1000130")).json() as { agents: unknown[] };
  assert.equal(fresh.agents.length, baseCount + 1, "a new import rebuilds the cached body");

  await app.close();
  db.close();
});

test("agents endpoint supports ETag 304 revalidation and brotli negotiation", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const hit = await app.inject("/api/agents?corp=1000130");
  assert.equal(hit.statusCode, 200);
  const etag = hit.headers.etag as string;

  const revalidated = await app.inject({ url: "/api/agents?corp=1000130", headers: { "if-none-match": etag } });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, "");

  const brotli = await app.inject({ url: "/api/agents?corp=1000130", headers: { "accept-encoding": "br" } });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(brotli.headers.etag, etag, "same body → same etag across encodings");

  await app.close();
  db.close();
});
