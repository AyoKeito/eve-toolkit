import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { fetchLpOffers } from "../src/fetchers/esi-lp.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

test("fetchLpOffers rebuilds indexed market dependencies for persisted offers", async () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, has_lp_store) VALUES (1, 'Test Navy', 'HIGHSEC', 1)").run();
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, has_lp_store, has_earnable_lp_source) VALUES (2, 'Frostline Laboratories', 'NULLSEC', 1, 0)"
  ).run();
  db.prepare("INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity) VALUES (100, 101, 1)").run();
  db.prepare("INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity) VALUES (100, 300, 7)").run();

  const originalFetch = globalThis.fetch;
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  const requestedUrls: string[] = [];
  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify([
        {
          offer_id: 7,
          type_id: 100,
          quantity: 2,
          lp_cost: 1000,
          isk_cost: 0,
          required_items: [{ type_id: 200, quantity: 1 }]
        }
      ]),
      {
        status: 200,
        headers: { expires: new Date(Date.now() + 60_000).toUTCString() }
      }
    );
  };

  try {
    assert.equal(await fetchLpOffers(db), 1);
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /\/loyalty\/stores\/1\/offers\//);
    const rows = db
      .prepare("SELECT type_id, role FROM offer_market_types WHERE offer_id=? ORDER BY role, type_id")
      .all(1_000_007);

    assert.deepEqual(rows, [
      { type_id: 300, role: "BUILD_MATERIAL" },
      { type_id: 101, role: "BUILD_PRODUCT" },
      { type_id: 100, role: "PRODUCT" },
      { type_id: 200, role: "REQUIRED_ITEM" }
    ]);
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
