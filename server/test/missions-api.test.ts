import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { registerMissionRoutes } from "../src/api/missions.js";
import { importMissionsFromSeed } from "../src/fetchers/missions-seed.js";

const missionSource = (id: number) =>
  ["https://games.", "chruk", "er.dk/eve_online/mission_view.php?id=", String(id)].join("");

const seed = {
  arc_id: 1,
  name: "Wildfire",
  faction: "MINMATAR",
  level: 4,
  starting_agent: "Mia Cadelanne",
  starting_system: "Avesber",
  description: "Minmatar level 4 epic arc.",
  source_url: missionSource(195),
  missions: [
    {
      mission_id: 200,
      arc_position: 6,
      prev_mission_id: 199,
      next_mission_id: 201,
      name: "A Demonstration",
      level: 4,
      mission_type: "COURIER",
      faction: "Minmatar Republic",
      is_epic_arc: true,
      damage_to_deal: null,
      damage_to_resist: null,
      recommended_ship: "Shuttle",
      space_risk: "LOWSEC",
      briefing_html: "<p>Move quickly.</p>",
      objective_html: "<p>Deliver the package.</p>",
      reward_isk: 500000,
      reward_lp: 12000,
      reward_bonus_isk: 250000,
      bonus_time_seconds: 900,
      source_url: missionSource(200),
      objective_items: [],
      pockets: []
    },
    {
      mission_id: 201,
      arc_position: 7,
      prev_mission_id: 200,
      next_mission_id: null,
      name: "Church of the Obsidian",
      level: 4,
      mission_type: "ENCOUNTER",
      faction: "Angel Cartel",
      is_epic_arc: true,
      damage_to_deal: "Explosive/Kinetic",
      damage_to_resist: "Explosive/Kinetic",
      recommended_ship: "Battleship",
      briefing_html: "<p>Scout the hostile pocket.</p>",
      objective_html: '<p>Destroy the stasis tower.</p><p>1x <a href="item.php?type_id=32280">Blood Obsidian Orb</a> (volume: 0 m3)</p>',
      objective_notes: "Loot the Blood Obsidian Orb from the tower wreck — the mission won't complete without it.",
      reward_isk: 1200000,
      reward_lp: 45000,
      reward_bonus_isk: 800000,
      bonus_time_seconds: 1800,
      source_url: missionSource(201),
      objective_items: [
        { type_id: null, type_name: "Wildfire Khumaak", quantity: 1, volume_m3: 0.5, role: "RETRIEVE" }
      ],
      pockets: [
        {
          pocket_index: 0,
          name: "Pocket 1",
          notes: "Initial wave.",
          groups: [
            {
              group_index: 0,
              label: "Group 1",
              distance_text: "23 km",
              trigger_text: "Last battleship triggers reinforcement.",
              optional: false,
              npcs: [
                {
                  quantity: 3,
                  type_id: 14352,
                  type_name: "Ammatar Navy Soldier",
                  ship_class: null,
                  bounty_isk: 8500,
                  signature_radius: 35,
                  max_velocity: 620,
                  orbit_velocity: 430,
                  orbit_distance: 7500,
                  shield_hp: 250,
                  armor_hp: 200,
                  hull_hp: 150,
                  resist_shield_em: 0,
                  resist_shield_therm: 20,
                  resist_shield_kin: 40,
                  resist_shield_exp: 50,
                  resist_armor_em: 60,
                  resist_armor_therm: 35,
                  resist_armor_kin: 25,
                  resist_armor_exp: 10,
                  turret_dps_em: 0,
                  turret_dps_therm: 4,
                  turret_dps_kin: 7,
                  turret_dps_exp: 11,
                  turret_range: 12000,
                  missile_dps_em: 0,
                  missile_dps_therm: 0,
                  missile_dps_kin: 3,
                  missile_dps_exp: 5,
                  missile_range: 18000,
                  defender_chance_pct: 5,
                  ewar: [{ type: "WEB", range: 10000, chance: 35 }],
                  notes: "Webs nearby targets."
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

// Minimal forked arc: 63 branches to 64 and 70 via explicit labelled links, while its
// linear next pointer arbitrarily picks 64 — exactly the shape of the Syndication fork.
const branchMission = (overrides: Record<string, unknown>) => ({
  level: 4,
  faction: null,
  is_epic_arc: true,
  damage_to_deal: null,
  damage_to_resist: null,
  recommended_ship: "Any ship",
  briefing_html: null,
  objective_html: "<p>Choose your path</p>",
  reward_isk: null,
  reward_lp: null,
  reward_bonus_isk: null,
  bonus_time_seconds: null,
  objective_items: [],
  pockets: [],
  ...overrides
});

const branchSeed = {
  arc_id: 2,
  name: "Syndication",
  faction: "GALLENTE",
  level: 4,
  starting_agent: "Roineron Aviviere",
  starting_system: "Dodixie",
  description: "Gallente level 4 epic arc (fork fixture).",
  source_url: missionSource(57),
  missions: [
    branchMission({
      mission_id: 63,
      arc_position: 1,
      prev_mission_id: null,
      next_mission_id: 64,
      name: "The High or Low Road",
      mission_type: "BRANCH",
      source_url: missionSource(63),
      links: [
        { to: 64, label: "High Road" },
        { to: 70, label: "Low Road" }
      ]
    }),
    branchMission({
      mission_id: 64,
      arc_position: 2,
      prev_mission_id: 63,
      next_mission_id: null,
      name: "Into the Black",
      mission_type: "ENCOUNTER",
      source_url: missionSource(64),
      links: []
    }),
    branchMission({
      mission_id: 70,
      arc_position: 2,
      prev_mission_id: 63,
      next_mission_id: null,
      name: "Outside the Scope",
      mission_type: "TRAVEL",
      space_risk: "LOWSEC",
      source_url: missionSource(70),
      links: []
    })
  ]
};

async function buildBranchApp(): Promise<{ app: FastifyInstance; db: Database.Database }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-missions-branch-"));
  fs.writeFileSync(path.join(dir, "syndication.json"), JSON.stringify(branchSeed, null, 2));
  const db = new Database(":memory:");
  migrate(db);
  await importMissionsFromSeed(db, dir);
  const app = Fastify();
  await registerMissionRoutes(app, db);
  return { app, db };
}

async function buildApp(): Promise<{ app: FastifyInstance; db: Database.Database }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-missions-api-"));
  fs.writeFileSync(path.join(dir, "wildfire.json"), JSON.stringify(seed, null, 2));
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO types(type_id, name, group_name, category_name) VALUES (?, ?, ?, ?)").run(
    14352,
    "Ammatar Navy Soldier",
    "Mission Amarr Empire Frigate",
    "Entity"
  );
  await importMissionsFromSeed(db, dir);
  db.prepare("UPDATE mission_npcs SET ship_class=NULL WHERE type_id=14352").run();
  const app = Fastify();
  await registerMissionRoutes(app, db);
  return { app, db };
}

test("mission list endpoint filters by level, faction, type, arc, and search", async () => {
  const { app, db } = await buildApp();
  const response = await app.inject("/api/missions?level=4&faction=Angel&type=ENCOUNTER&arc=1&search=obsidian");
  const payload = response.json() as {
    rows: Array<{ mission_id: number; name: string; arc_name: string; mission_type: string; faction: string }>;
  };

  assert.equal(response.statusCode, 200);
  assert.deepEqual(payload.rows.map((row) => row.mission_id), [201]);
  assert.equal(payload.rows[0].name, "Church of the Obsidian");
  assert.equal(payload.rows[0].arc_name, "Wildfire");
  assert.equal(payload.rows[0].mission_type, "ENCOUNTER");
  assert.equal(payload.rows[0].faction, "Angel Cartel");

  await app.close();
  db.close();
});

test("mission read endpoints advertise browser and CDN caching", async () => {
  const { app, db } = await buildApp();

  for (const url of ["/api/missions", "/api/arcs", "/api/missions/201"]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["cache-control"], "public, max-age=30, stale-while-revalidate=120", url);
    // Mission/arc data carries no dynamic component, so invalidation is purge-driven (import/deploy
    // both purge /api/); the 24h edge TTL is just a backstop. The browser TTL stays short (30 s)
    // so post-purge data still propagates near-instantly.
    assert.equal(response.headers["cdn-cache-control"], "public, s-maxage=86400, stale-while-revalidate=86400", url);
  }

  // The missions health endpoint stays origin-fresh like /api/health.
  const health = await app.inject("/api/missions/health");
  assert.equal(health.headers["cache-control"], "public, max-age=5, stale-while-revalidate=10");
  assert.equal(health.headers["cdn-cache-control"], undefined);

  await app.close();
  db.close();
});

test("mission search escapes LIKE wildcards so % and _ are matched literally", async () => {
  const { app, db } = await buildApp();

  // Raw '%' interpolated into a LIKE pattern would match every row; escaped, it
  // only matches a literal percent sign, which none of the seeded missions have.
  const wild = await app.inject("/api/missions?search=%25");
  assert.equal(wild.statusCode, 200);
  assert.equal((wild.json() as { rows: unknown[] }).rows.length, 0);

  // A genuine substring still matches.
  const real = await app.inject("/api/missions?search=Obsidian");
  assert.deepEqual(
    (real.json() as { rows: Array<{ mission_id: number }> }).rows.map((row) => row.mission_id),
    [201]
  );

  await app.close();
  db.close();
});

test("mission detail endpoint returns nested pockets, NPC stats, objective items, and neighbors", async () => {
  const { app, db } = await buildApp();
  const response = await app.inject("/api/missions/201");
  const payload = response.json() as {
    mission_id: number;
    space_risk: string | null;
    objective_html: string;
    objective_notes: string | null;
    objective_items: Array<{ type_name: string; role: string }>;
    pockets: Array<{ groups: Array<{ npcs: Array<{ type_name: string; ship_class: string | null; ewar: Array<{ type: string }> }> }> }>;
    neighbors: {
      prev: { id: number; name: string } | null;
      next: { id: number; name: string } | null;
      next_options: Array<{ id: number }> | null;
    };
  };

  assert.equal(response.statusCode, 200);
  assert.equal(payload.mission_id, 201);
  assert.equal(payload.space_risk, null);
  assert.doesNotMatch(payload.objective_html, /item\.php\?type_id=/);
  assert.doesNotMatch(payload.objective_html, /<a\b/i);
  assert.match(payload.objective_html, /Blood Obsidian Orb/);
  assert.match(payload.objective_html, /\(volume: 0 m3\)/);
  assert.match(payload.objective_notes ?? "", /Loot the Blood Obsidian Orb/);
  assert.equal(payload.objective_items[0].type_name, "Wildfire Khumaak");
  assert.equal(payload.objective_items[0].role, "RETRIEVE");
  assert.equal(payload.pockets[0].groups[0].npcs[0].type_name, "Ammatar Navy Soldier");
  assert.equal(payload.pockets[0].groups[0].npcs[0].ship_class, "Frigate");
  assert.equal(payload.pockets[0].groups[0].npcs[0].ewar[0].type, "WEB");
  assert.deepEqual(payload.neighbors.prev, { id: 200, name: "A Demonstration" });
  assert.equal(payload.neighbors.next, null);
  assert.equal(payload.neighbors.next_options, null);

  await app.close();
  db.close();
});

test("fork missions expose every outgoing branch as labelled next options", async () => {
  const { app, db } = await buildBranchApp();

  // The fork: next_mission_id arbitrarily points at 64, but next_options carries the
  // full labelled fan-out so the frontend can offer a real choice.
  const fork = await app.inject("/api/missions/63");
  const forkPayload = fork.json() as {
    neighbors: {
      next: { id: number } | null;
      next_options: Array<{ id: number; name: string; label: string | null; mission_type: string; space_risk: string | null }> | null;
    };
  };
  assert.equal(fork.statusCode, 200);
  assert.deepEqual(forkPayload.neighbors.next, { id: 64, name: "Into the Black" });
  assert.deepEqual(forkPayload.neighbors.next_options, [
    { id: 64, name: "Into the Black", label: "High Road", mission_type: "ENCOUNTER", space_risk: null },
    { id: 70, name: "Outside the Scope", label: "Low Road", mission_type: "TRAVEL", space_risk: "LOWSEC" }
  ]);

  // Branch endings are linear again: no options, just the (absent) next pointer.
  const ending = await app.inject("/api/missions/64");
  const endingPayload = ending.json() as { neighbors: { next: unknown; next_options: unknown } };
  assert.equal(endingPayload.neighbors.next, null);
  assert.equal(endingPayload.neighbors.next_options, null);

  await app.close();
  db.close();
});

test("arc endpoints expose arc summaries and ordered mission timeline", async () => {
  const { app, db } = await buildApp();
  // staging-system intel: the arc detail resolves starting_system by name
  db.prepare("INSERT INTO regions(region_id, name) VALUES (10000042, 'Metropolis')").run();
  db.prepare(
    "INSERT INTO systems(system_id, name, security_status, risk_tier, region_id) VALUES (30002057, 'Avesber', 0.42, 'HIGHSEC', 10000042)"
  ).run();
  const arcsResponse = await app.inject("/api/arcs");
  const arcResponse = await app.inject("/api/arcs/1");
  const arcs = arcsResponse.json() as { rows: Array<{ arc_id: number; mission_count: number }> };
  const arc = arcResponse.json() as {
    arc_id: number;
    missions: Array<{
      mission_id: number;
      prev_mission_id: number | null;
      next_mission_id: number | null;
      space_risk: string | null;
      peak_dps: number | null;
      ewar_types: string[];
    }>;
    total_reward_lp: number;
    starting_system_security: number | null;
    starting_system_region: string | null;
  };

  assert.equal(arcsResponse.statusCode, 200);
  assert.deepEqual(arcs.rows, [
    {
      arc_id: 1,
      name: "Wildfire",
      faction: "MINMATAR",
      level: 4,
      starting_agent: "Mia Cadelanne",
      starting_system: "Avesber",
      description: "Minmatar level 4 epic arc.",
      mission_count: 2
    }
  ]);
  assert.equal(arcResponse.statusCode, 200);
  assert.deepEqual(arc.missions.map((mission) => mission.mission_id), [200, 201]);
  assert.deepEqual(
    arc.missions.map((mission) => [mission.mission_id, mission.prev_mission_id, mission.next_mission_id]),
    [
      [200, 199, 201],
      [201, 200, null]
    ]
  );
  assert.deepEqual(
    arc.missions.map((mission) => [mission.mission_id, mission.peak_dps]),
    [
      [200, null],
      [201, 90]
    ]
  );
  assert.deepEqual(
    arc.missions.map((mission) => [mission.mission_id, mission.space_risk]),
    [
      [200, "LOWSEC"],
      [201, null]
    ]
  );
  assert.deepEqual(
    arc.missions.map((mission) => [mission.mission_id, mission.ewar_types]),
    [
      [200, []],
      [201, ["WEB"]]
    ]
  );
  assert.equal(arc.total_reward_lp, 57000);
  assert.equal(arc.starting_system_security, 0.42);
  assert.equal(arc.starting_system_region, "Metropolis");

  await app.close();
  db.close();
});

test("mission detail endpoint returns 400 for non-integer id", async () => {
  const { app, db } = await buildApp();
  const response = await app.inject("/api/missions/5abc");

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid_mission_id" });

  await app.close();
  db.close();
});

test("arc detail endpoint returns 400 for non-integer id", async () => {
  const { app, db } = await buildApp();
  const response = await app.inject("/api/arcs/5abc");

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid_arc_id" });

  await app.close();
  db.close();
});

test("mission health endpoint reports import status and row counts", async () => {
  const { app, db } = await buildApp();
  const response = await app.inject("/api/missions/health");
  const payload = response.json() as { last_import: string | null; mission_count: number; arc_count: number };

  assert.equal(response.statusCode, 200);
  assert.equal(typeof payload.last_import, "string");
  assert.equal(payload.mission_count, 2);
  assert.equal(payload.arc_count, 1);

  await app.close();
  db.close();
});
