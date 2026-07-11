import type { OrderLevel } from "./depth.js";
import { isPositiveFinite } from "./num.js";

// theta: only taker-buys consume the sell book, and ESI daily volume mixes both
// trade directions with no public split — 0.5 is the symmetric prior.
export const fillTheta = 0.5;
// A fill a week out keeps ~37% of the patient premium.
export const fillHorizonDays = 7;
// Assumed undercut cadence until persisted order ages justify a measured value.
export const relistIntervalDays = 2;
export const relistDiscountBase = 0.5;
export const relistDiscountPerLevel = 0.06;
export const maxAdvancedBrokerRelations = 5;

export interface FillEstimate {
  daysToFill: number | null;
  queueAhead: number;
  sellRatePerDay: number | null;
}

export const emptyFillEstimate: FillEstimate = {
  daysToFill: null,
  queueAhead: 0,
  sellRatePerDay: null
};

/**
 * Days for `qty` units plus the `queueAhead` already listed ahead of them to
 * clear at the sell-side share (theta) of `avgVol` daily volume. Null when
 * there is no volume to consume the queue (mirrors the callers' `> 0` guard, so
 * a non-positive or non-numeric avgVol yields null rather than an infinite fill).
 */
export function queueFillDays(queueAhead: number, qty: number, avgVol: number | null): number | null {
  if (avgVol === null || !(avgVol > 0)) return null;
  return (queueAhead + qty) / (fillTheta * avgVol);
}

/**
 * Days for a sell listing to fill assuming the lister joins the book at the
 * walked prices: everything already listed at or below the volume-weighted
 * list price fills first, and only the sell-side share of daily volume
 * (theta) consumes the queue. Null when there is no volume or no list price.
 */
export function estimateDaysToFill(
  sellBook: OrderLevel[],
  listPrice: number,
  quantity: number,
  avgDailyVolume28d: number | null
): FillEstimate {
  // tolerate float drift between the walk's average price and book levels
  const priceCeiling = listPrice * (1 + 1e-9);
  let queueAhead = 0;
  for (const level of sellBook) {
    if (!isPositiveFinite(level.price) || !isPositiveFinite(level.qty)) continue;
    if (level.qty >= Number.MAX_SAFE_INTEGER) continue; // synthetic fallback level
    if (level.price <= priceCeiling) queueAhead += level.qty;
  }

  const sellRatePerDay = isPositiveFinite(avgDailyVolume28d) ? fillTheta * avgDailyVolume28d : null;
  const daysToFill =
    sellRatePerDay !== null && isPositiveFinite(listPrice) && isPositiveFinite(quantity)
      ? queueFillDays(queueAhead, quantity, avgDailyVolume28d)
      : null;

  return { daysToFill, queueAhead, sellRatePerDay };
}

/** Relist discount: 50% base, +6pp per Advanced Broker Relations level (80% at V). */
export function relistDiscount(advancedBrokerRelations: number): number {
  const level = Math.min(maxAdvancedBrokerRelations, Math.max(0, advancedBrokerRelations));
  return relistDiscountBase + relistDiscountPerLevel * level;
}

/** Relists needed to stay listed for the full fill, one per interval after the first listing. */
export function expectedRelists(daysToFill: number): number {
  if (!Number.isFinite(daysToFill) || daysToFill <= 0) return 0;
  return Math.max(0, Math.ceil(daysToFill / relistIntervalDays) - 1);
}

/**
 * Effective patient profit: exponential decay from the patient premium toward
 * the guaranteed instant cashout as the estimated fill stretches out.
 */
export function effectivePatientNet(netInstant: number, netPatientAdjusted: number, daysToFill: number): number {
  return netInstant + (netPatientAdjusted - netInstant) * Math.exp(-daysToFill / fillHorizonDays);
}
