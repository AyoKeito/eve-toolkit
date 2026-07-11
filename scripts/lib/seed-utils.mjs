// Shared helper for the per-mission seed "patch" scripts (recommended ship,
// objective notes, …). Each script declares a { file: { mission_id: value } }
// table; this applies one field across the listed missions, writes each seed
// back as stable 2-space JSON + trailing newline, and logs a per-file summary.
//
// SEED_DIR is resolved relative to THIS file (not process.cwd()), so the patch
// scripts work regardless of the directory they are invoked from.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.resolve(here, "../../data/missions/seed");

// Apply `field` = value for each { file: { mission_id: value } } entry.
// opts.noun  — per-file log word (e.g. "set", "notes").
// opts.sanityCheck(seed) — optional; returns a string appended to the per-file
//   log line (e.g. ", still null: 12,13") after that file's missions are set.
export function patchSeedField(entries, field, { noun = "set", sanityCheck } = {}) {
  let patched = 0;
  let missing = 0;
  for (const [file, values] of Object.entries(entries)) {
    const filePath = path.join(SEED_DIR, file);
    const seed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const byId = new Map(seed.missions.map((m) => [m.mission_id, m]));
    for (const [id, value] of Object.entries(values)) {
      const mission = byId.get(Number(id));
      if (!mission) {
        console.warn(`WARN ${file}: mission ${id} not found`);
        missing += 1;
        continue;
      }
      mission[field] = value;
      patched += 1;
    }
    const suffix = sanityCheck ? sanityCheck(seed) : "";
    fs.writeFileSync(filePath, `${JSON.stringify(seed, null, 2)}\n`);
    console.log(`${file}: ${Object.keys(values).length} ${noun}${suffix}`);
  }
  console.log(JSON.stringify({ patched, missing }, null, 2));
  return { patched, missing };
}
