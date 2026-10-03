import { addDays, formatDate, isoWeekKey, type IsoDate } from '../../shared/dates';
import { formatCents } from '../../shared/money';
import type { AlertDTO } from '../../shared/types';
import type { GmailAuth } from '../email/gmailAuth';
import type { AnalyticsService } from './analyticsService';
import type { Logger, Repos } from './context';
import type { ForecastService } from './forecastService';

/** Alerts important enough to email (the rest stay in the app and, optionally, as Windows notifications). */
export function isImportant(a: Pick<AlertDTO, 'kind' | 'key'>): boolean {
  if (a.kind === 'budget') return a.key.endsWith(':100');
  return ['low_balance', 'duplicate_charge', 'unusual_charge', 'spending_pace', 'stock_sell'].includes(a.kind);
}

export interface WeeklySummary {
  title: string;
  /** Short text for a Windows notification. */
  short: string;
  /** Full text for the email. */
  text: string;
}

/**
 * Emails to yourself (with the optional Gmail send permission) and the Monday summary. Nothing is sent anywhere
 * else: the message goes from your Gmail account to your own address.
 */
export class NotifyService {
  constructor(
    private readonly repos: Repos,
    private readonly gmail: GmailAuth,
    private readonly analytics: AnalyticsService,
    private readonly forecast: ForecastService,
    private readonly log: Logger,
    private readonly now: () => Date,
  ) {}

  private async emailReady(): Promise<string | null> {
    const s = this.repos.settings.getSettings();
    if (!s.notifications.email) return null;
    const to = this.repos.settings.getEmailAccount();
    if (!to || this.repos.settings.getRaw('email.authError')) return null;
    if (!(await this.gmail.canSend())) return null;
    return to;
  }

  /** Emails the important alerts among the new ones (one message). Returns how many were included. */
  async emailAlerts(fresh: AlertDTO[]): Promise<number> {
    const important = fresh.filter(isImportant);
    if (!important.length) return 0;
    const to = await this.emailReady();
    if (!to) return 0;
    const amounts = this.repos.settings.getSettings().notifications.emailAmounts;
    const subject = important.length === 1 ? `Hormiga: ${important[0]!.title}` : `Hormiga: ${important.length} avisos importantes`;
    const lines = important.map((a) => (amounts ? `• ${a.title}\n  ${a.body}` : `• ${a.title}`));
    const text = [
      'Hola,',
      '',
      important.length === 1 ? 'Hormiga ha detectado algo que conviene que mires:' : 'Hormiga ha detectado varias cosas que conviene que mires:',
      '',
      ...lines,
      '',
      amounts ? 'Abre Hormiga en tu ordenador para ver el detalle.' : 'Por privacidad este correo no incluye importes: ábrelos en Hormiga en tu ordenador.',
      '',
      '— Hormiga (este correo te lo envías tú mismo desde tu cuenta; puedes desactivarlo en Ajustes → Avisos).',
    ].join('\n');
    try {
      await this.gmail.sendToSelf(to, subject, text);
      this.log.info('notify.email_sent', { n: important.length });
      return important.length;
    } catch (err) {
      this.log.warn('notify.email_failed', { code: (err as { code?: string }).code ?? 'ERROR' });
      return 0;
    }
  }

  /** The Monday summary is due once per week, from Monday 8:00 (local time). */
  weeklyDue(): boolean {
    const s = this.repos.settings.getSettings();
    if (!s.notifications.weeklySummary || !s.onboardingCompleted) return false;
    const now = this.now();
    // From Monday 8:00; if the PC was off on Monday, any later day of the same week.
    if (now.getDay() === 1 && now.getHours() < 8) return false;
    const key = isoWeekKey(now);
    return this.repos.settings.getRaw<string>('notify.weeklyLast') !== key;
  }

  markWeeklySent(): void {
    this.repos.settings.setRaw('notify.weeklyLast', isoWeekKey(this.now()));
  }

  weeklySummary(): WeeklySummary | null {
    const o = this.forecast.overview();
    if (!o.hasData) return null;
    const today = o.today;
    const weekAgo = addDays(today, -7);
    const spent = this.spentBetween(weekAgo, today);
    const avg = this.analytics.savings().avg3?.spendingCents ?? null;
    const usualWeek = avg !== null ? Math.round((avg / 30.4375) * 7) : null;
    const next7 = o.upcoming.filter((e) => e.date <= addDays(today, 7));
    const out7 = next7.filter((e) => e.amountCents < 0).reduce((t, e) => t - e.amountCents, 0);
    const lines: string[] = [];
    if (o.staleDays !== null && o.staleDays > 7) lines.push(`Tus movimientos llegan hasta el ${formatDate(o.dataUntil!)}: sincroniza o importa los extractos nuevos para que el resumen esté al día.`);
    lines.push(
      usualWeek !== null
        ? `Últimos 7 días: ${formatCents(spent)} de gasto (una semana normal para ti son unos ${formatCents(usualWeek)}).`
        : `Últimos 7 días: ${formatCents(spent)} de gasto.`,
    );
    if (next7.length) {
      lines.push(`Próximos 7 días: ${next7.length === 1 ? '1 pago previsto' : `${next7.length} movimientos previstos`}${out7 ? ` (${formatCents(out7)} en pagos)` : ''}:`);
      for (const e of next7.slice(0, 6)) lines.push(`  · ${formatDate(e.date)} ${e.label}: ${formatCents(e.amountCents, { signed: true })}`);
    }
    if (o.monthEnd) lines.push(`Previsión de este mes: ${formatCents(o.monthEnd.projectedSpendingCents)} de gasto${o.monthEnd.projectedSavingsCents !== null ? ` y ${formatCents(o.monthEnd.projectedSavingsCents)} de ahorro` : ''}.`);
    if (o.balance && o.balance.risk !== 'ok') lines.push(`Atención: tu cuenta corriente podría bajar a ${formatCents(o.balance.min.balanceCents)} el ${formatDate(o.balance.min.date)}.`);
    const top = o.levers.find((l) => l.suggested);
    if (top) lines.push(`Idea para ahorrar: ${top.title} (≈ ${formatCents(top.monthlyCents)}/mes). ${top.detail}`);
    const short = usualWeek !== null
      ? `Has gastado ${formatCents(spent)} esta semana (lo normal: ${formatCents(usualWeek)}).${next7.length ? ` Próximos 7 días: ${formatCents(out7)} en pagos.` : ''}`
      : `Has gastado ${formatCents(spent)} esta semana.`;
    return { title: 'Tu semana en Hormiga', short, text: ['Hola,', '', ...lines, '', '— Hormiga (resumen semanal; puedes desactivarlo en Ajustes → Avisos).'].join('\n') };
  }

  async emailWeekly(summary: WeeklySummary): Promise<boolean> {
    const to = await this.emailReady();
    if (!to) return false;
    const amounts = this.repos.settings.getSettings().notifications.emailAmounts;
    try {
      await this.gmail.sendToSelf(to, `Hormiga: ${summary.title.toLowerCase()}`, amounts ? summary.text : 'Hola,\n\nTu resumen semanal está listo en Hormiga (este correo no incluye importes por privacidad).\n\n— Hormiga');
      return true;
    } catch (err) {
      this.log.warn('notify.weekly_email_failed', { code: (err as { code?: string }).code ?? 'ERROR' });
      return false;
    }
  }

  /** Test message from the settings screen. */
  async sendTest(): Promise<void> {
    const to = this.repos.settings.getEmailAccount();
    if (!to) throw new Error('No hay ninguna cuenta de Gmail conectada.');
    await this.gmail.sendToSelf(to, 'Hormiga: correo de prueba', 'Hola,\n\nAsí te llegarán los avisos importantes de Hormiga (saldo bajo previsto, cargos duplicados o inusuales, presupuestos superados, señales de venta…) y el resumen de los lunes.\n\n— Hormiga');
  }

  private spentBetween(from: IsoDate, to: IsoDate): number {
    const r = this.repos.db.get<{ s: number | null }>(
      `SELECT -SUM(t.amount_cents) AS s FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.is_excluded = 0 AND c.excluded_from_spending = 0 AND t.type IN ('expense','fee','cash_withdrawal','refund') AND t.date > ? AND t.date <= ?`,
      from, to,
    );
    return Math.max(0, Number(r?.s ?? 0));
  }
}
