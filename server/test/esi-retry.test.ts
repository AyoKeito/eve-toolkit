import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { createEsiClient } from "../src/lib/esi.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

// Run `body` with the env createEsiClient needs (User-Agent build), restoring it
// afterwards so these tests stay independent of ambient process env.
async function withEsiEnv(body: () => Promise<void>): Promise<void> {
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  try {
    await body();
  } finally {
    if (originalContactEmail === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = originalContactEmail;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  }
}

test("ESI client retries transient 5xx and then succeeds", async () => {
  await withEsiEnv(async () => {
    const db = new Database(":memory:");
    migrate(db);
    let calls = 0;
    // Two consecutive 504s then a 200 — the pre-bump single-retry client would
    // have given up after the first retry and thrown.
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls <= 2) return new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout" });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const esi = createEsiClient(db, { fetchImpl, serverErrorBackoffMs: 1 });
      const data = await esi.getJson<{ ok: boolean }>("/latest/status/?datasource=tranquility", { store: false });
      assert.deepEqual(data, { ok: true });
      const stats = esi.getStats();
      assert.equal(stats.network_requests, 3, "1 original + 2 retried requests");
      assert.equal(stats.retry_count, 2, "both 504s were retried");
    } finally {
      db.close();
    }
  });
});

test("ESI client gives up after the 5xx retry limit", async () => {
  await withEsiEnv(async () => {
    const db = new Database(":memory:");
    migrate(db);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout" });
    };

    try {
      const esi = createEsiClient(db, { fetchImpl, serverErrorBackoffMs: 1 });
      await assert.rejects(esi.getJson("/latest/status/?datasource=tranquility", { store: false }), /ESI 504/);
      const stats = esi.getStats();
      // 1 original attempt + serverErrorRetryLimit (3) retries = 4 requests.
      assert.equal(stats.network_requests, 4, "original + 3 retries");
      assert.equal(stats.retry_count, 3, "retried up to the cap");
      assert.equal(calls, 4);
    } finally {
      db.close();
    }
  });
});
