import { describe, expect, it } from 'vitest';
import { makeCore, MemoryVault, type TestCore } from '../helpers/core';
import { budgetLine, suggestBudget } from '../../src/core/domain/budgets';
import { inferTransactionType } from '../../src/core/domain/transactionType';
import { normalizeText } from '../../src/core/domain/merchant';
import { AppLock } from '../../src/main/lock';
import { IPC_SCHEMAS } from '../../src/main/ipcSchemas';
import { nullLogger } from '../../src/core/services/context';
import { LOCK_CHANNELS } from '../../src/shared/channels';

function insert(core: TestCore, rows: { date: string; desc: string; amount: number; category?: string }[]) {
  const cats = core.repos.categories.list();
  const merchantIds = new Map<string, number>();
  rows.forEach((r, i) => {
    const key = normalizeText(r.desc);
    if (!merchantIds.has(key)) merchantIds.set(key, core.repos.merchants.upsert(key, r.desc));
    const t = inferTransactionType(key, r.amount, 'account');
    core.repos.transactions.insert({
      documentId: null, fingerprint: `f${i}-${r.date}-${r.amount}`, date: r.date, bookingDate: null, descriptionRaw: r.desc, descriptionNormalized: key,
      merchantRaw: r.desc, merchantId: merchantIds.get(key)!, amountCents: r.amount, type: t.type,
      categoryId: cats.find((c) => c.name === (r.category ?? 'Restaurantes'))!.id, classificationSource: 'RULE', classificationConfidence: 1, classificationDetail: null, ruleId: null,
    });
  });
}

describe('budgets', () => {
  it('suggests from history and projects the current month', () => {
    expect(suggestBudget([12000, 18000, 15000])).toBe(15000);
    expect(suggestBudget([0, 0, 0])).toBeNull();
    const l = budgetLine({ categoryId: 1, name: 'Restaurantes', color: '#000', limitCents: 20000, spentCents: 10000, month: '2026-09', today: '2026-09-10', suggestedCents: null, averageCents: null });
    expect(l).toMatchObject({ usedBp: 5000, projectedCents: 30000, status: 'at_risk', daysLeft: 20, remainingCents: 10000 });
    expect(budgetLine({ ...l, limitCents: 12000, spentCents: 10000, month: '2026-09', today: '2026-09-28', suggestedCents: null, averageCents: null, name: 'x', color: '#000', categoryId: 1 }).status).toBe('warning');
    expect(budgetLine({ categoryId: 1, name: 'x', color: '#000', limitCents: 9000, spentCents: 10000, month: '2026-08', today: '2026-09-28', suggestedCents: null, averageCents: null }).status).toBe('over');
  });

  it('service: overview, suggestions and alerts at 80 % / exceeded, raised once', () => {
    const core = makeCore({ now: '2026-09-20T10:00:00Z' });
    insert(core, [
      { date: '2026-06-05', desc: 'Bar Ficticio', amount: -15000 },
      { date: '2026-07-05', desc: 'Bar Ficticio', amount: -15000 },
      { date: '2026-08-05', desc: 'Bar Ficticio', amount: -15000 },
      { date: '2026-09-05', desc: 'Bar Ficticio', amount: -9000 },
    ]);
    const restaurants = core.repos.categories.list().find((c) => c.name === 'Restaurantes')!;
    const before = core.budgets.overview();
    expect(before.suggestions[0]).toMatchObject({ categoryId: restaurants.id, averageCents: 15000, suggestedCents: 15000 });
    core.budgets.set(restaurants.id, 10000);
    const o = core.budgets.overview();
    expect(o.lines[0]).toMatchObject({ spentCents: 9000, usedBp: 9000, status: 'warning', averageCents: 15000 });
    const first = core.budgets.refreshAlerts();
    expect(first.map((a) => a.kind)).toContain('budget');
    expect(core.budgets.refreshAlerts()).toEqual([]); // not raised twice
    insert(core, [{ date: '2026-09-18', desc: 'Bar Ficticio', amount: -2000 }]);
    expect(core.budgets.refreshAlerts().map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringMatching(/Has superado tu presupuesto de Restaurantes/)]));
    core.budgets.markRead();
    expect(core.budgets.alerts().every((a) => a.read)).toBe(true);
    core.budgets.set(restaurants.id, null);
    expect(core.budgets.overview().lines).toEqual([]);
    const own = core.repos.categories.list().find((c) => c.name === 'Entre mis cuentas')!;
    expect(() => core.budgets.set(own.id, 1000)).toThrow(/no admite presupuesto/);
  });

  it('alerts for duplicated and unusually large charges', () => {
    const core = makeCore({ now: '2026-09-20T10:00:00Z' });
    insert(core, [
      { date: '2026-06-01', desc: 'Gimnasio Ficticio', amount: -3000, category: 'Deporte' },
      { date: '2026-07-01', desc: 'Gimnasio Ficticio', amount: -3000, category: 'Deporte' },
      { date: '2026-08-01', desc: 'Gimnasio Ficticio', amount: -3000, category: 'Deporte' },
      { date: '2026-09-15', desc: 'Gimnasio Ficticio', amount: -9900, category: 'Deporte' },
      { date: '2026-09-16', desc: 'Tienda Ficticia', amount: -2500, category: 'Compras' },
      { date: '2026-09-16', desc: 'Tienda Ficticia', amount: -2500, category: 'Compras' },
    ]);
    const kinds = core.budgets.refreshAlerts().map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['unusual_charge', 'duplicate_charge']));
  });
});

describe('property operations and extraordinary movements', () => {
  it('a loan drawdown is neutral; very large movements can be marked as wealth operations', () => {
    const core = makeCore({ now: '2026-09-20T10:00:00Z' });
    expect(inferTransactionType(normalizeText('Abono por disposicion de prestamo/credito'), 15000000, 'account').type).toBe('transfer');
    insert(core, [
      { date: '2023-03-15', desc: 'Nomina Empresa Ficticia', amount: 250000, category: 'Ingresos' },
      { date: '2023-03-15', desc: 'Cargo por emision de cheque bancario', amount: -2500000, category: 'Vivienda' },
      { date: '2023-03-17', desc: 'Pago de impuestos', amount: -400000, category: 'Impuestos' },
    ]);
    // Drawdown imported as income by an older version: migration makes it neutral.
    const cats = core.repos.categories.list();
    core.repos.transactions.insert({ documentId: null, fingerprint: 'loan', date: '2023-03-15', bookingDate: null, descriptionRaw: 'Abono por disposicion de prestamo/credito', descriptionNormalized: normalizeText('Abono por disposicion de prestamo/credito'), merchantRaw: null, merchantId: null, amountCents: 15000000, type: 'income', categoryId: cats.find((c) => c.name === 'Ingresos')!.id, classificationSource: 'HEURISTIC', classificationConfidence: 0.7, classificationDetail: null, ruleId: null });
    expect(core.accounts.refreshCapital()).toBe(1);
    const june = () => core.analytics.dashboard('2023-03').summary;
    expect(june().incomeCents).toBe(250000);
    const list = core.accounts.extraordinary();
    expect(list.map((m) => m.amountCents)).toEqual([-2500000]);
    core.accounts.resolveExtraordinary(list[0]!.id, true);
    expect(june().spendingCents).toBe(400000); // the taxes of the purchase are still spending
    expect(core.accounts.extraordinary()).toEqual([]);
    // "Es un gasto real" keeps it and stops asking.
    insert(core, [{ date: '2025-01-10', desc: 'Reforma cocina', amount: -1500000, category: 'Vivienda' }]);
    const reforma = core.accounts.extraordinary()[0]!;
    core.accounts.resolveExtraordinary(reforma.id, false);
    expect(core.accounts.extraordinary()).toEqual([]);
    expect(core.analytics.dashboard('2025-01').summary.spendingCents).toBe(1500000);
  });
});

describe('app lock', () => {
  const make = (enabled = true) => {
    const vault = new MemoryVault();
    const events: boolean[] = [];
    const lock = new AppLock(vault, () => ({ enabled, windowsHello: false, autoLockMinutes: 5 }), nullLogger, (s) => events.push(s.locked));
    return { vault, lock, events };
  };

  it('stores only a salted hash, unlocks with the right PIN and slows down guessing', async () => {
    const { vault, lock } = make();
    await lock.setPin('4321');
    const stored = [...vault.data.values()].join('');
    expect(stored).not.toContain('4321');
    await lock.init();
    expect(lock.isLocked()).toBe(true);
    await expect(lock.unlockWithPin('0000')).rejects.toThrow(/incorrecto/);
    await expect(lock.unlockWithPin('1111')).rejects.toThrow(/incorrecto/);
    await expect(lock.unlockWithPin('2222')).rejects.toThrow(/incorrecto/);
    await expect(lock.unlockWithPin('4321')).rejects.toThrow(/Demasiados intentos/);
    expect((await lock.status()).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('unlocks, relocks, changes and removes the PIN only with the current one', async () => {
    const { lock } = make();
    await lock.setPin('123456');
    await lock.init();
    expect((await lock.unlockWithPin('123456')).locked).toBe(false);
    lock.lock();
    expect(lock.isLocked()).toBe(true);
    await lock.unlockWithPin('123456');
    await expect(lock.setPin('9999', '000000')).rejects.toThrow(/actual/);
    await lock.setPin('9999', '123456');
    await expect(lock.removePin('123456')).rejects.toThrow(/no es correcto/);
    await lock.removePin('9999');
    expect((await lock.status()).pinSet).toBe(false);
    await expect(lock.setPin('12')).rejects.toThrow(/4 y 8/);
  });

  it('is not active when disabled, and the lock cannot be switched off through the settings channel', async () => {
    const { lock } = make(false);
    await lock.setPin('1234');
    await lock.init();
    expect(lock.isLocked()).toBe(false);
    lock.lock();
    expect(lock.isLocked()).toBe(false);
    expect(IPC_SCHEMAS['settings.update'].safeParse({ lock: { enabled: false } }).success).toBe(false);
    expect(LOCK_CHANNELS).not.toContain('settings.get');
    expect(LOCK_CHANNELS).not.toContain('transactions.list');
  });
});
