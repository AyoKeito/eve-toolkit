/**
 * Pure HTML -> SeedMission parsing layer for the mission scraper.
 * Extracted from server/src/cli/scrape-missions.ts, which now keeps only the
 * arg/fetch/write entry-point and imports these functions. Every function here
 * is pure (HTML/string in, structured data out) with no I/O.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { shipClassFromTypeName } from "./ship-class.js";

export interface SeedNpc {
  quantity: number;
  type_id: number | null;
  type_name: string;
  ship_class: string | null;
  bounty_isk: number | null;
  signature_radius: number | null;
  max_velocity: number | null;
  orbit_velocity: number | null;
  orbit_distance: number | null;
  shield_hp: number | null;
  armor_hp: number | null;
  hull_hp: number | null;
  resist_shield_em: number | null;
  resist_shield_therm: number | null;
  resist_shield_kin: number | null;
  resist_shield_exp: number | null;
  resist_armor_em: number | null;
  resist_armor_therm: number | null;
  resist_armor_kin: number | null;
  resist_armor_exp: number | null;
  turret_dps_em: number | null;
  turret_dps_therm: number | null;
  turret_dps_kin: number | null;
  turret_dps_exp: number | null;
  turret_range: number | null;
  missile_dps_em: number | null;
  missile_dps_therm: number | null;
  missile_dps_kin: number | null;
  missile_dps_exp: number | null;
  missile_range: number | null;
  defender_chance_pct: number | null;
  ewar: Array<{ type: string; text: string }>;
  notes: string | null;
}

export interface SeedGroup {
  group_index: number;
  label: string | null;
  distance_text: string | null;
  trigger_text: string | null;
  optional: boolean;
  npcs: SeedNpc[];
}

export interface SeedPocket {
  pocket_index: number;
  name: string | null;
  notes: string | null;
  groups: SeedGroup[];
}

export interface SeedMission {
  mission_id: number;
  arc_position: number | null;
  prev_mission_id: number | null;
  next_mission_id: number | null;
  name: string;
  level: number;
  mission_type: string;
  faction: string | null;
  is_epic_arc: boolean;
  damage_to_deal: string | null;
  damage_to_resist: string | null;
  recommended_ship: string | null;
  briefing_html: string | null;
  objective_html: string | null;
  reward_isk: number | null;
  reward_lp: number | null;
  reward_bonus_isk: number | null;
  bonus_time_seconds: number | null;
  source_url: string;
  objective_items: Array<{
    type_id: number | null;
    type_name: string;
    quantity: number;
    volume_m3: number | null;
    role: string;
  }>;
  pockets: SeedPocket[];
}

export type CheerioApi = cheerio.CheerioAPI;

export function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function stripTags(html: string): string {
  return cleanText(cheerio.load(`<div>${html}</div>`)("div").text());
}

export function parseNumber(value: string | null | undefined): number | null {
  const raw = cleanText(value ?? "").replace(/%$/, "").replace(/x$/i, "");
  if (!raw || raw === "&nbsp;") return null;
  const match = raw.match(/^(-?[\d,.]+)\s*([kKmM])?(?:\s*(km|m3|m|sec|s|hp|gj))?$/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1].replaceAll(",", ""));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2];
  const unit = match[3]?.toLowerCase();
  let result = base;
  // "k"/"K" = thousand, "M" = million. Lowercase "m" is the meters unit (e.g. a
  // range or velocity), NOT mega — treating it as 1e6 inflated ranges 1,000,000x.
  if (suffix === "k" || suffix === "K") result *= 1000;
  else if (suffix === "M") result *= 1000000;
  if (unit === "km") result *= 1000;
  return Math.round(result * 1000) / 1000;
}

export function parseTypeId(href: string | undefined): number | null {
  const match = href?.match(/type_id=(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Mission briefing/objective sections are stored as HTML and rendered via
// innerHTML on the frontend, so neutralize the obvious script-injection vectors
// at ingest (the content is intentionally HTML, so we sanitize rather than escape).
export function sanitizeSectionHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
}

export function sectionHtml($: CheerioApi, headingText: string): string | null {
  const heading = $("h2")
    .filter((_, el) => cleanText($(el).text()).toLowerCase() === headingText.toLowerCase())
    .first();
  if (!heading.length) return null;
  const parts: string[] = [];
  let node: AnyNode | null = heading[0].nextSibling;
  while (node) {
    if (node.type === "tag") {
      const element = node as Element;
      if (element.name === "h2" || (element.attribs?.class ?? "").includes("site-pocket")) break;
    }
    parts.push($.html(node));
    node = node.nextSibling;
  }
  return sanitizeSectionHtml(parts.join("")).trim() || null;
}

export function neighborId(html: string, label: "Previous" | "Next"): number | null {
  const pattern = new RegExp(`${label}:<br\\s*/?>\\s*<a href=['"]mission_view\\.php\\?id=(\\d+)['"]`, "i");
  const match = html.match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function objectiveItems(objectiveHtml: string | null): SeedMission["objective_items"] {
  if (!objectiveHtml) return [];
  const rows: SeedMission["objective_items"] = [];
  const isDeliver = /deliver/i.test(stripTags(objectiveHtml));
  const pattern =
    /(\d[\d,]*)x\s*<a href=['"]item\.php\?type_id=(\d+)['"][^>]*>(.*?)<\/a>\s*(?:\(volume:\s*([^)]+?)\s*m3\))?/gi;
  for (const match of objectiveHtml.matchAll(pattern)) {
    rows.push({
      type_id: Number.parseInt(match[2], 10),
      type_name: stripTags(match[3]),
      quantity: Number.parseInt(match[1].replaceAll(",", ""), 10),
      volume_m3: parseNumber(match[4]),
      role: isDeliver ? "DELIVER" : "RETRIEVE"
    });
  }
  return rows;
}

export function missionType($: CheerioApi, objective: string | null): string {
  if ($(".site-pocket").length > 0) return "ENCOUNTER";
  const text = stripTags(objective ?? "");
  if (/deliver|transport|bring/i.test(text)) return "COURIER";
  if (/mine|asteroid/i.test(text)) return "MINING";
  return "ENCOUNTER";
}

export function enemyFaction($: CheerioApi, pageText: string): string | null {
  if (/angel|gist/i.test(pageText)) return "Angel Cartel";
  if (/sansa|sansha/i.test(pageText)) return "Sansha's Nation";
  if (/guristas/i.test(pageText)) return "Guristas";
  if (/serpentis/i.test(pageText)) return "Serpentis";
  if (/blood raider/i.test(pageText)) return "Blood Raiders";
  return $(".site-pocket").length > 0 ? "Unknown" : null;
}

export function damageProfile(faction: string | null): { deal: string | null; resist: string | null } {
  if (faction === "Angel Cartel") return { deal: "Explosive/Kinetic", resist: "Explosive/Kinetic" };
  if (faction === "Sansha's Nation" || faction === "Blood Raiders") return { deal: "EM/Thermal", resist: "EM/Thermal" };
  if (faction === "Guristas") return { deal: "Kinetic/Thermal", resist: "Kinetic/Thermal" };
  if (faction === "Serpentis") return { deal: "Thermal/Kinetic", resist: "Thermal/Kinetic" };
  return { deal: null, resist: null };
}

export interface EntityWeaponStats {
  turret_dps_em: number;
  turret_dps_therm: number;
  turret_dps_kin: number;
  turret_dps_exp: number;
  turret_range: number | null;
}

export function entityItemUrl(baseUrl: string, typeId: number): string {
  if (baseUrl.includes("mission_view.php?id=")) return baseUrl.replace("mission_view.php?id=", `item.php?type_id=${typeId}`);
  return `http://games.chruker.dk/eve_online/item.php?type_id=${typeId}`;
}

export function dpsTotal(npc: Pick<SeedNpc, "turret_dps_em" | "turret_dps_therm" | "turret_dps_kin" | "turret_dps_exp" | "missile_dps_em" | "missile_dps_therm" | "missile_dps_kin" | "missile_dps_exp">): number {
  return (
    (npc.turret_dps_em ?? 0) +
    (npc.turret_dps_therm ?? 0) +
    (npc.turret_dps_kin ?? 0) +
    (npc.turret_dps_exp ?? 0) +
    (npc.missile_dps_em ?? 0) +
    (npc.missile_dps_therm ?? 0) +
    (npc.missile_dps_kin ?? 0) +
    (npc.missile_dps_exp ?? 0)
  );
}

export function parseEntityWeaponStats(html: string): EntityWeaponStats | null {
  const $ = cheerio.load(html);
  const attrs = new Map<string, string>();
  $("tr").each((_, row) => {
    const cells = rowTexts($, row as Element);
    if (cells.length >= 3) attrs.set(cells[0], cells[2]);
  });

  const multiplier = parseNumber(attrs.get("damageMultiplier")) ?? 1;
  const rateOfFire = parseNumber(attrs.get("speed"));
  // Real rate of fire is thousands of ms; a value of 1 is a sentinel, not a
  // 1ms cycle. Treat <=1 as "no usable RoF" so we don't inflate DPS ~1000x+.
  if (rateOfFire === null || rateOfFire <= 1) return null;

  const dps = (attributeName: string): number => {
    const damage = parseNumber(attrs.get(attributeName)) ?? 0;
    return Math.round((damage * multiplier * 1000) / rateOfFire) / 1000;
  };
  const stats = {
    turret_dps_em: dps("emDamage"),
    turret_dps_therm: dps("thermalDamage"),
    turret_dps_kin: dps("kineticDamage"),
    turret_dps_exp: dps("explosiveDamage"),
    turret_range: parseNumber(attrs.get("maxRange")) ?? parseNumber(attrs.get("entityAttackRange"))
  };

  return stats.turret_dps_em + stats.turret_dps_therm + stats.turret_dps_kin + stats.turret_dps_exp > 0 ? stats : null;
}

export function rowTexts($: CheerioApi, row: Element): string[] {
  return $(row)
    .children("td")
    .toArray()
    .map((cell) => cleanText($(cell).text()));
}

export function valueAfter(cells: string[], label: RegExp): string | null {
  const index = cells.findIndex((cell) => label.test(cell));
  return index >= 0 ? cells[index + 1] ?? null : null;
}

export function metricsAfter(cells: string[], label: RegExp, count: number): Array<number | null> {
  const index = cells.findIndex((cell) => label.test(cell));
  if (index < 0) return Array.from({ length: count }, () => null);
  const values: Array<number | null> = [];
  for (const cell of cells.slice(index + 1)) {
    if (/^(Shield|Armor|Hull|Turrets|Missiles|Max\.vel|Orbit|- Speed|Sig\.Rad|Bounty|Attack|Defender)/i.test(cell)) break;
    values.push(parseNumber(cell));
    if (values.length === count) break;
  }
  while (values.length < count) values.push(null);
  return values;
}

export function dedupeEwar(entries: SeedNpc["ewar"]): SeedNpc["ewar"] {
  // A rowspan'd NPC repeats its EWAR spans across every row of the segment, so a
  // naive flatMap yields N copies of each effect. Dedupe by type+text.
  const seen = new Set<string>();
  const out: SeedNpc["ewar"] = [];
  for (const entry of entries) {
    const key = `${entry.type} ${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function ewarRows($: CheerioApi, row: Element): SeedNpc["ewar"] {
  return $(row)
    .find("[class*='ewar_']")
    .toArray()
    .map((span) => {
      const className = ($(span).attr("class") ?? "").split(/\s+/).find((name) => name.startsWith("ewar_")) ?? "ewar_unknown";
      return {
        type: className.replace(/^ewar_/, "").replaceAll("-", "_").toUpperCase(),
        text: cleanText($(span).text())
      };
    });
}

export function inferShipClass(name: string): string | null {
  return shipClassFromTypeName(name);
}

export function parseNpcTable($: CheerioApi, table: Element): SeedNpc[] {
  const rows = $(table).find("tr").toArray() as Element[];
  const npcs: SeedNpc[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const startRow = rows[i];
    const firstCell = $(startRow).children("td").first();
    if (!/^p\d+g\d+e\d+$/.test(firstCell.attr("id") ?? "")) continue;
    const rowspan = Number.parseInt(firstCell.attr("rowspan") ?? "1", 10);
    const segment = rows.slice(i, i + Math.max(rowspan, 1));
    const anchor = $(startRow).find("a[href*='item.php?type_id=']").first();
    const typeName = cleanText(anchor.text());
    if (!typeName) continue;
    const flattened = segment.flatMap((row) => rowTexts($, row));
    const startCells = rowTexts($, startRow);
    const shield = metricsAfter(flattened, /^Shield/i, 5);
    const armor = metricsAfter(flattened, /^Armor/i, 5);
    const turret = metricsAfter(flattened, /^Turrets/i, 5);
    const missile = metricsAfter(flattened, /^Missiles/i, 5);
    const defender = (flattened.join(" ").match(/Defender:\s*([\d.]+)%/i) ?? [])[1] ?? null;
    const compact = rowspan === 1 && startCells.length >= 7 && !flattened.some((cell) => /^Bounty:?$/i.test(cell));

    npcs.push({
      quantity: Math.trunc(parseNumber(firstCell.text()) ?? 1),
      type_id: parseTypeId(anchor.attr("href")),
      type_name: typeName,
      ship_class: inferShipClass(typeName),
      bounty_isk: compact ? parseNumber(startCells[2]) : parseNumber(valueAfter(flattened, /^Bounty:?$/i)),
      signature_radius: compact ? parseNumber(startCells[3]) : parseNumber(valueAfter(flattened, /^Sig\.Rad\./i)),
      max_velocity: parseNumber(valueAfter(flattened, /^Max\.vel\./i)),
      orbit_velocity: parseNumber(valueAfter(flattened, /^- Speed:?$/i)),
      orbit_distance: parseNumber(valueAfter(flattened, /^Orbit:?$/i)),
      shield_hp: compact ? Math.trunc(parseNumber(startCells[4]) ?? 0) : Math.trunc(shield[0] ?? 0),
      armor_hp: compact ? Math.trunc(parseNumber(startCells[5]) ?? 0) : Math.trunc(armor[0] ?? 0),
      hull_hp: compact ? Math.trunc(parseNumber(startCells[6]) ?? 0) : Math.trunc(parseNumber(valueAfter(flattened, /^Hull:?$/i)) ?? 0),
      resist_shield_em: shield[1],
      resist_shield_therm: shield[2],
      resist_shield_kin: shield[3],
      resist_shield_exp: shield[4],
      resist_armor_em: armor[1],
      resist_armor_therm: armor[2],
      resist_armor_kin: armor[3],
      resist_armor_exp: armor[4],
      turret_range: turret[0],
      turret_dps_em: turret[1],
      turret_dps_therm: turret[2],
      turret_dps_kin: turret[3],
      turret_dps_exp: turret[4],
      missile_range: missile[0],
      missile_dps_em: missile[1],
      missile_dps_therm: missile[2],
      missile_dps_kin: missile[3],
      missile_dps_exp: missile[4],
      defender_chance_pct: parseNumber(defender),
      ewar: dedupeEwar(segment.flatMap((row) => ewarRows($, row))),
      notes: null
    });
    i += Math.max(rowspan, 1) - 1;
  }
  return npcs;
}

export function parsePockets($: CheerioApi): SeedPocket[] {
  const pockets: SeedPocket[] = [];
  $(".site-pocket").each((pocketIndex, pocketEl) => {
    const pocket = $(pocketEl);
    const groups: SeedGroup[] = [];
    pocket.find(".site-group").each((groupIndex, groupEl) => {
      const group = $(groupEl);
      const label = cleanText(group.children("h3").first().text()) || null;
      const noteClone = group.clone();
      noteClone.children("h3, table").remove();
      const noteText = cleanText(noteClone.text());
      const triggerText = (noteText.match(/Spawn Trigger:[^]+?(?=Hacking Level|$)/i) ?? [])[0]?.trim() ?? null;
      const npcs = group.find("table").toArray().flatMap((table) => parseNpcTable($, table as Element));
      groups.push({
        group_index: groupIndex,
        label,
        distance_text: label?.split(" - ").slice(1).join(" - ") || null,
        trigger_text: triggerText,
        optional: /optional/i.test(label ?? noteText),
        npcs
      });
    });
    const pocketTitle = cleanText(pocket.find("h2").first().text()) || null;
    pockets.push({
      pocket_index: pocketIndex,
      name: pocketTitle,
      notes: null,
      groups
    });
  });
  return pockets;
}

export function parseMission(html: string, id: number, url: string, defaultLevel: number): SeedMission {
  const $ = cheerio.load(html);
  const briefing = sectionHtml($, "Mission Briefing");
  const objective = sectionHtml($, "Objective");
  const pageText = cleanText($("body").text());
  const faction = enemyFaction($, pageText);
  const damage = damageProfile(faction);
  const pockets = parsePockets($);
  const headline = cleanText($(".headline-note").text());
  const level = Number.parseInt((headline.match(/Level\s+(\d+)/i) ?? [])[1] ?? "", 10);
  return {
    mission_id: id,
    arc_position: null,
    prev_mission_id: neighborId(html, "Previous"),
    next_mission_id: neighborId(html, "Next"),
    name: cleanText($("h1").first().text()) || `Mission ${id}`,
    level: Number.isFinite(level) ? level : defaultLevel,
    mission_type: missionType($, objective),
    faction,
    is_epic_arc: /epic arc/i.test(headline),
    damage_to_deal: damage.deal,
    damage_to_resist: damage.resist,
    recommended_ship: pockets.length > 0 ? "Battleship" : null,
    briefing_html: briefing,
    objective_html: objective,
    reward_isk: null,
    reward_lp: null,
    reward_bonus_isk: null,
    bonus_time_seconds: null,
    source_url: url,
    objective_items: objectiveItems(objective),
    pockets
  };
}
