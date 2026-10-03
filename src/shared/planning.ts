import type { Cents } from './money';

/** Savings accumulated month by month at a fixed monthly amount. */
export function accumulate(startCents: Cents, monthlyCents: Cents, months: number): Cents[] {
  return Array.from({ length: months }, (_, i) => startCents + monthlyCents * (i + 1));
}

/** Months needed to save `remainingCents` at `monthlyCents` per month (0 if done, null if it never happens). */
export function monthsToReach(remainingCents: Cents, monthlyCents: Cents): number | null {
  if (remainingCents <= 0) return 0;
  if (monthlyCents <= 0) return null;
  return Math.ceil(remainingCents / monthlyCents);
}
