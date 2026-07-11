/**
 * Manufacturing job installation fee. CCP charges, per industry job:
 *
 *   jobCost = EIV × (systemCostIndex × structureBonus + facilityTax + sccSurcharge)
 *
 * where EIV (Estimated Item Value) = Σ(base material quantity × CCP adjusted_price)
 * over the blueprint's **ME-0 base** quantities — job fees ignore material efficiency.
 *
 * The defaults model the simplest facility the default view assumes: an NPC station
 * (no structure cost-index reduction → structureBonus 1.0; NPC facility tax 0.25%),
 * omega pilot (no 0.25% alpha surcharge). The SCC surcharge (4%) and facility tax are
 * location-independent, so ~4.25% of EIV is fixed no matter where the job runs; only
 * the systemCostIndex slice varies. Manufacturer mode overrides these per facility
 * preset + a user-supplied system cost index.
 */
export interface FacilityParams {
  /** Manufacturing system cost index (0–1), e.g. 0.025 = 2.5%. */
  systemCostIndex: number;
  /** Cost-index multiplier: 1.0 for an NPC station, < 1 inside a structure with role bonuses. */
  structureBonus: number;
}

/** NPC facility tax on the job-cost base (0.25%). */
export const NPC_FACILITY_TAX = 0.0025;
/** SCC surcharge, location-independent (4%). */
export const SCC_SURCHARGE = 0.04;
/** Conservative default system cost index for the non-Manufacturer-mode view. */
export const DEFAULT_SYSTEM_COST_INDEX = 0.025;

/** Default facility: NPC station at the default system cost index. */
export const NPC_FACILITY: FacilityParams = {
  systemCostIndex: DEFAULT_SYSTEM_COST_INDEX,
  structureBonus: 1
};

/** Fraction of EIV charged as the job installation fee for a facility. */
export function jobInstallationRate(facility: FacilityParams = NPC_FACILITY): number {
  return facility.systemCostIndex * facility.structureBonus + NPC_FACILITY_TAX + SCC_SURCHARGE;
}

/** Job installation cost in ISK for a job whose materials carry the given EIV. */
export function jobInstallationCost(eiv: number, facility: FacilityParams = NPC_FACILITY): number {
  if (!(eiv > 0)) return 0;
  return eiv * jobInstallationRate(facility);
}

// ---------------------------------------------------------------------------
// Facility preset — Manufacturer mode. Couples Material Efficiency (material
// savings) with the job-installation facility so a facility never hands out
// cheaper materials without its offsetting install fee.
// ---------------------------------------------------------------------------

/** LP-store BPCs are unresearched (ME 0). Presets model where they get built:
 * an NPC station (no rigs, ME 0) or a structure with a T2 ME rig in high/null sec. */
export type FacilityPreset = "npc" | "highsec-t2" | "null-t2";

// ME reduction compounds the engineering-complex structure role bonus (1%) with a
// T2 ME rig (2.4%) scaled by the security multiplier (highsec ×1.0, null/WH ×2.1).
// Per-material ceil rounding (see manufacture material loop) trims a little off the
// raw multiplier, landing null-T2 near the ~5.8% the cookbook user observed.
const STRUCTURE_ROLE_ME = 0.01;
const T2_RIG_ME = 0.024;
const NULL_SECURITY_MULTIPLIER = 2.1;
const HIGHSEC_SECURITY_MULTIPLIER = 1.0;

function rigMeMult(securityMultiplier: number): number {
  return (1 - STRUCTURE_ROLE_ME) * (1 - T2_RIG_ME * securityMultiplier);
}

export interface Facility {
  preset: FacilityPreset;
  /** Material multiplier Π(1 − bonus); 1.0 = ME 0 (materials unchanged). */
  meMult: number;
  /** Job-installation facility params. */
  cost: FacilityParams;
}

/** Default system cost index expressed as the percent users see in the UI. */
export const DEFAULT_SYSTEM_COST_INDEX_PCT = DEFAULT_SYSTEM_COST_INDEX * 100;

/**
 * Resolves the Manufacturer-mode facility from query params. `facility` selects the
 * preset (default "npc" → ME 0, matching the persisted default-view rows); `costIndex`
 * is the manufacturing system cost index as a PERCENT (0–100, default 2.5). When both
 * are absent this returns exactly the default-view facility, so cached rows stay valid.
 */
export function resolveFacility(params: { facility?: string; costIndex?: number } = {}): Facility {
  const preset: FacilityPreset =
    params.facility === "highsec-t2" || params.facility === "null-t2" ? params.facility : "npc";
  const meMult =
    preset === "highsec-t2"
      ? rigMeMult(HIGHSEC_SECURITY_MULTIPLIER)
      : preset === "null-t2"
        ? rigMeMult(NULL_SECURITY_MULTIPLIER)
        : 1;
  const pct =
    typeof params.costIndex === "number" && Number.isFinite(params.costIndex)
      ? Math.min(Math.max(params.costIndex, 0), 100)
      : DEFAULT_SYSTEM_COST_INDEX_PCT;
  return { preset, meMult, cost: { systemCostIndex: pct / 100, structureBonus: 1 } };
}
