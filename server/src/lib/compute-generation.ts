import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { prepareCached } from "./prepare-cache.js";

// Bumped 4 -> 5 when the materialized/cached sort ordering was unified (roi best
// basis, volume): changing this invalidates every stored response_cache body and
// client ETag, so a deploy immediately stops serving the old-ordering bodies even
// before the next recompute re-materializes them.
const responsePayloadVersion = 5;

export interface ComputeDirtyMarker {
  seq: number;
  since: string;
}

export function currentComputeGeneration(db: Db): number {
  return readKvNumber(db, "compute_generation");
}

/** Monotonic counter bumped whenever a write touches snapshot-mirrored market/offer
 * data. The in-memory MarketSnapshot keys its validity token on this, so it rebuilds
 * exactly when that data changes — not on every unrelated write to the connection.
 * Never reset (unlike the dirty seq), so a snapshot built during recompute stays valid
 * for the post-recompute serving path. */
export function snapshotDataVersion(db: Db): number {
  return readKvNumber(db, "snapshot_data_version");
}

/** Invalidate the market snapshot: bump the version so the next getMarketSnapshot
 * rebuilds. MUST be called by every path that writes a snapshot-mirrored table
 * (prices, prices_book, history, adjusted_prices, contract_prices, blueprints, types,
 * offers/offer_products/offer_required_items, corporations). markComputeDirty calls
 * this for the scheduler path; runFetcher and importSde call it directly so the
 * warmup and CLI paths (which bypass markComputeDirty) invalidate the snapshot too. */
export function bumpSnapshotDataVersion(db: Db): void {
  writeKv(db, "snapshot_data_version", String(readKvNumber(db, "snapshot_data_version") + 1));
}

export function computeGenerationEtag(generation: number): string {
  return `W/"gen-${Math.max(0, Math.trunc(generation))}-v${responsePayloadVersion}"`;
}

/**
 * Client-facing ETag that fingerprints the actual served body, not just the compute
 * generation. `signature` must include everything that varies the body for a given
 * generation — the normalized response-cache key (query shape: n/sortBy/basis/filters)
 * plus post-hoc rewrite params like lpPerHour. A generation-only ETag collides across
 * those, so a client replaying an If-None-Match across different query params could get
 * a wrong-body 304. Weak validator (revalidation only). The stored response_cache etag
 * stays computeGenerationEtag — that is an internal row-vs-generation consistency check,
 * distinct from this per-request client ETag.
 */
export function responseEtag(generation: number, signature: string): string {
  const hash = createHash("sha1").update(signature).digest("hex").slice(0, 16);
  return `W/"gen-${Math.max(0, Math.trunc(generation))}-v${responsePayloadVersion}-${hash}"`;
}

export function bumpComputeGeneration(db: Db): number {
  const next = readKvNumber(db, "compute_generation") + 1;
  writeKv(db, "compute_generation", String(next));
  return next;
}

export function readKvNumber(db: Db, key: string): number {
  const row = prepareCached(db, "SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
  const value = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function readKvString(db: Db, key: string): string | null {
  const row = prepareCached(db, "SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Upsert a single kv row. The one place the `INSERT … ON CONFLICT DO UPDATE`
 * kv-write is spelled; callers outside this module (e.g. cloudflare-purge) import it. */
export function writeKv(db: Db, key: string, value: string): void {
  prepareCached(db, `
    INSERT INTO kv(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

export function markComputeDirty(db: Db, reason: string, now = new Date()): ComputeDirtyMarker {
  const previousSeq = readKvNumber(db, "compute_dirty_seq");
  const previousSince = readKvString(db, "compute_dirty_since");
  const since =
    previousSeq > 0 && previousSince && Number.isFinite(Date.parse(previousSince))
      ? previousSince
      : now.toISOString();
  const seq = previousSeq + 1;

  const tx = db.transaction(() => {
    writeKv(db, "compute_dirty_seq", String(seq));
    writeKv(db, "compute_dirty_since", since);
    writeKv(db, "compute_dirty_reason", reason);
    // The scheduler pairs every ingest with markComputeDirty, so invalidate the
    // snapshot here too. (runFetcher/importSde also bump directly, covering the
    // warmup and CLI paths that do not reach markComputeDirty — a double bump on the
    // scheduler path is harmless since only version equality matters.)
    bumpSnapshotDataVersion(db);
  });
  tx();

  return { seq, since };
}

export function readComputeDirty(db: Db): ComputeDirtyMarker | null {
  const seq = readKvNumber(db, "compute_dirty_seq");
  if (seq <= 0) return null;
  const since = readKvString(db, "compute_dirty_since");
  if (!since || !Number.isFinite(Date.parse(since))) return null;
  return { seq, since };
}

export function clearComputeDirtyIfUnchanged(db: Db, observedSeq: number): boolean {
  const tx = db.transaction(() => {
    const current = readComputeDirty(db);
    if (!current || current.seq !== observedSeq) return false;
    db.prepare("DELETE FROM kv WHERE key IN ('compute_dirty_seq', 'compute_dirty_since', 'compute_dirty_reason')").run();
    return true;
  });
  return tx();
}
