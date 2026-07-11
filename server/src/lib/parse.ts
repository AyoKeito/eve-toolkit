/**
 * Shared strict integer parsers for route parameter and query string validation.
 */

/**
 * Extract a message string from an unknown caught value.
 * Returns `error.message` for Error instances, `String(error)` otherwise.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a raw string as a strict integer.
 * Returns null if the value is undefined, empty, non-integer, or has trailing
 * non-numeric characters (e.g. "5abc" → null, "5" → 5, " 5 " → 5).
 */
export function parseInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && String(parsed) === trimmed ? parsed : null;
}

/**
 * Like `parseInteger` but also returns null for negative numbers.
 */
export function parseNonNegativeInteger(raw: string | undefined): number | null {
  const parsed = parseInteger(raw);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
