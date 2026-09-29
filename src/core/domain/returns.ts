import { addDays, daysBetween, type IsoDate } from '../../shared/dates';

export interface PricePoint {
  date: IsoDate;
  /** Adjusted close (dividends reinvested) when available. */
  price: number;
}

export interface HistoricalReturns {
  firstDate: IsoDate;
  lastDate: IsoDate;
  years: number;
  /** Annualised returns (CAGR) in basis points; null when there is not enough history. */
  cagr: { y1: number | null; y3: number | null; y5: number | null; y10: number | null; all: number | null };
  ytdBp: number | null;
  /** Annualised volatility of monthly returns over the last 5 years (or all history), in basis points. */
  volatilityBp: number | null;
  /** Worst peak-to-trough fall of the series, in basis points (negative). */
  maxDrawdownBp: number | null;
  worstYearBp: number | null;
  bestYearBp: number | null;
}

const bp = (x: number) => Math.round(x * 10000);

/** Price on or before `date`, accepting up to 35 days of gap (monthly series). */
function priceAt(points: PricePoint[], date: IsoDate): PricePoint | null {
  let best: PricePoint | null = null;
  for (const p of points) if (p.date <= date) best = p;
  return best && daysBetween(best.date, date) <= 35 ? best : null;
}

function cagrOver(points: PricePoint[], years: number): number | null {
  const last = points[points.length - 1]!;
  const start = priceAt(points, addDays(last.date, -Math.round(years * 365.25)));
  if (!start || start.price <= 0) return null;
  return bp(Math.pow(last.price / start.price, 1 / years) - 1);
}

/** Past performance statistics of a price series. Past returns do not guarantee future returns. */
export function historicalReturns(input: PricePoint[]): HistoricalReturns | null {
  const points = input.filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const years = daysBetween(first.date, last.date) / 365.25;

  const prevYearEnd = priceAt(points, `${Number(last.date.slice(0, 4)) - 1}-12-31`);
  const monthly: number[] = [];
  const recent = points.filter((p) => p.date >= addDays(last.date, -Math.round(5 * 365.25)));
  for (let i = 1; i < recent.length; i++) monthly.push(Math.log(recent[i]!.price / recent[i - 1]!.price));
  let vol: number | null = null;
  if (monthly.length >= 12) {
    const mean = monthly.reduce((a, b) => a + b, 0) / monthly.length;
    vol = Math.sqrt(monthly.reduce((a, r) => a + (r - mean) ** 2, 0) / (monthly.length - 1)) * Math.sqrt(12);
  }
  let peak = first.price;
  let dd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.price);
    dd = Math.min(dd, p.price / peak - 1);
  }
  // Calendar-year returns for complete years inside the series.
  const yearly: number[] = [];
  for (let y = Number(first.date.slice(0, 4)) + 1; y < Number(last.date.slice(0, 4)); y++) {
    const a = priceAt(points, `${y - 1}-12-31`);
    const b = priceAt(points, `${y}-12-31`);
    if (a && b) yearly.push(b.price / a.price - 1);
  }
  return {
    firstDate: first.date,
    lastDate: last.date,
    years: Math.round(years * 10) / 10,
    cagr: {
      y1: years >= 0.95 ? cagrOver(points, 1) : null,
      y3: years >= 2.95 ? cagrOver(points, 3) : null,
      y5: years >= 4.95 ? cagrOver(points, 5) : null,
      y10: years >= 9.95 ? cagrOver(points, 10) : null,
      all: years >= 0.95 ? bp(Math.pow(last.price / first.price, 1 / years) - 1) : null,
    },
    ytdBp: prevYearEnd ? bp(last.price / prevYearEnd.price - 1) : null,
    volatilityBp: vol === null ? null : bp(vol),
    maxDrawdownBp: bp(dd),
    worstYearBp: yearly.length ? bp(Math.min(...yearly)) : null,
    bestYearBp: yearly.length ? bp(Math.max(...yearly)) : null,
  };
}
