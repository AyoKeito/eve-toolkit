// Shared missions helpers used by both the arc and detail views.

export const DAMAGE_ICON_PATHS = {
  em: "/missions/assets/damage/em.png",
  therm: "/missions/assets/damage/thermal.png",
  kin: "/missions/assets/damage/kinetic.png",
  exp: "/missions/assets/damage/explosive.png"
};

export const DAMAGE_TYPES = [
  { key: "em", label: "EM", full: "EM" },
  { key: "therm", label: "Th", full: "Thermal" },
  { key: "kin", label: "Kin", full: "Kinetic" },
  { key: "exp", label: "Exp", full: "Explosive" }
];

export const DAMAGE_COLORS = {
  em: "#6BB6FF",
  therm: "#FF6B4A",
  kin: "#C9D4DC",
  exp: "#FFB347"
};

export const EWAR_ICON_PATHS = {
  web: { label: "Stasis Webifier", src: "/missions/assets/ewar/stasis-webifier.png" },
  scramble: { label: "Warp Scrambler", src: "/missions/assets/ewar/warp-scrambler.png" },
  disrupt: { label: "Warp Disruptor", src: "/missions/assets/ewar/warp-disruptor.png" },
  neut: { label: "Energy Neutralizer", src: "/missions/assets/ewar/energy-neutralizer.png" },
  damp: { label: "Sensor Dampener", src: "/missions/assets/ewar/sensor-dampener.png" },
  jam: { label: "ECM", src: "/missions/assets/ewar/ecm.png" },
  td: { label: "Tracking Disruptor", src: "/missions/assets/ewar/tracking-disruptor.png" },
  painter: { label: "Target Painter", src: "/missions/assets/ewar/target-painter.png" },
  other: { label: "EWAR", src: "/missions/assets/ewar/ecm.png" }
};

const SPACE_RISK_TYPES = new Map([
  ["LOWSEC", { label: "Lowsec risk", severity: "warning", rank: 1 }],
  ["NULLSEC", { label: "Nullsec risk", severity: "danger", rank: 2 }],
  ["WORMHOLE", { label: "Wormhole risk", severity: "danger", rank: 2 }]
]);

// Returns { label, severity, rank } for a mission's space_risk, or null when unset
// or unknown. `severity` doubles as the chip tone (CSS classes already match).
export function describeSpaceRisk(risk) {
  return SPACE_RISK_TYPES.get(String(risk ?? "").toUpperCase()) ?? null;
}
