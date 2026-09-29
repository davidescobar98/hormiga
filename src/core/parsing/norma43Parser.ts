import { toIso } from '../../shared/dates';
import type { TransactionType } from '../../shared/types';
import type { ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * AEB Norma 43 (Cuaderno 43): standard fixed-width (80 chars) text export offered by practically every Spanish bank
 * (CaixaBank, Sabadell, Santander, BBVA…). Layout from the official AEB specification (June 2012):
 *   11 account header · 22 movement · 23 complementary concept (≤5) · 24 currency equivalence · 33 account totals · 88 end
 * Amounts have 2 implicit decimals; dates are AAMMDD; debit/credit key 1 = debe (charge), 2 = haber (credit).
 */

const BANKS: Record<string, string> = {
  '0182': 'BBVA', '2100': 'CaixaBank / imagin', '0081': 'Sabadell', '0049': 'Santander', '0073': 'Openbank',
  '1465': 'ING', '0128': 'Bankinter', '2103': 'Unicaja', '2080': 'Abanca', '2095': 'Kutxabank', '3058': 'Cajamar',
};

/** Common concept codes (anexo 2) → human label and, when unambiguous, the movement kind. */
const COMMON: Record<string, { label: string; hint?: (amountCents: number) => TransactionType | null }> = {
  '01': { label: 'Talones / reintegros', hint: (a) => (a < 0 ? 'cash_withdrawal' : null) },
  '02': { label: 'Abonarés / entregas / ingresos' },
  '03': { label: 'Recibos domiciliados' },
  '04': { label: 'Transferencias / traspasos', hint: () => 'transfer' },
  '05': { label: 'Amortización de préstamos' },
  '06': { label: 'Remesas de efectos' },
  '07': { label: 'Suscripciones / canjes' },
  '08': { label: 'Dividendos / cupones' },
  '09': { label: 'Operaciones de valores' },
  '10': { label: 'Cheques gasolina' },
  '11': { label: 'Cajero automático', hint: (a) => (a < 0 ? 'cash_withdrawal' : null) },
  '12': { label: 'Tarjetas' },
  '13': { label: 'Operaciones extranjero' },
  '14': { label: 'Devoluciones e impagados', hint: (a) => (a > 0 ? 'refund' : null) },
  '15': { label: 'Nóminas / seguros sociales', hint: (a) => (a > 0 ? 'income' : null) },
  '16': { label: 'Timbres / corretaje', hint: (a) => (a < 0 ? 'fee' : null) },
  '17': { label: 'Intereses / comisiones / gastos', hint: (a) => (a < 0 ? 'fee' : null) },
  '98': { label: 'Anulaciones / correcciones' },
  '99': { label: 'Varios' },
};

export function isNorma43(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 3) return false;
  return /^11\d{18}\d{12}[12]\d{14}/.test(lines[0]!) && lines.some((l) => l.startsWith('22')) && lines.some((l) => l.startsWith('33'));
}

const date = (aammdd: string): string | null => {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const y = 2000 + Number(aammdd.slice(0, 2));
  const m = Number(aammdd.slice(2, 4));
  const d = Number(aammdd.slice(4, 6));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return toIso(y, m, d);
};

const cents = (digits: string, sign: string): number | null => {
  if (!/^\d{14}$/.test(digits)) return null;
  const v = Number(digits);
  return sign === '1' ? -v : v;
};

const rawAmount = (c: number): string => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)},${String(Math.abs(c) % 100).padStart(2, '0')}`;

export class Norma43Parser implements StatementParser {
  readonly id = 'norma43-v1';
  readonly bank = 'Norma 43';

  detect(doc: ExtractedDocument): number {
    return doc.mimeType === 'text/x-norma43' ? 1 : 0;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const lines = doc.pages.flat().map((l) => l.replace(/\s+$/, ''));
    const transactions: (RawTransaction & { cents: number; concepts: string[]; ref2: string })[] = [];
    const issues: string[] = [];
    const accounts: { entity: string; account: string; start: string | null; end: string | null; opening: number | null; closing: number | null; debit: number; credit: number; nDebit: number; nCredit: number }[] = [];
    let current: (RawTransaction & { cents: number; concepts: string[]; ref2: string }) | null = null;

    lines.forEach((line, i) => {
      const code = line.slice(0, 2);
      if (code === '11') {
        accounts.push({
          entity: line.slice(2, 6), account: line.slice(10, 20), start: date(line.slice(20, 26)), end: date(line.slice(26, 32)),
          opening: cents(line.slice(33, 47), line.slice(32, 33)), closing: null, debit: 0, credit: 0, nDebit: 0, nCredit: 0,
        });
      } else if (code === '22') {
        const amount = cents(line.slice(28, 42), line.slice(27, 28));
        const common = line.slice(22, 24);
        if (amount === null) {
          issues.push(`Línea ${i + 1}: importe no válido.`);
          current = null;
          return;
        }
        const concept = COMMON[common];
        const ref2 = line.slice(64, 80).trim();
        current = {
          page: 1,
          line: i + 1,
          rawText: line.trimEnd(),
          dateRaw: date(line.slice(10, 16)) ?? line.slice(10, 16),
          valueDateRaw: date(line.slice(16, 22)),
          descriptionRaw: '',
          detailRaw: concept?.label ?? null,
          amountRaw: rawAmount(amount),
          balanceRaw: null,
          typeHint: concept?.hint?.(amount) ?? null,
          cents: amount,
          concepts: [],
          ref2: ref2 && /[A-Za-z]/.test(ref2) ? ref2 : '',
        };
        transactions.push(current);
      } else if (code === '23' && current) {
        const c = current as RawTransaction & { concepts: string[] };
        c.concepts.push(...[line.slice(4, 42), line.slice(42, 80)].map((s) => s.trim()).filter(Boolean));
        c.rawText += ` ⏎ ${line.trimEnd()}`;
      } else if (code === '33') {
        const acc = accounts[accounts.length - 1];
        if (acc) {
          acc.nDebit = Number(line.slice(20, 25));
          acc.debit = Number(line.slice(25, 39));
          acc.nCredit = Number(line.slice(39, 44));
          acc.credit = Number(line.slice(44, 58));
          acc.closing = cents(line.slice(59, 73), line.slice(58, 59));
        }
        current = null;
      } else if (code !== '24' && code !== '88' && line.trim()) {
        issues.push(`Línea ${i + 1}: registro «${code}» no reconocido.`);
      }
    });

    // Description: the complementary concepts (23) keep the bank's text; fall back to the AEB concept label.
    for (const t of transactions) {
      const text = [...t.concepts, t.ref2].join(' ').replace(/\s+/g, ' ').trim();
      t.descriptionRaw = text || t.detailRaw || 'Movimiento';
      if (!text) t.detailRaw = null;
    }

    // Control totals of record 33 must match the movements read.
    const totalDebit = transactions.filter((t) => t.cents < 0).reduce((a, t) => a - t.cents, 0);
    const totalCredit = transactions.filter((t) => t.cents > 0).reduce((a, t) => a + t.cents, 0);
    const declaredDebit = accounts.reduce((a, x) => a + x.debit, 0);
    const declaredCredit = accounts.reduce((a, x) => a + x.credit, 0);
    const integrityErrors: string[] = [];
    if (accounts.length && (declaredDebit !== totalDebit || declaredCredit !== totalCredit)) {
      integrityErrors.push('Los totales de control del fichero (registro 33) no coinciden con los movimientos leídos.');
    }
    const single = accounts.length === 1 ? accounts[0]! : null;
    const starts = accounts.map((a) => a.start).filter((d): d is string => !!d).sort();
    const ends = accounts.map((a) => a.end).filter((d): d is string => !!d).sort();

    return {
      parserId: this.id,
      bank: single ? (BANKS[single.entity] ?? `Entidad ${single.entity}`) : this.bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart: starts[0] ?? null,
      periodEnd: ends[ends.length - 1] ?? null,
      accountHint: single ? single.account.slice(-4) : null,
      declaredTotalCents: null,
      // With a single account, opening + movements = closing is verified by the normalizer.
      openingBalanceCents: single?.opening ?? null,
      closingBalanceCents: single?.closing ?? null,
      transactions: transactions.map(({ cents: _c, ...t }) => {
        const { concepts: _x, ref2: _r, ...rest } = t as RawTransaction & { concepts?: string[]; ref2?: string };
        return rest;
      }),
      issues,
      integrityErrors,
      verifiedByBalances: !single,
    };
  }
}
