import { formatBp, ratioBp, type Cents } from '../../shared/money';
import { buildSavingsInsights } from '../domain/savingsInsights';
import { splitLoanPayments } from '../domain/loanSplit';
import {
  addMonths, firstDayOfMonth, lastDayOfMonth, monthOf, monthRange, todayIso, type IsoDate, type YearMonth,
} from '../../shared/dates';
import type {
  AnalyticsRange, AnalyticsReport, Averages, CategoryBreakdown, CategoryKind, CategoryWithStats, Dashboard, IncomeMode,
  EmergencyInfo, MerchantBreakdown, MonthSummary, Recommendation, RecurringDTO, RecurringSummary, SavingsInsights, SavingsOverview,
} from '../../shared/types';
import {
  aggregateMonths, averageOver, buildComparisons, buildMonthSummary, buildScenarios, compare, estimateCapacity, forecastMonth,
  goalStatus, goalTarget, manualIncomeForMonth, type CategoryMonthAgg, type MonthAggregate,
} from '../domain/metrics';
import { generateRecommendations, type MerchantMonthActivity } from '../domain/recommendations';
import { generateMoreRecommendations, type MoreContext } from '../domain/moreRecommendations';
import { invalid } from '../errors';
import type { Repos } from './context';

const EMPTY_EMERGENCY: EmergencyInfo = {
  essentialMonthlyCents: 0, monthsUsed: 0, savedCents: 0, coverageTenths: null, potId: null, suggestedTargetCents: { months3: 0, months6: 0 },
  recommendedMonths: 3, recommendedReason: 'base de 3 meses', liquidCents: null, explanation: '',
};

const SPEND_TYPES_SQL = "('expense','fee','cash_withdrawal','refund')";

interface Dataset {
  months: YearMonth[];
  aggregates: Map<YearMonth, MonthAggregate>;
  summaries: Map<YearMonth, MonthSummary>;
}

/** Read-side service: every figure shown in the UI is computed here from aggregated SQL queries. */
export class AnalyticsService {
  constructor(private readonly repos: Repos, private readonly now: () => Date) {}

  private today(): IsoDate {
    return todayIso(this.now());
  }

  availableMonths(): YearMonth[] {
    return this.repos.db
      .all<{ m: string }>('SELECT DISTINCT substr(date, 1, 7) AS m FROM transactions WHERE is_excluded = 0 ORDER BY m')
      .map((r) => r.m);
  }

  /**
   * Principal part of loan payments between two dates (matched against the loans registered in «Patrimonio»).
   * Empty when the user prefers to count the whole payment as spending.
   */
  private principalAdjustments(from: IsoDate, to: IsoDate): { month: YearMonth; categoryId: number; kind: CategoryKind; merchantId: number | null; recurring: boolean; cents: Cents }[] {
    if (!this.repos.settings.getSettings().principalAsSavings) return [];
    const loans = this.repos.assets
      .list()
      .filter((a) => a.mode === 'loan' && a.principalCents && a.termMonths && a.startDate && a.annualRateBp !== null)
      .map((a) => ({ name: a.name, terms: { principalCents: a.principalCents!, annualRateBp: a.annualRateBp!, termMonths: a.termMonths!, startDate: a.startDate! } }));
    if (!loans.length) return [];
    const rows = this.repos.db.all<{ id: number; date: string; cents: number; category_id: number; kind: CategoryKind; merchant_id: number | null; recurring: number }>(
      `SELECT t.id, t.date, -t.amount_cents AS cents, t.category_id, c.kind, t.merchant_id,
              CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END AS recurring
       FROM transactions t JOIN categories c ON c.id = t.category_id
       LEFT JOIN recurring_expenses r ON r.merchant_id = t.merchant_id AND r.status <> 'dismissed'
       WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type = 'expense' AND t.amount_cents < 0 AND t.date >= ? AND t.date <= ?
         AND (c.system_key = 'loans' OR (' ' || t.description_normalized || ' ') LIKE '% PRESTAMO %' OR (' ' || t.description_normalized || ' ') LIKE '% HIPOTECA %')`,
      from, to,
    );
    const split = splitLoanPayments(rows.map((r) => ({ id: r.id, date: r.date, amountCents: Number(r.cents) })), loans);
    return rows
      .filter((r) => split.has(r.id))
      .map((r) => ({ month: r.date.slice(0, 7), categoryId: r.category_id, kind: r.kind, merchantId: r.merchant_id, recurring: r.recurring === 1, cents: split.get(r.id)!.principalCents }));
  }

  private load(from: YearMonth, to: YearMonth): Dataset {
    const months = monthRange(from, to);
    const rows = this.repos.db.all<{ month: string; category_id: number; kind: CategoryKind; recurring: number; gross: number; refunds: number; n: number }>(
      `SELECT substr(t.date, 1, 7) AS month, t.category_id, c.kind,
              CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END AS recurring,
              SUM(CASE WHEN t.type IN ('expense','fee','cash_withdrawal') THEN -t.amount_cents ELSE 0 END) AS gross,
              SUM(CASE WHEN t.type = 'refund' THEN t.amount_cents ELSE 0 END) AS refunds,
              COUNT(*) AS n
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN recurring_expenses r ON r.merchant_id = t.merchant_id AND r.status <> 'dismissed'
       WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ${SPEND_TYPES_SQL}
         AND t.date >= ? AND t.date <= ?
       GROUP BY month, t.category_id, recurring`,
      firstDayOfMonth(from), lastDayOfMonth(to),
    );
    const agg: CategoryMonthAgg[] = rows.map((r) => ({
      month: r.month, categoryId: r.category_id, kind: r.kind, recurring: r.recurring === 1,
      grossCents: Number(r.gross), refundsCents: Number(r.refunds), txCount: Number(r.n),
    }));
    const income = this.repos.db
      .all<{ month: string; cents: number; n: number }>(
        `SELECT substr(date, 1, 7) AS month, SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions
         WHERE is_excluded = 0 AND type = 'income' AND date >= ? AND date <= ? GROUP BY month`,
        firstDayOfMonth(from), lastDayOfMonth(to),
      )
      .map((r) => ({ month: r.month, cents: Number(r.cents), txCount: Number(r.n) }));
    const counts = new Map(
      this.repos.db
        .all<{ month: string; n: number }>(
          'SELECT substr(date, 1, 7) AS month, COUNT(*) AS n FROM transactions WHERE is_excluded = 0 AND date >= ? AND date <= ? GROUP BY month',
          firstDayOfMonth(from), lastDayOfMonth(to),
        )
        .map((r) => [r.month, Number(r.n)] as const),
    );
    const principal = this.principalAdjustments(firstDayOfMonth(from), lastDayOfMonth(to));
    // Principal repaid is not spending: it enters as a reduction of the loan category (like a refund).
    for (const p of principal) agg.push({ month: p.month, categoryId: p.categoryId, kind: p.kind, recurring: p.recurring, grossCents: 0, refundsCents: p.cents, txCount: 0 });
    const aggregates = aggregateMonths(agg, income, months);
    for (const [m, a] of aggregates) a.txCount = counts.get(m) ?? 0;

    const settings = this.repos.settings.getSettings();
    const incomeEntries = this.repos.income.list();
    const summaries = new Map<YearMonth, MonthSummary>();
    for (const [m, a] of aggregates) {
      const s = buildMonthSummary(a, { incomeMode: settings.incomeMode, incomeEntries, goal: this.repos.goals.forMonth(m) });
      s.principalRepaidCents = principal.filter((p) => p.month === m).reduce((t, p) => t + p.cents, 0);
      // Shown apart from real refunds: gross − refunds − principal = spending.
      s.refundsCents -= s.principalRepaidCents;
      summaries.set(m, s);
    }
    return { months, aggregates, summaries };
  }

  private categoryBreakdown(from: IsoDate, to: IsoDate, totalSpending: Cents): CategoryBreakdown[] {
    const adj = this.principalAdjustments(from, to);
    return this.repos.db
      .all<{ id: number; name: string; color: string; kind: CategoryKind; net: number; n: number }>(
        `SELECT c.id, c.name, c.color, c.kind, -SUM(t.amount_cents) AS net, COUNT(*) AS n
         FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ${SPEND_TYPES_SQL} AND t.date >= ? AND t.date <= ?
         GROUP BY c.id ORDER BY net DESC`,
        from, to,
      )
      .map((r) => {
        const net = Number(r.net) - adj.filter((p) => p.categoryId === r.id).reduce((t, p) => t + p.cents, 0);
        return { categoryId: r.id, name: r.name, color: r.color, kind: r.kind, spentCents: net, shareBp: ratioBp(net, totalSpending), txCount: Number(r.n) };
      })
      .sort((a, b) => b.spentCents - a.spentCents);
  }

  private merchantBreakdown(from: IsoDate, to: IsoDate, limit: number): MerchantBreakdown[] {
    const adj = this.principalAdjustments(from, to);
    return this.repos.db
      .all<{ id: number; name: string; category: string; net: number; n: number }>(
        `SELECT m.id, m.display_name AS name,
                (SELECT c2.name FROM transactions t2 JOIN categories c2 ON c2.id = t2.category_id WHERE t2.merchant_id = m.id ORDER BY t2.date DESC LIMIT 1) AS category,
                -SUM(t.amount_cents) AS net, COUNT(*) AS n
         FROM transactions t JOIN merchants m ON m.id = t.merchant_id JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ${SPEND_TYPES_SQL} AND t.date >= ? AND t.date <= ?
         GROUP BY m.id HAVING net > 0 ORDER BY net DESC LIMIT ?`,
        from, to, limit,
      )
      .map((r) => ({
        merchantId: r.id, name: r.name, categoryName: r.category, txCount: Number(r.n),
        spentCents: Number(r.net) - adj.filter((p) => p.merchantId === r.id).reduce((t, p) => t + p.cents, 0),
      }))
      .sort((a, b) => b.spentCents - a.spentCents);
  }

  private categoryMonthly(from: YearMonth, to: YearMonth): Map<YearMonth, Map<number, Cents>> {
    const rows = this.repos.db.all<{ month: string; category_id: number; net: number }>(
      `SELECT substr(t.date, 1, 7) AS month, t.category_id, -SUM(t.amount_cents) AS net
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ${SPEND_TYPES_SQL} AND t.date >= ? AND t.date <= ?
       GROUP BY month, t.category_id`,
      firstDayOfMonth(from), lastDayOfMonth(to),
    );
    const map = new Map<YearMonth, Map<number, Cents>>();
    for (const r of rows) {
      const m = map.get(r.month) ?? new Map<number, Cents>();
      m.set(r.category_id, Number(r.net));
      map.set(r.month, m);
    }
    for (const p of this.principalAdjustments(firstDayOfMonth(from), lastDayOfMonth(to))) {
      const m = map.get(p.month);
      if (m?.has(p.categoryId)) m.set(p.categoryId, m.get(p.categoryId)! - p.cents);
    }
    return map;
  }

  activeRecurring(): RecurringDTO[] {
    return this.repos.recurring.list().filter((r) => r.status !== 'dismissed');
  }

  recurringSummary(): RecurringSummary {
    const active = this.activeRecurring();
    const monthly = active.reduce((a, r) => a + r.monthlyCents, 0);
    return {
      activeCount: active.length,
      subscriptionCount: active.filter((r) => r.kind === 'subscription').length,
      monthlyCents: monthly,
      annualCents: monthly * 12,
      top: [...active].sort((a, b) => b.monthlyCents - a.monthlyCents).slice(0, 5),
    };
  }

  /** The month shown by default: the current month if it has data, otherwise the latest month with data. */
  resolveReferenceMonth(requested?: YearMonth): { ref: YearMonth; available: YearMonth[] } {
    const available = this.availableMonths();
    if (requested) {
      if (!/^\d{4}-\d{2}$/.test(requested)) throw invalid('Mes no válido.');
      return { ref: requested, available };
    }
    const current = monthOf(this.today());
    if (available.length === 0 || available.includes(current)) return { ref: current, available };
    return { ref: available[available.length - 1]!, available };
  }

  /** Last complete month with data at or before `ref` (the current calendar month is never complete). */
  private lastCompleteMonth(ref: YearMonth, available: YearMonth[]): YearMonth | null {
    const current = monthOf(this.today());
    const candidates = available.filter((m) => m <= ref && m < current);
    return candidates.length ? candidates[candidates.length - 1]! : null;
  }

  recommendations(): Recommendation[] {
    const { ref, available } = this.resolveReferenceMonth();
    const base = this.lastCompleteMonth(ref, available) ?? (available.length ? available[available.length - 1]! : null);
    if (!base) {
      this.repos.recommendations.replaceActive([]);
      return [];
    }
    const from = addMonths(base, -6);
    const data = this.load(from, base);
    const settings = this.repos.settings.getSettings();
    const expectedIncome = this.expectedIncome(data, base, settings.incomeMode);
    const activity: MerchantMonthActivity[] = this.repos.db
      .all<{ merchant_id: number; name: string; category: string; month: string; n: number; spent: number }>(
        `SELECT t.merchant_id, m.display_name AS name, c.name AS category, substr(t.date, 1, 7) AS month, COUNT(*) AS n, -SUM(t.amount_cents) AS spent
         FROM transactions t JOIN merchants m ON m.id = t.merchant_id JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type = 'expense' AND t.date >= ? AND t.date <= ?
         GROUP BY t.merchant_id, month`,
        firstDayOfMonth(addMonths(base, -2)), lastDayOfMonth(base),
      )
      .map((r) => ({ merchantId: r.merchant_id, name: r.name, categoryName: r.category, month: r.month, count: Number(r.n), spentCents: Number(r.spent) }));
    const fees = new Map(
      this.repos.db
        .all<{ month: string; cents: number; n: number }>(
          `SELECT substr(t.date, 1, 7) AS month, -SUM(t.amount_cents) AS cents, COUNT(*) AS n
           FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE t.is_excluded = 0 AND (t.type = 'fee' OR c.system_key = 'fees') AND t.amount_cents < 0 AND t.date >= ? AND t.date <= ?
           GROUP BY month`,
          firstDayOfMonth(addMonths(base, -2)), lastDayOfMonth(base),
        )
        .map((r) => [r.month, { cents: Number(r.cents), count: Number(r.n) }] as const),
    );
    const recs = generateRecommendations({
      referenceMonth: base,
      summaries: data.summaries,
      categoryMonthly: this.categoryMonthly(from, base),
      categories: this.repos.categories.list().filter((c) => !c.excludedFromSpending),
      activeRecurring: this.activeRecurring(),
      merchantActivity: activity,
      feesByMonth: fees,
      goalTargetCents: goalTarget(this.repos.goals.forMonth(addMonths(base, 1)) ?? this.repos.goals.latest(), expectedIncome.cents),
      uncategorizedCount: this.repos.transactions.uncategorizedCount(),
      protectedCategoryIds: settings.profile.priorityCategoryIds,
    });
    const extra = this.moreContext?.();
    if (extra) {
      const peopleId = this.repos.categories.idByKey('people');
      const monthly = (sql: string, ...params: (string | number)[]) => new Map(
        this.repos.db.all<{ month: string; cents: number; n: number }>(sql, ...params).map((r) => [r.month, { cents: Number(r.cents), count: Number(r.n) }] as const),
      );
      const window = [firstDayOfMonth(addMonths(base, -3)), lastDayOfMonth(base)] as const;
      const people = monthly(
        `SELECT substr(date, 1, 7) AS month, -SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions
         WHERE is_excluded = 0 AND category_id = ? AND type IN ('expense','refund') AND date >= ? AND date <= ? GROUP BY month`,
        peopleId, ...window,
      );
      const cash = monthly(
        `SELECT substr(date, 1, 7) AS month, -SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions
         WHERE is_excluded = 0 AND type = 'cash_withdrawal' AND date >= ? AND date <= ? GROUP BY month`,
        ...window,
      );
      const more = generateMoreRecommendations({
        ...extra,
        referenceMonth: base,
        today: this.today(),
        summaries: data.summaries,
        activeRecurring: this.activeRecurring(),
        priceIncreases: this.priceIncreases(),
        peopleByMonth: people,
        cashByMonth: new Map([...cash].map(([m, v]) => [m, v.cents])),
        illustrativeRateBp: 200,
      });
      const pRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      recs.push(...more);
      recs.sort((a, b) => pRank[a.priority]! - pRank[b.priority]! || (b.estimatedMonthlyImpactCents ?? 0) - (a.estimatedMonthlyImpactCents ?? 0));
    }
    this.repos.recommendations.replaceActive(recs);
    const dismissed = this.repos.recommendations.dismissedKeys();
    return recs.filter((r) => !dismissed.has(r.key));
  }

  private expectedIncome(data: Dataset, base: YearMonth, mode: IncomeMode): { cents: Cents; explanation: string } {
    const next = addMonths(base, 1);
    const manual = manualIncomeForMonth(this.repos.income.list(), next, { recurringOnly: true });
    const window = monthRange(addMonths(base, -2), base).map((m) => data.aggregates.get(m)).filter((a): a is MonthAggregate => !!a && a.txCount > 0);
    const importedAvg = window.length ? Math.round(window.reduce((s, a) => s + a.importedIncomeCents, 0) / window.length) : 0;
    if (mode === 'auto') {
      return importedAvg > 0
        ? { cents: importedAvg, explanation: `Media de ingresos detectados en tus documentos (${window.length} meses).` }
        : { cents: manual, explanation: 'Nómina e ingresos recurrentes configurados (sin extraordinarios).' };
    }
    if (mode === 'manual') return { cents: manual, explanation: 'Nómina e ingresos recurrentes configurados (sin extraordinarios).' };
    if (mode === 'documents') return { cents: importedAvg, explanation: `Media de ingresos detectados en documentos (${window.length} meses).` };
    return { cents: manual + importedAvg, explanation: 'Ingresos configurados + media de ingresos detectados en documentos.' };
  }

  dashboard(requested?: YearMonth): Dashboard {
    const { ref, available } = this.resolveReferenceMonth(requested);
    const currentMonth = monthOf(this.today());
    const isCurrent = ref === currentMonth;
    const data = this.load(addMonths(ref, -12), ref);
    const summary = data.summaries.get(ref)!;
    const prevMonth = addMonths(ref, -1);
    const previous = data.summaries.get(prevMonth)?.hasData ? data.summaries.get(prevMonth)! : null;
    const monthlyAll = monthRange(addMonths(ref, -11), ref).map((m) => data.summaries.get(m)!);
    const firstWithData = monthlyAll.findIndex((s) => s.hasData);
    const monthly = firstWithData === -1 ? [] : monthlyAll.slice(firstWithData);
    const recs = available.length ? this.recommendations() : [];

    let forecast = null;
    if (isCurrent && summary.hasData) {
      const today = this.today();
      const day = Number(today.slice(8, 10));
      const monthEnd = lastDayOfMonth(ref);
      const pending = this.activeRecurring()
        .filter((r) => r.nextDate > today && r.nextDate <= monthEnd && monthOf(r.lastDate) !== ref)
        .reduce((a, r) => a + r.averageCents, 0);
      const history = monthRange(addMonths(ref, -3), addMonths(ref, -1))
        .map((m) => data.aggregates.get(m)!)
        .filter((a) => a.txCount > 0);
      forecast = forecastMonth({
        month: ref,
        today: day,
        current: data.aggregates.get(ref)!,
        pendingRecurringCents: pending,
        history,
        expectedIncomeCents: summary.incomeCents > 0 ? summary.incomeCents : null,
      });
    }

    let comparisons = buildComparisons(data.summaries, ref, isCurrent);
    let projection: Dashboard['projection'] = null;
    if (forecast) {
      // A partial month compared with full months is misleading: compare the month-end projection instead.
      const projected = forecast.projectedSpendingCents;
      comparisons = comparisons.map((c) => compare(c.label, projected, c.baseCents, c.monthsUsed, false));
      const income = summary.incomeCents;
      const savings = income > 0 ? income - projected : null;
      const target = goalTarget(this.repos.goals.forMonth(ref), income);
      projection = {
        spendingCents: projected,
        savingsCents: savings,
        savingsRateBp: savings === null ? null : ratioBp(savings, income),
        goal: savings !== null && target !== null ? goalStatus(savings, target) : null,
      };
    }

    return {
      hasData: available.length > 0,
      referenceMonth: ref,
      availableMonths: available,
      isCurrentCalendarMonth: isCurrent,
      summary,
      previous,
      comparisons,
      projection,
      topCategories: this.categoryBreakdown(firstDayOfMonth(ref), lastDayOfMonth(ref), summary.spendingCents).slice(0, 8),
      monthly,
      recommendations: recs.slice(0, 4),
      recurring: this.recurringSummary(),
      forecast,
      reviewPending: this.repos.documents.reviewSummary().items,
      uncategorizedCount: this.repos.transactions.uncategorizedCount(),
      lastDocument: this.repos.documents.lastImported(),
      lastSyncAt: this.repos.settings.getLastSync()?.finishedAt ?? null,
      monthsOfData: available.length,
    };
  }

  report(range: AnalyticsRange): AnalyticsReport {
    if (range.from > range.to) throw invalid('El inicio del rango debe ser anterior al final.');
    if (monthRange(range.from, range.to).length > 60) throw invalid('El rango máximo es de 60 meses.');
    const data = this.load(addMonths(range.from, -11), range.to);
    const months = monthRange(range.from, range.to).map((m) => data.summaries.get(m)!);
    const withData = months.filter((m) => m.hasData);
    const sum = (f: (s: MonthSummary) => Cents) => months.reduce((a, s) => a + f(s), 0);
    const income = sum((s) => (s.hasData ? s.incomeCents : 0));
    const spending = sum((s) => s.spendingCents);
    const from = firstDayOfMonth(range.from);
    const to = lastDayOfMonth(range.to);
    const categories = this.categoryBreakdown(from, to, spending);
    const catMonthly = this.categoryMonthly(range.from, range.to);
    const top = categories.slice(0, 6);
    const fixed = sum((s) => s.fixedCents);
    const discretionary = sum((s) => s.discretionaryCents);
    const monthsN = withData.length;
    const profile: string[] = [];
    if (monthsN > 0 && spending > 0) {
      const period = monthsN === 1 ? 'En este periodo' : `Durante estos ${monthsN} meses con datos`;
      for (const c of categories.slice(0, 4)) {
        profile.push(`${period}, ${c.name.toLowerCase()} representa el ${formatBp(c.shareBp, 0)} de tu gasto.`);
      }
      profile.push(`Los gastos recurrentes suponen el ${formatBp(ratioBp(fixed, spending), 0)} del gasto y los discrecionales el ${formatBp(ratioBp(discretionary, spending), 0)}.`);
      if (income > 0) profile.push(`Has ahorrado el ${formatBp(ratioBp(income - spending, income), 0)} de tus ingresos en el periodo.`);
    }
    return {
      range,
      months,
      monthsWithData: monthsN,
      totals: { incomeCents: income, spendingCents: spending, savingsCents: income - spending, savingsRateBp: ratioBp(income - spending, income), refundsCents: sum((s) => s.refundsCents), principalRepaidCents: sum((s) => s.principalRepaidCents) },
      categories,
      merchants: this.merchantBreakdown(from, to, 10),
      categoryTrends: top.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        color: c.color,
        series: monthRange(range.from, range.to).map((m) => ({ month: m, cents: catMonthly.get(m)?.get(c.categoryId) ?? 0 })),
      })),
      recurringShareBp: ratioBp(fixed, spending),
      fixedCents: fixed,
      variableCents: spending - fixed,
      discretionaryCents: discretionary,
      averages: {
        avg3: averageOver(data.summaries, range.to, 3),
        avg6: averageOver(data.summaries, range.to, 6),
        avg12: averageOver(data.summaries, range.to, 12),
      },
      profile,
    };
  }

  savings(requested?: YearMonth): SavingsOverview {
    const resolved = this.resolveReferenceMonth(requested);
    const available = resolved.available;
    // Savings of a month in progress are not meaningful yet: default to the last complete month.
    const ref = requested ? resolved.ref : (this.lastCompleteMonth(resolved.ref, available) ?? resolved.ref);
    const data = this.load(addMonths(ref, -12), ref);
    const summary = data.summaries.get(ref)!;
    const base = this.lastCompleteMonth(ref, available);
    const windowMonths = base ? monthRange(addMonths(base, -5), base) : [];
    const window = windowMonths.map((m) => data.aggregates.get(m)).filter((a): a is MonthAggregate => !!a && a.txCount > 0);
    const settings = this.repos.settings.getSettings();
    const expected = this.expectedIncome(data, base ?? ref, settings.incomeMode);
    const capacity = estimateCapacity({
      window,
      expectedIncomeCents: expected.cents,
      expectedIncomeExplanation: expected.explanation,
      recurringMonthlyCents: this.recurringSummary().monthlyCents,
    });
    const goal = this.repos.goals.forMonth(ref) ?? this.repos.goals.latest();
    const target = goalTarget(goal, expected.cents);
    const avg = (n: number): Averages | null => (base ? averageOver(data.summaries, base, n) : null);
    return {
      month: ref,
      hasData: available.length > 0,
      summary,
      goal,
      goalStatus: summary.goal,
      avg3: avg(3),
      avg6: avg(6),
      capacity,
      scenarios: buildScenarios(capacity, target),
      history: monthRange(addMonths(ref, -11), ref)
        .map((m) => data.summaries.get(m)!)
        .filter((s) => s.hasData)
        .map((s) => ({ month: s.month, savingsCents: s.savingsCents, targetCents: s.goal?.targetCents ?? null, rateBp: s.savingsRateBp })),
      monthsOfData: available.length,
      insights: this.savingsInsights(ref, data),
      emergency: this.emergencyInfo?.() ?? EMPTY_EMERGENCY,
    };
  }

  /** Set by the composition root (wealth depends on analytics). */
  emergencyInfo: (() => EmergencyInfo) | null = null;
  /** Context from accounts, goals and loans for the wider suggestions (set by the composition root). */
  moreContext: (() => Pick<MoreContext, 'profile' | 'currentAccountsCents' | 'savingsAccountsCents' | 'pots' | 'loans' | 'pendingTransferReviews' | 'emergencyPotCents' | 'recommendedEmergencyMonths' | 'recommendedEmergencyReason' | 'essentialMonthlyCents'>) | null = null;

  /** Recurring payments whose last charge is higher than the usual previous amount. */
  priceChanges(): MoreContext['priceIncreases'] {
    return this.priceIncreases();
  }

  private priceIncreases(): MoreContext['priceIncreases'] {
    const active = this.activeRecurring();
    if (!active.length) return [];
    const out: MoreContext['priceIncreases'] = [];
    for (const r of active) {
      const charges = this.repos.db.all<{ date: string; cents: number }>(
        `SELECT date, -amount_cents AS cents FROM transactions WHERE merchant_id = ? AND type IN ('expense','fee') AND is_excluded = 0 AND amount_cents < 0
         ORDER BY date DESC LIMIT 4`,
        r.merchantId,
      );
      if (charges.length < 3) continue;
      const [last, ...prev] = charges;
      const usual = [...prev].map((c) => Number(c.cents)).sort((a, b) => a - b)[Math.floor(prev.length / 2)]!;
      const now = Number(last!.cents);
      if (now - usual >= 50 && now >= usual * 1.02 && now <= usual * 1.5) out.push({ name: r.merchantName, previousCents: usual, currentCents: now, date: last!.date });
    }
    return out.sort((a, b) => b.currentCents - b.previousCents - (a.currentCents - a.previousCents));
  }

  private savingsInsights(ref: YearMonth, data: Dataset): SavingsInsights {
    const a = data.aggregates.get(ref);
    const kind = (k: 'essential' | 'discretionary' | 'neutral') => (a ? a.byKind[k].recurring + a.byKind[k].variable : 0);
    const range = [firstDayOfMonth(ref), lastDayOfMonth(ref)] as const;
    const peopleIds = [this.repos.categories.idByKey('people')];
    const people = this.repos.db.get<{ net: number | null }>(
      `SELECT SUM(CASE WHEN type IN ('expense','fee','cash_withdrawal') THEN -amount_cents WHEN type = 'refund' THEN -amount_cents ELSE 0 END) AS net
       FROM transactions WHERE is_excluded = 0 AND category_id = ? AND date >= ? AND date <= ?`,
      peopleIds[0]!, ...range,
    );
    const moved = this.repos.db.get<{ out: number | null }>(
      `SELECT SUM(-amount_cents) AS out FROM transactions WHERE is_excluded = 0 AND type = 'transfer' AND amount_cents < 0
         AND (counter_account_id IS NOT NULL OR transfer_match_id IS NOT NULL OR category_id = ?) AND date >= ? AND date <= ?`,
      this.repos.categories.idByKey('transfers'), ...range,
    );
    const year = ref.slice(0, 4);
    return buildSavingsInsights({
      month: ref,
      summary: data.summaries.get(ref)!,
      essentialCents: kind('essential'),
      discretionaryCents: kind('discretionary'),
      neutralCents: kind('neutral'),
      peopleCents: Math.max(0, Number(people?.net ?? 0)),
      movedToOwnCents: Number(moved?.out ?? 0),
      yearSummaries: [...data.summaries.values()].filter((s) => s.month.startsWith(year) && s.month <= ref),
      recurring: this.activeRecurring(),
      today: todayIso(this.now()),
      horizonDays: 60,
    });
  }

  /**
   * Average monthly essential spending (essential categories, recurring included) over the last complete months
   * with data (max 6). Used to size the emergency fund.
   */
  essentialMonthly(): { cents: Cents; months: number } {
    const { ref, available } = this.resolveReferenceMonth();
    const base = this.lastCompleteMonth(ref, available);
    if (!base) return { cents: 0, months: 0 };
    const data = this.load(addMonths(base, -5), base);
    const window = monthRange(addMonths(base, -5), base).map((m) => data.aggregates.get(m)).filter((a): a is MonthAggregate => !!a && a.txCount > 0);
    if (window.length === 0) return { cents: 0, months: 0 };
    const total = window.reduce((s, a) => s + a.byKind.essential.recurring + a.byKind.essential.variable, 0);
    return { cents: Math.round(total / window.length), months: window.length };
  }

  categoriesWithStats(range?: { from?: string; to?: string }): CategoryWithStats[] {
    const from = range?.from ?? '0000-01-01';
    const to = range?.to ?? '9999-12-31';
    const stats = new Map(
      this.repos.db
        .all<{ category_id: number; net: number; n: number }>(
          `SELECT t.category_id, -SUM(CASE WHEN t.type IN ${SPEND_TYPES_SQL} THEN t.amount_cents ELSE 0 END) AS net, COUNT(*) AS n
           FROM transactions t WHERE t.is_excluded = 0 AND t.date >= ? AND t.date <= ? GROUP BY t.category_id`,
          from, to,
        )
        .map((r) => [r.category_id, { net: Number(r.net), n: Number(r.n) }] as const),
    );
    const rules = new Map(
      this.repos.db.all<{ category_id: number; n: number }>('SELECT category_id, COUNT(*) AS n FROM categorization_rules GROUP BY category_id').map((r) => [r.category_id, Number(r.n)] as const),
    );
    return this.repos.categories.list().map((c) => ({
      ...c,
      spentCents: c.excludedFromSpending ? 0 : (stats.get(c.id)?.net ?? 0),
      txCount: stats.get(c.id)?.n ?? 0,
      ruleCount: rules.get(c.id) ?? 0,
    }));
  }
}
