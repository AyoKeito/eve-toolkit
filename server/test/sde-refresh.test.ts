import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { readImportedSdeBuild, refreshSde } from "../src/fetchers/sde.js";
import { latestRemoteBuildNumber, pruneCachedArchives } from "../src/fetchers/sde-archive.js";

// --- Minimal store-method ZIP writer (same shape as sde-archive.test.ts) ---

interface ZipEntry {
  name: string;
  content: string;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function zipBuffer(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const crc = crc32(content);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(content.length), u32(content.length), u16(name.length), u16(0), name
    ]);
    localParts.push(localHeader, content);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(content.length), u32(content.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ])
    );
    offset += localHeader.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(central.length), u32(offset), u16(0)
    ])
  ]);
}

// importSde reads every one of these members; each must exist in the archive even when empty.
const SDE_MEMBERS = [
  "categories.jsonl", "groups.jsonl", "mapSolarSystems.jsonl", "npcStations.jsonl",
  "npcCorporations.jsonl", "blueprints.jsonl", "mapRegions.jsonl", "mapConstellations.jsonl",
  "agentTypes.jsonl", "npcCorporationDivisions.jsonl", "npcCharacters.jsonl",
  "agentsInSpace.jsonl", "stationOperations.jsonl"
];

function buildArchive(dir: string, build: number, typeId: number): string {
  const entries: ZipEntry[] = [
    { name: "_sde.jsonl", content: `${JSON.stringify({ buildNumber: build, releaseDate: "2026-07-07T11:24:17Z" })}\n` },
    { name: "types.jsonl", content: `${JSON.stringify({ typeID: typeId, groupID: 25, name: { en: `Type ${typeId}` }, volume: 1, packagedVolume: 1 })}\n` },
    ...SDE_MEMBERS.map((name) => ({ name, content: "\n" }))
  ];
  const archivePath = path.join(dir, `fixture-${build}.zip`);
  fs.writeFileSync(archivePath, zipBuffer(entries));
  return archivePath;
}

// A HEAD mock whose final response URL embeds the given build number (as CCP's redirect does).
function headFetch(build: number): typeof fetch {
  return (async () => ({ url: `https://x/eve-online-static-data-${build}-jsonl.zip`, ok: true })) as unknown as typeof fetch;
}

test("refreshSde imports on first run, skips an unchanged build, and re-imports a new build", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-refresh-"));
  const cacheDir = path.join(tempDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const db = new Database(":memory:");
  migrate(db);

  // First run: nothing imported yet -> import build 111.
  const archiveA = buildArchive(tempDir, 111, 6001);
  const first = await refreshSde(db, { archivePath: archiveA, archiveUrl: "file://a", fetchImpl: headFetch(111), cacheDir });
  assert.equal(first.imported, true);
  assert.equal(first.build, 111);
  assert.equal(first.previousBuild, null);
  assert.equal(readImportedSdeBuild(db), 111);
  assert.equal((db.prepare("SELECT type_id FROM types WHERE type_id=6001").get() as { type_id: number } | undefined)?.type_id, 6001);

  // Unchanged: HEAD reports the already-imported build 111 -> skip without downloading/importing.
  // No archivePath is supplied, so a wrongful import attempt would fail loudly instead of silently.
  const second = await refreshSde(db, { fetchImpl: headFetch(111), cacheDir });
  assert.equal(second.imported, false);
  assert.equal(second.latestBuild, 111);
  assert.equal(second.build, 111);
  assert.equal(readImportedSdeBuild(db), 111);

  // New build: HEAD reports 222 -> import build 222 over the top.
  const archiveB = buildArchive(tempDir, 222, 6002);
  const third = await refreshSde(db, { archivePath: archiveB, archiveUrl: "file://b", fetchImpl: headFetch(222), cacheDir });
  assert.equal(third.imported, true);
  assert.equal(third.build, 222);
  assert.equal(third.previousBuild, 111);
  assert.equal(readImportedSdeBuild(db), 222);
  assert.equal((db.prepare("SELECT type_id FROM types WHERE type_id=6002").get() as { type_id: number } | undefined)?.type_id, 6002);
});

test("latestRemoteBuildNumber reads the build from the redirect target and null-fails safe", async () => {
  const redirecting = (async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, "HEAD");
    return { url: "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-3424810-jsonl.zip", ok: true };
  }) as unknown as typeof fetch;
  assert.equal(await latestRemoteBuildNumber({ fetchImpl: redirecting }), 3424810);

  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.equal(await latestRemoteBuildNumber({ fetchImpl: boom }), null);
});

test("pruneCachedArchives keeps the newest builds and never touches non-archive files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-prune-"));
  const names = [
    "eve-online-static-data-100-jsonl.zip",
    "eve-online-static-data-200-jsonl.zip",
    "eve-online-static-data-300-jsonl.zip"
  ];
  names.forEach((name, i) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "x");
    const when = new Date(2026, 0, 1 + i); // ascending mtime -> 300 is newest
    fs.utimesSync(filePath, when, when);
  });
  fs.writeFileSync(path.join(dir, "sqlite-latest.sqlite"), "keep me");

  const deleted = pruneCachedArchives({ cacheDir: dir }, 2);
  assert.deepEqual(deleted.map((p) => path.basename(p)), ["eve-online-static-data-100-jsonl.zip"]);
  assert.equal(fs.existsSync(path.join(dir, "eve-online-static-data-100-jsonl.zip")), false);
  assert.equal(fs.existsSync(path.join(dir, "eve-online-static-data-200-jsonl.zip")), true);
  assert.equal(fs.existsSync(path.join(dir, "eve-online-static-data-300-jsonl.zip")), true);
  assert.equal(fs.existsSync(path.join(dir, "sqlite-latest.sqlite")), true);
});
