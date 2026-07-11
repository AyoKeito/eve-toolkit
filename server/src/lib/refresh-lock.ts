import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../config.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { processExists, processStartTime } from "./process-check.js";
import { sleep } from "./timers.js";

const defaultStaleMs = 6 * 60 * 60 * 1000;
const defaultPollMs = 500;
const defaultHeartbeatMs = 30 * 1000;
const defaultHeartbeatStaleMs = 15 * 60 * 1000;

export interface RefreshLockOwner {
  acquired_at: string;
  heartbeat_at: string;
  hostname: string;
  job: string;
  pid: number;
  process_start_time: string | null;
  token: string;
}

export interface RefreshLockOptions {
  job: string;
  lockDir?: string;
  heartbeatMs?: number;
  heartbeatStaleMs?: number;
  pollMs?: number;
  staleMs?: number;
  waitMs?: number;
}

export interface RefreshLockHandle {
  owner: RefreshLockOwner;
  release(): void;
}

export type RefreshLockTryResult =
  | { acquired: true; lock: RefreshLockHandle; owner: RefreshLockOwner }
  | { acquired: false; owner: RefreshLockOwner | null };

export class RefreshLockBusyError extends Error {
  constructor(
    readonly job: string,
    readonly owner: RefreshLockOwner | null
  ) {
    super(owner ? `Refresh lock is held by ${owner.job} (${owner.pid})` : "Refresh lock is held by another process");
    this.name = "RefreshLockBusyError";
  }
}

function lockPath(lockDir?: string): string {
  return lockDir ?? path.join(dataDir, "refresh.lock");
}

function ownerPath(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function readOwner(lockDir: string): RefreshLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath(lockDir), "utf8")) as Partial<RefreshLockOwner>;
    if (
      typeof parsed.job === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.acquired_at === "string" &&
      typeof parsed.token === "string"
    ) {
      return {
        ...parsed,
        heartbeat_at: typeof parsed.heartbeat_at === "string" ? parsed.heartbeat_at : parsed.acquired_at,
        process_start_time:
          typeof parsed.process_start_time === "string" || parsed.process_start_time === null
            ? parsed.process_start_time
            : null
      } as RefreshLockOwner;
    }
  } catch {
    return null;
  }
  return null;
}

function ownerIsStale(owner: RefreshLockOwner | null, staleMs: number, heartbeatStaleMs: number): boolean {
  if (!owner) return true;
  const acquiredMs = Date.parse(owner.acquired_at);
  if (!Number.isFinite(acquiredMs)) return true;
  const heartbeatMs = Date.parse(owner.heartbeat_at);
  if (Number.isFinite(heartbeatMs)) {
    if (Date.now() - heartbeatMs > heartbeatStaleMs) return true;
  } else if (Date.now() - acquiredMs > staleMs) {
    return true;
  }
  if (owner.hostname !== os.hostname()) {
    // A remote pid can't be probed, so a cross-host owner is trusted on heartbeat freshness
    // alone (checked above): a crashed holder stops heartbeating and ages out within
    // heartbeatStaleMs. Previously any different-host owner was declared stale outright, so the
    // container's api:refresh and a host-side manual:* CLI job — which share data/refresh.lock
    // through the ./data bind mount but see different os.hostname() — stole the lock from each
    // other and ran fetchers/recompute against lp.db concurrently despite a live heartbeat.
    return false;
  }
  if (!processExists(owner.pid)) return true;
  const currentStartTime = processStartTime(owner.pid);
  if (currentStartTime && !owner.process_start_time) return true;
  return Boolean(currentStartTime && owner.process_start_time && currentStartTime !== owner.process_start_time);
}

function removeLockDir(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function writeOwner(lockDir: string, owner: RefreshLockOwner): void {
  writeFileAtomic(ownerPath(lockDir), `${JSON.stringify(owner, null, 2)}\n`);
}

function touchHeartbeat(lockDir: string, owner: RefreshLockOwner): void {
  const current = readOwner(lockDir);
  if (current?.token !== owner.token) return;
  owner.heartbeat_at = new Date().toISOString();
  writeOwner(lockDir, owner);
}

function createHandle(lockDir: string, owner: RefreshLockOwner, heartbeatMs: number): RefreshLockHandle {
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          try {
            touchHeartbeat(lockDir, owner);
          } catch {
            // The guarded job still owns release semantics; a transient heartbeat write failure should not crash it.
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  return {
    owner,
    release() {
      if (heartbeat) clearInterval(heartbeat);
      const current = readOwner(lockDir);
      if (current?.token === owner.token) removeLockDir(lockDir);
    }
  };
}

async function acquireOnce(options: RefreshLockOptions): Promise<RefreshLockTryResult> {
  const resolvedLockDir = lockPath(options.lockDir);
  const staleMs = options.staleMs ?? defaultStaleMs;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? defaultHeartbeatStaleMs;
  fs.mkdirSync(path.dirname(resolvedLockDir), { recursive: true });

  try {
    fs.mkdirSync(resolvedLockDir);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const owner = readOwner(resolvedLockDir);
    if (ownerIsStale(owner, staleMs, heartbeatStaleMs)) {
      removeLockDir(resolvedLockDir);
      return acquireOnce(options);
    }
    return { acquired: false, owner };
  }

  const now = new Date().toISOString();
  const owner: RefreshLockOwner = {
    acquired_at: now,
    heartbeat_at: now,
    hostname: os.hostname(),
    job: options.job,
    pid: process.pid,
    process_start_time: processStartTime(process.pid),
    token: crypto.randomUUID()
  };

  try {
    writeOwner(resolvedLockDir, owner);
  } catch (error) {
    removeLockDir(resolvedLockDir);
    throw error;
  }

  const lock = createHandle(resolvedLockDir, owner, options.heartbeatMs ?? defaultHeartbeatMs);
  return { acquired: true, lock, owner };
}

export async function tryAcquireRefreshLock(options: RefreshLockOptions): Promise<RefreshLockTryResult> {
  return acquireOnce(options);
}

export async function acquireRefreshLock(options: RefreshLockOptions): Promise<RefreshLockHandle> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = Math.max(25, options.pollMs ?? defaultPollMs);
  const deadline = Date.now() + waitMs;
  let lastOwner: RefreshLockOwner | null = null;

  while (true) {
    const result = await tryAcquireRefreshLock(options);
    if (result.acquired) return result.lock;
    lastOwner = result.owner;
    if (Date.now() >= deadline) throw new RefreshLockBusyError(options.job, lastOwner);
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

export async function withRefreshLock<T>(options: RefreshLockOptions, action: () => Promise<T> | T): Promise<T> {
  const lock = await acquireRefreshLock(options);
  try {
    return await action();
  } finally {
    lock.release();
  }
}
