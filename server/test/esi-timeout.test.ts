import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { createEsiClient } from "../src/lib/esi.js";

const testAppUrl = process.env.APP_URL?.trim() || "https://app.example.test";

test("ESI client aborts a hung request after the configured timeout", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const originalContactEmail = process.env.CONTACT_EMAIL;
  const originalAppUrl = process.env.APP_URL;
  let observedSignal: AbortSignal | undefined;

  process.env.CONTACT_EMAIL = "tests@example.com";
  process.env.APP_URL = testAppUrl;

  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined;
      observedSignal?.addEventListener("abort", () => reject(new Error("aborted by test signal")), { once: true });
    });

  try {
    const esi = createEsiClient(db, { fetchImpl, requestTimeoutMs: 10 });

    await assert.rejects(
      esi.getJson("/latest/status/?datasource=tranquility"),
      /ESI request timed out after 10ms/
    );
    assert.equal(observedSignal?.aborted, true);
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
