import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openSdeArchive } from "../src/fetchers/sde-archive.js";

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

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value: number): Buffer {
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
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(content.length),
      writeUInt32(content.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name
    ]);
    localParts.push(localHeader, content);

    centralParts.push(
      Buffer.concat([
        writeUInt32(0x02014b50),
        writeUInt16(20),
        writeUInt16(20),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(crc),
        writeUInt32(content.length),
        writeUInt32(content.length),
        writeUInt16(name.length),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(0),
        writeUInt32(offset),
        name
      ])
    );
    offset += localHeader.length + content.length;
  }

  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    Buffer.concat([
      writeUInt32(0x06054b50),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(entries.length),
      writeUInt16(entries.length),
      writeUInt32(central.length),
      writeUInt32(offset),
      writeUInt16(0)
    ])
  ]);
}

test("SDE archive reader streams requested JSONL members and metadata", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-archive-"));
  const archivePath = path.join(tempDir, "fixture.zip");
  fs.writeFileSync(
    archivePath,
    zipBuffer([
      {
        name: "_sde.jsonl",
        content: `${JSON.stringify({ buildNumber: 3346029, releaseDate: "2026-05-13T11:51:25Z" })}\n`
      },
      {
        name: "fsd/types.jsonl",
        content: `${JSON.stringify({ typeID: 34, name: { en: "Tritanium" } })}\n${JSON.stringify({
          typeID: 35,
          name: "Pyerite"
        })}\n`
      },
      {
        name: "extra.jsonl",
        content: `${JSON.stringify({ ignored: true })}\n`
      }
    ])
  );

  const archive = await openSdeArchive({ archivePath });
  const rows: unknown[] = [];
  const count = await archive.readJsonl("types.jsonl", (row) => {
    rows.push(row);
  });

  const expectedUrl = pathToFileURL(path.resolve(archivePath)).href;
  assert.equal(archive.metadata.buildNumber, 3346029);
  assert.equal(archive.metadata.releaseDate, "2026-05-13T11:51:25Z");
  assert.equal(archive.archiveUrl, expectedUrl);
  assert.equal(archive.metadata.archiveUrl, expectedUrl);
  assert.equal(count, 2);
  assert.deepEqual(rows, [
    { typeID: 34, name: { en: "Tritanium" } },
    { typeID: 35, name: "Pyerite" }
  ]);
  assert.equal(fs.existsSync(path.join(tempDir, "types.jsonl")), false);
});
