import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { effectiveRuns } from "../src/calc/budget.js";
import { walkOrders } from "../src/calc/depth.js";
import { feeRates } from "../src/calc/fees.js";
import { estimateDaysToFill } from "../src/calc/fill.js";
import { qualityFlags, suspicious } from "../src/calc/flags.js";
import { calculateOffer, listOfferCalcs, recomputeAndPersist, summarizeOfferCalc } from "../src/calc/ratio.js";
import { leastRiskTier, riskAllowed, riskTierFromSecurity } from "../src/calc/risk.js";

test("walkOrders depth-walks and extrapolates the missing tail", () => {
  const result = walkOrders(
    [
      { price: 10, qty: 3, location_id: 1 },
      { price: 12, qty: 2, location_id: 2 }
    ],
    8
  );

  assert.equal(result.total_value, 90);
  assert.equal(result.filled_qty, 5);
  assert.equal(result.missing_qty, 3);
  assert.equal(result.insufficient_depth, true);
  assert.equal(result.orders.length, 3);
});

test("calculateOffer keeps source order metadata on depth-walked orders", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Order Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Order Module", 1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 1);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (100, 1200000, 1000000, 1, 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (100, 'sell', 0, 12345, 1200000, 5, 60003760, 30000142, 1)
  `).run();

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });

  assert.ok(row);
  assert.equal(row.sales_targets[0]?.walk.orders[0]?.order_id, 12345);
  assert.equal(row.sales_targets[0]?.walk.orders[0]?.system_id, 30000142);
  assert.equal(row.sales_targets[0]?.walk.orders[0]?.is_jita44, 1);

  db.close();
});

test("walkOrders skips invalid book rows and logs the first bad row", () => {
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };

  try {
    const result = walkOrders(
      [
        { price: Number.NaN, qty: 5, location_id: 1 },
        { price: 20, qty: 2, location_id: 2 },
        { price: Number.POSITIVE_INFINITY, qty: 20, location_id: 3 }
      ],
      4
    );

    assert.equal(result.total_value, 80);
    assert.equal(result.filled_qty, 2);
    assert.equal(result.missing_qty, 2);
    assert.equal(result.insufficient_depth, true);
    assert.equal(result.orders.length, 2);
    assert.equal(warnings, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("feeRates applies current Tranquility skill and standing formulas", () => {
  const defaults = feeRates();
  assert.equal(defaults.salesTaxRate, 0.075);
  assert.equal(defaults.brokerFeeRate, 0.03);

  const trained = feeRates({ acc: 5, bro: 5, factionStand: 10, corpStand: 10 });
  // Accounting V: 7.5% * (1 - 0.55) = 3.375%
  assert.ok(Math.abs(trained.salesTaxRate - 0.03375) < 1e-12);
  // Broker Relations V plus max standings bottoms out at the 1% floor
  assert.equal(trained.brokerFeeRate, 0.01);

  const brokerOnly = feeRates({ bro: 5 });
  // -0.3 percentage points per level: 3% -> 1.5% at V
  assert.ok(Math.abs(brokerOnly.brokerFeeRate - 0.015) < 1e-12);
});

test("noMarketFees zeroes sales tax and broker fee for the contract-sale channel", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Channel Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Faction Module', 1)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (100, 60000000, 50000000, 5, 5, 1)"
  ).run();

  // Default market sale: the patient channel pays sales tax (7.5%) + broker (3%);
  // the instant channel hits the bid and pays sales tax only.
  const market = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(market);
  assert.equal(market.fees.salesTaxRate, 0.075);
  assert.equal(market.fees.brokerFeeRate, 0.03);
  assert.ok(Math.abs(market.net_profit_patient - 60_000_000 * (1 - 0.075 - 0.03)) < 1e-6); // 53.7M
  assert.ok(Math.abs((market.net_profit_instant ?? 0) - 50_000_000 * (1 - 0.075)) < 1e-6); // 46.25M

  // Contract-sale channel: both fee rates zeroed, so net = gross with no fee drag.
  // (Skill sliders floor at 3.375% tax / 1% broker and can never reach this.)
  const contract = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, noMarketFees: true });
  assert.ok(contract);
  assert.equal(contract.fees.salesTaxRate, 0);
  assert.equal(contract.fees.brokerFeeRate, 0);
  assert.equal(contract.net_profit_patient, 60_000_000);
  assert.equal(contract.net_profit_instant, 50_000_000);

  db.close();
});

test("noMarketFees bypasses the cached calc rows persisted with default fees", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Channel Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Faction Module', 1)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (100, 60000000, 50000000, 5, 5, 1)"
  ).run();

  // Persist calc rows under the default (skill-floored) fee model.
  recomputeAndPersist(db);

  // A noMarketFees query must force the live path, not return the cached default-fee
  // net (53.7M). cacheEligible() treats noMarketFees as a custom-fee override.
  const baseQuery = { hideVanity: false, hideSuspicious: false, hideNoSecurity: false, includeSpecial: true } as const;
  const cached = listOfferCalcs(db, baseQuery);
  assert.equal(cached.length, 1);
  assert.ok(Math.abs(cached[0].net_profit_patient - 60_000_000 * (1 - 0.075 - 0.03)) < 1e-6); // 53.7M, cached

  const noFees = listOfferCalcs(db, { ...baseQuery, noMarketFees: true });
  assert.equal(noFees.length, 1);
  assert.equal(noFees[0].net_profit_patient, 60_000_000); // recomputed live, fee-free

  db.close();
});

test("a non-default facility forces the live path so ME and job cost apply", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Build Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15676, 'Some Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (15677, 'Some Module', 1)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (34, 'Tritanium', 0.01)").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, ?)").run(
    JSON.stringify([{ type_id: 34, quantity: 100 }])
  );
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (15677, 60000000, 50000000, 5, 5, 1)"
  ).run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (34, 5, 4, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();

  // Persist default-view rows (NPC facility, ME-0): build_cost = 500.
  recomputeAndPersist(db);
  const baseQuery = { hideVanity: false, hideSuspicious: false, hideNoSecurity: false, includeSpecial: true, bpc: "manufacture" } as const;
  const cached = listOfferCalcs(db, baseQuery);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].build_cost, 500); // ME-0 cached row

  // null-T2 must bypass the cache and apply ME: 100 → 95 units → build_cost 475.
  const nullT2 = listOfferCalcs(db, { ...baseQuery, facility: "null-t2" });
  assert.equal(nullT2.length, 1);
  assert.equal(nullT2[0].build_cost, 95 * 5);

  db.close();
});

test("effectiveRuns honors LP and ISK budgets", () => {
  assert.equal(effectiveRuns(1000, 2_000_000, { runs: 10 }), 10);
  assert.equal(effectiveRuns(1000, 2_000_000, { lpBudget: 4500 }), 4);
  assert.equal(effectiveRuns(1000, 2_000_000, { iskBudget: 5_500_000 }), 2);
  assert.equal(effectiveRuns(1000, 2_000_000, { lpBudget: 10_000, iskBudget: 5_500_000 }), 2);
});

test("risk tier filtering follows highsec to nullsec progression", () => {
  assert.equal(riskTierFromSecurity(0.9), "HIGHSEC");
  assert.equal(riskTierFromSecurity(0.2), "LOWSEC");
  assert.equal(riskTierFromSecurity(-0.1), "NULLSEC");
  assert.equal(riskTierFromSecurity(null), "NULLSEC");
  // Game boundary is the rounded value: true sec 0.45-0.49 displays 0.5 and is highsec.
  assert.equal(riskTierFromSecurity(0.45), "HIGHSEC");
  assert.equal(riskTierFromSecurity(0.449), "LOWSEC");
  // Any positive sec is lowsec (displays at least 0.1); exactly 0.0 is nullsec.
  assert.equal(riskTierFromSecurity(0.02), "LOWSEC");
  assert.equal(riskTierFromSecurity(0), "NULLSEC");
  assert.equal(riskAllowed("LOWSEC", "HIGHSEC"), false);
  assert.equal(riskAllowed("LOWSEC", "LOWSEC"), true);
  assert.equal(riskAllowed("WORMHOLE", "NULLSEC"), true);
  assert.equal(riskAllowed("WORMHOLE", "LOWSEC"), false);
  assert.equal(leastRiskTier(["WORMHOLE"]), "NULLSEC");
});

test("default offer list includes nullsec and legacy wormhole risk tiers when no max risk filter is requested", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'High Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (2, 'Low Corp', 'LOWSEC')").run();
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (3, 'Wormhole Corp', 'WORMHOLE')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'High Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'Low Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (300, 'Wormhole Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (3, 3, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (3, 300, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);
  insertPrice.run(300);

  const rows = listOfferCalcs(db, { hideVanity: false, includeFW: true, n: 10 });

  assert.deepEqual(rows.map((row) => row.corp_name).sort(), ["High Corp", "Low Corp", "Wormhole Corp"]);

  db.close();
});

test("offer list can filter rows above a max cargo volume", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Cargo Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Compact Crate', 50)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (200, 'Freighter Crate', 600)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(100);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(200);
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (100, 1000, 1000000, 1000000, 28)").run();
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (200, 1000, 1000000, 1000000, 28)").run();

  const rows = listOfferCalcs(db, { maxM3: 100, n: 10, hideVanity: false });

  assert.deepEqual(rows.map((row) => row.offer_name), ["Compact Crate"]);
  assert.equal(rows[0]?.cargo_m3, 50);
  db.close();
});

test("quality flags classify suspicious rows", () => {
  const flags = qualityFlags({
    productQty: 100,
    avgDailyVolume28d: 10,
    historyDays: 3,
    medianPrice28d: 100,
    sellMin: 250,
    buyMax: 100,
    sellOrderCount: 1,
    sellTopQtyShare: 0.9,
    sellMinAtJita44: false,
    insufficientDepth: true
  });

  assert.ok(flags.some((flag) => flag.code === "PRICE_SPIKE"));
  assert.equal(suspicious(flags), true);
});

test("quality flags mark sub-100 daily volume as a warning", () => {
  const lowVolumeFlags = qualityFlags({
    productQty: 1,
    avgDailyVolume28d: 99,
    historyDays: 30,
    medianPrice28d: 100,
    sellMin: 100,
    buyMax: 100,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  });
  const enoughVolumeFlags = qualityFlags({
    productQty: 100,
    avgDailyVolume28d: 100,
    historyDays: 30,
    medianPrice28d: 100,
    sellMin: 100,
    buyMax: 100,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  });

  assert.deepEqual(
    lowVolumeFlags.filter((flag) => flag.code === "LOW_VOLUME").map((flag) => flag.severity),
    ["warn"]
  );
  assert.equal(enoughVolumeFlags.some((flag) => flag.code === "LOW_VOLUME"), false);
});

test("low volume is ISK-aware: expensive items moving real ISK on few units pass", () => {
  const base = {
    productQty: 5,
    historyDays: 30,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  };
  // 20/day at 500m median = 10b ISK/day of trade
  const expensiveLiquid = qualityFlags({
    ...base,
    avgDailyVolume28d: 20,
    medianPrice28d: 500_000_000,
    sellMin: 550_000_000,
    buyMax: 450_000_000
  });
  assert.equal(expensiveLiquid.some((flag) => flag.code === "LOW_VOLUME"), false);

  // 20/day at 1m median = 20m ISK/day stays flagged
  const cheapTrickle = qualityFlags({
    ...base,
    avgDailyVolume28d: 20,
    medianPrice28d: 1_000_000,
    sellMin: 1_100_000,
    buyMax: 900_000
  });
  assert.ok(cheapTrickle.some((flag) => flag.code === "LOW_VOLUME"));
});

test("buy-side spikes flag strongly, normal buy maxima do not", () => {
  const base = {
    productQty: 10,
    avgDailyVolume28d: 1000,
    historyDays: 30,
    medianPrice28d: 100,
    sellMin: 120,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  };
  const spiked = qualityFlags({ ...base, buyMax: 200 });
  assert.ok(spiked.some((flag) => flag.code === "BUY_SPIKE" && flag.severity === "strong"));
  assert.equal(suspicious(spiked), true);

  const normal = qualityFlags({ ...base, buyMax: 90 });
  assert.equal(normal.some((flag) => flag.code === "BUY_SPIKE"), false);
});

test("slow fill warns past 7 days of volume and turns strong past 28", () => {
  const base = {
    avgDailyVolume28d: 1000,
    historyDays: 30,
    medianPrice28d: 1_000_000,
    sellMin: 1_100_000,
    buyMax: 900_000,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  };
  const quick = qualityFlags({ ...base, productQty: 1000 });
  assert.equal(quick.some((flag) => flag.code === "SLOW_FILL"), false);

  const warn = qualityFlags({ ...base, productQty: 10_000 });
  assert.deepEqual(warn.filter((flag) => flag.code === "SLOW_FILL").map((flag) => flag.severity), ["warn"]);

  const strong = qualityFlags({ ...base, productQty: 40_000 });
  assert.deepEqual(strong.filter((flag) => flag.code === "SLOW_FILL").map((flag) => flag.severity), ["strong"]);
});

test("queue-aware slow fill counts the queue against the sell-side share of volume", () => {
  const base = {
    productQty: 1000,
    avgDailyVolume28d: 1000,
    historyDays: 30,
    medianPrice28d: 1_000_000,
    sellMin: 1_100_000,
    buyMax: 900_000,
    sellOrderCount: 10,
    sellTopQtyShare: 0.1,
    sellMinAtJita44: true,
    insufficientDepth: false
  };
  // (0 + 1000) / (0.5 * 1000) = 2 days
  const front = qualityFlags({ ...base, queueAheadQty: 0 });
  assert.equal(front.some((flag) => flag.code === "SLOW_FILL"), false);

  // (5000 + 1000) / 500 = 12 days
  const queued = qualityFlags({ ...base, queueAheadQty: 5000 });
  assert.deepEqual(queued.filter((flag) => flag.code === "SLOW_FILL").map((flag) => flag.severity), ["warn"]);

  // (20000 + 1000) / 500 = 42 days
  const buried = qualityFlags({ ...base, queueAheadQty: 20_000 });
  assert.deepEqual(buried.filter((flag) => flag.code === "SLOW_FILL").map((flag) => flag.severity), ["strong"]);
});

test("days-to-fill estimator counts sell-book units at or below the list price", () => {
  const book = [
    { price: 100, qty: 300, location_id: 1 },
    { price: 110, qty: 200, location_id: 1 },
    { price: 150, qty: 5000, location_id: 1 }
  ];

  // listing at the front level: only its own depth queues ahead
  const front = estimateDaysToFill(book, 100, 200, 1000);
  assert.equal(front.queueAhead, 300);
  assert.equal(front.daysToFill, (300 + 200) / (0.5 * 1000));

  // a list price between levels counts only levels at or below it
  const between = estimateDaysToFill(book, 105, 400, 100);
  assert.equal(between.queueAhead, 300);

  // listing at the second level queues behind both cheap levels, not the expensive tail
  const walked = estimateDaysToFill(book, 110, 400, 100);
  assert.equal(walked.queueAhead, 500);
  assert.equal(walked.daysToFill, (500 + 400) / (0.5 * 100));

  // no market history -> queue is measured but days stay null
  const noHistory = estimateDaysToFill(book, 100, 200, null);
  assert.equal(noHistory.queueAhead, 300);
  assert.equal(noHistory.daysToFill, null);

  // synthetic fallback levels (no persisted book) never count as queue
  const synthetic = estimateDaysToFill(
    [{ price: 100, qty: Number.MAX_SAFE_INTEGER, location_id: null }],
    100,
    200,
    1000
  );
  assert.equal(synthetic.queueAhead, 0);
  assert.equal(synthetic.daysToFill, (0 + 200) / (0.5 * 1000));
});

test("realistic patient discounts the patient valuation by fill time and relist fees", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Fill Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Queued Module', 1)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (100, 1000000, 800000, 10, 10, 1)
  `).run();
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, price, qty, is_jita44) VALUES
    (100, 'sell', 0, 1000000, 500, 1),
    (100, 'buy', 0, 800000, 1000, 1)
  `).run();
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (100, 10, 900000, 1000000, 28)").run();

  const off = calculateOffer(db, 1, { hideVanity: false });
  assert.ok(off);
  // queue 500 at the 1m list price plus own unit, against 0.5 * 10/day
  assert.equal(off.fill_queue_ahead, 500);
  assert.equal(off.days_to_fill, (500 + 1) / (0.5 * 10));

  const on = calculateOffer(db, 1, { hideVanity: false, realisticPatient: true, advBro: 5 });
  assert.ok(on);
  assert.equal(on.days_to_fill, off.days_to_fill);
  assert.equal(on.net_profit_instant, off.net_profit_instant);

  const relists = Math.ceil((off.days_to_fill as number) / 2) - 1;
  const relistCost = relists * (1 - 0.8) * off.fees.brokerFeeRate * off.product_value_patient;
  const offNetInstant = off.net_profit_instant as number;
  const expected =
    offNetInstant +
    (off.net_profit_patient - relistCost - offNetInstant) * Math.exp(-(off.days_to_fill as number) / 7);
  assert.ok(Math.abs(on.net_profit_patient - expected) < 1e-6);
  assert.ok(on.net_profit_patient < off.net_profit_patient);

  // untrained Advanced Broker Relations pays bigger relist fees -> worse than at V
  const untrained = calculateOffer(db, 1, { hideVanity: false, realisticPatient: true });
  assert.ok(untrained);
  assert.ok(untrained.net_profit_patient <= on.net_profit_patient);

  db.close();
});

test("offer list hides vanity apparel, SKIN, and personalization products by default", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");

  const insertType = db.prepare("INSERT INTO types(type_id, name, group_id, group_name) VALUES (?, ?, ?, ?)");
  insertType.run(100, "Useful Module", 53, "Energy Weapon");
  insertType.run(200, "Women's Test Jacket", 1088, "Outer");
  insertType.run(300, "Test Ship SKIN", 1950, "Permanent SKIN");
  insertType.run(400, "Test Ship Emblem", 4471, "Ship Emblems");

  const insertOffer = db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (?, 1, 1000, 0, 'now', '{}')
  `);
  const insertProduct = db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)");
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 2000000, 2000000, 10, 10, 1)
  `);

  for (const [offerId, typeId] of [
    [1, 100],
    [2, 200],
    [3, 300],
    [4, 400]
  ]) {
    insertOffer.run(offerId);
    insertProduct.run(offerId, typeId);
    insertPrice.run(typeId);
  }

  assert.deepEqual(
    listOfferCalcs(db, { maxRiskTier: "HIGHSEC", n: 10 }).map((row) => row.offer_name),
    ["Useful Module"]
  );
  assert.deepEqual(
    listOfferCalcs(db, { maxRiskTier: "HIGHSEC", n: 10, hideVanity: false } as never).map((row) => row.offer_name),
    ["Useful Module", "Women's Test Jacket", "Test Ship SKIN", "Test Ship Emblem"]
  );

  db.close();
});

test("default offer list takes ranked candidates from the precomputed calc table", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");
  const insertType = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  insertType.run(100, "Live Expensive Module");
  insertType.run(200, "Cached Winner Module");

  const insertOffer = db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (?, 1, 1000, 0, 'now', '{}')
  `);
  insertOffer.run(1);
  insertOffer.run(2);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  insertPrice.run(100, 10_000_000, 10_000_000);
  insertPrice.run(200, 1_000_000, 1_000_000);

  const insertCalc = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, product_value_instant,
      product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (?, 1, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `);
  insertCalc.run(1, 100);
  insertCalc.run(2, 10_000);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    minVolume: 0,
    hideVanity: false,
    includeFW: true,
    sortBy: "instant",
    n: 1
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].offer_id, 2);

  db.close();
});

test("offer list ignores ascending sort direction requests", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Sort Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Low LP Module");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "High LP Module");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, ?, 0, 'now', '{}')").run(1, 100);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, ?, 0, 'now', '{}')").run(2, 10_000);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);

  const insertCalc = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, product_value_instant,
      product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (?, 1, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `);
  insertCalc.run(1, 1000);
  insertCalc.run(2, 900);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    sortBy: "lp",
    sortDir: "asc",
    n: 2
  });

  assert.deepEqual(rows.map((row) => row.offer_id), [2, 1]);

  db.close();
});

test("offer list exposes and sorts by average daily market volume", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Volume Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Thin Volume Module");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "Busy Volume Module");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    2
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(100);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(200);
  const insertHistory = db.prepare(
    "INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (?, ?, 1000000, 1000000, 28)"
  );
  insertHistory.run(100, 50);
  insertHistory.run(200, 500);

  recomputeAndPersist(db);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    minVolume: 0,
    hideVanity: false,
    includeFW: true,
    sortBy: "volume",
    n: 2
  });

  assert.deepEqual(rows.map((row) => row.offer_id), [2, 1]);
  assert.equal(rows[0].avg_daily_volume_28d, 500);
  assert.equal(summarizeOfferCalc(rows[0]).avg_daily_volume_28d, 500);

  db.close();
});

test("offer search matches item names without matching corporation names", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Search Corp", "HIGHSEC");
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(2, "Other Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Plain Module");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "Search Module");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, ?, 1000, 0, 'now', '{}')").run(
    1,
    1
  );
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, ?, 1000, 0, 'now', '{}')").run(
    2,
    2
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 2000000, 2000000, 10, 10, 1)
  `).run(100);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 2000000, 2000000, 10, 10, 1)
  `).run(200);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    search: "Search",
    n: 10
  });

  assert.deepEqual(
    rows.map((row) => `${row.corp_name}:${row.offer_name}`),
    ["Other Corp:Search Module"]
  );

  db.close();
});

test("global offer list groups identical store economics by default", () => {
  const db = new Database(":memory:");
  migrate(db);

  const insertCorp = db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)");
  insertCorp.run(1, "Alpha Logistics", "HIGHSEC");
  insertCorp.run(2, "Beta Logistics", "HIGHSEC");
  insertCorp.run(3, "Gamma Logistics", "HIGHSEC");

  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Duplicate Charge");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "Unique Module");

  const insertOffer = db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (?, ?, 1000, 1000000, 'now', '{}')
  `);
  insertOffer.run(1, 1);
  insertOffer.run(2, 2);
  insertOffer.run(3, 3);
  const insertProduct = db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)");
  insertProduct.run(1, 100);
  insertProduct.run(2, 100);
  insertProduct.run(3, 200);

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  insertPrice.run(100, 10_000_000, 10_000_000);
  insertPrice.run(200, 8_000_000, 8_000_000);

  const insertCalc = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, product_value_instant,
      product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `);
  insertCalc.run(1, 1, 9_000);
  insertCalc.run(2, 2, 9_000);
  insertCalc.run(3, 3, 7_000);

  const grouped = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10
  });

  assert.deepEqual(
    grouped.map((row) => row.offer_name),
    ["Duplicate Charge", "Unique Module"]
  );
  assert.equal(grouped[0].corp_name, "Alpha Logistics");
  assert.equal(grouped[0].store_count, 2);
  assert.deepEqual(
    grouped[0].store_options?.map((store) => store.corp_name),
    ["Alpha Logistics", "Beta Logistics"]
  );

  const raw = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    showDuplicateStores: true,
    n: 10
  });

  assert.deepEqual(
    raw.map((row) => `${row.corp_name}:${row.offer_name}`),
    ["Alpha Logistics:Duplicate Charge", "Beta Logistics:Duplicate Charge", "Gamma Logistics:Unique Module"]
  );

  db.close();
});

test("default global offer list excludes special LP stores unless opted in", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (?, ?, ?, ?)").run(
    1,
    "Standard Navy",
    "HIGHSEC",
    "STANDARD"
  );
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (?, ?, ?, ?)").run(
    1000137,
    "DED",
    "HIGHSEC",
    "SPECIAL"
  );
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Standard Module");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "Special Module");

  const insertOffer = db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (?, ?, 1000, 0, 'now', '{}')
  `);
  insertOffer.run(1, 1);
  insertOffer.run(2, 1000137);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  insertPrice.run(100, 1_000_000, 1_000_000);
  insertPrice.run(200, 10_000_000, 10_000_000);

  const insertCalc = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, product_value_instant,
      product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `);
  insertCalc.run(1, 1, 1_000);
  insertCalc.run(2, 1000137, 10_000);

  assert.deepEqual(
    listOfferCalcs(db, { maxRiskTier: "HIGHSEC", hideVanity: false, n: 10 }).map((row) => row.offer_name),
    ["Standard Module"]
  );
  assert.deepEqual(
    listOfferCalcs(db, { maxRiskTier: "HIGHSEC", hideVanity: false, includeSpecial: true, n: 10 }).map(
      (row) => row.offer_name
    ),
    ["Special Module", "Standard Module"]
  );

  db.close();
});

test("BPC cost-leg quality issues contribute row flags", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");
  const insertType = db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, 1)");
  insertType.run(100, "Test Blueprint");
  insertType.run(101, "Test Product");
  insertType.run(200, "Manipulated Input");
  insertType.run(300, "Clean Material");

  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (1, 200, 1)").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (100, 101, 1, ?)").run(
    JSON.stringify([{ type_id: 300, quantity: 1 }])
  );

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, ?, 10, 1)
  `);
  insertPrice.run(101, 10_000_000, 10_000_000, 10);
  insertPrice.run(200, 3_000_000, 2_900_000, 10);
  insertPrice.run(300, 1_000_000, 900_000, 10);

  const insertHistory = db.prepare(`
    INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days)
    VALUES (?, 1000, ?, ?, 28)
  `);
  insertHistory.run(101, 9_500_000, 10_000_000);
  insertHistory.run(200, 1_000_000, 3_000_000);
  insertHistory.run(300, 1_000_000, 1_000_000);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });

  assert.ok(row);
  assert.ok(row.flags.some((flag) => flag.code === "PRICE_SPIKE" && flag.message.includes("Manipulated Input")));

  db.close();
});

test("BPC calculations read normalized blueprint product and material tables", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");
  const insertType = db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, 1)");
  insertType.run(100, "Test Blueprint");
  insertType.run(101, "Test Product");
  insertType.run(300, "Build Material");

  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 2)").run();
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (100, 101, 3)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (100, 300, 7)").run();

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  insertPrice.run(101, 1_000_000, 1_000_000);
  insertPrice.run(300, 10_000, 10_000);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });

  assert.ok(row);
  assert.equal(row.sales_targets[0]?.type_id, 101);
  assert.equal(row.sales_targets[0]?.quantity, 6);
  assert.equal(row.build_lines[0]?.type_id, 300);
  assert.equal(row.build_lines[0]?.quantity, 14);

  db.close();
});

test("required input off-hub flags collapse into one strong summary", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");
  const insertType = db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, 1)");
  insertType.run(100, "Output Module");
  insertType.run(200, "Offhub Input A");
  insertType.run(201, "Offhub Input B");

  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (1, 200, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (1, 201, 1)").run();

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, ?)
  `);
  insertPrice.run(100, 10_000_000, 10_000_000, 1);
  insertPrice.run(200, 2_000_000, 1_900_000, 0);
  insertPrice.run(201, 2_000_000, 1_900_000, 0);

  const insertHistory = db.prepare(`
    INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days)
    VALUES (?, 1000, ?, ?, 28)
  `);
  insertHistory.run(100, 10_000_000, 10_000_000);
  insertHistory.run(200, 2_000_000, 2_000_000);
  insertHistory.run(201, 2_000_000, 2_000_000);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });

  assert.ok(row);
  const offHubFlags = row.flags.filter((flag) => flag.code === "OFF_HUB");
  assert.equal(offHubFlags.length, 1);
  assert.equal(offHubFlags[0]?.severity, "strong");
  assert.match(offHubFlags[0]?.message ?? "", /2 required inputs/);
  assert.match(offHubFlags[0]?.message ?? "", /Offhub Input A/);
  assert.match(offHubFlags[0]?.message ?? "", /Offhub Input B/);

  db.close();
});

test("recompute marks BPC required inputs and build materials as hot price legs", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Test Navy", "HIGHSEC");
  const insertType = db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, 1)");
  insertType.run(100, "Test Blueprint");
  insertType.run(101, "Test Product");
  insertType.run(200, "Required Input");
  insertType.run(300, "Build Material");

  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(
    1
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (1, 200, 1)").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (100, 101, 1, ?)").run(
    JSON.stringify([{ type_id: 300, quantity: 1 }])
  );

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  for (const [typeId, price] of [
    [100, 10],
    [101, 10_000_000],
    [200, 1_000_000],
    [300, 1_000_000]
  ]) {
    insertPrice.run(typeId, price, price);
  }

  recomputeAndPersist(db);

  const hot = db.prepare("SELECT type_id, rank_hot FROM prices WHERE type_id IN (101, 200, 300)").all() as Array<{
    type_id: number;
    rank_hot: number | null;
  }>;
  assert.deepEqual(
    Object.fromEntries(hot.map((row) => [row.type_id, row.rank_hot])),
    { 101: 1, 200: 1, 300: 1 }
  );

  db.close();
});

test("offer list hides corporations without level 4 or 5 Security agents by default", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (1, 'Security Navy', 'HIGHSEC', 1)"
  ).run();
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (2, 'Outer Ring Excavations', 'NULLSEC', 0)"
  ).run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Security Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'ORE Mining Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  const defaultRows = listOfferCalcs(db, {
    maxRiskTier: "NULLSEC",
    hideVanity: false,
    includeFW: true,
    showDuplicateStores: true,
    n: 10
  });
  const optOutRows = listOfferCalcs(db, {
    maxRiskTier: "NULLSEC",
    hideVanity: false,
    includeFW: true,
    hideNoSecurity: false,
    showDuplicateStores: true,
    n: 10
  });

  assert.deepEqual(defaultRows.map((row) => row.corp_name), ["Security Navy"]);
  assert.deepEqual(optOutRows.map((row) => row.corp_name).sort(), ["Outer Ring Excavations", "Security Navy"]);

  db.close();
});

test("explicit corp selection relaxes FW and no-security discovery filters", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (1, 'Security Navy', 'HIGHSEC', 1)"
  ).run();
  // FW militia with no level 4/5 Security agents — excluded from the global
  // leaderboard by both the includeFW=off default and hideNoSecurity=on default.
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (2, '24th Imperial Crusade', 'HIGHSEC', 0)"
  ).run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Navy Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'Militia Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  db.prepare("INSERT INTO offer_meta(offer_id, is_fw) VALUES (2, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  // Global leaderboard (default toggles): the FW, no-security militia is absent.
  const globalRows = listOfferCalcs(db, { maxRiskTier: "NULLSEC", hideVanity: false, showDuplicateStores: true, n: 10 });
  assert.deepEqual(globalRows.map((row) => row.corp_name), ["Security Navy"]);

  // Scoping to that corp shows its catalog despite the default includeFW=off +
  // hideNoSecurity=on toggles (regression: previously returned an empty table).
  const corpRows = listOfferCalcs(db, { maxRiskTier: "NULLSEC", hideVanity: false, showDuplicateStores: true, corp: 2, n: 10 });
  assert.deepEqual(corpRows.map((row) => row.corp_name), ["24th Imperial Crusade"]);

  db.close();
});

test("recompute persists corporations without level 4 or 5 Security agents for opt-out queries", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (1, 'Security Navy', 'HIGHSEC', 1)"
  ).run();
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (2, 'Outer Ring Excavations', 'NULLSEC', 0)"
  ).run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Security Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'ORE Ice Mining Laser')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  recomputeAndPersist(db);

  const persistedCorpIds = db.prepare("SELECT corp_id FROM calc ORDER BY corp_id").pluck().all();
  const optOutRows = listOfferCalcs(db, {
    maxRiskTier: "NULLSEC",
    hideNoSecurity: false,
    hideVanity: false,
    includeFW: true,
    showDuplicateStores: true,
    n: 10
  });

  assert.deepEqual(persistedCorpIds, [1, 2]);
  assert.deepEqual(optOutRows.map((row) => row.corp_name).sort(), ["Outer Ring Excavations", "Security Navy"]);

  db.close();
});

test("offer list excludes corporations without earnable LP source before user filters", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent, has_earnable_lp_source) VALUES (1, 'Outer Ring Excavations', 'NULLSEC', 0, 1)"
  ).run();
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent, has_earnable_lp_source) VALUES (2, 'Frostline Laboratories', 'NULLSEC', 0, 0)"
  ).run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'ORE Mining Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'Frostline Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "NULLSEC",
    hideNoSecurity: false,
    hideVanity: false,
    includeFW: true,
    includeSpecial: true,
    showDuplicateStores: true,
    n: 10
  });

  assert.deepEqual(rows.map((row) => row.corp_name), ["Outer Ring Excavations"]);

  db.close();
});

test("level 5 mission filter can show only, hide, or show all level 5 agent corporations", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, has_level5_agent) VALUES (1, 'Level Five Corp', 'HIGHSEC', 1)").run();
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, has_level5_agent) VALUES (2, 'Level Four Corp', 'HIGHSEC', 0)").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Level Five Module')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'Level Four Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 2, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  const onlyRows = listOfferCalcs(db, {
    level5Missions: "only",
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10,
    showDuplicateStores: true
  } as never);
  const hiddenRows = listOfferCalcs(db, {
    level5Missions: "hide",
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10,
    showDuplicateStores: true
  } as never);
  const shownRows = listOfferCalcs(db, {
    level5Missions: "show",
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10,
    showDuplicateStores: true
  } as never);

  assert.deepEqual(onlyRows.map((row) => `${row.corp_name}:${row.offer_name}`), ["Level Five Corp:Level Five Module"]);
  assert.deepEqual(hiddenRows.map((row) => `${row.corp_name}:${row.offer_name}`), ["Level Four Corp:Level Four Module"]);
  assert.deepEqual(shownRows.map((row) => `${row.corp_name}:${row.offer_name}`).sort(), [
    "Level Five Corp:Level Five Module",
    "Level Four Corp:Level Four Module"
  ]);

  db.close();
});

test("recompute materializes leaderboard fields and offer search FTS", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(`
    INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier)
    VALUES (1, 'Material Corp', 'HIGHSEC', 'STANDARD')
  `).run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Material Module', 5)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (200, 'Required Tag', 1)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (1, 200, 1)").run();
  db.prepare("INSERT INTO offer_meta(offer_id, required_standing, is_fw) VALUES (1, 4.5, 1)").run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, ?, 10, 1)
  `).run(100, 2_000_000, 1_800_000, 10);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, ?, 10, 1)
  `).run(200, 10_000, 9_000, 10);
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (100, 1, 1900000, 2000000, 28)").run();
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (200, 1000, 10000, 10000, 28)").run();

  recomputeAndPersist(db);

  const row = db.prepare(`
    SELECT offer_name, product_signature, required_signature, primary_product_type_id,
      risk_tier, lp_source_tier, required_standing, is_fw, flags_json,
      warn_flag_count, strong_flag_count, is_suspicious, days_to_fill
    FROM calc
    WHERE offer_id=1
  `).get() as Record<string, unknown>;

  assert.equal(row.offer_name, "Material Module");
  assert.equal(row.primary_product_type_id, 100);
  assert.equal(row.risk_tier, "HIGHSEC");
  assert.equal(row.lp_source_tier, "STANDARD");
  assert.equal(row.required_standing, 4.5);
  assert.equal(row.is_fw, 1);
  assert.match(String(row.product_signature), /100/);
  assert.match(String(row.required_signature), /200/);
  assert.ok(JSON.parse(String(row.flags_json)).some((flag: { code: string }) => flag.code === "LOW_VOLUME"));
  assert.equal(row.warn_flag_count, 1);
  assert.equal(row.strong_flag_count, 0);
  assert.equal(row.is_suspicious, 0);
  // no persisted book -> queue 0; (0 + 1) / (0.5 * 1/day) = 2 days
  assert.equal(row.days_to_fill, 2);

  const fts = db.prepare("SELECT rowid FROM offer_search_fts WHERE offer_search_fts MATCH 'Material'").all();
  assert.deepEqual(fts, [{ rowid: 1 }]);

  db.close();
});

test("cached offer list filters suspicious materialized rows before recalculation", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Safe Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Suspicious Winner')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (200, 'Safe Runner Up')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(100);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `).run(200);
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (100, 1000, 1000000, 1000000, 28)").run();
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (200, 1000, 1000000, 1000000, 28)").run();
  const insertCalc = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, product_signature, required_signature, risk_tier, lp_source_tier,
      flags_json, warn_flag_count, strong_flag_count, is_suspicious, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (?, 1, ?, ?, '', 'HIGHSEC', 'STANDARD', '[]', 0, 0, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `);
  insertCalc.run(1, "Suspicious Winner", "100", 1, 10_000);
  insertCalc.run(2, "Safe Runner Up", "200", 0, 5_000);

  const rows = listOfferCalcs(db, { n: 1, hideSuspicious: true, hideVanity: false, includeFW: true });

  assert.deepEqual(rows.map((row) => row.offer_name), ["Safe Runner Up"]);
  db.close();
});

test("quality guardrails hide BPC conversions, thin volume, and off-hub sell legs when enabled", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Guardrail Corp', 'HIGHSEC')").run();
  const insertType = db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, 1)");
  for (const [typeId, name] of [
    [100, "Safe Direct"],
    [200, "Blueprint Prize"],
    [201, "Built Prize"],
    [202, "Jita Material"],
    [300, "Thin Volume Direct"],
    [400, "Off Hub Input Offer"],
    [401, "Off Hub Required Input"]
  ] as const) {
    insertType.run(typeId, name);
  }

  const insertOffer = db.prepare(
    "INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 100, 0, 'now', '{}')"
  );
  for (const offerId of [1, 2, 3, 4]) insertOffer.run(offerId);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (3, 300, 1)").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (4, 400, 1)").run();
  db.prepare("INSERT INTO offer_required_items(offer_id, type_id, quantity) VALUES (4, 401, 1)").run();
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (200, 201, 1)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (200, 202, 1)").run();

  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, ?)
  `);
  for (const [typeId, sellMin, buyMax, isJita] of [
    [100, 1000, 900, 1],
    [200, 1000, 900, 1],
    [201, 9000, 8000, 1],
    [202, 100, 90, 1],
    [300, 10000, 9000, 1],
    [400, 11000, 10000, 1],
    [401, 100, 90, 0]
  ] as const) {
    insertPrice.run(typeId, sellMin, buyMax, isJita);
  }
  const insertHistory = db.prepare(
    "INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days) VALUES (?, ?, 1000, 1000, 28)"
  );
  for (const typeId of [100, 200, 201, 202, 400, 401]) insertHistory.run(typeId, 1000);
  insertHistory.run(300, 20);

  const guardedRows = listOfferCalcs(db, {
    n: 10,
    minVolume: 100,
    jita44Only: true,
    hideVanity: false,
    includeFW: true,
    bpc: "none"
  } as never);
  assert.deepEqual(guardedRows.map((row) => row.offer_name), ["Safe Direct"]);

  const includeBpcRows = listOfferCalcs(db, {
    n: 10,
    minVolume: 100,
    jita44Only: true,
    hideVanity: false,
    includeFW: true,
    bpc: "all"
  } as never);
  assert.ok(includeBpcRows.some((row) => row.offer_name === "Blueprint Prize (manufacture)"));

  const includeThinRows = listOfferCalcs(db, {
    n: 10,
    minVolume: 0,
    jita44Only: true,
    hideVanity: false,
    includeFW: true,
    bpc: "none"
  } as never);
  assert.ok(includeThinRows.some((row) => row.offer_name === "Thin Volume Direct"));

  const includeOffHubRows = listOfferCalcs(db, {
    n: 10,
    minVolume: 100,
    jita44Only: false,
    hideVanity: false,
    includeFW: true,
    bpc: "none"
  } as never);
  assert.ok(includeOffHubRows.some((row) => row.offer_name === "Off Hub Input Offer"));

  db.close();
});

test("offer summaries omit full breakdown arrays while keeping drawer summary data", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, hq_station_name, hq_system_name) VALUES (?, ?, ?, ?, ?)").run(
    1,
    "Summary Corp",
    "HIGHSEC",
    "Summary Station",
    "Summary"
  );
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Summary Module", 5);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    1000,
    0,
    "now",
    "{}"
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 2);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1200000, 1000000, 10, 10, 1)
  `).run(100);

  const row = listOfferCalcs(db, { maxRiskTier: "HIGHSEC", hideVanity: false, includeFW: true, n: 1 })[0];
  assert.ok(row);
  const summary = summarizeOfferCalc(row);

  assert.equal("sales_targets" in summary, false);
  assert.equal("computed_at" in summary, false);
  assert.equal(summary.detail_summary.store.corpName, "Summary Corp");
  assert.equal(summary.detail_summary.products.total, 1);
  assert.equal(summary.detail_summary.products.items[0]?.name, "Summary Module");

  db.close();
});

test("space risk filtering and flags use access risk instead of HQ risk", () => {
  const db = new Database(":memory:");
  migrate(db);

  db
    .prepare(
      "INSERT INTO corporations(corp_id, name, risk_tier, access_risk_tier, hq_station_name, hq_system_name, hq_security_status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "Sisters Test", "NULLSEC", "HIGHSEC", "Nullsec HQ", "X-7OMU", -0.141435);
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Sisters Probe", 0.1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    1000,
    0,
    "now",
    "{}"
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 1);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1200000, 1000000, 10, 10, 1)
  `).run(100);

  const row = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    minVolume: 0,
    hideVanity: false,
    includeFW: true,
    n: 1
  })[0] as ReturnType<typeof listOfferCalcs>[number] & { access_risk_tier: string };

  assert.ok(row);
  assert.equal(row.risk_tier, "NULLSEC");
  assert.equal(row.access_risk_tier, "HIGHSEC");
  assert.equal(summarizeOfferCalc(row).access_risk_tier, "HIGHSEC");

  db.close();
});

test("patient profit applies broker fee exactly once (not doubled)", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Fee Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Fee Module", 1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 1);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 2000000, 1800000, 10, 10, 1)
  `).run(100);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);

  const fees = row.fees;
  // patient profit should deduct salesTax + brokerFee once, not twice
  const expectedPatient = row.product_value_patient * (1 - fees.salesTaxRate - fees.brokerFeeRate);
  assert.equal(row.net_profit_patient, expectedPatient);

  // Confirm it is NOT equal to the double-fee formula
  const doubleFeeBugValue = row.product_value_patient * (1 - fees.salesTaxRate - 2 * fees.brokerFeeRate);
  assert.notEqual(row.net_profit_patient, doubleFeeBugValue);

  db.close();
});

test("walkOrders marks the extrapolated phantom tail order with is_phantom", () => {
  const result = walkOrders(
    [{ price: 100, qty: 3, location_id: 1 }],
    5
  );

  assert.equal(result.insufficient_depth, true);
  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[0]?.is_phantom, undefined);
  assert.equal(result.orders[1]?.is_phantom, true);
});

test("walkOrders avg_price reflects only real fills, not the extrapolated phantom", () => {
  // 3 units filled at 100, 2 units phantom at 100 — avg should be 100 either way,
  // but test with mixed prices to confirm phantom is excluded from avg
  const result = walkOrders(
    [
      { price: 100, qty: 2, location_id: 1 },
      { price: 200, qty: 2, location_id: 2 }
    ],
    6 // 4 real fills (2@100 + 2@200), 2 phantom at 200
  );

  // real fills: 2*100 + 2*200 = 600 over 4 units = avg 150
  assert.equal(result.filled_qty, 4);
  assert.equal(result.avg_price, 150);
  assert.equal(result.insufficient_depth, true);
  // phantom order is the last one
  assert.equal(result.orders[result.orders.length - 1]?.is_phantom, true);
});

test("summarizeOfferCalc sourceOrders excludes phantom tail orders", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Shallow Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Shallow Module", 1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 3);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1200000, 1000000, 1, 1, 1)
  `).run(100);
  // Only 1 unit in the sell book; requesting 3 — will produce a phantom for the remaining 2
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (?, 'sell', 0, 99001, 1200000, 1, 60003760, 30000142, 1)
  `).run(100);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);

  // Patient sell walk should be insufficient and have a phantom
  assert.equal(row.sales_targets[0]?.walk.insufficient_depth, true);
  const phantomOrder = row.sales_targets[0]?.walk.orders.find((o) => o.is_phantom);
  assert.ok(phantomOrder, "expected a phantom order in the walk");

  // summarizeOfferCalc should NOT include phantom in sourceOrders
  // Only the 1 real fill should appear, not the phantom for the 2 remaining units
  const summary = summarizeOfferCalc(row);
  assert.equal(summary.detail_summary.sourceOrders.total, 1);
  assert.equal(summary.detail_summary.sourceOrders.items[0]?.quantity, 1);

  db.close();
});

test("summarizeOfferCalc uses instant_targets walk when basis is instantSell", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Basis Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (?, ?, ?)").run(100, "Basis Module", 1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 1);
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1500000, 1000000, 10, 10, 1)
  `).run(100);

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);

  // instant_targets use the buy-order walk (buy_max = 1000000)
  // sales_targets use the sell-order walk (sell_min = 1500000)
  const instantSummary = summarizeOfferCalc(row, "instantSell");
  const patientSummary = summarizeOfferCalc(row, "patientSell");

  assert.equal(instantSummary.detail_summary.products.items[0]?.avgPrice, row.instant_targets[0]?.walk.avg_price);
  assert.equal(patientSummary.detail_summary.products.items[0]?.avgPrice, row.sales_targets[0]?.walk.avg_price);
  // The two bases should yield different avg prices (buy vs sell side)
  assert.notEqual(
    instantSummary.detail_summary.products.items[0]?.avgPrice,
    patientSummary.detail_summary.products.items[0]?.avgPrice
  );

  db.close();
});

test("effectiveRuns treats zero capital-per-run as no ISK constraint", () => {
  // When capitalPerRun is 0, ISK budget should not limit runs
  assert.equal(effectiveRuns(1000, 0, { iskBudget: 5_000_000, runs: 3 }), 3);
  assert.equal(effectiveRuns(1000, 0, { iskBudget: 5_000_000 }), 1);
  // Positive capitalPerRun still constrains as before
  assert.equal(effectiveRuns(1000, 2_000_000, { iskBudget: 5_000_000 }), 2);
});

test("leastRiskTier returns HIGHSEC for an empty store list rather than NULLSEC", () => {
  assert.equal(leastRiskTier([]), "HIGHSEC");
  // Non-empty inputs remain correct
  assert.equal(leastRiskTier(["HIGHSEC", "LOWSEC"]), "HIGHSEC");
  assert.equal(leastRiskTier(["LOWSEC", "NULLSEC"]), "LOWSEC");
});

test("search term with underscore matches literal underscore in offer name on the live path", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "Under Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "test_mod");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "testXmod");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(2);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  // Raw underscore search must match only "test_mod", not "testXmod" (underscore is literal, not SQL wildcard)
  const rows = listOfferCalcs(db, {
    search: "test_mod",
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10
  });

  assert.deepEqual(rows.map((row) => row.offer_name), ["test_mod"]);

  db.close();
});

test("percent in corpSearch does not act as SQL wildcard when filtering on the live path", () => {
  const db = new Database(":memory:");
  migrate(db);

  // Corp whose name literally contains "100%" — must be found; other corps must not bleed through.
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "100% Pure Navy", "HIGHSEC");
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(2, "Other Navy", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Pure Module");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "Other Module");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 0, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 2, 1000, 0, 'now', '{}')").run(2);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, 1000000, 1000000, 10, 10, 1)
  `);
  insertPrice.run(100);
  insertPrice.run(200);

  // "100%" as corpSearch must match only "100% Pure Navy", not every corp (% must be literal)
  const rows = listOfferCalcs(db, {
    corpSearch: "100%",
    maxRiskTier: "HIGHSEC",
    hideVanity: false,
    includeFW: true,
    n: 10
  });

  assert.deepEqual(rows.map((row) => row.corp_name), ["100% Pure Navy"]);

  db.close();
});

test("sortBy=roi with basis=patientSell ranks by roi_patient on the live path", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "ROI Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "High Patient ROI");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(200, "High Instant ROI");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 500000, 'now', '{}')").run(1);
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, 1, 1000, 500000, 'now', '{}')").run(2);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(1, 100);
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, 1)").run(2, 200);
  // type 100: sell_min (patient) is high, buy_max (instant) is low → high patient ROI
  // type 200: buy_max (instant) is high, sell_min (patient) is low → high instant ROI
  const insertPrice = db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (?, ?, ?, 10, 10, 1)
  `);
  insertPrice.run(100, 3_000_000, 1_200_000);
  insertPrice.run(200, 1_200_000, 3_000_000);

  const rows = listOfferCalcs(db, {
    maxRiskTier: "HIGHSEC",
    basis: "patientSell",
    sortBy: "roi",
    hideVanity: false,
    includeFW: true,
    n: 2
  });

  // "High Patient ROI" should rank first when sorting by roi with patientSell basis
  assert.equal(rows[0]?.offer_name, "High Patient ROI");
  assert.ok((rows[0]?.roi_patient ?? 0) > (rows[0]?.roi_instant ?? 0), "offer 1 should have higher patient than instant ROI");

  db.close();
});
