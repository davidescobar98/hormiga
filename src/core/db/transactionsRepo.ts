import type {
  ClassificationSource, DocumentSource, RecurringStatus, RuleMatchType, TransactionDTO, TransactionDetail,
  TransactionPage, TransactionQuery, TransactionType,
} from '../../shared/types';
import { normalizeText } from '../domain/merchant';
import { notFound } from '../errors';
import type { Database, SqlParam } from './database';

export interface NewTransaction {
  documentId: number | null;
  fingerprint: string;
  date: string;
  bookingDate: string | null;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchantRaw: string | null;
  merchantId: number | null;
  amountCents: number;
  type: TransactionType;
  categoryId: number;
  classificationSource: ClassificationSource;
  classificationConfidence: number;
  classificationDetail: string | null;
  ruleId: number | null;
}

interface TxRow {
  id: number;
  document_id: number | null;
  date: string;
  booking_date: string | null;
  description_raw: string;
  description_normalized: string;
  merchant_raw: string | null;
  merchant_id: number | null;
  merchant_name: string | null;
  amount_cents: number;
  currency: string;
  type: TransactionType;
  category_id: number;
  category_name: string;
  category_color: string;
  classification_source: ClassificationSource;
  classification_confidence: number;
  classification_detail: string | null;
  category_locked: number;
  is_excluded: number;
  notes: string | null;
  recurring_status: RecurringStatus | null;
  doc_source: DocumentSource | null;
  created_at: string;
  updated_at: string;
  rule_id: number | null;
}

const SELECT = `
  SELECT t.*, c.name AS category_name, c.color AS category_color, m.display_name AS merchant_name,
         r.status AS recurring_status, d.source AS doc_source
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  LEFT JOIN merchants m ON m.id = t.merchant_id
  LEFT JOIN recurring_expenses r ON r.merchant_id = t.merchant_id
  LEFT JOIN documents d ON d.id = t.document_id`;

const SORTS: Record<string, string> = {
  date: 't.date',
  amount: 't.amount_cents',
  merchant: "COALESCE(m.display_name, t.description_normalized) COLLATE NOCASE",
  category: 'c.name COLLATE NOCASE',
};

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toDto(r: TxRow): TransactionDTO {
  return {
    id: r.id,
    documentId: r.document_id,
    date: r.date,
    bookingDate: r.booking_date,
    descriptionRaw: r.description_raw,
    descriptionNormalized: r.description_normalized,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    merchantRaw: r.merchant_raw,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    type: r.type,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryColor: r.category_color,
    classificationSource: r.classification_source,
    classificationConfidence: r.classification_confidence,
    classificationDetail: r.classification_detail,
    categoryLocked: r.category_locked === 1,
    isExcluded: r.is_excluded === 1,
    notes: r.notes,
    recurringStatus: r.recurring_status,
    source: r.doc_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class TransactionsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  /** Inserts a movement unless an identical fingerprint exists. Returns the new id or null for duplicates. */
  insert(t: NewTransaction): number | null {
    const ts = this.now().toISOString();
    const r = this.db.run(
      `INSERT INTO transactions(document_id, fingerprint, date, booking_date, description_raw, description_normalized,
         merchant_raw, merchant_id, amount_cents, currency, type, category_id, classification_source,
         classification_confidence, classification_detail, rule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO NOTHING`,
      t.documentId, t.fingerprint, t.date, t.bookingDate, t.descriptionRaw, t.descriptionNormalized, t.merchantRaw,
      t.merchantId, t.amountCents, t.type, t.categoryId, t.classificationSource, t.classificationConfidence,
      t.classificationDetail, t.ruleId, ts, ts,
    );
    return r.changes > 0 ? r.lastInsertRowid : null;
  }

  list(q: TransactionQuery): TransactionPage {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (q.onlyExcluded) where.push('t.is_excluded = 1');
    else if (!q.includeExcluded) where.push('t.is_excluded = 0');
    if (q.categoryId !== undefined) {
      where.push('t.category_id = ?');
      params.push(q.categoryId);
    }
    if (q.uncategorizedOnly) where.push("t.classification_source = 'UNKNOWN'");
    if (q.type) {
      where.push('t.type = ?');
      params.push(q.type);
    }
    if (q.merchantId !== undefined) {
      where.push('t.merchant_id = ?');
      params.push(q.merchantId);
    }
    if (q.from) {
      where.push('t.date >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('t.date <= ?');
      params.push(q.to);
    }
    if (q.search && q.search.trim()) {
      const normalized = `%${escapeLike(normalizeText(q.search))}%`;
      const plain = `%${escapeLike(q.search.trim())}%`;
      where.push("(t.description_normalized LIKE ? ESCAPE '\\' OR m.display_name LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
      params.push(normalized, plain, plain, plain);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sort = SORTS[q.sort ?? 'date'] ?? SORTS.date!;
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const items = this.db.all<TxRow>(`${SELECT} ${whereSql} ORDER BY ${sort} ${dir}, t.id ${dir} LIMIT ? OFFSET ?`, ...params, limit, offset).map(toDto);
    const agg = this.db.get<{ n: number; net: number | null }>(
      `SELECT COUNT(*) AS n, SUM(t.amount_cents) AS net FROM transactions t JOIN categories c ON c.id = t.category_id
       LEFT JOIN merchants m ON m.id = t.merchant_id ${whereSql}`,
      ...params,
    )!;
    return { items, total: Number(agg.n), netCents: Number(agg.net ?? 0) };
  }

  get(id: number): TransactionDetail {
    const row = this.db.get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound('El movimiento');
    const base = toDto(row);
    const doc = row.document_id
      ? this.db.get<{ id: number; file_name: string; source: DocumentSource; imported_at: string; parser_id: string | null; period_start: string | null; period_end: string | null; subject: string | null }>(
          `SELECT d.id, d.file_name, d.source, d.imported_at, d.parser_id, s.period_start, s.period_end,
                  (SELECT e.subject FROM email_imports e WHERE e.document_id = d.id LIMIT 1) AS subject
           FROM documents d LEFT JOIN statements s ON s.document_id = d.id WHERE d.id = ?`,
          row.document_id,
        )
      : undefined;
    const rule = row.rule_id
      ? this.db.get<{ id: number; match_type: RuleMatchType; pattern: string }>('SELECT id, match_type, pattern FROM categorization_rules WHERE id = ?', row.rule_id)
      : undefined;
    return {
      ...base,
      document: doc
        ? { id: doc.id, fileName: doc.file_name, source: doc.source, importedAt: doc.imported_at, parserId: doc.parser_id, periodStart: doc.period_start, periodEnd: doc.period_end, emailSubject: doc.subject }
        : null,
      rule: rule ? { id: rule.id, matchType: rule.match_type, pattern: rule.pattern } : null,
    };
  }

  setCategory(id: number, categoryId: number, source: ClassificationSource, confidence: number, detail: string | null, ruleId: number | null, locked: boolean): void {
    this.db.run(
      `UPDATE transactions SET category_id = ?, classification_source = ?, classification_confidence = ?, classification_detail = ?,
         rule_id = ?, category_locked = ?, updated_at = ? WHERE id = ?`,
      categoryId, source, confidence, detail, ruleId, locked, this.now().toISOString(), id,
    );
  }

  setFields(id: number, fields: { merchantId?: number; type?: TransactionType; isExcluded?: boolean; notes?: string | null }): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    if (fields.merchantId !== undefined) {
      sets.push('merchant_id = ?');
      params.push(fields.merchantId);
    }
    if (fields.type !== undefined) {
      sets.push('type = ?');
      params.push(fields.type);
    }
    if (fields.isExcluded !== undefined) {
      sets.push('is_excluded = ?');
      params.push(fields.isExcluded);
    }
    if (fields.notes !== undefined) {
      sets.push('notes = ?');
      params.push(fields.notes);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(this.now().toISOString());
    this.db.run(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Movements eligible for automatic re-categorization (not manually fixed by the user). */
  listUnlocked(filter: { merchantKey?: string; contains?: string } = {}): { id: number; descriptionNormalized: string; merchantKey: string | null; type: TransactionType; categoryId: number; merchantRaw: string | null; amountCents: number }[] {
    const where = ['t.category_locked = 0'];
    const params: SqlParam[] = [];
    if (filter.merchantKey) {
      where.push('m.key = ?');
      params.push(filter.merchantKey);
    }
    if (filter.contains) {
      where.push("(' ' || t.description_normalized || ' ') LIKE ? ESCAPE '\\'");
      params.push(`% ${escapeLike(filter.contains)} %`);
    }
    return this.db
      .all<{ id: number; description_normalized: string; key: string | null; type: TransactionType; category_id: number; merchant_raw: string | null; amount_cents: number }>(
        `SELECT t.id, t.description_normalized, m.key, t.type, t.category_id, t.merchant_raw, t.amount_cents FROM transactions t
         LEFT JOIN merchants m ON m.id = t.merchant_id WHERE ${where.join(' AND ')}`,
        ...params,
      )
      .map((r) => ({ id: r.id, descriptionNormalized: r.description_normalized, merchantKey: r.key, type: r.type, categoryId: r.category_id, merchantRaw: r.merchant_raw, amountCents: Number(r.amount_cents) }));
  }

  countByMerchantExcept(merchantId: number, exceptId: number, categoryId: number): number {
    return Number(
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM transactions WHERE merchant_id = ? AND id <> ? AND category_id <> ? AND category_locked = 0',
        merchantId, exceptId, categoryId,
      )!.n,
    );
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')!.n);
  }

  uncategorizedCount(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE classification_source = 'UNKNOWN' AND is_excluded = 0")!.n);
  }

  /** Every movement, oldest first, for exports. */
  exportAll(): TransactionDTO[] {
    return this.db.all<TxRow>(`${SELECT} ORDER BY t.date, t.id`).map(toDto);
  }
}
