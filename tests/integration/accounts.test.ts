import { describe, expect, it } from 'vitest';
import { makeCore, type TestCore } from '../helpers/core';
import { buildWebMovementsPdf, type WebRow } from '../helpers/synthetic-statement.mjs';
import { Database } from '../../src/core/db/database';
import { MIGRATIONS } from '../../src/core/db/migrations';

// Fictitious "Últimos movimientos" statements of two accounts of the same person (newest first, running balance).
const accountA: WebRow[] = [
  { date: '20/09/2026', concept: 'Transferencia realizada', amount: '-600,00', balance: '900,00', detail: 'Casero Ficticio SL' },
  { date: '12/09/2026', concept: 'Transferencia realizada', amount: '-1.500,00', balance: '1.500,00', detail: 'Persona Ficticia Uno' },
  { date: '05/09/2026', concept: 'Bizum', amount: '-20,00', balance: '3.000,00', detail: 'ENVIADO: cena' },
  { date: '03/09/2026', concept: 'Traspaso a otra cuenta', amount: '-500,00', balance: '3.020,00', detail: 'Cuenta ahorro' },
  { date: '01/09/2026', concept: 'Abono de nómina', amount: '2.000,00', balance: '3.520,00', detail: 'Empresa Ficticia S.L.' },
];

async function importA(core: TestCore) {
  return core.importer.importDocument({ bytes: await buildWebMovementsPdf({ pages: [accountA] }), fileName: 'cuenta-a.pdf', source: 'manual' });
}

describe('accounts, balances and transfers (service level)', () => {
  it('creates the account from the statement with its printed balance and classifies transfers', async () => {
    const core = makeCore({ now: '2026-09-30T10:00:00Z' });
    expect(await importA(core)).toMatchObject({ status: 'imported', inserted: 5 });
    const [acc] = core.accounts.list();
    expect(acc).toMatchObject({ balanceCents: 90000, anchor: { balanceCents: 90000, date: '2026-09-20', source: 'statement' }, movementsCount: 5 });

    const tx = (date: string) => core.repos.transactions.list({ from: date, to: date }).items[0]!;
    expect(tx('2026-09-03')).toMatchObject({ type: 'transfer', categoryName: 'Entre mis cuentas' });
    expect(tx('2026-09-05')).toMatchObject({ type: 'expense', categoryName: 'Bizum y transferencias' });
    expect(tx('2026-09-20')).toMatchObject({ type: 'expense', categoryName: 'Bizum y transferencias' });
    // 1.500 € to someone not reviewed: assumed to be one of your accounts (liquidity kept) until you confirm.
    expect(tx('2026-09-12')).toMatchObject({ type: 'transfer' });
    expect(core.accounts.counterparties().find((c) => c.key === 'PERSONA FICTICIA UNO')).toMatchObject({ needsReview: true, sentCents: 150000 });
    expect(core.analytics.dashboard('2026-09').summary.spendingCents).toBe(2000 + 60000);
  });

  it('beneficiary decisions reclassify past movements and feed a manual remunerated account', async () => {
    const core = makeCore({ now: '2026-09-30T10:00:00Z' });
    await importA(core);
    const food = core.repos.categories.list().find((c) => c.name === 'Vivienda')!;
    core.accounts.decideCounterparty({ key: 'CASERO FICTICIO SL', role: 'other', accountId: null, categoryId: food.id });
    const saving = core.accounts.createManual({ name: 'Remunerada', bank: 'Otro', kind: 'savings', balanceCents: 1000000, date: '2026-09-01', annualRateBp: 0, ownTransferTarget: true });
    core.accounts.decideCounterparty({ key: 'PERSONA FICTICIA UNO', role: 'own', accountId: saving, categoryId: null });
    const tx = (date: string) => core.repos.transactions.list({ from: date, to: date }).items[0]!;
    expect(tx('2026-09-20')).toMatchObject({ type: 'expense', categoryName: 'Vivienda' });
    const remunerada = core.accounts.list().find((a) => a.id === saving)!;
    // Its balance grows with the transfers you sent it (the 1.500 € and the 500 € «traspaso a cuenta ahorro»);
    // your liquidity overall is unchanged by the moves.
    expect(remunerada.balanceCents).toBe(1000000 + 150000 + 50000);
    expect(core.repos.transactions.list({ accountId: saving }).total).toBe(2);
    expect(core.accounts.counterparties().find((c) => c.key === 'PERSONA FICTICIA UNO')).toMatchObject({ role: 'own', needsReview: false });
    // Spending of the month: Bizum + rent (now Vivienda); the transfer to your own account is not spending.
    expect(core.analytics.dashboard('2026-09').summary.spendingCents).toBe(2000 + 60000);

    // Your name in the profile also works without deciding one by one.
    core.accounts.decideCounterparty({ key: 'PERSONA FICTICIA UNO', role: null, accountId: null, categoryId: null });
    core.repos.settings.updateSettings({ profile: { ...core.repos.settings.getSettings().profile, ownerNames: ['Persona Ficticia Uno'] } });
    core.accounts.refreshTransfers();
    expect(tx('2026-09-12')).toMatchObject({ type: 'transfer', categoryName: 'Entre mis cuentas' });
  });

  it('pairs a transfer between two imported accounts and keeps a manual fix', async () => {
    const core = makeCore({ now: '2026-09-30T10:00:00Z' });
    await importA(core);
    // Second account (different bank) receiving the 1.500 € transfer.
    const rowsB: WebRow[] = [
      { date: '13/09/2026', concept: 'Transferencia recibida', amount: '1.500,00', balance: '1.500,00', detail: 'Persona Ficticia Uno' },
    ];
    const pdf = await buildWebMovementsPdf({ pages: [rowsB] });
    // Same generator (BBVA layout) → give it another last4 by renaming the bank in the account afterwards.
    const out = await core.importer.importDocument({ bytes: pdf, fileName: 'cuenta-b.pdf', source: 'manual' });
    expect(out.status).toBe('imported');
    const accounts = core.accounts.list();
    // Same bank and no digits: the importer reuses the account. Split it manually to simulate a second account.
    if (accounts.length === 1) {
      const other = core.repos.accounts.resolveForStatement('Otro banco', 'account', '9999');
      const received = core.repos.transactions.list({ from: '2026-09-13', to: '2026-09-13' }).items[0]!;
      core.repos.db.run('UPDATE transactions SET account_id = ? WHERE id = ?', other, received.id);
    }
    core.accounts.refreshTransfers();
    const sent = core.repos.transactions.list({ from: '2026-09-12', to: '2026-09-12' }).items[0]!;
    const got = core.repos.transactions.list({ from: '2026-09-13', to: '2026-09-13' }).items[0]!;
    expect(sent).toMatchObject({ type: 'transfer', transferMatchId: got.id });
    expect(got).toMatchObject({ type: 'transfer', transferMatchId: sent.id, categoryName: 'Entre mis cuentas' });
    expect(core.analytics.dashboard('2026-09').summary.incomeCents).toBe(200000);
  });

  it('user-entered balance for accounts without printed balance; merging accounts', () => {
    const core = makeCore({ now: '2026-09-30T10:00:00Z' });
    const a = core.repos.accounts.resolveForStatement('Banco X', 'account', null);
    const b = core.repos.accounts.resolveForStatement('Banco X', 'account', '1234');
    expect(b).toBe(a); // digits adopted by the only unnamed account
    const c = core.repos.accounts.resolveForStatement('Banco X', 'account', '5678');
    expect(c).not.toBe(a);
    core.accounts.setBalance(c, 50000, '2026-09-30');
    expect(core.accounts.list().find((x) => x.id === c)).toMatchObject({ balanceCents: 50000, anchor: { source: 'user' } });
    expect(() => core.accounts.setBalance(c, 1, '2027-01-01')).toThrow(/futura/);
    core.accounts.merge(c, a);
    expect(core.accounts.list().map((x) => x.id)).toEqual([a]);
    expect(core.accounts.list()[0]).toMatchObject({ balanceCents: 50000 });
  });

  it('demo data brings accounts, a remunerated account and wider suggestions; all removable', () => {
    const core = makeCore();
    core.data.loadDemo();
    core.recurring.detect();
    const accounts = core.accounts.list();
    expect(accounts.map((a) => a.name)).toEqual(expect.arrayContaining(['Cuenta nómina (demo)', 'Cuenta remunerada (demo)']));
    const remunerada = accounts.find((a) => a.name === 'Cuenta remunerada (demo)')!;
    expect(remunerada.balanceCents).toBeGreaterThan(250000); // receives the monthly transfers to own savings
    const w = core.wealth.wealthOverview();
    expect(w.accountsTotalCents).toBe(accounts.filter((a) => a.includeInNetWorth).reduce((t, a) => t + (a.balanceCents ?? 0), 0));
    const s = core.analytics.savings();
    expect(s.insights.flow.incomeCents).toBeGreaterThan(0);
    expect(s.insights.flow.movedToOwnCents).toBeGreaterThan(0);
    expect(s.emergency.recommendedMonths).toBe(3);
    expect(core.analytics.recommendations().length).toBeGreaterThan(0);
    core.data.removeDemo();
    expect(core.accounts.list()).toEqual([]);
  });

  it('migrates v3 → v4 creating accounts from existing statements', () => {
    const db = new Database(':memory:');
    db.transaction(() => {
      for (const m of MIGRATIONS.slice(0, 3)) db.exec(m.sql);
      db.exec('PRAGMA user_version = 3');
    });
    const ts = '2026-01-01T00:00:00Z';
    db.run("INSERT INTO documents(sha256, file_name, mime_type, size_bytes, source, status, imported_at) VALUES ('x', 'a.pdf', 'application/pdf', 1, 'manual', 'imported', ?)", ts);
    db.run("INSERT INTO statements(document_id, bank, kind, account_hint, computed_total_cents, created_at) VALUES (1, 'BBVA', 'account', '1234', 0, ?)", ts);
    db.run("INSERT INTO categories(name, kind, color, is_system, system_key, created_at) VALUES ('Transferencias', 'neutral', '#000000', 1, 'transfers', ?)", ts);
    db.run("INSERT INTO transactions(document_id, fingerprint, date, description_raw, description_normalized, amount_cents, type, category_id, classification_source, created_at, updated_at) VALUES (1, 'f', '2026-01-02', 'x', 'X', -100, 'expense', 1, 'UNKNOWN', ?, ?)", ts, ts);
    db.migrate();
    expect(db.schemaVersion).toBe(5);
    expect(db.get('SELECT name, bank, last4, source_kind FROM accounts')).toEqual({ name: 'BBVA · cuenta ···1234', bank: 'BBVA', last4: '1234', source_kind: 'account' });
    expect(db.get<{ account_id: number }>('SELECT account_id FROM transactions')!.account_id).toBe(1);
    expect(db.get<{ name: string }>("SELECT name FROM categories WHERE system_key = 'transfers'")!.name).toBe('Entre mis cuentas');
  });
});

describe('same account in two formats and email statements to retry', () => {
  it('movements already imported for the account from another format are not counted twice', async () => {
    const { buildStatementPdf } = await import('../helpers/synthetic-statement.mjs');
    const core = makeCore({ now: '2026-09-30T10:00:00Z' });
    await importA(core);
    // Monthly statement of the same BBVA account (no period printed, dd/mm dates), overlapping two movements.
    const monthly = await buildStatementPdf({
      kind: 'account',
      extraLines: ['Fecha de emisión 30/09/2026'],
      pages: [[
        { date: '01/09', valueDate: '01/09', desc: 'ABONO DE NOMINA EMPRESA FICTICIA', amount: '2.000,00', balance: '3.520,00' },
        { date: '05/09', valueDate: '05/09', desc: 'BIZUM ENVIADO CENA', amount: '-20,00', balance: '3.500,00' },
        { date: '25/09', valueDate: '25/09', desc: 'RECIBO LUZ FICTICIA', amount: '-45,00', balance: '3.455,00' },
      ]],
    });
    const out = await core.importer.importDocument({ bytes: monthly, fileName: 'extracto-septiembre.pdf', source: 'manual' });
    expect(out.status).toBe('imported');
    expect(out.inserted).toBe(1);
    expect(out.duplicatesSkipped).toBe(2);
    const luz = core.repos.transactions.list({ from: '2026-09-25', to: '2026-09-25' }).items[0]!;
    expect(luz).toMatchObject({ amountCents: -4500, date: '2026-09-25' });
    expect(core.accounts.list()).toHaveLength(1);
  });

  it('emailed documents left in review by an old reader are discarded and retried at the next sync', () => {
    const core = makeCore();
    const ts = '2026-09-01T00:00:00Z';
    const doc = core.repos.documents.insert({ sha256: 'abc', fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1, source: 'email', status: 'needs_review', parserId: 'bbva-pdf-v1', warnings: [] });
    core.repos.db.run("INSERT INTO email_imports(provider, message_id, attachment_key, subject, sender, received_at, score_bp, status, document_id, processed_at) VALUES ('gmail', 'm1', 'a', 's', 'x@bbva.es', ?, 9000, 'needs_review', ?, ?)", ts, doc, ts);
    expect(core.importer.retryEmailReviews(['bbva-pdf-v1'])).toBe(1);
    expect(core.repos.db.get<{ status: string }>("SELECT status FROM email_imports WHERE message_id = 'm1'")!.status).toBe('failed');
    expect(core.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')!.n).toBe(0);
  });
});
