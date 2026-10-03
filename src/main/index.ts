import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, powerMonitor, session, shell, type IpcMainInvokeEvent } from 'electron';
import { AppLock } from './lock';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Channel, EventMap, EventName } from '../shared/api';
import { CHANNELS, IPC_PREFIX, LOCK_CHANNELS } from '../shared/channels';
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
import { Desktop } from './desktop';
import { ProfileStore } from './profiles';

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
// Several people can use Hormiga on the same computer: each profile has its own data folder.
const profiles = new ProfileStore(app.getPath('userData'));
const profileChosen = { value: process.argv.includes('--profile-chosen') };
const paths = resolvePaths(profiles.dirOf(profiles.active.id));

/** Switching profile restarts Hormiga on the other profile's data: nothing stays in memory from the previous one. */
function switchProfile(id: string): void {
  if (id === profiles.active.id) {
    profileChosen.value = true;
    return;
  }
  profiles.setActive(id);
  desktop.quitting = true;
  app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--profile-chosen' && a !== '--hidden'), '--profile-chosen'] });
  app.exit(0);
}
const logLevel = (['error', 'warn', 'info', 'debug'].includes(env.HORMIGA_LOG_LEVEL ?? '') ? env.HORMIGA_LOG_LEVEL : isDev ? 'debug' : 'info') as 'info';
const log = createFileLogger(paths.logFile, logLevel, isDev);
// Never show Electron's "A JavaScript error occurred in the main process" dialog: log it and keep going.
let shuttingDown = false;
process.on('uncaughtException', (err) => log.error('main.uncaught', { err }));
process.on('unhandledRejection', (err) => log.error('main.unhandled_rejection', { err }));
/** Background timers do nothing once Hormiga is closing (the database is already closed). */
const whileRunning = (fn: () => unknown) => () => {
  if (shuttingDown) return;
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err: unknown) => log.warn('timer.failed', { code: toErrorPayload(err).code }));
  } catch (err) {
    log.warn('timer.failed', { code: toErrorPayload(err).code });
  }
};

let mainWindow: BrowserWindow | null = null;

let lock: AppLock | null = null;
let currentRuntime: Runtime | null = null;

function showWindow(): void {
  if (!mainWindow && currentRuntime) createWindow(currentRuntime);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const desktop = new Desktop({
  show: showWindow,
  syncNow: () => {
    if (currentRuntime) void scheduledSync(currentRuntime, true);
  },
  quit: () => {
    desktop.quitting = true;
    app.quit();
  },
});

/** Red dot on the taskbar and tray tooltip with the unread alerts. */
function refreshUnread(runtime: Runtime): void {
  try {
    const unread = runtime.core.budgets.alerts(50).filter((a) => !a.read).length;
    desktop.setUnread(mainWindow, unread);
  } catch {
    // Not critical.
  }
}

function send<E extends EventName>(event: E, payload: EventMap[E]): void {
  // While locked, only lock and update events reach the interface (no data, no email subjects).
  if (lock?.isLocked() && event !== 'lock.changed' && event !== 'update.status') return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(`${IPC_PREFIX}event`, event, payload);
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
  const handlers = createHandlers(runtime, () => mainWindow, (reason) => {
    send('data.changed', { reason });
    if (reason === 'alerts.read') refreshUnread(runtime);
  }, updater!, lock!, () => void checkAlerts(runtime), (d) => desktop.applyLoginItem(d.openAtLogin), { store: profiles, chosen: () => profileChosen.value, markChosen: () => { profileChosen.value = true; }, switchTo: switchProfile });
  for (const channel of CHANNELS) {
    ipcMain.handle(`${IPC_PREFIX}${channel}`, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) {
        log.warn('ipc.untrusted_sender', { channel });
        return { ok: false, error: { code: 'VALIDATION', message: 'Origen no autorizado.' } };
      }
      if (lock?.isLocked() && !LOCK_CHANNELS.includes(channel)) {
        return { ok: false, error: { code: 'LOCKED', message: 'Hormiga está bloqueada.' } };
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

  const hidden = desktop.startedHidden && !startupDone;
  mainWindow.once('ready-to-show', () => {
    if (!hidden) mainWindow?.show();
    if (!startupDone) {
      startupDone = true;
      void startupSync(runtime);
    }
    refreshUnread(runtime);
  });
  mainWindow.on('close', (e) => {
    if (mainWindow && desktop.hideInsteadOfClose(mainWindow, runtime.core.repos.settings.getSettings().desktop.trayOnClose)) e.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev && DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

let updater: Updater | null = null;
let startupDone = false;

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
  await checkAlerts(runtime);
}

/** While the app is open, looks for new statements every N hours (setting), then refreshes alerts. */
async function scheduledSync(runtime: Runtime, force = false): Promise<void> {
  const settings = runtime.core.repos.settings.getSettings();
  if (!settings.onboardingCompleted || (!force && settings.syncIntervalHours <= 0)) return;
  const last = runtime.core.repos.settings.getLastSync()?.finishedAt;
  if (!force && last && Date.now() - Date.parse(last) < settings.syncIntervalHours * 3600000) return;
  try {
    const status = await runtime.core.sync.status();
    if (status.state !== 'connected') return;
    const summary = await runtime.core.sync.syncNow('scheduled');
    send('sync.finished', summary);
    if (summary.imported > 0) send('data.changed', { reason: 'sync' });
  } catch (err) {
    log.warn('sync.scheduled_failed', { code: toErrorPayload(err).code });
  }
  await checkAlerts(runtime);
}

/** While the app is open, refreshes stock prices every 2 hours (only symbols leave the computer) and checks signals. */
async function scheduledMarket(runtime: Runtime): Promise<void> {
  const settings = runtime.core.repos.settings.getSettings();
  if (!settings.onboardingCompleted || !settings.marketDataEnabled) return;
  const last = runtime.core.repos.settings.getRaw<string>('stocks.lastRefresh');
  if (last && Date.now() - Date.parse(last) < 2 * 3600000) return;
  const tracked = runtime.core.repos.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM stock_watchlist) + (SELECT COUNT(*) FROM stock_trades) AS n');
  if (!tracked || Number(tracked.n) === 0) return;
  try {
    await runtime.core.stocks.refresh(false);
    send('data.changed', { reason: 'stocks' });
  } catch (err) {
    log.warn('stocks.scheduled_failed', { code: toErrorPayload(err).code });
  }
  await checkAlerts(runtime);
}

/** Monday summary of the week: Windows notification and, if enabled, email to yourself. */
async function weeklySummary(runtime: Runtime): Promise<void> {
  try {
    const notify = runtime.core.notify;
    if (!notify.weeklyDue()) return;
    const summary = notify.weeklySummary();
    notify.markWeeklySent();
    if (!summary) return;
    const settings = runtime.core.repos.settings.getSettings();
    if (settings.notifications.enabled && Notification.isSupported()) {
      const locked = lock?.isLocked() ?? false;
      const n = new Notification({ title: summary.title, body: locked ? 'Tu resumen semanal está listo.' : summary.short });
      n.on('click', () => {
        showWindow();
        send('app.navigate', { page: 'forecast', section: null });
      });
      n.show();
    }
    await notify.emailWeekly(summary);
  } catch (err) {
    log.warn('weekly.failed', { code: toErrorPayload(err).code });
  }
}

/** Stores new alerts (always visible in the app) and, if enabled, shows them as Windows notifications. */
async function checkAlerts(runtime: Runtime): Promise<void> {
  try {
    const settings = runtime.core.repos.settings.getSettings();
    if (!settings.onboardingCompleted) return;
    const fresh = runtime.core.budgets.refreshAlerts();
    refreshUnread(runtime);
    if (!fresh.length) return;
    send('data.changed', { reason: 'alerts' });
    // Important ones also by email to yourself (optional, needs the Gmail send permission).
    void runtime.core.notify.emailAlerts(fresh);
    if (!settings.notifications.enabled || !Notification.isSupported()) return;
    const locked = lock?.isLocked() ?? false;
    const shown = fresh.slice(0, 3);
    for (const a of shown) {
      // When locked, notifications say nothing about your finances.
      const n = new Notification({ title: locked ? 'Hormiga' : a.title, body: locked ? 'Tienes avisos nuevos.' : a.body, silent: false });
      n.on('click', () => {
        showWindow();
        send('app.navigate', { page: a.page, section: a.section });
      });
      n.show();
    }
    if (fresh.length > shown.length && !locked) {
      new Notification({ title: 'Hormiga', body: `Y ${fresh.length - shown.length} avisos más en la aplicación.` }).show();
    }
  } catch (err) {
    log.warn('alerts.failed', { code: toErrorPayload(err).code });
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url)) ev.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('second-instance', () => showWindow());

app.on('before-quit', () => {
  desktop.quitting = true;
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
  lock = new AppLock(runtime.vault, () => runtime.core.repos.settings.getSettings().lock, log, (s) => send('lock.changed', s));
  await lock.init();
  currentRuntime = runtime;
  registerIpc(runtime);
  createWindow(runtime);
  desktop.applyLoginItem(runtime.core.repos.settings.getSettings().desktop.openAtLogin);
  desktop.ensureTray(0);
  updater.start();
  // Auto-lock: when Windows locks, and after a period without using the computer.
  powerMonitor.on('lock-screen', () => lock?.lock());
  setInterval(whileRunning(() => {
    const minutes = runtime.core.repos.settings.getSettings().lock.autoLockMinutes;
    if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lock?.lock();
  }), 30000);
  setInterval(whileRunning(() => scheduledSync(runtime)), 10 * 60000);
  setInterval(whileRunning(() => checkAlerts(runtime)), 60 * 60000);
  setInterval(whileRunning(() => weeklySummary(runtime)), 30 * 60000);
  setTimeout(whileRunning(() => weeklySummary(runtime)), 2 * 60000);
  setTimeout(whileRunning(() => scheduledMarket(runtime)), 60000);
  setInterval(whileRunning(() => scheduledMarket(runtime)), 20 * 60000);
  log.info('app.started', { version: app.getVersion(), packaged: app.isPackaged });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime);
  });
  app.on('before-quit', () => {
    shuttingDown = true;
    runtime.close();
  });
});

app.on('window-all-closed', () => {
  // With the tray icon Hormiga keeps running in the background.
  if (desktop.enabled && !desktop.quitting && currentRuntime?.core.repos.settings.getSettings().desktop.trayOnClose) return;
  if (process.platform !== 'darwin') app.quit();
});
