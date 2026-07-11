import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { isEsiClientError, createEsiClient } from "../lib/esi.js";
import { runFetcher } from "../lib/fetcher.js";
import { median } from "../lib/stats.js";
import { referencedTypeIds } from "./esi-prices.js";

interface HistoryDay {
  average: number;
  date: string;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

const HISTORY_WINDOW_DAYS = 28;

/** ISO calendar date (YYYY-MM-DD) `days` days before `dateStr`, in UTC. */
function isoDateDaysBefore(dateStr: string, days: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function fetchHistory(db: Db, limit?: number): Promise<number> {
  const esi = createEsiClient(db);
  const typeIds = referencedTypeIds(db).slice(0, limit ?? Number.POSITIVE_INFINITY);
  const upsert = db.prepare(`
    INSERT INTO history(type_id, avg_daily_volume_28d, median_price_28d, max_price_28d, days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      avg_daily_volume_28d=excluded.avg_daily_volume_28d,
      median_price_28d=excluded.median_price_28d,
      max_price_28d=excluded.max_price_28d,
      days=excluded.days,
      updated_at=excluded.updated_at
  `);

  const nowTs = nowIso();
  let count = 0;
  return runFetcher(db, "esi-history", async () => {
    for (const typeId of typeIds) {
      let history: HistoryDay[];
      try {
        history = await esi.getJson<HistoryDay[]>(
          `/latest/markets/10000002/history/?datasource=tranquility&type_id=${typeId}`
        );
      } catch (error) {
        if (isEsiClientError(error, 400, 404)) continue;
        throw error;
      }
      // ESI market history omits zero-volume days, so the 28 most recent *records* can span many
      // months for a thin item. Window by the last 28 CALENDAR days (ending at the newest record)
      // and divide summed volume by the full 28-day window, so avg_daily_volume_28d is a true
      // per-calendar-day rate — not volume-per-trading-day, which overstated liquidity by
      // (span_days / trading_days) and corrupted the minVolume filter, fill estimates, and the
      // LOW_VOLUME / SLOW_FILL warnings.
      const sorted = history.slice().sort((a, b) => b.date.localeCompare(a.date));
      const newest = sorted[0]?.date;
      const windowStart = newest ? isoDateDaysBefore(newest, HISTORY_WINDOW_DAYS - 1) : null;
      const windowed = windowStart ? sorted.filter((day) => day.date >= windowStart) : [];
      const avgVolume =
        windowed.length > 0 ? windowed.reduce((sum, day) => sum + day.volume, 0) / HISTORY_WINDOW_DAYS : null;
      const medianPrice = median(windowed.map((day) => day.average).filter((value) => value > 0));
      const finiteAverages = windowed.map((day) => day.average).filter((value) => Number.isFinite(value));
      const maxPrice = finiteAverages.length > 0 ? Math.max(...finiteAverages) : null;
      upsert.run(typeId, avgVolume, medianPrice, maxPrice, windowed.length, nowTs);
      count += 1;
    }
    return count;
  });
}
