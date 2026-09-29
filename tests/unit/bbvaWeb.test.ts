import { describe, expect, it } from 'vitest';
import { buildWebMovementsPdf, type WebRow } from '../helpers/synthetic-statement.mjs';
import { extractPdfText } from '../../src/core/parsing/pdfText';
import { selectParser } from '../../src/core/parsing/registry';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import { makeCore } from '../helpers/core';

// Fictitious movements, newest first, with a consistent running balance (starting balance 500,00).
const J: WebRow = { date: '22/09/2026', concept: 'Transferencia realizada', amount: '-100,00', balance: '969,51', detail: 'MANCOMUNIDAD DE PROPIETARIOS DE LA PARCELA 1 DEL', detail2: 'SECTOR' };
const I: WebRow = { date: '20/09/2026', concept: 'Ret. efectivo a debito con tarj. en cajero. aut.', amount: '-1.050,00', balance: '1.069,51', detail: 'Otros' };
const H: WebRow = { date: '18/09/2026', concept: 'Bizum', amount: '-5,00', balance: '2.119,51', detail: 'Enviado: cena' };
const G: WebRow = { date: '15/09/2026', concept: 'Abono de nómina', amount: '1.800,00', balance: '2.124,51', detail: 'Empresa Ficticia S.L.U.', inlineValueDate: true, valueDate: '16/09/2026' };
const F: WebRow = { date: '12/09/2026', concept: 'Adeudo a su cargo', amount: '-45,50', balance: '324,51', detail: 'N 2026000011112222 C.P. VECINOS (MANCOMUNIDAD)', split: 'amounts' };
const E: WebRow = { date: '10/09/2026', concept: 'Cargo por amortizacion de prestamo/credito', amount: '-300,00', balance: '370,01', split: 'conceptAndAmounts' };
const D: WebRow = { date: '08/09/2026', concept: 'Transferencia recibida', amount: '250,00', balance: '670,01', detail: 'De Empresa Ficticia S.L.U.' };
const C: WebRow = { date: '05/09/2026', concept: 'Transferencia realizada', amount: '-9,99', balance: '420,01', detail: 'SPOTIFY DUO' };
const B: WebRow = { date: '03/09/2026', concept: 'Adeudo a su cargo', amount: '-30,00', balance: '430,00', detail: 'N 2026333344445555 JAZZTEL CPVR' };
const A: WebRow = { date: '01/09/2026', concept: 'Mercadona la plaza', amount: '-40,00', balance: '460,00', detail: 'Pago con tarjeta' };

const spec = { pages: [[J, I, H, G, F], [E], [D, C, B, A]] };

describe('BBVA "Últimos movimientos" (online banking PDF)', () => {
  it('is selected, handles split rows across pages, value dates and wrapped details', async () => {
    const doc = await extractPdfText(await buildWebMovementsPdf(spec), 'movimientos.pdf');
    const parser = selectParser(doc);
    expect(parser.id).toBe('bbva-web-movimientos-v1');
    const parsed = parser.parse(doc);
    expect(parsed.issues).toEqual([]);
    const n = normalizeStatement(parsed);
    expect(n.candidates).toHaveLength(10);
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true); // every row reconciles with the running balance
    expect(n.blockingIssues).toEqual([]);
    expect(n.warnings).toEqual([]);
    expect(n.periodStart).toBe('2026-09-01');
    expect(n.periodEnd).toBe('2026-09-22');
    const byDate = Object.fromEntries(n.candidates.map((c) => [c.date, c]));
    expect(byDate['2026-09-22']!.descriptionRaw).toBe('Transferencia realizada · MANCOMUNIDAD DE PROPIETARIOS DE LA PARCELA 1 DEL SECTOR');
    expect(byDate['2026-09-15']!.bookingDate).toBe('2026-09-16');
    expect(byDate['2026-09-12']!.amountCents).toBe(-4550);
    expect(byDate['2026-09-10']!.amountCents).toBe(-30000);
    expect(byDate['2026-09-20']!.amountCents).toBe(-105000);
  });

  it('extracts merchants from the detail line and infers the right semantics', async () => {
    const core = makeCore();
    const out = await core.importer.importDocument({ bytes: await buildWebMovementsPdf(spec), fileName: 'movimientos.pdf', source: 'manual' });
    expect(out).toMatchObject({ status: 'imported', inserted: 10 });
    const tx = (date: string) => core.repos.transactions.list({ from: date, to: date }).items[0]!;
    expect(tx('2026-09-01')).toMatchObject({ merchantName: 'Mercadona', categoryName: 'Supermercado', type: 'expense' });
    expect(tx('2026-09-03')).toMatchObject({ merchantName: 'Jazztel', categoryName: 'Servicios', type: 'expense' });
    expect(tx('2026-09-05')).toMatchObject({ merchantName: 'Spotify', type: 'transfer' });
    expect(tx('2026-09-08')).toMatchObject({ type: 'income', categoryName: 'Ingresos' });
    expect(tx('2026-09-10')).toMatchObject({ categoryName: 'Préstamos', type: 'expense' });
    expect(tx('2026-09-12')).toMatchObject({ categoryName: 'Vivienda', type: 'expense' });
    expect(tx('2026-09-15')).toMatchObject({ type: 'income' });
    expect(tx('2026-09-18')).toMatchObject({ merchantName: 'Bizum', type: 'transfer' });
    expect(tx('2026-09-20')).toMatchObject({ type: 'cash_withdrawal', categoryName: 'Efectivo' });

    // Income is taken from the documents automatically (default "auto" mode), without configuring anything.
    const s = core.analytics.dashboard('2026-09').summary;
    expect(s.incomeCents).toBe(205000);
    expect(s.spendingCents).toBe(4000 + 3000 + 30000 + 4550 + 105000);
  });

  it('moving a Bizum to a spending category makes it count as spending (and back)', async () => {
    const core = makeCore();
    await core.importer.importDocument({ bytes: await buildWebMovementsPdf(spec), fileName: 'movimientos.pdf', source: 'manual' });
    const bizum = core.repos.transactions.list({ from: '2026-09-18', to: '2026-09-18' }).items[0]!;
    const restaurants = core.repos.categories.list().find((c) => c.name === 'Restaurantes')!;
    const before = core.analytics.dashboard('2026-09').summary.spendingCents;
    expect(core.categorization.updateTransaction({ id: bizum.id, categoryId: restaurants.id }).transaction.type).toBe('expense');
    expect(core.analytics.dashboard('2026-09').summary.spendingCents).toBe(before + 500);
    const transfers = core.repos.categories.list().find((c) => c.name === 'Transferencias')!;
    expect(core.categorization.updateTransaction({ id: bizum.id, categoryId: transfers.id }).transaction.type).toBe('transfer');
    expect(core.analytics.dashboard('2026-09').summary.spendingCents).toBe(before);
  });
});
