import fs from "node:fs";
import path from "node:path";
import { buildUserAgent, loadConfig } from "../config.js";
import { sleep } from "../lib/timers.js";
import {
  dpsTotal,
  entityItemUrl,
  parseEntityWeaponStats,
  parseMission,
  type EntityWeaponStats,
  type SeedMission
} from "../missions/scrape-parse.js";
import { argValue, intArg, usage as usageExit } from "./args.js";

interface ScrapeOptions {
  start: number;
  stop: number | null;
  arcId: number;
  arcName: string;
  faction: string;
  level: number;
  startingAgent: string | null;
  startingSystem: string | null;
  description: string | null;
  out: string;
  delayMs: number;
  baseUrl: string;
}

const sourceHost = ["http://games.", "chruk", "er.dk/eve_online/mission_view.php?id="].join("");

const usageMessage =
  "Usage: npm run scrape-missions -- --start=195 --arc-name=Wildfire --faction=MINMATAR --level=4 --out=data/missions/seed/minmatar-l4-wildfire.json [--stop=205]";

function usage(): never {
  return usageExit(usageMessage);
}

function optionsFromArgs(args: string[]): ScrapeOptions {
  const start = intArg(args, "start", null, usage);
  const arcName = argValue(args, "arc-name");
  const faction = argValue(args, "faction");
  const level = intArg(args, "level", null, usage);
  const out = argValue(args, "out");
  if (start === null || !arcName || !faction || level === null || !out) usage();
  return {
    start,
    stop: intArg(args, "stop", null, usage),
    arcId: intArg(args, "arc-id", 1, usage) ?? 1,
    arcName,
    faction,
    level,
    startingAgent: argValue(args, "starting-agent"),
    startingSystem: argValue(args, "starting-system"),
    description: argValue(args, "description"),
    out: path.resolve(out),
    delayMs: intArg(args, "delay-ms", 1000, usage) ?? 1000,
    baseUrl: argValue(args, "base-url") ?? sourceHost
  };
}

async function fetchMission(url: string, userAgent: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent }
  });
  if (!response.ok) throw new Error(`Mission fetch failed ${response.status} for ${url}`);
  return response.text();
}

async function fetchEntityWeaponStats(
  typeId: number,
  baseUrl: string,
  userAgent: string,
  cache: Map<number, EntityWeaponStats | null>
): Promise<EntityWeaponStats | null> {
  if (cache.has(typeId)) return cache.get(typeId) ?? null;
  const stats = parseEntityWeaponStats(await fetchMission(entityItemUrl(baseUrl, typeId), userAgent));
  cache.set(typeId, stats);
  return stats;
}

async function enrichMissingNpcDps(
  mission: SeedMission,
  baseUrl: string,
  userAgent: string,
  cache: Map<number, EntityWeaponStats | null>
): Promise<void> {
  for (const pocket of mission.pockets) {
    for (const group of pocket.groups) {
      for (const npc of group.npcs) {
        if (npc.type_id === null || dpsTotal(npc) > 0) continue;
        const stats = await fetchEntityWeaponStats(npc.type_id, baseUrl, userAgent, cache);
        if (!stats) continue;
        npc.turret_dps_em = stats.turret_dps_em;
        npc.turret_dps_therm = stats.turret_dps_therm;
        npc.turret_dps_kin = stats.turret_dps_kin;
        npc.turret_dps_exp = stats.turret_dps_exp;
        npc.turret_range = npc.turret_range ?? stats.turret_range;
      }
    }
  }
}

async function scrape(options: ScrapeOptions): Promise<void> {
  const config = loadConfig({ requireEsiIdentity: true });
  const userAgent = `${buildUserAgent(config)} mission-seed`;
  const missions: SeedMission[] = [];
  const entityStatsCache = new Map<number, EntityWeaponStats | null>();
  const seen = new Set<number>();
  let currentId: number | null = options.start;
  while (currentId !== null) {
    if (seen.has(currentId)) throw new Error(`Loop detected at mission ${currentId}`);
    if (options.stop !== null && currentId > options.stop) break;
    seen.add(currentId);
    const url = `${options.baseUrl}${currentId}`;
    const html = await fetchMission(url, userAgent);
    const mission = parseMission(html, currentId, url, options.level);
    await enrichMissingNpcDps(mission, options.baseUrl, userAgent, entityStatsCache);
    missions.push(mission);
    currentId = mission.next_mission_id;
    if (currentId !== null && options.delayMs > 0) await sleep(options.delayMs);
  }

  missions.forEach((mission, index) => {
    mission.arc_position = index + 1;
  });

  const seed = {
    arc_id: options.arcId,
    name: options.arcName,
    faction: options.faction,
    level: options.level,
    starting_agent: options.startingAgent,
    starting_system: options.startingSystem,
    description: options.description,
    source_url: missions[0]?.source_url ?? null,
    missions
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(JSON.stringify({ out: options.out, missions: missions.length }, null, 2));
}

await scrape(optionsFromArgs(process.argv.slice(2)));
