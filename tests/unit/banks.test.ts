import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { extractDocument, selectParser } from '../../src/core/parsing/registry';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import { excelSerialToIso } from '../../src/core/parsing/tabularParser';
import { makeCore } from '../helpers/core';

/*
 * FICTITIOUS files reproducing the layout of each bank's export (researched from public docs and open-source
 * importers). No real data. Balances are consistent so every row is verified.
 */

type Row = (string | number | null)[];

function workbook(rows: Row[], type: 'biff8' | 'xlsx', sheetName = 'Movimientos'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: type }) as ArrayBuffer);
}

/** Excel serial for a date (1900 system). */
const serial = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000) + 25569;

async function parse(bytes: Uint8Array, fileName: string) {
  const doc = await extractDocument(bytes, fileName);
  const parser = selectParser(doc);
  const parsed = parser.parse(doc);
  return { parser, parsed, n: normalizeStatement(parsed) };
}

describe('CaixaBank / imagin (.xls BIFF, header on row 3)', () => {
  const rows: Row[] = [
    ['Movimientos de la cuenta ES00 2100 0000 0000 0000 1234', null, null, null, null, null],
    [null, null, null, null, null, null],
    ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'],
    ['05/09/2026', '05/09/2026', 'MERCADONA LA PLA', 'Fecha de operación: 04-09-2026 MERCADONA S.A.', -45.2, 954.8],
    ['03/09/2026', '03/09/2026', 'TRANSF A FAVOR', 'EMPRESA FICTICIA SL NOMINA SEPTIEMBRE', 1000, 1000],
  ];

  it('reads the binary .xls, maps "Movimiento" + "Más datos" and verifies balances', async () => {
    const { parser, parsed, n } = await parse(workbook(rows, 'biff8'), 'movimientos.xls');
    expect(parser.id).toBe('tabla-bancaria-v1');
    expect(parsed.bank).toBe('CaixaBank / imagin');
    expect(parsed.accountHint).toBe('1234');
    expect(parsed.verifiedByBalances).toBe(true);
    expect(n.candidates.map((c) => [c.date, c.amountCents])).toEqual([['2026-09-05', -4520], ['2026-09-03', 100000]]);
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true);
    // The "Fecha de operación" noise is removed from the detail.
    expect(n.candidates[0]!.descriptionRaw).toBe('MERCADONA LA PLA · MERCADONA S.A.');
    expect(n.candidates[0]!.merchant?.display).toBe('Mercadona');
    expect(n.warnings).toEqual([]);
  });

  it('recognises imagin when the file says so', async () => {
    const withMarker: Row[] = [['imaginBank - Movimientos'], [], ...rows.slice(2)];
    const { parsed } = await parse(workbook(withMarker, 'biff8'), 'imagin.xls');
    expect(parsed.bank).toBe('imagin');
  });
});

describe('Sabadell (.xls with Excel serial dates)', () => {
  it('parses F. Operativa / F. Valor serials and references', async () => {
    const rows: Row[] = [
      ['Banco Sabadell'],
      ['Cuenta: ES00 0081 0000 0000 0000 5678'],
      [],
      ['F. Operativa', 'Concepto', 'F. Valor', 'Importe', 'Saldo', 'Referencia 1', 'Referencia 2'],
      [serial('2026-08-30'), 'COMPRA TARJ. 1234 LIDL SUPERMERCADOS', serial('2026-08-30'), -23.4, 476.6, '000123', ''],
      [serial('2026-08-28'), 'CUOTA GIMNASIO FICTICIO', serial('2026-08-28'), -30, 500, '', ''],
    ];
    const { parsed, n } = await parse(workbook(rows, 'biff8'), 'Sabadell.xls');
    expect(parsed.bank).toBe('Sabadell');
    expect(n.candidates.map((c) => c.date)).toEqual(['2026-08-30', '2026-08-28']);
    expect(n.candidates[0]!.bookingDate).toBe('2026-08-30');
    expect(n.candidates[0]!.merchant?.display).toBe('Lidl');
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true);
  });
});

describe('Santander (".xls" that is really an HTML table, 7 preamble rows)', () => {
  it('parses Spanish text amounts from HTML and identifies the bank', async () => {
    const html = `<html><head><meta charset="utf-8"><title>Banco Santander</title></head><body><table>
      <tr><td>Cuenta Santander</td></tr><tr><td>IBAN</td><td>ES00 0049 0000 0000 0000 4321</td></tr>
      <tr><td>Titular</td><td>PERSONA FICTICIA</td></tr><tr><td>Saldo</td><td>1.234,56 EUR</td></tr><tr><td></td></tr><tr><td></td></tr><tr><td></td></tr>
      <tr><th>Fecha Operación</th><th>Fecha Valor</th><th>Concepto</th><th>Importe</th><th>Divisa</th><th>Saldo</th></tr>
      <tr><td>02/09/2026</td><td>02/09/2026</td><td>Pago Movil En Netflix.com</td><td>-12,99</td><td>EUR</td><td>1.234,56</td></tr>
      <tr><td>01/09/2026</td><td>01/09/2026</td><td>Transferencia Recibida De Empresa Ficticia S.L.</td><td>1.200,00</td><td>EUR</td><td>1.247,55</td></tr>
      </table></body></html>`;
    const { parsed, n } = await parse(new TextEncoder().encode(html), 'export.xls');
    expect(parsed.bank).toBe('Santander');
    expect(parsed.accountHint).toBe('4321');
    expect(n.candidates.map((c) => c.amountCents)).toEqual([-1299, 120000]);
    expect(n.candidates[0]!.merchant?.display).toBe('Netflix');
    expect(n.candidates[1]!.type).toBe('income');
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true);
  });
});

describe('ING (.xlsx, only "F. Valor")', () => {
  it('uses the value date as the movement date and ignores category columns', async () => {
    const rows: Row[] = [
      ['Número de cuenta: ES00 1465 0000 0000 0000 9999'],
      [],
      ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMAGEN', 'IMPORTE (€)', 'SALDO (€)'],
      ['04/09/2026', 'Alimentación', 'Supermercado', 'Pago en MERCADONA 1234', '', 'No', -60.1, 939.9],
      ['01/09/2026', 'Nómina', '', 'Nomina Empresa Ficticia', '', 'No', 1000, 1000],
    ];
    const { parsed, n } = await parse(workbook(rows, 'xlsx'), 'ING.xlsx');
    expect(parsed.bank).toBe('ING');
    expect(n.candidates.map((c) => [c.date, c.amountCents, c.type])).toEqual([
      ['2026-09-04', -6010, 'expense'],
      ['2026-09-01', 100000, 'income'],
    ]);
  });
});

describe('BBVA (Excel export: Concepto = merchant, Movimiento = kind)', () => {
  it('uses Concepto as description and Movimiento as detail', async () => {
    const rows: Row[] = [
      ['Últimos movimientos'],
      [],
      ['F.Valor', 'Fecha', 'Concepto', 'Movimiento', 'Importe', 'Divisa', 'Disponible', 'Divisa', 'Observaciones'],
      ['05/09/2026', '05/09/2026', 'Mercadona la plaza', 'Pago con tarjeta', -40, 'EUR', 460, 'EUR', ''],
    ];
    const { parsed, n } = await parse(workbook(rows, 'xlsx'), 'bbva.xlsx');
    expect(parsed.bank).toBe('BBVA');
    expect(n.candidates[0]!.descriptionRaw).toBe('Mercadona la plaza · Pago con tarjeta');
    expect(n.candidates[0]!.merchant?.display).toBe('Mercadona');
  });
});

describe('Norma 43 (AEB cuaderno 43)', () => {
  const pad = (s: string, n: number, c = ' ') => s.padEnd(n, c).slice(0, n);
  const num = (v: number, n: number) => String(v).padStart(n, '0');
  const r11 = (opening: number) => `11${'0081'}${'0001'}${'0000005678'}260801260831${opening < 0 ? 1 : 2}${num(Math.abs(opening), 14)}978${'3'}${pad('PERSONA FICTICIA', 26)}   `;
  const r22 = (op: string, dh: 1 | 2, cents: number, common = '12') => `22    0001${op}${op}${common}000${dh}${num(cents, 14)}${num(0, 10)}${num(0, 12)}${pad('', 16)}`;
  const r23 = (seq: number, a: string, b = '') => `23${num(seq, 2)}${pad(a, 38)}${pad(b, 38)}`;
  const r33 = (nD: number, d: number, nH: number, h: number, closing: number) => `33${'0081'}${'0001'}${'0000005678'}${num(nD, 5)}${num(d, 14)}${num(nH, 5)}${num(h, 14)}${closing < 0 ? 1 : 2}${num(Math.abs(closing), 14)}978    `;
  const file = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n'));

  it('reads movements, concept codes and verifies opening + movements = closing', async () => {
    const bytes = file([
      r11(50000),
      r22('260803', 1, 4520), r23(1, 'COMPRA TARJETA MERCADONA 1234'),
      r22('260805', 1, 6000, '11'), r23(1, 'CAJERO BANCO FICTICIO'),
      r22('260810', 2, 100000, '15'), r23(1, 'NOMINA EMPRESA FICTICIA SL'),
      r22('260812', 1, 250, '17'),
      r33(3, 10770, 1, 100000, 139230),
      `88${'9'.repeat(18)}${num(9, 6)}${pad('', 54)}`,
    ]);
    const { parser, parsed, n } = await parse(bytes, 'extracto.n43');
    expect(parser.id).toBe('norma43-v1');
    expect(parsed.bank).toBe('Sabadell');
    expect(parsed.periodStart).toBe('2026-08-01');
    expect(n.blockingIssues).toEqual([]);
    expect(n.candidates.map((c) => [c.date, c.amountCents, c.type])).toEqual([
      ['2026-08-03', -4520, 'expense'],
      ['2026-08-05', -6000, 'cash_withdrawal'],
      ['2026-08-10', 100000, 'income'],
      ['2026-08-12', -250, 'fee'],
    ]);
    expect(n.candidates[0]!.merchant?.display).toBe('Mercadona');
    expect(n.candidates[3]!.descriptionRaw).toBe('Intereses / comisiones / gastos');
  });

  it('sends the file to review when the balances do not add up', async () => {
    const bytes = file([r11(50000), r22('260803', 1, 4520), r23(1, 'MERCADONA'), r33(1, 4520, 0, 0, 99999), `88${'9'.repeat(18)}000004`]);
    const { n } = await parse(bytes, 'mal.n43');
    expect(n.blockingIssues.length).toBeGreaterThan(0);
  });
});

describe('import pipeline with other banks', () => {
  it('imports an Excel export end to end and deduplicates on re-import', async () => {
    const core = makeCore();
    const rows: Row[] = [
      ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'],
      ['05/09/2026', '05/09/2026', 'MERCADONA', '', -45.2, 954.8],
      ['03/09/2026', '03/09/2026', 'NOMINA', 'EMPRESA FICTICIA SL', 1000, 1000],
    ];
    const bytes = workbook(rows, 'biff8');
    const first = await core.importer.importDocument({ bytes, fileName: 'caixa.xls', source: 'manual' });
    expect(first).toMatchObject({ status: 'imported', inserted: 2 });
    expect(core.repos.documents.list()[0]!.parserId).toBe('tabla-bancaria-v1');
    const again = await core.importer.importDocument({ bytes, fileName: 'caixa.xls', source: 'manual' });
    expect(again.status).toBe('duplicate');
  });

  it('rejects spreadsheets without a movements table', async () => {
    const core = makeCore();
    const out = await core.importer.importDocument({ bytes: workbook([['Nombre', 'Edad'], ['Ana', 30]], 'xlsx'), fileName: 'otra.xlsx', source: 'manual' });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'UNKNOWN_FORMAT' });
  });

  it('converts Excel serial dates exactly (1900 and 1904 systems)', () => {
    expect(excelSerialToIso(serial('2026-09-29'))).toBe('2026-09-29');
    expect(excelSerialToIso(45000)).toBe('2023-03-15');
    expect(excelSerialToIso(45000 - 1462, { date1904: true })).toBe('2023-03-15');
  });
});
