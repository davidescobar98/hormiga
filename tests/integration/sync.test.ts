import { describe, expect, it } from 'vitest';
import { buildStatementPdf, sampleCardSpec } from '../helpers/synthetic-statement.mjs';
import { makeCore } from '../helpers/core';
import { AppError } from '../../src/core/errors';
import type { AttachmentMeta, EmailMessageMeta, EmailProvider, EmailSearch } from '../../src/core/email/types';

class FakeGmail implements EmailProvider {
  readonly id = 'gmail';
  searches: string[] = [];
  downloads = 0;
  failNext: AppError | null = null;
  constructor(public messages: (EmailMessageMeta & { bytes: Uint8Array[] })[]) {}
  async getAccount() {
    return 'persona.ficticia@example.com';
  }
  async search(s: EmailSearch) {
    this.searches.push(s.query);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return this.messages.map((m) => m.id);
  }
  async getMessage(id: string) {
    const m = this.messages.find((x) => x.id === id)!;
    return { id: m.id, subject: m.subject, from: m.from, date: m.date, attachments: m.attachments };
  }
  async downloadAttachment(messageId: string, a: AttachmentMeta) {
    this.downloads++;
    const m = this.messages.find((x) => x.id === messageId)!;
    return m.bytes[Number(a.key)]!;
  }
}

async function bbvaMessage(id: string, month: string, rows: { date: string; desc: string; amount: string }[], total: string) {
  const bytes = await buildStatementPdf(sampleCardSpec({ period: [`01/${month}/2026`, `28/${month}/2026`], pages: [rows], total }));
  return {
    id, subject: 'Tu extracto de tarjeta BBVA', from: 'BBVA <avisos@comunica.bbva.com>', date: `2026-${month}-02T08:00:00.000Z`,
    attachments: [{ key: '0', fileName: `Extracto_${month}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.byteLength, ref: 'x', inlineData: null }],
    bytes: [bytes],
  };
}

function connected(core: ReturnType<typeof makeCore>) {
  core.vault.data.set('gmail.client', JSON.stringify({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'secret' }));
  core.vault.data.set('gmail.tokens', JSON.stringify({ refresh_token: 'r', access_token: 'a' }));
}

describe('email sync (mocked Gmail API)', () => {
  it('reports configuration states', async () => {
    const core = makeCore();
    expect((await core.sync.status()).state).toBe('not_configured');
    core.vault.data.set('gmail.client', JSON.stringify({ clientId: 'x', clientSecret: 'y' }));
    expect((await core.sync.status()).state).toBe('disconnected');
    await expect(core.sync.syncNow()).rejects.toMatchObject({ code: 'GMAIL_NOT_CONNECTED' });
  });

  it('first sync only scans; the user selects; later syncs are incremental and idempotent', async () => {
    const aug = await bbvaMessage('m-aug-001', '08', [{ date: '02/08/2026', desc: 'MERCADONA', amount: '10,00' }], '10,00');
    const promo = { id: 'm-promo-01', subject: 'Novedades', from: 'marketing@otrodominio.com', date: '2026-08-03T00:00:00.000Z', attachments: [], bytes: [] };
    const gmail = new FakeGmail([aug, promo]);
    const core = makeCore({ provider: async () => gmail });
    connected(core);

    const first = await core.sync.syncNow('startup');
    expect(first.imported).toBe(0);
    expect(first.pendingCandidates).toBe(1);
    expect(core.repos.transactions.count()).toBe(0);

    const scan = await core.sync.scan(6);
    expect(scan.candidates.map((c) => c.messageId)).toEqual(['m-aug-001']);
    expect(scan.candidates[0]!.classification).toBe('detected');

    const sel = await core.sync.importSelected(['m-aug-001']);
    expect(sel.imported).toBe(1);
    expect(core.repos.transactions.count()).toBe(1);

    // New month arrives; old one must not be downloaded again.
    gmail.messages.push(await bbvaMessage('m-sep-001', '09', [{ date: '03/09/2026', desc: 'LIDL', amount: '20,00' }], '20,00'));
    const downloadsBefore = gmail.downloads;
    const inc = await core.sync.syncNow('manual');
    expect(inc.imported).toBe(1);
    expect(gmail.downloads - downloadsBefore).toBe(1);
    expect(core.repos.transactions.count()).toBe(2);

    const again = await core.sync.syncNow('manual');
    expect(again.imported).toBe(0);
    expect(again.message).toBe('No hay documentos nuevos.');
    expect(core.repos.transactions.count()).toBe(2);
    expect(gmail.searches.at(-1)).toContain('after:');
  });

  it('tolerates partial failures and records them', async () => {
    const good = await bbvaMessage('m-good-01', '08', [{ date: '02/08/2026', desc: 'MERCADONA', amount: '10,00' }], '10,00');
    const bad = { ...good, id: 'm-bad-001', bytes: [new TextEncoder().encode('%PDF-1.4 roto')] };
    const gmail = new FakeGmail([good, bad]);
    const core = makeCore({ provider: async () => gmail });
    connected(core);
    const s = await core.sync.importSelected(['m-good-01', 'm-bad-001']);
    expect(s.imported).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.errors[0]!.subject).toBe('Tu extracto de tarjeta BBVA');
    expect(core.repos.transactions.count()).toBe(1);
  });

  it('offline or expired authorization produce clear, recoverable states', async () => {
    const gmail = new FakeGmail([]);
    const core = makeCore({ provider: async () => gmail });
    connected(core);
    core.repos.emailImports.record({ provider: 'gmail', messageId: 'seed-0001', attachmentKey: '-', subject: null, sender: null, receivedAt: null, scoreBp: 0, status: 'skipped', errorCode: null, documentId: null });

    gmail.failNext = new AppError('GMAIL_OFFLINE', 'Sin conexión');
    const off = await core.sync.syncNow();
    expect(off.errors[0]!.code).toBe('GMAIL_OFFLINE');
    expect((await core.sync.status()).state).toBe('connected');

    gmail.failNext = new AppError('GMAIL_AUTH_EXPIRED', 'Caducado');
    await core.sync.syncNow();
    const st = await core.sync.status();
    expect(st.state).toBe('reauth_required');
    expect(st.message).toBe('Caducado');
  });

  it('disconnect removes tokens but not financial data', async () => {
    const core = makeCore();
    connected(core);
    core.data.loadDemo();
    await core.sync.disconnect();
    expect(core.vault.data.has('gmail.tokens')).toBe(false);
    expect(core.repos.transactions.count()).toBeGreaterThan(0);
  });
});
