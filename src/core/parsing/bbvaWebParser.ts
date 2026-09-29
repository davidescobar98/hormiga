import { parseSpanishDate } from '../../shared/dates';
import type { ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * BBVA "Últimos movimientos" (account movements exported/printed from BBVA online banking to PDF).
 * Validated against a real document (layout only; no data is stored in the repository).
 *
 * Each movement spans 2–3 lines:
 *   dd/mm/aaaa  <concepto>  <importe> €  <saldo> €
 *   Fecha valor [dd/mm/aaaa]  <detalle>          (detail: merchant, payer, Bizum note, direct-debit reference…)
 *   [dd/mm/aaaa]                                  (value date, when not inline)
 * At page breaks a row can be split: its amounts (sometimes with the concept) stay at the bottom of one page and the
 * date (+ concept) appears at the top of the next one.
 */

const DATE = String.raw`\d{2}/\d{2}/\d{4}`;
const AMT = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}`;
const EUR = String.raw`\s*(?:€|EUR)`;

export const BBVA_WEB_FORMAT = {
  marker: /^[ÚU]ltimos movimientos/i,
  header: /^Fecha\s+Concepto\s+Importe\s+Saldo$/i,
  fullRow: new RegExp(`^(${DATE})\\s+(.+?)\\s+(${AMT})${EUR}\\s+(${AMT})${EUR}$`),
  amountsOnly: new RegExp(`^(${AMT})${EUR}\\s+(${AMT})${EUR}$`),
  conceptAndAmounts: new RegExp(`^(.+?)\\s+(${AMT})${EUR}\\s+(${AMT})${EUR}$`),
  dateAndText: new RegExp(`^(${DATE})\\s+(.+)$`),
  dateOnly: new RegExp(`^(${DATE})$`),
  valueDate: new RegExp(`^Fecha valor(?:\\s+(${DATE}))?(?:\\s+(.*))?$`, 'i'),
  ignored: [/^BANCO BILBAO VIZCAYA ARGENTARIA/i, /^\d{1,3}\s*\/\s*\d{1,3}$/, /^[ÚU]ltimos movimientos/i, /^Fecha\s+Concepto\s+Importe\s+Saldo$/i],
};

interface Row extends RawTransaction {
  detailParts: string[];
  stage: 'main' | 'afterValueLabel' | 'done';
}

export class BbvaWebMovementsParser implements StatementParser {
  readonly id = 'bbva-web-movimientos-v1';
  readonly bank = 'BBVA';

  detect(doc: ExtractedDocument): number {
    if (doc.mimeType !== 'application/pdf') return 0;
    const lines = doc.pages.flat();
    const hasBank = lines.some((l) => /BANCO BILBAO VIZCAYA ARGENTARIA|\bBBVA\b/i.test(l));
    const hasHeader = lines.some((l) => BBVA_WEB_FORMAT.header.test(l.trim()));
    const valueLines = lines.filter((l) => BBVA_WEB_FORMAT.valueDate.test(l.trim())).length;
    const rows = lines.filter((l) => BBVA_WEB_FORMAT.fullRow.test(l.trim())).length;
    if (!hasHeader || valueLines === 0 || rows === 0) return 0;
    return hasBank ? 1 : 0.6;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const rows: Row[] = [];
    const issues: string[] = [];
    let current: Row | null = null;
    let orphan: { concept: string | null; amount: string; balance: string; page: number; line: number; raw: string } | null = null;
    let unrecognised = 0;

    const newRow = (page: number, line: number, raw: string, date: string, concept: string, amount: string, balance: string): Row => {
      const r: Row = { page, line, rawText: raw, dateRaw: date, valueDateRaw: null, descriptionRaw: concept.trim(), amountRaw: amount, balanceRaw: balance, detailRaw: null, detailParts: [], stage: 'main' };
      rows.push(r);
      return r;
    };

    doc.pages.forEach((lines, p) => {
      lines.forEach((rawLine, i) => {
        const line = rawLine.trim();
        if (!line || BBVA_WEB_FORMAT.ignored.some((re) => re.test(line))) return;
        let m: RegExpExecArray | null;

        if ((m = BBVA_WEB_FORMAT.fullRow.exec(line))) {
          current = newRow(p + 1, i + 1, line, m[1]!, m[2]!, m[3]!, m[4]!);
          orphan = null;
          return;
        }
        if ((m = BBVA_WEB_FORMAT.amountsOnly.exec(line))) {
          orphan = { concept: null, amount: m[1]!, balance: m[2]!, page: p + 1, line: i + 1, raw: line };
          current = null;
          return;
        }
        if ((m = BBVA_WEB_FORMAT.valueDate.exec(line))) {
          const row = current as Row | null;
          if (row) {
            if (m[1]) row.valueDateRaw = m[1];
            if (m[2]?.trim()) row.detailParts.push(m[2].trim());
            row.rawText += ` ⏎ ${line}`;
            row.stage = m[1] ? 'done' : 'afterValueLabel';
          } else unrecognised++;
          return;
        }
        if ((m = BBVA_WEB_FORMAT.dateOnly.exec(line))) {
          const o = orphan as typeof orphan;
          const row = current as Row | null;
          if (o && o.concept) {
            current = newRow(o.page, o.line, `${m[1]}  ${o.raw}`, m[1]!, o.concept, o.amount, o.balance);
            orphan = null;
          } else if (row && !row.valueDateRaw) {
            row.valueDateRaw = m[1]!;
            row.rawText += ` ⏎ ${line}`;
            row.stage = 'done';
          } else unrecognised++;
          return;
        }
        if ((m = BBVA_WEB_FORMAT.dateAndText.exec(line))) {
          const o = orphan as typeof orphan;
          const row = current as Row | null;
          if (o && !o.concept) {
            current = newRow(p + 1, i + 1, `${line}  ${o.raw}`, m[1]!, m[2]!, o.amount, o.balance);
            orphan = null;
          } else if (row && row.stage === 'afterValueLabel' && !row.valueDateRaw) {
            // Value date followed by the end of a long detail that wrapped.
            row.valueDateRaw = m[1]!;
            row.detailParts.push(m[2]!.trim());
            row.rawText += ` ⏎ ${line}`;
            row.stage = 'done';
          } else unrecognised++;
          return;
        }
        if ((m = BBVA_WEB_FORMAT.conceptAndAmounts.exec(line))) {
          orphan = { concept: m[1]!, amount: m[2]!, balance: m[3]!, page: p + 1, line: i + 1, raw: line };
          current = null;
          return;
        }
        // Wrapped continuation of a detail.
        const row = current as Row | null;
        if (row && row.stage !== 'main' && row.detailParts.length > 0 && line.length <= 90) {
          row.detailParts.push(line);
          row.rawText += ` ⏎ ${line}`;
          return;
        }
        unrecognised++;
      });
    });

    if (orphan) issues.push('Al final del documento quedó un importe sin fecha: revisa si falta un movimiento.');
    if (unrecognised > 0) issues.push(`${unrecognised} línea(s) no se reconocieron.`);

    const transactions: RawTransaction[] = rows.map(({ detailParts, stage: _stage, ...r }) => ({
      ...r,
      detailRaw: detailParts.length ? detailParts.join(' ').replace(/\s+/g, ' ').trim() : null,
    }));
    const dates = transactions.map((t) => parseSpanishDate(t.dateRaw)).filter((d): d is string => !!d).sort();

    return {
      parserId: this.id,
      bank: this.bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      accountHint: null,
      declaredTotalCents: null,
      openingBalanceCents: null,
      closingBalanceCents: null,
      transactions,
      issues,
      verifiedByBalances: true,
    };
  }
}
