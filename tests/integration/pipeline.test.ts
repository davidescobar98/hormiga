import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatementPdf, sampleCardSpec } from '../helpers/synthetic-statement.mjs';
import { makeCore } from '../helpers/core';
import { inspectDatabaseFile } from '../../src/core/db/database';
import { LATEST_SCHEMA_VERSION } from '../../src/core/db/migrations';

async function importSample(core: ReturnType<typeof makeCore>, overrides = {}, name = 'extracto-agosto.pdf') {
  const bytes = await buildStatementPdf(sampleCardSpec(overrides));
  return core.importer.importDocument({ bytes, fileName: name, source: 'manual' });
}

describe('document → parser → normalization → database → analytics', () => {
  it('imports a statement and exposes consistent analytics', async () => {
    const core = makeCore();
    const out = await importSample(core);
    expect(out.status).toBe('imported');
    expect(out.inserted).toBe(6);

    const page = core.repos.transactions.list({ limit: 50, sort: 'date', dir: 'asc' });
    expect(page.total).toBe(6);
    const mercadona = page.items.find((t) => t.merchantName === 'Mercadona')!;
    expect(mercadona.categoryName).toBe('Supermercado');
    expect(mercadona.classificationSource).toBe('MERCHANT');
    expect(mercadona.descriptionRaw).toBe('COMPRA TARJ. MERCADONA 1234 MADRID');
    const refund = page.items.find((t) => t.type === 'refund')!;
    expect(refund.amountCents).toBe(1999);
    expect(refund.categoryName).toBe('Compras');

    const detail = core.repos.transactions.get(mercadona.id);
    expect(detail.document?.fileName).toBe('extracto-agosto.pdf');
    expect(detail.document?.periodStart).toBe('2026-08-01');

    const d = core.analytics.dashboard('2026-08');
    expect(d.summary.grossExpensesCents).toBe(135325);
    expect(d.summary.refundsCents).toBe(1999);
    expect(d.summary.spendingCents).toBe(133326); // equals the statement total
    const byCategory = core.analytics.report({ from: '2026-08', to: '2026-08' }).categories.reduce((a, c) => a + c.spentCents, 0);
    expect(byCategory).toBe(d.summary.spendingCents);
  });

  it('is idempotent: the same document is detected as duplicate and nothing is inserted twice', async () => {
    const core = makeCore();
    await importSample(core);
    const again = await importSample(core);
    expect(again.status).toBe('duplicate');
    expect(again.errorCode).toBe('DUPLICATE_DOCUMENT');
    expect(core.repos.transactions.count()).toBe(6);
  });

  it('overlapping statements (different file, same movements) do not duplicate movements', async () => {
    const core = makeCore();
    await importSample(core);
    const overlap = await importSample(core, {
      extraLines: ['Documento reenviado'],
      pages: [[
        { date: '02/08/2026', desc: 'COMPRA TARJ. MERCADONA 1234 MADRID', amount: '45,20' },
        { date: '25/08/2026', desc: 'LIDL SUPERMERCADOS', amount: '10,00' },
      ]],
      total: '55,20',
    }, 'reenvio.pdf');
    expect(overlap.status).toBe('imported');
    expect(overlap.inserted).toBe(1);
    expect(overlap.duplicatesSkipped).toBe(1);
    expect(core.repos.transactions.count()).toBe(7);
  });

  it('sends inconsistent documents to review and imports only after confirmation', async () => {
    const core = makeCore();
    const out = await importSample(core, { total: '9.999,99' });
    expect(out.status).toBe('needs_review');
    expect(core.repos.transactions.count()).toBe(0);
    expect(core.analytics.availableMonths()).toEqual([]);

    const review = core.importer.review(out.documentId!);
    expect(review.statementIssues[0]).toContain('no coincide');
    expect(review.items.every((i) => i.status === 'accepted')).toBe(true);
    core.importer.updateReviewItem({ id: review.items[3]!.id, status: 'discarded' });
    const res = core.importer.confirmReview(out.documentId!);
    expect(res.inserted).toBe(5);
    expect(core.repos.documents.get(out.documentId!).status).toBe('imported');
  });

  it('rows with errors block confirmation until fixed or discarded', async () => {
    const core = makeCore();
    const out = await importSample(core, {
      pages: [[{ date: '02/08/2026', desc: 'MERCADONA', amount: '5,00' }, { date: '31/02/2026', desc: 'COMPRA CON FECHA IMPOSIBLE', amount: '7,00' }]],
      total: '12,00',
    });
    expect(out.status).toBe('needs_review');
    const items = core.importer.review(out.documentId!).items;
    const bad = items.find((i) => i.status === 'pending')!;
    expect(() => core.importer.confirmReview(out.documentId!)).toThrow(/pendientes/);
    expect(() => core.importer.updateReviewItem({ id: bad.id, status: 'accepted' })).toThrow(/No se puede aceptar/);
    core.importer.updateReviewItem({ id: bad.id, date: '2026-08-28' });
    expect(core.importer.confirmReview(out.documentId!).inserted).toBe(2);
  });

  it('reports unknown formats and invalid PDFs without touching the database', async () => {
    const core = makeCore();
    const notBbva = await core.importer.importDocument({ bytes: await buildStatementPdf({ omitBank: true, pages: [[]] }), fileName: 'otro.pdf', source: 'manual' });
    expect(notBbva).toMatchObject({ status: 'failed', errorCode: 'UNKNOWN_FORMAT' });
    const invalid = await core.importer.importDocument({ bytes: new TextEncoder().encode('hola'), fileName: 'x.pdf', source: 'manual' });
    expect(invalid).toMatchObject({ status: 'failed', errorCode: 'PDF_INVALID' });
    expect(core.repos.documents.list()).toEqual([]);
  });

  it('keeps the original PDF only when the user enables it', async () => {
    const core = makeCore();
    await importSample(core);
    expect(core.store.files.size).toBe(0);
    core.repos.settings.updateSettings({ keepDocuments: true });
    const out = await importSample(core, { extraLines: ['otra copia'] }, 'b.pdf');
    expect(core.repos.documents.get(out.documentId!).retained).toBe(true);
    expect(core.store.files.size).toBe(1);
    await core.importer.deleteRetainedDocuments();
    expect(core.store.files.size).toBe(0);
  });
});

describe('learning from the user', () => {
  it('manual correction → rule suggestion → rule applies to existing and future movements', async () => {
    const core = makeCore();
    await importSample(core);
    const shop = core.repos.transactions.list({ search: 'barrio luna' }).items[0]!;
    expect(shop.classificationSource).toBe('UNKNOWN');
    const compras = core.repos.categories.list().find((c) => c.name === 'Compras')!;

    const upd = core.categorization.updateTransaction({ id: shop.id, categoryId: compras.id });
    expect(upd.transaction.categoryLocked).toBe(true);
    expect(upd.ruleSuggestion).toMatchObject({ merchantName: 'Novedades Barrio Luna', categoryName: 'Compras' });

    const rule = core.categorization.createRule({ matchType: 'merchant', pattern: String(upd.ruleSuggestion!.merchantId), categoryId: compras.id, applyToExisting: true });
    expect(rule.rule.displayPattern).toContain('Novedades Barrio Luna');

    const next = await importSample(core, {
      period: ['01/09/2026', '30/09/2026'],
      pages: [[{ date: '03/09/2026', desc: 'NOVEDADES BARRIO LUNA 5555', amount: '14,00' }]],
      total: '14,00',
    }, 'septiembre.pdf');
    expect(next.status).toBe('imported');
    const future = core.repos.transactions.list({ from: '2026-09-01' }).items[0]!;
    expect(future.categoryName).toBe('Compras');
    expect(future.classificationSource).toBe('USER');
    expect(core.repos.transactions.get(future.id).rule?.matchType).toBe('merchant');
  });

  it('deleting a rule re-categorizes the affected movements', async () => {
    const core = makeCore();
    await importSample(core);
    const mercadona = core.repos.transactions.list({ search: 'mercadona' }).items[0]!;
    const otros = core.repos.categories.list().find((c) => c.name === 'Otros')!;
    const r = core.categorization.createRule({ matchType: 'merchant', pattern: String(mercadona.merchantId), categoryId: otros.id, applyToExisting: true });
    expect(core.repos.transactions.get(mercadona.id).categoryName).toBe('Otros');
    core.categorization.deleteRule(r.rule.id);
    expect(core.repos.transactions.get(mercadona.id).categoryName).toBe('Supermercado');
  });

  it('excluded movements and transfers do not count as spending', async () => {
    const core = makeCore();
    await importSample(core);
    const sofa = core.repos.transactions.list({ search: 'sofa' }).items[0]!;
    core.categorization.updateTransaction({ id: sofa.id, isExcluded: true });
    expect(core.analytics.dashboard('2026-08').summary.spendingCents).toBe(133326 - 123456);
    const netflix = core.repos.transactions.list({ search: 'netflix' }).items[0]!;
    core.categorization.updateTransaction({ id: netflix.id, type: 'transfer' });
    expect(core.analytics.dashboard('2026-08').summary.spendingCents).toBe(133326 - 123456 - 1299);
  });
});

describe('demo data, savings and recommendations end to end', () => {
  it('produces a full, consistent dataset', () => {
    const core = makeCore();
    const { transactions } = core.data.loadDemo();
    expect(transactions).toBeGreaterThan(400);
    core.recurring.detect();
    const recurring = core.recurring.list();
    const names = recurring.map((r) => r.merchantName);
    expect(names).toEqual(expect.arrayContaining(['Netflix', 'Spotify', 'Basic-Fit', 'Mapfre', 'Movistar']));
    expect(recurring.find((r) => r.merchantName === 'Mercadona')).toBeUndefined();

    const d = core.analytics.dashboard();
    expect(d.referenceMonth).toBe('2026-08');
    expect(d.monthsOfData).toBe(12);
    expect(d.summary.incomeCents).toBe(245000);
    expect(d.summary.savingsCents).toBe(d.summary.incomeCents - d.summary.spendingCents);
    expect(d.comparisons.map((c) => c.label)).toEqual(['Mes anterior', 'Media 3 meses', 'Media 6 meses']);

    const s = core.analytics.savings();
    expect(s.capacity.provisional).toBe(false);
    expect(s.capacity.monthsUsed).toBe(6);
    const sumLines = s.capacity.lines.slice(0, -1).reduce((a, l) => a + (l.op === '-' ? -l.cents : l.cents), 0);
    expect(sumLines).toBe(s.capacity.capacityCents);
    expect(s.scenarios.map((x) => x.id)).toEqual(['actual', 'moderate', 'goal']);

    const recs = core.analytics.recommendations();
    const types = recs.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['subscriptions', 'fees', 'frequent_small_purchases']));
    expect(recs.some((r) => r.category === 'Restaurantes')).toBe(true);

    // Transfers to own savings account are excluded from spending.
    const transfers = core.repos.transactions.list({ type: 'transfer', limit: 500 });
    expect(transfers.total).toBe(12);
    const report = core.analytics.report({ from: '2025-09', to: '2026-08' });
    expect(report.categories.find((c) => c.name === 'Transferencias')).toBeUndefined();
    expect(report.categories.reduce((a, c) => a + c.spentCents, 0)).toBe(report.totals.spendingCents);

    const removed = core.data.removeDemo();
    expect(removed.removed).toBe(transactions);
    expect(core.repos.transactions.count()).toBe(0);
    expect(core.repos.income.list()).toEqual([]);
  });

  it('dismissed recommendations stay dismissed', () => {
    const core = makeCore();
    core.data.loadDemo();
    core.recurring.detect();
    const first = core.analytics.recommendations()[0]!;
    core.repos.recommendations.dismiss(first.key);
    expect(core.analytics.recommendations().some((r) => r.key === first.key)).toBe(false);
  });
});

describe('exports and backups', () => {
  it('exports CSV and JSON with integer cents and original descriptions', async () => {
    const core = makeCore();
    await importSample(core);
    const csv = core.data.exportCsv();
    expect(csv.startsWith('﻿fecha;')).toBe(true);
    expect(csv).toContain('COMPRA TARJ. MERCADONA 1234 MADRID');
    expect(csv).toContain('-1234,56');
    const json = JSON.parse(core.data.exportJson());
    expect(json.transactions).toHaveLength(6);
    expect(json.transactions.every((t: { amountCents: number }) => Number.isInteger(t.amountCents))).toBe(true);
  });

  it('creates a consistent backup that can be validated before restoring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hormiga-test-'));
    try {
      const core = makeCore({ path: join(dir, 'hormiga.db') });
      await importSample(core);
      const backup = join(dir, 'copia.hormiga-backup');
      core.repos.db.backupTo(backup);
      const info = inspectDatabaseFile(backup);
      expect(info).toEqual({ appId: 'hormiga', schemaVersion: LATEST_SCHEMA_VERSION, transactions: 6 });
      core.repos.db.close();
      const restored = makeCore({ path: backup });
      expect(restored.repos.transactions.count()).toBe(6);
      restored.repos.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects files that are not Hormiga backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hormiga-test-'));
    try {
      const p = join(dir, 'x.hormiga-backup');
      writeFileSync(p, 'not a database');
      expect(() => inspectDatabaseFile(p)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('database integrity', () => {
  it('a failure in the middle of a transaction leaves no partial data', () => {
    const core = makeCore();
    const before = core.repos.transactions.count();
    expect(() =>
      core.repos.db.transaction(() => {
        core.repos.db.run("INSERT INTO merchants(key, display_name, created_at) VALUES ('X', 'X', 'now')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(core.repos.db.get("SELECT 1 FROM merchants WHERE key = 'X'")).toBeUndefined();
    expect(core.repos.transactions.count()).toBe(before);
  });

  it('enforces foreign keys and unique fingerprints', () => {
    const core = makeCore();
    expect(() => core.repos.db.run("INSERT INTO transactions(fingerprint, date, description_raw, description_normalized, amount_cents, type, category_id, classification_source, created_at, updated_at) VALUES ('f', '2026-01-01', 'x', 'x', -1, 'expense', 99999, 'UNKNOWN', 'n', 'n')")).toThrow();
  });
});
