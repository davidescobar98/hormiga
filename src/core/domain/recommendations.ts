import { formatBp, formatCents, ratioBp, roundToEuros, type Cents } from '../../shared/money';
import { addMonths, formatMonth, monthRange, type YearMonth } from '../../shared/dates';
import type { CategoryKind, MonthSummary, Priority, Recommendation, RecurringDTO } from '../../shared/types';

export interface CategoryInfo {
  id: number;
  name: string;
  kind: CategoryKind;
}

export interface MerchantMonthActivity {
  merchantId: number;
  name: string;
  categoryName: string;
  month: YearMonth;
  count: number;
  spentCents: Cents;
}

export interface RecommendationContext {
  /** Last complete month with data: all rules evaluate this month against its history. */
  referenceMonth: YearMonth;
  summaries: Map<YearMonth, MonthSummary>;
  /** Net spending per category per month. */
  categoryMonthly: Map<YearMonth, Map<number, Cents>>;
  categories: CategoryInfo[];
  activeRecurring: RecurringDTO[];
  merchantActivity: MerchantMonthActivity[];
  feesByMonth: Map<YearMonth, { cents: Cents; count: number }>;
  goalTargetCents: Cents | null;
  uncategorizedCount: number;
  /** Categories the user values most (profile): never suggested for cuts. */
  protectedCategoryIds?: number[];
}

// Thresholds (documented in docs/recommendations.md).
export const T = {
  increaseMinCents: 3000,
  increaseMinBp: 2500,
  discretionaryMinAvgCents: 10000,
  discretionaryMinShareBp: 1000,
  discretionaryTargetReductionBp: 2000,
  frequentMinPerMonth: 8,
  frequentMaxTicketCents: 1500,
  atypicalMinBp: 2000,
  positiveRateDeltaBp: 300,
  positiveCategoryDropBp: 1500,
  positiveCategoryDropMinCents: 2000,
  uncategorizedMin: 5,
};

function priorityFor(monthlyImpact: Cents | null): Priority {
  if (monthlyImpact === null) return 'low';
  if (monthlyImpact >= 10000) return 'high';
  if (monthlyImpact >= 4000) return 'medium';
  return 'low';
}

function rec(r: Omit<Recommendation, 'estimatedAnnualImpactCents' | 'priority'> & { priority?: Priority }): Recommendation {
  return {
    ...r,
    estimatedAnnualImpactCents: r.estimatedMonthlyImpactCents === null ? null : r.estimatedMonthlyImpactCents * 12,
    priority: r.priority ?? priorityFor(r.estimatedMonthlyImpactCents),
  };
}

function catValue(ctx: RecommendationContext, month: YearMonth, categoryId: number): Cents {
  return ctx.categoryMonthly.get(month)?.get(categoryId) ?? 0;
}

function monthsWithData(ctx: RecommendationContext, months: YearMonth[]): YearMonth[] {
  return months.filter((m) => ctx.summaries.get(m)?.hasData);
}

/** Generates explainable, data-backed savings recommendations. No investment advice, no external services. */
export function generateRecommendations(ctx: RecommendationContext): Recommendation[] {
  const ref = ctx.referenceMonth;
  const current = ctx.summaries.get(ref);
  if (!current?.hasData) return [];
  const out: Recommendation[] = [];
  const prev3 = monthsWithData(ctx, monthRange(addMonths(ref, -3), addMonths(ref, -1)));
  const last3 = monthsWithData(ctx, monthRange(addMonths(ref, -2), ref));
  const refLabel = formatMonth(ref);
  const increased = new Set<number>();

  // 1. Relevant increases per category (vs average of the 3 previous months).
  if (prev3.length === 3) {
    for (const c of ctx.categories) {
      const cur = catValue(ctx, ref, c.id);
      const base = Math.round(prev3.reduce((a, m) => a + catValue(ctx, m, c.id), 0) / 3);
      const delta = cur - base;
      if (base > 0 && delta >= T.increaseMinCents && (delta * 10000) / base >= T.increaseMinBp) {
        increased.add(c.id);
        out.push(rec({
          key: `increase:${c.id}:${ref}`,
          type: 'category_increase',
          title: `${c.name} ha subido un ${formatBp(ratioBp(delta, base), 0)}`,
          description: `En ${refLabel} gastaste ${formatCents(cur)} en ${c.name.toLowerCase()}, frente a una media de ${formatCents(base)} en los 3 meses anteriores.`,
          reason: `El aumento supera el umbral de ${formatCents(T.increaseMinCents)} y del ${formatBp(T.increaseMinBp, 0)}.`,
          evidence: [...prev3.map((m) => `${formatMonth(m)}: ${formatCents(catValue(ctx, m, c.id))}`), `${refLabel}: ${formatCents(cur)}`],
          estimatedMonthlyImpactCents: delta,
          category: c.name,
          tone: 'opportunity',
        }));
      }
    }
  }

  // 2. Subscriptions.
  const subs = ctx.activeRecurring.filter((r) => r.kind === 'subscription');
  if (subs.length >= 2) {
    const monthly = subs.reduce((a, s) => a + s.monthlyCents, 0);
    const cheapest = [...subs].sort((a, b) => a.monthlyCents - b.monthlyCents)[0]!;
    out.push(rec({
      key: `subscriptions:${subs.length}:${monthly}`,
      type: 'subscriptions',
      title: `Tienes ${subs.length} suscripciones activas`,
      description: `Suman ${formatCents(monthly)}/mes (${formatCents(monthly * 12)}/año). Revisa si sigues usando todas.`,
      reason: 'Detectadas como cargos periódicos con importe estable en comercios de suscripción.',
      evidence: subs.map((s) => `${s.merchantName}: ${formatCents(s.monthlyCents)}/mes`),
      estimatedMonthlyImpactCents: cheapest.monthlyCents,
      priority: monthly >= 5000 ? 'medium' : 'low',
      category: 'Suscripciones',
      tone: 'opportunity',
    }));
  }

  // 3. Discretionary categories with room to reduce (average of last 3 months).
  if (last3.length >= 2) {
    const avgSpending = Math.round(last3.reduce((a, m) => a + (ctx.summaries.get(m)?.spendingCents ?? 0), 0) / last3.length);
    const candidates = ctx.categories
      .filter((c) => c.kind === 'discretionary' && !increased.has(c.id) && !(ctx.protectedCategoryIds ?? []).includes(c.id))
      .map((c) => {
        const avg = Math.round(last3.reduce((a, m) => a + catValue(ctx, m, c.id), 0) / last3.length);
        const target = roundToEuros(Math.round((avg * (10000 - T.discretionaryTargetReductionBp)) / 10000), 10);
        return { c, avg, target, impact: avg - target, share: ratioBp(avg, avgSpending) ?? 0 };
      })
      .filter((x) => x.avg >= T.discretionaryMinAvgCents && x.share >= T.discretionaryMinShareBp && x.impact >= 1000)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 2);
    for (const x of candidates) {
      out.push(rec({
        key: `discretionary:${x.c.id}:${ref}`,
        type: 'discretionary_reduction',
        title: x.c.name,
        description: `Has gastado una media de ${formatCents(x.avg)}/mes durante los últimos ${last3.length} meses. Reducirlo hasta ${formatCents(x.target)}/mes supondría aproximadamente ${formatCents(x.impact)}/mes y ${formatCents(x.impact * 12)}/año.`,
        reason: `${x.c.name} es una categoría discrecional y representa el ${formatBp(x.share, 0)} de tu gasto.`,
        evidence: last3.map((m) => `${formatMonth(m)}: ${formatCents(catValue(ctx, m, x.c.id))}`),
        estimatedMonthlyImpactCents: x.impact,
        category: x.c.name,
        tone: 'opportunity',
      }));
    }
  }

  // 4. Frequent small purchases at the same merchant.
  const window = last3.length ? last3 : [ref];
  const byMerchant = new Map<number, MerchantMonthActivity[]>();
  for (const a of ctx.merchantActivity) {
    if (!window.includes(a.month)) continue;
    byMerchant.set(a.merchantId, [...(byMerchant.get(a.merchantId) ?? []), a]);
  }
  const frequent = [...byMerchant.values()]
    .map((acts) => {
      const count = acts.reduce((s, a) => s + a.count, 0);
      const spent = acts.reduce((s, a) => s + a.spentCents, 0);
      return { a: acts[0]!, perMonth: count / window.length, ticket: count ? Math.round(spent / count) : 0, monthly: Math.round(spent / window.length) };
    })
    .filter((x) => x.perMonth >= T.frequentMinPerMonth && x.ticket <= T.frequentMaxTicketCents && x.ticket > 0)
    .sort((a, b) => b.monthly - a.monthly)
    .slice(0, 2);
  for (const f of frequent) {
    const impact = Math.round(f.monthly / 2);
    out.push(rec({
      key: `frequent:${f.a.merchantId}:${ref}`,
      type: 'frequent_small_purchases',
      title: `Compras frecuentes en ${f.a.name}`,
      description: `Unas ${Math.round(f.perMonth)} compras al mes con un ticket medio de ${formatCents(f.ticket)} suman ${formatCents(f.monthly)}/mes. Reducir la frecuencia a la mitad liberaría unos ${formatCents(impact)}/mes.`,
      reason: `Los pequeños pagos repetidos (≥ ${T.frequentMinPerMonth}/mes y ≤ ${formatCents(T.frequentMaxTicketCents)}) suelen pasar desapercibidos.`,
      evidence: window.map((m) => {
        const a = byMerchant.get(f.a.merchantId)?.find((x) => x.month === m);
        return `${formatMonth(m)}: ${a?.count ?? 0} compras, ${formatCents(a?.spentCents ?? 0)}`;
      }),
      estimatedMonthlyImpactCents: impact,
      category: f.a.categoryName,
      tone: 'opportunity',
    }));
  }

  // 5. Bank fees.
  const feeMonths = window.map((m) => ({ m, f: ctx.feesByMonth.get(m) })).filter((x) => x.f && x.f.cents > 0);
  if (feeMonths.length > 0) {
    const total = feeMonths.reduce((a, x) => a + x.f!.cents, 0);
    const monthly = Math.round(total / window.length);
    out.push(rec({
      key: `fees:${ref}:${total}`,
      type: 'fees',
      title: feeMonths.length >= 2 ? 'Pagas comisiones de forma recurrente' : 'Has pagado comisiones bancarias',
      description: `En los últimos ${window.length} ${window.length === 1 ? 'mes' : 'meses'} has pagado ${formatCents(total)} en comisiones e intereses. Consulta con tu banco qué condiciones permiten evitarlas.`,
      reason: 'Las comisiones son un gasto sin contrapartida que a menudo se puede evitar.',
      evidence: feeMonths.map((x) => `${formatMonth(x.m)}: ${x.f!.count} cargo(s), ${formatCents(x.f!.cents)}`),
      estimatedMonthlyImpactCents: monthly,
      priority: feeMonths.length >= 2 ? 'high' : priorityFor(monthly),
      category: 'Comisiones',
      tone: 'opportunity',
    }));
  }

  // 6. Atypical month vs up to 6 previous months.
  const hist = monthsWithData(ctx, monthRange(addMonths(ref, -6), addMonths(ref, -1)));
  if (hist.length >= 3) {
    const values = hist.map((m) => ctx.summaries.get(m)!.spendingCents);
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    const cur = current.spendingCents;
    if (mean > 0 && cur - mean >= (mean * T.atypicalMinBp) / 10000 && cur - mean > 1.5 * sd) {
      const drivers = ctx.categories
        .map((c) => ({ c, delta: catValue(ctx, ref, c.id) - Math.round(hist.reduce((a, m) => a + catValue(ctx, m, c.id), 0) / hist.length) }))
        .filter((x) => x.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 3);
      out.push(rec({
        key: `atypical:${ref}`,
        type: 'atypical_month',
        title: `${refLabel.charAt(0).toUpperCase()}${refLabel.slice(1)} fue un mes de gasto atípico`,
        description: `Gastaste ${formatCents(cur)}, un ${formatBp(ratioBp(Math.round(cur - mean), Math.round(mean)), 0)} más que tu media de ${formatCents(Math.round(mean))} (${hist.length} meses).`,
        reason: 'El gasto supera la media en más de un 20 % y en más de 1,5 desviaciones típicas.',
        evidence: drivers.map((d) => `${d.c.name}: +${formatCents(d.delta)} sobre su media`),
        estimatedMonthlyImpactCents: null,
        priority: 'medium',
        category: null,
        tone: 'info',
      }));
    }
  }

  // 7. Savings goal.
  if (ctx.goalTargetCents !== null && ctx.goalTargetCents > 0 && current.incomeCents > 0) {
    const months = last3.length ? last3 : [ref];
    const avgSavings = Math.round(months.reduce((a, m) => a + ctx.summaries.get(m)!.savingsCents, 0) / months.length);
    const target = ctx.goalTargetCents;
    if (avgSavings >= target) {
      out.push(rec({
        key: `goal_met:${ref}`,
        type: 'goal_met',
        title: 'Estás cumpliendo tu objetivo de ahorro',
        description: `Tu ahorro medio es de ${formatCents(avgSavings)}/mes y tu objetivo es ${formatCents(target)}/mes.`,
        reason: `Media de ${months.length} ${months.length === 1 ? 'mes' : 'meses'}.`,
        evidence: months.map((m) => `${formatMonth(m)}: ${formatCents(ctx.summaries.get(m)!.savingsCents)}`),
        estimatedMonthlyImpactCents: null,
        priority: 'low',
        category: null,
        tone: 'positive',
      }));
    } else {
      const gap = target - avgSavings;
      const disc = ctx.categories
        .filter((c) => c.kind === 'discretionary' && !(ctx.protectedCategoryIds ?? []).includes(c.id))
        .map((c) => ({ c, avg: Math.round(months.reduce((a, m) => a + catValue(ctx, m, c.id), 0) / months.length) }))
        .filter((x) => x.avg > 0)
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 3);
      out.push(rec({
        key: `goal_gap:${ref}:${target}`,
        type: 'goal_gap',
        title: `Te faltan ${formatCents(gap)}/mes para tu objetivo`,
        description: `Ahorras de media ${formatCents(avgSavings)}/mes y tu objetivo es ${formatCents(target)}/mes. Reducir ${formatCents(gap)}/mes de gasto te situaría en él.`,
        reason: 'Diferencia entre tu objetivo y el ahorro medio observado.',
        evidence: disc.length ? disc.map((x) => `${x.c.name}: ${formatCents(x.avg)}/mes de media`) : ['No hay gasto discrecional destacable.'],
        estimatedMonthlyImpactCents: gap,
        priority: 'high',
        category: null,
        tone: 'opportunity',
      }));
    }
  }

  // 8. Positive trends.
  if (prev3.length === 3 && current.savingsRateBp !== null) {
    const rates = prev3.map((m) => ctx.summaries.get(m)!.savingsRateBp).filter((r): r is number => r !== null);
    if (rates.length === 3) {
      const avgRate = Math.round(rates.reduce((a, r) => a + r, 0) / 3);
      if (current.savingsRateBp - avgRate >= T.positiveRateDeltaBp) {
        out.push(rec({
          key: `rate_up:${ref}`,
          type: 'savings_rate_up',
          title: 'Tu tasa de ahorro ha mejorado',
          description: `En ${refLabel} ahorraste el ${formatBp(current.savingsRateBp, 0)} de tus ingresos, frente al ${formatBp(avgRate, 0)} de media en los 3 meses anteriores.`,
          reason: `Mejora de más de ${formatBp(T.positiveRateDeltaBp, 0)} puntos.`,
          evidence: prev3.map((m) => `${formatMonth(m)}: ${formatBp(ctx.summaries.get(m)!.savingsRateBp)}`),
          estimatedMonthlyImpactCents: null,
          priority: 'low',
          category: null,
          tone: 'positive',
        }));
      }
    }
    const drops = ctx.categories
      .filter((c) => c.kind === 'discretionary')
      .map((c) => {
        const base = Math.round(prev3.reduce((a, m) => a + catValue(ctx, m, c.id), 0) / 3);
        return { c, base, cur: catValue(ctx, ref, c.id) };
      })
      .filter((x) => x.base > 0 && x.base - x.cur >= T.positiveCategoryDropMinCents && ((x.base - x.cur) * 10000) / x.base >= T.positiveCategoryDropBp)
      .sort((a, b) => b.base - b.cur - (a.base - a.cur))
      .slice(0, 1);
    for (const d of drops) {
      out.push(rec({
        key: `drop:${d.c.id}:${ref}`,
        type: 'category_decrease',
        title: `Has reducido ${d.c.name.toLowerCase()}`,
        description: `En ${refLabel} gastaste ${formatCents(d.cur)}, ${formatCents(d.base - d.cur)} menos que tu media de ${formatCents(d.base)}.`,
        reason: 'Descenso de más del 15 % frente a los 3 meses anteriores.',
        evidence: prev3.map((m) => `${formatMonth(m)}: ${formatCents(catValue(ctx, m, d.c.id))}`),
        estimatedMonthlyImpactCents: null,
        priority: 'low',
        category: d.c.name,
        tone: 'positive',
      }));
    }
  }

  // 9. Organisation: uncategorized movements.
  if (ctx.uncategorizedCount >= T.uncategorizedMin) {
    out.push(rec({
      key: `uncategorized:${ctx.uncategorizedCount}`,
      type: 'uncategorized',
      title: `${ctx.uncategorizedCount} movimientos sin clasificar`,
      description: 'Clasificarlos mejora la precisión de las estadísticas y recomendaciones. Al corregir uno puedes crear una regla para los siguientes.',
      reason: 'Ninguna regla ni comercio conocido coincide con ellos.',
      evidence: [],
      estimatedMonthlyImpactCents: null,
      priority: 'low',
      category: 'Sin clasificar',
      tone: 'info',
    }));
  }

  const pRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return out.sort(
    (a, b) => pRank[a.priority] - pRank[b.priority] || (b.estimatedMonthlyImpactCents ?? 0) - (a.estimatedMonthlyImpactCents ?? 0),
  );
}
