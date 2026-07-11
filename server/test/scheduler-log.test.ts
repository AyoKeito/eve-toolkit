import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import * as scheduler from "../src/jobs/scheduler.js";
import { migrate } from "../src/db.js";
import { markComputeDirty, readComputeDirty } from "../src/lib/compute-generation.js";
import { createSchedulerLogger, runLoggedJob } from "../src/jobs/scheduler-log.js";

type StartupWarmupDeps = {
  importSde(db: Database.Database): Promise<unknown>;
  fetchLpOffers(db: Database.Database): Promise<number>;
  fetchPrices(db: Database.Database, tier: "hot" | "cold"): Promise<number>;
  fetchAdjustedPrices(db: Database.Database): Promise<number>;
  fetchHistory(db: Database.Database): Promise<number>;
  recomputeAndPersist(db: Database.Database): number;
};

type RunStartupWarmup = (
  db: Database.Database,
  options: { nowMs: number; deps: StartupWarmupDeps }
) => Promise<unknown>;

type RunDebouncedCompute = (
  db: Database.Database,
  options: {
    debounceMs: number;
    lockDir: string;
    nowMs: number;
    recomputeAndPersist(db: Database.Database): number;
  }
) => Promise<number | null>;

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insertSdeReadyRows(db: Database.Database, now: string): void {
  db.prepare(`
    INSERT INTO source_imports(source, build_number, release_date, archive_url, imported_at, metadata_json)
    VALUES ('ccp-jsonl-sde', 1, '2026-05-18T00:00:00Z', 'file://fixture.zip', ?, '{}')
  `).run(now);
  db.prepare("INSERT INTO corporations(corp_id, name, has_lp_store) VALUES (1, 'Test Corp', 1)").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Test Item')").run();
}

function insertOfferReadyRows(db: Database.Database, now: string): void {
  db.prepare("INSERT INTO offers(offer_id, corp_id, lp_cost, isk_cost, fetched_at, raw_json) VALUES (1, 1, 100, 0, ?, '{}')").run(
    now
  );
  db.prepare("INSERT INTO offer_market_types(offer_id, type_id, role) VALUES (1, 10, 'PRODUCT')").run();
}

function insertPriceReadyRows(db: Database.Database, now: string, rankHot: number | null = 1): void {
  db.prepare(`
    INSERT INTO prices(type_id, sell_min, buy_max, sell_order_count, buy_order_count, rank_hot, updated_at)
    VALUES (10, 100, 90, 1, 1, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      sell_min=excluded.sell_min,
      buy_max=excluded.buy_max,
      sell_order_count=excluded.sell_order_count,
      buy_order_count=excluded.buy_order_count,
      rank_hot=excluded.rank_hot,
      updated_at=excluded.updated_at
  `).run(rankHot, now);
  db.prepare(`
    INSERT OR REPLACE INTO prices_book(type_id, side, rank, order_id, price, qty, location_id, system_id, is_jita44)
    VALUES (10, 'sell', 0, 1, 100, 10, 60003760, 30000142, 1)
  `).run();
}

function insertHistoryReadyRows(db: Database.Database, now: string): void {
  db.prepare("INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days, updated_at) VALUES (10, 100, 100, 100, 28, ?)").run(
    now
  );
}

function insertAdjustedPriceReadyRows(db: Database.Database, now: string): void {
  db.prepare("INSERT INTO adjusted_prices(type_id, adjusted_price, average_price, updated_at) VALUES (10, 100, 100, ?)").run(now);
}

function insertCalcReadyRows(db: Database.Database, now: string): void {
  db.prepare(`
    INSERT INTO calc(offer_id, corp_id, computed_at)
    VALUES (1, 1, ?)
    ON CONFLICT(offer_id) DO UPDATE SET computed_at=excluded.computed_at
  `).run(now);
}

function insertFetcherSuccess(db: Database.Database, name: string, now: string): void {
  db.prepare("INSERT INTO fetcher_status(name, last_success, last_error_at, last_error_msg) VALUES (?, ?, NULL, NULL)").run(
    name,
    now
  );
}

function insertFetcherFailure(db: Database.Database, name: string, lastSuccess: string | null, lastErrorAt: string): void {
  db.prepare("INSERT INTO fetcher_status(name, last_success, last_error_at, last_error_msg) VALUES (?, ?, ?, 'ESI 504')").run(
    name,
    lastSuccess,
    lastErrorAt
  );
}

type RunFetcherCatchUp = (
  db: Database.Database,
  options: {
    deps: {
      fetchLpOffers(db: Database.Database): Promise<number>;
      fetchHistory(db: Database.Database): Promise<number>;
      fetchKillmails?(db: Database.Database): Promise<unknown>;
      fetchContracts?(db: Database.Database): Promise<unknown>;
    };
  }
) => Promise<string[]>;

function runFetcherCatchUpExport(): RunFetcherCatchUp {
  const maybeRunFetcherCatchUp = (scheduler as { runFetcherCatchUp?: RunFetcherCatchUp }).runFetcherCatchUp;
  if (typeof maybeRunFetcherCatchUp !== "function") {
    assert.fail("runFetcherCatchUp export is missing");
  }
  return maybeRunFetcherCatchUp;
}

function runStartupWarmupExport(): RunStartupWarmup {
  const maybeRunStartupWarmup = (scheduler as { runStartupWarmup?: RunStartupWarmup }).runStartupWarmup;
  if (typeof maybeRunStartupWarmup !== "function") {
    assert.fail("runStartupWarmup export is missing");
  }
  return maybeRunStartupWarmup;
}

function runDebouncedComputeExport(): RunDebouncedCompute {
  const maybeRunDebouncedCompute = (scheduler as { runDebouncedCompute?: RunDebouncedCompute }).runDebouncedCompute;
  if (typeof maybeRunDebouncedCompute !== "function") {
    assert.fail("runDebouncedCompute export is missing");
  }
  return maybeRunDebouncedCompute;
}

test("runLoggedJob writes start and success events to scheduler log", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-scheduler-log-"));
  const logger = createSchedulerLogger({ logDir: tempDir, echo: false });

  await runLoggedJob(logger, "prices-hot", async () => undefined);

  const lines = fs.readFileSync(path.join(tempDir, "scheduler.log"), "utf8").trim().split("\n");
  const events = lines.map((line) => JSON.parse(line) as { job: string; event: string; duration_ms?: number });

  assert.deepEqual(
    events.map((event) => ({ job: event.job, event: event.event })),
    [
      { job: "prices-hot", event: "start" },
      { job: "prices-hot", event: "success" }
    ]
  );
  assert.equal(typeof events[1]?.duration_ms, "number");
});

test("runLoggedJob writes failure events and rethrows", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-scheduler-log-"));
  const logger = createSchedulerLogger({ logDir: tempDir, echo: false });

  await assert.rejects(
    runLoggedJob(logger, "prices-cold", async () => {
      throw new Error("ESI unavailable");
    }),
    /ESI unavailable/
  );

  const lines = fs.readFileSync(path.join(tempDir, "scheduler.log"), "utf8").trim().split("\n");
  const failure = JSON.parse(lines[1] ?? "{}") as { job: string; event: string; error: string };

  assert.deepEqual(
    { job: failure.job, event: failure.event, error: failure.error },
    { job: "prices-cold", event: "failure", error: "ESI unavailable" }
  );
});

test("safeCron logs and swallows job failures while clearing in-flight tracking", async () => {
  const events: Array<Record<string, unknown>> = [];
  const inFlight = new Set<Promise<void>>();
  const maybeSafeCron = (scheduler as {
    safeCron?: (
      logger: { write(entry: Record<string, unknown>): void },
      inFlight: Set<Promise<void>>,
      job: string,
      action: () => Promise<unknown>
    ) => () => Promise<void>;
  }).safeCron;

  if (typeof maybeSafeCron !== "function") {
    assert.fail("safeCron export is missing");
  }
  const safeCron = maybeSafeCron;

  const handler = safeCron(
    {
      write(entry: Record<string, unknown>) {
        events.push(entry);
      }
    },
    inFlight,
    "prices-hot",
    async () => {
      throw new Error("boom");
    }
  ) as () => Promise<void>;

  await assert.doesNotReject(handler);
  assert.equal(inFlight.size, 0);
  assert.equal(events.at(-1)?.event, "failure");
});

test("safeCron skips locked refresh jobs instead of running concurrent writers", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(tempDir, "refresh.lock");
  const events: Array<Record<string, unknown>> = [];
  const inFlight = new Set<Promise<void>>();
  const refreshLock = await import("../src/lib/refresh-lock.js");
  const heldLock = await refreshLock.acquireRefreshLock({ job: "manual:fetch-history", lockDir });
  let ran = false;

  try {
    const handler = scheduler.safeCron(
      {
        write(entry: Record<string, unknown>) {
          events.push(entry);
        }
      },
      inFlight,
      "esi-prices-hot",
      async () => {
        ran = true;
      },
      { lock: { lockDir } }
    ) as () => Promise<void>;

    await assert.doesNotReject(handler);

    assert.equal(ran, false);
    assert.equal(inFlight.size, 0);
    assert.equal(events.at(-1)?.event, "skip");
    assert.equal(events.at(-1)?.reason, "refresh_lock_busy");
    assert.equal((events.at(-1)?.lock_owner as { job?: string } | undefined)?.job, "manual:fetch-history");
  } finally {
    heldLock.release();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vacuumDatabase runs SQLite VACUUM through the scheduler helper", () => {
  const calls: string[] = [];
  const maybeVacuumDatabase = (scheduler as { vacuumDatabase?: unknown }).vacuumDatabase;

  if (typeof maybeVacuumDatabase !== "function") {
    assert.fail("vacuumDatabase export is missing");
  }

  const vacuumDatabase = maybeVacuumDatabase as (db: { prepare(sql: string): { run(): unknown } }) => void;
  vacuumDatabase({
    prepare(sql: string) {
      calls.push(sql);
      return {
        run() {
          calls.push("run");
        }
      };
    }
  });

  assert.deepEqual(calls, ["VACUUM", "run"]);
});

test("startup warmup bootstraps empty leaderboard data in dependency order", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  const now = "2026-05-18T12:00:00.000Z";
  const deps: StartupWarmupDeps = {
    async importSde(target) {
      calls.push("import-sde");
      insertSdeReadyRows(target, now);
      return {};
    },
    async fetchLpOffers(target) {
      calls.push("esi-lp");
      insertOfferReadyRows(target, now);
      return 1;
    },
    async fetchPrices(target, tier) {
      calls.push(`esi-prices-${tier}`);
      insertPriceReadyRows(target, now, tier === "hot" ? 1 : null);
      return 1;
    },
    async fetchAdjustedPrices(target) {
      calls.push("esi-adjusted-prices");
      insertAdjustedPriceReadyRows(target, now);
      return 1;
    },
    async fetchHistory(target) {
      calls.push("esi-history");
      insertHistoryReadyRows(target, now);
      return 1;
    },
    recomputeAndPersist(target) {
      calls.push("compute");
      insertCalcReadyRows(target, now);
      target.prepare("UPDATE prices SET rank_hot=1 WHERE type_id=10").run();
      return 1;
    }
  };

  try {
    await runStartupWarmupExport()(db, { nowMs: Date.parse(now), deps });

    assert.deepEqual(calls, [
      "import-sde",
      "esi-lp",
      "esi-prices-cold",
      "esi-adjusted-prices",
      "esi-history",
      "compute",
      "esi-prices-hot",
      "compute"
    ]);
  } finally {
    db.close();
  }
});

test("startup warmup skips when leaderboard data and fetchers are current", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  const now = "2026-05-18T12:00:00.000Z";
  insertSdeReadyRows(db, now);
  insertOfferReadyRows(db, now);
  insertPriceReadyRows(db, now);
  insertHistoryReadyRows(db, now);
  insertAdjustedPriceReadyRows(db, now);
  insertCalcReadyRows(db, now);
  for (const name of ["esi-lp", "esi-prices-cold", "esi-prices-hot", "esi-history", "esi-adjusted-prices"]) {
    insertFetcherSuccess(db, name, now);
  }

  const deps: StartupWarmupDeps = {
    async importSde() {
      calls.push("import-sde");
      return {};
    },
    async fetchLpOffers() {
      calls.push("esi-lp");
      return 0;
    },
    async fetchPrices(_target, tier) {
      calls.push(`esi-prices-${tier}`);
      return 0;
    },
    async fetchAdjustedPrices() {
      calls.push("esi-adjusted-prices");
      return 0;
    },
    async fetchHistory() {
      calls.push("esi-history");
      return 0;
    },
    recomputeAndPersist() {
      calls.push("compute");
      return 1;
    }
  };

  try {
    await runStartupWarmupExport()(db, { nowMs: Date.parse(now), deps });

    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

test("fetcher catch-up retries a failing daily fetcher and marks compute dirty", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  insertFetcherFailure(db, "esi-lp", "2026-06-09T11:10:00.000Z", "2026-06-10T11:10:00.000Z");
  insertFetcherSuccess(db, "esi-history", "2026-06-10T11:35:00.000Z");

  try {
    const ran = await runFetcherCatchUpExport()(db, {
      deps: {
        async fetchLpOffers() {
          calls.push("esi-lp");
          return 1;
        },
        async fetchHistory() {
          calls.push("esi-history");
          return 1;
        }
      }
    });

    assert.deepEqual(ran, ["esi-lp"]);
    assert.deepEqual(calls, ["esi-lp"]);
    assert.ok(readComputeDirty(db), "compute should be marked dirty after a catch-up fetch");
  } finally {
    db.close();
  }
});

test("fetcher catch-up retries a failing contract scan and marks compute dirty", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  insertFetcherSuccess(db, "esi-lp", "2026-06-10T11:10:00.000Z");
  insertFetcherSuccess(db, "esi-history", "2026-06-10T11:35:00.000Z");
  // Contracts now run once daily, so a failed run must be retried by catch-up, not left for 24h.
  insertFetcherFailure(db, "esi-contracts", "2026-06-09T13:00:00.000Z", "2026-06-10T13:00:00.000Z");

  try {
    const ran = await runFetcherCatchUpExport()(db, {
      deps: {
        async fetchLpOffers() {
          calls.push("esi-lp");
          return 1;
        },
        async fetchHistory() {
          calls.push("esi-history");
          return 1;
        },
        async fetchContracts() {
          calls.push("esi-contracts");
          return 1;
        }
      }
    });

    assert.deepEqual(ran, ["esi-contracts"]);
    assert.deepEqual(calls, ["esi-contracts"]);
    assert.ok(readComputeDirty(db), "compute should be marked dirty after a contract catch-up");
  } finally {
    db.close();
  }
});

test("fetcher catch-up does nothing when the daily fetchers are healthy", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  insertFetcherSuccess(db, "esi-lp", "2026-06-10T11:10:00.000Z");
  insertFetcherSuccess(db, "esi-history", "2026-06-10T11:35:00.000Z");

  try {
    const ran = await runFetcherCatchUpExport()(db, {
      deps: {
        async fetchLpOffers() {
          calls.push("esi-lp");
          return 1;
        },
        async fetchHistory() {
          calls.push("esi-history");
          return 1;
        }
      }
    });

    assert.deepEqual(ran, []);
    assert.deepEqual(calls, []);
    assert.equal(readComputeDirty(db), null);
  } finally {
    db.close();
  }
});

test("fetcher catch-up still retries history when the lp retry throws", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  insertFetcherFailure(db, "esi-lp", null, "2026-06-10T11:10:00.000Z");
  insertFetcherFailure(db, "esi-history", "2026-06-08T11:20:00.000Z", "2026-06-10T11:20:00.000Z");

  try {
    await assert.rejects(
      runFetcherCatchUpExport()(db, {
        deps: {
          async fetchLpOffers() {
            calls.push("esi-lp");
            throw new Error("ESI 504");
          },
          async fetchHistory() {
            calls.push("esi-history");
            return 1;
          }
        }
      }),
      /ESI 504/
    );

    assert.deepEqual(calls, ["esi-lp", "esi-history"]);
    assert.ok(readComputeDirty(db), "history catch-up should still mark compute dirty");
  } finally {
    db.close();
  }
});

test("startup warmup imports SDE when only non-SDE import metadata exists", async () => {
  const db = memoryDb();
  const calls: string[] = [];
  const now = "2026-05-18T12:00:00.000Z";
  db.prepare(`
    INSERT INTO source_imports(source, build_number, release_date, archive_url, imported_at, metadata_json)
    VALUES ('missions-seed', NULL, NULL, 'file://missions.json', ?, '{}')
  `).run(now);
  db.prepare("INSERT INTO corporations(corp_id, name, has_lp_store) VALUES (1, 'Test Corp', 1)").run();
  db.prepare("INSERT INTO types(type_id, name) VALUES (10, 'Test Item')").run();
  insertOfferReadyRows(db, now);
  insertPriceReadyRows(db, now);
  insertHistoryReadyRows(db, now);
  insertAdjustedPriceReadyRows(db, now);
  insertCalcReadyRows(db, now);
  for (const name of ["esi-lp", "esi-prices-cold", "esi-prices-hot", "esi-history", "esi-adjusted-prices"]) {
    insertFetcherSuccess(db, name, now);
  }

  const deps: StartupWarmupDeps = {
    async importSde() {
      calls.push("import-sde");
      return {};
    },
    async fetchLpOffers() {
      calls.push("esi-lp");
      return 0;
    },
    async fetchPrices(_target, tier) {
      calls.push(`esi-prices-${tier}`);
      return 0;
    },
    async fetchAdjustedPrices() {
      calls.push("esi-adjusted-prices");
      return 0;
    },
    async fetchHistory() {
      calls.push("esi-history");
      return 0;
    },
    recomputeAndPersist() {
      calls.push("compute");
      return 1;
    }
  };

  try {
    await runStartupWarmupExport()(db, { nowMs: Date.parse(now), deps });

    assert.deepEqual(calls, ["import-sde", "compute"]);
  } finally {
    db.close();
  }
});

test("runDebouncedCompute waits for the debounce window before computing once", async () => {
  const db = memoryDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-debounce-lock-"));
  const nowMs = Date.parse("2026-05-20T12:00:30.000Z");
  let computes = 0;
  markComputeDirty(db, "esi-lp", new Date("2026-05-20T12:00:05.000Z"));
  markComputeDirty(db, "esi-prices-hot", new Date("2026-05-20T12:00:06.000Z"));

  try {
    assert.equal(
      await runDebouncedComputeExport()(db, {
        debounceMs: 30_000,
        lockDir: path.join(tempDir, "refresh.lock"),
        nowMs,
        recomputeAndPersist() {
          computes += 1;
          return 7;
        }
      }),
      null
    );
    assert.equal(computes, 0);

    assert.equal(
      await runDebouncedComputeExport()(db, {
        debounceMs: 30_000,
        lockDir: path.join(tempDir, "refresh.lock"),
        nowMs: nowMs + 10_000,
        recomputeAndPersist() {
          computes += 1;
          return 7;
        }
      }),
      7
    );
    assert.equal(computes, 1);
    assert.equal(readComputeDirty(db), null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runDebouncedCompute does not clear dirty work marked during compute", async () => {
  const db = memoryDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-debounce-dirty-"));
  markComputeDirty(db, "esi-prices-cold", new Date("2026-05-20T12:00:00.000Z"));

  try {
    assert.equal(
      await runDebouncedComputeExport()(db, {
        debounceMs: 30_000,
        lockDir: path.join(tempDir, "refresh.lock"),
        nowMs: Date.parse("2026-05-20T12:01:00.000Z"),
        recomputeAndPersist(target) {
          markComputeDirty(target, "esi-history", new Date("2026-05-20T12:01:00.000Z"));
          return 3;
        }
      }),
      3
    );
    assert.deepEqual(readComputeDirty(db), { seq: 2, since: "2026-05-20T12:00:00.000Z" });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("safeCron uses per-job lock dirs so two different jobs do not block each other", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-per-job-lock-"));
  const inFlight = new Set<Promise<void>>();
  const logger = { write(_entry: Record<string, unknown>) {} };

  // Lock the first job's dir explicitly.
  const refreshLock = await import("../src/lib/refresh-lock.js");
  const lockDirA = path.join(tempDir, "scheduler-esi-lp.lock");
  const heldLock = await refreshLock.acquireRefreshLock({ job: "manual:hold-esi-lp", lockDir: lockDirA });
  let ranB = false;

  try {
    // Job A (esi-lp) should be skipped because its lock is held.
    let ranA = false;
    const handlerA = scheduler.safeCron(logger, inFlight, "esi-lp", async () => {
      ranA = true;
    }, { lock: { lockDir: lockDirA } }) as () => Promise<void>;
    await handlerA();
    assert.equal(ranA, false, "esi-lp should be skipped while its lock is held");

    // Job B (esi-history) must use a different lock dir and should run unblocked.
    const lockDirB = path.join(tempDir, "scheduler-esi-history.lock");
    const handlerB = scheduler.safeCron(logger, inFlight, "esi-history", async () => {
      ranB = true;
    }, { lock: { lockDir: lockDirB } }) as () => Promise<void>;
    await handlerB();
    assert.equal(ranB, true, "esi-history should run independently of esi-lp lock");
  } finally {
    heldLock.release();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
