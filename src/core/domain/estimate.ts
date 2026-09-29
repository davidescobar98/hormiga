import type { Cents } from '../../shared/money';
import { daysBetween, type IsoDate } from '../../shared/dates';
import { paymentDate } from './loans';

export interface BaseValuation {
  date: IsoDate;
  valueCents: Cents;
  contributedCents: Cents | null;
}

/**
 * Estimated value on `date` from the last real valuation, growing at an annual rate (TAE for accounts/deposits, an
 * assumed return for funds and stocks) and adding a monthly contribution on each monthly anniversary of the base date.
 * Growth between two dates is (1 + rate)^(days / 365). Rounded to the cent once, at the end (no drift).
 */
export function projectValue(base: BaseValuation, annualRateBp: number, monthlyContributionCents: Cents, date: IsoDate): { valueCents: Cents; contributedCents: Cents | null } {
  if (date <= base.date) return { valueCents: base.valueCents, contributedCents: base.contributedCents };
  const growth = (from: IsoDate, to: IsoDate) => Math.pow(1 + annualRateBp / 10000, daysBetween(from, to) / 365);
  let value = base.valueCents;
  let contributed = base.contributedCents;
  let cursor = base.date;
  for (let k = 1; k <= 1200; k++) {
    const next = paymentDate(base.date, k);
    if (next > date) break;
    value = value * growth(cursor, next) + monthlyContributionCents;
    if (contributed !== null) contributed += monthlyContributionCents;
    cursor = next;
  }
  return { valueCents: Math.max(0, Math.round(value * growth(cursor, date))), contributedCents: contributed };
}
