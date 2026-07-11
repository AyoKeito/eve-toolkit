import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, type Db } from "../src/db.js";
import { denormalizeItems, fetchContracts } from "../src/fetchers/esi-contracts.js";

const testAppUrl = "https://app.example.test";

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

interface MockState {
  listing: Array<Record<string, unknown>>;
  items: Map<number, Array<Record<string, unknown>> | 404 | 500>;
  listingCalls: number;
  itemsCalls: number;
}

/** Listing responses use an already-expired Expires header so every cycle
 * refetches (prod aligns the 30-min header with the 30-min cron instead). */
function installMockFetch(state: MockState): () => void {
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const originalSaturation = process.env.CONTRACT_SATURATION_ENABLED;
  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  // This suite mocks only The Forge listing; keep the scan price-regions-only so the default
  // warzone saturation regions aren't paged (they have their own coverage in fits-api.test.ts).
  process.env.CONTRACT_SATURATION_ENABLED = "false";

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const headers = {
      expires: new Date(Date.now() - 1000).toUTCString(),
      "x-pages": "1"
    };
    const listingMatch = url.match(/\/contracts\/public\/10000002\//);
    if (listingMatch) {
      state.listingCalls += 1;
      return new Response(JSON.stringify(state.listing), { status: 200, headers });
    }
    const itemsMatch = url.match(/\/contracts\/public\/items\/(\d+)\//);
    if (itemsMatch) {
      state.itemsCalls += 1;
      const contractId = Number(itemsMatch[1]);
      const items = state.items.get(contractId);
      if (items === 500) {
        return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers });
      }
      if (items === undefined || items === 404) {
        return new Response(JSON.stringify({ error: "contract not found" }), { status: 404, headers });
      }
      return new Response(JSON.stringify(items), { status: 200, headers });
    }
    throw new Error(`unexpected URL in mock fetch: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
    if (originalContactEmail === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = originalContactEmail;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalSaturation === undefined) delete process.env.CONTRACT_SATURATION_ENABLED;
    else process.env.CONTRACT_SATURATION_ENABLED = originalSaturation;
  };
}

function contractRow(db: Db, contractId: number): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM contracts WHERE contract_id=?").get(contractId) as Record<string, unknown> | undefined;
}

test("denormalizeItems applies the single-type bundle rule", () => {
  // Two copies of the same BPC in one contract: a quantity-2 ask.
  const bundle = denormalizeItems([
    { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 1, runs: 1, type_id: 57144 },
    { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 2, runs: 1, type_id: 57144 }
  ]);
  assert.deepEqual(bundle, { hasExcluded: false, singleType: { typeId: 57144, quantity: 2, isBpc: true, runs: 1 } });

  // Mixed types: not a single-type ask.
  assert.equal(denormalizeItems([
    { is_included: true, quantity: 1, record_id: 1, type_id: 100 },
    { is_included: true, quantity: 1, record_id: 2, type_id: 200 }
  ]).singleType, null);

  // BPC lines disagreeing on runs: skipped (unit price would be meaningless).
  assert.equal(denormalizeItems([
    { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 1, runs: 1, type_id: 100 },
    { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 2, runs: 10, type_id: 100 }
  ]).singleType, null);

  // Wanted items (is_included false) flag the contract as a trade, not an ask.
  const trade = denormalizeItems([
    { is_included: true, quantity: 1, record_id: 1, type_id: 100 },
    { is_included: false, quantity: 1, record_id: 2, type_id: 300 }
  ]);
  assert.equal(trade.hasExcluded, true);
  assert.equal(trade.singleType?.typeId, 100);
});

test("fetchContracts ingests a region, fetches items once, detects disappearances, prices the rollup", async () => {
  const db = new Database(":memory:");
  migrate(db);

  const state: MockState = {
    listing: [
      { contract_id: 101, type: "item_exchange", price: 2_000_000_000, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 102, type: "item_exchange", price: 500_000, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 103, type: "courier", price: 0, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 104, type: "auction", price: 1_000_000, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 105, type: "item_exchange", price: 1_000, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 106, type: "item_exchange", price: 100, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 107, type: "item_exchange", price: 110, date_issued: futureIso(-7), date_expired: futureIso(7) },
      { contract_id: 108, type: "item_exchange", price: 777, date_issued: futureIso(-7), date_expired: futureIso(7) }
    ],
    items: new Map<number, Array<Record<string, unknown>> | 404 | 500>([
      [
        101,
        [
          { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 11, runs: 1, type_id: 500 },
          { is_included: true, is_blueprint_copy: true, quantity: 1, record_id: 12, runs: 1, type_id: 500 }
        ]
      ],
      [102, [
        { is_included: true, quantity: 1, record_id: 21, type_id: 600 },
        { is_included: false, quantity: 1, record_id: 22, type_id: 700 }
      ]],
      [105, 404],
      [106, [{ is_included: true, quantity: 1, record_id: 61, type_id: 800 }]],
      [107, [{ is_included: true, quantity: 1, record_id: 71, type_id: 800 }]],
      [108, 500]
    ]),
    listingCalls: 0,
    itemsCalls: 0
  };
  const restore = installMockFetch(state);

  try {
    const summary = await fetchContracts(db);

    assert.equal(summary.contracts_listed, 7); // courier dropped at ingest
    assert.equal(summary.new_contracts, 7);
    assert.equal(summary.items_fetched, 4);
    assert.equal(summary.items_vanished, 1);
    assert.equal(summary.items_failed, 1, "persistent 500 is tolerated, not fatal");
    assert.equal(summary.priced_types, 1);

    const failed = contractRow(db, 108);
    assert.ok(failed);
    assert.equal(failed.items_fetched, 0, "failed contract left pending for retry");

    assert.equal(contractRow(db, 103), undefined);

    const bundle = contractRow(db, 101);
    assert.ok(bundle);
    assert.equal(bundle.single_item_type_id, 500);
    assert.equal(bundle.single_item_quantity, 2);
    assert.equal(bundle.single_item_is_bpc, 1);
    assert.equal(bundle.items_fetched, 1);

    const trade = contractRow(db, 102);
    assert.ok(trade);
    assert.equal(trade.has_excluded_items, 1);

    const auction = contractRow(db, 104);
    assert.ok(auction);
    assert.equal(auction.items_fetched, 0, "auction items must not be fetched in v1");

    const vanished = contractRow(db, 105);
    assert.ok(vanished);
    assert.notEqual(vanished.gone_at, null);
    assert.equal(vanished.gone_before_expiry, 1);
    assert.equal(vanished.items_fetched, 1, "vanished contracts must not be retried");

    // Two same-type asks (106, 107) publish; the lone BPC bundle (type 500) stays below the floor.
    const priced = db.prepare("SELECT * FROM contract_prices WHERE type_id=800").get() as Record<string, unknown>;
    assert.ok(priced);
    assert.equal(priced.ask_count, 2);
    assert.equal(priced.ask_min, 100);
    const loneBpc = db.prepare("SELECT COUNT(*) AS n FROM contract_prices WHERE type_id=500").get() as { n: number };
    assert.equal(loneBpc.n, 0);

    // Items responses bypass esi_cache (store: false); the listing page is cacheable.
    const itemsCached = db
      .prepare("SELECT COUNT(*) AS n FROM esi_cache WHERE cache_key LIKE '%/contracts/public/items/%'")
      .get() as { n: number };
    assert.equal(itemsCached.n, 0);

    // Cycle 2: contract 101 sold (missing from the listing) — marked gone; fetched
    // items are never refetched; the previously failed contract 108 is retried.
    state.listing = state.listing.filter((row) => row.contract_id !== 101);
    state.items.set(108, [{ is_included: true, quantity: 1, record_id: 81, type_id: 900 }]);
    const itemsCallsAfterFirstCycle = state.itemsCalls;
    const second = await fetchContracts(db);

    assert.equal(second.new_contracts, 0);
    assert.equal(second.gone_marked, 1);
    assert.equal(second.items_fetched, 1, "retry of the failed contract succeeds");
    assert.equal(second.items_failed, 0);
    assert.equal(state.itemsCalls, itemsCallsAfterFirstCycle + 1, "only the failed contract is refetched");

    const sold = contractRow(db, 101);
    assert.ok(sold);
    assert.notEqual(sold.gone_at, null);
    assert.equal(sold.gone_before_expiry, 1, "vanished a week before expiry: likely sold");
  } finally {
    restore();
    db.close();
  }
});
