import { describe, expect, it } from 'vitest';
import { buildLinesPdf } from '../helpers/synthetic-statement.mjs';
import { extractPdfText } from '../../src/core/parsing/pdfText';
import { selectParser } from '../../src/core/parsing/registry';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import { makeCore } from '../helpers/core';

// FICTITIOUS replica of the BBVA monthly account statement layout: two month sections, rows whose concept is above
// the dates+amounts line (layout B) or on the amounts line with the dates below (layout A), and a page break.
const PAGES = [
  [
    'Extracto de cuenta ficticio',
    'Fecha de emisión: 7 de septiembre de 2026',
    'IBAN ES00 0000 0000 0000 0000 1234  Cuenta Ficticia',
    'Movimientos de la cuenta del 01/08/2026 al 31/08/2026',
    'F. Oper.  F. Valor  Concepto  Importe  Saldo  Divisa',
    'Saldo anterior: 1.000,00 EUR',
    'PAGO CON TARJETA  -50,00  950,00  EUR',
    '03/08  02/08',
    'N 0000******0000 SUPERMERCADO FICTICIO',
    'TRANSFERENCIAS  -500,00  450,00  EUR',
    '04/08  04/08',
    'PERSONA FICTICIA UNO',
    'RECIBO LUZ',
    '05/08  05/08  -40,00  410,00  EUR',
    'COMPAÑIA ELECTRICA FICTICIA',
    '1',
    'BBVA: documento ficticio  1 de 2',
  ],
  [
    'IBAN ES00 0000 0000 0000 0000 1234  Cuenta Ficticia',
    'F. Oper.  F. Valor  Concepto  Importe  Saldo  Divisa',
    'BIZUM',
    '10/08  10/08  -20,00  390,00  EUR',
    'ENVIADO: cena',
    'ABONO DE NOMINA POR TRANSFERENCIA  1.500,00  1.890,00  EUR',
    '27/08  27/08',
    'EMPRESA FICTICIA S.L.U.',
    'Saldo a 31 de agosto: 1.890,00 EUR',
    'Movimientos de la cuenta del 01/09/2026 al 07/09/2026',
    'F. Oper.  F. Valor  Concepto  Importe  Saldo  Divisa',
    'CARGO POR AMORTIZACION DE PRESTAMO  -300,00  1.590,00  EUR',
    '01/09  01/09',
    'Saldo 7 de septiembre: 1.590,00 EUR',
    'BBVA: documento ficticio  2 de 2',
  ],
];

describe('BBVA monthly account statement (emailed, validated layout)', () => {
  it('reads both row layouts, sections, page breaks and the running balance', async () => {
    const doc = await extractPdfText(await buildLinesPdf(PAGES), 'extracto.pdf');
    const parser = selectParser(doc);
    expect(parser.id).toBe('bbva-extracto-cuenta-v1');
    const p = parser.parse(doc);
    expect(p).toMatchObject({ periodStart: '2026-08-01', periodEnd: '2026-09-07', accountHint: '1234', openingBalanceCents: 100000, closingBalanceCents: 159000 });
    expect(p.transactions.map((t) => [t.dateRaw, t.descriptionRaw, t.amountRaw, t.detailRaw])).toEqual([
      ['2026-08-03', 'PAGO CON TARJETA', '-50,00', 'N 0000******0000 SUPERMERCADO FICTICIO'],
      ['2026-08-04', 'TRANSFERENCIAS', '-500,00', 'PERSONA FICTICIA UNO'],
      ['2026-08-05', 'RECIBO LUZ', '-40,00', 'COMPAÑIA ELECTRICA FICTICIA'],
      ['2026-08-10', 'BIZUM', '-20,00', 'ENVIADO: cena'],
      ['2026-08-27', 'ABONO DE NOMINA POR TRANSFERENCIA', '1.500,00', 'EMPRESA FICTICIA S.L.U.'],
      ['2026-09-01', 'CARGO POR AMORTIZACION DE PRESTAMO', '-300,00', null],
    ]);
    const n = normalizeStatement(p);
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true);
    expect(n.blockingIssues).toEqual([]);
    expect(n.endBalance).toEqual({ cents: 159000, date: '2026-09-01' });
  });

  it('imports with account, balance and the right semantics', async () => {
    const core = makeCore({ now: '2026-09-10T10:00:00Z' });
    const out = await core.importer.importDocument({ bytes: await buildLinesPdf(PAGES), fileName: 'extracto.pdf', source: 'email' });
    expect(out).toMatchObject({ status: 'imported', inserted: 6 });
    const tx = (date: string) => core.repos.transactions.list({ from: date, to: date }).items[0]!;
    expect(tx('2026-08-04')).toMatchObject({ type: 'expense', categoryName: 'Bizum y transferencias' });
    expect(tx('2026-08-10')).toMatchObject({ type: 'expense', categoryName: 'Bizum y transferencias' });
    expect(tx('2026-08-27')).toMatchObject({ type: 'income' });
    expect(core.accounts.list()[0]).toMatchObject({ last4: '1234', balanceCents: 159000, anchor: { source: 'statement' } });
  });
});
