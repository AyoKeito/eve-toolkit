// DOM-free helpers for the Anomic burners guide (/missions/burners): EFT parsing,
// variant ordering, enemy-ship detection, and small data-shaping helpers. Split out of
// burners.js — same rationale as combat-stats.js / missions-ewar.js — so the logic can
// be reasoned about (and unit tested under plain Node) without a DOM.

// Parses a single EFT clipboard block into its ship/fit name and module/cargo lines.
// Cargo & charges lines are the ones ending in "xN" (e.g. "Nova Rage Rocket x6486");
// everything else between the header and end-of-text is a fitted module/rig line.
export function parseEft(eft) {
  const lines = String(eft || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const header = lines[0] || "";
  const headerMatch = header.match(/^\[(.+?),\s*(.+)\]$/);
  const shipName = headerMatch ? headerMatch[1] : "";
  const fitName = headerMatch ? headerMatch[2] : header;
  const modules = [];
  const cargo = [];
  for (const line of lines.slice(1)) {
    if (isCargoLine(line)) cargo.push(line);
    else modules.push(line);
  }
  return { shipName, fitName, modules, cargo };
}

export function isCargoLine(line) {
  return /x\d+$/.test(line);
}

export function isEmptySlotLine(line) {
  return /^\[Empty .*slot\]$/i.test(line);
}

// Standard variant first, then original order otherwise — the "recommended" fit reads
// as the default tab without the seed data needing to list it first.
export function sortVariants(variants) {
  return (variants || [])
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const pa = a.v.tier === "standard" ? 0 : 1;
      const pb = b.v.tier === "standard" ? 0 : 1;
      return pa - pb || a.i - b.i;
    })
    .map((x) => x.v);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds the earliest (and, on a tie, longest) known ship name mentioned in free text
// such as a mission's "enemy" line — used to show a "vs <enemy ship icon>" hint.
// `shipNames` is any iterable of ship-name strings (typically Object.keys(ship_type_ids)).
export function findEnemyShip(text, shipNames) {
  if (!text) return null;
  let best = null;
  let bestIndex = Infinity;
  for (const key of shipNames) {
    const re = new RegExp("\\b" + escapeRegExp(key) + "\\b", "i");
    const m = re.exec(text);
    if (!m) continue;
    if (m.index < bestIndex || (m.index === bestIndex && best && key.length > best.length)) {
      bestIndex = m.index;
      best = key;
    }
  }
  return best;
}

export function missionNameLookup(categories) {
  const map = new Map();
  for (const cat of categories || []) for (const m of cat.missions || []) map.set(m.id, m.name);
  return map;
}

// Chip tone for a category's difficulty badge.
export function diffTone(difficulty) {
  if (!difficulty) return null;
  if (difficulty === "entry") return "success";
  if (difficulty === "medium") return "warning";
  if (difficulty === "highest") return "danger";
  return "info";
}

const FACTS_LABELS = [
  ["hulls", "Hulls"],
  ["enemies", "Enemies"],
  ["challenge", "Challenge"],
  ["investment", "Investment"],
  ["income", "Income"]
];

// Ordered [label, value] pairs for a category's quick-fact grid, skipping unset facts.
export function factsEntries(facts) {
  return FACTS_LABELS.filter(([key]) => facts && facts[key]).map(([key, label]) => [label, facts[key]]);
}

// Ordered quick-fact chip data for one variant/build: { key, label, value, tone }.
export function quickFactsEntries(variant) {
  const chips = [];
  const quick = variant.quick || {};
  if (quick.orbit) chips.push({ key: "orbit", label: "Orbit", value: quick.orbit, tone: null });
  if (quick.ammo && quick.ammo.length) chips.push({ key: "ammo", label: "Ammo", value: quick.ammo.join(" / "), tone: "info" });
  if (variant.cost) chips.push({ key: "cost", label: "Cost", value: variant.cost, tone: null });
  if (variant.missions_to_profit != null) {
    chips.push({ key: "missions_to_profit", label: "Missions to profit", value: String(variant.missions_to_profit), tone: "success" });
  }
  return chips;
}
