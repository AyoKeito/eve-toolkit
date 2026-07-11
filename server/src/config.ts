import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function findRoot(start: string): string {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start, "../..");
    current = parent;
  }
}

export const rootDir = findRoot(srcDir);
export const dataDir = path.resolve(rootDir, "data");
export const backupDir = path.resolve(rootDir, "backups");
export const webDir = path.resolve(rootDir, "web");
export const agentsWebDir = path.resolve(webDir, "agents");
export const fitsWebDir = path.resolve(webDir, "fits");
export const landingWebDir = path.resolve(webDir, "landing");
export const lpWebDir = path.resolve(webDir, "lp");
export const missionsWebDir = path.resolve(webDir, "missions");
export const sharedWebDir = path.resolve(webDir, "shared");
export const logDir = path.resolve(rootDir, process.env.LOG_DIR ?? "logs");

export interface RuntimeConfig {
  adminToken: string;
  appUrl: string;
  contactEmail: string;
  dbPath: string;
  host: string;
  logLevel: string;
  port: number;
  trustProxy: boolean;
}

export interface RuntimeConfigOptions {
  requireAdminToken?: boolean;
  requireEsiIdentity?: boolean;
}

function parsePort(value = "3004"): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || String(port) !== value.trim() || port <= 0 || port >= 65536) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

export function parseIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && String(parsed) === raw ? parsed : defaultValue;
}

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  return defaultValue;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function backupRetentionDays(): number {
  return clamp(parseIntegerEnv("BACKUP_RETENTION_DAYS", 30), 1, 365);
}

export function esiCacheMaxRows(): number {
  const rows = parseIntegerEnv("ESI_CACHE_MAX_ROWS", 20_000);
  return rows > 0 ? rows : 20_000;
}

export function esiRequestTimeoutMs(): number {
  return clamp(parseIntegerEnv("ESI_REQUEST_TIMEOUT_MS", 30_000), 1_000, 300_000);
}

export function esiFetchConcurrency(): number {
  return clamp(parseIntegerEnv("ESI_FETCH_CONCURRENCY", 15), 1, 50);
}

export function esiFetchAgentConnections(): number {
  return clamp(parseIntegerEnv("ESI_FETCH_AGENT_CONNECTIONS", 50), 1, 200);
}

export function esiFetchAgentPipelining(): number {
  return clamp(parseIntegerEnv("ESI_FETCH_AGENT_PIPELINING", 1), 1, 10);
}

export function computeDebounceMs(): number {
  return clamp(parseIntegerEnv("COMPUTE_DEBOUNCE_MS", 30_000), 0, 300_000);
}

/** Parse a CSV of positive integer region IDs, falling back when empty/blank/all-invalid. */
function parseRegionCsv(raw: string | undefined, fallback: number[]): number[] {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const ids = trimmed
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? ids : fallback;
}

/** The 9 faction-warfare warzone regions (Caldari-Gallente + Amarr-Minmatar). Shared default for
 * both killmail ingest and contract-saturation scanning. The lowsec security filter trims the
 * highsec systems automatically (killmails), so a generous list is fine. */
const WARZONE_REGION_DEFAULTS = [
  10000069, // Black Rise
  10000048, // Placid
  10000064, // Essence
  10000068, // Verge Vendor
  10000033, // The Citadel
  10000030, // Heimatar
  10000042, // Metropolis
  10000036, // Devoid
  10000038 // The Bleak Lands
];

/** Regions whose contract asks feed the BPC / contract-only PRICE rollup
 * (`rebuildContractPrices`). Default: The Forge only — phase 0 measured it covers 98% of types
 * priceable anywhere. Kept SEPARATE from the scan set so the
 * saturation scan can widen into the warzone without polluting contract prices. The legacy
 * `CONTRACT_REGIONS` env is still honored for back-compat. */
export function contractPriceRegions(): number[] {
  return parseRegionCsv(process.env.CONTRACT_PRICE_REGIONS ?? process.env.CONTRACT_REGIONS, [10000002]);
}

/** Master switch for warzone contract-supply scanning (the /fits/ competition check). Off keeps
 * the fetcher scanning only the price regions, decoupling a code deploy from the one-time
 * warzone items backfill. */
export function contractSaturationEnabled(): boolean {
  return parseBooleanEnv("CONTRACT_SATURATION_ENABLED", true);
}

/** Regions scanned for fitted-ship contract SUPPLY (the competition signal on /fits/). Default:
 * the 9 warzone regions, where FW pilots actually rebuy fitted ships. These contracts are
 * recorded and fingerprinted but excluded from the price rollup above. */
export function contractSaturationRegions(): number[] {
  return parseRegionCsv(process.env.CONTRACT_SATURATION_REGIONS, WARZONE_REGION_DEFAULTS);
}

/** Every region the public-contracts fetcher pages: price regions ∪ saturation regions
 * (de-duplicated). Saturation regions drop out when the master switch is off. */
export function contractScanRegions(): number[] {
  const saturation = contractSaturationEnabled() ? contractSaturationRegions() : [];
  return [...new Set([...contractPriceRegions(), ...saturation])];
}

/** Killmail ingestion master switch. Disabled keeps the daily job a no-op without
 * removing its scheduler/CLI wiring. */
export function killmailsEnabled(): boolean {
  return parseBooleanEnv("KILLMAILS_ENABLED", true);
}

/** Region IDs whose lowsec systems are kept by the killmail fetcher. Default: the
 * Caldari-Gallente and Amarr-Minmatar faction-warfare warzone regions. The lowsec
 * security filter trims their highsec systems automatically, so a generous list is fine. */
export function killmailsWarzoneRegions(): number[] {
  return parseRegionCsv(process.env.KILLMAILS_WARZONE_REGIONS, WARZONE_REGION_DEFAULTS);
}

/** How many days back (ending yesterday UTC) the killmail fetcher pulls per run.
 * 1 = just yesterday; larger values warm up history or recover missed days. */
export function killmailsBackfillDays(): number {
  return clamp(parseIntegerEnv("KILLMAILS_BACKFILL_DAYS", 1), 1, 90);
}

export function loadConfig(options: RuntimeConfigOptions = {}): RuntimeConfig {
  const requireAdminToken = options.requireAdminToken ?? false;
  const requireEsiIdentity = options.requireEsiIdentity ?? false;

  const contactEmail = process.env.CONTACT_EMAIL?.trim() ?? "";
  const appUrl = process.env.APP_URL?.trim() ?? "";
  const adminToken = process.env.ADMIN_TOKEN?.trim() ?? "";

  const missing: string[] = [];
  if (requireEsiIdentity && !contactEmail) missing.push("CONTACT_EMAIL");
  if (requireEsiIdentity && !appUrl) missing.push("APP_URL");
  if (requireAdminToken && !adminToken) missing.push("ADMIN_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    adminToken,
    appUrl,
    contactEmail,
    dbPath: path.resolve(rootDir, process.env.DB_PATH ?? "data/lp.db"),
    host: process.env.HOST ?? "0.0.0.0",
    logLevel: process.env.LOG_LEVEL ?? "info",
    port: parsePort(process.env.PORT ?? "3004"),
    trustProxy: process.env.TRUST_PROXY === "1"
  };
}

export function buildUserAgent(config: Pick<RuntimeConfig, "appUrl" | "contactEmail">): string {
  return `lp-calc/0.1 (contact: ${config.contactEmail}) +${config.appUrl}`;
}
