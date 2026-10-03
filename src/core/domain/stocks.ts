import type { Cents } from '../../shared/money';
import type { IsoDate } from '../../shared/dates';

/*
 * Stock watchlist signals and portfolio maths. Everything here is deterministic and explainable: each signal is a
 * fixed rule over public daily closing prices (moving averages, RSI, distance to the 52-week high) or over your own
 * positions (stop-loss, trailing stop, take-profit, concentration). They are not personalised investment advice.
 *
 * Money in euros is always integer cents. Share quantities and native prices are floating point (fractional shares,
 * prices with 4 decimals), rounded where they become euros.
 */

export interface DailyClose {
  date: IsoDate;
  close: number;
}

export interface StockRules {
  /** Loss on the position (in euros, fees included) that triggers a stop-loss warning, in %. */
  stopLossPct: number;
  /** Fall from the highest close since you bought that triggers a trailing-stop warning, in %. */
  trailingStopPct: number;
  /** Gain on the position that suggests taking (part of) the profit, in %. */
  takeProfitPct: number;
  /** Minimum fall from the 52-week high for a "dip in an uptrend" buy signal, in %. */
  dipPct: number;
  /** Maximum weight of one stock in your portfolio, in %. */
  maxPositionPct: number;
}

export const DEFAULT_STOCK_RULES: StockRules = { stopLossPct: 15, trailingStopPct: 20, takeProfitPct: 30, dipPct: 10, maxPositionPct: 20 };

// ───────── Indicators ─────────

export function sma(values: number[], period: number, end = values.length - 1): number | null {
  if (period <= 0 || end < period - 1 || end >= values.length) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += values[i]!;
  return s / period;
}

/** Wilder's RSI over the whole series; the value at `end`. Null with fewer than period + 1 closes. */
export function rsi(values: number[], period = 14, end = values.length - 1): number | null {
  if (end < period || end >= values.length) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i <= end; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export interface Indicators {
  lastDate: IsoDate;
  last: number;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  high52w: number;
  low52w: number;
  /** Fall from the 52-week high, in basis points (positive = below the high). */
  drawdownBp: number;
  /** Change over the last ~12 months (252 sessions), in basis points. */
  change1yBp: number | null;
  /** SMA50 crossed above SMA200 in the last 5 sessions. */
  goldenCross: boolean;
  /** SMA50 crossed below SMA200 in the last 5 sessions. */
  deathCross: boolean;
  /** The close crossed below SMA200 in the last 5 sessions (it was above before). */
  brokeBelowSma200: boolean;
}

const bp = (x: number) => Math.round(x * 10000);

/**
 * Indicators from daily closes (ascending dates). `lastPrice` (the live quote) replaces the last close when given
 * and newer. Null when there are fewer than 30 closes.
 */
export function indicators(series: DailyClose[], live?: { date: IsoDate; price: number } | null): Indicators | null {
  const s = [...series];
  if (live && live.price > 0) {
    if (s.length && s[s.length - 1]!.date === live.date) s[s.length - 1] = { date: live.date, close: live.price };
    else if (!s.length || live.date > s[s.length - 1]!.date) s.push({ date: live.date, close: live.price });
  }
  if (s.length < 30) return null;
  const c = s.map((x) => x.close);
  const end = c.length - 1;
  const last = c[end]!;
  const window = c.slice(Math.max(0, c.length - 252));
  const high = Math.max(...window);
  const low = Math.min(...window);
  const cross = (dir: 1 | -1) => {
    for (let i = end; i > end - 5 && i > 0; i--) {
      const a = sma(c, 50, i), b = sma(c, 200, i), pa = sma(c, 50, i - 1), pb = sma(c, 200, i - 1);
      if (a === null || b === null || pa === null || pb === null) return false;
      if (dir === 1 ? pa <= pb && a > b : pa >= pb && a < b) return true;
    }
    return false;
  };
  let broke = false;
  for (let i = end; i > end - 5 && i > 0; i--) {
    const m = sma(c, 200, i), pm = sma(c, 200, i - 1);
    if (m === null || pm === null) break;
    if (c[i - 1]! >= pm && c[i]! < m) {
      broke = c[end]! < sma(c, 200)!;
      break;
    }
  }
  return {
    lastDate: s[end]!.date,
    last,
    sma50: sma(c, 50),
    sma200: sma(c, 200),
    rsi14: rsi(c, 14),
    high52w: high,
    low52w: low,
    drawdownBp: high > 0 ? bp((high - last) / high) : 0,
    change1yBp: c.length > 252 ? bp(last / c[end - 252]! - 1) : null,
    goldenCross: cross(1),
    deathCross: cross(-1),
    brokeBelowSma200: broke,
  };
}

// ───────── Signals ─────────

export type BuySignalKind = 'dip_in_uptrend' | 'golden_cross' | 'target_price' | 'oversold_downtrend';
export type SellSignalKind = 'stop_loss' | 'trailing_stop' | 'take_profit' | 'trend_break' | 'concentration';
export type SignalStrength = 'strong' | 'moderate' | 'weak';

export interface Signal<K extends string> {
  kind: K;
  strength: SignalStrength;
  title: string;
  /** Why it fired, with the numbers. */
  detail: string;
}

const pct = (x: number, digits = 1) => `${x.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
const price = (x: number, currency: string | null) => `${x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;

export function buySignals(ind: Indicators, rules: StockRules, opts: { targetPrice: number | null; currency: string | null }): Signal<BuySignalKind>[] {
  const out: Signal<BuySignalKind>[] = [];
  const cur = opts.currency;
  const uptrend = ind.sma200 !== null && ind.sma50 !== null && ind.last > ind.sma200 && ind.sma50 > ind.sma200;
  const dd = ind.drawdownBp / 100;
  if (uptrend && dd >= rules.dipPct && ind.rsi14 !== null && ind.rsi14 <= 40) {
    out.push({
      kind: 'dip_in_uptrend',
      strength: ind.rsi14 <= 30 ? 'strong' : 'moderate',
      title: 'Corrección dentro de una tendencia alcista',
      detail: `Cotiza un ${pct(dd)} por debajo de su máximo de 52 semanas (${price(ind.high52w, cur)}) pero sigue por encima de su media de 200 sesiones (${price(ind.sma200!, cur)}), y el RSI(14) está en ${ind.rsi14.toFixed(0)} (por debajo de 40 indica que la caída ha sido fuerte).`,
    });
  }
  if (ind.goldenCross && ind.sma200 !== null && ind.last > ind.sma200) {
    out.push({
      kind: 'golden_cross',
      strength: 'moderate',
      title: 'Cruce dorado',
      detail: `La media de 50 sesiones (${price(ind.sma50!, cur)}) acaba de cruzar por encima de la de 200 (${price(ind.sma200, cur)}): suele marcar el inicio de una tendencia alcista, aunque llega con retraso.`,
    });
  }
  if (opts.targetPrice !== null && ind.last <= opts.targetPrice) {
    out.push({
      kind: 'target_price',
      strength: 'strong',
      title: 'Ha llegado a tu precio objetivo',
      detail: `Cotiza a ${price(ind.last, cur)}, en o por debajo del precio de compra que fijaste (${price(opts.targetPrice, cur)}).`,
    });
  }
  if (!uptrend && ind.sma200 !== null && ind.last < ind.sma200 && ind.rsi14 !== null && ind.rsi14 <= 25) {
    out.push({
      kind: 'oversold_downtrend',
      strength: 'weak',
      title: 'Sobreventa en tendencia bajista (arriesgado)',
      detail: `El RSI(14) está en ${ind.rsi14.toFixed(0)}, muy bajo, pero cotiza por debajo de su media de 200 sesiones (${price(ind.sma200, cur)}): puede rebotar o seguir cayendo. Solo para quien acepta más riesgo.`,
    });
  }
  return out;
}

export interface PositionState {
  shares: number;
  /** What the open shares cost you, in euros (fees included, FIFO). */
  costCents: Cents;
  valueCents: Cents;
  /** Average purchase price of the open shares, in the stock's currency. */
  avgPriceNative: number;
  firstBuyDate: IsoDate;
}

/** Highest close since a date (inclusive), or null. */
export function peakSince(series: DailyClose[], since: IsoDate, live?: number | null): number | null {
  let peak: number | null = null;
  for (const p of series) if (p.date >= since && (peak === null || p.close > peak)) peak = p.close;
  if (live && live > 0 && (peak === null || live > peak)) peak = live;
  return peak;
}

export function sellSignals(
  pos: PositionState,
  ind: Indicators | null,
  peak: number | null,
  portfolioValueCents: Cents,
  positionsCount: number,
  rules: StockRules,
  currency: string | null,
): Signal<SellSignalKind>[] {
  const out: Signal<SellSignalKind>[] = [];
  if (pos.costCents <= 0 || pos.shares <= 0) return out;
  const ret = (pos.valueCents - pos.costCents) / pos.costCents;
  const retPct = ret * 100;
  const stop = retPct <= -rules.stopLossPct;
  if (stop) {
    out.push({
      kind: 'stop_loss',
      strength: 'strong',
      title: 'Stop-loss alcanzado',
      detail: `La posición pierde un ${pct(-retPct)} (tu límite es ${pct(rules.stopLossPct, 0)}). Vender limita la pérdida; mantener solo tiene sentido si las razones por las que compraste siguen vigentes.`,
    });
  }
  if (!stop && ind && peak !== null && peak > pos.avgPriceNative) {
    const fall = ((peak - ind.last) / peak) * 100;
    if (fall >= rules.trailingStopPct) {
      out.push({
        kind: 'trailing_stop',
        strength: 'strong',
        title: 'Stop dinámico: ha caído desde su máximo',
        detail: `Desde tu compra llegó a ${price(peak, currency)} y ahora cotiza a ${price(ind.last, currency)}: un ${pct(fall)} menos (tu límite es ${pct(rules.trailingStopPct, 0)}). Vender ahora protege la ganancia que queda.`,
      });
    }
  }
  if (retPct >= rules.takeProfitPct) {
    out.push({
      kind: 'take_profit',
      strength: 'moderate',
      title: 'Objetivo de beneficio alcanzado',
      detail: `La posición gana un ${pct(retPct)} (tu objetivo es ${pct(rules.takeProfitPct, 0)}). Puedes vender una parte para asegurar beneficio o subir tu stop.`,
    });
  }
  if (ind?.brokeBelowSma200) {
    out.push({
      kind: 'trend_break',
      strength: 'moderate',
      title: 'Ha perdido su media de 200 sesiones',
      detail: `Ha cerrado por debajo de su media de 200 sesiones (${price(ind.sma200!, currency)}), señal habitual de cambio a tendencia bajista.${ind.deathCross ? ' Además, la media de 50 ha cruzado por debajo de la de 200 (cruce de la muerte).' : ''}`,
    });
  }
  // Only when the portfolio has enough positions to respect the limit (with 20 %, at least 5); otherwise it is a
  // portfolio-level note, not a reason to sell this stock.
  if (positionsCount >= 2 && positionsCount * rules.maxPositionPct >= 100 && portfolioValueCents > 0) {
    const weight = (pos.valueCents / portfolioValueCents) * 100;
    if (weight > rules.maxPositionPct) {
      out.push({
        kind: 'concentration',
        strength: 'weak',
        title: 'Pesa demasiado en tu cartera',
        detail: `Supone el ${pct(weight)} de tu cartera de acciones (tu máximo es ${pct(rules.maxPositionPct, 0)}). Reducirla diversifica el riesgo.`,
      });
    }
  }
  return out;
}

// ───────── Trades, FIFO and taxes (Spain) ─────────

export interface Trade {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  date: IsoDate;
  quantity: number;
  /** Price per share in `currency`. */
  price: number;
  currency: string;
  /** Units of `currency` per 1 € on the trade date (1 for EUR). */
  fxPerEur: number;
  feesCents: Cents;
}

/** Converts a price in a quote currency to euros. London quotes in pence (GBp/GBX) are divided by 100. */
export function nativeToEur(amount: number, currency: string, fxPerEur: number): number {
  const units = currency === 'GBp' || currency === 'GBX' ? amount / 100 : amount;
  return units / fxPerEur;
}

/** The currency whose EUR rate is needed (GBp → GBP), or null for euros. */
export function fxCurrency(currency: string): string | null {
  if (currency === 'GBp' || currency === 'GBX') return 'GBP';
  return currency.toUpperCase() === 'EUR' ? null : currency.toUpperCase();
}

export interface Lot {
  tradeId: number;
  date: IsoDate;
  quantity: number;
  priceNative: number;
  /** Remaining cost in euros cents (fees included), proportional to the remaining quantity. */
  costCents: Cents;
}

export interface RealizedSale {
  tradeId: number;
  symbol: string;
  date: IsoDate;
  quantity: number;
  proceedsCents: Cents;
  costCents: Cents;
  gainCents: Cents;
  /** Loss that may not be deductible yet: homogeneous shares bought within 2 months before or after (art. 33.5.f LIRPF). */
  washSale: boolean;
}

export interface FifoResult {
  lots: Map<string, Lot[]>;
  sales: RealizedSale[];
}

const EPS = 1e-9;
const roundQty = (q: number) => Math.round(q * 1e8) / 1e8;

export class OversellError extends Error {
  constructor(readonly symbol: string, readonly date: IsoDate, readonly available: number) {
    super(`oversell ${symbol}`);
  }
}

function addMonthsToDate(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Spanish rule: shares are sold in the order they were bought (FIFO), per stock. Euros are fixed with each trade's
 * own exchange rate (gains include the currency effect, as Hacienda computes them).
 */
export function fifo(trades: Trade[]): FifoResult {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date) || (a.side === b.side ? a.id - b.id : a.side === 'buy' ? -1 : 1));
  const lots = new Map<string, Lot[]>();
  const sales: RealizedSale[] = [];
  for (const t of sorted) {
    const list = lots.get(t.symbol) ?? [];
    lots.set(t.symbol, list);
    const gross = Math.round(nativeToEur(t.quantity * t.price, t.currency, t.fxPerEur) * 100);
    if (t.side === 'buy') {
      list.push({ tradeId: t.id, date: t.date, quantity: t.quantity, priceNative: t.price, costCents: gross + t.feesCents });
      continue;
    }
    const available = list.reduce((s, l) => s + l.quantity, 0);
    if (t.quantity > available + EPS) throw new OversellError(t.symbol, t.date, roundQty(available));
    let left = t.quantity;
    let cost = 0;
    while (left > EPS && list.length) {
      const lot = list[0]!;
      const take = Math.min(lot.quantity, left);
      const part = take >= lot.quantity - EPS ? lot.costCents : Math.round((lot.costCents * take) / lot.quantity);
      cost += part;
      lot.costCents -= part;
      lot.quantity = roundQty(lot.quantity - take);
      left = roundQty(left - take);
      if (lot.quantity <= EPS) list.shift();
    }
    const proceeds = gross - t.feesCents;
    // Shares bought in the two months before the sale and still held after it defer a loss.
    const heldRecent = list.some((l) => l.date >= addMonthsToDate(t.date, -2));
    sales.push({ tradeId: t.id, symbol: t.symbol, date: t.date, quantity: t.quantity, proceedsCents: proceeds, costCents: cost, gainCents: proceeds - cost, washSale: heldRecent && proceeds - cost < 0 });
  }
  // …and so does a repurchase in the two months after it.
  for (const s of sales) {
    if (s.gainCents >= 0 || s.washSale) continue;
    const to = addMonthsToDate(s.date, 2);
    s.washSale = sorted.some((t) => t.symbol === s.symbol && t.side === 'buy' && t.date > s.date && t.date <= to);
  }
  return { lots, sales };
}

/** Spanish savings tax scale (base del ahorro), from 2025: [up to €, rate %]. */
export const SAVINGS_TAX_BRACKETS: readonly [number, number][] = [
  [6000, 19],
  [50000, 21],
  [200000, 23],
  [300000, 27],
  [Infinity, 30],
];

/** Tax on a savings base (cents), with the progressive scale. */
export function savingsTaxCents(baseCents: Cents): Cents {
  if (baseCents <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const [limitEuros, rate] of SAVINGS_TAX_BRACKETS) {
    const limit = limitEuros === Infinity ? Infinity : limitEuros * 100;
    const slice = Math.min(baseCents, limit) - prev;
    if (slice > 0) tax += (slice * rate) / 100;
    if (baseCents <= limit) break;
    prev = limit;
  }
  return Math.round(tax);
}

/** Extra tax caused by an additional gain, given the net gains already realised this year. */
export function marginalTaxCents(gainCents: Cents, realizedThisYearCents: Cents): Cents {
  if (gainCents <= 0) return 0;
  const base = Math.max(0, realizedThisYearCents);
  return savingsTaxCents(base + gainCents) - savingsTaxCents(base);
}

/** Loss sold within the last two months: buying again now would defer that loss. */
export function recentLossSale(sales: RealizedSale[], symbol: string, today: IsoDate): RealizedSale | null {
  const from = addMonthsToDate(today, -2);
  return sales.filter((s) => s.symbol === symbol && s.gainCents < 0 && s.date >= from && s.date <= today).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** Shares bought within the last two months: selling them at a loss now would defer that loss. */
export function boughtWithinTwoMonths(lots: Lot[], today: IsoDate): boolean {
  const from = addMonthsToDate(today, -2);
  return lots.some((l) => l.date >= from);
}

export { addMonthsToDate as addMonthsToIsoDate };
