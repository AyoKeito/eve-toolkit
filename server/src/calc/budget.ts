export interface BudgetParams {
  runs: number;
  lpBudget?: number;
  iskBudget?: number;
}

export function effectiveRuns(lpCostPerRun: number, capitalPerRun: number, params: Partial<BudgetParams>): number {
  const requestedRuns = Math.max(1, Math.floor(params.runs ?? 1));
  const lpBudget = params.lpBudget;
  const iskBudget = params.iskBudget;
  if (lpBudget === undefined && iskBudget === undefined) return requestedRuns;

  let maxRuns = Number.POSITIVE_INFINITY;
  if (lpBudget !== undefined) {
    maxRuns = Math.min(maxRuns, Math.floor(Math.max(0, lpBudget) / Math.max(lpCostPerRun, 1)));
  }
  if (iskBudget !== undefined && capitalPerRun > 0) {
    maxRuns = Math.min(maxRuns, Math.floor(Math.max(0, iskBudget) / capitalPerRun));
  }
  if (!Number.isFinite(maxRuns)) return requestedRuns;
  return Math.max(0, maxRuns);
}
