/**
 * Money is represented as integer euro cents (`number`, always an integer).
 * Integers are exact up to 2^53, i.e. ~90 billion euros in cents — far beyond any
 * personal statement. Floats are never used for stored or aggregated amounts.
 */
export type Cents = number;

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new Error(`Importe no entero en céntimos: ${value}`);
  return value;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total);
}

/**
 * Parses an amount written in Spanish (or plain) notation into integer cents.
 * Accepts: "1.234,56 €", "-45,20", "45,20-", "+12,00 EUR", "1234.56", "(12,30)", "−3,10".
 * Returns null when the text is not an unambiguous amount.
 */
export function parseAmountToCents(input: string): Cents | null {
  let s = input.trim().replace(/\u2212/g, '-').replace(/\u00a0/g, ' ');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/(€|eur|euros)$/i, '').trim();
  s = s.replace(/^(€|eur)/i, '').trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/(€|eur)$/i, '').trim();
  s = s.replace(/[\s']/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;

  let intPart: string;
  let decPart = '';
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the right-most separator is the decimal one.
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const [i, d, ...rest] = s.split(decSep);
    if (rest.length > 0 || i === undefined || d === undefined) return null;
    if (!isValidGrouping(i, thouSep)) return null;
    intPart = i.split(thouSep).join('');
    decPart = d;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1]!.length <= 2 && parts[1]!.length > 0) {
      intPart = parts[0]!;
      decPart = parts[1]!;
    } else if (isValidGrouping(s, ',') && parts.length > 1) {
      intPart = parts.join('');
    } else return null;
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length === 2 && parts[1]!.length <= 2 && parts[1]!.length > 0) {
      intPart = parts[0]!;
      decPart = parts[1]!;
    } else if (isValidGrouping(s, '.') && parts.length > 1) {
      // Spanish thousands separator without decimals: "1.234" → 1234,00
      intPart = parts.join('');
    } else return null;
  } else {
    intPart = s;
  }
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) return null;
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

function isValidGrouping(value: string, sep: string): boolean {
  if (!value.includes(sep)) return /^\d+$/.test(value);
  const groups = value.split(sep);
  const [first, ...rest] = groups;
  return !!first && /^\d{1,3}$/.test(first) && rest.every((g) => /^\d{3}$/.test(g));
}

const eurFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
});
const eurCompactFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
  useGrouping: 'always',
});

/** Formats cents as "1.234,56 €". Division by 100 happens only at the display boundary. */
export function formatCents(cents: Cents, opts: { compact?: boolean; signed?: boolean } = {}): string {
  const f = opts.compact ? eurCompactFormatter : eurFormatter;
  const text = f.format((opts.compact ? Math.round(cents / 100) : cents / 100) as number);
  if (opts.signed && cents > 0) return `+${text}`;
  return text;
}

/** Plain decimal string with comma ("-45,20"), used for CSV export. */
export function centsToDecimalString(cents: Cents, decimalSep = ','): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}${decimalSep}${String(abs % 100).padStart(2, '0')}`;
}

/** Rounds `cents * numerator / denominator` to the nearest cent (half away from zero). */
export function mulDiv(cents: Cents, numerator: number, denominator: number): Cents {
  if (denominator === 0) throw new Error('División por cero');
  const raw = (cents * numerator) / denominator;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

/** Ratio in basis points (1 % = 100 bp) rounded to nearest integer, or null if denominator ≤ 0. */
export function ratioBp(numerator: Cents, denominator: Cents): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator * 10000) / denominator);
}

export function formatBp(bp: number | null, digits = 1): string {
  if (bp === null) return '—';
  return `${(bp / 100).toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

/** Rounds cents to the nearest multiple of `step` euros (e.g. 10 → nearest 10 €). */
export function roundToEuros(cents: Cents, stepEuros: number): Cents {
  const step = stepEuros * 100;
  return Math.round(cents / step) * step;
}
