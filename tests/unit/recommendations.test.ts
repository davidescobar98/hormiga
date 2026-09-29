import { describe, expect, it } from 'vitest';
import { generateRecommendations, type RecommendationContext } from '../../src/core/domain/recommendations';
import { buildMonthSummary, emptyMonth } from '../../src/core/domain/metrics';
import type { IncomeDTO, MonthSummary, RecurringDTO } from '../../src/shared/types';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const salary: IncomeDTO = { id: 1, kind: 'salary', label: 'Salario', amountCents: 250000, startMonth: '2026-01', endMonth: null };
const CATS = [
  { id: 1, name: 'Supermercado', kind: 'essential' as const },
  { id: 2, name: 'Restaurantes', kind: 'discretionary' as const },
  { id: 3, name: 'Ocio', kind: 'discretionary' as const },
  { id: 4, name: 'Comisiones', kind: 'neutral' as const },
];

function ctx(perMonth: Record<string, Record<number, number>>, extra: Partial<RecommendationContext> = {}): RecommendationContext {
  const summaries = new Map<string, MonthSummary>();
  const categoryMonthly = new Map<string, Map<number, number>>();
  for (const m of MONTHS) {
    const cats = perMonth[m] ?? {};
    const a = emptyMonth(m);
    a.netCents = Object.values(cats).reduce((x, y) => x + y, 0);
    a.txCount = a.netCents > 0 ? 10 : 0;
    summaries.set(m, buildMonthSummary(a, { incomeMode: 'manual', incomeEntries: [salary], goal: null }));
    categoryMonthly.set(m, new Map(Object.entries(cats).map(([k, v]) => [Number(k), v])));
  }
  return {
    referenceMonth: '2026-08', summaries, categoryMonthly, categories: CATS, activeRecurring: [], merchantActivity: [],
    feesByMonth: new Map(), goalTargetCents: null, uncategorizedCount: 0, ...extra,
  };
}

const base = { 1: 40000, 2: 20000, 3: 5000 };
const steady = Object.fromEntries(MONTHS.map((m) => [m, base]));

const FORBIDDEN = /invier|inversi[oó]n|acciones|bolsa|fondo|cripto|bitcoin|trading|dep[oó]sito a plazo|contrata/i;

describe('generateRecommendations', () => {
  it('detects a relevant category increase with monthly and annual impact', () => {
    const recs = generateRecommendations(ctx({ ...steady, '2026-08': { 1: 40000, 2: 31000, 3: 5000 } }));
    const inc = recs.find((r) => r.type === 'category_increase');
    expect(inc?.category).toBe('Restaurantes');
    expect(inc?.estimatedMonthlyImpactCents).toBe(11000);
    expect(inc?.estimatedAnnualImpactCents).toBe(132000);
    expect(inc?.evidence.length).toBe(4);
  });

  it('suggests reducing a large discretionary category, with the documented target', () => {
    const recs = generateRecommendations(ctx(Object.fromEntries(MONTHS.map((m) => [m, { 1: 40000, 2: 31000, 3: 5000 }]))));
    const d = recs.find((r) => r.type === 'discretionary_reduction' && r.category === 'Restaurantes');
    expect(d).toBeDefined();
    expect(d!.description).toContain('310,00');
    expect(d!.description).toContain('250,00');
    expect(d!.estimatedMonthlyImpactCents).toBe(6000);
    expect(d!.estimatedAnnualImpactCents).toBe(72000);
  });

  it('flags several subscriptions', () => {
    const sub = (id: number, name: string, monthly: number): RecurringDTO => ({
      id, merchantId: id, merchantName: name, categoryId: 2, categoryName: 'Suscripciones', status: 'probable', frequency: 'monthly', kind: 'subscription',
      averageCents: monthly, lastDate: '2026-08-05', nextDate: '2026-09-04', occurrences: 5, monthlyCents: monthly, annualCents: monthly * 12, confidenceBp: 9000, reason: '',
    });
    const recs = generateRecommendations(ctx(steady, { activeRecurring: [sub(1, 'Netflix', 1299), sub(2, 'Spotify', 1099)] }));
    const s = recs.find((r) => r.type === 'subscriptions');
    expect(s?.title).toContain('2 suscripciones');
    expect(s?.estimatedMonthlyImpactCents).toBe(1099);
  });

  it('detects frequent small purchases and recurring fees', () => {
    const merchantActivity = ['2026-06', '2026-07', '2026-08'].map((m) => ({ merchantId: 9, name: 'Cafetería', categoryName: 'Restaurantes', month: m, count: 12, spentCents: 3000 }));
    const feesByMonth = new Map([['2026-07', { cents: 300, count: 1 }], ['2026-08', { cents: 300, count: 1 }]]);
    const recs = generateRecommendations(ctx(steady, { merchantActivity, feesByMonth }));
    expect(recs.find((r) => r.type === 'frequent_small_purchases')?.estimatedMonthlyImpactCents).toBe(1500);
    const fees = recs.find((r) => r.type === 'fees');
    expect(fees?.priority).toBe('high');
    expect(fees?.estimatedMonthlyImpactCents).toBe(200);
  });

  it('detects an atypical month and explains the drivers', () => {
    const recs = generateRecommendations(ctx({ ...steady, '2026-08': { 1: 40000, 2: 20000, 3: 45000 } }));
    const a = recs.find((r) => r.type === 'atypical_month');
    expect(a).toBeDefined();
    expect(a!.evidence[0]).toContain('Ocio');
  });

  it('computes the gap to the savings goal, or celebrates when met', () => {
    const gap = generateRecommendations(ctx(steady, { goalTargetCents: 200000 })).find((r) => r.type === 'goal_gap');
    expect(gap?.estimatedMonthlyImpactCents).toBe(200000 - (250000 - 65000));
    const met = generateRecommendations(ctx(steady, { goalTargetCents: 100000 })).find((r) => r.type === 'goal_met');
    expect(met?.tone).toBe('positive');
  });

  it('generates positive observations, not only negative ones', () => {
    const recs = generateRecommendations(ctx({ ...steady, '2026-08': { 1: 40000, 2: 12000, 3: 5000 } }));
    expect(recs.some((r) => r.tone === 'positive' && r.type === 'category_decrease')).toBe(true);
    expect(recs.some((r) => r.type === 'savings_rate_up')).toBe(true);
  });

  it('never contains investment advice and every recommendation has a reason', () => {
    const recs = generateRecommendations(ctx({ ...steady, '2026-08': { 1: 40000, 2: 31000, 3: 45000, 4: 500 } }, {
      goalTargetCents: 150000, uncategorizedCount: 12, feesByMonth: new Map([['2026-08', { cents: 500, count: 1 }]]),
    }));
    expect(recs.length).toBeGreaterThan(3);
    for (const r of recs) {
      expect(`${r.title} ${r.description} ${r.reason} ${r.evidence.join(' ')}`).not.toMatch(FORBIDDEN);
      expect(r.reason.length).toBeGreaterThan(10);
      if (r.estimatedMonthlyImpactCents !== null) expect(r.estimatedAnnualImpactCents).toBe(r.estimatedMonthlyImpactCents * 12);
    }
  });

  it('returns nothing without data', () => {
    expect(generateRecommendations(ctx({}))).toEqual([]);
  });
});
