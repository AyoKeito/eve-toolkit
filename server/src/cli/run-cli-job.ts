import { openDb, type Db } from "../db.js";
import { withRefreshLock } from "../lib/refresh-lock.js";

export interface RunCliJobOptions {
  /** Override the database path (e.g. from loadConfig().dbPath). Defaults to openDb() default. */
  dbPath?: string;
  /**
   * Hook invoked after withRefreshLock resolves but before the result is printed.
   * Used by compute.ts for waitForPendingCloudflarePurge().
   */
  postLock?: () => Promise<void>;
}

/**
 * Standard CLI entry-point shell shared by write-path CLI tools.
 *
 * Opens the database, runs `fn` inside withRefreshLock({ job: `manual:${jobSuffix}`,
 * waitMs: 60_000 }), prints JSON.stringify(result, null, 2), then closes the db.
 *
 * Job names are preserved exactly: pass the full suffix including any dynamic parts
 * (e.g. `fetch-prices:${tier}`).
 */
export async function runCliJob<T>(
  jobSuffix: string,
  fn: (db: Db) => Promise<T>,
  opts: RunCliJobOptions = {}
): Promise<void> {
  const db = openDb(opts.dbPath);
  try {
    const result = await withRefreshLock({ job: `manual:${jobSuffix}`, waitMs: 60_000 }, () => fn(db));
    if (opts.postLock) await opts.postLock();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}
