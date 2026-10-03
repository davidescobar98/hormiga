import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';
import { buildWebMovementsPdf, type WebRow } from '../helpers/synthetic-statement.mjs';
import { buildCsv } from '../helpers/csv';

/*
 * Real-life case: you download "the last 12 months" today and again in a month. The 11 overlapping months must not
 * be imported twice, while genuinely repeated movements (two identical coffees the same day) must be kept.
 */

// Like the bank prints it: thousands with a dot even for 4 digits (1.234,56).
const fmt = (c: number) => {
  const neg = c < 0;
  const [i, d] = (Math.abs(c) / 100).toFixed(2).split('.');
  return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
};

interface Mv { date: string; concept: string; cents: number }

const pages = (r: WebRow[]) => Array.from({ length: Math.ceil(r.length / 15) }, (_, i) => r.slice(i * 15, i * 15 + 15));

/** Fictitious movements of one account between two months (inclusive), with a running balance, newest first. */
function rows(movs: Mv[], opening: number): WebRow[] {
  let bal = opening;
  const withBal = [...movs].sort((a, b) => a.date.localeCompare(b.date)).map((m) => {
    bal += m.cents;
    return { ...m, bal };
  });
  return withBal.reverse().map((m) => ({ date: m.date.split('-').reverse().join('/'), concept: m.concept, amount: fmt(m.cents), balance: fmt(m.bal) }));
}

function year(fromMonth: number, months: number): Mv[] {
  const out: Mv[] = [];
  for (let k = 0; k < months; k++) {
    const d = new Date(Date.UTC(2025, fromMonth - 1 + k, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ date: `${ym}-01`, concept: 'Abono de nómina Empresa Ficticia S.L.', cents: 200000 });
    out.push({ date: `${ym}-05`, concept: 'Recibo Alquiler Ficticio', cents: -70000 });
    // Two identical coffees the same day: both are real.
    out.push({ date: `${ym}-10`, concept: 'Pago con tarjeta Cafeteria Ficticia', cents: -150 });
    out.push({ date: `${ym}-10`, concept: 'Pago con tarjeta Cafeteria Ficticia', cents: -150 });
    out.push({ date: `${ym}-20`, concept: 'Pago con tarjeta Supermercado Ficticio', cents: -8000 - (d.getUTCMonth() + 1) * 100 });
  }
  return out;
}

describe('overlapping downloads of the same account', () => {
  it('a second "last 12 months" one month later only adds the new month', async () => {
    const core = makeCore({ now: '2026-10-15T10:00:00Z' });
    const first = year(10, 12); // Oct 2025 – Sep 2026
    const a = await core.importer.importDocument({ bytes: await buildWebMovementsPdf({ pages: pages(rows(first, 100000)) }), fileName: 'movimientos-1.pdf', source: 'manual' });
    expect(a).toMatchObject({ status: 'imported', inserted: 60 });

    // One month later: Nov 2025 – Oct 2026 (11 months overlap + October 2026 new), same running balances.
    const second = year(11, 12);
    const opening = 100000 + first.filter((m) => m.date < '2025-11-01').reduce((t, m) => t + m.cents, 0);
    const b = await core.importer.importDocument({ bytes: await buildWebMovementsPdf({ pages: pages(rows(second, opening)) }), fileName: 'movimientos-2.pdf', source: 'manual' });
    expect(b).toMatchObject({ status: 'imported', inserted: 5, duplicatesSkipped: 55 });

    const all = core.repos.transactions.list({ limit: 500 });
    expect(all.total).toBe(65);
    // Both coffees of every month are still there (2 × 13 months).
    expect(all.items.filter((t) => t.descriptionRaw.includes('Cafeteria')).length).toBe(26);
    // Totals are right: 13 payrolls, 13 rents.
    expect(core.analytics.report({ from: '2025-10', to: '2026-10' }).totals.incomeCents).toBe(13 * 200000);
  });

  it('a third coffee on a day that already had two is added (multiset, not set)', async () => {
    const core = makeCore({ now: '2026-10-15T10:00:00Z' });
    const base: Mv[] = [
      { date: '2026-09-10', concept: 'Pago con tarjeta Cafeteria Ficticia', cents: -150 },
      { date: '2026-09-10', concept: 'Pago con tarjeta Cafeteria Ficticia', cents: -150 },
    ];
    await core.importer.importDocument({ bytes: await buildWebMovementsPdf({ pages: pages(rows(base, 10000)) }), fileName: 'a.pdf', source: 'manual' });
    const more = [...base, { date: '2026-09-10', concept: 'Pago con tarjeta Cafeteria Ficticia', cents: -150 }];
    const r = await core.importer.importDocument({ bytes: await buildWebMovementsPdf({ pages: pages(rows(more, 10000)) }), fileName: 'b.pdf', source: 'manual' });
    expect(r).toMatchObject({ inserted: 1, duplicatesSkipped: 2 });
  });

  it('overlapping CSV exports without account number are deduplicated by movement fingerprint', async () => {
    const core = makeCore({ now: '2026-10-15T10:00:00Z' });
    const head = ['Fecha', 'Concepto', 'Importe'];
    const mk = (list: Mv[]) => buildCsv([head, ...list.map((m) => [m.date.split('-').reverse().join('/'), m.concept, fmt(m.cents)])]);
    const r1 = await core.importer.importDocument({ bytes: mk(year(10, 3)), fileName: 'export-1.csv', source: 'manual' });
    const r2 = await core.importer.importDocument({ bytes: mk(year(11, 3)), fileName: 'export-2.csv', source: 'manual' });
    expect(r1.inserted).toBe(15);
    expect(r2).toMatchObject({ inserted: 5, duplicatesSkipped: 10 });
  });
});
