import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { importSde } from "../src/fetchers/sde.js";

interface ZipEntry {
  name: string;
  rows: unknown[];
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function zipBuffer(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(`${entry.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const crc = crc32(content);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(content.length),
      u32(content.length),
      u16(name.length),
      u16(0),
      name
    ]);
    localParts.push(localHeader, content);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(content.length),
        u32(content.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    );
    offset += localHeader.length + content.length;
  }

  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(central.length),
      u32(offset),
      u16(0)
    ])
  ]);
}

test("importSde imports official JSONL SDE fixtures into normalized app tables", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-import-"));
  const archivePath = path.join(tempDir, "fixture.zip");
  fs.writeFileSync(
    archivePath,
    zipBuffer([
      { name: "_sde.jsonl", rows: [{ buildNumber: 3346029, releaseDate: "2026-05-13T11:51:25Z" }] },
      { name: "categories.jsonl", rows: [{ categoryID: 6, name: { en: "Ship" } }] },
      { name: "groups.jsonl", rows: [{ groupID: 25, categoryID: 6, name: { en: "Frigate" } }] },
      {
        name: "types.jsonl",
        rows: [
          { typeID: 100, groupID: 25, name: { en: "Test Blueprint" }, volume: 0.01, packagedVolume: 0.01 },
          { typeID: 101, groupID: 25, name: { en: "Test Frigate" }, volume: 2500, packagedVolume: 2500 },
          { typeID: 200, groupID: 25, name: { en: "Test Material" }, volume: 1, packagedVolume: 1 }
        ]
      },
      {
        name: "mapSolarSystems.jsonl",
        rows: [
          { solarSystemID: 30000142, solarSystemName: "Jita", security: 0.9459, regionID: 10000002, constellationID: 20000020 },
          { solarSystemID: 30005000, solarSystemName: "X-7OMU", security: -0.141435, regionID: 10000057, constellationID: 20000698 },
          { solarSystemID: 30002543, solarSystemName: "Apanake", security: 0.452, regionID: 10000002, constellationID: 20000020 }
        ]
      },
      {
        name: "mapRegions.jsonl",
        rows: [
          { _key: 10000002, name: { en: "The Forge" } },
          { _key: 10000057, name: { en: "Outer Ring" } }
        ]
      },
      {
        name: "mapConstellations.jsonl",
        rows: [
          { _key: 20000020, name: { en: "Kimotoro" }, regionID: 10000002 },
          { _key: 20000698, name: { en: "DYK6-B" }, regionID: 10000057 }
        ]
      },
      {
        name: "agentTypes.jsonl",
        rows: [
          { _key: 2, name: "BasicAgent" },
          { _key: 4, name: "ResearchAgent" }
        ]
      },
      {
        name: "npcCorporationDivisions.jsonl",
        rows: [
          { _key: 22, name: { en: "Distribution" }, displayName: "Distribution division", internalName: "Distribution" },
          { _key: 24, name: { en: "Security" }, displayName: "Security division", internalName: "Security" }
        ]
      },
      {
        name: "npcCharacters.jsonl",
        rows: [
          // Non-agent NPC: no agent block, must be ignored without counting as skipped.
          { _key: 999, name: { en: "Random NPC" }, corporationID: 1000051, locationID: 60003760 },
          {
            _key: 3008416,
            agent: { agentTypeID: 2, divisionID: 24, isLocator: true, level: 5 },
            corporationID: 1000051,
            locationID: 60003760,
            name: { en: "Test Agent Five" }
          },
          {
            _key: 3009318,
            agent: { agentTypeID: 4, divisionID: 18, isLocator: false, level: 3 },
            corporationID: 1000129,
            locationID: 60012583,
            name: { en: "Research Agent" },
            skills: [{ typeID: 11450 }]
          },
          // Agent located directly in a solar system (in-space/COSMOS pattern).
          {
            _key: 3018343,
            agent: { agentTypeID: 2, divisionID: 22, isLocator: false, level: 1 },
            corporationID: 1000130,
            locationID: 30000142,
            name: { en: "Space Agent" }
          },
          // Unresolvable location: neither a station nor a solar system id.
          {
            _key: 555,
            agent: { agentTypeID: 2, divisionID: 22, isLocator: false, level: 1 },
            corporationID: 1000130,
            locationID: 99,
            name: { en: "Lost Agent" }
          }
        ]
      },
      {
        name: "agentsInSpace.jsonl",
        rows: [{ _key: 3018343, dungeonID: 416, solarSystemID: 30000142, spawnPointID: 1, typeID: 20520 }]
      },
      {
        name: "npcStations.jsonl",
        rows: [
          {
            stationID: 60003760,
            stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
            solarSystemID: 30000142,
            corporationID: 1000051,
            operationID: 1,
            stationTypeID: 1529
          },
          {
            stationID: 60003761,
            stationName: "Sisters Highsec Bureau",
            solarSystemID: 30000142,
            corporationID: 1000130,
            operationID: 1,
            stationTypeID: 1529
          },
          // Nameless like the real npcStations.jsonl rows: the importer must reconstruct the
          // in-game name from celestialIndex/orbitIndex/owner/operation.
          {
            stationID: 60012583,
            solarSystemID: 30005000,
            ownerID: 1000129,
            operationID: 99,
            celestialIndex: 8,
            orbitIndex: 1,
            stationTypeID: 1529
          }
        ]
      },
      {
        name: "stationOperations.jsonl",
        rows: [{ _key: 99, operationName: { en: "Mining Outpost" } }]
      },
      {
        name: "npcCorporations.jsonl",
        rows: [
          {
            corporationID: 1000051,
            name: { en: "Republic Fleet" },
            factionID: 500001,
            stationID: 60003760,
            solarSystemID: 30000142,
            lpOfferTables: [1]
          },
          {
            corporationID: 100002,
            corporationName: "No Store Corp",
            solarSystemID: 30000142,
            lpOfferTables: []
          },
          {
            corporationID: 1000130,
            name: { en: "Sisters of EVE" },
            factionID: 500016,
            solarSystemID: 30005000,
            lpOfferTables: [2]
          },
          {
            corporationID: 1000129,
            name: { en: "Outer Ring Excavations" },
            factionID: 500014,
            stationID: 60012583,
            solarSystemID: 30005000,
            lpOfferTables: [31]
          },
          {
            corporationID: 1000277,
            name: { en: "Frostline Laboratories" },
            factionID: 500014,
            solarSystemID: 30005000,
            lpOfferTables: [32]
          }
        ]
      },
      {
        name: "blueprints.jsonl",
        rows: [
          {
            blueprintTypeID: 100,
            activities: {
              manufacturing: {
                products: [{ typeID: 101, quantity: 1 }],
                materials: [{ typeID: 200, quantity: 7 }]
              }
            }
          }
        ]
      }
    ])
  );

  const db = new Database(":memory:");
  migrate(db);
  const summary = await importSde(db, { archivePath, archiveUrl: "file://fixture.zip" });

  assert.deepEqual(summary, {
    types: 3,
    systems: 3,
    stations: 3,
    corporations: 5,
    blueprints: 1,
    regions: 2,
    constellations: 2,
    agentTypes: 2,
    corpDivisions: 2,
    agents: 3,
    source: "file://fixture.zip"
  });

  assert.deepEqual(db.prepare("SELECT name, group_name, category_name FROM types WHERE type_id=101").get(), {
    name: "Test Frigate",
    group_name: "Frigate",
    category_name: "Ship"
  });
  assert.deepEqual(db.prepare("SELECT name, risk_tier, region_id, constellation_id FROM systems WHERE system_id=30000142").get(), {
    name: "Jita",
    risk_tier: "HIGHSEC",
    region_id: 10000002,
    constellation_id: 20000020
  });
  assert.deepEqual(
    db.prepare("SELECT risk_tier FROM systems WHERE system_id=30002543").get(),
    { risk_tier: "HIGHSEC" },
    "true sec 0.45-0.49 rounds to 0.5 in-game and must classify as highsec"
  );
  assert.deepEqual(db.prepare("SELECT name FROM regions WHERE region_id=10000002").get(), { name: "The Forge" });
  assert.deepEqual(db.prepare("SELECT name FROM constellations WHERE constellation_id=20000020").get(), { name: "Kimotoro" });
  assert.deepEqual(
    db.prepare("SELECT name FROM stations WHERE station_id=60012583").get(),
    { name: "X-7OMU VIII - Moon 1 - Outer Ring Excavations Mining Outpost" },
    "nameless SDE stations must get the reconstructed in-game name"
  );
  assert.deepEqual(db.prepare("SELECT name FROM npc_corp_divisions WHERE division_id=24").get(), { name: "Security" });
  assert.deepEqual(db.prepare("SELECT name FROM npc_agent_types WHERE agent_type_id=2").get(), { name: "BasicAgent" });
  assert.deepEqual(
    db
      .prepare(
        "SELECT name, corp_id, station_id, system_id, level, division_id, agent_type_id, is_locator, in_space FROM npc_agents WHERE agent_id=3008416"
      )
      .get(),
    {
      name: "Test Agent Five",
      corp_id: 1000051,
      station_id: 60003760,
      system_id: 30000142,
      level: 5,
      division_id: 24,
      agent_type_id: 2,
      is_locator: 1,
      in_space: 0
    }
  );
  assert.deepEqual(
    db.prepare("SELECT station_id, system_id, in_space FROM npc_agents WHERE agent_id=3018343").get(),
    { station_id: null, system_id: 30000142, in_space: 1 },
    "system-located agent keeps a NULL station and is flagged in-space via agentsInSpace membership"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM npc_agents WHERE agent_id IN (555, 999)").pluck().get(),
    0,
    "non-agent NPCs and agents with unresolvable locations must not be imported"
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT has_lp_store, has_level5_agent, has_l4_l5_security_agent, hq_station_id, hq_system_name, risk_tier, access_risk_tier FROM corporations WHERE corp_id=1000051"
      )
      .get(),
    {
      has_lp_store: 1,
      has_level5_agent: 1,
      has_l4_l5_security_agent: 1,
      hq_station_id: 60003760,
      hq_system_name: "Jita",
      risk_tier: "HIGHSEC",
      access_risk_tier: "HIGHSEC"
    }
  );
  assert.deepEqual(
    db
      .prepare("SELECT hq_system_name, risk_tier, access_risk_tier FROM corporations WHERE corp_id=1000130")
      .get(),
    { hq_system_name: "X-7OMU", risk_tier: "NULLSEC", access_risk_tier: "HIGHSEC" }
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT has_lp_store, has_earnable_lp_source, has_level5_agent, has_l4_l5_security_agent, hq_system_name, risk_tier FROM corporations WHERE corp_id=1000129"
      )
      .get(),
    {
      has_lp_store: 1,
      has_earnable_lp_source: 1,
      has_level5_agent: 0,
      has_l4_l5_security_agent: 0,
      hq_system_name: "X-7OMU",
      risk_tier: "NULLSEC"
    }
  );
  assert.deepEqual(
    db
      .prepare("SELECT has_lp_store, has_earnable_lp_source, has_level5_agent, has_l4_l5_security_agent FROM corporations WHERE corp_id=1000277")
      .get(),
    {
      has_lp_store: 1,
      has_earnable_lp_source: 0,
      has_level5_agent: 0,
      has_l4_l5_security_agent: 0
    }
  );
  assert.deepEqual(db.prepare("SELECT product_type_id, quantity FROM blueprint_products WHERE blueprint_type_id=100").get(), {
    product_type_id: 101,
    quantity: 1
  });
  assert.deepEqual(db.prepare("SELECT material_type_id, quantity FROM blueprint_materials WHERE blueprint_type_id=100").get(), {
    material_type_id: 200,
    quantity: 7
  });
  assert.deepEqual(db.prepare("SELECT source, build_number, release_date FROM source_imports").get(), {
    source: "ccp-jsonl-sde",
    build_number: 3346029,
    release_date: "2026-05-13T11:51:25Z"
  });

  db.close();
});

test("importSde with empty blueprints.jsonl does not delete existing blueprint data", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-import-empty-bp-"));
  const archivePath = path.join(tempDir, "fixture-empty-bp.zip");
  fs.writeFileSync(
    archivePath,
    zipBuffer([
      { name: "_sde.jsonl", rows: [{ buildNumber: 9999999, releaseDate: "2026-01-01T00:00:00Z" }] },
      { name: "categories.jsonl", rows: [] },
      { name: "groups.jsonl", rows: [] },
      { name: "types.jsonl", rows: [] },
      { name: "mapSolarSystems.jsonl", rows: [] },
      { name: "npcStations.jsonl", rows: [] },
      { name: "npcCorporations.jsonl", rows: [] },
      { name: "blueprints.jsonl", rows: [] },
      { name: "mapRegions.jsonl", rows: [] },
      { name: "mapConstellations.jsonl", rows: [] },
      { name: "agentTypes.jsonl", rows: [] },
      { name: "npcCorporationDivisions.jsonl", rows: [] },
      { name: "npcCharacters.jsonl", rows: [] },
      { name: "agentsInSpace.jsonl", rows: [] },
      { name: "stationOperations.jsonl", rows: [] }
    ])
  );

  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");

  // Pre-populate blueprint tables with existing data
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (100, 101, 1)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (100, 200, 7)").run();

  await importSde(db, { archivePath, archiveUrl: "file://fixture-empty-bp.zip" });

  // Existing data must be preserved — empty parse must not wipe the tables
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM blueprint_products").pluck().get(),
    1,
    "blueprint_products should be untouched after empty-parse import"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM blueprint_materials").pluck().get(),
    1,
    "blueprint_materials should be untouched after empty-parse import"
  );

  db.close();
});
