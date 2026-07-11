import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { cleanupExpiredEsiCache, createEsiClient } from "../src/lib/esi.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("ESI cache uses a short fallback TTL when Expires is unparseable", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const started = Date.now();

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        expires: "not a date",
        "x-pages": "1"
      }
    });

  try {
    const result = await createEsiClient(db).getJson<{ ok: boolean }>("/latest/status/");
    assert.deepEqual(result, { ok: true });
    const cached = db.prepare("SELECT expires_at FROM esi_cache LIMIT 1").get() as { expires_at: string } | undefined;
    assert.ok(cached);
    const fallbackTtlMs = Date.parse(cached.expires_at) - started;
    assert.ok(fallbackTtlMs >= 240_000);
    assert.ok(fallbackTtlMs <= 360_000);
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

test("ESI client with store:false bypasses the cache for both reads and writes", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  let networkCalls = 0;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () => {
    networkCalls += 1;
    return new Response(JSON.stringify({ n: networkCalls }), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 3_600_000).toUTCString(),
        "x-pages": "1"
      }
    });
  };

  try {
    const client = createEsiClient(db);
    const first = await client.getJson<{ n: number }>("/latest/contracts/public/items/1/", { store: false });
    const second = await client.getJson<{ n: number }>("/latest/contracts/public/items/1/", { store: false });
    assert.equal(first.n, 1);
    assert.equal(second.n, 2, "store:false must not serve from cache");
    const cachedRows = db.prepare("SELECT COUNT(*) AS n FROM esi_cache").get() as { n: number };
    assert.equal(cachedRows.n, 0, "store:false must not write to cache");

    // A cached entry from a normal request must not be served to a store:false request.
    await client.getJson("/latest/contracts/public/items/1/");
    assert.equal(networkCalls, 3);
    await client.getJson("/latest/contracts/public/items/1/", { store: false });
    assert.equal(networkCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("ESI client returns null for 204 No Content and empty 200 bodies without caching", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  let status = 204;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () => new Response(status === 204 ? null : "", { status });

  try {
    const client = createEsiClient(db);
    const noContent = await client.getJson<unknown[] | null>("/latest/contracts/public/items/1/");
    assert.equal(noContent, null);

    // ESI also serves 200 OK with Content-Length: 0 on this endpoint.
    status = 200;
    const emptyOk = await client.getJson<unknown[] | null>("/latest/contracts/public/items/2/");
    assert.equal(emptyOk, null);

    const cachedRows = db.prepare("SELECT COUNT(*) AS n FROM esi_cache").get() as { n: number };
    assert.equal(cachedRows.n, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CONTACT_EMAIL", originalContactEmail);
    restoreEnv("APP_URL", originalAppUrl);
    db.close();
  }
});

test("ESI client rejects invalid JSON without caching the bad body", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response("{", {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString()
      }
    });

  try {
    await assert.rejects(
      createEsiClient(db).getJson("/latest/status/"),
      /invalid JSON from ESI for https:\/\/esi\.evetech\.net\/latest\/status\//
    );
    const cached = db.prepare("SELECT COUNT(*) AS count FROM esi_cache").get() as { count: number };
    assert.equal(cached.count, 0);
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

test("ESI client persists a successful response before low-error-budget backoff", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-esi-error-limit-remain": "9",
        "x-esi-error-limit-reset": "1"
      }
    });

  const pending = createEsiClient(db).getJson<{ ok: boolean }>("/latest/status/");
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cached = db.prepare("SELECT body FROM esi_cache LIMIT 1").get() as { body: string } | undefined;
    assert.ok(cached);
    assert.deepEqual(JSON.parse(cached.body), { ok: true });
    assert.deepEqual(await pending, { ok: true });
  } finally {
    await pending.catch(() => undefined);
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

test("ESI client exposes per-client cache and network timing stats", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  let calls = 0;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        expires: new Date(Date.now() + 60_000).toUTCString(),
        "x-pages": "1"
      }
    });
  };

  try {
    const client = createEsiClient(db, { fetchImpl });
    assert.deepEqual(await client.getJson<{ ok: boolean }>("/latest/status/"), { ok: true });
    assert.deepEqual(await client.getJson<{ ok: boolean }>("/latest/status/"), { ok: true });

    const stats = client.getStats();
    assert.equal(calls, 1);
    assert.equal(stats.cache_hits, 1);
    assert.equal(stats.network_requests, 1);
    assert.equal(typeof stats.network_ms, "number");
    assert.equal(stats.retry_count, 0);
  } finally {
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

test("cleanupExpiredEsiCache deletes only expired cache rows", () => {
  const db = new Database(":memory:");
  migrate(db);
  const now = new Date("2026-05-13T12:00:00Z");
  const insert = db.prepare(`
    INSERT INTO esi_cache(cache_key, expires_at, body, updated_at)
    VALUES (?, ?, '{}', ?)
  `);
  insert.run("expired", "2026-05-13T11:59:59.000Z", now.toISOString());
  insert.run("fresh", "2026-05-13T12:00:01.000Z", now.toISOString());

  assert.equal(cleanupExpiredEsiCache(db, now), 1);
  assert.deepEqual(
    (db.prepare("SELECT cache_key FROM esi_cache ORDER BY cache_key").all() as Array<{ cache_key: string }>).map(
      (row) => row.cache_key
    ),
    ["fresh"]
  );

  db.close();
});

test("cleanupExpiredEsiCache caps rows by removing the earliest expirations first", () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalMaxRows = process.env.ESI_CACHE_MAX_ROWS;
  const now = new Date("2026-05-13T12:00:00Z");
  const insert = db.prepare(`
    INSERT INTO esi_cache(cache_key, expires_at, body, updated_at)
    VALUES (?, ?, '{}', ?)
  `);

  process.env.ESI_CACHE_MAX_ROWS = "10";
  for (let index = 0; index < 12; index++) {
    insert.run(
      `cache-${String(index).padStart(2, "0")}`,
      new Date(Date.UTC(2026, 4, 14, 0, index, 0)).toISOString(),
      now.toISOString()
    );
  }

  try {
    assert.equal(cleanupExpiredEsiCache(db, now), 2);
    assert.deepEqual(
      (db.prepare("SELECT cache_key FROM esi_cache ORDER BY expires_at ASC").all() as Array<{ cache_key: string }>).map(
        (row) => row.cache_key
      ),
      [
        "cache-02",
        "cache-03",
        "cache-04",
        "cache-05",
        "cache-06",
        "cache-07",
        "cache-08",
        "cache-09",
        "cache-10",
        "cache-11"
      ]
    );
  } finally {
    restoreEnv("ESI_CACHE_MAX_ROWS", originalMaxRows);
    db.close();
  }
});
