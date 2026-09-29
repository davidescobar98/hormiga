import type { AppSettings, DetectionConfig, SyncSummary } from '../../shared/types';
import type { Database } from './database';

export const DEFAULT_DETECTION: DetectionConfig = {
  senderDomains: ['bbva.com', 'bbva.es', 'comunica.bbva.com', 'info.bbva.com', 'notificaciones.bbva.com'],
  senderAddresses: [],
  subjectKeywords: ['extracto', 'resumen', 'factura', 'liquidación', 'liquidacion', 'movimientos', 'tarjeta', 'documento', 'correspondencia'],
  filenameKeywords: ['extracto', 'resumen', 'factura', 'liquidacion', 'movimientos', 'tarjeta', 'bbva'],
  minScore: 60,
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  keepDocuments: false,
  incomeMode: 'auto',
  initialLookbackMonths: 12,
  autoSyncOnStart: true,
  onboardingCompleted: false,
  detection: DEFAULT_DETECTION,
  marketDataEnabled: false,
  lastSeenVersion: null,
  autoUpdate: true,
};

/** Non-secret key/value settings stored as JSON. Secrets (OAuth tokens) never go here. */
export class SettingsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  getRaw<T>(key: string): T | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setRaw(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.now().toISOString(),
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM settings WHERE key = ?', key);
  }

  getSettings(): AppSettings {
    const stored = this.getRaw<Partial<AppSettings>>('app') ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      detection: { ...DEFAULT_DETECTION, ...(stored.detection ?? {}) },
    };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...patch,
      detection: { ...current.detection, ...(patch.detection ?? {}) },
    };
    this.setRaw('app', next);
    return next;
  }

  getLastSync(): SyncSummary | null {
    return this.getRaw<SyncSummary>('email.lastSync');
  }

  setLastSync(summary: SyncSummary): void {
    this.setRaw('email.lastSync', summary);
  }

  getEmailAccount(): string | null {
    return this.getRaw<string>('email.account');
  }

  setEmailAccount(account: string | null): void {
    if (account === null) this.delete('email.account');
    else this.setRaw('email.account', account);
  }
}
