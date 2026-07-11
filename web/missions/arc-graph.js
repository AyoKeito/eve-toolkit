import { arcMissionPositionLabels, orderedArcMissions } from "./arc-order.js";
import { loadProfile, effectiveMultiplier, profileIsActive, dpsSeverity } from "./fit-profile.js";
import { dpsFormat as dpsFormatter } from "./formatters.js";
import { describeEwar } from "./missions-ewar.js";
import { describeSpaceRisk } from "./missions-util.js";

const DAMAGE_KEYS = ["em", "therm", "kin", "exp"];

function missionEffectivePeakDps(mission, profile) {
  const byType = mission.peak_dps_by_type;
  if (byType && typeof byType === "object" && profileIsActive(profile)) {
    let total = 0;
    for (const key of DAMAGE_KEYS) {
      total += Number(byType[key] ?? 0) * effectiveMultiplier(profile, key);
    }
    return total;
  }
  return Number(mission.peak_dps ?? 0);
}
function stepKey(mission) {
  return mission.arc_position == null ? `mission:${mission.mission_id}` : `position:${mission.arc_position}`;
}

function stepLabel(mission) {
  return mission.arc_position == null ? "-" : String(mission.arc_position);
}

function describePeakDps(value, options = {}) {
  const dps = Number(value);
  if (!Number.isFinite(dps) || dps <= 0) return null;
  const suffix = options.effective ? "eff DPS" : "DPS";
  return {
    value: Math.round(dps),
    label: `${dpsFormatter.format(Math.round(dps))} ${suffix}`,
    severity: dpsSeverity(dps)
  };
}

function higherSpaceRisk(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.rank > left.rank ? right : left;
}

function appendMetaText(container, parts) {
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return;
  const span = document.createElement("span");
  span.className = "arc-graph-meta-text";
  span.textContent = text;
  container.append(span);
}

function appendDpsChip(container, peak) {
  if (!peak) return;
  const chip = document.createElement("span");
  chip.className = `arc-graph-chip dps-chip is-${peak.severity}`;
  const label = document.createElement("span");
  label.className = "arc-graph-chip-label";
  label.textContent = "DPS";
  const value = document.createElement("strong");
  value.textContent = peak.label;
  chip.append(label, value);
  container.append(chip);
}

function appendEwarChips(container, items) {
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = `arc-graph-chip ewar-chip is-${item.severity}`;
    chip.textContent = item.label;
    container.append(chip);
  }
}

function appendSpaceRiskChip(container, risk) {
  if (!risk) return;
  const chip = document.createElement("span");
  chip.className = `arc-graph-chip space-risk-chip is-${risk.severity}`;
  chip.textContent = risk.label;
  container.append(chip);
}

function buildMissionMeta(arc, mission) {
  const missionLevel = mission.level ?? arc?.level;
  const wrapper = document.createElement("div");
  wrapper.className = "arc-graph-meta";
  const spaceRisk = describeSpaceRisk(mission.space_risk);

  appendMetaText(wrapper, [
    missionLevel ? `L${missionLevel}` : null,
    mission.mission_type,
    mission.faction,
    spaceRisk?.label
  ]);

  const profile = loadProfile();
  const effective = profileIsActive(profile);
  const peakDps = missionEffectivePeakDps(mission, profile);
  appendSpaceRiskChip(wrapper, spaceRisk);
  appendDpsChip(wrapper, describePeakDps(peakDps, { effective }));
  appendEwarChips(wrapper, describeEwar(mission.ewar_types));

  return wrapper.children.length > 0 ? wrapper : null;
}

export function missionMeta(arc, mission) {
  const missionLevel = mission.level ?? arc?.level;
  const peak = describePeakDps(mission.peak_dps);
  const ewar = describeEwar(mission.ewar_types);
  const spaceRisk = describeSpaceRisk(mission.space_risk);
  return [
    missionLevel ? `L${missionLevel}` : null,
    mission.mission_type,
    mission.faction,
    spaceRisk?.label,
    peak ? `Peak ${peak.label}` : null,
    ewar.length > 0 ? `EWAR ${ewar.map((item) => item.label).join(", ")}` : null
  ]
    .filter(Boolean)
    .join(" · ");
}

export function arcGraphSteps(missions) {
  const ordered = orderedArcMissions(missions ?? []);
  const steps = [];

  for (const mission of ordered) {
    const key = stepKey(mission);
    let step = steps.at(-1);
    if (!step || step.key !== key) {
      step = { key, label: stepLabel(mission), missions: [] };
      steps.push(step);
    }
    step.missions.push(mission);
  }

  return steps.map(({ label, missions: stepMissions }) => ({ label, missions: stepMissions }));
}

const MISSION_TYPE_SHORT = new Map([
  ["ENCOUNTER", "combat"],
  ["TRAVEL", "travel"],
  ["COURIER", "courier"],
  ["MINING", "mining"],
  ["TRADE", "trade"]
]);

function buildArcIndex(missions) {
  const byId = new Map();
  const incoming = new Map();
  for (const mission of missions) {
    byId.set(mission.mission_id, mission);
  }
  for (const mission of missions) {
    if (mission.next_mission_id != null) {
      incoming.set(mission.next_mission_id, (incoming.get(mission.next_mission_id) ?? 0) + 1);
    }
  }
  const mergePoints = new Set();
  for (const [id, count] of incoming) {
    if (count > 1) mergePoints.add(id);
  }
  return { byId, mergePoints };
}

function followBranchPath(startMission, index) {
  const path = [];
  let current = startMission;
  let safety = 100;
  while (current && safety-- > 0) {
    path.push(current);
    if (current.next_mission_id == null) break;
    const next = index.byId.get(current.next_mission_id);
    if (!next || index.mergePoints.has(next.mission_id)) break;
    current = next;
  }
  return path;
}

function summarizeBranchPath(path, profile) {
  const typeCounts = new Map();
  const ewarSet = new Set();
  const factionSet = new Set();
  let peakDps = 0;
  let spaceRisk = null;
  for (const mission of path) {
    const type = mission.mission_type ?? "";
    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const dps = missionEffectivePeakDps(mission, profile);
    if (Number.isFinite(dps) && dps > peakDps) peakDps = dps;
    spaceRisk = higherSpaceRisk(spaceRisk, describeSpaceRisk(mission.space_risk));
    for (const ewar of mission.ewar_types ?? []) ewarSet.add(ewar);
    if (mission.faction) factionSet.add(mission.faction);
  }
  const typeBreakdown = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${MISSION_TYPE_SHORT.get(type) ?? type.toLowerCase()}`)
    .join(" + ");
  return {
    missionCount: path.length,
    typeBreakdown,
    peakDps: peakDps > 0 ? peakDps : null,
    spaceRisk,
    ewar: [...ewarSet],
    factions: [...factionSet],
    firstMission: path[0] ?? null,
    lastMission: path.at(-1) ?? null
  };
}

function renderBranchSummary(step, index, positionLabels, profile) {
  const panel = document.createElement("section");
  panel.className = "arc-branch-summary";
  panel.setAttribute("aria-label", "How the branches differ");

  const heading = document.createElement("header");
  heading.className = "arc-branch-summary-heading";
  const title = document.createElement("span");
  title.className = "arc-branch-summary-title";
  title.textContent = "Branches diverge";
  const note = document.createElement("span");
  note.className = "arc-branch-summary-note";
  note.textContent = `Compare the ${step.missions.length} paths`;
  heading.append(title, note);
  panel.append(heading);

  const cards = document.createElement("div");
  cards.className = "arc-branch-summary-cards";

  const effective = profileIsActive(profile);

  step.missions.forEach((mission, branchIndex) => {
    const path = followBranchPath(mission, index);
    const summary = summarizeBranchPath(path, profile);
    const card = document.createElement("article");
    card.className = "arc-branch-summary-card";
    card.dataset.branchIndex = String(branchIndex);

    const cardHeader = document.createElement("div");
    cardHeader.className = "arc-branch-summary-card-header";
    const badge = document.createElement("span");
    badge.className = "arc-graph-node-badge";
    badge.textContent = positionLabels.get(mission.mission_id) ?? step.label;
    const name = document.createElement("a");
    name.href = `/missions/${mission.mission_id}`;
    name.textContent = mission.name;
    cardHeader.append(badge, name);
    card.append(cardHeader);

    const facts = document.createElement("div");
    facts.className = "arc-branch-summary-facts";
    const countText = `${summary.missionCount} mission${summary.missionCount === 1 ? "" : "s"}`;
    const breakdown = summary.typeBreakdown ? ` · ${summary.typeBreakdown}` : "";
    const riskText = summary.spaceRisk ? ` · ${summary.spaceRisk.label}` : "";
    const lead = document.createElement("span");
    lead.className = "arc-branch-summary-lead";
    lead.textContent = `${countText}${breakdown}${riskText}`;
    facts.append(lead);

    if (summary.factions.length > 0) {
      const faction = document.createElement("span");
      faction.className = "arc-branch-summary-faction";
      faction.textContent = summary.factions.slice(0, 2).join(", ");
      facts.append(faction);
    }
    card.append(facts);

    const chips = document.createElement("div");
    chips.className = "arc-branch-summary-chips";
    appendSpaceRiskChip(chips, summary.spaceRisk);
    appendDpsChip(chips, describePeakDps(summary.peakDps, { effective }));
    appendEwarChips(chips, describeEwar(summary.ewar));
    if (chips.children.length > 0) card.append(chips);

    cards.append(card);
  });

  panel.append(cards);
  return panel;
}

function buildMissionNode(arc, mission, badgeText, { choiceIndex } = {}) {
  const node = document.createElement("article");
  node.className = "arc-graph-node";
  if (choiceIndex != null) {
    node.classList.add("is-choice");
    node.dataset.branchIndex = String(choiceIndex);
  }
  if (mission.mission_type === "BRANCH") node.classList.add("is-branch-decision");
  node.dataset.missionId = String(mission.mission_id);
  if (mission.prev_mission_id != null) node.dataset.prevMissionId = String(mission.prev_mission_id);
  if (mission.next_mission_id != null) node.dataset.nextMissionId = String(mission.next_mission_id);

  const title = document.createElement("div");
  title.className = "arc-graph-node-title";
  const badge = document.createElement("span");
  badge.className = "arc-graph-node-badge";
  badge.textContent = badgeText;
  const link = document.createElement("a");
  link.href = `/missions/${mission.mission_id}`;
  link.textContent = mission.name;
  title.append(badge, link);
  node.append(title);

  const meta = buildMissionMeta(arc, mission);
  if (meta) node.append(meta);
  return node;
}

// Shared container setup for both renderers: marks the element as a graph, clears it,
// and renders the empty-state when there are no missions. Returns true when empty so
// the caller can bail out early.
function prepareGraphContainer(container, arc, missionCount) {
  container.classList.add("arc-graph");
  container.hidden = false;
  container.setAttribute("aria-label", `${arc?.name ?? "Mission arc"} mission diagram`);
  container.replaceChildren();
  if (missionCount === 0) {
    const empty = document.createElement("div");
    empty.className = "arc-graph-empty";
    empty.textContent = "No missions found for this arc.";
    container.append(empty);
    return true;
  }
  return false;
}

// Legacy step renderer: used when the arc has no explicit edges in the payload.
function renderArcSteps(container, arc, missions) {
  const steps = arcGraphSteps(missions);
  const ordered = steps.flatMap((step) => step.missions);
  const positionLabels = arcMissionPositionLabels(ordered);
  const missionCount = ordered.length;
  const stepCount = steps.length;
  if (!container) return { missionCount, stepCount };
  if (prepareGraphContainer(container, arc, missionCount)) return { missionCount, stepCount };

  const arcIndex = buildArcIndex(ordered);
  const profile = loadProfile();
  let prevIsSplit = false;
  for (const step of steps) {
    const isSplit = step.missions.length > 1;
    if (isSplit && !prevIsSplit) container.append(renderBranchSummary(step, arcIndex, positionLabels, profile));
    prevIsSplit = isSplit;

    const row = document.createElement("section");
    row.className = "arc-graph-step";
    if (isSplit) row.classList.add("is-split");
    const label = document.createElement("span");
    label.className = "arc-graph-step-label";
    label.textContent = step.label;
    const branches = document.createElement("div");
    branches.className = "arc-graph-branches";
    if (isSplit) branches.classList.add("is-split");

    step.missions.forEach((mission, branchIndex) => {
      branches.append(
        buildMissionNode(arc, mission, positionLabels.get(mission.mission_id) ?? step.label, {
          choiceIndex: isSplit ? branchIndex : null
        })
      );
    });
    row.append(label, branches);
    container.append(row);
  }
  return { missionCount, stepCount };
}

// --- Layered DAG renderer (used when the arc payload includes edges) ---

const PATH_PALETTE = ["#5b8cff", "#46c46a", "#e0a64b", "#c061d6", "#3fc7c2", "#e0648c", "#9aa4b2"];
const KNOWN_PATH_COLORS = new Map([
  ["hyasyoda", "#5b8cff"],
  ["nugoeihuvi", "#46c46a"],
  ["caldari state", "#e0a64b"]
]);
const NEUTRAL_EDGE = "#5a6472";

function pathColors(edges) {
  const map = new Map();
  let next = 0;
  for (const edge of edges) {
    const label = (edge.label ?? "").trim();
    if (!label || map.has(label)) continue;
    map.set(label, KNOWN_PATH_COLORS.get(label.toLowerCase()) ?? PATH_PALETTE[next++ % PATH_PALETTE.length]);
  }
  return map;
}

function computeDepths(missions, edges) {
  if (missions.every((mission) => mission.arc_position != null)) {
    return new Map(missions.map((mission) => [mission.mission_id, mission.arc_position]));
  }
  const out = new Map(missions.map((mission) => [mission.mission_id, []]));
  const indeg = new Map(missions.map((mission) => [mission.mission_id, 0]));
  for (const edge of edges) {
    if (!out.has(edge.from) || !indeg.has(edge.to)) continue;
    out.get(edge.from).push(edge.to);
    indeg.set(edge.to, indeg.get(edge.to) + 1);
  }
  const depth = new Map();
  const queue = [];
  for (const [id, d] of indeg) if (d === 0) (depth.set(id, 1), queue.push(id));
  while (queue.length) {
    const id = queue.shift();
    for (const to of out.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 1, (depth.get(id) ?? 1) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  for (const mission of missions) if (!depth.has(mission.mission_id)) depth.set(mission.mission_id, 1);
  return depth;
}

// Left-to-right lane order via DFS that follows edges in their declared order,
// so the rendered columns match the authored branch order.
function dfsOrder(missions, edges) {
  const out = new Map(missions.map((mission) => [mission.mission_id, []]));
  const indeg = new Map(missions.map((mission) => [mission.mission_id, 0]));
  for (const edge of edges) {
    if (out.has(edge.from)) out.get(edge.from).push(edge.to);
    if (indeg.has(edge.to)) indeg.set(edge.to, indeg.get(edge.to) + 1);
  }
  const roots = missions
    .filter((mission) => indeg.get(mission.mission_id) === 0)
    .sort((a, b) => (a.arc_position ?? 0) - (b.arc_position ?? 0) || a.mission_id - b.mission_id)
    .map((mission) => mission.mission_id);
  const order = new Map();
  let next = 0;
  const stack = [...roots].reverse();
  while (stack.length) {
    const id = stack.pop();
    if (order.has(id)) continue;
    order.set(id, next++);
    const children = out.get(id) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) if (!order.has(children[i])) stack.push(children[i]);
  }
  let fallback = next;
  for (const mission of missions) if (!order.has(mission.mission_id)) order.set(mission.mission_id, fallback++);
  return order;
}

function renderDagLegend(colors) {
  if (colors.size === 0) return null;
  const legend = document.createElement("div");
  legend.className = "arc-dag-legend";
  for (const [label, color] of colors) {
    const item = document.createElement("span");
    item.className = "arc-dag-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "arc-dag-legend-swatch";
    swatch.style.background = color;
    const text = document.createElement("span");
    text.textContent = label;
    item.append(swatch, text);
    legend.append(item);
  }
  return legend;
}

function drawConnectors(plane, svg, edges, nodeEls, colors) {
  const planeRect = plane.getBoundingClientRect();
  svg.setAttribute("width", String(plane.scrollWidth));
  svg.setAttribute("height", String(plane.scrollHeight));
  svg.setAttribute("viewBox", `0 0 ${plane.scrollWidth} ${plane.scrollHeight}`);
  svg.replaceChildren();
  for (const edge of edges) {
    const fromEl = nodeEls.get(edge.from);
    const toEl = nodeEls.get(edge.to);
    if (!fromEl || !toEl) continue;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - planeRect.left;
    const y1 = a.bottom - planeRect.top;
    const x2 = b.left + b.width / 2 - planeRect.left;
    const y2 = b.top - planeRect.top;
    const dy = Math.max(18, (y2 - y1) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", colors.get((edge.label ?? "").trim()) ?? NEUTRAL_EDGE);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
  }
}

function renderArcDag(container, arc, missions, edges) {
  const missionCount = missions.length;
  // Reuse the pure layout (also unit-tested via dagLayout) instead of recomputing
  // depths/order/layers here. layout.colors is an entry array; rebuild the Map the
  // legend + connector drawing expect, and resolve layer ids back to mission objects.
  const { layers, colors: colorEntries } = dagLayout(missions, edges);
  const positionLabels = arcMissionPositionLabels(missions);
  const stepCount = layers.length;
  if (!container) return { missionCount, stepCount };
  if (prepareGraphContainer(container, arc, missionCount)) return { missionCount, stepCount };

  const colors = new Map(colorEntries);
  const legend = renderDagLegend(colors);
  if (legend) container.append(legend);

  const plane = document.createElement("div");
  plane.className = "arc-dag-plane";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "arc-dag-edges");
  svg.setAttribute("aria-hidden", "true");
  plane.append(svg);

  const byId = new Map(missions.map((mission) => [mission.mission_id, mission]));
  const nodeEls = new Map();
  for (const layer of layers) {
    const row = document.createElement("section");
    row.className = "arc-dag-row";
    const rowMissions = layer.missionIds.map((id) => byId.get(id)).filter(Boolean);
    if (rowMissions.length > 1) row.classList.add("is-split");
    for (const mission of rowMissions) {
      const node = buildMissionNode(arc, mission, positionLabels.get(mission.mission_id) ?? String(layer.depth));
      nodeEls.set(mission.mission_id, node);
      row.append(node);
    }
    plane.append(row);
  }
  container.append(plane);

  const redraw = () => drawConnectors(plane, svg, edges, nodeEls, colors);
  requestAnimationFrame(redraw);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => redraw());
    observer.observe(plane);
  }

  return { missionCount, stepCount };
}

export function renderArcDiagram(container, arc, missions, edges) {
  if (Array.isArray(edges) && edges.length > 0) return renderArcDag(container, arc, missions, edges);
  return renderArcSteps(container, arc, missions);
}

// Pure layout used by the DAG renderer (and exercised directly by tests):
// groups missions into depth layers, orders each layer by the authored edge
// order, and resolves a colour per path label.
export function dagLayout(missions, edges) {
  const depths = computeDepths(missions, edges);
  const order = dfsOrder(missions, edges);
  const layerKeys = [...new Set(missions.map((mission) => depths.get(mission.mission_id)))].sort((a, b) => a - b);
  const layers = layerKeys.map((depth) => ({
    depth,
    missionIds: missions
      .filter((mission) => depths.get(mission.mission_id) === depth)
      .sort((a, b) => (order.get(a.mission_id) ?? 0) - (order.get(b.mission_id) ?? 0))
      .map((mission) => mission.mission_id)
  }));
  return { layers, colors: [...pathColors(edges)] };
}
