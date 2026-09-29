import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildStatementPdf, sampleCardSpec } from '../helpers/synthetic-statement.mjs';
import type { ExtractedDocument } from '../../src/core/parsing/types';
import type { AttachmentMeta, EmailMessageMeta, EmailProvider } from '../../src/core/email/types';

// pdf-lib cannot encrypt PDFs, so encryption is simulated at the extraction boundary: files whose first bytes
// say "LOCKED" require the (fictitious) password below; everything else is parsed for real.
const PASSWORD = '00000000T';
const docs = new Map<string, ExtractedDocument>();

vi.mock('../../src/core/parsing/registry', async (orig) => {
  const real = await orig<typeof import('../../src/core/parsing/registry')>();
  const { AppError } = await import('../../src/core/errors');
  return {
    ...real,
    extractDocument: async (bytes: Uint8Array, fileName: string, password?: string) => {
      const head = Buffer.from(bytes.subarray(0, 6)).toString();
      if (head !== 'LOCKED') return real.extractDocument(bytes, fileName, password);
      if (password === undefined) throw new AppError('PDF_PASSWORD_REQUIRED', 'protegido');
      if (password !== PASSWORD) throw new AppError('PDF_PASSWORD_INCORRECT', 'incorrecta');
      return docs.get(Buffer.from(bytes).toString())!;
    },
  };
});

const { makeCore } = await import('../helpers/core');
const { extractPdfText } = await import('../../src/core/parsing/pdfText');

async function lockedFile(id: string, month: string): Promise<Uint8Array> {
  const pdf = await buildStatementPdf(sampleCardSpec({
    period: [`01/${month}/2026`, `28/${month}/2026`],
    pages: [[{ date: `03/${month}/2026`, desc: 'MERCADONA', amount: '10,00' }]],
    total: '10,00',
  }));
  const key = `LOCKED-${id}`;
  docs.set(key, await extractPdfText(pdf, `${id}.pdf`));
  return new TextEncoder().encode(key);
}

beforeAll(() => {
  docs.clear();
});

describe('password-protected PDFs', () => {
  it('asks once, and a remembered password (memory only) opens the next documents automatically', async () => {
    const core = makeCore();
    const first = await core.importer.importDocument({ bytes: await lockedFile('a', '07'), fileName: 'a.pdf', source: 'manual' });
    expect(first.status).toBe('password_required');

    const wrong = await core.importer.importWithPassword(first.pendingToken!, '11111111H', true);
    expect(wrong.status).toBe('password_required');
    expect(core.importer.hasRememberedPasswords()).toBe(false);

    const ok = await core.importer.importWithPassword(first.pendingToken!, PASSWORD, true);
    expect(ok).toMatchObject({ status: 'imported', inserted: 1 });
    expect(core.importer.hasRememberedPasswords()).toBe(true);

    const second = await core.importer.importDocument({ bytes: await lockedFile('b', '08'), fileName: 'b.pdf', source: 'manual' });
    expect(second).toMatchObject({ status: 'imported', inserted: 1 });

    core.importer.forgetPasswords();
    const third = await core.importer.importDocument({ bytes: await lockedFile('c', '09'), fileName: 'c.pdf', source: 'manual' });
    expect(third.status).toBe('password_required');
  });

  it('the password is never written to the database', async () => {
    const core = makeCore();
    const r = await core.importer.importDocument({ bytes: await lockedFile('d', '07'), fileName: 'd.pdf', source: 'manual' });
    await core.importer.importWithPassword(r.pendingToken!, PASSWORD, true);
    const dump = JSON.stringify(core.repos.db.all("SELECT * FROM settings")) + JSON.stringify(core.repos.db.all('SELECT * FROM documents'));
    expect(dump).not.toContain(PASSWORD);
    expect([...core.vault.data.values()].join()).not.toContain(PASSWORD);
  });

  it('unlocks every pending protected email with a single password', async () => {
    const files = { m1: await lockedFile('m1', '07'), m2: await lockedFile('m2', '08') };
    const meta = (id: string): EmailMessageMeta => ({
      id, subject: `Extracto ${id}`, from: 'BBVA <avisos@comunica.bbva.com>', date: '2026-08-02T08:00:00.000Z',
      attachments: [{ key: '0', fileName: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, ref: 'x', inlineData: null }],
    });
    const provider: EmailProvider = {
      id: 'gmail',
      getAccount: async () => 'x@example.com',
      search: async () => ['msg-000001', 'msg-000002'],
      getMessage: async (id) => meta(id),
      downloadAttachment: async (id: string, _a: AttachmentMeta) => (id === 'msg-000001' ? files.m1 : files.m2),
    };
    const core = makeCore({ provider: async () => provider });
    core.vault.data.set('gmail.client', JSON.stringify({ clientId: 'x.apps.googleusercontent.com', clientSecret: 's' }));
    core.vault.data.set('gmail.tokens', JSON.stringify({ refresh_token: 'r' }));

    const s = await core.sync.importSelected(['msg-000001', 'msg-000002']);
    expect(s.passwordRequired).toBe(2);
    expect(core.sync.pendingPasswords()).toHaveLength(2);

    const bad = await core.sync.unlockPending('99999999R', true);
    expect(bad.unlocked).toBe(0);
    expect(bad.message).toContain('no es correcta');

    const good = await core.sync.unlockPending(PASSWORD, true);
    expect(good).toMatchObject({ unlocked: 2, remaining: 0, newTransactions: 2 });
    expect(core.sync.pendingPasswords()).toHaveLength(0);
    expect(core.importer.hasRememberedPasswords()).toBe(true);
  });
});
