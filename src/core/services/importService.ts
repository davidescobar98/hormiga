import { randomUUID } from 'node:crypto';
import type { DocumentSource, ImportOutcome, ReviewDocument, ReviewItem, TransactionType, UpdateReviewItemInput } from '../../shared/types';
import { isIsoDate } from '../../shared/dates';
import { assignFingerprints, sha256Hex } from '../domain/fingerprint';
import { normalizeMerchant, normalizeText, type MerchantResult } from '../domain/merchant';
import { AppError, invalid } from '../errors';
import { normalizeStatement, type CandidateTransaction } from '../parsing/normalize';
import { DEFAULT_PARSERS, extractDocument, selectParser } from '../parsing/registry';
import type { StatementParser } from '../parsing/types';
import type { CategorizationService } from './categorizationService';
import type { DocumentStore, Logger, Repos } from './context';
import type { AccountsService } from './accountsService';
import { refineTransfer } from '../domain/transfers';

export interface ImportRequest {
  bytes: Uint8Array;
  fileName: string;
  source: DocumentSource;
  password?: string;
}

interface PendingPassword {
  bytes: Uint8Array;
  fileName: string;
  source: DocumentSource;
  expiresAt: number;
  onImported?: (outcome: ImportOutcome) => void;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

interface InsertableRow {
  date: string;
  bookingDate: string | null;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchant: MerchantResult | null;
  amountCents: number;
  type: TransactionType;
}

/**
 * Document ingestion: file → text → parser → normalization/validation → DB (atomically).
 * Consistent documents are imported directly; anything suspicious goes to "Revisión de importación".
 */
export class ImportService {
  private readonly pending = new Map<string, PendingPassword>();
  /**
   * Passwords the user chose to reuse while the app is open (BBVA protects every PDF with the same DNI/NIE).
   * Memory only: never written to disk, logs or the database; gone when the app closes.
   */
  private sessionPasswords: string[] = [];

  rememberPassword(password: string): void {
    if (!password || this.sessionPasswords.includes(password)) return;
    this.sessionPasswords = [password, ...this.sessionPasswords].slice(0, 3);
  }

  forgetPasswords(): void {
    this.sessionPasswords = [];
  }

  hasRememberedPasswords(): boolean {
    return this.sessionPasswords.length > 0;
  }

  constructor(
    private readonly repos: Repos,
    private readonly categorization: CategorizationService,
    private readonly store: DocumentStore,
    private readonly log: Logger,
    private readonly afterChange: () => void,
    private readonly parsers: StatementParser[] = DEFAULT_PARSERS,
  ) {}

  /** Set by the composition root (accounts depend on categorization too). */
  accounts: AccountsService | null = null;

  async importDocument(req: ImportRequest, hooks: { onPasswordImported?: (o: ImportOutcome) => void } = {}): Promise<ImportOutcome> {
    const base = { fileName: req.fileName, documentId: null, inserted: 0, duplicatesSkipped: 0, reviewCount: 0, pendingToken: null, errorCode: null };
    const sha = sha256Hex(req.bytes);
    const existing = this.repos.documents.findByHash(sha);
    if (existing) {
      this.log.info('import.duplicate_document', { documentId: existing.id });
      return {
        ...base,
        status: 'duplicate',
        documentId: existing.id,
        errorCode: 'DUPLICATE_DOCUMENT',
        message: `Este documento ya se importó el ${new Date(existing.importedAt).toLocaleDateString('es-ES')} («${existing.fileName}»). No se ha duplicado nada.`,
      };
    }

    let doc;
    try {
      doc = await extractDocument(req.bytes, req.fileName, req.password);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PDF_PASSWORD_REQUIRED' && req.password === undefined) {
        for (const pw of this.sessionPasswords) {
          const unlocked = await extractDocument(req.bytes, req.fileName, pw).catch(() => null);
          if (unlocked) {
            doc = unlocked;
            break;
          }
        }
      }
      if (!doc && err instanceof AppError && err.code === 'PDF_PASSWORD_REQUIRED') {
        const token = randomUUID();
        this.gcPending();
        this.pending.set(token, { bytes: req.bytes, fileName: req.fileName, source: req.source, expiresAt: Date.now() + PENDING_TTL_MS, onImported: hooks.onPasswordImported });
        return { ...base, status: 'password_required', pendingToken: token, errorCode: err.code, message: err.message };
      }
      if (!doc && err instanceof AppError) {
        this.log.warn('import.extract_failed', { code: err.code });
        return { ...base, status: 'failed', errorCode: err.code, message: err.message };
      }
      if (!doc) throw err;
    }

    try {
      const parser = selectParser(doc, this.parsers);
      const parsed = parser.parse(doc);
      if (parsed.transactions.length === 0) {
        throw new AppError('UNKNOWN_FORMAT', `No se encontraron movimientos en «${req.fileName}». Puede que el formato del documento haya cambiado o que no sea un extracto.`);
      }
      const normalized = normalizeStatement(parsed);
      const sameperiod = this.repos.documents.findSamePeriod(parsed.bank, parsed.accountHint, normalized.periodStart, normalized.periodEnd);
      const warnings = [...normalized.warnings];
      if (sameperiod) warnings.push(`Ya había un extracto del mismo periodo («${sameperiod.fileName}»). Los movimientos repetidos se han omitido.`);

      const invalidRows = normalized.candidates.filter((c) => c.errors.length > 0);
      const needsReview = invalidRows.length > 0 || normalized.blockingIssues.length > 0;

      const result = this.repos.db.transaction(() => {
        const accountId = this.repos.accounts.resolveForStatement(parsed.bank, parsed.kind, parsed.accountHint);
        const documentId = this.repos.documents.insert({
          sha256: sha,
          fileName: req.fileName,
          mimeType: doc.mimeType,
          sizeBytes: req.bytes.byteLength,
          source: req.source,
          status: needsReview ? 'needs_review' : 'imported',
          parserId: parser.id,
          warnings,
        });
        this.repos.documents.insertStatement({
          documentId,
          bank: parsed.bank,
          kind: parsed.kind,
          accountHint: parsed.accountHint,
          periodStart: normalized.periodStart,
          periodEnd: normalized.periodEnd,
          declaredTotalCents: parsed.declaredTotalCents,
          computedTotalCents: normalized.computedTotalCents,
          issues: [...normalized.blockingIssues],
          accountId,
          endBalanceCents: needsReview ? null : normalized.endBalance?.cents ?? null,
          endBalanceDate: needsReview ? null : normalized.endBalance?.date ?? null,
        });
        if (!needsReview && normalized.endBalance) this.repos.accounts.offerStatementBalance(accountId, normalized.endBalance.cents, normalized.endBalance.date);
        if (needsReview) {
          for (const c of normalized.candidates) this.repos.documents.insertReviewItem(toReviewItem(documentId, c));
          return { documentId, inserted: 0, duplicates: 0, review: invalidRows.length || normalized.candidates.length };
        }
        const { inserted, duplicates } = this.insertRows(documentId, normalized.candidates.map(candidateToRow));
        return { documentId, inserted, duplicates, review: 0 };
      });

      if (this.repos.settings.getSettings().keepDocuments) await this.retain(result.documentId, sha, req);
      if (!needsReview) this.accounts?.refreshTransfers();
      this.afterChange();
      this.log.info('import.completed', { documentId: result.documentId, parser: parser.id, inserted: result.inserted, duplicates: result.duplicates, review: needsReview });

      if (needsReview) {
        const reason = normalized.blockingIssues.length
          ? 'Los totales del documento no cuadran con los movimientos leídos.'
          : `${invalidRows.length} movimiento(s) no se pudieron interpretar con seguridad.`;
        return {
          ...base,
          status: 'needs_review',
          documentId: result.documentId,
          reviewCount: result.review,
          message: `${reason} Revisa la importación antes de que cuente en tus estadísticas.`,
        };
      }
      return {
        ...base,
        status: 'imported',
        documentId: result.documentId,
        inserted: result.inserted,
        duplicatesSkipped: result.duplicates,
        message:
          result.duplicates > 0
            ? `${result.inserted} movimientos importados; ${result.duplicates} ya existían y se han omitido.`
            : `${result.inserted} movimientos importados.`,
      };
    } catch (err) {
      if (err instanceof AppError) {
        this.log.warn('import.parse_failed', { code: err.code });
        return { ...base, status: 'failed', errorCode: err.code, message: err.message };
      }
      throw err;
    }
  }

  async importWithPassword(token: string, password: string, remember = false): Promise<ImportOutcome> {
    this.gcPending();
    const p = this.pending.get(token);
    if (!p) throw new AppError('NOT_FOUND', 'La solicitud de contraseña ha caducado. Vuelve a importar el documento.');
    const outcome = await this.importDocument({ bytes: p.bytes, fileName: p.fileName, source: p.source, password });
    if (outcome.status === 'failed' && outcome.errorCode === 'PDF_PASSWORD_INCORRECT') {
      return { ...outcome, status: 'password_required', pendingToken: token };
    }
    this.pending.delete(token);
    if (remember) this.rememberPassword(password);
    p.onImported?.(outcome);
    return outcome;
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
  }

  private async retain(documentId: number, sha: string, req: ImportRequest): Promise<void> {
    try {
      const ext = /\.csv$/i.test(req.fileName) ? 'csv' : 'pdf';
      const path = await this.store.save(sha, ext, req.bytes);
      this.repos.documents.setStoredPath(documentId, path);
    } catch (err) {
      this.log.warn('import.retain_failed', { documentId, err: String((err as Error)?.message ?? err) });
    }
  }

  /** Inserts rows (categorized, deduplicated by fingerprint). Must run inside a DB transaction. */
  private insertRows(documentId: number | null, rows: InsertableRow[]): { inserted: number; duplicates: number } {
    let inserted = 0;
    let duplicates = 0;
    const accountId = documentId === null ? null : this.repos.db.get<{ account_id: number | null }>('SELECT account_id FROM statements WHERE document_id = ?', documentId)?.account_id ?? null;
    const transferCtx = this.accounts?.transferContext() ?? null;
    // The same account imported in two formats (monthly statement and "últimos movimientos", Excel…): a movement of
    // that account with the same date and amount already imported from another document is the same movement.
    const available = new Map<string, number>();
    const alreadyInAccount = (date: string, amount: number): boolean => {
      if (accountId === null) return false;
      const key = `${date}|${amount}`;
      if (!available.has(key)) {
        const n = this.repos.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND date = ? AND amount_cents = ? AND (document_id IS NULL OR document_id <> ?)',
          accountId, date, amount, documentId ?? -1,
        )!.n;
        available.set(key, Number(n));
      }
      const left = available.get(key)!;
      if (left <= 0) return false;
      available.set(key, left - 1);
      return true;
    };
    for (const r of assignFingerprints(rows)) {
      if (alreadyInAccount(r.date, r.amountCents)) {
        duplicates++;
        continue;
      }
      const merchant = r.merchant ?? normalizeMerchant(r.descriptionRaw);
      const merchantId = this.repos.merchants.upsert(merchant.key, merchant.display);
      const ref = transferCtx ? refineTransfer(r.descriptionRaw, r.descriptionNormalized, r.amountCents, transferCtx) : null;
      const refCategory = ref ? this.accounts!.categoryFor(ref) : null;
      const cat = refCategory !== null
        ? { categoryId: refCategory, source: 'HEURISTIC' as const, confidence: 0.9, detail: ref!.detail, ruleId: null }
        : this.categorization.classify(r.descriptionNormalized, merchant, ref?.type ?? r.type);
      const baseType = ref?.type ?? r.type;
      const type = cat.source === 'USER' || refCategory !== null ? this.categorization.alignType(baseType, r.amountCents, this.repos.categories.get(cat.categoryId)) : baseType;
      const id = this.repos.transactions.insert({
        documentId,
        fingerprint: r.fingerprint,
        date: r.date,
        bookingDate: r.bookingDate,
        descriptionRaw: r.descriptionRaw,
        descriptionNormalized: r.descriptionNormalized,
        merchantRaw: merchant.raw,
        merchantId,
        amountCents: r.amountCents,
        type,
        categoryId: cat.categoryId,
        classificationSource: cat.source,
        classificationConfidence: cat.confidence,
        classificationDetail: cat.detail,
        ruleId: cat.ruleId,
        accountId,
        counterAccountId: ref?.counterAccountId ?? null,
      });
      if (id === null) duplicates++;
      else inserted++;
    }
    return { inserted, duplicates };
  }

  /**
   * Emailed documents that a previous version of a parser left in review are discarded (they never counted) and
   * their emails marked for retry, so the next sync downloads and reads them again with the current parser.
   */
  retryEmailReviews(parserIds: string[]): number {
    if (!parserIds.length) return 0;
    const docs = this.repos.db.all<{ id: number }>(
      `SELECT id FROM documents WHERE source = 'email' AND status = 'needs_review' AND parser_id IN (${parserIds.map(() => '?').join(',')})`,
      ...parserIds,
    );
    if (!docs.length) return 0;
    this.repos.db.transaction(() => {
      for (const d of docs) {
        this.repos.db.run("UPDATE email_imports SET status = 'failed', error_code = 'RETRY', document_id = NULL WHERE document_id = ?", d.id);
        this.repos.db.run('DELETE FROM documents WHERE id = ?', d.id);
      }
      this.repos.accounts.pruneEmpty();
    });
    this.log.info('import.retry_email_reviews', { documents: docs.length });
    return docs.length;
  }

  /** Used by demo data: rows that did not come from a parsed file. */
  insertSyntheticDocument(label: string, rows: InsertableRow[]): { documentId: number; inserted: number } {
    // Demo rows: no statement, so no account until the caller assigns one.
    return this.repos.db.transaction(() => {
      const documentId = this.repos.documents.insert({
        sha256: sha256Hex(`demo:${label}`),
        fileName: label,
        mimeType: 'text/csv',
        sizeBytes: 0,
        source: 'demo',
        status: 'imported',
        parserId: 'demo',
        warnings: ['Datos ficticios de demostración.'],
      });
      const { inserted } = this.insertRows(documentId, rows);
      return { documentId, inserted };
    });
  }

  // ───────────── Review ─────────────

  review(documentId: number): ReviewDocument {
    return {
      document: this.repos.documents.get(documentId),
      statementIssues: this.repos.documents.statementIssues(documentId),
      items: this.repos.documents.reviewItems(documentId),
    };
  }

  updateReviewItem(input: UpdateReviewItemInput): ReviewItem {
    const item = this.repos.documents.reviewItemRaw(input.id);
    const doc = this.repos.documents.get(item.documentId);
    if (doc.status !== 'needs_review') throw invalid('Este documento ya no está en revisión.');
    const next = {
      date: input.date ?? item.date,
      description: input.description ?? item.description,
      amountCents: input.amountCents ?? item.amountCents,
      type: input.type ?? item.type,
    };
    const errors = validateReviewRow(next);
    const status = input.status ?? (errors.length === 0 && item.status === 'pending' && (input.date || input.description || input.amountCents !== undefined) ? 'accepted' : item.status);
    if (status === 'accepted' && errors.length > 0) throw invalid(`No se puede aceptar la fila: ${errors.join(' ')}`);
    this.repos.documents.updateReviewItem(input.id, {
      date: next.date ?? undefined,
      description: next.description,
      amountCents: next.amountCents ?? undefined,
      type: next.type,
      status,
      errors,
    });
    return this.repos.documents.reviewItems(item.documentId).find((i) => i.id === input.id)!;
  }

  confirmReview(documentId: number): { inserted: number; duplicatesSkipped: number } {
    const doc = this.repos.documents.get(documentId);
    if (doc.status !== 'needs_review') throw invalid('Este documento no tiene una revisión pendiente.');
    const items = this.repos.documents.reviewItems(documentId);
    const pending = items.filter((i) => i.status === 'pending');
    if (pending.length > 0) throw invalid(`Quedan ${pending.length} fila(s) pendientes: acéptalas tras corregirlas o descártalas.`);
    const rows: InsertableRow[] = items
      .filter((i) => i.status === 'accepted')
      .map((i) => {
        const errors = validateReviewRow(i);
        if (errors.length) throw invalid(`La fila ${i.rowIndex + 1} tiene errores: ${errors.join(' ')}`);
        return {
          date: i.date!,
          bookingDate: null,
          descriptionRaw: i.description,
          descriptionNormalized: normalizeText(i.description),
          merchant: normalizeMerchant(i.description),
          amountCents: i.amountCents!,
          type: i.type,
        };
      });
    const result = this.repos.db.transaction(() => {
      const r = this.insertRows(documentId, rows);
      this.repos.documents.deleteReviewItems(documentId);
      this.repos.documents.setStatus(documentId, 'imported');
      return r;
    });
    this.afterChange();
    this.log.info('import.review_confirmed', { documentId, inserted: result.inserted });
    return { inserted: result.inserted, duplicatesSkipped: result.duplicates };
  }

  async discardDocument(documentId: number): Promise<{ removedTransactions: number }> {
    const doc = this.repos.documents.get(documentId);
    const stored = this.repos.documents.storedPath(documentId);
    const removed = doc.txCount;
    this.repos.db.transaction(() => this.repos.documents.delete(documentId));
    if (stored) await this.store.remove(stored).catch(() => undefined);
    this.afterChange();
    this.log.info('import.document_discarded', { documentId });
    return { removedTransactions: removed };
  }

  /**
   * Deletes an account with everything imported into it (its documents and their movements). Manual accounts are
   * simply removed; demo accounts are removed with the demo data. Transfers to it lose their destination.
   */
  async deleteAccount(accountId: number): Promise<{ removedTransactions: number; removedDocuments: number }> {
    const account = this.repos.accounts.get(accountId);
    if (account.name.endsWith(' (demo)')) {
      throw new AppError('VALIDATION', 'Es una cuenta de los datos de demostración: quítala con «Eliminar datos de demostración» (Ajustes → Privacidad y datos) o desde el botón de esta cuenta.');
    }
    if (account.sourceKind === 'manual') {
      this.repos.accounts.delete(accountId);
      this.accounts?.refreshTransfers();
      this.afterChange();
      return { removedTransactions: 0, removedDocuments: 0 };
    }
    const docIds = this.repos.db
      .all<{ id: number }>(
        `SELECT document_id AS id FROM transactions WHERE account_id = ? AND document_id IS NOT NULL
         UNION SELECT document_id AS id FROM statements WHERE account_id = ? AND document_id IS NOT NULL`,
        accountId, accountId,
      )
      .map((r) => r.id);
    let removedTransactions = 0;
    for (const id of docIds) {
      const doc = this.repos.documents.get(id);
      const stored = this.repos.documents.storedPath(id);
      removedTransactions += doc.txCount;
      this.repos.db.transaction(() => this.repos.documents.delete(id));
      if (stored) await this.store.remove(stored).catch(() => undefined);
    }
    this.repos.db.transaction(() => {
      // Movements of this account without a document (none today, but never leave orphans behind).
      removedTransactions += this.repos.db.run('DELETE FROM transactions WHERE account_id = ?', accountId).changes;
      this.repos.db.run('DELETE FROM accounts WHERE id = ?', accountId);
      this.repos.accounts.pruneEmpty();
    });
    this.accounts?.refreshTransfers();
    this.afterChange();
    this.log.info('import.account_deleted', { accountId, documents: docIds.length });
    return { removedTransactions, removedDocuments: docIds.length };
  }

  async deleteRetainedDocuments(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const d of this.repos.documents.allStoredPaths()) {
      await this.store.remove(d.path).catch(() => undefined);
      this.repos.documents.setStoredPath(d.id, null);
      deleted++;
    }
    return { deleted };
  }
}

function candidateToRow(c: CandidateTransaction): InsertableRow {
  return {
    date: c.date!,
    bookingDate: c.bookingDate,
    descriptionRaw: c.descriptionRaw,
    descriptionNormalized: c.descriptionNormalized,
    merchant: c.merchant,
    amountCents: c.amountCents!,
    type: c.type,
  };
}

function toReviewItem(documentId: number, c: CandidateTransaction) {
  return {
    documentId,
    rowIndex: c.rowIndex,
    rawText: c.rawText,
    date: c.date,
    bookingDate: c.bookingDate,
    description: c.descriptionRaw,
    amountCents: c.amountCents,
    type: c.type,
    errors: c.errors,
    status: c.errors.length === 0 ? ('accepted' as const) : ('pending' as const),
  };
}

export function validateReviewRow(r: { date: string | null; description: string; amountCents: number | null }): string[] {
  const errors: string[] = [];
  if (!r.date || !isIsoDate(r.date)) errors.push('Fecha no válida.');
  if (!r.description.trim()) errors.push('Descripción vacía.');
  if (r.amountCents === null || !Number.isSafeInteger(r.amountCents) || r.amountCents === 0) errors.push('Importe no válido.');
  return errors;
}
