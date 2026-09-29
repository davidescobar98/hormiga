import { describe, expect, it, vi } from 'vitest';
import { earlyRepayment, loanStatus, monthlyPayment, paymentDate, schedule } from '../../src/core/domain/loans';
import { projectValue } from '../../src/core/domain/estimate';
import { historicalReturns, type PricePoint } from '../../src/core/domain/returns';
import { assetValueAt, netWorthAt } from '../../src/core/domain/wealth';
import { YahooMarketProvider } from '../../src/core/market/yahoo';
import { addMonths } from '../../src/shared/dates';
import { compareVersions, notesSince } from '../../src/shared/changelog';

const MORTGAGE = { principalCents: 10000000, annualRateBp: 300, termMonths: 240, startDate: '2020-01-15' };

describe('loans (French amortization)', () => {
  it('computes the standard payment: 100.000 € at 3 % over 20 years = 554,60 €', () => {
    expect(monthlyPayment(10000000, 300, 240)).toBe(55460);
    expect(monthlyPayment(120000, 0, 12)).toBe(10000);
  });

  it('schedule repays exactly the principal and ends at zero on the last payment', () => {
    const rows = schedule(MORTGAGE);
    expect(rows).toHaveLength(240);
    expect(rows.reduce((a, r) => a + r.principalCents, 0)).toBe(MORTGAGE.principalCents);
    expect(rows.at(-1)!.balanceCents).toBe(0);
    expect(rows[0]!.interestCents).toBe(25000);
    expect(rows[0]!.date).toBe('2020-02-15');
    for (const r of rows) expect(r.paymentCents).toBe(r.interestCents + r.principalCents);
  });

  it('clamps payment dates to the month length', () => {
    expect(paymentDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(paymentDate('2026-01-31', 2)).toBe('2026-03-31');
  });

  it('status on a date: paid, outstanding and pending interest add up', () => {
    const s = loanStatus(MORTGAGE, '2026-09-29');
    const rows = schedule(MORTGAGE);
    expect(s.paymentsMade).toBe(rows.filter((r) => r.date <= '2026-09-29').length);
    expect(s.outstandingCents).toBe(rows[s.paymentsMade - 1]!.balanceCents);
    expect(s.paidPrincipalCents + s.outstandingCents).toBe(MORTGAGE.principalCents);
    expect(s.paidInterestCents + s.remainingInterestCents).toBe(s.totalInterestCents);
    expect(s.remainingPayments).toBe(240 - s.paymentsMade);
    expect(s.endDate).toBe('2040-01-15');
    expect(loanStatus(MORTGAGE, '2019-12-01').outstandingCents).toBe(0);
  });

  it('early repayment: reducing the term saves more interest than reducing the payment', () => {
    const term = earlyRepayment(MORTGAGE, '2026-09-29', 2000000, 'reduce_term');
    const pay = earlyRepayment(MORTGAGE, '2026-09-29', 2000000, 'reduce_payment');
    expect(term.outstandingAfterCents).toBe(term.outstandingBeforeCents - 2000000);
    expect(term.newPaymentCents).toBe(term.currentPaymentCents);
    expect(term.newRemainingPayments).toBeLessThan(term.currentRemainingPayments);
    expect(pay.newRemainingPayments).toBe(pay.currentRemainingPayments);
    expect(pay.newPaymentCents).toBeLessThan(pay.currentPaymentCents);
    expect(term.interestSavedCents).toBeGreaterThan(pay.interestSavedCents);
    expect(pay.interestSavedCents).toBeGreaterThan(0);
    const all = earlyRepayment(MORTGAGE, '2026-09-29', 999999999, 'reduce_term');
    expect(all.outstandingAfterCents).toBe(0);
    expect(all.newRemainingPayments).toBe(0);
  });
});

describe('rate-based estimates', () => {
  it('grows at the annual rate: 10.000 € at 3 % for one year = 10.300 €', () => {
    expect(projectValue({ date: '2025-01-01', valueCents: 1000000, contributedCents: 1000000 }, 300, 0, '2026-01-01')).toEqual({ valueCents: 1030000, contributedCents: 1000000 });
  });

  it('adds the monthly contribution on each monthly anniversary', () => {
    expect(projectValue({ date: '2026-01-10', valueCents: 0, contributedCents: 0 }, 0, 10000, '2026-07-09')).toEqual({ valueCents: 50000, contributedCents: 50000 });
    expect(projectValue({ date: '2026-01-10', valueCents: 0, contributedCents: 0 }, 0, 10000, '2026-07-10')).toEqual({ valueCents: 60000, contributedCents: 60000 });
  });

  it('does not change before the base date and supports negative rates', () => {
    const base = { date: '2026-01-01', valueCents: 100000, contributedCents: null };
    expect(projectValue(base, 500, 0, '2025-06-01').valueCents).toBe(100000);
    expect(projectValue(base, -1000, 0, '2027-01-01').valueCents).toBe(90000);
  });

  it('assetValueAt: manual carries forward, rate estimates, loan uses the schedule', () => {
    const v = { assetId: 1, date: '2025-01-01', valueCents: 1000000, contributedCents: 1000000 };
    expect(assetValueAt({ id: 1, type: 'fund', mode: 'manual' }, v, '2026-01-01')).toMatchObject({ valueCents: 1000000, estimated: false });
    expect(assetValueAt({ id: 1, type: 'deposit', mode: 'rate', annualRateBp: 300 }, v, '2026-01-01')).toMatchObject({ valueCents: 1030000, estimated: true, baseDate: '2025-01-01' });
    const loan = assetValueAt({ id: 2, type: 'mortgage', mode: 'loan', loan: MORTGAGE }, undefined, '2026-09-29');
    expect(loan!.valueCents).toBe(loanStatus(MORTGAGE, '2026-09-29').outstandingCents);
    const nw = netWorthAt([{ id: 1, type: 'deposit', mode: 'rate', annualRateBp: 300 }, { id: 2, type: 'mortgage', mode: 'loan', loan: MORTGAGE }], [v], '2026-01-01');
    expect(nw.assetsCents).toBe(1030000);
    expect(nw.liabilitiesCents).toBe(loanStatus(MORTGAGE, '2026-01-01').outstandingCents);
  });
});

function series(years: number, annual: number, start = '2015-01-01'): PricePoint[] {
  const out: PricePoint[] = [];
  for (let m = 0; m <= years * 12; m++) out.push({ date: `${addMonths(start.slice(0, 7), m)}-01`, price: 100 * Math.pow(1 + annual, m / 12) });
  return out;
}

describe('historical returns', () => {
  it('recovers a constant 7 % yearly growth over every horizon', () => {
    const r = historicalReturns(series(11, 0.07))!;
    for (const k of ['y1', 'y3', 'y5', 'y10', 'all'] as const) expect(Math.abs(r.cagr[k]! - 700)).toBeLessThanOrEqual(15);
    expect(r.maxDrawdownBp).toBe(0);
    expect(r.volatilityBp).toBeLessThanOrEqual(5);
    expect(Math.abs(r.bestYearBp! - 700)).toBeLessThanOrEqual(15);
  });

  it('measures drawdowns and leaves short horizons empty', () => {
    const pts = series(2, 0.1);
    pts[12] = { ...pts[12]!, price: pts[11]!.price * 0.7 };
    const r = historicalReturns(pts)!;
    expect(r.maxDrawdownBp).toBe(-3000);
    expect(r.cagr.y3).toBeNull();
    expect(r.cagr.y10).toBeNull();
    expect(historicalReturns([{ date: '2026-01-01', price: 1 }])).toBeNull();
  });
});

describe('Yahoo market provider (mocked, no network)', () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it('sends only the query text and keeps supported instruments', async () => {
    const fetchFn = vi.fn((_url: string) => ok({ quotes: [
      { symbol: 'IWDA.AS', longname: 'iShares Core MSCI World', quoteType: 'ETF', exchDisp: 'Amsterdam' },
      { symbol: 'BTC-USD', shortname: 'Bitcoin', quoteType: 'CRYPTOCURRENCY' },
      { symbol: 'bad symbol!', quoteType: 'EQUITY' },
    ] }));
    const p = new YahooMarketProvider(fetchFn);
    const r = await p.search('msci world');
    expect(r).toEqual([{ symbol: 'IWDA.AS', name: 'iShares Core MSCI World', type: 'ETF', exchange: 'Amsterdam' }]);
    const url = new URL(fetchFn.mock.calls[0]![0]);
    expect(url.hostname).toBe('query2.finance.yahoo.com');
    expect(url.searchParams.get('q')).toBe('msci world');
  });

  it('parses monthly history using adjusted closes and skips gaps', async () => {
    const ts = [Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 1), Date.UTC(2020, 2, 1)].map((t) => t / 1000);
    const p = new YahooMarketProvider(() => ok({ chart: { result: [{ meta: { symbol: 'X', longName: 'Fondo X', currency: 'EUR' }, timestamp: ts, indicators: { adjclose: [{ adjclose: [10, null, 12] }], quote: [{ close: [1, 1, 1] }] } }] } }));
    const h = await p.monthlyHistory('X');
    expect(h).toEqual({ symbol: 'X', name: 'Fondo X', currency: 'EUR', points: [{ date: '2020-01-01', price: 10 }, { date: '2020-03-01', price: 12 }] });
  });

  it('maps failures to clear errors and rejects invalid symbols before any request', async () => {
    const offline = new YahooMarketProvider(() => Promise.reject(new TypeError('fetch failed')));
    await expect(offline.search('abc')).rejects.toMatchObject({ code: 'MARKET_OFFLINE' });
    const limited = new YahooMarketProvider(() => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }));
    await expect(limited.search('abc')).rejects.toMatchObject({ code: 'MARKET_ERROR' });
    const empty = new YahooMarketProvider(() => ok({ chart: { result: [] } }));
    await expect(empty.monthlyHistory('ZZZ')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const spy = vi.fn();
    await expect(new YahooMarketProvider(spy).monthlyHistory('../etc')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('release notes', () => {
  it('compares versions numerically and lists only the new notes', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(notesSince('0.1.0', '0.2.0').map((n) => n.version)).toEqual(['0.2.0']);
    expect(notesSince('0.2.0', '0.2.0')).toEqual([]);
  });
});
