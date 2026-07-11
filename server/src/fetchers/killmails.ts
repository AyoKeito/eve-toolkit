import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fetch as undiciFetch } from "undici";
import { extract as tarExtract } from "tar-stream";
import bz2 from "unbzip2-stream";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import {
  buildUserAgent,
  killmailsBackfillDays,
  killmailsEnabled,
  killmailsWarzoneRegions,
  loadConfig
} from "../config.js";
import { runFetcher } from "../lib/fetcher.js";
import { sqlPlaceholders } from "../lib/sql.js";

/**
 * Daily lowsec faction-warfare killmail ingestion (docs plan: trending fits).
 *
 * Source: the EVE-Ref daily archive (https://data.everef.net/killmails/), one
 * tar.bz2 per UTC day where each entry is a verbatim copy of the ESI
 * /killmails/{id}/{hash}/ body — so the victim's fit is already included and we
 * never call ESI per kill. We stream-decompress the whole-day global archive and
 * keep only killmails in lowsec systems within the FW warzone regions, then derive
 * a normalized fit fingerprint (hull + fitted modules, ammo/charges excluded) used
 * to rank "trending fits".
 */

const everefBaseUrl = "https://data.everef.net/killmails";

interface EsiKillmailItem {
  item_type_id?: number;
  flag?: number;
  quantity_destroyed?: number;
  quantity_dropped?: number;
  // Nested items live inside containers/ship-bay holds (cargo). Ignored for fits.
  items?: EsiKillmailItem[];
}

interface EsiKillmail {
  killmail_id?: number;
  killmail_time?: string;
  solar_system_id?: number;
  victim?: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    faction_id?: number;
    ship_type_id?: number;
    items?: EsiKillmailItem[];
  };
  attackers?: unknown[];
  // EVE-Ref entries are verbatim ESI bodies (no hash); tolerate a wrapper just in case.
  zkb?: { hash?: string };
}

export interface FitFingerprint {
  fitHash: string;
  /** Sorted, ammo-stripped module list — the buildable shopping list. */
  moduleList: Array<{ type_id: number; qty: number }>;
  /** Total fitted module quantity. */
  moduleCount: number;
}

export interface KillmailsFetchOptions {
  /** Explicit single date (YYYY-MM-DD, UTC) to ingest. Overrides backfill window. */
  date?: string;
  /** Days back ending yesterday UTC. Defaults to KILLMAILS_BACKFILL_DAYS. */
  backfillDays?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof undiciFetch;
}

export interface KillmailsFetchSummary {
  enabled: boolean;
  dates: string[];
  archives_downloaded: number;
  archives_missing: number;
  killmails_scanned: number;
  killmails_kept: number;
  killmails_new: number;
  fits_total: number;
}

/**
 * Inventory flags for fitted module slots: low 11-18, mid 19-26, high 27-34,
 * rig 92-99, subsystem 125-132. Excludes drone bay (87) and cargo (5) by omission.
 */
export function isFittedModuleFlag(flag: number): boolean {
  return (
    (flag >= 11 && flag <= 34) || // low + mid + high (contiguous)
    (flag >= 92 && flag <= 99) || // rigs
    (flag >= 125 && flag <= 132) // subsystems
  );
}

/**
 * Pure fit fingerprint: hull + fitted modules (qty-summed across slots), sorted by
 * type_id, with charges excluded (isCharge). Two kills of the same hull+modules but
 * different loaded ammo therefore hash identically.
 */
/**
 * Canonical fit fingerprint from a hull + an aggregated (type_id -> summed qty) module map.
 * Shared core of both the flag-based killmail path (computeFitHash) and the category-based
 * contract path (server/src/fetchers/esi-contracts.ts), so a clean pre-fit contract and the
 * killmail of the same hull+modules hash IDENTICALLY — that equality is what lets the /fits/
 * competition check match contract supply to trending losses.
 */
export function hashFit(shipTypeId: number, byType: Map<number, number>): FitFingerprint {
  const moduleList = [...byType.entries()]
    .map(([type_id, qty]) => ({ type_id, qty }))
    .sort((a, b) => a.type_id - b.type_id);
  const moduleCount = moduleList.reduce((sum, m) => sum + m.qty, 0);
  const canonical = `${shipTypeId}|${moduleList.map((m) => `${m.type_id}:${m.qty}`).join(",")}`;
  const fitHash = createHash("sha1").update(canonical).digest("hex");
  return { fitHash, moduleList, moduleCount };
}

export function computeFitHash(
  shipTypeId: number,
  items: EsiKillmailItem[],
  isCharge: (typeId: number) => boolean
): FitFingerprint {
  const byType = new Map<number, number>();
  for (const item of items) {
    const typeId = item.item_type_id;
    const flag = item.flag;
    if (typeof typeId !== "number" || typeof flag !== "number") continue;
    if (!isFittedModuleFlag(flag)) continue;
    if (isCharge(typeId)) continue;
    const qty = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
    byType.set(typeId, (byType.get(typeId) ?? 0) + (qty > 0 ? qty : 1));
  }
  return hashFit(shipTypeId, byType);
}

/** UTC YYYY-MM-DD strings to ingest: a window of `backfillDays` ending yesterday. */
export function targetDates(nowMs: number, backfillDays: number): string[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const yesterdayMs = nowMs - dayMs;
  const dates: string[] = [];
  for (let i = backfillDays - 1; i >= 0; i -= 1) {
    dates.push(new Date(yesterdayMs - i * dayMs).toISOString().slice(0, 10));
  }
  return dates;
}

function archiveUrl(date: string): string {
  const year = date.slice(0, 4);
  return `${everefBaseUrl}/${year}/killmails-${date}.tar.bz2`;
}

interface KeptKillmail {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  region_id: number;
  victim_ship_type_id: number | null;
  victim_character_id: number | null;
  victim_corporation_id: number | null;
  victim_alliance_id: number | null;
  victim_faction_id: number | null;
  attacker_count: number;
  hash: string | null;
  fit: FitFingerprint;
}

/** Stream one day's archive, parsing + filtering entries to warzone-lowsec kills. */
async function streamArchive(
  url: string,
  userAgent: string,
  regionForSystem: Map<number, number>,
  isCharge: (typeId: number) => boolean,
  fetchImpl: typeof undiciFetch,
  onScanned: () => void
): Promise<KeptKillmail[] | null> {
  const res = await fetchImpl(url, { headers: { "User-Agent": userAgent } });
  if (res.status === 404) return null; // not published yet / no kills that day
  if (!res.ok || !res.body) {
    throw new Error(`EVE-Ref ${res.status} ${res.statusText} for ${url}`);
  }

  const kept: KeptKillmail[] = [];
  const extract = tarExtract();

  extract.on("entry", (header, stream, next) => {
    if (!header.name.endsWith(".json")) {
      stream.resume();
      stream.on("end", next);
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      onScanned();
      try {
        const km = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EsiKillmail;
        const systemId = km.solar_system_id;
        const killmailId = km.killmail_id;
        if (typeof systemId !== "number" || typeof killmailId !== "number" || !km.killmail_time) {
          return next();
        }
        const regionId = regionForSystem.get(systemId);
        if (regionId === undefined) return next(); // not a warzone-lowsec system
        const victim = km.victim ?? {};
        const fit = computeFitHash(victim.ship_type_id ?? 0, victim.items ?? [], isCharge);
        kept.push({
          killmail_id: killmailId,
          killmail_time: km.killmail_time,
          solar_system_id: systemId,
          region_id: regionId,
          victim_ship_type_id: victim.ship_type_id ?? null,
          victim_character_id: victim.character_id ?? null,
          victim_corporation_id: victim.corporation_id ?? null,
          victim_alliance_id: victim.alliance_id ?? null,
          victim_faction_id: victim.faction_id ?? null,
          attacker_count: Array.isArray(km.attackers) ? km.attackers.length : 0,
          hash: km.zkb?.hash ?? null,
          fit
        });
      } catch {
        // Skip a malformed entry rather than abort the whole day.
      }
      next();
    });
    stream.on("error", next);
  });

  await new Promise<void>((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("error", reject);
    source.pipe(bz2()).on("error", reject).pipe(extract);
  });

  return kept;
}

/** Persist one day's kept killmails. New killmails bump fit counts; re-runs are no-ops. */
function persistDay(db: Db, kept: KeptKillmail[]): number {
  const ingestedAt = nowIso();
  const insertKm = db.prepare(`
    INSERT INTO killmails(
      killmail_id, killmail_time, solar_system_id, region_id, victim_ship_type_id,
      victim_character_id, victim_corporation_id, victim_alliance_id, victim_faction_id,
      attacker_count, fit_hash, hash, ingested_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(killmail_id) DO NOTHING
  `);
  const insertItem = db.prepare(
    "INSERT OR IGNORE INTO killmail_items(killmail_id, flag, type_id, quantity) VALUES (?, ?, ?, ?)"
  );
  const upsertFit = db.prepare(`
    INSERT INTO fits(fit_hash, ship_type_id, module_list_json, module_count, loss_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(fit_hash) DO UPDATE SET
      loss_count = loss_count + 1,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen)
  `);

  let newCount = 0;
  const tx = db.transaction(() => {
    for (const km of kept) {
      const inserted = insertKm.run(
        km.killmail_id,
        km.killmail_time,
        km.solar_system_id,
        km.region_id,
        km.victim_ship_type_id,
        km.victim_character_id,
        km.victim_corporation_id,
        km.victim_alliance_id,
        km.victim_faction_id,
        km.attacker_count,
        km.fit.fitHash,
        km.hash,
        ingestedAt
      ).changes;
      if (inserted === 0) continue; // already ingested — keep idempotent
      newCount += 1;
      for (const m of km.fit.moduleList) {
        insertItem.run(km.killmail_id, 0, m.type_id, m.qty);
      }
      upsertFit.run(
        km.fit.fitHash,
        km.victim_ship_type_id ?? 0,
        JSON.stringify(km.fit.moduleList),
        km.fit.moduleCount,
        km.killmail_time,
        km.killmail_time
      );
    }
  });
  tx();
  return newCount;
}

export async function fetchKillmails(db: Db, options: KillmailsFetchOptions = {}): Promise<KillmailsFetchSummary> {
  return runFetcher(db, "killmails", async () => {
    const summary: KillmailsFetchSummary = {
      enabled: killmailsEnabled(),
      dates: [],
      archives_downloaded: 0,
      archives_missing: 0,
      killmails_scanned: 0,
      killmails_kept: 0,
      killmails_new: 0,
      fits_total: 0
    };

    if (!summary.enabled) {
      summary.fits_total = (db.prepare("SELECT COUNT(*) AS n FROM fits").get() as { n: number }).n;
      return summary;
    }

    const config = loadConfig({ requireEsiIdentity: true });
    const userAgent = buildUserAgent(config);
    const fetchImpl = options.fetchImpl ?? undiciFetch;
    const nowMs = options.nowMs ?? Date.now();
    summary.dates = options.date ? [options.date] : targetDates(nowMs, options.backfillDays ?? killmailsBackfillDays());

    // Warzone-lowsec system -> region lookup, built once. Lowsec = true-sec in (0, 0.45).
    const regions = killmailsWarzoneRegions();
    const placeholders = sqlPlaceholders(regions.length);
    const systemRows = db
      .prepare(
        `SELECT system_id, region_id FROM systems
         WHERE region_id IN (${placeholders}) AND security_status > 0 AND security_status < 0.45`
      )
      .all(...regions) as Array<{ system_id: number; region_id: number }>;
    const regionForSystem = new Map<number, number>(systemRows.map((r) => [r.system_id, r.region_id]));

    const chargeTypeIds = new Set<number>(
      (db.prepare("SELECT type_id FROM types WHERE category_id = 8").all() as Array<{ type_id: number }>).map(
        (r) => r.type_id
      )
    );
    const isCharge = (typeId: number): boolean => chargeTypeIds.has(typeId);

    let lastError: unknown = null;
    for (const date of summary.dates) {
      try {
        const kept = await streamArchive(
          archiveUrl(date),
          userAgent,
          regionForSystem,
          isCharge,
          fetchImpl,
          () => {
            summary.killmails_scanned += 1;
          }
        );
        if (kept === null) {
          summary.archives_missing += 1;
          continue;
        }
        summary.archives_downloaded += 1;
        summary.killmails_kept += kept.length;
        summary.killmails_new += persistDay(db, kept);
      } catch (error) {
        lastError = error;
      }
    }

    // Fail the run only if every requested date failed to download (real outage);
    // a partial miss is left for the hourly catch-up.
    if (lastError !== null && summary.archives_downloaded === 0 && summary.archives_missing === 0) {
      throw lastError;
    }

    summary.fits_total = (db.prepare("SELECT COUNT(*) AS n FROM fits").get() as { n: number }).n;
    return summary;
  });
}
