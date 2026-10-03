import { addDays, daysBetween, todayIso, type IsoDate } from '../../shared/dates';
import { formatCents } from '../../shared/money';
import type {
  PositionDTO, RealizedYearDTO, StockQuoteInfo, StockSignalDTO, StockTradeDTO, StockTradeInput, StocksOverview, StocksRefreshResult, WatchItemDTO,
} from '../../shared/types';
import {
  boughtWithinTwoMonths, buySignals, fifo, fxCurrency, indicators, marginalTaxCents, nativeToEur, OversellError, peakSince, recentLossSale,
  savingsTaxCents, sellSignals, type DailyClose, type Indicators, type Signal, type Trade,
} from '../domain/stocks';
import { AppError } from '../errors';
import type { MarketProvider } from '../market/yahoo';
import type { NewAlert } from './budgetsService';
import type { Repos } from './context';

/** Prices are refreshed at most this often unless forced. */
const REFRESH_MINUTES = 30;
/** A price older than this is shown as out of date and does not raise alerts. */
const STALE_DAYS = 5;
const MAX_WATCHLIST = 60;
/** Weak signals are shown in the app but never notified. */
const NOTIFY_STRENGTHS = new Set(['strong', 'moderate']);

export const fxSymbol = (currency: string) => `EUR${currency}=X`;

export interface LiquidityContext {
  liquidCents: number | null;
  emergencyTargetCents: number | null;
}

interface SymbolRow {
  symbol: string;
  name: string;
  currency: string | null;
  exchange: string | null;
  live_price: number | null;
  live_date: string | null;
  fetched_at: string | null;
}

/**
 * «Bolsa»: a watchlist with rule-based buy signals, your own trades (FIFO, Spanish tax estimate) and sell signals on
 * your positions. Only stock symbols are sent to the public market data provider; your trades never leave the PC.
 * Hormiga is not an investment adviser: signals are transparent technical rules you configure.
 */
export class StocksService {
  constructor(
    private readonly repos: Repos,
    private readonly market: MarketProvider | null,
    private readonly now: () => Date,
  ) {}

  /** Set by the composition root: cash and emergency fund from your accounts. */
  liquidity: () => LiquidityContext = () => ({ liquidCents: null, emergencyTargetCents: null });

  private today(): IsoDate {
    return todayIso(this.now());
  }

  private enabled(): boolean {
    return this.repos.settings.getSettings().marketDataEnabled;
  }

  private provider(): MarketProvider & Required<Pick<MarketProvider, 'dailyHistory'>> {
    if (!this.market?.dailyHistory) throw new AppError('MARKET_DISABLED', 'Consulta de mercado no disponible.');
    if (!this.enabled()) {
      throw new AppError('MARKET_DISABLED', 'Activa la consulta de datos de mercado para seguir cotizaciones. Solo se envía el símbolo de cada valor (nunca tus importes ni operaciones).');
    }
    return this.market as MarketProvider & Required<Pick<MarketProvider, 'dailyHistory'>>;
  }

  // ───────── Data access ─────────

  private symbolRow(symbol: string): SymbolRow | undefined {
    return this.repos.db.get<SymbolRow>('SELECT symbol, name, currency, exchange, live_price, live_date, fetched_at FROM market_symbols WHERE symbol = ?', symbol);
  }

  private series(symbol: string): DailyClose[] {
    return this.repos.db.all<{ date: string; close: number }>('SELECT date, close FROM market_prices WHERE symbol = ? ORDER BY date', symbol).map((r) => ({ date: r.date, close: Number(r.close) }));
  }

  private trades(): Trade[] {
    return this.repos.db
      .all<{ id: number; symbol: string; side: 'buy' | 'sell'; date: string; quantity: number; price: number; currency: string; fx_per_eur: number; fees_cents: number }>(
        'SELECT id, symbol, side, date, quantity, price, currency, fx_per_eur, fees_cents FROM stock_trades ORDER BY date, id',
      )
      .map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, date: r.date, quantity: Number(r.quantity), price: Number(r.price), currency: r.currency, fxPerEur: Number(r.fx_per_eur), feesCents: Number(r.fees_cents) }));
  }

  /** Units of `currency` per 1 € on a date (latest close on or before it), from the cache. */
  private fxOn(currency: string, date: IsoDate): number | null {
    const c = fxCurrency(currency);
    if (!c) return 1;
    const row = this.repos.db.get<{ close: number }>('SELECT close FROM market_prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1', fxSymbol(c), date);
    if (row) return Number(row.close);
    const live = this.symbolRow(fxSymbol(c));
    return live?.live_price && live.live_date && live.live_date <= date ? Number(live.live_price) : null;
  }

  private latestFx(currency: string): number | null {
    const c = fxCurrency(currency);
    if (!c) return 1;
    const live = this.symbolRow(fxSymbol(c));
    const last = this.repos.db.get<{ date: string; close: number }>('SELECT date, close FROM market_prices WHERE symbol = ? ORDER BY date DESC LIMIT 1', fxSymbol(c));
    if (live?.live_price && (!last || (live.live_date ?? '') >= last.date)) return Number(live.live_price);
    return last ? Number(last.close) : null;
  }

  // ───────── Refresh ─────────

  /** Downloads daily prices for your watchlist, your positions and the exchange rates they need. */
  async refresh(force = false): Promise<StocksRefreshResult> {
    const provider = this.provider();
    const trades = this.trades();
    const open = [...fifo(trades).lots].filter(([, lots]) => lots.length).map(([s]) => s);
    const watched = this.repos.db.all<{ symbol: string }>('SELECT symbol FROM stock_watchlist').map((r) => r.symbol);
    const symbols = [...new Set([...watched, ...open])];
    const failed: StocksRefreshResult['failed'] = [];
    let updated = 0;
    const fresh = (s: string) => {
      const at = this.symbolRow(s)?.fetched_at;
      return !force && at && this.now().getTime() - Date.parse(at) < REFRESH_MINUTES * 60000;
    };
    for (const s of symbols) {
      if (fresh(s)) continue;
      try {
        await this.store(await provider.dailyHistory(s), s);
        updated++;
      } catch (err) {
        failed.push({ symbol: s, message: err instanceof AppError ? err.message : 'Error al consultar la cotización.' });
      }
    }
    const currencies = new Set<string>();
    for (const s of symbols) {
      const c = this.symbolRow(s)?.currency;
      if (c && fxCurrency(c)) currencies.add(fxCurrency(c)!);
    }
    for (const t of trades) if (fxCurrency(t.currency)) currencies.add(fxCurrency(t.currency)!);
    for (const c of currencies) {
      const s = fxSymbol(c);
      if (fresh(s)) continue;
      try {
        await this.store(await provider.dailyHistory(s), s);
      } catch (err) {
        failed.push({ symbol: s, message: err instanceof AppError ? err.message : 'Error al consultar el tipo de cambio.' });
      }
    }
    this.repos.settings.setRaw('stocks.lastRefresh', this.now().toISOString());
    return { updated, failed, overview: this.overview() };
  }

  private store(h: Awaited<ReturnType<NonNullable<MarketProvider['dailyHistory']>>>, symbol: string): void {
    const ts = this.now().toISOString();
    this.repos.db.transaction(() => {
      this.repos.db.run(
        `INSERT INTO market_symbols(symbol, name, currency, exchange, type, live_price, live_date, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, currency = excluded.currency, exchange = excluded.exchange, type = excluded.type,
           live_price = excluded.live_price, live_date = excluded.live_date, fetched_at = excluded.fetched_at`,
        symbol, h.name, h.currency, h.exchange, h.type, h.live?.price ?? null, h.live?.date ?? null, ts,
      );
      for (const p of h.points) {
        this.repos.db.run('INSERT INTO market_prices(symbol, date, close) VALUES (?, ?, ?) ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close', symbol, p.date, p.close);
      }
      // Keep about three years per symbol.
      this.repos.db.run('DELETE FROM market_prices WHERE symbol = ? AND date < ?', symbol, addDays(this.today(), -3 * 366));
    });
  }

  // ───────── Watchlist and trades ─────────

  async addWatch(symbol: string): Promise<StocksOverview> {
    const s = symbol.trim().toUpperCase();
    const count = Number(this.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stock_watchlist')!.n);
    if (count >= MAX_WATCHLIST) throw new AppError('VALIDATION', `Puedes seguir hasta ${MAX_WATCHLIST} valores.`);
    const h = await this.provider().dailyHistory!(s);
    if (h.points.length < 30) throw new AppError('VALIDATION', `«${s}» no tiene suficientes cotizaciones diarias para calcular señales.`);
    this.store(h, s);
    this.repos.db.run('INSERT INTO stock_watchlist(symbol, created_at) VALUES (?, ?) ON CONFLICT(symbol) DO NOTHING', s, this.now().toISOString());
    const c = h.currency ? fxCurrency(h.currency) : null;
    if (c && !this.latestFx(h.currency!)) {
      try {
        this.store(await this.provider().dailyHistory!(fxSymbol(c)), fxSymbol(c));
      } catch {
        // The value in euros will be missing until the next refresh.
      }
    }
    return this.overview();
  }

  removeWatch(symbol: string): StocksOverview {
    this.repos.db.transaction(() => {
      this.repos.db.run('DELETE FROM stock_watchlist WHERE symbol = ?', symbol);
      this.repos.db.run("DELETE FROM stock_signal_state WHERE symbol = ? AND kind IN ('dip_in_uptrend','golden_cross','target_price','oversold_downtrend')", symbol);
    });
    return this.overview();
  }

  setTarget(symbol: string, targetPrice: number | null): StocksOverview {
    const r = this.repos.db.run('UPDATE stock_watchlist SET target_price = ? WHERE symbol = ?', targetPrice, symbol);
    if (!r.changes) throw new AppError('NOT_FOUND', 'Ese valor no está en tu lista de seguimiento.');
    return this.overview();
  }

  addTrade(input: StockTradeInput): StocksOverview {
    const symbol = input.symbol.trim().toUpperCase();
    const currency = input.currency.toUpperCase();
    if (input.date > this.today()) throw new AppError('VALIDATION', 'La fecha de la operación no puede ser futura.');
    const known = this.symbolRow(symbol);
    if (known?.currency && known.currency.toUpperCase() !== currency && !(known.currency === 'GBp' && currency === 'GBP')) {
      throw new AppError('VALIDATION', `«${symbol}» cotiza en ${known.currency}: indica el precio en esa moneda.`);
    }
    // Prices of London stocks are quoted in pence; trades are entered in pounds.
    const tradeCurrency = known?.currency === 'GBp' ? 'GBP' : currency;
    const fx = fxCurrency(tradeCurrency) === null ? 1 : input.fxPerEur ?? this.fxOn(tradeCurrency, input.date);
    if (!fx) throw new AppError('VALIDATION', `Indica el tipo de cambio (${tradeCurrency} por 1 €) de esa fecha: no está en los datos descargados.`);
    const all = this.trades();
    const probe: Trade = { id: Number.MAX_SAFE_INTEGER, symbol, side: input.side, date: input.date, quantity: input.quantity, price: input.price, currency: tradeCurrency, fxPerEur: fx, feesCents: input.feesCents };
    try {
      fifo([...all, probe]);
    } catch (err) {
      if (err instanceof OversellError) {
        throw new AppError('VALIDATION', `No tenías tantas acciones de ${symbol} el ${input.date.split('-').reverse().join('/')}: registra antes la compra (disponibles: ${err.available.toLocaleString('es-ES')}).`);
      }
      throw err;
    }
    const ts = this.now().toISOString();
    this.repos.db.transaction(() => {
      if (!known) {
        this.repos.db.run('INSERT INTO market_symbols(symbol, name, currency) VALUES (?, ?, ?) ON CONFLICT(symbol) DO NOTHING', symbol, symbol, tradeCurrency);
      }
      this.repos.db.run(
        'INSERT INTO stock_trades(symbol, side, date, quantity, price, currency, fx_per_eur, fees_cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        symbol, input.side, input.date, input.quantity, input.price, tradeCurrency, fx, input.feesCents, input.note, ts,
      );
    });
    return this.overview();
  }

  deleteTrade(id: number): StocksOverview {
    const t = this.trades();
    try {
      fifo(t.filter((x) => x.id !== id));
    } catch (err) {
      if (err instanceof OversellError) throw new AppError('VALIDATION', 'No puedes borrar esa compra: hay ventas posteriores que la necesitan. Borra antes la venta.');
      throw err;
    }
    this.repos.db.run('DELETE FROM stock_trades WHERE id = ?', id);
    return this.overview();
  }

  // ───────── Overview ─────────

  private quoteInfo(symbol: string): { info: StockQuoteInfo; ind: Indicators | null; series: DailyClose[]; live: number | null } {
    const row = this.symbolRow(symbol);
    const series = this.series(symbol);
    const live = row?.live_price && row.live_date ? { date: row.live_date, price: Number(row.live_price) } : null;
    const ind = indicators(series, live);
    const lastPrice = ind?.last ?? live?.price ?? series[series.length - 1]?.close ?? null;
    const lastDate = ind?.lastDate ?? live?.date ?? series[series.length - 1]?.date ?? null;
    return {
      info: {
        symbol,
        name: row?.name ?? symbol,
        currency: row?.currency ?? null,
        exchange: row?.exchange ?? null,
        lastPrice,
        lastDate,
        stale: lastDate === null || daysBetween(lastDate, this.today()) > STALE_DAYS,
        sma50: ind?.sma50 ?? null,
        sma200: ind?.sma200 ?? null,
        rsi14: ind?.rsi14 ?? null,
        high52w: ind?.high52w ?? null,
        drawdownBp: ind?.drawdownBp ?? null,
        change1yBp: ind?.change1yBp ?? null,
        sparkline: series.slice(-126).map((p) => p.close),
      },
      ind,
      series,
      live: lastPrice,
    };
  }

  private signalStates(): Map<string, string> {
    return new Map(this.repos.db.all<{ symbol: string; kind: string; active_since: string }>('SELECT * FROM stock_signal_state').map((r) => [`${r.symbol}|${r.kind}`, r.active_since]));
  }

  overview(): StocksOverview {
    const settings = this.repos.settings.getSettings();
    const rules = settings.stocks;
    const today = this.today();
    const states = this.signalStates();
    const dto = (symbol: string, side: 'buy' | 'sell', s: Signal<string>): StockSignalDTO => ({ ...s, side, since: states.get(`${symbol}|${s.kind}`) ?? null });

    const trades = this.trades();
    const { lots, sales } = fifo(trades);
    const names = new Map<string, string>();
    const nameOf = (s: string) => {
      if (!names.has(s)) names.set(s, this.symbolRow(s)?.name ?? s);
      return names.get(s)!;
    };
    const year = today.slice(0, 4);
    const computable = (x: { gainCents: number; washSale: boolean }) => (x.gainCents < 0 && x.washSale ? 0 : x.gainCents);
    const realizedThisYear = sales.filter((s) => s.date.startsWith(year)).reduce((t, s) => t + computable(s), 0);

    // Positions.
    const positions: PositionDTO[] = [];
    for (const [symbol, open] of lots) {
      if (!open.length) continue;
      const q = this.quoteInfo(symbol);
      const shares = Math.round(open.reduce((t, l) => t + l.quantity, 0) * 1e8) / 1e8;
      const costCents = open.reduce((t, l) => t + l.costCents, 0);
      const nativeCost = open.reduce((t, l) => t + l.quantity * l.priceNative, 0);
      const tradeCurrency = trades.find((t) => t.symbol === symbol)?.currency ?? 'EUR';
      const quoteCurrency = q.info.currency ?? tradeCurrency;
      // Purchase prices are in the trade currency (pounds for London stocks quoted in pence).
      const avgPriceNative = quoteCurrency === 'GBp' ? (nativeCost / shares) * 100 : nativeCost / shares;
      const fx = this.latestFx(quoteCurrency);
      const valueCents = q.live !== null && fx ? Math.round(nativeToEur(shares * q.live, quoteCurrency, fx) * 100) : null;
      const gainCents = valueCents === null ? null : valueCents - costCents;
      positions.push({
        ...q.info,
        currency: quoteCurrency,
        shares,
        avgPriceNative,
        firstBuyDate: open[0]!.date,
        costCents,
        valueCents,
        gainCents,
        gainBp: gainCents === null || costCents <= 0 ? null : Math.round((gainCents / costCents) * 10000),
        weightBp: null,
        fxPerEur: fxCurrency(quoteCurrency) ? fx : null,
        estimatedTaxCents: gainCents === null ? null : marginalTaxCents(gainCents, realizedThisYear),
        signals: [],
        warnings: [],
      });
    }
    const priced = positions.filter((p) => p.valueCents !== null);
    const portfolioValue = priced.reduce((t, p) => t + p.valueCents!, 0);
    for (const p of positions) {
      if (p.valueCents !== null && portfolioValue > 0) p.weightBp = Math.round((p.valueCents / portfolioValue) * 10000);
      if (p.valueCents === null) {
        p.warnings.push(this.enabled() ? 'Sin cotización o tipo de cambio todavía: pulsa «Actualizar cotizaciones».' : 'Activa los datos de mercado para valorar esta posición.');
        continue;
      }
      if (p.stale) p.warnings.push(`La última cotización es del ${p.lastDate!.split('-').reverse().join('/')}: las señales esperan a tener datos al día.`);
      const q = this.quoteInfo(p.symbol);
      const pos = { shares: p.shares, costCents: p.costCents, valueCents: p.valueCents, avgPriceNative: p.avgPriceNative, firstBuyDate: p.firstBuyDate };
      const sig = p.stale ? [] : sellSignals(pos, q.ind, peakSince(q.series, p.firstBuyDate, q.live), portfolioValue, priced.length, rules, p.currency);
      p.signals = sig.map((s) => dto(p.symbol, 'sell', s));
      if (p.gainCents !== null && p.gainCents < 0 && boughtWithinTwoMonths(lots.get(p.symbol) ?? [], today)) {
        p.warnings.push('Compraste parte en los últimos 2 meses: si vendes ahora con pérdidas, Hacienda no te deja compensarla hasta que vendas también esas acciones (regla de los dos meses).');
      }
    }
    positions.sort((a, b) => (b.valueCents ?? b.costCents) - (a.valueCents ?? a.costCents));

    // Liquidity check before buying.
    const liq = this.liquidity();
    const surplus = liq.liquidCents !== null && liq.emergencyTargetCents !== null ? liq.liquidCents - liq.emergencyTargetCents : null;
    const maxNew = surplus === null ? null : Math.max(0, Math.min(surplus, Math.round(((portfolioValue + Math.max(0, surplus)) * rules.maxPositionPct) / 100)));
    const liquidity: StocksOverview['liquidity'] = {
      liquidCents: liq.liquidCents,
      emergencyTargetCents: liq.emergencyTargetCents,
      surplusCents: surplus,
      maxNewPositionCents: maxNew,
      ok: surplus !== null && surplus > 0,
      note: liq.liquidCents === null
        ? 'Indica el saldo de tus cuentas en «Cuentas» para comprobar si puedes invertir sin tocar tu colchón.'
        : liq.emergencyTargetCents === null || liq.emergencyTargetCents <= 0
          ? 'Aún no hay datos suficientes para estimar tu fondo de emergencia: invierte solo dinero que no vayas a necesitar en años.'
          : surplus! <= 0
            ? `Tu liquidez (${formatCents(liq.liquidCents)}) no cubre tu fondo de emergencia recomendado (${formatCents(liq.emergencyTargetCents)}). Antes de comprar acciones, complétalo.`
            : `Tienes ${formatCents(surplus!)} por encima de tu fondo de emergencia recomendado (${formatCents(liq.emergencyTargetCents)}). Con tu límite del ${rules.maxPositionPct} % por valor, una compra nueva no debería superar ${formatCents(maxNew!)}.`,
    };

    // Watchlist.
    const held = new Set(positions.map((p) => p.symbol));
    const watchlist: WatchItemDTO[] = this.repos.db
      .all<{ symbol: string; target_price: number | null }>('SELECT symbol, target_price FROM stock_watchlist ORDER BY created_at, symbol')
      .map((w) => {
        const q = this.quoteInfo(w.symbol);
        const target = w.target_price === null ? null : Number(w.target_price);
        const warnings: string[] = [];
        let signals: StockSignalDTO[] = [];
        if (!q.ind) warnings.push('Sin cotizaciones suficientes todavía.');
        else if (q.info.stale) warnings.push(`La última cotización es del ${q.info.lastDate!.split('-').reverse().join('/')}.`);
        else signals = buySignals(q.ind, rules, { targetPrice: target, currency: q.info.currency }).map((s) => dto(w.symbol, 'buy', s));
        const loss = recentLossSale(sales, w.symbol, today);
        if (loss) warnings.push(`Vendiste con pérdidas el ${loss.date.split('-').reverse().join('/')}: si recompras antes del ${addMonthsLabel(loss.date)}, no podrás compensar esa pérdida en la renta hasta vender estas acciones (regla de los dos meses).`);
        if (signals.length && !liquidity.ok && liq.liquidCents !== null) warnings.push('Tu liquidez no cubre tu fondo de emergencia: no es buen momento para comprar.');
        return { ...q.info, targetPrice: target, held: held.has(w.symbol), signals, warnings };
      });

    // Realised gains by year.
    const byYear = new Map<number, RealizedYearDTO>();
    for (const s of sales) {
      const y = Number(s.date.slice(0, 4));
      const r = byYear.get(y) ?? { year: y, gainsCents: 0, lossesCents: 0, netCents: 0, deferredLossCents: 0, estimatedTaxCents: 0, sales: [] };
      if (s.gainCents >= 0) r.gainsCents += s.gainCents;
      else if (s.washSale) r.deferredLossCents += -s.gainCents;
      else r.lossesCents += -s.gainCents;
      r.sales.push({ ...s, name: nameOf(s.symbol) });
      byYear.set(y, r);
    }
    for (const r of byYear.values()) {
      r.netCents = r.gainsCents - r.lossesCents;
      r.estimatedTaxCents = savingsTaxCents(r.netCents);
      r.sales.sort((a, b) => b.date.localeCompare(a.date));
    }

    const tradeDTOs: StockTradeDTO[] = [...trades].reverse().map((t) => {
      const gross = Math.round(nativeToEur(t.quantity * t.price, t.currency, t.fxPerEur) * 100);
      return { ...t, name: nameOf(t.symbol), totalCents: t.side === 'buy' ? gross + t.feesCents : gross - t.feesCents, note: this.noteOf(t.id) };
    });

    const costPriced = priced.reduce((t, p) => t + p.costCents, 0);
    return {
      marketEnabled: settings.marketDataEnabled,
      source: this.market?.source ?? null,
      lastRefreshAt: this.repos.settings.getRaw<string>('stocks.lastRefresh'),
      rules,
      liquidity,
      portfolio: {
        valueCents: portfolioValue,
        costCents: costPriced,
        gainCents: portfolioValue - costPriced,
        gainBp: costPriced > 0 ? Math.round(((portfolioValue - costPriced) / costPriced) * 10000) : null,
        pricedPositions: priced.length,
        positions: positions.length,
        estimatedTaxCents: marginalTaxCents(portfolioValue - costPriced, realizedThisYear),
        realizedThisYearCents: realizedThisYear,
        note: positions.length > 0 && positions.length * rules.maxPositionPct < 100
          ? `Tienes ${positions.length === 1 ? '1 valor' : `${positions.length} valores`}: con tu límite del ${rules.maxPositionPct} % por valor necesitarías al menos ${Math.ceil(100 / rules.maxPositionPct)} para estar diversificado. Un fondo o ETF indexado reparte el riesgo entre cientos de empresas.`
          : null,
      },
      positions,
      watchlist,
      trades: tradeDTOs,
      realized: [...byYear.values()].sort((a, b) => b.year - a.year),
    };
  }

  /**
   * Value in euros of the shares you held at the end of a date (for net worth and its history). Positions without
   * a price (or exchange rate) on that date count at what they cost you.
   */
  valueAt(date: IsoDate): { valueCents: number; costCents: number } {
    const trades = this.trades().filter((t) => t.date <= date);
    if (!trades.length) return { valueCents: 0, costCents: 0 };
    let value = 0;
    let cost = 0;
    for (const [symbol, lots] of fifo(trades).lots) {
      if (!lots.length) continue;
      const shares = lots.reduce((t, l) => t + l.quantity, 0);
      const lotCost = lots.reduce((t, l) => t + l.costCents, 0);
      cost += lotCost;
      const row = this.symbolRow(symbol);
      const close = this.repos.db.get<{ close: number }>('SELECT close FROM market_prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1', symbol, date);
      const lastClose = this.repos.db.get<{ date: string }>('SELECT MAX(date) AS date FROM market_prices WHERE symbol = ?', symbol);
      const useLive = row?.live_price && row.live_date && row.live_date <= date && (!lastClose?.date || row.live_date >= lastClose.date);
      const price = useLive ? Number(row!.live_price) : close ? Number(close.close) : null;
      const currency = row?.currency ?? trades.find((t) => t.symbol === symbol)!.currency;
      const fx = date >= this.today() ? this.latestFx(currency) : this.fxOn(currency, date);
      value += price !== null && fx ? Math.round(nativeToEur(shares * price, currency, fx) * 100) : lotCost;
    }
    return { valueCents: value, costCents: cost };
  }

  private noteOf(id: number): string | null {
    return this.repos.db.get<{ note: string | null }>('SELECT note FROM stock_trades WHERE id = ?', id)?.note ?? null;
  }

  // ───────── Alerts ─────────

  /**
   * Tracks when each signal starts and returns one alert per episode (a signal that stops and starts again alerts
   * again). Weak signals and out-of-date prices never alert.
   */
  alerts(): NewAlert[] {
    const settings = this.repos.settings.getSettings();
    if (!settings.marketDataEnabled) return [];
    const o = this.overview();
    const today = this.today();
    const active: { symbol: string; name: string; side: 'buy' | 'sell'; s: StockSignalDTO; warnings: string[]; extra: string }[] = [];
    const evaluated = new Set<string>();
    for (const w of o.watchlist) {
      if (w.stale || w.lastPrice === null) continue;
      evaluated.add(`${w.symbol}|buy`);
      for (const s of w.signals) active.push({ symbol: w.symbol, name: w.name, side: 'buy', s, warnings: w.warnings, extra: o.liquidity.ok ? '' : ' Antes de comprar, completa tu fondo de emergencia.' });
    }
    for (const p of o.positions) {
      if (p.stale || p.valueCents === null) continue;
      evaluated.add(`${p.symbol}|sell`);
      const g = p.gainCents ?? 0;
      const extra = ` Resultado si vendes todo: ${formatCents(g, { signed: true })}${g > 0 && p.estimatedTaxCents ? ` (unos ${formatCents(p.estimatedTaxCents)} de IRPF)` : ''}.`;
      for (const s of p.signals) active.push({ symbol: p.symbol, name: p.name, side: 'sell', s, warnings: p.warnings, extra });
    }
    const out: NewAlert[] = [];
    this.repos.db.transaction(() => {
      const states = this.signalStates();
      const activeKeys = new Set(active.map((a) => `${a.symbol}|${a.s.kind}`));
      // Signals that stopped (only for symbols evaluated with fresh data) end their episode.
      for (const key of states.keys()) {
        const [symbol, kind] = key.split('|') as [string, string];
        const side = SELL_KINDS.has(kind) ? 'sell' : 'buy';
        if (!activeKeys.has(key) && (evaluated.has(`${symbol}|${side}`) || !this.isTracked(symbol))) {
          this.repos.db.run('DELETE FROM stock_signal_state WHERE symbol = ? AND kind = ?', symbol, kind);
        }
      }
      for (const a of active) {
        const key = `${a.symbol}|${a.s.kind}`;
        let since = states.get(key);
        if (!since) {
          since = today;
          this.repos.db.run('INSERT INTO stock_signal_state(symbol, kind, active_since) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', a.symbol, a.s.kind, since);
        }
        if (!settings.stocks.notify || !NOTIFY_STRENGTHS.has(a.s.strength)) continue;
        out.push({
          key: `stock:${a.symbol}:${a.s.kind}:${since}`,
          kind: a.side === 'buy' ? 'stock_buy' : 'stock_sell',
          title: `${a.side === 'buy' ? 'Oportunidad' : 'Revisa tu posición'}: ${a.name} (${a.symbol})`,
          body: `${a.s.title}. ${a.s.detail}${a.extra}`,
          page: 'stocks',
          section: a.side === 'buy' ? 'watchlist' : 'positions',
        });
      }
    });
    return out;
  }

  private isTracked(symbol: string): boolean {
    return !!this.repos.db.get('SELECT 1 FROM stock_watchlist WHERE symbol = ?', symbol) || this.trades().some((t) => t.symbol === symbol);
  }
}

const SELL_KINDS = new Set(['stop_loss', 'trailing_stop', 'take_profit', 'trend_break', 'concentration']);

function addMonthsLabel(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m + 1, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${String(Math.min(d, last)).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${t.getUTCFullYear()}`;
}
