import type { Cents } from '../../shared/money';
import { daysInMonth, parseYearMonth, type IsoDate, type YearMonth } from '../../shared/dates';
import type { BudgetLine, BudgetStatus } from '../../shared/types';

export const BUDGET_WARNING_BP = 8000;

/** Suggested monthly budget: average of the last complete months, rounded up to 10 €. Null without history. */
export function suggestBudget(monthly: Cents[]): Cents | null {
  const withData = monthly.filter((v) => v > 0);
  if (!withData.length) return null;
  const avg = withData.reduce((t, v) => t + v, 0) / monthly.length;
  return Math.max(1000, Math.ceil(avg / 1000) * 1000);
}

/**
 * Status of one category budget for a month. For the current month the end-of-month figure is projected linearly
 * from the days elapsed (an estimate, clearly labelled as such in the UI).
 */
export function budgetLine(input: {
  categoryId: number;
  name: string;
  color: string;
  limitCents: Cents;
  spentCents: Cents;
  month: YearMonth;
  today: IsoDate;
  suggestedCents: Cents | null;
  averageCents: Cents | null;
}): BudgetLine {
  const { y, m } = parseYearMonth(input.month);
  const total = daysInMonth(y, m);
  const current = input.today.slice(0, 7) === input.month;
  const elapsed = current ? Math.max(1, Number(input.today.slice(8, 10))) : total;
  const projected = current ? Math.round((input.spentCents * total) / elapsed) : input.spentCents;
  const usedBp = input.limitCents > 0 ? Math.round((input.spentCents * 10000) / input.limitCents) : 0;
  let status: BudgetStatus = 'ok';
  if (input.spentCents > input.limitCents) status = 'over';
  else if (usedBp >= BUDGET_WARNING_BP) status = 'warning';
  else if (current && projected > input.limitCents) status = 'at_risk';
  return {
    categoryId: input.categoryId,
    name: input.name,
    color: input.color,
    limitCents: input.limitCents,
    spentCents: input.spentCents,
    remainingCents: input.limitCents - input.spentCents,
    usedBp,
    projectedCents: projected,
    status,
    suggestedCents: input.suggestedCents,
    averageCents: input.averageCents,
    daysLeft: current ? total - elapsed : 0,
  };
}
