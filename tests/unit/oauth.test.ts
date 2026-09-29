import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { GmailAuth, GMAIL_SCOPE } from '../../src/core/email/gmailAuth';
import { nullLogger } from '../../src/core/services/context';
import { MemoryVault } from '../helpers/core';

const CLIENT = { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret' };

afterEach(() => vi.restoreAllMocks());

/** Simulates the system browser: Google redirects back to the loopback URL with the given params. */
function browser(params: (authUrl: URL) => Record<string, string>) {
  const seen: URL[] = [];
  const open = async (url: string) => {
    const u = new URL(url);
    seen.push(u);
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    for (const [k, v] of Object.entries(params(u))) redirect.searchParams.set(k, v);
    // Fire-and-forget like a real browser; the app is awaiting the callback.
    setTimeout(() => void fetch(redirect).catch(() => undefined), 10);
  };
  return { open, seen };
}

describe('GmailAuth (OAuth 2.0 installed-app flow)', () => {
  it('uses loopback + PKCE S256 + state + read-only scope and stores tokens only in the vault', async () => {
    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { access_token: 'ya29.test', refresh_token: '1//refresh', scope: GMAIL_SCOPE, expiry_date: Date.now() + 3600_000 },
      res: null,
    } as never);
    const vault = new MemoryVault();
    const b = browser((u) => ({ code: 'auth-code', state: u.searchParams.get('state')! }));
    const auth = new GmailAuth(vault, b.open, nullLogger, CLIENT);

    await auth.authorize();

    const u = b.seen[0]!;
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[\w-]{43,}$/);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(u.searchParams.get('state')).toMatch(/^[a-f0-9]{48}$/);
    const call = getToken.mock.calls[0]![0] as unknown as { code: string; codeVerifier: string };
    expect(call.code).toBe('auth-code');
    expect(call.codeVerifier).toMatch(/^[\w.~-]{43,128}$/);
    expect(JSON.parse(vault.data.get('gmail.tokens')!).refresh_token).toBe('1//refresh');
    expect(await auth.hasTokens()).toBe(true);
  });

  it('rejects a callback with a different state (CSRF protection)', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: { refresh_token: 'x' }, res: null } as never);
    const vault = new MemoryVault();
    const b = browser(() => ({ code: 'auth-code', state: 'attacker-state' }));
    await expect(new GmailAuth(vault, b.open, nullLogger, CLIENT).authorize()).rejects.toMatchObject({ code: 'GMAIL_ERROR' });
    expect(vault.data.has('gmail.tokens')).toBe(false);
  });

  it('reports a cancelled consent clearly', async () => {
    const b = browser((u) => ({ error: 'access_denied', state: u.searchParams.get('state')! }));
    await expect(new GmailAuth(new MemoryVault(), b.open, nullLogger, CLIENT).authorize()).rejects.toMatchObject({ code: 'OAUTH_CANCELLED' });
  });

  it('requires a configured client and refuses to store secrets without OS secure storage', async () => {
    await expect(new GmailAuth(new MemoryVault(), async () => {}, nullLogger, null).authorize()).rejects.toMatchObject({ code: 'GMAIL_NOT_CONFIGURED' });
    const noVault = Object.assign(new MemoryVault(), { isAvailable: () => false });
    await expect(new GmailAuth(noVault, async () => {}, nullLogger, CLIENT).saveClientConfig(CLIENT)).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
  });

  it('disconnect revokes (best effort) and deletes local tokens even offline', async () => {
    vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const vault = new MemoryVault();
    vault.data.set('gmail.tokens', JSON.stringify({ refresh_token: 'r' }));
    await new GmailAuth(vault, async () => {}, nullLogger, CLIENT).disconnect();
    expect(vault.data.has('gmail.tokens')).toBe(false);
  });
});
