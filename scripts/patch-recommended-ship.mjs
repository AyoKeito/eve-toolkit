// Re-curate `recommended_ship` for arcs 2-4 from EVE University wiki research.
// Wildfire (arc 1) is intentionally NOT touched — it was hand-curated earlier
// and is pinned by tests. Idempotent.
//
// Usage: node scripts/patch-recommended-ship.mjs
import { patchSeedField } from "./lib/seed-utils.mjs";

const SHIPS = {
  "gallente-l4-syndication.json": {
    57: "Any ship",
    58: "Battleship",
    59: "Battleship + Salvager",
    60: "Battleship",
    61: "Any ship",
    62: "Battleship (omni-tank or speed-tank vs ~2000 DPS)",
    63: "Any ship",
    70: "Fast ship",
    64: "Any ship",
    80: "Frigate (inconspicuous; battleship tips them off)",
    65: "Battleship",
    81: "Frigate or T2 battlecruiser (battleships gate-locked out)",
    66: "Battleship",
    82: "Any ship",
    67: "Battleship (long range)",
    83: "Any ship",
    68: "Any ship",
    69: "Any ship",
    72: "Battleship (long range)",
    73: "Stealth Bomber or cloaky T3C",
    71: "Battlecruiser or heavy frigate",
    74: "Battleship (fast frigate to blitz)",
    75: "Battleship (sniping)",
    76: "Sniping Battleship, Heavy Assault Cruiser, or T3C",
    77: "Any ship",
    78: "Any ship",
    79: "Fast ship"
  },
  "caldari-l4-penumbra.json": {
    901: "Fast frigate",
    902: "Fast frigate",
    903: "Battleship",
    904: "Covert Ops or Interceptor (route-choice branch)",
    905: "Fast frigate",
    906: "Any ship (deliver formula sheet, no combat)",
    907: "Fast frigate",
    908: "Covert Ops or Interceptor (route-choice branch)",
    909: "Interceptor (don't gate-to-gate; nullsec bubbles)",
    910: "Fast frigate (lowsec delivery)",
    911: "Battleship",
    912: "Exploration frigate + Data Analyzer (hack + timed extract)",
    913: "Any ship (talk/travel)",
    914: "Battleship (Blood Raiders; branch point)",
    915: "Battleship (sniper; Blood Raiders; neut battleships)",
    916: "Battleship (high DPS; EWAR; escalating waves)",
    917: "Fast frigate (blitz; no combat required)",
    918: "Fast frigate (lowsec Black Rise transit)",
    919: "Battleship + Data Analyzer (combat + hack)",
    920: "Cloaky frigate + Data Analyzer (or buy objective on market)",
    921: "Fast frigate",
    922: "Fast frigate",
    923: "Fast frigate",
    924: "Any ship (branch/choice; lowsec transit)",
    925: "Fast frigate (bring a combat ship next)",
    926: "Battleship (sniper; warp between positions)",
    927: "Any ship (branch/choice)",
    928: "Fast frigate",
    929: "Fast frigate (blitz; lowsec Black Rise)",
    930: "Blockade Runner (5000 m³ cargo; 3 lowsec jumps)"
  },
  "amarr-l4-right-to-rule.json": {
    341: "Any ship",
    342: "Battleship (EM/Thermal tank)",
    343: "Battleship (EM/Thermal tank)",
    344: "Battleship (EM/Thermal tank)",
    345: "Battleship (cap-stable fit; heavy neuts + EWAR)",
    346: "Any ship",
    347: "Battleship (EM/Thermal tank)",
    348: "Frigate + Data Analyzer (no combat required)",
    349: "Fast frigate or shuttle (observe only)",
    350: "Battleship (refit Kinetic/Thermal vs Mordu's Legion)",
    351: "Battleship (sniper; elite BSes dangerous up close)",
    352: "Battleship (EM/Thermal tank)",
    353: "Any ship",
    354: "Battleship (EM/Thermal tank)",
    355: "Any ship",
    356: "Battleship (EM/Thermal tank; neuts present)",
    361: "Battleship (EM/Thermal tank)",
    357: "Any ship",
    362: "Battleship (EM/Thermal tank)",
    358: "Any ship",
    363: "Frigate + Data Analyzer (light combat)",
    359: "Battleship (cap-stable fit; neut sentry at 100 km)",
    364: "Battleship (EM/Thermal tank)",
    360: "Battleship (EM/Thermal tank; neuts + webs, bring extra ammo)"
  }
};

// Sanity: every mission in these arcs should now have a recommendation.
patchSeedField(SHIPS, "recommended_ship", {
  noun: "set",
  sanityCheck: (seed) => {
    const stillNull = seed.missions.filter((m) => m.recommended_ship == null).map((m) => m.mission_id);
    return stillNull.length ? `, still null: ${stillNull.join(",")}` : "";
  }
});
