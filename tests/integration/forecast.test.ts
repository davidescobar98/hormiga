import { describe, expect, it } from 'vitest';
import { makeCore, MemoryVault } from '../helpers/core';
import { addDays } from '../../src/shared/dates';
import { formatCents } from '../../src/shared/money';

function demoCore() {
  const core = makeCore();
  core.data.loadDemo();
  core.recurring.detect();
  return core;
}

describe('Previsión (service level)', () => {
  it('projects the current account with recurring payments, payroll and usual spending, consistently', () => {
    const core = demoCore();
    const o0 = core.forecast.overview();
    expect(o0.hasData).toBe(true);
    // No current account with a balance yet: explained, not invented.
    if (!core.accounts.list().some((a) => a.kind === 'current' && a.balanceCents !== null)) {
      expect(o0.balance).toBeNull();
      expect(o0.balanceNote).toMatch(/saldo/);
      const acc = core.accounts.createManual({ name: 'Corriente', bank: 'Demo', kind: 'current', balanceCents: 250000, date: o0.today, annualRateBp: 0, ownTransferTarget: false });
      expect(acc).toBeGreaterThan(0);
    }
    const o = core.forecast.overview();
    const b = o.balance!;
    expect(b).not.toBeNull();
    expect(b.points).toHaveLength(60);
    // The projection is exactly: start + expected events − usual variable spending and transfers per day.
    const basis = core.analytics.forecastBasis();
    const daily = basis.variableMonthlyCents! / 30.4375 + b.dailyTransfersCents;
    expect(b.dailyVariableCents).toBeCloseTo(basis.variableMonthlyCents! / 30.4375, 1);
    // Between today and 30 days later the balance moves exactly by the expected events minus usual spending (± 1 cent).
    const at = (d: string) => b.points.find((p) => p.date === d)!.balanceCents;
    const startToday = b.startDate === o.today ? b.startCents : at(o.today);
    const d30 = addDays(o.today, 30);
    const eventsTo30 = o.upcoming.filter((e) => e.date <= d30).reduce((t, e) => t + e.amountCents, 0);
    const k0 = Math.round((Date.parse(o.today) - Date.parse(b.startDate)) / 86400000);
    const expected = startToday + eventsTo30 - (Math.round(daily * (k0 + 30)) - Math.round(daily * k0));
    expect(Math.abs(at(d30) - expected)).toBeLessThanOrEqual(1);
    expect(b.min.balanceCents).toBe(Math.min(...b.points.filter((p) => p.date > o.today).map((p) => p.balanceCents)));
    expect(['ok', 'low', 'negative']).toContain(b.risk);
    // Recurring charges appear in the next 30 days with their usual amount.
    const recurring = core.analytics.activeRecurring();
    for (const e of o.upcoming.filter((x) => x.kind === 'recurring')) {
      const r = recurring.find((x) => x.merchantName === e.label)!;
      expect(e.amountCents).toBe(-r.averageCents);
    }
  });

  it('levers and plan come from your own months; the plan becomes budgets', () => {
    const core = demoCore();
    const o = core.forecast.overview();
    for (const l of o.levers) {
      expect(l.monthlyCents).toBeGreaterThan(0);
      expect(l.annualCents).toBe(l.monthlyCents * 12);
    }
    const cat = o.levers.filter((l) => l.kind === 'category');
    if (cat.length) {
      core.budgets.setMany(cat.map((l) => ({ categoryId: l.categoryId!, amountCents: l.targetCents! })));
      const lines = core.budgets.overview().lines;
      for (const l of cat) expect(lines.find((x) => x.categoryId === l.categoryId)?.limitCents).toBe(l.targetCents);
      expect(core.forecast.overview().plan.budgetedCategoryIds.sort()).toEqual(cat.map((l) => l.categoryId).sort());
    }
    expect(o.plan.baselineMonthlyCents).toBe(core.analytics.savings().capacity.capacityCents);
  });

  it('low balance ahead raises an alert once per episode', () => {
    const core = demoCore();
    const today = core.forecast.overview().today;
    core.accounts.createManual({ name: 'Corriente', bank: 'Demo', kind: 'current', balanceCents: 5000, date: today, annualRateBp: 0, ownTransferTarget: false });
    const o = core.forecast.overview();
    // Demo data ends at "today" (fresh), the account starts at 50 €: it will fall below 100 €.
    if (o.staleDays !== null && o.staleDays <= 7) {
      const fresh = core.budgets.refreshAlerts().filter((a) => a.kind === 'low_balance');
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.page).toBe('forecast');
      expect(core.budgets.refreshAlerts().filter((a) => a.kind === 'low_balance')).toHaveLength(0);
    }
  });
});

describe('Pregunta a Hormiga (service level)', () => {
  it('answers with the same numbers as the rest of the app', () => {
    const core = demoCore();
    const last = core.analytics.availableMonths().filter((m) => m < core.analytics.forecastBasis().today.slice(0, 7)).at(-1)!;
    const report = core.analytics.report({ from: last, to: last });
    const month = Number(last.slice(5, 7));
    const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const a = core.assistant.ask(`¿Cuánto he ahorrado en ${names[month - 1]} de ${last.slice(0, 4)}?`);
    expect(a.facts.find((f) => f.label === 'Ahorro')!.value).toBe(formatCents(report.totals.savingsCents));
    const cat = report.categories?.[0];
    if (cat) {
      const s = core.assistant.ask(`¿Cuánto gasté en ${cat.name} en ${names[month - 1]} de ${last.slice(0, 4)}?`);
      expect(s.text).toContain(cat.name);
      expect(s.actions[0]).toMatchObject({ page: 'transactions', params: { categoryId: cat.categoryId } });
    }
    expect(core.assistant.ask('¿Cómo puedo ahorrar más?').actions.some((x) => x.page === 'forecast')).toBe(true);
    expect(core.assistant.ask('se me desconecta gmail').actions[0]).toMatchObject({ page: 'help', params: { section: 'gmail' } });
    expect(core.assistant.ask('blablabla').suggestions.length).toBeGreaterThan(0);
  });

  it('without data it says what to do', () => {
    const core = makeCore();
    expect(core.assistant.ask('¿cuánto gasté este mes?').actions[0]!.page).toBe('import');
  });
});

describe('Gmail connection survives', () => {
  it('keeps the OAuth client outside the vault and only asks to reconnect', async () => {
    const core = makeCore();
    await core.gmailAuth.saveClientConfig({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'not-really-secret' });
    await core.vault.set('gmail.tokens', JSON.stringify({ refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.readonly' }));
    expect((await core.sync.status()).state).toBe('connected');
    expect((await core.sync.status()).canSend).toBe(false);
    // Windows can no longer decrypt the vault (e.g. a different machine key): the client is kept.
    (core.vault as MemoryVault).data.clear();
    const s = await core.sync.status();
    expect(s.clientConfigured).toBe(true);
    expect(s.state).toBe('disconnected');
    // And the vault copy is healed.
    expect(core.vault.data.get('gmail.client')).toContain('abc.apps.googleusercontent.com');
    // Removing it is still possible on purpose.
    await core.gmailAuth.clearClientConfig();
    expect((await core.sync.status()).state).toBe('not_configured');
  });

  it('knows when the send permission was granted', async () => {
    const core = makeCore();
    await core.gmailAuth.saveClientConfig({ clientId: 'abc', clientSecret: 's' });
    await core.vault.set('gmail.tokens', JSON.stringify({ refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' }));
    expect(await core.gmailAuth.canSend()).toBe(true);
    expect((await core.sync.status()).canSend).toBe(true);
  });

  it('flags the weekly expiry of projects in Testing mode, and raises one alert', async () => {
    const core = makeCore();
    await core.gmailAuth.saveClientConfig({ clientId: 'abc', clientSecret: 's' });
    await core.vault.set('gmail.tokens', JSON.stringify({ refresh_token: 'r' }));
    core.repos.settings.setRaw('gmail.authorizedAt', '2026-09-08T10:00:00Z');
    core.repos.settings.setRaw('email.authError', 'Google ha retirado la autorización');
    core.repos.settings.setRaw('email.authErrorAt', '2026-09-15T09:00:00Z');
    const s = await core.sync.status();
    expect(s.state).toBe('reauth_required');
    expect(s.weeklyExpiryLikely).toBe(true);
    const alerts = core.budgets.refreshAlerts().filter((a) => a.kind === 'gmail');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.section).toBe('email');
  });
});

describe('weekly summary', () => {
  it('is due once per week from Monday 8:00 and summarises the week', () => {
    const core = demoCore();
    core.repos.settings.updateSettings({ onboardingCompleted: true });
    core.clock.now = new Date(2026, 8, 14, 7, 0); // Monday 7:00 local
    expect(core.notify.weeklyDue()).toBe(false);
    core.clock.now = new Date(2026, 8, 14, 9, 0);
    expect(core.notify.weeklyDue()).toBe(true);
    const s = core.notify.weeklySummary()!;
    expect(s.text).toMatch(/Últimos 7 días/);
    core.notify.markWeeklySent();
    expect(core.notify.weeklyDue()).toBe(false);
    core.clock.now = new Date(2026, 8, 21, 9, 0);
    expect(core.notify.weeklyDue()).toBe(true);
  });
});
