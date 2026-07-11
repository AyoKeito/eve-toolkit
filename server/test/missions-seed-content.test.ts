import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

interface MissionSeed {
  arc_id: number;
  name: string;
  faction: string;
  level: number;
  missions: Array<{
    mission_id: number;
    name: string;
    mission_type: string;
    faction: string;
    arc_position: number | null;
    prev_mission_id: number | null;
    next_mission_id: number | null;
    recommended_ship: string | null;
    space_risk?: string | null;
    damage_to_deal?: string | null;
    damage_to_resist?: string | null;
    links?: Array<{ to: number; label: string | null }>;
    objective_html: string | null;
    objective_notes?: string | null;
    objective_items: Array<{
      type_id: number;
      type_name: string;
      quantity: number;
      volume_m3: number;
      role: string;
    }>;
    pockets: Array<{
      groups: Array<{
        npcs: Array<{
          type_id?: number;
          type_name: string;
          notes?: string | null;
          turret_dps_therm: number | null;
          turret_dps_kin: number | null;
        }>;
      }>;
    }>;
    source_url: string;
  }>;
}

function readMissionSeed(fileName: string): MissionSeed {
  const seedPath = path.resolve("data/missions/seed", fileName);
  return JSON.parse(fs.readFileSync(seedPath, "utf8")) as MissionSeed;
}

function readWildfireSeed(): MissionSeed {
  return readMissionSeed("minmatar-l4-wildfire.json");
}

function readSyndicationSeed(): MissionSeed {
  return readMissionSeed("gallente-l4-syndication.json");
}

function readRightToRuleSeed(): MissionSeed {
  return readMissionSeed("amarr-l4-right-to-rule.json");
}

function readBloodStainedStarsSeed(): MissionSeed {
  return readMissionSeed("soe-l1-blood-stained-stars.json");
}

function readAngelSoundSeed(): MissionSeed {
  return readMissionSeed("angel-cartel-l3-angel-sound.json");
}

function readSmashAndGrabSeed(): MissionSeed {
  return readMissionSeed("guristas-l3-smash-and-grab.json");
}

test("Wildfire seed includes the final Revelation or Retraction choice", () => {
  const seed = readWildfireSeed();
  const linearIds = Array.from({ length: 17 }, (_, index) => 191 + index);
  const expectedIds = [...linearIds, 209, 208];

  assert.equal(seed.arc_id, 1);
  assert.equal(seed.name, "Wildfire");
  assert.equal(seed.faction, "MINMATAR");
  assert.equal(seed.level, 4);
  assert.deepEqual(
    seed.missions.map((mission) => mission.mission_id),
    expectedIds
  );

  linearIds.slice(0, -1).forEach((expectedId, index) => {
    const mission = seed.missions.find((row) => row.mission_id === expectedId);
    assert.ok(mission);
    assert.equal(mission.arc_position, index + 1);
    assert.equal(mission.prev_mission_id, index === 0 ? null : expectedId - 1);
    assert.equal(mission.next_mission_id, expectedId + 1);
    assert.equal(mission.source_url, `http://games.chruker.dk/eve_online/mission_view.php?id=${expectedId}`);
  });

  const branchSource = seed.missions.find((mission) => mission.mission_id === 207);
  assert.ok(branchSource);
  assert.equal(branchSource.arc_position, 17);
  assert.equal(branchSource.prev_mission_id, 206);
  assert.equal(branchSource.next_mission_id, 208);

  const finalChoices = seed.missions.filter((mission) => mission.arc_position === 18);
  assert.deepEqual(
    finalChoices.map((mission) => mission.name),
    ["Revelation", "Retraction"]
  );

  for (const mission of finalChoices) {
    assert.equal(mission.prev_mission_id, 207);
    assert.equal(mission.next_mission_id, null);
    assert.equal(mission.source_url, `http://games.chruker.dk/eve_online/mission_view.php?id=${mission.mission_id}`);
  }
});

test("Wildfire seed includes EVE University objective details missing from Chruker", () => {
  const seed = readWildfireSeed();
  const demonstration = seed.missions.find((mission) => mission.mission_id === 191);
  const branch = seed.missions.find((mission) => mission.mission_id === 207);

  assert.ok(demonstration);
  assert.equal(demonstration.name, "A Demonstration");
  assert.equal(demonstration.recommended_ship, "Battleship (sniper with Afterburner)");
  assert.match(demonstration.objective_html ?? "", /Find and retrieve 1x/);
  assert.match(demonstration.objective_html ?? "", /Olfei Medallion/);
  assert.deepEqual(demonstration.objective_items, [
    {
      type_id: 32099,
      type_name: "Olfei Medallion",
      quantity: 1,
      volume_m3: 0.1,
      role: "RETRIEVE",
    },
  ]);

  assert.ok(branch);
  assert.equal(branch.name, "With Great Power");
  assert.match(branch.objective_html ?? "", /Choose your path/);
});

test("Wildfire seed uses EVE University metadata where the scraper fallback is too broad", () => {
  const seed = readWildfireSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));
  const shipExpectations = new Map<number, string | null>([
    [193, "Battleship, Tanked Frigate (Blitz)"],
    [194, "Combat ship (next mission requires combat)"],
    [195, "Battleship (sniper)"],
    [196, "Combat Ship (mission-after-next requires combat, this one is on the way there)"],
    [197, "Combat Ship (next mission requires combat)"],
    [199, "Battleship (sniper)"],
    [200, "Fast ship"],
    [201, "Hacking Ship"],
    [203, "Fast ship or Strategic Cruiser, Battlecruiser or Battleship with Micro Jump Drive and Relic Analyzer"],
    [204, "Fast ship or Strategic Cruiser, Battlecruiser or Battleship with Micro Jump Drive and Relic Analyzer"],
    [205, "Fast ship"],
    [206, "Battleship (sniper)"],
    [208, "Any ship"],
  ]);
  const typeExpectations = new Map<number, string>([
    [207, "BRANCH"],
    [208, "COURIER"],
  ]);
  const factionExpectations = new Map<number, string>([
    [192, "Mercenaries"],
    [198, "Minmatar Republic"],
    [199, "Mercenaries"],
    [203, "Ammatar"],
    [204, "Ammatar"],
  ]);

  for (const [missionId, expectedShip] of shipExpectations) {
    assert.equal(missionsById.get(missionId)?.recommended_ship, expectedShip, `mission ${missionId} ship hint`);
  }

  for (const [missionId, expectedType] of typeExpectations) {
    assert.equal(missionsById.get(missionId)?.mission_type, expectedType, `mission ${missionId} type`);
  }

  for (const [missionId, expectedFaction] of factionExpectations) {
    assert.equal(missionsById.get(missionId)?.faction, expectedFaction, `mission ${missionId} faction`);
  }
});

test("Syndication seed includes every EVE University branch path", () => {
  const seed = readSyndicationSeed();
  const expectedByPosition = new Map<number, Array<[number, string]>>([
    [1, [[57, "Impetus"]]],
    [2, [[58, "The Tolle Scar"]]],
    [3, [[59, "Priority One"]]],
    [4, [[60, "The Averon Exchange"]]],
    [5, [[61, "A Different Kind of Director"]]],
    [6, [[62, "Assistance"]]],
    [7, [[63, "The High or Low Road"]]],
    [8, [[70, "Outside the Scope"], [64, "Into the Black"]]],
    [9, [[80, "Hidden Camera"], [65, "Poor Man's Shakedown"]]],
    [10, [[81, "Rendezvous"], [66, "Underground Circus"]]],
    [11, [[82, "Handoff"], [67, "Intaki Chase"]]],
    [12, [[83, "With Authority"], [68, "Rat in a Corner"]]],
    [13, [[69, "Places to Hide"]]],
    [14, [[72, "Little Fingers"], [73, "Oldest Profession"], [71, "Octomet Plantation"]]],
    [15, [[74, "Carry On"]]],
    [16, [[75, "Studio I"]]],
    [17, [[76, "Showtime"]]],
    [18, [[77, "Where's the Line?"]]],
    [19, [[78, "Everybody Has a Price"], [79, "Safe Return"]]]
  ]);
  const expectedIds = Array.from(expectedByPosition.values()).flat().map(([missionId]) => missionId);

  assert.equal(seed.arc_id, 2);
  assert.equal(seed.name, "Syndication");
  assert.equal(seed.faction, "GALLENTE");
  assert.equal(seed.level, 4);
  assert.deepEqual(
    seed.missions.map((mission) => mission.mission_id),
    expectedIds
  );

  for (const [position, expectedMissions] of expectedByPosition) {
    const missions = seed.missions.filter((mission) => mission.arc_position === position);
    assert.deepEqual(
      missions.map((mission) => [mission.mission_id, mission.name]),
      expectedMissions,
      `position ${position}`
    );
    for (const mission of missions) {
      assert.equal(mission.source_url, `http://games.chruker.dk/eve_online/mission_view.php?id=${mission.mission_id}`);
    }
  }
});

test("Syndication seed uses EVE University branch, travel, ship, and faction metadata", () => {
  const seed = readSyndicationSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));
  const typeExpectations = new Map<number, string>([
    [63, "BRANCH"],
    [69, "BRANCH"],
    [77, "BRANCH"],
    [70, "TRAVEL"],
    [83, "TRAVEL"],
    [82, "COURIER"]
  ]);
  const shipExpectations = new Map<number, string | null>([
    [59, "Battleship + Salvager"],
    [67, "Battleship (long range)"],
    [72, "Battleship (long range)"],
    [73, "Stealth Bomber or cloaky T3C"],
    [74, "Battleship (fast frigate to blitz)"],
    [75, "Battleship (sniping)"],
    [76, "Sniping Battleship, Heavy Assault Cruiser, or T3C"],
    [79, "Fast ship"]
  ]);
  const factionExpectations = new Map<number, string | null>([
    [57, null],
    [58, "Rogue Drones"],
    [59, "Minmatar"],
    [60, "Mercenaries"],
    [61, null],
    [62, "Mercenaries"],
    [63, null],
    [70, null],
    [64, null],
    [80, "Pator 6 (Minmatar)"],
    [65, "Minmatar Republic"],
    [81, "Pator 6 (Minmatar/Gallente), The Syndicate"],
    [66, "Serpentis"],
    [82, null],
    [67, "Syndicate"],
    [83, null],
    [68, null],
    [69, null],
    [72, "Gallente Federation"],
    [73, "Independent (Various Ship Types)"],
    [71, "Independent (Gallente Ships)"],
    [74, "Mercenaries"],
    [75, "The Syndicate"],
    [76, "Minmatar Republic"],
    [77, null],
    [78, null],
    [79, "The Syndicate"]
  ]);

  for (const [missionId, expectedType] of typeExpectations) {
    assert.equal(missionsById.get(missionId)?.mission_type, expectedType, `mission ${missionId} type`);
  }

  for (const [missionId, expectedShip] of shipExpectations) {
    assert.equal(missionsById.get(missionId)?.recommended_ship, expectedShip, `mission ${missionId} ship hint`);
  }

  for (const [missionId, expectedFaction] of factionExpectations) {
    assert.equal(missionsById.get(missionId)?.faction, expectedFaction, `mission ${missionId} faction`);
  }

  assert.match(missionsById.get(63)?.objective_html ?? "", /Choose your path/);
  assert.match(missionsById.get(77)?.objective_html ?? "", /Choose your path/);
  assert.equal(missionsById.get(70)?.space_risk, "LOWSEC", "Outside the Scope lowsec risk");
  assert.equal(missionsById.get(64)?.space_risk ?? null, null, "Into the Black stays unmarked");
  assert.equal(missionsById.get(73)?.space_risk, "LOWSEC", "Oldest Profession lowsec risk");
  assert.equal(missionsById.get(71)?.space_risk, "LOWSEC", "Octomet Plantation lowsec risk");
  assert.equal(missionsById.get(72)?.space_risk ?? null, null, "Little Fingers stays unmarked");

  const octometPlantation = missionsById.get(71);
  assert.ok(octometPlantation);
  const plantationCustomer = octometPlantation.pockets
    .flatMap((pocket) => pocket.groups.flatMap((group) => group.npcs))
    .find((npc) => npc.type_name === "Plantation Customer");
  assert.ok(plantationCustomer);
  assert.match(plantationCustomer.notes ?? "", /drops 1x Carry On Token/i);

  const carryOn = missionsById.get(74);
  assert.ok(carryOn);
  assert.match(carryOn.objective_html ?? "", /Carry On Token/);
  assert.match(carryOn.objective_html ?? "", /Toll Booth Gate/);
  assert.match(carryOn.objective_html ?? "", /consumed/i);
  assert.deepEqual(carryOn.objective_items, [
    {
      type_id: 32242,
      type_name: "Carry On Token",
      quantity: 1,
      volume_m3: 0.1,
      role: "PASSKEY"
    }
  ]);
});

test("Syndication seed fills enemy DPS from linked Chruker entity stats when mission rows omit it", () => {
  const seed = readSyndicationSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  const handoff = missionsById.get(82);
  assert.ok(handoff);
  const handoffNpcs = handoff.pockets.flatMap((pocket) => pocket.groups.flatMap((group) => group.npcs));
  const blackEagles = handoffNpcs.filter((npc) => npc.type_name === "Black Eagles Operative");
  const mourmarie = handoffNpcs.find((npc) => npc.type_name === "Mourmarie Mone's Covert Ops Frigate");

  assert.equal(blackEagles.length, 3);
  for (const npc of blackEagles) {
    assert.equal(npc.turret_dps_therm, 12);
    assert.equal(npc.turret_dps_kin, 9);
  }

  assert.ok(mourmarie);
  assert.equal(Math.round(mourmarie.turret_dps_therm ?? 0), 29);
  assert.equal(Math.round(mourmarie.turret_dps_kin ?? 0), 41);

  const everybodyHasAPrice = missionsById.get(78);
  assert.ok(everybodyHasAPrice);
  const syndicateCruiser = everybodyHasAPrice.pockets
    .flatMap((pocket) => pocket.groups.flatMap((group) => group.npcs))
    .find((npc) => npc.type_name === "Syndicate Cruiser");
  assert.ok(syndicateCruiser);
  assert.equal(syndicateCruiser.turret_dps_therm, 12);
  assert.equal(syndicateCruiser.turret_dps_kin, 9);
});

test("Blood-Stained Stars seed forks at Tracking or Scanning and at the empire choice", () => {
  const seed = readBloodStainedStarsSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  assert.equal(seed.arc_id, 5);
  assert.equal(seed.name, "The Blood-Stained Stars");
  assert.equal(seed.faction, "SISTERS OF EVE");
  assert.equal(seed.level, 1);
  assert.equal(seed.missions.length, 58);

  // Trunk: 84-107 occupy depths 1-24 in order.
  Array.from({ length: 24 }, (_, index) => 84 + index).forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, index + 1, `trunk ${missionId} depth`);
  });

  // 107 "Tracking or Scanning" is the first permanent decision.
  const trackingOrScanning = missionsById.get(107);
  assert.ok(trackingOrScanning);
  assert.equal(trackingOrScanning.mission_type, "BRANCH");
  assert.deepEqual(trackingOrScanning.links, [
    { to: 109, label: "Tracking" },
    { to: 108, label: "Scanning" }
  ]);

  // The two 3-mission paths share depths 25-27 and merge at Burning Down the Hive (114).
  [109, 110, 111].forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 25 + index, `tracking ${missionId} depth`);
  });
  [108, 112, 113].forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 25 + index, `scanning ${missionId} depth`);
  });
  assert.equal(missionsById.get(111)?.links?.[0]?.to, 114);
  assert.equal(missionsById.get(113)?.links?.[0]?.to, 114);
  assert.equal(missionsById.get(114)?.arc_position, 28);

  // 135 "The Missing Piece" forks four ways by empire; all converge on Our Man Dagan (140).
  const missingPiece = missionsById.get(135);
  assert.ok(missingPiece);
  assert.equal(missingPiece.mission_type, "BRANCH");
  assert.deepEqual(missingPiece.links, [
    { to: 136, label: "Gallente" },
    { to: 137, label: "Minmatar" },
    { to: 138, label: "Caldari" },
    { to: 139, label: "Amarr" }
  ]);
  for (const commanderId of [136, 137, 138, 139]) {
    const commander = missionsById.get(commanderId);
    assert.equal(commander?.arc_position, 50, `commander ${commanderId} depth`);
    assert.equal(commander?.mission_type, "TRAVEL", `commander ${commanderId} type`);
    assert.equal(commander?.links?.[0]?.to, 140, `commander ${commanderId} converges on Dagan`);
  }

  // chruker models Dagan per-empire (140/514); the wiki's single converging mission wins.
  const dagan = missionsById.get(140);
  assert.ok(dagan);
  assert.equal(dagan.name, "Our Man Dagan");
  assert.equal(dagan.arc_position, 51);
  assert.equal(missionsById.get(141)?.arc_position, 52);
  assert.deepEqual(missionsById.get(141)?.links, []);
});

test("Blood-Stained Stars seed uses EVE University faction, damage, and risk metadata", () => {
  const seed = readBloodStainedStarsSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  const factionExpectations = new Map<number, string | null>([
    [86, "Blood Raiders"],
    [97, "Angel Cartel"],
    [99, null], // Passive Observation: observe only, never shoot
    [109, "Mordu's Legion"],
    [140, "Society of Conscious Thought"]
  ]);
  for (const [missionId, expected] of factionExpectations) {
    assert.equal(missionsById.get(missionId)?.faction, expected, `mission ${missionId} faction`);
  }
  assert.equal(missionsById.get(86)?.damage_to_resist, "EM/Thermal");
  assert.equal(missionsById.get(97)?.damage_to_resist, "Explosive/Kinetic");

  // The optional lowsec shortcut on Brothers and Sisters is flagged.
  assert.equal(missionsById.get(130)?.space_risk, "LOWSEC");
  // Recovery's hacking gotcha is reflected in the ship hint.
  assert.match(missionsById.get(126)?.recommended_ship ?? "", /Analyzer/);
  // Dagan's shield regen is the arc's signature gotcha.
  assert.match(missionsById.get(140)?.objective_notes ?? "", /100/);
});

test("Angel Sound seed funnels three entries into K-QWHE and wiki-fills chruker's gaps", () => {
  const seed = readAngelSoundSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  assert.equal(seed.arc_id, 6);
  assert.equal(seed.name, "Angel Sound");
  assert.equal(seed.faction, "ANGEL CARTEL");
  assert.equal(seed.level, 3);
  assert.equal(seed.missions.length, 19);

  // Three alternate entry missions share depth 1 and converge on New Opportunities.
  const entryLabels = new Map<number, string>([
    [228, "Minmatar start"],
    [229, "Amarr start"],
    [1101, "Angel Cartel start"]
  ]);
  for (const [missionId, label] of entryLabels) {
    const entry = missionsById.get(missionId);
    assert.equal(entry?.arc_position, 1, `entry ${missionId} depth`);
    assert.equal(entry?.mission_type, "TRAVEL", `entry ${missionId} type`);
    assert.deepEqual(entry?.links, [{ to: 230, label }], `entry ${missionId} edge`);
  }

  // Fight or Flight forks into the Heaven and Utopia chapters, which re-merge at Dominus.
  const fightOrFlight = missionsById.get(231);
  assert.ok(fightOrFlight);
  assert.equal(fightOrFlight.mission_type, "BRANCH");
  assert.deepEqual(fightOrFlight.links, [
    { to: 233, label: "Heaven" },
    { to: 232, label: "Utopia" }
  ]);
  [233, 1102, 1103, 1104].forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 4 + index, `heaven ${missionId} depth`);
  });
  [232, 234, 235, 236].forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 4 + index, `utopia ${missionId} depth`);
  });
  assert.equal(missionsById.get(1104)?.links?.[0]?.to, 237);
  assert.equal(missionsById.get(236)?.links?.[0]?.to, 237);

  // The Lesser of Two offers a two-mission stealth path or a single assault mission.
  const lesserOfTwo = missionsById.get(238);
  assert.ok(lesserOfTwo);
  assert.equal(lesserOfTwo.mission_type, "BRANCH");
  assert.deepEqual(lesserOfTwo.links, [
    { to: 240, label: "Stealth path" },
    { to: 239, label: "Assault path" }
  ]);
  assert.deepEqual(missionsById.get(243)?.links, []);
  assert.equal(missionsById.get(243)?.faction, "CONCORD");

  // The whole arc lives in Curse nullsec.
  for (const mission of seed.missions) {
    assert.equal(mission.space_risk, "NULLSEC", `mission ${mission.mission_id} risk`);
  }

  // chruker lacks five missions; they are wiki-built (1100-block) with SDE NPC stats.
  for (const wikiId of [1101, 1102, 1103, 1104, 1105]) {
    const mission = missionsById.get(wikiId);
    assert.ok(mission, `wiki-built ${wikiId} present`);
    assert.match(mission.source_url, /wiki\.eveuniversity\.org/, `wiki-built ${wikiId} source`);
  }
  const rideToTheRescue = missionsById.get(1102);
  assert.ok(rideToTheRescue);
  const yukiro = rideToTheRescue.pockets
    .flatMap((pocket) => pocket.groups.flatMap((group) => group.npcs))
    .find((npc) => npc.type_name === "Yukiro Demense");
  assert.ok(yukiro, "Yukiro Demense present in Ride to the Rescue");
  assert.ok(typeof yukiro.type_id === "number", "Yukiro Demense resolved against the SDE");
});

test("Smash and Grab seed keeps both Chapter 3 trails as separate endings", () => {
  const seed = readSmashAndGrabSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  assert.equal(seed.arc_id, 7);
  assert.equal(seed.name, "Smash and Grab");
  assert.equal(seed.faction, "GURISTAS");
  assert.equal(seed.level, 3);
  assert.equal(seed.missions.length, 19);

  // Three alternate entry missions share depth 1 and converge on Intelligence Mining.
  const entryLabels = new Map<number, string>([
    [244, "Gallente start"],
    [249, "Guristas start"],
    [250, "Caldari start"]
  ]);
  for (const [missionId, label] of entryLabels) {
    const entry = missionsById.get(missionId);
    assert.equal(entry?.arc_position, 1, `entry ${missionId} depth`);
    assert.equal(entry?.mission_type, "TRAVEL", `entry ${missionId} type`);
    assert.deepEqual(entry?.links, [{ to: 245, label }], `entry ${missionId} edge`);
  }

  // Planning the Operation forks into single-mission alternatives that re-merge.
  const planning = missionsById.get(246);
  assert.ok(planning);
  assert.equal(planning.mission_type, "BRANCH");
  assert.deepEqual(planning.links, [
    { to: 247, label: "Sabotage" },
    { to: 248, label: "Frontal assault" }
  ]);
  assert.equal(missionsById.get(247)?.links?.[0]?.to, 251);
  assert.equal(missionsById.get(248)?.links?.[0]?.to, 251);

  // Culling the Weak splits into two trails that never merge — two arc endings.
  const culling = missionsById.get(255);
  assert.ok(culling);
  assert.equal(culling.mission_type, "BRANCH");
  assert.deepEqual(culling.links, [
    { to: 256, label: "Irichi's trail" },
    { to: 257, label: "Kori's trail" }
  ]);
  assert.deepEqual(missionsById.get(260)?.links, []);
  assert.deepEqual(missionsById.get(262)?.links, []);

  // The whole arc lives in Venal nullsec.
  for (const mission of seed.missions) {
    assert.equal(mission.space_risk, "NULLSEC", `mission ${mission.mission_id} risk`);
  }

  // The hacking requirement on Miscommunication is reflected in both hint fields.
  assert.match(missionsById.get(252)?.recommended_ship ?? "", /Data Analyzer/);
  assert.match(missionsById.get(252)?.objective_notes ?? "", /Hacking III/);
});

test("seeds carry non-obvious objective notes, including the Priority One salvage gotcha", () => {
  const syndication = readSyndicationSeed();
  const priorityOne = syndication.missions.find((mission) => mission.mission_id === 59);
  assert.ok(priorityOne);
  assert.match(priorityOne.objective_notes ?? "", /salvage/i);
  assert.match(priorityOne.objective_notes ?? "", /Salvager/);

  // Every arc should surface at least a few gotchas.
  for (const seed of [
    readWildfireSeed(),
    readSyndicationSeed(),
    readRightToRuleSeed(),
    readBloodStainedStarsSeed(),
    readAngelSoundSeed(),
    readSmashAndGrabSeed()
  ]) {
    const withNotes = seed.missions.filter((mission) => (mission.objective_notes ?? "").trim().length > 0);
    assert.ok(withNotes.length >= 3, `${seed.name} should have at least 3 objective notes, got ${withNotes.length}`);
  }
});

test("every arc recommends a ship for every mission", () => {
  for (const seed of [
    readWildfireSeed(),
    readSyndicationSeed(),
    readRightToRuleSeed(),
    readMissionSeed("caldari-l4-penumbra.json"),
    readBloodStainedStarsSeed(),
    readAngelSoundSeed(),
    readSmashAndGrabSeed()
  ]) {
    const missing = seed.missions
      .filter((mission) => (mission.recommended_ship ?? "").trim().length === 0)
      .map((mission) => mission.mission_id);
    assert.equal(missing.length, 0, `${seed.name} missions missing a recommended ship: ${missing.join(", ")}`);
  }

  // The salvage/hacking gotchas should be reflected in the ship hint.
  const syndication = readSyndicationSeed();
  assert.match(syndication.missions.find((m) => m.mission_id === 59)?.recommended_ship ?? "", /Salvager/);
  const rightToRule = readRightToRuleSeed();
  assert.match(rightToRule.missions.find((m) => m.mission_id === 350)?.recommended_ship ?? "", /Kinetic\/Thermal/);
  assert.match(rightToRule.missions.find((m) => m.mission_id === 348)?.recommended_ship ?? "", /Data Analyzer/);
});

test("Right to Rule seed splits Chapter 3 into the Old Guard and Alike Minds endings", () => {
  const seed = readRightToRuleSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  assert.equal(seed.arc_id, 4);
  assert.equal(seed.name, "Right to Rule");
  assert.equal(seed.faction, "AMARR");
  assert.equal(seed.level, 4);
  assert.equal(seed.missions.length, 24);

  // Shared trunk: 341-353 occupy depths 1-13 in order.
  Array.from({ length: 13 }, (_, index) => 341 + index).forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, index + 1, `trunk ${missionId} depth`);
  });

  // 353 is the branch decision and forks to both Chapter 3 paths.
  const decision = missionsById.get(353);
  assert.ok(decision);
  assert.equal(decision.mission_type, "BRANCH");
  assert.deepEqual(decision.links, [
    { to: 354, label: "The Old Guard" },
    { to: 355, label: "Alike Minds" }
  ]);

  // Old Guard chain (354,356-360) and Alike Minds chain (355,361-364) share depths 14+.
  const oldGuard = [354, 356, 357, 358, 359, 360];
  const alikeMinds = [355, 361, 362, 363, 364];
  oldGuard.forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 14 + index, `old guard ${missionId} depth`);
  });
  alikeMinds.forEach((missionId, index) => {
    assert.equal(missionsById.get(missionId)?.arc_position, 14 + index, `alike minds ${missionId} depth`);
  });

  // Each path carries its own label and terminates with no outgoing links.
  for (const missionId of oldGuard.slice(0, -1)) {
    assert.equal(missionsById.get(missionId)?.links?.[0]?.label, "The Old Guard", `old guard ${missionId} label`);
  }
  for (const missionId of alikeMinds.slice(0, -1)) {
    assert.equal(missionsById.get(missionId)?.links?.[0]?.label, "Alike Minds", `alike minds ${missionId} label`);
  }
  assert.deepEqual(missionsById.get(360)?.links, []);
  assert.deepEqual(missionsById.get(364)?.links, []);
});

test("Right to Rule seed corrects scraper factions and damage profiles", () => {
  const seed = readRightToRuleSeed();
  const missionsById = new Map(seed.missions.map((mission) => [mission.mission_id, mission]));

  // The scraper tagged every mission "Angel Cartel"; the arc is actually Sansha's
  // Nation, with Amarr loyalist resistance on the Alike Minds path and one
  // Mordus mercenary mission.
  const factionExpectations = new Map<number, string | null>([
    [344, "Sansha's Nation"],
    [350, "Mercenaries"],
    [361, "Amarr Empire"],
    [364, "Amarr Empire"],
    [353, null]
  ]);
  for (const [missionId, expected] of factionExpectations) {
    assert.equal(missionsById.get(missionId)?.faction, expected, `mission ${missionId} faction`);
  }

  // Sansha and Amarr loyalists deal EM/Thermal; the Mordus mercenaries Kin/Therm.
  assert.equal(missionsById.get(344)?.damage_to_resist, "EM/Thermal");
  assert.equal(missionsById.get(361)?.damage_to_resist, "EM/Thermal");
  assert.equal(missionsById.get(350)?.damage_to_resist, "Kinetic/Thermal");
  assert.equal(seed.missions.find((mission) => mission.mission_id === 344)?.faction, "Sansha's Nation");
  assert.equal(seed.missions.every((mission) => mission.faction !== "Angel Cartel"), true);
});
