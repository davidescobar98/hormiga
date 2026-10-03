import type { AlertDTO, AlertKind, BudgetsOverview } from '../../shared/types';
import { addDays, addMonths, firstDayOfMonth, lastDayOfMonth, monthOf, todayIso, type IsoDate, type YearMonth } from '../../shared/dates';
import { formatCents, formatBp } from '../../shared/money';
import { budgetLine, suggestBudget } from '../domain/budgets';
import { AppError } from '../errors';
import type { AnalyticsService } from './analyticsService';
import type { Repos } from './context';

const SPEND = "('expense','fee','cash_withdrawal','refund')";

export interface NewAlert {
  key: string;
  kind: AlertKind;
  title: string;
  body: string;
  page: string;
  section?: string | null;
}

/** Monthly budgets per category and the alerts derived from your data (shown in the app; optionally notified). */
export class BudgetsService {
  constructor(private readonly repos: Repos, private readonly analytics: AnalyticsService, private readonly now: () => Date) {}

  /** Set by the composition root: counterparties still to review. */
  pendingTransferReviews: () => number = () => 0;
  /** Set by the composition root: buy/sell signals on stocks. */
  stockAlerts: () => NewAlert[] = () => [];

  private today(): IsoDate {
    return todayIso(this.now());
  }

  private spentByCategory(month: YearMonth): Map<number, number> {
    return new Map(
      this.repos.db
        .all<{ category_id: number; net: number }>(
          `SELECT t.category_id, -SUM(t.amount_cents) AS net FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ${SPEND} AND t.date >= ? AND t.date <= ?
           GROUP BY t.category_id`,
          firstDayOfMonth(month), lastDayOfMonth(month),
        )
        .map((r) => [r.category_id, Math.max(0, Number(r.net))] as const),
    );
  }

  overview(requested?: YearMonth): BudgetsOverview {
    const today = this.today();
    const month = requested ?? monthOf(today);
    const spent = this.spentByCategory(month);
    // Averages from the 3 complete months before the one shown.
    const history = [1, 2, 3].map((k) => this.spentByCategory(addMonths(month, -k)));
    const avgOf = (id: number) => {
      const values = history.map((h) => h.get(id) ?? 0);
      return values.some((v) => v > 0) ? Math.round(values.reduce((t, v) => t + v, 0) / values.length) : null;
    };
    const suggestOf = (id: number) => suggestBudget(history.map((h) => h.get(id) ?? 0));
    const categories = new Map(this.repos.categories.list().map((c) => [c.id, c]));
    const budgets = this.repos.db.all<{ category_id: number; amount_cents: number }>('SELECT category_id, amount_cents FROM budgets');
    const lines = budgets
      .filter((b) => categories.has(b.category_id))
      .map((b) => {
        const c = categories.get(b.category_id)!;
        return budgetLine({
          categoryId: c.id, name: c.name, color: c.color, limitCents: Number(b.amount_cents), spentCents: spent.get(c.id) ?? 0,
          month, today, suggestedCents: suggestOf(c.id), averageCents: avgOf(c.id),
        });
      })
      .sort((a, b) => b.usedBp - a.usedBp);
    const budgeted = new Set(lines.map((l) => l.categoryId));
    const suggestions = [...categories.values()]
      .filter((c) => !c.excludedFromSpending && !budgeted.has(c.id) && c.kind !== 'neutral')
      .map((c) => ({ c, avg: avgOf(c.id), sug: suggestOf(c.id) }))
      .filter((x): x is { c: typeof x.c; avg: number; sug: number } => x.avg !== null && x.avg >= 3000 && x.sug !== null)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 6)
      .map((x) => ({ categoryId: x.c.id, name: x.c.name, averageCents: x.avg, suggestedCents: x.sug, kind: x.c.kind }));
    return {
      month,
      isCurrentMonth: month === monthOf(today),
      lines,
      totalLimitCents: lines.reduce((t, l) => t + l.limitCents, 0),
      totalSpentCents: lines.reduce((t, l) => t + l.spentCents, 0),
      suggestions,
    };
  }

  set(categoryId: number, amountCents: number | null): void {
    const c = this.repos.categories.get(categoryId);
    if (c.excludedFromSpending) throw new AppError('VALIDATION', 'Esta categoría no cuenta como gasto: no admite presupuesto.');
    const ts = this.now().toISOString();
    if (amountCents === null || amountCents <= 0) this.repos.db.run('DELETE FROM budgets WHERE category_id = ?', categoryId);
    else {
      this.repos.db.run(
        `INSERT INTO budgets(category_id, amount_cents, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(category_id) DO UPDATE SET amount_cents = excluded.amount_cents, updated_at = excluded.updated_at`,
        categoryId, amountCents, ts, ts,
      );
    }
  }

  // ───────── Alerts ─────────

  /** Computes current alerts and stores the new ones. Returns only alerts that did not exist before. */
  refreshAlerts(): AlertDTO[] {
    const fresh: AlertDTO[] = [];
    const ts = this.now().toISOString();
    this.repos.db.transaction(() => {
      for (const a of this.computeAlerts()) {
        const r = this.repos.db.run(
          'INSERT INTO alerts(key, kind, title, body, page, section, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
          a.key, a.kind, a.title, a.body, a.page, a.section ?? null, ts,
        );
        if (r.changes > 0) fresh.push({ ...a, section: a.section ?? null, createdAt: ts, read: false });
      }
      // Keep the list short: alerts older than 90 days are forgotten.
      this.repos.db.run('DELETE FROM alerts WHERE created_at < ?', new Date(this.now().getTime() - 90 * 86400000).toISOString());
    });
    return fresh;
  }

  alerts(limit = 20): AlertDTO[] {
    return this.repos.db
      .all<{ key: string; kind: AlertKind; title: string; body: string; page: string; section: string | null; created_at: string; read_at: string | null }>(
        'SELECT * FROM alerts ORDER BY created_at DESC, rowid DESC LIMIT ?', limit,
      )
      .map((r) => ({ key: r.key, kind: r.kind, title: r.title, body: r.body, page: r.page, section: r.section, createdAt: r.created_at, read: r.read_at !== null }));
  }

  markRead(key?: string): void {
    const ts = this.now().toISOString();
    if (key) this.repos.db.run('UPDATE alerts SET read_at = ? WHERE key = ? AND read_at IS NULL', ts, key);
    else this.repos.db.run('UPDATE alerts SET read_at = ? WHERE read_at IS NULL', ts);
  }

  private computeAlerts(): NewAlert[] {
    const out: NewAlert[] = [];
    const today = this.today();
    const month = monthOf(today);

    // Budgets: 80 % and exceeded, once per month and category.
    for (const l of this.overview(month).lines) {
      if (l.status === 'over') {
        out.push({ key: `budget:${l.categoryId}:${month}:100`, kind: 'budget', title: `Has superado tu presupuesto de ${l.name}`, body: `Llevas ${formatCents(l.spentCents)} de ${formatCents(l.limitCents)} este mes.`, page: 'savings', section: 'budgets' });
      } else if (l.status === 'warning') {
        out.push({ key: `budget:${l.categoryId}:${month}:80`, kind: 'budget', title: `${l.name}: ${formatBp(l.usedBp, 0)} del presupuesto`, body: `Te quedan ${formatCents(l.remainingCents)} para ${l.daysLeft} ${l.daysLeft === 1 ? 'día' : 'días'}.`, page: 'savings', section: 'budgets' });
      }
    }

    const from = addDays(today, -7);
    // Charges much larger than usual at the same merchant.
    const recent = this.repos.db.all<{ id: number; merchant_id: number; name: string; date: string; cents: number }>(
      `SELECT t.id, t.merchant_id, m.display_name AS name, t.date, -t.amount_cents AS cents FROM transactions t JOIN merchants m ON m.id = t.merchant_id
       WHERE t.type IN ('expense','fee') AND t.is_excluded = 0 AND t.amount_cents < 0 AND t.date >= ?`,
      from,
    );
    for (const r of recent) {
      const prev = this.repos.db.get<{ n: number; maxc: number | null }>(
        `SELECT COUNT(*) AS n, MAX(-amount_cents) AS maxc FROM transactions WHERE merchant_id = ? AND amount_cents < 0 AND date < ? AND type IN ('expense','fee')`,
        r.merchant_id, r.date,
      )!;
      if (Number(prev.n) >= 3 && prev.maxc !== null && Number(r.cents) >= 5000 && Number(r.cents) >= Number(prev.maxc) * 2) {
        out.push({ key: `unusual:${r.id}`, kind: 'unusual_charge', title: `Cargo inusual en ${r.name}`, body: `${formatCents(Number(r.cents))} el ${r.date.split('-').reverse().join('/')}, más del doble de lo habitual (máximo anterior ${formatCents(Number(prev.maxc))}).`, page: 'transactions' });
      }
    }
    // Possible double charges: same merchant, amount and day.
    const dups = this.repos.db.all<{ name: string; date: string; cents: number; n: number; ids: string }>(
      `SELECT m.display_name AS name, t.date, -t.amount_cents AS cents, COUNT(*) AS n, GROUP_CONCAT(t.id) AS ids FROM transactions t JOIN merchants m ON m.id = t.merchant_id
       WHERE t.type = 'expense' AND t.is_excluded = 0 AND t.amount_cents <= -1000 AND t.date >= ? GROUP BY t.merchant_id, t.date, t.amount_cents HAVING COUNT(*) > 1`,
      from,
    );
    for (const d of dups) {
      out.push({ key: `dup:${d.ids}`, kind: 'duplicate_charge', title: `¿Cargo duplicado en ${d.name}?`, body: `${d.n} cargos de ${formatCents(Number(d.cents))} el mismo día (${d.date.split('-').reverse().join('/')}). Compruébalo con tu banco si no lo reconoces.`, page: 'transactions' });
    }

    // Recurring payments: coming within 7 days (non-monthly, ≥ 50 €) and price increases.
    for (const r of this.analytics.activeRecurring()) {
      if (r.frequency !== 'monthly' && r.frequency !== 'weekly' && r.averageCents >= 5000 && r.nextDate >= today && r.nextDate <= addDays(today, 7)) {
        out.push({ key: `upcoming:${r.merchantId}:${r.nextDate}`, kind: 'upcoming_payment', title: `Próximo pago: ${r.merchantName}`, body: `Unos ${formatCents(r.averageCents)} hacia el ${r.nextDate.split('-').reverse().join('/')}.`, page: 'recurring' });
      }
    }
    for (const p of this.analytics.priceChanges()) {
      out.push({ key: `price:${p.name}:${p.currentCents}`, kind: 'price_increase', title: `${p.name} ha subido de precio`, body: `De ${formatCents(p.previousCents)} a ${formatCents(p.currentCents)}.`, page: 'recurring' });
    }

    const pending = this.pendingTransferReviews();
    if (pending > 0) {
      out.push({ key: `transfers:${pending}:${month}`, kind: 'transfer_review', title: 'Confirma tus transferencias grandes', body: `${pending === 1 ? 'Hay 1 beneficiario' : `Hay ${pending} beneficiarios`} sin revisar. Mientras tanto se tratan como dinero movido a otra cuenta tuya.`, page: 'accounts', section: 'transfers' });
    }
    out.push(...this.stockAlerts());
    return out;
  }
}

