// Small numeric guards shared across the calc paths.

/**
 * Narrowing guard for a strictly-positive finite number. Accepts `unknown` so it
 * serves both callers that already hold a `number` and those holding a
 * `number | null | undefined`; non-numbers (including null/undefined) and
 * non-finite or non-positive values fail the guard.
 */
export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
