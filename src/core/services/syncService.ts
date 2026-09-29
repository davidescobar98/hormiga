import { addMonths, monthOf, todayIso } from '../../shared/dates';
import type { EmailCandidate, EmailStatus, ImportOutcome, ScanResult, SyncProgressEvent, SyncSummary } from '../../shared/types';
import { buildGmailQuery, isStatementAttachment, scoreMessage } from '../email/detection';
import { GMAIL_SCOPE, mapGoogleError } from '../email/gmailAuth';
import type { EmailMessageMeta, EmailProvider } from '../email/types';
import type { EmailImportStatus } from '../db/documentsRepo';
import { AppError } from '../errors';
import type { Logger, Repos } from './context';
import type { ImportService } from './importService';

export interface EmailAuthPort {
  clientConfig(): Promise<{ clientId: string } | null>;
  hasTokens(): Promise<boolean>;
  authorize(): Promise<void>;
  disconnect(): Promise<void>;
  resetClient(): void;
}

const PROVIDER = 'gmail';
const MAX_MESSAGES = 300;
const OVERLAP_DAYS = 7;

/**
 * Email ingestion use cases: connection status, candidate scan (for review before the first bulk import),
 * incremental sync and password retries. Failures of one message never abort the others,
 * and every processed message is recorded so repeated syncs are idempotent.
 */
export class SyncService {
  private running: Promise<SyncSummary> | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly auth: EmailAuthPort,
    private readonly providerFactory: () => Promise<EmailProvider>,
    private readonly importer: ImportService,
    private readonly log: Logger,
    private readonly now: () => Date,
    private readonly emit: (e: SyncProgressEvent) => void = () => {},
  ) {}

  async status(): Promise<EmailStatus> {
    const client = await this.auth.clientConfig();
    const tokens = client ? await this.auth.hasTokens() : false;
    const authError = this.repos.settings.getRaw<string>('email.authError');
    const state: EmailStatus['state'] = !client ? 'not_configured' : !tokens ? 'disconnected' : authError ? 'reauth_required' : 'connected';
    const last = this.repos.settings.getLastSync();
    return {
      state,
      provider: 'gmail',
      account: tokens ? this.repos.settings.getEmailAccount() : null,
      clientConfigured: !!client,
      scope: GMAIL_SCOPE,
      lastSyncAt: last?.finishedAt ?? null,
      lastSync: last,
      lastDocument: this.repos.documents.lastImported(),
      message: state === 'reauth_required' ? authError : null,
    };
  }

  async connect(): Promise<EmailStatus> {
    await this.auth.authorize();
    this.repos.settings.delete('email.authError');
    try {
      const provider = await this.providerFactory();
      this.repos.settings.setEmailAccount(await provider.getAccount());
    } catch (err) {
      this.log.warn('gmail.profile_failed', { code: mapGoogleError(err).code });
    }
    return this.status();
  }

  async disconnect(): Promise<EmailStatus> {
    await this.auth.disconnect();
    this.repos.settings.setEmailAccount(null);
    this.repos.settings.delete('email.authError');
    return this.status();
  }

  private async provider(): Promise<EmailProvider> {
    if (!(await this.auth.clientConfig())) throw new AppError('GMAIL_NOT_CONFIGURED', 'Configura primero el cliente OAuth de Google en Ajustes → Cuenta de correo.');
    if (!(await this.auth.hasTokens())) throw new AppError('GMAIL_NOT_CONNECTED', 'Conecta tu cuenta de Gmail para sincronizar.');
    return this.providerFactory();
  }

  private handleAuthFailure(err: AppError): void {
    if (err.code === 'GMAIL_AUTH_EXPIRED' || err.code === 'GMAIL_PERMISSION') {
      this.repos.settings.setRaw('email.authError', err.message);
      this.auth.resetClient();
    }
  }

  private async fetchCandidates(provider: EmailProvider, after: Date): Promise<{ query: string; items: { meta: EmailMessageMeta; score: ReturnType<typeof scoreMessage> }[] }> {
    const cfg = this.repos.settings.getSettings().detection;
    const query = buildGmailQuery(cfg, after);
    this.emit({ phase: 'searching', current: 0, total: 0, message: 'Buscando extractos de tus bancos en el correo…' });
    const ids = await provider.search({ query, maxResults: MAX_MESSAGES });
    const items: { meta: EmailMessageMeta; score: ReturnType<typeof scoreMessage> }[] = [];
    for (let i = 0; i < ids.length; i++) {
      this.emit({ phase: 'searching', current: i + 1, total: ids.length, message: `Analizando email ${i + 1} de ${ids.length}` });
      const meta = await provider.getMessage(ids[i]!);
      items.push({ meta, score: scoreMessage(meta, cfg) });
    }
    return { query, items };
  }

  /** Lists candidate emails without importing anything (used before the first bulk import). */
  async scan(lookbackMonths?: number): Promise<ScanResult> {
    const months = lookbackMonths ?? this.repos.settings.getSettings().initialLookbackMonths;
    const provider = await this.provider();
    try {
      const after = new Date(`${addMonths(monthOf(todayIso(this.now())), -months)}-01T00:00:00`);
      const { query, items } = await this.fetchCandidates(provider, after);
      const processed = this.repos.emailImports.statusByMessage(PROVIDER);
      const candidates: EmailCandidate[] = items
        .map(({ meta, score }) => ({
          messageId: meta.id,
          subject: meta.subject,
          from: meta.from,
          date: meta.date,
          scoreBp: score.score * 100,
          classification: score.classification,
          reasons: score.reasons,
          attachments: meta.attachments.filter(isStatementAttachment).map((a) => ({ fileName: a.fileName, sizeBytes: a.sizeBytes })),
          processedStatus: processed.get(meta.id) ?? null,
        }))
        .filter((c) => c.classification !== 'ignored')
        .sort((a, b) => b.date.localeCompare(a.date));
      this.emit({ phase: 'done', current: candidates.length, total: candidates.length, message: `${candidates.length} emails candidatos` });
      return { candidates, query, lookbackMonths: months };
    } catch (err) {
      const e = mapGoogleError(err);
      this.handleAuthFailure(e);
      throw e;
    }
  }

  /** Imports the messages the user selected in the review list. */
  async importSelected(messageIds: string[]): Promise<SyncSummary> {
    return this.singleFlight(async () => {
      const provider = await this.provider();
      const summary = this.newSummary('selection');
      const processedAlready = this.repos.emailImports.statusByMessage(PROVIDER);
      try {
        for (let i = 0; i < messageIds.length; i++) {
          const id = messageIds[i]!;
          this.emit({ phase: 'downloading', current: i + 1, total: messageIds.length, message: `Importando email ${i + 1} de ${messageIds.length}` });
          const prev = processedAlready.get(id);
          if (prev === 'imported' || prev === 'duplicate') {
            summary.duplicates++;
            continue;
          }
          const meta = await provider.getMessage(id);
          const score = scoreMessage(meta, this.repos.settings.getSettings().detection);
          summary.scanned++;
          summary.detected++;
          await this.processMessage(provider, meta, score.score, summary);
        }
      } catch (err) {
        this.recordFatal(summary, err);
      }
      return this.finish(summary);
    });
  }

  /** Incremental sync. The very first sync only scans: the user reviews the candidates before a bulk import. */
  async syncNow(trigger: 'manual' | 'startup' | 'scheduled' = 'manual'): Promise<SyncSummary> {
    return this.singleFlight(async () => {
      const summary = this.newSummary(trigger);
      const provider = await this.provider();
      const settings = this.repos.settings.getSettings();
      const firstSync = this.repos.emailImports.count(PROVIDER) === 0;
      const last = this.repos.settings.getLastSync();
      const after = last && !firstSync
        ? new Date(new Date(last.startedAt).getTime() - OVERLAP_DAYS * 86_400_000)
        : new Date(`${addMonths(monthOf(todayIso(this.now())), -settings.initialLookbackMonths)}-01T00:00:00`);
      try {
        const { items } = await this.fetchCandidates(provider, after);
        const processed = this.repos.emailImports.statusByMessage(PROVIDER);
        summary.scanned = items.length;
        const detected = items.filter((i) => i.score.classification === 'detected');
        summary.detected = detected.length;
        const pendingNew = items.filter((i) => i.score.classification !== 'ignored' && !processed.has(i.meta.id));
        if (firstSync) {
          summary.pendingCandidates = pendingNew.length;
          return this.finish(summary, pendingNew.length
            ? `Se han encontrado ${pendingNew.length} emails candidatos. Revísalos antes de la importación inicial.`
            : 'No se han encontrado emails de bancos con extractos en el periodo configurado.');
        }
        const toImport = detected.filter((i) => !processed.has(i.meta.id) || processed.get(i.meta.id) === 'failed');
        summary.pendingCandidates = pendingNew.filter((i) => i.score.classification === 'possible').length;
        for (let i = 0; i < toImport.length; i++) {
          this.emit({ phase: 'processing', current: i + 1, total: toImport.length, message: `Procesando documento ${i + 1} de ${toImport.length}` });
          await this.processMessage(provider, toImport[i]!.meta, toImport[i]!.score.score, summary);
        }
      } catch (err) {
        this.recordFatal(summary, err);
      }
      return this.finish(summary);
    });
  }

  /** Re-downloads a password-protected attachment and imports it with the password (never stored). */
  async retryPassword(messageId: string, password: string): Promise<ImportOutcome[]> {
    const provider = await this.provider();
    const meta = await provider.getMessage(messageId).catch((err) => {
      throw mapGoogleError(err);
    });
    const outcomes: ImportOutcome[] = [];
    const info = this.repos.emailImports.getMeta(PROVIDER, messageId);
    for (const att of meta.attachments.filter(isStatementAttachment)) {
      const bytes = await provider.downloadAttachment(messageId, att).catch((err) => {
        throw mapGoogleError(err);
      });
      const outcome = await this.importer.importDocument({ bytes, fileName: att.fileName, source: 'email', password });
      if (outcome.status === 'failed' && outcome.errorCode === 'PDF_PASSWORD_INCORRECT') {
        outcomes.push(outcome);
        continue;
      }
      this.repos.emailImports.record({
        provider: PROVIDER, messageId, attachmentKey: att.key, subject: meta.subject, sender: meta.from, receivedAt: meta.date,
        scoreBp: info?.scoreBp ?? 0, status: statusFor(outcome), errorCode: outcome.errorCode, documentId: outcome.documentId,
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * Tries one password (usually the DNI/NIE) on every protected BBVA email pending. Optionally keeps it in memory
   * so the next protected documents open automatically while the app is running.
   */
  async unlockPending(password: string, remember: boolean): Promise<{ unlocked: number; remaining: number; newTransactions: number; message: string }> {
    const pending = this.pendingPasswords();
    let unlocked = 0;
    let newTransactions = 0;
    let wrong = 0;
    for (const p of pending) {
      const outcomes = await this.retryPassword(p.messageId, password);
      if (outcomes.some((o) => o.errorCode === 'PDF_PASSWORD_INCORRECT')) wrong++;
      else if (outcomes.length > 0) {
        unlocked++;
        newTransactions += outcomes.reduce((a, o) => a + o.inserted, 0);
      }
    }
    if (remember && unlocked > 0) this.importer.rememberPassword(password);
    const remaining = this.pendingPasswords().length;
    const message = unlocked === 0 && wrong > 0
      ? 'La contraseña no es correcta para ningún documento. Comprueba el DNI/NIE (con letra, sin espacios).'
      : `${unlocked} documento(s) desbloqueado(s) con ${newTransactions} movimientos nuevos${remaining ? `; ${remaining} siguen protegidos con otra contraseña` : ''}.`;
    this.log.info('sync.unlock_pending', { unlocked, remaining });
    return { unlocked, remaining, newTransactions, message };
  }

  pendingPasswords(): { messageId: string; subject: string | null }[] {
    return this.repos.emailImports.pendingPasswords(PROVIDER);
  }

  private async processMessage(provider: EmailProvider, meta: EmailMessageMeta, score: number, summary: SyncSummary): Promise<void> {
    const pdfs = meta.attachments.filter(isStatementAttachment);
    const base = { provider: PROVIDER, messageId: meta.id, subject: meta.subject, sender: meta.from, receivedAt: meta.date, scoreBp: score * 100 };
    if (pdfs.length === 0) {
      this.repos.emailImports.record({ ...base, attachmentKey: '-', status: 'skipped', errorCode: null, documentId: null });
      return;
    }
    for (const att of pdfs) {
      try {
        const bytes = await provider.downloadAttachment(meta.id, att);
        const outcome = await this.importer.importDocument({ bytes, fileName: att.fileName, source: 'email' });
        const status = statusFor(outcome);
        this.repos.emailImports.record({ ...base, attachmentKey: att.key, status, errorCode: outcome.errorCode, documentId: outcome.documentId });
        if (status === 'imported') {
          summary.imported++;
          summary.newTransactions += outcome.inserted;
        } else if (status === 'duplicate') summary.duplicates++;
        else if (status === 'needs_review') summary.needsReview++;
        else if (status === 'password_required') summary.passwordRequired++;
        else if (status === 'not_statement') summary.ignored++;
        else if (status === 'failed') {
          summary.failed++;
          summary.errors.push({ code: outcome.errorCode ?? 'INTERNAL', message: outcome.message, subject: meta.subject });
        }
      } catch (err) {
        const e = mapGoogleError(err);
        if (e.code === 'GMAIL_OFFLINE' || e.code === 'GMAIL_AUTH_EXPIRED' || e.code === 'GMAIL_PERMISSION' || e.code === 'GMAIL_RATE_LIMITED') throw e;
        this.repos.emailImports.record({ ...base, attachmentKey: att.key, status: 'failed', errorCode: e.code, documentId: null });
        summary.failed++;
        summary.errors.push({ code: e.code, message: e.message, subject: meta.subject });
        this.log.warn('sync.message_failed', { code: e.code });
      }
    }
  }

  private recordFatal(summary: SyncSummary, err: unknown): void {
    const e = mapGoogleError(err);
    this.handleAuthFailure(e);
    summary.errors.push({ code: e.code, message: e.message });
    this.log.warn('sync.aborted', { code: e.code });
  }

  private newSummary(trigger: SyncSummary['trigger']): SyncSummary {
    return {
      startedAt: this.now().toISOString(), finishedAt: '', trigger, scanned: 0, detected: 0, imported: 0, duplicates: 0,
      needsReview: 0, passwordRequired: 0, failed: 0, ignored: 0, newTransactions: 0, pendingCandidates: 0, errors: [], message: '',
    };
  }

  private finish(summary: SyncSummary, message?: string): SyncSummary {
    summary.finishedAt = this.now().toISOString();
    summary.message = message ?? describe(summary);
    const fatal = summary.errors.find((e) => !e.subject);
    // Only a sync that reached Gmail moves the incremental window forward.
    if (!fatal) this.repos.settings.setLastSync(summary);
    else this.repos.settings.setRaw('email.lastFailedSync', summary);
    if (!fatal) this.repos.settings.delete('email.authError');
    this.emit({ phase: 'done', current: 1, total: 1, message: summary.message });
    this.log.info('sync.finished', { trigger: summary.trigger, scanned: summary.scanned, imported: summary.imported, failed: summary.failed, fatal: fatal?.code ?? null });
    return summary;
  }

  private singleFlight(fn: () => Promise<SyncSummary>): Promise<SyncSummary> {
    this.running ??= fn().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}


function statusFor(o: ImportOutcome): EmailImportStatus {
  switch (o.status) {
    case 'imported':
      return 'imported';
    case 'duplicate':
      return 'duplicate';
    case 'needs_review':
      return 'needs_review';
    case 'password_required':
      return 'password_required';
    default:
      return o.errorCode === 'UNKNOWN_FORMAT' || o.errorCode === 'PDF_NO_TEXT' ? 'not_statement' : 'failed';
  }
}

function describe(s: SyncSummary): string {
  const fatal = s.errors.find((e) => !e.subject);
  if (fatal) return fatal.message;
  const parts: string[] = [];
  if (s.imported) parts.push(`${s.imported} documento(s) importado(s) con ${s.newTransactions} movimientos`);
  if (s.needsReview) parts.push(`${s.needsReview} pendiente(s) de revisión`);
  if (s.passwordRequired) parts.push(`${s.passwordRequired} protegido(s) con contraseña`);
  if (s.duplicates) parts.push(`${s.duplicates} ya importado(s)`);
  if (s.failed) parts.push(`${s.failed} con errores`);
  if (s.ignored) parts.push(`${s.ignored} adjunto(s) que no eran extractos (ignorados)`);
  if (s.pendingCandidates) parts.push(`${s.pendingCandidates} posible(s) para revisar`);
  return parts.length ? `${parts.join(', ')}.` : 'No hay documentos nuevos.';
}
