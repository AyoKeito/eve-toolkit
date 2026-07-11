import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { countRows, type Db } from "../db.js";
import { backupDir as defaultBackupDir, backupRetentionDays, loadConfig } from "../config.js";

export interface RunSnapshotResult {
  rows: number;
  backup: string | null;
}

export function runSnapshot(db: Db, dbPath: string): RunSnapshotResult {
  return {
    rows: snapshotCalc(db),
    backup: backupSqlite(dbPath)
  };
}

export function snapshotCalc(db: Db): number {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM calc_prev").run();
    db.prepare("INSERT INTO calc_prev SELECT * FROM calc").run();
  });
  tx();
  return countRows(db, "calc_prev");
}

interface BackupSqliteOptions {
  backupDir?: string;
  now?: Date;
  /** Test-only: override the WAL checkpoint result instead of opening a real db. */
  _checkpointResult?: { busy: number; log: number; checkpointed: number };
}

export function backupSqlite(dbPath = loadConfig().dbPath, options: BackupSqliteOptions = {}): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const targetBackupDir = options.backupDir ?? defaultBackupDir;
  fs.mkdirSync(targetBackupDir, { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().slice(0, 10);
  const target = path.join(targetBackupDir, `lp-${stamp}.db`);
  // Checkpoint the WAL back into the main database file before copying. A raw
  // copyFileSync on a WAL-mode database silently omits any committed frames
  // still sitting in the -wal file, producing a stale backup. TRUNCATE folds
  // those frames into the .db (and empties the WAL), so the single-file copy is
  // consistent. better-sqlite3's db.backup() is async and would force the whole
  // call chain (scheduler, CLI, withRefreshLock callback) async, so we use the
  // synchronous checkpoint+copy path instead.
  // PRAGMA wal_checkpoint returns a single row: (busy, log, checkpointed).
  // busy > 0 means another connection held a read lock; log !== checkpointed
  // means some frames were not folded in. Either case means the copied file
  // would silently miss committed transactions, so we throw rather than
  // produce a silently incomplete backup.
  let cpResult: { busy: number; log: number; checkpointed: number } | undefined;
  if (options._checkpointResult !== undefined) {
    cpResult = options._checkpointResult;
  } else {
    const src = new Database(dbPath);
    try {
      [cpResult] = src.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    } finally {
      src.close();
    }
  }
  if (cpResult && (cpResult.busy > 0 || cpResult.log !== cpResult.checkpointed)) {
    throw new Error(
      `WAL checkpoint did not complete before backup: busy=${cpResult.busy} log=${cpResult.log} checkpointed=${cpResult.checkpointed}`
    );
  }
  fs.copyFileSync(dbPath, target);

  const backups = fs
    .readdirSync(targetBackupDir)
    .filter((file) => /^lp-\d{4}-\d{2}-\d{2}\.db$/.test(file))
    .sort()
    .reverse();
  for (const old of backups.slice(backupRetentionDays())) {
    fs.rmSync(path.join(targetBackupDir, old), { force: true });
  }
  return target;
}
