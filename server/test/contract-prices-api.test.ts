import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate, type Db } from "../src/db.js";
import { registerContractPriceRoutes } from "../src/api/contract-prices.js";

function seededDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO types(type_id, name, category_id, category_name) VALUES
      (57144, 'High-grade Rapture Delta Blueprint', 9, 'Blueprint');
    INSERT INTO contract_prices(type_id, ask_count, ask_min, ask_median, is_bpc, runs_modal, updated_at) VALUES
      (57144, 3, 1700000000, 1780000000, 1, 1, '2026-06-11T00:00:00.000Z'),
      (15676, 2, 50000000, 52500000, 1, 1, '2026-06-11T00:00:00.000Z');
  `);
  return db;
}

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await registerContractPriceRoutes(app, db);
  return app;
}

test("contract-prices endpoint dumps all rows with type names and cache headers", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const response = await app.inject("/api/contract-prices");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=30, stale-while-revalidate=120");
  assert.equal(response.headers["cdn-cache-control"], "public, s-maxage=1800, stale-while-revalidate=3600");

  const body = response.json() as { count: number; prices: Array<Record<string, unknown>> };
  assert.equal(body.count, 2);
  assert.equal(body.prices[0]?.type_id, 15676);
  assert.equal(body.prices[0]?.name, null); // unknown type: row still served
  assert.equal(body.prices[1]?.name, "High-grade Rapture Delta Blueprint");
  assert.equal(body.prices[1]?.ask_min, 1_700_000_000);

  await app.close();
  db.close();
});

test("contract-prices endpoint filters by type and validates the parameter", async () => {
  const db = seededDb();
  const app = await buildApp(db);

  const one = await app.inject("/api/contract-prices?type=57144");
  assert.equal(one.statusCode, 200);
  const body = one.json() as { prices: Array<Record<string, unknown>> };
  assert.equal(body.prices.length, 1);
  assert.equal(body.prices[0]?.ask_count, 3);

  const unknown = await app.inject("/api/contract-prices?type=42");
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "type_not_priced" });

  const invalid = await app.inject("/api/contract-prices?type=bpc");
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: "invalid_type_id" });

  await app.close();
  db.close();
});
