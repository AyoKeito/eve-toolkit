import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import {
  loadProfile,
  effectiveMultiplier,
  profileIsActive,
  summarizeProfile,
  onProfileChange,
  installFitProfileButton,
  dpsSeverity
} from "./fit-profile.js";
import { numberFormat as formatter } from "./formatters.js";
import { el } from "./dom-util.js";
import { installBetaNotice } from "./beta-notice.js";
import { ewarMapping, EWAR_META, parseEwarText } from "./missions-ewar.js";
import { DAMAGE_COLORS, DAMAGE_ICON_PATHS, DAMAGE_TYPES, EWAR_ICON_PATHS, describeSpaceRisk } from "./missions-util.js";
import {
  numOrZero,
  npcQty,
  npcRawDps,
  isStructure,
  flattenNpcs,
  aggregateCombatStats,
  computeSummary
} from "./combat-stats.js";

const missionId = location.pathname.match(/\/missions\/(\d+)/)?.[1];
initializeDiagnostics();
installBetaNotice();

const elements = {
  title: document.querySelector("#missionTitle"),
  meta: document.querySelector("#missionMeta"),
  root: document.querySelector("#missionRoot"),
  sourceLink: document.querySelector("#sourceLink"),
  prevMission: document.querySelector("#prevMission"),
  nextMission: document.querySelector("#nextMission"),
  nav: document.querySelector(".missions-actions")
};
installFitProfileButton(elements.nav);

let activeProfile = loadProfile();
let activeMission = null;
// Per-NPC layout: "compact" cards (default) or a "dense" table the user can expand. Persisted.
let rowStyle = (() => {
  try {
    return localStorage.getItem("missions-row-style") === "dense" ? "dense" : "compact";
  } catch {
    return "compact";
  }
})();
installDensityToggle(elements.nav);

const TANK_LAYER_ICONS = {
  shield: { label: "Shield", src: "/missions/assets/tank/shield.png" },
  armor: { label: "Armor", src: "/missions/assets/tank/armor.png" },
  hull: { label: "Hull", src: "/missions/assets/tank/hull.png" }
};

function formatN(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 10000000) return Math.round(n / 1000000) + "M";
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 10000) return Math.round(n / 1000) + "K";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toString();
}

function formatKm(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 10000) return Math.round(n / 1000) + "km";
  if (n >= 1000) return (n / 1000).toFixed(1) + "km";
  return Math.round(n) + "m";
}

function formatIsk(v) {
  if (v == null) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M ISK`;
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k ISK`;
  return `${formatter.format(v)} ISK`;
}

function classifyResist(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "med";
  if (n <= 20) return "weak";
  if (n <= 45) return "med";
  return "tough";
}

// Relative best→worst ranking for the four "Deal these" summary chips. Unlike
// classifyResist (absolute, used per-rat where 52% genuinely IS a tough resist),
// this colours the mission-level summary by ORDER, so the softest target is always
// green even when every resist is high. Ties on the rounded % share a tier.
function dealRankClasses(deal) {
  const rounded = deal.map((t) => Math.round(t.avg));
  const distinct = [...new Set(rounded)].sort((a, b) => a - b);
  const span = Math.max(1, distinct.length - 1);
  return rounded.map((v) => {
    const f = distinct.indexOf(v) / span;
    if (f <= 0) return "r0";
    if (f < 0.4) return "r1";
    if (f < 0.75) return "r2";
    return "r3";
  });
}

function assetIcon(src, label, size = 14, className = "eve-icon", decorative = true) {
  const img = el("img", {
    class: className,
    src,
    alt: decorative ? "" : label,
    title: label,
    decoding: "async",
    width: size,
    height: size,
    style: { width: `${size}px`, height: `${size}px` },
    draggable: "false"
  });
  if (decorative) img.setAttribute("aria-hidden", "true");
  return img;
}

function damageIcon(type, size = 14) {
  const damageType = DAMAGE_TYPES.find((t) => t.key === type);
  const label = damageType ? `${damageType.full} damage` : "Damage";
  return assetIcon(DAMAGE_ICON_PATHS[type], label, size, `eve-icon damage-icon damage-${type}`);
}

function tankLayerIcon(type, size = 14) {
  const tankType = TANK_LAYER_ICONS[type] || TANK_LAYER_ICONS.hull;
  return assetIcon(tankType.src, tankType.label, size, `eve-icon tank-icon tank-${type}`, false);
}

function ewarIcon(kind, size = 18) {
  const ewarType = EWAR_ICON_PATHS[kind] || EWAR_ICON_PATHS.other;
  return assetIcon(ewarType.src, ewarType.label, size, `eve-icon ewar-icon ewar-${kind}`);
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

// DPS for one NPC, scaled by the active fit profile.
function npcDpsByType(npc) {
  const qty = npcQty(npc);
  return DAMAGE_TYPES.map((t) => {
    const raw = npcRawDps(npc, t.key) * qty;
    return { ...t, raw, value: raw * effectiveMultiplier(activeProfile, t.key) };
  });
}

function buildDamageChart(items, className, options = {}) {
  const values = items.map((item) => Math.max(0, Number(item.value) || 0));
  const maxValue = options.maxValue ?? Math.max(...values, 1);
  const rows = items.map((item) => {
    const value = Math.max(0, Number(item.value) || 0);
    const chartValue = Math.max(0, Number(item.chartValue ?? item.value) || 0);
    const width = options.percent ? clampPct(chartValue) : clampPct((chartValue / maxValue) * 100);
    const valueText = item.valueText ?? (value === 0 ? "—" : Math.round(value).toString());
    const row = el("div", {
      class: `chart-row${value === 0 ? " zero" : ""}`,
      style: { color: DAMAGE_COLORS[item.key] },
      title: item.title || `${item.full || item.label}: ${valueText}`
    });
    row.append(
      damageIcon(item.key, 12),
      el("span", { class: "chart-track" }, [el("i", { style: { width: `${width}%` } })]),
      el("span", { class: "chart-value", text: valueText })
    );
    return row;
  });
  return el("div", { class: `damage-chart ${className}` }, rows);
}

function buildResistChart(rows, className = "npc-resist-chart") {
  return el(
    "div",
    { class: className },
    rows.map((row) => {
      const avg = Math.round((row.shield + row.armor) / 2);
      const item = el("div", {
        class: `resist-row ${classifyResist(avg)}`,
        style: { color: DAMAGE_COLORS[row.key] },
        title: `${row.full}: shield ${row.shield}%, armor ${row.armor}%`
      });
      item.append(
        el("div", { class: "resist-damage" }, [damageIcon(row.key, 12), el("span", { text: row.label })]),
        el("div", { class: "resist-layer-bars" }, [
          buildResistLayer("shield", row.shield),
          buildResistLayer("armor", row.armor)
        ]),
        el("span", { class: "resist-avg", text: `${avg}%` })
      );
      return item;
    })
  );
}

function buildResistLayer(layer, value) {
  return el("div", { class: "resist-layer" }, [
    tankLayerIcon(layer, 12),
    el("span", { class: "resist-track" }, [el("i", { style: { width: `${clampPct(value)}%` } })])
  ]);
}

// Build a fragment of SVG/HTML markup from a string.
function svg(markup) {
  const wrap = document.createElement("span");
  wrap.style.display = "inline-flex";
  wrap.innerHTML = markup;
  return wrap;
}

function chip(text, tone = "") {
  return el("span", { class: tone ? `chip is-${tone}` : "chip", text });
}

function detectNpcRole(npc) {
  const name = String(npc?.type_name || "");
  const m = name.match(/\s*[-–—]\s*(trigger|objective)\b.*$/i);
  if (!m) return { displayName: name, role: null, roleDetail: null };
  return {
    displayName: name.slice(0, m.index).trim() || name,
    role: m[1].toLowerCase(),
    roleDetail: m[0].replace(/^\s*[-–—]\s*/, "").trim()
  };
}

function buildNpcImage(npc) {
  if (npc.type_id) {
    const img = el("img", {
      src: `https://images.evetech.net/types/${npc.type_id}/icon?size=64`,
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerPolicy: "no-referrer"
    });
    img.addEventListener("error", () => {
      img.replaceWith(buildFallbackBadge(npc));
    });
    return img;
  }
  return buildFallbackBadge(npc);
}

function buildFallbackBadge(npc) {
  const cleaned = (npc.type_name || "?")
    .replace(/\b(Navy|Fleet|Ammatar|Imperial|Republic|Federation|Caldari|Khanid|State|Federal|Domination|Arch|Dread)\b/gi, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return el("div", { class: "img-fallback", text: cleaned || "?" });
}

// Collapse exact-duplicate effects (scrape artifact) into one entry; keep distinct ones.
function dedupEwar(ewarList) {
  const seen = new Set();
  const out = [];
  for (const effect of ewarList || []) {
    const detailText = effect?.detail || effect?.text;
    const map = ewarMapping(effect?.type, detailText);
    const key = `${map.kind}|${detailText || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      map,
      detailText,
      parsed: parseEwarText(detailText),
      severity: EWAR_META[map.kind]?.severity ?? "warning",
      raw: effect
    });
  }
  return out;
}

function ewarParamSpans(parsed) {
  return [
    parsed.gjPerSec != null ? el("span", { class: "ep-stat ep-gj", text: `${parsed.gjPerSec} GJ/s` }) : null,
    parsed.rangeKm != null
      ? el("span", {
          class: "ep-stat ep-range",
          text: parsed.rangeKmMin != null ? `${parsed.rangeKmMin}–${parsed.rangeKm} km` : `${parsed.rangeKm} km`
        })
      : null,
    parsed.strengthPct != null ? el("span", { class: "ep-stat ep-str", text: `${parsed.strengthPct}%` }) : null,
    parsed.chancePct != null ? el("span", { class: "ep-stat ep-chance", text: `${parsed.chancePct}%ch` }) : null,
    parsed.points != null ? el("span", { class: "ep-stat ep-pts", text: `${parsed.points}pt` }) : null
  ].filter(Boolean);
}

// ---- shared NPC sub-sections (used by compact rows and the dense expand drawer) ----

function physStatsOf(npc) {
  const optimalRange = numOrZero(npc.turret_range) || numOrZero(npc.missile_range);
  const stats = [];
  if (npc.signature_radius != null) stats.push(["Sig", formatN(npc.signature_radius)]);
  if (optimalRange > 0) stats.push(["Rng", formatKm(optimalRange)]);
  if (npc.max_velocity != null) stats.push(["Vel", formatN(npc.max_velocity)]);
  if (npc.orbit_distance != null) stats.push(["Orbit", formatKm(npc.orbit_distance)]);
  if (npc.orbit_velocity != null) stats.push(["OrbVel", formatN(npc.orbit_velocity)]);
  if (npc.defender_chance_pct != null && numOrZero(npc.defender_chance_pct) > 0) {
    stats.push(["Def", `${Math.round(numOrZero(npc.defender_chance_pct))}%`, "Defender missile launch chance"]);
  }
  return stats;
}

function buildPhysSection(npc) {
  const stats = physStatsOf(npc);
  return el("section", { class: "npc-physical" }, [
    el("span", { class: "col-label", text: "Physical" }),
    stats.length
      ? el(
          "div",
          { class: "npc-phys-inline" },
          stats.map(([k, v, title]) =>
            el("span", { class: "ps", title: title || k }, [
              el("span", { class: "ps-key", text: k }),
              el("b", { class: "ps-val", text: v })
            ])
          )
        )
      : el("span", { class: "ps-empty", text: "—" })
  ]);
}

function buildHpSection(npc) {
  const maxHp = Math.max(numOrZero(npc.shield_hp), numOrZero(npc.armor_hp), numOrZero(npc.hull_hp), 1);
  const layer = (key, cls) => {
    const val = numOrZero(npc[`${key}_hp`]);
    return el("div", { class: `layer ${cls}` }, [
      tankLayerIcon(key, 14),
      el("span", { class: "bar" }, [el("i", { style: { width: `${(val / maxHp) * 100}%` } })]),
      el("span", { class: "val", text: formatN(val) })
    ]);
  };
  return el("section", { class: "npc-hp" }, [
    el("span", { class: "col-label", text: "HP layers" }),
    layer("shield", "s"),
    layer("armor", "a"),
    layer("hull", "h")
  ]);
}

function buildResistSection(npc) {
  const rows = DAMAGE_TYPES.map((t) => ({
    ...t,
    shield: Math.round(numOrZero(npc[`resist_shield_${t.key}`])),
    armor: Math.round(numOrZero(npc[`resist_armor_${t.key}`]))
  }));
  return el("section", { class: "npc-resists" }, [
    el("span", { class: "col-label", text: "Deal to — lower % = better" }),
    buildResistChart(rows)
  ]);
}

function buildDpsSection(npc) {
  const dpsByType = npcDpsByType(npc);
  const total = dpsByType.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    return el("section", { class: "npc-dps" }, [
      el("span", { class: "col-label", text: "Tank against" }),
      el("div", { class: "non-combat", text: "Non-combatant" })
    ]);
  }
  const maxDps = Math.max(...dpsByType.map((x) => x.value), 1);
  const dpsActive = profileIsActive(activeProfile);
  return el("section", { class: "npc-dps" }, [
    el("span", { class: "col-label", text: `Tank against · ${Math.round(total)} ${dpsActive ? "eff DPS" : "DPS"}` }),
    buildDamageChart(
      dpsByType.map((d) => ({
        ...d,
        valueText: d.value === 0 ? "—" : Math.round(d.value).toString(),
        title: `${d.full}: ${Math.round(d.value)} ${dpsActive ? "eff DPS" : "DPS"}${dpsActive ? ` (raw ${Math.round(d.raw)})` : ""}`
      })),
      "npc-dps-chart",
      { maxValue: maxDps }
    )
  ]);
}

function buildEwarSection(npc) {
  const list = dedupEwar(npc.ewar);
  const children = [el("span", { class: "col-label", text: "EWAR" })];
  if (!list.length) {
    children.push(el("div", { class: "empty", text: "None" }));
    return el("section", { class: "npc-ewar" }, children);
  }
  for (const e of list) {
    const params = ewarParamSpans(e.parsed);
    const chipEl = el("div", { class: `chip is-${e.severity}`, title: e.raw?.text || e.raw?.detail || "" }, [
      ewarIcon(e.map.kind, 18),
      el("span", { class: "lab", text: e.map.label })
    ]);
    if (params.length) chipEl.append(el("div", { class: "ewar-params" }, params));
    children.push(chipEl);
  }
  return el("section", { class: "npc-ewar" }, children);
}

// ---- compact card row ----
function buildNpcRow(npc) {
  const structure = isStructure(npc);
  const qty = npcQty(npc);
  const role = detectNpcRole(npc);

  const meta = el("div", { class: "meta" }, [
    el("span", { class: "qty-chip", text: `×${qty}` }),
    role.role === "objective"
      ? el("span", { class: "role-chip is-objective", title: role.roleDetail, text: "Objective" })
      : null,
    role.role === "trigger"
      ? el("span", { class: "role-chip is-trigger", title: role.roleDetail, text: "Trigger" })
      : null,
    npc.ship_class ? el("span", { class: "class-chip", text: structure ? "Structure" : npc.ship_class }) : null,
    npc.bounty_isk ? el("span", { text: formatIsk(npc.bounty_isk) }) : null
  ]);
  const identity = el("section", { class: "npc-identity" }, [
    buildNpcImage(npc),
    el("div", { class: "nm" }, [
      el("strong", { title: npc.type_name, text: role.displayName }),
      meta,
      npc.notes ? el("div", { class: "notes", text: npc.notes }) : null
    ])
  ]);

  const rowClasses = ["npc-row"];
  if (structure) rowClasses.push("structure");
  if (role.role === "objective") rowClasses.push("is-objective");
  if (role.role === "trigger") rowClasses.push("is-trigger");
  if ((npc.ewar || []).length) rowClasses.push("has-ewar");

  return el("div", { class: rowClasses.join(" ") }, [
    identity,
    buildPhysSection(npc),
    buildHpSection(npc),
    buildResistSection(npc),
    buildDpsSection(npc),
    buildEwarSection(npc)
  ]);
}

// ---- dense table row (one line + click to expand) ----
function buildDenseHeader() {
  const h = (t, cls = "") => el("span", { class: `dh-l ${cls}`.trim(), text: t });
  return el("div", { class: "npc-dense-head" }, [
    el("span", {}),
    h("NPC"),
    h("Sig", "dh-r"),
    h("Range", "dh-r"),
    h("Vel", "dh-r"),
    h("HP", "dh-r"),
    ...DAMAGE_TYPES.map((t) => el("span", { class: "dh-ic", title: `Deal to: ${t.full} resist %` }, [damageIcon(t.key, 16)])),
    h("DPS"),
    h("EWAR"),
    el("span", {})
  ]);
}

function buildDenseRow(npc) {
  const structure = isStructure(npc);
  const qty = npcQty(npc);
  const role = detectNpcRole(npc);
  const totalHp = numOrZero(npc.shield_hp) + numOrZero(npc.armor_hp) + numOrZero(npc.hull_hp);
  const dpsByType = npcDpsByType(npc);
  const totalDps = dpsByType.reduce((s, x) => s + x.value, 0);

  const resistCells = DAMAGE_TYPES.map((t) => {
    const s = Math.round(numOrZero(npc[`resist_shield_${t.key}`]));
    const a = Math.round(numOrZero(npc[`resist_armor_${t.key}`]));
    const avg = Math.round((s + a) / 2);
    return el(
      "span",
      { class: `dense-resist r-${classifyResist(avg)}`, title: `${t.full}: shield ${s}% / armor ${a}% (avg ${avg}% resist — lower is better)` },
      [damageIcon(t.key, 15), el("span", { class: "dr-pct", text: `${avg}%` })]
    );
  });

  const dpsCell = totalDps > 0
    ? el("span", { class: "dense-dps", title: `${Math.round(totalDps)} DPS · ${dpsByType.filter((d) => d.value > 0).map((d) => `${d.full} ${Math.round(d.value)}`).join(", ")}` }, [
        el("span", { class: "dd-icons" }, dpsByType.map((d) => el("span", { class: "dd-slot" }, d.value > 0 ? [damageIcon(d.key, 15)] : []))),
        el("span", { class: "dd-num", text: formatN(totalDps) })
      ])
    : el("span", { class: "dense-dps dash", text: "—" });

  const ewarList = dedupEwar(npc.ewar);
  const ewarCell = el("span", { class: "dense-ewar" }, ewarList.length
    ? ewarList.map((e) => el("span", { class: `dense-ewar-chip is-${e.severity}`, title: e.raw?.text || e.raw?.detail || "" }, [ewarIcon(e.map.kind, 16), el("span", { class: "dec-lab", text: e.map.label })]))
    : [el("span", { class: "dense-dash", text: "—" })]);

  const nameWrap = el("div", { class: "dense-name" }, [
    el("strong", { title: npc.type_name, text: role.displayName }),
    qty > 1 ? el("span", { class: "qty-chip", text: `×${qty}` }) : null,
    role.role === "objective" ? el("span", { class: "role-chip is-objective", title: role.roleDetail, text: "Obj" }) : null,
    role.role === "trigger" ? el("span", { class: "role-chip is-trigger", title: role.roleDetail, text: "Trig" }) : null,
    npc.ship_class ? el("span", { class: "dense-class", text: structure ? "Structure" : npc.ship_class }) : null
  ]);

  const optimalRange = numOrZero(npc.turret_range) || numOrZero(npc.missile_range);
  const hpLayers = [["shield", numOrZero(npc.shield_hp)], ["armor", numOrZero(npc.armor_hp)], ["hull", numOrZero(npc.hull_hp)]];
  const domHp = hpLayers.slice().sort((a, b) => b[1] - a[1])[0];
  const hpCell = totalHp > 0
    ? el("span", { class: "dense-hp", title: `${formatN(totalHp)} total HP · mostly ${TANK_LAYER_ICONS[domHp[0]].label}` }, [tankLayerIcon(domHp[0], 15), el("span", { class: "dh-num", text: formatN(totalHp) })])
    : el("span", { class: "dense-hp dash", text: "—" });
  const numCell = (val, title) => el("span", { class: "dense-num" + (val === "—" ? " dash" : ""), title }, val);

  const rowClasses = ["npc-dense"];
  if (structure) rowClasses.push("structure");
  if (role.role === "objective") rowClasses.push("is-objective");
  if (role.role === "trigger") rowClasses.push("is-trigger");
  if (ewarList.length) rowClasses.push("has-ewar");

  const row = el("div", { class: rowClasses.join(" "), role: "button", tabindex: "0" }, [
    el("div", { class: "dense-img" }, [buildNpcImage(npc)]),
    nameWrap,
    numCell(formatN(npc.signature_radius), "Signature radius (m)"),
    numCell(formatKm(optimalRange), "Optimal weapon range"),
    numCell(formatN(npc.max_velocity), "Max velocity (m/s)"),
    hpCell,
    ...resistCells,
    dpsCell,
    ewarCell,
    el("span", { class: "dense-chev", text: "›" })
  ]);

  let detail = null;
  const toggle = () => {
    if (detail) {
      detail.remove();
      detail = null;
      row.classList.remove("open");
      return;
    }
    row.classList.add("open");
    detail = el("div", { class: "dense-detail" }, [
      buildPhysSection(npc),
      buildHpSection(npc),
      buildResistSection(npc),
      buildDpsSection(npc),
      buildEwarSection(npc)
    ]);
    row.after(detail);
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return row;
}

function buildCombatRibbon(stats, options = {}) {
  if (!stats || (stats.totalDps <= 0 && stats.ewar.length === 0 && !stats.neutGjPerSec)) return null;
  const ribbon = el("div", { class: `combat-ribbon ${options.size === "lg" ? "lg" : "sm"}` });

  if (stats.totalDps > 0) {
    const dpsSev = dpsSeverity(stats.totalDps);
    const dpsChip = el("span", { class: `combat-ribbon-dps is-${dpsSev}` });
    dpsChip.append(
      el("span", { class: "lab", text: "DPS" }),
      el("strong", { text: formatN(Math.round(stats.totalDps)) })
    );
    ribbon.append(dpsChip);

    const topTypes = stats.dpsByType
      .filter((d) => d.value > 0 && d.pct >= 10)
      .sort((a, b) => b.value - a.value);
    if (topTypes.length > 0) {
      const types = el("span", { class: "combat-ribbon-types" });
      for (const t of topTypes) {
        const tag = el("span", {
          class: `combat-ribbon-type damage-${t.key}`,
          title: `${t.full}: ${Math.round(t.value)} DPS (${t.pct}%)`,
          style: { color: DAMAGE_COLORS[t.key] }
        });
        tag.append(damageIcon(t.key, 11), el("span", { text: `${t.pct}%` }));
        types.append(tag);
      }
      ribbon.append(types);
    }
  }

  for (const entry of stats.ewar) {
    const c = el("div", {
      class: `ewar-summary-chip is-${entry.severity}`,
      title: `${entry.label} on ${entry.count} ship${entry.count === 1 ? "" : "s"}`
    });
    c.append(
      ewarIcon(entry.kind, 12),
      el("span", { class: "lab", text: entry.label }),
      el("span", { class: "count", text: `×${entry.count}` })
    );
    ribbon.append(c);
  }

  if (stats.neutGjPerSec > 0) {
    const sev = stats.neutGjPerSec >= 100 ? "danger" : stats.neutGjPerSec >= 30 ? "warning" : "info";
    ribbon.append(
      el("span", { class: `combat-ribbon-neut is-${sev}`, title: "Incoming cap neutralisation per second across this scope" }, [
        ewarIcon("neut", 11),
        el("b", { text: `${Math.round(stats.neutGjPerSec)} GJ/s` })
      ])
    );
  }

  return ribbon;
}

function buildPocket(pocket) {
  const groups = pocket.groups || [];
  const npcCount = groups.reduce((s, g) => s + (g.npcs || []).reduce((n, x) => n + npcQty(x), 0), 0);
  const pocketStats = aggregateCombatStats(flattenNpcs({ pockets: [pocket] }), activeProfile);
  const head = el("header", { class: "pocket-head" }, [
    el("div", { class: "pocket-head-text" }, [
      el("h2", { text: pocket.name || `Pocket ${(pocket.pocket_index ?? 0) + 1}` }),
      el("div", {
        class: "pocket-sub",
        text: `${groups.length} group${groups.length === 1 ? "" : "s"} · ${npcCount} ship${npcCount === 1 ? "" : "s"}`
      })
    ]),
    buildCombatRibbon(pocketStats, { size: "lg" })
  ]);

  const section = el("section", { class: "pocket" }, [head]);
  if (rowStyle === "dense") section.append(buildDenseHeader());

  for (const group of groups) {
    const isObjective = /\bobjective\b/i.test(group.label ?? "");
    const groupStats = aggregateCombatStats(group.npcs || [], activeProfile);
    const groupHead = el("header", { class: "group-head" }, [
      el("h3", { text: group.label || `Group ${(group.group_index ?? 0) + 1}` }),
      isObjective ? chip("Objective", "success") : null,
      group.optional ? chip("Optional", "warning") : null,
      buildCombatRibbon(groupStats, { size: "sm" })
    ]);
    if (group.trigger_text) {
      const triggerSvg = svg(
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 2 22h20L12 2Z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.7" fill="currentColor"/></svg>'
      );
      const trigger = el("div", { class: "trigger" });
      trigger.append(triggerSvg, document.createTextNode(group.trigger_text));
      groupHead.append(trigger);
    }
    const anyEwar = (group.npcs || []).some((n) => (n.ewar || []).length);
    const body = el("div", { class: "group-body" + (anyEwar ? "" : " no-group-ewar") });
    for (const npc of group.npcs || []) {
      body.append(rowStyle === "dense" ? buildDenseRow(npc) : buildNpcRow(npc));
    }
    const classes = ["group"];
    if (isObjective) classes.push("is-objective");
    if (group.optional) classes.push("is-optional");
    section.append(el("div", { class: classes.join(" ") }, [groupHead, body]));
  }

  return section;
}

// "Deal these" resistance spectrum (hero cell): a Best→Worst gradient rail with each
// damage type as an EVE-damage-icon pin, % + label below. Markers are evenly spaced in
// best→worst order (the exact resist is the label, not the x — a narrow cell can't place
// four absolute points without overlap when resists cluster). Pin colour follows the
// relative rank (softest target always green), so an all-high-resist mission still reads
// a clear best→worst instead of four reds.
function buildDealSpectrum(summary) {
  const article = el("article", { class: "deal-spectrum" }, [el("span", { class: "label", text: "Deal these" })]);
  if (!summary.dealWeight) {
    article.append(el("div", { class: "value" }, [el("span", { class: "small", text: "No resists listed" })]));
    return article;
  }
  const ranks = dealRankClasses(summary.deal);
  const n = summary.deal.length;
  const plot = el("div", { class: "ds-plot" }, [
    el("span", { class: "ds-end ds-end-best", text: "Best" }),
    el("span", { class: "ds-end ds-end-worst", text: "Worst" }),
    el("span", { class: "ds-rail" }),
    el("span", { class: "ds-dot ds-dot-l" }),
    el("span", { class: "ds-dot ds-dot-r" })
  ]);
  summary.deal.forEach((t, i) => {
    const avg = Math.round(t.avg);
    plot.append(
      el(
        "div",
        {
          class: `ds-marker ${ranks[i]}${i === 0 ? " best" : ""}`,
          style: { left: `${((i + 0.5) / n) * 100}%` },
          title: `${t.label}: ${avg}% HP-weighted avg resist`
        },
        [
          el("span", { class: "ds-pin" }, [damageIcon(t.key, 17)]),
          el("span", { class: "ds-stem" }),
          el("b", { class: "ds-val", text: `${avg}%` }),
          el("span", { class: "ds-name", text: t.short })
        ]
      )
    );
  });
  article.append(plot, el("span", { class: "ds-foot cell-foot", text: "Lower resist is better" }));
  return article;
}

function buildHero(mission, summary, objectiveSection) {
  const crumbBits = [];
  if (mission.arc?.faction) crumbBits.push(mission.arc.faction);
  if (mission.arc?.name) crumbBits.push(mission.arc.name);
  if (mission.arc?.starting_system) crumbBits.push(mission.arc.starting_system);
  const crumb = crumbBits.join(" · ");

  const tags = [chip(`Level ${mission.level}`, "lvl")];
  if (mission.mission_type) tags.push(chip(mission.mission_type));
  if (mission.faction) tags.push(chip(mission.faction, "warning"));
  const spaceRisk = describeSpaceRisk(mission.space_risk);
  if (spaceRisk) tags.push(chip(spaceRisk.label, spaceRisk.severity));
  if (mission.arc?.name) tags.push(chip(`Arc · ${mission.arc.name}`, "info"));
  if (profileIsActive(activeProfile)) tags.push(chip(`Eff DPS · ${summarizeProfile(activeProfile)}`, "success"));

  const head = el("div", { class: "mission-hero-head" }, [
    el("div", { class: "mission-hero-title" }, [
      crumb ? el("div", { class: "crumb", text: crumb }) : null,
      el("div", { class: "title-row" }, [el("h1", { text: mission.name || "Mission" }), el("div", { class: "mission-hero-tags" }, tags)])
    ])
  ]);

  const dpsActive = profileIsActive(activeProfile);

  // Tank against
  const tankArticle = el("article", null, [el("span", { class: "label", text: dpsActive ? "Tank against · effective" : "Tank against" })]);
  if (summary.tank.length === 0 || summary.tank.every((t) => t.value === 0)) {
    tankArticle.append(el("div", { class: "value" }, [el("span", { class: "small", text: "No DPS listed" })]));
  } else {
    tankArticle.append(
      buildDamageChart(
        summary.tank.map((t) => ({
          ...t,
          chartValue: t.pct,
          valueText: `${t.pct}% · ${formatN(t.value)} ${dpsActive ? "eff" : "DPS"}`,
          title: `${t.full || t.label}: ${t.pct}% incoming · ${formatN(t.value)} ${dpsActive ? "eff DPS" : "DPS"}${dpsActive ? ` (raw ${formatN(t.raw)})` : ""}`
        })),
        "tank-summary-chart",
        { percent: true }
      )
    );
    tankArticle.append(
      el("span", {
        class: "label cell-foot",
        text: `Peak ${Math.round(summary.peakDps)} ${dpsActive ? "eff DPS" : "DPS"} · ${summary.peakPocket}`
      })
    );
  }

  // EWAR threats — vertical stat cards + neut meter.
  const ewarArticle = el("article", { class: "ewar-summary" }, [el("span", { class: "label", text: "EWAR threats" })]);
  if (!summary.ewar || summary.ewar.length === 0) {
    ewarArticle.append(el("div", { class: "value" }, [el("span", { class: "small", text: "None listed" })]));
  } else {
    const cards = el("div", { class: "ewar-cards" });
    for (const e of summary.ewar) {
      const stats = [];
      if (e.worstGj != null) stats.push(`${e.worstGj} GJ/s`);
      if (e.worstPts != null) stats.push(`${e.worstPts} pt`);
      if (e.worstStr != null) stats.push(`${e.worstStr}%`);
      if (e.worstRange != null) stats.push(`${e.worstRange} km`);
      if (e.worstChance != null) stats.push(`${e.worstChance}% chance`);
      cards.append(
        el("div", { class: `ewar-card is-${e.severity}` }, [
          el("div", { class: "ec-head" }, [ewarIcon(e.kind, 24), el("span", { class: "ec-label", text: e.label }), el("span", { class: "ec-count", text: `×${e.count}` })]),
          stats.length ? el("div", { class: "ec-stats" }, stats.map((s) => el("span", { class: "ec-stat", text: s }))) : null
        ])
      );
    }
    ewarArticle.append(cards);
    if (summary.neutGjPerSec > 0) {
      ewarArticle.append(
        el("div", { class: "neut-meter", title: "Worst single-pocket incoming cap neutralisation (all neut ships × qty)" }, [
          ewarIcon("neut", 14),
          el("span", { text: "Peak neut pressure" }),
          el("b", { text: `${Math.round(summary.neutGjPerSec)} GJ/s` })
        ])
      );
    }
  }

  // Mission overview — recommended ship, scope, and the grind size (ships + total HP).
  const pk = (mission.pockets || []).length;
  const missionCell = el("article", null, [
    el("span", { class: "label", text: "Recommended ship" }),
    el("div", { class: "value sp-ship", text: mission.recommended_ship || "—" }),
    el("div", { class: "cell-foot sp-meta" }, [
      el("span", {
        class: "label sp-pk",
        text: `${pk} pocket${pk === 1 ? "" : "s"} · ${summary.totalGroups} group${summary.totalGroups === 1 ? "" : "s"} · ${summary.totalShips} ships`
      }),
      el("span", { class: "label sp-pk", text: `~${formatN(summary.totalHp)} total HP` })
    ])
  ]);

  // Bottom band: objective beside EWAR, split adaptively — the EWAR cell sizes to its
  // card count (slim "None listed" column up to ~46% for five kinds) and the objective
  // flexes into the rest, so neither extreme wastes the row.
  return el("section", { class: "mission-hero" }, [
    head,
    el("div", { class: "mission-hero-strip hero-3" }, [tankArticle, buildDealSpectrum(summary), missionCell]),
    el("div", { class: "hero-bottom" }, [objectiveSection, ewarArticle])
  ]);
}

// Seed prose often ends in stray <br> runs that render as a dead band — trim both edges.
function trimBreaks(html) {
  return typeof html === "string"
    ? html.replace(/^(?:\s|<br\s*\/?>)+/i, "").replace(/(?:\s|<br\s*\/?>)+$/i, "")
    : html;
}

// Objective strip — the important answers (goal + gotchas + items); briefing is collapsed flavor.
function buildObjective(mission) {
  const children = [el("p", { class: "card-title", text: "Objective" })];
  const main = el("div", { class: "obj-main" }, [
    el("div", { class: "objective-summary", html: trimBreaks(mission.objective_html) || "<p>No objective text.</p>" })
  ]);
  const items = (mission.objective_items || []).filter((it) => it?.type_name);
  if (items.length) {
    main.append(
      el(
        "div",
        { class: "obj-items" },
        items.map((it) =>
          el("span", { class: "item" }, [
            el("span", { class: "qty", text: `${formatter.format(it.quantity)}×` }),
            document.createTextNode(it.type_name),
            it.role ? el("span", { class: "role", text: it.role.toLowerCase() }) : null
          ])
        )
      )
    );
  }
  children.push(main);
  if (mission.objective_notes) {
    children.push(
      el("div", { class: "objective-notes" }, [
        el("span", { class: "objective-notes-label", text: "Heads up" }),
        el("span", { class: "objective-notes-body", text: mission.objective_notes })
      ])
    );
  }
  const briefingHtml = trimBreaks(mission.briefing_html);
  if (briefingHtml) {
    children.push(
      el("details", { class: "briefing-collapse" }, [
        el("summary", {}, [document.createTextNode("Briefing")]),
        el("div", { class: "briefing-body", html: briefingHtml })
      ])
    );
  }
  return el("section", { class: "mission-card objective mission-objective" }, children);
}

function installDensityToggle(nav) {
  if (!nav) return;
  const btn = el("button", { class: "button ghost density-toggle", type: "button", title: "Toggle compact cards / dense table" });
  const sync = () => {
    btn.textContent = rowStyle === "dense" ? "Compact view" : "Dense view";
    btn.classList.toggle("is-active", rowStyle === "dense");
  };
  btn.addEventListener("click", () => {
    rowStyle = rowStyle === "dense" ? "compact" : "dense";
    try {
      localStorage.setItem("missions-row-style", rowStyle);
    } catch {
      /* ignore storage failures */
    }
    sync();
    if (activeMission) renderMission(activeMission);
  });
  sync();
  nav.prepend(btn);
}

function renderNeighbors(neighbors) {
  if (neighbors?.prev) {
    elements.prevMission.href = `/missions/${neighbors.prev.id}`;
    elements.prevMission.title = neighbors.prev.name;
    elements.prevMission.hidden = false;
  } else {
    elements.prevMission.hidden = true;
  }
  const options = neighbors?.next_options;
  if (options?.length > 1) {
    // Fork mission: a plain "Next" would pick a branch arbitrarily — send the user to
    // the in-page chooser instead.
    elements.nextMission.href = "#pathChoice";
    elements.nextMission.textContent = "Choose path";
    elements.nextMission.title = options.map((o) => (o.label ? `${o.label} — ${o.name}` : o.name)).join(" · ");
    elements.nextMission.hidden = false;
  } else if (neighbors?.next) {
    elements.nextMission.href = `/missions/${neighbors.next.id}`;
    elements.nextMission.textContent = "Next";
    elements.nextMission.title = neighbors.next.name;
    elements.nextMission.hidden = false;
  } else {
    elements.nextMission.hidden = true;
  }
}

// Fork missions ("Choose your path"): one card per outgoing arc edge, so the choice is
// explicit instead of the linear next pointer silently picking one branch.
function buildPathChoice(options) {
  const cards = options.map((option) => {
    const risk = describeSpaceRisk(option.space_risk);
    return el("a", { class: "path-option", href: `/missions/${option.id}` }, [
      el("div", { class: "po-text" }, [
        option.label ? el("span", { class: "po-label", text: option.label }) : null,
        el("strong", { class: "po-name", text: option.name }),
        el("div", { class: "po-meta" }, [
          option.mission_type ? chip(option.mission_type) : null,
          risk ? chip(risk.label, risk.severity) : null
        ])
      ]),
      el("span", { class: "po-arrow", "aria-hidden": "true", text: "→" })
    ]);
  });
  return el("section", { class: "mission-card path-choice", id: "pathChoice" }, [
    el("p", { class: "card-title", text: "Choose your path" }),
    el("p", { class: "path-choice-sub", text: "The arc branches here — pick the mission to continue with." }),
    el("div", { class: "path-options" }, cards)
  ]);
}

function renderMission(mission) {
  activeMission = mission;
  elements.title.textContent = mission.name || "Mission";
  const metaBits = [];
  if (mission.level != null) metaBits.push(`Level ${mission.level}`);
  if (mission.mission_type) metaBits.push(mission.mission_type);
  if (mission.faction) metaBits.push(mission.faction);
  const spaceRisk = describeSpaceRisk(mission.space_risk);
  if (spaceRisk) metaBits.push(spaceRisk.label);
  if (mission.arc?.name) metaBits.push(`Arc · ${mission.arc.name}`);
  elements.meta.textContent = metaBits.join(" · ");
  elements.sourceLink.href = mission.source_url || "/missions/";

  const summary = computeSummary(mission, activeProfile);
  const root = elements.root;
  root.replaceChildren(buildHero(mission, summary, buildObjective(mission)));

  const nextOptions = mission.neighbors?.next_options;
  if (nextOptions?.length > 1) root.append(buildPathChoice(nextOptions));

  const pocketsWrap = el("section", { class: `mission-pockets style-${rowStyle}` });
  for (const pocket of mission.pockets || []) {
    pocketsWrap.append(buildPocket(pocket));
  }
  root.append(pocketsWrap);

  // Unwrap chruker item links inside objective/briefing.
  for (const anchor of root.querySelectorAll('a[href^="item.php?type_id="]')) {
    anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
  }

  renderNeighbors(mission.neighbors || {});
}

function renderError(message) {
  elements.title.textContent = "Mission unavailable";
  elements.meta.textContent = message;
  elements.root.replaceChildren();
}

// Warm the browser/edge cache for the chain neighbors so prev/next navigation renders
// without waiting on the network. Called once after the initial load (not from
// renderMission, which re-runs on every fit-profile change).
function prefetchNeighbors(neighbors) {
  const seen = new Set();
  for (const neighbor of [neighbors?.prev, neighbors?.next, ...(neighbors?.next_options ?? [])]) {
    if (neighbor?.id == null || seen.has(neighbor.id)) continue;
    seen.add(neighbor.id);
    apiFetch(`/api/missions/${neighbor.id}`, { priority: "low" }).catch(() => {});
  }
}

onProfileChange((next) => {
  activeProfile = next;
  if (activeMission) renderMission(activeMission);
});

// Paint a structural skeleton into the otherwise-blank content column immediately, so the page
// shows shape while /api/missions/:id is in flight instead of an empty area under the header.
// renderMission (and renderError) replaceChildren over it when the request settles; #missionRoot
// is the last element on the page, so the skeleton->content swap shifts nothing above it.
function renderSkeleton() {
  elements.root.replaceChildren(
    el("div", { class: "mission-skeleton", "aria-hidden": "true" }, [
      el("div", { class: "skeleton-block sk-hero" }),
      el("div", { class: "skeleton-row" }, Array.from({ length: 4 }, () => el("div", { class: "skeleton-block sk-card" }))),
      el("div", { class: "skeleton-block sk-band" }),
      el("div", { class: "skeleton-block sk-band" })
    ])
  );
}

if (!missionId) {
  renderError("Missing mission id.");
} else {
  renderSkeleton();
  apiFetch(`/api/missions/${missionId}`)
    .then((response) => {
      if (!response.ok) throw responseError(response, "Mission");
      return response.json();
    })
    .then((mission) => {
      renderMission(mission);
      prefetchNeighbors(mission.neighbors);
    })
    .catch((error) => renderError(apiErrorMessage(error)));
}
