export type RiskTier = "HIGHSEC" | "LOWSEC" | "NULLSEC" | "WORMHOLE";

const riskRank: Record<RiskTier, number> = {
  HIGHSEC: 0,
  LOWSEC: 1,
  NULLSEC: 2,
  WORMHOLE: 2
};

/**
 * Official boundaries (https://developers.eveonline.com/docs/guides/system-security/):
 * highsec is true security >= 0.45 — the game classifies by the ROUNDED one-decimal value,
 * so 0.45-0.49 systems display 0.5 and are highsec. Lowsec is anything positive below that
 * (sec in (0, 0.05) displays as 0.1, never 0.0); nullsec is <= 0.0 exactly.
 */
export function riskTierFromSecurity(security: number | null | undefined): RiskTier {
  if (security === null || security === undefined || Number.isNaN(security)) return "NULLSEC";
  if (security >= 0.45) return "HIGHSEC";
  if (security > 0) return "LOWSEC";
  return "NULLSEC";
}

export function normalizeRiskTier(tier: RiskTier): RiskTier {
  return tier === "WORMHOLE" ? "NULLSEC" : tier;
}

export function riskAllowed(tier: RiskTier, maxTier: RiskTier): boolean {
  return riskRank[tier] <= riskRank[maxTier];
}

export function leastRiskTier(tiers: RiskTier[]): RiskTier {
  // Empty array: default to safest tier rather than implying NULLSEC access.
  if (tiers.length === 0) return "HIGHSEC";
  return tiers.reduce<RiskTier>(
    (least, tier) => (riskRank[tier] < riskRank[least] ? normalizeRiskTier(tier) : least),
    "NULLSEC"
  );
}
