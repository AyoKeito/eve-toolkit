import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { createEsiClient } from "../lib/esi.js";
import { runFetcher } from "../lib/fetcher.js";

export interface AdjustedPriceRow {
  type_id: number;
  adjusted_price?: number;
  average_price?: number;
}

/**
 * Upserts CCP reference prices, filtered to types present in the local SDE so the
 * adjusted_prices → types foreign key holds (markets/prices returns ~50k rows,
 * many for types we never import). Missing prices coalesce to null rather than
 * being dropped, so a later EIV lookup sees the row and can fall back explicitly.
 * Returns the number of rows written. Exported for unit testing without network.
 */
export function persistAdjustedPrices(db: Db, rows: AdjustedPriceRow[], updatedAt: string): number {
  const known = new Set(
    (db.prepare("SELECT type_id FROM types").all() as Array<{ type_id: number }>).map((row) => row.type_id)
  );
  const upsert = db.prepare(`
    INSERT INTO adjusted_prices(type_id, adjusted_price, average_price, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(type_id) DO UPDATE SET
      adjusted_price=excluded.adjusted_price,
      average_price=excluded.average_price,
      updated_at=excluded.updated_at
  `);
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!known.has(row.type_id)) continue;
      upsert.run(row.type_id, row.adjusted_price ?? null, row.average_price ?? null, updatedAt);
      count += 1;
    }
  });
  tx();
  return count;
}

/**
 * Fetches CCP's daily reference prices from ESI /markets/prices/ — a single bulk
 * page (no x-pages) — and stores adjusted_price/average_price per type. The bulk
 * body honours ESI's own ~1h cache; the dedicated table lets job cost refresh on a
 * daily cadence independent of the order-book fetch.
 */
export async function fetchAdjustedPrices(db: Db): Promise<number> {
  const esi = createEsiClient(db);
  return runFetcher(db, "esi-adjusted-prices", async () => {
    const rows = await esi.getJson<AdjustedPriceRow[]>("/latest/markets/prices/?datasource=tranquility");
    return persistAdjustedPrices(db, rows, nowIso());
  });
}
