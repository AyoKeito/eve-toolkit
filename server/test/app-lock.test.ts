import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AppLockBusyError,
  acquireAppLock,
  tryAcquireAppLock,
  withAppLock
} from "../src/lib/app-lock.js";

function tempLockDir(): { root: string; lockDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-app-lock-"));
  return { root, lockDir: path.join(root, "app.lock") };
}

function writeOwner(lockDir: string, owner: Record<string, unknown>): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

test("app lock prevents a second live HTTP scheduler process", async () => {
  const { root, lockDir } = tempLockDir();
  const first = await acquireAppLock({ lockDir, heartbeatMs: 0, appRoot: "/srv/eve", dbPath: "/srv/eve/data/lp.db" });

  try {
    const second = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, appRoot: "/srv/eve", dbPath: "/srv/eve/data/lp.db" });

    assert.equal(second.acquired, false);
    assert.equal(second.owner?.app_root, "/srv/eve");
    assert.equal(second.owner?.db_path, "/srv/eve/data/lp.db");
    await assert.rejects(
      withAppLock({ lockDir, heartbeatMs: 0 }, async () => "ran"),
      AppLockBusyError
    );
  } finally {
    first.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app lock release allows a later process to start", async () => {
  const { root, lockDir } = tempLockDir();
  const first = await acquireAppLock({ lockDir, heartbeatMs: 0 });
  first.release();

  const second = await tryAcquireAppLock({ lockDir, heartbeatMs: 0 });
  assert.equal(second.acquired, true);
  second.lock.release();

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock recovers a stale heartbeat from a dead process", async () => {
  const { root, lockDir } = tempLockDir();
  writeOwner(lockDir, {
    acquired_at: "2026-05-20T00:00:00.000Z",
    heartbeat_at: "2026-05-20T00:00:00.000Z",
    hostname: "old-container",
    pid: 99999999,
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "old-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 1 });
  assert.equal(result.acquired, true);
  result.lock.release();

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock preserves a fresh owner from another hostname", async () => {
  const { root, lockDir } = tempLockDir();
  const now = new Date().toISOString();
  writeOwner(lockDir, {
    acquired_at: now,
    heartbeat_at: now,
    hostname: "docker-container",
    pid: 21,
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "fresh-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 60_000 });
  assert.equal(result.acquired, false);
  assert.equal(result.owner?.hostname, "docker-container");

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock recovers same-host pid reuse with a different process start time", async () => {
  const { root, lockDir } = tempLockDir();
  const now = new Date().toISOString();
  writeOwner(lockDir, {
    acquired_at: now,
    heartbeat_at: now,
    hostname: os.hostname(),
    pid: process.pid,
    process_start_time: "older-process-start",
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "old-container-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 60_000 });
  assert.equal(result.acquired, true);
  result.lock.release();

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock reclaims a pid-reuse hazard when owner has no process_start_time but system can provide one", async () => {
  const { root, lockDir } = tempLockDir();
  const now = new Date().toISOString();
  // Owner recorded no process_start_time (legacy record), but the current process
  // for that PID is probed and returns a start time. This is the recycled-PID gap:
  // the lock should be treated as stale rather than live.
  writeOwner(lockDir, {
    acquired_at: now,
    heartbeat_at: now,
    hostname: os.hostname(),
    pid: process.pid,
    // process_start_time deliberately absent
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "legacy-no-start-time-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 60_000 });
  // process.pid is live and process_start_time() will return a value for it,
  // so the asymmetry guard must fire and reclaim the lock.
  assert.equal(result.acquired, true);
  result.lock.release();

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock writeOwner leaves no temp files in the lock dir", async () => {
  const { root, lockDir } = tempLockDir();
  const lock = await acquireAppLock({ lockDir, heartbeatMs: 0 });

  try {
    // Trigger a heartbeat write so writeOwner is called at least once.
    lock.heartbeat();

    const entries = fs.readdirSync(lockDir);
    // Only owner.json should exist — no leftover .tmp files.
    assert.deepEqual(entries.filter((f) => f !== "owner.json"), []);
  } finally {
    lock.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app lock preserves a cross-host lock with a fresh heartbeat regardless of acquired_at age", async () => {
  const { root, lockDir } = tempLockDir();
  // A cross-host owner whose acquired_at is ancient but whose heartbeat is fresh: something is
  // still writing that heartbeat every ~30s, so the runtime is ALIVE and must not be displaced —
  // stealing it would run a second process against the same lp.db. (The old acquired_at max-age
  // cap wrongly reclaimed exactly this case after ~50 min.)
  const ancientTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
  const freshHeartbeat = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago (fresh)
  writeOwner(lockDir, {
    acquired_at: ancientTs,
    heartbeat_at: freshHeartbeat,
    hostname: "docker-container",
    pid: 1,
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "live-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 5 * 60 * 1000 });
  assert.equal(result.acquired, false);
  assert.equal(result.owner?.hostname, "docker-container");

  fs.rmSync(root, { recursive: true, force: true });
});

test("app lock reclaims a cross-host lock whose heartbeat has gone stale", async () => {
  const { root, lockDir } = tempLockDir();
  // The genuinely-crashed case: a different host's process died, so its heartbeat froze and aged
  // past staleMs. That — not elapsed acquired_at — is what makes a cross-host lock reclaimable.
  const staleHeartbeat = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago (stale)
  writeOwner(lockDir, {
    acquired_at: staleHeartbeat,
    heartbeat_at: staleHeartbeat,
    hostname: "crashed-host",
    pid: 1,
    app_root: "/app",
    db_path: "/app/data/lp.db",
    token: "dead-token"
  });

  const result = await tryAcquireAppLock({ lockDir, heartbeatMs: 0, staleMs: 5 * 60 * 1000 });
  assert.equal(result.acquired, true);
  result.lock.release();

  fs.rmSync(root, { recursive: true, force: true });
});
