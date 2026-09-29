import { describe, expect, it } from 'vitest';
import { monthsUntil, potProgress } from '../../src/core/domain/pots';
import { monthsToTarget, simulate } from '../../src/shared/simulator';
import { allocation, gain, netWorthAt, netWorthHistory } from '../../src/core/domain/wealth';

describe('savings pots', () => {
  const base = { targetCents: 120000, createdOn: '2026-01-01', today: '2026-07-01' };

  it('computes the monthly amount needed to arrive on time (rounded up)', () => {
    const p = potProgress({ ...base, targetDate: '2026-12-31', savedCents: 60000 });
    expect(p.monthsLeft).toBe(6);
    expect(p.requiredMonthlyCents).toBe(10000);
    expect(p.progressBp).toBe(5000);
    expect(p.status).toBe('on_track');
    expect(potProgress({ ...base, targetDate: '2026-12-31', savedCents: 60001 }).requiredMonthlyCents).toBe(10000);
    expect(potProgress({ ...base, targetDate: '2026-12-31', savedCents: 59999 }).requiredMonthlyCents).toBe(10001);
  });

  it('classifies ahead / behind / done / overdue / no date', () => {
    expect(potProgress({ ...base, targetDate: '2026-12-31', savedCents: 100000 }).status).toBe('ahead');
    expect(potProgress({ ...base, targetDate: '2026-12-31', savedCents: 10000 }).status).toBe('behind');
    expect(potProgress({ ...base, targetDate: '2026-12-31', savedCents: 130000 })).toMatchObject({ status: 'done', remainingCents: 0, progressBp: 10000 });
    expect(potProgress({ ...base, targetDate: '2026-06-30', savedCents: 10000 })).toMatchObject({ status: 'overdue', requiredMonthlyCents: 110000 });
    expect(potProgress({ ...base, targetDate: null, savedCents: 10000 })).toMatchObject({ status: 'no_date', requiredMonthlyCents: null });
  });

  it('counts the current month when the target is later this month', () => {
    expect(monthsUntil('2026-07-01', '2026-07-31')).toBe(1);
    expect(monthsUntil('2026-07-15', '2027-07-15')).toBe(13);
  });
});

describe('compound growth simulator', () => {
  it('without return, the final value equals what was contributed', () => {
    const r = simulate({ initialCents: 100000, monthlyCents: 10000, annualRateBp: 0, years: 10, inflationBp: 0 });
    expect(r.final.valueCents).toBe(100000 + 10000 * 120);
    expect(r.final.growthCents).toBe(0);
    expect(r.points).toHaveLength(11);
  });

  it('matches the closed-form compound interest formula within cents of rounding', () => {
    const years = 20;
    const rate = 0.05;
    const r = simulate({ initialCents: 1000000, monthlyCents: 20000, annualRateBp: 500, years, inflationBp: 0 });
    const rm = Math.pow(1 + rate, 1 / 12) - 1;
    const n = years * 12;
    const expected = 1000000 * Math.pow(1 + rm, n) + 20000 * ((Math.pow(1 + rm, n) - 1) / rm);
    expect(Math.abs(r.final.valueCents - expected)).toBeLessThan(n); // at most ~1 cent of rounding per month
  });

  it('shows the effect of inflation in today’s euros', () => {
    const r = simulate({ initialCents: 1000000, monthlyCents: 0, annualRateBp: 0, years: 10, inflationBp: 200 });
    expect(r.final.valueCents).toBe(1000000);
    expect(r.final.realValueCents).toBe(Math.round(1000000 / Math.pow(1.02, 10)));
  });

  it('finds how long it takes to reach a target', () => {
    expect(monthsToTarget(1200000, 0, 100000, 0)).toBe(12);
    expect(monthsToTarget(500, 1000, 0, 0)).toBe(0);
    expect(monthsToTarget(1_000_000_000, 0, 1, 0)).toBeNull();
    const withReturn = monthsToTarget(1200000, 0, 100000, 500)!;
    expect(withReturn).toBeLessThanOrEqual(12);
  });
});

describe('wealth', () => {
  const assets = [
    { id: 1, type: 'cash' as const },
    { id: 2, type: 'fund' as const },
    { id: 3, type: 'loan' as const },
  ];
  const vals = [
    { assetId: 1, date: '2026-01-31', valueCents: 500000, contributedCents: null },
    { assetId: 2, date: '2026-01-31', valueCents: 300000, contributedCents: 280000 },
    { assetId: 3, date: '2026-01-31', valueCents: 400000, contributedCents: null },
    { assetId: 2, date: '2026-03-31', valueCents: 320000, contributedCents: 300000 },
  ];

  it('carries the latest valuation forward and subtracts liabilities', () => {
    expect(netWorthAt(assets, vals, '2026-02-28')).toEqual({ assetsCents: 800000, liabilitiesCents: 400000, netWorthCents: 400000 });
    expect(netWorthAt(assets, vals, '2026-03-31').netWorthCents).toBe(420000);
    expect(netWorthHistory(assets, vals, ['2025-12', '2026-01']).map((h) => h.netWorthCents)).toEqual([0, 400000]);
  });

  it('computes gain over contributions only for investments', () => {
    expect(gain('fund', 320000, 300000)).toEqual({ gainCents: 20000, returnBp: 667 });
    expect(gain('cash', 500000, 400000)).toEqual({ gainCents: null, returnBp: null });
    expect(gain('fund', 320000, null)).toEqual({ gainCents: null, returnBp: null });
  });

  it('allocation excludes liabilities and sums to 100 %', () => {
    const a = allocation([{ type: 'cash', valueCents: 500000 }, { type: 'fund', valueCents: 500000 }, { type: 'loan', valueCents: 999 }]);
    expect(a.map((x) => x.shareBp)).toEqual([5000, 5000]);
  });
});
