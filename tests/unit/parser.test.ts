import { describe, expect, it } from 'vitest';
import { buildStatementPdf, sampleCardSpec } from '../helpers/synthetic-statement.mjs';
import { extractPdfText, itemsToLines } from '../../src/core/parsing/pdfText';
import { BbvaStatementParser } from '../../src/core/parsing/bbvaParser';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import { extractDocument, selectParser } from '../../src/core/parsing/registry';
import { AppError } from '../../src/core/errors';
import type { ExtractedDocument } from '../../src/core/parsing/types';

const parser = new BbvaStatementParser();

async function parsePdf(spec: Parameters<typeof buildStatementPdf>[0]) {
  const bytes = await buildStatementPdf(spec);
  const doc = await extractPdfText(bytes, 'test.pdf');
  return { doc, parsed: parser.parse(doc), normalized: normalizeStatement(parser.parse(doc)) };
}

describe('PDF text extraction', () => {
  it('rebuilds lines with column gaps', async () => {
    const bytes = await buildStatementPdf(sampleCardSpec());
    const doc = await extractPdfText(bytes, 'x.pdf');
    const lines = doc.pages[0]!;
    expect(lines.some((l) => /^02\/08\/2026\s{2,}COMPRA TARJ\. MERCADONA 1234 MADRID\s{2,}45,20$/.test(l))).toBe(true);
  });

  it('groups items on the same baseline and sorts by x', () => {
    const it = (str: string, x: number, y: number) => ({ str, transform: [9, 0, 0, 9, x, y], width: str.length * 5, height: 9 });
    expect(itemsToLines([it('B', 100, 700), it('A', 10, 700.8), it('C', 10, 680)])).toEqual(['A  B', 'C']);
  });

  it('rejects invalid documents with a typed error', async () => {
    await expect(extractPdfText(new TextEncoder().encode('no soy un pdf'), 'x.pdf')).rejects.toMatchObject({ code: 'PDF_INVALID' });
    const broken = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage');
    await expect(extractPdfText(broken, 'roto.pdf')).rejects.toBeInstanceOf(AppError);
  });
});

describe('BbvaStatementParser', () => {
  it('parses a one-page card statement: dates, amounts, refund, thousands separator, split description', async () => {
    const { doc, parsed, normalized } = await parsePdf(sampleCardSpec());
    expect(parser.detect(doc)).toBeGreaterThanOrEqual(0.8);
    expect(parsed.kind).toBe('card');
    expect(parsed.periodStart).toBe('2026-08-01');
    expect(parsed.periodEnd).toBe('2026-08-31');
    expect(parsed.accountHint).toBe('0000');
    expect(parsed.declaredTotalCents).toBe(133326);
    expect(normalized.candidates).toHaveLength(6);
    expect(normalized.blockingIssues).toEqual([]);
    const c = normalized.candidates;
    expect(c[0]).toMatchObject({ date: '2026-08-02', amountCents: -4520, type: 'expense', errors: [] });
    expect(c[2]!.descriptionRaw).toBe('PAGO EN RESTAURANTE CASA FICTICIA CALLE INVENTADA 1');
    expect(c[4]!.amountCents).toBe(-123456);
    expect(c[5]).toMatchObject({ amountCents: 1999, type: 'refund' });
    expect(normalized.computedTotalCents).toBe(133326);
  });

  it('parses multi-page statements and ignores page headers/footers', async () => {
    const spec = sampleCardSpec({
      pages: [
        [
          { date: '02/08/2026', desc: 'LIDL SUPERMERCADOS', amount: '10,00' },
          { date: '03/08/2026', desc: 'REPSOL E.S. 5521', amount: '50,00' },
        ],
        [
          { date: '15/08/2026', desc: 'CINESA PROYECCIONES', amount: '9,50' },
          { date: '16/08/2026', desc: 'FARMACIA CENTRAL', amount: '4,35' },
        ],
      ],
      total: '73,85',
    });
    const { normalized } = await parsePdf(spec);
    expect(normalized.candidates.map((c) => c.amountCents)).toEqual([-1000, -5000, -950, -435]);
    expect(normalized.blockingIssues).toEqual([]);
  });

  it('flags a total mismatch as a blocking issue (never imports silently)', async () => {
    const { normalized } = await parsePdf(sampleCardSpec({ total: '1.400,00' }));
    expect(normalized.blockingIssues[0]).toContain('no coincide');
  });

  it('parses account statements with signed amounts and running balance, fixing signs from the balance', async () => {
    const { parsed, normalized } = await parsePdf({
      kind: 'account',
      period: ['01/07/2026', '31/07/2026'],
      opening: '1.000,00',
      pages: [[
        { date: '01/07/2026', valueDate: '01/07/2026', desc: 'ABONO NOMINA EMPRESA FICTICIA', amount: '2.000,00', balance: '3.000,00' },
        { date: '02/07/2026', valueDate: '02/07/2026', desc: 'RECIBO ALQUILER VIVIENDA', amount: '-800,00', balance: '2.200,00' },
        // Sign missing in the source: the balance tells us it is a charge.
        { date: '05/07/2026', valueDate: '05/07/2026', desc: 'COMPRA MERCADONA', amount: '55,10', balance: '2.144,90' },
      ]],
      closing: '2.144,90',
    });
    expect(parsed.kind).toBe('account');
    expect(normalized.candidates.map((c) => c.amountCents)).toEqual([200000, -80000, -5510]);
    expect(normalized.candidates[0]!.type).toBe('income');
    expect(normalized.blockingIssues).toEqual([]);
    expect(normalized.warnings.join(' ')).toContain('corregido el signo');
  });

  it('marks rows with impossible dates for review', async () => {
    const { normalized } = await parsePdf(sampleCardSpec({
      pages: [[{ date: '31/02/2026', desc: 'COMPRA RARA', amount: '10,00' }, { date: '02/08/2026', desc: 'MERCADONA', amount: '5,00' }]],
      total: '15,00',
    }));
    // "31/02/2026" is not a valid date: the row is not matched as a date line or is flagged
    const bad = normalized.candidates.find((c) => c.errors.length > 0);
    const unrecognised = normalized.warnings.some((w) => w.includes('no se reconocieron'));
    expect(bad !== undefined || unrecognised).toBe(true);
  });

  it('flags movements outside the statement period', async () => {
    const { normalized } = await parsePdf(sampleCardSpec({
      pages: [[{ date: '02/01/2025', desc: 'MERCADONA', amount: '5,00' }]],
      total: '5,00',
    }));
    expect(normalized.candidates[0]!.errors.join(' ')).toContain('fuera del periodo');
  });

  it('does not treat summary lines as movements', () => {
    const doc: ExtractedDocument = {
      fileName: 'x',
      mimeType: 'application/pdf',
      pages: [['BBVA', '01/08/2026  SALDO ANTERIOR  100,00', '02/08/2026  MERCADONA  5,00', '31/08/2026  TOTAL  5,00']],
    };
    expect(parser.parse(doc).transactions).toHaveLength(1);
  });
});

describe('parser selection', () => {
  it('rejects documents that are not BBVA statements', async () => {
    const bytes = await buildStatementPdf({ omitBank: true, pages: [[]] });
    const doc = await extractDocument(bytes, 'otro.pdf');
    expect(() => selectParser(doc)).toThrow(AppError);
  });

  it('routes CSV files to the CSV parser', async () => {
    const doc = await extractDocument(new TextEncoder().encode('Fecha;Concepto;Importe\n01/08/2026;MERCADONA;-10,00\n'), 'mov.csv');
    expect(selectParser(doc).id).toBe('tabla-bancaria-v1');
  });
});
