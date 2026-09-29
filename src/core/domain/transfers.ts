import type { TransactionType } from '../../shared/types';
import { daysBetween, type IsoDate } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import { normalizeText } from './merchant';
import { hasKeyword, INTERNAL_TRANSFER, PERSON_TRANSFER } from './transactionType';

/*
 * Transfers between people and between your own accounts.
 * - Money moved between your own accounts is neutral: not spending, not income, and your liquidity is kept (it
 *   leaves one balance and enters another).
 * - The counterparty ("beneficiary") printed in a transfer is decided once by the user (own / partner / other) and
 *   applied to every past and future movement with the same name.
 */

/** Concepts that name one of your own accounts as destination (card settlements and contributions are excluded). */
const OWN_ACCOUNT_CONCEPTS = ['TRASPASO', 'TRASPASOS', 'ENTRE CUENTAS', 'CUENTA PROPIA', 'CUENTAS PROPIAS', 'A MI CUENTA', 'MISMA TITULARIDAD', 'CUENTA AHORRO', 'CUENTA DE AHORRO', 'CUENTA REMUNERADA', 'HUCHA'];

const CP_PREFIX = /^(DE|A|PARA|ORDENANTE|BENEFICIARIO|DESTINATARIO|ENVIADO|RECIBIDO|CONCEPTO)\s+/;
const MAX_CP_WORDS = 6;

/**
 * Name of the other side of a transfer as printed by the bank, normalized ("DAVID ESCOBAR GARCIA").
 * Taken from the detail after " · " (BBVA and most banks print the beneficiary/payer there). Bizum details are
 * concepts ("Enviado: cena"), not names, so they have no counterparty.
 */
export function counterpartyKey(descriptionRaw: string): string | null {
  const [concept = '', ...rest] = descriptionRaw.split(' · ');
  const c = normalizeText(concept);
  if (!hasKeyword(c, PERSON_TRANSFER) && !hasKeyword(c, INTERNAL_TRANSFER)) return null;
  if (hasKeyword(c, ['BIZUM'])) return null;
  let detail = normalizeText(rest.join(' '));
  for (let i = 0; i < 3; i++) detail = detail.replace(CP_PREFIX, '');
  const words = detail.split(' ').filter(Boolean);
  if (words.length === 0 || !/[A-Z]/.test(detail)) return null;
  return words.slice(0, MAX_CP_WORDS).join(' ');
}

export type CounterpartyRole = 'own' | 'partner' | 'other';

export interface CounterpartyDecision {
  key: string;
  role: CounterpartyRole;
  accountId: number | null;
  categoryId: number | null;
}

export interface TransferContext {
  /** Decisions by counterparty key. */
  decisions: Map<string, CounterpartyDecision>;
  /** Normalized names of the user (profile): transfers naming them are between own accounts. */
  ownerKeys: string[];
  partnerKey: string | null;
  /** Manual account that receives transfers to your own name when no specific account was chosen. */
  defaultOwnAccountId: number | null;
}

export interface TransferRefinement {
  type: TransactionType;
  /** Category decided by the transfer rules; null = let the normal categorizer decide. */
  categoryKey: 'transfers' | 'shared' | 'people' | null;
  categoryId: number | null;
  counterAccountId: number | null;
  detail: string;
  /** Assumed (large transfer to someone not reviewed yet): shown for confirmation. */
  assumed?: boolean;
}

/** Transfers at least this large to a beneficiary you have not classified are assumed to be between your own accounts. */
export const LARGE_TRANSFER_CENTS = 100000;

const containsName = (text: string, name: string) => !!name && ` ${text} `.includes(` ${name} `);

/** Applies the user's counterparty decisions and profile names to a transfer-like movement. Null = no change. */
export function refineTransfer(descriptionRaw: string, descriptionNormalized: string, amountCents: Cents, ctx: TransferContext): TransferRefinement | null {
  const isTransferish = hasKeyword(descriptionNormalized, PERSON_TRANSFER) || hasKeyword(descriptionNormalized, INTERNAL_TRANSFER);
  if (!isTransferish || amountCents === 0) return null;
  const key = counterpartyKey(descriptionRaw);
  const decision = key ? ctx.decisions.get(key) : undefined;
  const out = amountCents < 0;

  // Moved to one of your savings accounts by concept ("traspaso", "cuenta ahorro"…): same as a transfer to your name.
  const toOwnByConcept = !decision && !!hasKeyword(descriptionNormalized, OWN_ACCOUNT_CONCEPTS);
  if (decision?.role === 'own' || toOwnByConcept || (!decision && ctx.ownerKeys.some((n) => containsName(descriptionNormalized, n)))) {
    return {
      type: 'transfer',
      categoryKey: 'transfers',
      categoryId: null,
      counterAccountId: decision?.accountId ?? ctx.defaultOwnAccountId,
      detail: out ? 'Dinero movido a otra cuenta tuya: mantienes la liquidez' : 'Dinero traído de otra cuenta tuya',
    };
  }
  if (decision?.role === 'partner' || (!decision && ctx.partnerKey && containsName(descriptionNormalized, ctx.partnerKey))) {
    return {
      type: out ? 'expense' : 'refund',
      categoryKey: 'shared',
      categoryId: null,
      counterAccountId: null,
      detail: out ? 'Pago a tu pareja: gasto compartido del hogar' : 'Dinero de tu pareja: compensa gastos compartidos',
    };
  }
  if (!decision && key && out && -amountCents >= LARGE_TRANSFER_CENTS && !hasKeyword(descriptionNormalized, ['BIZUM'])) {
    return {
      type: 'transfer',
      categoryKey: 'transfers',
      categoryId: null,
      counterAccountId: ctx.defaultOwnAccountId,
      detail: 'Transferencia grande sin confirmar: se trata como dinero movido a otra cuenta tuya (mantienes la liquidez) hasta que lo revises',
      assumed: true,
    };
  }
  if (decision?.role === 'other') {
    return {
      type: out ? 'expense' : hasKeyword(descriptionNormalized, ['BIZUM']) ? 'refund' : 'income',
      categoryKey: decision.categoryId ? null : 'people',
      categoryId: decision.categoryId,
      counterAccountId: null,
      detail: 'Según lo que indicaste para este beneficiario',
    };
  }
  return null;
}

export interface PairCandidate {
  id: number;
  accountId: number | null;
  date: IsoDate;
  amountCents: Cents;
  transferish: boolean;
  /** Already matched or fixed by the user: not considered. */
  locked: boolean;
}

export const PAIR_MAX_DAYS = 4;

/**
 * Finds transfers between two imported accounts of the user: same amount with opposite sign, in different
 * accounts, within a few days, and at least one side described as a transfer. Closest dates are paired first.
 */
export function matchInternalPairs(rows: PairCandidate[]): [number, number][] {
  const outs = rows.filter((r) => r.amountCents < 0 && r.accountId !== null && !r.locked);
  const ins = rows.filter((r) => r.amountCents > 0 && r.accountId !== null && !r.locked);
  const byAmount = new Map<number, PairCandidate[]>();
  for (const r of ins) byAmount.set(r.amountCents, [...(byAmount.get(r.amountCents) ?? []), r]);
  const options: { out: PairCandidate; inn: PairCandidate; gap: number }[] = [];
  for (const o of outs) {
    for (const i of byAmount.get(-o.amountCents) ?? []) {
      if (i.accountId === o.accountId || !(o.transferish || i.transferish)) continue;
      const gap = Math.abs(daysBetween(o.date, i.date));
      if (gap <= PAIR_MAX_DAYS) options.push({ out: o, inn: i, gap });
    }
  }
  options.sort((a, b) => a.gap - b.gap || a.out.id - b.out.id || a.inn.id - b.inn.id);
  const used = new Set<number>();
  const pairs: [number, number][] = [];
  for (const p of options) {
    if (used.has(p.out.id) || used.has(p.inn.id)) continue;
    used.add(p.out.id);
    used.add(p.inn.id);
    pairs.push([p.out.id, p.inn.id]);
  }
  return pairs;
}
