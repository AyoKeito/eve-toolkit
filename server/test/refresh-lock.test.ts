import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RefreshLockBusyError,
  acquireRefreshLock,
  tryAcquireRefreshLock,
  withRefreshLock
} from "../src/lib/refresh-lock.js";

test("refresh lock prevents concurrent writers across handles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(dir, "refresh.lock");

  const first = await acquireRefreshLock({ job: "manual:fetch-history", lockDir });
  const second = await tryAcquireRefreshLock({ job: "scheduler:esi-prices-hot", lockDir });

  assert.equal(second.acquired, false);
  assert.equal(second.owner?.job, "manual:fetch-history");

  await assert.rejects(
    withRefreshLock({ job: "scheduler:esi-prices-hot", lockDir, waitMs: 0 }, async () => "ran"),
    RefreshLockBusyError
  );

  first.release();
  const afterRelease = await withRefreshLock({ job: "scheduler:esi-prices-hot", lockDir }, async () => "ran");
  assert.equal(afterRelease, "ran");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("refresh lock is released when a guarded job throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(dir, "refresh.lock");

  await assert.rejects(
    withRefreshLock({ job: "manual:compute", lockDir }, async () => {
      throw new Error("compute failed");
    }),
    /compute failed/
  );

  const next = await tryAcquireRefreshLock({ job: "manual:fetch-lp", lockDir });
  assert.equal(next.acquired, true);
  next.lock.release();

  fs.rmSync(dir, { recursive: true, force: true });
});

test("refresh lock reclaims Docker PID reuse when process start identity differs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(dir, "refresh.lock");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(
      {
        acquired_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        hostname: os.hostname(),
        job: "scheduler:esi-prices-hot",
        pid: process.pid,
        process_start_time: "different-container-start",
        token: "old-token"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const next = await tryAcquireRefreshLock({ job: "manual:fetch-prices:hot", lockDir });

  assert.equal(next.acquired, true);
  next.lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refresh lock preserves a cross-host owner with a fresh heartbeat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(dir, "refresh.lock");
  fs.mkdirSync(lockDir);
  // The container (hostname eve-lp) can hold data/refresh.lock while a host-side manual CLI job
  // runs; they share the file through the ./data bind mount but see different os.hostname(). A live
  // cross-host holder heartbeats every ~30s, so a different-host owner with a fresh heartbeat must
  // NOT be stolen — doing so let the two write lp.db concurrently.
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(
      {
        acquired_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        heartbeat_at: new Date(Date.now() - 30 * 1000).toISOString(),
        hostname: `${os.hostname()}-other`,
        job: "api:refresh",
        pid: 1,
        process_start_time: null,
        token: "live-token"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const next = await tryAcquireRefreshLock({ job: "manual:fetch-prices:hot", lockDir });
  assert.equal(next.acquired, false);
  assert.equal(next.owner?.hostname, `${os.hostname()}-other`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("refresh lock reclaims owners with a stale heartbeat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-refresh-lock-"));
  const lockDir = path.join(dir, "refresh.lock");
  const first = await acquireRefreshLock({ job: "scheduler:esi-prices-hot", lockDir, heartbeatMs: 0 });
  const ownerPath = path.join(lockDir, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    ownerPath,
    `${JSON.stringify({ ...owner, heartbeat_at: new Date(Date.now() - 10_000).toISOString() }, null, 2)}\n`,
    "utf8"
  );

  const next = await tryAcquireRefreshLock({
    job: "manual:fetch-prices:hot",
    lockDir,
    heartbeatStaleMs: 1_000,
    staleMs: 60 * 60 * 1000
  });

  assert.equal(next.acquired, true);
  first.release();
  next.lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});
