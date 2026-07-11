// Trending fits page — fetches /api/fits/trending and renders a sortable leaderboard with
// per-fit shopping lists, live-vs-estimated pricing, and a build→sell margin model. Owner-only.
import { escapeHtml } from "/shared/utils.js";

const API = "/api/fits/trending";
const FETCH_LIMIT = 150;
const $ = (sel) => document.querySelector(sel);

const state = { windowDays: 0, shipClass: "all", sort: "open_demand", search: "", markup: 0.2, minLost: 0 };
let DATA = null;
let FITS = [];
let maxLoss = 1;
let byHash = {};

function isk(n) {
  if (!n) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + " B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + " M";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + " k";
  return String(Math.round(n));
}
function iskFull(n) { return Math.round(n).toLocaleString("en-US") + " ISK"; }
function icon(id, size) { return `https://images.evetech.net/types/${id}/icon?size=${size}`; }

const sellOf = (f) => Math.round(f.build_cost * (1 + state.markup));
const profitOf = (f) => sellOf(f) - f.build_cost;
// Opportunity = total ISK on the table if you captured every loss as a sale; profit-per-m³ is
// the hauler's true yield per unit of hold spent. Both depend on the markup, so they live here
// (client-side) and react to the markup toggle without a refetch — same as sellOf/profitOf.
const oppOf = (f) => profitOf(f) * f.losses;
const profitPerM3 = (f) => (f.volume_m3 > 0 ? profitOf(f) / f.volume_m3 : 0);
// Sort key for momentum: "new" fits (null pct, no prior baseline) sort to the very top.
const trendScore = (f) => (f.momentum_pct == null ? Number.POSITIVE_INFINITY : f.momentum_pct);
// Supply side: days of contract cover at the current loss rate (0 = nobody's selling it), and the
// "underserved" lens = demand per existing seller. Drive the On-market column + sort. Both are
// markup-independent (counts come straight from the API).
const coverDays = (f) => (f.losses_per_day > 0 ? f.hull_contracts / f.losses_per_day : f.hull_contracts > 0 ? Infinity : 0);
const underservedScore = (f) => f.losses_per_day / (f.hull_contracts + 1);
// Demand breadth: many distinct corps = many independent buyers (an open market). A high single-corp
// share means the losses are one fleet's self-supplied DOCTRINE — resupplied internally, so they
// never become a contract sale. open-market demand strips that dominant-corp share out of the loss
// count, so the board stops ranking doctrine fits at the top. All markup-independent (from the API).
const topShare = (f) => f.top_corp_share || 0;
const openDemand = (f) => Math.round(f.losses * (1 - topShare(f)));
const isDoctrine = (f) => topShare(f) >= 0.6;
const isBroad = (f) => (f.corps || 0) >= 5 && topShare(f) <= 0.4;

function fmtPct(p) {
  const v = Math.round(p * 100);
  return (v > 0 ? "+" : "") + v + "%";
}
function fmtRate(r) {
  if (!r) return "0";
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1).replace(/\.0$/, "");
}
function trendCell(f) {
  if (f.momentum_pct == null) {
    return '<span class="trend up" title="No losses in the prior half of the window — new this window">▲ new</span>';
  }
  const cls = f.trend === "rising" ? "up" : f.trend === "falling" ? "down" : "flat";
  const glyph = f.trend === "rising" ? "▲" : f.trend === "falling" ? "▼" : "·";
  const title = `${f.recent_losses} lost in the recent half vs ${f.prior_losses} in the prior half`;
  return `<span class="trend ${cls}" title="${title}">${glyph} ${fmtPct(f.momentum_pct)}</span>`;
}
function trendDetail(f) {
  const span = `${f.recent_losses} vs ${f.prior_losses}`;
  if (f.momentum_pct == null) return `<span class="trend up">New this window</span> · ${f.recent_losses} recent`;
  const cls = f.trend === "rising" ? "up" : f.trend === "falling" ? "down" : "flat";
  const word = f.trend === "rising" ? "Rising" : f.trend === "falling" ? "Falling" : "Steady";
  return `<span class="trend ${cls}">${word} ${fmtPct(f.momentum_pct)}</span> · ${span}`;
}
function fmtCover(c) {
  if (!isFinite(c)) return "∞";
  return c >= 10 ? String(Math.round(c)) : c.toFixed(1).replace(/\.0$/, "");
}
// On-market cell: count of warzone contracts selling this hull (the supply), with the exact-fit
// count as a subline. Colored by how stocked the shelf is vs demand — open/undersupplied is the
// opportunity, saturated is the warning.
function onMarketCell(f) {
  const n = f.hull_contracts || 0;
  const cover = coverDays(f);
  const cls = n === 0 ? "open" : cover < 1 ? "good" : cover > 3 ? "sat" : "mid";
  const sub = n === 0 ? "no sellers" : `${f.exact_contracts} exact`;
  const title =
    n === 0
      ? "No warzone contracts sell this hull — open shelf"
      : `${n} warzone contract${n === 1 ? "" : "s"} sell this hull, ${f.exact_contracts} your exact fit` +
        (f.cheapest_ask != null ? `; cheapest ask ${isk(f.cheapest_ask)}` : "");
  return `<span class="mkt ${cls}" title="${escapeHtml(title)}"><span class="mkt-num">${n}</span><span class="mkt-sub">${sub}</span></span>`;
}
// Breadth cell: how many distinct corps lost this fit + the dominant corp's share. Broad spread
// (green) = many independent buyers; a high single-corp share (red "doctrine") = one fleet feeding
// itself, which looks like demand on raw losses but won't convert to contract sales.
function breadthCell(f) {
  const share = Math.round(topShare(f) * 100);
  const doc = isDoctrine(f);
  const cls = doc ? "doctrine" : isBroad(f) ? "broad" : "mid";
  const sub = doc ? `${share}% one corp` : `${share}% top corp`;
  const title = doc
    ? `${f.corps} corp${f.corps === 1 ? "" : "s"} lost this fit but ${share}% of losses come from a single corp — a self-supplied fleet doctrine, not open-market demand. Open-market demand ≈ ${openDemand(f)}.`
    : `${f.corps} distinct corps lost this fit; the biggest is ${share}% of losses — broad independent demand. Open-market demand ≈ ${openDemand(f)}.`;
  return `<span class="breadth ${cls}" title="${escapeHtml(title)}"><span class="breadth-num">${f.corps || 0}</span><span class="breadth-sub">${sub}</span></span>`;
}
// Competition detail: supply counts + cheapest ask vs your sell (undercut check, markup-dependent),
// days of cover, and the free "also in Jita" line. Jita rarely stocks these — 0 there means you'd
// be the only hub seller.
function competitionCard(f) {
  const sell = sellOf(f);
  const cheapest = f.cheapest_ask;
  const undercut = cheapest != null && cheapest < sell;
  const cover = coverDays(f);
  const coverTxt =
    f.hull_contracts === 0 ? "wide open" : f.losses_per_day > 0 ? `${fmtCover(cover)} days at current loss rate` : "—";
  let verdict;
  if (cheapest == null) verdict = "No competing asks on the warzone shelf — open lane.";
  else if (undercut) verdict = `Cheapest competitor ${iskFull(cheapest)} undercuts your ${iskFull(sell)} sell.`;
  else verdict = `You'd be the cheapest at ${iskFull(sell)} (next is ${iskFull(cheapest)}).`;
  return (
    `<div class="buy-card"><h4>Competition (warzone contracts)</h4>` +
    `<div class="kv"><span>Selling this hull</span><b>${f.hull_contracts}</b></div>` +
    `<div class="kv"><span>Your exact fit on sale</span><b>${f.exact_contracts}</b></div>` +
    `<div class="kv"><span>Cheapest ask</span><b class="${undercut ? "neg" : "pos"}">${cheapest != null ? isk(cheapest) : "—"}</b></div>` +
    `<div class="kv"><span>Days of cover</span><b>${coverTxt}</b></div>` +
    `<div class="kv"><span>Also in Jita</span><b>${f.jita_contracts}</b></div>` +
    `<div class="buy-sub">${escapeHtml(verdict)} "Warzone" = the 9 FW regions where pilots rebuy; "exact" matches your fitted modules (clean pre-fits only — bundles with extra cargo won't match).</div></div>`
  );
}

async function load() {
  $("#loading").hidden = false;
  $("#loading").textContent = "Loading…";
  $("#empty").hidden = true;
  $("#rows").innerHTML = "";
  const qs = new URLSearchParams({ limit: String(FETCH_LIMIT), min_losses: "2" });
  if (state.windowDays > 0) qs.set("window", String(state.windowDays));
  try {
    const res = await fetch(`${API}?${qs.toString()}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    $("#loading").textContent = "Failed to load fits: " + (err && err.message ? err.message : err);
    return;
  }
  FITS = DATA.fits || [];
  byHash = Object.fromEntries(FITS.map((f) => [f.fit_hash, f]));
  maxLoss = Math.max(1, ...FITS.map((f) => f.losses));
  $("#loading").hidden = true;
  renderHeader();
  renderClassSeg();
  syncHeaderSort();
  renderRows();
}

function renderHeader() {
  const r = DATA.data_range || {};
  $("#subline").innerHTML =
    `Lowsec faction-warfare losses · <b>${r.from || "?"} → ${r.to || "?"}</b> · ` +
    `<b>${(DATA.total_kills_in_window || 0).toLocaleString()}</b> kills in window`;
  const top = FITS[0];
  // Headline riser: the fastest-growing fit that already carries real recent volume (so a
  // 1→3 fluke can't top it). momentum is markup-independent, so this stays valid across markups.
  const riser = FITS.filter((f) => f.recent_losses >= 10).sort((a, b) => trendScore(b) - trendScore(a))[0];
  const riserNote = riser ? (riser.momentum_pct == null ? "new this window" : fmtPct(riser.momentum_pct) + " recent vs prior") : "";
  // Broadest demand: the strongest OPEN-MARKET fit (losses with the dominant-corp doctrine share
  // stripped out) — what you'd actually sell, as opposed to "Most lost" which can be a self-supplied
  // doctrine. Only meaningful once corp data exists in the response.
  const broad = top && top.corps != null
    ? FITS.filter((f) => f.losses >= 20).sort((a, b) => openDemand(b) - openDemand(a))[0]
    : null;
  const broadNote = broad ? `${broad.corps} corps · ${Math.round(topShare(broad) * 100)}% top corp` : "";
  const metrics = [
    { l: "Fits ranked", v: DATA.count, n: "combat hulls, ≥3 modules" },
    { l: "Most lost", v: top ? top.ship_name : "—", n: top ? top.losses + " losses" : "" },
    { l: "Broadest demand", v: broad ? broad.ship_name : "—", n: broadNote },
    { l: "Rising fastest", v: riser ? riser.ship_name : "—", n: riserNote }
  ];
  // Only show the supply-aware "Most underserved" headline once warzone contract data exists;
  // before the saturation scan runs, every fit reads 0 sellers and it would just mirror Most lost.
  if (FITS.some((f) => f.hull_contracts > 0)) {
    const under = FITS.filter((f) => f.losses >= 20).sort((a, b) => underservedScore(b) - underservedScore(a))[0];
    const note = under ? `${under.hull_contracts} on market · ${fmtRate(under.losses_per_day)}/day` : "";
    metrics.push({ l: "Most underserved", v: under ? under.ship_name : "—", n: note });
  }
  metrics.push({ l: "Data span", v: (r.days_available || 0) + "d", n: `${r.from || "?"} → ${r.to || "?"}` });
  $("#metrics").innerHTML = metrics
    .map((m) => `<div class="metric"><div class="ml">${m.l}</div><div class="mv">${escapeHtml(String(m.v))}</div><div class="mn">${escapeHtml(String(m.n))}</div></div>`)
    .join("");
}

function renderClassSeg() {
  const counts = {};
  for (const f of FITS) if (f.group_name) counts[f.group_name] = (counts[f.group_name] || 0) + 1;
  const classes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const cur = state.shipClass;
  $("#classSeg").innerHTML =
    `<button type="button" data-class="all" aria-pressed="${cur === "all"}">All</button>` +
    classes
      .map((c) => `<button type="button" data-class="${escapeHtml(c)}" aria-pressed="${cur === c}">${escapeHtml(c)}</button>`)
      .join("");
}

function visibleFits() {
  const q = state.search.trim().toLowerCase();
  const list = FITS.filter((f) => {
    if (state.shipClass !== "all" && f.group_name !== state.shipClass) return false;
    if (state.minLost && f.losses < state.minLost) return false;
    if (q && !f.ship_name.toLowerCase().includes(q)) return false;
    return true;
  });
  const cmp = {
    losses: (a, b) => b.losses - a.losses || b.pilots - a.pilots,
    pilots: (a, b) => b.pilots - a.pilots || b.losses - a.losses,
    build_cost: (a, b) => b.build_cost - a.build_cost,
    sell: (a, b) => sellOf(b) - sellOf(a),
    profit: (a, b) => profitOf(b) - profitOf(a),
    opportunity: (a, b) => oppOf(b) - oppOf(a),
    trend: (a, b) => trendScore(b) - trendScore(a) || b.losses - a.losses,
    open_demand: (a, b) => openDemand(b) - openDemand(a) || b.losses - a.losses,
    underserved: (a, b) => underservedScore(b) - underservedScore(a) || b.losses - a.losses,
    profit_density: (a, b) => profitPerM3(b) - profitPerM3(a),
    mods: (a, b) => b.module_count - a.module_count,
    density: (a, b) => b.isk_per_m3 - a.isk_per_m3,
    name: (a, b) => a.ship_name.localeCompare(b.ship_name)
  }[state.sort] || ((a, b) => b.losses - a.losses);
  return list.slice().sort(cmp);
}

function srcChip(source) {
  if (source === "jita") return '<span class="src-chip good">live</span>';
  if (source === "est") return '<span class="src-chip">est</span>';
  return '<span class="src-chip warn">none</span>';
}

function whereCard(f) {
  const sys = f.top_systems || [];
  const max = sys.length ? sys[0].count : 1;
  const rows = sys.length
    ? sys
        .map((s) => {
          const w = Math.max(8, Math.round((s.count / max) * 100));
          return (
            `<div class="hot-row"><span class="nm">${escapeHtml(s.name)}${s.region ? ` <em class="rg">${escapeHtml(s.region)}</em>` : ""}</span>` +
            `<span class="bar"><i style="width:${w}%"></i></span><span class="ct">${s.count}</span></div>`
          );
        })
        .join("")
    : `<div class="buy-sub">No location data.</div>`;
  return (
    `<div class="buy-card"><h4>Where it dies — sell near here</h4>${rows}` +
    `<div class="buy-sub">Top systems where this fit was lost in the window — stage sell contracts here or at the nearest faction-warfare hub.</div></div>`
  );
}

function multibuy(f) {
  const lines = [`${f.ship_name} 1`];
  for (const m of f.modules) lines.push(`${m.name} ${m.qty}`);
  return lines.join("\n");
}

function detailHtml(f) {
  const rows = [
    `<tr class="hull"><td class="mod-name"><img loading="lazy" src="${icon(f.ship_type_id, 32)}" alt=""/>${escapeHtml(f.ship_name)} <span class="mod-qty">(hull)</span></td>` +
      `<td class="r mod-qty">1</td><td class="r">${isk(f.hull_price)}</td><td class="r">${srcChip(f.hull_source)}</td></tr>`
  ];
  for (const m of f.modules) {
    rows.push(
      `<tr><td class="mod-name"><img loading="lazy" src="${icon(m.type_id, 32)}" alt=""/>${escapeHtml(m.name)}</td>` +
        `<td class="r mod-qty">${m.qty}</td><td class="r">${isk(m.line_value)}</td><td class="r">${srcChip(m.source)}</td></tr>`
    );
  }
  const sell = sellOf(f);
  const profit = profitOf(f);
  const zk = `https://zkillboard.com/ship/${f.ship_type_id}/`;
  return (
    `<div class="detail-inner">` +
    `<div><table class="mod-table"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Value</th><th class="r">Price</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody>` +
    `<tfoot><tr><td>Total build cost</td><td class="r"></td><td class="r">${isk(f.build_cost)}</td><td></td></tr></tfoot></table></div>` +
    `<div class="buy-panel">` +
    `<div class="buy-card"><h4>Build → sell (+${Math.round(state.markup * 100)}%)</h4>` +
    `<div class="price-grid">` +
    `<div><div class="pg-l">Build</div><div class="pg-v">${isk(f.build_cost)}</div></div>` +
    `<div><div class="pg-l">Sell at</div><div class="pg-v">${isk(sell)}</div></div>` +
    `<div><div class="pg-l">Profit</div><div class="pg-v profit pos">${isk(profit)}</div></div>` +
    `</div>` +
    `<div class="buy-sub">${iskFull(f.build_cost)} to build · sell ${iskFull(sell)} · ${Math.round((f.value_priced_share || 0) * 100)}% of cost from live Jita orders, rest ESI estimate. Hull + ${f.module_count} modules; ammo/drones not included.</div></div>` +
    `<div class="buy-card"><h4>Demand &amp; hauling</h4>` +
    `<div class="kv"><span>Demand rate</span><b>${fmtRate(f.losses_per_day)} losses/day</b></div>` +
    `<div class="kv"><span>Trend (recent vs prior)</span><b>${trendDetail(f)}</b></div>` +
    `<div class="kv"><span>Pilots lost it</span><b>${f.pilots}</b></div>` +
    `<div class="kv"><span>Systems seen</span><b>${f.systems}</b></div>` +
    `<div class="kv"><span>Demand breadth</span><b class="${isDoctrine(f) ? "neg" : isBroad(f) ? "pos" : ""}">${f.corps || 0} corps · ${Math.round(topShare(f) * 100)}% top corp${isDoctrine(f) ? " (doctrine)" : ""}</b></div>` +
    `<div class="kv"><span>Open-market demand</span><b>${openDemand(f)} <span class="unit">of ${f.losses}</span></b></div>` +
    `<div class="kv"><span>Opportunity (window)</span><b>${isk(oppOf(f))}</b></div>` +
    `<div class="kv"><span>Losses (lifetime)</span><b>${f.losses_lifetime}</b></div>` +
    `<div class="kv"><span>Last seen</span><b>${(f.last_seen || "").slice(0, 10) || "—"}</b></div>` +
    `<div class="kv"><span>Components volume</span><b>${(f.volume_m3 || 0).toLocaleString()} m³</b></div>` +
    `<div class="kv"><span>Profit / m³</span><b>${isk(profitPerM3(f))} / m³</b></div>` +
    `<div class="kv"><span>Value density (build)</span><b>${isk(f.isk_per_m3)} / m³</b></div>` +
    `</div>` +
    competitionCard(f) +
    whereCard(f) +
    `<div class="buy-card"><h4>Buy list (EVE multibuy)</h4>` +
    `<button type="button" class="buy-btn" data-copy="${f.fit_hash}">Copy multibuy</button>` +
    `<textarea class="multibuy" readonly id="mb-${f.fit_hash}">${escapeHtml(multibuy(f))}</textarea>` +
    `<div class="buy-sub"><a class="zk-link" href="${zk}" target="_blank" rel="noopener">View ${escapeHtml(f.ship_name)} on zKillboard ↗</a></div></div>` +
    `</div></div>`
  );
}

function renderRows() {
  const list = visibleFits();
  $("#empty").hidden = list.length > 0;
  $("#countNote").innerHTML = `<b>${list.length}</b> fit${list.length === 1 ? "" : "s"}`;
  $("#rows").innerHTML = list
    .map((f, i) => {
      const barPct = Math.round((f.losses / maxLoss) * 100);
      const profit = profitOf(f);
      return (
        `<tr class="fit-row" data-hash="${f.fit_hash}">` +
        `<td class="rank">${i + 1}</td>` +
        `<td class="shipcol"><div class="ship-cell"><img loading="lazy" src="${icon(f.ship_type_id, 64)}" alt=""/>` +
        `<div class="ship-meta"><span class="ship-name">${escapeHtml(f.ship_name)}</span><span class="ship-class">${escapeHtml(f.group_name || "")}</span></div></div></td>` +
        `<td><span class="loss-cell"><span class="loss-num">${f.losses}</span><span class="loss-bar"><i style="width:${barPct}%"></i></span><span class="loss-rate">${fmtRate(f.losses_per_day)}/day</span></span></td>` +
        `<td>${trendCell(f)}</td>` +
        `<td class="pilots">${f.pilots}</td>` +
        `<td>${breadthCell(f)}</td>` +
        `<td>${onMarketCell(f)}</td>` +
        `<td class="val">${isk(f.build_cost)} <span class="unit">ISK</span></td>` +
        `<td class="profit pos">${isk(profit)}</td>` +
        `<td class="val">${isk(oppOf(f))}</td>` +
        `<td class="val muted">${isk(profitPerM3(f))}</td>` +
        `</tr>` +
        `<tr class="fit-detail" data-detail="${f.fit_hash}" hidden><td colspan="11"></td></tr>`
      );
    })
    .join("");
}

// ---- interactions ----
$("#rows").addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".buy-btn");
  if (copyBtn) {
    const f = byHash[copyBtn.dataset.copy];
    const ta = document.getElementById("mb-" + f.fit_hash);
    if (ta) ta.select();
    navigator.clipboard?.writeText(multibuy(f)).catch(() => {});
    copyBtn.classList.add("copied");
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => { copyBtn.classList.remove("copied"); copyBtn.textContent = "Copy multibuy"; }, 1400);
    return;
  }
  const row = e.target.closest(".fit-row");
  if (!row) return;
  const detail = document.querySelector(`tr.fit-detail[data-detail="${row.dataset.hash}"]`);
  if (!detail.hidden) {
    detail.hidden = true;
    row.classList.remove("open");
    detail.firstElementChild.innerHTML = "";
  } else {
    detail.firstElementChild.innerHTML = detailHtml(byHash[row.dataset.hash]);
    detail.hidden = false;
    row.classList.add("open");
  }
});

function pressOnly(container, btn) {
  for (const x of container.children) x.setAttribute("aria-pressed", x === btn ? "true" : "false");
}
function wireSeg(id, handler) {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    pressOnly(el, b);
    handler(b);
  });
}
wireSeg("#windowSeg", (b) => { state.windowDays = Number(b.dataset.days); load(); });
wireSeg("#minLostSeg", (b) => { state.minLost = Number(b.dataset.min); renderRows(); });
wireSeg("#classSeg", (b) => { state.shipClass = b.dataset.class; renderRows(); });
wireSeg("#markupSeg", (b) => { state.markup = Number(b.dataset.markup); renderRows(); });
wireSeg("#sortSeg", (b) => {
  state.sort = b.dataset.sort;
  syncHeaderSort();
  renderRows();
});
$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderRows(); });

function syncHeaderSort() {
  document.querySelectorAll("thead th").forEach((h) => h.classList.toggle("sorted", h.dataset.sort === state.sort));
  for (const x of $("#sortSeg").children) x.setAttribute("aria-pressed", x.dataset.sort === state.sort ? "true" : "false");
}
document.querySelectorAll("thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => { state.sort = th.dataset.sort; syncHeaderSort(); renderRows(); });
});

load();
