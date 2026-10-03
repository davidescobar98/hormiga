import type { ProfileStore } from './profiles';
import { app, dialog, nativeTheme, shell, type BrowserWindow } from 'electron';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ApiMap, Channel, HelpTopic } from '../shared/api';
import { todayIso } from '../shared/dates';
import type { FileActionResult, ImportOutcome } from '../shared/types';
import { APP_ID, inspectDatabaseFile } from '../core/db/database';
import { LATEST_SCHEMA_VERSION } from '../core/db/migrations';
import { AppError } from '../core/errors';
import { MAX_DOCUMENT_BYTES } from '../core/parsing/pdfText';
import { SUPPORTED_EXTENSIONS } from '../core/parsing/registry';
import type { Runtime } from './runtime';
import type { Updater } from './updater';
import type { AppLock } from './lock';

type Handler<C extends Channel> = (input: ApiMap[C]['input']) => Promise<ApiMap[C]['output']> | ApiMap[C]['output'];
export type Handlers = { [C in Channel]: Handler<C> };

const HELP_URLS: Record<HelpTopic, string> = {
  'google-cloud-console': 'https://console.cloud.google.com/apis/credentials',
  'gmail-api': 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  'oauth-consent': 'https://console.cloud.google.com/auth/audience',
};

export const RESTORE_CONFIRMATION = 'RESTAURAR';
export const DELETE_CONFIRMATION = 'ELIMINAR';
export const CLEAR_CONFIRMATION = 'BORRAR';

const cancelled = (message = 'Operación cancelada.'): FileActionResult => ({ ok: false, cancelled: true, message, path: null });

export function createHandlers(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  emitChanged: (reason: string) => void,
  updater: Updater,
  lock: AppLock,
  onAlertsChanged: () => void = () => {},
  onDesktopChanged: (d: { openAtLogin: boolean; trayOnClose: boolean }) => void = () => {},
  profiles: { store: ProfileStore; chosen: () => boolean; markChosen?: () => void; switchTo: (id: string) => void } | null = null,
): Handlers {
  const pstore = () => {
    if (!profiles) throw new AppError('VALIDATION', 'Perfiles no disponibles.');
    return profiles.store;
  };
  const perr = <T,>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('VALIDATION', (err as Error).message);
    }
  };
  const c = () => rt.core;
  const win = () => getWindow() ?? undefined;
  const refreshAfterDataChange = () => {
    c().recurring.detect();
    emitChanged('data');
  };

  const confirmNative = async (message: string, detail: string, confirmLabel: string): Promise<boolean> => {
    const w = win();
    const opts = { type: 'warning' as const, buttons: ['Cancelar', confirmLabel], defaultId: 0, cancelId: 0, noLink: true, title: 'Hormiga', message, detail };
    const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return r.response === 1;
  };

  return {
    'app.info': () => ({ version: app.getVersion(), isDev: !app.isPackaged, platform: process.platform, dataDir: rt.paths.root, logFile: rt.paths.logFile }),
    'app.updateStatus': () => updater.getStatus(),
    'app.checkUpdates': () => updater.check(),
    'app.installUpdate': () => ({ ok: updater.install() }),
    'app.completeOnboarding': () => c().repos.settings.updateSettings({ onboardingCompleted: true }),

    'profiles.list': () => {
      const s = pstore().list(profiles!.chosen());
      // Whoever is already inside Hormiga in this session has chosen: adding a profile later must not ask again until the next start.
      if (!s.mustChoose) profiles!.markChosen?.();
      return s;
    },
    'profiles.create': (input) => perr(() => {
      pstore().create(input);
      return pstore().list(profiles!.chosen());
    }),
    'profiles.update': ({ id, ...patch }) => perr(() => {
      pstore().update(id, patch);
      return pstore().list(profiles!.chosen());
    }),
    'profiles.switch': ({ id }) => perr(() => {
      profiles!.switchTo(id);
      return pstore().list(profiles!.chosen());
    }),
    'profiles.setAskOnStart': ({ value }) => perr(() => {
      pstore().setAskOnStart(value);
      return pstore().list(profiles!.chosen());
    }),
    'profiles.delete': async ({ id }) => {
      const p = pstore().list(true).profiles.find((x) => x.id === id);
      if (!p) throw new AppError('NOT_FOUND', 'Perfil no encontrado.');
      const ok = await confirmNative(`Se borrará el perfil «${p.name}» con todos sus datos.`, 'Movimientos, documentos, metas, patrimonio, conexión con Gmail y copias de seguridad de ese perfil. Los demás perfiles no se tocan. No se puede deshacer.', 'Borrar perfil');
      if (!ok) return pstore().list(profiles!.chosen());
      perr(() => pstore().remove(id));
      return pstore().list(profiles!.chosen());
    },
    'settings.get': () => c().repos.settings.getSettings(),
    'settings.update': (patch) => {
      if (patch.theme) nativeTheme.themeSource = patch.theme;
      const next = c().repos.settings.updateSettings(patch);
      if (patch.autoUpdate) updater.start();
      if (patch.desktop) onDesktopChanged(next.desktop);
      if (patch.profile) {
        if (c().accounts.refreshTransfers() > 0) refreshAfterDataChange();
      }
      return next;
    },

    'categories.list': (input) => c().analytics.categoriesWithStats(input ?? undefined),
    'categories.create': (input) => c().repos.categories.create(input),
    'categories.update': (input) => {
      const r = c().repos.categories.update(input);
      emitChanged('categories');
      return r;
    },
    'categories.delete': ({ id }) => {
      const r = c().repos.categories.delete(id);
      c().categorization.invalidateRules();
      emitChanged('categories');
      return r;
    },

    'transactions.list': (q) => c().repos.transactions.list(q),
    'transactions.get': ({ id }) => c().repos.transactions.get(id),
    'transactions.update': (input) => {
      const r = c().categorization.updateTransaction(input);
      if (input.type !== undefined || input.isExcluded !== undefined || input.merchantName !== undefined) c().recurring.detect();
      return r;
    },

    'rules.list': () => c().repos.rules.list(),
    'rules.create': (input) => {
      const r = c().categorization.createRule(input);
      c().recurring.detect();
      return r;
    },
    'rules.delete': ({ id }) => ({ deleted: c().categorization.deleteRule(id) }),

    'merchants.rename': ({ merchantId, name }) => c().categorization.renameMerchant(merchantId, name),

    'recurring.list': () => c().recurring.list(),
    'recurring.setStatus': ({ id, status }) => c().recurring.setStatus(id, status),
    'recurring.redetect': () => c().recurring.detect(),

    'income.list': () => c().repos.income.list(),
    'income.save': (input) => {
      const r = c().repos.income.save(input);
      emitChanged('income');
      return r;
    },
    'income.delete': ({ id }) => {
      const r = { deleted: c().repos.income.delete(id) };
      emitChanged('income');
      return r;
    },

    'goal.get': () => c().repos.goals.latest(),
    'goal.set': (goal) => {
      const r = c().repos.goals.set(goal, todayIso().slice(0, 7));
      emitChanged('goal');
      return r;
    },

    'analytics.dashboard': (input) => c().analytics.dashboard(input?.month),
    'analytics.report': (range) => c().analytics.report(range),
    'analytics.savings': (input) => c().analytics.savings(input?.month),

    'recommendations.list': () => c().analytics.recommendations(),
    'recommendations.dismiss': ({ key }) => ({ dismissed: c().repos.recommendations.dismiss(key) }),

    'import.pickAndImport': async () => {
      const w = win();
      const opts = {
        title: 'Importar extractos',
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: [
          { name: 'Extractos y movimientos (PDF, Excel, CSV, Norma 43)', extensions: SUPPORTED_EXTENSIONS },
          { name: 'Todos los archivos', extensions: ['*'] },
        ],
      };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || r.filePaths.length === 0) return [];
      const outcomes: ImportOutcome[] = [];
      for (const path of r.filePaths.slice(0, 50)) {
        const fileName = basename(path);
        const info = await stat(path);
        if (info.size > MAX_DOCUMENT_BYTES) {
          outcomes.push({ status: 'failed', fileName, message: `«${fileName}» supera el tamaño máximo admitido (25 MB).`, documentId: null, inserted: 0, duplicatesSkipped: 0, reviewCount: 0, pendingToken: null, errorCode: 'FILE_TOO_LARGE' });
          continue;
        }
        outcomes.push(await c().importer.importDocument({ bytes: new Uint8Array(await readFile(path)), fileName, source: 'manual' }));
      }
      return outcomes;
    },
    'import.withPassword': ({ token, password, remember }) => c().importer.importWithPassword(token, password, remember ?? false),
    'import.forgetPasswords': () => {
      c().importer.forgetPasswords();
      return { forgotten: true };
    },
    'import.documents': () => c().repos.documents.list(),
    'import.review': ({ documentId }) => c().importer.review(documentId),
    'import.reviewSummary': () => c().repos.documents.reviewSummary(),
    'import.updateReviewItem': (input) => c().importer.updateReviewItem(input),
    'import.confirmReview': ({ documentId }) => c().importer.confirmReview(documentId),
    'import.discardDocument': ({ documentId }) => c().importer.discardDocument(documentId),
    'import.openDocument': async ({ documentId }) => {
      const stored = c().repos.documents.storedPath(documentId);
      if (!stored) return { ok: false, cancelled: false, message: 'El PDF original no se conservó (puedes activarlo en Ajustes → Privacidad).', path: null };
      const full = rt.documentStore.resolveOwned(stored);
      if (!existsSync(full)) return { ok: false, cancelled: false, message: 'El archivo conservado ya no existe.', path: null };
      const err = await shell.openPath(full);
      return { ok: !err, cancelled: false, message: err || 'Documento abierto.', path: null };
    },
    'import.deleteRetainedDocuments': () => c().importer.deleteRetainedDocuments(),

    'email.status': () => c().sync.status(),
    'email.saveClientConfig': async (cfg) => {
      await c().gmailAuth.saveClientConfig(cfg);
      return c().sync.status();
    },
    'email.clearClientConfig': async () => {
      await c().sync.disconnect();
      await c().gmailAuth.clearClientConfig();
      return c().sync.status();
    },
    'email.connect': (input) => c().sync.connect(input?.send ?? false),
    'email.disconnect': () => c().sync.disconnect(),
    'email.scan': (input) => c().sync.scan(input?.lookbackMonths),
    'email.importSelected': ({ messageIds }) => c().sync.importSelected(messageIds),
    'email.syncNow': () => c().sync.syncNow('manual'),
    'email.retryPassword': ({ messageId, password }) => c().sync.retryPassword(messageId, password),
    'email.pendingPasswords': () => c().sync.pendingPasswords(),
    'email.unlockPending': async ({ password, remember }) => {
      const r = await c().sync.unlockPending(password, remember);
      if (r.unlocked > 0) emitChanged('unlock');
      return r;
    },

    'data.info': async () => {
      const counts = c().repos.documents.counts();
      let retainedBytes = 0;
      for (const d of c().repos.documents.allStoredPaths()) retainedBytes += await rt.documentStore.size(d.path);
      const dbSize = existsSync(rt.paths.db) ? (await stat(rt.paths.db)).size : 0;
      return {
        dataDir: rt.paths.root,
        dbSizeBytes: dbSize,
        transactionsCount: c().repos.transactions.count(),
        documentsCount: counts.documents,
        retainedDocumentsCount: counts.retained,
        retainedDocumentsBytes: retainedBytes,
        hasDemoData: counts.demo > 0,
        schemaVersion: rt.db.schemaVersion,
      };
    },
    'data.exportTransactions': async ({ format }) => {
      const w = win();
      const opts = {
        title: 'Exportar movimientos',
        defaultPath: `hormiga-movimientos-${todayIso()}.${format}`,
        filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }],
      };
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return cancelled();
      await writeFile(r.filePath, format === 'csv' ? c().data.exportCsv() : c().data.exportJson(), 'utf8');
      rt.log.info('data.exported', { format });
      return { ok: true, cancelled: false, message: `Movimientos exportados en ${basename(r.filePath)}.`, path: r.filePath };
    },
    'data.backup': async () => {
      const w = win();
      const opts = { title: 'Exportar copia de seguridad', defaultPath: `hormiga-backup-${todayIso()}.hormiga-backup`, filters: [{ name: 'Copia de Hormiga', extensions: ['hormiga-backup'] }] };
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return cancelled();
      const tmp = `${r.filePath}.tmp-${Date.now()}`;
      rt.db.backupTo(tmp);
      await rm(r.filePath, { force: true });
      await rename(tmp, r.filePath);
      rt.log.info('data.backup_created');
      return { ok: true, cancelled: false, message: `Copia guardada en ${basename(r.filePath)}. Contiene tus datos financieros sin cifrar: guárdala en un lugar seguro. No incluye credenciales de Gmail ni PDFs.`, path: r.filePath };
    },
    'data.restore': async ({ confirmation }) => {
      if (confirmation !== RESTORE_CONFIRMATION) throw new AppError('VALIDATION', `Escribe ${RESTORE_CONFIRMATION} para confirmar.`);
      const w = win();
      const opts = { title: 'Restaurar copia de seguridad', properties: ['openFile'] as 'openFile'[], filters: [{ name: 'Copia de Hormiga', extensions: ['hormiga-backup', 'db', 'sqlite'] }] };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return cancelled();
      const source = r.filePaths[0];
      const info = inspectDatabaseFile(source);
      if (info.appId !== APP_ID) throw new AppError('BACKUP_INVALID', 'El archivo no es una copia de seguridad de Hormiga.');
      if (info.schemaVersion > LATEST_SCHEMA_VERSION) throw new AppError('BACKUP_INVALID', 'La copia se creó con una versión más reciente de Hormiga. Actualiza la aplicación antes de restaurarla.');
      const ok = await confirmNative(
        'Se sustituirán todos los datos actuales por los de la copia.',
        `La copia contiene ${info.transactions} movimientos (esquema v${info.schemaVersion}). Tus datos actuales se guardarán como archivo de seguridad en la carpeta de datos antes de restaurar.`,
        'Restaurar',
      );
      if (!ok) return cancelled();
      const safety = `${rt.paths.db}.pre-restore-${Date.now()}`;
      rt.close();
      try {
        rt.db.close();
        await rename(rt.paths.db, safety);
        for (const s of ['-wal', '-shm']) await rm(`${rt.paths.db}${s}`, { force: true });
        await copyFile(source, rt.paths.db);
        rt.open();
      } catch (err) {
        rt.log.error('data.restore_failed', { err });
        await rm(rt.paths.db, { force: true });
        if (existsSync(safety)) await rename(safety, rt.paths.db);
        rt.open();
        throw new AppError('BACKUP_INVALID', 'No se pudo restaurar la copia; se han conservado los datos anteriores.', err);
      }
      rt.core.recurring.detect();
      emitChanged('restore');
      rt.log.info('data.restored', { schema: info.schemaVersion });
      return { ok: true, cancelled: false, message: `Copia restaurada (${info.transactions} movimientos). Los datos anteriores se guardaron como ${basename(safety)}.`, path: null };
    },
    'data.deleteAll': async ({ confirmation }) => {
      if (confirmation !== DELETE_CONFIRMATION) throw new AppError('VALIDATION', `Escribe ${DELETE_CONFIRMATION} para confirmar.`);
      const ok = await confirmNative(
        'Se eliminarán de forma permanente todos tus datos de Hormiga.',
        'Movimientos, documentos conservados, estadísticas, reglas, ingresos, objetivos, configuración y credenciales de Gmail (se revocará el acceso). Esta acción no se puede deshacer.',
        'Eliminar todo',
      );
      if (!ok) return cancelled();
      await rt.core.sync.disconnect().catch(() => undefined);
      await rt.core.gmailAuth.clearClientConfig().catch(() => undefined);
      rt.close();
      for (const s of ['', '-wal', '-shm']) await rm(`${rt.paths.db}${s}`, { force: true });
      await rm(rt.paths.documents, { recursive: true, force: true });
      await rm(rt.paths.secrets, { recursive: true, force: true });
      await rm(rt.paths.backups, { recursive: true, force: true });
      rt.open();
      emitChanged('deleteAll');
      rt.log.info('data.deleted_all');
      return { ok: true, cancelled: false, message: 'Todos los datos se han eliminado.', path: null };
    },
    'data.clearImported': async ({ confirmation }) => {
      if (confirmation !== CLEAR_CONFIRMATION) throw new AppError('VALIDATION', `Escribe ${CLEAR_CONFIRMATION} para confirmar.`);
      const ok = await confirmNative(
        'Se borrarán todos los movimientos y documentos cargados.',
        'Podrás volver a importarlos o sincronizar Gmail de nuevo. Se conservan tu configuración, categorías y reglas, ingresos, objetivos, metas, patrimonio y la conexión con Gmail. Si quieres, haz antes una copia de seguridad.',
        'Borrar datos cargados',
      );
      if (!ok) return cancelled();
      await c().importer.deleteRetainedDocuments();
      const r = c().data.clearImported();
      refreshAfterDataChange();
      rt.log.info('data.cleared_imported', { transactions: r.transactions, documents: r.documents });
      return { ok: true, cancelled: false, message: `Borrados ${r.transactions} movimientos de ${r.documents} documentos.`, path: null };
    },
    'data.loadDemo': () => {
      const r = c().data.loadDemo();
      refreshAfterDataChange();
      return r;
    },
    'data.removeDemo': () => {
      const r = c().data.removeDemo();
      refreshAfterDataChange();
      return r;
    },
    'data.openDataDir': async () => {
      const err = await shell.openPath(rt.paths.root);
      return { ok: !err, cancelled: false, message: err || 'Carpeta abierta.', path: null };
    },

    'pots.overview': () => c().wealth.potsOverview(),
    'pots.save': (input) => {
      const potId = c().repos.pots.save(input);
      emitChanged('pots');
      return c().wealth.potDTOs().find((p) => p.id === potId)!;
    },
    'pots.delete': ({ id }) => {
      const r = { deleted: c().repos.pots.delete(id) };
      emitChanged('pots');
      return r;
    },
    'pots.movements': ({ potId }) => c().repos.pots.movements(potId),
    'pots.addMovement': ({ potId, date, amountCents, note }) => {
      c().repos.pots.addMovement(potId, date, amountCents, note);
      emitChanged('pots');
      return c().wealth.potDTOs().find((p) => p.id === potId)!;
    },
    'pots.deleteMovement': ({ id }) => {
      const r = { deleted: c().repos.pots.deleteMovement(id) };
      emitChanged('pots');
      return r;
    },
    'wealth.overview': () => c().wealth.wealthOverview(),
    'accounts.list': () => c().accounts.list(),
    'budgets.overview': (input) => c().budgets.overview(input?.month),
    'budgets.set': ({ categoryId, amountCents }) => {
      c().budgets.set(categoryId, amountCents);
      onAlertsChanged();
      emitChanged('budgets');
      return c().budgets.overview();
    },
    'alerts.list': () => c().budgets.alerts(),
    'alerts.markRead': (input) => {
      c().budgets.markRead(input?.key);
      emitChanged('alerts.read');
      return { ok: true };
    },
    'lock.status': () => lock.status(),
    'lock.unlockPin': ({ pin }) => lock.unlockWithPin(pin),
    'lock.unlockHello': () => lock.unlockWithHello(),
    'lock.lockNow': () => {
      lock.lock();
      return { ok: lock.isLocked() };
    },
    'lock.configure': async (input) => {
      const settings = c().repos.settings;
      const current = settings.getSettings().lock;
      const before = await lock.status();
      if (input.pin) await lock.setPin(input.pin, input.currentPin);
      if (input.enabled === false && current.enabled) {
        // Turning the lock off requires the PIN (and removes it).
        await lock.removePin(input.currentPin ?? '');
      }
      const pinSet = input.pin ? true : input.enabled === false ? false : before.pinSet;
      if (input.enabled === true && !pinSet) throw new AppError('VALIDATION', 'Define primero un PIN de 4 a 8 cifras.');
      settings.updateSettings({
        lock: {
          enabled: input.enabled ?? current.enabled,
          windowsHello: input.windowsHello ?? (input.enabled === false ? false : current.windowsHello),
          autoLockMinutes: input.autoLockMinutes ?? current.autoLockMinutes,
        },
      });
      return lock.status();
    },
    'accounts.update': (input) => {
      c().accounts.update(input);
      refreshAfterDataChange();
      return c().accounts.list();
    },
    'accounts.setBalance': ({ id, balanceCents, date }) => {
      c().accounts.setBalance(id, balanceCents, date);
      emitChanged('accounts');
      return c().accounts.list();
    },
    'accounts.createManual': (input) => {
      c().accounts.createManual(input);
      refreshAfterDataChange();
      return c().accounts.list();
    },
    'accounts.merge': ({ fromId, intoId }) => {
      c().accounts.merge(fromId, intoId);
      refreshAfterDataChange();
      return c().accounts.list();
    },
    'accounts.deleteManual': ({ id }) => {
      c().accounts.deleteManual(id);
      refreshAfterDataChange();
      return c().accounts.list();
    },
    'accounts.counterparties': () => c().accounts.counterparties(),
    'accounts.extraordinary': () => c().accounts.extraordinary(),
    'accounts.resolveExtraordinary': ({ id, asCapital }) => {
      c().accounts.resolveExtraordinary(id, asCapital);
      refreshAfterDataChange();
      return c().accounts.extraordinary();
    },
    'accounts.decideCounterparty': (input) => {
      const changed = c().accounts.decideCounterparty(input);
      refreshAfterDataChange();
      return { changed };
    },
    'wealth.saveAsset': (input) => {
      const assetId = c().repos.assets.save(input);
      emitChanged('wealth');
      return c().wealth.assetDTOs().find((a) => a.id === assetId)!;
    },
    'wealth.deleteAsset': ({ id }) => {
      const r = { deleted: c().repos.assets.delete(id) };
      emitChanged('wealth');
      return r;
    },
    'wealth.valuations': ({ assetId }) => c().repos.assets.valuations(assetId),
    'wealth.saveValuation': (input) => {
      c().repos.assets.upsertValuation(input);
      emitChanged('wealth');
      return c().wealth.assetDTOs().find((a) => a.id === input.assetId)!;
    },
    'wealth.loanSchedule': ({ assetId }) => c().wealth.loanSchedule(assetId),
    'wealth.earlyRepayment': ({ assetId, date, amountCents, strategy }) => c().wealth.earlyRepayment(assetId, date, amountCents, strategy),
    'market.search': ({ query }) => c().wealth.marketSearch(query),
    'market.returns': ({ symbol }) => c().wealth.marketReturns(symbol),
    'forecast.overview': () => c().forecast.overview(),
    'budgets.setMany': ({ items }) => {
      c().budgets.setMany(items);
      onAlertsChanged();
      return c().budgets.overview();
    },
    'assistant.ask': ({ question }) => c().assistant.ask(question),
    'data.audit': () => c().audit.run(),
    'notify.testEmail': async () => {
      await c().notify.sendTest();
      return { ok: true };
    },
    'stocks.overview': () => c().stocks.overview(),
    'stocks.refresh': async (input) => {
      const r = await c().stocks.refresh(input?.force ?? false);
      onAlertsChanged();
      return r;
    },
    'stocks.addWatch': async ({ symbol }) => {
      const r = await c().stocks.addWatch(symbol);
      onAlertsChanged();
      return r;
    },
    'stocks.removeWatch': ({ symbol }) => c().stocks.removeWatch(symbol),
    'stocks.setTarget': ({ symbol, targetPrice }) => {
      const r = c().stocks.setTarget(symbol, targetPrice);
      onAlertsChanged();
      return r;
    },
    'stocks.addTrade': (input) => {
      const r = c().stocks.addTrade(input);
      onAlertsChanged();
      return r;
    },
    'stocks.deleteTrade': ({ id }) => c().stocks.deleteTrade(id),
    'wealth.deleteValuation': ({ id }) => {
      const r = { deleted: c().repos.assets.deleteValuation(id) };
      emitChanged('wealth');
      return r;
    },

    'shell.openHelp': async ({ topic }) => {
      await shell.openExternal(HELP_URLS[topic]);
      return { opened: true };
    },
  };
}
