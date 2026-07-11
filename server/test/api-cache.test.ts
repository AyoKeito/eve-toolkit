import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import fastifyEtag from "@fastify/etag";
import { migrate } from "../src/db.js";
import { registerHealthRoutes } from "../src/api/health.js";
import { registerOfferRoutes } from "../src/api/offers.js";
import { registerCorpRoutes } from "../src/api/corp.js";
import {
  bumpComputeGeneration,
  clearComputeDirtyIfUnchanged,
  computeGenerationEtag,
  currentComputeGeneration,
  markComputeDirty,
  readComputeDirty
} from "../src/lib/compute-generation.js";
import { applyLpPerHour, materializeCanonicalResponses, readMaterializedResponse, responseCacheKey } from "../src/lib/response-materialize.js";
import { ResponseCache } from "../src/lib/response-cache.js";

test("cacheable read endpoints advertise browser and CDN caching aligned to compute cadence", async () => {
  const db = new Database(":memory:");
  migrate(db);
  bumpComputeGeneration(db);
  const app = Fastify();
  await app.register(fastifyEtag);
  await registerOfferRoutes(app, db);
  await registerCorpRoutes(app, db);

  const responses = await Promise.all([
    app.inject("/api/offers/top?n=1"),
    app.inject("/api/offers/top.csv?n=1"),
    app.inject("/api/corps")
  ]);

  await app.close();
  db.close();

  for (const response of responses) {
    assert.equal(response.headers["cache-control"], "public, max-age=60, stale-while-revalidate=1800");
    assert.equal(response.headers["cdn-cache-control"], "public, s-maxage=900, stale-while-revalidate=1800");
    assert.equal(response.headers.vary, "Accept-Encoding");
    // Offers etags fingerprint the body (gen + query-shape hash); /api/corps stays
    // generation-only. Both carry the generation-tagged weak validator.
    assert.match(response.headers.etag as string, /^W\/"gen-1-v\d+(-[0-9a-f]{16})?"$/);
  }
});

test("health endpoint keeps a short origin-only cache policy", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await registerHealthRoutes(app, db);

  const response = await app.inject("/api/health");

  await app.close();
  db.close();

  assert.equal(response.headers["cache-control"], "public, max-age=5, stale-while-revalidate=10");
  assert.equal(response.headers["cdn-cache-control"], undefined);
});

test("hot read endpoints support ETag conditional requests", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await app.register(fastifyEtag);
  await registerHealthRoutes(app, db);

  const first = await app.inject("/api/health");
  const etag = first.headers.etag;
  assert.equal(first.statusCode, 200);
  assert.equal(typeof etag, "string");

  const second = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { "if-none-match": etag as string }
  });
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, "");

  await app.close();
  db.close();
});

test("compute generation persists and bumps through kv storage", () => {
  const db = new Database(":memory:");
  migrate(db);

  assert.equal(currentComputeGeneration(db), 0);
  assert.equal(bumpComputeGeneration(db), 1);
  assert.equal(currentComputeGeneration(db), 1);
  assert.equal(bumpComputeGeneration(db), 2);
  assert.equal(currentComputeGeneration(db), 2);
  assert.equal(db.prepare("SELECT value FROM kv WHERE key='compute_generation'").pluck().get(), "2");

  db.close();
});

test("compute generation observes external CLI bumps without a server restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-compute-generation-"));
  const dbPath = path.join(dir, "lp.db");
  const serverDb = new Database(dbPath);
  migrate(serverDb);
  assert.equal(currentComputeGeneration(serverDb), 0);

  const computeDb = new Database(dbPath);
  migrate(computeDb);
  assert.equal(bumpComputeGeneration(computeDb), 1);
  computeDb.close();

  assert.equal(currentComputeGeneration(serverDb), 1);

  serverDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compute dirty marker increments and clears only unchanged sequences", () => {
  const db = new Database(":memory:");
  migrate(db);
  const first = markComputeDirty(db, "esi-lp", new Date("2026-05-20T10:00:00.000Z"));
  const second = markComputeDirty(db, "esi-prices-hot", new Date("2026-05-20T10:00:01.000Z"));

  assert.equal(first.seq, 1);
  assert.deepEqual(second, { seq: 2, since: "2026-05-20T10:00:00.000Z" });
  assert.deepEqual(readComputeDirty(db), { seq: 2, since: "2026-05-20T10:00:00.000Z" });
  assert.equal(clearComputeDirtyIfUnchanged(db, 1), false);
  assert.deepEqual(readComputeDirty(db), { seq: 2, since: "2026-05-20T10:00:00.000Z" });
  assert.equal(clearComputeDirtyIfUnchanged(db, 2), true);
  assert.equal(readComputeDirty(db), null);

  db.close();
});

test("response cache stores compressed bytes and deduplicates concurrent fills", async () => {
  const cache = new ResponseCache<string>({ maxEntries: 2, ttlMs: 1000 });
  let fills = 0;
  const first = cache.getOrCreate("same", async () => {
    fills += 1;
    return { body: Buffer.from("payload"), brotli: Buffer.from("br"), etag: "tag", contentType: "text/plain" };
  });
  const second = cache.getOrCreate("same", async () => {
    fills += 1;
    return { body: Buffer.from("other"), etag: "other", contentType: "text/plain" };
  });

  assert.equal((await first).body.toString(), "payload");
  assert.equal((await second).brotli?.toString(), "br");
  assert.equal(fills, 1);

  cache.clear();
  assert.equal(cache.peek("same"), undefined);
});

test("canonical offer cache key drops defaults and lpPerHour", () => {
  const explicit = responseCacheKey("/api/offers/top", {
    n: 100,
    basis: "best",
    minVolume: 0,
    hideSuspicious: true,
    hideVanity: true,
    hideNoSecurity: true,
    bpc: "none",
    maxRiskTier: "NULLSEC",
    sortBy: "iskPerLp",
    lpPerHour: 30000
  });
  const bare = responseCacheKey("/api/offers/top", {});
  const custom = responseCacheKey("/api/offers/top", {
    n: 200,
    hideSuspicious: false,
    hideVanity: false,
    hideNoSecurity: false,
    bpc: "all",
    minVolume: 100,
    maxM3: 500,
    sortBy: "patient",
    lpPerHour: 50000
  });

  assert.equal(explicit, bare);
  assert.equal(custom, "/api/offers/top bpc=all&hideNoSecurity=false&hideSuspicious=false&hideVanity=false&maxM3=500&minVolume=100&n=200&sortBy=patient");
});

test("manufacturer-mode overrides participate in the canonical cache key", () => {
  // These params force the live calc path (custom fees / facility), so they must
  // change the response cache key — otherwise an override request short-circuits to
  // the materialized default-view body and silently serves the wrong numbers.
  const bare = responseCacheKey("/api/offers/top", {});
  assert.notEqual(responseCacheKey("/api/offers/top", { noMarketFees: true }), bare);
  assert.notEqual(responseCacheKey("/api/offers/top", { facility: "null-t2" }), bare);
  assert.notEqual(responseCacheKey("/api/offers/top", { costIndex: 10 }), bare);

  // The NPC facility and an absent/false override are the defaults — they must NOT
  // perturb the key (so default-view requests still hit the materialized body).
  assert.equal(responseCacheKey("/api/offers/top", { facility: "npc", noMarketFees: false }), bare);

  // Distinct overrides yield distinct keys (no in-memory cache collision).
  assert.notEqual(
    responseCacheKey("/api/offers/top", { bpc: "manufacture" }),
    responseCacheKey("/api/offers/top", { bpc: "manufacture", noMarketFees: true, facility: "null-t2", costIndex: 10 })
  );
});

test("applyLpPerHour scales from the active valuation basis", () => {
  const body = Buffer.from(
    JSON.stringify({ rows: [{ isk_per_lp: 26447.11, isk_per_lp_instant: -12958.28, isk_per_lp_patient: 26447.11 }] })
  );

  const buy = JSON.parse(applyLpPerHour(body, 30000, "instantSell").body.toString("utf8"));
  const highest = JSON.parse(applyLpPerHour(body, 30000, "best").body.toString("utf8"));

  assert.equal(buy.rows[0].isk_per_hour, -388748400);
  assert.equal(highest.rows[0].isk_per_hour, 793413300);
});

test("applyLpPerHour leaves contract-priced rows without an hourly rate", () => {
  // A contract-priced ratio is a real one-off conversion rate, but no hourly
  // rate exists — the rewrite must not resurrect isk_per_hour for these rows.
  const body = Buffer.from(
    JSON.stringify({
      rows: [
        { isk_per_lp_patient: 96600, contract_priced: true, isk_per_hour: null },
        { isk_per_lp_patient: 1200, isk_per_hour: 36000000 }
      ]
    })
  );

  const result = JSON.parse(applyLpPerHour(body, 50000, "best").body.toString("utf8"));

  assert.equal(result.rows[0].isk_per_hour, null);
  assert.equal(result.rows[1].isk_per_hour, 60000000);
});

test("materializeCanonicalResponses writes default JSON, CSV, and corps blobs", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (1, 'Cache Corp', 'HIGHSEC', 'STANDARD')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Cache Module'), (20, 'Suspicious Module')").run();
  db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES
      (101, 1, 1000, 0, 'now', '{}'),
      (102, 1, 1000, 0, 'now', '{}')
  `).run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (101, 10, 1), (102, 20, 1)").run();
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, is_suspicious, computed_at
    )
    VALUES
      (101, 1, 'Cache Module', 1200, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 0, 'now'),
      (102, 1, 'Suspicious Module', 1600, 1100, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 200, 1, 1, 'now')
  `).run();

  const keys = materializeCanonicalResponses(db, generation);
  const rows = db.prepare("SELECT cache_key, generation, content_type, body, body_brotli, etag FROM response_cache ORDER BY cache_key").all() as Array<{
    cache_key: string;
    generation: number;
    content_type: string;
    body: Buffer;
    body_brotli: Buffer | null;
    etag: string;
  }>;

  assert.ok(keys.includes("/api/offers/top "));
  assert.ok(keys.includes("/api/offers/top n=200"));
  assert.ok(keys.includes("/api/offers/top.csv "));
  assert.ok(keys.includes("/api/corps "));
  assert.ok(rows.every((row) => row.generation === generation));
  assert.ok(rows.every((row) => row.etag === computeGenerationEtag(1)));
  assert.ok(rows.every((row) => row.body.length > 0));
  assert.ok(rows.every((row) => row.body_brotli && row.body_brotli.length > 0));
  const defaultBody = rows.find((row) => row.cache_key === "/api/offers/top ")?.body.toString("utf8") ?? "";
  assert.match(defaultBody, /Cache Module/);
  assert.doesNotMatch(defaultBody, /Suspicious Module/);

  db.close();
});

test("materializeCanonicalResponses bakes the manufacturer-mode preset, blueprints only", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare(
    "INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier, has_l4_l5_security_agent) VALUES (1, 'Build Corp', 'HIGHSEC', 'STANDARD', 1)"
  ).run();
  db.prepare("INSERT INTO types(type_id, name, category_id, category_name) VALUES (200, 'Faction BP', 9, 'Blueprint'), (300, 'Spiky BP', 9, 'Blueprint')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (201, 'Built Module'), (301, 'Spiky Module'), (100, 'Plain Module')").run();
  db.prepare(`
    INSERT INTO bp_manufacture(blueprint_type_id, product_type_id, runs, materials_json)
    VALUES (200, 201, 1, '[]'), (300, 301, 1, '[]')
  `).run();
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (201, 5000, 4000, 5, 5, 1), (301, 5000, 4000, 5, 5, 1), (100, 1000, 900, 5, 5, 1)
  `).run();
  // Built Module trades healthily (clean row); Spiky Module's sell is >2x its 28d median
  // → PRICE_SPIKE (strong) → suspicious, so the suspicious build row must be excluded too.
  db.prepare(`
    INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days, updated_at)
    VALUES (201, 1000, 5000, 5200, 28, 'now'), (301, 1000, 1000, 5200, 28, 'now')
  `).run();
  // Offer 2 = clean buildable blueprint; offer 1 = plain direct item (hidden — not buildable);
  // offer 3 = suspicious buildable blueprint (hidden — hideSuspicious default).
  db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES (1, 1, 1000, 0, 'now', '{}'), (2, 1, 1000, 0, 'now', '{}'), (3, 1, 1000, 0, 'now', '{}')
  `).run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 100, 1), (2, 200, 1), (3, 300, 1)").run();
  // The manufacturer materialization restricts the candidate scan to manufacture rows
  // via has_manufactured_bpc, so the blueprint offers carry the flag and the plain one does not.
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, has_manufactured_bpc, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, computed_at
    )
    VALUES
      (1, 1, 'Plain Module', 0, 1000, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now'),
      (2, 1, 'Faction BP (manufacture)', 1, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now'),
      (3, 1, 'Spiky BP (manufacture)', 1, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now')
  `).run();

  const keys = materializeCanonicalResponses(db, generation);
  const manufacturerKey = "/api/offers/top bpc=manufacture&facility=null-t2&noMarketFees=true";
  assert.ok(keys.includes(manufacturerKey), "manufacturer preset key missing");
  assert.ok(keys.includes("/api/offers/top bpc=manufacture&facility=null-t2&n=200&noMarketFees=true"));
  assert.ok(keys.includes("/api/offers/top bpc=manufacture&facility=null-t2&n=500&noMarketFees=true"));

  const body = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get(manufacturerKey) as Buffer;
  const payload = JSON.parse(body.toString("utf8")) as {
    rows: Array<{ offer_name: string; isk_per_lp: number; isk_per_hour: number | null; contract_priced: boolean }>;
  };
  // Blueprints only AND not suspicious: only the clean built blueprint survives — the
  // plain direct item (not buildable) and the spiky build row (suspicious) are both gone.
  assert.equal(payload.rows.length, 1);
  assert.match(payload.rows[0].offer_name, /Faction BP .*manufacture/);
  assert.ok(!payload.rows.some((row) => /Spiky/.test(row.offer_name)), "suspicious build row leaked");
  // lpPerHour is baked at the canonical 30000 rate (matching the live route), so the
  // ISK/hr column is populated rather than null for this non-contract row.
  assert.equal(payload.rows[0].contract_priced, false);
  assert.ok((payload.rows[0].isk_per_hour ?? 0) > 0, "manufacturer row served a null/zero isk_per_hour");
  assert.equal(payload.rows[0].isk_per_hour, payload.rows[0].isk_per_lp * 30000);

  db.close();
});

test("materializeCanonicalResponses logs build, compression, and database timings", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  const originalLog = console.log;
  const entries: unknown[] = [];
  console.log = (message?: unknown) => {
    if (typeof message === "string" && message.includes('"component":"response_materialize"')) {
      entries.push(JSON.parse(message));
    }
  };

  try {
    materializeCanonicalResponses(db, generation);
  } finally {
    console.log = originalLog;
    db.close();
  }

  const entry = entries[0] as
    | { component?: string; keys?: number; build_ms?: number; compress_ms?: number; db_ms?: number; duration_ms?: number }
    | undefined;
  assert.equal(entry?.component, "response_materialize");
  assert.equal(typeof entry?.keys, "number");
  assert.equal(typeof entry?.build_ms, "number");
  assert.equal(typeof entry?.compress_ms, "number");
  assert.equal(typeof entry?.db_ms, "number");
  assert.equal(typeof entry?.duration_ms, "number");
});

test("materializeCanonicalResponses uses current calc flags over stale embedded summaries", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (1, 'Cache Corp', 'HIGHSEC', 'STANDARD')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Cache Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (101, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (101, 10, 1)").run();
  const staleSummary = JSON.stringify({
    offer_id: 101,
    offer_name: "Cache Module",
    flags: [{ code: "PRICE_SPIKE", severity: "strong", message: "stale embedded summary" }]
  });
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, flags_json, api_summary_json,
      isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, is_suspicious, computed_at
    )
    VALUES (101, 1, 'Cache Module', '[]', ?, 1200, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 0, 'now')
  `).run(staleSummary);

  materializeCanonicalResponses(db, generation);
  const defaultBody = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get("/api/offers/top ") as Buffer;
  const payload = JSON.parse(defaultBody.toString("utf8")) as { rows: Array<{ flags: unknown[] }> };
  assert.deepEqual(payload.rows[0]?.flags, []);

  db.close();
});

test("materializeCanonicalResponses writes hot sort variants for default filters", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (1, 'Sort Corp', 'HIGHSEC', 'STANDARD')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Instant Module'), (20, 'Volume Module')").run();
  db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES
      (101, 1, 1000, 100, 'now', '{}'),
      (102, 1, 500, 5000, 'now', '{}')
  `).run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (101, 10, 1), (102, 20, 1)").run();
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, computed_at
    )
    VALUES
      (101, 1, 'Instant Module', 2000, 800, 0, 0, 0, 0, 0, 0, 0, 1.2, 0, NULL, 100, 1, 'now'),
      (102, 1, 'Volume Module', 1000, 700, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, NULL, 2000, 1, 'now')
  `).run();

  materializeCanonicalResponses(db, generation);
  const keys = db.prepare("SELECT cache_key FROM response_cache ORDER BY cache_key").pluck().all() as string[];
  for (const sortBy of ["instant", "patient", "lp", "isk", "roi", "iskPerHour", "volume"]) {
    assert.ok(keys.includes(`/api/offers/top sortBy=${sortBy}`), sortBy);
  }
  for (const sortBy of ["instant", "patient", "volume"]) {
    assert.ok(keys.includes(`/api/offers/top n=200&sortBy=${sortBy}`), sortBy);
    assert.ok(keys.includes(`/api/offers/top n=500&sortBy=${sortBy}`), sortBy);
  }
  assert.ok(!keys.includes("/api/offers/top sortBy=rank"));

  const defaultBody = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get("/api/offers/top ") as Buffer;
  const volumeBody = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get("/api/offers/top sortBy=volume") as Buffer;
  const defaultRows = JSON.parse(defaultBody.toString("utf8")) as { rows: Array<{ offer_name: string }> };
  const volumeRows = JSON.parse(volumeBody.toString("utf8")) as { rows: Array<{ offer_name: string }> };
  assert.equal(defaultRows.rows[0].offer_name, "Instant Module");
  assert.equal(volumeRows.rows[0].offer_name, "Volume Module");

  db.close();
});

test("offers route serves pre-rendered response_cache blobs with generation 304 support", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  const etag = computeGenerationEtag(generation);
  const body = Buffer.from(JSON.stringify({ rows: [{ offer_id: 42, isk_per_hour: 36_000_000 }] }));
  db.prepare(`
    INSERT INTO response_cache(cache_key, generation, content_type, body, body_brotli, etag, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'now')
  `).run("/api/offers/top ", generation, "application/json; charset=utf-8", body, Buffer.from("brotli-body"), etag);

  const app = Fastify();
  await registerOfferRoutes(app, db);

  const hit = await app.inject("/api/offers/top?n=100&minVolume=0&hideVanity=true&lpPerHour=30000");
  const brotliHit = await app.inject({
    url: "/api/offers/top?n=100&lpPerHour=30000",
    headers: { "accept-encoding": "br" }
  });
  // The client ETag now fingerprints the body, not just the generation; the default
  // (lpPerHour 30000) and absent-lpPerHour requests share it. Revalidate with it.
  const clientEtag = hit.headers.etag as string;
  const notModified = await app.inject({ url: "/api/offers/top", headers: { "if-none-match": clientEtag } });

  await app.close();
  db.close();

  assert.equal(hit.statusCode, 200);
  assert.match(clientEtag, /^W\/"gen-1-v\d+-[0-9a-f]{16}"$/);
  assert.notEqual(clientEtag, etag, "client etag is body-fingerprinted, not the stored generation etag");
  assert.deepEqual(JSON.parse(hit.body), { rows: [{ offer_id: 42, isk_per_hour: 36_000_000 }] });
  assert.equal(brotliHit.headers["content-encoding"], "br");
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.body, "");
});

test("ETag distinguishes lpPerHour variants so a replayed If-None-Match cannot 304 the wrong body", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  const stored = computeGenerationEtag(generation);
  const body = Buffer.from(JSON.stringify({ rows: [{ offer_id: 42, isk_per_lp_instant: 1000, isk_per_hour: 30_000_000 }] }));
  db.prepare(`
    INSERT INTO response_cache(cache_key, generation, content_type, body, body_brotli, etag, computed_at)
    VALUES ('/api/offers/top ', ?, 'application/json; charset=utf-8', ?, ?, ?, 'now')
  `).run(generation, body, Buffer.from("br"), stored);

  const app = Fastify();
  await registerOfferRoutes(app, db);

  const def = await app.inject("/api/offers/top?lpPerHour=30000");
  const doubled = await app.inject("/api/offers/top?lpPerHour=60000");
  // Replay the default request's ETag against the 60000 request — must NOT 304 onto
  // the (differently-rewritten) body; it must serve 200 with the correct etag.
  const crossReplay = await app.inject({ url: "/api/offers/top?lpPerHour=60000", headers: { "if-none-match": def.headers.etag as string } });

  await app.close();
  db.close();

  assert.notEqual(def.headers.etag, doubled.headers.etag, "different lpPerHour must yield different etags");
  assert.equal(crossReplay.statusCode, 200, "an etag from a different lpPerHour must not produce a 304");
  assert.equal(crossReplay.headers.etag, doubled.headers.etag);
});

test("materialized response_cache ignores blobs from older response schemas", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare(`
    INSERT INTO response_cache(cache_key, generation, content_type, body, body_brotli, etag, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'now')
  `).run(
    "/api/offers/top ",
    generation,
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify({ rows: [{ avg_daily_volume_30d: 10 }] })),
    null,
    'W/"gen-1"'
  );

  assert.equal(readMaterializedResponse(db, "/api/offers/top "), null);

  db.close();
});

test("materialized response_cache ignores same-generation blobs from prior payload versions", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare(`
    INSERT INTO response_cache(cache_key, generation, content_type, body, body_brotli, etag, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'now')
  `).run(
    "/api/offers/top ",
    generation,
    "application/json; charset=utf-8",
    Buffer.from(JSON.stringify({ rows: [{ corp_name: "Outer Ring Excavations" }] })),
    null,
    'W/"gen-1-v2"'
  );

  assert.equal(readMaterializedResponse(db, "/api/offers/top "), null);

  db.close();
});

test("server gates proxy trust and host binding behind environment variables", () => {
  const indexTs = fs.readFileSync(path.resolve("server/src/index.ts"), "utf8");
  // The TRUST_PROXY/HOST env reads live in config.ts (RuntimeConfig); index.ts wires them
  // through `config.trustProxy` / `config.host`.
  const configTs = fs.readFileSync(path.resolve("server/src/config.ts"), "utf8");
  assert.match(configTs, /trustProxy:\s*process\.env\.TRUST_PROXY\s*===\s*"1"/);
  assert.match(configTs, /host:\s*process\.env\.HOST\s*\?\?\s*"0\.0\.0\.0"/);
  assert.match(indexTs, /trustProxy:\s*config\.trustProxy/);
  assert.match(indexTs, /host:\s*config\.host/);
  assert.match(indexTs, /@fastify\/etag/);
  assert.match(indexTs, /app\.get\("\/"/);
  assert.match(indexTs, /sendLandingPage\(reply\)/);
  assert.match(indexTs, /app\.get\("\/about"/);
  assert.match(indexTs, /reply\.redirect\("\/lp\/about\.html"/);
  assert.match(indexTs, /prefix:\s*"\/lp\/"/);
  assert.match(indexTs, /prefix:\s*"\/lp"/);
  assert.match(indexTs, /process\.on\("unhandledRejection"/);
  assert.match(indexTs, /process\.on\("uncaughtException"/);
});

test("offer detail cache key includes lpPerHour so different rates get distinct entries", async () => {
  const db = new Database(":memory:");
  migrate(db);
  bumpComputeGeneration(db);
  const app = Fastify();
  await registerOfferRoutes(app, db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (1, 'Detail Corp', 'HIGHSEC', 'STANDARD')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Detail Module')").run();
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 1000, 0, 'now', '{}')").run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (1, 10, 1)").run();
  // Price + depth so the offer has positive profit; isk_per_hour then scales with lpPerHour.
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, sell_min_at_jita_44)
    VALUES (10, 1200000, 1000000, 1, 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (10, 'sell', 0, 12345, 1200000, 5, 60003760, 30000142, 1)
  `).run();
  db.prepare(`
    INSERT INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (10, 'buy', 0, 12346, 1000000, 5, 60003760, 30000142, 1)
  `).run();
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, computed_at
    )
    VALUES (1, 1, 'Detail Module', 1200, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now')
  `).run();

  const r30k = await app.inject("/api/offers/1?lpPerHour=30000");
  const r60k = await app.inject("/api/offers/1?lpPerHour=60000");

  await app.close();
  db.close();

  const body30k = r30k.json() as Record<string, unknown>;
  const body60k = r60k.json() as Record<string, unknown>;
  assert.equal(r30k.statusCode, 200);
  assert.equal(r60k.statusCode, 200);
  // isk_per_hour at 60k should be double that at 30k
  assert.ok(
    typeof body30k.isk_per_hour === "number" &&
      typeof body60k.isk_per_hour === "number" &&
      Math.abs((body60k.isk_per_hour as number) / (body30k.isk_per_hour as number) - 2) < 0.001,
    `expected 60k isk_per_hour to be double 30k; got ${body30k.isk_per_hour} vs ${body60k.isk_per_hour}`
  );
});

test("materialized CSV uses iskPerLp sort order matching the default JSON view", () => {
  const db = new Database(":memory:");
  migrate(db);
  const generation = bumpComputeGeneration(db);
  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier, lp_source_tier) VALUES (1, 'Sort Corp', 'HIGHSEC', 'STANDARD')").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'High ISK Module'), (20, 'High Instant Module')").run();
  db.prepare(`
    INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json)
    VALUES
      (101, 1, 1000, 0, 'now', '{}'),
      (102, 1, 1000, 0, 'now', '{}')
  `).run();
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (101, 10, 1), (102, 20, 1)").run();
  // offer 101: best=2000 (patient wins), instant=500
  // offer 102: best=1800 (instant wins), instant=1800
  // iskPerLp sort → 101 first (best=2000); instant sort → 102 first (instant=1800)
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost,
      net_profit_instant, net_profit_patient, capital_required, roi_instant,
      roi_patient, days_of_supply, avg_daily_volume_28d, cargo_m3, computed_at
    )
    VALUES
      (101, 1, 'High ISK Module', 500, 2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now'),
      (102, 1, 'High Instant Module', 1800, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 50, 1, 'now')
  `).run();

  materializeCanonicalResponses(db, generation);

  const defaultBody = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get("/api/offers/top ") as Buffer;
  const csvBody = db.prepare("SELECT body FROM response_cache WHERE cache_key=?").pluck().get("/api/offers/top.csv ") as Buffer;
  const defaultRows = JSON.parse(defaultBody.toString("utf8")) as { rows: Array<{ offer_name: string }> };
  const csvLines = csvBody.toString("utf8").split("\n");
  const csvFirstDataRow = csvLines[1] ?? "";

  // Both default JSON and CSV should lead with the highest iskPerLp offer
  assert.equal(defaultRows.rows[0].offer_name, "High ISK Module");
  assert.ok(csvFirstDataRow.includes("High ISK Module"), `expected CSV first row to be 'High ISK Module', got: ${csvFirstDataRow}`);

  db.close();
});

test("CSV export prefixes spreadsheet formula cells", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const app = Fastify();
  await registerOfferRoutes(app, db);

  db.prepare("INSERT INTO corporations(corp_id, name, risk_tier) VALUES (?, ?, ?)").run(1, "=Formula Corp", "HIGHSEC");
  db.prepare("INSERT INTO types(type_id, name) VALUES (?, ?)").run(100, "+Formula Module");
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    1,
    1,
    1000,
    0,
    "now",
    "{}"
  );
  db.prepare("INSERT INTO offer_products(offer_id, type_id, quantity) VALUES (?, ?, ?)").run(1, 100, 1);
  db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, isk_per_lp_instant, isk_per_lp_patient, product_value_instant,
      product_value_patient, input_cost, build_cost, net_profit_instant, net_profit_patient,
      capital_required, roi_instant, roi_patient, days_of_supply, cargo_m3, computed_at
    )
    VALUES (1, 1, 1000, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 'cached')
  `).run();

  const response = await app.inject("/api/offers/top.csv?minVolume=0&jita44Only=false&hideSuspicious=false&includeFW=true");
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /,"'=Formula Corp",/);
  assert.match(response.body, /,"'\+Formula Module",/);

  await app.close();
  db.close();
});
