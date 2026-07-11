import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { backupSqlite } from "../src/jobs/snapshot.js";

/** Create a minimal valid SQLite database at `filePath`. */
function createSqliteFile(filePath: string): void {
  const db = new Database(filePath);
  db.prepare("CREATE TABLE _init (x INTEGER)").run();
  db.close();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createBackupFixtures(dir: string, count: number): string[] {
  const files: string[] = [];
  for (let index = 0; index < count; index++) {
    const day = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
    const file = `lp-${day}.db`;
    files.push(file);
    fs.writeFileSync(path.join(dir, file), `backup-${index}`);
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "do not delete");
  return files;
}

test("backupSqlite keeps the configured number of newest dated backups", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-snapshot-"));
  const source = path.join(tempDir, "lp.db");
  const backups = path.join(tempDir, "backups");
  const originalRetention = process.env.BACKUP_RETENTION_DAYS;
  fs.mkdirSync(backups);
  createSqliteFile(source);
  const fixtureFiles = createBackupFixtures(backups, 50);
  process.env.BACKUP_RETENTION_DAYS = "30";

  try {
    const created = backupSqlite(source, {
      backupDir: backups,
      now: new Date("2026-03-01T00:00:00Z")
    });

    assert.equal(created, path.join(backups, "lp-2026-03-01.db"));
    const files = fs.readdirSync(backups).sort();
    const backupFiles = files.filter((file) => /^lp-\d{4}-\d{2}-\d{2}\.db$/.test(file));
    assert.equal(backupFiles.length, 30);
    assert.deepEqual(backupFiles, [...fixtureFiles, "lp-2026-03-01.db"].sort().slice(-30));
    assert.ok(files.includes("notes.txt"));
  } finally {
    restoreEnv("BACKUP_RETENTION_DAYS", originalRetention);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backupSqlite throws when WAL checkpoint reports busy readers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-snapshot-"));
  const source = path.join(tempDir, "lp.db");
  const backups = path.join(tempDir, "backups");
  fs.mkdirSync(backups);
  createSqliteFile(source);

  try {
    assert.throws(
      () =>
        backupSqlite(source, {
          backupDir: backups,
          _checkpointResult: { busy: 1, log: 5, checkpointed: 3 }
        }),
      /WAL checkpoint did not complete before backup: busy=1 log=5 checkpointed=3/
    );
    // No backup file should have been written.
    const files = fs.readdirSync(backups).filter((f) => /^lp-/.test(f));
    assert.equal(files.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backupSqlite throws when log and checkpointed diverge", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-snapshot-"));
  const source = path.join(tempDir, "lp.db");
  const backups = path.join(tempDir, "backups");
  fs.mkdirSync(backups);
  createSqliteFile(source);

  try {
    assert.throws(
      () =>
        backupSqlite(source, {
          backupDir: backups,
          _checkpointResult: { busy: 0, log: 10, checkpointed: 7 }
        }),
      /WAL checkpoint did not complete before backup: busy=0 log=10 checkpointed=7/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backupSqlite honors smaller backup retention overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-snapshot-"));
  const source = path.join(tempDir, "lp.db");
  const backups = path.join(tempDir, "backups");
  const originalRetention = process.env.BACKUP_RETENTION_DAYS;
  fs.mkdirSync(backups);
  createSqliteFile(source);
  const fixtureFiles = createBackupFixtures(backups, 50);
  process.env.BACKUP_RETENTION_DAYS = "7";

  try {
    backupSqlite(source, {
      backupDir: backups,
      now: new Date("2026-03-01T00:00:00Z")
    });

    const backupFiles = fs
      .readdirSync(backups)
      .filter((file) => /^lp-\d{4}-\d{2}-\d{2}\.db$/.test(file))
      .sort();
    assert.deepEqual(backupFiles, [...fixtureFiles, "lp-2026-03-01.db"].sort().slice(-7));
  } finally {
    restoreEnv("BACKUP_RETENTION_DAYS", originalRetention);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
