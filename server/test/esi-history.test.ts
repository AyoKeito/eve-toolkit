import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { fetchHistory } from "../src/fetchers/esi-history.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

function createHistoryDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");

  const insertType = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  insertType.run(10, "First market item");
  insertType.run(11, "Missing market history item");
  insertType.run(12, "Second market item");

  const insertDependency = db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (?, ?, 'PRODUCT')");
  insertDependency.run(1, 10);
  insertDependency.run(2, 11);
  insertDependency.run(3, 12);

  return db;
}

function okHistory(volume: number): Response {
  return new Response(
    JSON.stringify([
      { average: 100, date: "2026-05-03", highest: 120, lowest: 90, order_count: 4, volume },
      { average: 110, date: "2026-05-04", highest: 130, lowest: 95, order_count: 5, volume: volume * 2 }
    ]),
    {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString()
      }
    }
  );
}

function historyResponse(days: Array<{ date: string; volume: number; average: number }>): Response {
  return new Response(
    JSON.stringify(
      days.map((day) => ({
        average: day.average,
        date: day.date,
        highest: day.average,
        lowest: day.average,
        order_count: 1,
        volume: day.volume
      }))
    ),
    {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString()
      }
    }
  );
}

test("fetchHistory skips missing per-type history and continues the batch", async () => {
  const db = createHistoryDb();
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("type_id=10")) return okHistory(30);
    if (url.includes("type_id=11")) return new Response("bad type", { status: 400, statusText: "Bad Request" });
    if (url.includes("type_id=12")) return okHistory(60);
    throw new Error(`unexpected url ${url}`);
  };

  try {
    assert.equal(await fetchHistory(db), 2);
    const rows = db.prepare("SELECT type_id, avg_daily_volume_28d FROM history ORDER BY type_id").all() as Array<{
      type_id: number;
      avg_daily_volume_28d: number;
    }>;
    // Each okHistory item has 2 trading days (both inside the 28-day window), so the average is
    // total volume / 28 calendar days: type 10 = (30 + 60) / 28, type 12 = (60 + 120) / 28.
    assert.deepEqual(
      rows.map((row) => [row.type_id, row.avg_daily_volume_28d]),
      [
        [10, 90 / 28],
        [12, 180 / 28]
      ]
    );
    const status = db.prepare("SELECT last_success, last_error_at FROM fetcher_status WHERE name='esi-history'").get() as
      | { last_success: string | null; last_error_at: string | null }
      | undefined;
    assert.ok(status?.last_success);
    assert.equal(status.last_error_at, null);
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

test("fetchHistory averages over 28 calendar days, not 28 trading records", async () => {
  const db = createHistoryDb();
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  // A thinly-traded item: 4 trades inside the last 28 calendar days (ending at the newest record,
  // 2026-05-30) plus 2 far-older ones. The old code took the 28 most recent RECORDS and divided by
  // their count (6), folding in trades from months ago; the fix windows to [2026-05-03, 2026-05-30]
  // and divides by the full 28-day window.
  const days = [
    { date: "2026-05-30", volume: 700, average: 200 },
    { date: "2026-05-25", volume: 700, average: 200 },
    { date: "2026-05-10", volume: 700, average: 200 },
    { date: "2026-05-04", volume: 700, average: 200 },
    { date: "2026-03-01", volume: 999999, average: 999 },
    { date: "2026-01-15", volume: 888888, average: 999 }
  ];

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("type_id=10")) return historyResponse(days);
    throw new Error(`unexpected url ${url}`);
  };

  try {
    assert.equal(await fetchHistory(db, 1), 1);
    const row = db.prepare("SELECT avg_daily_volume_28d, max_price_28d, days FROM history WHERE type_id=10").get() as {
      avg_daily_volume_28d: number;
      max_price_28d: number;
      days: number;
    };
    // 4 in-window trades × 700 = 2800, divided by the 28-day window = 100/day — NOT 2800/4 = 700,
    // and NOT (2800 + 1.9M)/6. The two ancient trades are excluded from volume, median and max.
    assert.equal(row.avg_daily_volume_28d, 100);
    assert.equal(row.max_price_28d, 200);
    assert.equal(row.days, 4);
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

test("fetchHistory summarizes the most recent 28 market-history days", async () => {
  const db = createHistoryDb();
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = index + 1;
    return {
      date: `2026-05-${String(day).padStart(2, "0")}`,
      volume: day <= 2 ? 1000 : 10,
      average: day <= 2 ? 500 : 100
    };
  });

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("type_id=10")) return historyResponse(days);
    throw new Error(`unexpected url ${url}`);
  };

  try {
    assert.equal(await fetchHistory(db, 1), 1);
    const row = db.prepare("SELECT avg_daily_volume_28d, median_price_28d, max_price_28d, days FROM history WHERE type_id=10").get() as {
      avg_daily_volume_28d: number;
      median_price_28d: number;
      max_price_28d: number;
      days: number;
    };
    assert.equal(row.avg_daily_volume_28d, 10);
    assert.equal(row.median_price_28d, 100);
    assert.equal(row.max_price_28d, 100);
    assert.equal(row.days, 28);
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
