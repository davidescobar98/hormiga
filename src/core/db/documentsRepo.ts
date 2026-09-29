import type { DocumentDTO, DocumentSource, DocumentStatus, ReviewItem, ReviewItemStatus, TransactionType } from '../../shared/types';
import { notFound } from '../errors';
import type { Database, SqlParam } from './database';

interface DocRow {
  id: number;
  sha256: string;
  file_name: string;
  source: DocumentSource;
  status: DocumentStatus;
  parser_id: string | null;
  stored_path: string | null;
  warnings: string;
  imported_at: string;
  kind: string | null;
  bank: string | null;
  period_start: string | null;
  period_end: string | null;
  tx_count: number;
  review_count: number;
  subject: string | null;
}

const DOC_SELECT = `
  SELECT d.*, s.kind, s.bank, s.period_start, s.period_end,
         (SELECT COUNT(*) FROM transactions t WHERE t.document_id = d.id) AS tx_count,
         (SELECT COUNT(*) FROM import_review_items i WHERE i.document_id = d.id AND i.status = 'pending') AS review_count,
         (SELECT e.subject FROM email_imports e WHERE e.document_id = d.id LIMIT 1) AS subject
  FROM documents d LEFT JOIN statements s ON s.document_id = d.id`;

function toDoc(r: DocRow): DocumentDTO {
  return {
    id: r.id,
    fileName: r.file_name,
    source: r.source,
    sha256Short: r.sha256.slice(0, 12),
    importedAt: r.imported_at,
    status: r.status,
    parserId: r.parser_id,
    documentKind: r.kind,
    bank: r.bank,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    txCount: Number(r.tx_count),
    reviewCount: Number(r.review_count),
    retained: !!r.stored_path,
    warnings: safeJsonArray(r.warnings),
    emailSubject: r.subject,
  };
}

export function safeJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface NewDocument {
  sha256: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  source: DocumentSource;
  status: DocumentStatus;
  parserId: string | null;
  warnings: string[];
}

export interface NewStatement {
  documentId: number;
  bank: string;
  kind: string;
  accountHint: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  declaredTotalCents: number | null;
  computedTotalCents: number;
  issues: string[];
  accountId?: number | null;
  endBalanceCents?: number | null;
  endBalanceDate?: string | null;
}

export interface NewReviewItem {
  documentId: number;
  rowIndex: number;
  rawText: string;
  date: string | null;
  bookingDate: string | null;
  description: string;
  amountCents: number | null;
  type: TransactionType;
  errors: string[];
  status: ReviewItemStatus;
}

interface ReviewRow {
  id: number;
  document_id: number;
  row_index: number;
  raw_text: string;
  date: string | null;
  booking_date: string | null;
  description: string;
  amount_cents: number | null;
  type: TransactionType;
  errors: string;
  status: ReviewItemStatus;
}

const toReview = (r: ReviewRow): ReviewItem => ({
  id: r.id,
  documentId: r.document_id,
  rowIndex: r.row_index,
  rawText: r.raw_text,
  date: r.date,
  description: r.description,
  amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
  type: r.type,
  errors: safeJsonArray(r.errors),
  status: r.status,
});

export class DocumentsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  findByHash(sha256: string): { id: number; fileName: string; importedAt: string; status: DocumentStatus } | null {
    const r = this.db.get<{ id: number; file_name: string; imported_at: string; status: DocumentStatus }>(
      'SELECT id, file_name, imported_at, status FROM documents WHERE sha256 = ?', sha256,
    );
    return r ? { id: r.id, fileName: r.file_name, importedAt: r.imported_at, status: r.status } : null;
  }

  insert(d: NewDocument): number {
    return this.db.run(
      `INSERT INTO documents(sha256, file_name, mime_type, size_bytes, source, status, parser_id, warnings, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.sha256, d.fileName, d.mimeType, d.sizeBytes, d.source, d.status, d.parserId, JSON.stringify(d.warnings), this.now().toISOString(),
    ).lastInsertRowid;
  }

  insertStatement(s: NewStatement): number {
    return this.db.run(
      `INSERT INTO statements(document_id, bank, kind, account_hint, period_start, period_end, declared_total_cents,
         computed_total_cents, issues, created_at, account_id, end_balance_cents, end_balance_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.documentId, s.bank, s.kind, s.accountHint, s.periodStart, s.periodEnd, s.declaredTotalCents, s.computedTotalCents,
      JSON.stringify(s.issues), this.now().toISOString(), s.accountId ?? null, s.endBalanceCents ?? null, s.endBalanceDate ?? null,
    ).lastInsertRowid;
  }

  findSamePeriod(bank: string, accountHint: string | null, start: string | null, end: string | null): { documentId: number; fileName: string } | null {
    if (!start || !end) return null;
    const r = this.db.get<{ document_id: number; file_name: string }>(
      `SELECT s.document_id, d.file_name FROM statements s JOIN documents d ON d.id = s.document_id
       WHERE s.bank = ? AND COALESCE(s.account_hint, '') = COALESCE(?, '') AND s.period_start = ? AND s.period_end = ?
         AND d.status <> 'discarded' LIMIT 1`,
      bank, accountHint, start, end,
    );
    return r ? { documentId: r.document_id, fileName: r.file_name } : null;
  }

  statementIssues(documentId: number): string[] {
    const r = this.db.get<{ issues: string }>('SELECT issues FROM statements WHERE document_id = ?', documentId);
    return safeJsonArray(r?.issues);
  }

  list(): DocumentDTO[] {
    return this.db.all<DocRow>(`${DOC_SELECT} WHERE d.status <> 'discarded' ORDER BY d.imported_at DESC, d.id DESC`).map(toDoc);
  }

  get(id: number): DocumentDTO {
    const r = this.db.get<DocRow>(`${DOC_SELECT} WHERE d.id = ?`, id);
    if (!r) throw notFound('El documento');
    return toDoc(r);
  }

  storedPath(id: number): string | null {
    return this.db.get<{ stored_path: string | null }>('SELECT stored_path FROM documents WHERE id = ?', id)?.stored_path ?? null;
  }

  setStoredPath(id: number, path: string | null): void {
    this.db.run('UPDATE documents SET stored_path = ? WHERE id = ?', path, id);
  }

  allStoredPaths(): { id: number; path: string }[] {
    return this.db.all<{ id: number; stored_path: string }>('SELECT id, stored_path FROM documents WHERE stored_path IS NOT NULL').map((r) => ({ id: r.id, path: r.stored_path }));
  }

  setStatus(id: number, status: DocumentStatus): void {
    this.db.run('UPDATE documents SET status = ? WHERE id = ?', status, id);
  }

  delete(id: number): void {
    this.db.run('DELETE FROM documents WHERE id = ?', id);
  }

  lastImported(): { fileName: string; importedAt: string; source: DocumentSource } | null {
    const r = this.db.get<{ file_name: string; imported_at: string; source: DocumentSource }>(
      "SELECT file_name, imported_at, source FROM documents WHERE status = 'imported' AND source <> 'demo' ORDER BY imported_at DESC, id DESC LIMIT 1",
    );
    return r ? { fileName: r.file_name, importedAt: r.imported_at, source: r.source } : null;
  }

  counts(): { documents: number; retained: number; demo: number } {
    const r = this.db.get<{ n: number; retained: number; demo: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN stored_path IS NOT NULL THEN 1 ELSE 0 END) AS retained,
              SUM(CASE WHEN source = 'demo' THEN 1 ELSE 0 END) AS demo FROM documents`,
    )!;
    return { documents: Number(r.n), retained: Number(r.retained ?? 0), demo: Number(r.demo ?? 0) };
  }

  demoDocumentIds(): number[] {
    return this.db.all<{ id: number }>("SELECT id FROM documents WHERE source = 'demo'").map((r) => r.id);
  }

  // ── Review items ──

  insertReviewItem(i: NewReviewItem): void {
    this.db.run(
      `INSERT INTO import_review_items(document_id, row_index, raw_text, date, booking_date, description, amount_cents, type, errors, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      i.documentId, i.rowIndex, i.rawText, i.date, i.bookingDate, i.description, i.amountCents, i.type, JSON.stringify(i.errors), i.status,
    );
  }

  reviewItems(documentId: number): ReviewItem[] {
    return this.db.all<ReviewRow>('SELECT * FROM import_review_items WHERE document_id = ? ORDER BY row_index', documentId).map(toReview);
  }

  reviewItemRaw(id: number): (ReviewItem & { bookingDate: string | null }) {
    const r = this.db.get<ReviewRow>('SELECT * FROM import_review_items WHERE id = ?', id);
    if (!r) throw notFound('La fila de revisión');
    return { ...toReview(r), bookingDate: r.booking_date };
  }

  updateReviewItem(id: number, fields: { date?: string; description?: string; amountCents?: number; type?: TransactionType; status?: ReviewItemStatus; errors?: string[] }): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    const map: [keyof typeof fields, string][] = [['date', 'date'], ['description', 'description'], ['amountCents', 'amount_cents'], ['type', 'type'], ['status', 'status']];
    for (const [k, col] of map) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(fields[k] as SqlParam);
      }
    }
    if (fields.errors !== undefined) {
      sets.push('errors = ?');
      params.push(JSON.stringify(fields.errors));
    }
    if (sets.length) this.db.run(`UPDATE import_review_items SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  deleteReviewItems(documentId: number): void {
    this.db.run('DELETE FROM import_review_items WHERE document_id = ?', documentId);
  }

  reviewSummary(): { documents: number; items: number } {
    const r = this.db.get<{ docs: number; items: number }>(
      `SELECT COUNT(DISTINCT d.id) AS docs, COUNT(i.id) AS items FROM documents d
       LEFT JOIN import_review_items i ON i.document_id = d.id AND i.status = 'pending'
       WHERE d.status = 'needs_review'`,
    )!;
    return { documents: Number(r.docs), items: Number(r.items) };
  }
}

export type EmailImportStatus = 'imported' | 'duplicate' | 'needs_review' | 'password_required' | 'failed' | 'not_statement' | 'skipped';

export class EmailImportsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  record(e: {
    provider: string; messageId: string; attachmentKey: string; subject: string | null; sender: string | null;
    receivedAt: string | null; scoreBp: number; status: EmailImportStatus; errorCode: string | null; documentId: number | null;
  }): void {
    this.db.run(
      `INSERT INTO email_imports(provider, message_id, attachment_key, subject, sender, received_at, score_bp, status, error_code, document_id, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, message_id, attachment_key) DO UPDATE SET status = excluded.status, error_code = excluded.error_code,
         document_id = COALESCE(excluded.document_id, email_imports.document_id), processed_at = excluded.processed_at`,
      e.provider, e.messageId, e.attachmentKey, e.subject, e.sender, e.receivedAt, e.scoreBp, e.status, e.errorCode, e.documentId, this.now().toISOString(),
    );
  }

  /** Message ids fully handled (anything except retryable failures / pending passwords). */
  statusByMessage(provider: string): Map<string, EmailImportStatus> {
    const rows = this.db.all<{ message_id: string; status: EmailImportStatus }>('SELECT message_id, status FROM email_imports WHERE provider = ?', provider);
    const map = new Map<string, EmailImportStatus>();
    const rank: Record<EmailImportStatus, number> = { failed: 0, password_required: 1, skipped: 2, not_statement: 3, needs_review: 4, duplicate: 5, imported: 6 };
    for (const r of rows) {
      const prev = map.get(r.message_id);
      if (!prev || rank[r.status] > rank[prev]) map.set(r.message_id, r.status);
    }
    return map;
  }

  count(provider: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_imports WHERE provider = ?', provider)!.n);
  }

  pendingPasswords(provider: string): { messageId: string; subject: string | null }[] {
    return this.db
      .all<{ message_id: string; subject: string | null }>("SELECT DISTINCT message_id, subject FROM email_imports WHERE provider = ? AND status = 'password_required'", provider)
      .map((r) => ({ messageId: r.message_id, subject: r.subject }));
  }

  getMeta(provider: string, messageId: string): { subject: string | null; sender: string | null; receivedAt: string | null; scoreBp: number } | null {
    const r = this.db.get<{ subject: string | null; sender: string | null; received_at: string | null; score_bp: number }>(
      'SELECT subject, sender, received_at, score_bp FROM email_imports WHERE provider = ? AND message_id = ? LIMIT 1', provider, messageId,
    );
    return r ? { subject: r.subject, sender: r.sender, receivedAt: r.received_at, scoreBp: r.score_bp } : null;
  }
}
