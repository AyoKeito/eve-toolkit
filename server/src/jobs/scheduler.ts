import path from "node:path";
import cron from "node-cron";
import { computeDebounceMs, dataDir, loadConfig } from "../config.js";
import { countRows, type Db } from "../db.js";
import { recomputeAndPersist } from "../calc/ratio.js";
import { fetchAdjustedPrices } from "../fetchers/esi-adjusted-prices.js";
import { fetchContracts } from "../fetchers/esi-contracts.js";
import { fetchHistory } from "../fetchers/esi-history.js";
import { fetchKillmails } from "../fetchers/killmails.js";
import { fetchLpOffers } from "../fetchers/esi-lp.js";
import { fetchPrices } from "../fetchers/esi-prices.js";
import { clearComputeDirtyIfUnchanged, markComputeDirty, readComputeDirty } from "../lib/compute-generation.js";
import { tryAcquireRefreshLock, type RefreshLockOwner } from "../lib/refresh-lock.js";
import { importSde, refreshSde } from "../fetchers/sde.js";
import { purgeMissionsAgentsEdge } from "../lib/cloudflare-purge.js";
import { createSchedulerLogger, runLoggedJob, type SchedulerLogger } from "./scheduler-log.js";
import { runSnapshot } from "./snapshot.js";

interface ScheduledTask {
  stop(): void;
  destroy?(): void;
}

interface SchedulerHandle {
  stop(): void;
  waitForIdle(): Promise<void>;
}

interface SafeCronOptions {
  lock?: {
    lockDir?: string;
  };
}

type PriceTier = "hot" | "cold";

interface StartupWarmupDeps {
  importSde(db: Db): Promise<unknown>;
  fetchLpOffers(db: Db): Promise<number>;
  fetchPrices(db: Db, tier: PriceTier): Promise<number>;
  fetchAdjustedPrices(db: Db): Promise<number>;
  fetchHistory(db: Db): Promise<number>;
  recomputeAndPersist(db: Db): number;
}

interface StartupWarmupOptions {
  deps?: StartupWarmupDeps;
  nowMs?: number;
}

interface StartupWarmupResult {
  ran: string[];
  recomputedRows: number | null;
}

interface DebouncedComputeOptions {
  debounceMs?: number;
  lockDir?: string;
  nowMs?: number;
  recomputeAndPersist?: (db: Db) => number;
}

interface FetchJob {
  cron: string;
  job: string;
  run: (db: Db) => Promise<unknown>;
  markDirty: boolean;
}

const fetcherFreshnessMs = {
  "esi-lp": 48 * 60 * 60 * 1000,
  "esi-prices-hot": 30 * 60 * 1000,
  "esi-prices-cold": 2 * 60 * 60 * 1000,
  // CCP recalculates adjusted prices roughly daily; a 48h window tolerates one
  // missed run before health/warmup treats the job-cost basis as stale.
  "esi-adjusted-prices": 48 * 60 * 60 * 1000,
  "esi-history": 48 * 60 * 60 * 1000
} as const;

const defaultStartupWarmupDeps: StartupWarmupDeps = {
  importSde,
  fetchLpOffers,
  fetchPrices,
  fetchAdjustedPrices,
  fetchHistory,
  recomputeAndPersist
};

function hasRankedHotTypes(db: Db): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM prices WHERE rank_hot IS NOT NULL").get() as { count: number };
  return row.count > 0;
}

function hasSdeImport(db: Db): boolean {
  const row = db.prepare("SELECT 1 FROM source_imports WHERE source='ccp-jsonl-sde'").get();
  return row !== undefined;
}

function fetcherNeedsWarmup(db: Db, name: keyof typeof fetcherFreshnessMs, nowMs: number): boolean {
  const row = db.prepare("SELECT last_success FROM fetcher_status WHERE name=?").get(name) as
    | { last_success: string | null }
    | undefined;
  if (!row?.last_success) return true;
  const lastSuccessMs = Date.parse(row.last_success);
  return !Number.isFinite(lastSuccessMs) || nowMs - lastSuccessMs > fetcherFreshnessMs[name];
}

// A fetcher is failing when its most recent attempt errored (error newer than the
// last success). Used by the hourly catch-up so a transient ESI outage during the
// once-a-day fetch window doesn't cost a full extra day of staleness.
function fetcherIsFailing(db: Db, name: string): boolean {
  const row = db.prepare("SELECT last_success, last_error_at FROM fetcher_status WHERE name=?").get(name) as
    | { last_success: string | null; last_error_at: string | null }
    | undefined;
  if (!row?.last_error_at) return false;
  if (!row.last_success) return true;
  return Date.parse(row.last_error_at) > Date.parse(row.last_success);
}

type FetcherCatchUpDeps = Pick<StartupWarmupDeps, "fetchLpOffers" | "fetchHistory"> & {
  // Optional so existing callers/tests that only inject lp/history still type-check;
  // the killmails/contracts branches fall back to the real fetcher.
  fetchKillmails?: (db: Db) => Promise<unknown>;
  fetchContracts?: (db: Db) => Promise<unknown>;
};

// Retry the daily fetchers between their scheduled runs while they are failing.
// Hot/cold prices retry on their own 15m/1h cadence and are deliberately excluded.
const defaultFetcherCatchUpDeps: FetcherCatchUpDeps = {
  fetchLpOffers,
  fetchHistory,
  fetchKillmails,
  fetchContracts
};

export async function runFetcherCatchUp(db: Db, options: { deps?: FetcherCatchUpDeps } = {}): Promise<string[]> {
  const deps = options.deps ?? defaultFetcherCatchUpDeps;
  const ran: string[] = [];
  const errors: unknown[] = [];

  if (fetcherIsFailing(db, "esi-lp")) {
    try {
      await deps.fetchLpOffers(db);
      markComputeDirty(db, "esi-lp");
      ran.push("esi-lp");
    } catch (error) {
      errors.push(error);
    }
  }

  if (fetcherIsFailing(db, "esi-history")) {
    try {
      await deps.fetchHistory(db);
      markComputeDirty(db, "esi-history");
      ran.push("esi-history");
    } catch (error) {
      errors.push(error);
    }
  }

  // Killmails are independent of offer economics (no markComputeDirty). Retry only
  // on a recorded download/parse failure; a not-yet-published archive 404s without
  // erroring, so it is simply picked up by the next daily run.
  if (fetcherIsFailing(db, "killmails")) {
    try {
      await (deps.fetchKillmails ?? fetchKillmails)(db);
      ran.push("killmails");
    } catch (error) {
      errors.push(error);
    }
  }

  // Contracts run once daily now, so a failed run would otherwise sit stale for ~24h (both the
  // BPC price rollup and the /fits/ saturation data). Retry on a recorded failure, like killmails.
  if (fetcherIsFailing(db, "esi-contracts")) {
    try {
      await (deps.fetchContracts ?? fetchContracts)(db);
      markComputeDirty(db, "esi-contracts");
      ran.push("esi-contracts");
    } catch (error) {
      errors.push(error);
    }
  }

  // Surface the first failure so the scheduler log records the job as failed
  // (the fetchers have already recorded their own per-fetcher failure state).
  if (errors.length > 0) throw errors[0];
  return ran;
}

interface WarmupStep {
  name: keyof typeof fetcherFreshnessMs;
  table: string;
  run: () => Promise<unknown>;
  // Overrides the default "presence table empty || fetcher stale" check (prices guards two tables).
  needs?: () => boolean;
}

export async function runStartupWarmup(db: Db, options: StartupWarmupOptions = {}): Promise<StartupWarmupResult> {
  const deps = options.deps ?? defaultStartupWarmupDeps;
  const nowMs = options.nowMs ?? Date.now();
  const ran: string[] = [];
  let recomputeNeeded = countRows(db, "calc") === 0;
  let recomputedRows: number | null = null;

  if (!hasSdeImport(db) || countRows(db, "corporations") === 0 || countRows(db, "types") === 0) {
    await deps.importSde(db);
    ran.push("import-sde");
    recomputeNeeded = true;
  }

  const warmupSteps: WarmupStep[] = [
    { name: "esi-lp", table: "offers", run: () => deps.fetchLpOffers(db) },
    {
      name: "esi-prices-cold",
      table: "prices",
      run: () => deps.fetchPrices(db, "cold"),
      needs: () =>
        countRows(db, "prices") === 0 ||
        countRows(db, "prices_book") === 0 ||
        fetcherNeedsWarmup(db, "esi-prices-cold", nowMs)
    },
    { name: "esi-adjusted-prices", table: "adjusted_prices", run: () => deps.fetchAdjustedPrices(db) },
    { name: "esi-history", table: "history", run: () => deps.fetchHistory(db) }
  ];

  for (const step of warmupSteps) {
    const needs = step.needs ?? (() => countRows(db, step.table) === 0 || fetcherNeedsWarmup(db, step.name, nowMs));
    if (needs()) {
      await step.run();
      ran.push(step.name);
      recomputeNeeded = true;
    }
  }

  if (recomputeNeeded) {
    recomputedRows = deps.recomputeAndPersist(db);
    ran.push("compute");
  }

  if (hasRankedHotTypes(db) && fetcherNeedsWarmup(db, "esi-prices-hot", nowMs)) {
    await deps.fetchPrices(db, "hot");
    ran.push("esi-prices-hot");
    recomputedRows = deps.recomputeAndPersist(db);
    ran.push("compute");
  }

  return { ran, recomputedRows };
}

export function safeCron(
  logger: SchedulerLogger,
  inFlight: Set<Promise<void>>,
  job: string,
  action: () => Promise<unknown> | unknown,
  options: SafeCronOptions = {}
): () => Promise<void> {
  return async () => {
    let run: Promise<void>;
    run = runScheduledJob(logger, job, action, options)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(run);
      });
    inFlight.add(run);
    await run;
  };
}

function perJobLockDir(job: string, explicitLockDir?: string): string {
  // If the caller provided an explicit path, honour it; otherwise derive a
  // per-job lock directory under dataDir so concurrent jobs never block each
  // other on a single shared lock.
  return explicitLockDir ?? path.join(dataDir, `scheduler-${job.replace(/[^a-z0-9_-]/gi, "_")}.lock`);
}

async function runScheduledJob(
  logger: SchedulerLogger,
  job: string,
  action: () => Promise<unknown> | unknown,
  options: SafeCronOptions
): Promise<unknown> {
  if (!options.lock) return runLoggedJob(logger, job, action);

  const lockDir = perJobLockDir(job, options.lock.lockDir);
  const result = await tryAcquireRefreshLock({ job: `scheduler:${job}`, lockDir });
  if (!result.acquired) {
    logger.write({
      component: "scheduler",
      job,
      event: "skip",
      reason: "refresh_lock_busy",
      lock_owner: publicLockOwner(result.owner)
    });
    return undefined;
  }

  try {
    return await runLoggedJob(logger, job, action);
  } finally {
    result.lock.release();
  }
}

function publicLockOwner(owner: RefreshLockOwner | null): Omit<RefreshLockOwner, "token"> | null {
  if (!owner) return null;
  const { token: _token, ...publicOwner } = owner;
  return publicOwner;
}

export async function runDebouncedCompute(db: Db, options: DebouncedComputeOptions = {}): Promise<number | null> {
  const debounce = options.debounceMs ?? computeDebounceMs();
  const nowMs = options.nowMs ?? Date.now();
  const dirty = readComputeDirty(db);
  if (!dirty) return null;
  const dirtySinceMs = Date.parse(dirty.since);
  if (!Number.isFinite(dirtySinceMs) || nowMs - dirtySinceMs < debounce) return null;

  const result = await tryAcquireRefreshLock({
    job: "scheduler:compute-debounced",
    lockDir: options.lockDir ?? perJobLockDir("compute-debounced")
  });
  if (!result.acquired) return null;

  try {
    const observed = readComputeDirty(db);
    if (!observed) return null;
    const observedSinceMs = Date.parse(observed.since);
    if (!Number.isFinite(observedSinceMs) || nowMs - observedSinceMs < debounce) return null;
    const count = (options.recomputeAndPersist ?? recomputeAndPersist)(db);
    clearComputeDirtyIfUnchanged(db, observed.seq);
    return count;
  } finally {
    result.lock.release();
  }
}

export function vacuumDatabase(db: Pick<Db, "prepare">): void {
  db.prepare("VACUUM").run();
}

// The recurring ESI/killmail fetch crons. Each fetch marks the compute generation dirty on success
// so the debounced recompute picks up the new data (reason === job name in every case) — except
// killmails, an independent dataset that does not feed offer economics (markDirty: false).
const fetchJobs: FetchJob[] = [
  { cron: "10 11 * * *", job: "esi-lp", run: (db) => fetchLpOffers(db), markDirty: true },
  { cron: "*/15 * * * *", job: "esi-prices-hot", run: (db) => fetchPrices(db, "hot"), markDirty: true },
  { cron: "7 * * * *", job: "esi-prices-cold", run: (db) => fetchPrices(db, "cold"), markDirty: true },
  { cron: "20 11 * * *", job: "esi-history", run: (db) => fetchHistory(db), markDirty: true },
  { cron: "22 11 * * *", job: "esi-adjusted-prices", run: (db) => fetchAdjustedPrices(db), markDirty: true },
  // Once daily at 13:00 UTC, after the 12:30 killmail ingest: this one job feeds BOTH the BPC/
  // contract-only price rollup AND the /fits/ competition signal. Faction-BPC supply churns on a
  // days timescale (30-day price-freshness window) and the saturation data only pairs with daily
  // killmail demand, so sub-daily scanning bought nothing. A failed run is retried within the hour
  // by fetcher-catch-up (below). Not in startup warmup: the first run sweeps items for every active
  // item_exchange contract, kicked off via `npm run fetch-contracts`.
  { cron: "0 13 * * *", job: "esi-contracts", run: (db) => fetchContracts(db), markDirty: true },
  // Daily lowsec-FW killmail ingestion. 12:30 UTC pulls "yesterday", whose EVE-Ref
  // archive is finalized well before then. Independent dataset — no markComputeDirty.
  { cron: "30 12 * * *", job: "killmails", run: (db) => fetchKillmails(db), markDirty: false }
];

export function startScheduler(db: Db, dbPath: string): SchedulerHandle {
  const tasks: ScheduledTask[] = [];
  const logger = createSchedulerLogger();
  const inFlight = new Set<Promise<void>>();

  for (const { cron: expr, job, run, markDirty } of fetchJobs) {
    tasks.push(cron.schedule(expr, safeCron(logger, inFlight, job, async () => {
      await run(db);
      if (markDirty) markComputeDirty(db, job);
    }, { lock: {} })));
  }

  tasks.push(cron.schedule("*/2 * * * *", safeCron(logger, inFlight, "compute-debounced", () => runDebouncedCompute(db))));

  tasks.push(cron.schedule("25 * * * *", safeCron(logger, inFlight, "fetcher-catch-up", () => runFetcherCatchUp(db), { lock: {} })));

  // CCP publishes a new JSONL SDE most weekdays after downtime (~11:00 UTC), landing by ~11:25.
  // Pull at 11:35 UTC and re-import only when the build actually changed — a cheap HEAD gates the
  // ~100MB download. On import, mark the compute generation dirty so the debounced recompute picks
  // up new types/blueprints/corp data, and purge the missions/agents edge (best-effort) so SDE-driven
  // agent/mission changes go live without waiting on the 24h backstop TTL. A missed/failed run is
  // caught by the next day's run (the HEAD gate imports as soon as it next succeeds).
  tasks.push(cron.schedule("35 11 * * *", safeCron(logger, inFlight, "sde-refresh", async () => {
    const result = await refreshSde(db);
    if (result.imported) {
      markComputeDirty(db, "sde-refresh");
      await purgeMissionsAgentsEdge(db, loadConfig().appUrl).catch(() => undefined);
    }
    return result;
  }, { lock: {} })));

  tasks.push(cron.schedule("45 11 * * *", safeCron(logger, inFlight, "snapshot", () => {
    runSnapshot(db, dbPath);
  }, { lock: {} })));

  tasks.push(cron.schedule("0 3 1 * *", safeCron(logger, inFlight, "vacuum", () => {
    vacuumDatabase(db);
  }, { lock: {} })));

  void safeCron(logger, inFlight, "startup-warmup", () => runStartupWarmup(db), { lock: {} })();

  return {
    stop() {
      for (const task of tasks) {
        task.stop();
        task.destroy?.();
      }
    },
    async waitForIdle() {
      await Promise.allSettled([...inFlight]);
    }
  };
}
