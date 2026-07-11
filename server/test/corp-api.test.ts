import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { registerCorpRoutes } from "../src/api/corp.js";

test("corp autocomplete endpoint returns sorted earnable corporation options", async () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier, has_lp_store) VALUES (?, ?, ?, ?, 1)").run(
    2,
    "Beta Freight",
    "LOWSEC",
    "STANDARD"
  );
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier, has_lp_store) VALUES (?, ?, ?, ?, 1)").run(
    1,
    "Alpha Freight",
    "HIGHSEC",
    "SPECIAL"
  );
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier, has_lp_store, has_earnable_lp_source) VALUES (?, ?, ?, ?, 1, ?)").run(
    3,
    "Frostline Laboratories",
    "NULLSEC",
    "STANDARD",
    0
  );

  const app = Fastify();
  await registerCorpRoutes(app, db);
  const response = await app.inject("/api/corps");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).rows, [
    { corp_id: 1, name: "Alpha Freight", risk_tier: "HIGHSEC", access_risk_tier: "HIGHSEC", lp_source_tier: "SPECIAL" },
    { corp_id: 2, name: "Beta Freight", risk_tier: "LOWSEC", access_risk_tier: "LOWSEC", lp_source_tier: "STANDARD" }
  ]);

  await app.close();
  db.close();
});
