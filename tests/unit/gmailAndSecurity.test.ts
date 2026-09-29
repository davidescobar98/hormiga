import { describe, expect, it } from 'vitest';
import { GmailEmailProvider, type GmailHttp } from '../../src/core/email/gmailProvider';
import { mapGoogleError, GMAIL_SCOPE } from '../../src/core/email/gmailAuth';
import { sanitize, scrub } from '../../src/main/logger';
import { IPC_SCHEMAS } from '../../src/main/ipcSchemas';
import { CHANNELS } from '../../src/shared/channels';
import { isUrlFromOrigin } from '../../src/main/origin';

function fakeHttp(routes: Record<string, unknown>, calls: string[] = []): GmailHttp {
  return {
    async get<T>(path: string, params?: Record<string, string | number | undefined>) {
      calls.push(`${path}?${JSON.stringify(params ?? {})}`);
      const key = Object.keys(routes).find((k) => path === k || (k.endsWith('*') && path.startsWith(k.slice(0, -1))));
      if (!key) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      const v = routes[key];
      if (v instanceof Error) throw v;
      return (typeof v === 'function' ? (v as (p: unknown) => unknown)(params) : v) as T;
    },
  };
}

describe('GmailEmailProvider (mocked API)', () => {
  it('paginates search results', async () => {
    const calls: string[] = [];
    const http = fakeHttp({
      messages: (p: { pageToken?: string }) => (p?.pageToken ? { messages: [{ id: 'c' }] } : { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 't2' }),
    }, calls);
    const ids = await new GmailEmailProvider(http).search({ query: 'q', maxResults: 10 });
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
  });

  it('extracts headers and nested PDF attachments', async () => {
    const http = fakeHttp({
      'messages/abc': {
        id: 'abc',
        internalDate: String(Date.UTC(2026, 7, 3)),
        payload: {
          headers: [{ name: 'Subject', value: 'Extracto' }, { name: 'From', value: 'BBVA <x@bbva.com>' }],
          parts: [
            { partId: '0', mimeType: 'text/html', filename: '', body: { size: 10 } },
            { partId: '1', mimeType: 'multipart/mixed', filename: '', parts: [{ partId: '1.1', mimeType: 'application/pdf', filename: 'Extracto.pdf', body: { attachmentId: 'ATT', size: 2048 } }] },
          ],
        },
      },
      'messages/abc/attachments/ATT': { data: Buffer.from('%PDF-1.4 test').toString('base64url'), size: 13 },
    });
    const p = new GmailEmailProvider(http);
    const m = await p.getMessage('abc');
    expect(m.subject).toBe('Extracto');
    expect(m.date).toBe('2026-08-03T00:00:00.000Z');
    expect(m.attachments).toEqual([expect.objectContaining({ key: '1.1:Extracto.pdf', fileName: 'Extracto.pdf', mimeType: 'application/pdf', ref: 'ATT' })]);
    const bytes = await p.downloadAttachment('abc', m.attachments[0]!);
    expect(Buffer.from(bytes).toString()).toBe('%PDF-1.4 test');
  });

  it('maps API failures to actionable errors', async () => {
    const offline = Object.assign(new Error('getaddrinfo ENOTFOUND gmail.googleapis.com'), { code: 'ENOTFOUND' });
    await expect(new GmailEmailProvider(fakeHttp({ profile: offline })).getAccount()).rejects.toMatchObject({ code: 'GMAIL_OFFLINE' });
    expect(mapGoogleError({ response: { status: 400, data: { error: 'invalid_grant' } } }).code).toBe('GMAIL_AUTH_EXPIRED');
    expect(mapGoogleError({ response: { status: 401 } }).code).toBe('GMAIL_AUTH_EXPIRED');
    expect(mapGoogleError({ response: { status: 403, data: { error: { message: 'insufficientPermissions' } } } }).code).toBe('GMAIL_PERMISSION');
    expect(mapGoogleError({ response: { status: 429 } }).code).toBe('GMAIL_RATE_LIMITED');
  });

  it('requests only the read-only scope', () => {
    expect(GMAIL_SCOPE).toBe('https://www.googleapis.com/auth/gmail.readonly');
  });
});

describe('secure logging', () => {
  it('masks IBANs, card numbers, emails and tokens', () => {
    const s = scrub('IBAN ES9121000418450200051332 tarjeta 4111 1111 1111 1111 de ana@example.com token ya29.a0AfH6SMB');
    expect(s).not.toMatch(/ES9121|4111|ana@example|ya29\.a0/);
  });
  it('redacts sensitive keys', () => {
    const out = sanitize({ amountCents: 1234, description: 'MERCADONA', refresh_token: 'x', documentId: 3, code: 'PDF_INVALID' });
    expect(out).toEqual({ amountCents: '[REDACTED]', description: '[REDACTED]', refresh_token: '[REDACTED]', documentId: 3, code: 'PDF_INVALID' });
  });
});

describe('renderer origin check', () => {
  it('accepts only the exact app origin', () => {
    expect(isUrlFromOrigin('app://hormiga/index.html', 'app://hormiga')).toBe(true);
    expect(isUrlFromOrigin('app://hormiga.evil/index.html', 'app://hormiga')).toBe(false);
    expect(isUrlFromOrigin('file:///C:/x/renderer/index.html', 'app://hormiga')).toBe(false);
    expect(isUrlFromOrigin('http://localhost:51730/', 'http://localhost:5173')).toBe(false);
  });
});

describe('IPC input validation', () => {
  it('has a schema for every channel', () => {
    for (const c of CHANNELS) expect(IPC_SCHEMAS[c]).toBeDefined();
  });
  it('rejects unknown keys and bad values', () => {
    expect(IPC_SCHEMAS['transactions.update'].safeParse({ id: 1, categoryId: 2 }).success).toBe(true);
    expect(IPC_SCHEMAS['transactions.update'].safeParse({ id: 1, sql: 'DROP TABLE' }).success).toBe(false);
    expect(IPC_SCHEMAS['transactions.list'].safeParse({ sort: 'amount; DROP TABLE transactions' }).success).toBe(false);
    expect(IPC_SCHEMAS['income.save'].safeParse({ kind: 'salary', label: 'x', amountCents: 10.5, startMonth: '2026-01', endMonth: null }).success).toBe(false);
    expect(IPC_SCHEMAS['email.saveClientConfig'].safeParse({ clientId: 'evil', clientSecret: 'xxxxxxxxxx' }).success).toBe(false);
    expect(IPC_SCHEMAS['settings.update'].safeParse({ detection: { senderDomains: ['bbva.com'] } }).success).toBe(true);
    expect(IPC_SCHEMAS['settings.update'].safeParse({ detection: { minScore: 5 } }).success).toBe(false);
  });
});
