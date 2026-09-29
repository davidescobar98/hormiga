import type {
  IncomeDTO, IncomeInput, IncomeKind, Recommendation, RecurringDTO, RecurringFrequency, RecurringStatus, SavingsGoalDTO,
} from '../../shared/types';
import type { YearMonth } from '../../shared/dates';
import { monthlyEquivalent } from '../domain/recurring';
import { notFound } from '../errors';
import type { Database } from './database';

interface IncomeRow {
  id: number;
  kind: IncomeKind;
  label: string;
  amount_cents: number;
  start_month: string;
  end_month: string | null;
}
const toIncome = (r: IncomeRow): IncomeDTO => ({
  id: r.id, kind: r.kind, label: r.label, amountCents: Number(r.amount_cents), startMonth: r.start_month, endMonth: r.end_month,
});

export class IncomeRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  list(): IncomeDTO[] {
    return this.db.all<IncomeRow>('SELECT * FROM income ORDER BY start_month DESC, id DESC').map(toIncome);
  }

  save(input: IncomeInput): IncomeDTO {
    const ts = this.now().toISOString();
    const endMonth = input.kind === 'extraordinary' ? input.startMonth : input.endMonth;
    if (input.id) {
      const r = this.db.run(
        'UPDATE income SET kind = ?, label = ?, amount_cents = ?, start_month = ?, end_month = ?, updated_at = ? WHERE id = ?',
        input.kind, input.label.trim(), input.amountCents, input.startMonth, endMonth, ts, input.id,
      );
      if (r.changes === 0) throw notFound('El ingreso');
      return toIncome(this.db.get<IncomeRow>('SELECT * FROM income WHERE id = ?', input.id)!);
    }
    const id = this.db.run(
      'INSERT INTO income(kind, label, amount_cents, start_month, end_month, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.kind, input.label.trim(), input.amountCents, input.startMonth, endMonth, ts, ts,
    ).lastInsertRowid;
    return toIncome(this.db.get<IncomeRow>('SELECT * FROM income WHERE id = ?', id)!);
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM income WHERE id = ?', id).changes > 0;
  }
}

export class GoalsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  /** Goal in force for a month (latest effective_from ≤ month). */
  forMonth(month: YearMonth): SavingsGoalDTO | null {
    const r = this.db.get<{ mode: 'amount' | 'percent'; amount_cents: number | null; percent_bp: number | null; effective_from: string }>(
      'SELECT mode, amount_cents, percent_bp, effective_from FROM savings_goals WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
      month,
    );
    return r ? { mode: r.mode, amountCents: r.amount_cents, percentBp: r.percent_bp, effectiveFrom: r.effective_from } : null;
  }

  latest(): SavingsGoalDTO | null {
    const r = this.db.get<{ mode: 'amount' | 'percent'; amount_cents: number | null; percent_bp: number | null; effective_from: string }>(
      'SELECT mode, amount_cents, percent_bp, effective_from FROM savings_goals ORDER BY effective_from DESC LIMIT 1',
    );
    return r ? { mode: r.mode, amountCents: r.amount_cents, percentBp: r.percent_bp, effectiveFrom: r.effective_from } : null;
  }

  /** A goal set "from month X" replaces the one starting that same month; earlier months keep their goal. */
  set(goal: SavingsGoalDTO | null, currentMonth: YearMonth): SavingsGoalDTO | null {
    if (goal === null) {
      this.db.run('DELETE FROM savings_goals');
      return null;
    }
    this.db.run(
      `INSERT INTO savings_goals(mode, amount_cents, percent_bp, effective_from, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(effective_from) DO UPDATE SET mode = excluded.mode, amount_cents = excluded.amount_cents, percent_bp = excluded.percent_bp`,
      goal.mode, goal.mode === 'amount' ? goal.amountCents : null, goal.mode === 'percent' ? goal.percentBp : null,
      goal.effectiveFrom || currentMonth, this.now().toISOString(),
    );
    // Later goals would shadow the new one; the most recent edit wins.
    this.db.run('DELETE FROM savings_goals WHERE effective_from > ?', goal.effectiveFrom || currentMonth);
    return this.latest();
  }
}

interface RecurringRow {
  id: number;
  merchant_id: number;
  merchant_name: string;
  category_id: number;
  category_name: string;
  status: RecurringStatus;
  frequency: RecurringFrequency;
  kind: 'subscription' | 'fixed';
  average_cents: number;
  last_date: string;
  next_date: string;
  occurrences: number;
  confidence_bp: number;
  reason: string;
}

function toRecurring(r: RecurringRow): RecurringDTO {
  const monthly = monthlyEquivalent(Number(r.average_cents), r.frequency);
  return {
    id: r.id,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    status: r.status,
    frequency: r.frequency,
    kind: r.kind,
    averageCents: Number(r.average_cents),
    lastDate: r.last_date,
    nextDate: r.next_date,
    occurrences: r.occurrences,
    monthlyCents: monthly,
    annualCents: monthly * 12,
    confidenceBp: r.confidence_bp,
    reason: r.reason,
  };
}

export interface RecurringUpsert {
  merchantId: number;
  frequency: RecurringFrequency;
  kind: 'subscription' | 'fixed';
  averageCents: number;
  lastDate: string;
  nextDate: string;
  occurrences: number;
  confidenceBp: number;
  reason: string;
}

export class RecurringRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  list(): RecurringDTO[] {
    return this.db
      .all<RecurringRow>(
        `SELECT r.*, m.display_name AS merchant_name,
                COALESCE((SELECT t.category_id FROM transactions t WHERE t.merchant_id = r.merchant_id ORDER BY t.date DESC LIMIT 1), 0) AS category_id,
                COALESCE((SELECT c.name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.merchant_id = r.merchant_id ORDER BY t.date DESC LIMIT 1), '') AS category_name
         FROM recurring_expenses r JOIN merchants m ON m.id = r.merchant_id
         ORDER BY CASE r.status WHEN 'confirmed' THEN 0 WHEN 'probable' THEN 1 ELSE 2 END, r.average_cents DESC`,
      )
      .map(toRecurring);
  }

  get(id: number): RecurringDTO {
    const found = this.list().find((r) => r.id === id);
    if (!found) throw notFound('El gasto recurrente');
    return found;
  }

  /**
   * Replaces automatic detections. Rows the user confirmed/dismissed keep their status;
   * automatic "probable" rows that are no longer detected are removed.
   */
  replaceDetections(detections: RecurringUpsert[]): void {
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      const detectedIds = new Set(detections.map((d) => d.merchantId));
      const existing = this.db.all<{ merchant_id: number; user_set: number }>('SELECT merchant_id, user_set FROM recurring_expenses');
      for (const e of existing) {
        if (!detectedIds.has(e.merchant_id) && e.user_set === 0) this.db.run('DELETE FROM recurring_expenses WHERE merchant_id = ?', e.merchant_id);
      }
      for (const d of detections) {
        this.db.run(
          `INSERT INTO recurring_expenses(merchant_id, status, frequency, kind, average_cents, last_date, next_date, occurrences, confidence_bp, reason, user_set, detected_at, updated_at)
           VALUES (?, 'probable', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(merchant_id) DO UPDATE SET frequency = excluded.frequency, kind = excluded.kind, average_cents = excluded.average_cents,
             last_date = excluded.last_date, next_date = excluded.next_date, occurrences = excluded.occurrences,
             confidence_bp = excluded.confidence_bp, reason = excluded.reason, updated_at = excluded.updated_at`,
          d.merchantId, d.frequency, d.kind, d.averageCents, d.lastDate, d.nextDate, d.occurrences, d.confidenceBp, d.reason, ts, ts,
        );
      }
    });
  }

  setStatus(id: number, status: RecurringStatus): void {
    const r = this.db.run('UPDATE recurring_expenses SET status = ?, user_set = 1, updated_at = ? WHERE id = ?', status, this.now().toISOString(), id);
    if (r.changes === 0) throw notFound('El gasto recurrente');
  }
}

export class RecommendationsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  dismissedKeys(): Set<string> {
    return new Set(this.db.all<{ key: string }>("SELECT key FROM recommendations WHERE status = 'dismissed'").map((r) => r.key));
  }

  /** Stores the latest generated set; dismissed keys are preserved. */
  replaceActive(recs: Recommendation[]): void {
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      this.db.run("DELETE FROM recommendations WHERE status = 'active'");
      for (const r of recs) {
        this.db.run(
          `INSERT INTO recommendations(key, type, payload, status, generated_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
           ON CONFLICT(key) DO NOTHING`,
          r.key, r.type, JSON.stringify(r), ts, ts,
        );
      }
    });
  }

  dismiss(key: string): boolean {
    const ts = this.now().toISOString();
    const r = this.db.run("UPDATE recommendations SET status = 'dismissed', updated_at = ? WHERE key = ?", ts, key);
    return r.changes > 0;
  }
}
