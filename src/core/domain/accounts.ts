import type { Cents } from '../../shared/money';
import { daysBetween, type IsoDate } from '../../shared/dates';

/*
 * Account balances are derived, never typed per month: a known balance at the end of one day (the "anchor", printed in
 * a statement or entered by the user) plus the movements after it, minus the movements between the date asked and the
 * anchor. Manual accounts (not imported) receive the transfers you send them from your other accounts and, if they are
 * remunerated, grow at their annual rate.
 */

export interface Anchor {
  balanceCents: Cents;
  /** Balance at the END of this day (movements of that day included). */
  date: IsoDate;
}

export interface Flow {
  date: IsoDate;
  /** Money in positive, money out negative, from the account's point of view. */
  amountCents: Cents;
}

/** Balance at the end of `date` for an account whose movements are all known. */
export function balanceAt(anchor: Anchor, flows: Flow[], date: IsoDate): Cents {
  let b = anchor.balanceCents;
  for (const f of flows) {
    if (f.date > anchor.date && f.date <= date) b += f.amountCents;
    else if (f.date > date && f.date <= anchor.date) b -= f.amountCents;
  }
  return b;
}

/**
 * Balance of a remunerated manual account: from the anchor forward, interest accrues daily at the annual rate
 * ((1 + TAE)^(days/365)) and flows are added on their dates. Before the anchor, flows are simply undone (no interest).
 * Rounded to the cent once, at the end.
 */
export function balanceWithInterest(anchor: Anchor, flows: Flow[], annualRateBp: number | null, date: IsoDate): Cents {
  if (!annualRateBp || date <= anchor.date) return balanceAt(anchor, flows, date);
  const growth = (from: IsoDate, to: IsoDate) => Math.pow(1 + annualRateBp / 10000, daysBetween(from, to) / 365);
  let value = anchor.balanceCents;
  let cursor = anchor.date;
  for (const f of [...flows].filter((x) => x.date > anchor.date && x.date <= date).sort((a, b) => a.date.localeCompare(b.date))) {
    value = value * growth(cursor, f.date) + f.amountCents;
    cursor = f.date;
  }
  return Math.round(value * growth(cursor, date));
}

/** Interest earned in a period by a remunerated account (balance change not explained by flows). */
export function interestBetween(anchor: Anchor, flows: Flow[], annualRateBp: number | null, from: IsoDate, to: IsoDate): Cents {
  if (!annualRateBp) return 0;
  const net = flows.filter((f) => f.date > from && f.date <= to).reduce((a, f) => a + f.amountCents, 0);
  return balanceWithInterest(anchor, flows, annualRateBp, to) - balanceWithInterest(anchor, flows, annualRateBp, from) - net;
}
