import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import { renderArcDiagram } from "./arc-graph.js";
import { installFitProfileButton, onProfileChange } from "./fit-profile.js";
import { dpsFormat, numberFormat as formatter } from "./formatters.js";
import { el } from "./dom-util.js";
import { installBetaNotice } from "./beta-notice.js";
import { EWAR_META, normalizeEwarType } from "./missions-ewar.js";
import { DAMAGE_COLORS, DAMAGE_ICON_PATHS, DAMAGE_TYPES, EWAR_ICON_PATHS } from "./missions-util.js";
import { arcEmblem, ARC_PRESENTATION } from "./arc-meta.js";

const arcId = location.pathname.match(/\/missions\/arc\/(\d+)/)?.[1];
initializeDiagnostics();
installBetaNotice();
const elements = {
  title: document.querySelector("#arcTitle"),
  meta: document.querySelector("#arcMeta"),
  hero: document.querySelector("#arcHero"),
  graph: document.querySelector("#arcGraph"),
  nav: document.querySelector(".missions-actions")
};
installFitProfileButton(elements.nav);

let lastArc = null;

const MISSION_TYPE_LABELS = { ENCOUNTER: "combat", COURIER: "courier", TRAVEL: "travel", BRANCH: "choice" };
const MISSION_TYPE_ORDER = ["combat", "courier", "travel", "choice"];

function compactIsk(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return formatter.format(Math.round(value));
}

// Everything the hero shows is derived from the mission rows the page already
// fetches for the timeline: type mix, low/null legs, the summed incoming damage
// spectrum, EWAR presence per mission, and the highest single-pocket DPS.
function arcAggregates(arc) {
  const missions = arc.missions ?? [];
  const typeCounts = new Map();
  const risk = { lowsec: 0, nullsec: 0 };
  const dmg = { em: 0, therm: 0, kin: 0, exp: 0 };
  const ewarCounts = new Map();
  let toughest = null;

  for (const mission of missions) {
    const typeLabel = MISSION_TYPE_LABELS[mission.mission_type] ?? String(mission.mission_type ?? "other").toLowerCase();
    typeCounts.set(typeLabel, (typeCounts.get(typeLabel) ?? 0) + 1);

    const riskKey = String(mission.space_risk ?? "").toUpperCase();
    if (riskKey === "LOWSEC") risk.lowsec++;
    else if (riskKey === "NULLSEC" || riskKey === "WORMHOLE") risk.nullsec++;

    const peak = mission.peak_dps_by_type;
    if (peak && typeof peak === "object") {
      for (const key of Object.keys(dmg)) dmg[key] += Number(peak[key] ?? 0);
    }

    const kinds = new Set((mission.ewar_types ?? []).map((type) => normalizeEwarType(type)));
    for (const kind of kinds) ewarCounts.set(kind, (ewarCounts.get(kind) ?? 0) + 1);

    const peakDps = Number(mission.peak_dps ?? 0);
    if (peakDps > 0 && (!toughest || peakDps > Number(toughest.peak_dps))) toughest = mission;
  }

  const dmgTotal = Object.values(dmg).reduce((sum, value) => sum + value, 0);
  const dmgPct = Object.fromEntries(
    Object.entries(dmg).map(([key, value]) => [key, dmgTotal > 0 ? Math.round((value / dmgTotal) * 100) : 0])
  );
  const tankAdvice = DAMAGE_TYPES.filter((type) => dmgPct[type.key] >= 15)
    .sort((left, right) => dmgPct[right.key] - dmgPct[left.key])
    .map((type) => type.key)
    .join("/");

  const ewar = [...ewarCounts.entries()]
    .map(([kind, count]) => ({ kind, count, ...(EWAR_META[kind] ?? EWAR_META.other) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

  const mixLabel = [...MISSION_TYPE_ORDER, ...[...typeCounts.keys()].filter((key) => !MISSION_TYPE_ORDER.includes(key))]
    .filter((key) => typeCounts.has(key))
    .map((key) => `${typeCounts.get(key)} ${key}`)
    .join(" · ");

  return { missionCount: missions.length, mixLabel, risk, dmgTotal, dmgPct, tankAdvice, ewar, toughest };
}

// Per-mission space_risk is editorially curated and absent for some arcs, so
// derived leg counts only replace the hand-written risk label when they exist.
function riskBadges(arc, agg) {
  const meta = ARC_PRESENTATION[arc.arc_id] ?? {};
  const { lowsec, nullsec } = agg.risk;
  if (lowsec + nullsec === 0) {
    return meta.risk ? [el("span", { class: `badge-risk ${meta.risk.tone}`, text: meta.risk.label })] : [];
  }
  const hisec = agg.missionCount - lowsec - nullsec;
  if (hisec === 0 && lowsec === 0) return [el("span", { class: "badge-risk nullsec", text: "Nullsec" })];
  if (hisec === 0 && nullsec === 0) return [el("span", { class: "badge-risk lowsec", text: "Lowsec" })];
  const badges = [];
  if (hisec > 0) badges.push(el("span", { class: "badge-risk hisec", text: "Hisec route" }));
  if (lowsec > 0) badges.push(el("span", { class: "badge-risk lowsec", text: `${lowsec} lowsec leg${lowsec > 1 ? "s" : ""}` }));
  if (nullsec > 0) badges.push(el("span", { class: "badge-risk nullsec", text: `${nullsec} nullsec leg${nullsec > 1 ? "s" : ""}` }));
  return badges;
}

function securityTone(security) {
  if (security >= 0.45) return "sec-hisec";
  return security > 0 ? "sec-lowsec" : "sec-nullsec";
}

function guideLinkText(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${decodeURIComponent(url.pathname)}`;
  } catch {
    return "Mission guide";
  }
}

function identityCard(arc, agg) {
  const meta = ARC_PRESENTATION[arc.arc_id] ?? {};
  const facts = [];
  const fact = (label, children) => {
    facts.push(el("dt", { text: label }), el("dd", {}, children));
  };

  if (arc.starting_agent) fact("Entry agent", arc.starting_agent);
  if (arc.starting_system) {
    const parts = [
      el("a", {
        href: `https://evemaps.dotlan.net/system/${encodeURIComponent(arc.starting_system)}`,
        target: "_blank",
        rel: "noopener",
        text: arc.starting_system
      })
    ];
    if (typeof arc.starting_system_security === "number") {
      // + 0 collapses negative zero, so a -0.04 truesec renders "0.0" not "-0.0"
      const rounded = Math.round(arc.starting_system_security * 10) / 10 + 0;
      parts.push(" ", el("span", { class: securityTone(arc.starting_system_security), text: rounded.toFixed(1) }));
    }
    if (arc.starting_system_region) parts.push(` · ${arc.starting_system_region}`);
    fact("Staging", parts);
  }
  const badges = riskBadges(arc, agg);
  if (badges.length > 0) fact("Route", el("span", { class: "fact-badges" }, badges));
  fact("Missions", `${formatter.format(agg.missionCount)} — ${agg.mixLabel}`);
  if (meta.metaNote) fact("Cadence", meta.metaNote);
  if (arc.source_url) {
    fact("Guide", el("a", { href: arc.source_url, target: "_blank", rel: "noopener", text: guideLinkText(arc.source_url) }));
  }

  const payout = [];
  const payoutItem = (value, label, tone) =>
    el("span", { class: "arc-payout" }, [
      el("b", { class: tone ? `tone-${tone}` : null, text: value }),
      el("small", { text: label })
    ]);
  const rewardIsk = compactIsk(arc.total_reward_isk);
  if (rewardIsk) payout.push(payoutItem(`${rewardIsk} ISK`, "Mission payout"));
  const bonusIsk = compactIsk(arc.total_bonus_isk);
  if (bonusIsk) payout.push(payoutItem(`+${bonusIsk} ISK`, "Time bonuses"));
  if (Number(arc.total_reward_lp) > 0) payout.push(payoutItem(`${formatter.format(arc.total_reward_lp)} LP`, "Loyalty points"));
  for (const reward of meta.rewards ?? []) payout.push(payoutItem(reward.value, reward.label, reward.tone));

  return el("article", { class: "arc-hero-card arc-hero-identity" }, [
    el("div", { class: "arc-hero-head" }, [
      arcEmblem(arc),
      el("p", { class: "arc-flavor", text: meta.flavor ?? arc.description ?? "" })
    ]),
    el("dl", { class: "arc-hero-facts" }, facts),
    payout.length > 0 ? el("div", { class: "arc-hero-payout" }, payout) : null
  ]);
}

function damageRows(agg) {
  const maxPct = Math.max(...DAMAGE_TYPES.map((type) => agg.dmgPct[type.key]), 1);
  return el(
    "div",
    { class: "arc-dmg-rows" },
    DAMAGE_TYPES.map((type) => {
      const pct = agg.dmgPct[type.key];
      return el("div", { class: `arc-dmg-row${pct === 0 ? " zero" : ""}`, style: { color: DAMAGE_COLORS[type.key] } }, [
        el("img", { class: "eve-icon damage-icon", src: DAMAGE_ICON_PATHS[type.key], alt: type.full, title: type.full }),
        el("span", { class: "arc-dmg-label", text: type.label }),
        el("div", { class: "arc-dmg-track" }, [el("i", { style: { width: `${Math.round((pct / maxPct) * 100)}%` } })]),
        el("span", { class: "arc-dmg-value", text: `${pct}%` })
      ]);
    })
  );
}

// Same card language as the mission-detail EWAR summary; the arc payload has no
// effect params, so the stat line carries the mission count instead.
function ewarCards(agg) {
  return agg.ewar.map((item) =>
    el("div", { class: `ewar-card is-${item.severity}`, title: EWAR_ICON_PATHS[item.kind]?.label ?? item.label }, [
      el("div", { class: "ec-head" }, [
        EWAR_ICON_PATHS[item.kind] ? el("img", { class: "ewar-icon", src: EWAR_ICON_PATHS[item.kind].src, alt: "" }) : null,
        el("span", { class: "ec-label", text: item.label })
      ]),
      el("div", { class: "ec-stats" }, [
        el("span", { class: "ec-stat", text: `${item.count} mission${item.count > 1 ? "s" : ""}` })
      ])
    ])
  );
}

function intelCard(agg) {
  const blocks = [];
  if (agg.dmgTotal > 0) {
    blocks.push(
      el("div", { class: "arc-intel-block" }, [
        el("span", { class: "arc-intel-label", text: `Incoming damage — tank ${agg.tankAdvice}` }),
        damageRows(agg)
      ])
    );
  }
  if (agg.ewar.length > 0) {
    blocks.push(
      el("div", { class: "arc-intel-block" }, [
        el("span", { class: "arc-intel-label", text: "Electronic warfare" }),
        el("div", { class: "ewar-cards" }, ewarCards(agg))
      ])
    );
  }
  if (agg.toughest) {
    blocks.push(
      el("div", { class: "arc-intel-foot" }, [
        "Toughest fight: ",
        el("a", { href: `/missions/${agg.toughest.mission_id}`, text: agg.toughest.name }),
        el("b", { text: ` ~${dpsFormat.format(Math.round(agg.toughest.peak_dps))} DPS` })
      ])
    );
  }
  if (blocks.length === 0) return null;

  return el("article", { class: "arc-hero-card arc-hero-intel" }, [
    el("div", { class: "arc-intel-head" }, [
      el("span", { class: "arc-intel-title", text: "Combat intel" }),
      el("span", { class: "arc-intel-sub", text: `aggregated from ${formatter.format(agg.missionCount)} missions` })
    ]),
    ...blocks
  ]);
}

function renderArc(arc) {
  lastArc = arc;
  renderArcDiagram(elements.graph, arc, arc.missions ?? [], arc.edges ?? []);
  elements.title.textContent = arc.name;
  elements.meta.textContent = `${arc.faction} L${arc.level} epic arc`;

  const agg = arcAggregates(arc);
  const intel = intelCard(agg);
  elements.hero.dataset.faction = arc.faction ?? "";
  elements.hero.classList.toggle("no-intel", intel === null);
  elements.hero.replaceChildren(identityCard(arc, agg), ...(intel ? [intel] : []));
  elements.hero.hidden = false;
}

onProfileChange(() => {
  if (lastArc) renderArc(lastArc);
});

function renderError(message) {
  elements.title.textContent = "Arc unavailable";
  elements.meta.textContent = message;
}

// No content skeleton here on purpose: the arc hero is hidden until data and reveals above the
// graph, so any *visible* placeholder in the graph would be shoved down when the hero appears
// (measured CLS 0.25 with a graph skeleton vs 0.015 with the graph left empty). The header's
// "Loading arc." copy is the load affordance; the graph fills from empty, shifting nothing.
if (!arcId) {
  renderError("Missing arc id.");
} else {
  apiFetch(`/api/arcs/${arcId}`)
    .then((response) => {
      if (!response.ok) throw responseError(response, "Arc");
      return response.json();
    })
    .then(renderArc)
    .catch((error) => renderError(apiErrorMessage(error)));
}
