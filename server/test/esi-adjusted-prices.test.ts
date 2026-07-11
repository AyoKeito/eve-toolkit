import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { persistAdjustedPrices } from "../src/fetchers/esi-adjusted-prices.js";

function seedTypes(db: Database.Database, ...typeIds: number[]): void {
  const insert = db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)");
  for (const typeId of typeIds) insert.run(typeId, `Type ${typeId}`);
}

test("persistAdjustedPrices upserts known types, skips unknown ones, and coalesces missing prices", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedTypes(db, 34, 35, 36);

  const written = persistAdjustedPrices(
    db,
    [
      { type_id: 34, adjusted_price: 5.5, average_price: 6 },
      { type_id: 35, adjusted_price: 1000 }, // no average_price -> null
      { type_id: 36 }, // no adjusted_price -> null, still stored
      { type_id: 9999, adjusted_price: 42 } // unknown type -> skipped (FK safety)
    ],
    "2026-06-22T00:00:00.000Z"
  );

  assert.equal(written, 3);
  const rows = db
    .prepare("SELECT type_id, adjusted_price, average_price, updated_at FROM adjusted_prices ORDER BY type_id")
    .all();
  assert.deepEqual(rows, [
    { type_id: 34, adjusted_price: 5.5, average_price: 6, updated_at: "2026-06-22T00:00:00.000Z" },
    { type_id: 35, adjusted_price: 1000, average_price: null, updated_at: "2026-06-22T00:00:00.000Z" },
    { type_id: 36, adjusted_price: null, average_price: null, updated_at: "2026-06-22T00:00:00.000Z" }
  ]);
  // The unknown type never lands, so the FK to types is never violated.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM adjusted_prices WHERE type_id=9999").pluck().get(), 0);

  db.close();
});

test("persistAdjustedPrices overwrites a prior row for the same type", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedTypes(db, 34);

  persistAdjustedPrices(db, [{ type_id: 34, adjusted_price: 5, average_price: 5 }], "2026-06-21T00:00:00.000Z");
  const second = persistAdjustedPrices(db, [{ type_id: 34, adjusted_price: 7.25, average_price: 8 }], "2026-06-22T00:00:00.000Z");

  assert.equal(second, 1);
  assert.deepEqual(db.prepare("SELECT adjusted_price, average_price, updated_at FROM adjusted_prices WHERE type_id=34").get(), {
    adjusted_price: 7.25,
    average_price: 8,
    updated_at: "2026-06-22T00:00:00.000Z"
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM adjusted_prices").pluck().get(), 1);

  db.close();
});
