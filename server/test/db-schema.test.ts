import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, calcColumnNames } from "../src/db.js";

function schemaObjectNames(db: Database.Database, type: "table" | "index"): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type=?").all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name));
}

test("migration creates defuzz schema objects", () => {
  const db = new Database(":memory:");
  migrate(db);

  const tables = schemaObjectNames(db, "table");
  const indexes = schemaObjectNames(db, "index");

  for (const table of [
    "source_imports",
    "systems",
    "stations",
    "blueprint_products",
    "blueprint_materials",
    "offer_market_types",
    "offer_search_fts",
    "kv",
    "response_cache",
    "mission_arcs",
    "missions",
    "mission_objective_items",
    "mission_pockets",
    "mission_groups",
    "mission_npcs",
    "regions",
    "constellations",
    "npc_agent_types",
    "npc_corp_divisions",
    "npc_agents",
    "contracts",
    "contract_items",
    "contract_prices",
    "adjusted_prices"
  ]) {
    assert.ok(tables.has(table), `missing table ${table}`);
  }

  assert.ok(indexes.has("idx_calc_fast_filters"));
  assert.equal(indexes.has("idx_calc_default_filter"), false);
  assert.ok(indexes.has("sqlite_autoindex_kv_1"));
  assert.ok(indexes.has("sqlite_autoindex_response_cache_1"));
  assert.ok(indexes.has("idx_esi_cache_expires"));
  assert.ok(indexes.has("idx_corporations_level5_agent"));
  assert.ok(indexes.has("idx_corporations_l4_l5_security_agent"));
  assert.ok(indexes.has("idx_corporations_earnable_lp_source"));
  assert.ok(indexes.has("idx_missions_arc_position"));
  assert.ok(indexes.has("idx_mission_npcs_group"));
  assert.ok(indexes.has("idx_npc_agents_corp"));
  assert.ok(indexes.has("idx_npc_agents_system"));
  assert.ok(indexes.has("idx_contracts_region_active"));
  assert.ok(indexes.has("idx_contracts_single_type"));
  assert.ok(indexes.has("idx_contracts_gone"));

  const systemColumns = columnNames(db, "systems");
  assert.ok(systemColumns.has("region_id"));
  assert.ok(systemColumns.has("constellation_id"));

  const corpColumns = new Set(
    (db.prepare("PRAGMA table_info(corporations)").all() as Array<{ name: string }>).map((col) => col.name)
  );
  assert.ok(corpColumns.has("has_level5_agent"));
  assert.ok(corpColumns.has("has_l4_l5_security_agent"));
  assert.ok(corpColumns.has("has_earnable_lp_source"));

  const npcColumns = new Set(
    (db.prepare("PRAGMA table_info(mission_npcs)").all() as Array<{ name: string }>).map((col) => col.name)
  );
  assert.ok(npcColumns.has("resist_shield_em"));
  assert.ok(npcColumns.has("turret_dps_therm"));
  assert.ok(npcColumns.has("ewar_json"));

  db.close();
});

test("migration backfills earnable LP, normal level 5, and level 4 or 5 Security agent corporation flags", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE corporations(
      corp_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      risk_tier TEXT NOT NULL DEFAULT 'HIGHSEC'
    );
    INSERT INTO corporations(corp_id, name, risk_tier)
    VALUES
      (1000051, 'Republic Fleet', 'HIGHSEC'),
      (1000129, 'Outer Ring Excavations', 'NULLSEC'),
      (1000179, '24th Imperial Crusade', 'LOWSEC'),
      (1000277, 'Frostline Laboratories', 'NULLSEC'),
      (999999, 'No Security Corp', 'HIGHSEC');
  `);

  migrate(db);

  assert.deepEqual(
    db
      .prepare("SELECT corp_id, has_earnable_lp_source, has_level5_agent, has_l4_l5_security_agent FROM corporations ORDER BY corp_id")
      .all(),
    [
      { corp_id: 999999, has_earnable_lp_source: 0, has_level5_agent: 0, has_l4_l5_security_agent: 0 },
      { corp_id: 1000051, has_earnable_lp_source: 1, has_level5_agent: 1, has_l4_l5_security_agent: 1 },
      { corp_id: 1000129, has_earnable_lp_source: 1, has_level5_agent: 0, has_l4_l5_security_agent: 0 },
      { corp_id: 1000179, has_earnable_lp_source: 1, has_level5_agent: 0, has_l4_l5_security_agent: 0 },
      { corp_id: 1000277, has_earnable_lp_source: 0, has_level5_agent: 0, has_l4_l5_security_agent: 0 }
    ]
  );

  db.close();
});

test("migration derives agent corp flags from npc_agents instead of the static lists once agents exist", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO corporations(corp_id, name) VALUES (1000051, 'Republic Fleet'), (777777, 'Data Corp');
    INSERT INTO npc_agents(agent_id, name, corp_id, station_id, system_id, level, division_id, agent_type_id, is_locator, in_space)
    VALUES
      (1, 'L5 Sec', 777777, 60000001, 30000001, 5, 24, 2, 0, 0),
      (2, 'L4 Sec In Space', 1000051, NULL, 30000001, 4, 24, 2, 0, 1);
  `);

  // Re-running migrate must now prefer the imported agent rows: corp 777777 gains both flags
  // from its L5 Security BasicAgent, while corp 1000051 — despite being on the static lists —
  // loses them because its only agent is in-space.
  migrate(db);

  assert.deepEqual(
    db.prepare("SELECT corp_id, has_level5_agent, has_l4_l5_security_agent FROM corporations ORDER BY corp_id").all(),
    [
      { corp_id: 777777, has_level5_agent: 1, has_l4_l5_security_agent: 1 },
      { corp_id: 1000051, has_level5_agent: 0, has_l4_l5_security_agent: 0 }
    ]
  );

  db.close();
});

test("migration adds 28-day volume cache column before indexing existing calc tables", () => {
  const db = new Database(":memory:");
  const legacyCalcColumns = `
    offer_id INTEGER PRIMARY KEY,
    corp_id INTEGER NOT NULL,
    offer_name TEXT NOT NULL DEFAULT '',
    product_signature TEXT NOT NULL DEFAULT '',
    required_signature TEXT NOT NULL DEFAULT '',
    primary_product_type_id INTEGER,
    risk_tier TEXT NOT NULL DEFAULT 'HIGHSEC',
    lp_source_tier TEXT NOT NULL DEFAULT 'STANDARD',
    required_standing REAL,
    is_fw INTEGER NOT NULL DEFAULT 0,
    flags_json TEXT NOT NULL DEFAULT '[]',
    warn_flag_count INTEGER NOT NULL DEFAULT 0,
    strong_flag_count INTEGER NOT NULL DEFAULT 0,
    is_suspicious INTEGER NOT NULL DEFAULT 0,
    isk_per_lp_instant REAL,
    isk_per_lp_patient REAL,
    product_value_instant REAL,
    product_value_patient REAL,
    input_cost REAL,
    build_cost REAL,
    net_profit_instant REAL,
    net_profit_patient REAL,
    capital_required REAL,
    roi_instant REAL,
    roi_patient REAL,
    days_of_supply REAL,
    cargo_m3 REAL,
    computed_at TEXT NOT NULL
  `;
  db.exec(`
    CREATE TABLE calc(${legacyCalcColumns});
    CREATE TABLE calc_prev(${legacyCalcColumns});
  `);

  migrate(db);

  const calcColumns = columnNames(db, "calc");
  assert.ok(calcColumns.has("avg_daily_volume_28d"));
  assert.equal(calcColumns.has("avg_daily_volume_30d"), false);
  assert.ok(schemaObjectNames(db, "index").has("idx_calc_volume"));

  db.close();
});

test("migration back-fills every calc column from the single source of truth on a legacy DB", () => {
  const db = new Database(":memory:");
  // A legacy calc/calc_prev pair holding only the original columns the pre-back-fill
  // indexes reference. The non-indexed value columns (product_value_*, *_cost,
  // net_profit_*, capital_required, roi_patient, cargo_m3) are deliberately absent —
  // those are exactly the columns the old hand-written migration list never added.
  const legacyCalc = `
    offer_id INTEGER PRIMARY KEY,
    corp_id INTEGER NOT NULL,
    isk_per_lp_instant REAL,
    isk_per_lp_patient REAL,
    roi_instant REAL,
    days_of_supply REAL,
    computed_at TEXT NOT NULL
  `;
  db.exec(`
    CREATE TABLE calc(${legacyCalc});
    CREATE TABLE calc_prev(${legacyCalc});
  `);

  migrate(db);

  for (const table of ["calc", "calc_prev"]) {
    const cols = columnNames(db, table);
    for (const name of calcColumnNames) {
      assert.ok(cols.has(name), `${table} is missing ${name} after migration`);
    }
  }

  db.close();
});

test("migration renames 30-day history and calc columns to 28-day columns", () => {
  const db = new Database(":memory:");
  const legacyCalcColumns = `
    offer_id INTEGER PRIMARY KEY,
    corp_id INTEGER NOT NULL,
    isk_per_lp_instant REAL,
    isk_per_lp_patient REAL,
    roi_instant REAL,
    days_of_supply REAL,
    avg_daily_volume_30d REAL,
    computed_at TEXT NOT NULL
  `;
  db.exec(`
    CREATE TABLE history(
      type_id INTEGER PRIMARY KEY,
      avg_daily_volume_30d REAL,
      median_price_30d REAL,
      max_price_30d REAL,
      days INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO history(type_id, avg_daily_volume_30d, median_price_30d, max_price_30d, days)
    VALUES (10, 123, 456, 789, 30);
    CREATE TABLE calc(${legacyCalcColumns});
    CREATE TABLE calc_prev(${legacyCalcColumns});
    INSERT INTO calc(offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, roi_instant, days_of_supply, avg_daily_volume_30d, computed_at)
    VALUES (1, 1, 100, 90, 0.1, 2, 321, 'now');
    INSERT INTO calc_prev(offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, roi_instant, days_of_supply, avg_daily_volume_30d, computed_at)
    VALUES (2, 1, 200, 190, 0.2, 3, 654, 'then');
    CREATE INDEX idx_calc_volume ON calc(avg_daily_volume_30d DESC, offer_id);
  `);

  migrate(db);

  const historyColumns = columnNames(db, "history");
  assert.ok(historyColumns.has("avg_daily_volume_28d"));
  assert.ok(historyColumns.has("median_price_28d"));
  assert.ok(historyColumns.has("max_price_28d"));
  assert.equal(historyColumns.has("avg_daily_volume_30d"), false);
  assert.equal(historyColumns.has("median_price_30d"), false);
  assert.equal(historyColumns.has("max_price_30d"), false);

  for (const table of ["calc", "calc_prev"]) {
    const calcColumns = columnNames(db, table);
    assert.ok(calcColumns.has("avg_daily_volume_28d"));
    assert.equal(calcColumns.has("avg_daily_volume_30d"), false);
  }

  assert.deepEqual(db.prepare("SELECT avg_daily_volume_28d, median_price_28d, max_price_28d FROM history").get(), {
    avg_daily_volume_28d: 123,
    median_price_28d: 456,
    max_price_28d: 789
  });
  assert.equal(db.prepare("SELECT avg_daily_volume_28d FROM calc").pluck().get(), 321);
  assert.equal(db.prepare("SELECT avg_daily_volume_28d FROM calc_prev").pluck().get(), 654);
  const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_calc_volume'").pluck().get() as
    | string
    | null;
  assert.match(indexSql ?? "", /avg_daily_volume_28d/);

  db.close();
});
