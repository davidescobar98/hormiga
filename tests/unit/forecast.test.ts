import { describe, expect, it } from 'vitest';
import { categoryLevers, detectPayday, occurrences, projectBalance, seasonalPeaks } from '../../src/core/domain/forecast';
import { accumulate, monthsToReach } from '../../src/shared/planning';
import { bestParagraph, detectIntent, detectPeriod, findTarget, searchHelp } from '../../src/core/domain/assistant';
import { isoWeekKey } from '../../src/shared/dates';
import { isImportant } from '../../src/core/services/notifyService';

describe('expected movements', () => {
  it('expands recurring payments by frequency', () => {
    expect(occurrences('2026-10-05', 'monthly', '2026-10-01', '2026-12-31')).toEqual(['2026-10-05', '2026-11-05', '2026-12-05']);
    expect(occurrences('2026-01-31', 'monthly', '2026-01-01', '2026-03-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-28']);
    expect(occurrences('2026-10-02', 'weekly', '2026-10-01', '2026-10-20')).toEqual(['2026-10-02', '2026-10-09', '2026-10-16']);
    expect(occurrences('2026-11-15', 'annual', '2026-10-01', '2027-12-31')).toEqual(['2026-11-15', '2027-11-15']);
    expect(occurrences('2026-10-10', 'quarterly', '2026-10-01', '2027-04-30')).toEqual(['2026-10-10', '2027-01-10', '2027-04-10']);
    // Overdue: expected once at the start of the window, then on its normal rhythm.
    expect(occurrences('2026-09-20', 'monthly', '2026-10-01', '2026-11-30')).toEqual(['2026-10-01', '2026-10-20', '2026-11-20']);
  });

  it('detects the usual payday from the largest income of each month', () => {
    expect(detectPayday([
      { date: '2026-07-28', cents: 200000 }, { date: '2026-07-05', cents: 1000 },
      { date: '2026-08-29', cents: 200000 }, { date: '2026-09-27', cents: 210000 },
    ])).toBe(28);
    expect(detectPayday([{ date: '2026-09-27', cents: 1 }])).toBeNull();
  });

  it('projects the balance day by day without rounding drift', () => {
    const p = projectBalance({
      today: '2026-10-01',
      days: 30,
      startCents: 100000,
      events: [
        { date: '2026-10-05', kind: 'recurring', label: 'Alquiler', amountCents: -60000 },
        { date: '2026-10-28', kind: 'income', label: 'Nómina', amountCents: 200000 },
      ],
      dailyVariableCents: 1000,
      dailyTransfersCents: 0,
    });
    expect(p.points).toHaveLength(30);
    expect(p.points[0]).toEqual({ date: '2026-10-02', balanceCents: 99000 });
    // 5 Oct: 100.000 − 600 € − 4 days × 10 €.
    expect(p.points.find((x) => x.date === '2026-10-05')!.balanceCents).toBe(100000 - 60000 - 4000);
    // Lowest point: the day before payday (27 Oct = 26 days).
    expect(p.min).toEqual({ date: '2026-10-27', balanceCents: 100000 - 60000 - 26000 });
    expect(p.end).toEqual({ date: '2026-10-31', balanceCents: 100000 - 60000 + 200000 - 30000 });
    // Fractional daily amounts accumulate exactly (no per-day rounding drift).
    const q = projectBalance({ today: '2026-10-01', days: 365, startCents: 0, events: [], dailyVariableCents: 1000 / 3, dailyTransfersCents: 0 });
    expect(q.end.balanceCents).toBe(-Math.round((1000 / 3) * 365));
  });
});

describe('seasonality and levers', () => {
  const months = (from: string, n: number) => {
    const out: string[] = [];
    let [y, m] = from.split('-').map(Number) as [number, number];
    for (let i = 0; i < n; i++) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  };

  it('finds months that were expensive last year', () => {
    const all = months('2024-09', 25); // 2024-09 … 2026-09
    const data = new Map(all.map((m) => [m, new Map([[1, m === '2025-12' ? 60000 : 10000], [2, 20000]])]));
    const peaks = seasonalPeaks(data, new Set(all), [{ id: 1, name: 'Regalos' }, { id: 2, name: 'Supermercado' }], '2026-10-03', 3);
    expect(peaks).toEqual([{ month: '2026-12', categoryId: 1, categoryName: 'Regalos', lastYearCents: 60000, usualCents: 10000, extraCents: 50000 }]);
    // Without last year's data, nothing is predicted.
    expect(seasonalPeaks(data, new Set(all.filter((m) => m !== '2025-12')), [{ id: 1, name: 'Regalos' }], '2026-10-03', 3)).toEqual([]);
  });

  it('proposes going back to your best quarter, never more than halving', () => {
    const all = months('2025-07', 15); // 2025-07 … 2026-09
    const restaurants = (m: string) => (m >= '2026-07' ? 30000 : m >= '2025-11' && m <= '2026-01' ? 18000 : 25000);
    const data = new Map(all.map((m) => [m, new Map([[1, restaurants(m)], [2, m >= '2026-07' ? 40000 : 8000]])]));
    const levers = categoryLevers(data, new Set(all), [{ id: 1, name: 'Restaurantes', trimmable: true }, { id: 2, name: 'Ocio', trimmable: true }, { id: 3, name: 'Vivienda', trimmable: false }], '2026-09');
    const r = levers.find((l) => l.categoryId === 1)!;
    expect(r).toMatchObject({ monthlyCents: 12000, annualCents: 144000, targetCents: 18000, suggested: true });
    expect(r.detail).toContain('Entre noviembre 2025 y enero 2026');
    // Ocio: best quarter 80 €, but the target is capped at half of today's 400 €.
    expect(levers.find((l) => l.categoryId === 2)).toMatchObject({ targetCents: 20000, monthlyCents: 20000 });
    expect(levers[0]!.categoryId).toBe(2);
  });

  it('plan arithmetic', () => {
    expect(accumulate(0, 10000, 3)).toEqual([10000, 20000, 30000]);
    expect(monthsToReach(100000, 30000)).toBe(4);
    expect(monthsToReach(0, 0)).toBe(0);
    expect(monthsToReach(100, 0)).toBeNull();
  });
});

describe('assistant understanding', () => {
  it('intents', () => {
    expect(detectIntent('¿Cuánto gasté en restaurantes el mes pasado?')).toBe('spending');
    expect(detectIntent('cuanto me cuesta netflix')).toBe('spending');
    expect(detectIntent('¿Cómo puedo ahorrar más?')).toBe('tips');
    expect(detectIntent('¿Cuánto he ahorrado este año?')).toBe('savings');
    expect(detectIntent('¿Cómo acabaré el mes?')).toBe('forecast');
    expect(detectIntent('¿Qué pagos tengo esta semana?')).toBe('upcoming');
    expect(detectIntent('¿Cuánto dinero tengo?')).toBe('balance');
    expect(detectIntent('mis suscripciones')).toBe('recurring');
    expect(detectIntent('¿Cuánto cobré en agosto?')).toBe('income');
    expect(detectIntent('se desconecta gmail')).toBe('help');
  });

  it('periods', () => {
    const t = '2026-10-03';
    expect(detectPeriod('el mes pasado', t)).toMatchObject({ from: '2026-09-01', to: '2026-09-30', implicit: false });
    expect(detectPeriod('este mes', t)).toMatchObject({ from: '2026-10-01', to: '2026-10-03' });
    expect(detectPeriod('en mayo', t)).toMatchObject({ from: '2026-05-01', to: '2026-05-31', label: 'mayo de 2026' });
    expect(detectPeriod('en noviembre', t)).toMatchObject({ from: '2025-11-01', to: '2025-11-30' });
    expect(detectPeriod('en diciembre de 2024', t)).toMatchObject({ from: '2024-12-01', to: '2024-12-31' });
    expect(detectPeriod('este año', t)).toMatchObject({ from: '2026-01-01', to: '2026-10-03' });
    expect(detectPeriod('el año pasado', t)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    expect(detectPeriod('los últimos 3 meses', t)).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(detectPeriod('ayer', t)).toMatchObject({ from: '2026-10-02', to: '2026-10-02' });
    expect(detectPeriod('la semana pasada', t)).toMatchObject({ from: '2026-09-21', to: '2026-09-27' }); // 3 Oct 2026 is a Saturday
    expect(detectPeriod('gastos', t)).toMatchObject({ from: '2026-10-01', implicit: true });
    expect(detectPeriod('en 2025', t)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('targets: categories, synonyms and merchants', () => {
    const cats = [{ id: 1, name: 'Restaurantes', key: 'restaurants' }, { id: 2, name: 'Supermercado', key: 'groceries' }, { id: 3, name: 'Combustible', key: 'fuel' }];
    const merchants = [{ id: 10, name: 'Mercadona' }, { id: 11, name: 'Netflix' }];
    expect(findTarget('cuánto gasté en restaurantes', cats, merchants)).toEqual({ type: 'category', id: 1, name: 'Restaurantes' });
    expect(findTarget('gasolina este mes', cats, merchants)).toEqual({ type: 'category', id: 3, name: 'Combustible' });
    expect(findTarget('¿Cuánto me cuesta Netflix?', cats, merchants)).toEqual({ type: 'merchant', id: 11, name: 'Netflix' });
    expect(findTarget('en mercadona', cats, merchants)).toEqual({ type: 'merchant', id: 10, name: 'Mercadona' });
    expect(findTarget('cuánto gasté', cats, merchants)).toBeNull();
  });

  it('help search', () => {
    expect(searchHelp('se me desconecta gmail cada semana')[0]!.id).toBe('gmail');
    expect(searchHelp('como importo un pdf con contraseña')[0]!.id).toBe('import');
    // The answer is the paragraph that solves the problem, not the article's introduction.
    expect(bestParagraph('se me desconecta gmail', searchHelp('se me desconecta gmail')[0]!)).toMatch(/7 días/);
    expect(bestParagraph('que es gmail', searchHelp('que es gmail')[0]!)).toMatch(/Solo lee/);
    expect(searchHelp('xyzzy')).toEqual([]);
  });
});

describe('notifications', () => {
  it('important alerts and ISO weeks', () => {
    expect(isImportant({ kind: 'low_balance', key: 'lowbal:2026-10-10' })).toBe(true);
    expect(isImportant({ kind: 'budget', key: 'budget:3:2026-10:100' })).toBe(true);
    expect(isImportant({ kind: 'budget', key: 'budget:3:2026-10:80' })).toBe(false);
    expect(isImportant({ kind: 'price_increase', key: 'x' })).toBe(false);
    expect(isoWeekKey(new Date(2026, 9, 3))).toBe('2026-W40');
    expect(isoWeekKey(new Date(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeekKey(new Date(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('income sources', () => {
  it('links extra transfers from your employer to your payroll and finds the extra pays', async () => {
    const { incomeSources, incomePayer } = await import('../../src/core/domain/forecast');
    expect(incomePayer('ABONO DE NOMINA EMPRESA FICTICIA S L')).toEqual({ payer: 'EMPRESA FICTICIA', payroll: true });
    expect(incomePayer('TRANSFERENCIA RECIBIDA DE EMPRESA FICTICIA SPAIN S L')).toEqual({ payer: 'EMPRESA FICTICIA', payroll: false });
    expect(incomePayer('BIZUM RECIBIDO CENA')).toBeNull();
    const incomes = [];
    for (let k = 0; k < 12; k++) {
      const d = new Date(Date.UTC(2025, 9 + k, 1));
      const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      incomes.push({ date: `${m}-26`, cents: 190000 + (k % 2) * 2000, description: 'ABONO DE NOMINA EMPRESA FICTICIA S L' });
      if (m.endsWith('-12') || m.endsWith('-07')) incomes.push({ date: `${m}-17`, cents: 230000, description: 'ABONO DE NOMINA EMPRESA FICTICIA S L' });
      if (k !== 3) incomes.push({ date: `${m}-24`, cents: 90000, description: 'TRANSFERENCIA RECIBIDA DE EMPRESA FICTICIA S L' });
      if (k === 5) incomes.push({ date: `${m}-10`, cents: 30000, description: 'TRANSFERENCIA RECIBIDA DE PERSONA FICTICIA' });
    }
    const s = incomeSources(incomes, '2026-09');
    const payroll = s.find((x) => x.kind === 'payroll')!;
    expect(payroll).toMatchObject({ payer: 'EMPRESA FICTICIA', day: 26, monthsSeen: 12, regular: true });
    expect(payroll.monthlyCents).toBe(191000);
    expect(payroll.extraPays.map((e) => e.month).sort((a, b) => a - b)).toEqual([7, 12]);
    expect(payroll.extraPays.every((e) => e.day === 17)).toBe(true);
    const variable = s.find((x) => x.kind === 'employer_variable')!;
    expect(variable).toMatchObject({ monthlyCents: 90000, day: 24, monthsSeen: 11, regular: true });
    expect(s.find((x) => x.kind === 'other')).toMatchObject({ payer: 'PERSONA FICTICIA', regular: false });
  });
});
