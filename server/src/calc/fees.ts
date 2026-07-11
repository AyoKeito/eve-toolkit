export interface FeeParams {
  acc: number;
  bro: number;
  factionStand: number;
  corpStand: number;
}

export interface FeeRates {
  salesTaxRate: number;
  brokerFeeRate: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function feeRates(params: Partial<FeeParams> = {}): FeeRates {
  const accounting = clamp(params.acc ?? 0, 0, 5);
  const brokerRelations = clamp(params.bro ?? 0, 0, 5);
  const factionStanding = clamp(params.factionStand ?? 0, -10, 10);
  const corpStanding = clamp(params.corpStand ?? 0, -10, 10);

  // Tranquility values: sales tax 7.5% base, -11% per Accounting level (3.375% at V);
  // NPC broker fee 3% base, -0.3pp per Broker Relations level, standings shave up to
  // 0.3pp (faction) + 0.2pp (corp), floored at 1%.
  const salesTaxRate = 0.075 * (1 - 0.11 * accounting);
  const brokerFeeRate = Math.max(
    0.03 - 0.003 * brokerRelations - 0.0003 * factionStanding - 0.0002 * corpStanding,
    0.01
  );

  return { salesTaxRate, brokerFeeRate };
}
