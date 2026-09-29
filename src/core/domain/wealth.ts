import type { Cents } from '../../shared/money';
import { lastDayOfMonth, type IsoDate, type YearMonth } from '../../shared/dates';
import { ASSET_TYPE_LABELS, INVESTMENT_TYPES, LIABILITY_TYPES, type AssetType, type ValuationMode } from '../../shared/types';
import { projectValue } from './estimate';
import { loanStatus, type LoanTerms } from './loans';

export interface ValuationPoint {
  assetId: number;
  date: IsoDate;
  valueCents: Cents;
  contributedCents: Cents | null;
}

export interface AssetRef {
  id: number;
  type: AssetType;
  mode?: ValuationMode;
  annualRateBp?: number | null;
  monthlyContributionCents?: Cents | null;
  loan?: LoanTerms | null;
}

export const isLiability = (t: AssetType) => LIABILITY_TYPES.includes(t);

/** Latest valuation of each asset on or before `date` (a valuation is carried forward until the next one). */
export function valuesAt(valuations: ValuationPoint[], date: IsoDate): Map<number, ValuationPoint> {
  const out = new Map<number, ValuationPoint>();
  for (const v of valuations) {
    if (v.date > date) continue;
    const prev = out.get(v.assetId);
    if (!prev || v.date > prev.date) out.set(v.assetId, v);
  }
  return out;
}

export interface AssetValue {
  valueCents: Cents;
  contributedCents: Cents | null;
  estimated: boolean;
  baseDate: IsoDate | null;
}

/**
 * Value of one asset on a date:
 *  - loan: outstanding balance of its amortization schedule;
 *  - rate: last real valuation grown at the annual rate (+ monthly contribution) up to the date;
 *  - manual: last real valuation, carried forward.
 */
export function assetValueAt(asset: AssetRef, latest: ValuationPoint | undefined, date: IsoDate): AssetValue | null {
  if (asset.mode === 'loan' && asset.loan) {
    if (date < asset.loan.startDate) return null;
    return { valueCents: loanStatus(asset.loan, date).outstandingCents, contributedCents: null, estimated: true, baseDate: null };
  }
  if (!latest) return null;
  if (asset.mode === 'rate' && asset.annualRateBp !== null && asset.annualRateBp !== undefined) {
    const p = projectValue(latest, asset.annualRateBp, asset.monthlyContributionCents ?? 0, date);
    return { ...p, estimated: date > latest.date, baseDate: latest.date };
  }
  return { valueCents: latest.valueCents, contributedCents: latest.contributedCents, estimated: false, baseDate: latest.date };
}

export interface NetWorth {
  assetsCents: Cents;
  liabilitiesCents: Cents;
  netWorthCents: Cents;
}

export function netWorthAt(assets: AssetRef[], valuations: ValuationPoint[], date: IsoDate): NetWorth {
  const latest = valuesAt(valuations, date);
  let a = 0;
  let l = 0;
  for (const asset of assets) {
    const v = assetValueAt(asset, latest.get(asset.id), date);
    if (!v) continue;
    if (isLiability(asset.type)) l += v.valueCents;
    else a += v.valueCents;
  }
  return { assetsCents: a, liabilitiesCents: l, netWorthCents: a - l };
}

export function netWorthHistory(assets: AssetRef[], valuations: ValuationPoint[], months: YearMonth[], today?: IsoDate) {
  return months.map((m) => {
    const end = lastDayOfMonth(m);
    return { month: m, ...netWorthAt(assets, valuations, today && end > today ? today : end) };
  });
}

/** Gain and simple return over the amount contributed (only when the user recorded contributions). */
export function gain(type: AssetType, value: Cents | null, contributed: Cents | null): { gainCents: Cents | null; returnBp: number | null } {
  if (value === null || contributed === null || !INVESTMENT_TYPES.includes(type)) return { gainCents: null, returnBp: null };
  const g = value - contributed;
  return { gainCents: g, returnBp: contributed > 0 ? Math.round((g * 10000) / contributed) : null };
}

export function allocation(items: { type: AssetType; valueCents: Cents }[]) {
  const byType = new Map<AssetType, Cents>();
  for (const i of items) if (!isLiability(i.type)) byType.set(i.type, (byType.get(i.type) ?? 0) + i.valueCents);
  const total = [...byType.values()].reduce((a, b) => a + b, 0);
  return [...byType.entries()]
    .map(([type, cents]) => ({ type, label: ASSET_TYPE_LABELS[type], cents, shareBp: total > 0 ? Math.round((cents * 10000) / total) : null }))
    .sort((a, b) => b.cents - a.cents);
}
