import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { migrate } from "../src/db.js";
import { computeTrending, registerFitRoutes } from "../src/api/fits.js";
import { bumpSnapshotDataVersion } from "../src/lib/compute-generation.js";

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
const OLD = "2020-01-01T00:00:00Z";

function seed(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");

  const type = db.prepare(
    "INSERT INTO types(type_id, name, group_id, group_name, category_id, volume, packaged_volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // Assembled volume in BOTH columns mimics the SDE import bug; the group-class map (Destroyer
  // group 420 => 5,000 m³ packaged) must override it for correct hauling volume.
  type.run(100, "Corax", 420, "Destroyer", 6, 55_000, 55_000);
  type.run(101, "Tristan", 25, "Frigate", 6, 27_000, 2_500);
  type.run(200, "Capsule", 29, "Capsule", 6, 1_000, 1_000); // excluded group
  type.run(300, "Cheap Module", 7, "Module A", 7, 5, 5);
  type.run(301, "Pricey Module", 7, "Module B", 7, 10, 10);
  type.run(302, "Other Module", 7, "Module C", 7, 20, 20);

  const price = db.prepare("INSERT INTO prices(type_id, sell_min, updated_at) VALUES (?, ?, ?)");
  price.run(100, 1_000_000, RECENT); // hull: live Jita sell
  price.run(300, 1_000, RECENT); // module: live
  price.run(302, 2_000, RECENT);
  // 301 has no live sell — only an ESI estimate:
  db.prepare("INSERT INTO adjusted_prices(type_id, average_price, updated_at) VALUES (?, ?, ?)").run(301, 500_000, RECENT);

  db.prepare("INSERT INTO regions(region_id, name) VALUES (?, ?)").run(100, "Black Rise");
  const sys = db.prepare(
    "INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  sys.run(10, "Tama", 0.3, "LOWSEC", 100, 1);
  sys.run(11, "Nennamaila", 0.4, "LOWSEC", 100, 1);
  sys.run(12, "Kedama", 0.2, "LOWSEC", 100, 1);
  sys.run(20, "Old System", 0.3, "LOWSEC", 100, 1);
  sys.run(30, "Pod System", 0.3, "LOWSEC", 100, 1);

  const fit = db.prepare(
    "INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  fit.run("A", 100, JSON.stringify([{ type_id: 300, qty: 2 }, { type_id: 301, qty: 1 }]), 3, 5, RECENT, RECENT);
  fit.run("B", 101, JSON.stringify([{ type_id: 302, qty: 4 }]), 4, 2, RECENT, RECENT);
  fit.run("P", 200, JSON.stringify([]), 0, 9, RECENT, RECENT); // capsule, excluded
  fit.run("N", 100, JSON.stringify([]), 0, 9, RECENT, RECENT); // naked hull, excluded by module_count

  const km = db.prepare(
    "INSERT INTO killmails(killmail_id, killmail_time, fit_hash, victim_character_id, solar_system_id, region_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let id = 1;
  const aVictims = [1, 1, 2, 3, 4]; // 4 distinct pilots (pilot 1 lost it twice)
  const aSystems = [10, 10, 11, 11, 12]; // systems 10×2, 11×2, 12×1
  for (let i = 0; i < 5; i++) km.run(id++, RECENT, "A", aVictims[i], aSystems[i], 100, RECENT);
  const bVictims = [5, 6];
  for (let i = 0; i < 2; i++) km.run(id++, OLD, "B", bVictims[i], 20, 100, RECENT); // B's losses are OLD
  for (let i = 0; i < 9; i++) km.run(id++, RECENT, "P", 7, 30, 100, RECENT);
  return db;
}

test("ranks sellable combat fits by windowed losses, excluding pods/shuttles/naked hulls", () => {
  const db = seed();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const hashes = res.fits.map((f) => f.fit_hash);
  assert.deepEqual(hashes, ["A", "B"], "only combat fits with >=3 modules, ranked by losses");
  assert.equal(res.fits[0].losses, 5);
  assert.equal(res.fits[0].rank, 1);
  assert.ok(!hashes.includes("P"), "capsule excluded");
  assert.ok(!hashes.includes("N"), "naked hull excluded");
  db.close();
});

test("values a fit at live Jita sell, falling back to ESI estimate, and reports priced share", () => {
  const db = seed();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const a = res.fits.find((f) => f.fit_hash === "A")!;
  // hull 1,000,000 (live) + 300:2x1,000 (live) + 301:1x500,000 (est) = 1,502,000
  assert.equal(a.build_cost, 1_502_000);
  assert.equal(a.hull_source, "jita");
  // priced (live) share = (1,000,000 + 2,000) / 1,502,000 ≈ 0.67
  assert.equal(a.value_priced_share, 0.67);
  // shopping list ordered most-expensive line first; 301 is the est-priced big line
  assert.equal(a.modules[0].type_id, 301);
  assert.equal(a.modules[0].source, "est");
  assert.equal(a.modules[1].source, "jita");
  db.close();
});

test("aggregates distinct pilots/systems and components volume + ISK/m³", () => {
  const db = seed();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const a = res.fits.find((f) => f.fit_hash === "A")!;
  assert.equal(a.pilots, 4, "5 losses, pilot 1 repeats => 4 distinct pilots");
  assert.equal(a.systems, 3);
  // group-class packaged hull 5,000 (NOT the bugged 55,000) + module 300 (vol 5 ×2=10) +
  // module 301 (vol 10 ×1=10) = 5,020 m³
  assert.equal(a.volume_m3, 5_020);
  assert.equal(a.isk_per_m3, Math.round(1_502_000 / 5_020)); // 299
  db.close();
});

test("top_systems pinpoints where a fit dies, ranked, with region names", () => {
  const db = seed();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const a = res.fits.find((f) => f.fit_hash === "A")!;
  assert.equal(a.top_systems.length, 3); // systems 10, 11, 12
  assert.equal(a.top_systems[0].count, 2); // top system has 2 losses
  assert.equal(a.top_systems[0].region, "Black Rise");
  assert.deepEqual(
    a.top_systems.map((s) => s.name).sort(),
    ["Kedama", "Nennamaila", "Tama"]
  );
  db.close();
});

test("min_losses filters via HAVING; class filter scopes to a ship group", () => {
  const db = seed();
  const strict = computeTrending(db, { windowDays: null, limit: 60, minLosses: 3, shipClass: null });
  assert.deepEqual(strict.fits.map((f) => f.fit_hash), ["A"], "B has only 2 losses");

  const frig = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: "Frigate" });
  assert.deepEqual(frig.fits.map((f) => f.fit_hash), ["B"]);
  db.close();
});

test("window filter drops fits whose losses fall outside the recent window", () => {
  const db = seed();
  const windowed = computeTrending(db, { windowDays: 1, limit: 60, minLosses: 1, shipClass: null });
  // B's two losses are in 2020 (outside a 1-day window) so it drops out; A stays.
  assert.deepEqual(windowed.fits.map((f) => f.fit_hash), ["A"]);
  db.close();
});

// A single fit whose losses are spread across a 10-day span (2026-06-01 .. 2026-06-11), so the
// midpoint splits at 2026-06-06: 2 losses before it, 6 on/after it. Lets us assert momentum
// (recent vs prior), the per-day rate, and span clamping precisely.
function seedTimeline(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  const type = db.prepare(
    "INSERT INTO types(type_id, name, group_id, group_name, category_id, volume, packaged_volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  type.run(100, "Corax", 420, "Destroyer", 6, 55_000, 55_000);
  type.run(300, "Mod A", 7, "Module A", 7, 5, 5);
  type.run(301, "Mod B", 7, "Module B", 7, 10, 10);
  db.prepare("INSERT INTO regions(region_id, name) VALUES (?, ?)").run(100, "Black Rise");
  db.prepare(
    "INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(10, "Tama", 0.3, "LOWSEC", 100, 1);
  db.prepare(
    "INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("M", 100, JSON.stringify([{ type_id: 300, qty: 2 }, { type_id: 301, qty: 1 }]), 3, 8, "2026-06-01", "2026-06-11");
  const km = db.prepare(
    "INSERT INTO killmails(killmail_id, killmail_time, fit_hash, victim_character_id, solar_system_id, region_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // prior half (< 2026-06-06): 2 losses; recent half (>= 2026-06-06): 6 losses.
  const days = ["01", "02", "06", "07", "08", "09", "10", "11"];
  days.forEach((d, i) => km.run(i + 1, `2026-06-${d}T00:00:00.000Z`, "M", i + 1, 10, 100, "2026-06-12"));
  return db;
}

test("momentum splits the covered window at its midpoint and reports the per-day rate", () => {
  const db = seedTimeline();
  const all = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const m = all.fits[0];
  assert.equal(all.window_span_days, 10, "2026-06-01 .. 2026-06-11 is a 10-day span");
  assert.equal(m.losses, 8);
  assert.equal(m.recent_losses, 6, "6 losses on/after the 2026-06-06 midpoint");
  assert.equal(m.prior_losses, 2, "2 losses before it");
  assert.equal(m.trend, "rising");
  assert.equal(m.momentum_pct, 2, "(6 - 2) / 2 = +200%");
  assert.equal(m.losses_per_day, 0.8, "8 losses / 10 days");
  db.close();
});

test("a window narrower than the data clamps the span and re-centers the momentum split", () => {
  const db = seedTimeline();
  // 4-day window off the 2026-06-11 anchor => cutoff 2026-06-07, midpoint 2026-06-09.
  const win = computeTrending(db, { windowDays: 4, limit: 60, minLosses: 1, shipClass: null });
  const m = win.fits[0];
  assert.equal(win.window_span_days, 4);
  assert.equal(m.losses, 5, "losses on/after 2026-06-07: the 07/08/09/10/11 kills");
  assert.equal(m.recent_losses, 3, "09/10/11 are on/after the 2026-06-09 midpoint");
  assert.equal(m.prior_losses, 2, "07/08 fall before it");
  assert.equal(m.trend, "rising");
  assert.equal(m.losses_per_day, 1.3, "5 losses / 4 days, rounded");
  db.close();
});

test("a fit with no losses in the prior half reports momentum as new (null pct)", () => {
  const db = seed();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const a = res.fits.find((f) => f.fit_hash === "A")!;
  // A's 5 losses sit at one recent instant while the data spans back to 2020, so the midpoint
  // lands years earlier — every A loss falls in the recent half, none in the prior.
  assert.equal(a.prior_losses, 0);
  assert.equal(a.recent_losses, 5);
  assert.equal(a.momentum_pct, null, "no prior baseline to divide by");
  assert.equal(a.trend, "rising");
  db.close();
});

// Demand breadth: a fit whose losses are mostly one corp is a self-supplied fleet doctrine, not
// open-market demand. We report distinct corps + the dominant corp's share so the board can sink
// doctrines. DOC = 10 losses, 8 from one corp; BROAD = 6 losses across 6 corps.
function seedCorps(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  const type = db.prepare(
    "INSERT INTO types(type_id, name, group_id, group_name, category_id, volume, packaged_volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  type.run(100, "Corax", 420, "Destroyer", 6, 55_000, 55_000);
  type.run(101, "Tristan", 25, "Frigate", 6, 27_000, 2_500);
  type.run(300, "Mod A", 7, "Module A", 7, 5, 5);
  db.prepare("INSERT INTO regions(region_id, name) VALUES (?, ?)").run(100, "Black Rise");
  db.prepare(
    "INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(10, "Tama", 0.3, "LOWSEC", 100, 1);
  const fit = db.prepare(
    "INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  fit.run("DOC", 100, JSON.stringify([{ type_id: 300, qty: 3 }]), 3, 10, RECENT, RECENT);
  fit.run("BROAD", 101, JSON.stringify([{ type_id: 300, qty: 3 }]), 3, 6, RECENT, RECENT);
  const km = db.prepare(
    "INSERT INTO killmails(killmail_id, killmail_time, fit_hash, victim_character_id, victim_corporation_id, solar_system_id, region_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let id = 1;
  const docCorps = [500, 500, 500, 500, 500, 500, 500, 500, 501, 501]; // 8x corp 500, 2x corp 501
  docCorps.forEach((c, i) => km.run(id++, RECENT, "DOC", 1000 + i, c, 10, 100, RECENT));
  for (let c = 600; c < 606; c++) km.run(id++, RECENT, "BROAD", 2000 + c, c, 10, 100, RECENT); // 6 distinct corps
  return db;
}

test("reports demand breadth: distinct corps and the dominant-corp doctrine share", () => {
  const db = seedCorps();
  const res = computeTrending(db, { windowDays: null, limit: 60, minLosses: 1, shipClass: null });
  const doc = res.fits.find((f) => f.fit_hash === "DOC")!;
  const broad = res.fits.find((f) => f.fit_hash === "BROAD")!;
  assert.equal(doc.corps, 2, "DOC lost by 2 distinct corps");
  assert.equal(doc.top_corp_share, 0.8, "8 of 10 losses from a single corp => doctrine");
  assert.equal(broad.corps, 6, "BROAD lost by 6 distinct corps");
  assert.equal(broad.top_corp_share, 0.17, "1 of 6 from the top corp, rounded to 2dp");
  // Open-market re-ranking: BROAD (6 open) should outrank DOC (10 losses but ~2 open) by open demand,
  // even though DOC has more raw losses — that's the whole point of the signal.
  const openDemand = (f: { losses: number; top_corp_share: number }) =>
    Math.round(f.losses * (1 - f.top_corp_share));
  assert.ok(openDemand(broad) > openDemand(doc), "broad fit wins on open-market demand");
  db.close();
});

test("fits/trending response is cached in-process and rebuilt only when the data version changes", async () => {
  const db = seed();
  const app = Fastify();
  await registerFitRoutes(app, db);

  const firstBody = (await app.inject("/api/fits/trending")).body;

  // A new qualifying fit (priced hull + module, recent losses) WITHOUT bumping the data
  // version must NOT appear yet — the cached body is served until an ingest bumps the version.
  db.prepare(
    "INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen) VALUES ('C', 100, ?, 3, 5, ?, ?)"
  ).run(JSON.stringify([{ type_id: 300, qty: 3 }]), RECENT, RECENT);
  const km = db.prepare(
    "INSERT INTO killmails(killmail_id, killmail_time, fit_hash, victim_character_id, solar_system_id, region_id, ingested_at) VALUES (?, ?, 'C', ?, 10, 100, ?)"
  );
  for (let i = 0; i < 5; i++) km.run(2000 + i, RECENT, 50 + i, RECENT);

  const staleBody = (await app.inject("/api/fits/trending")).body;
  assert.equal(staleBody, firstBody, "served from cache until the data version rotates");

  // Simulate an ingest (killmails/prices/contracts all bump this via runFetcher).
  bumpSnapshotDataVersion(db);
  const freshBody = (await app.inject("/api/fits/trending")).body;
  assert.notEqual(freshBody, firstBody, "a data-version bump rebuilds the cached body");

  await app.close();
  db.close();
});

test("fits/trending supports ETag 304 revalidation and brotli negotiation", async () => {
  const db = seed();
  const app = Fastify();
  await registerFitRoutes(app, db);

  const hit = await app.inject("/api/fits/trending");
  assert.equal(hit.statusCode, 200);
  const etag = hit.headers.etag as string;
  assert.match(etag, /^W\/"gen-0-v\d+-[0-9a-f]{16}"$/);

  const revalidated = await app.inject({ url: "/api/fits/trending", headers: { "if-none-match": etag } });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, "");

  const brotli = await app.inject({ url: "/api/fits/trending", headers: { "accept-encoding": "br" } });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(brotli.headers.etag, etag, "same body → same etag across encodings");

  await app.close();
  db.close();
});
