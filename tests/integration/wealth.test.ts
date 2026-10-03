import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';
import { Database } from '../../src/core/db/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/core/db/migrations';
import { loanStatus } from '../../src/core/domain/loans';
import type { MarketProvider } from '../../src/core/market/yahoo';

describe('savings pots, emergency fund and wealth (service level)', () => {
  it('demo data produces coherent pots, emergency coverage and net worth, and is fully removable', () => {
    const core = makeCore();
    core.data.loadDemo();
    core.recurring.detect();

    const pots = core.wealth.potsOverview();
    const emergency = pots.pots.find((p) => p.kind === 'emergency')!;
    expect(emergency.savedCents).toBe(360000);
    expect(pots.emergency.essentialMonthlyCents).toBeGreaterThan(0);
    expect(pots.emergency.coverageTenths).toBe(Math.floor((360000 * 10) / pots.emergency.essentialMonthlyCents));
    const trip = pots.pots.find((p) => p.name.startsWith('Viaje'))!;
    expect(trip.savedCents).toBe(90000);
    expect(trip.requiredMonthlyCents).toBe(Math.ceil(260000 / trip.monthsLeft!));
    expect(pots.requiredMonthlyTotalCents).toBe(trip.requiredMonthlyCents);
    expect(pots.insights.length).toBeGreaterThan(0);

    const w = core.wealth.wealthOverview();
    expect(w.assets).toHaveLength(5);
    const mortgage = w.assets.find((a) => a.type === 'mortgage')!;
    expect(mortgage.loan).not.toBeNull();
    expect(mortgage.valueCents).toBe(mortgage.loan!.outstandingCents);
    expect(mortgage.estimated).toBe(true);
    const remunerated = w.assets.find((a) => a.mode === 'rate')!;
    expect(remunerated.valueCents).toBeGreaterThan(500000 + 6 * 10000);
    expect(remunerated.contributedCents).toBe(500000 + 6 * 10000);
    expect(w.netWorthCents).toBe(w.totalAssetsCents - w.totalLiabilitiesCents);
    const fund = w.assets.find((a) => a.type === 'fund')!;
    expect(fund.gainCents).toBe(fund.valueCents! - fund.contributedCents!);
    expect(w.investedContributedCents).toBe(fund.contributedCents! + remunerated.contributedCents!);
    expect(w.history.length).toBeGreaterThanOrEqual(12);
    expect(w.allocation.reduce((a, x) => a + (x.shareBp ?? 0), 0)).toBeGreaterThanOrEqual(9999);

    const json = JSON.parse(core.data.exportJson());
    expect(json.savingsPots.pots).toHaveLength(2);
    expect(json.assetValuations.length).toBe(25);

    core.data.removeDemo();
    expect(core.repos.pots.list()).toEqual([]);
    expect(core.repos.assets.list()).toEqual([]);
    expect(core.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM asset_valuations')!.n).toBe(0);
  });

  it('pot movements add and subtract; only one active emergency fund', () => {
    const core = makeCore();
    const id = core.repos.pots.save({ name: 'Coche', kind: 'goal', targetCents: 500000, targetDate: '2027-09-30', color: '#3b82b8' });
    core.repos.pots.addMovement(id, '2026-09-01', 100000, null);
    core.repos.pots.addMovement(id, '2026-09-10', -25000, 'Retirada');
    expect(core.wealth.potDTOs()[0]!.savedCents).toBe(75000);
    core.repos.pots.save({ name: 'Colchón', kind: 'emergency', targetCents: 600000, targetDate: null, color: '#2f8f6b' });
    expect(() => core.repos.pots.save({ name: 'Otro', kind: 'emergency', targetCents: 1, targetDate: null, color: '#000000' })).toThrow(/Ya tienes un fondo/);
  });

  it('a valuation per asset and day: saving the same date replaces it', () => {
    const core = makeCore();
    const a = core.repos.assets.save({ name: 'Depósito', type: 'deposit', institution: null, notes: null });
    core.repos.assets.upsertValuation({ assetId: a, date: '2026-09-01', valueCents: 1000000, contributedCents: 1000000, note: null });
    core.repos.assets.upsertValuation({ assetId: a, date: '2026-09-01', valueCents: 1002000, contributedCents: 1000000, note: null });
    expect(core.repos.assets.valuations(a)).toHaveLength(1);
    expect(core.wealth.assetDTOs()[0]).toMatchObject({ valueCents: 1002000, gainCents: 2000, returnBp: 20 });
  });

  it('loan assets: validated, valued by the schedule and simulated', () => {
    const core = makeCore({ now: '2026-09-29T10:00:00Z' });
    expect(() => core.repos.assets.save({ name: 'Hipoteca', type: 'mortgage', institution: null, notes: null, mode: 'loan', principalCents: 100, annualRateBp: null })).toThrow(/capital, tipo de interés/);
    const terms = { principalCents: 15000000, annualRateBp: 250, termMonths: 300, startDate: '2021-03-10' };
    const id = core.repos.assets.save({ name: 'Hipoteca', type: 'mortgage', institution: null, notes: null, mode: 'loan', ...terms });
    const cash = core.repos.assets.save({ name: 'Cuenta', type: 'cash', institution: null, notes: null });
    core.repos.assets.upsertValuation({ assetId: cash, date: '2026-09-01', valueCents: 2000000, contributedCents: null, note: null });
    const st = loanStatus(terms, '2026-09-29');
    const dto = core.wealth.assetDTOs().find((a) => a.id === id)!;
    expect(dto).toMatchObject({ mode: 'loan', isLiability: true, valueCents: st.outstandingCents, stale: false, loan: { ...terms, paymentCents: st.paymentCents } });
    const w = core.wealth.wealthOverview();
    expect(w.netWorthCents).toBe(2000000 - st.outstandingCents);
    expect(w.history[0]!.month).toBe('2023-10');
    expect(core.wealth.loanSchedule(id)).toHaveLength(300);
    expect(core.wealth.earlyRepayment(id, '2026-09-29', 1000000, 'reduce_term').interestSavedCents).toBeGreaterThan(0);
    expect(() => core.wealth.loanSchedule(cash)).toThrow(/no es un préstamo/);
    // Switching back to manual clears the loan terms.
    core.repos.assets.save({ id, name: 'Hipoteca', type: 'mortgage', institution: null, notes: null, mode: 'manual' });
    expect(core.repos.assets.get(id)).toMatchObject({ mode: 'manual', principalCents: null, annualRateBp: null, startDate: null });
  });

  it('rate assets estimate from the last real valuation, which resets the estimate', () => {
    const core = makeCore({ now: '2026-01-01T10:00:00Z' });
    const id = core.repos.assets.save({ name: 'Cuenta remunerada', type: 'deposit', institution: null, notes: null, mode: 'rate', annualRateBp: 300 });
    core.repos.assets.upsertValuation({ assetId: id, date: '2025-01-01', valueCents: 1000000, contributedCents: 1000000, note: null });
    expect(core.wealth.assetDTOs()[0]).toMatchObject({ valueCents: 1030000, gainCents: 30000, estimated: true, baseDate: '2025-01-01', stale: false });
    core.repos.assets.upsertValuation({ assetId: id, date: '2026-01-01', valueCents: 1025000, contributedCents: 1000000, note: null });
    expect(core.wealth.assetDTOs()[0]).toMatchObject({ valueCents: 1025000, estimated: false });
    expect(() => core.repos.assets.save({ name: 'x', type: 'fund', institution: null, notes: null, mode: 'rate' })).toThrow(/rentabilidad anual/);
  });

  it('market data is opt-in and only the symbol reaches the provider', async () => {
    const calls: string[] = [];
    const market: MarketProvider = {
      source: 'Fake',
      search: async (q) => { calls.push(q); return [{ symbol: 'IWDA.AS', name: 'MSCI World', type: 'ETF', exchange: 'AMS' }]; },
      monthlyHistory: async (s) => {
        calls.push(s);
        const points = Array.from({ length: 61 }, (_, m) => ({ date: `${2021 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`, price: 100 * Math.pow(1.08, m / 12) }));
        return { symbol: s, name: 'MSCI World', currency: 'EUR', points };
      },
    };
    const core = makeCore({ market });
    await expect(core.wealth.marketSearch('world')).rejects.toMatchObject({ code: 'MARKET_DISABLED' });
    expect(calls).toEqual([]);
    core.repos.settings.updateSettings({ marketDataEnabled: true });
    expect(await core.wealth.marketSearch('world')).toHaveLength(1);
    const r = await core.wealth.marketReturns('IWDA.AS');
    expect(Math.abs(r.cagr.y5! - 800)).toBeLessThanOrEqual(15);
    expect(r.indexSeries[0]).toEqual({ date: '2021-01-01', value: 100 });
    expect(r.source).toBe('Fake');
    expect(calls).toEqual(['world', 'IWDA.AS']);
    await expect(makeCore().wealth.marketSearch('x')).rejects.toMatchObject({ code: 'MARKET_DISABLED' });
  });

  it('clearing loaded data keeps configuration, goals and wealth', () => {
    const core = makeCore();
    core.data.loadDemo();
    const pots = core.repos.pots.list().length;
    const assets = core.repos.assets.list().length;
    const rules = core.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM categorization_rules')!.n;
    const r = core.data.clearImported();
    expect(r.transactions).toBeGreaterThan(0);
    for (const t of ['transactions', 'documents', 'statements', 'import_review_items', 'recurring_expenses', 'email_imports']) {
      expect(core.repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
    }
    expect(core.repos.pots.list()).toHaveLength(pots);
    expect(core.repos.assets.list()).toHaveLength(assets);
    expect(core.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM categorization_rules')!.n).toBe(rules);
    expect(core.repos.settings.getSettings().onboardingCompleted).toBe(core.repos.settings.getSettings().onboardingCompleted);
  });

  it('migrates a v2 database to v3 keeping assets as manual', () => {
    const db = new Database(':memory:');
    db.transaction(() => {
      db.exec(MIGRATIONS[0]!.sql);
      db.exec(MIGRATIONS[1]!.sql);
      db.exec('PRAGMA user_version = 2');
    });
    db.run("INSERT INTO assets(name, type, created_at, updated_at) VALUES ('Fondo', 'fund', 'now', 'now')");
    db.migrate();
    expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(db.get<{ valuation_mode: string; annual_rate_bp: number | null }>('SELECT valuation_mode, annual_rate_bp FROM assets')).toEqual({ valuation_mode: 'manual', annual_rate_bp: null });
  });

  it('migrates an existing v1 database to v2 without losing data', () => {
    const db = new Database(':memory:');
    db.transaction(() => {
      db.exec(MIGRATIONS[0]!.sql);
      db.exec('PRAGMA user_version = 1');
    });
    db.run("INSERT INTO settings(key, value, updated_at) VALUES ('x', '1', 'now')");
    db.migrate();
    expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'x'")!.value).toBe('1');
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'savings_pots'")).toBeDefined();
  });
});
