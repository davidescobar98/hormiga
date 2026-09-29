import { describe, expect, it } from 'vitest';
import { generateMoreRecommendations, type MoreContext } from '../../src/core/domain/moreRecommendations';
import { buildSavingsInsights } from '../../src/core/domain/savingsInsights';
import { DEFAULT_PROFILE } from '../../src/core/db/settingsRepo';
import type { MonthSummary, RecurringDTO } from '../../src/shared/types';

const summary = (month: string, income: number, spending: number, goal: 'above' | 'below' | null = null): MonthSummary => ({
  month, incomeCents: income, incomeSource: '', grossExpensesCents: spending, refundsCents: 0, spendingCents: spending, savingsCents: income - spending,
  savingsRateBp: income > 0 ? Math.round(((income - spending) * 10000) / income) : null, fixedCents: 0, variableCents: spending, discretionaryCents: 0,
  txCount: 10, hasData: true, goal: goal ? { targetCents: 30000, differenceCents: 0, progressBp: 10000, status: goal, description: '' } : null,
});
const sub = (name: string, monthly: number, extra: Partial<RecurringDTO> = {}): RecurringDTO => ({
  id: 1, merchantId: name.length, merchantName: name, categoryId: 1, categoryName: 'Suscripciones', status: 'confirmed', frequency: 'monthly', kind: 'subscription',
  averageCents: monthly, lastDate: '2026-09-01', nextDate: '2026-10-01', occurrences: 6, monthlyCents: monthly, annualCents: monthly * 12, confidenceBp: 9000, reason: '', ...extra,
});

function base(over: Partial<MoreContext> = {}): MoreContext {
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  return {
    referenceMonth: '2026-09',
    today: '2026-09-30',
    summaries: new Map(months.map((m) => [m, summary(m, 250000, 200000)])),
    profile: DEFAULT_PROFILE,
    essentialMonthlyCents: 100000,
    recommendedEmergencyMonths: 3,
    recommendedEmergencyReason: 'base de 3 meses',
    emergencyPotCents: 0,
    currentAccountsCents: null,
    savingsAccountsCents: null,
    activeRecurring: [],
    priceIncreases: [],
    peopleByMonth: new Map(),
    pendingTransferReviews: 0,
    cashByMonth: new Map(),
    pots: [],
    loans: [],
    illustrativeRateBp: 200,
    ...over,
  };
}
const types = (ctx: MoreContext) => generateMoreRecommendations(ctx).map((r) => r.type);

describe('wider savings suggestions', () => {
  it('emergency gap uses the profile target and the money in accounts', () => {
    const r = generateMoreRecommendations(base({ currentAccountsCents: 150000, savingsAccountsCents: 0, recommendedEmergencyMonths: 6 }));
    const e = r.find((x) => x.type === 'emergency_gap')!;
    expect(e.title).toMatch(/1,5 meses; para ti conviene 6/);
    expect(e.description).toMatch(/Te faltan 4\.500,00/);
    expect(types(base({ currentAccountsCents: 150000, savingsAccountsCents: 300000 }))).not.toContain('emergency_gap');
  });

  it('idle money in current accounts beyond one month and the cushion', () => {
    const r = generateMoreRecommendations(base({ currentAccountsCents: 1500000, savingsAccountsCents: 300000 }));
    const idle = r.find((x) => x.type === 'idle_cash')!;
    expect(idle.description).toMatch(/sobran 14\.000,00/);
    expect(idle.estimatedMonthlyImpactCents).toBe(Math.round((1400000 * 200) / 10000 / 12));
    expect(types(base({ currentAccountsCents: 350000, savingsAccountsCents: 0 }))).not.toContain('idle_cash');
  });

  it('overlapping video platforms, price increases and upcoming annual payments', () => {
    const ctx = base({
      activeRecurring: [sub('Netflix', 1399), sub('HBO Max', 999), sub('Disney+', 899), sub('Seguro hogar', 30000, { kind: 'fixed', frequency: 'annual', nextDate: '2026-10-20', monthlyCents: 2500, annualCents: 30000 })],
      priceIncreases: [{ name: 'Netflix', previousCents: 1299, currentCents: 1399, date: '2026-09-01' }],
    });
    const t = types(ctx);
    expect(t).toEqual(expect.arrayContaining(['overlapping_subscriptions', 'price_increase', 'upcoming_payments']));
  });

  it('transfers to people, pending reviews, lifestyle inflation, cash and expensive debt', () => {
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const ctx = base({
      summaries: new Map(months.map((m, i) => [m, i < 3 ? summary(m, 200000, 150000) : summary(m, 230000, 185000)])),
      peopleByMonth: new Map([['2026-09', { cents: 40000, count: 6 }]]),
      pendingTransferReviews: 2,
      cashByMonth: new Map([['2026-09', 30000]]),
      currentAccountsCents: 1000000,
      savingsAccountsCents: 300000,
      loans: [{ name: 'Préstamo coche', annualRateBp: 695, outstandingCents: 800000, interestSavedCents: (a) => Math.round(a * 0.1) }],
    });
    const r = generateMoreRecommendations(ctx);
    expect(r.map((x) => x.type)).toEqual(expect.arrayContaining(['people_transfers', 'pending_transfers', 'lifestyle_inflation', 'cash_withdrawals', 'expensive_debt']));
    expect(r.find((x) => x.type === 'expensive_debt')!.title).toMatch(/Amortizar 8\.000,00/);
  });
});

describe('savings insights', () => {
  it('splits income, compares with 50/30/20 and summarises the year', () => {
    const yearSummaries = ['2026-01', '2026-02', '2026-03'].map((m, i) => summary(m, 200000, 150000 + i * 10000, i === 2 ? 'below' : 'above'));
    const i = buildSavingsInsights({
      month: '2026-03', summary: yearSummaries[2]!, essentialCents: 90000, discretionaryCents: 50000, neutralCents: 30000, peopleCents: 20000,
      movedToOwnCents: 50000, yearSummaries, recurring: [sub('Seguro', 24000, { frequency: 'annual', nextDate: '2026-04-15', annualCents: 24000 })], today: '2026-03-31', horizonDays: 60,
    });
    expect(i.flow).toMatchObject({ incomeCents: 200000, peopleCents: 20000, otherCents: 10000, savingsCents: 30000, movedToOwnCents: 50000 });
    expect(i.benchmark).toEqual({ needsBp: 4500, wantsBp: 4000, savingsBp: 1500 });
    expect(i.year).toMatchObject({ savedCents: 50000 + 40000 + 30000, months: 3, avgMonthlyCents: 40000, projectedCents: 120000 + 40000 * 9, monthsGoalMet: 2, streak: 0 });
    expect(i.upcoming).toHaveLength(1);
    expect(i.nonMonthlyReserveCents).toBe(2000);
  });
});
