import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { makeCore } from '../helpers/core';

/*
 * One fictitious file per bank, built with the layout of its real export (researched from the banks' help pages and
 * open-source importers that read them: column names, preamble rows, dates as text or Excel serials, signs, file type).
 * No real data. Each must import with the right bank, dates, amounts and signs.
 */

type Row = (string | number | null)[];

const xls = (rows: Row[], sheet = 'Movimientos', bookType: XLSX.BookType = 'biff8') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
};
const text = (s: string) => new TextEncoder().encode(s);
/** Excel serial for a date (1900 system). */
const serial = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;

interface Case {
  name: string;
  file: string;
  bytes: () => Uint8Array;
  bank: string | RegExp;
  expected: { date: string; cents: number; text: RegExp }[];
}

const CASES: Case[] = [
  {
    name: 'CaixaBank (.xls BIFF, header on row 3, signed amounts, «Más datos»)',
    file: 'movimientos_cuenta.xls',
    bank: /CaixaBank/,
    bytes: () => xls([
      ['Movimientos de la cuenta ES12 2100 0000 0000 0000 1234 · CaixaBank'],
      [],
      ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'],
      ['12/09/2026', '12/09/2026', 'BONPREU MOLLET', 'Fecha de operación: 11-09-2026', -32.15, 1467.85],
      ['10/09/2026', '10/09/2026', 'NOMINA', 'EMPRESA FICTICIA SL', 1500, 1500],
    ]),
    expected: [
      { date: '2026-09-12', cents: -3215, text: /BONPREU/ },
      { date: '2026-09-10', cents: 150000, text: /NOMINA/ },
    ],
  },
  {
    name: 'imagin (CaixaBank layout, text amounts in Spanish format)',
    file: 'imagin-movimientos.xls',
    bank: 'imagin',
    bytes: () => xls([
      ['imagin · Cuenta imagin'],
      [],
      ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'],
      ['03/09/2026', '03/09/2026', 'BIZUM ENVIADO', 'CENA', '-1.234,56', '765,44'],
    ]),
    expected: [{ date: '2026-09-03', cents: -123456, text: /BIZUM/ }],
  },
  {
    name: 'Sabadell (.xls, preamble, dates as Excel serials)',
    file: 'Movimientos_cuenta_Sabadell.xls',
    bank: 'Sabadell',
    bytes: () => xls([
      ['Banco Sabadell'],
      ['Consulta de movimientos'],
      ['Cuenta', 'ES00 0081 0000 0000 0000 0000'],
      ['Titular', 'PERSONA FICTICIA'],
      ['Periodo', '01/09/2026 - 30/09/2026'],
      [],
      ['F. Operativa', 'Concepto', 'F. Valor', 'Importe', 'Saldo', 'Referencia 1', 'Referencia 2'],
      [serial('2026-09-15'), 'COMPRA TARJ. 5402XXXXXXXX1234 MERCADONA', serial('2026-09-15'), -45.6, 954.4, '000001', ''],
      [serial('2026-09-01'), 'TRANSFERENCIA DE EMPRESA FICTICIA', serial('2026-09-01'), 1000, 1000, '', ''],
    ]),
    expected: [
      { date: '2026-09-15', cents: -4560, text: /MERCADONA/ },
      { date: '2026-09-01', cents: 100000, text: /TRANSFERENCIA/ },
    ],
  },
  {
    name: 'Santander (".xls" that is an HTML table, 7 preamble rows)',
    file: 'export_santander.xls',
    bank: 'Santander',
    bytes: () => text(`<html><head><meta charset="utf-8"></head><body><table>
<tr><td>Banco Santander</td></tr><tr><td>Cuenta Santander</td><td>ES00 0049 0000 0000 0000 0000</td></tr>
<tr><td>Titular</td><td>PERSONA FICTICIA</td></tr><tr><td></td></tr><tr><td>Movimientos</td></tr><tr><td></td></tr><tr><td></td></tr>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>20/09/2026</td><td>20/09/2026</td><td>Recibo Endesa Energia</td><td>-58,90 EUR</td><td>2.441,10 EUR</td></tr>
<tr><td>18/09/2026</td><td>18/09/2026</td><td>Transferencia recibida de Persona Ficticia</td><td>500,00 EUR</td><td>2.500,00 EUR</td></tr>
</table></body></html>`),
    expected: [
      { date: '2026-09-20', cents: -5890, text: /Endesa/i },
      { date: '2026-09-18', cents: 50000, text: /Transferencia/i },
    ],
  },
  {
    name: 'Openbank (.xlsx, Fecha · Concepto · Importe · Saldo)',
    file: 'openbank-movimientos.xlsx',
    bank: 'Openbank',
    bytes: () => xls([
      ['Openbank · Cuenta corriente'],
      [],
      ['Fecha', 'Concepto', 'Importe', 'Saldo'],
      ['22/09/2026', 'COMPRA EN AMAZON', -19.99, 980.01],
    ], 'Openbank', 'xlsx'),
    expected: [{ date: '2026-09-22', cents: -1999, text: /AMAZON/ }],
  },
  {
    name: 'ING (.xls with logo and preamble, F. VALOR · CATEGORÍA · … · IMPORTE (€) · SALDO (€))',
    file: 'movimientos-ing.xls',
    bank: 'ING',
    bytes: () => xls([
      [null],
      ['ING'],
      ['Número de cuenta:', 'ES00 1465 0000 0000 0000 0000'],
      ['Titular:', 'PERSONA FICTICIA'],
      ['Fecha exportación:', '30/09/2026'],
      [],
      ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMAGEN', 'IMPORTE (€)', 'SALDO (€)'],
      ['30/09/2026', 'Alimentación', 'Supermercados', 'Pago en LIDL', '', '', -1.55, 1200.45],
      ['28/09/2026', 'Nómina', 'Nómina', 'Nómina recibida EMPRESA FICTICIA', '', '', 1202, 1202],
    ]),
    expected: [
      { date: '2026-09-30', cents: -155, text: /LIDL/ },
      { date: '2026-09-28', cents: 120200, text: /N[oó]mina/ },
    ],
  },
  {
    name: 'BBVA (Excel export)',
    file: 'movimientos-bbva.xlsx',
    bank: 'BBVA',
    bytes: () => xls([
      ['Últimos movimientos BBVA'],
      ['Cuenta', 'ES00 0182 0000 0000 0000 0000'],
      [],
      ['F.Valor', 'Fecha', 'Concepto', 'Movimiento', 'Importe', 'Divisa', 'Disponible', 'Divisa', 'Observaciones'],
      ['25/09/2026', '25/09/2026', 'Mercadona', 'Pago con tarjeta', -23.4, 'EUR', 876.6, 'EUR', ''],
    ], 'Hoja1', 'xlsx'),
    expected: [{ date: '2026-09-25', cents: -2340, text: /Mercadona/ }],
  },
  {
    name: 'Bankinter (.xlsx)',
    file: 'bankinter.xlsx',
    bank: 'Bankinter',
    bytes: () => xls([
      ['Bankinter · Movimientos de cuenta'],
      [],
      ['Fecha contable', 'Fecha valor', 'Descripción', 'Importe', 'Saldo'],
      ['05/09/2026', '05/09/2026', 'RECIBO GIMNASIO FICTICIO', '-39,90', '960,10'],
    ], 'Movimientos', 'xlsx'),
    expected: [{ date: '2026-09-05', cents: -3990, text: /GIMNASIO/ }],
  },
  {
    name: 'N26 (CSV, ISO dates, dot decimals)',
    file: 'n26-csv-transactions.csv',
    bank: 'N26',
    bytes: () => text([
      '"Fecha","Beneficiario","Número de cuenta","Tipo de transacción","Referencia de pago","Categoría","Cantidad (EUR)","Cantidad (Divisa extranjera)","Tipo de divisa extranjera","Tipo de cambio"',
      '"2026-09-04","Cafeteria Ficticia","","Pago con tarjeta MasterCard","","Bares y restaurantes","-12.5","","",""',
      '"2026-09-01","Empresa Ficticia","ES0000000000000000000000","Transferencia entrante","Nómina septiembre","Ingresos","1500.0","","",""',
    ].join('\n')),
    expected: [
      { date: '2026-09-04', cents: -1250, text: /Cafeteria/ },
      { date: '2026-09-01', cents: 150000, text: /Empresa/ },
    ],
  },
  {
    name: 'Revolut (CSV: fee on top, reverted and pending rows skipped)',
    file: 'account-statement_2026-09-01_2026-09-30_es_000000.csv',
    bank: 'Revolut',
    bytes: () => text([
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'TRANSFER,Current,2026-09-01 09:00:00,2026-09-01 09:00:01,Transfer from PERSONA FICTICIA,500.00,0.00,EUR,COMPLETED,500.00',
      'CARD_PAYMENT,Current,2026-09-03 10:15:22,2026-09-04 08:01:00,Supermercado Ficticio,-25.40,0.00,EUR,COMPLETED,474.60',
      'EXCHANGE,Current,2026-09-10 12:00:00,2026-09-10 12:00:01,Exchanged to USD,-100.00,1.00,EUR,COMPLETED,373.60',
      'CARD_PAYMENT,Current,2026-09-12 20:00:00,,Tienda Ficticia,-60.00,0.00,EUR,REVERTED,',
      'CARD_PAYMENT,Current,2026-09-29 21:00:00,,Restaurante Ficticio,-30.00,0.00,EUR,PENDING,',
    ].join('\n')),
    expected: [
      { date: '2026-09-04', cents: -2540, text: /Supermercado/ },
      { date: '2026-09-01', cents: 50000, text: /PERSONA/ },
      { date: '2026-09-10', cents: -10100, text: /Exchanged/ },
    ],
  },
  {
    name: 'Generic CSV with separate Cargo / Abono columns',
    file: 'export.csv',
    bank: /.+/,
    bytes: () => text('Fecha;Concepto;Cargo;Abono\n03/09/2026;FARMACIA FICTICIA;12,30;\n04/09/2026;DEVOLUCION TIENDA FICTICIA;;20,00\n'),
    expected: [
      { date: '2026-09-03', cents: -1230, text: /FARMACIA/ },
      { date: '2026-09-04', cents: 2000, text: /DEVOLUCION/ },
    ],
  },
];

describe('statements from other banks', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const core = makeCore({ now: '2026-10-03T10:00:00Z' });
      const r = await core.importer.importDocument({ bytes: c.bytes(), fileName: c.file, source: 'manual' });
      expect(r.status, r.message).toBe('imported');
      const doc = core.repos.documents.list().find((d) => d.id === r.documentId)!;
      if (typeof c.bank === 'string') expect(doc.bank).toBe(c.bank);
      else expect(doc.bank ?? '').toMatch(c.bank);
      // Movements land with the right date, amount and sign (whether imported directly or pending review).
      const rows = r.status === 'imported'
        ? core.repos.transactions.list({ limit: 100 }).items.map((t) => ({ date: t.date, cents: t.amountCents, text: t.descriptionRaw }))
        : core.importer.review(r.documentId!).items.map((i) => ({ date: i.date!, cents: i.amountCents!, text: i.description ?? '' }));
      expect(rows).toHaveLength(c.expected.length);
      for (const e of c.expected) {
        const found = rows.find((x) => x.date === e.date && x.cents === e.cents);
        expect(found, `${e.date} ${e.cents}`).toBeTruthy();
        expect(found!.text).toMatch(e.text);
      }
    });
  }
});
