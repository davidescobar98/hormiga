/** Calendar dates are ISO strings "YYYY-MM-DD"; months are "YYYY-MM". No time zones involved. */
export type IsoDate = string;
export type YearMonth = string;

const MONTHS_ES: Record<string, number> = {
  ENE: 1, ENERO: 1, FEB: 2, FEBRERO: 2, MAR: 3, MARZO: 3, ABR: 4, ABRIL: 4, MAY: 5, MAYO: 5,
  JUN: 6, JUNIO: 6, JUL: 7, JULIO: 7, AGO: 8, AGOSTO: 8, SEP: 9, SEPT: 9, SEPTIEMBRE: 9, SETIEMBRE: 9,
  OCT: 10, OCTUBRE: 10, NOV: 11, NOVIEMBRE: 11, DIC: 12, DICIEMBRE: 12,
};

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function toIso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Parses Spanish-style dates: dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, dd/mm (needs reference year),
 * "12 ENE 2026", "12-ene-26" and ISO yyyy-mm-dd. Returns null when invalid.
 * `inferYear` resolves dates without year (e.g. from the statement period).
 */
export function parseSpanishDate(input: string, inferYear?: (month: number) => number): IsoDate | null {
  const s = input.trim().toUpperCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return build(expandYear(m[3]!), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s);
  if (m) {
    if (!inferYear) return null;
    const month = Number(m[2]);
    return build(inferYear(month), month, Number(m[1]));
  }
  m = /^(\d{1,2})[\s/.-]+([A-ZÁÉÍÓÚ]{3,10})\.?[\s/.-]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS_ES[stripAccents(m[2]!)];
    if (!month) return null;
    return build(expandYear(m[3]!), month, Number(m[1]));
  }
  return null;
}

function build(y: number, mo: number, d: number): IsoDate | null {
  return isValidYmd(y, mo, d) ? toIso(y, mo, d) : null;
}

function expandYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function monthOf(date: IsoDate): YearMonth {
  return date.slice(0, 7);
}

export function parseYearMonth(ym: YearMonth): { y: number; m: number } {
  const [y, m] = ym.split('-').map(Number);
  return { y: y!, m: m! };
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const { y, m } = parseYearMonth(ym);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(from: YearMonth, to: YearMonth): number {
  const a = parseYearMonth(from);
  const b = parseYearMonth(to);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/** Inclusive list of months from `from` to `to`. */
export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  const n = monthsBetween(from, to);
  for (let i = 0; i <= n; i++) out.push(addMonths(from, i));
  return out;
}

export function firstDayOfMonth(ym: YearMonth): IsoDate {
  return `${ym}-01`;
}

export function lastDayOfMonth(ym: YearMonth): IsoDate {
  const { y, m } = parseYearMonth(ym);
  return toIso(y, m, daysInMonth(y, m));
}

export function dateToUtcMs(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(dateToUtcMs(date) + days * 86_400_000);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function todayIso(now: Date = new Date()): IsoDate {
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function formatMonth(ym: YearMonth, style: 'long' | 'short' = 'long'): string {
  const { y, m } = parseYearMonth(ym);
  return style === 'long' ? `${MONTH_NAMES[m - 1]} ${y}` : `${MONTH_SHORT[m - 1]} ${String(y).slice(2)}`;
}

export function formatDate(date: IsoDate): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
