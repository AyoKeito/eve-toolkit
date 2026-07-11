import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { registerRefreshRoutes, tokenMatches } from "../src/api/refresh.js";
import { migrate } from "../src/db.js";

test("tokenMatches accepts only exact string admin tokens", () => {
  assert.equal(tokenMatches("correct-token", "correct-token"), true);
  assert.equal(tokenMatches("wrongct-token", "correct-token"), false);
  assert.equal(tokenMatches(["correct-token"], "correct-token"), false);
  assert.equal(tokenMatches(undefined, "correct-token"), false);
});

test("refresh route rejects missing and same-length wrong admin tokens", async () => {
  const originalAdminToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "correct-token";
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await registerRefreshRoutes(app, db);

  try {
    const missing = await app.inject({ method: "POST", url: "/api/refresh" });
    assert.equal(missing.statusCode, 401);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { "x-admin-token": "wrongct-token" }
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
    db.close();
    if (originalAdminToken === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = originalAdminToken;
    }
  }
});
