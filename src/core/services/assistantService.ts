import { addDays, formatDate, monthOf, todayIso, type IsoDate } from '../../shared/dates';
import { formatBp, formatCents, ratioBp } from '../../shared/money';
import type { AssistantAnswer } from '../../shared/types';
import { bestParagraph, detectIntent, detectPeriod, findTarget, searchHelp, type Period } from '../domain/assistant';
import type { AccountsService } from './accountsService';
import type { AnalyticsService } from './analyticsService';
import type { BudgetsService } from './budgetsService';
import type { Repos } from './context';
import type { ForecastService } from './forecastService';
import type { WealthService } from './wealthService';

const EXAMPLES = [
  '¿Cuánto gasté en restaurantes el mes pasado?',
  '¿Cómo acabaré el mes?',
  '¿Qué pagos tengo esta semana?',
  '¿Cómo puedo ahorrar más?',
  '¿Cuánto he ahorrado este año?',
];

/** «Pregunta a Hormiga»: answers about your own money, computed on this computer. */
/** "El mes pasado has…", "Este año has…", "En mayo de 2026 has…". */
function inPeriod(p: Period): string {
  return /^(el|la|este|esta|hoy|ayer)\b/.test(p.label) ? p.label.charAt(0).toUpperCase() + p.label.slice(1) : `En ${p.label}`;
}

export class AssistantService {
  constructor(
    private readonly repos: Repos,
    private readonly analytics: AnalyticsService,
    private readonly accounts: AccountsService,
    private readonly forecast: ForecastService,
    private readonly budgets: BudgetsService,
    private readonly wealth: WealthService,
    private readonly now: () => Date,
  ) {}

  private today(): IsoDate {
    return todayIso(this.now());
  }

  ask(question: string): AssistantAnswer {
    const q = question.trim().slice(0, 300);
    if (!q) return { text: 'Escribe una pregunta sobre tu dinero.', facts: [], actions: [], suggestions: EXAMPLES };
    const intent = detectIntent(q);
    const hasData = this.analytics.availableMonths().length > 0;
    if (!hasData && !['help', 'balance'].includes(intent)) {
      return { text: 'Todavía no hay movimientos. Importa un extracto en «Documentos» o conecta Gmail y podré responderte con tus datos.', facts: [], actions: [{ label: 'Importar extractos', page: 'import' }], suggestions: [] };
    }
    switch (intent) {
      case 'spending': return this.spending(q);
      case 'income': return this.income(q);
      case 'savings': return this.savings(q);
      case 'balance': return this.balance();
      case 'recurring': return this.recurring(q);
      case 'forecast': return this.forecastAnswer();
      case 'upcoming': return this.upcoming(q);
      case 'tips': return this.tips();
      case 'budget': return this.budget();
      case 'networth': return this.networth();
      default: return this.help(q);
    }
  }

  private target(q: string) {
    const cats = this.repos.db.all<{ id: number; name: string; key: string | null }>('SELECT id, name, system_key AS key FROM categories WHERE excluded_from_spending = 0');
    const merchants = this.repos.db.all<{ id: number; name: string }>('SELECT id, display_name AS name FROM merchants');
    return findTarget(q, cats, merchants);
  }

  private spentIn(p: Period, target: ReturnType<AssistantService['target']>): { cents: number; n: number } {
    const filter = target ? (target.type === 'category' ? 'AND t.category_id = ?' : 'AND t.merchant_id = ?') : '';
    const r = this.repos.db.get<{ s: number | null; n: number }>(
      `SELECT -SUM(t.amount_cents) AS s, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ('expense','fee','cash_withdrawal','refund') AND t.date >= ? AND t.date <= ? ${filter}`,
      ...(target ? [p.from, p.to, target.id] : [p.from, p.to]),
    );
    return { cents: Math.max(0, Number(r?.s ?? 0)), n: Number(r?.n ?? 0) };
  }

  private spending(q: string): AssistantAnswer {
    const p = detectPeriod(q, this.today());
    const target = this.target(q);
    const now = this.spentIn(p, target);
    const what = target ? ` en ${target.name}` : '';
    const facts: AssistantAnswer['facts'] = [{ label: `Gasto${what} (${p.label})`, value: formatCents(now.cents) }];
    // Same length period just before, for context (months: previous month).
    const len = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86400000) + 1;
    const prev = { from: addDays(p.from, -len), to: addDays(p.from, -1), label: 'el periodo anterior', implicit: true };
    const before = this.spentIn(prev, target);
    if (before.cents > 0 && len >= 7) facts.push({ label: `Periodo anterior (${formatDate(prev.from)} – ${formatDate(prev.to)})`, value: formatCents(before.cents) });
    const text = now.n === 0
      ? `No tengo movimientos${what} en ${p.label}${this.dataNote(p)}.`
      : `${inPeriod(p)} has gastado ${formatCents(now.cents)}${what} (${now.n} ${now.n === 1 ? 'movimiento' : 'movimientos'})${this.dataNote(p)}.`;
    return {
      text,
      facts,
      actions: [{ label: 'Ver movimientos', page: 'transactions', params: { from: p.from, to: p.to, ...(target?.type === 'category' ? { categoryId: target.id } : target ? { merchantId: target.id } : {}) } }],
      suggestions: target ? [] : ['¿Cuánto gasté en restaurantes este mes?', '¿Cuánto gasté en supermercado el mes pasado?'],
    };
  }

  private income(q: string): AssistantAnswer {
    const p = detectPeriod(q, this.today());
    const r = this.repos.db.get<{ s: number | null; n: number }>(
      "SELECT SUM(amount_cents) AS s, COUNT(*) AS n FROM transactions WHERE is_excluded = 0 AND type = 'income' AND amount_cents > 0 AND date >= ? AND date <= ?",
      p.from, p.to,
    );
    const cents = Number(r?.s ?? 0);
    return {
      text: cents ? `${inPeriod(p)} has ingresado ${formatCents(cents)} (${r!.n} ${r!.n === 1 ? 'ingreso' : 'ingresos'})${this.dataNote(p)}.` : `No tengo ingresos registrados en ${p.label}${this.dataNote(p)}.`,
      facts: [{ label: `Ingresos (${p.label})`, value: formatCents(cents) }],
      actions: [{ label: 'Ver movimientos', page: 'transactions', params: { from: p.from, to: p.to } }],
      suggestions: [],
    };
  }

  private savings(q: string): AssistantAnswer {
    const p = detectPeriod(q, this.today(), 'this_year');
    const from = monthOf(p.from);
    const to = monthOf(p.to);
    const r = this.analytics.report({ from, to });
    const t = r.totals;
    const text = t.incomeCents <= 0
      ? `No tengo ingresos en ${p.label}, así que no puedo calcular tu ahorro.`
      : `${inPeriod(p)} has ahorrado ${formatCents(t.savingsCents)}: ingresos ${formatCents(t.incomeCents)} − gastos ${formatCents(t.spendingCents)}. Es un ${formatBp(ratioBp(t.savingsCents, t.incomeCents))} de lo que ingresaste.`;
    const facts: AssistantAnswer['facts'] = [
      { label: 'Ingresos', value: formatCents(t.incomeCents) },
      { label: 'Gastos', value: formatCents(t.spendingCents) },
      { label: 'Ahorro', value: formatCents(t.savingsCents) },
    ];
    if (t.principalRepaidCents > 0) facts.push({ label: 'De ello, capital de préstamos amortizado', value: formatCents(t.principalRepaidCents) });
    return { text, facts, actions: [{ label: 'Abrir «Ahorro»', page: 'savings' }], suggestions: ['¿Cómo puedo ahorrar más?'] };
  }

  private balance(): AssistantAnswer {
    const list = this.accounts.list().filter((a) => a.includeInNetWorth && a.sourceKind !== 'card');
    const known = list.filter((a) => a.balanceCents !== null);
    if (!known.length) return { text: 'Aún no sé el saldo de tus cuentas. Indícalo una vez en «Cuentas» y lo mantendré al día con tus movimientos.', facts: [], actions: [{ label: 'Ir a Cuentas', page: 'accounts' }], suggestions: [] };
    const total = known.reduce((t, a) => t + a.balanceCents!, 0);
    return {
      text: `Tienes ${formatCents(total)} en ${known.length === 1 ? 'tu cuenta' : `tus ${known.length} cuentas`}${list.length > known.length ? ` (falta el saldo de ${list.length - known.length})` : ''}.`,
      facts: known.map((a) => ({ label: a.name, value: formatCents(a.balanceCents!) })),
      actions: [{ label: 'Ver cuentas', page: 'accounts' }],
      suggestions: ['¿Cómo acabaré el mes?'],
    };
  }

  private recurring(q: string): AssistantAnswer {
    const target = this.target(q);
    const active = this.analytics.activeRecurring();
    if (target?.type === 'merchant') {
      const r = active.find((x) => x.merchantId === target.id);
      if (r) return { text: `${r.merchantName} te cuesta ${formatCents(r.monthlyCents)} al mes, ${formatCents(r.annualCents)} al año. El próximo cargo se espera hacia el ${formatDate(r.nextDate)}.`, facts: [], actions: [{ label: 'Ver recurrentes', page: 'recurring' }], suggestions: [] };
    }
    const s = this.analytics.recurringSummary();
    const subs = active.filter((r) => r.kind === 'subscription');
    return {
      text: `Tienes ${s.activeCount} pagos recurrentes que suman ${formatCents(s.monthlyCents)} al mes (${formatCents(s.annualCents)} al año)${subs.length ? `; ${subs.length} son suscripciones (${formatCents(subs.reduce((t, r) => t + r.monthlyCents, 0))}/mes)` : ''}.`,
      facts: s.top.map((r) => ({ label: r.merchantName, value: `${formatCents(r.monthlyCents)}/mes` })),
      actions: [{ label: 'Ver recurrentes', page: 'recurring' }],
      suggestions: ['¿Cómo puedo ahorrar más?'],
    };
  }

  private forecastAnswer(): AssistantAnswer {
    const o = this.forecast.overview();
    const facts: AssistantAnswer['facts'] = [];
    let text = '';
    if (o.monthEnd) {
      text = `A este ritmo terminarás el mes con unos ${formatCents(o.monthEnd.projectedSpendingCents)} de gasto${o.monthEnd.projectedSavingsCents !== null ? ` y ${formatCents(o.monthEnd.projectedSavingsCents)} de ahorro` : ''}.`;
      facts.push({ label: 'Gastado hasta hoy', value: formatCents(o.monthEnd.spentSoFarCents) }, { label: 'Recurrentes pendientes', value: formatCents(o.monthEnd.pendingRecurringCents) });
    } else if (o.balance) {
      // No movements of this month yet (statements arrive later): answer with the projected balance at month end.
      const monthEnd = o.balance.points.filter((pt) => monthOf(pt.date) === monthOf(this.today())).at(-1);
      text = monthEnd
        ? `Aún no tengo movimientos de este mes, pero con tus cobros, pagos y gasto habituales tu cuenta corriente terminará el mes con unos ${formatCents(monthEnd.balanceCents)}.`
        : 'Aún no tengo movimientos de este mes.';
    } else text = 'Aún no tengo movimientos de este mes. Indica el saldo de tu cuenta corriente en «Cuentas» y te diré cómo terminará.';
    if (o.balance) {
      text += ` Tu cuenta corriente bajará como mucho a ${formatCents(o.balance.min.balanceCents)} el ${formatDate(o.balance.min.date)}${o.balance.risk === 'ok' ? '.' : ': conviene que lo revises.'}`;
      facts.push({ label: `Saldo previsto el ${formatDate(o.balance.end.date)}`, value: formatCents(o.balance.end.balanceCents) });
    }
    if (o.staleDays !== null && o.staleDays > 7) text += ` (Tus movimientos llegan hasta el ${formatDate(o.dataUntil!)}.)`;
    return { text, facts, actions: [{ label: 'Abrir «Previsión»', page: 'forecast' }], suggestions: ['¿Qué pagos tengo esta semana?'] };
  }

  private upcoming(q: string): AssistantAnswer {
    const o = this.forecast.overview();
    const days = /mes/.test(q.toLowerCase()) ? 30 : 7;
    const list = o.upcoming.filter((e) => e.date <= addDays(o.today, days));
    if (!list.length) return { text: `No veo pagos ni cobros previstos en los próximos ${days} días.`, facts: [], actions: [{ label: 'Abrir «Previsión»', page: 'forecast' }], suggestions: [] };
    const out = list.filter((e) => e.amountCents < 0).reduce((t, e) => t - e.amountCents, 0);
    return {
      text: `En los próximos ${days} días espero ${list.length} ${list.length === 1 ? 'movimiento' : 'movimientos'}${out ? `, con ${formatCents(out)} en pagos` : ''}.`,
      facts: list.slice(0, 10).map((e) => ({ label: `${formatDate(e.date)} · ${e.label}`, value: formatCents(e.amountCents, { signed: true }) })),
      actions: [{ label: 'Abrir «Previsión»', page: 'forecast' }],
      suggestions: [],
    };
  }

  private tips(): AssistantAnswer {
    const o = this.forecast.overview();
    const top = [...o.levers].sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.monthlyCents - a.monthlyCents).slice(0, 4);
    if (!top.length) return { text: 'Con tus datos actuales no veo recortes claros: tu gasto está en línea con tus mejores meses. Revisa tus suscripciones en «Recurrentes» por si alguna sobra.', facts: [], actions: [{ label: 'Ver recurrentes', page: 'recurring' }], suggestions: [] };
    const total = top.filter((l) => l.suggested).reduce((t, l) => t + l.monthlyCents, 0);
    return {
      text: `Estas son tus mejores oportunidades${total ? `: solo con las sugeridas ahorrarías unos ${formatCents(total)} al mes (${formatCents(total * 12)} al año)` : ''}.`,
      facts: top.map((l) => ({ label: l.title, value: `${formatCents(l.monthlyCents)}/mes` })),
      actions: [{ label: 'Crear mi plan de ahorro', page: 'forecast', params: { section: 'plan' } }],
      suggestions: [],
    };
  }

  private budget(): AssistantAnswer {
    const b = this.budgets.overview();
    if (!b.lines.length) return { text: 'No tienes presupuestos. Puedes crearlos en «Ahorro» o convertir tu plan de ahorro en presupuestos desde «Previsión».', facts: [], actions: [{ label: 'Crear presupuestos', page: 'savings', params: { section: 'budgets' } }], suggestions: [] };
    const over = b.lines.filter((l) => l.status === 'over');
    return {
      text: over.length ? `Este mes te has pasado en ${over.map((l) => l.name).join(', ')}.` : `Vas dentro de presupuesto: llevas ${formatCents(b.totalSpentCents)} de ${formatCents(b.totalLimitCents)}.`,
      facts: b.lines.map((l) => ({ label: l.name, value: `${formatCents(l.spentCents)} de ${formatCents(l.limitCents)}` })),
      actions: [{ label: 'Ver presupuestos', page: 'savings', params: { section: 'budgets' } }],
      suggestions: [],
    };
  }

  private networth(): AssistantAnswer {
    const w = this.wealth.wealthOverview();
    return {
      text: `Tu patrimonio neto es de ${formatCents(w.netWorthCents)}: ${formatCents(w.totalAssetsCents)} en activos menos ${formatCents(w.totalLiabilitiesCents)} de deudas.`,
      facts: [],
      actions: [{ label: 'Abrir «Patrimonio»', page: 'wealth' }],
      suggestions: [],
    };
  }

  private help(q: string): AssistantAnswer {
    const found = searchHelp(q);
    if (!found.length) {
      return {
        text: 'No te he entendido. Puedo responder sobre tus gastos, ingresos, ahorro, saldo, pagos previstos, presupuestos o cómo usar Hormiga. Prueba con alguna de estas preguntas:',
        facts: [],
        actions: [{ label: 'Abrir la ayuda', page: 'help' }],
        suggestions: EXAMPLES,
      };
    }
    const a = found[0]!;
    return {
      text: bestParagraph(q, a),
      facts: [],
      actions: [{ label: `Ayuda: ${a.title}`, page: 'help', params: { section: a.id } }, ...(a.page && a.page !== 'help' ? [{ label: 'Ir allí', page: a.page, params: a.section ? { section: a.section } : undefined }] : [])],
      suggestions: found.slice(1).map((x) => x.title),
    };
  }

  private dataNote(p: Period): string {
    const until = this.repos.db.get<{ d: string | null }>('SELECT MAX(date) AS d FROM transactions WHERE is_excluded = 0')?.d ?? null;
    return until && until < p.to ? ` (tus movimientos llegan hasta el ${formatDate(until)})` : '';
  }
}
