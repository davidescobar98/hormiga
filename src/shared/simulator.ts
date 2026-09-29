/**
 * Compound-growth simulator (educational). Every rate is an assumption entered by the user; nothing here is a
 * forecast or a product recommendation. Pure and dependency-free so the UI can recalculate instantly.
 *
 * Model (monthly steps): value ← value × (1 + r_m) + contribution, with r_m = (1 + annual)^(1/12) − 1.
 * Contributions happen at the end of each month. Values are rounded to the cent at every step.
 * Real value = nominal value / (1 + inflation)^(years elapsed).
 */

export interface SimulationInput {
  initialCents: number;
  monthlyCents: number;
  /** Assumed annual return in basis points (5 % = 500). May be 0 or negative. */
  annualRateBp: number;
  years: number;
  /** Assumed annual inflation in basis points (for the "today's euros" line). */
  inflationBp: number;
  /** Yearly increase of the monthly contribution, in basis points (e.g. salary growth). */
  contributionGrowthBp?: number;
}

export interface SimulationPoint {
  year: number;
  contributedCents: number;
  valueCents: number;
  realValueCents: number;
  growthCents: number;
}

export interface SimulationResult {
  points: SimulationPoint[];
  final: SimulationPoint;
  monthlyRate: number;
}

export const MAX_YEARS = 60;

export function monthlyRate(annualRateBp: number): number {
  return Math.pow(1 + annualRateBp / 10000, 1 / 12) - 1;
}

export function simulate(input: SimulationInput): SimulationResult {
  const years = Math.max(0, Math.min(MAX_YEARS, Math.floor(input.years)));
  const r = monthlyRate(input.annualRateBp);
  let value = Math.max(0, Math.round(input.initialCents));
  let contributed = value;
  let monthly = Math.max(0, Math.round(input.monthlyCents));
  const points: SimulationPoint[] = [point(0, contributed, value, 0)];
  for (let y = 1; y <= years; y++) {
    for (let m = 0; m < 12; m++) {
      value = Math.round(value * (1 + r)) + monthly;
      contributed += monthly;
    }
    points.push(point(y, contributed, value, deflate(value, input.inflationBp, y)));
    if (input.contributionGrowthBp) monthly = Math.round(monthly * (1 + input.contributionGrowthBp / 10000));
  }
  points[0]!.realValueCents = points[0]!.valueCents;
  return { points, final: points[points.length - 1]!, monthlyRate: r };
}

function point(year: number, contributed: number, value: number, real: number): SimulationPoint {
  return { year, contributedCents: contributed, valueCents: value, realValueCents: real, growthCents: value - contributed };
}

function deflate(value: number, inflationBp: number, years: number): number {
  return Math.round(value / Math.pow(1 + inflationBp / 10000, years));
}

/** Months needed to reach a target with the same model; null if it is not reached within MAX_YEARS. */
export function monthsToTarget(targetCents: number, initialCents: number, monthlyCents: number, annualRateBp: number): number | null {
  if (initialCents >= targetCents) return 0;
  const r = monthlyRate(annualRateBp);
  let value = Math.max(0, Math.round(initialCents));
  for (let m = 1; m <= MAX_YEARS * 12; m++) {
    value = Math.round(value * (1 + r)) + Math.round(monthlyCents);
    if (value >= targetCents) return m;
  }
  return null;
}
