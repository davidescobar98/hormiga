import { describe, expect, it } from 'vitest';
import { detectRecurring, monthlyEquivalent, type RecurringInputTx } from '../../src/core/domain/recurring';

const tx = (merchantId: number, date: string, spendCents: number, categoryKey = 'subscriptions', subscriptionHint = false): RecurringInputTx => ({
  merchantId, merchantName: `M${merchantId}`, date, spendCents, categoryKey, subscriptionHint,
});

describe('detectRecurring', () => {
  it('detects a monthly subscription with stable amount', () => {
    const txs = ['2026-03-05', '2026-04-05', '2026-05-06', '2026-06-05', '2026-07-05'].map((d) => tx(1, d, 1299, 'subscriptions', true));
    const [r] = detectRecurring(txs, '2026-07-20');
    expect(r).toBeDefined();
    expect(r!.frequency).toBe('monthly');
    expect(r!.kind).toBe('subscription');
    expect(r!.averageCents).toBe(1299);
    expect(r!.nextDate).toBe('2026-08-04');
  });

  it('does not mark something recurring just because it appears twice', () => {
    const txs = [tx(2, '2026-05-05', 1299), tx(2, '2026-06-05', 1299)];
    expect(detectRecurring(txs, '2026-06-20')).toHaveLength(0);
  });

  it('accepts two yearly charges only for insurance-like categories', () => {
    const insurance = [tx(3, '2025-03-10', 45000, 'insurance'), tx(3, '2026-03-12', 46500, 'insurance')];
    expect(detectRecurring(insurance, '2026-04-01')[0]?.frequency).toBe('annual');
    const shopping = [tx(4, '2025-03-10', 45000, 'shopping'), tx(4, '2026-03-12', 45000, 'shopping')];
    expect(detectRecurring(shopping, '2026-04-01')).toHaveLength(0);
  });

  it('rejects irregular intervals and unstable amounts', () => {
    const irregular = ['2026-01-03', '2026-01-19', '2026-03-28', '2026-04-02', '2026-06-30'].map((d) => tx(5, d, 2000, 'groceries'));
    expect(detectRecurring(irregular, '2026-07-01')).toHaveLength(0);
    const unstable = ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05'].map((d, i) => tx(6, d, [2000, 9000, 1500, 6000][i]!, 'shopping'));
    expect(detectRecurring(unstable, '2026-06-20')).toHaveLength(0);
  });

  it('tolerates variable utility bills', () => {
    const bills = ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'].map((d, i) => tx(7, d, [4800, 6100, 5200, 5600][i]!, 'utilities'));
    const [r] = detectRecurring(bills, '2026-05-20');
    expect(r?.kind).toBe('fixed');
    expect(r?.frequency).toBe('monthly');
  });

  it('drops stale recurrences (cancelled subscriptions)', () => {
    const txs = ['2025-01-05', '2025-02-05', '2025-03-05', '2025-04-05'].map((d) => tx(8, d, 999));
    expect(detectRecurring(txs, '2026-01-01')).toHaveLength(0);
  });

  it('monthly equivalents', () => {
    expect(monthlyEquivalent(1200, 'weekly')).toBe(5200);
    expect(monthlyEquivalent(6000, 'quarterly')).toBe(2000);
    expect(monthlyEquivalent(12000, 'annual')).toBe(1000);
  });
});
