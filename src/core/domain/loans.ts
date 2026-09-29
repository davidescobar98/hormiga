import type { Cents } from '../../shared/money';
import { addMonths, daysInMonth, parseYearMonth, toIso, type IsoDate } from '../../shared/dates';

/*
 * French amortization (sistema francés: constant payment), the usual system for Spanish mortgages and loans.
 *   i = TIN / 12, payment = P·i / (1 − (1 + i)^−n)   (P / n when i = 0)
 * Each month: interest = round(balance · i), principal = payment − interest; the last payment settles the rest.
 * Payments are due monthly from one month after the start date (same day of month, clamped to month length).
 */

export interface LoanTerms {
  principalCents: Cents;
  /** Nominal annual rate (TIN) in basis points. */
  annualRateBp: number;
  termMonths: number;
  startDate: IsoDate;
}

export interface ScheduleRow {
  n: number;
  date: IsoDate;
  paymentCents: Cents;
  interestCents: Cents;
  principalCents: Cents;
  balanceCents: Cents;
}

export function monthlyPayment(principal: Cents, annualRateBp: number, n: number): Cents {
  if (n <= 0) return principal;
  const i = annualRateBp / 10000 / 12;
  if (i === 0) return Math.ceil(principal / n);
  return Math.round((principal * i) / (1 - Math.pow(1 + i, -n)));
}

/** Due date of payment k (k ≥ 1): same day of month as the start, clamped (31/01 → 28/02). */
export function paymentDate(start: IsoDate, k: number): IsoDate {
  const ym = addMonths(start.slice(0, 7), k);
  const { y, m } = parseYearMonth(ym);
  return toIso(y, m, Math.min(Number(start.slice(8, 10)), daysInMonth(y, m)));
}

export function schedule(t: LoanTerms, paymentOverride?: Cents): ScheduleRow[] {
  const i = t.annualRateBp / 10000 / 12;
  const payment = paymentOverride ?? monthlyPayment(t.principalCents, t.annualRateBp, t.termMonths);
  const rows: ScheduleRow[] = [];
  let balance = t.principalCents;
  for (let k = 1; balance > 0 && k <= 1200; k++) {
    const interest = Math.round(balance * i);
    let principal = payment - interest;
    if (principal <= 0) throw new Error('La cuota no cubre los intereses');
    if (principal > balance || k === t.termMonths) principal = balance;
    balance -= principal;
    rows.push({ n: k, date: paymentDate(t.startDate, k), paymentCents: principal + interest, interestCents: interest, principalCents: principal, balanceCents: balance });
  }
  return rows;
}

export interface LoanStatus {
  paymentCents: Cents;
  outstandingCents: Cents;
  paidPrincipalCents: Cents;
  paidInterestCents: Cents;
  totalInterestCents: Cents;
  remainingInterestCents: Cents;
  paymentsMade: number;
  remainingPayments: number;
  nextPaymentDate: IsoDate | null;
  endDate: IsoDate;
}

/** Situation on `date`: payments whose due date is on or before it are considered paid. */
export function loanStatus(t: LoanTerms, date: IsoDate): LoanStatus {
  const rows = schedule(t);
  const paid = rows.filter((r) => r.date <= date);
  const last = paid[paid.length - 1];
  const totalInterest = rows.reduce((a, r) => a + r.interestCents, 0);
  const paidInterest = paid.reduce((a, r) => a + r.interestCents, 0);
  return {
    paymentCents: rows[0]?.paymentCents ?? 0,
    outstandingCents: date < t.startDate ? 0 : (last?.balanceCents ?? t.principalCents),
    paidPrincipalCents: paid.reduce((a, r) => a + r.principalCents, 0),
    paidInterestCents: paidInterest,
    totalInterestCents: totalInterest,
    remainingInterestCents: totalInterest - paidInterest,
    paymentsMade: paid.length,
    remainingPayments: rows.length - paid.length,
    nextPaymentDate: rows[paid.length]?.date ?? null,
    endDate: rows[rows.length - 1]?.date ?? t.startDate,
  };
}

export type EarlyRepaymentStrategy = 'reduce_term' | 'reduce_payment';

export interface EarlyRepaymentResult {
  outstandingBeforeCents: Cents;
  outstandingAfterCents: Cents;
  currentPaymentCents: Cents;
  newPaymentCents: Cents;
  currentRemainingPayments: number;
  newRemainingPayments: number;
  currentEndDate: IsoDate;
  newEndDate: IsoDate;
  interestSavedCents: Cents;
}

/**
 * Extra repayment made on `date` (after that day's instalment). "reduce_term" keeps the payment and shortens the
 * loan; "reduce_payment" keeps the end date and lowers the payment. Bank fees for early repayment are not included.
 */
export function earlyRepayment(t: LoanTerms, date: IsoDate, amountCents: Cents, strategy: EarlyRepaymentStrategy): EarlyRepaymentResult {
  const rows = schedule(t);
  const paid = rows.filter((r) => r.date <= date);
  const remaining = rows.slice(paid.length);
  const before = paid.length ? paid[paid.length - 1]!.balanceCents : t.principalCents;
  const amount = Math.min(amountCents, before);
  const after = before - amount;
  const currentInterestLeft = remaining.reduce((a, r) => a + r.interestCents, 0);
  const restart: LoanTerms = {
    principalCents: after,
    annualRateBp: t.annualRateBp,
    termMonths: Math.max(1, remaining.length),
    startDate: paid.length ? paid[paid.length - 1]!.date : t.startDate,
  };
  const payment = rows[0]?.paymentCents ?? 0;
  const newRows = after === 0 ? [] : strategy === 'reduce_term' ? schedule({ ...restart, termMonths: 1200 }, payment) : schedule(restart);
  const newInterest = newRows.reduce((a, r) => a + r.interestCents, 0);
  return {
    outstandingBeforeCents: before,
    outstandingAfterCents: after,
    currentPaymentCents: payment,
    newPaymentCents: newRows[0]?.paymentCents ?? 0,
    currentRemainingPayments: remaining.length,
    newRemainingPayments: newRows.length,
    currentEndDate: rows[rows.length - 1]?.date ?? t.startDate,
    newEndDate: newRows[newRows.length - 1]?.date ?? date,
    interestSavedCents: currentInterestLeft - newInterest,
  };
}
