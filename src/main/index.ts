import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Channel, EventMap, EventName } from '../shared/api';
import { CHANNELS, IPC_PREFIX } from '../shared/channels';
import type { IpcResult } from '../shared/types';
import { AppError, toErrorPayload } from '../core/errors';
import { createHandlers } from './handlers';
import { IPC_SCHEMAS } from './ipcSchemas';
import { createFileLogger } from './logger';
import { resolvePaths, Runtime } from './runtime';
import { Updater } from './updater';
import { runSelfTest } from './selfTest';
import { SafeStorageVault } from './vault';
import { tmpdir } from 'node:os';
import { APP_ORIGIN, handleAppScheme, registerAppScheme } from './appProtocol';
import { isUrlFromOrigin } from './origin';

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Optional isolated profile (E2E tests, portable use). Data never leaves the chosen folder.
if (process.env.HORMIGA_USER_DATA) app.setPath('userData', process.env.HORMIGA_USER_DATA);

app.enableSandbox();
registerAppScheme();

if (!process.argv.includes('--self-test') && !app.requestSingleInstanceLock()) {
  app.quit();
}

/** Minimal .env reader for development only (packaged builds never read .env). */
function loadDevEnv(): Record<string, string> {
  if (!isDev) return {};
  try {
    const text = readFileSync(join(app.getAppPath(), '.env'), 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')]),
    );
  } catch {
    return {};
  }
}

const env = { ...loadDevEnv(), ...process.env };
const paths = resolvePaths();
const logLevel = (['error', 'warn', 'info', 'debug'].includes(env.HORMIGA_LOG_LEVEL ?? '') ? env.HORMIGA_LOG_LEVEL : isDev ? 'debug' : 'info') as 'info';
const log = createFileLogger(paths.logFile, logLevel, isDev);

let mainWindow: BrowserWindow | null = null;

function send<E extends EventName>(event: E, payload: EventMap[E]): void {
  mainWindow?.webContents.send(`${IPC_PREFIX}event`, event, payload);
}

/** Only the Google OAuth consent screen may be opened from the core (validated here, not in the renderer). */
async function openExternalSafe(url: string): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'accounts.google.com') throw new AppError('VALIDATION', 'URL externa no permitida.');
  await shell.openExternal(u.toString());
}

const envClient = env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET } : null;

function rendererOrigin(): string {
  return DEV_URL && isDev ? new URL(DEV_URL).origin : APP_ORIGIN;
}

/** Exact origin match ("app://hormiga/"), so look-alikes such as "app://hormiga.evil/" are rejected. */
function isAppUrl(url: string): boolean {
  return isUrlFromOrigin(url, rendererOrigin());
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (e.senderFrame !== e.sender.mainFrame) return false;
  return isAppUrl(url);
}

function registerIpc(runtime: Runtime): void {
  const handlers = createHandlers(runtime, () => mainWindow, (reason) => send('data.changed', { reason }), updater!);
  for (const channel of CHANNELS) {
    ipcMain.handle(`${IPC_PREFIX}${channel}`, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) {
        log.warn('ipc.untrusted_sender', { channel });
        return { ok: false, error: { code: 'VALIDATION', message: 'Origen no autorizado.' } };
      }
      const parsed = IPC_SCHEMAS[channel as Channel].safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        log.warn('ipc.invalid_input', { channel, path: issue?.path.join('.') ?? '' });
        return { ok: false, error: { code: 'VALIDATION', message: issue?.message ? `Datos no válidos: ${issue.message}` : 'Datos no válidos.' } };
      }
      try {
        const handler = handlers[channel as Channel] as (input: unknown) => unknown;
        return { ok: true, data: await handler(parsed.data) };
      } catch (err) {
        const payload = toErrorPayload(err);
        if (payload.code === 'INTERNAL') log.error('ipc.handler_failed', { channel, err });
        else log.warn('ipc.handler_error', { channel, code: payload.code });
        return { ok: false, error: payload };
      }
    });
  }
}

const CSP = [
  "default-src 'self'",
  isDev && DEV_URL ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  isDev && DEV_URL ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function applySessionSecurity(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  handleAppScheme(join(__dirname, '../renderer'), CSP);
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  // The renderer never needs the network: block anything that is not the app itself.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith(`${APP_ORIGIN}/`) || url.startsWith('devtools://') || url.startsWith('data:') ||
      (isDev && !!DEV_URL && (url.startsWith(rendererOrigin()) || url.startsWith('ws://localhost')));
    callback({ cancel: !allowed });
  });
}

function createWindow(runtime: Runtime): void {
  const settings = runtime.core.repos.settings.getSettings();
  nativeTheme.themeSource = settings.theme;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Hormiga',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161c' : '#f5f4f0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    void startupSync(runtime);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev && DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

let updater: Updater | null = null;

async function startupSync(runtime: Runtime): Promise<void> {
  try {
    const settings = runtime.core.repos.settings.getSettings();
    if (!settings.autoSyncOnStart || !settings.onboardingCompleted) return;
    const status = await runtime.core.sync.status();
    if (status.state !== 'connected') return;
    const summary = await runtime.core.sync.syncNow('startup');
    send('sync.finished', summary);
    if (summary.imported > 0) send('data.changed', { reason: 'sync' });
  } catch (err) {
    log.warn('sync.startup_failed', { code: toErrorPayload(err).code });
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url)) ev.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (process.argv.includes('--self-test')) {
    const result = await runSelfTest(new SafeStorageVault(join(tmpdir(), 'hormiga-selftest-vault')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    log.info('selftest.finished', { ok: result.ok });
    app.exit(result.ok ? 0 : 1);
    return;
  }
  applySessionSecurity();
  let runtime: Runtime;
  try {
    runtime = new Runtime(paths, log, {
      syncProgress: (e) => send('sync.progress', e),
      dataChanged: (reason) => send('data.changed', { reason }),
    }, openExternalSafe, envClient);
  } catch (err) {
    log.error('startup.failed', { err });
    dialog.showErrorBox('Hormiga no pudo iniciarse', `${toErrorPayload(err).message}\n\nCarpeta de datos: ${paths.root}`);
    app.quit();
    return;
  }
  updater = new Updater(log, (s) => send('update.status', s), () => runtime.core.repos.settings.getSettings().autoUpdate);
  registerIpc(runtime);
  createWindow(runtime);
  updater.start();
  log.info('app.started', { version: app.getVersion(), packaged: app.isPackaged });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime);
  });
  app.on('before-quit', () => runtime.close());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
