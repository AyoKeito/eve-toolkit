// /missions/burners — Anomic burners mission guide. Single scrollable page: sticky
// anchor-nav rail (content-type nav + guide-section TOC) and category sections with
// mission cards, variant tabs, and EFT fit cards. DOM building follows the el()
// convention used by app.js/detail.js; the DOM-free parsing/ordering/lookup logic
// lives in burners-util.js so it can be unit tested without a browser.
import { apiErrorMessage, apiFetch, initializeDiagnostics, responseError } from "./diagnostics.js";
import { installBetaNotice } from "./beta-notice.js";
import { el } from "./dom-util.js";
import {
  parseEft,
  isEmptySlotLine,
  sortVariants,
  findEnemyShip,
  missionNameLookup,
  diffTone,
  factsEntries,
  quickFactsEntries
} from "./burners-util.js";

const DATA_URL = "/api/burners";

initializeDiagnostics();
installBetaNotice();

const elements = {
  toc: document.querySelector("#burnersToc"),
  main: document.querySelector("#burnersMain"),
  status: document.querySelector("#statusLine")
};

// Ship type ids from the payload (name -> typeID), used for ship icons and the
// "vs <enemy ship>" hint. Populated once the guide loads.
let SHIP_IDS = {};

// ---- ship icon: fixed-size placeholder box so nothing shifts while the image loads;
// on a failed load we hide the <img> (not the box), so a broken network fetch leaves a
// plain placeholder rather than a broken-image glyph. Unknown ship names (not in the
// payload's ship_type_ids map) get a two-letter initials badge instead of an icon. ----
function shipIcon(shipName, size = 34) {
  const wrap = el("span", {
    class: "burner-ship-icon-wrap",
    style: { width: `${size}px`, height: `${size}px` },
    title: shipName
  });
  const typeId = SHIP_IDS[shipName];
  if (!typeId) {
    wrap.append(el("span", { class: "burner-ship-initials", text: shipName.slice(0, 2).toUpperCase() }));
    return wrap;
  }
  const img = el("img", {
    class: "burner-ship-icon",
    width: size,
    height: size,
    loading: "lazy",
    decoding: "async",
    src: `https://images.evetech.net/types/${typeId}/icon?size=64`,
    alt: shipName
  });
  img.addEventListener("error", () => {
    img.style.display = "none";
  });
  wrap.append(img);
  return wrap;
}

// ---- clipboard ----
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function copyButton(label, text) {
  const btn = el("button", { type: "button", class: "button ghost burner-copy", text: label });
  btn.addEventListener("click", async () => {
    const ok = await copyText(text);
    btn.textContent = ok ? "Copied!" : "Copy failed";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = label;
      btn.disabled = false;
    }, 1500);
  });
  return btn;
}

// ---- small building blocks ----
function chip(children, tone) {
  return el("span", { class: tone ? `chip is-${tone}` : "chip" }, children);
}

function diffChip(difficulty) {
  if (!difficulty) return null;
  return chip(`${difficulty} difficulty`, diffTone(difficulty));
}

function factsGrid(facts) {
  const entries = factsEntries(facts);
  if (!entries.length) return null;
  return el(
    "div",
    { class: "burner-facts-grid" },
    entries.map(([label, value]) =>
      el("div", { class: "burner-fact-card" }, [
        el("span", { class: "pf-label", text: label }),
        el("span", { class: "pf-value", text: value })
      ])
    )
  );
}

function quickFactsChips(subject) {
  const entries = quickFactsEntries(subject);
  if (!entries.length) return null;
  return el(
    "div",
    { class: "burner-quickfacts" },
    entries.map((entry) => chip([el("b", { text: entry.label }), entry.value], entry.tone))
  );
}

// ---- fit card ----
function buildFitCard(eft) {
  if (!eft) return null;
  const { shipName, fitName, modules, cargo } = parseEft(eft);
  const card = el("div", { class: "burner-fit-card" }, [
    el("div", { class: "burner-fit-head" }, [
      el("div", {}, [
        el("div", { class: "burner-fit-title", text: fitName }),
        el("div", { class: "burner-fit-ship", text: shipName })
      ]),
      copyButton("Copy fit (EFT)", eft)
    ]),
    el(
      "div",
      { class: "burner-fit-modules" },
      modules.map((m) => el("div", { class: `burner-fit-line${isEmptySlotLine(m) ? " is-empty" : ""}`, text: m }))
    )
  ]);
  if (cargo.length) {
    card.append(
      el("div", { class: "burner-fit-cargo" }, [
        el("div", { class: "burner-fit-cargo-heading", text: "Cargo & charges" }),
        el(
          "div",
          { class: "burner-fit-cargo-lines" },
          cargo.map((c) => el("div", { class: "burner-fit-line", text: c }))
        )
      ])
    );
  }
  return card;
}

// ---- variant tabs + panels ----
function buildVariantPanel(variant, isActive) {
  const panel = el("div", { class: "burner-variant-panel", hidden: isActive ? null : "" });
  panel.append(el("div", { class: "burner-variant-byline", text: `${variant.ship} · by ${variant.author || "bears"}` }));

  const quick = quickFactsChips(variant);
  if (quick) panel.append(quick);
  if (variant.quick?.note) panel.append(el("p", { class: "burner-note", text: variant.quick.note }));
  if (variant.instructions?.length) {
    panel.append(el("ol", { class: "burner-instructions" }, variant.instructions.map((step) => el("li", { text: step }))));
  }
  if (variant.warnings?.length) {
    panel.append(
      el("div", { class: "burner-alert" }, [
        el("strong", { text: "Warning" }),
        el("ul", {}, variant.warnings.map((w) => el("li", { text: w })))
      ])
    );
  }
  const fitCard = buildFitCard(variant.eft);
  if (fitCard) panel.append(fitCard);
  return panel;
}

function buildMission(mission) {
  const variants = sortVariants(mission.variants);
  const uniqueShips = [...new Set(variants.map((v) => v.ship))];
  const enemyShip = findEnemyShip(mission.enemy || "", Object.keys(SHIP_IDS));

  const shipIcons = el("div", { class: "burner-ship-icons" }, uniqueShips.map((s) => shipIcon(s)));
  if (enemyShip) shipIcons.append(el("span", { class: "burner-vs", text: "vs" }), shipIcon(enemyShip));

  const article = el("article", { id: mission.id, class: "burner-mission", dataset: { observeSection: "" } }, [
    el("header", { class: "burner-mission-head" }, [
      el("div", { class: "burner-mission-titles" }, [
        el("h3", { text: mission.name }),
        el("p", { class: "burner-mission-enemy", text: mission.enemy })
      ]),
      shipIcons
    ])
  ]);

  if (mission.caveat) {
    article.append(
      el("div", { class: "burner-alert burner-alert-danger" }, [el("strong", { text: "Caveat" }), document.createTextNode(mission.caveat)])
    );
  }

  if (variants.length > 1) {
    const tabs = el("div", { class: "burner-variant-tabs", role: "tablist" });
    const panelsWrap = el("div", { class: "burner-variant-panels" });
    variants.forEach((variant, i) => {
      const isActive = i === 0;
      const tab = el("button", {
        type: "button",
        class: `burner-variant-tab tier-${variant.tier || "standard"}${isActive ? " is-active" : ""}`,
        role: "tab",
        "aria-selected": isActive ? "true" : "false",
        text: variant.label
      });
      tab.addEventListener("click", () => {
        [...tabs.children].forEach((t) => {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        [...panelsWrap.children].forEach((p, idx) => {
          p.hidden = idx !== i;
        });
      });
      tabs.append(tab);
      panelsWrap.append(buildVariantPanel(variant, isActive));
    });
    article.append(tabs, panelsWrap);
  } else if (variants.length === 1) {
    article.append(el("div", { class: "burner-variant-panels" }, [buildVariantPanel(variants[0], true)]));
  }

  return article;
}

function buildCategory(cat) {
  const header = el("div", { class: "burner-category-header" }, [el("h2", { text: cat.name })]);
  const diff = diffChip(cat.difficulty);
  if (diff) header.append(diff);

  const section = el("section", { id: cat.id, class: "burner-category", dataset: { observeSection: "" } }, [header]);
  const grid = factsGrid(cat.facts);
  if (grid) section.append(grid);
  if (cat.overview?.length) {
    section.append(el("div", { class: "burner-overview" }, cat.overview.map((p) => el("p", { class: "burner-para", text: p }))));
  }
  section.append(el("div", { class: "burner-missions" }, (cat.missions || []).map(buildMission)));
  return section;
}

// ---- "Getting started": location advice, skill plans, implants/boosters/drugs ----
function buildSkillPlan(plan) {
  const skillsText = (plan.skills || []).join("\n");
  const body = el("div", { class: "burner-subdetails-body" });
  if (plan.notes) body.append(el("p", { class: "burner-para", text: plan.notes }));
  body.append(
    el("div", { class: "burner-copy-row" }, [copyButton("Copy skill plan", skillsText)]),
    el("pre", { class: "burner-skill-list", text: skillsText })
  );
  return el("details", { class: "burner-subdetails" }, [
    el("summary", {}, [document.createTextNode(plan.name), el("span", { class: "burner-skill-meta", text: `${(plan.skills || []).length} entries` })]),
    body
  ]);
}

function buildImplants(extras) {
  const ib = extras.implants_boosters || {};
  const body = el("div", { class: "burner-subdetails-body" }, (ib.paragraphs || []).map((p) => el("p", { class: "burner-para", text: p })));
  body.append(
    el(
      "div",
      { class: "burner-implant-grid" },
      (ib.implant_sets || []).map((s) =>
        el("div", { class: "burner-implant-card" }, [el("h4", { text: s.name }), el("ul", {}, (s.items || []).map((it) => el("li", { text: it })))])
      )
    ),
    el("div", { class: "mission-table" }, [
      el("table", { class: "burner-drug-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Drug" }), el("th", { text: "Slot" }), el("th", { text: "Effect" })])]),
        el("tbody", {}, (ib.drugs || []).map((d) => el("tr", {}, [el("td", { text: d.name }), el("td", { text: d.slot }), el("td", { text: d.effect })])))
      ])
    ])
  );
  return el("details", { class: "burner-subdetails" }, [el("summary", { text: "Implants, boosters & drugs" }), body]);
}

function buildGettingStarted(extras) {
  const loc = extras.location_advice || {};
  const locBlock = el("div", {}, [
    el("h4", { class: "burner-subheading", text: loc.title || "Choosing a location" }),
    ...(loc.paragraphs || []).map((p) => el("p", { class: "burner-para", text: p }))
  ]);
  const skillsBlock = el("div", {}, [
    el("h4", { class: "burner-subheading", text: "Recommended skill plans" }),
    ...((extras.recommended_skills || {}).paragraphs || []).map((p) => el("p", { class: "burner-para", text: p })),
    el("div", { class: "burner-skill-plans" }, (extras.skill_plans || []).map(buildSkillPlan))
  ]);
  return el("details", { id: "getting-started", class: "burner-details", dataset: { observeSection: "" } }, [
    el("summary", { text: "Getting started" }),
    el("div", { class: "burner-details-body" }, [locBlock, skillsBlock, buildImplants(extras)])
  ]);
}

// ---- Advanced builds: unified fits + pinnacle archive ----
function buildUnifiedBuild(build, nameLookup) {
  const head = el("div", { class: "burner-build-head" }, [el("h3", { text: build.name })]);
  const quick = quickFactsChips(build);
  if (quick) head.append(quick);

  const card = el("div", { class: "burner-build-card" }, [
    head,
    el(
      "div",
      { class: "burner-build-covers" },
      (build.covers || []).map((id) => chip(nameLookup.get(id) || id, "info"))
    ),
    el("div", { class: "mission-table" }, [
      el("table", { class: "burner-per-mission-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Mission" }), el("th", { text: "Ammo" }), el("th", { text: "Instructions" })])]),
        el(
          "tbody",
          {},
          (build.per_mission || []).map((pm) => el("tr", {}, [el("td", { text: pm.mission }), el("td", { text: pm.ammo }), el("td", { text: pm.instructions })]))
        )
      ])
    ])
  ]);
  for (const note of build.notes || []) card.append(el("p", { class: "burner-para", text: note }));
  const fitCard = buildFitCard(build.eft);
  if (fitCard) card.append(fitCard);
  return card;
}

function buildPinnacle(pin) {
  if (!pin) return null;
  return el("div", { class: "burner-pinnacle-card" }, [
    el("h3", { text: "Pinnacle collection" }),
    ...(pin.paragraphs || []).slice(0, 2).map((p) => el("p", { class: "burner-para", text: p })),
    el("ul", {}, (pin.build_list || []).map((b) => el("li", { text: b }))),
    el("a", { class: "button ghost", href: pin.archive_url, target: "_blank", rel: "noopener noreferrer", text: "HateLesS build archive on EveWorkbench" })
  ]);
}

function buildAdvancedBuilds(data) {
  const nameLookup = missionNameLookup(data.categories || []);
  const missionsWrap = el(
    "div",
    { class: "burner-missions" },
    (data.unified_builds || []).map((b) => buildUnifiedBuild(b, nameLookup))
  );
  const pinnacle = buildPinnacle(data.pinnacle_collection);
  if (pinnacle) missionsWrap.append(pinnacle);
  return el("section", { id: "advanced-builds", class: "burner-category", dataset: { observeSection: "" } }, [
    el("div", { class: "burner-category-header" }, [el("h2", { text: "Advanced builds" })]),
    el("p", { class: "burner-para", text: "Unified fits that cover more than one burner mission on a single hull, plus a curated archive of community builds." }),
    missionsWrap
  ]);
}

// ---- rail TOC ----
function tocLink(targetId, label, extraClass) {
  return el("a", { class: `codex-nav-item ${extraClass}`, href: `#${targetId}`, dataset: { target: targetId }, text: label });
}

function buildToc(data) {
  const nodes = [tocLink("getting-started", "Getting started", "burner-toc-top")];
  for (const cat of data.categories || []) {
    nodes.push(
      el("div", { class: "burner-toc-group" }, [
        tocLink(cat.id, cat.name, "burner-toc-heading"),
        el(
          "nav",
          { class: "codex-nav burner-toc-missions" },
          (cat.missions || []).map((m) => tocLink(m.id, m.name, "burner-toc-mission"))
        )
      ])
    );
  }
  nodes.push(tocLink("advanced-builds", "Advanced builds", "burner-toc-top"));
  return nodes;
}

// ---- attribution + main body ----
function buildAttribution(source) {
  return el("div", { class: "burner-attribution" }, [
    el("div", { class: "burner-attribution-title" }, [
      document.createTextNode("Based on the "),
      el("a", { href: source.url, target: "_blank", rel: "noopener noreferrer", text: source.title }),
      document.createTextNode(` by the ${source.author}`)
    ]),
    el("div", { class: "burner-attribution-meta", text: `Last updated ${source.updated}` }),
    el("div", { class: "burner-attribution-dedication", text: source.dedication })
  ]);
}

function buildMain(data) {
  const frag = document.createDocumentFragment();
  const header = el("header", { class: "codex-section-header" }, [
    el("h2", { class: "codex-section-title", text: "Anomic burners" }),
    el("div", { class: "codex-intro" }, (data.intro || []).map((p) => el("p", { class: "burner-para", text: p }))),
    buildAttribution(data.source || {})
  ]);
  frag.append(header, buildGettingStarted(data.extras || {}), ...(data.categories || []).map(buildCategory), buildAdvancedBuilds(data));
  return frag;
}

// ---- deep-linking: rail clicks + scrollspy update the hash via replaceState (no
// history-entry spam, no fighting between a smooth click-scroll and the observer) ----
let suppressSpyUntil = 0;

function setActiveNav(targetId) {
  document.querySelectorAll("[data-target]").forEach((n) => n.classList.toggle("active", n.dataset.target === targetId));
}

function installNavigation() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-target]");
    if (!link) return;
    const targetId = link.dataset.target;
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    suppressSpyUntil = Date.now() + 700;
    if (target.tagName === "DETAILS") target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${targetId}`);
    setActiveNav(targetId);
  });

  const sections = [...document.querySelectorAll("[data-observe-section]")];
  if (!sections.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        setActiveNav(entry.target.id);
        if (Date.now() >= suppressSpyUntil) history.replaceState(null, "", `#${entry.target.id}`);
      }
    },
    { rootMargin: "-96px 0px -70% 0px", threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));
}

function scrollToHashSection() {
  const id = location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  if (target.tagName === "DETAILS") target.open = true;
  requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

function renderError(message) {
  if (elements.status) elements.status.textContent = "Burner guide unavailable";
  elements.toc.replaceChildren(el("p", { class: "codex-empty error", text: "Unavailable" }));
  elements.main.replaceChildren(el("div", { class: "burner-error" }, [el("h2", { text: "Could not load the burner guide" }), el("p", { text: message })]));
}

async function init() {
  try {
    const res = await apiFetch(DATA_URL);
    if (!res.ok) throw responseError(res, "Burners");
    const data = await res.json();
    SHIP_IDS = data.ship_type_ids || {};

    let missionCount = 0;
    for (const cat of data.categories || []) missionCount += (cat.missions || []).length;
    if (elements.status) elements.status.textContent = `${missionCount} burner missions · fits, orbits and blitz instructions`;

    elements.toc.replaceChildren(...buildToc(data));
    elements.main.replaceChildren(buildMain(data));
    installNavigation();
    scrollToHashSection();
  } catch (err) {
    renderError(apiErrorMessage(err));
  }
}

init();
