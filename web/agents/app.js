import { resolveCorpOption } from "/lp/ui-model.js";
import { apiErrorMessage, apiFetch, initializeDiagnostics } from "/shared/diagnostics.js";
import { debounce } from "/shared/utils.js";

const $ = (id) => document.getElementById(id);

const groupNouns = { system: "systems", station: "stations", constellation: "constellations", region: "regions" };

// Synthetic combobox entry that clears the corp filter and switches to the all-corporations view.
const ALL_CORPS = { corp_id: "", name: "All corporations" };

// The agent finder loads BasicAgent + storyline (6,7) + EpicArc (10) in one request so the
// Type segment switches client-side and the Basic view can mark systems that also host a
// storyline/epic agent. parseAgentTypeIds on the server validates and dedupes the list.
const AGENT_TYPE_IDS = "2,6,7,10";
const typeLabels = { all: "", basic: "Basic ", story: "Storyline ", epic: "Epic-arc " };

// Collapse an agent's raw type id into the three buckets the Type segment exposes.
function agentBucket(agent) {
  if (agent.agent_type_id === 10) return "epic";
  if (agent.agent_type_id === 6 || agent.agent_type_id === 7) return "story";
  return "basic";
}

// Agent level color scale (defined in style.css): low = cold/dim, high = hot/bright.
const levelColor = (level) => `var(--l${level})`;

const state = {
  corpOptions: [],
  corpById: new Map(),
  corpName: "",
  // "corp" when a corporation is picked, "all" when the field is empty (cross-corp hub finder).
  scope: "all",
  agents: [],
  emptyReason: null,
  group: "system",
  type: "all",
  sec: "all",
  level: "all",
  division: "all",
  locator: "all",
  // Minimum matching agents a hub must have to appear, as a string "1".."5" ("1" = no minimum).
  min: "1",
  hubQuery: "",
  selectedKey: null,
  loading: false
};

const scopeLabel = () => (state.scope === "all" ? "All corporations" : state.corpName);

// The all-corporations view ranks ~1600 systems / ~4700 stations; render only the densest top
// slice (the rest are reachable by filtering/searching) so a keystroke never rebuilds thousands
// of DOM rows. The status line still reports the true total.
const RANK_CAP = 300;

// EVE rounds true security to one decimal for display, except (0, 0.05) rounds up to 0.1
// so a positive-security system never shows 0.0.
function roundedSec(sec) {
  if (sec === null || sec === undefined) return null;
  if (sec > 0 && sec < 0.05) return 0.1;
  return Math.round(sec * 10) / 10;
}

function secLabel(sec) {
  const rounded = roundedSec(sec);
  return rounded === null ? "?" : rounded.toFixed(1);
}

// Official in-game security color table (developers.eveonline.com/docs/guides/system-security).
const secPalette = {
  "1.0": "#2c75e1",
  "0.9": "#399aeb",
  "0.8": "#4ecef8",
  "0.7": "#60dba3",
  "0.6": "#71e754",
  "0.5": "#f5ff83",
  "0.4": "#dc6c06",
  "0.3": "#ce440f",
  "0.2": "#bb1116",
  "0.1": "#731f1f"
};
const nullsecColor = "#8d3163";

function secColor(sec) {
  const rounded = roundedSec(sec);
  if (rounded === null || rounded <= 0) return nullsecColor;
  return secPalette[Math.min(rounded, 1).toFixed(1)] ?? nullsecColor;
}

function filteredAgents() {
  return state.agents.filter(
    (agent) =>
      (state.type === "all" || agentBucket(agent) === state.type) &&
      (state.sec === "all" || agent.risk_tier === state.sec) &&
      (state.level === "all" || String(agent.level) === state.level) &&
      (state.division === "all" || String(agent.division_id) === state.division) &&
      (state.locator === "all" || agent.is_locator === 1)
  );
}

// system_id -> { story, epic }: which systems also host a storyline/epic agent, regardless of
// the active Type tab. Drives the ★/◆ hub-row markers in the Basic view.
function systemExtras() {
  const map = new Map();
  for (const agent of state.agents) {
    const bucket = agentBucket(agent);
    if (bucket === "basic") continue;
    const entry = map.get(agent.system_id) ?? { story: false, epic: false };
    if (bucket === "story") entry.story = true;
    else entry.epic = true;
    map.set(agent.system_id, entry);
  }
  return map;
}

function sysMarksHtml(extra) {
  if (!extra || (!extra.story && !extra.epic)) return "";
  const marks =
    (extra.epic ? '<span class="sysmark epic" title="Epic-arc agent here">◆</span>' : "") +
    (extra.story ? '<span class="sysmark story" title="Storyline agent here">★</span>' : "");
  return `<span class="sysmarks">${marks}</span>`;
}

function describeSystem(agent) {
  return {
    key: agent.system_id,
    label: agent.system_name ?? `System ${agent.system_id}`,
    region: agent.region_name ?? "",
    security: agent.security_status,
    riskTier: agent.risk_tier
  };
}

// A station hub: finer than a system, so the label is the station and the system name moves into
// the subtitle. Every finder agent is stationed (in-space ones are filtered out), so station_id
// is reliable; the fallback only guards malformed rows.
function describeStation(agent) {
  return {
    key: agent.station_id ?? `s${agent.agent_id}`,
    label: agent.station_name ?? "In space",
    system: agent.system_name ?? "",
    region: agent.region_name ?? "",
    security: agent.security_status,
    riskTier: agent.risk_tier
  };
}

function describeGroup(agent) {
  if (state.group === "station") return describeStation(agent);
  if (state.group === "region") {
    return { key: agent.region_id ?? agent.region_name ?? 0, label: agent.region_name ?? "Unknown region", region: "" };
  }
  if (state.group === "constellation") {
    return {
      key: agent.constellation_id ?? `c${agent.system_id}`,
      label: agent.constellation_name ?? "Unknown constellation",
      region: agent.region_name ?? ""
    };
  }
  return describeSystem(agent);
}

// Groups agents by the chosen map unit and ranks the groups so the best mission hubs
// come first: most L5s, then most L4s, then total agents, then highest level, then name.
function rankedGroups(agents, describe) {
  const map = new Map();
  for (const agent of agents) {
    const meta = describe(agent);
    if (!map.has(meta.key)) map.set(meta.key, { ...meta, agents: [], systemIds: new Set() });
    const group = map.get(meta.key);
    group.agents.push(agent);
    group.systemIds.add(agent.system_id);
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.counts = [0, 0, 0, 0, 0, 0];
    for (const agent of group.agents) group.counts[agent.level] += 1;
    group.maxLevel = Math.max(...group.agents.map((agent) => agent.level));
  }
  groups.sort(
    (a, b) =>
      b.counts[5] - a.counts[5] ||
      b.counts[4] - a.counts[4] ||
      b.agents.length - a.agents.length ||
      b.maxLevel - a.maxLevel ||
      a.label.localeCompare(b.label)
  );
  return groups;
}

function levelBars(group) {
  const bars = group.agents
    .slice()
    .sort((a, b) => b.level - a.level)
    .slice(0, 12)
    .map((agent) => `<i style="height:${6 + agent.level * 3}px;background:${levelColor(agent.level)}"></i>`);
  return `<span class="bars">${bars.join("")}</span>`;
}

function countChips(group) {
  return [5, 4, 3, 2, 1]
    .filter((level) => group.counts[level] > 0)
    .map(
      (level) =>
        `<span class="countchip lv" style="--c:${levelColor(level)}">L${level} <strong>×${group.counts[level]}</strong></span>`
    )
    .join("");
}

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = value ?? "";
  return span.innerHTML;
}

// Per-row badges: LOCATOR, STORYLINE, and a plain EPIC ARC badge for mid-arc epic agents.
// An epic agent that *starts* an arc gets the inline arc chip instead of the bare badge.
function agentBadgesHtml(agent) {
  let html = agent.is_locator ? '<span class="locator">LOCATOR</span>' : "";
  const bucket = agentBucket(agent);
  if (bucket === "story") html += '<span class="tbadge story">STORYLINE</span>';
  if (bucket === "epic" && !agent.arc_id) html += '<span class="tbadge epic">EPIC ARC</span>';
  return html;
}

function arcChipHtml(agent) {
  if (!agent.arc_id) return "";
  return `<a class="arclink" href="/missions/arc/${agent.arc_id}"><span class="arrow" aria-hidden="true">▸</span> ${escapeText(agent.arc_name ?? "Epic arc")}</a>`;
}

// In the all-corporations view the owning corp is shown as a dimmed line under the agent name,
// since one system/station can mix agents from several corps.
function corpLineHtml(agent) {
  if (state.scope !== "all") return "";
  return `<span class="corpline">${escapeText(agent.corp_name ?? `Corp ${agent.corp_id}`)}</span>`;
}

// When grouping by station the station name is already in the section header, so the per-row
// station column is dropped to avoid repeating it on every line.
function agentRowsHtml(agents, { showStation = true } = {}) {
  return agents
    .slice()
    .sort((a, b) => b.level - a.level || a.agent_name.localeCompare(b.agent_name))
    .map(
      (agent) => `
        <tr>
          <td class="lvl"><span class="lvlpill" style="--c:${levelColor(agent.level)}">L${agent.level}</span></td>
          <td class="agent">${escapeText(agent.agent_name)}${agentBadgesHtml(agent)}${arcChipHtml(agent)}${corpLineHtml(agent)}</td>
          <td class="div">${escapeText(agent.division_name ?? "")}</td>
          ${showStation ? `<td class="station" title="${escapeText(agent.station_name ?? "")}">${escapeText(agent.station_name ?? "In space")}</td>` : ""}
        </tr>`
    )
    .join("");
}

function renderDetail(group) {
  const detail = $("detail");
  if (!group) {
    detail.innerHTML = `<p class="empty-state">No ${groupNouns[state.group]} match the current filters.</p>`;
    return;
  }
  if (state.group === "system" || state.group === "station") {
    // A station header carries its parent system in the subtitle; the per-row station column is
    // then redundant and dropped.
    const subtitle = state.group === "station" ? [group.system, group.region].filter(Boolean).join(" · ") : group.region;
    detail.innerHTML = `
      <div class="dethead">
        <span class="sysname">${escapeText(group.label)}</span>
        <span class="secbadge" style="--c:${secColor(group.security)}">${secLabel(group.security)}</span>
        <span class="region">${escapeText(subtitle)}</span>
        <span class="countwrap">${countChips(group)}</span>
      </div>
      <table><tbody>${agentRowsHtml(group.agents, { showStation: state.group !== "station" })}</tbody></table>`;
    return;
  }
  // Constellation/region detail: the same hub ranking applied to the systems inside the group,
  // each system rendered as its own sub-section.
  const sections = rankedGroups(group.agents, describeSystem)
    .map(
      (sys) => `
        <div class="syshead">
          <span class="sysname">${escapeText(sys.label)}</span>
          <span class="secbadge" style="--c:${secColor(sys.security)}">${secLabel(sys.security)}</span>
          ${state.group === "region" ? "" : `<span class="region">${escapeText(sys.region)}</span>`}
          <span class="countwrap">${countChips(sys)}</span>
        </div>
        <table><tbody>${agentRowsHtml(sys.agents)}</tbody></table>`
    )
    .join("");
  detail.innerHTML = `
    <div class="dethead">
      <span class="sysname">${escapeText(group.label)}</span>
      ${group.region ? `<span class="region">${escapeText(group.region)}</span>` : ""}
      <span class="countwrap">
        <span class="countchip"><strong>${group.systemIds.size}</strong> ${group.systemIds.size === 1 ? "system" : "systems"}</span>
        ${countChips(group)}
      </span>
    </div>
    ${sections}`;
}

function renderEmpty(message) {
  $("rankTitle").textContent = `Hub ${groupNouns[state.group]}`;
  $("rankRows").replaceChildren();
  $("detail").innerHTML = `<p class="empty-state">${escapeText(message)}</p>`;
}

function render() {
  if (state.loading) return;
  if (state.emptyReason === "no_agent_data") {
    renderEmpty("Agent data has not been imported on this deployment yet. Try again later.");
    setStatus(`${scopeLabel()} — agent data unavailable`);
    return;
  }
  if (state.agents.length === 0) {
    renderEmpty(
      state.scope === "all" ? "No mission agents are available." : "This corporation has no regular mission agents."
    );
    setStatus(`${scopeLabel()} — no mission agents`);
    return;
  }

  const agents = filteredAgents();
  const allGroups = rankedGroups(agents, describeGroup);
  // Minimum-density gate: hide hubs with fewer than the chosen number of matching agents
  // ("show me systems with at least N L4 Security agents"). "1" means no minimum.
  const minN = Number(state.min);
  const minGroups = minN > 1 ? allGroups.filter((group) => group.agents.length >= minN) : allGroups;
  // Live name filter on the hub list — typing narrows visible systems/stations/constellations/regions.
  const hubQuery = state.hubQuery.trim().toLowerCase();
  const groups = hubQuery ? minGroups.filter((group) => group.label.toLowerCase().includes(hubQuery)) : minGroups;
  if (!groups.some((group) => group.key === state.selectedKey)) {
    state.selectedKey = groups[0]?.key ?? null;
  }

  $("rankTitle").textContent = `Hub ${groupNouns[state.group]} (${groups.length})`;
  // Cross-type markers only make sense per-system in the Basic view (constellation/region
  // groups span multiple systems; the storyline/epic tabs already list those agents).
  const extras = state.group === "system" && state.type === "basic" ? systemExtras() : null;
  // System and station rows are anchored to one solar system, so they show a security badge;
  // constellation/region rows span many systems and show a system count instead.
  const isLeaf = state.group === "system" || state.group === "station";
  const rankRows = $("rankRows");
  rankRows.replaceChildren();
  const shown = groups.length > RANK_CAP ? groups.slice(0, RANK_CAP) : groups;
  for (const [index, group] of shown.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rankrow" + (group.key === state.selectedKey ? " sel" : "");
    const badge = isLeaf
      ? `<span class="secbadge" style="--c:${secColor(group.security)}">${secLabel(group.security)}</span>`
      : `<span class="syscount">${group.systemIds.size} sys</span>`;
    button.innerHTML = `
      <span class="num">${index + 1}</span>
      <span class="name">${escapeText(group.label)}</span>
      ${extras ? sysMarksHtml(extras.get(group.key)) : ""}
      ${badge}
      ${levelBars(group)}
      <span class="num">${group.agents.length}</span>`;
    button.addEventListener("click", () => {
      state.selectedKey = group.key;
      render();
    });
    rankRows.append(button);
  }
  if (groups.length > shown.length) {
    const more = document.createElement("div");
    more.className = "rankmore";
    more.textContent = `+${groups.length - shown.length} more — refine the filters or search to narrow`;
    rankRows.append(more);
  }

  renderDetail(groups.find((group) => group.key === state.selectedKey) ?? null);
  let status = `${scopeLabel()} — ${agents.length} ${typeLabels[state.type]}agents in ${allGroups.length} ${groupNouns[state.group]}`;
  if (minN > 1) status += ` · ${minGroups.length} with ≥${minN}`;
  setStatus(status);
}

function setStatus(text) {
  $("statusLine").textContent = text;
}

function updateUrl() {
  const params = new URLSearchParams();
  if ($("corp").value) params.set("corp", $("corp").value);
  if (state.group !== "system") params.set("group", state.group);
  if (state.type !== "all") params.set("type", state.type);
  if (state.min !== "1") params.set("min", state.min);
  const query = params.toString();
  history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
}

function setSegmentAvailability(containerId, key, available, hasData) {
  const container = $(containerId);
  let resetSelection = false;
  for (const button of container.children) {
    const value = button.dataset.value;
    if (!value || value === "all") continue;
    const impossible = hasData && !available.has(value);
    button.disabled = impossible;
    if (impossible && state[key] === value) resetSelection = true;
  }
  if (resetSelection) {
    state[key] = "all";
    for (const button of container.children) {
      button.setAttribute("aria-pressed", String(button.dataset.value === "all"));
    }
  }
}

// Every segment option stays visible; options the loaded corporation cannot satisfy are
// greyed out instead of hidden, and a selection that became impossible resets to All.
function updateFilterAvailability() {
  // Availability reflects the active Type tab: e.g. on Epic-arc, only the levels/divisions/
  // security bands that epic agents actually occupy stay enabled.
  const typed = state.type === "all" ? state.agents : state.agents.filter((agent) => agentBucket(agent) === state.type);
  const hasData = typed.length > 0;
  setSegmentAvailability("levelFilter", "level", new Set(typed.map((agent) => String(agent.level))), hasData);
  setSegmentAvailability(
    "divisionFilter",
    "division",
    new Set(typed.map((agent) => String(agent.division_id))),
    hasData
  );
  setSegmentAvailability("secFilter", "sec", new Set(typed.map((agent) => agent.risk_tier)), hasData);
}

// Monotonic load token: the corp combobox and "All corporations" can fire overlapping loads, and
// the all-corps payload is large/slow, so a stale response must not overwrite a newer view.
let loadToken = 0;

async function loadAgents() {
  const corpId = $("corp").value;
  const token = ++loadToken;
  // A fresh load starts with an unfiltered hub list. An empty corp field is the all-corporations
  // view, which ranks dense agent hubs across every corp at once.
  state.hubQuery = "";
  $("hubSearch").value = "";
  state.scope = corpId ? "corp" : "all";
  state.loading = true;
  setStatus(corpId ? "Loading agents…" : "Loading all corporations…");
  try {
    const url = corpId
      ? `/api/agents?corp=${encodeURIComponent(corpId)}&type=${AGENT_TYPE_IDS}`
      : `/api/agents?type=${AGENT_TYPE_IDS}`;
    const response = await apiFetch(url);
    if (token !== loadToken) return; // superseded by a newer load
    if (!response.ok) throw Object.assign(new Error("agents request failed"), { status: response.status });
    const data = await response.json();
    if (token !== loadToken) return;
    state.scope = data.scope ?? state.scope;
    state.corpName = corpId ? (data.corp_name ?? state.corpName) : "";
    state.agents = Array.isArray(data.agents) ? data.agents : [];
    state.emptyReason = data.empty_reason ?? null;
    state.selectedKey = null;
  } catch (error) {
    if (token !== loadToken) return;
    state.agents = [];
    state.emptyReason = null;
    state.loading = false;
    updateFilterAvailability();
    renderEmpty(apiErrorMessage(error));
    setStatus("Failed to load agents");
    return;
  }
  state.loading = false;
  updateFilterAvailability();
  render();
}

// -- Corporation combobox: text input + filtered dropdown with keyboard navigation --

let corpMatches = [];
let corpActive = -1;

function corpFilter(query) {
  const q = query.trim().toLowerCase();
  if (!q) return state.corpOptions.slice(0, 12);
  const starts = [];
  const contains = [];
  for (const corp of state.corpOptions) {
    const name = corp.name.toLowerCase();
    if (name.startsWith(q)) starts.push(corp);
    else if (name.includes(q)) contains.push(corp);
  }
  return [...starts, ...contains].slice(0, 12);
}

function closeCorpList() {
  $("corpList").hidden = true;
  corpActive = -1;
  $("corpSearch").setAttribute("aria-expanded", "false");
  $("corpSearch").removeAttribute("aria-activedescendant");
}

function openCorpList() {
  const list = $("corpList");
  const value = $("corpSearch").value;
  const matches = corpFilter(value);
  // "All corporations" is always offered so the cross-corp view stays one click away (including
  // when a corp name fills the box). It leads only for an empty box; for any typed text it trails,
  // so index 0 stays a real corp and a prefix + Enter selects that corp instead of clearing.
  corpMatches = value.trim() === "" ? [ALL_CORPS, ...matches] : [...matches, ALL_CORPS];
  corpActive = -1;
  list.replaceChildren();
  if (corpMatches.length === 0) {
    closeCorpList();
    return;
  }
  for (const [index, corp] of corpMatches.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = corp === ALL_CORPS ? "corp-option corp-option-all" : "corp-option";
    option.id = `corpOption${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.textContent = corp.name;
    // mousedown would blur the input (closing the list before click fires) — suppress it.
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectCorp(corp));
    list.append(option);
  }
  list.hidden = false;
  $("corpSearch").setAttribute("aria-expanded", "true");
}

function setCorpActive(index) {
  const options = $("corpList").children;
  if (options.length === 0) return;
  corpActive = (index + options.length) % options.length;
  for (const [i, option] of [...options].entries()) {
    option.classList.toggle("active", i === corpActive);
    option.setAttribute("aria-selected", String(i === corpActive));
  }
  $("corpSearch").setAttribute("aria-activedescendant", `corpOption${corpActive}`);
  options[corpActive].scrollIntoView({ block: "nearest" });
}

function selectCorp(corp) {
  // The "All corporations" sentinel clears the corp filter, dropping back to the cross-corp view.
  const isAll = corp.corp_id === "" || corp.corp_id == null;
  const newValue = isAll ? "" : String(corp.corp_id);
  $("corpSearch").value = isAll ? "" : corp.name;
  const changed = $("corp").value !== newValue;
  $("corp").value = newValue;
  state.corpName = isAll ? "" : corp.name;
  closeCorpList();
  if (changed) {
    updateUrl();
    void loadAgents();
  }
}

function setCorpOptions(rows) {
  state.corpOptions = Array.isArray(rows) ? rows : [];
  state.corpById = new Map(state.corpOptions.map((corp) => [String(corp.corp_id), corp]));
  // A ?corp= permalink can resolve its display name only after options arrive.
  const selected = state.corpById.get($("corp").value);
  if (selected && !$("corpSearch").value.trim()) {
    $("corpSearch").value = selected.name;
    state.corpName = selected.name;
  }
}

async function loadCorpOptions() {
  try {
    // Every corporation that has agents — not just the LP-store subset that /api/corps returns.
    // /api/corps filters has_lp_store=1, so it omitted valid mission corporations the /api/agents
    // view can still surface (e.g. Jove Navy, InterBus), making them unreachable from the picker.
    // This endpoint is keyed by SDE import version and cached like the rest of /api/agents.
    const response = await apiFetch("/api/agents/corps");
    if (!response.ok) return;
    const data = await response.json();
    setCorpOptions(data.rows);
  } catch {
    // Corp picker degrades to free-text entry; agents load still works via ?corp= permalinks.
  }
}

function resolveCorpSelection() {
  const previous = $("corp").value;
  const value = $("corpSearch").value.trim();
  if (value === "") {
    // A deliberately emptied field is the all-corporations trigger.
    $("corp").value = "";
  } else {
    // A non-empty but not-yet-unique prefix keeps the current corp: we only switch when the text
    // resolves to a corp, so typing toward a name never flickers through the heavy all-corps view.
    const corp = resolveCorpOption(state.corpOptions, value);
    if (corp) {
      $("corp").value = String(corp.corp_id);
      state.corpName = corp.name;
    }
  }
  return $("corp").value !== previous;
}

function wireChips(containerId, key, onChange) {
  $(containerId).addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !button.dataset.value) return;
    state[key] = button.dataset.value;
    for (const sibling of button.parentElement.children) {
      sibling.setAttribute("aria-pressed", String(sibling === button));
    }
    state.selectedKey = null;
    if (onChange) onChange();
    render();
  });
}

initializeDiagnostics();
wireChips("groupFilter", "group", updateUrl);
// Type switches the loaded buckets client-side; refresh which level/division/sec options the
// new tab can satisfy, and keep it in the URL alongside the group.
wireChips("typeFilter", "type", () => {
  updateFilterAvailability();
  updateUrl();
});
wireChips("secFilter", "sec");
wireChips("levelFilter", "level");
wireChips("divisionFilter", "division");
wireChips("locatorFilter", "locator");
// Minimum agents per hub — the density gate behind "show me places with at least N agents".
wireChips("minFilter", "min", updateUrl);

// Live hub-list name filter: narrows the ranked hubs as the user types. The render is debounced
// because the all-corporations view re-groups a large dataset and rebuilds the list each call.
const renderHubFilter = debounce(render, 140);
$("hubSearch").addEventListener("input", () => {
  state.hubQuery = $("hubSearch").value;
  renderHubFilter();
});

const corpChanged = debounce(() => {
  if (resolveCorpSelection()) {
    updateUrl();
    void loadAgents();
  }
}, 250);
$("corpSearch").addEventListener("input", () => {
  openCorpList();
  corpChanged();
});
$("corpSearch").addEventListener("focus", openCorpList);
$("corpSearch").addEventListener("blur", closeCorpList);
$("corpSearch").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if ($("corpList").hidden) openCorpList();
    setCorpActive(corpActive + (event.key === "ArrowDown" ? 1 : -1));
  } else if (event.key === "Enter") {
    if (!$("corpList").hidden && corpMatches.length > 0) {
      event.preventDefault();
      selectCorp(corpMatches[corpActive >= 0 ? corpActive : 0]);
    }
  } else if (event.key === "Escape") {
    closeCorpList();
  }
});

const initialParams = new URLSearchParams(window.location.search);
const initialCorp = initialParams.get("corp");
if (initialCorp && /^\d+$/.test(initialCorp)) $("corp").value = initialCorp;
const initialGroup = initialParams.get("group");
if (initialGroup === "station" || initialGroup === "constellation" || initialGroup === "region") {
  state.group = initialGroup;
  for (const button of $("groupFilter").children) {
    button.setAttribute("aria-pressed", String(button.dataset.value === initialGroup));
  }
}
const initialMin = initialParams.get("min");
if (initialMin && /^[2-5]$/.test(initialMin)) {
  state.min = initialMin;
  for (const button of $("minFilter").children) {
    button.setAttribute("aria-pressed", String(button.dataset.value === initialMin));
  }
}
const initialType = initialParams.get("type");
if (initialType === "basic" || initialType === "story" || initialType === "epic") {
  state.type = initialType;
  for (const button of $("typeFilter").children) {
    button.setAttribute("aria-pressed", String(button.dataset.value === initialType));
  }
}

void loadCorpOptions().then(() => {
  const selected = state.corpById.get($("corp").value);
  if (selected) {
    $("corpSearch").value = selected.name;
    state.corpName = selected.name;
  }
});
void loadAgents();
