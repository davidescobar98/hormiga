import { parseAmountToCents } from '../../shared/money';
import { parseSpanishDate, type IsoDate } from '../../shared/dates';
import { identifyBank } from './tabularParser';
import type { ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * Fallback reader for PDF statements of banks without a dedicated parser (Santander, Sabadell, ING, CaixaBank…).
 * It looks for lines shaped like "date [value date] concept amount [balance]", which is how most Spanish account
 * statements print their movements. Because the layout is not known in advance, results are only trusted when
 * they can be verified: every row against the printed running balance, or the whole document against its opening
 * and closing balances. Otherwise the document goes to review and does not count until the user checks it.
 */

const DATE = String.raw`\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?`;
const AMOUNT = String.raw`[-+−]?\s?\d{1,3}(?:\.\d{3})*,\d{2}\s?(?:€|EUR)?-?`;
const MOVEMENT = new RegExp(String.raw`^(${DATE})\s+(?:(${DATE})\s+)?(.*?\S)\s+(${AMOUNT})(?:\s+(${AMOUNT}))?$`, 'i');
const SUMMARY_LINE = /^(saldo|total|suma|sumas|importe total|retenci)/i;
const NOISE_LINE = /(p[aá]gina|p[aá]g\.|hoja)\s*\d|^fecha\b|^f\.\s?(valor|oper)|concepto\s+importe|www\.|iban\b|bic\b|swift|entidad|n\.?i\.?f/i;
const PERIOD = new RegExp(String.raw`(?:del|desde|periodo|per[ií]odo)[^\d]{0,20}(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\s*(?:al|a|hasta|-)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})`, 'i');
const OPENING = new RegExp(String.raw`saldo\s+(?:anterior|inicial|de apertura)[^\d-]*(${AMOUNT})`, 'i');
const CLOSING = new RegExp(String.raw`saldo\s+(?:final|actual|a fecha|de cierre|al \d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})[^\d-]*(${AMOUNT})`, 'i');

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Row {
  page: number;
  line: number;
  rawText: string;
  date: string;
  valueDate: string | null;
  concept: string;
  detail: string | null;
  amount: string;
  balance: string | null;
}

function findRows(doc: ExtractedDocument): Row[] {
  const rows: Row[] = [];
  doc.pages.forEach((lines, page) => {
    let last: Row | null = null;
    lines.forEach((raw, line) => {
      const text = clean(raw);
      const m = MOVEMENT.exec(text);
      if (m && !SUMMARY_LINE.test(m[3]!) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(m[3]!)) {
        last = { page: page + 1, line: line + 1, rawText: text, date: m[1]!, valueDate: m[2] ?? null, concept: m[3]!, detail: null, amount: m[4]!, balance: m[5] ?? null };
        rows.push(last);
        return;
      }
      // One continuation line right after a movement usually carries the merchant or payer.
      if (last && !last.detail && text.length <= 80 && !new RegExp(AMOUNT).test(text) && !SUMMARY_LINE.test(text) && !NOISE_LINE.test(text) && !new RegExp(`^${DATE}`).test(text)) {
        last.detail = text;
        last.rawText += `\n${text}`;
      }
      last = null;
    });
  });
  return rows;
}

function fullDate(raw: string, yearFor: (month: number) => number | null): string {
  if (/[/.-]\d{2,4}$/.test(raw) && raw.split(/[/.-]/).length === 3) return raw;
  const month = Number(raw.split(/[/.-]/)[1]);
  const y = yearFor(month);
  return y ? `${raw}/${y}` : raw;
}

export class GenericPdfStatementParser implements StatementParser {
  readonly id = 'generic-pdf-v1';
  readonly bank = 'Otro banco';

  detect(doc: ExtractedDocument): number {
    if (doc.mimeType !== 'application/pdf') return 0;
    return findRows(doc).length >= 3 ? 0.55 : 0;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const text = doc.pages.flat().join('\n');
    const rows = findRows(doc);
    const bank = identifyBank([], `${text} ${doc.fileName}`);
    const issues: string[] = [];
    const integrityErrors: string[] = [];

    const period = PERIOD.exec(text);
    const periodStart: IsoDate | null = period ? parseSpanishDate(period[1]!) : null;
    const periodEnd: IsoDate | null = period ? parseSpanishDate(period[2]!) : null;
    // Year for dates printed as dd/mm: from the period, or the most frequent year in the document.
    const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    const common = years.length ? [...years.reduce((m, y) => m.set(y, (m.get(y) ?? 0) + 1), new Map<number, number>())].sort((a, b) => b[1] - a[1])[0]![0] : null;
    const yearFor = (month: number): number | null => {
      if (periodStart && periodEnd) {
        const [ys, ms] = [Number(periodStart.slice(0, 4)), Number(periodStart.slice(5, 7))];
        const ye = Number(periodEnd.slice(0, 4));
        return ys === ye || month >= ms ? ys : ye;
      }
      return common;
    };

    const transactions: RawTransaction[] = rows.map((r) => ({
      page: r.page,
      line: r.line,
      rawText: r.rawText,
      dateRaw: fullDate(r.date, yearFor),
      valueDateRaw: r.valueDate ? fullDate(r.valueDate, yearFor) : null,
      descriptionRaw: r.concept,
      detailRaw: r.detail,
      amountRaw: r.amount,
      balanceRaw: r.balance,
    }));

    const opening = OPENING.exec(text);
    const closing = CLOSING.exec(text);
    const openingBalanceCents = opening ? parseAmountToCents(opening[1]!) : null;
    const closingBalanceCents = closing ? parseAmountToCents(closing[1]!) : null;
    const withBalance = rows.filter((r) => r.balance !== null).length;
    const verifiedByBalances = rows.length > 1 && withBalance === rows.length;
    const hasTotals = openingBalanceCents !== null && closingBalanceCents !== null;

    if (!verifiedByBalances && !hasTotals) {
      integrityErrors.push(
        `Extracto PDF de ${bank === 'Otro banco' ? 'un banco sin lector específico' : bank} leído con el lector genérico y sin saldos para comprobarlo: revisa los movimientos (sobre todo el signo de cada importe) antes de que cuenten.`,
      );
    } else {
      issues.push(`Leído con el lector genérico de PDF (${bank}). Los importes se han comprobado con los saldos impresos.`);
    }

    return {
      parserId: this.id,
      bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart,
      periodEnd,
      accountHint: null,
      declaredTotalCents: null,
      openingBalanceCents,
      closingBalanceCents,
      transactions,
      issues,
      integrityErrors,
      verifiedByBalances,
    };
  }
}
