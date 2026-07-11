import type { Db } from "../db.js";
import {
  hasEarnableLpSource,
  hasLevel4Or5SecurityBasicAgent,
  hasLevel5BasicAgent
} from "../reference/level5-agent-corps.js";
import { nowIso, recordSourceImport as recordSourceImportDb, syncAgentDerivedCorpFlags } from "../db.js";
import { bumpSnapshotDataVersion } from "../lib/compute-generation.js";
import { leastRiskTier, riskTierFromSecurity, type RiskTier } from "../calc/risk.js";
import { arrayValue, integerValue, localizedName, numberValue, objectValue, rowName, stringValue } from "../lib/sde-row.js";
import {
  latestRemoteBuildNumber,
  openSdeArchive,
  pruneCachedArchives,
  type OpenSdeArchiveOptions,
  type SdeArchiveReader
} from "./sde-archive.js";

type LpSourceTier = "STANDARD" | "SPECIAL";

const specialLpCorpIds = new Set([1000125, 1000137]);

interface GroupInfo {
  name: string | null;
  categoryId: number | null;
  categoryName: string | null;
}

interface SystemInfo {
  name: string;
  security: number | null;
  riskTier: RiskTier;
}

interface StationInfo {
  name: string;
  systemId: number;
  ownerCorpId: number | null;
}

interface SdeImportSummary {
  types: number;
  systems: number;
  stations: number;
  corporations: number;
  blueprints: number;
  regions: number;
  constellations: number;
  agentTypes: number;
  corpDivisions: number;
  agents: number;
  source: string;
}

async function readRows(reader: SdeArchiveReader, memberName: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  await reader.readJsonl<Record<string, unknown>>(memberName, (row) => {
    rows.push(row);
  });
  return rows;
}

function lpSourceTier(corpId: number, name: string): LpSourceTier {
  return specialLpCorpIds.has(corpId) || name === "CONCORD" || name === "DED" ? "SPECIAL" : "STANDARD";
}

function hasLpStore(row: Record<string, unknown>): number {
  return arrayValue(row, ["lpOfferTables", "lp_offer_tables", "lpStoreOffers"]).length > 0 ? 1 : 0;
}

function accessRiskTier(
  corpId: number,
  stations: Map<number, StationInfo>,
  systems: Map<number, SystemInfo>,
  fallback: RiskTier
): RiskTier {
  const stationTiers: RiskTier[] = [];
  for (const station of stations.values()) {
    if (station.ownerCorpId !== corpId) continue;
    const tier = systems.get(station.systemId)?.riskTier;
    if (tier) stationTiers.push(tier);
  }
  return stationTiers.length > 0 ? leastRiskTier(stationTiers) : fallback;
}

function manufacturingActivity(row: Record<string, unknown>): Record<string, unknown> {
  const activities = row.activities;
  if (activities && typeof activities === "object") {
    const manufacturing = (activities as Record<string, unknown>).manufacturing;
    if (manufacturing && typeof manufacturing === "object") return manufacturing as Record<string, unknown>;
  }
  return {};
}

function typedQuantityRows(value: unknown): Array<{ typeId: number; quantity: number }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ typeId: number; quantity: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const typeId = integerValue(row, ["typeID", "type_id", "productTypeID", "materialTypeID"]);
    const quantity = integerValue(row, ["quantity"]);
    if (typeId !== null && quantity !== null) rows.push({ typeId, quantity });
  }
  return rows;
}

// -- Buffered row sets read before any DB writes --

interface SdeRowSets {
  categoryRows: Array<Record<string, unknown>>;
  groupRows: Array<Record<string, unknown>>;
  typeRows: Array<Record<string, unknown>>;
  systemRows: Array<Record<string, unknown>>;
  stationRows: Array<Record<string, unknown>>;
  corporationRows: Array<Record<string, unknown>>;
  blueprintRows: Array<Record<string, unknown>>;
  regionRows: Array<Record<string, unknown>>;
  constellationRows: Array<Record<string, unknown>>;
  agentTypeRows: Array<Record<string, unknown>>;
  corpDivisionRows: Array<Record<string, unknown>>;
  npcCharacterRows: Array<Record<string, unknown>>;
  agentsInSpaceRows: Array<Record<string, unknown>>;
  stationOperationRows: Array<Record<string, unknown>>;
}

async function readAllRows(reader: SdeArchiveReader): Promise<SdeRowSets> {
  // Sequential reads: each readJsonl opens the ZIP independently; serialising
  // them avoids holding many concurrent file handles against the same archive.
  const categoryRows = await readRows(reader, "categories.jsonl");
  const groupRows = await readRows(reader, "groups.jsonl");
  const typeRows = await readRows(reader, "types.jsonl");
  const systemRows = await readRows(reader, "mapSolarSystems.jsonl");
  const stationRows = await readRows(reader, "npcStations.jsonl");
  const corporationRows = await readRows(reader, "npcCorporations.jsonl");
  const blueprintRows = await readRows(reader, "blueprints.jsonl");
  const regionRows = await readRows(reader, "mapRegions.jsonl");
  const constellationRows = await readRows(reader, "mapConstellations.jsonl");
  const agentTypeRows = await readRows(reader, "agentTypes.jsonl");
  const corpDivisionRows = await readRows(reader, "npcCorporationDivisions.jsonl");
  const npcCharacterRows = await readRows(reader, "npcCharacters.jsonl");
  const agentsInSpaceRows = await readRows(reader, "agentsInSpace.jsonl");
  const stationOperationRows = await readRows(reader, "stationOperations.jsonl");
  return {
    categoryRows,
    groupRows,
    typeRows,
    systemRows,
    stationRows,
    corporationRows,
    blueprintRows,
    regionRows,
    constellationRows,
    agentTypeRows,
    corpDivisionRows,
    npcCharacterRows,
    agentsInSpaceRows,
    stationOperationRows
  };
}

// The official JSONL SDE ships npcStations.jsonl WITHOUT station names; the in-game name is
// constructed as "<System> <Planet roman> [- Moon <n>] - <Owner corp> <Operation>"
// (e.g. "Aeschee X - Moon 20 - Sisters of EVE Academy"). These helpers rebuild it from
// celestialIndex/orbitIndex/ownerID/operationID so the UI never shows raw station ids.

const romanOnes = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
const romanTens = ["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"];

function romanNumeral(value: number): string {
  if (value <= 0 || value >= 100) return String(value);
  return romanTens[Math.floor(value / 10)] + romanOnes[value % 10];
}

function buildNameMap(rows: Array<Record<string, unknown>>, idKeys: string[], nameKeys: string[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of rows) {
    const id = integerValue(row, idKeys);
    if (id === null) continue;
    const name = localizedName(objectValue(row, nameKeys), "");
    if (name) names.set(id, name);
  }
  return names;
}

function constructStationName(
  row: Record<string, unknown>,
  stationId: number,
  systemName: string,
  ownerCorpId: number | null,
  corpNames: Map<number, string>,
  operationNames: Map<number, string>
): string {
  const celestialIndex = integerValue(row, ["celestialIndex", "celestial_index"]);
  const orbitIndex = integerValue(row, ["orbitIndex", "orbit_index"]);
  const operationId = integerValue(row, ["operationID", "operation_id"]);
  const corpName = ownerCorpId === null ? undefined : corpNames.get(ownerCorpId);
  const operationName = operationId === null ? undefined : operationNames.get(operationId);
  if (!corpName && !operationName) return `Station ${stationId} (${systemName})`;

  let place = systemName;
  if (celestialIndex !== null && celestialIndex > 0) place += ` ${romanNumeral(celestialIndex)}`;
  if (orbitIndex !== null && orbitIndex > 0) place += ` - Moon ${orbitIndex}`;
  return `${place} - ${[corpName, operationName].filter(Boolean).join(" ")}`;
}

// -- Synchronous write functions (called inside the single outer transaction) --

function writeTypes(
  appDb: Db,
  categoryRows: Array<Record<string, unknown>>,
  groupRows: Array<Record<string, unknown>>,
  typeRows: Array<Record<string, unknown>>
): number {
  const categories = new Map<number, string>();
  for (const row of categoryRows) {
    const categoryId = integerValue(row, ["categoryID", "category_id", "_key"]);
    if (categoryId === null) continue;
    categories.set(categoryId, rowName(row, ["name", "categoryName", "category_name"], `Category ${categoryId}`));
  }

  const groups = new Map<number, GroupInfo>();
  for (const row of groupRows) {
    const groupId = integerValue(row, ["groupID", "group_id", "_key"]);
    if (groupId === null) continue;
    const categoryId = integerValue(row, ["categoryID", "category_id"]);
    groups.set(groupId, {
      name: rowName(row, ["name", "groupName", "group_name"], `Group ${groupId}`),
      categoryId,
      categoryName: categoryId === null ? null : categories.get(categoryId) ?? `Category ${categoryId}`
    });
  }

  const insert = appDb.prepare(`
    INSERT INTO types(type_id, name, group_id, group_name, category_id, category_name, volume, packaged_volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      name=excluded.name,
      group_id=excluded.group_id,
      group_name=excluded.group_name,
      category_id=excluded.category_id,
      category_name=excluded.category_name,
      volume=excluded.volume,
      packaged_volume=excluded.packaged_volume
  `);

  let count = 0;
  for (const row of typeRows) {
    const typeId = integerValue(row, ["typeID", "type_id", "_key"]);
    if (typeId === null) continue;
    const groupId = integerValue(row, ["groupID", "group_id"]);
    const group = groupId === null ? null : groups.get(groupId);
    const volume = numberValue(row, ["volume"]);
    insert.run(
      typeId,
      rowName(row, ["name", "typeName", "type_name"], `Type ${typeId}`),
      groupId,
      group?.name ?? null,
      group?.categoryId ?? null,
      group?.categoryName ?? null,
      volume,
      numberValue(row, ["packagedVolume", "packaged_volume"]) ?? volume
    );
    count += 1;
  }
  return count;
}

function writeSystems(
  appDb: Db,
  systemRows: Array<Record<string, unknown>>
): Map<number, SystemInfo> {
  const systems = new Map<number, SystemInfo>();
  const insert = appDb.prepare(`
    INSERT INTO systems(system_id, name, security_status, risk_tier, region_id, constellation_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id) DO UPDATE SET
      name=excluded.name,
      security_status=excluded.security_status,
      risk_tier=excluded.risk_tier,
      region_id=excluded.region_id,
      constellation_id=excluded.constellation_id
  `);
  for (const row of systemRows) {
    const systemId = integerValue(row, ["solarSystemID", "solar_system_id", "systemID", "system_id", "_key"]);
    if (systemId === null) continue;
    const security = numberValue(row, ["security", "securityStatus", "security_status"]);
    const riskTier = riskTierFromSecurity(security);
    const info = {
      name: rowName(row, ["name", "solarSystemName", "solar_system_name"], `System ${systemId}`),
      security,
      riskTier
    };
    systems.set(systemId, info);
    insert.run(
      systemId,
      info.name,
      security,
      riskTier,
      integerValue(row, ["regionID", "region_id"]),
      integerValue(row, ["constellationID", "constellation_id"])
    );
  }
  return systems;
}

interface IdNameTable {
  table: string;
  idColumn: string;
  idKeys: string[];
  nameKeys: string[];
  fallbackPrefix: string;
}

// Shared id+name upsert for the structurally identical region/constellation/agent-type
// tables: one integer id column + a name column, "keep the latest name" on conflict. The
// `idColumn` is interpolated into both the insert column list and the ON CONFLICT target;
// it comes from this module's static table config (never user input). `writeCorpDivisions`
// stays separate because it carries extra display/internal name columns.
function writeIdNameRows(appDb: Db, config: IdNameTable, rows: Array<Record<string, unknown>>): number {
  const insert = appDb.prepare(`
    INSERT INTO ${config.table}(${config.idColumn}, name)
    VALUES (?, ?)
    ON CONFLICT(${config.idColumn}) DO UPDATE SET name=excluded.name
  `);
  let count = 0;
  for (const row of rows) {
    const id = integerValue(row, config.idKeys);
    if (id === null) continue;
    insert.run(id, rowName(row, config.nameKeys, `${config.fallbackPrefix} ${id}`));
    count += 1;
  }
  return count;
}

function writeCorpDivisions(appDb: Db, corpDivisionRows: Array<Record<string, unknown>>): number {
  const insert = appDb.prepare(`
    INSERT INTO npc_corp_divisions(division_id, name, display_name, internal_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(division_id) DO UPDATE SET
      name=excluded.name,
      display_name=excluded.display_name,
      internal_name=excluded.internal_name
  `);
  let count = 0;
  for (const row of corpDivisionRows) {
    const divisionId = integerValue(row, ["divisionID", "division_id", "_key"]);
    if (divisionId === null) continue;
    insert.run(
      divisionId,
      rowName(row, ["name"], `Division ${divisionId}`),
      stringValue(row, ["displayName", "display_name"]),
      stringValue(row, ["internalName", "internal_name"])
    );
    count += 1;
  }
  return count;
}

function writeAgents(
  appDb: Db,
  npcCharacterRows: Array<Record<string, unknown>>,
  agentsInSpaceRows: Array<Record<string, unknown>>,
  stations: Map<number, StationInfo>
): number {
  const inSpaceAgentIds = new Set<number>();
  for (const row of agentsInSpaceRows) {
    const agentId = integerValue(row, ["agentID", "agent_id", "_key"]);
    if (agentId !== null) inSpaceAgentIds.add(agentId);
  }

  const insert = appDb.prepare(`
    INSERT INTO npc_agents(
      agent_id, name, corp_id, station_id, system_id,
      level, division_id, agent_type_id, is_locator, in_space
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name=excluded.name,
      corp_id=excluded.corp_id,
      station_id=excluded.station_id,
      system_id=excluded.system_id,
      level=excluded.level,
      division_id=excluded.division_id,
      agent_type_id=excluded.agent_type_id,
      is_locator=excluded.is_locator,
      in_space=excluded.in_space
  `);

  let count = 0;
  let skipped = 0;
  for (const row of npcCharacterRows) {
    // npcCharacters also carries non-agent NPCs; only rows with an agent block matter here.
    const agent = objectValue(row, ["agent"]);
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue;
    const agentRecord = agent as Record<string, unknown>;

    const agentId = integerValue(row, ["characterID", "character_id", "_key"]);
    const corpId = integerValue(row, ["corporationID", "corporation_id"]);
    const locationId = integerValue(row, ["locationID", "location_id"]);
    const agentTypeId = integerValue(agentRecord, ["agentTypeID", "agent_type_id"]);
    const level = integerValue(agentRecord, ["level"]);

    // locationID is a station for nearly every agent; a handful sit directly in a solar
    // system. Anything else (or a station we never imported) cannot be placed on the map.
    let stationId: number | null = null;
    let systemId: number | null = null;
    if (locationId !== null && locationId >= 60_000_000 && locationId < 70_000_000) {
      const station = stations.get(locationId);
      if (station) {
        stationId = locationId;
        systemId = station.systemId;
      }
    } else if (locationId !== null && locationId >= 30_000_000 && locationId < 40_000_000) {
      systemId = locationId;
    }

    if (agentId === null || corpId === null || agentTypeId === null || level === null || systemId === null) {
      skipped += 1;
      continue;
    }

    insert.run(
      agentId,
      rowName(row, ["name"], `Agent ${agentId}`),
      corpId,
      stationId,
      systemId,
      level,
      integerValue(agentRecord, ["divisionID", "division_id"]),
      agentTypeId,
      agentRecord.isLocator === true ? 1 : 0,
      inSpaceAgentIds.has(agentId) ? 1 : 0
    );
    count += 1;
  }
  if (skipped > 0) {
    console.warn(JSON.stringify({ component: "sde-import", event: "agents_skipped", count: skipped }));
  }
  return count;
}

function writeStations(
  appDb: Db,
  stationRows: Array<Record<string, unknown>>,
  systems: Map<number, SystemInfo>,
  corpNames: Map<number, string>,
  operationNames: Map<number, string>
): Map<number, StationInfo> {
  const stations = new Map<number, StationInfo>();
  const insert = appDb.prepare(`
    INSERT INTO stations(station_id, name, system_id, owner_corp_id, operation_id, type_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id) DO UPDATE SET
      name=excluded.name,
      system_id=excluded.system_id,
      owner_corp_id=excluded.owner_corp_id,
      operation_id=excluded.operation_id,
      type_id=excluded.type_id
  `);
  for (const row of stationRows) {
    const stationId = integerValue(row, ["stationID", "station_id", "_key"]);
    const systemId = integerValue(row, ["solarSystemID", "solar_system_id", "systemID", "system_id"]);
    if (stationId === null || systemId === null) continue;
    const systemName = systems.get(systemId)?.name ?? `System ${systemId}`;
    const ownerCorpId = integerValue(row, ["corporationID", "corporation_id", "ownerCorpID", "owner_corp_id", "ownerID"]);
    // Prefer an explicit name if CCP ever re-adds one; otherwise rebuild the in-game name.
    const name = rowName(
      row,
      ["name", "stationName", "station_name"],
      constructStationName(row, stationId, systemName, ownerCorpId, corpNames, operationNames)
    );
    stations.set(stationId, { name, systemId, ownerCorpId });
    insert.run(
      stationId,
      name,
      systemId,
      ownerCorpId,
      integerValue(row, ["operationID", "operation_id"]),
      integerValue(row, ["stationTypeID", "station_type_id", "typeID", "type_id"])
    );
  }
  return stations;
}

function writeCorporations(
  appDb: Db,
  corporationRows: Array<Record<string, unknown>>,
  systems: Map<number, SystemInfo>,
  stations: Map<number, StationInfo>
): number {
  const insert = appDb.prepare(`
    INSERT INTO corporations(
      corp_id, name, faction_id, hq_station_id, hq_station_name,
      hq_system_id, hq_system_name, hq_security_status, risk_tier, access_risk_tier,
      lp_source_tier, has_lp_store, has_earnable_lp_source, has_level5_agent, has_l4_l5_security_agent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(corp_id) DO UPDATE SET
      name=excluded.name,
      faction_id=excluded.faction_id,
      hq_station_id=excluded.hq_station_id,
      hq_station_name=excluded.hq_station_name,
      hq_system_id=excluded.hq_system_id,
      hq_system_name=excluded.hq_system_name,
      hq_security_status=excluded.hq_security_status,
      risk_tier=excluded.risk_tier,
      access_risk_tier=excluded.access_risk_tier,
      lp_source_tier=excluded.lp_source_tier,
      has_lp_store=excluded.has_lp_store,
      has_earnable_lp_source=excluded.has_earnable_lp_source,
      has_level5_agent=excluded.has_level5_agent,
      has_l4_l5_security_agent=excluded.has_l4_l5_security_agent
  `);
  let count = 0;
  for (const row of corporationRows) {
    const corpId = integerValue(row, ["corporationID", "corporation_id", "_key"]);
    if (corpId === null) continue;
    const name = rowName(row, ["name", "corporationName", "corporation_name"], `Corporation ${corpId}`);
    const stationId = integerValue(row, ["stationID", "station_id"]);
    const station = stationId === null ? undefined : stations.get(stationId);
    const systemId = station?.systemId ?? integerValue(row, ["solarSystemID", "solar_system_id", "systemID", "system_id"]);
    const system = systemId === null ? undefined : systems.get(systemId);
    const security = system?.security ?? null;
    const riskTier = system?.riskTier ?? riskTierFromSecurity(security);
    insert.run(
      corpId,
      name,
      integerValue(row, ["factionID", "faction_id"]),
      stationId,
      station?.name ?? null,
      systemId,
      system?.name ?? null,
      security,
      riskTier,
      accessRiskTier(corpId, stations, systems, riskTier),
      lpSourceTier(corpId, name),
      hasLpStore(row),
      hasEarnableLpSource(corpId) ? 1 : 0,
      hasLevel5BasicAgent(corpId) ? 1 : 0,
      hasLevel4Or5SecurityBasicAgent(corpId) ? 1 : 0
    );
    count += 1;
  }
  return count;
}

function writeBlueprints(
  appDb: Db,
  blueprintRows: Array<Record<string, unknown>>
): number {
  // Guard: empty parse must not wipe existing blueprint data.
  if (blueprintRows.length === 0) return 0;
  const insertProduct = appDb.prepare(`
    INSERT INTO blueprint_products(blueprint_type_id, product_type_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(blueprint_type_id, product_type_id) DO UPDATE SET quantity=excluded.quantity
  `);
  const insertMaterial = appDb.prepare(`
    INSERT INTO blueprint_materials(blueprint_type_id, material_type_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(blueprint_type_id, material_type_id) DO UPDATE SET quantity=excluded.quantity
  `);
  appDb.prepare("DELETE FROM blueprint_products").run();
  appDb.prepare("DELETE FROM blueprint_materials").run();
  let count = 0;
  for (const row of blueprintRows) {
    const blueprintTypeId = integerValue(row, ["blueprintTypeID", "blueprint_type_id", "typeID", "type_id"]);
    if (blueprintTypeId === null) continue;
    const manufacturing = manufacturingActivity(row);
    const products = typedQuantityRows(objectValue(manufacturing, ["products"]));
    const materials = typedQuantityRows(objectValue(manufacturing, ["materials"]));
    if (products.length === 0 && materials.length === 0) continue;
    for (const product of products) insertProduct.run(blueprintTypeId, product.typeId, product.quantity);
    for (const material of materials) insertMaterial.run(blueprintTypeId, material.typeId, material.quantity);
    count += 1;
  }
  return count;
}

function recordSourceImport(appDb: Db, reader: SdeArchiveReader, counts: Omit<SdeImportSummary, "source">): void {
  recordSourceImportDb(
    appDb,
    "ccp-jsonl-sde",
    reader.archiveUrl,
    nowIso(),
    JSON.stringify({ ...reader.metadata.raw, counts }),
    reader.metadata.buildNumber,
    reader.metadata.releaseDate,
    { updateBuildInfo: true }
  );
}

export async function importSde(appDb: Db, options: OpenSdeArchiveOptions = {}): Promise<SdeImportSummary> {
  const reader = await openSdeArchive(options);

  // Read all JSONL files before touching the database.
  // This ensures that a streaming failure (e.g. corrupt archive member) leaves
  // the database untouched, and that all writes commit or roll back atomically.
  const rowSets = await readAllRows(reader);

  // All DB writes in one synchronous transaction — no partial SDE state possible.
  const tx = appDb.transaction(() => {
    const types = writeTypes(appDb, rowSets.categoryRows, rowSets.groupRows, rowSets.typeRows);
    const regions = writeIdNameRows(
      appDb,
      {
        table: "regions",
        idColumn: "region_id",
        idKeys: ["regionID", "region_id", "_key"],
        nameKeys: ["name", "regionName", "region_name"],
        fallbackPrefix: "Region"
      },
      rowSets.regionRows
    );
    const constellations = writeIdNameRows(
      appDb,
      {
        table: "constellations",
        idColumn: "constellation_id",
        idKeys: ["constellationID", "constellation_id", "_key"],
        nameKeys: ["name", "constellationName", "constellation_name"],
        fallbackPrefix: "Constellation"
      },
      rowSets.constellationRows
    );
    const systems = writeSystems(appDb, rowSets.systemRows);
    const corpNames = buildNameMap(rowSets.corporationRows, ["corporationID", "corporation_id", "_key"], ["name", "corporationName", "corporation_name"]);
    const operationNames = buildNameMap(rowSets.stationOperationRows, ["operationID", "operation_id", "_key"], ["operationName", "operation_name", "name"]);
    const stations = writeStations(appDb, rowSets.stationRows, systems, corpNames, operationNames);
    const corporations = writeCorporations(appDb, rowSets.corporationRows, systems, stations);
    const blueprints = writeBlueprints(appDb, rowSets.blueprintRows);
    const agentTypes = writeIdNameRows(
      appDb,
      {
        table: "npc_agent_types",
        idColumn: "agent_type_id",
        idKeys: ["agentTypeID", "agent_type_id", "_key"],
        nameKeys: ["name"],
        fallbackPrefix: "AgentType"
      },
      rowSets.agentTypeRows
    );
    const corpDivisions = writeCorpDivisions(appDb, rowSets.corpDivisionRows);
    const agents = writeAgents(appDb, rowSets.npcCharacterRows, rowSets.agentsInSpaceRows, stations);
    // Corp agent flags come from the freshly imported agent rows (falls back to the static
    // reference lists only when no agents were imported at all).
    syncAgentDerivedCorpFlags(appDb);
    const counts = {
      types,
      systems: systems.size,
      stations: stations.size,
      corporations,
      blueprints,
      regions,
      constellations,
      agentTypes,
      corpDivisions,
      agents
    };
    recordSourceImport(appDb, reader, counts);
    return counts;
  });
  const counts = tx() as Omit<SdeImportSummary, "source">;

  // SDE writes types/blueprints/corporations — all snapshot-mirrored. importSde does
  // not go through runFetcher, so invalidate the snapshot here for the CLI import-sde
  // path (warmup runs this before its first snapshot build, so it is harmless there).
  bumpSnapshotDataVersion(appDb);

  return { ...counts, source: reader.archiveUrl };
}

export function readImportedSdeBuild(appDb: Db): number | null {
  const row = appDb.prepare("SELECT build_number FROM source_imports WHERE source='ccp-jsonl-sde'").get() as
    | { build_number: number | null }
    | undefined;
  return row?.build_number ?? null;
}

export interface SdeRefreshResult {
  imported: boolean;
  build: number | null;
  previousBuild: number | null;
  latestBuild: number | null;
  pruned: string[];
  summary?: SdeImportSummary;
}

// Daily refresh: import the SDE only when CCP has published a newer build. A cheap HEAD on
// the `latest` URL reveals the remote build number (via its redirect) without pulling the
// ~100MB archive; when it matches the build we last imported we skip entirely. On a new build
// — or when the remote build can't be determined and we can't safely skip — we force a fresh
// download + import (idempotent upserts) and prune superseded archives from the cache.
export async function refreshSde(appDb: Db, options: OpenSdeArchiveOptions = {}): Promise<SdeRefreshResult> {
  const previousBuild = readImportedSdeBuild(appDb);
  const latestBuild = await latestRemoteBuildNumber(options);
  if (latestBuild !== null && previousBuild !== null && latestBuild === previousBuild) {
    return { imported: false, build: previousBuild, previousBuild, latestBuild, pruned: [] };
  }
  const summary = await importSde(appDb, { ...options, forceDownload: true });
  const pruned = pruneCachedArchives(options);
  return { imported: true, build: readImportedSdeBuild(appDb), previousBuild, latestBuild, pruned, summary };
}
