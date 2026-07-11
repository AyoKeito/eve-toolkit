/**
 * Null-safe multi-key row extractors shared between fetchers/sde.ts and
 * fetchers/sde-archive.ts.
 *
 * Each helper accepts an ordered `keys` array and returns the value from the
 * first key that is present and non-null in `row`, or a safe fallback (null /
 * empty array / fallback string) when no key matches.
 */

/** Returns the raw value of the first matching key, or undefined. */
export function objectValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

/**
 * Returns a finite float from the first matching key, or null.
 * Accepts both number and string values.
 */
export function numberValue(row: Record<string, unknown>, keys: string[]): number | null {
  const value = objectValue(row, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Returns a truncated integer from the first matching key, or null.
 * Delegates to numberValue so it accepts both number and string values.
 */
export function integerValue(row: Record<string, unknown>, keys: string[]): number | null {
  const value = numberValue(row, keys);
  return value === null ? null : Math.trunc(value);
}

/**
 * Returns a non-empty string from the first matching key, or null.
 * Equivalent to the `metadataString` helper in sde-archive.ts.
 */
export function stringValue(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Returns an array from the first matching key, or [].
 */
export function arrayValue(row: Record<string, unknown>, keys: string[]): unknown[] {
  const value = objectValue(row, keys);
  return Array.isArray(value) ? value : [];
}

/**
 * Resolves a localized name from a string or EN-keyed object, falling back to
 * `fallback` if no usable value is found.
 */
export function localizedName(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const names = value as Record<string, unknown>;
    for (const key of ["en", "en-us", "en_US"]) {
      const name = names[key];
      if (typeof name === "string" && name.trim()) return name;
    }
  }
  return fallback;
}

/**
 * Convenience: resolves a localized name from the first matching key in `row`.
 */
export function rowName(row: Record<string, unknown>, keys: string[], fallback: string): string {
  return localizedName(objectValue(row, keys), fallback);
}
