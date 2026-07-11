import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { jobInstallationCost, jobInstallationRate, NPC_FACILITY, resolveFacility } from "../src/calc/job-cost.js";
import { calculateOffer, recomputeAndPersist, SELL_VARIANT_OFFSET } from "../src/calc/ratio.js";

// Default NPC facility: 2.5% system cost index × 1.0 structure + 0.25% facility + 4% SCC.
const DEFAULT_RATE = 0.025 + 0.0025 + 0.04;

test("jobInstallationRate/jobInstallationCost apply the EIV percentage", () => {
  assert.ok(Math.abs(jobInstallationRate(NPC_FACILITY) - DEFAULT_RATE) < 1e-12);
  assert.ok(Math.abs(jobInstallationCost(1_000_000) - 1_000_000 * DEFAULT_RATE) < 1e-6);
  // A structure with a cost-index role bonus pays less on the index slice; the flat
  // 4.25% (facility + SCC) is unaffected.
  assert.ok(
    Math.abs(jobInstallationRate({ systemCostIndex: 0.025, structureBonus: 0.5 }) - (0.0125 + 0.0025 + 0.04)) < 1e-12
  );
  // No EIV (no priced materials) => no fee, never negative.
  assert.equal(jobInstallationCost(0), 0);
  assert.equal(jobInstallationCost(-5), 0);
});

function seedManufactureOffer(db: Database.Database, options: { adjustedPrice?: number } = {}): void {
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
  if (options.adjustedPrice !== undefined) {
    db.prepare("INSERT INTO adjusted_prices(type_id, adjusted_price, average_price, updated_at) VALUES (34, ?, ?, 'now')").run(
      options.adjustedPrice,
      options.adjustedPrice
    );
  }
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();
}

test("job installation cost deducts from net and adds to capital on a manufacture row", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db, { adjustedPrice: 6 }); // EIV = 100 × 6 = 600

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);

  const expectedJob = 600 * DEFAULT_RATE; // 40.5
  assert.ok(Math.abs(row.job_cost - expectedJob) < 1e-6, `job_cost=${row.job_cost}`);
  // Build materials (sell-order walk) are unchanged by the install fee.
  assert.equal(row.build_cost, 500); // 100 × 5 ISK
  // Capital fronts materials + the real ISK install fee.
  assert.ok(Math.abs(row.capital_required - (500 + expectedJob)) < 1e-6);
  // Patient net: 60M after tax+broker, minus materials and the install fee.
  const expectedPatient = 60_000_000 * (1 - 0.075 - 0.03) - 500 - expectedJob;
  assert.ok(Math.abs(row.net_profit_patient - expectedPatient) < 1e-6);
  // Instant net: 50M after sales tax only, minus materials and the install fee.
  const expectedInstant = 50_000_000 * (1 - 0.075) - 500 - expectedJob;
  assert.ok(Math.abs((row.net_profit_instant ?? 0) - expectedInstant) < 1e-6);
  // ROI denominator includes the install fee (net / capital).
  assert.ok(Math.abs((row.roi_patient ?? 0) - expectedPatient / (500 + expectedJob)) < 1e-6);

  db.close();
});

test("job cost is zero when CCP publishes no adjusted price for the materials", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db); // no adjusted_prices row

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);
  assert.equal(row.job_cost, 0);
  assert.equal(row.capital_required, 500); // materials only, no install fee
  assert.ok(Math.abs(row.net_profit_patient - (60_000_000 * (1 - 0.075 - 0.03) - 500)) < 1e-6);

  db.close();
});

test("job cost stays zero for the (sell) variant and for non-manufacture rows", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db, { adjustedPrice: 6 });
  // The blueprint itself has a fresh contract ask, so a (sell) variant exists.
  db.prepare(
    "INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES (15676, 4, 50000000, 52000000, 1, 1, ?)"
  ).run(new Date().toISOString());
  // A plain non-BPC market offer.
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (200, 'Plain Module', 1)").run();
  db.prepare(
    "INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (200, 1000, 900, 5, 5, 1)"
  ).run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (2, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (2, 200, 1)").run();

  const sell = calculateOffer(db, 1 + SELL_VARIANT_OFFSET, { hideVanity: false, includeSpecial: true });
  assert.ok(sell);
  assert.equal(sell.offer_name, "Some Blueprint (sell)");
  assert.equal(sell.job_cost, 0); // selling the copy runs no job

  const plain = calculateOffer(db, 2, { hideVanity: false, includeSpecial: true });
  assert.ok(plain);
  assert.equal(plain.job_cost, 0); // no recipe, no materials

  db.close();
});

test("resolveFacility maps presets to ME multipliers and percent cost index to a fraction", () => {
  // Default / absent => NPC, ME 0, house-default index (matches persisted default rows).
  const npc = resolveFacility();
  assert.equal(npc.preset, "npc");
  assert.equal(npc.meMult, 1);
  assert.ok(Math.abs(npc.cost.systemCostIndex - 0.025) < 1e-12);
  assert.equal(npc.cost.structureBonus, 1);

  // highsec T2: (1-0.01)(1-0.024×1.0) = 0.96624; null T2: (1-0.01)(1-0.024×2.1) = 0.940104.
  assert.ok(Math.abs(resolveFacility({ facility: "highsec-t2" }).meMult - 0.96624) < 1e-9);
  assert.ok(Math.abs(resolveFacility({ facility: "null-t2" }).meMult - 0.940104) < 1e-9);

  // costIndex is a percent and clamps to [0, 100].
  assert.ok(Math.abs(resolveFacility({ costIndex: 5 }).cost.systemCostIndex - 0.05) < 1e-12);
  assert.equal(resolveFacility({ costIndex: 250 }).cost.systemCostIndex, 1);
  assert.equal(resolveFacility({ costIndex: -3 }).cost.systemCostIndex, 0);
  // Unknown preset falls back to NPC.
  assert.equal(resolveFacility({ facility: "bogus" }).meMult, 1);
});

test("a facility ME preset reduces build materials but leaves EIV-based job cost intact", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db, { adjustedPrice: 6 }); // 100× material 34, sell 5, adjusted 6

  // null-T2 ME: 100 × 0.940104 = 94.0104 → round2 94.01 → ceil 95 units consumed.
  const nullT2 = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, facility: "null-t2" });
  assert.ok(nullT2);
  assert.equal(nullT2.build_cost, 95 * 5); // 475 — fewer materials bought
  // EIV ignores ME: still 100 × 6 = 600, so job cost is unchanged by the preset.
  assert.ok(Math.abs(nullT2.job_cost - 600 * (0.025 + 0.0025 + 0.04)) < 1e-6);

  // highsec-T2 ME: 100 × 0.96624 = 96.624 → round2 96.62 → ceil 97.
  const hsT2 = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, facility: "highsec-t2" });
  assert.ok(hsT2);
  assert.equal(hsT2.build_cost, 97 * 5); // 485

  // NPC (default) is a no-op: full 100 units, unchanged from ME-0.
  const npc = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, facility: "npc" });
  assert.ok(npc);
  assert.equal(npc.build_cost, 100 * 5); // 500

  // A custom cost index scales only the job fee, not materials.
  const richIndex = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, facility: "null-t2", costIndex: 5 });
  assert.ok(richIndex);
  assert.equal(richIndex.build_cost, 95 * 5); // materials unchanged by index
  assert.ok(Math.abs(richIndex.job_cost - 600 * (0.05 + 0.0025 + 0.04)) < 1e-6);

  db.close();
});

test("partial EIV: an unpriced material is skipped, the priced one still drives job cost", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Build Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15676, 'Some Blueprint', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (15677, 'Some Module', 1)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (34, 'Tritanium', 0.01)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (35, 'Pyerite', 0.01)").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, ?)").run(
    JSON.stringify([{ type_id: 34, quantity: 100 }, { type_id: 35, quantity: 50 }])
  );
  db.prepare("INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (15677, 60000000, 50000000, 5, 5, 1)").run();
  db.prepare("INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (34, 5, 4, 5, 5, 1)").run();
  db.prepare("INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (35, 8, 7, 5, 5, 1)").run();
  // Only Tritanium has a CCP adjusted price; Pyerite is skipped from EIV.
  db.prepare("INSERT INTO adjusted_prices(type_id, adjusted_price, average_price, updated_at) VALUES (34, 6, 6, 'now')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1)").run();

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);
  // EIV = 100×6 (Tritanium) only; Pyerite contributes 0, not NaN.
  assert.ok(Math.abs(row.job_cost - 600 * DEFAULT_RATE) < 1e-6, `job_cost=${row.job_cost}`);
  // build_cost still reflects BOTH materials at their sell-order prices.
  assert.equal(row.build_cost, 100 * 5 + 50 * 8); // 900

  db.close();
});

test("multi-product offer sums EIV across both recipes and flags it as a manufacture row", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (1, 'Build Corp', 'HIGHSEC')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15676, 'BP A', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (15678, 'BP B', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (15677, 'Module A', 1)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (15679, 'Module B', 1)").run();
  db.prepare("INSERT INTO types(type_id, name, packaged_volume) VALUES (34, 'Tritanium', 0.01)").run();
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15676, 15677, 1, ?)").run(
    JSON.stringify([{ type_id: 34, quantity: 100 }])
  );
  db.prepare("INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json) VALUES (15678, 15679, 1, ?)").run(
    JSON.stringify([{ type_id: 34, quantity: 50 }])
  );
  for (const t of [15677, 15679]) {
    db.prepare("INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (?, 60000000, 50000000, 5, 5, 1)").run(t);
  }
  db.prepare("INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44) VALUES (34, 5, 4, 5, 5, 1)").run();
  db.prepare("INSERT INTO adjusted_prices(type_id, adjusted_price, average_price, updated_at) VALUES (34, 6, 6, 'now')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 15676, 1), (1, 15678, 1)").run();

  const row = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  assert.ok(row);
  // EIV sums both recipes' base material: (100 + 50) × 6 = 900.
  assert.ok(Math.abs(row.job_cost - 900 * DEFAULT_RATE) < 1e-6, `job_cost=${row.job_cost}`);
  assert.equal(row.build_cost, 150 * 5); // 750, ME-0 at the default facility

  // null-T2 applies ME per material term: 100→95 and 50→48, summed = 143 units.
  const nullT2 = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, facility: "null-t2" });
  assert.ok(nullT2);
  assert.equal(nullT2.build_cost, (95 + 48) * 5); // per-term ceil, not ceil of the 150 total
  // EIV still uses ME-0 base, so job cost is unchanged by the facility.
  assert.ok(Math.abs(nullT2.job_cost - 900 * DEFAULT_RATE) < 1e-6);

  db.close();
});

test("realistic-patient mode counts the job fee exactly once", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db, { adjustedPrice: 6 });
  // History gives the patient-fill estimate something to work with.
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days, updated_at) VALUES (15677, 50, 60000000, 61000000, 28, 'now')").run();

  const plain = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true });
  const realistic = calculateOffer(db, 1, { hideVanity: false, includeSpecial: true, realisticPatient: true });
  assert.ok(plain && realistic);

  // The job fee is identical and counted once: capital and net_instant are unchanged,
  // and patient net is only ever discounted (never double-charged) by realistic mode.
  assert.equal(realistic.job_cost, plain.job_cost);
  assert.ok(realistic.job_cost > 0);
  assert.equal(realistic.capital_required, plain.capital_required);
  assert.equal(realistic.capital_required, plain.build_cost + plain.job_cost);
  assert.ok(Math.abs((realistic.net_profit_instant ?? 0) - (plain.net_profit_instant ?? 0)) < 1e-6);
  assert.ok(realistic.net_profit_patient <= plain.net_profit_patient + 1e-6);

  db.close();
});

test("recomputeAndPersist stores job_cost on the calc row", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedManufactureOffer(db, { adjustedPrice: 6 });

  recomputeAndPersist(db);
  const stored = db.prepare("SELECT job_cost FROM calc WHERE offer_id=1").pluck().get() as number;
  assert.ok(Math.abs(stored - 600 * DEFAULT_RATE) < 1e-6, `stored job_cost=${stored}`);

  db.close();
});
