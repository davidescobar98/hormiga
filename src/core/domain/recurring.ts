import type { Cents } from '../../shared/money';
import { addDays, daysBetween, type IsoDate } from '../../shared/dates';
import type { RecurringFrequency } from '../../shared/types';

export interface RecurringInputTx {
  merchantId: number;
  merchantName: string;
  date: IsoDate;
  /** Positive spending amount in cents. */
  spendCents: Cents;
  categoryKey: string | null;
  subscriptionHint: boolean;
}

export interface RecurringDetection {
  merchantId: number;
  frequency: RecurringFrequency;
  kind: 'subscription' | 'fixed';
  averageCents: Cents;
  lastDate: IsoDate;
  nextDate: IsoDate;
  occurrences: number;
  confidenceBp: number;
  reason: string;
}

const PERIODS: { f: RecurringFrequency; days: number; tol: number }[] = [
  { f: 'weekly', days: 7, tol: 2 },
  { f: 'monthly', days: 30.44, tol: 6 },
  { f: 'bimonthly', days: 60.88, tol: 9 },
  { f: 'quarterly', days: 91.31, tol: 12 },
  { f: 'annual', days: 365.25, tol: 25 },
];

/** Categories whose recurring bills vary in amount (electricity, water...). */
const VARIABLE_AMOUNT_CATEGORIES = new Set(['utilities']);
const SUBSCRIPTION_CATEGORIES = new Set(['subscriptions', 'technology', 'sport']);
/** Two yearly charges are only accepted for categories where yearly billing is typical. */
const ANNUAL_TWO_OCCURRENCE_CATEGORIES = new Set(['insurance', 'subscriptions', 'taxes', 'technology']);

export function monthlyEquivalent(averageCents: Cents, f: RecurringFrequency): Cents {
  switch (f) {
    case 'weekly':
      return Math.round((averageCents * 52) / 12);
    case 'monthly':
      return averageCents;
    case 'bimonthly':
      return Math.round(averageCents / 2);
    case 'quarterly':
      return Math.round(averageCents / 3);
    case 'annual':
      return Math.round(averageCents / 12);
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Detects recurring expenses per merchant. A merchant is recurring when:
 *  - it has ≥3 charges (≥2 only for yearly insurance/subscriptions/taxes),
 *  - ≥75 % of the intervals between charges fit one period (weekly…annual) within tolerance,
 *  - amounts are stable (≤15 % from the median; ≤35 % for utilities), and
 *  - the last charge is recent enough (not older than 2 periods before `today`).
 * Charges on the same day are merged first (split payments).
 */
export function detectRecurring(txs: RecurringInputTx[], today: IsoDate): RecurringDetection[] {
  const byMerchant = new Map<number, RecurringInputTx[]>();
  for (const t of txs) {
    if (t.spendCents <= 0) continue;
    const list = byMerchant.get(t.merchantId) ?? [];
    list.push(t);
    byMerchant.set(t.merchantId, list);
  }

  const out: RecurringDetection[] = [];
  for (const [merchantId, list] of byMerchant) {
    const byDay = new Map<string, number>();
    for (const t of list) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.spendCents);
    const charges = [...byDay.entries()].map(([date, cents]) => ({ date, cents })).sort((a, b) => a.date.localeCompare(b.date));
    if (charges.length < 2) continue;
    const categoryKey = list[list.length - 1]!.categoryKey;
    const subscriptionHint = list.some((t) => t.subscriptionHint);

    const intervals: number[] = [];
    for (let i = 1; i < charges.length; i++) intervals.push(daysBetween(charges[i - 1]!.date, charges[i]!.date));

    let best: { f: RecurringFrequency; days: number; fit: number } | null = null;
    for (const p of PERIODS) {
      const fits = intervals.filter((d) => Math.abs(d - p.days) <= p.tol).length;
      const ratio = fits / intervals.length;
      if (ratio >= 0.75 && (!best || ratio > best.fit)) best = { f: p.f, days: p.days, fit: ratio };
    }
    if (!best) continue;

    const minOccurrences = best.f === 'annual' && ANNUAL_TWO_OCCURRENCE_CATEGORIES.has(categoryKey ?? '') ? 2 : 3;
    if (charges.length < minOccurrences) continue;

    // Use the most recent charges (up to 6) to describe the current amount.
    const recent = charges.slice(-6);
    const med = median(recent.map((c) => c.cents));
    const tolerance = VARIABLE_AMOUNT_CATEGORIES.has(categoryKey ?? '') ? 0.35 : 0.15;
    const stable = recent.filter((c) => Math.abs(c.cents - med) <= med * tolerance).length / recent.length;
    if (stable < 0.75) continue;

    const last = charges[charges.length - 1]!;
    const staleAfter = Math.round(best.days * 2 + (PERIODS.find((p) => p.f === best!.f)!.tol));
    if (daysBetween(last.date, today) > staleAfter) continue;

    const averageCents = Math.round(recent.reduce((s, c) => s + c.cents, 0) / recent.length);
    const kind: 'subscription' | 'fixed' = subscriptionHint || SUBSCRIPTION_CATEGORIES.has(categoryKey ?? '') ? 'subscription' : 'fixed';
    const confidence = Math.min(1, 0.4 + 0.1 * charges.length) * best.fit * stable;
    out.push({
      merchantId,
      frequency: best.f,
      kind,
      averageCents,
      lastDate: last.date,
      nextDate: addDays(last.date, Math.round(best.days)),
      occurrences: charges.length,
      confidenceBp: Math.round(confidence * 10000),
      reason: `${charges.length} cargos con intervalos regulares (${Math.round(best.fit * 100)} % encajan) e importes estables (±${Math.round(tolerance * 100)} %).`,
    });
  }
  return out;
}
