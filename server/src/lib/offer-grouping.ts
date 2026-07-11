/**
 * Shared store-option deduplication helper used by calc/ratio.ts and
 * lib/response-materialize.ts.  The generic constraint is intentionally
 * minimal so the function works with both OfferCalc-derived StoreOption
 * objects and OfferSummary["store_options"] elements.
 */
export function uniqueStoreOptionsByCorpId<T extends { corp_id: number; corp_name: string }>(
  options: T[]
): T[] {
  const byCorp = new Map<number, T>();
  for (const option of options) {
    if (!byCorp.has(option.corp_id)) byCorp.set(option.corp_id, option);
  }
  return [...byCorp.values()].sort((a, b) => a.corp_name.localeCompare(b.corp_name));
}
