// Editorial presentation layer for the missions landing page.
//
// The arcs API carries the data facts (name, faction, level, counts, entry agent,
// description); this module carries the copy the codex landing renders around
// them: flavor sentences, space-risk labels, and headline reward values, sourced
// from the EVE University wiki page for each arc. Arcs without an entry fall back
// to the API description and a plain mission-count stat, so future imports render
// before they get copy here.
//
// It also owns arcEmblem (the faction-logo/monogram badge), the one DOM builder the
// arc landing and the arc detail page both render — hence the one-directional import of
// el from ./dom-util.js (dom-util does not import this module, so no cycle).
import { el } from "./dom-util.js";

export const FACTION_IMAGE_IDS = {
  CALDARI: 500001,
  MINMATAR: 500002,
  AMARR: 500003,
  GALLENTE: 500004,
  GURISTAS: 500010,
  "ANGEL CARTEL": 500011,
  "SISTERS OF EVE": 500016
};

export const FACTION_MONOGRAMS = {
  CALDARI: "CAL",
  MINMATAR: "MIN",
  AMARR: "AMR",
  GALLENTE: "GAL",
  GURISTAS: "GUR",
  "ANGEL CARTEL": "ANG",
  "SISTERS OF EVE": "SoE"
};

// Group sublabels keyed by arc level; unknown levels render without a sublabel.
export const LEVEL_GROUP_NAMES = {
  1: "Getting started",
  3: "Pirate factions",
  4: "Empire navies"
};

const REPEAT_NOTE = "Repeats every 3 months";

export const ARC_PRESENTATION = {
  1: {
    flavor:
      "Arsten Takalo sends you across Minmatar and Ammatar space tracing an Angel Cartel conspiracy through 19 missions of escalating encounters and a final loyalty choice.",
    risk: { label: "Hisec + low/null legs", tone: "mixed" },
    metaNote: REPEAT_NOTE,
    rewards: [{ value: "Large", label: "Minmatar standing", tone: "faction" }]
  },
  2: {
    flavor:
      "Roineron Aviviere uncovers a Serpentis and Syndicate web entangling Gallente media — 27 missions from the Federation's core to its lowsec fringes.",
    risk: { label: "Hisec + low/null legs", tone: "mixed" },
    metaNote: REPEAT_NOTE,
    rewards: [{ value: "Large", label: "Gallente standing", tone: "faction" }]
  },
  3: {
    flavor:
      "Aursa Kunivuri pulls you into a Hyasyoda versus Nugoeihuvi megacorp power struggle, threading Serpentis ambushes and Blood Raider decoys across 30 missions.",
    risk: { label: "Hisec + low/null legs", tone: "mixed" },
    metaNote: REPEAT_NOTE,
    rewards: [{ value: "Large", label: "Caldari standing", tone: "faction" }]
  },
  4: {
    flavor:
      "Karde Romu dispatches you to root out Sansha infiltration of Amarr nobility — 24 missions culminating in a choice between the Old Guard and the Nation's path.",
    risk: { label: "Hisec + low/null legs", tone: "mixed" },
    metaNote: REPEAT_NOTE,
    rewards: [{ value: "Large", label: "Amarr standing", tone: "faction" }]
  },
  5: {
    flavor:
      "Chase the Society spy Dagan across all four empires in the canonical first arc for newer pilots — 58 missions, one long journey through hisec.",
    risk: { label: "Hisec", tone: "hisec" },
    metaNote: REPEAT_NOTE,
    rewards: [{ value: "+0.7 Standing", label: "SoE + empire (choice)", tone: "accent" }]
  },
  6: {
    flavor:
      "Deep in Curse nullsec, three entry paths converge at Abdiel Verat's door. Run ops for the Cartel against Sansha and Guristas rivals across 19 encounters.",
    risk: { label: "Nullsec", tone: "nullsec" },
    metaNote: "3 alternate entry agents",
    rewards: [
      { value: "+30% Standing", label: "Angel Cartel base", tone: "faction" },
      { value: "Cynabal BPC", label: "Reward ship", tone: "faction" }
    ]
  },
  7: {
    flavor:
      "Infiltrate Caldari military infrastructure from Venal nullsec. The Guristas want their data — how you get it is up to you. Two diverging endings, one prize.",
    risk: { label: "Nullsec", tone: "nullsec" },
    metaNote: "3 alternate entry agents",
    rewards: [
      { value: "+30% Standing", label: "Guristas base", tone: "faction" },
      { value: "Gila BPC", label: "Reward ship", tone: "faction" }
    ]
  }
};

// The faction badge shared by the arc landing rows and the arc detail hero: a corp-logo
// image over a monogram fallback (which shows through if the logo 404s and removes itself).
export function arcEmblem(arc) {
  const factionId = FACTION_IMAGE_IDS[arc.faction ?? ""];
  const monogram = el("span", {
    class: "arc-monogram",
    text: FACTION_MONOGRAMS[arc.faction ?? ""] ?? (arc.name ?? "?").slice(0, 2).toUpperCase()
  });
  const children = [monogram];
  if (factionId) {
    children.unshift(
      el("img", {
        src: `https://images.evetech.net/corporations/${factionId}/logo?size=128`,
        alt: "",
        loading: "lazy",
        decoding: "async",
        width: "40",
        height: "40",
        onerror: (event) => event.currentTarget.remove()
      })
    );
  }
  return el("div", { class: `arc-emblem${factionId ? " has-logo" : ""}`, "aria-hidden": "true" }, children);
}
