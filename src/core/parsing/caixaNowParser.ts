import { parseSpanishDate } from '../../shared/dates';
import type { ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * CaixaBankNow account movements printed to PDF from the online banking ("CaixaBank | banca digital CaixaBankNow").
 * Validated against the layout of a real document (no data is stored in the repository).
 *
 *   n/N                                                    (page counter, top of every page)
 *   <titular y cuenta>  ESkk 2100 xxxx xxxx xxxx xxxx     (first page)
 *   Periodo dd/mm/aaaa - dd/mm/aaaa  Saldo disponible     (first page)
 *   Concepto  Fecha  Importe Saldo                        (first page)
 *   <concepto>  dd/mm/aaaa  ±importe€  saldo€             (one line per movement, newest first)
 *
 * Amounts carry an explicit sign; the thousands separator only appears from 10.000 (e.g. «-1234,56€», «+12.345,67€»).
 * Every row has the running balance, so the importer verifies the whole chain.
 */

const DATE = String.raw`\d{2}/\d{2}/\d{4}`;
const AMT = String.raw`\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}`;

export const CAIXA_NOW_FORMAT = {
  header: /^Concepto\s+Fecha\s+Importe\s+Saldo$/i,
  row: new RegExp(`^(.+?)\\s+(${DATE})\\s+([+-]?(?:${AMT}))\\s*€\\s+(-?(?:${AMT}))\\s*€$`),
  period: new RegExp(`^Periodo\\s+(${DATE})\\s*-\\s*(${DATE})(?:\\s+Saldo.*)?$`, 'i'),
  iban: /\bES\d{2}\s?2100(?:\s?\d{4}){4}\b/,
  pageCounter: /^\d{1,4}\s*\/\s*\d{1,4}$/,
};

/** Text extraction can leave NUL and other control characters in web-printed PDFs. */
const clean = (l: string) => [...l].filter((ch) => ch.charCodeAt(0) >= 32).join('').trim();

export class CaixaBankNowParser implements StatementParser {
  readonly id = 'caixabank-now-movimientos-v1';
  readonly bank = 'CaixaBank';

  detect(doc: ExtractedDocument): number {
    if (doc.mimeType !== 'application/pdf') return 0;
    const lines = doc.pages.flat().map(clean);
    if (!lines.some((l) => CAIXA_NOW_FORMAT.header.test(l))) return 0;
    const rows = lines.filter((l) => CAIXA_NOW_FORMAT.row.test(l)).length;
    if (rows === 0) return 0;
    const caixa = lines.some((l) => CAIXA_NOW_FORMAT.iban.test(l) || /caixabank/i.test(l));
    const period = lines.some((l) => CAIXA_NOW_FORMAT.period.test(l));
    return caixa ? 1 : period ? 0.7 : 0.5;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const transactions: RawTransaction[] = [];
    const issues: string[] = [];
    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    let accountHint: string | null = null;
    let unrecognised = 0;

    doc.pages.forEach((lines, p) => {
      lines.forEach((rawLine, i) => {
        const line = clean(rawLine);
        if (!line || CAIXA_NOW_FORMAT.pageCounter.test(line) || CAIXA_NOW_FORMAT.header.test(line)) return;
        let m: RegExpExecArray | null;
        if ((m = CAIXA_NOW_FORMAT.row.exec(line))) {
          transactions.push({ page: p + 1, line: i + 1, rawText: line, dateRaw: m[2]!, valueDateRaw: null, descriptionRaw: m[1]!.trim(), amountRaw: m[3]!.replace(/^\+/, ''), balanceRaw: m[4]!, detailRaw: null });
          return;
        }
        if ((m = CAIXA_NOW_FORMAT.period.exec(line))) {
          periodStart = parseSpanishDate(m[1]!);
          periodEnd = parseSpanishDate(m[2]!);
          return;
        }
        const iban = CAIXA_NOW_FORMAT.iban.exec(line);
        if (iban && !accountHint) {
          accountHint = iban[0].replace(/\s/g, '').slice(-4);
          return;
        }
        unrecognised++;
      });
    });

    if (unrecognised > 0) issues.push(`${unrecognised} línea(s) no se reconocieron.`);
    if (!periodStart || !periodEnd) {
      const dates = transactions.map((t) => parseSpanishDate(t.dateRaw)).filter((d): d is string => !!d).sort();
      periodStart ??= dates[0] ?? null;
      periodEnd ??= dates[dates.length - 1] ?? null;
    }

    return {
      parserId: this.id,
      bank: this.bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart,
      periodEnd,
      accountHint,
      declaredTotalCents: null,
      openingBalanceCents: null,
      closingBalanceCents: null,
      transactions,
      issues,
      verifiedByBalances: true,
    };
  }
}
