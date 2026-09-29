import type { Cents } from '../../shared/money';
import { daysBetween, type IsoDate } from '../../shared/dates';
import { schedule, type LoanTerms } from './loans';

/*
 * A loan payment is partly interest (a cost) and partly principal (it reduces your debt: your net worth does not
 * change). With the loan's terms registered in «Patrimonio», each bank charge is matched to its row of the French
 * amortization schedule and split. Unmatched charges are left untouched (counted in full as spending).
 */

export interface LoanPayment {
  id: number;
  date: IsoDate;
  /** Positive amount charged. */
  amountCents: Cents;
}

export interface PaymentSplit {
  interestCents: Cents;
  principalCents: Cents;
  loanName: string;
}

// A late or early charge can belong to the previous or next instalment.
const MAX_DAYS = 35;
const MAX_AMOUNT_DIFF = 0.05;

export function splitLoanPayments(payments: LoanPayment[], loans: { name: string; terms: LoanTerms }[]): Map<number, PaymentSplit> {
  const out = new Map<number, PaymentSplit>();
  const rows = loans.map((l) => ({ name: l.name, rows: schedule(l.terms), used: new Set<number>() }));
  for (const p of [...payments].sort((a, b) => a.date.localeCompare(b.date))) {
    let best: { loan: (typeof rows)[number]; idx: number; score: number } | null = null;
    for (const loan of rows) {
      for (let i = 0; i < loan.rows.length; i++) {
        if (loan.used.has(i)) continue;
        const r = loan.rows[i]!;
        const days = Math.abs(daysBetween(r.date, p.date));
        if (days > MAX_DAYS) continue;
        const diff = Math.abs(r.paymentCents - p.amountCents) / r.paymentCents;
        if (diff > MAX_AMOUNT_DIFF) continue;
        const score = days + diff * 100;
        if (!best || score < best.score) best = { loan, idx: i, score };
      }
    }
    if (!best) continue;
    best.loan.used.add(best.idx);
    const r = best.loan.rows[best.idx]!;
    // Small differences (rounding, a bank fee included) scale both parts; principal never exceeds the charge.
    const principal = Math.min(p.amountCents, Math.round((r.principalCents * p.amountCents) / r.paymentCents));
    out.set(p.id, { principalCents: principal, interestCents: p.amountCents - principal, loanName: best.loan.name });
  }
  return out;
}
