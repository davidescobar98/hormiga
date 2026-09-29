import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '../core/app';
import { Database } from '../core/db/database';
import { LATEST_SCHEMA_VERSION } from '../core/db/migrations';
import type { OAuthClientConfig } from '../core/email/gmailAuth';
import type { Logger } from '../core/services/context';
import type { SyncProgressEvent } from '../shared/types';
import { FsDocumentStore } from './documentStore';
import { SafeStorageVault } from './vault';

export interface Paths {
  root: string;
  db: string;
  documents: string;
  secrets: string;
  backups: string;
  logs: string;
  logFile: string;
}

export function resolvePaths(): Paths {
  const root = join(app.getPath('userData'), 'data');
  const logs = join(app.getPath('userData'), 'logs');
  return {
    root,
    db: join(root, 'hormiga.db'),
    documents: join(root, 'documents'),
    secrets: join(root, 'secrets'),
    backups: join(root, 'backups'),
    logs,
    logFile: join(logs, 'hormiga.log'),
  };
}

const PRE_UPGRADE_PREFIX = 'antes-de-actualizar-';
const KEEP_UPGRADE_BACKUPS = 5;

export interface RuntimeEvents {
  syncProgress: (e: SyncProgressEvent) => void;
  dataChanged: (reason: string) => void;
}

/** Owns the database connection and the core services; can be torn down and rebuilt (restore / delete all). */
export class Runtime {
  core!: Core;
  db!: Database;
  readonly vault: SafeStorageVault;
  readonly documentStore: FsDocumentStore;

  constructor(
    readonly paths: Paths,
    readonly log: Logger,
    private readonly events: RuntimeEvents,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly envClient: OAuthClientConfig | null,
  ) {
    for (const dir of [paths.root, paths.documents, paths.secrets, paths.logs]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.vault = new SafeStorageVault(paths.secrets);
    this.documentStore = new FsDocumentStore(paths.documents);
    this.open();
  }

  /**
   * Before a newer version changes the database structure, keeps a copy of the current file so an
   * update can never lose data. Only the last few copies are kept.
   */
  private backupBeforeUpgrade(): void {
    if (!existsSync(this.paths.db)) return;
    const probe = new Database(this.paths.db);
    try {
      const from = probe.schemaVersion;
      if (from === 0 || from >= LATEST_SCHEMA_VERSION) return;
      if (!existsSync(this.paths.backups)) mkdirSync(this.paths.backups, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      probe.backupTo(join(this.paths.backups, `${PRE_UPGRADE_PREFIX}v${from}-${stamp}.db`));
      this.log.info('db.pre_upgrade_backup', { from, to: LATEST_SCHEMA_VERSION });
      const old = readdirSync(this.paths.backups).filter((f) => f.startsWith(PRE_UPGRADE_PREFIX)).sort().reverse().slice(KEEP_UPGRADE_BACKUPS);
      for (const f of old) rmSync(join(this.paths.backups, f), { force: true });
    } finally {
      probe.close();
    }
  }

  open(): void {
    this.backupBeforeUpgrade();
    this.db = Database.open(this.paths.db);
    this.core = createCore({
      db: this.db,
      now: () => new Date(),
      log: this.log,
      vault: this.vault,
      documentStore: this.documentStore,
      openExternal: this.openExternal,
      envOAuthClient: this.envClient,
      emitSyncProgress: this.events.syncProgress,
      onDataChanged: this.events.dataChanged,
    });
    this.log.info('db.opened', { schema: this.db.schemaVersion });
    // A fresh install has no release notes to show; an update keeps the previous value.
    const settings = this.core.repos.settings.getSettings();
    if (!settings.onboardingCompleted && settings.lastSeenVersion !== app.getVersion()) this.core.repos.settings.updateSettings({ lastSeenVersion: app.getVersion() });
  }

  close(): void {
    this.db?.close();
  }
}
