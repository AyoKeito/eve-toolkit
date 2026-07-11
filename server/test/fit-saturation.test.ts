import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, type Db } from "../src/db.js";
import { computeContractFit } from "../src/fetchers/esi-contracts.js";
import { hashFit, computeFitHash } from "../src/fetchers/killmails.js";
import { rebuildContractPrices } from "../src/calc/contract-prices.js";
import { computeTrending } from "../src/api/fits.js";

// EVE inventory category ids used by the fit fingerprint: ship=6, module/rig=7, charge=8,
// drone=18, subsystem=32. Killmail fitted-slot flags: low 11-18, mid 19-26, high 27-34, rigs
// 92-99, subsystems 125-132.
const CAT_SHIP = 6;
const CAT_MODULE = 7;
const CAT_CHARGE = 8;
const CAT_DRONE = 18;
const CAT_SUBSYSTEM = 32;

// Stable type ids for the fixture fit (one hull, two modules, one subsystem, plus ammo/drone).
const HULL = 100;
const MOD1 = 300;
const MOD2 = 301;
const SUB = 400;
const CHARGE = 500;
const DRONE = 600;

// A category lookup mirroring what the fetcher builds from the `types` table.
function categoryLookup(map: Record<number, number>): (typeId: number) => number | undefined {
  return (typeId: number) => map[typeId];
}

const CLEAN_CATEGORY = categoryLookup({
  [HULL]: CAT_SHIP,
  [MOD1]: CAT_MODULE,
  [MOD2]: CAT_MODULE,
  [SUB]: CAT_SUBSYSTEM,
  [CHARGE]: CAT_CHARGE,
  [DRONE]: CAT_DRONE
});

// The canonical fit hash for the clean fixture fit: hull + the two modules + the subsystem,
// each at qty 1. This is the cross-source target every clean-fit path must agree on.
const CLEAN_FIT_HASH = hashFit(
  HULL,
  new Map<number, number>([
    [MOD1, 1],
    [MOD2, 1],
    [SUB, 1]
  ])
).fitHash;

function farFutureIso(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}
function recentPastIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

test("a clean pre-fit contract hashes IDENTICALLY to a killmail and to hashFit (cross-source match)", () => {
  // Supply side: a public contract carrying one hull + two modules + one subsystem, all included,
  // no slot flags (contracts have none).
  const contractItems = [
    { is_included: true, quantity: 1, type_id: HULL },
    { is_included: true, quantity: 1, type_id: MOD1 },
    { is_included: true, quantity: 1, type_id: MOD2 },
    { is_included: true, quantity: 1, type_id: SUB }
  ];
  const fit = computeContractFit(contractItems, CLEAN_CATEGORY);
  assert.ok(fit, "a single-hull clean pre-fit must produce a fit");
  assert.equal(fit.shipTypeId, HULL);

  // (a) equals the canonical hashFit of the same (hull, type:qty) aggregate.
  assert.equal(fit.fitHash, CLEAN_FIT_HASH, "contract fit must equal hashFit aggregate");

  // (b) equals a killmail of the same fit: the SAME modules placed in fitted slots (high 27, 28;
  // subsystem 125), with destroyed/dropped quantities; nothing is a charge.
  const killmailItems = [
    { item_type_id: HULL, flag: 0, quantity_destroyed: 1, quantity_dropped: 0 }, // hull slot is ignored anyway
    { item_type_id: MOD1, flag: 27, quantity_destroyed: 1, quantity_dropped: 0 },
    { item_type_id: MOD2, flag: 28, quantity_destroyed: 0, quantity_dropped: 1 },
    { item_type_id: SUB, flag: 125, quantity_destroyed: 1, quantity_dropped: 0 }
  ];
  const isCharge = () => false;
  const kmFit = computeFitHash(HULL, killmailItems, isCharge);
  assert.equal(kmFit.fitHash, CLEAN_FIT_HASH, "killmail fit must equal the same canonical hash");
  assert.equal(fit.fitHash, kmFit.fitHash, "contract and killmail of the same fit hash identically");
});

test("charges and drones in the contract are excluded from the fit fingerprint", () => {
  // The same clean fit PLUS an included charge (cat 8) and an included drone (cat 18). These must
  // be dropped (only cat 7 modules/rigs and cat 32 subsystems contribute), so the hash is unchanged.
  const contractItems = [
    { is_included: true, quantity: 1, type_id: HULL },
    { is_included: true, quantity: 1, type_id: MOD1 },
    { is_included: true, quantity: 1, type_id: MOD2 },
    { is_included: true, quantity: 1, type_id: SUB },
    { is_included: true, quantity: 1000, type_id: CHARGE }, // ammo: excluded
    { is_included: true, quantity: 5, type_id: DRONE } // drones: excluded
  ];
  const fit = computeContractFit(contractItems, CLEAN_CATEGORY);
  assert.ok(fit);
  assert.equal(fit.fitHash, CLEAN_FIT_HASH, "charges/drones must not change the fit hash");
});

test("computeContractFit returns null without exactly one single-unit hull", () => {
  // (a) No hull at all — a lone BPC (cat 9) ask.
  const bpcOnly = [{ is_included: true, quantity: 1, type_id: 900 }];
  assert.equal(computeContractFit(bpcOnly, categoryLookup({ 900: 9 })), null, "no cat-6 hull => null");

  // (b) Two distinct hulls — a multi-ship bundle, not one fit.
  const twoHulls = [
    { is_included: true, quantity: 1, type_id: HULL },
    { is_included: true, quantity: 1, type_id: 101 },
    { is_included: true, quantity: 1, type_id: MOD1 }
  ];
  assert.equal(
    computeContractFit(twoHulls, categoryLookup({ [HULL]: CAT_SHIP, 101: CAT_SHIP, [MOD1]: CAT_MODULE })),
    null,
    "two distinct hulls => null"
  );

  // (c) A single hull but quantity 2 — multiple copies of the ship, not one pre-fit.
  const doubleHull = [
    { is_included: true, quantity: 2, type_id: HULL },
    { is_included: true, quantity: 1, type_id: MOD1 }
  ];
  assert.equal(computeContractFit(doubleHull, CLEAN_CATEGORY), null, "hull quantity 2 => null");
});

test("a build kit (clean fit + a spare module in cargo) hashes DIFFERENTLY than the clean fit", () => {
  // Contracts carry no slot flags, so a spare module riding in cargo is indistinguishable from a
  // fitted one and folds into the fingerprint — deliberately producing a fit hash no killmail
  // matches (conservative: never a false competition match).
  const buildKit = [
    { is_included: true, quantity: 1, type_id: HULL },
    { is_included: true, quantity: 1, type_id: MOD1 },
    { is_included: true, quantity: 1, type_id: MOD2 },
    { is_included: true, quantity: 1, type_id: SUB },
    { is_included: true, quantity: 1, type_id: 302 } // spare cat-7 module in cargo
  ];
  const fit = computeContractFit(buildKit, categoryLookup({
    [HULL]: CAT_SHIP,
    [MOD1]: CAT_MODULE,
    [MOD2]: CAT_MODULE,
    [SUB]: CAT_SUBSYSTEM,
    302: CAT_MODULE
  }));
  assert.ok(fit);
  assert.notEqual(fit.fitHash, CLEAN_FIT_HASH, "an extra cargo module must yield a different hash");
});

function seedSingleItemBpc(
  db: Db,
  contractId: number,
  regionId: number,
  typeId: number,
  price: number,
  runs = 1
): void {
  const future = farFutureIso();
  const past = recentPastIso();
  db.prepare(
    `
    INSERT INTO contracts(
      contract_id, region_id, contract_type, price, date_issued, date_expired,
      first_seen_at, last_seen_at, gone_at, items_fetched,
      single_item_type_id, single_item_quantity, single_item_is_bpc, single_item_runs, has_excluded_items
    )
    VALUES (?, ?, 'item_exchange', ?, ?, ?, ?, ?, NULL, 1, ?, 1, 1, ?, 0)
  `
  ).run(contractId, regionId, price, past, future, past, past, typeId, runs);
}

test("rebuildContractPrices scopes the rollup to the price regions, excluding warzone asks", () => {
  const db = new Database(":memory:");
  migrate(db);

  const BPC = 57144;
  const PRODUCT = 57145;
  // A recipe whose product trades on the market, so the recipe cap admits the (modest) Forge asks
  // and the rollup can publish — same setup contract-prices.test.ts uses.
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (?, ?, 1, '[]')").run(BPC, PRODUCT);
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, 'Built Product')").run(PRODUCT);
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (?, 1000, 900, 5, 5, 1)"
  ).run(PRODUCT);

  // Two qualifying asks in The Forge (10000002) at 100 / 120.
  seedSingleItemBpc(db, 1, 10000002, BPC, 100);
  seedSingleItemBpc(db, 2, 10000002, BPC, 120);
  // Two qualifying asks in a warzone region (10000069, Black Rise) at far lower prices: if these
  // leaked into the rollup they would drag ask_min down to 5 and bump ask_count to 4.
  seedSingleItemBpc(db, 3, 10000069, BPC, 5);
  seedSingleItemBpc(db, 4, 10000069, BPC, 6);

  const published = rebuildContractPrices(db);
  assert.equal(published, 1, "only the Forge book of this one type publishes");

  const row = db.prepare("SELECT * FROM contract_prices WHERE type_id=?").get(BPC) as
    | { ask_min: number; ask_count: number }
    | undefined;
  assert.ok(row, "the Forge asks must publish a price");
  assert.equal(row.ask_count, 2, "only the two Forge asks are counted, not the warzone pair");
  assert.equal(row.ask_min, 100, "ask_min reflects the Forge floor (100), not the warzone 5");

  db.close();
});

// --- test 6: computeTrending competition fields -----------------------------------------------
// Reuses the fits-api seeding shape: one ranked destroyer fit with enough recent losses.
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const RANKED_HULL = 100; // Corax destroyer (group 420)
const RANKED_FIT_HASH = "RANKEDFIT";

function seedRankedFit(db: Db): void {
  db.pragma("foreign_keys = OFF");
  const type = db.prepare(
    "INSERT INTO types(type_id, name, group_id, group_name, category_id, volume, packaged_volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  type.run(RANKED_HULL, "Corax", 420, "Destroyer", 6, 55_000, 55_000);
  type.run(300, "Mod A", 7, "Module A", 7, 5, 5);
  type.run(301, "Mod B", 7, "Module B", 7, 10, 10);

  db.prepare("INSERT INTO regions(region_id, name) VALUES (?, ?)").run(100, "Black Rise");
  db.prepare(
    "INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(10, "Tama", 0.3, "LOWSEC", 100, 1);

  db.prepare(
    "INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(RANKED_FIT_HASH, RANKED_HULL, JSON.stringify([{ type_id: 300, qty: 2 }, { type_id: 301, qty: 1 }]), 3, 5, RECENT, RECENT);

  const km = db.prepare(
    "INSERT INTO killmails(killmail_id, killmail_time, fit_hash, victim_character_id, solar_system_id, region_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (let i = 1; i <= 5; i++) km.run(i, RECENT, RANKED_FIT_HASH, i, 10, 100, RECENT);
}

function seedHullContract(
  db: Db,
  contractId: number,
  regionId: number,
  price: number,
  fitHash: string | null
): void {
  db.prepare(
    `
    INSERT INTO contracts(
      contract_id, region_id, contract_type, price, date_issued, date_expired,
      first_seen_at, last_seen_at, gone_at, items_fetched, fit_hash, fit_ship_type_id
    )
    VALUES (?, ?, 'item_exchange', ?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `
  ).run(contractId, regionId, price, recentPastIso(), farFutureIso(), recentPastIso(), recentPastIso(), fitHash, fitHash ? RANKED_HULL : null);
  // computeTrending's hull supply join reads contract_items for an included row whose type_id is
  // the hull — that is what counts a contract as "selling this hull".
  db.prepare(
    "INSERT INTO contract_items(contract_id, record_id, type_id, quantity, is_included, is_blueprint_copy, runs) VALUES (?, 1, ?, 1, 1, 0, NULL)"
  ).run(contractId, RANKED_HULL);
}

test("computeTrending reports hull/exact/cheapest/jita competition fields for a ranked fit", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedRankedFit(db);

  // (a) Warzone (10000069) contract selling this hull with the EXACT ranked fit_hash, priced 9M.
  seedHullContract(db, 1001, 10000069, 9_000_000, RANKED_FIT_HASH);
  // (b) Warzone contract selling the same hull but a DIFFERENT fit_hash, priced 7M (the cheaper).
  seedHullContract(db, 1002, 10000069, 7_000_000, "OTHERFIT");
  // (c) Forge (10000002) contract selling this hull — the "only seller in Jita?" check.
  seedHullContract(db, 1003, 10000002, 8_000_000, RANKED_FIT_HASH);

  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const fit = res.fits.find((f) => f.fit_hash === RANKED_FIT_HASH);
  assert.ok(fit, "the seeded fit must rank");

  assert.equal(fit.hull_contracts, 2, "both warzone hull contracts count toward supply");
  assert.equal(fit.exact_contracts, 1, "only the fit_hash match counts as an exact pre-fit");
  assert.equal(fit.cheapest_ask, 7_000_000, "cheapest_ask is the MIN price among the warzone hull contracts");
  assert.equal(fit.jita_contracts, 1, "one Forge contract sells this hull");

  // A Jita-only hull contract must NOT bump hull_contracts (that field is warzone-scoped).
  const before = fit.hull_contracts;
  seedHullContract(db, 1004, 10000002, 6_000_000, "OTHERFIT2");
  const res2 = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const fit2 = res2.fits.find((f) => f.fit_hash === RANKED_FIT_HASH)!;
  assert.equal(fit2.hull_contracts, before, "a Jita-only hull contract does not raise warzone hull_contracts");
  assert.equal(fit2.jita_contracts, 2, "but it does raise the Forge (jita) count");

  db.close();
});

test("computeTrending excludes barter/scam contracts from hull supply and cheapest_ask", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedRankedFit(db);

  // A genuine warzone cash ask for this hull at 8M.
  seedHullContract(db, 2001, 10000069, 8_000_000, RANKED_FIT_HASH);
  // A barter contract offering the same hull for price 0 (it wants items in return, not ISK). It
  // must NOT count as supply and must NOT drag cheapest_ask down to 0.
  seedHullContract(db, 2002, 10000069, 0, null);
  // A price>0 contract that asks excluded items in return (has_excluded_items=1) — also not a real
  // cash ask a competing seller sets.
  seedHullContract(db, 2003, 10000069, 5_000_000, null);
  db.prepare("UPDATE contracts SET has_excluded_items = 1 WHERE contract_id = 2003").run();

  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const fit = res.fits.find((f) => f.fit_hash === RANKED_FIT_HASH);
  assert.ok(fit, "the seeded fit must rank");
  assert.equal(fit.hull_contracts, 1, "only the genuine cash ask counts; barter and item-request contracts are excluded");
  assert.equal(fit.cheapest_ask, 8_000_000, "cheapest_ask ignores the price-0 barter and the has_excluded_items ask");

  db.close();
});

test("migrate on a legacy contracts DB adds fit_hash/fit_ship_type_id and the idx_contracts_fit index", () => {
  const db = new Database(":memory:");

  // A pre-existing contracts table WITHOUT the fit_hash / fit_ship_type_id columns (the column list
  // from db.ts minus those two), plus a minimal contract_items table and one populated row. This is
  // the prod shape before the migration that adds the fit fingerprint.
  db.exec(`
    CREATE TABLE contracts(
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
      has_excluded_items INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE contract_items(
      contract_id INTEGER NOT NULL,
      record_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      is_included INTEGER NOT NULL,
      PRIMARY KEY(contract_id, record_id)
    );
  `);
  const past = recentPastIso();
  db.prepare(
    `INSERT INTO contracts(
       contract_id, region_id, contract_type, price, date_issued, date_expired,
       first_seen_at, last_seen_at, items_fetched, has_excluded_items
     ) VALUES (1, 10000002, 'item_exchange', 100, ?, ?, ?, ?, 1, 0)`
  ).run(past, farFutureIso(), past, past);
  db.prepare("INSERT INTO contract_items(contract_id, record_id, type_id, quantity, is_included) VALUES (1, 1, 100, 1, 1)").run();

  // The migration must back-fill the two columns BEFORE creating the index on them (the
  // ensureColumn-then-index ordering this guards), so it must not throw on a populated legacy DB.
  assert.doesNotThrow(() => migrate(db), "migrate must not throw on a legacy contracts DB");

  const cols = new Set(
    (db.prepare("PRAGMA table_info(contracts)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  assert.ok(cols.has("fit_hash"), "fit_hash column added");
  assert.ok(cols.has("fit_ship_type_id"), "fit_ship_type_id column added");

  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contracts_fit'")
    .get() as { name: string } | undefined;
  assert.ok(idx, "idx_contracts_fit index exists after migration");

  // The pre-existing row survives the migration untouched (back-fill is additive).
  const row = db.prepare("SELECT fit_hash, price FROM contracts WHERE contract_id=1").get() as
    | { fit_hash: string | null; price: number }
    | undefined;
  assert.ok(row);
  assert.equal(row.fit_hash, null, "the legacy row's new fit_hash defaults to NULL");
  assert.equal(row.price, 100);

  db.close();
});
