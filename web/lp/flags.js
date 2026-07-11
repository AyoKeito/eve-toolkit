// Flag / access-risk / cargo chip rendering for the LP leaderboard. Pure DOM
// construction — no app state, no imports. iconChip builds the accessible,
// tap-to-expand chips; riskFlag/vanityFlag derive synthetic flags from a row.

const flagIcons = {
  HEAVY: "package",
  VERY_HEAVY: "package",
  LOW_VOLUME: "bar-chart",
  SLOW_FILL: "hourglass",
  THIN_BOOK: "book-open",
  WIDE_SPREAD: "split-arrows",
  PRICE_SPIKE: "trending-up",
  BUY_SPIKE: "circle-arrow-up",
  OFF_HUB: "map-pin-off",
  NO_HISTORY: "clock",
  INSUFFICIENT_DEPTH: "layers",
  CONTRACT_PRICED: "file-signature",
  NICHE_DEMAND: "gauge",
  VANITY: "sparkles",
  RISK_LOWSEC: "triangle-alert",
  RISK_NULLSEC: "shield-alert",
  RISK_UNKNOWN: "help-circle"
};

const flagNames = {
  HEAVY: "Heavy cargo",
  VERY_HEAVY: "Very heavy cargo",
  LOW_VOLUME: "Low volume",
  SLOW_FILL: "Slow fill",
  THIN_BOOK: "Thin order book",
  WIDE_SPREAD: "Wide spread",
  PRICE_SPIKE: "Price spike",
  BUY_SPIKE: "Buy-order spike",
  OFF_HUB: "Off-hub price",
  NO_HISTORY: "No market history",
  INSUFFICIENT_DEPTH: "Insufficient depth",
  CONTRACT_PRICED: "Contract priced",
  NICHE_DEMAND: "Niche demand",
  VANITY: "Vanity or cosmetic product",
  RISK_LOWSEC: "Low security LP store",
  RISK_NULLSEC: "Null security LP store",
  RISK_UNKNOWN: "Unknown LP store risk"
};

const iconPaths = {
  "bar-chart": ["M4 19V5", "M4 19h16", "M8 16V9", "M12 16V6", "M16 16v-4"],
  "book-open": ["M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z", "M4 5.5A2.5 2.5 0 0 1 6.5 8H20", "M12 3v18"],
  "split-arrows": ["M4 7h12", "M12 3l4 4-4 4", "M20 17H8", "M12 13l-4 4 4 4"],
  "trending-up": ["M3 17 9 11l4 4 7-8", "M14 7h6v6"],
  "circle-arrow-up": ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 16V8", "m8.5 11.5 3.5-3.5 3.5 3.5"],
  hourglass: ["M5 22h14", "M5 2h14", "M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4A2 2 0 0 0 7 17.8V22", "M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2"],
  "map-pin-off": ["M5 5 19 19", "M12 21s6-4.6 6-10a6 6 0 0 0-8.5-5.4", "M9.6 9.6A2.5 2.5 0 0 0 12 13a2.5 2.5 0 0 0 2.4-1.8"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  gauge: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
  layers: ["M12 3 3 8l9 5 9-5-9-5Z", "M3 12l9 5 9-5", "M3 16l9 5 9-5"],
  "file-signature": ["M14 3v4a1 1 0 0 0 1 1h4", "M19 12V8l-5-5H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6", "M13.5 18.5 17 15l2 2-3.5 3.5H13.5v-2Z"],
  "triangle-alert": ["M12 3 2 20h20L12 3Z", "M12 9v4", "M12 17h.01"],
  "shield-alert": ["M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z", "M12 8v5", "M12 17h.01"],
  "circle-dot": ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 12h.01"],
  package: ["M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z", "M3.3 7 12 12l8.7-5", "M12 22V12", "m7.5 4.3 9 5.1"],
  sparkles: ["M12 3l1.2 4.2L17 8.5l-3.8 1.3L12 14l-1.2-4.2L7 8.5l3.8-1.3L12 3Z", "M5 13l.7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7L5 13Z", "M19 14l.6 1.8 1.9.7-1.9.7L19 19l-.6-1.8-1.9-.7 1.9-.7L19 14Z"],
  "help-circle": ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-.9.6-1.6 1.1-1.6 2.6", "M12 17h.01"]
};

function iconNode(name, className = "chip-icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of iconPaths[name] || iconPaths["help-circle"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function iconChip(flag) {
  const code = flag?.code || "RISK_UNKNOWN";
  const label = flag.message || flagNames[code] || String(code).replaceAll("_", " ");
  const span = document.createElement("span");
  span.className = `chip flag ${flag?.severity || "warn"}`;
  span.title = label;
  span.setAttribute("role", "button");
  span.setAttribute("tabindex", "0");
  span.setAttribute("aria-label", label);
  span.setAttribute("aria-expanded", "false");
  span.append(iconNode(flagIcons[code] || "help-circle"));

  const text = document.createElement("span");
  text.className = "flag-label";
  text.textContent = label;
  const link = document.createElement("a");
  link.className = "flag-doc-link";
  link.href = code.startsWith("RISK_") ? "/lp/about.html#risk-and-access" : "/lp/about.html#quality-flags";
  link.textContent = "?";
  link.title = "Flag definitions in the methodology";
  link.addEventListener("click", (event) => event.stopPropagation());
  text.append(link);
  span.append(text);

  // tooltips need hover — on touch the tap expands the chip into its label instead
  const toggle = (event) => {
    event.stopPropagation();
    const open = span.classList.toggle("open");
    span.setAttribute("aria-expanded", String(open));
    if (open) span.removeAttribute("title");
    else span.title = label;
  };
  span.addEventListener("click", toggle);
  span.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle(event);
    }
  });
  return span;
}

export function riskFlag(tier) {
  const normalizedTier = tier === "WORMHOLE" ? "NULLSEC" : tier;
  tier = normalizedTier;
  if (tier === "HIGHSEC") return null;
  const severity = tier === "LOWSEC" ? "warn" : "strong";
  return {
    code: `RISK_${tier || "UNKNOWN"}`,
    severity,
    message: tier ? `${tier} LP store risk tier` : "Unknown LP store risk tier"
  };
}

export function vanityFlag(row) {
  if (!row?.is_vanity) return null;
  return {
    code: "VANITY",
    severity: "warn",
    message: "Vanity or cosmetic product"
  };
}

export function renderFlags(flags, ...extraFlags) {
  const wrap = document.createElement("div");
  wrap.className = "flag-wrap";
  for (const flag of [...(flags || []), ...extraFlags].filter(Boolean)) {
    wrap.append(iconChip(flag));
  }
  return wrap;
}
