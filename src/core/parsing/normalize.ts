import { parseAmountToCents, formatCents } from '../../shared/money';
import { addDays, isIsoDate, parseSpanishDate, type IsoDate } from '../../shared/dates';
import type { TransactionType } from '../../shared/types';
import { merchantSourceFor, normalizeMerchant, normalizeText, type MerchantResult } from '../domain/merchant';
import { inferTransactionType } from '../domain/transactionType';
import type { ParsedStatement, RawTransaction } from './types';

export interface CandidateTransaction {
  rowIndex: number;
  rawText: string;
  date: IsoDate | null;
  bookingDate: IsoDate | null;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchant: MerchantResult | null;
  /** Money in positive, money out negative. */
  amountCents: number | null;
  type: TransactionType;
  errors: string[];
}

export interface NormalizedStatement {
  parsed: ParsedStatement;
  candidates: CandidateTransaction[];
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  /** Sum of valid rows in "charges positive" convention (net spending of the document). */
  computedTotalCents: number;
  /** Problems that make the whole statement untrustworthy (e.g. totals don't match). */
  blockingIssues: string[];
  /** Informational notes. */
  warnings: string[];
  /** Balance at the end of the last movement's day (printed running balance or declared closing balance). */
  endBalance: { cents: number; date: IsoDate } | null;
}

/** Days before the period start a movement may be dated (card statements include late-posted operations). */
const PERIOD_TOLERANCE_BEFORE = 45;
const PERIOD_TOLERANCE_AFTER = 5;

export function normalizeStatement(parsed: ParsedStatement): NormalizedStatement {
  const warnings = [...parsed.issues];
  const blockingIssues: string[] = [...(parsed.integrityErrors ?? [])];

  const candidates = parsed.transactions.map((raw, idx) => normalizeRow(raw, idx, parsed));
  const chainDir = applyBalanceChain(parsed, candidates, warnings);

  // Period: use the declared one, or deduce it from movement dates.
  let periodStart = parsed.periodStart;
  let periodEnd = parsed.periodEnd;
  const dates = candidates.map((c) => c.date).filter((d): d is string => !!d).sort();
  if ((!periodStart || !periodEnd) && dates.length > 0) {
    periodStart ??= dates[0]!;
    periodEnd ??= dates[dates.length - 1]!;
    if (parsed.periodStart === null) warnings.push('El documento no indica periodo: se ha deducido de las fechas de los movimientos.');
  }
  if (periodStart && periodEnd) {
    const min = addDays(periodStart, -PERIOD_TOLERANCE_BEFORE);
    const max = addDays(periodEnd, PERIOD_TOLERANCE_AFTER);
    for (const c of candidates) {
      if (c.date && (c.date < min || c.date > max)) c.errors.push(`Fecha fuera del periodo del documento (${periodStart} – ${periodEnd}).`);
    }
  }

  // Types need the final signed amount. A kind declared by the format (Norma 43 concept codes) wins over keywords.
  for (const c of candidates) {
    if (c.amountCents !== null) {
      const hint = parsed.transactions[c.rowIndex]?.typeHint;
      c.type = hint ?? inferTransactionType(c.descriptionNormalized, c.amountCents, parsed.kind).type;
      if (c.amountCents === 0) c.errors.push('Importe cero.');
    }
  }

  const valid = candidates.filter((c) => c.errors.length === 0 && c.amountCents !== null);
  const computedTotalCents = -valid.reduce((s, c) => s + (c.amountCents ?? 0), 0);
  const allRowsValid = valid.length === candidates.length;

  if (parsed.declaredTotalCents !== null) {
    if (allRowsValid && computedTotalCents !== parsed.declaredTotalCents) {
      blockingIssues.push(
        `La suma de los movimientos (${formatCents(computedTotalCents)}) no coincide con el total declarado en el documento (${formatCents(parsed.declaredTotalCents)}). Puede faltar o sobrar algún movimiento.`,
      );
    }
  } else if (parsed.openingBalanceCents !== null && parsed.closingBalanceCents !== null) {
    const net = valid.reduce((s, c) => s + (c.amountCents ?? 0), 0);
    if (allRowsValid && parsed.openingBalanceCents + net !== parsed.closingBalanceCents) {
      blockingIssues.push(
        `Saldo inicial + movimientos (${formatCents(parsed.openingBalanceCents + net)}) no coincide con el saldo final del documento (${formatCents(parsed.closingBalanceCents)}).`,
      );
    }
  } else if (parsed.bank !== 'CSV' && !parsed.verifiedByBalances) {
    warnings.push('El documento no incluye un total verificable: la suma no se ha podido comprobar.');
  }

  let endBalance: NormalizedStatement['endBalance'] = null;
  if (chainDir) {
    // Chronologically last movement with a printed balance: last row (oldest first) or first row (newest first).
    const idx = chainDir === 'asc' ? [...candidates.keys()].reverse() : [...candidates.keys()];
    for (const i of idx) {
      const b = parsed.transactions[i]?.balanceRaw ? parseAmountToCents(parsed.transactions[i]!.balanceRaw!) : null;
      const d = candidates[i]!.date;
      if (b !== null && d && candidates[i]!.errors.length === 0) {
        endBalance = { cents: b, date: d };
        break;
      }
    }
  } else if (parsed.closingBalanceCents !== null && periodEnd && blockingIssues.length === 0) {
    endBalance = { cents: parsed.closingBalanceCents, date: periodEnd };
  }
  return { parsed, candidates, periodStart, periodEnd, computedTotalCents, blockingIssues, warnings, endBalance };
}

function normalizeRow(raw: RawTransaction, idx: number, parsed: ParsedStatement): CandidateTransaction {
  const errors: string[] = [];
  const date = isIsoDate(raw.dateRaw) ? raw.dateRaw : parseSpanishDate(raw.dateRaw);
  if (!date) errors.push(`Fecha no válida: «${raw.dateRaw || 'vacía'}».`);
  const bookingDate = raw.valueDateRaw ? (isIsoDate(raw.valueDateRaw) ? raw.valueDateRaw : parseSpanishDate(raw.valueDateRaw)) : null;
  const printed = parseAmountToCents(raw.amountRaw);
  if (printed === null) errors.push(`Importe no válido: «${raw.amountRaw || 'vacío'}».`);
  const amountCents = printed === null ? null : parsed.signConvention === 'charges_positive' ? -printed : printed;
  const concept = raw.descriptionRaw.replace(/\s+/g, ' ').trim();
  const detail = raw.detailRaw?.replace(/\s+/g, ' ').trim() || null;
  const descriptionRaw = detail ? `${concept} · ${detail}` : concept;
  if (!concept) errors.push('Descripción vacía.');
  const descriptionNormalized = normalizeText(descriptionRaw);
  return {
    rowIndex: idx,
    rawText: raw.rawText,
    date,
    bookingDate,
    descriptionRaw,
    descriptionNormalized,
    merchant: concept ? normalizeMerchant(merchantSourceFor(concept, detail)) : null,
    amountCents,
    type: 'unknown',
    errors,
  };
}

/**
 * When a running balance is printed, it is the most reliable source for the sign of each movement.
 * Detects the ordering (oldest-first or newest-first), fixes signs that contradict the balance, and
 * flags rows whose amount cannot be reconciled.
 */
function applyBalanceChain(parsed: ParsedStatement, rows: CandidateTransaction[], warnings: string[]): 'asc' | 'desc' | null {
  const balances = parsed.transactions.map((t) => (t.balanceRaw ? parseAmountToCents(t.balanceRaw) : null));
  if (balances.filter((b) => b !== null).length < Math.max(2, rows.length * 0.6)) return null;

  const check = (dir: 'asc' | 'desc') => {
    let ok = 0;
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = balances[i - 1];
      const cur = balances[i];
      const amtRow = dir === 'asc' ? rows[i]! : rows[i - 1]!;
      if (prev == null || cur == null || amtRow.amountCents === null) continue;
      total++;
      const diff = dir === 'asc' ? cur - prev : prev - cur;
      if (Math.abs(diff) === Math.abs(amtRow.amountCents)) ok++;
    }
    return { ok, total };
  };
  const asc = check('asc');
  const desc = check('desc');
  const dir = asc.ok >= desc.ok ? 'asc' : 'desc';
  const best = dir === 'asc' ? asc : desc;
  if (best.total === 0) return null;

  let fixed = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = balances[i - 1];
    const cur = balances[i];
    const row = dir === 'asc' ? rows[i]! : rows[i - 1]!;
    if (prev == null || cur == null || row.amountCents === null) continue;
    const diff = dir === 'asc' ? cur - prev : prev - cur;
    if (Math.abs(diff) !== Math.abs(row.amountCents)) {
      row.errors.push('El importe no cuadra con la variación del saldo impreso.');
    } else if (diff !== row.amountCents) {
      row.amountCents = diff;
      fixed++;
    }
  }
  // First row of an ascending chain can be verified against the opening balance.
  if (dir === 'asc' && parsed.openingBalanceCents !== null && balances[0] != null && rows[0]?.amountCents != null) {
    const diff = balances[0] - parsed.openingBalanceCents;
    if (Math.abs(diff) === Math.abs(rows[0].amountCents) && diff !== rows[0].amountCents) {
      rows[0].amountCents = diff;
      fixed++;
    }
  }
  if (fixed > 0) warnings.push(`Se ha corregido el signo de ${fixed} movimiento(s) usando el saldo impreso.`);
  return dir;
}
