import type { Db } from "../db.js";
import { recordFetcherFailureBestEffort, recordFetcherSuccess } from "../db.js";
import { bumpSnapshotDataVersion } from "./compute-generation.js";
import { cleanupExpiredEsiCache } from "./esi.js";

/**
 * Standard try/cleanup/record shell shared by ESI fetchers.
 *
 * Runs `work`, then on success calls cleanupExpiredEsiCache + recordFetcherSuccess.
 * On failure calls recordFetcherFailureBestEffort and re-throws.
 *
 * Every ESI fetcher writes a snapshot-mirrored table, so bump the snapshot version
 * on success — synchronously, after work() has committed — so the in-process market
 * snapshot is invalidated regardless of caller (scheduler, startup warmup, or CLI).
 * Without this, warmup's hot-price fetch and any write CLI would leave the live /lp
 * path serving a stale snapshot until the next markComputeDirty.
 */
export async function runFetcher<T>(db: Db, name: string, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    cleanupExpiredEsiCache(db);
    recordFetcherSuccess(db, name);
    bumpSnapshotDataVersion(db);
    return result;
  } catch (error) {
    recordFetcherFailureBestEffort(db, name, error);
    throw error;
  }
}
