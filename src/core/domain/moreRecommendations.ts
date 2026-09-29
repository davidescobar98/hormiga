import { formatBp, formatCents, ratioBp, type Cents } from '../../shared/money';
import { formatDate, formatMonth, type IsoDate, type YearMonth } from '../../shared/dates';
import type { FinancialProfile, MonthSummary, PotDTO, Priority, Recommendation, RecurringDTO } from '../../shared/types';
import { normalizeText } from './merchant';

/*
 * Suggestions that look beyond monthly spending: liquidity, emergency fund, subscriptions, upcoming payments,
 * transfers to people, lifestyle inflation, goals and debts. All are explainable from the user's own data and
 * profile; none recommends a specific financial product.
 */

export interface MoreContext {
  referenceMonth: YearMonth;
  today: IsoDate;
  summaries: Map<YearMonth, MonthSummary>;
  profile: FinancialProfile;
  /** Average monthly essential spending and the emergency target recommended for this profile. */
  essentialMonthlyCents: Cents;
  recommendedEmergencyMonths: number;
  recommendedEmergencyReason: string;
  emergencyPotCents: Cents;
  /** Known balances today (null = no balances known yet). */
  currentAccountsCents: Cents | null;
  savingsAccountsCents: Cents | null;
  activeRecurring: RecurringDTO[];
  /** Last charge vs the previous usual amount for recurring payments whose amount went up. */
  priceIncreases: { name: string; previousCents: Cents; currentCents: Cents; date: IsoDate }[];
  /** Transfers and Bizum to other people in the reference month and the 3 previous. */
  peopleByMonth: Map<YearMonth, { cents: Cents; count: number }>;
  /** Large transfers to beneficiaries not reviewed yet. */
  pendingTransferReviews: number;
  cashByMonth: Map<YearMonth, Cents>;
  pots: PotDTO[];
  loans: { name: string; annualRateBp: number; outstandingCents: Cents; interestSavedCents: (amount: Cents) => Cents }[];
  /** Assumed yield used only to illustrate the cost of idle money. */
  illustrativeRateBp: number;
}

function rec(r: Omit<Recommendation, 'estimatedAnnualImpactCents'> & { annual?: Cents | null }): Recommendation {
  const { annual, ...rest } = r;
  return { ...rest, estimatedAnnualImpactCents: annual !== undefined ? annual : r.estimatedMonthlyImpactCents === null ? null : r.estimatedMonthlyImpactCents * 12 };
}

const VIDEO = ['NETFLIX', 'HBO', 'MAX', 'DISNEY', 'PRIME VIDEO', 'AMAZON PRIME', 'FILMIN', 'DAZN', 'MOVISTAR PLUS', 'SKYSHOWTIME', 'APPLE TV'];
const MUSIC = ['SPOTIFY', 'APPLE MUSIC', 'YOUTUBE PREMIUM', 'AMAZON MUSIC', 'DEEZER', 'TIDAL'];
const matches = (name: string, list: string[]) => list.some((k) => ` ${normalizeText(name)} `.includes(` ${k} `));

export function generateMoreRecommendations(ctx: MoreContext): Recommendation[] {
  const out: Recommendation[] = [];
  const ref = ctx.referenceMonth;
  const refLabel = formatMonth(ref);
  const cur = ctx.summaries.get(ref);
  const goals = new Set(ctx.profile.goals);

  // 1. Emergency fund for this profile.
  const target = ctx.essentialMonthlyCents * ctx.recommendedEmergencyMonths;
  const liquid = (ctx.currentAccountsCents ?? 0) + (ctx.savingsAccountsCents ?? 0);
  const cushion = ctx.currentAccountsCents === null && ctx.savingsAccountsCents === null ? ctx.emergencyPotCents : liquid;
  if (ctx.essentialMonthlyCents > 0 && cushion < target) {
    const months = cushion / ctx.essentialMonthlyCents;
    const gap = target - cushion;
    out.push(rec({
      key: `emergency_gap:${ctx.recommendedEmergencyMonths}:${Math.round(gap / 10000)}`,
      type: 'emergency_gap',
      title: `Tu colchón cubre ${months.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses; para ti conviene ${ctx.recommendedEmergencyMonths}`,
      description: `Con un gasto esencial de ${formatCents(ctx.essentialMonthlyCents)}/mes, ${ctx.recommendedEmergencyMonths} meses son ${formatCents(target)}. Te faltan ${formatCents(gap)}: apartando ${formatCents(Math.ceil(gap / 12))}/mes lo tendrías en un año.`,
      reason: `Colchón recomendado según tu perfil: ${ctx.recommendedEmergencyReason}.`,
      evidence: [
        ctx.currentAccountsCents !== null || ctx.savingsAccountsCents !== null ? `Dinero en tus cuentas: ${formatCents(liquid)}` : `Fondo de emergencia registrado: ${formatCents(ctx.emergencyPotCents)}`,
        `Gasto esencial medio: ${formatCents(ctx.essentialMonthlyCents)}/mes`,
      ],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: months < 1 || goals.has('emergency') ? 'high' : 'medium',
      category: null,
      tone: 'opportunity',
    }));
  }

  // 2. Idle money in current accounts beyond the cushion (educational: no products).
  if (ctx.currentAccountsCents !== null && ctx.essentialMonthlyCents > 0) {
    const buffer = ctx.essentialMonthlyCents * 1; // one month to operate day to day
    const cushionInSavings = ctx.savingsAccountsCents ?? 0;
    const cushionMissing = Math.max(0, target - cushionInSavings);
    const idle = ctx.currentAccountsCents - buffer - cushionMissing;
    if (idle >= 300000) {
      const yearly = Math.round((idle * ctx.illustrativeRateBp) / 10000);
      out.push(rec({
        key: `idle_cash:${Math.round(idle / 100000)}`,
        type: 'idle_cash',
        title: `Tienes unos ${formatCents(idle, { compact: true })} parados en cuenta corriente`,
        description: `Además de un mes de gastos y de tu colchón, sobran ${formatCents(idle)} sin rentabilidad. Como referencia, al ${formatBp(ctx.illustrativeRateBp, 1)} anual (supuesto) generarían unos ${formatCents(yearly)} al año; también podrías destinarlos a tus metas o deudas.`,
        reason: 'Saldo en cuentas corrientes por encima de lo que necesitas para el día a día y para imprevistos.',
        evidence: [`Cuentas corrientes: ${formatCents(ctx.currentAccountsCents)}`, `Colchón recomendado: ${formatCents(target)}`, `Ya en cuentas de ahorro: ${formatCents(cushionInSavings)}`],
        estimatedMonthlyImpactCents: Math.round(yearly / 12),
        priority: 'medium',
        category: null,
        tone: 'opportunity',
      }));
    }
  }

  // 3. Subscription price increases.
  for (const p of ctx.priceIncreases.slice(0, 3)) {
    const delta = p.currentCents - p.previousCents;
    out.push(rec({
      key: `price_up:${normalizeText(p.name)}:${p.currentCents}`,
      type: 'price_increase',
      title: `${p.name} ha subido de precio`,
      description: `El último cargo (${formatDate(p.date)}) fue de ${formatCents(p.currentCents)}, antes pagabas ${formatCents(p.previousCents)}: ${formatCents(delta)} más cada vez. Comprueba si te compensa o si hay un plan más barato.`,
      reason: 'Pago recurrente cuyo importe ha aumentado respecto a los anteriores.',
      evidence: [`Antes: ${formatCents(p.previousCents)}`, `Ahora: ${formatCents(p.currentCents)}`],
      estimatedMonthlyImpactCents: delta,
      priority: 'low',
      category: 'Suscripciones',
      tone: 'opportunity',
    }));
  }

  // 4. Overlapping subscriptions.
  const subs = ctx.activeRecurring.filter((r) => r.kind === 'subscription');
  const video = subs.filter((s) => matches(s.merchantName, VIDEO));
  const music = subs.filter((s) => matches(s.merchantName, MUSIC));
  for (const [group, list, min] of [['plataformas de vídeo', video, 3], ['servicios de música', music, 2]] as const) {
    if (list.length >= min) {
      const cheapest = [...list].sort((a, b) => a.monthlyCents - b.monthlyCents)[0]!;
      out.push(rec({
        key: `overlap:${group}:${list.length}`,
        type: 'overlapping_subscriptions',
        title: `Pagas ${list.length} ${group} a la vez`,
        description: `Suman ${formatCents(list.reduce((t, s) => t + s.monthlyCents, 0))}/mes. Alternarlas (una cada vez) o compartir un plan familiar suele ahorrar dinero sin perder contenido.`,
        reason: 'Varias suscripciones del mismo tipo activas al mismo tiempo.',
        evidence: list.map((s) => `${s.merchantName}: ${formatCents(s.monthlyCents)}/mes`),
        estimatedMonthlyImpactCents: cheapest.monthlyCents,
        priority: 'low',
        category: 'Suscripciones',
        tone: 'opportunity',
      }));
    }
  }

  // 5. Big non-monthly payments coming soon.
  const soon = ctx.activeRecurring
    .filter((r) => r.frequency !== 'monthly' && r.frequency !== 'weekly' && r.averageCents >= 10000)
    .filter((r) => r.nextDate >= ctx.today && r.nextDate <= addDaysIso(ctx.today, 60));
  if (soon.length) {
    const total = soon.reduce((t, r) => t + r.averageCents, 0);
    out.push(rec({
      key: `upcoming:${soon.map((s) => s.merchantId).join('-')}:${soon[0]!.nextDate}`,
      type: 'upcoming_payments',
      title: `En los próximos 60 días pagarás unos ${formatCents(total)} en recibos no mensuales`,
      description: 'Déjalos previstos para que no te pillen por sorpresa. Para el futuro, apartar cada mes la parte proporcional de los pagos anuales o trimestrales suaviza tu ahorro.',
      reason: 'Pagos periódicos (trimestrales, semestrales o anuales) detectados en tu historial.',
      evidence: soon.map((s) => `${s.merchantName}: ~${formatCents(s.averageCents)} el ${formatDate(s.nextDate)}`),
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: total >= 50000 ? 'medium' : 'low',
      category: null,
      tone: 'info',
    }));
  }

  // 6. Transfers and Bizum to people: largest "unknown" spending.
  const p = ctx.peopleByMonth.get(ref);
  if (p && cur && cur.spendingCents > 0 && p.cents >= 20000 && (ratioBp(p.cents, cur.spendingCents) ?? 0) >= 1500) {
    out.push(rec({
      key: `people:${ref}:${p.cents}`,
      type: 'people_transfers',
      title: `${formatCents(p.cents)} en Bizum y transferencias a otras personas`,
      description: `Son el ${formatBp(ratioBp(p.cents, cur.spendingCents), 0)} de tu gasto de ${refLabel}. Asigna a cada beneficiario su categoría real (alquiler → Vivienda, cenas → Restaurantes…) en «Cuentas → Revisa tus transferencias» para saber de verdad a qué dedicas el dinero.`,
      reason: 'Gasto sin categoría concreta: cuanto más se clasifica, más útiles son las sugerencias.',
      evidence: [`${p.count} movimientos en ${refLabel}`],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: 'medium',
      category: 'Bizum y transferencias',
      tone: 'info',
    }));
  }
  if (ctx.pendingTransferReviews > 0) {
    out.push(rec({
      key: `pending_transfers:${ctx.pendingTransferReviews}`,
      type: 'pending_transfers',
      title: `Confirma ${ctx.pendingTransferReviews === 1 ? '1 transferencia grande' : `${ctx.pendingTransferReviews} beneficiarios de transferencias grandes`}`,
      description: 'Se están tratando como dinero movido a otra cuenta tuya (no cuentan como gasto). Si alguna fue un pago, márcala para que tu ahorro sea exacto.',
      reason: 'Transferencias de 1.000 € o más a beneficiarios que aún no has revisado.',
      evidence: [],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: 'high',
      category: null,
      tone: 'info',
    }));
  }

  // 7. Lifestyle inflation: income up, savings not.
  const months = [...ctx.summaries.values()].filter((s) => s.hasData && s.month <= ref).sort((a, b) => a.month.localeCompare(b.month));
  if (months.length >= 6) {
    const last = months.slice(-3);
    const prev = months.slice(-6, -3);
    const avg = (xs: MonthSummary[], f: (s: MonthSummary) => number) => xs.reduce((t, s) => t + f(s), 0) / xs.length;
    const incNow = avg(last, (s) => s.incomeCents);
    const incBefore = avg(prev, (s) => s.incomeCents);
    const spendNow = avg(last, (s) => s.spendingCents);
    const spendBefore = avg(prev, (s) => s.spendingCents);
    if (incBefore > 0 && incNow >= incBefore * 1.05 && spendNow - spendBefore >= (incNow - incBefore) * 0.8) {
      out.push(rec({
        key: `lifestyle:${ref}`,
        type: 'lifestyle_inflation',
        title: 'Ganas más, pero también gastas más',
        description: `Tus ingresos medios han subido ${formatCents(Math.round(incNow - incBefore))}/mes en los últimos 3 meses, y tu gasto ${formatCents(Math.round(spendNow - spendBefore))}/mes. Apartar automáticamente parte de cada subida (por ejemplo la mitad) evita que desaparezca en gasto.`,
        reason: 'Comparación de los 3 últimos meses con los 3 anteriores.',
        evidence: [`Ingresos: ${formatCents(Math.round(incBefore))} → ${formatCents(Math.round(incNow))}`, `Gasto: ${formatCents(Math.round(spendBefore))} → ${formatCents(Math.round(spendNow))}`],
        estimatedMonthlyImpactCents: Math.round((incNow - incBefore) / 2),
        priority: 'medium',
        category: null,
        tone: 'opportunity',
      }));
    }
    // 8. Low savings rate against the usual 20 % reference.
    const rates = last.map((s) => s.savingsRateBp).filter((r): r is number => r !== null);
    if (rates.length === 3 && rates.every((r) => r < 1000)) {
      const avgRate = Math.round(rates.reduce((t, r) => t + r, 0) / 3);
      out.push(rec({
        key: `low_rate:${ref}`,
        type: 'low_savings_rate',
        title: `Ahorras el ${formatBp(avgRate, 0)} de tus ingresos`,
        description: `Una referencia habitual es ahorrar alrededor del 20 %. Llegar al 10 % supondría apartar unos ${formatCents(Math.max(0, Math.round(avg(last, (s) => s.incomeCents) * (1000 - avgRate) / 10000)))} más al mes.`,
        reason: 'Tasa de ahorro por debajo del 10 % en los 3 últimos meses.',
        evidence: last.map((s) => `${formatMonth(s.month)}: ${formatBp(s.savingsRateBp, 0)}`),
        estimatedMonthlyImpactCents: null,
        annual: null,
        priority: 'medium',
        category: null,
        tone: 'info',
      }));
    }
  }

  // 9. Cash withdrawals: spending without detail.
  const cash = ctx.cashByMonth.get(ref) ?? 0;
  if (cur && cur.spendingCents > 0 && cash >= 20000 && (ratioBp(cash, cur.spendingCents) ?? 0) >= 1000) {
    out.push(rec({
      key: `cash:${ref}:${cash}`,
      type: 'cash_withdrawals',
      title: `Sacaste ${formatCents(cash)} en efectivo`,
      description: `Es el ${formatBp(ratioBp(cash, cur.spendingCents), 0)} de tu gasto de ${refLabel} y no se sabe en qué se usó. Pagar con tarjeta o Bizum deja rastro y te ayuda a ver dónde ajustar.`,
      reason: 'Retiradas de efectivo por encima del 10 % del gasto del mes.',
      evidence: [],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: 'low',
      category: 'Efectivo',
      tone: 'info',
    }));
  }

  // 10. Savings goals behind schedule.
  for (const pot of ctx.pots.filter((x) => x.status === 'behind' || x.status === 'overdue').slice(0, 2)) {
    out.push(rec({
      key: `pot_behind:${pot.id}:${pot.savedCents}`,
      type: 'pot_behind',
      title: `«${pot.name}» va por detrás`,
      description: pot.requiredMonthlyCents
        ? `Para llegar a ${formatCents(pot.targetCents)}${pot.targetDate ? ` el ${formatDate(pot.targetDate)}` : ''} necesitas apartar ${formatCents(pot.requiredMonthlyCents)}/mes. También puedes ampliar el plazo.`
        : `Le faltan ${formatCents(pot.remainingCents)} y ya ha pasado su fecha objetivo.`,
      reason: 'El ritmo de aportaciones no alcanza el objetivo en la fecha prevista.',
      evidence: [`Llevas ${formatCents(pot.savedCents)} de ${formatCents(pot.targetCents)}`],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: 'medium',
      category: null,
      tone: 'opportunity',
    }));
  }

  // 11. Expensive debt when there is spare liquidity.
  const spare = ctx.currentAccountsCents !== null ? ctx.currentAccountsCents + (ctx.savingsAccountsCents ?? 0) - target - ctx.essentialMonthlyCents : 0;
  for (const l of ctx.loans.filter((x) => x.outstandingCents > 0 && x.annualRateBp >= 300).sort((a, b) => b.annualRateBp - a.annualRateBp).slice(0, 1)) {
    const amount = Math.min(l.outstandingCents, Math.max(0, Math.floor(spare / 100000) * 100000));
    if (amount < 100000) continue;
    const saved = l.interestSavedCents(amount);
    out.push(rec({
      key: `debt:${normalizeText(l.name)}:${amount}`,
      type: 'expensive_debt',
      title: `Amortizar ${formatCents(amount)} de «${l.name}» te ahorraría ${formatCents(saved)} en intereses`,
      description: `Tu préstamo cuesta un ${formatBp(l.annualRateBp, 2)} TIN y tienes liquidez por encima de tu colchón. Es un cálculo con tu cuadro de amortización (reduciendo plazo); revisa la comisión por amortización anticipada de tu contrato.`,
      reason: 'Deuda con interés alto y dinero disponible por encima del colchón recomendado.',
      evidence: [`Pendiente: ${formatCents(l.outstandingCents)}`, `Liquidez sobrante: ${formatCents(spare)}`],
      estimatedMonthlyImpactCents: null,
      annual: null,
      priority: (goals.has('debt') ? 'high' : 'medium') as Priority,
      category: 'Préstamos',
      tone: 'opportunity',
    }));
  }
  return out;
}

function addDaysIso(d: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
