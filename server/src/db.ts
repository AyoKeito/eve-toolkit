import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadConfig } from "./config.js";
import { errorMessage } from "./lib/parse.js";
import {
  hasEarnableLpSource,
  level4Or5SecurityBasicAgentCorpIds,
  level5BasicAgentCorpIds
} from "./reference/level5-agent-corps.js";

export type Db = Database.Database;

interface CalcColumn {
  name: string;
  /** SQLite column definition (everything after the column name in the DDL). */
  definition: string;
  /**
   * Base columns are part of the original `calc`/`calc_prev` schema and cannot be
   * added by `ALTER TABLE ADD COLUMN` (a PRIMARY KEY, or NOT NULL with no usable
   * default), so they appear in the CREATE TABLE DDL only and are skipped by the
   * column back-fill migration. Every other column is both created and migrated
   * from this one list, so the DDL and the migration can never drift apart.
   */
  base?: boolean;
}

const calcColumnDefs: CalcColumn[] = [
  { name: "offer_id", definition: "INTEGER PRIMARY KEY", base: true },
  { name: "corp_id", definition: "INTEGER NOT NULL", base: true },
  { name: "offer_name", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "product_signature", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "required_signature", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "primary_product_type_id", definition: "INTEGER" },
  { name: "risk_tier", definition: "TEXT NOT NULL DEFAULT 'HIGHSEC'" },
  { name: "access_risk_tier", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "lp_source_tier", definition: "TEXT NOT NULL DEFAULT 'STANDARD'" },
  { name: "required_standing", definition: "REAL" },
  { name: "is_fw", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "flags_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "warn_flag_count", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "strong_flag_count", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "is_suspicious", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "is_vanity", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "has_manufactured_bpc", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "contract_priced", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "api_summary_json", definition: "TEXT" },
  { name: "isk_per_lp_instant", definition: "REAL" },
  { name: "isk_per_lp_patient", definition: "REAL" },
  { name: "product_value_instant", definition: "REAL" },
  { name: "product_value_patient", definition: "REAL" },
  { name: "input_cost", definition: "REAL" },
  { name: "build_cost", definition: "REAL" },
  { name: "job_cost", definition: "REAL NOT NULL DEFAULT 0" },
  { name: "net_profit_instant", definition: "REAL" },
  { name: "net_profit_patient", definition: "REAL" },
  { name: "capital_required", definition: "REAL" },
  { name: "roi_instant", definition: "REAL" },
  { name: "roi_patient", definition: "REAL" },
  { name: "days_of_supply", definition: "REAL" },
  { name: "days_to_fill", definition: "REAL" },
  { name: "avg_daily_volume_28d", definition: "REAL" },
  { name: "cargo_m3", definition: "REAL" },
  { name: "computed_at", definition: "TEXT NOT NULL", base: true }
];

/** Names of all `calc`/`calc_prev` columns, in DDL order. Exported for schema tests. */
export const calcColumnNames: readonly string[] = calcColumnDefs.map((column) => column.name);

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(dbPath = loadConfig().dbPath): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -262144");
  db.pragma("mmap_size = 1073741824");
  db.pragma("temp_store = MEMORY");
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 67108864");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  migratePricesBook(db);
  migrateHistoryWindowColumns(db);

  const calcColumns = calcColumnDefs.map((column) => `${column.name} ${column.definition}`).join(",\n    ");

  db.exec(`
    CREATE TABLE IF NOT EXISTS corporations(
      corp_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      faction_id INTEGER,
      hq_station_id INTEGER,
      hq_station_name TEXT,
      hq_system_id INTEGER,
      hq_system_name TEXT,
      hq_security_status REAL,
      risk_tier TEXT NOT NULL DEFAULT 'HIGHSEC',
      access_risk_tier TEXT NOT NULL DEFAULT '',
      lp_source_tier TEXT NOT NULL DEFAULT 'STANDARD',
      has_lp_store INTEGER NOT NULL DEFAULT 0,
      has_earnable_lp_source INTEGER NOT NULL DEFAULT 1,
      has_level5_agent INTEGER NOT NULL DEFAULT 0,
      has_l4_l5_security_agent INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS source_imports(
      source TEXT PRIMARY KEY,
      build_number INTEGER,
      release_date TEXT,
      archive_url TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS systems(
      system_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      security_status REAL,
      risk_tier TEXT NOT NULL,
      region_id INTEGER,
      constellation_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS stations(
      station_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      system_id INTEGER NOT NULL,
      owner_corp_id INTEGER,
      operation_id INTEGER,
      type_id INTEGER,
      FOREIGN KEY(system_id) REFERENCES systems(system_id)
    );

    CREATE TABLE IF NOT EXISTS regions(
      region_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS constellations(
      constellation_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_agent_types(
      agent_type_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_corp_divisions(
      division_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      internal_name TEXT
    );

    -- NPC mission agents from the SDE (npcCharacters rows with an agent block). Deliberately
    -- without FK constraints: the importer skips unresolvable rows and reads use LEFT JOINs,
    -- so a partially imported lookup table never poisons the whole SDE transaction.
    CREATE TABLE IF NOT EXISTS npc_agents(
      agent_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      corp_id INTEGER NOT NULL,
      station_id INTEGER,
      system_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      division_id INTEGER,
      agent_type_id INTEGER NOT NULL,
      is_locator INTEGER NOT NULL DEFAULT 0,
      in_space INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS types(
      type_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      group_id INTEGER,
      group_name TEXT,
      category_id INTEGER,
      category_name TEXT,
      volume REAL,
      packaged_volume REAL
    );

    CREATE TABLE IF NOT EXISTS offers(
      offer_id INTEGER PRIMARY KEY,
      esi_offer_id INTEGER,
      corp_id INTEGER NOT NULL,
      lp_cost INTEGER NOT NULL,
      isk_cost REAL NOT NULL,
      fetched_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      FOREIGN KEY(corp_id) REFERENCES corporations(corp_id)
    );

    CREATE TABLE IF NOT EXISTS offer_products(
      offer_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY(offer_id, type_id),
      FOREIGN KEY(offer_id) REFERENCES offers(offer_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS offer_required_items(
      offer_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY(offer_id, type_id),
      FOREIGN KEY(offer_id) REFERENCES offers(offer_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS offer_meta(
      offer_id INTEGER PRIMARY KEY,
      required_standing REAL,
      is_fw INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(offer_id) REFERENCES offers(offer_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prices(
      type_id INTEGER PRIMARY KEY,
      sell_min REAL,
      buy_max REAL,
      sell_order_count INTEGER NOT NULL DEFAULT 0,
      buy_order_count INTEGER NOT NULL DEFAULT 0,
      sell_top_qty_share REAL,
      sell_min_at_jita_44 INTEGER NOT NULL DEFAULT 0,
      rank_hot INTEGER,
      updated_at TEXT,
      FOREIGN KEY(type_id) REFERENCES types(type_id)
    );

    CREATE TABLE IF NOT EXISTS prices_book(
      type_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      rank INTEGER NOT NULL,
      order_id INTEGER,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      location_id INTEGER,
      system_id INTEGER,
      is_jita44 INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(type_id, side, rank)
    );

    CREATE TABLE IF NOT EXISTS history(
      type_id INTEGER PRIMARY KEY,
      avg_daily_volume_28d REAL,
      median_price_28d REAL,
      max_price_28d REAL,
      days INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      FOREIGN KEY(type_id) REFERENCES types(type_id)
    );

    -- Public contracts (ESI), one row per contract ever seen; gone_at marks contracts
    -- that vanished from the region listing. Items are immutable once fetched.
    CREATE TABLE IF NOT EXISTS contracts(
      contract_id INTEGER PRIMARY KEY,
      region_id INTEGER NOT NULL,
      contract_type TEXT NOT NULL,
      price REAL NOT NULL,
      date_issued TEXT NOT NULL,
      date_expired TEXT NOT NULL,
      start_location_id INTEGER,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      gone_at TEXT,
      gone_before_expiry INTEGER,
      items_fetched INTEGER NOT NULL DEFAULT 0,
      single_item_type_id INTEGER,
      single_item_quantity INTEGER,
      single_item_is_bpc INTEGER,
      single_item_runs INTEGER,
      has_excluded_items INTEGER NOT NULL DEFAULT 0,
      fit_hash TEXT,                     -- category-based fit fingerprint of a fitted-ship contract
      fit_ship_type_id INTEGER           -- the hull, when the contract is a clean single pre-fit
    );

    CREATE TABLE IF NOT EXISTS contract_items(
      contract_id INTEGER NOT NULL,
      record_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      is_included INTEGER NOT NULL,
      is_blueprint_copy INTEGER NOT NULL DEFAULT 0,
      runs INTEGER,
      me INTEGER,
      te INTEGER,
      PRIMARY KEY(contract_id, record_id),
      FOREIGN KEY(contract_id) REFERENCES contracts(contract_id) ON DELETE CASCADE
    );

    -- Rolled-up ask prices for contract-only types. Rows persist after asks vanish
    -- (thin BPC supply churns on a timescale of days); consumers filter on updated_at.
    CREATE TABLE IF NOT EXISTS contract_prices(
      type_id INTEGER PRIMARY KEY,
      ask_count INTEGER NOT NULL,
      ask_min REAL,
      ask_median REAL,
      is_bpc INTEGER NOT NULL DEFAULT 0,
      runs_modal INTEGER,
      updated_at TEXT NOT NULL
    );

    -- Lowsec-FW killmails ingested daily from the EVE-Ref archive (each entry is a
    -- verbatim ESI killmail body). One row per killmail; region_id is denormalized
    -- from systems at ingest so trending queries never touch the geography join.
    CREATE TABLE IF NOT EXISTS killmails(
      killmail_id INTEGER PRIMARY KEY,
      killmail_time TEXT NOT NULL,
      solar_system_id INTEGER,
      region_id INTEGER,
      victim_ship_type_id INTEGER,
      victim_character_id INTEGER,
      victim_corporation_id INTEGER,
      victim_alliance_id INTEGER,
      victim_faction_id INTEGER,
      attacker_count INTEGER,
      fit_hash TEXT,
      hash TEXT,
      ingested_at TEXT NOT NULL
    );

    -- Full victim item list, kept lossless (flag + qty) so the fit fingerprint can be
    -- recomputed later if the normalization rules change.
    CREATE TABLE IF NOT EXISTS killmail_items(
      killmail_id INTEGER NOT NULL,
      flag INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY(killmail_id, flag, type_id),
      FOREIGN KEY(killmail_id) REFERENCES killmails(killmail_id) ON DELETE CASCADE
    );

    -- Fit dictionary: one row per distinct fingerprint (hull + fitted modules, ammo
    -- excluded). module_list_json is the buildable shopping list; loss_count is the
    -- lifetime popularity tally. Time-windowed "trending" is a GROUP BY over killmails.
    CREATE TABLE IF NOT EXISTS fits(
      fit_hash TEXT PRIMARY KEY,
      ship_type_id INTEGER NOT NULL,
      module_list_json TEXT NOT NULL,
      module_count INTEGER NOT NULL,
      loss_count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT
    );

    -- CCP daily reference prices (ESI /markets/prices/). adjusted_price is the basis
    -- for the manufacturing job-installation fee (EIV = Σ base_qty × adjusted_price);
    -- average_price is kept for reference only. Refreshed on its own daily cadence,
    -- decoupled from the heavy order-book fetch.
    CREATE TABLE IF NOT EXISTS adjusted_prices(
      type_id INTEGER PRIMARY KEY,
      adjusted_price REAL,
      average_price REAL,
      updated_at TEXT,
      FOREIGN KEY(type_id) REFERENCES types(type_id)
    );

    CREATE TABLE IF NOT EXISTS bp_manufacture(
      blueprint_type_id INTEGER PRIMARY KEY,
      product_type_id INTEGER NOT NULL,
      runs INTEGER NOT NULL DEFAULT 1,
      materials_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blueprint_products(
      blueprint_type_id INTEGER NOT NULL,
      product_type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY(blueprint_type_id, product_type_id)
    );

    CREATE TABLE IF NOT EXISTS blueprint_materials(
      blueprint_type_id INTEGER NOT NULL,
      material_type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY(blueprint_type_id, material_type_id)
    );

    CREATE TABLE IF NOT EXISTS offer_market_types(
      offer_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('PRODUCT', 'REQUIRED_ITEM', 'BUILD_PRODUCT', 'BUILD_MATERIAL')),
      PRIMARY KEY(offer_id, type_id, role),
      FOREIGN KEY(offer_id) REFERENCES offers(offer_id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS offer_search_fts USING fts5(
      offer_name,
      corp_name,
      product_names,
      content=''
    );

    CREATE TABLE IF NOT EXISTS calc(${calcColumns});
    CREATE TABLE IF NOT EXISTS calc_prev(${calcColumns});

    CREATE TABLE IF NOT EXISTS kv(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS response_cache(
      cache_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      body_brotli BLOB,
      etag TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fetcher_status(
      name TEXT PRIMARY KEY,
      last_success TEXT,
      last_error_at TEXT,
      last_error_msg TEXT
    );

    CREATE TABLE IF NOT EXISTS esi_cache(
      cache_key TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      body TEXT NOT NULL,
      headers_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_arcs(
      arc_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      faction TEXT NOT NULL,
      level INTEGER NOT NULL,
      starting_agent TEXT,
      starting_system TEXT,
      description TEXT,
      source_url TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS missions(
      mission_id INTEGER PRIMARY KEY,
      arc_id INTEGER REFERENCES mission_arcs(arc_id),
      arc_position INTEGER,
      prev_mission_id INTEGER,
      next_mission_id INTEGER,
      name TEXT NOT NULL,
      level INTEGER NOT NULL,
      mission_type TEXT NOT NULL,
      faction TEXT,
      is_epic_arc INTEGER NOT NULL DEFAULT 0,
      damage_to_deal TEXT,
      damage_to_resist TEXT,
      recommended_ship TEXT,
      space_risk TEXT,
      briefing_html TEXT,
      objective_html TEXT,
      objective_notes TEXT,
      reward_isk INTEGER,
      reward_lp INTEGER,
      reward_bonus_isk INTEGER,
      bonus_time_seconds INTEGER,
      source_url TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_objective_items(
      mission_id INTEGER NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
      type_id INTEGER,
      type_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      volume_m3 REAL,
      role TEXT NOT NULL,
      PRIMARY KEY(mission_id, type_name)
    );

    CREATE TABLE IF NOT EXISTS mission_pockets(
      pocket_id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
      pocket_index INTEGER NOT NULL,
      name TEXT,
      notes TEXT,
      UNIQUE(mission_id, pocket_index)
    );

    CREATE TABLE IF NOT EXISTS mission_groups(
      group_id INTEGER PRIMARY KEY AUTOINCREMENT,
      pocket_id INTEGER NOT NULL REFERENCES mission_pockets(pocket_id) ON DELETE CASCADE,
      group_index INTEGER NOT NULL,
      label TEXT,
      distance_text TEXT,
      trigger_text TEXT,
      optional INTEGER NOT NULL DEFAULT 0,
      UNIQUE(pocket_id, group_index)
    );

    CREATE TABLE IF NOT EXISTS mission_npcs(
      npc_id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES mission_groups(group_id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL,
      type_id INTEGER,
      type_name TEXT NOT NULL,
      ship_class TEXT,
      bounty_isk INTEGER,
      signature_radius REAL,
      max_velocity REAL,
      orbit_velocity REAL,
      orbit_distance REAL,
      shield_hp INTEGER,
      armor_hp INTEGER,
      hull_hp INTEGER,
      resist_shield_em REAL,
      resist_shield_therm REAL,
      resist_shield_kin REAL,
      resist_shield_exp REAL,
      resist_armor_em REAL,
      resist_armor_therm REAL,
      resist_armor_kin REAL,
      resist_armor_exp REAL,
      turret_dps_em REAL,
      turret_dps_therm REAL,
      turret_dps_kin REAL,
      turret_dps_exp REAL,
      turret_range REAL,
      missile_dps_em REAL,
      missile_dps_therm REAL,
      missile_dps_kin REAL,
      missile_dps_exp REAL,
      missile_range REAL,
      defender_chance_pct REAL,
      ewar_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS mission_links(
      arc_id INTEGER NOT NULL REFERENCES mission_arcs(arc_id) ON DELETE CASCADE,
      from_mission_id INTEGER NOT NULL,
      to_mission_id INTEGER NOT NULL,
      label TEXT,
      PRIMARY KEY(from_mission_id, to_mission_id)
    );

    CREATE INDEX IF NOT EXISTS idx_offers_corp ON offers(corp_id);
    CREATE INDEX IF NOT EXISTS idx_offer_products_type ON offer_products(type_id);
    CREATE INDEX IF NOT EXISTS idx_offer_required_type ON offer_required_items(type_id);
    CREATE INDEX IF NOT EXISTS idx_corporations_name_nocase ON corporations(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_stations_owner ON stations(owner_corp_id, station_id);
    CREATE INDEX IF NOT EXISTS idx_stations_system ON stations(system_id);
    CREATE INDEX IF NOT EXISTS idx_offer_market_types_type ON offer_market_types(type_id, role);
    CREATE INDEX IF NOT EXISTS idx_offer_market_types_offer ON offer_market_types(offer_id);
    CREATE INDEX IF NOT EXISTS idx_prices_rank_hot ON prices(rank_hot);
    CREATE INDEX IF NOT EXISTS idx_prices_book_type_side_rank ON prices_book(type_id, side, rank);
    CREATE INDEX IF NOT EXISTS idx_calc_instant ON calc(isk_per_lp_instant DESC, offer_id);
    CREATE INDEX IF NOT EXISTS idx_calc_patient ON calc(isk_per_lp_patient DESC, offer_id);
    CREATE INDEX IF NOT EXISTS idx_calc_roi ON calc(roi_instant DESC, offer_id);
    CREATE INDEX IF NOT EXISTS idx_calc_days ON calc(days_of_supply ASC, offer_id);
    CREATE INDEX IF NOT EXISTS idx_calc_corp_instant ON calc(corp_id, isk_per_lp_instant DESC, offer_id);
    CREATE INDEX IF NOT EXISTS idx_offer_meta_offer ON offer_meta(offer_id);
    CREATE INDEX IF NOT EXISTS idx_esi_cache_expires ON esi_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_missions_arc_position ON missions(arc_id, arc_position, mission_id);
    CREATE INDEX IF NOT EXISTS idx_missions_filters ON missions(level, mission_type, faction, mission_id);
    CREATE INDEX IF NOT EXISTS idx_mission_pockets_mission ON mission_pockets(mission_id, pocket_index);
    CREATE INDEX IF NOT EXISTS idx_mission_groups_pocket ON mission_groups(pocket_id, group_index);
    CREATE INDEX IF NOT EXISTS idx_mission_npcs_group ON mission_npcs(group_id, npc_id);
    CREATE INDEX IF NOT EXISTS idx_mission_links_arc ON mission_links(arc_id, from_mission_id, to_mission_id);
    CREATE INDEX IF NOT EXISTS idx_npc_agents_corp ON npc_agents(corp_id, system_id, level DESC);
    CREATE INDEX IF NOT EXISTS idx_npc_agents_system ON npc_agents(system_id, corp_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_region_active ON contracts(region_id, gone_at, contract_type);
    CREATE INDEX IF NOT EXISTS idx_contracts_single_type ON contracts(single_item_type_id) WHERE single_item_type_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contracts_gone ON contracts(gone_at) WHERE gone_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contract_items_type ON contract_items(type_id);
    CREATE INDEX IF NOT EXISTS idx_killmails_time ON killmails(killmail_time);
    CREATE INDEX IF NOT EXISTS idx_killmails_fit ON killmails(fit_hash);
    CREATE INDEX IF NOT EXISTS idx_killmails_ship ON killmails(victim_ship_type_id);
    CREATE INDEX IF NOT EXISTS idx_killmail_items_km ON killmail_items(killmail_id);
    CREATE INDEX IF NOT EXISTS idx_fits_ship ON fits(ship_type_id);
  `);

  ensureColumn(db, "offers", "esi_offer_id", "INTEGER");
  ensureColumn(db, "corporations", "lp_source_tier", "TEXT NOT NULL DEFAULT 'STANDARD'");
  const addedCorpAccessRisk = ensureColumn(db, "corporations", "access_risk_tier", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "corporations", "has_lp_store", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "corporations", "has_earnable_lp_source", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "corporations", "has_level5_agent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "corporations", "has_l4_l5_security_agent", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "types", "category_id", "INTEGER");
  ensureColumn(db, "types", "category_name", "TEXT");
  ensureColumn(db, "systems", "region_id", "INTEGER");
  ensureColumn(db, "systems", "constellation_id", "INTEGER");
  ensureColumn(db, "esi_cache", "headers_json", "TEXT");
  ensureColumn(db, "missions", "space_risk", "TEXT");
  ensureColumn(db, "missions", "objective_notes", "TEXT");
  ensureColumn(db, "contracts", "fit_hash", "TEXT");
  ensureColumn(db, "contracts", "fit_ship_type_id", "INTEGER");
  ensureCalcColumns(db, "calc");
  ensureCalcColumns(db, "calc_prev");
  db.exec(`
    -- Indexes on migrated (ensureColumn) columns must be created AFTER the columns exist on an
    -- already-populated prod DB — hence this second exec, after the contracts fit_* back-fill above.
    CREATE INDEX IF NOT EXISTS idx_contracts_fit ON contracts(fit_hash) WHERE fit_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contracts_fitship ON contracts(fit_ship_type_id) WHERE fit_ship_type_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_corporations_lp_store ON corporations(has_lp_store, corp_id);
    CREATE INDEX IF NOT EXISTS idx_corporations_earnable_lp_source ON corporations(has_earnable_lp_source, corp_id);
    CREATE INDEX IF NOT EXISTS idx_corporations_level5_agent ON corporations(has_level5_agent, corp_id);
    CREATE INDEX IF NOT EXISTS idx_corporations_l4_l5_security_agent ON corporations(has_l4_l5_security_agent, corp_id);
    DROP INDEX IF EXISTS idx_calc_default_filter;
    -- Rebuild without the dropped all_sell_legs_jita44 column: an existing prod index
    -- created with it would otherwise survive the IF NOT EXISTS below untouched.
    DROP INDEX IF EXISTS idx_calc_fast_filters;
    CREATE INDEX IF NOT EXISTS idx_calc_fast_filters ON calc(
      access_risk_tier,
      lp_source_tier,
      is_fw,
      is_suspicious,
      is_vanity,
      has_manufactured_bpc,
      isk_per_lp_instant DESC
    );
    CREATE INDEX IF NOT EXISTS idx_calc_volume ON calc(avg_daily_volume_28d DESC, offer_id);
  `);
  db.prepare("UPDATE corporations SET lp_source_tier='STANDARD' WHERE lp_source_tier IS NULL OR lp_source_tier=''").run();
  if (addedCorpAccessRisk) {
    db.prepare("UPDATE corporations SET access_risk_tier=risk_tier").run();
  } else {
    db.prepare("UPDATE corporations SET access_risk_tier=risk_tier WHERE access_risk_tier IS NULL OR access_risk_tier=''").run();
  }
  db.prepare("UPDATE corporations SET lp_source_tier='SPECIAL' WHERE corp_id IN (1000125, 1000137) OR name IN ('CONCORD', 'DED')").run();
  syncEarnableLpSourceFlags(db);
  // Prefer agent flags derived from imported SDE agent rows; the static reference lists only
  // cover fresh databases that have not imported npc_agents yet. Without this guard a process
  // restart would overwrite the data-derived flags with the hand-maintained lists.
  if (!syncAgentDerivedCorpFlags(db)) {
    syncBooleanCorpFlag(db, "has_level5_agent", level5BasicAgentCorpIds);
    syncBooleanCorpFlag(db, "has_l4_l5_security_agent", level4Or5SecurityBasicAgentCorpIds);
  }
}

function syncEarnableLpSourceFlags(db: Db): void {
  const rows = db.prepare("SELECT corp_id FROM corporations").all() as Array<{ corp_id: number }>;
  const update = db.prepare("UPDATE corporations SET has_earnable_lp_source=? WHERE corp_id=?");
  const tx = db.transaction(() => {
    for (const row of rows) update.run(hasEarnableLpSource(row.corp_id) ? 1 : 0, row.corp_id);
  });
  tx();
}

/**
 * Derives corporation agent flags from imported npc_agents rows. Returns false (and changes
 * nothing) when no agent rows exist, so callers can fall back to the static reference lists in
 * reference/level5-agent-corps.ts — which become deletable once every deployment has agent data.
 * Thresholds mirror that file: BasicAgent (type 2) level 5, and Security (division 24) level 4-5.
 */
export function syncAgentDerivedCorpFlags(db: Db): boolean {
  if (!tableExists(db, "npc_agents") || countRows(db, "npc_agents") === 0) return false;
  const level5 = (db.prepare(
    "SELECT DISTINCT corp_id FROM npc_agents WHERE level=5 AND agent_type_id=2 AND in_space=0"
  ).all() as Array<{ corp_id: number }>).map((row) => row.corp_id);
  const l4l5Security = (db.prepare(
    "SELECT DISTINCT corp_id FROM npc_agents WHERE level>=4 AND agent_type_id=2 AND division_id=24 AND in_space=0"
  ).all() as Array<{ corp_id: number }>).map((row) => row.corp_id);
  syncBooleanCorpFlag(db, "has_level5_agent", level5);
  syncBooleanCorpFlag(db, "has_l4_l5_security_agent", l4l5Security);
  return true;
}

function syncBooleanCorpFlag(db: Db, column: string, corpIds: Iterable<number>): void {
  const update = db.prepare(`UPDATE corporations SET ${column}=1 WHERE corp_id=?`);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE corporations SET ${column}=0`).run();
    for (const corpId of corpIds) update.run(corpId);
  });
  tx();
}

function tableExists(db: Db, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function tableColumns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name));
}

function migratePricesBook(db: Db): void {
  if (!tableExists(db, "prices_book")) return;
  if (tableColumns(db, "prices_book").has("rank")) return;

  db.exec(`
    ALTER TABLE prices_book RENAME TO prices_book_legacy;
    CREATE TABLE prices_book(
      type_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      rank INTEGER NOT NULL,
      order_id INTEGER,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      location_id INTEGER,
      system_id INTEGER,
      is_jita44 INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(type_id, side, rank)
    );
    INSERT INTO prices_book(type_id, side, rank, price, qty, location_id)
    SELECT type_id, side, ix, price, qty, location_id
    FROM prices_book_legacy;
    DROP TABLE prices_book_legacy;
  `);
}

function migrateHistoryWindowColumns(db: Db): void {
  renameColumnIfExists(db, "history", "avg_daily_volume_30d", "avg_daily_volume_28d");
  renameColumnIfExists(db, "history", "median_price_30d", "median_price_28d");
  renameColumnIfExists(db, "history", "max_price_30d", "max_price_28d");
  renameColumnIfExists(db, "calc", "avg_daily_volume_30d", "avg_daily_volume_28d");
  renameColumnIfExists(db, "calc_prev", "avg_daily_volume_30d", "avg_daily_volume_28d");
}

function renameColumnIfExists(db: Db, table: string, oldColumn: string, newColumn: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = tableColumns(db, table);
  if (!columns.has(oldColumn) || columns.has(newColumn)) return false;
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldColumn} TO ${newColumn}`);
  return true;
}

function ensureCalcColumns(db: Db, table: "calc" | "calc_prev"): void {
  for (const column of calcColumnDefs) {
    if (column.base) continue;
    const added = ensureColumn(db, table, column.name, column.definition);
    // access_risk_tier seeds from the older risk_tier column when first added.
    if (added && column.name === "access_risk_tier") {
      db.prepare(`UPDATE ${table} SET access_risk_tier=risk_tier`).run();
    }
  }
}

function ensureColumn(db: Db, table: string, column: string, definition: string): boolean {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

export function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function recordFetcherSuccess(db: Db, name: string): void {
  db.prepare(`
    INSERT INTO fetcher_status(name, last_success, last_error_at, last_error_msg)
    VALUES (?, ?, NULL, NULL)
    ON CONFLICT(name) DO UPDATE SET
      last_success=excluded.last_success,
      last_error_at=NULL,
      last_error_msg=NULL
  `).run(name, nowIso());
}

export function recordFetcherFailure(db: Db, name: string, error: unknown): void {
  const message = errorMessage(error);
  db.prepare(`
    INSERT INTO fetcher_status(name, last_success, last_error_at, last_error_msg)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_error_at=excluded.last_error_at,
    last_error_msg=excluded.last_error_msg
  `).run(name, nowIso(), message.slice(0, 1000));
}

export function recordFetcherFailureBestEffort(db: Db, name: string, error: unknown): void {
  try {
    recordFetcherFailure(db, name, error);
  } catch (recordError) {
    console.warn(
      JSON.stringify({
        component: "fetcher_status",
        event: "failure_record_skipped",
        fetcher: name,
        original_error: errorMessage(error),
        record_error: errorMessage(recordError)
      })
    );
  }
}

export interface RecordSourceImportOptions {
  /**
   * When true, the ON CONFLICT clause also updates `build_number` and
   * `release_date` (needed for SDE imports which carry real build metadata).
   * When false/omitted, those two columns are left unchanged on conflict
   * (correct for missions-seed which always inserts NULL for them).
   */
  updateBuildInfo?: boolean;
}

export function recordSourceImport(
  db: Db,
  source: string,
  archiveUrl: string,
  importedAt: string,
  metadataJson: string,
  buildNumber: string | number | null = null,
  releaseDate: string | null = null,
  opts: RecordSourceImportOptions = {}
): void {
  const updateBuildInfo = opts.updateBuildInfo ?? false;
  const conflictSet = updateBuildInfo
    ? `build_number=excluded.build_number,
      release_date=excluded.release_date,
      archive_url=excluded.archive_url,
      imported_at=excluded.imported_at,
      metadata_json=excluded.metadata_json`
    : `archive_url=excluded.archive_url,
      imported_at=excluded.imported_at,
      metadata_json=excluded.metadata_json`;
  db.prepare(`
    INSERT INTO source_imports(source, build_number, release_date, archive_url, imported_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      ${conflictSet}
  `).run(source, buildNumber, releaseDate, archiveUrl, importedAt, metadataJson);
}

export function closeDb(db: Db): void {
  db.close();
}
