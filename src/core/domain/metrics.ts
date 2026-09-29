import { formatCents, formatBp, mulDiv, ratioBp, type Cents } from '../../shared/money';
import { addMonths, daysInMonth, monthRange, parseYearMonth, type YearMonth } from '../../shared/dates';
import type {
  Averages, CapacityEstimate, CategoryKind, Comparison, Forecast, FormulaLine, GoalStatus, IncomeDTO, IncomeMode,
  MonthSummary, SavingsGoalDTO, SavingsScenario,
} from '../../shared/types';

/**
 * Aggregated spending of one month for one category, split by whether the merchant is a known recurring expense.
 * All amounts are NET spending in positive cents: charges − refunds (transfers and income never included).
 */
export interface CategoryMonthAgg {
  month: YearMonth;
  categoryId: number;
  kind: CategoryKind;
  recurring: boolean;
  grossCents: Cents;
  refundsCents: Cents;
  txCount: number;
}

export interface MonthAggregate {
  month: YearMonth;
  grossCents: Cents;
  refundsCents: Cents;
  netCents: Cents;
  recurringCents: Cents;
  byKind: Record<CategoryKind, { recurring: Cents; variable: Cents }>;
  importedIncomeCents: Cents;
  txCount: number;
}

export function emptyMonth(month: YearMonth): MonthAggregate {
  return {
    month,
    grossCents: 0,
    refundsCents: 0,
    netCents: 0,
    recurringCents: 0,
    byKind: { essential: { recurring: 0, variable: 0 }, discretionary: { recurring: 0, variable: 0 }, neutral: { recurring: 0, variable: 0 } },
    importedIncomeCents: 0,
    txCount: 0,
  };
}

export function aggregateMonths(rows: CategoryMonthAgg[], income: { month: YearMonth; cents: Cents; txCount: number }[], months: YearMonth[]): Map<YearMonth, MonthAggregate> {
  const map = new Map<YearMonth, MonthAggregate>(months.map((m) => [m, emptyMonth(m)]));
  for (const r of rows) {
    const m = map.get(r.month);
    if (!m) continue;
    const net = r.grossCents - r.refundsCents;
    m.grossCents += r.grossCents;
    m.refundsCents += r.refundsCents;
    m.netCents += net;
    if (r.recurring) m.recurringCents += net;
    m.byKind[r.kind][r.recurring ? 'recurring' : 'variable'] += net;
    m.txCount += r.txCount;
  }
  for (const i of income) {
    const m = map.get(i.month);
    if (m) {
      m.importedIncomeCents += i.cents;
      m.txCount += i.txCount;
    }
  }
  return map;
}

/** Configured income for a month: salary/recurring entries active that month + extraordinary entries of that month. */
export function manualIncomeForMonth(entries: IncomeDTO[], month: YearMonth, opts: { recurringOnly?: boolean } = {}): Cents {
  let total = 0;
  for (const e of entries) {
    if (e.kind === 'extraordinary') {
      if (!opts.recurringOnly && e.startMonth === month) total += e.amountCents;
    } else if (e.startMonth <= month && (e.endMonth === null || e.endMonth >= month)) {
      total += e.amountCents;
    }
  }
  return total;
}

export function incomeForMonth(mode: IncomeMode, manual: Cents, imported: Cents): { cents: Cents; source: string } {
  switch (mode) {
    case 'auto':
      // Documents with payroll win; otherwise the configured income. Never both (no double counting).
      return imported > 0 ? { cents: imported, source: 'Ingresos detectados en documentos' } : { cents: manual, source: 'Ingresos configurados' };
    case 'manual':
      return { cents: manual, source: 'Ingresos configurados' };
    case 'documents':
      return { cents: imported, source: 'Ingresos detectados en documentos' };
    case 'combined':
      return { cents: manual + imported, source: 'Ingresos configurados + detectados en documentos' };
  }
}

export function goalTarget(goal: SavingsGoalDTO | null, incomeCents: Cents): Cents | null {
  if (!goal) return null;
  if (goal.mode === 'amount') return goal.amountCents ?? null;
  if (goal.percentBp === null || incomeCents <= 0) return null;
  return mulDiv(incomeCents, goal.percentBp, 10000);
}

/** ±5 % of the target counts as "within" the goal. */
export const GOAL_TOLERANCE_BP = 500;

export function goalStatus(savingsCents: Cents, targetCents: Cents): GoalStatus {
  const diff = savingsCents - targetCents;
  const band = mulDiv(Math.abs(targetCents), GOAL_TOLERANCE_BP, 10000);
  const status: GoalStatus['status'] = diff > band ? 'above' : diff < -band ? 'below' : 'on_track';
  const description =
    status === 'above'
      ? `Has ahorrado ${formatCents(diff)} más que tu objetivo de ${formatCents(targetCents)}.`
      : status === 'on_track'
        ? `Estás en línea con tu objetivo de ${formatCents(targetCents)}.`
        : `Te faltan ${formatCents(-diff)} para llegar a tu objetivo de ${formatCents(targetCents)}.`;
  return { targetCents, differenceCents: diff, status, progressBp: ratioBp(savingsCents, targetCents), description };
}

export function buildMonthSummary(
  agg: MonthAggregate,
  ctx: { incomeMode: IncomeMode; incomeEntries: IncomeDTO[]; goal: SavingsGoalDTO | null },
): MonthSummary {
  const manual = manualIncomeForMonth(ctx.incomeEntries, agg.month);
  const income = incomeForMonth(ctx.incomeMode, manual, agg.importedIncomeCents);
  const savings = income.cents - agg.netCents;
  const target = goalTarget(ctx.goal, income.cents);
  const hasData = agg.txCount > 0;
  return {
    month: agg.month,
    incomeCents: income.cents,
    incomeSource: income.source,
    grossExpensesCents: agg.grossCents,
    refundsCents: agg.refundsCents,
    spendingCents: agg.netCents,
    savingsCents: savings,
    savingsRateBp: ratioBp(savings, income.cents),
    fixedCents: agg.recurringCents,
    variableCents: agg.netCents - agg.recurringCents,
    discretionaryCents: agg.byKind.discretionary.recurring + agg.byKind.discretionary.variable,
    txCount: agg.txCount,
    hasData,
    goal: target !== null && hasData ? goalStatus(savings, target) : null,
    principalRepaidCents: 0,
  };
}

/** Average of the last `n` calendar months ending at `end` (inclusive). Null unless all n months have data. */
export function averageOver(summaries: Map<YearMonth, MonthSummary>, end: YearMonth, n: number): Averages | null {
  const months = monthRange(addMonths(end, -(n - 1)), end).map((m) => summaries.get(m)).filter((s): s is MonthSummary => !!s && s.hasData);
  if (months.length < n) return null;
  const avg = (f: (s: MonthSummary) => Cents) => Math.round(months.reduce((a, s) => a + f(s), 0) / months.length);
  return { months: months.length, spendingCents: avg((s) => s.spendingCents), incomeCents: avg((s) => s.incomeCents), savingsCents: avg((s) => s.savingsCents) };
}

export function compare(label: string, current: Cents, base: Cents, monthsUsed: number, reliable: boolean): Comparison {
  return { label, baseCents: base, currentCents: current, deltaCents: current - base, deltaBp: ratioBp(current - base, base), monthsUsed, reliable };
}

export function buildComparisons(summaries: Map<YearMonth, MonthSummary>, ref: YearMonth, refIsPartial: boolean): Comparison[] {
  const current = summaries.get(ref);
  if (!current || !current.hasData) return [];
  const out: Comparison[] = [];
  const prev = summaries.get(addMonths(ref, -1));
  if (prev?.hasData) out.push(compare('Mes anterior', current.spendingCents, prev.spendingCents, 1, !refIsPartial));
  const a3 = averageOver(summaries, addMonths(ref, -1), 3);
  if (a3) out.push(compare('Media 3 meses', current.spendingCents, a3.spendingCents, 3, !refIsPartial));
  const a6 = averageOver(summaries, addMonths(ref, -1), 6);
  if (a6) out.push(compare('Media 6 meses', current.spendingCents, a6.spendingCents, 6, !refIsPartial));
  return out;
}

// ───────────────────────── Savings capacity ─────────────────────────

export const MODERATE_DISCRETIONARY_REDUCTION_BP = 1500;

export interface CapacityInput {
  /** Complete months with data used as history (most recent last), at most 6. */
  window: MonthAggregate[];
  expectedIncomeCents: Cents;
  expectedIncomeExplanation: string;
  /** Monthly equivalent of active recurring expenses. */
  recurringMonthlyCents: Cents;
}

export function estimateCapacity(input: CapacityInput): CapacityEstimate {
  const n = input.window.length;
  const avg = (f: (m: MonthAggregate) => Cents) => (n === 0 ? 0 : Math.round(input.window.reduce((a, m) => a + f(m), 0) / n));
  const essential = avg((m) => m.byKind.essential.variable);
  const neutral = avg((m) => m.byKind.neutral.variable);
  const discretionary = avg((m) => m.byKind.discretionary.variable);
  const fixed = input.recurringMonthlyCents;
  const capacity = input.expectedIncomeCents - fixed - essential - neutral - discretionary;
  const period = n === 1 ? 'del último mes' : `de los últimos ${n} meses`;
  const lines: FormulaLine[] = [
    { label: 'Ingreso mensual esperado', cents: input.expectedIncomeCents, op: '+', explanation: input.expectedIncomeExplanation },
    { label: 'Gastos fijos y recurrentes', cents: fixed, op: '-', explanation: 'Suma del coste mensual equivalente de los gastos recurrentes activos (probables y confirmados).' },
    { label: 'Gasto esencial variable', cents: essential, op: '-', explanation: `Media ${period} en categorías esenciales, sin contar recurrentes.` },
    { label: 'Otros gastos variables', cents: neutral, op: '-', explanation: `Media ${period} en categorías neutrales (efectivo, comisiones, otros, sin clasificar).` },
    { label: 'Gasto discrecional', cents: discretionary, op: '-', explanation: `Media ${period} en categorías discrecionales, sin contar recurrentes.` },
    { label: 'Capacidad de ahorro estimada', cents: capacity, op: '=', explanation: 'Lo que quedaría cada mes si tu gasto sigue el patrón observado.' },
  ];
  const notes: string[] = [];
  if (n === 0) notes.push('Sin meses completos con datos: la estimación solo usa ingresos y gastos recurrentes conocidos.');
  else if (n < 3) notes.push(`Estimación provisional: solo hay ${n} ${n === 1 ? 'mes' : 'meses'} de datos.`);
  if (input.expectedIncomeCents === 0) notes.push('No hay ingresos configurados: añade tus ingresos en Ajustes para una estimación útil.');
  return {
    provisional: n < 3,
    monthsUsed: n,
    expectedIncomeCents: input.expectedIncomeCents,
    fixedCents: fixed,
    essentialVariableCents: essential,
    neutralVariableCents: neutral,
    discretionaryCents: discretionary,
    capacityCents: capacity,
    lines,
    notes,
  };
}

export function buildScenarios(cap: CapacityEstimate, goalTargetCents: Cents | null): SavingsScenario[] {
  const scenarios: SavingsScenario[] = [
    {
      id: 'actual',
      label: 'Situación actual',
      monthlySavingsCents: cap.capacityCents,
      discretionaryReductionBp: 0,
      achievable: true,
      explanation: 'Mantienes el patrón de gasto observado: ingreso esperado − fijos − variable esencial − otros − discrecional.',
    },
  ];
  const moderateSaving = mulDiv(cap.discretionaryCents, MODERATE_DISCRETIONARY_REDUCTION_BP, 10000);
  scenarios.push({
    id: 'moderate',
    label: 'Reducción moderada',
    monthlySavingsCents: cap.capacityCents + moderateSaving,
    discretionaryReductionBp: MODERATE_DISCRETIONARY_REDUCTION_BP,
    achievable: true,
    explanation: `Reduces un ${formatBp(MODERATE_DISCRETIONARY_REDUCTION_BP, 0)} el gasto discrecional (${formatCents(cap.discretionaryCents)}/mes → ${formatCents(cap.discretionaryCents - moderateSaving)}/mes): +${formatCents(moderateSaving)}/mes.`,
  });
  if (goalTargetCents !== null) {
    const needed = goalTargetCents - cap.capacityCents;
    if (needed <= 0) {
      scenarios.push({
        id: 'goal',
        label: 'Objetivo personal',
        monthlySavingsCents: goalTargetCents,
        discretionaryReductionBp: 0,
        achievable: true,
        explanation: `Con tu patrón actual ya alcanzarías el objetivo de ${formatCents(goalTargetCents)}/mes.`,
      });
    } else {
      const bp = cap.discretionaryCents > 0 ? Math.ceil((needed * 10000) / cap.discretionaryCents) : null;
      const achievable = bp !== null && bp <= 10000;
      scenarios.push({
        id: 'goal',
        label: 'Objetivo personal',
        monthlySavingsCents: goalTargetCents,
        discretionaryReductionBp: bp ?? 10000,
        achievable,
        explanation: achievable
          ? `Para ahorrar ${formatCents(goalTargetCents)}/mes necesitarías reducir el gasto discrecional en ${formatCents(needed)}/mes (un ${formatBp(bp, 0)}).`
          : `El objetivo de ${formatCents(goalTargetCents)}/mes requiere ${formatCents(needed)}/mes más de lo que permite reducir solo el gasto discrecional. Revisa también gastos fijos o ingresos.`,
      });
    }
  }
  return scenarios;
}

// ───────────────────────── Forecast ─────────────────────────

export interface ForecastInput {
  month: YearMonth;
  today: number;
  current: MonthAggregate;
  pendingRecurringCents: Cents;
  /** Previous complete months with data (for the variable baseline). */
  history: MonthAggregate[];
  expectedIncomeCents: Cents | null;
}

/**
 * Projects month-end spending: recurring already charged + recurring still expected + projected variable spending.
 * Variable projection blends the current pace (weight = elapsed fraction of the month) with the historical average.
 */
export function forecastMonth(input: ForecastInput): Forecast {
  const { y, m } = parseYearMonth(input.month);
  const D = daysInMonth(y, m);
  const d = Math.min(Math.max(input.today, 1), D);
  const spent = input.current.netCents;
  const recurringSoFar = input.current.recurringCents;
  const variableSoFar = spent - recurringSoFar;
  const pace = Math.round((variableSoFar / d) * D);
  const hist = input.history.length ? Math.round(input.history.reduce((a, h) => a + (h.netCents - h.recurringCents), 0) / input.history.length) : null;
  const w = d / D;
  const blended = hist === null ? pace : Math.round(w * pace + (1 - w) * hist);
  const projectedVariable = Math.max(variableSoFar, blended);
  const projectedSpending = recurringSoFar + input.pendingRecurringCents + projectedVariable;
  const explanation = [
    `Llevas ${formatCents(spent)} gastados en ${d} de ${D} días.`,
    `Recurrentes pendientes este mes: ${formatCents(input.pendingRecurringCents)}.`,
    hist === null
      ? `Gasto variable proyectado al ritmo actual: ${formatCents(projectedVariable)}.`
      : `Gasto variable proyectado: ${Math.round(w * 100)} % ritmo actual (${formatCents(pace)}) + ${100 - Math.round(w * 100)} % media histórica (${formatCents(hist)}) = ${formatCents(projectedVariable)}.`,
  ];
  return {
    month: input.month,
    dayOfMonth: d,
    daysInMonth: D,
    spentSoFarCents: spent,
    pendingRecurringCents: input.pendingRecurringCents,
    projectedVariableCents: projectedVariable,
    projectedSpendingCents: projectedSpending,
    expectedIncomeCents: input.expectedIncomeCents,
    projectedSavingsCents: input.expectedIncomeCents === null ? null : input.expectedIncomeCents - projectedSpending,
    confidence: input.history.length >= 3 && d >= 10 ? 'medium' : 'low',
    explanation,
  };
}
