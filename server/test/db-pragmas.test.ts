import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDb, openDb } from "../src/db.js";

test("openDb applies read-heavy SQLite performance pragmas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-db-"));
  const dbPath = path.join(dir, "lp.db");
  const db = openDb(dbPath);

  try {
    assert.equal(db.pragma("synchronous", { simple: true }), 1);
    assert.equal(db.pragma("temp_store", { simple: true }), 2);
    assert.equal(Number(db.pragma("cache_size", { simple: true })), -262_144);
    assert.ok(Number(db.pragma("mmap_size", { simple: true })) >= 1_073_741_824);
    assert.equal(Number(db.pragma("journal_size_limit", { simple: true })), 67_108_864);
    assert.equal(Number(db.pragma("busy_timeout", { simple: true })), 5000);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrations create hot-path offer calculation indexes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-db-"));
  const dbPath = path.join(dir, "lp.db");
  const db = openDb(dbPath);

  try {
    const calcIndexes = db.prepare("PRAGMA index_list(calc)").all() as Array<{ name: string }>;
    const offerMetaIndexes = db.prepare("PRAGMA index_list(offer_meta)").all() as Array<{ name: string }>;
    assert.ok(calcIndexes.some((index) => index.name === "idx_calc_corp_instant"));
    assert.ok(offerMetaIndexes.some((index) => index.name === "idx_offer_meta_offer"));
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
