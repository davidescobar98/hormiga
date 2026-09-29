import type { Cents } from '../../shared/money';
import { daysBetween, type IsoDate } from '../../shared/dates';
import type { PotStatus } from '../../shared/types';

export interface PotProgressInput {
  targetCents: Cents;
  targetDate: IsoDate | null;
  createdOn: IsoDate;
  savedCents: Cents;
  today: IsoDate;
}

export interface PotProgress {
  remainingCents: Cents;
  progressBp: number;
  monthsLeft: number | null;
  requiredMonthlyCents: Cents | null;
  expectedTodayCents: Cents | null;
  status: PotStatus;
}

/** Whole months left until the target date, counting the current month (a date later this month = 1). */
export function monthsUntil(today: IsoDate, target: IsoDate): number {
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const [gy, gm] = [Number(target.slice(0, 4)), Number(target.slice(5, 7))];
  return Math.max(0, (gy - ty) * 12 + (gm - tm) + (target >= today ? 1 : 0));
}

/** ±5 % of the target around the linear path counts as "on track". */
const TOLERANCE_BP = 500;

/**
 * Progress of a savings pot. Linear plan: from the creation date to the target date the pot should grow evenly.
 * requiredMonthly = remaining / months left (rounded up to the cent), so following it reaches the goal on time.
 */
export function potProgress(p: PotProgressInput): PotProgress {
  const remaining = Math.max(0, p.targetCents - p.savedCents);
  const progressBp = Math.min(10000, Math.max(0, Math.floor((p.savedCents * 10000) / p.targetCents)));
  if (remaining === 0) return { remainingCents: 0, progressBp: 10000, monthsLeft: p.targetDate ? monthsUntil(p.today, p.targetDate) : null, requiredMonthlyCents: 0, expectedTodayCents: null, status: 'done' };
  if (!p.targetDate) return { remainingCents: remaining, progressBp, monthsLeft: null, requiredMonthlyCents: null, expectedTodayCents: null, status: 'no_date' };
  if (p.targetDate < p.today) return { remainingCents: remaining, progressBp, monthsLeft: 0, requiredMonthlyCents: remaining, expectedTodayCents: p.targetCents, status: 'overdue' };

  const monthsLeft = Math.max(1, monthsUntil(p.today, p.targetDate));
  const required = Math.ceil(remaining / monthsLeft);
  const totalDays = Math.max(1, daysBetween(p.createdOn, p.targetDate));
  const elapsed = Math.min(totalDays, Math.max(0, daysBetween(p.createdOn, p.today)));
  const expected = Math.round((p.targetCents * elapsed) / totalDays);
  const band = Math.round((p.targetCents * TOLERANCE_BP) / 10000);
  const status: PotStatus = p.savedCents > expected + band ? 'ahead' : p.savedCents < expected - band ? 'behind' : 'on_track';
  return { remainingCents: remaining, progressBp, monthsLeft, requiredMonthlyCents: required, expectedTodayCents: expected, status };
}
