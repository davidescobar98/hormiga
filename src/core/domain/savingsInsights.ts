import type { Cents } from '../../shared/money';
import { ratioBp } from '../../shared/money';
import type { IsoDate, YearMonth } from '../../shared/dates';
import type { MonthSummary, RecurringDTO, SavingsInsights } from '../../shared/types';

export interface InsightInputs {
  month: YearMonth;
  summary: MonthSummary;
  /** Net spending of the month by kind of category. */
  essentialCents: Cents;
  discretionaryCents: Cents;
  neutralCents: Cents;
  /** Part of the neutral spending that went to other people (Bizum and transfers). */
  peopleCents: Cents;
  /** Money moved to your other accounts in the month (kept as liquidity, not spending). */
  movedToOwnCents: Cents;
  /** Summaries of every month of the reference month's year up to it (only months with data are used). */
  yearSummaries: MonthSummary[];
  /** Active recurring payments with their next date. */
  recurring: RecurringDTO[];
  today: IsoDate;
  horizonDays: number;
}

const add = (d: IsoDate, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * Explainable savings insights from the user's own data. The 50/30/20 split is only a widely used reference for
 * orientation (needs / wants / savings), never a rule the user must follow.
 */
export function buildSavingsInsights(i: InsightInputs): SavingsInsights {
  const income = i.summary.incomeCents;
  const other = Math.max(0, i.neutralCents - i.peopleCents);
  const flow = {
    incomeCents: income,
    essentialCents: i.essentialCents,
    discretionaryCents: i.discretionaryCents,
    peopleCents: i.peopleCents,
    otherCents: other,
    savingsCents: i.summary.savingsCents,
    movedToOwnCents: i.movedToOwnCents,
  };
  const benchmark = income > 0
    ? {
        needsBp: ratioBp(i.essentialCents, income) ?? 0,
        wantsBp: ratioBp(i.discretionaryCents + i.peopleCents + other, income) ?? 0,
        savingsBp: ratioBp(i.summary.savingsCents, income) ?? 0,
      }
    : null;

  const withData = i.yearSummaries.filter((s) => s.hasData && s.incomeCents > 0);
  const saved = withData.reduce((t, s) => t + s.savingsCents, 0);
  const avg = withData.length ? Math.round(saved / withData.length) : 0;
  const lastMonthNumber = Number(i.month.slice(5, 7));
  const withGoal = withData.filter((s) => s.goal);
  const met = withGoal.filter((s) => s.goal!.status !== 'below');
  let streak = 0;
  for (const s of [...withData].reverse()) {
    if (s.goal && s.goal.status !== 'below') streak++;
    else break;
  }
  const sorted = [...withData].sort((a, b) => b.savingsCents - a.savingsCents);
  const year = {
    year: Number(i.month.slice(0, 4)),
    savedCents: saved,
    months: withData.length,
    avgMonthlyCents: avg,
    projectedCents: withData.length ? saved + avg * (12 - lastMonthNumber) : null,
    monthsWithGoal: withGoal.length,
    monthsGoalMet: met.length,
    streak,
    best: sorted[0] ? { month: sorted[0].month, cents: sorted[0].savingsCents } : null,
    worst: sorted.length > 1 ? { month: sorted.at(-1)!.month, cents: sorted.at(-1)!.savingsCents } : null,
  };

  const until = add(i.today, i.horizonDays);
  const upcoming = i.recurring
    .filter((r) => r.nextDate >= i.today && r.nextDate <= until)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .map((r) => ({ name: r.merchantName, date: r.nextDate, amountCents: r.averageCents, frequency: r.frequency }));
  const reserve = i.recurring.filter((r) => r.frequency !== 'monthly' && r.frequency !== 'weekly');
  return {
    month: i.month,
    flow,
    benchmark,
    year,
    upcoming,
    upcomingTotalCents: upcoming.reduce((t, u) => t + u.amountCents, 0),
    nonMonthly: reserve.map((r) => ({ name: r.merchantName, annualCents: r.annualCents, nextDate: r.nextDate, frequency: r.frequency })),
    nonMonthlyReserveCents: Math.round(reserve.reduce((t, r) => t + r.annualCents, 0) / 12),
  };
}
