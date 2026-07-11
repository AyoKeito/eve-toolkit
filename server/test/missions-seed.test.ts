import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { importMissionsFromSeed } from "../src/fetchers/missions-seed.js";

const missionSource = (id: number) =>
  ["https://games.", "chruk", "er.dk/eve_online/mission_view.php?id=", String(id)].join("");

const seed = {
  arc_id: 1,
  name: "Wildfire",
  faction: "MINMATAR",
  level: 4,
  starting_agent: "Mia Cadelanne",
  starting_system: "Avesber",
  description: "Minmatar level 4 epic arc.",
  source_url: missionSource(195),
  missions: [
    {
      mission_id: 201,
      arc_position: 7,
      prev_mission_id: 200,
      next_mission_id: 202,
      name: "Church of the Obsidian",
      level: 4,
      mission_type: "ENCOUNTER",
      faction: "Angel Cartel",
      is_epic_arc: true,
      damage_to_deal: "Explosive/Kinetic",
      damage_to_resist: "Explosive/Kinetic",
      recommended_ship: "Battleship",
      space_risk: "LOWSEC",
      briefing_html: "<p>Scout the hostile pocket.</p>",
      objective_html: "<p>Destroy the stasis tower.</p>",
      reward_isk: 1200000,
      reward_lp: 45000,
      reward_bonus_isk: 800000,
      bonus_time_seconds: 1800,
      source_url: missionSource(201),
      objective_items: [
        { type_id: 34, type_name: "Tritanium", quantity: 10, volume_m3: 0.1, role: "RETRIEVE" }
      ],
      pockets: [
        {
          pocket_index: 0,
          name: "Pocket 1",
          notes: "Initial wave.",
          groups: [
            {
              group_index: 0,
              label: "Group 1",
              distance_text: "23 km",
              trigger_text: "Last battleship triggers reinforcement.",
              optional: false,
              npcs: [
                {
                  quantity: 3,
                  type_id: 14352,
                  type_name: "Ammatar Navy Soldier",
                  ship_class: null,
                  bounty_isk: 8500,
                  signature_radius: 35,
                  max_velocity: 620,
                  orbit_velocity: 430,
                  orbit_distance: 7500,
                  shield_hp: 250,
                  armor_hp: 200,
                  hull_hp: 150,
                  resist_shield_em: 0,
                  resist_shield_therm: 20,
                  resist_shield_kin: 40,
                  resist_shield_exp: 50,
                  resist_armor_em: 60,
                  resist_armor_therm: 35,
                  resist_armor_kin: 25,
                  resist_armor_exp: 10,
                  turret_dps_em: 0,
                  turret_dps_therm: 4,
                  turret_dps_kin: 7,
                  turret_dps_exp: 11,
                  turret_range: 12000,
                  missile_dps_em: 0,
                  missile_dps_therm: 0,
                  missile_dps_kin: 3,
                  missile_dps_exp: 5,
                  missile_range: 18000,
                  defender_chance_pct: 5,
                  ewar: [{ type: "WEB", range: 10000, chance: 35 }],
                  notes: "Webs nearby targets."
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

test("mission seed importer upserts nested mission reference data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-missions-seed-"));
  fs.writeFileSync(path.join(dir, "wildfire.json"), JSON.stringify(seed, null, 2));

  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO types(type_id, name, group_name, category_name) VALUES (?, ?, ?, ?)").run(
    14352,
    "Ammatar Navy Soldier",
    "Mission Amarr Empire Frigate",
    "Entity"
  );
  const summary = await importMissionsFromSeed(db, dir);

  assert.deepEqual(summary, { arcs: 1, missions: 1, pockets: 1, groups: 1, npcs: 1, objectiveItems: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mission_arcs").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM missions").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mission_npcs").get() as { count: number }).count, 1);
  assert.equal(
    (db.prepare("SELECT json_extract(ewar_json, '$[0].type') AS ewar FROM mission_npcs").get() as { ewar: string }).ewar,
    "WEB"
  );
  assert.equal(
    (db.prepare("SELECT ship_class FROM mission_npcs WHERE type_id=14352").get() as { ship_class: string }).ship_class,
    "Frigate"
  );
  assert.equal(
    (db.prepare("SELECT space_risk FROM missions WHERE mission_id=201").get() as { space_risk: string }).space_risk,
    "LOWSEC"
  );
  assert.equal(
    (db.prepare("SELECT source FROM source_imports WHERE source='missions-seed'").get() as { source: string }).source,
    "missions-seed"
  );
  assert.equal(
    (db.prepare("SELECT archive_url FROM source_imports WHERE source='missions-seed'").get() as { archive_url: string })
      .archive_url,
    `missions-seed:${path.basename(dir)}`
  );

  await importMissionsFromSeed(db, dir);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM missions").get() as { count: number }).count, 1);

  db.close();
});
