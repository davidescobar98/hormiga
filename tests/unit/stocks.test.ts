import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/shared/dates';
import {
  buySignals, DEFAULT_STOCK_RULES, fifo, indicators, marginalTaxCents, nativeToEur, OversellError, peakSince, recentLossSale, rsi,
  savingsTaxCents, sellSignals, sma, type DailyClose, type Trade,
} from '../../src/core/domain/stocks';
import { inferTransactionType } from '../../src/core/domain/transactionType';
import { normalizeText } from '../../src/core/domain/merchant';
import { dipSeries } from '../helpers/stocks';

let nextId = 1;
const t = (p: Partial<Trade> & Pick<Trade, 'side' | 'date' | 'quantity' | 'price'>): Trade => ({ id: nextId++, symbol: 'ACME', currency: 'EUR', fxPerEur: 1, feesCents: 0, ...p });

describe('indicators', () => {
  it('moving average and RSI', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
    expect(sma([1, 2], 5)).toBeNull();
    expect(rsi(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(100);
    expect(rsi(Array.from({ length: 20 }, () => 5))).toBe(50);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 20 - i))).toBe(0);
    expect(rsi([1, 2, 3])).toBeNull();
  });

  it('a pullback inside an uptrend is a buy signal, with the numbers', () => {
    const ind = indicators(dipSeries())!;
    expect(ind.last).toBe(175);
    expect(ind.high52w).toBe(200);
    expect(ind.drawdownBp).toBe(1250);
    expect(ind.sma200!).toBeLessThan(175);
    expect(ind.rsi14!).toBeLessThan(30);
    const s = buySignals(ind, DEFAULT_STOCK_RULES, { targetPrice: null, currency: 'USD' });
    expect(s.map((x) => x.kind)).toEqual(['dip_in_uptrend']);
    expect(s[0]!.strength).toBe('strong');
    expect(s[0]!.detail).toContain('12,5 %');
    // A target price at or above the live price also fires.
    expect(buySignals(ind, DEFAULT_STOCK_RULES, { targetPrice: 180, currency: 'USD' }).map((x) => x.kind)).toContain('target_price');
    // A smaller fall than the rule does not.
    expect(buySignals(ind, { ...DEFAULT_STOCK_RULES, dipPct: 15 }, { targetPrice: null, currency: null })).toEqual([]);
  });

  it('the live quote replaces or extends the last close', () => {
    const s = dipSeries();
    const last = s[s.length - 1]!;
    expect(indicators(s, { date: last.date, price: 190 })!.last).toBe(190);
    expect(indicators(s, { date: addDays(last.date, 1), price: 160 })!.lastDate).toBe(addDays(last.date, 1));
    expect(indicators(s.slice(0, 20))).toBeNull();
  });

  it('a series that just lost its 200-session average flags a trend break', () => {
    const s: DailyClose[] = [];
    for (let i = 0; i < 230; i++) s.push({ date: addDays('2025-01-01', i), close: 100 });
    s.push({ date: addDays('2025-01-01', 230), close: 90 });
    const ind = indicators(s)!;
    expect(ind.brokeBelowSma200).toBe(true);
  });
});

describe('sell signals', () => {
  const pos = { shares: 10, costCents: 100000, valueCents: 100000, avgPriceNative: 100, firstBuyDate: '2025-06-01' };
  it('stop-loss, trailing stop, take-profit and concentration', () => {
    expect(sellSignals({ ...pos, valueCents: 80000 }, null, null, 80000, 1, DEFAULT_STOCK_RULES, 'EUR').map((s) => s.kind)).toEqual(['stop_loss']);
    expect(sellSignals({ ...pos, valueCents: 90000 }, null, null, 90000, 1, DEFAULT_STOCK_RULES, 'EUR')).toEqual([]);
    const ind = indicators(dipSeries())!; // last 175, peak 200
    // Fell 12,5 % from its peak: not enough for a 20 % trailing stop, but enough for 10 %.
    expect(sellSignals({ ...pos, valueCents: 175000 }, ind, 200, 175000, 1, DEFAULT_STOCK_RULES, 'EUR').map((s) => s.kind)).toEqual(['take_profit']);
    expect(sellSignals({ ...pos, valueCents: 175000 }, ind, 200, 175000, 1, { ...DEFAULT_STOCK_RULES, trailingStopPct: 10 }, 'EUR').map((s) => s.kind)).toEqual(['trailing_stop', 'take_profit']);
    // Never a trailing stop if the peak was below what you paid (that is the stop-loss's job).
    expect(sellSignals({ ...pos, avgPriceNative: 250, valueCents: 90000 }, ind, 200, 90000, 1, { ...DEFAULT_STOCK_RULES, trailingStopPct: 10 }, 'EUR')).toEqual([]);
    // With 2 positions a 20 % limit cannot be met: that is a portfolio note, not a sell signal.
    expect(sellSignals({ ...pos, valueCents: 100000 }, null, null, 300000, 2, DEFAULT_STOCK_RULES, 'EUR')).toEqual([]);
    const c = sellSignals({ ...pos, valueCents: 100000 }, null, null, 300000, 5, DEFAULT_STOCK_RULES, 'EUR');
    expect(c.map((s) => s.kind)).toEqual(['concentration']);
    expect(c[0]!.detail).toContain('33,3 %');
    expect(peakSince(dipSeries(), '2025-06-01')).toBe(200);
    expect(peakSince(dipSeries(), addDays('2025-06-01', 255), 180)).toBe(185);
  });
});

describe('FIFO, currencies and Spanish taxes', () => {
  it('sells the oldest shares first, with each trade exchange rate and fees', () => {
    const r = fifo([
      t({ side: 'buy', date: '2025-01-10', quantity: 10, price: 100, currency: 'USD', fxPerEur: 1.25, feesCents: 500 }), // 800 € + 5 €
      t({ side: 'buy', date: '2025-03-10', quantity: 10, price: 150, currency: 'USD', fxPerEur: 1.5, feesCents: 500 }), // 1.000 € + 5 €
      t({ side: 'sell', date: '2025-09-10', quantity: 15, price: 200, currency: 'USD', fxPerEur: 1.6, feesCents: 1000 }), // 1.875 € − 10 €
    ]);
    expect(r.sales).toHaveLength(1);
    expect(r.sales[0]).toMatchObject({ proceedsCents: 186500, costCents: 80500 + 50250, gainCents: 186500 - 130750, washSale: false });
    const lots = r.lots.get('ACME')!;
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ quantity: 5, costCents: 50250, priceNative: 150 });
  });

  it('refuses to sell shares you did not have', () => {
    expect(() => fifo([t({ side: 'buy', date: '2025-01-10', quantity: 1, price: 10 }), t({ side: 'sell', date: '2025-01-09', quantity: 1, price: 10 })])).toThrow(OversellError);
    expect(() => fifo([t({ side: 'buy', date: '2025-01-10', quantity: 1, price: 10 }), t({ side: 'sell', date: '2025-01-11', quantity: 1.5, price: 10 })])).toThrow(OversellError);
    // Fractional shares add up exactly.
    const r = fifo([t({ side: 'buy', date: '2025-01-10', quantity: 0.1, price: 10 }), t({ side: 'buy', date: '2025-01-11', quantity: 0.2, price: 10 }), t({ side: 'sell', date: '2025-01-12', quantity: 0.3, price: 10 })]);
    expect(r.lots.get('ACME')).toEqual([]);
    expect(r.sales[0]!.gainCents).toBe(0);
  });

  it('two-month rule: a loss with a repurchase around it is deferred', () => {
    const before = fifo([
      t({ side: 'buy', date: '2026-01-10', quantity: 10, price: 10 }),
      t({ side: 'buy', date: '2026-02-20', quantity: 10, price: 8 }),
      t({ side: 'sell', date: '2026-03-01', quantity: 10, price: 7 }),
    ]);
    expect(before.sales[0]).toMatchObject({ gainCents: -3000, washSale: true });
    const after = fifo([t({ side: 'buy', date: '2025-06-01', quantity: 10, price: 10 }), t({ side: 'sell', date: '2026-03-01', quantity: 10, price: 7 }), t({ side: 'buy', date: '2026-04-15', quantity: 1, price: 7 })]);
    expect(after.sales[0]!.washSale).toBe(true);
    const clean = fifo([t({ side: 'buy', date: '2025-06-01', quantity: 10, price: 10 }), t({ side: 'sell', date: '2026-03-01', quantity: 10, price: 7 }), t({ side: 'buy', date: '2026-06-01', quantity: 1, price: 7 })]);
    expect(clean.sales[0]!.washSale).toBe(false);
    // Gains are never affected.
    expect(fifo([t({ side: 'buy', date: '2026-01-10', quantity: 1, price: 10 }), t({ side: 'buy', date: '2026-02-20', quantity: 1, price: 10 }), t({ side: 'sell', date: '2026-03-01', quantity: 1, price: 12 })]).sales[0]!.washSale).toBe(false);
    expect(recentLossSale(before.sales, 'ACME', '2026-04-30')?.date).toBe('2026-03-01');
    expect(recentLossSale(before.sales, 'ACME', '2026-05-02')).toBeNull();
  });

  it('savings tax scale', () => {
    expect(savingsTaxCents(0)).toBe(0);
    expect(savingsTaxCents(-5000)).toBe(0);
    expect(savingsTaxCents(600000)).toBe(114000); // 6.000 € × 19 %
    expect(savingsTaxCents(1000000)).toBe(114000 + 84000); // + 4.000 € × 21 %
    expect(savingsTaxCents(6000000)).toBe(114000 + 924000 + 230000); // 6k@19 + 44k@21 + 10k@23
    expect(marginalTaxCents(200000, 500000)).toBe(savingsTaxCents(700000) - savingsTaxCents(500000));
    expect(marginalTaxCents(200000, 500000)).toBe(40000);
    expect(marginalTaxCents(-1000, 0)).toBe(0);
  });

  it('pence quotes are converted', () => {
    expect(nativeToEur(1000, 'GBp', 0.8)).toBeCloseTo(12.5);
    expect(nativeToEur(10, 'GBP', 0.8)).toBeCloseTo(12.5);
    expect(nativeToEur(10, 'EUR', 1)).toBe(10);
  });
});

describe('buying shares is not spending', () => {
  it('broker transfers and fund subscriptions are neutral', () => {
    for (const d of ['TRANSFERENCIA A TRADE REPUBLIC BANK GMBH', 'COMPRA DE VALORES BOLSA', 'SUSCRIPCION FONDOS INVERSION', 'TRANSFERENCIA DEGIRO']) {
      expect(inferTransactionType(normalizeText(d), -100000, 'account').type).toBe('transfer');
    }
    expect(inferTransactionType(normalizeText('REEMBOLSO FONDO INVERSION'), 100000, 'account').type).toBe('transfer');
    // A normal refund is still a refund.
    expect(inferTransactionType(normalizeText('REEMBOLSO AMAZON'), 1000, 'account').type).toBe('refund');
  });
});
