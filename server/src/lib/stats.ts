// Numeric helpers shared by the price/history stats paths.

/**
 * Median of `values`, or null when the list is empty. Sorts a copy ascending so
 * the caller's array is left untouched. Callers that can prove a non-empty input
 * (e.g. a `>= 2` survivor count) may assert the result with `!`.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
