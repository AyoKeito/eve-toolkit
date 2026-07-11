// Strip chruker row annotations out of NPC type_names in seed files.
//
// chruker mission tables embed notes in the ship-name cell ("Taibu State Yari
// - trigger", "Republic Tribal Baldur - wave 1", "Mizara - objective"); the
// scraper keeps the full cell text, which then fails SDE type_name resolution
// in enrich-missions.mjs. Move the " - " suffix into the npc's notes field and
// keep the clean name. Idempotent; run before (re-)enriching.
//
// Usage: node scripts/clean-npc-name-suffixes.mjs <seed.json> [<seed.json> ...]
import fs from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/clean-npc-name-suffixes.mjs <seed.json> ...");
  process.exit(2);
}

for (const file of files) {
  const seed = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = 0;
  for (const m of seed.missions ?? [])
    for (const p of m.pockets ?? [])
      for (const g of p.groups ?? [])
        for (const npc of g.npcs ?? []) {
          const idx = (npc.type_name ?? "").indexOf(" - ");
          if (idx <= 0) continue;
          const suffix = npc.type_name.slice(idx + 3).trim();
          npc.type_name = npc.type_name.slice(0, idx).trim();
          if (suffix) npc.notes = npc.notes ? `${npc.notes}; ${suffix}` : suffix;
          changed += 1;
        }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(JSON.stringify({ file, changed }));
}
