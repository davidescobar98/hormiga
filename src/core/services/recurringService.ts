import { addDays, todayIso } from '../../shared/dates';
import type { RecurringDTO, RecurringStatus } from '../../shared/types';
import { detectRecurring, type RecurringInputTx } from '../domain/recurring';
import { findKnownMerchant } from '../domain/merchant';
import type { Repos } from './context';

export class RecurringService {
  constructor(private readonly repos: Repos, private readonly now: () => Date, private readonly onChange: () => void = () => {}) {}

  /** Re-runs detection over the last 24 months of spending. Idempotent; keeps user decisions. */
  detect(): RecurringDTO[] {
    const today = todayIso(this.now());
    const rows = this.repos.db.all<{ merchant_id: number; key: string; display_name: string; date: string; spend: number; system_key: string | null }>(
      `SELECT t.merchant_id, m.key, m.display_name, t.date, -t.amount_cents AS spend, c.system_key
       FROM transactions t JOIN merchants m ON m.id = t.merchant_id JOIN categories c ON c.id = t.category_id
       WHERE t.type IN ('expense','fee') AND t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.date >= ?
       ORDER BY t.date`,
      addDays(today, -730),
    );
    const input: RecurringInputTx[] = rows.map((r) => ({
      merchantId: r.merchant_id,
      merchantName: r.display_name,
      date: r.date,
      spendCents: Number(r.spend),
      categoryKey: r.system_key,
      subscriptionHint: !!findKnownMerchant(r.key)?.subscription,
    }));
    this.repos.recurring.replaceDetections(detectRecurring(input, today));
    return this.repos.recurring.list();
  }

  list(): RecurringDTO[] {
    return this.repos.recurring.list();
  }

  setStatus(id: number, status: RecurringStatus): RecurringDTO {
    this.repos.recurring.setStatus(id, status);
    this.onChange();
    return this.repos.recurring.get(id);
  }
}
