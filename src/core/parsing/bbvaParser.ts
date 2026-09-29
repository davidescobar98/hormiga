import { parseAmountToCents } from '../../shared/money';
import { parseSpanishDate, type IsoDate } from '../../shared/dates';
import type { StatementKind } from '../domain/transactionType';
import type { ExtractedDocument, ParsedStatement, RawTransaction, SignConvention, StatementParser } from './types';

/*
 * BBVA statement parser (PDF text).
 *
 * IMPORTANT: this parser has been built from the public, generic structure of Spanish bank statements
 * ("fecha operación / fecha valor / concepto / importe / saldo") and is covered by synthetic fixtures.
 * It has NOT been validated against a real BBVA document yet. Everything format-specific lives in
 * BBVA_FORMAT so it can be adjusted without touching the pipeline.
 */

const DATE = String.raw`\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?`;
const DATE_TEXT = String.raw`\d{1,2}[\s-](?:ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|SEPT|OCT|NOV|DIC)[A-Z]*[\s-]\d{2,4}`;
const ANY_DATE = `(?:${DATE}|${DATE_TEXT})`;
const AMOUNT = String.raw`[-+−]?\s?\d{1,3}(?:\.\d{3})*,\d{2}\s?-?(?:\s?(?:€|EUR))?|[-+−]?\s?\d+,\d{2}\s?-?(?:\s?(?:€|EUR))?`;

export const BBVA_FORMAT = {
  identity: [/\bBBVA\b/i, /BANCO BILBAO VIZCAYA ARGENTARIA/i],
  cardHints: [/TARJETA/i, /LIQUIDACI[OÓ]N/i, /L[IÍ]MITE DE CR[EÉ]DITO|CR[EÉ]DITO DISPONIBLE|IMPORTE A PAGAR|FORMA DE PAGO/i],
  accountHints: [/EXTRACTO DE (?:LA )?CUENTA|CUENTA (?:ONLINE|CORRIENTE|NÓMINA|NOMINA)|SALDO ANTERIOR|SALDO INICIAL/i],
  transactionLine: new RegExp(`^(${ANY_DATE})\\s+(?:(${ANY_DATE})\\s+)?(.*?)\\s*(?<!\\d)(${AMOUNT})(?:\\s+(${AMOUNT}))?\\s*$`, 'i'),
  /** Lines that look like movements but are summaries. */
  nonTransactionDescriptions: /^(SALDO\b|TOTAL\b|SUMA\b|SUBTOTAL\b|IMPORTE TOTAL|RESUMEN\b|L[IÍ]MITE\b|DISPONIBLE\b|FECHA\b|PAGO M[IÍ]NIMO)/i,
  ignoredLines: [
    /^P[AÁ]G(?:INA)?\.?\s*\d+/i,
    /^\d+\s*(?:\/|DE)\s*\d+$/i,
    /\bFECHA\b.*\b(CONCEPTO|IMPORTE|OPERACI[OÓ]N|VALOR)\b/i,
    /^F\.?\s?(OPER|VALOR)/i,
    /BANCO BILBAO VIZCAYA|REGISTRO MERCANTIL|C\.?I\.?F\.?\s*[A-Z]?\d/i,
    /^(IBAN|BIC|SWIFT|TITULAR|N[ºO°]\s?(DE\s)?(CUENTA|TARJETA)|CONTRATO)\b/i,
    /^(SALDO|TOTAL|SUMA|SUBTOTAL|IMPORTE TOTAL|RESUMEN|L[IÍ]MITE|DISPONIBLE|PAGO M[IÍ]NIMO)\b/i,
    /^(MOVIMIENTOS|DETALLE DE MOVIMIENTOS|EXTRACTO)\b/i,
  ],
  period: [
    new RegExp(`(?:PER[IÍ]ODO|DEL|DESDE|FECHAS?)\\s*:?\\s*(?:DEL\\s+)?(${ANY_DATE})\\s*(?:-|–|A|AL|HASTA)\\s*(${ANY_DATE})`, 'i'),
  ],
  periodEnd: [new RegExp(`FECHA\\s+(?:DE\\s+)?(?:LIQUIDACI[OÓ]N|EXTRACTO|EMISI[OÓ]N|CORTE|CARGO)\\s*:?\\s*(${ANY_DATE})`, 'i')],
  openingBalance: new RegExp(`SALDO\\s+(?:ANTERIOR|INICIAL)[^\\d\\-+]*?(${AMOUNT})\\s*$`, 'i'),
  closingBalance: new RegExp(`SALDO\\s+(?:FINAL|ACTUAL|A\\s+FECHA)[^\\d\\-+]*?(${AMOUNT})\\s*$`, 'i'),
  declaredTotal: new RegExp(`(?:TOTAL\\s+(?:MOVIMIENTOS|OPERACIONES|COMPRAS|DEL\\s+PER[IÍ]ODO|LIQUIDACI[OÓ]N|A\\s+PAGAR|EXTRACTO)|IMPORTE\\s+TOTAL(?:\\s+(?:LIQUIDADO|A\\s+PAGAR))?)[^\\d\\-+]*?(${AMOUNT})\\s*$`, 'i'),
  totalCharges: new RegExp(`TOTAL\\s+(?:CARGOS|ADEUDOS|DEBE)[^\\d\\-+]*?(${AMOUNT})\\s*$`, 'i'),
  totalCredits: new RegExp(`TOTAL\\s+(?:ABONOS|HABER|DEVOLUCIONES)[^\\d\\-+]*?(${AMOUNT})\\s*$`, 'i'),
  maskedNumber: /(?:[X*•]{2,}[\s-]?){1,3}(\d{4})\b/i,
  maxContinuationLines: 2,
};

function stripCurrency(s: string): string {
  return s.replace(/\s?(€|EUR)$/i, '').trim();
}

export class BbvaStatementParser implements StatementParser {
  readonly id = 'bbva-pdf-v1';
  readonly bank = 'BBVA';

  detect(doc: ExtractedDocument): number {
    if (doc.mimeType !== 'application/pdf') return 0;
    const text = doc.pages.flat().join('\n');
    let score = 0;
    if (BBVA_FORMAT.identity[0]!.test(text)) score += 0.6;
    if (BBVA_FORMAT.identity[1]!.test(text)) score += 0.2;
    const txLines = doc.pages.flat().filter((l) => BBVA_FORMAT.transactionLine.test(l)).length;
    if (txLines > 0) score += 0.2;
    return Math.min(1, score);
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const all = doc.pages.flat();
    const text = all.join('\n');
    const issues: string[] = [];

    // ── Period ──
    let periodStart: IsoDate | null = null;
    let periodEnd: IsoDate | null = null;
    for (const line of all) {
      for (const re of BBVA_FORMAT.period) {
        const m = re.exec(line);
        if (m && !periodStart) {
          const s = parseSpanishDate(m[1]!);
          const e = parseSpanishDate(m[2]!);
          if (s && e && s <= e) {
            periodStart = s;
            periodEnd = e;
          }
        }
      }
    }
    if (!periodEnd) {
      for (const line of all) {
        for (const re of BBVA_FORMAT.periodEnd) {
          const m = re.exec(line);
          const d = m ? parseSpanishDate(m[1]!) : null;
          if (d && !periodEnd) periodEnd = d;
        }
      }
    }

    // ── Kind & totals ──
    const cardScore = BBVA_FORMAT.cardHints.filter((re) => re.test(text)).length;
    const accountScore = BBVA_FORMAT.accountHints.filter((re) => re.test(text)).length;
    let opening: number | null = null;
    let closing: number | null = null;
    let declared: number | null = null;
    let charges: number | null = null;
    let credits: number | null = null;
    for (const line of all) {
      const upper = line.toUpperCase();
      let m = BBVA_FORMAT.openingBalance.exec(upper);
      if (m && opening === null) opening = parseAmountToCents(stripCurrency(m[1]!));
      m = BBVA_FORMAT.closingBalance.exec(upper);
      if (m && closing === null) closing = parseAmountToCents(stripCurrency(m[1]!));
      m = BBVA_FORMAT.declaredTotal.exec(upper);
      if (m && declared === null) declared = parseAmountToCents(stripCurrency(m[1]!));
      m = BBVA_FORMAT.totalCharges.exec(upper);
      if (m && charges === null) charges = parseAmountToCents(stripCurrency(m[1]!));
      m = BBVA_FORMAT.totalCredits.exec(upper);
      if (m && credits === null) credits = parseAmountToCents(stripCurrency(m[1]!));
    }
    if (declared === null && charges !== null) declared = Math.abs(charges) - Math.abs(credits ?? 0);

    const accountHintMatch = BBVA_FORMAT.maskedNumber.exec(text);
    const accountHint = accountHintMatch ? accountHintMatch[1]! : null;

    // ── Movements ──
    const inferYear = makeYearInference(periodStart, periodEnd);
    const transactions: RawTransaction[] = [];
    let unrecognised = 0;
    doc.pages.forEach((lines, pageIdx) => {
      let current: RawTransaction | null = null;
      let continuation = 0;
      lines.forEach((line, lineIdx) => {
        const trimmed = line.trim();
        const m = BBVA_FORMAT.transactionLine.exec(trimmed);
        if (m) {
          const description = (m[3] ?? '').trim();
          if (BBVA_FORMAT.nonTransactionDescriptions.test(description)) {
            current = null;
            return;
          }
          current = {
            page: pageIdx + 1,
            line: lineIdx + 1,
            rawText: trimmed,
            dateRaw: m[1]!,
            valueDateRaw: m[2] ?? null,
            descriptionRaw: description,
            amountRaw: stripCurrency(m[4]!),
            balanceRaw: m[5] ? stripCurrency(m[5]) : null,
          };
          transactions.push(current);
          continuation = 0;
          return;
        }
        if (BBVA_FORMAT.ignoredLines.some((re) => re.test(trimmed))) {
          current = null;
          return;
        }
        // Continuation of a long/split description (no date, no amount).
        const looksLikeData = new RegExp(`^${ANY_DATE}\\b`, 'i').test(trimmed) || new RegExp(`(${AMOUNT})$`).test(trimmed);
        if (current && !looksLikeData && continuation < BBVA_FORMAT.maxContinuationLines && trimmed.length <= 90) {
          const tx = current as RawTransaction;
          tx.descriptionRaw = `${tx.descriptionRaw} ${trimmed}`.trim();
          tx.rawText = `${tx.rawText} ⏎ ${trimmed}`;
          continuation++;
          return;
        }
        current = null;
        if (new RegExp(`^${ANY_DATE}\\b`, 'i').test(trimmed)) unrecognised++;
      });
    });
    if (unrecognised > 0) issues.push(`${unrecognised} línea(s) empiezan por fecha pero no se reconocieron como movimiento.`);

    const hasBalances = transactions.length > 0 && transactions.filter((t) => t.balanceRaw).length >= transactions.length * 0.6;
    const kind: StatementKind = hasBalances || accountScore > cardScore ? 'account' : 'card';
    const signConvention: SignConvention = kind === 'card' ? 'charges_positive' : 'charges_negative';

    // Dates without year need the period; resolve them now so later validation sees full dates.
    for (const t of transactions) {
      t.dateRaw = resolveDate(t.dateRaw, inferYear) ?? t.dateRaw;
      if (t.valueDateRaw) t.valueDateRaw = resolveDate(t.valueDateRaw, inferYear) ?? t.valueDateRaw;
    }

    return {
      parserId: this.id,
      bank: this.bank,
      kind,
      signConvention,
      periodStart,
      periodEnd,
      accountHint,
      declaredTotalCents: kind === 'card' ? declared : null,
      openingBalanceCents: opening,
      closingBalanceCents: closing,
      transactions,
      issues,
    };
  }
}

function resolveDate(raw: string, inferYear: ((month: number) => number) | undefined): string | null {
  const iso = parseSpanishDate(raw, inferYear);
  return iso;
}

/** For "dd/mm" dates: pick the year from the statement period (handles December→January statements). */
export function makeYearInference(start: IsoDate | null, end: IsoDate | null): ((month: number) => number) | undefined {
  const ref = end ?? start;
  if (!ref) return undefined;
  const refYear = Number(ref.slice(0, 4));
  const refMonth = Number(ref.slice(5, 7));
  return (month: number) => (month > refMonth + 1 ? refYear - 1 : refYear);
}
