import { escapeHtml } from "./diagnostics.js";
import { isNoValue, summarizeDetailDrawer } from "./ui-model.js";
import { compact, isk, numericFormat, ratio, ratioFormat } from "./format.js";
import { iconChip } from "./flags.js";

// The expandable per-offer detail drawer: LP store facts, product/required/build/source
// breakdowns, and the patient-fill estimate. summarizeDetailDrawer (ui-model) shapes the
// row into the grouped summary this renders.

function renderDetailList(group, renderItem, options = {}) {
  const list = document.createElement("ul");
  list.className = "detail-list";
  for (const item of group.items) {
    const li = document.createElement("li");
    li.innerHTML = renderItem(item);
    if (item.insufficientDepth) li.append(iconChip({ code: "INSUFFICIENT_DEPTH", severity: "strong" }));
    list.append(li);
  }
  if (options.showRemaining !== false && group.remaining > 0) {
    const li = document.createElement("li");
    li.className = "more-line";
    li.textContent = `+${group.remaining} more`;
    list.append(li);
  }
  return list;
}

function detailSectionTitle(title, countLabel) {
  return `<h3>${title}<span>${countLabel}</span></h3>`;
}

function fillEstimateText(row) {
  const days = row?.days_to_fill;
  if (isNoValue(days)) return "Est. patient fill: n/a (no market history)";
  const dayLabel = days < 10 ? ratioFormat.format(days) : numericFormat.format(Math.round(days));
  const queue = row?.fill_queue_ahead;
  const queuePart = isNoValue(queue) ? "" : `, queue ${numericFormat.format(Math.round(queue))} units ahead`;
  const volume = row?.avg_daily_volume_28d;
  const ratePart = isNoValue(volume) ? "" : `, ~${numericFormat.format(Math.round(volume / 2))}/day sell-side`;
  return `Est. patient fill: ~${dayLabel} days${queuePart}${ratePart}`;
}

function detailSummaryBlock(summary, row) {
  const detail = document.createElement("div");
  detail.className = "detail-grid";
  const storeCountValue = summary.store.storeCount ?? 1;

  const store = document.createElement("section");
  store.innerHTML = `
    <h3>LP store</h3>
    <p class="detail-primary">${escapeHtml(summary.store.corpName)}</p>
    <dl class="mini-dl">
      <div><dt>Station</dt><dd>${escapeHtml(summary.store.station)}</dd></div>
      <div><dt>System</dt><dd>${escapeHtml(summary.store.system)} ${summary.store.security === null ? "" : ratio(summary.store.security)}</dd></div>
      <div><dt>Stores</dt><dd>${numericFormat.format(storeCountValue)}</dd></div>
      <div><dt>Runs</dt><dd>${summary.store.runs ?? "-"}</dd></div>
      <div><dt>Capital</dt><dd>${compact(summary.store.capitalRequired)} ISK</dd></div>
      ${summary.store.jobCost > 0 ? `<div><dt>Job install</dt><dd>${compact(summary.store.jobCost)} ISK</dd></div>` : ""}
      <div><dt>Materials</dt><dd>${numericFormat.format(summary.buildMaterials.total)} lines</dd></div>
      <div><dt>Agents</dt><dd><a href="/agents/?corp=${Number(row?.corp_id) || ""}" title="Systems ranked by this corporation's mission agent density.">Find mission hubs</a></dd></div>
    </dl>
  `;
  detail.append(store);

  const products = document.createElement("section");
  products.innerHTML = detailSectionTitle("Products", `${numericFormat.format(summary.products.total)} total`);
  products.append(renderDetailList(summary.products, (item) => `<strong>${escapeHtml(item.name)}</strong><span>${isk(item.quantity)} units / ${compact(item.totalValue)} ISK</span>`));
  const fillEstimate = document.createElement("p");
  fillEstimate.className = "fill-estimate";
  fillEstimate.title = "Estimated days for a sell listing of the primary output to fill: orders queued at or below the walked list price plus your quantity, against the sell-side half of daily volume.";
  fillEstimate.textContent = fillEstimateText(row);
  products.append(fillEstimate);
  detail.append(products);

  const required = document.createElement("section");
  required.innerHTML = detailSectionTitle("Required items", `${numericFormat.format(summary.requiredItems.total)} total`);
  required.append(renderDetailList(summary.requiredItems, (item) => `<strong>${escapeHtml(item.name)}</strong><span>${isk(item.quantity)} units / avg ${ratio(item.avgPrice)}</span>`));
  detail.append(required);

  const build = document.createElement("section");
  build.innerHTML = detailSectionTitle("Build / materials", `${numericFormat.format(summary.buildMaterials.total)} total`);
  const materialNames = document.createElement("p");
  materialNames.className = "material-summary";
  materialNames.textContent = summary.buildMaterials.names || "No build materials";
  const materialCost = document.createElement("p");
  materialCost.className = "material-summary-cost";
  materialCost.textContent = `${numericFormat.format(summary.buildMaterials.total)} materials / ${compact(summary.buildMaterials.totalCost)} ISK total`;
  build.append(materialNames, materialCost);
  detail.append(build);

  const orders = document.createElement("section");
  orders.innerHTML = detailSectionTitle("Source orders", `${numericFormat.format(summary.sourceOrders.total)} total`);
  orders.append(renderDetailList(summary.sourceOrders, (item) => `<strong>${escapeHtml(item.name)}</strong><span>${isk(item.quantity)} @ ${ratio(item.avgPrice)} / ${item.locationId ?? "n/a"}</span>`));
  detail.append(orders);

  return detail;
}

export function detailBlock(row) {
  return detailSummaryBlock(summarizeDetailDrawer(row), row);
}
