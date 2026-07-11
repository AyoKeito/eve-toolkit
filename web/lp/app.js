import {
  cargoFlag,
  deriveOfferMetrics,
  formatDailyVolume,
  isNoValue,
  offerIskPerLp,
  offerRoi,
  resolveCorpOption
} from "./ui-model.js";
import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import { debounce } from "/shared/utils.js";
import { compact, isk, pctFormat, ratio } from "./format.js";
import { renderFlags, riskFlag, vanityFlag } from "./flags.js";
import { detailBlock } from "./detail-drawer.js";
import { initializeFloatingScrollbar, initializeFloatingTableHeader, scheduleTableChrome } from "./floating-table.js";
import { loadHealth } from "./health-chips.js";

const controls = [
  "search",
  "corp",
  "maxRiskTier",
  "level5Missions",
  "basis",
  "minVolume",
  "sortBy",
  "runs",
  "maxM3",
  "lpBudget",
  "iskBudget",
  "lpPerHour",
  "jita44Only",
  "hideSuspicious",
  "hideVanity",
  "hideNoSecurity",
  "bpc",
  "includeFW",
  "includeSpecial",
  "showDuplicateStores",
  "acc",
  "bro",
  "advBro",
  "factionStand",
  "corpStand",
  "realisticPatient",
  "noMarketFees",
  "facility",
  "costIndex",
  "mode"
];

// Short labels for the collapsed Manufacturer-mode ribbon summary.
const facilityShortLabel = {
  npc: "NPC station",
  "highsec-t2": "Highsec T2 rigs",
  "null-t2": "Null T2 rigs"
};

const mfgRibbonCollapsedKey = "lp:mfgRibbonCollapsed";

const $ = (id) => document.getElementById(id);
const defaultMaxRiskTier = "NULLSEC";
const rowsCachePrefix = "eve-lp-offers:v4-basis:";
const filtersCollapsedKey = "filtersCollapsed";
let corpOptions = [];
let corpById = new Map();
let rowsRequestSeq = 0;

initializeDiagnostics();

function runWhenIdle(callback) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(callback, { timeout: 1500 });
    return;
  }
  window.setTimeout(callback, 0);
}

function setFilterPanelCollapsed(collapsed, { persist = false } = {}) {
  const panel = $("filtersPanel");
  const workstation = document.querySelector(".workstation");
  const button = $("toggleFilters");

  workstation?.classList.toggle("filters-collapsed", collapsed);
  if (panel) panel.hidden = collapsed;
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Show filters" : "Collapse filters");
    button.title = collapsed ? "Show filters" : "Collapse filters";
  }
  if (persist) localStorage.setItem("filtersCollapsed", String(collapsed));
  scheduleTableChrome();
}

function setInitialFilterPanel() {
  const stored = localStorage.getItem(filtersCollapsedKey);
  // Phones default to collapsed: the open panel pushes the leaderboard a full screen down.
  const collapsed = stored === null ? window.matchMedia("(max-width: 700px)").matches : stored === "true";
  setFilterPanelCollapsed(collapsed);
}

function controlDefaultValue(input) {
  return input.dataset.defaultValue ?? input.defaultValue ?? "";
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  for (const id of controls) {
    const input = $(id);
    if (!input) continue;
    if (input.type === "checkbox") {
      input.checked = params.has(id) ? params.get(id) === "true" : input.defaultChecked;
    } else if (id === "maxRiskTier" && params.has(id)) {
      input.value = params.get(id) === "WORMHOLE" ? "NULLSEC" : params.get(id);
    } else if (params.has(id)) {
      input.value = params.get(id);
    }
  }
  if (!$("sortBy").value) $("sortBy").value = "iskPerLp";
  syncRiskTierFilter();
  syncLevel5MissionFilter();
  syncBasisFilter();
  syncBpcFilter();
  syncQualityToggleButtons();
  syncMfgMode();
  syncCorpSearchFromId();
}

function resetFilters() {
  for (const id of controls) {
    const input = $(id);
    if (!input) continue;
    if (input.type === "checkbox") {
      input.checked = input.defaultChecked;
    } else {
      input.value = controlDefaultValue(input);
    }
  }
  $("maxRiskTier").value = defaultMaxRiskTier;
  $("level5Missions").value = "show";
  $("basis").value = "best";
  $("bpc").value = "none";
  $("corpSearch").value = "";
  $("sortBy").value = "iskPerLp";
  syncRiskTierFilter();
  syncLevel5MissionFilter();
  syncBasisFilter();
  syncBpcFilter();
  syncQualityToggleButtons();
  syncMfgMode();
  loadRows().catch(renderLoadError);
}

function corpDisplayName(corp) {
  return corp?.name || "";
}

function setCorpOptions(rows) {
  corpOptions = Array.isArray(rows) ? rows : [];
  corpById = new Map(corpOptions.map((corp) => [String(corp.corp_id), corp]));

  const list = $("corpOptions");
  if (list) {
    list.textContent = "";
    for (const corp of corpOptions) {
      const option = document.createElement("option");
      // value is the picker text (what resolveCorpOption matches on). Do NOT set a
      // separate `label`: Chrome renders the value but Firefox renders the label, so
      // a corp_id label showed raw ids in the Firefox dropdown. textContent mirrors
      // the value as the cross-browser display fallback.
      option.value = corpDisplayName(corp);
      option.textContent = corpDisplayName(corp);
      list.append(option);
    }
  }

  if ($("corpSearch")?.value.trim()) {
    const changed = resolveCorpSelection();
    if (changed) debouncedLoad();
  } else {
    syncCorpSearchFromId();
  }
}

async function loadCorpOptions() {
  const response = await apiFetch("/lp/api/corps");
  if (!response.ok) return;
  const data = await response.json();
  setCorpOptions(data.rows);
}

function syncCorpSearchFromId() {
  const corpInput = $("corp");
  const corpSearch = $("corpSearch");
  if (!corpInput || !corpSearch) return;
  if (!corpInput.value) {
    if (document.activeElement !== corpSearch) corpSearch.value = "";
    return;
  }
  const corp = corpById.get(corpInput.value);
  if (corp) corpSearch.value = corpDisplayName(corp);
}

function resolveCorpSelection() {
  const corpInput = $("corp");
  const corpSearch = $("corpSearch");
  if (!corpInput || !corpSearch) return false;
  const previousCorpId = corpInput.value;
  const value = corpSearch.value.trim();
  if (!value) {
    corpInput.value = "";
    return corpInput.value !== previousCorpId;
  }
  const corp = resolveCorpOption(corpOptions, value);
  corpInput.value = corp ? String(corp.corp_id) : "";
  return corpInput.value !== previousCorpId;
}

function syncToggleGroup(selector, dataKey, activeValue) {
  for (const button of document.querySelectorAll(selector)) {
    const isActive = button.dataset[dataKey] === activeValue;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function syncRiskTierFilter() {
  syncToggleGroup("[data-risk-filter]", "riskFilter", $("maxRiskTier")?.value || defaultMaxRiskTier);
}

function syncLevel5MissionFilter() {
  syncToggleGroup("[data-level5-filter]", "level5Filter", $("level5Missions")?.value || "show");
}

function syncBasisFilter() {
  syncToggleGroup("[data-basis-filter]", "basisFilter", $("basis")?.value || "best");
}

function syncBpcFilter() {
  syncToggleGroup("[data-bpc-filter]", "bpcFilter", $("bpc")?.value || "none");
}

function syncQualityToggleButtons() {
  for (const button of document.querySelectorAll("[data-quality-toggle]")) {
    const input = $(button.dataset.qualityToggle);
    const isActive = Boolean(input?.checked);
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function syncNoMarketFees() {
  const input = $("noMarketFees");
  const pill = document.querySelector('[data-ribbon-toggle="noMarketFees"]');
  if (!pill) return;
  const isActive = Boolean(input?.checked);
  pill.classList.toggle("active", isActive);
  pill.setAttribute("aria-pressed", String(isActive));
}

function updateMfgRibbonSummary() {
  const summary = $("mfgRibbonSummary");
  if (!summary) return;
  const parts = [];
  if ($("noMarketFees")?.checked) parts.push("no market fees");
  const facility = $("facility")?.value || "npc";
  parts.push(facilityShortLabel[facility] ?? facilityShortLabel.npc);
  const costIndex = $("costIndex")?.value;
  if (costIndex) parts.push(`cost index ${costIndex}%`);
  summary.textContent = parts.join(" · ");
}

function readMfgRibbonCollapsed() {
  try {
    return localStorage.getItem(mfgRibbonCollapsedKey) === "1";
  } catch {
    return false;
  }
}

function writeMfgRibbonCollapsed(collapsed) {
  try {
    localStorage.setItem(mfgRibbonCollapsedKey, collapsed ? "1" : "0");
  } catch {
    /* private mode: collapse simply won't persist */
  }
}

function applyMfgRibbonCollapsed(collapsed) {
  $("mfgRibbon")?.classList.toggle("collapsed", collapsed);
  $("mfgRibbonToggle")?.setAttribute("aria-expanded", String(!collapsed));
}

// Apply the Manufacturer-mode chrome (html class, ribbon visibility, button state)
// from the current `mode` control value, WITHOUT re-bundling — on load the URL params
// already carry the individual control values (noMarketFees, facility, bpc, ...).
function syncMfgMode() {
  const on = $("mode")?.value === "manufacturer";
  document.documentElement.classList.toggle("mfg-mode", on);
  const ribbon = $("mfgRibbon");
  if (ribbon) ribbon.hidden = !on;
  $("toggleMfgMode")?.setAttribute("aria-pressed", String(on));
  applyMfgRibbonCollapsed(readMfgRibbonCollapsed());
  syncNoMarketFees();
  updateMfgRibbonSummary();
}

// Controls the standalone mode bundles; snapshotted on entry so exit restores
// whatever the user had set (e.g. a manual bpc=sell) instead of hard-resetting.
let mfgModePrevState = null;

// Toggle the standalone mode. Entering bundles the serious-builder defaults
// (contract sale, manufacture rows, null-sec T2 facility); leaving restores the
// pre-bundle values, or global defaults when entered fresh from a permalink.
function setMfgMode(on) {
  const mode = $("mode");
  if (mode) mode.value = on ? "manufacturer" : "";
  if (on) {
    mfgModePrevState = {
      noMarketFees: $("noMarketFees").checked,
      bpc: $("bpc").value,
      facility: $("facility").value,
      costIndex: $("costIndex").value
    };
    $("noMarketFees").checked = true;
    $("bpc").value = "manufacture";
    $("facility").value = "null-t2";
  } else {
    const prev = mfgModePrevState;
    mfgModePrevState = null;
    $("noMarketFees").checked = prev ? prev.noMarketFees : false;
    $("bpc").value = prev ? prev.bpc : "none";
    $("facility").value = prev ? prev.facility : "npc";
    $("costIndex").value = prev ? prev.costIndex : controlDefaultValue($("costIndex"));
  }
  document.documentElement.classList.toggle("mfg-mode", on);
  const ribbon = $("mfgRibbon");
  if (ribbon) ribbon.hidden = !on;
  $("toggleMfgMode")?.setAttribute("aria-pressed", String(on));
  syncBpcFilter();
  syncNoMarketFees();
  updateMfgRibbonSummary();
}

function buildParams() {
  if ($("corpSearch")?.value.trim()) resolveCorpSelection();
  const params = new URLSearchParams();
  for (const id of controls) {
    const input = $(id);
    if (!input) continue;
    if (input.type === "checkbox") {
      if (input.checked !== input.defaultChecked) params.set(id, String(input.checked));
      continue;
    }
    if (input.value !== "" && input.value !== controlDefaultValue(input)) params.set(id, input.value);
  }
  params.set("n", "100");
  return params;
}

function updateUrl() {
  const params = buildParams();
  history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  $("exportCsv").href = `/lp/api/offers/top.csv?${params.toString()}`;
  updateSortHeaders();
}

async function copyPermalink() {
  updateUrl();
  const href = window.location.href;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(href);
    return;
  }

  const field = document.createElement("textarea");
  field.value = href;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    document.execCommand("copy");
  } finally {
    field.remove();
  }
}

function updateSortHeaders() {
  const activeSort = $("sortBy").value || "iskPerLp";
  for (const header of document.querySelectorAll("th[data-sort]")) {
    const isActive = header.dataset.sort === activeSort;
    header.setAttribute("aria-sort", isActive ? "descending" : "none");
  }
}

function handleSortHeaderClick(header) {
  const nextSort = header.dataset.sort;
  if (!nextSort) return;
  $("sortBy").value = nextSort;
  loadRows().catch(renderLoadError);
}

function activateSortHeader(header) {
  if (header.dataset.sortHeaderBound === "true") return;
  header.dataset.sortHeaderBound = "true";
  header.querySelector(".sort-header")?.addEventListener("click", () => {
    handleSortHeaderClick(header);
  });
}

function autoSelectFirstRow(index) {
  return index === 0;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function renderMetricStrip(rows) {
  const metrics = deriveOfferMetrics(rows, $("lpPerHour")?.value, $("basis")?.value);

  setText("metricBestInstant", ratio(metrics.bestInstant?.isk_per_lp_instant));
  setText("metricBestInstantMeta", metrics.bestInstant?.corp_name || "no matching rows");
  setText("metricBestPatient", ratio(metrics.bestPatient?.isk_per_lp_patient));
  setText("metricBestPatientMeta", metrics.bestPatient?.corp_name || "no matching rows");
  setText("metricMedianIskPerLp", ratio(metrics.medianIskPerLp));
  setText("metricLpVolume", compact(metrics.totalLpVolume));
  setText("metricIskVolume", compact(metrics.totalIskVolume));
  setText("metricBestIskHour", `${compact(metrics.bestIskPerHour)} ISK/hr`);
  setText("metricPriceHealth", metrics.priceHealth.label);
  setText("metricPriceHealthNote", metrics.priceHealth.note);
  const healthCard = $("metricPriceHealth")?.closest(".metric-card");
  if (healthCard) healthCard.dataset.tone = metrics.priceHealth.tone;
}

function cellText(text, title = text) {
  const span = document.createElement("span");
  span.className = "cell-text";
  span.textContent = text;
  span.title = title || text;
  return span;
}

function storeCount(row) {
  if (!row) return 1;
  const explicit = Number(row.store_count);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (Array.isArray(row.store_options) && row.store_options.length > 0) return row.store_options.length;
  return 1;
}

function storeNames(row) {
  if (Array.isArray(row?.store_options) && row.store_options.length > 0) {
    return row.store_options.map((store) => store.corp_name).join(", ");
  }
  return row?.corp_name || "Unknown corporation";
}

function storeLabel(row) {
  const corpName = row?.corp_name || "Unknown corporation";
  const count = storeCount(row);
  return count > 1 ? `${corpName} +${count - 1}` : corpName;
}

function storeTitle(row) {
  const count = storeCount(row);
  return count > 1 ? `${count} stores: ${storeNames(row)}` : storeNames(row);
}

function renderRows(rows) {
  const tbody = $("rows");
  tbody.textContent = "";
  const template = $("rowTemplate");

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="muted-state">No offers match the current filters.</td></tr>`;
    scheduleTableChrome();
    return;
  }

  rows.forEach((row, index) => {
    const fragment = template.content.cloneNode(true);
    const dataRow = fragment.querySelector(".data-row");
    const detailRow = fragment.querySelector(".detail-row");
    const cells = Object.fromEntries([...fragment.querySelectorAll("[data-cell]")].map((cell) => [cell.dataset.cell, cell]));

    cells.rank.textContent = row.rank;
    cells.corp.replaceChildren(cellText(storeLabel(row), storeTitle(row)));
    cells.offer.replaceChildren(cellText(row.offer_name));
    cells.lp.textContent = isk(row.lp_cost);
    cells.isk.textContent = isk(row.isk_cost);
    cells.iskPerLp.textContent = ratio(offerIskPerLp(row, $("basis")?.value));
    cells.instant.textContent = ratio(row.isk_per_lp_instant);
    cells.patient.textContent = ratio(row.isk_per_lp_patient);
    const roiValue = offerRoi(row, $("basis")?.value);
    cells.roi.textContent = isNoValue(roiValue) ? "-" : pctFormat.format(roiValue);
    if (row.contract_priced) {
      // No hourly rate exists: contract demand, not LP/hour, caps these rows.
      cells.iskHour.textContent = "—";
      cells.iskHour.title = "Sells via occasional public contracts — no sustainable hourly rate exists. ISK/LP is still a real one-off conversion rate.";
    } else {
      cells.iskHour.textContent = isk(row.isk_per_hour);
    }
    cells.cargo.textContent = ratio(row.cargo_m3);
    cells.supply.textContent = formatDailyVolume(row.avg_daily_volume_28d);
    cells.flags.append(renderFlags(row.flags, cargoFlag(row), vanityFlag(row), riskFlag(row.access_risk_tier)));
    dataRow.title = "Click to expand offer details.";

    detailRow.querySelector(".detail").append(detailBlock(row));
    const expanded = autoSelectFirstRow(index);
    detailRow.hidden = !expanded;
    dataRow.classList.toggle("expanded", expanded);
    dataRow.setAttribute("aria-selected", String(expanded));
    dataRow.addEventListener("click", () => {
      const isExpanding = detailRow.hidden;
      for (const openRow of tbody.querySelectorAll(".detail-row")) openRow.hidden = true;
      for (const openData of tbody.querySelectorAll(".data-row")) {
        openData.classList.remove("expanded");
        openData.setAttribute("aria-selected", "false");
      }
      if (isExpanding) {
        detailRow.hidden = false;
        dataRow.classList.add("expanded");
        dataRow.setAttribute("aria-selected", "true");
      }
    });
    tbody.append(fragment);
  });
  scheduleTableChrome();
}

function renderLoadingRows() {
  const tbody = $("rows");
  const cells = Array.from({ length: 13 }, (_, index) => `<td><span class="skeleton-bar skeleton-bar-${index + 1}"></span></td>`);
  tbody.innerHTML = Array.from({ length: 8 }, () => `<tr class="skeleton-row">${cells.join("")}</tr>`).join("");
  scheduleTableChrome();
}

function setRowsLoading(loading, { cached = false } = {}) {
  const results = document.querySelector(".results");
  const tableWrap = $("tableWrap");
  const loadingState = $("resultsLoadingState");

  results?.classList.toggle("is-refreshing", loading);
  tableWrap?.setAttribute("aria-busy", String(loading));
  if (loadingState) {
    loadingState.hidden = !loading;
    loadingState.textContent = cached ? "Updating" : "Loading";
  }
}

function isCurrentRowsRequest(requestSeq) {
  return requestSeq === rowsRequestSeq;
}

function cacheKey(params) {
  return `${rowsCachePrefix}${params.toString()}`;
}

function readCachedRows(key) {
  try {
    const cached = sessionStorage.getItem(key);
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed?.rows) ? parsed.rows : null;
  } catch {
    return null;
  }
}

function writeCachedRows(key, rows) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ rows, cachedAt: Date.now() }));
  } catch {
    // Storage can be unavailable in private contexts; the network response still renders normally.
  }
}

async function loadRows() {
  const requestSeq = ++rowsRequestSeq;
  updateUrl();
  const params = buildParams();
  const key = cacheKey(params);
  const cachedRows = readCachedRows(key);
  setRowsLoading(true, { cached: Boolean(cachedRows) });
  if (cachedRows) {
    renderRows(cachedRows);
    renderMetricStrip(cachedRows);
  } else {
    renderLoadingRows();
  }

  try {
    const response = await apiFetch(`/lp/api/offers/top?${params.toString()}`);
    if (!isCurrentRowsRequest(requestSeq)) return;
    if (!response.ok) throw responseError(response, "Offers");
    const data = await response.json();
    if (!isCurrentRowsRequest(requestSeq)) return;
    const rows = Array.isArray(data.rows) ? data.rows : [];
    renderRows(rows);
    renderMetricStrip(rows);
    writeCachedRows(key, rows);
  } catch (error) {
    if (!isCurrentRowsRequest(requestSeq)) return;
    throw error;
  } finally {
    if (isCurrentRowsRequest(requestSeq)) setRowsLoading(false);
  }
}

function renderLoadError(error) {
  const tbody = $("rows");
  tbody.textContent = "";
  const row = document.createElement("tr");
  const messageCell = document.createElement("td");
  messageCell.colSpan = 13;
  messageCell.className = "error";
  messageCell.textContent = apiErrorMessage(error);
  row.append(messageCell);
  tbody.append(row);
  scheduleTableChrome();
}

readParams();
setInitialFilterPanel();
initializeFloatingScrollbar();
initializeFloatingTableHeader();

const debouncedLoad = debounce(() => {
  loadRows().catch(renderLoadError);
});

for (const id of controls) {
  const input = $(id);
  if (!input) continue;
  input.addEventListener("input", debouncedLoad);
  input.addEventListener("change", debouncedLoad);
}

$("corpSearch")?.addEventListener("input", () => {
  resolveCorpSelection();
  debouncedLoad();
});

$("corpSearch")?.addEventListener("change", () => {
  resolveCorpSelection();
  loadRows().catch(renderLoadError);
});

for (const header of document.querySelectorAll("th[data-sort]")) {
  activateSortHeader(header);
}

$("copyPermalink").addEventListener("click", () => {
  copyPermalink().catch(() => {});
});

$("toggleFilters")?.addEventListener("click", () => {
  setFilterPanelCollapsed(!$("filtersPanel")?.hidden, { persist: true });
});

$("resetFilters")?.addEventListener("click", resetFilters);

$("toggleMfgMode")?.addEventListener("click", () => {
  setMfgMode($("mode")?.value !== "manufacturer");
  loadRows().catch(renderLoadError);
});

document.querySelector('[data-ribbon-toggle="noMarketFees"]')?.addEventListener("click", () => {
  const input = $("noMarketFees");
  if (!input) return;
  input.checked = !input.checked;
  syncNoMarketFees();
  updateMfgRibbonSummary();
  debouncedLoad();
});

$("mfgRibbonToggle")?.addEventListener("click", () => {
  const collapsed = !readMfgRibbonCollapsed();
  writeMfgRibbonCollapsed(collapsed);
  applyMfgRibbonCollapsed(collapsed);
});

// facility/costIndex live-reload through the generic controls loop; they also need
// to refresh the collapsed-ribbon summary text.
for (const id of ["facility", "costIndex"]) {
  $(id)?.addEventListener("input", updateMfgRibbonSummary);
  $(id)?.addEventListener("change", updateMfgRibbonSummary);
}

for (const button of document.querySelectorAll("[data-risk-filter]")) {
  button.addEventListener("click", () => {
    $("maxRiskTier").value = button.dataset.riskFilter || defaultMaxRiskTier;
    syncRiskTierFilter();
    loadRows().catch(renderLoadError);
  });
}

for (const button of document.querySelectorAll("[data-level5-filter]")) {
  button.addEventListener("click", () => {
    $("level5Missions").value = button.dataset.level5Filter || "show";
    syncLevel5MissionFilter();
    debouncedLoad();
  });
}

for (const button of document.querySelectorAll("[data-basis-filter]")) {
  button.addEventListener("click", () => {
    $("basis").value = button.dataset.basisFilter || "best";
    syncBasisFilter();
    debouncedLoad();
  });
}

for (const button of document.querySelectorAll("[data-bpc-filter]")) {
  button.addEventListener("click", () => {
    $("bpc").value = button.dataset.bpcFilter || "none";
    syncBpcFilter();
    debouncedLoad();
  });
}

for (const button of document.querySelectorAll("[data-quality-toggle]")) {
  button.addEventListener("click", () => {
    const input = $(button.dataset.qualityToggle);
    if (!input) return;
    input.checked = !input.checked;
    syncQualityToggleButtons();
    debouncedLoad();
  });
}

function scheduleNonCriticalStartup() {
  runWhenIdle(() => {
    void Promise.allSettled([loadCorpOptions(), loadHealth()]);
  });
}

function loadInitialData() {
  void loadRows().catch(renderLoadError).finally(() => {
    scheduleNonCriticalStartup();
  });
}

loadInitialData();
