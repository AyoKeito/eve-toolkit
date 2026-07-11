import assert from "node:assert/strict";
import test from "node:test";
import * as uiModel from "../../web/lp/ui-model.js";
import {
  classifyCloudflarePurge,
  classifyFetcherFreshness,
  classifyHealth,
  cargoFlag,
  deriveOfferMetrics,
  formatDailyVolume,
  offerIskPerLp,
  offerRoi,
  resolveCorpOption,
  selectLatestFetcherStatus,
  summarizeDetailDrawer
} from "../../web/lp/ui-model.js";

const rows = [
  {
    offer_id: 101,
    corp_name: "Nugoeihuvi Corporation",
    offer_name: "Agency 'Hardshell' TB5 Dose III",
    isk_per_lp_instant: 2732.41,
    isk_per_lp_patient: 3842.18,
    roi_instant: 0.406,
    lp_cost: 150000,
    isk_cost: 409860000,
    capital_required: 500000000,
    runs: 1,
    cargo_m3: 0.01,
    days_of_supply: 2.3,
    risk_tier: "HIGHSEC",
    flags: [{ code: "LOW_VOLUME", severity: "warn" }]
  },
  {
    offer_id: 102,
    corp_name: "Blood Raiders",
    offer_name: "Covenant Module",
    isk_per_lp_instant: 2415.77,
    isk_per_lp_patient: 4128.77,
    roi_instant: 0.71,
    lp_cost: 180000,
    isk_cost: 434840000,
    capital_required: 700000000,
    runs: 2,
    cargo_m3: 1.4,
    days_of_supply: 1.2,
    risk_tier: "LOWSEC",
    flags: []
  }
];

test("deriveOfferMetrics returns desktop metric-strip values from loaded rows", () => {
  const metrics = deriveOfferMetrics(rows, "30000");

  assert.equal(metrics.offerCount, 2);
  assert.equal(metrics.bestInstant?.corp_name, "Nugoeihuvi Corporation");
  assert.equal(metrics.bestInstant?.isk_per_lp_instant, 2732.41);
  assert.equal(metrics.bestPatient?.corp_name, "Blood Raiders");
  assert.equal(metrics.bestPatient?.isk_per_lp_patient, 4128.77);
  assert.equal(metrics.bestIskPerHour, 123863100);
  assert.equal(metrics.medianIskPerLp, 3985.48);
  assert.equal(metrics.totalLpVolume, 510000);
  assert.equal(metrics.totalIskVolume, 1200000000);
  assert.deepEqual(metrics.priceHealth, { label: "Watch", tone: "warn", note: "1 flagged row" });
});

test("deriveOfferMetrics summarizes displayed ISK/LP instead of instant-only liquidation", () => {
  const metrics = deriveOfferMetrics(
    [
      { isk_per_lp_instant: -50000, isk_per_lp_patient: 270700 },
      { isk_per_lp_instant: 1200, isk_per_lp_patient: 1500 },
      { isk_per_lp_instant: -1000, isk_per_lp_patient: 4000 }
    ],
    "30000"
  );

  assert.equal(metrics.medianIskPerLp, 4000);
});

test("deriveOfferMetrics scales ISK/hour from the active valuation basis", () => {
  const row = { isk_per_lp_instant: -12958.28, isk_per_lp_patient: 26447.11 };

  assert.equal(deriveOfferMetrics([row], "30000", "instantSell").bestIskPerHour, -388748400);
  assert.equal(deriveOfferMetrics([row], "30000", "patientSell").bestIskPerHour, 793413300);
  assert.equal(deriveOfferMetrics([row], "30000", "best").bestIskPerHour, 793413300);
});

test("deriveOfferMetrics handles empty rows without fake values", () => {
  const metrics = deriveOfferMetrics([], "30000");

  assert.equal(metrics.offerCount, 0);
  assert.equal(metrics.bestInstant, null);
  assert.equal(metrics.bestPatient, null);
  assert.equal(metrics.bestIskPerHour, null);
  assert.equal(metrics.medianIskPerLp, null);
  assert.equal(metrics.totalLpVolume, null);
  assert.equal(metrics.totalIskVolume, null);
  assert.deepEqual(metrics.priceHealth, { label: "No data", tone: "muted", note: "waiting for rows" });
});

test("offerIskPerLp uses explicit API value before display fallback", () => {
  assert.equal(offerIskPerLp({ isk_per_lp: 3910, isk_per_lp_instant: 2732.41, isk_per_lp_patient: 3842.18 }), 3910);
  assert.equal(offerIskPerLp({ isk_per_lp_instant: 2732.41, isk_per_lp_patient: 3842.18 }), 3842.18);
  assert.equal(offerIskPerLp({ isk_per_lp_instant: null, isk_per_lp_patient: undefined }), null);
});

test("offerIskPerLp can resolve buy, sell, and highest valuation bases", () => {
  const row = { isk_per_lp_instant: -12958.28, isk_per_lp_patient: 26447.11 };

  assert.equal(offerIskPerLp(row, "instantSell"), -12958.28);
  assert.equal(offerIskPerLp(row, "patientSell"), 26447.11);
  assert.equal(offerIskPerLp(row, "best"), 26447.11);
});

test("offerRoi follows the valuation basis and picks the winning route on best", () => {
  // A contract-priced sell row: no instant channel at all.
  const contractRow = { isk_per_lp_instant: null, isk_per_lp_patient: 96_600, roi_instant: null, roi_patient: 32.2 };
  assert.equal(offerRoi(contractRow, "best"), 32.2);
  assert.equal(offerRoi(contractRow, "instantSell"), null);
  assert.equal(offerRoi(contractRow, "patientSell"), 32.2);

  const marketRow = { isk_per_lp_instant: 2500, isk_per_lp_patient: 2000, roi_instant: 0.4, roi_patient: 0.3 };
  assert.equal(offerRoi(marketRow, "best"), 0.4);
});

test("formatDailyVolume renders whole-number daily volume labels", () => {
  assert.equal(formatDailyVolume(931.36), "931/d");
  assert.equal(formatDailyVolume(23_040.4), "23K/d");
  assert.equal(formatDailyVolume(746_410.9), "746K/d");
  assert.equal(formatDailyVolume(null), "-");
});

test("cargoFlag marks heavy and very heavy rows by packaged volume", () => {
  assert.equal(cargoFlag({ cargo_m3: 100 }), null);
  assert.deepEqual(cargoFlag({ cargo_m3: 100.01 }), {
    code: "HEAVY",
    severity: "warn",
    message: "Heavy cargo above 100 m3"
  });
  assert.deepEqual(cargoFlag({ cargo_m3: 500.01 }), {
    code: "VERY_HEAVY",
    severity: "strong",
    message: "Very heavy cargo above 500 m3"
  });
});

test("classifyHealth maps health payloads to rail display tones", () => {
  assert.deepEqual(classifyHealth({ status: "ok" }), { label: "Healthy", tone: "good" });
  assert.deepEqual(classifyHealth({ status: "degraded" }), { label: "Needs attention", tone: "bad" });
  assert.deepEqual(classifyHealth(null), { label: "Unavailable", tone: "muted" });
});

test("classifyCloudflarePurge maps purge records to edge chip tones", () => {
  const nowMs = Date.parse("2026-06-07T12:00:00.000Z");

  assert.deepEqual(classifyCloudflarePurge(null, nowMs).tone, "muted");

  const fresh = classifyCloudflarePurge({ status: "ok", at: "2026-06-07T11:45:00.000Z" }, nowMs);
  assert.equal(fresh.label, "Edge purged");
  assert.equal(fresh.tone, "good");

  const stale = classifyCloudflarePurge({ status: "ok", at: "2026-06-07T08:00:00.000Z" }, nowMs);
  assert.equal(stale.label, "Edge purge stale");
  assert.equal(stale.tone, "warn");

  const failing = classifyCloudflarePurge(
    { status: "error", status_code: 400, error: "Invalid API Token", at: "2026-06-07T11:45:00.000Z" },
    nowMs
  );
  assert.equal(failing.label, "Edge purge failing");
  assert.equal(failing.tone, "bad");
  assert.match(failing.detail, /HTTP 400/);
  assert.match(failing.detail, /Invalid API Token/);

  const off = classifyCloudflarePurge({ status: "skipped", reason: "missing_api_token", at: "2026-06-07T11:45:00.000Z" }, nowMs);
  assert.equal(off.label, "Edge purge off");
  assert.equal(off.tone, "muted");
  assert.match(off.detail, /missing_api_token/);
});

test("selectLatestFetcherStatus picks the newest successful price fetcher", () => {
  const fetchers = [
    { name: "esi-prices-cold", last_success: "2026-05-19T12:05:00.000Z" },
    { name: "esi-prices-hot", last_success: "2026-05-19T14:00:00.000Z" }
  ];

  const selected = selectLatestFetcherStatus(fetchers, ["esi-prices-hot", "esi-prices-cold"]);

  assert.equal(selected?.name, "esi-prices-hot");
});

test("classifyFetcherFreshness treats daily LP updates as fresh inside the health window", () => {
  const nowMs = Date.parse("2026-05-19T14:17:00.000Z");

  assert.deepEqual(
    classifyFetcherFreshness(
      { name: "esi-lp", last_success: "2026-05-19T11:39:45.846Z", last_error_at: null },
      48 * 60 * 60 * 1000,
      nowMs
    ),
    { tone: "good", issue: null }
  );
  assert.equal(
    classifyFetcherFreshness(
      { name: "esi-prices-cold", last_success: "2026-05-19T11:59:00.000Z", last_error_at: null },
      2 * 60 * 60 * 1000,
      nowMs
    ).tone,
    "bad"
  );
});

test("summarizeDetailDrawer caps dense detail sections for the first viewport", () => {
  const summary = summarizeDetailDrawer({
    corp_name: "DED",
    corp_station: "Yulai VIII - Moon 12 - DED Logistic Support",
    corp_system: "Yulai",
    corp_security: 1,
    runs: 1,
    capital_required: 302000000,
    build_cost: 45600000,
    sales_targets: [
      { name: "Stormbringer", quantity: 1, walk: { avg_price: 353000000, total_value: 353000000, orders: [{ price: 353000000, consumed_qty: 1, location_id: 60003760 }] } }
    ],
    input_lines: [
      { name: "Triglavian Sublight Telemeter", quantity: 100, walk: { avg_price: 956, total_value: 95600 } },
      { name: "Triglavian Transconduit Datacaster", quantity: 600, walk: { avg_price: 420696.5, total_value: 252417900 } }
    ],
    build_lines: [
      { name: "Tritanium", quantity: 540000, walk: { avg_price: 3.45, total_value: 1863000 } },
      { name: "Pyerite", quantity: 180000, walk: { avg_price: 16.87, total_value: 3036856 } },
      { name: "Mexallon", quantity: 36000, walk: { avg_price: 64.75, total_value: 2331000 } },
      { name: "Isogen", quantity: 10000, walk: { avg_price: 214.9, total_value: 2149000 } },
      { name: "Nocxium", quantity: 2500, walk: { avg_price: 724.86, total_value: 1812156 } }
    ]
  });

  assert.ok(summary);
  assert.equal(summary.store.station, "Yulai VIII - Moon 12 - DED Logistic Support");
  assert.equal(summary.products.items.length, 1);
  assert.equal(summary.requiredItems.items.length, 2);
  assert.equal(summary.buildMaterials.items.length, 5);
  assert.equal(summary.buildMaterials.remaining, 0);
  assert.equal(summary.buildMaterials.names, "Tritanium, Pyerite, Mexallon, Isogen, Nocxium");
  assert.equal(summary.buildMaterials.totalCost, 11192012);
  assert.equal(summary.sourceOrders.items.length, 1);
});

test("resolveCorpOption resolves exact visible corporation names", () => {
  const corp = resolveCorpOption(
    [
      { corp_id: 1000137, name: "DED" },
      { corp_id: 1000125, name: "CONCORD" }
    ],
    "DED"
  );

  assert.equal(corp?.corp_id, 1000137);
});

test("ui model does not expose collapsible movers state", () => {
  assert.equal("shouldKeepMoverPanelOpen" in uiModel, false);
});

test("summarizeDetailDrawer returns null totalCost when all item values are null", () => {
  const summary = summarizeDetailDrawer({
    corp_name: "Test Corp",
    corp_station: "Test Station",
    corp_system: "Test System",
    corp_security: 1,
    runs: 1,
    capital_required: 0,
    build_cost: 0,
    sales_targets: [{ name: "Unpriced Item", quantity: 1, walk: { orders: [] } }],
    input_lines: [],
    build_lines: []
  });

  assert.ok(summary);
  assert.equal(summary.products.totalCost, null);
});

test("summarizeDetailDrawer returns numeric totalCost when items have values", () => {
  const summary = summarizeDetailDrawer({
    corp_name: "Test Corp",
    corp_station: "Test Station",
    corp_system: "Test System",
    corp_security: 1,
    runs: 1,
    capital_required: 0,
    build_cost: 0,
    sales_targets: [
      { name: "Item A", quantity: 1, walk: { avg_price: 100, total_value: 100, orders: [] } },
      { name: "Item B", quantity: 1, walk: { orders: [] } }
    ],
    input_lines: [],
    build_lines: []
  });

  assert.ok(summary);
  assert.equal(summary.products.totalCost, 100);
});
