import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, type Db } from "../src/db.js";
import {
  bumpComputeGeneration,
  markComputeDirty
} from "../src/lib/compute-generation.js";
import { getMarketSnapshot } from "../src/calc/market-snapshot.js";
import { runFetcher } from "../src/lib/fetcher.js";
import { calculateOffer, createOfferCalcMemo, recomputeAndPersist, SELL_VARIANT_OFFSET } from "../src/calc/ratio.js";

/** Small fixture exercising the plain-item, manufacture, and contract-priced paths. */
function buildFixture(): Db {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, hq_station_name, hq_system_name, hq_security_status) VALUES (?, ?, ?, ?, ?, ?)").run(
    1,
    "Test Corp",
    "HIGHSEC",
    "Jita IV-4",
    "Jita",
    0.9
  );

  const types: Array<[number, string, number]> = [
    [100, "Widget", 5],
    [200, "Widget Blueprint", 0.01],
    [300, "Built Thing", 10],
    [400, "Tritanium", 0.01],
    [500, "Required Input", 1],
    [600, "Rare Blueprint", 0.01],
    [700, "Rare Product", 20]
  ];
  const insType = db.prepare(
    "INSERT INTO types(type_id, name, group_id, group_name, category_id, category_name, volume, packaged_volume) VALUES (?, ?, 1, 'Group', 7, 'Module', ?, ?)"
  );
  for (const [id, name, vol] of types) insType.run(id, name, vol, vol);

  const insOffer = db.prepare(
    "INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, ?, ?, 'now', '{}')"
  );
  insOffer.run(1, 1000, 0);
  insOffer.run(2, 5000, 1_000_000);
  insOffer.run(3, 2000, 0);

  const insProduct = db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)");
  insProduct.run(1, 100, 2);
  insProduct.run(2, 200, 1000);
  insProduct.run(3, 600, 1000);
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(2, 500, 1);

  db.prepare("INSERT INTO offer_meta(offer_id, required_standing, is_fw) VALUES (2, 5.0, 0)").run();

  // blueprint_products (200) and bp_manufacture-style recipe path both covered.
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (200, 300, 1)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (200, 400, 100)").run();
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (600, 700, 5)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (600, 400, 50)").run();

  const insPrice = db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_top_qty_share, sell_min_at_jita_44) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  insPrice.run(100, 1_200_000, 1_000_000, 3, 3, 0.5, 1);
  insPrice.run(300, 500_000, 400_000, 5, 5, 0.4, 1);
  insPrice.run(400, 5, 4, 9, 9, 0.9, 1);
  insPrice.run(500, 20_000, 15_000, 4, 4, 0.6, 1);
  insPrice.run(700, 2_000_000, 1_800_000, 2, 2, 0.3, 0);
  // type 600 deliberately has NO prices row → lacksMarketPrice, contract fallback.

  const insBook = db.prepare(
    "INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insBook.run(100, "sell", 0, 1, 1_200_000, 5, 60003760, 30000142, 1);
  insBook.run(100, "buy", 0, 2, 1_000_000, 10, 60003760, 30000142, 1);
  insBook.run(300, "sell", 0, 3, 500_000, 50, 60003760, 30000142, 1);
  insBook.run(300, "buy", 0, 4, 400_000, 100, 60003760, 30000142, 1);
  insBook.run(400, "sell", 0, 5, 5, 100_000, 60003760, 30000142, 1);
  insBook.run(500, "sell", 0, 6, 20_000, 100, 60003760, 30000142, 1);
  insBook.run(700, "sell", 0, 7, 2_000_000, 10, 60003760, 30000142, 0);
  insBook.run(700, "buy", 0, 8, 1_800_000, 10, 60003760, 30000142, 0);

  const insHist = db.prepare(
    "INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (?, ?, ?, ?, 28)"
  );
  insHist.run(100, 500, 1_150_000, 1_300_000);
  insHist.run(300, 1000, 450_000, 550_000);
  insHist.run(700, 3, 1_900_000, 2_100_000);

  db.prepare("INSERT INTO adjusted_prices(type_id, adjusted_price, average_price) VALUES (400, 6, 6)").run();

  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (600, 3, 300000, 320000, 1, 5, ?)"
  ).run(new Date().toISOString());

  return db;
}

const QUERY = { hideVanity: false, includeSpecial: true };

/** Strips per-run computed_at fields so two calc passes compare byte-identical. */
function stripComputedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComputedAt);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "computed_at") continue;
      out[key] = stripComputedAt(v);
    }
    return out;
  }
  return value;
}

test("getMarketSnapshot reuses the snapshot while the validity token is unchanged", () => {
  const db = buildFixture();
  const first = getMarketSnapshot(db);
  const second = getMarketSnapshot(db);
  assert.equal(first, second, "same object returned when token is unchanged");
  db.close();
});

test("getMarketSnapshot is reused across a bare generation bump (data unchanged)", () => {
  const db = buildFixture();
  const before = getMarketSnapshot(db);
  // A recompute bumps the generation but does not change snapshot-mirrored market
  // data, so the snapshot must survive — this is what keeps it warm post-recompute.
  bumpComputeGeneration(db);
  const after = getMarketSnapshot(db);
  assert.equal(before, after, "generation bump alone does not rebuild the snapshot");
  db.close();
});

test("getMarketSnapshot rebuilds when the dirty marker changes", () => {
  const db = buildFixture();
  const before = getMarketSnapshot(db);
  markComputeDirty(db, "ingest");
  const after = getMarketSnapshot(db);
  assert.notEqual(before, after, "dirty marker change forces a rebuild");
  assert.notEqual(before.token, after.token);
  db.close();
});

test("a mirrored write through runFetcher invalidates the snapshot (warmup/CLI staleness regression)", async () => {
  const db = buildFixture();
  const before = getMarketSnapshot(db);
  assert.equal(before.prices.get(100)?.sell_min, 1_200_000);
  // Warmup and write CLIs invoke fetchers directly, bypassing markComputeDirty. The
  // fetcher shell must still bump the data version, or the live path serves the stale
  // snapshot until the next scheduled ingest (the regression this guards).
  await runFetcher(db, "test-prices", async () => {
    db.prepare("UPDATE prices SET sell_min=? WHERE type_id=?").run(9_999_999, 100);
  });
  const after = getMarketSnapshot(db);
  assert.notEqual(before, after, "runFetcher write must rebuild the snapshot");
  assert.equal(after.prices.get(100)?.sell_min, 9_999_999, "rebuilt snapshot reflects the fetcher's write");
  db.close();
});

test("the snapshot recompute warms is reused by the next query (no cold rebuild)", () => {
  const db = buildFixture();
  recomputeAndPersist(db);
  const warmed = getMarketSnapshot(db);
  // Post-recompute serving path: generation bumped and response cache was rewritten,
  // but no snapshot-mirrored data changed, so the snapshot recompute built must be
  // handed back as-is rather than cold-rebuilt.
  const served = getMarketSnapshot(db);
  assert.equal(warmed, served, "post-recompute query reuses the warmed snapshot");
  db.close();
});

test("calculateOffer is output-identical with and without the snapshot", () => {
  const db = buildFixture();
  const snapshotMemo = createOfferCalcMemo(getMarketSnapshot(db));
  const sqlMemo = createOfferCalcMemo();

  const ids = [1, 2, 3, 1 + SELL_VARIANT_OFFSET, 2 + SELL_VARIANT_OFFSET, 3 + SELL_VARIANT_OFFSET];
  let nonNull = 0;
  for (const id of ids) {
    const viaSql = calculateOffer(db, id, QUERY, sqlMemo);
    const viaSnapshot = calculateOffer(db, id, QUERY, snapshotMemo);
    if (viaSql !== null) nonNull += 1;
    assert.deepEqual(
      stripComputedAt(viaSnapshot),
      stripComputedAt(viaSql),
      `offer ${id} differs between snapshot and SQL paths`
    );
  }
  assert.ok(nonNull >= 3, "fixture should produce several non-null rows");
  db.close();
});
