import { toIso } from '../../shared/dates';
import { AppError } from '../errors';
import type { PricePoint } from '../domain/returns';
import type { DailyClose } from '../domain/stocks';

/*
 * Public market data used ONLY to look up past returns of a fund/ETF/stock the user chooses.
 * What leaves the computer: the search text (name, ticker or ISIN) or the chosen symbol. Never amounts, positions,
 * movements or any personal data. Yahoo Finance's chart/search endpoints are public but unofficial: they may change.
 */

export interface MarketQuote {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

export interface MarketHistory {
  symbol: string;
  name: string;
  currency: string | null;
  points: PricePoint[];
}

export interface DailyHistory {
  symbol: string;
  name: string;
  currency: string | null;
  exchange: string | null;
  type: string | null;
  /** Latest quote (may be intraday or delayed). */
  live: { date: string; price: number } | null;
  /** Daily closes (not adjusted for dividends: comparable with your purchase price), ascending. */
  points: DailyClose[];
}

export interface MarketProvider {
  readonly source: string;
  search(query: string): Promise<MarketQuote[]>;
  monthlyHistory(symbol: string): Promise<MarketHistory>;
  /** Last ~2 years of daily closes. */
  dailyHistory?(symbol: string): Promise<DailyHistory>;
}

type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,24}$/;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Hormiga personal finance)', Accept: 'application/json' };

export class YahooMarketProvider implements MarketProvider {
  readonly source = 'Yahoo Finance (datos públicos, no oficial)';

  constructor(private readonly fetchFn: FetchFn = fetch as unknown as FetchFn) {}

  private async get(url: string): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new AppError('MARKET_OFFLINE', 'No se pudo conectar con el servicio de datos de mercado. Comprueba tu conexión.', err);
    }
    if (res.status === 429) throw new AppError('MARKET_ERROR', 'El servicio de datos de mercado ha limitado las consultas. Inténtalo en unos minutos.');
    if (!res.ok) throw new AppError('MARKET_ERROR', `El servicio de datos de mercado respondió con un error (HTTP ${res.status}).`);
    return res.json();
  }

  async search(query: string): Promise<MarketQuote[]> {
    const q = query.trim().slice(0, 60);
    if (!q) return [];
    const data = (await this.get(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`)) as {
      quotes?: { symbol?: string; shortname?: string; longname?: string; quoteType?: string; exchDisp?: string; exchange?: string }[];
    };
    return (data.quotes ?? [])
      .filter((x) => x.symbol && SYMBOL_RE.test(x.symbol) && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(x.quoteType ?? ''))
      .map((x) => ({ symbol: x.symbol!, name: x.longname ?? x.shortname ?? x.symbol!, type: x.quoteType!, exchange: x.exchDisp ?? x.exchange ?? '' }));
  }

  async monthlyHistory(symbol: string): Promise<MarketHistory> {
    if (!SYMBOL_RE.test(symbol)) throw new AppError('VALIDATION', 'Símbolo no válido.');
    const data = (await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1mo&events=div,split`)) as {
      chart?: {
        error?: { description?: string } | null;
        result?: { meta?: { currency?: string; longName?: string; shortName?: string; symbol?: string }; timestamp?: number[]; indicators?: { adjclose?: { adjclose?: (number | null)[] }[]; quote?: { close?: (number | null)[] }[] } }[];
      };
    };
    const r = data.chart?.result?.[0];
    if (!r || !r.timestamp?.length) throw new AppError('NOT_FOUND', `No hay histórico disponible para «${symbol}».`);
    const prices = r.indicators?.adjclose?.[0]?.adjclose ?? r.indicators?.quote?.[0]?.close ?? [];
    const points: PricePoint[] = [];
    r.timestamp.forEach((t, i) => {
      const p = prices[i];
      if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return;
      const d = new Date(t * 1000);
      points.push({ date: toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), price: p });
    });
    return { symbol: r.meta?.symbol ?? symbol, name: r.meta?.longName ?? r.meta?.shortName ?? symbol, currency: r.meta?.currency ?? null, points };
  }

  async dailyHistory(symbol: string): Promise<DailyHistory> {
    if (!SYMBOL_RE.test(symbol)) throw new AppError('VALIDATION', 'Símbolo no válido.');
    const data = (await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`)) as {
      chart?: {
        result?: {
          meta?: { currency?: string; longName?: string; shortName?: string; symbol?: string; fullExchangeName?: string; exchangeName?: string; instrumentType?: string; regularMarketPrice?: number; regularMarketTime?: number; gmtoffset?: number };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const r = data.chart?.result?.[0];
    if (!r || !r.timestamp?.length) throw new AppError('NOT_FOUND', `No hay cotizaciones disponibles para «${symbol}».`);
    const offset = r.meta?.gmtoffset ?? 0;
    // Session date in the exchange's own time zone.
    const day = (t: number) => {
      const d = new Date((t + offset) * 1000);
      return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    };
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const points: DailyClose[] = [];
    r.timestamp.forEach((t, i) => {
      const p = closes[i];
      if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return;
      const date = day(t);
      if (points.length && points[points.length - 1]!.date === date) points[points.length - 1] = { date, close: p };
      else points.push({ date, close: p });
    });
    const m = r.meta ?? {};
    const live = typeof m.regularMarketPrice === 'number' && m.regularMarketPrice > 0 && m.regularMarketTime ? { date: day(m.regularMarketTime), price: m.regularMarketPrice } : null;
    return {
      symbol: m.symbol ?? symbol,
      name: m.longName ?? m.shortName ?? symbol,
      currency: m.currency ?? null,
      exchange: m.fullExchangeName ?? m.exchangeName ?? null,
      type: m.instrumentType ?? null,
      live,
      points,
    };
  }
}
