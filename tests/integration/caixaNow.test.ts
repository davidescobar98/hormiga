import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';
import { buildLinesPdf } from '../helpers/synthetic-statement.mjs';

/**
 * FICTITIOUS replica of the CaixaBankNow movements PDF (web page printed to PDF): newest first, explicit signs,
 * running balance, thousands separator only from 10.000. No real data.
 */
const HEADER = ['1/2', 'Cuenta Corriente Persona Ficticia  ES00 2100 0000 0000 0000 9999', 'Periodo 01/07/2026 - 30/09/2026  Saldo disponible', 'Concepto  Fecha  Importe Saldo'];
const PAGE1 = [
  'COMPRA SUPERMERCADO FICTICIO  28/09/2026  -45,20€  13.004,80€',
  'NOMINA EMPRESA FICTICIA S.L.  26/09/2026  +1500,00€  13.050,00€',
  'TRANSF. A UNA CUENTA  20/09/2026  -2500,00€  11.550,00€',
  'VENTA PISO FICTICIO  15/09/2026  +12.345,67€  14.050,00€',
];
const PAGE2 = [
  '2/2',
  'CRÈDIT AP. RESTAURANT L\'EXEMPLE  10/08/2026  -1704,33€  1704,33€',
  'BIZUM RECIBIDO  05/07/2026  +8,66€  3408,66€',
];

async function importCaixa(core: ReturnType<typeof makeCore>, pages = [[...HEADER, ...PAGE1], PAGE2], name = 'CaixaBank_digital_CaixaBankNow_20261003.pdf') {
  return core.importer.importDocument({ bytes: await buildLinesPdf(pages), fileName: name, source: 'manual' });
}

describe('CaixaBankNow movements PDF', () => {
  it('imports every row with its sign, verifies the running balance and keeps the period of the header', async () => {
    const core = makeCore();
    const out = await importCaixa(core);
    expect(out.status).toBe('imported');
    expect(out.inserted).toBe(6);
    const page = core.repos.transactions.list({ limit: 50, sort: 'date', dir: 'asc' });
    expect(page.items.map((t) => [t.date, t.amountCents])).toEqual([
      ['2026-07-05', 866],
      ['2026-08-10', -170433],
      ['2026-09-15', 1234567],
      ['2026-09-20', -250000],
      ['2026-09-26', 150000],
      ['2026-09-28', -4520],
    ]);
    const doc = core.repos.documents.list()[0]!;
    expect(doc.bank).toBe('CaixaBank');
    expect(doc.periodStart).toBe('2026-07-01');
    expect(doc.periodEnd).toBe('2026-09-30');
  });

  it('a misread or missing row breaks the balance chain: nothing is imported silently', async () => {
    const core = makeCore();
    // The 2.500 € transfer is missing: 14.050,00 − 45,20… no longer chains.
    const out = await importCaixa(core, [[...HEADER, PAGE1[0]!, PAGE1[1]!, PAGE1[3]!], PAGE2], 'incompleto.pdf');
    expect(out.status).toBe('needs_review');
    expect(core.repos.transactions.count()).toBe(0);
  });

  it('re-importing a later download that overlaps does not duplicate movements', async () => {
    const core = makeCore();
    await importCaixa(core);
    const later = [
      '1/1', HEADER[1]!, 'Periodo 01/09/2026 - 03/10/2026  Saldo disponible', HEADER[3]!,
      'RECIBO LUZ FICTICIA  02/10/2026  -60,00€  12.944,80€',
      ...PAGE1,
    ];
    const out = await importCaixa(core, [later], 'CaixaBank_digital_CaixaBankNow_20261004.pdf');
    expect(out.status).toBe('imported');
    expect(out.inserted).toBe(1);
    expect(core.repos.transactions.count()).toBe(7);
  });
});

describe('deleting an account (e.g. to replace the payroll account)', () => {
  it('removes an imported account with its documents and movements, and nothing else', async () => {
    const core = makeCore();
    await importCaixa(core);
    const other = await core.importer.importDocument({
      bytes: await buildLinesPdf([[...HEADER.map((l) => l.replace('9999', '8888')), 'RECIBO GIMNASIO FICTICIO  03/09/2026  -30,00€  970,00€', 'NOMINA OTRA FICTICIA  01/09/2026  +1000,00€  1000,00€']]),
      fileName: 'otra-cuenta.pdf',
      source: 'manual',
    });
    expect(other.status).toBe('imported');
    const accounts = core.accounts.list();
    expect(accounts).toHaveLength(2);
    const target = accounts.find((a) => a.movementsCount === 6)!;
    const res = await core.importer.deleteAccount(target.id);
    expect(res).toEqual({ removedTransactions: 6, removedDocuments: 1 });
    expect(core.accounts.list().map((a) => a.movementsCount)).toEqual([2]);
    expect(core.repos.transactions.count()).toBe(2);
    expect(core.repos.documents.list()).toHaveLength(1);
    // The same file can be imported again afterwards.
    expect((await importCaixa(core)).status).toBe('imported');
  });

  it('demo accounts point to «Eliminar datos de demostración»; manual accounts are simply removed', async () => {
    const core = makeCore();
    core.data.loadDemo();
    const demo = core.accounts.list().find((a) => a.name.endsWith(' (demo)'))!;
    await expect(core.importer.deleteAccount(demo.id)).rejects.toThrow(/demostración/);
    core.accounts.createManual({ name: 'Hucha', bank: 'Ficticio', kind: 'savings', balanceCents: 1000, date: '2026-09-01', annualRateBp: 0, ownTransferTarget: false });
    const manual = core.accounts.list().find((a) => a.name === 'Hucha')!;
    await core.importer.deleteAccount(manual.id);
    expect(core.accounts.list().some((a) => a.name === 'Hucha')).toBe(false);
  });
});
