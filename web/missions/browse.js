import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import { installFitProfileButton } from "./fit-profile.js";
import { installBetaNotice } from "./beta-notice.js";
import { debounce } from "/shared/utils.js";
import { numberFormat as formatter } from "./formatters.js";

const elements = {
  search: document.querySelector("#missionSearch"),
  level: document.querySelector("#levelFilter"),
  faction: document.querySelector("#factionFilter"),
  type: document.querySelector("#typeFilter"),
  arc: document.querySelector("#arcFilter"),
  rows: document.querySelector("#missionRows"),
  missionCount: document.querySelector("#missionCount"),
  arcCount: document.querySelector("#arcCount"),
  filteredCount: document.querySelector("#filteredCount"),
  status: document.querySelector("#statusLine"),
  nav: document.querySelector(".missions-actions")
};
installFitProfileButton(elements.nav);
initializeDiagnostics();
installBetaNotice();

function cell(text, className = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  // phone cards hide placeholder cells entirely instead of stacking "n/a" rows
  if (text === "n/a") td.classList.add("na");
  td.textContent = text;
  td.title = text;
  return td;
}

function paramsFromControls() {
  const params = new URLSearchParams();
  if (elements.search.value.trim()) params.set("search", elements.search.value.trim());
  if (elements.level.value) params.set("level", elements.level.value);
  if (elements.faction.value) params.set("faction", elements.faction.value);
  if (elements.type.value) params.set("type", elements.type.value);
  if (elements.arc.value) params.set("arc", elements.arc.value);
  params.set("n", "200");
  return params;
}

function syncControlsFromUrl() {
  const params = new URLSearchParams(location.search);
  elements.search.value = params.get("search") ?? "";
  elements.level.value = params.get("level") ?? "";
  elements.faction.value = params.get("faction") ?? "";
  elements.type.value = params.get("type") ?? "";
  elements.arc.value = params.get("arc") ?? "";
}

function updateUrl(params) {
  const clean = new URLSearchParams(params);
  clean.delete("n");
  const query = clean.toString();
  history.replaceState(null, "", query ? `/missions/browse?${query}` : "/missions/browse");
}

function renderRows(rows) {
  elements.rows.replaceChildren();
  elements.filteredCount.textContent = formatter.format(rows.length);
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = cell("No missions match the current filters.", "empty-state");
    td.colSpan = 8;
    tr.append(td);
    elements.rows.append(tr);
    return;
  }

  for (const mission of rows) {
    const tr = document.createElement("tr");
    tr.className = "mission-row";
    tr.tabIndex = 0;
    tr.append(
      cell(mission.name, "mission-name"),
      cell(String(mission.level)),
      cell(mission.mission_type),
      cell(mission.faction ?? "n/a"),
      cell(mission.arc_name ?? "n/a"),
      cell(mission.damage_to_deal ?? "n/a"),
      cell(mission.damage_to_resist ?? "n/a"),
      cell(mission.recommended_ship ?? "n/a")
    );
    tr.addEventListener("click", () => {
      location.href = `/missions/${mission.mission_id}`;
    });
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter") location.href = `/missions/${mission.mission_id}`;
    });
    elements.rows.append(tr);
  }
}

function renderArcOptions(arcs) {
  const previous = elements.arc.value || new URLSearchParams(location.search).get("arc") || "";
  elements.arc.replaceChildren(new Option("All arcs", ""));
  for (const arc of arcs) {
    elements.arc.append(new Option(`${arc.name} L${arc.level}`, String(arc.arc_id)));
  }
  elements.arc.value = previous;
}

function renderFactionOptions(rows) {
  const previous = elements.faction.value || new URLSearchParams(location.search).get("faction") || "";
  const factions = [...new Set([
    ...rows.map((row) => row.faction).filter(Boolean),
    ...(previous ? [previous] : [])
  ])].sort((a, b) => a.localeCompare(b));
  elements.faction.replaceChildren(new Option("All factions", ""));
  for (const faction of factions) elements.faction.append(new Option(faction, faction));
  elements.faction.value = previous;
}

async function loadArcs() {
  const response = await apiFetch("/api/arcs");
  if (!response.ok) throw responseError(response, "Arc");
  const payload = await response.json();
  const arcs = payload.rows ?? [];
  elements.arcCount.textContent = formatter.format(arcs.length);
  renderArcOptions(arcs);
}

async function loadMissions() {
  const params = paramsFromControls();
  updateUrl(params);
  const response = await apiFetch(`/api/missions?${params.toString()}`);
  if (!response.ok) throw responseError(response, "Mission");
  const payload = await response.json();
  const rows = payload.rows ?? [];
  elements.missionCount.textContent = formatter.format(rows.length);
  renderFactionOptions(rows);
  renderRows(rows);
  elements.status.textContent = rows.length === 1 ? "1 mission visible" : `${rows.length} missions visible`;
}

const debouncedLoad = debounce(() => loadMissions().catch(renderError), 120);

function renderError(error) {
  elements.status.textContent = error?.status === 429 ? "Rate limit active" : "Mission data unavailable";
  elements.rows.replaceChildren();
  const tr = document.createElement("tr");
  const td = cell(apiErrorMessage(error), "empty-state error");
  td.colSpan = 8;
  tr.append(td);
  elements.rows.append(tr);
}

for (const control of [elements.search, elements.level, elements.faction, elements.type, elements.arc]) {
  control.addEventListener("input", debouncedLoad);
  control.addEventListener("change", debouncedLoad);
}

syncControlsFromUrl();
// The two endpoints are independent (missions render from controls/URL state, not arc
// data), so fetch them in parallel instead of serially.
Promise.all([loadArcs(), loadMissions()]).catch(renderError);
