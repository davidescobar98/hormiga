import { parseAmountToCents } from '../../shared/money';
import { parseSpanishDate, type IsoDate } from '../../shared/dates';
import { makeYearInference } from './bbvaParser';
import type { ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * BBVA monthly ACCOUNT statement ("extracto de cuenta" sent by email, usually protected with the holder's DNI/NIE).
 * Layout validated against a real document (structure only; no data is stored in the repository).
 *
 *   IBAN ES.. .... .... .... .... ....
 *   <texto> dd/mm/aaaa <a> dd/mm/aaaa              one or more sections, each with its period
 *   F. Oper.  F. Valor  Concepto  Importe  Saldo  Divisa
 *   Saldo anterior: 1.234,56 EUR
 * Each movement spans 2–3 lines and the concept is vertically centred in its row, so the order varies:
 *   A) <concepto>  -12,34  1.222,22  EUR            B) <concepto>
 *      dd/mm  dd/mm                                     dd/mm  dd/mm  -12,34  1.222,22  EUR
 *      <detalle>                                        <detalle>
 *   Saldo a 31 de agosto: 1.222,22 EUR              closes each section
 * Every row prints the running balance, so each amount (and its sign) is verified against the previous balance.
 */

const DM = String.raw`\d{2}/\d{2}`;
const FULL = String.raw`\d{1,2}/\d{1,2}/\d{4}`;
const AMT = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}`;

export const BBVA_ACCOUNT_FORMAT = {
  header: /^F\.\s*Oper\.?\s+F\.\s*Valor\s+Concepto\s+Importe\s+Saldo/i,
  anchor: new RegExp(`^(?:(${DM})\\s+(${DM})\\s+)?(.*?)\\s*(${AMT})\\s+(${AMT})\\s+EUR$`),
  datesOnly: new RegExp(`^(${DM})\\s+(${DM})$`),
  section: new RegExp(`(${FULL})\\s*\\S{0,3}\\s*(${FULL})\\s*$`),
  balance: new RegExp(`^Saldo\\b[^:]*:\\s*(${AMT})\\s*EUR$`, 'i'),
  iban: /IBAN\s+ES\d{2}((?:\s?\d{4}){5})/i,
  ignored: [
    /^IBAN\b/i,
    /^F\.\s*Oper/i,
    /^\d{1,3}$/,
    /^-(\s+-)+$/,
    /BANCO BILBAO VIZCAYA ARGENTARIA|C\.I\.F\.|Registro Mercantil/i,
    /\b\d+\s+de\s+\d+$/,
  ],
};

interface Row extends RawTransaction {
  hasDates: boolean;
  conceptParts: string[];
  detailParts: string[];
}

export class BbvaAccountStatementParser implements StatementParser {
  readonly id = 'bbva-extracto-cuenta-v1';
  readonly bank = 'BBVA';

  detect(doc: ExtractedDocument): number {
    if (doc.mimeType !== 'application/pdf') return 0;
    const lines = doc.pages.flat().map((l) => l.trim());
    const header = lines.some((l) => BBVA_ACCOUNT_FORMAT.header.test(l));
    const anchors = lines.filter((l) => BBVA_ACCOUNT_FORMAT.anchor.test(l)).length;
    const dates = lines.filter((l) => BBVA_ACCOUNT_FORMAT.datesOnly.test(l) || /^\d{2}\/\d{2}\s+\d{2}\/\d{2}\s/.test(l)).length;
    if (!header || anchors === 0 || dates === 0) return 0;
    return lines.some((l) => /\bBBVA\b/.test(l)) ? 1 : 0.7;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const issues: string[] = [];
    const rows: Row[] = [];
    let pending: string[] = [];
    let last: Row | null = null;
    let waitingDates: Row | null = null;
    const periods: [IsoDate, IsoDate][] = [];
    const balances: number[] = [];
    let firstBalanceBeforeRows: number | null = null;
    let accountHint: string | null = null;

    const flushPendingTo = (row: Row | null) => {
      if (row && pending.length) row.detailParts.push(...pending);
      pending = [];
    };

    doc.pages.forEach((lines, pageIdx) => {
      lines.forEach((raw, lineIdx) => {
        const line = raw.trim().replace(/\s+/g, ' ');
        if (!line) return;
        const iban = BBVA_ACCOUNT_FORMAT.iban.exec(line);
        if (iban && !accountHint) accountHint = iban[1]!.replace(/\s/g, '').slice(-4);
        const bal = BBVA_ACCOUNT_FORMAT.balance.exec(line);
        if (bal) {
          const cents = parseAmountToCents(bal[1]!);
          if (cents !== null) {
            if (rows.length === 0 && firstBalanceBeforeRows === null) firstBalanceBeforeRows = cents;
            balances.push(cents);
          }
          flushPendingTo(last);
          return;
        }
        const sec = BBVA_ACCOUNT_FORMAT.section.exec(line);
        if (sec && !BBVA_ACCOUNT_FORMAT.anchor.test(line)) {
          const s = parseSpanishDate(sec[1]!);
          const e = parseSpanishDate(sec[2]!);
          if (s && e && s <= e) periods.push([s, e]);
          flushPendingTo(last);
          return;
        }
        if (BBVA_ACCOUNT_FORMAT.ignored.some((re) => re.test(line))) return;

        const a = BBVA_ACCOUNT_FORMAT.anchor.exec(line);
        if (a) {
          const [, d1, d2, conceptInline, amount, balance] = a;
          const row: Row = {
            page: pageIdx + 1, line: lineIdx + 1, rawText: line, dateRaw: d1 ?? '', valueDateRaw: d2 ?? null,
            descriptionRaw: '', detailRaw: null, amountRaw: amount!, balanceRaw: balance!, hasDates: !!d1, conceptParts: [], detailParts: [],
          };
          if (conceptInline) {
            row.conceptParts.push(conceptInline);
            flushPendingTo(last);
          } else {
            // Layout B: the concept is the text line right above; anything before it is the previous row's detail.
            const concept = pending.pop();
            flushPendingTo(last);
            if (concept) row.conceptParts.push(concept);
          }
          if (!row.hasDates) waitingDates = row;
          rows.push(row);
          last = row;
          return;
        }
        const d = BBVA_ACCOUNT_FORMAT.datesOnly.exec(line);
        if (d && waitingDates) {
          waitingDates.dateRaw = d[1]!;
          waitingDates.valueDateRaw = d[2]!;
          waitingDates.hasDates = true;
          waitingDates = null;
          flushPendingTo(last);
          return;
        }
        if (rows.length > 0) pending.push(line);
      });
    });
    flushPendingTo(last);

    const periodStart = periods.length ? periods.map((p) => p[0]).sort()[0]! : null;
    const periodEnd = periods.length ? periods.map((p) => p[1]).sort().at(-1)! : null;
    const inferYear = makeYearInference(periodStart, periodEnd);
    const transactions: RawTransaction[] = rows.map((r) => {
      if (!r.hasDates) issues.push(`Movimiento sin fecha (página ${r.page}).`);
      const concept = r.conceptParts.join(' ').trim();
      const detail = r.detailParts.join(' ').trim() || null;
      return {
        page: r.page,
        line: r.line,
        rawText: [r.rawText, ...r.detailParts].join(' ⏎ '),
        dateRaw: r.dateRaw ? parseSpanishDate(r.dateRaw, inferYear) ?? r.dateRaw : '',
        valueDateRaw: r.valueDateRaw ? parseSpanishDate(r.valueDateRaw, inferYear) ?? r.valueDateRaw : null,
        descriptionRaw: concept || detail || 'Movimiento',
        detailRaw: concept ? detail : null,
        amountRaw: r.amountRaw,
        balanceRaw: r.balanceRaw,
      };
    });

    return {
      parserId: this.id,
      bank: this.bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart,
      periodEnd,
      accountHint,
      declaredTotalCents: null,
      openingBalanceCents: firstBalanceBeforeRows,
      closingBalanceCents: balances.length > 1 ? balances.at(-1)! : null,
      transactions,
      issues,
      verifiedByBalances: transactions.length > 1 && transactions.every((t) => t.balanceRaw),
    };
  }
}
