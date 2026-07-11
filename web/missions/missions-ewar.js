// Canonical EWAR taxonomy shared by the missions detail + arc views.
//
// normalizeEwarType: fuzzy-match a raw server EWAR string → a canonical kind.
//   (The matcher originated in detail.js and is the source of truth — it tolerates
//   the loosely-typed strings the chruker scrape produces.) In chruker's class
//   vocabulary `ewar_disrupt` means TRACKING disruptor (every seed DISRUPT text is
//   "Tracking Disrupt (…)"), and `ewar_scramble` covers ALL warp tackle — the
//   "N pt." effect text is what separates a 2pt scram from a 1pt point.
// normalizeEwarEffect: kind for a (type, text) pair — refines SCRAMBLE by points
//   and lets a "Tracking …" text win over the type. Prefer it whenever the effect
//   text is available.
// EWAR_META: per-kind label + severity. Labels follow EVE University terminology
//   (https://wiki.eveuniversity.org/Electronic_warfare): warp disruptor = "Point",
//   ECM = "ECM". `severity` drives the is-{severity} chip colour.
// describeEwar / ewarMapping: thin adapters for the two consumers' shapes.

export const EWAR_META = {
  web: { kind: "web", label: "Web", severity: "warning" },
  scramble: { kind: "scramble", label: "Scram", severity: "danger" },
  disrupt: { kind: "disrupt", label: "Point", severity: "warning" },
  neut: { kind: "neut", label: "Neut", severity: "danger" },
  damp: { kind: "damp", label: "Damp", severity: "warning" },
  jam: { kind: "jam", label: "ECM", severity: "danger" },
  td: { kind: "td", label: "TD", severity: "danger" },
  painter: { kind: "painter", label: "Paint", severity: "info" },
  other: { kind: "other", label: "EWAR", severity: "warning" }
};

export function normalizeEwarType(rawType) {
  const t = String(rawType || "").toUpperCase();
  if (t.startsWith("WEB") || t.includes("STASIS")) return "web";
  if (t.includes("TRACKING") || t === "TD") return "td";
  if (t.startsWith("SCRAMBLE") || t.includes("SCRAM")) return "scramble";
  if (t.includes("WARP_DIS")) return "disrupt";
  // chruker's ewar_disrupt class marks tracking disruptors, not warp points.
  if (t.startsWith("DISRUPT")) return "td";
  if (t === "DRAIN" || t.includes("NEUT") || t.includes("NEUTRAL")) return "neut";
  if (t.startsWith("DAMP") || t.includes("SENSOR_DAMP")) return "damp";
  if (t.startsWith("JAM") || t.startsWith("ECM")) return "jam";
  if (t.startsWith("PAINT")) return "painter";
  return "other";
}

// Kind for a full (type, text) effect pair. SCRAMBLE entries are split by warp
// points — "2 pt." is a scram, "1 pt." (or a bare "point"/"point=yes" flag) is a
// long point — and a "Tracking …" text wins over whatever the type claims.
export function normalizeEwarEffect(rawType, text) {
  const kind = normalizeEwarType(rawType);
  const t = String(text || "");
  if (/tracking/i.test(t)) return "td";
  if (kind === "scramble") {
    const points = parseEwarText(t).points;
    return points != null && points >= 2 ? "scramble" : "disrupt";
  }
  return kind;
}

// Parse the rich free-text EWAR effect string (e.g. "Energy Neutralize (20.0 GJ/s,
// 30 km, 75% chance)", "Webbing (10 km, -50%, 25% chance, 5s)") into structured params.
// Defensive: every field is null when absent, and bare labels like "Damp" return all-null.
export function parseEwarText(text) {
  const t = String(text || "");
  const one = (re) => {
    const m = t.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  const gjPerSec = one(/([\d.]+)\s*GJ\/s/i);
  const chancePct = one(/([\d.]+)\s*%\s*chance/i);
  // strength is the first signed % that is NOT the "N% chance" token
  let strengthPct = null;
  for (const m of t.matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 8).toLowerCase();
    if (after.includes("chance")) continue;
    strengthPct = parseFloat(m[1]);
    break;
  }
  // "25-75 km" range expressions (damps, painters) carry both ends; keep the
  // max in rangeKm (worst case) and surface the min separately.
  let rangeKm = null;
  let rangeKmMin = null;
  const rangePair = t.match(/(\d[\d.]*)\s*-\s*(\d[\d.]*)\s*km/i);
  if (rangePair) {
    rangeKmMin = parseFloat(rangePair[1]);
    rangeKm = parseFloat(rangePair[2]);
  } else {
    rangeKm = one(/([\d.]+)\s*km/i);
  }
  const points = one(/(\d+(?:\.\d+)?)\s*pt/i);
  const durs = [...t.matchAll(/([\d.]+)\s*s\b/gi)];
  const durationS = durs.length ? parseFloat(durs[durs.length - 1][1]) : null;
  return { gjPerSec, rangeKm, rangeKmMin, chancePct, strengthPct, points, durationS };
}

// detail.js shape: { kind, label }. Unknown types keep their raw string as the
// label. Pass the effect text when you have it — it disambiguates scram vs point
// and mislabelled tracking disruptors (see normalizeEwarEffect).
export function ewarMapping(rawType, text) {
  const kind = text != null ? normalizeEwarEffect(rawType, text) : normalizeEwarType(rawType);
  const label = kind === "other" ? (rawType || "EWAR").toString() : EWAR_META[kind].label;
  return { kind, label };
}

// arc-graph.js shape: list of { kind, label, severity } for a list of raw types,
// de-duplicated by raw type and preserving input order.
export function describeEwar(types) {
  if (!Array.isArray(types) || types.length === 0) return [];
  const seen = new Set();
  const items = [];
  for (const type of types) {
    if (seen.has(type)) continue;
    seen.add(type);
    const kind = normalizeEwarType(type);
    const label = kind === "other" ? String(type) : EWAR_META[kind].label;
    items.push({ kind, label, severity: EWAR_META[kind].severity });
  }
  return items;
}
