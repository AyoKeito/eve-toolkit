const wholeNumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// Shared "missing value" guard for the numeric formatters (isk/ratio/compact + below).
export function isNoValue(value) {
  return value === null || value === undefined || Number.isNaN(value);
}

// Shared K/M/B/T magnitude formatter. `format` renders each scaled number; `suffix`
// is appended after the magnitude letter (e.g. "" for compact ISK, "/d" for volume).
export function compactMagnitude(value, format, suffix = "") {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `${format(value / 1_000_000_000_000)}T${suffix}`;
  if (abs >= 1_000_000_000) return `${format(value / 1_000_000_000)}B${suffix}`;
  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M${suffix}`;
  if (abs >= 1_000) return `${format(value / 1_000)}K${suffix}`;
  return `${format(value)}${suffix}`;
}

export function formatDailyVolume(value) {
  if (isNoValue(value)) return "-";
  return compactMagnitude(value, (n) => wholeNumberFormat.format(n), "/d");
}

export function deriveOfferMetrics(rows, lpPerHourValue, basisValue = "best") {
  const list = Array.isArray(rows) ? rows : [];
  const basis = normalizeBasis(basisValue);
  const bestInstant = maxByNumber(list, "isk_per_lp_instant");
  const bestPatient = maxByNumber(list, "isk_per_lp_patient");
  // "Best ISK/hr" multiplies an ISK/LP basis by LP/hour, so it may only consider rows that
  // actually have a sustainable hourly rate. Contract-priced rows deliberately show "—" in the
  // table (their isk_per_hour is null server-side) because those items sell only a few times a
  // day game-wide; including them here would fabricate an hourly income the market cannot absorb.
  const bestBasis = maxByValue(
    list.filter((row) => !row.contract_priced),
    (row) => offerIskPerLp(row, basis)
  );
  const iskPerLpValues = list
    .map((row) => offerIskPerLp(row, basis))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const lpPerHour = Number.parseFloat(lpPerHourValue || "0");
  const bestIskPerHour =
    lpPerHour > 0 && bestBasis?.value != null
      ? round2(bestBasis.value * lpPerHour)
      : null;
  const totalLpVolume = sumBy(list, (row) => row.lp_cost, (row) => row.runs ?? 1);
  const totalIskVolume = sumBy(list, (row) => row.capital_required ?? row.isk_cost);
  const flaggedRows = list.filter((row) => Array.isArray(row.flags) && row.flags.length > 0);
  const strongRows = flaggedRows.filter((row) => row.flags.some((flag) => flag.severity === "strong"));

  return {
    offerCount: list.length,
    bestInstant,
    bestPatient,
    bestIskPerHour,
    medianIskPerLp: medianNumber(iskPerLpValues),
    totalOffers: list.length,
    totalLpVolume: list.length ? totalLpVolume : null,
    totalIskVolume: list.length ? totalIskVolume : null,
    priceHealth: classifyPriceHealth(list.length, flaggedRows.length, strongRows.length)
  };
}

export function offerIskPerLp(row, basisValue = "best") {
  if (!row) return null;
  const basis = normalizeBasis(basisValue);
  if (basis === "instantSell") return finiteNumber(row.isk_per_lp_instant);
  if (basis === "patientSell") return finiteNumber(row.isk_per_lp_patient);
  if (typeof row.isk_per_lp === "number" && Number.isFinite(row.isk_per_lp)) return row.isk_per_lp;
  const values = [row.isk_per_lp_instant, row.isk_per_lp_patient].filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  return values.length ? Math.max(...values) : null;
}

// ROI follows the valuation basis like isk/LP does. On "best", show the ROI of
// the route that produced the displayed ratio — contract-priced rows have no
// instant channel, and their roi_instant (-100%) would misrepresent the offer.
export function offerRoi(row, basisValue = "best") {
  if (!row) return null;
  const basis = normalizeBasis(basisValue);
  if (basis === "instantSell") return finiteNumber(row.roi_instant);
  if (basis === "patientSell") return finiteNumber(row.roi_patient);
  const instant = finiteNumber(row.isk_per_lp_instant);
  const patient = finiteNumber(row.isk_per_lp_patient);
  if (patient !== null && (instant === null || patient >= instant)) return finiteNumber(row.roi_patient);
  return finiteNumber(row.roi_instant);
}

function normalizeBasis(value) {
  return value === "instantSell" || value === "patientSell" || value === "best" ? value : "best";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function cargoFlag(row) {
  const cargoM3 = Number(row?.cargo_m3);
  if (!Number.isFinite(cargoM3) || cargoM3 <= 100) return null;
  if (cargoM3 > 500) {
    return {
      code: "VERY_HEAVY",
      severity: "strong",
      message: "Very heavy cargo above 500 m3"
    };
  }
  return {
    code: "HEAVY",
    severity: "warn",
    message: "Heavy cargo above 100 m3"
  };
}

export function summarizeDetailDrawer(row) {
  if (!row) return null;
  if (row.detail_summary) return row.detail_summary;
  const salesTargets = Array.isArray(row.sales_targets) ? row.sales_targets : [];
  const inputLines = Array.isArray(row.input_lines) ? row.input_lines : [];
  const buildLines = Array.isArray(row.build_lines) ? row.build_lines : [];
  const sourceOrders = [];

  for (const target of salesTargets) {
    for (const order of target.walk?.orders || []) {
      sourceOrders.push({
        label: target.name || "Unknown item",
        quantity: order.consumed_qty ?? order.qty ?? null,
        price: order.price ?? null,
        locationId: order.location_id ?? null
      });
    }
  }

  return {
    store: {
      corpName: row.corp_name ?? "Unknown corporation",
      station: row.corp_station ?? "Unknown station",
      system: row.corp_system ?? "unknown system",
      security: row.corp_security ?? null,
      runs: row.runs ?? null,
      capitalRequired: row.capital_required ?? null,
      buildCost: row.build_cost ?? null,
      jobCost: row.job_cost ?? null,
      storeCount: row.store_count ?? row.store_options?.length ?? 1
    },
    products: cappedItems(salesTargets, 2),
    requiredItems: cappedItems(inputLines, 3),
    buildMaterials: cappedItems(buildLines, buildLines.length),
    sourceOrders: cappedItems(sourceOrders, 4)
  };
}

export function resolveCorpOption(options, value) {
  const list = Array.isArray(options) ? options : [];
  const needle = String(value ?? "").trim().toLowerCase();
  if (!needle) return null;

  const exact = list.find((corp) => corpName(corp).toLowerCase() === needle);
  if (exact) return exact;

  const prefixMatches = list.filter((corp) => corpName(corp).toLowerCase().startsWith(needle));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

function corpName(corp) {
  return corp?.name ?? corp?.corp_name ?? "";
}

export function classifyHealth(health) {
  if (!health) return { label: "Unavailable", tone: "muted" };
  return health.status === "ok"
    ? { label: "Healthy", tone: "good" }
    : { label: "Needs attention", tone: "bad" };
}

const cloudflarePurgeFreshnessMs = 2 * 60 * 60 * 1000;

export function classifyCloudflarePurge(purge, nowMs = Date.now()) {
  if (!purge) {
    return { label: "Edge purge -", tone: "muted", detail: "No Cloudflare edge purge recorded since the last deploy." };
  }
  if (purge.status === "error") {
    const code = purge.status_code ? ` HTTP ${purge.status_code}.` : "";
    const error = purge.error ? ` ${purge.error}` : "";
    return {
      label: "Edge purge failing",
      tone: "bad",
      detail: `Cloudflare edge purge failed; cached API responses may stay stale for up to 15 minutes.${code}${error}`
    };
  }
  if (purge.status === "skipped") {
    return {
      label: "Edge purge off",
      tone: "muted",
      detail: `Cloudflare edge purge skipped (${purge.reason ?? "not configured"}).`
    };
  }
  const atMs = Date.parse(purge.at ?? "");
  if (!Number.isFinite(atMs)) {
    return { label: "Edge purge -", tone: "muted", detail: "Cloudflare edge purge timestamp unavailable." };
  }
  if (nowMs - atMs > cloudflarePurgeFreshnessMs) {
    return {
      label: "Edge purge stale",
      tone: "warn",
      detail: "Last successful Cloudflare edge purge is older than two hours."
    };
  }
  return { label: "Edge purged", tone: "good", detail: "Cloudflare edge cache purged after the latest recompute." };
}

export function selectLatestFetcherStatus(fetchers, names) {
  const allowedNames = new Set(names);
  const matches = (Array.isArray(fetchers) ? fetchers : []).filter((fetcher) => allowedNames.has(fetcher?.name));
  let latest = null;
  let latestMs = -Infinity;

  for (const fetcher of matches) {
    const lastSuccessMs = Date.parse(fetcher?.last_success ?? "");
    if (Number.isFinite(lastSuccessMs) && lastSuccessMs > latestMs) {
      latest = fetcher;
      latestMs = lastSuccessMs;
    }
  }

  return latest ?? matches[0] ?? null;
}

export function classifyFetcherFreshness(fetcher, maxAgeMs, nowMs = Date.now()) {
  if (!fetcher) return { tone: "bad", issue: "missing_status" };
  if (fetcher.last_error_at) return { tone: "bad", issue: "last_run_failed" };
  if (!fetcher.last_success) return { tone: "bad", issue: "missing_success" };

  const lastSuccessMs = Date.parse(fetcher.last_success);
  if (!Number.isFinite(lastSuccessMs)) return { tone: "bad", issue: "invalid_success" };
  if (nowMs - lastSuccessMs > maxAgeMs) return { tone: "bad", issue: "stale" };

  return { tone: "good", issue: null };
}

function classifyPriceHealth(rowCount, flaggedCount, strongCount) {
  if (!rowCount) return { label: "No data", tone: "muted", note: "waiting for rows" };
  if (strongCount > 0) return { label: "Risk", tone: "bad", note: `${strongCount} strong ${plural(strongCount, "flag")}` };
  if (flaggedCount > 0) return { label: "Watch", tone: "warn", note: `${flaggedCount} flagged ${plural(flaggedCount, "row")}` };
  return { label: "Healthy", tone: "good", note: "no active flags" };
}

function maxByNumber(rows, key) {
  let best = null;
  for (const row of rows) {
    const value = row?.[key];
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (!best || value > best[key]) best = row;
  }
  return best;
}

function maxByValue(rows, getValue) {
  let best = null;
  for (const row of rows) {
    const value = getValue(row);
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (!best || value > best.value) best = { row, value };
  }
  return best;
}

function medianNumber(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return round2(value);
}

function cappedItems(items, limit) {
  const mapped = items.map((item) => normalizeLine(item));
  return {
    items: mapped.slice(0, limit),
    remaining: Math.max(0, mapped.length - limit),
    total: mapped.length,
    names: mapped.map((item) => item.name).join(", "),
    totalCost: sumBy(mapped, (item) => item.totalValue)
  };
}

function normalizeLine(line) {
  return {
    name: line.name ?? line.type_name ?? line.label ?? "Unknown item",
    quantity: line.quantity ?? null,
    totalValue: line.walk?.total_value ?? line.totalValue ?? null,
    avgPrice: line.walk?.avg_price ?? line.avgPrice ?? line.price ?? null,
    locationId: line.locationId ?? null,
    insufficientDepth: Boolean(line.walk?.insufficient_depth)
  };
}

function sumBy(rows, getValue, getMultiplier = () => 1) {
  let total = 0;
  let hasValue = false;
  for (const row of rows) {
    const value = getValue(row);
    const multiplier = getMultiplier(row);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    hasValue = true;
    total += value * (typeof multiplier === "number" && Number.isFinite(multiplier) ? multiplier : 1);
  }
  return hasValue ? total : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}
