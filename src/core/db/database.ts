import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations';
import { AppError } from '../errors';

export type SqlParam = SQLInputValue | boolean | undefined;
type Row = Record<string, unknown>;

export const APP_ID = 'hormiga';

/**
 * Thin wrapper over node:sqlite (built into Node ≥22.13 and Electron ≥35: no native addon to rebuild).
 * All SQL uses bound parameters; string interpolation of values is forbidden.
 */
export class Database {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
    }
  }

  static open(path: string, now: () => string = () => new Date().toISOString()): Database {
    const db = new Database(path);
    db.migrate(now);
    return db;
  }

  get schemaVersion(): number {
    return (this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0) as number;
  }

  migrate(now: () => string = () => new Date().toISOString()): void {
    const current = this.schemaVersion;
    if (current > LATEST_SCHEMA_VERSION) {
      throw new AppError('CONFLICT', `La base de datos fue creada por una versión más reciente de Hormiga (esquema ${current}). Actualiza la aplicación.`);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${Number(m.version)}`);
        this.run(
          `INSERT INTO app_meta(key, value) VALUES ('app_id', ?), ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          APP_ID,
          String(m.version),
        );
        this.run(
          `INSERT INTO app_meta(key, value) VALUES ('migrated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          now(),
        );
      });
    }
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...norm(params)) as T[];
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...norm(params)) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls use savepoints. Any throw rolls back everything inside. */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('transaction() no admite funciones asíncronas');
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /** Writes a consistent, compacted copy of the database (safe while the app is running). */
  backupTo(targetPath: string): void {
    this.db.prepare('VACUUM INTO ?').run(targetPath);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function norm(params: SqlParam[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/** Validates that a file is a Hormiga database and returns its schema version, without modifying it. */
export function inspectDatabaseFile(path: string): { appId: string | null; schemaVersion: number; transactions: number } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== 'ok') throw new AppError('BACKUP_INVALID', 'La copia de seguridad está dañada (falla la comprobación de integridad).');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
    if (!hasMeta) return { appId: null, schemaVersion: version, transactions: 0 };
    const app = db.prepare("SELECT value FROM app_meta WHERE key='app_id'").get() as { value: string } | undefined;
    const tx = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
    return { appId: app?.value ?? null, schemaVersion: version, transactions: Number(tx.n) };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BACKUP_INVALID', 'El archivo seleccionado no es una base de datos SQLite válida.', err);
  } finally {
    db?.close();
  }
}
