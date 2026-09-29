import { describe, expect, it } from 'vitest';
import { splitLoanPayments } from '../../src/core/domain/loanSplit';
import { schedule } from '../../src/core/domain/loans';
import { makeCore } from '../helpers/core';
import { normalizeText } from '../../src/core/domain/merchant';

const TERMS = { principalCents: 15000000, annualRateBp: 300, termMonths: 300, startDate: '2025-01-20' };

describe('loan payment split (interest vs principal)', () => {
  it('matches each bank charge to its schedule row by date and amount', () => {
    const rows = schedule(TERMS);
    const pay = rows[0]!.paymentCents;
    const split = splitLoanPayments(
      [
        { id: 1, date: '2025-02-20', amountCents: pay },
        { id: 2, date: '2025-03-21', amountCents: pay },
        { id: 3, date: '2025-03-25', amountCents: 12000 }, // not a loan payment
        { id: 4, date: '2026-09-01', amountCents: pay * 3 }, // amount far off
      ],
      [{ name: 'Hipoteca', terms: TERMS }],
    );
    expect(split.get(1)).toEqual({ principalCents: rows[0]!.principalCents, interestCents: rows[0]!.interestCents, loanName: 'Hipoteca' });
    expect(split.get(2)!.principalCents).toBe(rows[1]!.principalCents);
    expect(split.has(3)).toBe(false);
    expect(split.has(4)).toBe(false);
  });

  it('two charges in the same month use two different rows', () => {
    const rows = schedule(TERMS);
    const pay = rows[0]!.paymentCents;
    const split = splitLoanPayments([{ id: 1, date: '2025-03-15', amountCents: pay }, { id: 2, date: '2025-03-16', amountCents: pay }], [{ name: 'H', terms: TERMS }]);
    expect(new Set([split.get(1)!.principalCents, split.get(2)!.principalCents]).size).toBe(2);
  });

  it('principal is savings, not spending (can be switched off)', () => {
    const core = makeCore({ now: '2025-04-30T10:00:00Z' });
    const rows = schedule(TERMS);
    core.repos.assets.save({ name: 'Hipoteca', type: 'mortgage', institution: null, notes: null, mode: 'loan', ...TERMS });
    const loans = core.repos.categories.list().find((c) => c.name === 'Préstamos')!;
    const income = core.repos.categories.list().find((c) => c.name === 'Ingresos')!;
    const ins = (fp: string, date: string, desc: string, amount: number, cat: number, type: 'expense' | 'income') =>
      core.repos.transactions.insert({ documentId: null, fingerprint: fp, date, bookingDate: null, descriptionRaw: desc, descriptionNormalized: normalizeText(desc), merchantRaw: null, merchantId: null, amountCents: amount, type, categoryId: cat, classificationSource: 'RULE', classificationConfidence: 1, classificationDetail: null, ruleId: null });
    ins('n', '2025-03-01', 'Abono nomina', 200000, income.id, 'income');
    ins('p', '2025-03-20', 'Cargo por amortizacion de prestamo', -rows[1]!.paymentCents, loans.id, 'expense');
    const s = core.analytics.dashboard('2025-03').summary;
    expect(s.principalRepaidCents).toBe(rows[1]!.principalCents);
    expect(s.spendingCents).toBe(rows[1]!.interestCents);
    expect(s.refundsCents).toBe(0);
    const report = core.analytics.report({ from: '2025-03', to: '2025-03' });
    expect(report.categories.find((c) => c.categoryId === loans.id)!.spentCents).toBe(rows[1]!.interestCents);
    expect(report.totals.principalRepaidCents).toBe(rows[1]!.principalCents);
    core.repos.settings.updateSettings({ principalAsSavings: false });
    expect(core.analytics.dashboard('2025-03').summary.spendingCents).toBe(rows[1]!.paymentCents);
  });
});
