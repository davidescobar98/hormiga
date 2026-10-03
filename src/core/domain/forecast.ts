import type { Cents } from '../../shared/money';
import { formatCents } from '../../shared/money';
import { addDays, addMonths, daysBetween, formatMonth, monthOf, monthRange, type IsoDate, type YearMonth } from '../../shared/dates';
import type { RecurringFrequency } from '../../shared/types';

/*
 * Predictions from your own history, all deterministic and explainable:
 *  - day-by-day projection of the money in your current accounts (expected payroll, recurring charges on their
 *    expected dates, your usual variable spending and transfers to your other accounts),
 *  - months in which you usually spend much more than normal in a category (seasonality),
 *  - levers to save more, each with the evidence and the monthly amount.
 */

// ───────── Calendar of expected movements ─────────

const STEP_MONTHS: Record<RecurringFrequency, number> = { weekly: 0, monthly: 1, bimonthly: 2, quarterly: 3, annual: 12 };

function addMonthsToDate(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Dates of a recurring payment from its next expected date up to `to` (inclusive), never before `from`. */
export function occurrences(nextDate: IsoDate, frequency: RecurringFrequency, from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let d = nextDate;
  // A payment expected in the past that has not arrived yet is expected soon (tomorrow), once.
  if (d < from) d = from;
  for (let i = 0; d <= to && i < 400; i++) {
    out.push(d);
    d = frequency === 'weekly' ? addDays(d, 7) : addMonthsToDate(nextDate < from && i === 0 ? nextDate : d, STEP_MONTHS[frequency]);
    while (d < from) d = frequency === 'weekly' ? addDays(d, 7) : addMonthsToDate(d, STEP_MONTHS[frequency]);
  }
  return out;
}

/** Next date of a recurring payment after `date` following its rhythm. */
export function nextAfter(date: IsoDate, frequency: RecurringFrequency): IsoDate {
  return frequency === 'weekly' ? addDays(date, 7) : addMonthsToDate(date, STEP_MONTHS[frequency]);
}

/**
 * Where to start expecting a recurring payment, given the date the projection starts from.
 * - If the starting balance is more recent than your last imported movement, payments due before it are assumed to
 *   be already reflected in that balance.
 * - Otherwise a payment overdue by a few days (≤ 10) is expected right away (late charge); older ones are assumed
 *   skipped or cancelled and move to their next cycle.
 */
export function firstExpected(nextDate: IsoDate, frequency: RecurringFrequency, startDate: IsoDate, dataUntil: IsoDate | null): IsoDate {
  let d = nextDate;
  const balanceAfterData = !!dataUntil && startDate > dataUntil;
  for (let i = 0; d <= startDate && i < 400; i++) {
    if (!balanceAfterData && daysBetween(d, startDate) <= 10) break;
    d = nextAfter(d, frequency);
  }
  return d;
}

/** Usual payday: median day of the month of the largest income of each of the last months. */
export function detectPayday(incomes: { date: IsoDate; cents: Cents }[]): number | null {
  const byMonth = new Map<string, { date: IsoDate; cents: Cents }>();
  for (const i of incomes) {
    const m = i.date.slice(0, 7);
    const cur = byMonth.get(m);
    if (!cur || i.cents > cur.cents) byMonth.set(m, i);
  }
  const days = [...byMonth.values()].map((i) => Number(i.date.slice(8, 10))).sort((a, b) => a - b);
  if (days.length < 2) return null;
  return days[Math.floor((days.length - 1) / 2)]!;
}

export interface ExpectedEvent {
  date: IsoDate;
  kind: 'income' | 'recurring';
  label: string;
  /** Signed: + money in, − money out. */
  amountCents: Cents;
  frequency?: RecurringFrequency;
  merchantId?: number;
}

export interface BalanceProjectionInput {
  today: IsoDate;
  days: number;
  startCents: Cents;
  events: ExpectedEvent[];
  /** Usual variable spending (not recurring) per day, positive. */
  dailyVariableCents: number;
  /** Usual net money moved to your other accounts per day, positive = out. */
  dailyTransfersCents: number;
}

export interface BalancePoint {
  date: IsoDate;
  balanceCents: Cents;
}

/** End-of-day balances from tomorrow to today + days. Rounded to the cent per day (no drift: cumulative rounding). */
export function projectBalance(input: BalanceProjectionInput): { points: BalancePoint[]; min: BalancePoint; end: BalancePoint } {
  const byDate = new Map<IsoDate, Cents>();
  for (const e of input.events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amountCents);
  const points: BalancePoint[] = [];
  const perDay = input.dailyVariableCents + input.dailyTransfersCents;
  let events = 0;
  for (let k = 1; k <= input.days; k++) {
    const date = addDays(input.today, k);
    events += byDate.get(date) ?? 0;
    points.push({ date, balanceCents: input.startCents + events - Math.round(perDay * k) });
  }
  const min = points.reduce((a, p) => (p.balanceCents < a.balanceCents ? p : a), points[0] ?? { date: input.today, balanceCents: input.startCents });
  return { points, min, end: points[points.length - 1] ?? { date: input.today, balanceCents: input.startCents } };
}

// ───────── Seasonality ─────────

export interface SeasonalPeak {
  month: YearMonth;
  categoryId: number;
  categoryName: string;
  /** What you spent in the same month last year. */
  lastYearCents: Cents;
  /** Your usual month in that category (average of the 12 months before). */
  usualCents: Cents;
  extraCents: Cents;
}

/**
 * Upcoming months in which, last year, a category cost much more than usual (≥ 1,5× and ≥ 100 € extra).
 * Needs the same month of last year to have data.
 */
export function seasonalPeaks(
  monthly: Map<YearMonth, Map<number, Cents>>,
  monthsWithData: Set<YearMonth>,
  categories: { id: number; name: string }[],
  today: IsoDate,
  horizon = 3,
): SeasonalPeak[] {
  const current = monthOf(today);
  const out: SeasonalPeak[] = [];
  for (let k = 0; k <= horizon; k++) {
    const month = addMonths(current, k);
    const lastYear = addMonths(month, -12);
    if (!monthsWithData.has(lastYear)) continue;
    const window = monthRange(addMonths(lastYear, -12), addMonths(lastYear, -1)).filter((m) => monthsWithData.has(m));
    if (window.length < 6) continue;
    for (const c of categories) {
      const ly = monthly.get(lastYear)?.get(c.id) ?? 0;
      const usual = Math.round(window.reduce((t, m) => t + (monthly.get(m)?.get(c.id) ?? 0), 0) / window.length);
      if (ly >= usual * 1.5 && ly - usual >= 10000) out.push({ month, categoryId: c.id, categoryName: c.name, lastYearCents: ly, usualCents: usual, extraCents: ly - usual });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || b.extraCents - a.extraCents);
}

// ───────── Savings levers ─────────

export type LeverKind = 'category' | 'subscription' | 'fees' | 'price_increase';

export interface SavingsLever {
  id: string;
  kind: LeverKind;
  title: string;
  /** Why, with your own numbers. */
  detail: string;
  monthlyCents: Cents;
  annualCents: Cents;
  /** Suggested in the default plan (you decide). */
  suggested: boolean;
  categoryId: number | null;
  /** For category levers: the monthly limit that achieves the saving (usable as a budget). */
  targetCents: Cents | null;
}

/**
 * «Back to your best quarter»: for each category, the average of the last 3 complete months against the cheapest
 * 3 consecutive months of the 12 before. Proven achievable because you already did it.
 */
export function categoryLevers(
  monthly: Map<YearMonth, Map<number, Cents>>,
  monthsWithData: Set<YearMonth>,
  categories: { id: number; name: string; trimmable: boolean }[],
  lastComplete: YearMonth,
): SavingsLever[] {
  const recent = monthRange(addMonths(lastComplete, -2), lastComplete);
  if (!recent.every((m) => monthsWithData.has(m))) return [];
  const history = monthRange(addMonths(lastComplete, -14), addMonths(lastComplete, -3));
  const out: SavingsLever[] = [];
  for (const c of categories.filter((x) => x.trimmable)) {
    const v = (m: YearMonth) => monthly.get(m)?.get(c.id) ?? 0;
    const avg3 = Math.round(recent.reduce((t, m) => t + v(m), 0) / 3);
    if (avg3 < 5000) continue;
    let best: { avg: number; from: YearMonth; to: YearMonth } | null = null;
    for (let i = 0; i + 2 < history.length; i++) {
      const w = history.slice(i, i + 3);
      if (!w.every((m) => monthsWithData.has(m))) continue;
      const avg = Math.round(w.reduce((t, m) => t + v(m), 0) / 3);
      if (!best || avg < best.avg) best = { avg, from: w[0]!, to: w[2]! };
    }
    if (!best) continue;
    // Never suggest less than half of today's level: drastic cuts are not realistic.
    const target = Math.max(best.avg, Math.round(avg3 / 2));
    const saving = avg3 - target;
    if (saving < 1500) continue;
    out.push({
      id: `category:${c.id}`,
      kind: 'category',
      title: `${c.name}: bajar a ${formatCents(target)}/mes`,
      detail: `Los últimos 3 meses gastaste de media ${formatCents(avg3)}/mes. Entre ${formatMonth(best.from).toLowerCase()} y ${formatMonth(best.to).toLowerCase()} lo hiciste con ${formatCents(best.avg)}/mes${target > best.avg ? ' (proponemos como mucho la mitad del recorte)' : ''}: ya sabes que se puede.`,
      monthlyCents: saving,
      annualCents: saving * 12,
      suggested: true,
      categoryId: c.id,
      targetCents: target,
    });
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents);
}

// ───────── Projections ─────────

export { accumulate, monthsToReach } from '../../shared/planning';

/** Average daily amount from monthly totals (30,44 days per month). */
export const perDay = (monthlyCents: number) => monthlyCents / 30.4375;

export { addMonthsToDate, daysBetween };

// ───────── Income sources ─────────

export interface IncomeMovement {
  date: IsoDate;
  cents: Cents;
  description: string;
}

export interface IncomeSource {
  /** Who pays (e.g. "ACME SERVICIOS"). */
  payer: string;
  kind: 'payroll' | 'employer_variable' | 'other';
  /** Your usual month from this source (median of the last 12 complete months; 0 when irregular). */
  monthlyCents: Cents;
  /** Day of the month it usually arrives. */
  day: number | null;
  /** Months of the last 12 with money from this source. */
  monthsSeen: number;
  last12Cents: Cents;
  /** Payroll only: months with an extra pay last year and its size. */
  extraPays: { month: number; cents: Cents; day: number }[];
  regular: boolean;
}

const PAYROLL_PREFIX = /^(ABONO (DE )?NOMINA|NOMINA|PAGO NOMINA|ABONO NOMINA)\s+/;
const TRANSFER_PREFIX = /^(TRANSFERENCIA RECIBIDA DE|TRANSFERENCIA RECIBIDA|TRANSF RECIBIDA DE|TRANSFERENCIA DE|ABONO TRANSFERENCIA DE|ABONO TRANSFERENCIA|TRANSFERENCIA)\s+/;
const LEGAL = new Set(['S', 'L', 'U', 'A', 'SL', 'SA', 'SLU', 'SAU', 'SPAIN', 'ESPANA', 'IBERIA', 'SOCIEDAD', 'LIMITADA', 'ANONIMA', 'DE', 'Y', 'COOP']);

/** Payer of an income movement from its normalized description (first two meaningful words of the company). */
export function incomePayer(description: string): { payer: string; payroll: boolean } | null {
  const d = description.trim();
  let rest: string | null = null;
  let payroll = false;
  if (PAYROLL_PREFIX.test(d)) {
    rest = d.replace(PAYROLL_PREFIX, '');
    payroll = true;
  } else if (TRANSFER_PREFIX.test(d)) rest = d.replace(TRANSFER_PREFIX, '');
  if (!rest) return null;
  const words = rest.split(/\s+/).filter((w) => w && !LEGAL.has(w) && !/^\d+$/.test(w));
  if (!words.length) return null;
  return { payer: words.slice(0, 2).join(' '), payroll };
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : Math.round((s[n / 2 - 1]! + s[n / 2]!) / 2);
};

/**
 * Groups your income by payer over the last 12 complete months. Money from the company that pays your payroll
 * (other transfers: overtime, bonuses, expenses…) is linked to it as variable income from your employer.
 */
export function incomeSources(incomes: IncomeMovement[], lastComplete: YearMonth): IncomeSource[] {
  const months = monthRange(addMonths(lastComplete, -11), lastComplete);
  const inWindow = incomes.filter((i) => months.includes(i.date.slice(0, 7)));
  const tagged = inWindow.map((i) => ({ ...i, p: incomePayer(i.description) })).filter((i) => i.p);
  const payrollPayers = new Set(tagged.filter((i) => i.p!.payroll).map((i) => i.p!.payer));
  const groups = new Map<string, { kind: IncomeSource['kind']; items: IncomeMovement[] }>();
  for (const i of tagged) {
    const payer = i.p!.payer;
    const kind: IncomeSource['kind'] = i.p!.payroll ? 'payroll' : payrollPayers.has(payer) ? 'employer_variable' : 'other';
    const key = `${kind}|${payer}`;
    const g = groups.get(key) ?? { kind, items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  const out: IncomeSource[] = [];
  for (const [key, g] of groups) {
    const payer = key.split('|')[1]!;
    const perMonth = months.map((m) => g.items.filter((i) => i.date.startsWith(m)).reduce((t, i) => t + i.cents, 0));
    const seen = perMonth.filter((v) => v > 0).length;
    const extraPays: IncomeSource['extraPays'] = [];
    let monthly: number;
    let day: number | null;
    if (g.kind === 'payroll') {
      // The regular payroll is the usual monthly payment; months with a clearly larger total carry an extra pay.
      const regular = median(months.map((m) => {
        const list = g.items.filter((i) => i.date.startsWith(m)).map((i) => i.cents);
        return list.length ? Math.min(...list) : 0;
      }).filter((v) => v > 0));
      monthly = regular;
      months.forEach((m, k) => {
        if (perMonth[k]! > regular * 1.5) {
          const items = g.items.filter((i) => i.date.startsWith(m)).sort((a, b) => b.cents - a.cents);
          const extra = items.find((i) => Math.abs(i.cents - regular) > regular * 0.08) ?? items[0]!;
          extraPays.push({ month: Number(m.slice(5, 7)), cents: perMonth[k]! - regular, day: Number(extra.date.slice(8, 10)) });
        }
      });
      const regularDays = g.items.filter((i) => !extraPays.some((e) => i.date.endsWith(`-${String(e.day).padStart(2, '0')}`) && Number(i.date.slice(5, 7)) === e.month)).map((i) => Number(i.date.slice(8, 10)));
      day = regularDays.length ? median(regularDays) : null;
    } else {
      // Variable income: the usual month over the last 6 (zero months count, so irregular money is not promised).
      monthly = median(perMonth.slice(-6));
      day = median(g.items.map((i) => Number(i.date.slice(8, 10))));
    }
    out.push({
      payer,
      kind: g.kind,
      monthlyCents: monthly,
      day,
      monthsSeen: seen,
      last12Cents: perMonth.reduce((t, v) => t + v, 0),
      extraPays,
      regular: monthly > 0 && seen >= 6,
    });
  }
  const order = { payroll: 0, employer_variable: 1, other: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || b.last12Cents - a.last12Cents);
}
