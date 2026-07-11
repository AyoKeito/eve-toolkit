import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { fetchPrices, referencedTypeIds } from "../src/fetchers/esi-prices.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("referencedTypeIds excludes referenced ids missing from the local types table", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");

  const insertType = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  insertType.run(100, "Known offer product");
  insertType.run(200, "Known required item");
  insertType.run(300, "Known manufactured product");
  insertType.run(400, "Known material");

  const insertDependency = db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, ?)");
  insertDependency.run(1, 100, "PRODUCT");
  insertDependency.run(2, 999, "PRODUCT");
  insertDependency.run(1, 200, "REQUIRED_ITEM");
  insertDependency.run(3, 300, "BUILD_PRODUCT");
  insertDependency.run(3, 400, "BUILD_MATERIAL");

  assert.deepEqual(referencedTypeIds(db), [100, 200, 300, 400]);
  db.close();
});

test("referencedTypeIds reads indexed offer market dependencies", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");

  const insertType = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  insertType.run(100, "Offer product");
  insertType.run(200, "Required item");
  insertType.run(300, "Manufactured product");
  insertType.run(400, "Build material");

  const insertDependency = db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, ?, ?)");
  insertDependency.run(100, "PRODUCT");
  insertDependency.run(200, "REQUIRED_ITEM");
  insertDependency.run(300, "BUILD_PRODUCT");
  insertDependency.run(400, "BUILD_MATERIAL");
  insertDependency.run(999, "PRODUCT");

  assert.deepEqual(referencedTypeIds(db), [100, 200, 300, 400]);
  db.close();
});

test("fetchPrices stops market order pagination at the ESI X-Pages count", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Busy market item");
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, ?)").run(1, 100, "PRODUCT");

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const pages: number[] = [];
  const orders = Array.from({ length: 1000 }, (_, index) => ({
    is_buy_order: index % 2 === 0,
    location_id: 60003760,
    order_id: index + 1,
    price: 100 + index,
    system_id: 30000142,
    type_id: 100,
    volume_remain: 1
  }));

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    pages.push(page);
    if (page !== 1) throw new Error(`unexpected page ${page}`);
    return new Response(JSON.stringify(orders), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "1"
      }
    });
  };

  try {
    assert.equal(await fetchPrices(db, "cold"), 1);
    assert.deepEqual(pages, [1]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalContactEmail === undefined) {
      delete process.env.CONTACT_EMAIL;
    } else {
      process.env.CONTACT_EMAIL = originalContactEmail;
    }
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = originalAppUrl;
    }
    db.close();
  }
});

test("fetchPrices persists source order metadata in ranked book rows", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Metadata market item");
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, ?)").run(1, 100, "PRODUCT");

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          is_buy_order: false,
          location_id: 60003760,
          order_id: 10,
          price: 100,
          system_id: 30000142,
          type_id: 100,
          volume_remain: 3
        },
        {
          is_buy_order: true,
          location_id: 60008494,
          order_id: 20,
          price: 90,
          system_id: 30000144,
          type_id: 100,
          volume_remain: 2
        }
      ]),
      {
        status: 200,
        headers: {
          expires: new Date(Date.now() + 60_000).toUTCString(),
          "x-pages": "1"
        }
      }
    );

  try {
    assert.equal(await fetchPrices(db, "cold"), 1);
    const rows = db
      .prepare("SELECT side, rank, order_id, location_id, system_id, is_jita44 FROM prices_book ORDER BY side, rank")
      .all();

    assert.deepEqual(rows, [
      { side: "buy", rank: 0, order_id: 20, location_id: 60008494, system_id: 30000144, is_jita44: 0 },
      { side: "sell", rank: 0, order_id: 10, location_id: 60003760, system_id: 30000142, is_jita44: 1 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalContactEmail === undefined) {
      delete process.env.CONTACT_EMAIL;
    } else {
      process.env.CONTACT_EMAIL = originalContactEmail;
    }
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = originalAppUrl;
    }
    db.close();
  }
});

test("fetchPrices counts only buy orders that reach Jita 4-4", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "Range-filtered market item");
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, ?)").run(1, 100, "PRODUCT");

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        // Sell at Jita 4-4.
        { is_buy_order: false, location_id: 60003760, order_id: 10, price: 500, range: "region", system_id: 30000142, type_id: 100, volume_remain: 5 },
        // Highest bid, but a remote STATION-range order — a Jita 4-4 seller cannot fill it → excluded.
        { is_buy_order: true, location_id: 60008494, order_id: 22, price: 200, range: "station", system_id: 30000144, type_id: 100, volume_remain: 5 },
        // Remote SOLARSYSTEM-range order (not Jita's system) → excluded.
        { is_buy_order: true, location_id: 60011866, order_id: 25, price: 150, range: "solarsystem", system_id: 30000144, type_id: 100, volume_remain: 5 },
        // STATION-range order AT Jita 4-4 → kept.
        { is_buy_order: true, location_id: 60003760, order_id: 21, price: 100, range: "station", system_id: 30000142, type_id: 100, volume_remain: 5 },
        // REGION-range order anywhere in The Forge → reaches Jita 4-4 → kept.
        { is_buy_order: true, location_id: 60011866, order_id: 24, price: 90, range: "region", system_id: 30000144, type_id: 100, volume_remain: 5 }
      ]),
      { status: 200, headers: { expires: new Date(Date.now() + 60_000).toUTCString(), "x-pages": "1" } }
    );

  try {
    assert.equal(await fetchPrices(db, "cold"), 1);
    // buy_max must be the highest bid a Jita 4-4 seller can actually hit — 100, not the remote 200.
    assert.equal(db.prepare("SELECT buy_max FROM prices WHERE type_id=100").pluck().get(), 100);
    const buyOrderIds = db
      .prepare("SELECT order_id FROM prices_book WHERE type_id=100 AND side='buy' ORDER BY rank")
      .pluck()
      .all();
    assert.deepEqual(buyOrderIds, [21, 24]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("fetchPrices bounds per-type concurrency by ESI_FETCH_CONCURRENCY", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  const insertType = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  const insertDependency = db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, 'PRODUCT')");
  for (const typeId of [100, 200, 300]) {
    insertType.run(typeId, `Market item ${typeId}`);
    insertDependency.run(typeId, typeId);
  }

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const originalConcurrency = process.env.ESI_FETCH_CONCURRENCY;
  let inFlight = 0;
  let maxInFlight = 0;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  process.env.ESI_FETCH_CONCURRENCY = "2";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const typeId = Number.parseInt(url.searchParams.get("type_id") ?? "0", 10);
    assert.ok(typeId > 0);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, typeId === 100 ? 30 : 10));
    inFlight -= 1;
    return new Response(
      JSON.stringify([
        {
          is_buy_order: false,
          location_id: 60003760,
          order_id: typeId,
          price: typeId,
          system_id: 30000142,
          type_id: typeId,
          volume_remain: 1
        }
      ]),
      {
        status: 200,
        headers: {
          expires: new Date(Date.now() + 60_000).toUTCString(),
          "x-pages": "1"
        }
      }
    );
  };

  try {
    assert.equal(await fetchPrices(db, "cold", 3), 3);
    assert.equal(maxInFlight, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    restoreEnv("ESI_FETCH_CONCURRENCY", originalConcurrency);
    db.close();
  }
});

test("fetchPrices cold bulk filters unknown types and persists known types without orders as empty", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Bulk item'), (200, 'Market-dead item')").run();
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 100, 'PRODUCT'), (2, 200, 'PRODUCT')").run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, updated_at)
    VALUES (200, 999, 888, 1, 1, 'stale')
  `).run();
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (200, 'sell', 0, 20, 999, 1, 60003760, 30000142, 1)
  `).run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const requestedPages: number[] = [];

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.has("type_id"), false);
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    requestedPages.push(page);
    const rows =
      page === 1
        ? [
            {
              is_buy_order: false,
              location_id: 60003760,
              order_id: 10,
              price: 123,
              system_id: 30000142,
              type_id: 100,
              volume_remain: 2
            },
            {
              is_buy_order: false,
              location_id: 60003760,
              order_id: 999,
              price: 456,
              system_id: 30000142,
              type_id: 999,
              volume_remain: 2
            }
          ]
        : [];
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "2"
      }
    });
  };

  try {
    assert.equal(await fetchPrices(db, "cold"), 2);
    assert.deepEqual(requestedPages.sort((a, b) => a - b), [1, 2]);
    const rows = db.prepare("SELECT type_id, sell_min, sell_order_count, buy_order_count FROM prices ORDER BY type_id").all();
    assert.deepEqual(rows, [
      { type_id: 100, sell_min: 123, sell_order_count: 1, buy_order_count: 0 },
      { type_id: 200, sell_min: null, sell_order_count: 0, buy_order_count: 0 }
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) FROM prices_book WHERE type_id=200").pluck().get(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("fetchPrices cold limit keeps using per-type fetching", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Limited item'), (200, 'Skipped item')").run();
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 100, 'PRODUCT'), (2, 200, 'PRODUCT')").run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const requestedTypeIds: number[] = [];

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const typeId = Number.parseInt(url.searchParams.get("type_id") ?? "0", 10);
    requestedTypeIds.push(typeId);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "1"
      }
    });
  };

  try {
    assert.equal(await fetchPrices(db, "cold", 1), 1);
    assert.deepEqual(requestedTypeIds, [100]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("fetchPrices per-type handles empty order array without error", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Empty market item')").run();
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 100, 'PRODUCT')").run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "1"
      }
    });

  try {
    assert.equal(await fetchPrices(db, "cold", 1), 1);
    const row = db.prepare("SELECT sell_min, buy_max, sell_order_count, buy_order_count FROM prices WHERE type_id=100").get() as
      | { sell_min: number | null; buy_max: number | null; sell_order_count: number; buy_order_count: number }
      | undefined;
    assert.ok(row, "prices row should exist");
    assert.equal(row.sell_min, null);
    assert.equal(row.buy_max, null);
    assert.equal(row.sell_order_count, 0);
    assert.equal(row.buy_order_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("fetchPrices per-type terminates after exactly-1000-row page with no x-pages header", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Full page item')").run();
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 100, 'PRODUCT')").run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const requestedPages: number[] = [];
  const fullPageOrders = Array.from({ length: 1000 }, (_, index) => ({
    is_buy_order: false,
    location_id: 60003760,
    order_id: index + 1,
    price: 100 + index,
    system_id: 30000142,
    type_id: 100,
    volume_remain: 1
  }));

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    requestedPages.push(page);
    // Page 1: full 1000 rows, no x-pages; page 2: empty, signals end-of-data
    const orders = page === 1 ? fullPageOrders : [];
    return new Response(JSON.stringify(orders), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString()
        // deliberately omitting x-pages on all pages
      }
    });
  };

  try {
    assert.equal(await fetchPrices(db, "cold", 1), 1);
    // Must request exactly pages [1, 2]: page 1 full → advance; page 2 empty → break
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("fetchPrices cold falls back to per-type when region bulk lacks X-Pages", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO types(type_id, name) VALUES (100, 'Fallback item')").run();
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 100, 'PRODUCT')").run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  let bulkAttempted = false;
  const perTypeIds: number[] = [];

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const typeId = url.searchParams.get("type_id");
    if (!typeId) {
      bulkAttempted = true;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          expires: new Date(Date.now() + 60_000).toUTCString()
        }
      });
    }
    perTypeIds.push(Number.parseInt(typeId, 10));
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "1"
      }
    });
  };

  try {
    assert.equal(await fetchPrices(db, "cold"), 1);
    assert.equal(bulkAttempted, true);
    assert.deepEqual(perTypeIds, [100]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});
