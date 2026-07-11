import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../src/db.js";
import { recordFetcherFailureBestEffort } from "../src/db.js";

test("best-effort fetcher failure recording does not mask the original fetch failure", () => {
  const db = {
    prepare() {
      throw new Error("database is locked");
    }
  } as unknown as Db;

  assert.doesNotThrow(() => {
    recordFetcherFailureBestEffort(db, "esi-prices-cold", new Error("ESI 504 Gateway Timeout"));
  });
});
