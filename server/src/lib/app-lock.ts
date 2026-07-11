import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, rootDir } from "../config.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { processExists, processStartTime } from "./process-check.js";

const defaultStaleMs = 5 * 60 * 1000;
const defaultHeartbeatMs = 30 * 1000;

export interface AppLockOwner {
  acquired_at: string;
  heartbeat_at: string;
  hostname: string;
  pid: number;
  process_start_time?: string;
  app_root: string;
  db_path: string;
  token: string;
}

export interface AppLockOptions {
  appRoot?: string;
  dbPath?: string;
  heartbeatMs?: number;
  lockDir?: string;
  staleMs?: number;
}

export interface AppLockHandle {
  owner: AppLockOwner;
  heartbeat(): void;
  release(): void;
}

export type AppLockTryResult =
  | { acquired: true; lock: AppLockHandle; owner: AppLockOwner }
  | { acquired: false; owner: AppLockOwner | null };

export class AppLockBusyError extends Error {
  constructor(readonly owner: AppLockOwner | null) {
    super(owner ? `App runtime is already running as pid ${owner.pid} on ${owner.hostname}` : "App runtime is already running");
    this.name = "AppLockBusyError";
  }
}

function lockPath(lockDir?: string): string {
  return lockDir ?? path.join(dataDir, "app.lock");
}

function ownerPath(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function readOwner(lockDir: string): AppLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath(lockDir), "utf8")) as Partial<AppLockOwner>;
    if (
      typeof parsed.acquired_at === "string" &&
      typeof parsed.heartbeat_at === "string" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.app_root === "string" &&
      typeof parsed.db_path === "string" &&
      typeof parsed.token === "string"
    ) {
      return parsed as AppLockOwner;
    }
  } catch {
    return null;
  }
  return null;
}

function ownerIsStale(owner: AppLockOwner | null, staleMs: number): boolean {
  if (!owner) return true;
  const heartbeatMs = Date.parse(owner.heartbeat_at);
  if (!Number.isFinite(heartbeatMs)) return true;
  if (Date.now() - heartbeatMs > staleMs) return true;
  if (owner.hostname !== os.hostname()) {
    // A remote pid can't be probed, so a cross-host owner is trusted purely on heartbeat
    // freshness, which was already checked above. It is NOT expired on elapsed acquired_at age: a
    // crashed remote process stops updating heartbeat_at and ages out via the staleness check
    // above within staleMs, so the only way a cross-host heartbeat stays fresh is a live owner
    // still writing it every ~30s — and stealing that lock would run a second runtime against the
    // same lp.db. (The previous acquired_at max-age cap displaced live cross-host owners after
    // ~50 min even while they were actively heartbeating.)
    return false;
  }
  if (!processExists(owner.pid)) return true;
  const currentProcessStartTime = processStartTime(owner.pid);
  // If the system can identify the current process start time but the lock owner
  // recorded none, the owner record predates start-time tracking — treat as stale
  // to close the recycled-PID gap (mirrors the same guard in refresh-lock.ts).
  if (currentProcessStartTime && !owner.process_start_time) return true;
  return Boolean(owner.process_start_time && currentProcessStartTime && owner.process_start_time !== currentProcessStartTime);
}

function removeLockDir(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function writeOwner(lockDir: string, owner: AppLockOwner): void {
  writeFileAtomic(ownerPath(lockDir), `${JSON.stringify(owner, null, 2)}\n`);
}

function createHandle(lockDir: string, owner: AppLockOwner, heartbeatMs: number): AppLockHandle {
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const heartbeat = (): void => {
    const current = readOwner(lockDir);
    if (current?.token !== owner.token) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    owner.heartbeat_at = new Date().toISOString();
    writeOwner(lockDir, owner);
  };

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(heartbeat, heartbeatMs);
    heartbeatTimer.unref();
  }

  return {
    owner,
    heartbeat,
    release() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const current = readOwner(lockDir);
      if (current?.token === owner.token) removeLockDir(lockDir);
    }
  };
}

async function acquireOnce(options: AppLockOptions): Promise<AppLockTryResult> {
  const resolvedLockDir = lockPath(options.lockDir);
  const staleMs = options.staleMs ?? defaultStaleMs;
  fs.mkdirSync(path.dirname(resolvedLockDir), { recursive: true });

  try {
    fs.mkdirSync(resolvedLockDir);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const owner = readOwner(resolvedLockDir);
    if (ownerIsStale(owner, staleMs)) {
      removeLockDir(resolvedLockDir);
      return acquireOnce(options);
    }
    return { acquired: false, owner };
  }

  const now = new Date().toISOString();
  const owner: AppLockOwner = {
    acquired_at: now,
    heartbeat_at: now,
    hostname: os.hostname(),
    pid: process.pid,
    process_start_time: processStartTime(process.pid) ?? undefined,
    app_root: path.resolve(options.appRoot ?? rootDir),
    db_path: path.resolve(options.dbPath ?? path.join(dataDir, "lp.db")),
    token: crypto.randomUUID()
  };

  try {
    writeOwner(resolvedLockDir, owner);
  } catch (error) {
    removeLockDir(resolvedLockDir);
    throw error;
  }

  const lock = createHandle(resolvedLockDir, owner, Math.max(0, options.heartbeatMs ?? defaultHeartbeatMs));
  return { acquired: true, lock, owner };
}

export async function tryAcquireAppLock(options: AppLockOptions = {}): Promise<AppLockTryResult> {
  return acquireOnce(options);
}

export async function acquireAppLock(options: AppLockOptions = {}): Promise<AppLockHandle> {
  const result = await tryAcquireAppLock(options);
  if (result.acquired) return result.lock;
  throw new AppLockBusyError(result.owner);
}

export async function withAppLock<T>(options: AppLockOptions, action: () => Promise<T> | T): Promise<T> {
  const lock = await acquireAppLock(options);
  try {
    return await action();
  } finally {
    lock.release();
  }
}
