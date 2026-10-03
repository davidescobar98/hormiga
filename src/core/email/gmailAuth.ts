import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { AppError } from '../errors';
import type { Logger } from '../services/context';
import type { SecretVault } from './types';

/** Read-only access: list/read messages and download attachments. No modify, delete or settings. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** Optional: send messages (Hormiga only ever sends your own alerts to your own address). */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Copy of the OAuth client (ID and secret) outside the encrypted vault, in your local database. For desktop apps
 * Google does not treat the client secret as confidential; keeping it means you never have to create or paste it
 * again if Windows can no longer decrypt the vault. Tokens (the real access) stay only in the vault.
 */
export interface ClientConfigStore {
  get(): OAuthClientConfig | null;
  set(config: OAuthClientConfig | null): void;
  authorizedAt(at?: string | null): string | null;
}

const SECRET_TOKENS = 'gmail.tokens';
const SECRET_CLIENT = 'gmail.client';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth 2.0 for installed apps (RFC 8252): system browser + loopback redirect on 127.0.0.1 + PKCE (S256) + state.
 * Tokens are stored only through the SecretVault (OS-encrypted); the email password is never seen by the app.
 */
export class GmailAuth {
  private client: OAuth2Client | null = null;
  private authInProgress: Promise<void> | null = null;

  constructor(
    private readonly vault: SecretVault,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly log: Logger,
    private readonly envClient: OAuthClientConfig | null = null,
    private readonly store: ClientConfigStore | null = null,
  ) {}

  async clientConfig(): Promise<OAuthClientConfig | null> {
    const stored = await this.vault.get(SECRET_CLIENT);
    if (stored) {
      try {
        const c = JSON.parse(stored) as OAuthClientConfig;
        if (c.clientId) return c;
      } catch {
        /* fall through */
      }
    }
    const kept = this.store?.get();
    if (kept?.clientId) {
      // Heal the vault copy (best effort) so both stay in sync.
      if (this.vault.isAvailable()) await this.vault.set(SECRET_CLIENT, JSON.stringify(kept)).catch(() => undefined);
      return kept;
    }
    return this.envClient?.clientId ? this.envClient : null;
  }

  async saveClientConfig(config: OAuthClientConfig): Promise<void> {
    this.requireVault();
    await this.vault.set(SECRET_CLIENT, JSON.stringify(config));
    this.store?.set(config);
    this.client = null;
  }

  async clearClientConfig(): Promise<void> {
    await this.vault.delete(SECRET_CLIENT);
    this.store?.set(null);
    this.client = null;
  }

  /** Gmail credentials saved on disk that this Windows session cannot decrypt anymore. */
  async unreadableSecrets(): Promise<boolean> {
    if (!this.vault.unreadable) return false;
    return (await this.vault.unreadable(SECRET_CLIENT)) || (await this.vault.unreadable(SECRET_TOKENS));
  }

  async hasTokens(): Promise<boolean> {
    return !!(await this.vault.get(SECRET_TOKENS));
  }

  private requireVault(): void {
    if (!this.vault.isAvailable()) {
      throw new AppError('SECURE_STORAGE_UNAVAILABLE', 'El almacenamiento seguro del sistema no está disponible; no es posible guardar credenciales de forma cifrada.');
    }
  }

  /** Whether the saved authorization includes permission to send (your own alerts to yourself). */
  async canSend(): Promise<boolean> {
    const raw = await this.vault.get(SECRET_TOKENS);
    if (!raw) return false;
    try {
      return String((JSON.parse(raw) as Credentials).scope ?? '').split(' ').includes(GMAIL_SEND_SCOPE);
    } catch {
      return false;
    }
  }

  /** Runs the interactive authorization in the system browser. */
  async authorize(opts: { send?: boolean } = {}): Promise<void> {
    this.authInProgress ??= this.runAuthorization(!!opts.send).finally(() => {
      this.authInProgress = null;
    });
    return this.authInProgress;
  }

  private async runAuthorization(send: boolean): Promise<void> {
    this.requireVault();
    const cfg = await this.clientConfig();
    if (!cfg) throw new AppError('GMAIL_NOT_CONFIGURED', 'Falta configurar el cliente OAuth de Google (ID y secreto de cliente de escritorio).');

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(24).toString('hex');
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: send ? [GMAIL_SCOPE, GMAIL_SEND_SCOPE] : [GMAIL_SCOPE],
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
      include_granted_scopes: false,
    });

    try {
      const codePromise = this.waitForCode(server, state);
      codePromise.catch(() => undefined);
      await this.openExternal(url);
      const code = await codePromise;
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
      if (!tokens.refresh_token) {
        throw new AppError('GMAIL_ERROR', 'Google no devolvió un token de actualización. Revoca el acceso de Hormiga en tu cuenta de Google y vuelve a conectar.');
      }
      if (tokens.scope && !tokens.scope.split(' ').includes(GMAIL_SCOPE)) {
        throw new AppError('GMAIL_PERMISSION', 'No se concedió el permiso de lectura de Gmail. Vuelve a conectar y marca la casilla de acceso.');
      }
      await this.vault.set(SECRET_TOKENS, JSON.stringify(tokens));
      this.store?.authorizedAt(new Date().toISOString());
      this.client = null;
      this.log.info('gmail.authorized', { send: String(tokens.scope ?? '').includes(GMAIL_SEND_SCOPE) });
    } finally {
      server.close();
    }
  }

  private waitForCode(server: Server, state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError('OAUTH_TIMEOUT', 'La autorización con Google ha caducado (5 minutos). Vuelve a intentarlo.')), AUTH_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const finish = (ok: boolean, message: string) => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
          res.end(`<!doctype html><meta charset="utf-8"><title>Hormiga</title><body style="font-family:system-ui;padding:40px;color:#1c2430"><h2>${ok ? 'Cuenta conectada' : 'No se completó la conexión'}</h2><p>${message}</p><p>Puedes cerrar esta pestaña y volver a Hormiga.</p></body>`);
        };
        clearTimeout(timer);
        if (reqUrl.searchParams.get('state') !== state) {
          finish(false, 'La respuesta no corresponde a esta solicitud.');
          reject(new AppError('GMAIL_ERROR', 'Respuesta de autorización no válida (state distinto).'));
          return;
        }
        const error = reqUrl.searchParams.get('error');
        if (error) {
          finish(false, 'Has cancelado o denegado el acceso.');
          reject(new AppError('OAUTH_CANCELLED', 'Has cancelado la autorización en Google.'));
          return;
        }
        const code = reqUrl.searchParams.get('code');
        if (!code) {
          finish(false, 'Falta el código de autorización.');
          reject(new AppError('GMAIL_ERROR', 'Google no devolvió un código de autorización.'));
          return;
        }
        finish(true, 'Hormiga puede leer tu correo para buscar extractos y, si lo has permitido, enviarte tus avisos a ti mismo. Nunca borra ni modifica nada.');
        resolve(code);
      });
    });
  }

  /** Returns an authorized client; refreshed tokens are persisted back to the vault. */
  async getClient(): Promise<OAuth2Client> {
    if (this.client) return this.client;
    const cfg = await this.clientConfig();
    if (!cfg) throw new AppError('GMAIL_NOT_CONFIGURED', 'Falta configurar el cliente OAuth de Google.');
    const raw = await this.vault.get(SECRET_TOKENS);
    if (!raw) throw new AppError('GMAIL_NOT_CONNECTED', 'No hay ninguna cuenta de Gmail conectada.');
    const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    client.setCredentials(JSON.parse(raw) as Credentials);
    client.on('tokens', (t) => {
      const merged = { ...(JSON.parse(raw) as Credentials), ...t };
      void this.vault.set(SECRET_TOKENS, JSON.stringify(merged)).catch((err) => this.log.warn('gmail.token_persist_failed', { err: String(err) }));
    });
    this.client = client;
    return client;
  }

  async disconnect(): Promise<void> {
    const raw = await this.vault.get(SECRET_TOKENS);
    if (raw) {
      try {
        const t = JSON.parse(raw) as Credentials;
        const token = t.refresh_token ?? t.access_token;
        const cfg = await this.clientConfig();
        if (token && cfg) await new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }).revokeToken(token);
      } catch (err) {
        // Revocation is best effort (offline, already revoked...). Local tokens are deleted regardless.
        this.log.warn('gmail.revoke_failed', { err: mapGoogleError(err).code });
      }
    }
    await this.vault.delete(SECRET_TOKENS);
    this.client = null;
  }

  /**
   * Sends an email from your account to your own address. Only used for your own alerts and summaries; needs the
   * optional send permission.
   */
  async sendToSelf(to: string, subject: string, text: string): Promise<void> {
    if (!(await this.canSend())) throw new AppError('GMAIL_PERMISSION', 'Falta el permiso para enviar correos: vuelve a conectar Gmail marcando «Enviarme mis avisos por correo».');
    const client = await this.getClient();
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, (line) => `${line}\r\n`);
    const mime = [`To: ${to}`, `From: ${to}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
    try {
      await client.request({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        method: 'POST',
        data: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
        timeout: 30000,
      });
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  /** Called when Google reports the grant is no longer valid. */
  resetClient(): void {
    this.client = null;
  }
}

/** Maps gaxios/network errors to user-facing, actionable AppErrors. */
export function mapGoogleError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: string | number; message?: string; status?: number; response?: { status?: number; data?: unknown } };
  const status = e?.response?.status ?? e?.status;
  const data = JSON.stringify(e?.response?.data ?? '');
  const message = String(e?.message ?? '');
  const netCodes = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'];
  if ((typeof e?.code === 'string' && netCodes.includes(e.code)) || /fetch failed|network|getaddrinfo|socket hang up/i.test(message)) {
    return new AppError('GMAIL_OFFLINE', 'No hay conexión con Gmail. Comprueba tu conexión a internet; lo ya importado sigue disponible.', err);
  }
  if (/invalid_grant/i.test(data) || /invalid_grant/i.test(message)) {
    return new AppError('GMAIL_AUTH_EXPIRED', 'Google ha retirado la autorización de Gmail. Pulsa «Volver a conectar»: no hace falta crear ni pegar nada nuevo.', err);
  }
  if (status === 401) return new AppError('GMAIL_AUTH_EXPIRED', 'La sesión de Gmail ha caducado. Vuelve a conectar la cuenta.', err);
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(data)) {
    return new AppError('GMAIL_RATE_LIMITED', 'Gmail ha limitado temporalmente las peticiones. Vuelve a intentarlo en unos minutos.', err);
  }
  if (status === 403) {
    return new AppError('GMAIL_PERMISSION', 'Gmail ha denegado el acceso (permiso revocado o API no habilitada en tu proyecto de Google Cloud).', err);
  }
  return new AppError('GMAIL_ERROR', `Error al comunicarse con Gmail${status ? ` (HTTP ${status})` : ''}.`, err);
}
