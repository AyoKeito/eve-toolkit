import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import { installFitProfileButton } from "./fit-profile.js";
import { installBetaNotice } from "./beta-notice.js";
import { el } from "./dom-util.js";
import { numberFormat as formatter } from "./formatters.js";
import { arcEmblem, ARC_PRESENTATION, LEVEL_GROUP_NAMES } from "./arc-meta.js";

const elements = {
  search: document.querySelector("#arcSearch"),
  groups: document.querySelector("#arcGroups"),
  navCount: document.querySelector("#arcNavCount"),
  status: document.querySelector("#statusLine"),
  nav: document.querySelector(".missions-actions")
};
installFitProfileButton(elements.nav);
initializeDiagnostics();
installBetaNotice();

function metaItem(children) {
  return el("span", { class: "arc-meta-item" }, children);
}

function arcStats(arc, meta) {
  const stats = (meta.rewards ?? []).map((reward) =>
    el("span", { class: "arc-stat" }, [
      el("strong", { class: `arc-stat-value${reward.tone ? ` tone-${reward.tone}` : ""}`, text: reward.value }),
      el("small", { class: "arc-stat-label", text: reward.label })
    ])
  );
  if (stats.length < 2) {
    stats.push(
      el("span", { class: "arc-stat" }, [
        el("strong", { class: "arc-stat-value", text: formatter.format(arc.mission_count ?? 0) }),
        el("small", { class: "arc-stat-label", text: "Missions" })
      ])
    );
  }
  return el("div", { class: "arc-stats" }, stats);
}

function arcRow(arc) {
  const meta = ARC_PRESENTATION[arc.arc_id] ?? {};
  const metaItems = [];
  if (arc.starting_agent) {
    metaItems.push(
      metaItem([
        el("span", { class: "arc-meta-label", text: "Entry" }),
        ` ${arc.starting_agent}${arc.starting_system ? ` · ${arc.starting_system}` : ""}`
      ])
    );
  }
  metaItems.push(metaItem(`${formatter.format(arc.mission_count ?? 0)} missions`));
  if (meta.risk) {
    metaItems.push(metaItem([el("span", { class: `badge-risk ${meta.risk.tone}`, text: meta.risk.label })]));
  }
  if (meta.metaNote) metaItems.push(metaItem(meta.metaNote));

  return el(
    "a",
    {
      class: "arc-row",
      href: `/missions/arc/${arc.arc_id}`,
      dataset: { faction: arc.faction ?? "", search: `${arc.name} ${arc.faction ?? ""}`.toLowerCase() }
    },
    [
      arcEmblem(arc),
      el("div", { class: "arc-body" }, [
        el("h3", { class: "arc-name", text: arc.name }),
        el("p", { class: "arc-flavor", text: meta.flavor ?? arc.description ?? "" }),
        el("div", { class: "arc-meta" }, metaItems)
      ]),
      arcStats(arc, meta),
      el("span", { class: "arc-cta" }, ["View arc", el("span", { class: "arc-cta-arrow", text: "→" })])
    ]
  );
}

function levelGroup(level, arcs) {
  const sublabel = LEVEL_GROUP_NAMES[level];
  return el("section", { class: "level-group", dataset: { level: String(level) } }, [
    el("header", { class: "level-heading" }, [
      el("span", { class: "level-label", text: `Level ${level}` }),
      sublabel ? el("span", { class: "level-sublabel", text: `— ${sublabel}` }) : null,
      el("span", { class: "level-sep" }),
      el("span", { class: "level-count", text: arcs.length === 1 ? "1 arc" : `${arcs.length} arcs` })
    ]),
    el(
      "ul",
      { class: "arc-list", role: "list" },
      arcs.map((arc) => el("li", {}, [arcRow(arc)]))
    )
  ]);
}

function renderGroups(arcs) {
  const byLevel = new Map();
  for (const arc of arcs) {
    const level = arc.level ?? 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(arc);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  elements.groups.replaceChildren(
    ...levels.map((level) =>
      levelGroup(
        level,
        byLevel.get(level).sort((a, b) => a.name.localeCompare(b.name))
      )
    )
  );
}

function applySearch() {
  const query = elements.search.value.trim().toLowerCase();
  for (const row of elements.groups.querySelectorAll(".arc-row")) {
    row.closest("li").hidden = Boolean(query) && !row.dataset.search.includes(query);
  }
  for (const group of elements.groups.querySelectorAll(".level-group")) {
    group.hidden = !group.querySelector("li:not([hidden])");
  }
}

function renderError(error) {
  elements.status.textContent = error?.status === 429 ? "Rate limit active" : "Mission data unavailable";
  elements.groups.replaceChildren(el("p", { class: "codex-empty error", text: apiErrorMessage(error) }));
}

async function loadArcs() {
  const response = await apiFetch("/api/arcs");
  if (!response.ok) throw responseError(response, "Arc");
  const payload = await response.json();
  const arcs = payload.rows ?? [];
  const missionTotal = arcs.reduce((sum, arc) => sum + (arc.mission_count ?? 0), 0);
  elements.navCount.textContent = formatter.format(arcs.length);
  elements.status.textContent =
    `${formatter.format(arcs.length)} epic arcs · ${formatter.format(missionTotal)} missions indexed`;
  renderGroups(arcs);
  applySearch();
}

elements.search.addEventListener("input", applySearch);
elements.search.addEventListener("keydown", (event) => {
  // The rail box filters arcs as you type; Enter hands the query to the full
  // mission browser, which searches names, objectives, and factions server-side.
  if (event.key !== "Enter") return;
  const query = elements.search.value.trim();
  location.href = query ? `/missions/browse?search=${encodeURIComponent(query)}` : "/missions/browse";
});

loadArcs().catch(renderError);
