import { describe, expect, it } from 'vitest';
import {
  aggregateMonths, averageOver, buildComparisons, buildMonthSummary, buildScenarios, emptyMonth, estimateCapacity,
  forecastMonth, goalStatus, goalTarget, incomeForMonth, manualIncomeForMonth, type CategoryMonthAgg,
} from '../../src/core/domain/metrics';
import type { IncomeDTO, MonthSummary } from '../../src/shared/types';

const salary: IncomeDTO = { id: 1, kind: 'salary', label: 'Salario', amountCents: 250000, startMonth: '2026-01', endMonth: null };

describe('income', () => {
  it('applies recurring income by period and extraordinary only in its month', () => {
    const entries: IncomeDTO[] = [
      { ...salary, endMonth: '2026-05' },
      { id: 2, kind: 'salary', label: 'Salario nuevo', amountCents: 270000, startMonth: '2026-06', endMonth: null },
      { id: 3, kind: 'extraordinary', label: 'Paga extra', amountCents: 125000, startMonth: '2026-06', endMonth: '2026-06' },
    ];
    expect(manualIncomeForMonth(entries, '2026-05')).toBe(250000);
    expect(manualIncomeForMonth(entries, '2026-06')).toBe(395000);
    expect(manualIncomeForMonth(entries, '2026-06', { recurringOnly: true })).toBe(270000);
    expect(manualIncomeForMonth(entries, '2025-12')).toBe(0);
  });

  it('income modes never double count silently', () => {
    expect(incomeForMonth('manual', 250000, 248000).cents).toBe(250000);
    expect(incomeForMonth('documents', 250000, 248000).cents).toBe(248000);
    expect(incomeForMonth('combined', 250000, 10000).cents).toBe(260000);
    expect(incomeForMonth('auto', 250000, 248000).cents).toBe(248000);
    expect(incomeForMonth('auto', 250000, 0).cents).toBe(250000);
  });
});

describe('month summary & invariants', () => {
  const rows: CategoryMonthAgg[] = [
    { month: '2026-08', categoryId: 1, kind: 'essential', recurring: false, grossCents: 30000, refundsCents: 0, txCount: 5 },
    { month: '2026-08', categoryId: 2, kind: 'discretionary', recurring: false, grossCents: 20000, refundsCents: 3000, txCount: 4 },
    { month: '2026-08', categoryId: 3, kind: 'discretionary', recurring: true, grossCents: 1299, refundsCents: 0, txCount: 1 },
    { month: '2026-08', categoryId: 4, kind: 'neutral', recurring: false, grossCents: 5000, refundsCents: 0, txCount: 1 },
  ];
  const agg = aggregateMonths(rows, [], ['2026-08']).get('2026-08')!;
  agg.txCount = 11;
  const s = buildMonthSummary(agg, { incomeMode: 'manual', incomeEntries: [salary], goal: { mode: 'amount', amountCents: 70000, percentBp: null, effectiveFrom: '2026-01' } });

  it('refunds reduce spending but keep their own figure', () => {
    expect(s.grossExpensesCents).toBe(56299);
    expect(s.refundsCents).toBe(3000);
    expect(s.spendingCents).toBe(53299);
  });

  it('sum(category net) = total spending', () => {
    const byCategory = rows.reduce((a, r) => a + (r.grossCents - r.refundsCents), 0);
    expect(byCategory).toBe(s.spendingCents);
  });

  it('income − expenses = savings, and the rate is savings / income', () => {
    expect(s.incomeCents - s.spendingCents).toBe(s.savingsCents);
    expect(s.savingsCents).toBe(196701);
    expect(s.savingsRateBp).toBe(Math.round((196701 * 10000) / 250000));
  });

  it('fixed + variable = spending; discretionary counted by category kind', () => {
    expect(s.fixedCents + s.variableCents).toBe(s.spendingCents);
    expect(s.fixedCents).toBe(1299);
    expect(s.discretionaryCents).toBe(20000 - 3000 + 1299);
  });

  it('goal status', () => {
    expect(s.goal?.status).toBe('above');
    expect(goalStatus(69000, 70000).status).toBe('on_track');
    expect(goalStatus(52000, 70000).status).toBe('below');
    expect(goalStatus(52000, 70000).differenceCents).toBe(-18000);
    expect(goalTarget({ mode: 'percent', amountCents: null, percentBp: 2000, effectiveFrom: '2026-01' }, 250000)).toBe(50000);
    expect(goalTarget({ mode: 'percent', amountCents: null, percentBp: 2000, effectiveFrom: '2026-01' }, 0)).toBeNull();
  });

  it('savings rate is null without income', () => {
    const noIncome = buildMonthSummary(agg, { incomeMode: 'manual', incomeEntries: [], goal: null });
    expect(noIncome.savingsRateBp).toBeNull();
    expect(noIncome.savingsCents).toBe(-53299);
  });
});

function summaries(values: Record<string, number>): Map<string, MonthSummary> {
  const map = new Map<string, MonthSummary>();
  for (const [month, spend] of Object.entries(values)) {
    const a = emptyMonth(month);
    a.netCents = spend;
    a.grossCents = spend;
    a.txCount = spend > 0 ? 1 : 0;
    map.set(month, buildMonthSummary(a, { incomeMode: 'manual', incomeEntries: [salary], goal: null }));
  }
  return map;
}

describe('averages and comparisons', () => {
  it('requires full history before showing an average', () => {
    const m = summaries({ '2026-05': 100000, '2026-06': 120000, '2026-07': 110000 });
    expect(averageOver(m, '2026-07', 3)?.spendingCents).toBe(110000);
    expect(averageOver(m, '2026-07', 6)).toBeNull();
  });

  it('compares with previous month and 3-month average; partial months are flagged unreliable', () => {
    const m = summaries({ '2026-04': 100000, '2026-05': 100000, '2026-06': 100000, '2026-07': 130000 });
    const c = buildComparisons(m, '2026-07', false);
    expect(c.map((x) => x.label)).toEqual(['Mes anterior', 'Media 3 meses']);
    expect(c[0]!.deltaBp).toBe(3000);
    expect(buildComparisons(m, '2026-07', true).every((x) => !x.reliable)).toBe(true);
  });
});

describe('savings capacity & scenarios', () => {
  const window = ['2026-05', '2026-06', '2026-07'].map((m) => {
    const a = emptyMonth(m);
    a.byKind.essential.variable = 60000;
    a.byKind.discretionary.variable = 40000;
    a.byKind.neutral.variable = 10000;
    a.txCount = 10;
    return a;
  });

  it('follows the documented formula', () => {
    const cap = estimateCapacity({ window, expectedIncomeCents: 250000, expectedIncomeExplanation: '', recurringMonthlyCents: 90000 });
    expect(cap.capacityCents).toBe(250000 - 90000 - 60000 - 10000 - 40000);
    expect(cap.provisional).toBe(false);
    expect(cap.lines.at(-1)!.cents).toBe(cap.capacityCents);
  });

  it('flags provisional estimates', () => {
    const cap = estimateCapacity({ window: window.slice(0, 1), expectedIncomeCents: 250000, expectedIncomeExplanation: '', recurringMonthlyCents: 0 });
    expect(cap.provisional).toBe(true);
    expect(cap.notes.join(' ')).toContain('Estimación provisional: solo hay 1 mes de datos.');
  });

  it('builds actual / moderate / goal scenarios', () => {
    const cap = estimateCapacity({ window, expectedIncomeCents: 250000, expectedIncomeExplanation: '', recurringMonthlyCents: 90000 });
    const [actual, moderate, goal] = buildScenarios(cap, 70000);
    expect(actual!.monthlySavingsCents).toBe(50000);
    expect(moderate!.monthlySavingsCents).toBe(50000 + 6000);
    expect(goal!.discretionaryReductionBp).toBe(5000);
    expect(goal!.achievable).toBe(true);
    const [, , impossible] = buildScenarios(cap, 200000);
    expect(impossible!.achievable).toBe(false);
  });
});

describe('forecast', () => {
  it('blends pace with history and adds pending recurring charges', () => {
    const current = emptyMonth('2026-09');
    current.netCents = 50000;
    current.recurringCents = 10000;
    const hist = ['2026-06', '2026-07', '2026-08'].map((m) => {
      const a = emptyMonth(m);
      a.netCents = 140000;
      a.recurringCents = 20000;
      a.txCount = 5;
      return a;
    });
    const f = forecastMonth({ month: '2026-09', today: 10, current, pendingRecurringCents: 10000, history: hist, expectedIncomeCents: 250000 });
    // variable so far 40.000; pace 40.000/10*30 = 120.000; hist 120.000 → blended 120.000
    expect(f.projectedVariableCents).toBe(120000);
    expect(f.projectedSpendingCents).toBe(10000 + 10000 + 120000);
    expect(f.projectedSavingsCents).toBe(250000 - 140000);
    expect(f.confidence).toBe('medium');
  });

  it('never projects less than already spent', () => {
    const current = emptyMonth('2026-09');
    current.netCents = 90000;
    const hist = [emptyMonth('2026-08')];
    hist[0]!.netCents = 10000;
    const f = forecastMonth({ month: '2026-09', today: 5, current, pendingRecurringCents: 0, history: hist, expectedIncomeCents: null });
    expect(f.projectedSpendingCents).toBeGreaterThanOrEqual(90000);
    expect(f.projectedSavingsCents).toBeNull();
    expect(f.confidence).toBe('low');
  });
});
