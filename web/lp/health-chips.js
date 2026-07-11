import { apiFetch, setChip } from "./diagnostics.js";
import { classifyCloudflarePurge, classifyFetcherFreshness, classifyHealth, selectLatestFetcherStatus } from "./ui-model.js";
import { ageLabel, refreshedLabel } from "./format.js";

// The topbar staleness/health chips: price + LP fetcher freshness, overall health,
// and the Cloudflare edge-purge status, driven by /lp/api/health.

const $ = (id) => document.getElementById(id);

const fetcherFreshnessMs = {
  lp: 48 * 60 * 60 * 1000,
  pricesHot: 30 * 60 * 1000,
  pricesCold: 2 * 60 * 60 * 1000
};

export async function loadHealth() {
  const response = await apiFetch("/lp/api/health");
  if (!response.ok) {
    renderStalenessChips(null);
    return;
  }
  const health = await response.json();
  const fetchers = health.fetcher_status || [];
  const hot = fetchers.find((item) => item.name === "esi-prices-hot") ?? null;
  const cold = fetchers.find((item) => item.name === "esi-prices-cold") ?? null;
  const price = selectLatestFetcherStatus(fetchers, ["esi-prices-hot", "esi-prices-cold"]);
  const lp = fetchers.find((item) => item.name === "esi-lp") ?? null;
  $("statusLine").className = health.status === "ok" ? "ok" : "bad";
  renderStalenessChips(health, { hot, cold, price, lp });
}

function setStalenessChip(id, label, tone, title = label) {
  setChip(id, label, title, { tone });
}

function ageToken(isoValue) {
  const label = ageLabel(isoValue);
  return label === "-" ? "missing" : label;
}

function strongestTone(...tones) {
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("good")) return "good";
  return "muted";
}

function fetcherTitle(label, fetcher, cadence) {
  const error = fetcher?.last_error_msg ? ` Last error: ${fetcher.last_error_msg}` : "";
  return `${label}: ${refreshedLabel(fetcher?.last_success)}; cadence ${cadence}.${error}`;
}

function healthTitle(health) {
  const issues = Array.isArray(health?.issues) ? health.issues : [];
  return issues.length
    ? `Health issues: ${issues.join(", ")}`
    : "All required fetchers are inside their freshness windows.";
}

function renderPurgeChip(purge) {
  const classified = classifyCloudflarePurge(purge);
  const ageSuffix = purge?.status === "ok" ? ` ${refreshedLabel(purge.at)}` : "";
  setStalenessChip("stalePurge", `${classified.label}${ageSuffix}`, classified.tone, classified.detail);
}

function renderStalenessChips(health, statuses = {}) {
  const classified = classifyHealth(health);
  if (!health) {
    setStalenessChip("stalePrices", "Prices unavailable", "muted", "Market price freshness could not be loaded.");
    setStalenessChip("staleLp", "LP unavailable", "muted", "LP offer freshness could not be loaded.");
    setStalenessChip("staleHealth", classified.label, classified.tone, "Overall fetcher health from /api/health.");
    setStalenessChip("stalePurge", "Edge purge -", "muted", "Cloudflare edge purge status could not be loaded.");
    return;
  }

  const priceTone = strongestTone(
    classifyFetcherFreshness(statuses.hot, fetcherFreshnessMs.pricesHot).tone,
    classifyFetcherFreshness(statuses.cold, fetcherFreshnessMs.pricesCold).tone
  );
  const lpTone = classifyFetcherFreshness(statuses.lp, fetcherFreshnessMs.lp).tone;
  const priceLabel = statuses.hot || statuses.cold
    ? `Prices hot ${ageToken(statuses.hot?.last_success)} / cold ${ageToken(statuses.cold?.last_success)}`
    : `Prices ${refreshedLabel(statuses.price?.last_success)}`;
  const priceTitle = [
    fetcherTitle("Hot market prices", statuses.hot, "every 15 minutes"),
    fetcherTitle("Cold market prices", statuses.cold, "hourly")
  ].join(" ");

  setStalenessChip("stalePrices", priceLabel, priceTone, priceTitle);
  setStalenessChip(
    "staleLp",
    `LP daily ${refreshedLabel(statuses.lp?.last_success)}`,
    lpTone,
    fetcherTitle("LP offers", statuses.lp, "daily at 11:10 UTC")
  );
  setStalenessChip(
    "staleHealth",
    classified.label === "Healthy" ? "Updates OK" : classified.label,
    classified.tone,
    healthTitle(health)
  );
  renderPurgeChip(health.cloudflare_purge ?? null);
}
