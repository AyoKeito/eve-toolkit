import fs from "node:fs";
import path from "node:path";

/**
 * Write `data` to `filePath` atomically using a sibling temp file and rename.
 * The rename is either atomic (POSIX) or near-atomic (Windows/cross-device fallback).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}
