import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, type Db } from "../src/db.js";
import { markComputeDirty } from "../src/lib/compute-generation.js";
import {
  getContractPrice,
  rebuildContractPrices,
  rollupAsks
} from "../src/calc/contract-prices.js";
import { suspicious } from "../src/calc/flags.js";
import { calculateOffer, listOfferCalcs, recomputeAndPersist, SELL_VARIANT_OFFSET, summarizeOfferCalc } from "../src/calc/ratio.js";

function ask(unitPrice: number, isBpc = false, runs: number | null = null) {
  return { unitPrice, isBpc, runs };
}

test("rollupAsks anchors the band on the minimum ask and requires two survivors", () => {
  // Decoy at 10x the cheapest ask is rejected; the two sane asks publish.
  const stats = rollupAsks([ask(100), ask(110), ask(1100)]);
  assert.ok(stats);
  assert.equal(stats.ask_count, 2);
  assert.equal(stats.ask_min, 100);
  assert.equal(stats.ask_median, 105);

  // A single ask never publishes — as likely a scam as a price.
  assert.equal(rollupAsks([ask(100)]), null);
  // Two asks where the band filter leaves one survivor: no publish either.
  assert.equal(rollupAsks([ask(100), ask(100_000)]), null);
  // A scam PAIR outnumbering the honest ask must not flip the anchor (a median
  // anchor would land on the scams here): one honest survivor is below the floor.
  assert.equal(rollupAsks([ask(52.5), ask(40_000), ask(55_000)]), null);
});

test("rollupAsks recipe cap screens decoys with no honest ask to anchor on", () => {
  // Both asks are absurd against what the built product sells for: no publish.
  assert.equal(rollupAsks([ask(40_000, true, 1), ask(55_000, true, 1)], 840), null);
  // Asks under the cap publish normally.
  const capped = rollupAsks([ask(50, true, 1), ask(60, true, 1)], 840);
  assert.ok(capped);
  assert.equal(capped.ask_min, 50);
});

test("rollupAsks pools per-run BPC asks across runs counts", () => {
  // Unit prices arrive per-run, so a 10-run copy at 450/run pools with 1-run asks.
  const stats = rollupAsks([
    ask(500, true, 1),
    ask(520, true, 1),
    ask(540, true, 1),
    ask(450, true, 10)
  ]);
  assert.ok(stats);
  assert.equal(stats.runs_modal, 1);
  assert.equal(stats.ask_count, 4);
  assert.equal(stats.ask_min, 450);
  assert.equal(stats.is_bpc, true);
});

function seedContract(
  db: Db,
  contractId: number,
  typeId: number,
  price: number,
  options: { quantity?: number; isBpc?: boolean; runs?: number | null; goneAt?: string | null; expired?: boolean } = {}
): void {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `
    INSERT INTO contracts(
      contract_id, region_id, contract_type, price, date_issued, date_expired,
      first_seen_at, last_seen_at, gone_at, items_fetched,
      single_item_type_id, single_item_quantity, single_item_is_bpc, single_item_runs, has_excluded_items
    )
    VALUES (?, 10000002, 'item_exchange', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)
  `
  ).run(
    contractId,
    price,
    past,
    options.expired ? past : future,
    past,
    past,
    options.goneAt ?? null,
    typeId,
    options.quantity ?? 1,
    options.isBpc ? 1 : 0,
    options.runs ?? null
  );
}

test("rebuildContractPrices publishes qualifying types, keeps stale rows, prunes ancient ones", () => {
  const db = new Database(":memory:");
  migrate(db);

  seedContract(db, 1, 500, 100);
  seedContract(db, 2, 500, 120);
  seedContract(db, 3, 600, 999); // single ask: below the floor
  seedContract(db, 4, 700, 50, { goneAt: new Date().toISOString() }); // gone: ignored
  seedContract(db, 5, 800, 50, { expired: true }); // past expiry: ignored
  seedContract(db, 6, 900, 400, { quantity: 4 });
  seedContract(db, 7, 900, 440, { quantity: 4 }); // stackables price per unit
  // The Synth-booster shape: one copy carrying 1000 licensed runs — per-run unit.
  seedContract(db, 8, 950, 25_000_000, { isBpc: true, runs: 1000 });
  seedContract(db, 9, 950, 30_000_000, { isBpc: true, runs: 1000 });
  // The Harbinger shape: only scam asks, but the built product's market value
  // caps what a run can be worth — nothing publishes.
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (960, 961, 1, '[]')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (961, 'Built Product')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (961, 400, 350, 5, 5, 1)"
  ).run();
  seedContract(db, 10, 960, 40_000_000, { isBpc: true, runs: 1 });
  seedContract(db, 11, 960, 55_000_000, { isBpc: true, runs: 1 });
  // A previously published row for the scam-only type (e.g. from a cycle with a
  // weaker filter) must be dropped, not retained: active asks are the freshest
  // evidence, and they cannot support a price.
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (960, 2, 40000000, 47500000, 1, 1, ?)"
  ).run(new Date().toISOString());

  const published = rebuildContractPrices(db);
  assert.equal(published, 3);
  assert.equal(getContractPrice(db, 960), null);
  const dropped = db.prepare("SELECT COUNT(*) AS n FROM contract_prices WHERE type_id=960").get() as { n: number };
  assert.equal(dropped.n, 0);

  const t500 = getContractPrice(db, 500);
  assert.ok(t500);
  assert.equal(t500.ask_min, 100);
  assert.equal(t500.ask_count, 2);
  assert.equal(getContractPrice(db, 600), null);
  const t900 = getContractPrice(db, 900);
  assert.ok(t900);
  assert.equal(t900.ask_min, 100);
  assert.equal(t900.ask_median, 105);
  const t950 = getContractPrice(db, 950);
  assert.ok(t950);
  assert.equal(t950.ask_min, 25_000); // per run: 25M / 1000 runs
  assert.equal(t950.ask_median, 27_500);

  // Retention: when a type's asks vanish, the published row survives the rebuild...
  db.prepare("UPDATE contracts SET gone_at=? WHERE contract_id IN (1, 2)").run(new Date().toISOString());
  rebuildContractPrices(db);
  assert.ok(getContractPrice(db, 500));

  // ...but consumers treat rows past the freshness window as absent...
  const staleIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE contract_prices SET updated_at=? WHERE type_id=500").run(staleIso);
  assert.equal(getContractPrice(db, 500), null);

  // ...and rows past the retention window are pruned on the next rebuild.
  const ancientIso = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE contract_prices SET updated_at=? WHERE type_id=500").run(ancientIso);
  rebuildContractPrices(db);
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM contract_prices WHERE type_id=500").get() as { n: number };
  assert.equal(remaining.n, 0);

  db.close();
});

test("calculateOffer values contract-only products on the patient basis with no market fees", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'BPC Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name, packaged_volume) VALUES (?, ?, 9, 'Blueprint', 0.01)").run(
    57144,
    "High-grade Rapture Delta Blueprint"
  );
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 57144, 1)").run();
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (?, 3, 1700000000, 1780000000, 1, 1, ?)"
  ).run(57144, new Date().toISOString());

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, lpPerHour: 30000 });
  assert.ok(row);

  // Patient basis = lowest surviving ask with NO sales tax / broker fee (flat
  // contract fee is noise at BPC scale).
  assert.equal(row.product_value_patient, 1_700_000_000);
  assert.equal(row.net_profit_patient, 1_700_000_000);
  assert.equal(row.isk_per_lp_patient, 1_700_000);

  // The ratio is a real one-off conversion rate, but no hourly rate exists:
  // contract demand, not LP/hour, caps the row — isk_per_hour stays blank.
  assert.equal(row.contract_priced, true);
  assert.equal(row.isk_per_hour, null);

  const contractFlag = row.flags.find((flag) => flag.code === "CONTRACT_PRICED");
  assert.ok(contractFlag, "CONTRACT_PRICED flag missing");
  assert.match(contractFlag.message, /3 public-contract asks/);
  // Market-microstructure flags are meaningless for a type that cannot trade on
  // the market — CONTRACT_PRICED must be the row's ONLY flag, or the default
  // hide-suspicious guardrail would bury every contract-priced row.
  assert.deepEqual(row.flags.map((flag) => flag.code), ["CONTRACT_PRICED"]);

  // No bid book exists for contract-only types: the instant channel is absent,
  // not a loss — BUY column and instant ROI must show "-", not negatives.
  assert.equal(row.product_value_instant, 0);
  assert.equal(row.net_profit_instant, null);
  assert.equal(row.isk_per_lp_instant, null);
  assert.equal(row.roi_instant, null);

  db.close();
});

test("a contract-priced BPC offer yields both a (manufacture) row and a (sell) variant", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Navy Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name, packaged_volume) VALUES (?, ?, 9, 'Blueprint', 0.01)").run(
    15676,
    "Caldari Navy Co-Processor Blueprint"
  );
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (15677, 'Caldari Navy Co-Processor', 1)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (34, 'Tritanium', 0.01)").run();
  // The BPC has a manufacture recipe whose product trades on the market...
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, ?)").run(
    JSON.stringify([{ type_id: 34, quantity: 100 }])
  );
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (15677, 60000000, 50000000, 5, 5, 1)"
  ).run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (34, 5, 4, 5, 5, 1)"
  ).run();
  // The product trades 2 units/day, so one 1-run copy covers half a day of the
  // entire market's demand — the niche-demand threshold exactly.
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days, updated_at) VALUES (15677, 2, 60000000, 61000000, 28, 'now')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();
  // ...and the BPC itself has no market price but a fresh contract ask.
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (15676, 4, 50000000, 52000000, 1, 1, ?)"
  ).run(new Date().toISOString());

  // Base row: the manufacture conversion (arrow-free name). Net profit keeps
  // total-realization math; the consumed BPC is paid for in LP, so its contract
  // value is excluded from net profit, capital_required/ROI, and the drawer.
  const manufacture = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(manufacture);
  assert.equal(manufacture.offer_name, "Caldari Navy Co-Processor Blueprint (manufacture)");
  assert.equal(manufacture.sales_targets[0]?.type_id, 15677);
  assert.equal(manufacture.sales_targets[0]?.is_bpc, true);
  assert.equal(manufacture.build_cost, 500); // 100x Tritanium at 5 ISK
  assert.equal(manufacture.capital_required, 500); // BPC contract value excluded
  const expectedNet = 60_000_000 * (1 - 0.075 - 0.03) - 500;
  assert.ok(Math.abs(manufacture.net_profit_patient - expectedNet) < 1e-6);
  assert.equal(manufacture.flags.some((flag) => flag.code === "CONTRACT_PRICED"), false);

  // The consumed copy does not appear in the build-materials drawer: it is not a
  // material and its value is neither cost nor capital. The (sell) variant row
  // below is where the copy's contract value surfaces instead.
  const drawer = summarizeOfferCalc(manufacture).detail_summary;
  assert.equal(drawer.buildMaterials.totalCost, 500); // real materials only
  assert.equal(drawer.buildMaterials.total, 1); // 1 line: Tritanium
  assert.doesNotMatch(drawer.buildMaterials.names, /contract value/);

  // Sell variant at offer_id + SELL_VARIANT_OFFSET: direct contract sale of the
  // BPC, fee-free patient value, flagged, default-visible (is_bpc false).
  const sell = calculateOffer(db, 1 + SELL_VARIANT_OFFSET, { hideVanity: false, includeSpecial: true, lpPerHour: 30000 });
  assert.ok(sell);
  assert.equal(sell.offer_id, 1 + SELL_VARIANT_OFFSET);
  assert.equal(sell.offer_name, "Caldari Navy Co-Processor Blueprint (sell)");
  assert.equal(sell.sales_targets[0]?.type_id, 15676);
  assert.equal(sell.sales_targets[0]?.is_bpc, false);
  assert.equal(sell.product_value_patient, 50_000_000);
  assert.equal(sell.net_profit_patient, 50_000_000);
  assert.equal(sell.capital_required, 0);
  // ROI is suppressed for (sell) rows: the only ISK capital is the token LP-store
  // fee, so net / fee is meaningless — the row's real cost is LP. (See the dedicated
  // isk_cost > 0 case below, where capital is positive but ROI is still null.)
  assert.equal(sell.roi_patient, null);
  assert.equal(sell.roi_instant, null);
  assert.ok(sell.flags.some((flag) => flag.code === "CONTRACT_PRICED"));

  // Selling the copy competes for the market that consumes the BUILT product:
  // one copy covers >= half a day of its entire Jita volume, so the row gets
  // the demand-context flag and no hourly rate — and the informational
  // NICHE_DEMAND flag must not tip the row into hide-suspicious territory.
  const niche = sell.flags.find((flag) => flag.code === "NICHE_DEMAND");
  assert.ok(niche, "NICHE_DEMAND flag missing");
  assert.match(niche.message, /One 1-run copy ≈ 0\.5 days of total Jita demand for Caldari Navy Co-Processor \(~2\/day\)/);
  assert.equal(sell.contract_priced, true);
  assert.equal(sell.isk_per_hour, null);
  assert.equal(suspicious(sell.flags), false);

  // The manufacture conversion sells a market-traded product: it keeps its
  // hourly extrapolation and never carries the contract-channel marker.
  assert.equal(manufacture.contract_priced, false);
  const manufactureWithRate = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, lpPerHour: 30000 });
  assert.ok(manufactureWithRate);
  assert.notEqual(manufactureWithRate.isk_per_hour, null);

  // The four-position bpc mode picks which of the dual rows surface.
  const listNames = (bpc?: "none" | "sell" | "manufacture" | "all") =>
    listOfferCalcs(db, {
      all: true,
      hideVanity: false,
      includeSpecial: true,
      hideSuspicious: false,
      hideNoSecurity: false,
      ...(bpc === undefined ? {} : { bpc })
    })
      .map((row) => row.offer_name)
      .sort();
  assert.deepEqual(listNames("all"), [
    "Caldari Navy Co-Processor Blueprint (manufacture)",
    "Caldari Navy Co-Processor Blueprint (sell)"
  ]);
  assert.deepEqual(listNames("sell"), ["Caldari Navy Co-Processor Blueprint (sell)"]);
  assert.deepEqual(listNames("manufacture"), ["Caldari Navy Co-Processor Blueprint (manufacture)"]);
  assert.deepEqual(listNames("none"), []);
  // Default is "none": no blueprint rows without an explicit opt-in.
  assert.deepEqual(listNames(), []);

  db.close();
});

test("manufacturer mode (bpc=manufacture) is buildables-only: plain direct-item offers are hidden", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, has_l4_l5_security_agent) VALUES (1, 'Navy Corp', 'HIGHSEC', 1)").run();
  // A plain direct-item offer: the LP store hands over a finished module, no blueprint.
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Plain Module')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (100, 1000, 900, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  // A blueprint offer: the LP store hands over a BPC that builds into a market product.
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (200, 'Some Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (201, 'Built Module')").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (200, 201, 1, '[]')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (201, 5000, 4000, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();

  const liveNames = (bpc: "none" | "sell" | "manufacture" | "all") =>
    listOfferCalcs(db, {
      all: true,
      hideVanity: false,
      includeSpecial: true,
      hideSuspicious: false,
      hideNoSecurity: false,
      bpc
    })
      .map((row) => row.offer_name)
      .sort();

  // Live path (calc not yet populated → full scan, rowMatchesQuery filters).
  // Build mode shows only the blueprint conversion; the plain module is hidden.
  assert.deepEqual(liveNames("manufacture"), ["Some Blueprint (manufacture)"]);
  // None keeps the plain module and drops blueprint rows.
  assert.deepEqual(liveNames("none"), ["Plain Module"]);
  // All shows both (no (sell) variant exists without a contract ask).
  assert.deepEqual(liveNames("all"), ["Plain Module", "Some Blueprint (manufacture)"]);

  // After a compute, the calc table exists: the live path restricts the candidate
  // scan to manufacture rows via the has_manufactured_bpc join, and the cache-eligible
  // path applies the same has_manufactured_bpc=1 candidate filter. Both must still be
  // blueprints-only.
  recomputeAndPersist(db);
  // Live path post-recompute: the has_manufactured_bpc candidate join is active but
  // still blueprints-only.
  assert.deepEqual(liveNames("manufacture"), ["Some Blueprint (manufacture)"]);

  // Cache-eligible path (cachedCandidateIds has_manufactured_bpc=1 filter): blueprints-only.
  const cachedManufacture = listOfferCalcs(db, {
    bpc: "manufacture",
    hideVanity: false,
    includeSpecial: true,
    hideSuspicious: false,
    hideNoSecurity: false
  })
    .map((row) => row.offer_name)
    .sort();
  assert.deepEqual(cachedManufacture, ["Some Blueprint (manufacture)"]);

  // A blueprint offer fetched AFTER the last recompute: present in `offers`, absent
  // from `calc`. The forced-live manufacturer path must still surface it (the LEFT JOIN
  // IS NULL escape), matching the full scan rather than silently hiding a fresh buildable.
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (300, 'Fresh Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (301, 'Fresh Module')").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (300, 301, 1, '[]')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (301, 7000, 6000, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (3, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (3, 300, 1)").run();
  // In production a freshly-fetched offer arrives via the esi-lp job, which marks the
  // DB dirty; that bump invalidates the market snapshot so the live path sees the new
  // row. Mirror that here (a raw insert alone leaves the snapshot data-version stale).
  markComputeDirty(db, "test-fresh-offer");
  assert.deepEqual(liveNames("manufacture"), ["Fresh Blueprint (manufacture)", "Some Blueprint (manufacture)"]);

  db.close();
});

test("the (sell) variant does not exist without a fresh contract price", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Navy Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15676, 'Some Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (15677, 'Some Module')").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, '[]')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (15677, 1000, 900, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();

  assert.equal(calculateOffer(db, 1 + SELL_VARIANT_OFFSET, { hideVanity: false, includeSpecial: true }), null);
  const manufacture = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(manufacture);
  // No contract price: no opportunity cost in capital either.
  assert.equal(manufacture.capital_required, 0);

  db.close();
});

test("(sell) rows suppress ROI even when the LP-store ISK fee makes capital positive", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Navy Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15676, 'Some Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (15677, 'Some Module')").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, '[]')").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (15677, 60000000, 50000000, 5, 5, 1)"
  ).run();
  // Non-zero LP-store ISK fee → capital_required > 0, but it is a token next to the
  // contract value, so an unsuppressed ROI would read in the thousands of percent.
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 1000000, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (15676, 4, 50000000, 52000000, 1, 1, ?)"
  ).run(new Date().toISOString());

  const sell = calculateOffer(db, 1 + SELL_VARIANT_OFFSET, { hideVanity: false, includeSpecial: true });
  assert.ok(sell);
  assert.equal(sell.capital_required, 1_000_000); // the token ISK fee, positive
  assert.equal(sell.net_profit_patient, 49_000_000); // 50M contract value - 1M fee
  assert.equal(sell.roi_patient, null); // ~4900% if not suppressed
  assert.equal(sell.roi_instant, null);

  db.close();
});

test("calculateOffer prefers real market data over contract asks when both exist", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Mixed Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (100, 'Market Module', 1)").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1)").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (100, 2000, 1500, 1, 1, 1)"
  ).run();
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (100, 5, 99999, 99999, 0, NULL, ?)"
  ).run(new Date().toISOString());

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);
  assert.equal(row.product_value_patient, 2000);
  assert.equal(row.flags.some((flag) => flag.code === "CONTRACT_PRICED"), false);

  db.close();
});

test("contract-priced rows sort last by ISK/hour but keep their real ISK/LP rank", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Sort Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (200, 'Plain Module', 1)").run();
  db.prepare(
    "INSERT INTO types(type_id, name, category_id, category_name, packaged_volume) VALUES (201, 'Recipeless Blueprint', 9, 'Blueprint', 0.01)"
  ).run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (200, 5000, 4500, 5, 5, 1)"
  ).run();
  db.prepare(
    "INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}'), (2, 1, 1000, 0, 'now', '{}')"
  ).run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 200, 1), (2, 201, 1)").run();
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (201, 3, 50000000, 52000000, 1, 1, ?)"
  ).run(new Date().toISOString());

  const query = {
    all: true,
    hideVanity: false,
    hideSuspicious: false,
    hideNoSecurity: false,
    includeSpecial: true,
    lpPerHour: 30000
  };
  const byHour = listOfferCalcs(db, { ...query, sortBy: "iskPerHour" }).map((row) => row.offer_name);
  const byRatio = listOfferCalcs(db, { ...query, sortBy: "iskPerLp" }).map((row) => row.offer_name);

  // The blueprint's ratio (50k ISK/LP) dwarfs the module's (~4.5), but no
  // hourly rate exists for a contract-only seller, so ISK/hour ranks it last
  // while ISK/LP keeps the honest marginal-rate order.
  assert.deepEqual(byHour, ["Plain Module", "Recipeless Blueprint"]);
  assert.deepEqual(byRatio, ["Recipeless Blueprint", "Plain Module"]);

  // Same ordering through the cached candidate path (calc-table SQL sort).
  recomputeAndPersist(db);
  const cachedByHour = listOfferCalcs(db, {
    hideVanity: false,
    hideSuspicious: false,
    hideNoSecurity: false,
    includeSpecial: true,
    lpPerHour: 30000,
    sortBy: "iskPerHour"
  }).map((row) => row.offer_name);
  assert.deepEqual(cachedByHour, ["Plain Module", "Recipeless Blueprint"]);

  db.close();
});
