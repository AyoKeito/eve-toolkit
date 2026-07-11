// Add per-mission `objective_notes` (non-obvious gotchas) to the arc seeds.
// Sourced from the EVE University wiki per-mission pages. Idempotent: re-running
// overwrites notes for the listed missions and leaves the rest untouched.
//
// Usage: node scripts/patch-objective-notes.mjs
import { patchSeedField } from "./lib/seed-utils.mjs";

const NOTES = {
  "minmatar-l4-wildfire.json": {
    191: "Blitz: buy the Olfei Medallion off the local market (a few ISK) instead of fighting through the Angel fortress to hack it.",
    192: "Loot the Archives Passkey from Ailon Boufin's wreck — hitting his shields, then his armor, each triggers a heavy reinforcement wave.",
    193: "Loot the Wildfire Khumaak from the Central Burial Tomb (needed next mission); battleships can't reach it — approach in a frigate from the domed top.",
    196: "The real objective is looting three documents from the RSS Radio Telescope container, not the combat — grab all three.",
    198: "After killing Lomar Vujik, loot the Singed Datapad from his cargo container — the mission won't complete without it.",
    199: "Looting the Encrypted Transmission from Tili's Brothel spawns Mercenaries at 25 km — grab it fast, or in a ship that can take the hit.",
    201: "Bring your own Data Analyzer to hack the Drive Cluster Archives; a T2 analyzer's range lets you finish before the 5 km proximity spawn.",
    203: "Needs Archaeology III + a Relic Analyzer to hack the chapel; elite frigates web/scram you at the first gate, and completion costs Amarr Empire standing.",
    204: "Needs Archaeology III + a Relic Analyzer; hacking a relic can spawn more, and the item only drops from the last one — don't shoot Kakoti Rend (non-hostile).",
    205: "Inserting the Obsidian Datacore into the Chapel Container instantly spawns hostiles — align first and warp out right after to blitz it.",
    206: "Kill the Energy Neutralizer Sentry (250 km, ~20 GJ/s) first; killing Karkoti Rend makes the rest warp off. Costs ~3% Angel Cartel standing.",
    207: "Permanent ending choice: Revelation (deliver to Posmon Aubenard) vs Retraction (deliver to Oggur Marendei) — different standings and rewards."
  },
  "gallente-l4-syndication.json": {
    59: "Despite the 'escort' objective you must SALVAGE the Shuttle Wreck with a fitted Salvager (drones don't work), within 2 hours — pull the fleet off with MWD/MJD first.",
    62: "Only the Mercenary Overlords count toward the objective — the elite frigates and cruisers can be ignored.",
    63: "Branch: High Road (highsec) vs Low Road (lowsec); both paths rejoin with no lasting arc impact.",
    70: "Lowsec (Vitrauze) — set up an undock spot and safe bookmarks before docking with the agent.",
    80: "Bring a frigate (a battleship tips them off); carry the Covert Recording Device, and loot the Destabilizer Datacore passkey to open the second gate.",
    65: "Loot the Shanty Town Gate Clearance from the container — it's consumed by the acceleration gate and required to proceed.",
    81: "Retrieve Ralie Ardanne's Belongings from a can; skip the optional missile batteries (destroying them costs ~3% Syndicate standing). Ships capped at T2 battlecruiser and below.",
    66: "Destroy the Pleasure Hub structure to spawn The Ringmaster, then manually loot the container from its wreck.",
    82: "Do NOT shoot anything — this is a drop-only mission and aggression fails it. Just place the Kidnapping Evidence in the Dead Drop.",
    67: "Destroying the control tower costs ~3% Syndicate standing; elite battleships shred drones — pull them or use turrets.",
    69: "Branch into one of three paths (Little Fingers / Oldest Profession / Octomet Plantation); all rejoin at 'Carry On'.",
    72: "Loot the Carry On Token from the centre Fuel Depot (lets you blitz 'Carry On'); destroying the depot itself costs ~3% Syndicate standing.",
    73: "Need a Spintrixiate Rewards Coin from a container to open the gate to Room B, where the Carry On Token is. Lowsec travel.",
    71: "Kill the Plantation Customer to get the Carry On Token (blitzes 'Carry On'); destroying the mansion costs ~3% Syndicate standing.",
    74: "The acceleration gate won't appear until you destroy a cruise-missile battery; the Carry On Token from the prior mission opens the fast route. Any ship kills cost Syndicate standing.",
    75: "Any damage to the Studio I structure spawns 6 elite frigates + 6 elite battleships on top of you; destroying it also costs ~3% Syndicate standing.",
    76: "Manually retrieve Ralie Ardanne from the cargo container; killing the last elite cruiser, then the last battleship, each trigger extra waves.",
    77: "Final, irreversible choice: 'Everybody Has a Price' (Syndicate reward + standing) vs 'Safe Return' (Black Eagle Drone Link Augmentor + Gallente standing).",
    79: "Battleships spawn at 40 km when you place Ralie in the container — align first; the mission completes on placement, so you needn't fight them."
  },
  "caldari-l4-penumbra.json": {
    903: "Blitz: destroy only the Facility (0% resist) and loot the S.I. Formula Sheet — no ships required. Costs ~3% Serpentis standing.",
    904: "Permanent path lock: 'An Honorable Betrayal' = Hyasyoda (highsec); 'Two Steps into Hell' = Nugoeihuvi nullsec; 'Playing It Safer' = Nugoeihuvi lowsec.",
    908: "Sub-choice between the nullsec and lowsec routes to KFR-ZE; no lasting arc impact (your faction path is already locked).",
    909: "Never warp gate-to-gate (bubbles) — use an interceptor; do NOT lose the S.I. Formula Sheet or you fail the arc (90-day cooldown).",
    910: "Don't undock without the S.I. Formula Sheet in your hold — losing it fails the arc (90-day cooldown).",
    912: "Bring a Data Analyzer to hack the CPF Habitation Module; it explodes ~30 s after the hack — loot the CPF Security Personnel and get 10 km clear.",
    915: "Enemies are Blood Raiders (fit EM/Thermal); don't kill the two Dark Corpus Harbingers until last (they trigger a wave); the Corpus battleships neut.",
    919: "Bring a Data Analyzer to hack the Federation Navy Shipyard; warp in at range — warp-to-0 triggers the Broadcast Tower group.",
    920: "Bring a Data Analyzer and scan probes — the site is an unscanned signature you must probe to 100% before you can warp in.",
    924: "Permanent Hyasyoda-path ending choice: 'Home in Peace' (ISK + Caldari standing) vs 'Slipping Away' (leads to the research-lab blueprint reward).",
    926: "Approaching the Nugoeihuvi Caretaker spawns 13 elite warp-disrupting frigates; kill it first to open the container holding the mission item.",
    927: "Permanent Nugoeihuvi-path ending choice: 'Home in Peace' (ISK + Caldari standing) vs 'Learning by Doing' (Synth Blue Pill boosters).",
    930: "Bring ~5,000 m³ of cargo for the Caldari POWs (a blockade runner helps); the route includes lowsec jumps."
  },
  "amarr-l4-right-to-rule.json": {
    344: "Mission completes once Wave 4's cruisers and frigates die — you don't need to grind down the final battleships.",
    345: "Several rooms have Energy Neutralizer towers — kill them first or a cap-hungry ship gets crippled.",
    348: "Bring a Data Analyzer to hack the Encrypted Communications Array (20 km); the defenders sit 100 km away, so combat is optional.",
    350: "Enemies here are Mordu's Legion (Kinetic/Thermal), not Sansha — refit resists and damage for this mission only.",
    351: "Mina Darabi sits in an untractorable container — fly to it; after ~30 min a powerful, bounty-less elite wave spawns.",
    352: "Manually loot 'Rahsa, Sansha Commander' from Rahsa's battleship wreck in Room 2 — required; destroying the battletower costs ~3% Sansha standing.",
    353: "Permanent branch: 'Catching the Scent' = Amarr/Empire highsec path (Noble implant); 'Silence Rahsa' = Sansha/Nation lowsec path (Gnome implant).",
    354: "Kill-order matters: leave one cruiser and one battleship, clear the cruiser waves before the battleship waves; the receiver spawns by the last kill.",
    356: "Manually place the Homemade Sansha Beacon (given at the start) into the Linked Broadcast Array Hub to trigger the rescue spawn.",
    361: "You fight Amarr loyalists (no standing loss); loot the Primordial Biomass that drops from the Advanced Amarr Research Lab.",
    362: "Collect the Sansha Command Signal Receiver from the container after the fight, then drop it into the Business Associate's cargo.",
    363: "Bring a Data Analyzer — you must hack a Communications Array to finish (no loot, just complete the hack).",
    364: "Carry the fake body from the Business Associate container between pockets; start the final conversation only after leaving lowsec to get the Gnome implant.",
    359: "Killing the last ship of each hull type spawns another wave (repeats ~5x) — kill the battleship and warp out once the mission completes to stop the chain.",
    360: "Four rooms — bring extra ammo; in the final room shoot only Harkan's Behemoth, as the others trigger a chain spawn."
  }
};

patchSeedField(NOTES, "objective_notes", { noun: "notes" });
