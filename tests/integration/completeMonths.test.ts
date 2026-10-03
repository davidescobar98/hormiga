import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';
import { buildCsv } from '../helpers/csv';

/*
 * A mortgage charged on the last day of each month, and data that only reaches the 29th of last month: that month
 * is not complete yet, so averages must not count it as a month without mortgage.
 */
describe('a month is complete only when its last days are imported', () => {
  const head = ['Fecha', 'Concepto', 'Importe'];
  const months = [['06', '30'], ['07', '31'], ['08', '31']];
  const base = months.flatMap(([m, last]) => [
    [`${last}/${m}/2026`, 'Cargo por amortizacion de prestamo hipoteca', '-650,00'],
    [`05/${m}/2026`, 'Abono de nomina Empresa Ficticia S.L.', '2.500,00'],
    [`10/${m}/2026`, 'Compra Supermercado Ficticio', '-200,00'],
  ]);

  it('the September budget average ignores an unfinished September', async () => {
    const core = makeCore({ now: '2026-10-03T10:00:00Z' });
    const rows = [...base, ['05/09/2026', 'Abono de nomina Empresa Ficticia S.L.', '2.500,00'], ['10/09/2026', 'Compra Supermercado Ficticio', '-200,00'], ['29/09/2026', 'Compra Supermercado Ficticio', '-10,00']];
    await core.importer.importDocument({ bytes: buildCsv([head, ...rows]), fileName: 'movs.csv', source: 'manual' });
    expect(core.analytics.coverageDate()).toBe('2026-09-29');
    expect(core.analytics.isMonthComplete('2026-09')).toBe(false);
    expect(core.analytics.isMonthComplete('2026-08')).toBe(true);
    const loans = core.repos.categories.list().find((c) => c.name === 'Préstamos')!;
    const sug = core.budgets.overview('2026-10').suggestions.find((s) => s.categoryId === loans.id);
    // Average of June–August (650,00 each), not (650,00 + 650,00 + 0) / 3.
    expect(sug?.averageCents).toBe(65000);
    // The savings screen shows the last complete month by default.
    expect(core.analytics.savings().month).toBe('2026-08');
  });

  it('once October movements arrive, September counts as complete', async () => {
    const core = makeCore({ now: '2026-10-10T10:00:00Z' });
    const rows = [...base, ['30/09/2026', 'Cargo por amortizacion de prestamo hipoteca', '-650,00'], ['02/10/2026', 'Compra Supermercado Ficticio', '-5,00']];
    await core.importer.importDocument({ bytes: buildCsv([head, ...rows]), fileName: 'movs.csv', source: 'manual' });
    expect(core.analytics.isMonthComplete('2026-09')).toBe(true);
    expect(core.analytics.isMonthComplete('2026-10')).toBe(false);
  });
});
