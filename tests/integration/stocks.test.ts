import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';
import { addDays } from '../../src/shared/dates';
import type { DailyHistory, MarketProvider } from '../../src/core/market/yahoo';
import { dipSeries } from '../helpers/stocks';

const START = '2025-06-01';
const LAST = addDays(START, 259); // last session of dipSeries

function fakeMarket(calls: string[]): MarketProvider {
  const history = (symbol: string): DailyHistory => {
    if (symbol === 'EURUSD=X') {
      return { symbol, name: 'EUR/USD', currency: 'USD', exchange: 'CCY', type: 'CURRENCY', live: null, points: dipSeries(START).map((p) => ({ date: p.date, close: 1.25 })) };
    }
    if (symbol === 'ACME') return { symbol, name: 'Acme Corp', currency: 'USD', exchange: 'NASDAQ', type: 'EQUITY', live: null, points: dipSeries(START) };
    if (symbol === 'FLAT.MC') return { symbol, name: 'Plana SA', currency: 'EUR', exchange: 'MCE', type: 'EQUITY', live: null, points: dipSeries(START).map((p) => ({ date: p.date, close: 10 })) };
    throw new Error('unknown');
  };
  return {
    source: 'Fake',
    search: async () => [],
    monthlyHistory: async () => { throw new Error('no'); },
    dailyHistory: async (s) => {
      calls.push(s);
      return history(s);
    },
  };
}

describe('Bolsa (service level)', () => {
  it('market data is opt-in; only symbols reach the provider', async () => {
    const calls: string[] = [];
    const core = makeCore({ now: `${LAST}T18:00:00Z`, market: fakeMarket(calls) });
    await expect(core.stocks.addWatch('ACME')).rejects.toMatchObject({ code: 'MARKET_DISABLED' });
    expect(calls).toEqual([]);
    // Without market data you can still register trades (valued once prices are available).
    core.stocks.addTrade({ symbol: 'flat.mc', side: 'buy', date: '2025-07-01', quantity: 3, price: 10, currency: 'EUR', fxPerEur: null, feesCents: 0, note: null });
    const o = core.stocks.overview();
    expect(o.positions[0]).toMatchObject({ symbol: 'FLAT.MC', shares: 3, costCents: 3000, valueCents: null });
    expect(o.positions[0]!.warnings[0]).toMatch(/Activa los datos de mercado/);
    expect(core.stocks.alerts()).toEqual([]);
  });

  it('watchlist buy signal → one alert per episode; trades in USD valued in euros; sell checks', async () => {
    const calls: string[] = [];
    const core = makeCore({ now: `${LAST}T18:00:00Z`, market: fakeMarket(calls) });
    core.repos.settings.updateSettings({ marketDataEnabled: true });
    core.stocks.liquidity = () => ({ liquidCents: 2000000, emergencyTargetCents: 1200000 });

    const o1 = await core.stocks.addWatch('acme');
    expect(calls).toEqual(['ACME', 'EURUSD=X']);
    const w = o1.watchlist[0]!;
    expect(w).toMatchObject({ symbol: 'ACME', name: 'Acme Corp', currency: 'USD', lastPrice: 175, drawdownBp: 1250, stale: false, held: false });
    expect(w.signals.map((s) => s.kind)).toEqual(['dip_in_uptrend']);
    expect(o1.liquidity).toMatchObject({ surplusCents: 800000, ok: true });
    // 20 % of (0 portfolio + 8.000 € surplus).
    expect(o1.liquidity.maxNewPositionCents).toBe(160000);

    const fresh = core.budgets.refreshAlerts();
    const stock = fresh.filter((a) => a.kind === 'stock_buy');
    expect(stock).toHaveLength(1);
    expect(stock[0]!.title).toContain('Acme Corp (ACME)');
    expect(stock[0]!.page).toBe('stocks');
    // Same episode: not raised again.
    expect(core.budgets.refreshAlerts().filter((a) => a.kind === 'stock_buy')).toHaveLength(0);
    expect(core.stocks.overview().watchlist[0]!.signals[0]!.since).toBe(LAST);

    // Buy 10 at 150 USD with the cached rate of that day (1,25 USD/€): 1.200 € + 4,50 € fees.
    core.stocks.addTrade({ symbol: 'ACME', side: 'buy', date: addDays(START, 200), quantity: 10, price: 150, currency: 'USD', fxPerEur: null, feesCents: 450, note: null });
    let o = core.stocks.overview();
    const p = o.positions[0]!;
    expect(p).toMatchObject({ shares: 10, costCents: 120450, avgPriceNative: 150, fxPerEur: 1.25 });
    expect(p.valueCents).toBe(140000); // 10 × 175 / 1,25
    expect(p.gainCents).toBe(140000 - 120450);
    expect(p.gainBp).toBe(Math.round(((140000 - 120450) / 120450) * 10000));
    expect(p.estimatedTaxCents).toBe(Math.round((140000 - 120450) * 0.19));
    expect(o.portfolio).toMatchObject({ valueCents: 140000, costCents: 120450, gainCents: 19550, positions: 1, pricedPositions: 1 });
    expect(o.portfolio.estimatedTaxCents).toBe(Math.round(19550 * 0.19));
    expect(o.portfolio.note).toMatch(/al menos 5/);
    // Net worth includes the portfolio at market value (and its history, by month-end prices).
    const nw = core.wealth.wealthOverview();
    expect(nw.stocksPortfolio).toEqual({ valueCents: 140000, costCents: 120450 });
    expect(nw.netWorthCents).toBe(140000);
    expect(nw.allocation.find((a) => a.type === 'stocks')?.cents).toBe(140000);
    expect(nw.stocksMaybeDuplicated).toBe(false);
    expect(core.stocks.valueAt(addDays(START, 199))).toEqual({ valueCents: 0, costCents: 0 });
    // On the purchase day: 10 × that close / 1,25.
    const close = 100 + (100 * 200) / 249;
    expect(core.stocks.valueAt(addDays(START, 200)).valueCents).toBe(Math.round(((10 * close) / 1.25) * 100));
    expect(o.watchlist[0]!.held).toBe(true);
    expect(o.trades[0]).toMatchObject({ totalCents: 120450, fxPerEur: 1.25 });

    // Cannot sell more than you hold, nor before buying.
    expect(() => core.stocks.addTrade({ symbol: 'ACME', side: 'sell', date: LAST, quantity: 11, price: 175, currency: 'USD', fxPerEur: 1.25, feesCents: 0, note: null })).toThrow(/No tenías tantas/);
    expect(() => core.stocks.addTrade({ symbol: 'ACME', side: 'sell', date: START, quantity: 1, price: 175, currency: 'USD', fxPerEur: 1.25, feesCents: 0, note: null })).toThrow(/No tenías tantas/);
    // Wrong currency for a known symbol.
    expect(() => core.stocks.addTrade({ symbol: 'ACME', side: 'buy', date: LAST, quantity: 1, price: 175, currency: 'EUR', fxPerEur: 1, feesCents: 0, note: null })).toThrow(/cotiza en USD/);
    // Future dates are refused.
    expect(() => core.stocks.addTrade({ symbol: 'ACME', side: 'buy', date: addDays(LAST, 2), quantity: 1, price: 175, currency: 'USD', fxPerEur: 1.25, feesCents: 0, note: null })).toThrow(/futura/);

    // Sell 4 at 175 USD (1,25): 560 € − 1 € fees; cost 4/10 of 1.204,50 € = 481,80 €.
    core.stocks.addTrade({ symbol: 'ACME', side: 'sell', date: LAST, quantity: 4, price: 175, currency: 'USD', fxPerEur: 1.25, feesCents: 100, note: 'parcial' });
    o = core.stocks.overview();
    const year = Number(LAST.slice(0, 4));
    expect(o.realized[0]).toMatchObject({ year, gainsCents: 55900 - 48180, lossesCents: 0, netCents: 7720, estimatedTaxCents: Math.round(7720 * 0.19) });
    expect(o.positions[0]).toMatchObject({ shares: 6, costCents: 120450 - 48180 });
    expect(o.portfolio.realizedThisYearCents).toBe(7720);
    // Unrealised gain is taxed on top of what was already realised this year.
    expect(o.portfolio.estimatedTaxCents).toBe(Math.round((7720 + o.portfolio.gainCents) * 0.19) - Math.round(7720 * 0.19));
    // The buy cannot be deleted while a later sale needs it.
    const buyId = o.trades.find((x) => x.side === 'buy')!.id;
    expect(() => core.stocks.deleteTrade(buyId)).toThrow(/Borra antes la venta/);
    core.stocks.deleteTrade(o.trades.find((x) => x.side === 'sell')!.id);
    core.stocks.deleteTrade(buyId);
    expect(core.stocks.overview().positions).toEqual([]);

    // Stop-loss: bought at 250 USD, now 175 → −30 %.
    core.stocks.addTrade({ symbol: 'ACME', side: 'buy', date: addDays(START, 240), quantity: 2, price: 250, currency: 'USD', fxPerEur: 1.25, feesCents: 0, note: null });
    o = core.stocks.overview();
    expect(o.positions[0]!.signals.map((s) => s.kind)).toEqual(['stop_loss']);
    expect(o.positions[0]!.warnings.some((x) => /dos meses/.test(x))).toBe(true);
    const sell = core.budgets.refreshAlerts().filter((a) => a.kind === 'stock_sell');
    expect(sell).toHaveLength(1);
    expect(sell[0]!.body).toMatch(/Resultado si vendes todo: −?-?/);

    // Removing from the watchlist ends the buy episode; following again raises a new alert only on a new day.
    core.stocks.removeWatch('ACME');
    expect(core.stocks.overview().watchlist).toEqual([]);
  });

  it('a buy signal while the emergency fund is not covered says so', async () => {
    const core = makeCore({ now: `${LAST}T18:00:00Z`, market: fakeMarket([]) });
    core.repos.settings.updateSettings({ marketDataEnabled: true });
    core.stocks.liquidity = () => ({ liquidCents: 500000, emergencyTargetCents: 1200000 });
    const o = await core.stocks.addWatch('ACME');
    expect(o.liquidity).toMatchObject({ ok: false, surplusCents: -700000, maxNewPositionCents: 0 });
    expect(o.liquidity.note).toMatch(/complétalo/);
    expect(o.watchlist[0]!.warnings.some((x) => /fondo de emergencia/.test(x))).toBe(true);
    const a = core.stocks.alerts();
    expect(a[0]!.body).toMatch(/completa tu fondo de emergencia/);
  });

  it('stale prices do not alert, and notifications can be turned off', async () => {
    const core = makeCore({ now: `${addDays(LAST, 20)}T18:00:00Z`, market: fakeMarket([]) });
    core.repos.settings.updateSettings({ marketDataEnabled: true });
    const o = await core.stocks.addWatch('ACME');
    expect(o.watchlist[0]!.stale).toBe(true);
    expect(o.watchlist[0]!.signals).toEqual([]);
    expect(core.stocks.alerts()).toEqual([]);

    const core2 = makeCore({ now: `${LAST}T18:00:00Z`, market: fakeMarket([]) });
    core2.repos.settings.updateSettings({ marketDataEnabled: true, stocks: { ...core2.repos.settings.getSettings().stocks, notify: false } });
    await core2.stocks.addWatch('ACME');
    expect(core2.stocks.alerts()).toEqual([]);
    expect(core2.stocks.overview().watchlist[0]!.signals).toHaveLength(1);
  });

  it('refresh skips recently fetched symbols unless forced', async () => {
    const calls: string[] = [];
    const core = makeCore({ now: `${LAST}T18:00:00Z`, market: fakeMarket(calls) });
    core.repos.settings.updateSettings({ marketDataEnabled: true });
    await core.stocks.addWatch('ACME');
    calls.length = 0;
    expect((await core.stocks.refresh(false)).updated).toBe(0);
    expect(calls).toEqual([]);
    const r = await core.stocks.refresh(true);
    expect(r.updated).toBe(1);
    expect(calls).toEqual(['ACME', 'EURUSD=X']);
  });
});
