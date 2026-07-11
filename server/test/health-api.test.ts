import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { migrate } from "../src/db.js";
import { registerHealthRoutes } from "../src/api/health.js";

test("health reports degraded before required data and fetchers are ready", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await registerHealthRoutes(app, db);

  const response = await app.inject("/api/health");
  const payload = response.json() as {
    status: string;
    issues?: string[];
  };

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, "degraded");
  assert.ok(payload.issues?.includes("missing_fetcher_status:esi-lp"));
  assert.ok(payload.issues?.includes("empty_table:calc"));

  await app.close();
  db.close();
});

test("health surfaces the last Cloudflare purge result and flags failures", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await registerHealthRoutes(app, db);

  const before = await app.inject("/api/health");
  assert.equal(before.json().cloudflare_purge, null);

  db.prepare("INSERT INTO kv(key, value) VALUES('cloudflare_purge_last', ?)").run(
    JSON.stringify({
      status: "error",
      status_code: 400,
      error: "Invalid API Token",
      reason: null,
      at: "2026-06-07T12:00:00.000Z"
    })
  );

  const response = await app.inject("/api/health");
  const payload = response.json() as {
    issues?: string[];
    cloudflare_purge?: { status: string; status_code: number | null; error: string | null };
  };

  assert.equal(response.statusCode, 200);
  assert.ok(payload.issues?.includes("cloudflare_purge_failed"));
  assert.equal(payload.cloudflare_purge?.status, "error");
  assert.equal(payload.cloudflare_purge?.status_code, 400);
  assert.equal(payload.cloudflare_purge?.error, "Invalid API Token");

  await app.close();
  db.close();
});

test("health exposes imported SDE metadata when available", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(`
    INSERT INTO source_imports(source, build_number, release_date, archive_url, imported_at, metadata_json)
    VALUES ('ccp-jsonl-sde', 3346029, '2026-05-13T11:51:25Z', 'file://fixture.zip', '2026-05-13T12:00:00Z', '{}')
  `).run();
  const app = Fastify();
  await registerHealthRoutes(app, db);

  const response = await app.inject("/api/health");
  const payload = response.json() as {
    sde?: {
      source: string;
      build_number: number;
      release_date: string;
      imported_at: string;
    };
  };

  assert.equal(response.statusCode, 200);
  assert.deepEqual(payload.sde, {
    source: "ccp-jsonl-sde",
    build_number: 3346029,
    release_date: "2026-05-13T11:51:25Z",
    imported_at: "2026-05-13T12:00:00Z"
  });

  await app.close();
  db.close();
});
