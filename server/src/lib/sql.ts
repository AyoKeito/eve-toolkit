// Small SQL-building helpers shared across the API handlers and fetchers, so the
// `?,?,?` placeholder idiom, the SQLite variable-limit chunk size, and the
// group-by-into-a-map pattern each live in exactly one place.

/** A `?,?,?` placeholder list of `count` bind parameters for an `IN (...)` clause. */
export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * Split `items` into chunks of at most `size` (default 900, comfortably under
 * SQLite's 999 bound-variable limit) so a large `IN (...)` query can be issued in
 * batches without tripping SQLITE_MAX_VARIABLE_NUMBER.
 */
export function chunk<T>(items: readonly T[], size = 900): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Append `value` to the list stored at `key`, creating the list on first use. */
export function pushToMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
