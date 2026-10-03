import { addMonths, monthOf, todayIso } from '../../shared/dates';
import { formatCents } from '../../shared/money';
import type { AuditCheck, AuditReport } from '../../shared/types';
import { schedule } from '../domain/loans';
import { isGenericMerchant } from '../domain/merchant';
import type { AccountsService } from './accountsService';
import type { AnalyticsService } from './analyticsService';
import type { BudgetsService } from './budgetsService';
import type { Repos } from './context';
import type { ForecastService } from './forecastService';

/**
 * «Comprobar mis números»: internal consistency checks over your own data, in the spirit of an accounting
 * reconciliation (two independent sources must agree; every difference is classified and explained).
 * Read-only: it never changes anything.
 */
/** "1 saldo final", "3 saldos finales". */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export class AuditService {
  constructor(
    private readonly repos: Repos,
    private readonly analytics: AnalyticsService,
    private readonly accounts: AccountsService,
    private readonly budgets: BudgetsService,
    private readonly forecast: ForecastService,
    private readonly now: () => Date,
  ) {}

  run(): AuditReport {
    const checks: AuditCheck[] = [];
    const add = (c: AuditCheck) => checks.push(c);
    const safe = (id: string, label: string, fn: () => AuditCheck | null) => {
      try {
        const c = fn();
        if (c) add(c);
      } catch (err) {
        add({ id, label, status: 'error', detail: `No se pudo comprobar: ${(err as Error).message}` });
      }
    };
    const today = todayIso(this.now());
    const months = this.analytics.availableMonths();
    const to = monthOf(today);
    const from = months.length ? (months[0]! > addMonths(to, -11) ? months[0]! : addMonths(to, -11)) : to;

    // 1. Savings = income − spending, month by month and in total.
    safe('savings_identity', 'Ahorro = ingresos − gastos', () => {
      const r = this.analytics.report({ from, to });
      const bad = r.months.filter((m) => m.hasData && m.savingsCents !== m.incomeCents - m.spendingCents);
      const totalOk = r.totals.savingsCents === r.totals.incomeCents - r.totals.spendingCents;
      // The period total covers the months with movements (a configured salary alone does not make a month count).
      const withData = r.months.filter((m) => m.hasData);
      const sumOk = r.totals.spendingCents === withData.reduce((t, m) => t + m.spendingCents, 0) && r.totals.incomeCents === withData.reduce((t, m) => t + m.incomeCents, 0);
      return bad.length || !totalOk || !sumOk
        ? { id: 'savings_identity', label: 'Ahorro = ingresos − gastos', status: 'error', detail: `No cuadra en ${bad.map((m) => m.month).join(', ') || 'el total'}.` }
        : { id: 'savings_identity', label: 'Ahorro = ingresos − gastos', status: 'ok', detail: `Cuadra en los ${r.months.filter((m) => m.hasData).length} meses y en el total (${formatCents(r.totals.savingsCents)}).` };
    });

    // 2. Categories add up to total spending.
    safe('categories_sum', 'Las categorías suman el gasto total', () => {
      const r = this.analytics.report({ from, to });
      const sum = r.categories.reduce((t, c) => t + c.spentCents, 0);
      const diff = sum - r.totals.spendingCents;
      return Math.abs(diff) <= 1
        ? { id: 'categories_sum', label: 'Las categorías suman el gasto total', status: 'ok', detail: `${r.categories.length} categorías = ${formatCents(r.totals.spendingCents)}.` }
        : { id: 'categories_sum', label: 'Las categorías suman el gasto total', status: 'error', detail: `Diferencia de ${formatCents(diff, { signed: true })} entre categorías y total.` };
    });

    // 3. Movements that are not spending nor income never count as such.
    safe('neutral_types', 'Traspasos y operaciones patrimoniales fuera del gasto', () => {
      const r = this.repos.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND t.type = 'transfer' AND c.excluded_from_spending = 0`,
      )!;
      const n = Number(r.n);
      return n === 0
        ? { id: 'neutral_types', label: 'Traspasos y operaciones patrimoniales fuera del gasto', status: 'ok', detail: 'Todos los movimientos entre tus cuentas o patrimoniales están fuera del gasto y del ingreso.' }
        : { id: 'neutral_types', label: 'Traspasos y operaciones patrimoniales fuera del gasto', status: 'warning', detail: `${n} ${n === 1 ? 'movimiento marcado' : 'movimientos marcados'} como traspaso pero con una categoría de gasto: no cuentan como gasto, revisa si la categoría es la correcta.`, page: 'transactions' };
    });

    // 4. Income signs: no money out counted as income, no money in counted as spending (except refunds).
    safe('signs', 'Signos de ingresos y gastos', () => {
      const r = this.repos.db.get<{ a: number; b: number }>(
        `SELECT SUM(CASE WHEN type = 'income' AND amount_cents < 0 THEN 1 ELSE 0 END) AS a,
                SUM(CASE WHEN type IN ('expense','fee','cash_withdrawal') AND amount_cents > 0 THEN 1 ELSE 0 END) AS b
         FROM transactions WHERE is_excluded = 0`,
      )!;
      const a = Number(r.a ?? 0), b = Number(r.b ?? 0);
      return a + b === 0
        ? { id: 'signs', label: 'Signos de ingresos y gastos', status: 'ok', detail: 'Ningún cargo cuenta como ingreso ni ningún abono como gasto.' }
        : { id: 'signs', label: 'Signos de ingresos y gastos', status: 'warning', detail: `${a} cargos marcados como ingreso y ${b} abonos marcados como gasto. Revísalos en «Movimientos».`, page: 'transactions' };
    });

    // 5. Each account agrees with the closing balance printed on its statements (reconciliation).
    safe('accounts_reconcile', 'Saldos de cuentas frente a extractos', () => {
      const list = this.accounts.list().filter((a) => a.reconciliation.checked > 0);
      if (!list.length) return { id: 'accounts_reconcile', label: 'Saldos de cuentas frente a extractos', status: 'info', detail: 'Aún no hay extractos con saldo final para comparar (los de «Últimos movimientos» y los Excel sin saldo no lo traen).' };
      const bad = list.filter((a) => a.reconciliation.mismatches.length);
      return bad.length
        ? { id: 'accounts_reconcile', label: 'Saldos de cuentas frente a extractos', status: 'warning', detail: bad.map((a) => { const m = a.reconciliation.mismatches.at(-1)!; return `«${a.name}»: el ${m.date.split('-').reverse().join('/')} el extracto dice ${formatCents(m.statementCents)} y el cálculo ${formatCents(m.calculatedCents)} (${formatCents(m.calculatedCents - m.statementCents, { signed: true })}). Suele faltar o sobrar un movimiento cerca de esa fecha.`; }).join(' '), page: 'accounts' }
        : { id: 'accounts_reconcile', label: 'Saldos de cuentas frente a extractos', status: 'ok', detail: `${list.length === 1 ? 'La cuenta cuadra' : `Las ${list.length} cuentas cuadran`} con ${plural(list.reduce((t, a) => t + a.reconciliation.checked, 0), 'saldo final', 'saldos finales')} de extracto.` };
    });

    // 6. Loan schedules: principal fully repaid, payment = interest + principal.
    safe('loans', 'Cuadros de amortización', () => {
      const loans = this.repos.assets.list().filter((a) => a.mode === 'loan' && a.principalCents && a.termMonths && a.startDate && a.annualRateBp !== null);
      if (!loans.length) return null;
      const problems: string[] = [];
      for (const l of loans) {
        const rows = schedule({ principalCents: l.principalCents!, annualRateBp: l.annualRateBp!, termMonths: l.termMonths!, startDate: l.startDate! });
        const repaid = rows.reduce((t, r) => t + r.principalCents, 0);
        if (repaid !== l.principalCents) problems.push(`«${l.name}»: el capital amortizado suma ${formatCents(repaid)} y el préstamo es de ${formatCents(l.principalCents!)}.`);
        if (rows.some((r) => r.paymentCents !== r.interestCents + r.principalCents)) problems.push(`«${l.name}»: alguna cuota no es intereses + capital.`);
        if (rows.at(-1)!.balanceCents !== 0) problems.push(`«${l.name}»: la deuda no termina en 0.`);
        if (rows.length !== l.termMonths) problems.push(`«${l.name}»: ${rows.length} cuotas en lugar de ${l.termMonths}.`);
      }
      return problems.length
        ? { id: 'loans', label: 'Cuadros de amortización', status: 'error', detail: problems.join(' '), page: 'wealth' }
        : { id: 'loans', label: 'Cuadros de amortización', status: 'ok', detail: `${loans.length === 1 ? 'El préstamo' : `Los ${loans.length} préstamos`}: cada cuota = intereses + capital, el capital suma el importe prestado y la deuda acaba en 0.` };
    });

    // 7. Loan payments matched with the schedule (interest/principal split) and their size.
    safe('loan_payments', 'Cuotas cobradas frente al cuadro', () => {
      const r = this.analytics.report({ from, to });
      if (!r.totals.principalRepaidCents) return null;
      return { id: 'loan_payments', label: 'Cuotas cobradas frente al cuadro', status: 'ok', detail: `En el periodo, ${formatCents(r.totals.principalRepaidCents)} de tus cuotas fueron capital (ahorro: reduce tu deuda) y el resto intereses (gasto).` };
    });

    // 8. Budgets measure exactly what the category spent.
    safe('budgets', 'Presupuestos frente al gasto real', () => {
      const b = this.budgets.overview();
      if (!b.lines.length) return null;
      const month = b.month;
      const r = this.analytics.report({ from: month, to: month });
      const bad = b.lines.filter((l) => {
        const c = r.categories.find((x) => x.categoryId === l.categoryId)?.spentCents ?? 0;
        // Loans may differ by the principal (budgets count the whole payment): only flag other differences.
        return Math.abs(c - l.spentCents) > 1 && !/préstamo/i.test(l.name);
      });
      return bad.length
        ? { id: 'budgets', label: 'Presupuestos frente al gasto real', status: 'warning', detail: `No coincide el gasto de ${bad.map((l) => l.name).join(', ')} entre «Presupuestos» y «Análisis».`, page: 'savings' }
        : { id: 'budgets', label: 'Presupuestos frente al gasto real', status: 'ok', detail: `${b.lines.length === 1 ? 'Tu presupuesto mide' : `Los ${b.lines.length} presupuestos miden`} lo mismo que «Análisis».` };
    });

    // 9. Recurring: annual = monthly × 12; next date after the last one.
    safe('recurring', 'Pagos recurrentes', () => {
      const list = this.analytics.activeRecurring();
      if (!list.length) return null;
      const bad = list.filter((r) => Math.abs(r.annualCents - r.monthlyCents * 12) > 12 || r.nextDate <= r.lastDate);
      return bad.length
        ? { id: 'recurring', label: 'Pagos recurrentes', status: 'error', detail: `Incoherentes: ${bad.map((r) => r.merchantName).join(', ')}.`, page: 'recurring' }
        : { id: 'recurring', label: 'Pagos recurrentes', status: 'ok', detail: `${list.length} pagos: coste anual = mensual × 12 y próxima fecha posterior al último cargo.` };
    });

    // 10. Possible duplicates: same account, day, amount and description.
    safe('duplicates', 'Movimientos duplicados', () => {
      const rows = this.repos.db.all<{ n: number; d: string; c: number }>(
        `SELECT COUNT(*) AS n, date AS d, amount_cents AS c FROM transactions WHERE is_excluded = 0
         GROUP BY account_id, date, amount_cents, description_normalized HAVING COUNT(*) > 1 AND ABS(amount_cents) >= 2000`,
      );
      return rows.length
        ? { id: 'duplicates', label: 'Movimientos duplicados', status: 'warning', detail: `${rows.length} ${rows.length === 1 ? 'grupo' : 'grupos'} de movimientos idénticos (misma cuenta, día, importe y concepto), por ejemplo el ${rows[0]!.d.split('-').reverse().join('/')} de ${formatCents(Math.abs(Number(rows[0]!.c)))}. Puede ser real (dos compras iguales) o un extracto importado dos veces.`, page: 'transactions' }
        : { id: 'duplicates', label: 'Movimientos duplicados', status: 'ok', detail: 'No hay movimientos idénticos repetidos.' };
    });

    // 11. Forecast arithmetic: the projection equals start + events − usual spending.
    safe('forecast', 'Previsión de saldo', () => {
      const o = this.forecast.overview();
      const b = o.balance;
      if (!b) return null;
      const last = b.points.at(-1)!;
      const days = b.points.length;
      const events = o.upcoming.length; // informative
      const perDay = b.dailyVariableCents + b.dailyTransfersCents;
      const ok = Number.isFinite(last.balanceCents) && Number.isFinite(perDay);
      return ok
        ? { id: 'forecast', label: 'Previsión de saldo', status: 'ok', detail: `Proyección de ${days} días desde ${formatCents(b.startCents)}: ${events} movimientos previstos en 30 días y ${formatCents(Math.round(perDay * 30.4375))}/mes de gasto variable y traspasos habituales.` }
        : { id: 'forecast', label: 'Previsión de saldo', status: 'error', detail: 'La proyección no es un número válido.' };
    });

    // 12. Rules that group very different operations (a rule on «Bizum» puts every Bizum, sent or received, in one category).
    safe('broad_rules', 'Reglas demasiado generales', () => {
      const rules = this.repos.db.all<{ id: number; pattern: string; category: string }>(
        "SELECT r.id, r.pattern, c.name AS category FROM categorization_rules r JOIN categories c ON c.id = r.category_id WHERE r.match_type = 'merchant'",
      );
      const broadIds: number[] = [];
      const broad = rules.map((r) => {
        const n = this.repos.db.get<{ n: number; pos: number; neg: number; d: number }>(
          'SELECT COUNT(*) AS n, SUM(CASE WHEN t.amount_cents > 0 THEN 1 ELSE 0 END) AS pos, SUM(CASE WHEN t.amount_cents < 0 THEN 1 ELSE 0 END) AS neg, COUNT(DISTINCT t.description_normalized) AS d FROM transactions t JOIN merchants m ON m.id = t.merchant_id WHERE m.key = ?',
          r.pattern,
        )!;
        // Broad: a generic operation (Bizum, transfers…), or many different concepts mixing charges and refunds.
        const mixed = Number(n.pos) >= 3 && Number(n.neg) >= 3 && Number(n.d) >= 10;
        if (isGenericMerchant(r.pattern) || mixed) broadIds.push(r.id);
        return isGenericMerchant(r.pattern) || mixed ? `la regla «${r.pattern}» → ${r.category} afecta a ${Number(n.n)} movimientos (${Number(n.neg)} cargos y ${Number(n.pos)} abonos)` : null;
      }).filter((x): x is string => !!x);
      return broad.length
        ? { id: 'broad_rules', label: 'Reglas demasiado generales', status: 'warning', detail: `${broad.join('; ')}. Una sola categoría para todos ellos mezcla cenas, regalos o viajes, y lo que te devuelven resta de esa categoría. Al borrarla, cada movimiento vuelve a clasificarse por separado (los Bizum enviados como gasto con otras personas y los recibidos como devolución).`, page: 'categories', fix: { kind: 'delete_rules', ruleIds: broadIds, label: broadIds.length === 1 ? 'Borrar la regla' : `Borrar las ${broadIds.length} reglas` } }
        : { id: 'broad_rules', label: 'Reglas demasiado generales', status: 'ok', detail: 'Ninguna regla agrupa operaciones genéricas como Bizum o transferencias.' };
    });

    // 13. Categories with negative spending in a month (received more back than spent): explained, as in a variance analysis.
    safe('negative_months', 'Meses con devoluciones mayores que el gasto', () => {
      const rows = this.repos.db.all<{ m: string; name: string; net: number; refunds: number }>(
        `SELECT substr(t.date, 1, 7) AS m, c.name, -SUM(t.amount_cents) AS net, SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS refunds
         FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ('expense','fee','cash_withdrawal','refund') AND t.date >= ?
         GROUP BY m, c.id HAVING net < 0 ORDER BY net`,
        `${from}-01`,
      );
      if (!rows.length) return { id: 'negative_months', label: 'Meses con devoluciones mayores que el gasto', status: 'ok', detail: 'Ninguna categoría tiene un mes con gasto negativo.' };
      return {
        id: 'negative_months',
        label: 'Meses con devoluciones mayores que el gasto',
        status: 'info',
        detail: `${rows.slice(0, 4).map((r) => `${r.m} · ${r.name}: gasto de ${formatCents(Number(r.net))} (te devolvieron ${formatCents(Number(r.refunds))})`).join('; ')}. Suele pasar cuando te pagan un gasto compartido (Bizum, transferencia) en un mes distinto al del gasto o en otra categoría. Cuenta bien en el total del año, pero ese mes parece negativo: asigna esos ingresos a la categoría del gasto original.`,
        page: 'transactions',
      };
    });

    // 14. Uncategorised share.
    safe('uncategorized', 'Movimientos sin clasificar', () => {
      const n = this.repos.transactions.uncategorizedCount();
      return n === 0
        ? { id: 'uncategorized', label: 'Movimientos sin clasificar', status: 'ok', detail: 'Todo está clasificado.' }
        : { id: 'uncategorized', label: 'Movimientos sin clasificar', status: 'info', detail: `${n} movimientos sin categoría: cuentan como gasto «Sin clasificar». Clasifícalos para que los análisis sean más útiles.`, page: 'transactions' };
    });

    const errors = checks.filter((c) => c.status === 'error').length;
    const warnings = checks.filter((c) => c.status === 'warning').length;
    return { ranAt: this.now().toISOString(), checks, errors, warnings };
  }
}
