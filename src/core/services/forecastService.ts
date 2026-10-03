import { addDays, addMonths, daysBetween, formatDate, formatMonth, lastDayOfMonth, monthOf, monthRange, type IsoDate } from '../../shared/dates';
import { formatCents } from '../../shared/money';
import type { ForecastEventDTO, ForecastOverview, SavingsLeverDTO } from '../../shared/types';
import { categoryLevers, detectPayday, firstExpected, incomePayer, incomeSources, occurrences, perDay, projectBalance, seasonalPeaks, type ExpectedEvent, type IncomeSource } from '../domain/forecast';
import type { AnalyticsService } from './analyticsService';
import type { AccountsService } from './accountsService';
import type { NewAlert } from './budgetsService';
import type { Repos } from './context';
import type { WealthService } from './wealthService';

/** How far the balance projection goes. */
const HORIZON_DAYS = 60;
/** Transfers this large are one-off operations (a house, a loan), not your usual monthly moves. */
const ONE_OFF_TRANSFER_CENTS = 1000000;
/** Categories never proposed for cuts (fixed by contracts or not really yours to trim). */
const NOT_TRIMMABLE = new Set(['housing', 'loans', 'insurance', 'taxes', 'utilities', 'education', 'health', 'subscriptions', 'fees', 'transfers', 'capital', 'income', 'uncategorized', 'other', 'shared']);

/**
 * «Previsión»: where your money is heading (balance of your current accounts day by day, month-end spending,
 * seasonal peaks) and where you can save (levers with your own numbers). Everything is computed on this computer.
 */
export class ForecastService {
  constructor(
    private readonly repos: Repos,
    private readonly analytics: AnalyticsService,
    private readonly accounts: AccountsService,
    private readonly wealth: WealthService,
  ) {}

  overview(): ForecastOverview {
    const basis = this.analytics.forecastBasis();
    const today = basis.today;
    const settings = this.repos.settings.getSettings();
    const recurring = this.analytics.activeRecurring();
    const staleDays = basis.dataUntil ? Math.max(0, daysBetween(basis.dataUntil, today)) : null;

    // ── Balance projection of current accounts ──
    const current = this.accounts.list().filter((a) => a.kind === 'current' && a.sourceKind !== 'card' && a.includeInNetWorth && a.balanceCents !== null);
    let balance: ForecastOverview['balance'] = null;
    let balanceNote: string | null = null;
    let events: ExpectedEvent[] = [];
    const sources = basis.lastComplete ? incomeSources(basis.incomes, basis.lastComplete) : [];
    const payroll = sources.find((s) => s.kind === 'payroll' && s.regular);
    const payday = payroll?.day ?? detectPayday(basis.incomes);
    if (!basis.monthsWithData.size) balanceNote = 'Importa tus movimientos para ver la previsión.';
    else if (!current.length) balanceNote = 'Indica el saldo de tu cuenta corriente en «Cuentas» para prever cómo evolucionará día a día.';
    else if (basis.variableMonthlyCents === null) balanceNote = 'Hace falta al menos un mes completo de movimientos para estimar tu gasto habitual.';
    else {
      const last = current.map((a) => (a.lastDate && a.anchor ? (a.lastDate > a.anchor.date ? a.lastDate : a.anchor.date) : a.lastDate ?? a.anchor?.date ?? today)).sort().at(-1)!;
      const startDate = last > today ? today : last;
      const startCents = this.accounts.balancesAt([startDate]).filter((b) => current.some((a) => a.id === b.account.id)).reduce((t, b) => t + (b.values[0] ?? 0), 0);
      const end = addDays(today, HORIZON_DAYS);
      events = this.expectedEvents(startDate, end, basis.expectedIncome.cents, payday, basis.incomes, recurring, basis.dataUntil, sources);
      const transfersMonthly = this.usualTransfersOut(current.map((a) => a.id), basis.lastComplete);
      const daily = perDay(basis.variableMonthlyCents);
      const days = daysBetween(startDate, end);
      const p = projectBalance({ today: startDate, days, startCents, events, dailyVariableCents: daily, dailyTransfersCents: perDay(transfersMonthly) });
      const future = p.points.filter((x) => x.date > today);
      const min = (future.length ? future : p.points).reduce((a, x) => (x.balanceCents < a.balanceCents ? x : a));
      const threshold = settings.notifications.lowBalanceCents;
      balance = {
        startDate,
        startCents,
        accounts: current.map((a) => a.name),
        points: p.points.map((x) => ({ ...x, estimated: x.date <= today })),
        min,
        end: p.end,
        lowThresholdCents: threshold,
        risk: min.balanceCents < 0 ? 'negative' : min.balanceCents < threshold ? 'low' : 'ok',
        payday,
        dailyVariableCents: Math.round(daily * 100) / 100,
        dailyTransfersCents: Math.round(perDay(transfersMonthly) * 100) / 100,
        explanation: [
          `Parte de ${formatCents(startCents)} el ${formatDate(startDate)} (${current.length === 1 ? `cuenta «${current[0]!.name}»` : `${current.length} cuentas corrientes`}).`,
          sources.some((s) => s.regular)
            ? `Suma tus ingresos habituales en su día: ${sources.filter((s) => s.regular).map((s) => `${s.kind === 'payroll' ? 'nómina' : s.kind === 'employer_variable' ? 'variable' : 'ingreso'} de ${s.payer} (${formatCents(s.monthlyCents)}, día ${s.day})`).join(', ')}${payroll?.extraPays.length ? `, y las pagas extra en los meses en que las cobraste el año pasado` : ''}.`
            : basis.expectedIncome.cents > 0 && payday
              ? `Suma tus ingresos esperados (${formatCents(basis.expectedIncome.cents)}) hacia el día ${payday} de cada mes. ${basis.expectedIncome.explanation}`
              : 'No suma ingresos: no se ha detectado un día de cobro habitual.',
          `Resta tus pagos recurrentes en su fecha prevista y tu gasto variable habitual (${formatCents(basis.variableMonthlyCents)}/mes, media de los 3 últimos meses completos), repartido por días.`,
          transfersMonthly > 0 ? `Resta también lo que sueles mover a tus otras cuentas: ${formatCents(transfersMonthly)}/mes (mediana de los 3 últimos meses: los traspasos puntuales grandes no cuentan como hábito).` : 'No se ha detectado que muevas dinero a otras cuentas cada mes.',
          ...(startDate < today ? [`Tus movimientos llegan hasta el ${formatDate(startDate)}: hasta hoy es una estimación.`] : []),
          ...(basis.dataUntil && startDate > basis.dataUntil ? [`Tu saldo es del ${formatDate(startDate)} y tus movimientos llegan hasta el ${formatDate(basis.dataUntil)}: los recibos previstos entre medias se dan por pagados.`] : []),
        ],
      };
    }

    const upcoming: ForecastEventDTO[] = (events.length ? events : this.expectedEvents(today, addDays(today, 30), basis.expectedIncome.cents, payday, basis.incomes, recurring, basis.dataUntil, sources))
      .filter((e) => e.date > today && e.date <= addDays(today, 30))
      .sort((a, b) => a.date.localeCompare(b.date) || a.amountCents - b.amountCents)
      .map((e) => ({ date: e.date, kind: e.kind, label: e.label, amountCents: e.amountCents, frequency: e.frequency ?? null }));

    // ── Seasonality and levers ──
    const keys = new Map(this.repos.db.all<{ id: number; system_key: string | null }>('SELECT id, system_key FROM categories').map((r) => [r.id, r.system_key ?? '']));
    const categories = this.repos.categories.list().filter((c) => !c.excludedFromSpending).map((c) => ({ ...c, systemKey: keys.get(c.id) ?? '' }));
    const seasonal = seasonalPeaks(basis.byCategory, basis.monthsWithData, categories.map((c) => ({ id: c.id, name: c.name })), today, 3);
    const levers: SavingsLeverDTO[] = basis.lastComplete
      ? categoryLevers(
          basis.variableByCategory,
          basis.monthsWithData,
          categories.map((c) => ({ id: c.id, name: c.name, trimmable: !NOT_TRIMMABLE.has(c.systemKey) && (c.kind === 'discretionary' || c.systemKey === 'groceries' || c.systemKey === 'people' || c.systemKey === 'cash') })),
          basis.lastComplete,
        )
      : [];
    for (const r of recurring.filter((x) => x.kind === 'subscription' && x.monthlyCents >= 100)) {
      levers.push({
        id: `subscription:${r.merchantId}`,
        kind: 'subscription',
        title: `Revisar ${r.merchantName}`,
        detail: `Te cuesta ${formatCents(r.monthlyCents)}/mes (${formatCents(r.annualCents)}/año). Si apenas lo usas, darlo de baja es el ahorro más fácil.`,
        monthlyCents: r.monthlyCents,
        annualCents: r.annualCents,
        suggested: false,
        categoryId: r.categoryId,
        targetCents: null,
      });
    }
    if (basis.feesMonthlyCents >= 200) {
      levers.push({
        id: 'fees',
        kind: 'fees',
        title: 'Dejar de pagar comisiones bancarias',
        detail: `En los últimos 12 meses has pagado ${formatCents(basis.feesMonthlyCents * 12)} en comisiones. Muchas cuentas no cobran mantenimiento ni tarjeta: pide que te las quiten o cambia de cuenta.`,
        monthlyCents: basis.feesMonthlyCents,
        annualCents: basis.feesMonthlyCents * 12,
        suggested: true,
        categoryId: null,
        targetCents: null,
      });
    }

    // ── Plan baseline ──
    const savings = this.analytics.savings();
    const pots = this.wealth.potDTOs();
    const e = this.wealth.emergency(pots);
    const emergencyTarget = e.monthsUsed > 0 && e.essentialMonthlyCents > 0 ? e.essentialMonthlyCents * e.recommendedMonths : null;
    const liquid = e.liquidCents;
    let monthEnd = null;
    try {
      monthEnd = this.analytics.dashboard().forecast;
    } catch {
      monthEnd = null;
    }
    const regular = sources.filter((s) => s.regular);
    const expectedMonthly = regular.reduce((t, s) => t + s.monthlyCents, 0);
    const extrasYear = (payroll?.extraPays ?? []).reduce((t, e) => t + e.cents, 0);
    return {
      hasData: basis.monthsWithData.size > 0,
      income: { sources, expectedMonthlyCents: expectedMonthly, expectedYearCents: expectedMonthly * 12 + extrasYear },
      today,
      dataUntil: basis.dataUntil,
      staleDays,
      balance,
      balanceNote,
      upcoming,
      monthEnd,
      seasonal,
      levers,
      plan: {
        baselineMonthlyCents: savings.hasData ? savings.capacity.capacityCents : null,
        baselineExplanation: 'Tu capacidad de ahorro estimada: ingresos esperados − gastos fijos − gasto variable medio (ver «Ahorro»).',
        provisional: savings.capacity.provisional,
        emergencyTargetCents: emergencyTarget,
        emergencyGapCents: emergencyTarget !== null && liquid !== null ? Math.max(0, emergencyTarget - liquid) : null,
        pots: pots.filter((p) => p.status !== 'done' && p.kind !== 'emergency').map((p) => ({ name: p.name, remainingCents: p.remainingCents })),
        budgetedCategoryIds: this.repos.db.all<{ category_id: number }>('SELECT category_id FROM budgets').map((r) => r.category_id),
      },
    };
  }

  private expectedEvents(
    startDate: IsoDate,
    end: IsoDate,
    incomeCents: number,
    payday: number | null,
    incomes: { date: IsoDate; cents: number; description: string }[],
    recurring: ReturnType<AnalyticsService['activeRecurring']>,
    dataUntil: IsoDate | null,
    sources: IncomeSource[] = [],
  ): ExpectedEvent[] {
    const out: ExpectedEvent[] = [];
    const from = addDays(startDate, 1);
    const regular = sources.filter((s) => s.regular && s.day);
    if (regular.length) {
      // Each income source on its usual day, unless this month's money from that payer already arrived.
      for (const m of monthRange(monthOf(from), monthOf(end))) {
        const last = Number(lastDayOfMonth(m).slice(8, 10));
        for (const s of regular) {
          const date = `${m}-${String(Math.min(s.day!, last)).padStart(2, '0')}`;
          const received = incomes.filter((i) => i.date.startsWith(m) && incomeMatches(i.description, s)).reduce((t, i) => t + i.cents, 0);
          if (date >= from && date <= end && received < s.monthlyCents / 2) {
            out.push({ date, kind: 'income', label: s.kind === 'payroll' ? `Nómina (${s.payer})` : s.kind === 'employer_variable' ? `Variable de ${s.payer}` : `Ingreso de ${s.payer}`, amountCents: s.monthlyCents });
          }
          for (const e of s.extraPays.filter((x) => x.month === Number(m.slice(5, 7)))) {
            const ed = `${m}-${String(Math.min(e.day, last)).padStart(2, '0')}`;
            if (ed >= from && ed <= end) out.push({ date: ed, kind: 'income', label: `Paga extra (${s.payer}, como el año pasado)`, amountCents: e.cents });
          }
        }
      }
    } else if (incomeCents > 0 && payday) {
      for (const m of monthRange(monthOf(from), monthOf(end))) {
        const last = Number(lastDayOfMonth(m).slice(8, 10));
        const date = `${m}-${String(Math.min(payday, last)).padStart(2, '0')}`;
        if (date < from || date > end) continue;
        // Already received this month (at least half of it): not expected again.
        const received = incomes.filter((i) => i.date.startsWith(m)).reduce((t, i) => t + i.cents, 0);
        if (received >= incomeCents / 2) continue;
        out.push({ date, kind: 'income', label: 'Ingresos esperados (nómina)', amountCents: incomeCents });
      }
    }
    for (const r of recurring) {
      for (const date of occurrences(firstExpected(r.nextDate, r.frequency, startDate, dataUntil), r.frequency, from, end)) {
        out.push({ date, kind: 'recurring', label: r.merchantName, amountCents: -r.averageCents, frequency: r.frequency, merchantId: r.merchantId });
      }
    }
    return out;
  }

  /**
   * Usual net money moved from your current accounts to your other accounts per month: the median of the last 3
   * complete months, so a one-off move (e.g. 7.000 € to a savings account once) does not look like a habit.
   */
  private usualTransfersOut(accountIds: number[], lastComplete: string | null): number {
    if (!lastComplete || !accountIds.length) return 0;
    const months = monthRange(addMonths(lastComplete, -2), lastComplete);
    const totals = months.map((m) => {
      const row = this.repos.db.get<{ s: number | null }>(
        `SELECT -SUM(amount_cents) AS s FROM transactions
         WHERE type = 'transfer' AND is_excluded = 0 AND ABS(amount_cents) < ? AND date >= ? AND date <= ?
           AND account_id IN (${accountIds.map(() => '?').join(',')})`,
        ONE_OFF_TRANSFER_CENTS, `${m}-01`, lastDayOfMonth(m), ...accountIds,
      );
      return Number(row?.s ?? 0);
    }).sort((x, y) => x - y);
    return Math.max(0, totals[1]!);
  }

  // ───────── Alerts ─────────

  alerts(): NewAlert[] {
    const o = this.overview();
    const out: NewAlert[] = [];
    // Only with recent data: a projection from old movements would raise false alarms.
    if (o.balance && o.staleDays !== null && o.staleDays <= 7) {
      const soon = o.balance.points.filter((p) => !p.estimated && p.date <= addDays(o.today, 21));
      const min = soon.length ? soon.reduce((a, p) => (p.balanceCents < a.balanceCents ? p : a)) : null;
      if (min && min.balanceCents < o.balance.lowThresholdCents) {
        out.push({
          key: `lowbal:${min.date}`,
          kind: 'low_balance',
          title: min.balanceCents < 0 ? 'Tu cuenta podría quedarse en negativo' : 'Tu cuenta va a quedar muy justa',
          body: `Según tus pagos previstos y tu gasto habitual, el ${formatDate(min.date)} podrías tener ${formatCents(min.balanceCents)} en tu cuenta corriente. Revisa la previsión o mueve dinero de tu cuenta de ahorro antes.`,
          page: 'forecast',
          section: 'balance',
        });
      }
    }
    const f = o.monthEnd;
    if (f && f.dayOfMonth >= 10 && f.dayOfMonth <= f.daysInMonth - 3) {
      const avg = this.usualMonthlySpending();
      if (avg !== null && f.projectedSpendingCents > avg * 1.15 && f.projectedSpendingCents - avg >= 10000) {
        out.push({
          key: `pace:${f.month}`,
          kind: 'spending_pace',
          title: 'Este mes vas a gastar más de lo habitual',
          body: `A este ritmo cerrarás ${formatMonth(f.month).toLowerCase()} con unos ${formatCents(f.projectedSpendingCents)} de gasto, ${formatCents(f.projectedSpendingCents - avg)} más que tu media. Quedan ${f.daysInMonth - f.dayOfMonth} días para corregirlo.`,
          page: 'forecast',
          section: 'month',
        });
      }
    }
    const next = addMonths(monthOf(o.today), 1);
    for (const s of o.seasonal.filter((x) => x.month === next && x.extraCents >= 15000)) {
      out.push({
        key: `season:${s.categoryId}:${s.month}`,
        kind: 'seasonal',
        title: `${formatMonth(s.month)} suele ser caro en ${s.categoryName}`,
        body: `El año pasado gastaste ${formatCents(s.lastYearCents)} en ${s.categoryName} ese mes, ${formatCents(s.extraCents)} más de lo normal. Si apartas algo ahora, no te pillará por sorpresa.`,
        page: 'forecast',
        section: 'seasonal',
      });
    }
    return out;
  }

  private usualMonthlySpending(): number | null {
    const s = this.analytics.savings();
    return s.avg3?.spendingCents ?? null;
  }
}

/** Whether an income movement comes from a given source (same payer, same kind). */
function incomeMatches(description: string, s: IncomeSource): boolean {
  const p = incomePayer(description);
  if (!p || p.payer !== s.payer) return false;
  return s.kind === 'payroll' ? p.payroll : !p.payroll;
}
