import { queueFillDays } from "./fill.js";

export type FlagSeverity = "warn" | "strong";

export interface QualityFlag {
  code:
    | "LOW_VOLUME"
    | "SLOW_FILL"
    | "THIN_BOOK"
    | "WIDE_SPREAD"
    | "PRICE_SPIKE"
    | "BUY_SPIKE"
    | "OFF_HUB"
    | "NO_HISTORY"
    | "INSUFFICIENT_DEPTH"
    | "CONTRACT_PRICED"
    | "NICHE_DEMAND";
  severity: FlagSeverity;
  message: string;
}

export interface FlagInputs {
  productQty: number;
  avgDailyVolume28d: number | null;
  historyDays: number;
  medianPrice28d: number | null;
  sellMin: number | null;
  buyMax: number | null;
  sellOrderCount: number;
  sellTopQtyShare: number | null;
  sellMinAtJita44: boolean;
  insufficientDepth: boolean;
  /**
   * Sell-book units listed at or below the leg's walked list price. Set only
   * for the output leg, where SLOW_FILL becomes queue-aware: the queue plus
   * the own quantity fills at the sell-side share (theta) of daily volume.
   * Cost legs leave it unset and keep the plain quantity-vs-volume rule.
   */
  queueAheadQty?: number | null;
}

// liquidity floor: a unit threshold alone misflags expensive items (20 implants/day
// at 500m each is liquid) and passes cheap junk, so an ISK-denominated floor gates it
const lowVolumeUnitThreshold = 100;
const lowVolumeIskThreshold = 250_000_000;
const slowFillWarnDays = 7;
const slowFillStrongDays = 28;
const buySpikeMedianMultiple = 1.5;

export function qualityFlags(inputs: FlagInputs): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const avgVolume = inputs.avgDailyVolume28d ?? 0;
  const medianPrice = inputs.medianPrice28d ?? 0;

  if (avgVolume < lowVolumeUnitThreshold && avgVolume * medianPrice < lowVolumeIskThreshold) {
    flags.push({
      code: "LOW_VOLUME",
      severity: "warn",
      message: "28d average daily volume is below 100 units and 250m ISK."
    });
  }

  const queueAware = typeof inputs.queueAheadQty === "number" && Number.isFinite(inputs.queueAheadQty);
  const fillDays = queueAware
    ? queueFillDays(inputs.queueAheadQty as number, inputs.productQty, avgVolume)
    : avgVolume > 0
      ? inputs.productQty / avgVolume
      : null;
  if (fillDays !== null && fillDays > slowFillWarnDays) {
    const strong = fillDays > slowFillStrongDays;
    flags.push({
      code: "SLOW_FILL",
      severity: strong ? "strong" : "warn",
      message: queueAware
        ? strong
          ? "Estimated sell-order fill exceeds 28 days (queue ahead plus quantity vs sell-side volume)."
          : "Estimated sell-order fill exceeds 7 days (queue ahead plus quantity vs sell-side volume)."
        : strong
          ? "Requested quantity exceeds 28 days of market volume."
          : "Requested quantity exceeds 7 days of market volume."
    });
  }

  if (inputs.sellOrderCount <= 2 || (inputs.sellTopQtyShare ?? 0) > 0.8) {
    flags.push({
      code: "THIN_BOOK",
      severity: "warn",
      message: "Sell book is concentrated in very few orders."
    });
  }

  if ((inputs.buyMax ?? 0) > 0 && (inputs.sellMin ?? 0) > 0) {
    const spread = ((inputs.sellMin ?? 0) - (inputs.buyMax ?? 0)) / (inputs.buyMax ?? 1);
    if (spread > 0.5) {
      flags.push({
        code: "WIDE_SPREAD",
        severity: "warn",
        message: "Sell/buy spread is above 50%."
      });
    }
  }

  if ((inputs.sellMin ?? 0) > 0 && medianPrice > 0 && (inputs.sellMin ?? 0) > 2 * medianPrice) {
    flags.push({
      code: "PRICE_SPIKE",
      severity: "strong",
      message: "Current sell minimum is more than twice the 28d median."
    });
  }

  // a seeded buy wall inflates the instant (buy-order) valuation; buy maxima
  // normally sit below the recent median, so well above it reads as manipulation
  if ((inputs.buyMax ?? 0) > 0 && medianPrice > 0 && (inputs.buyMax ?? 0) > buySpikeMedianMultiple * medianPrice) {
    flags.push({
      code: "BUY_SPIKE",
      severity: "strong",
      message: "Current buy maximum is more than 1.5x the 28d median."
    });
  }

  if (!inputs.sellMinAtJita44) {
    flags.push({
      code: "OFF_HUB",
      severity: "warn",
      message: "Cheapest sell order is not at Jita 4-4."
    });
  }

  if (inputs.historyDays < 7) {
    flags.push({
      code: "NO_HISTORY",
      severity: "warn",
      message: "Market history has fewer than seven days."
    });
  }

  if (inputs.insufficientDepth) {
    flags.push({
      code: "INSUFFICIENT_DEPTH",
      severity: "strong",
      message: "Persisted order-book depth does not cover the requested fill."
    });
  }

  return flags;
}

export function countFlags(flags: QualityFlag[]): { warn: number; strong: number } {
  let warn = 0;
  let strong = 0;
  for (const flag of flags) {
    // NICHE_DEMAND only ever rides along with CONTRACT_PRICED, annotating the
    // same contract-only sales channel with demand math. Counting both would
    // make every such pair suspicious-by-construction and bury the rows the
    // BPC filter just opted into.
    if (flag.code === "NICHE_DEMAND") continue;
    if (flag.severity === "warn") warn++;
    else if (flag.severity === "strong") strong++;
  }
  return { warn, strong };
}

export function suspicious(flags: QualityFlag[]): boolean {
  const { warn, strong } = countFlags(flags);
  return strong >= 1 || warn >= 2;
}
