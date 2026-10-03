import { useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { useNavigate } from '../App';
import { addDays, formatDate, formatMonth } from '../../../shared/dates';
import { formatCents } from '../../../shared/money';
import { accumulate, monthsToReach } from '../../../shared/planning';
import { FREQUENCY_LABELS, type ForecastOverview, type SavingsLeverDTO } from '../../../shared/types';
import { Badge, Callout, Card, EmptyState, ErrorBox, Loading, Money, useToast } from '../components/ui';
import { chartColors } from '../components/charts';

const short = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const monthsLabel = (n: number | null) => (n === null ? 'nunca a este ritmo' : n === 0 ? 'ya lo tienes' : n === 1 ? '1 mes' : n < 24 ? `${n} meses` : `${(n / 12).toLocaleString('es-ES', { maximumFractionDigits: 1 })} años`);

export function ForecastPage({ initialSection }: { initialSection?: string }) {
  const q = useQuery(() => api('forecast.overview'), []);
  const navigate = useNavigate();
  const loaded = q.data !== undefined;
  useEffect(() => {
    if (initialSection && loaded) setTimeout(() => document.getElementById(initialSection)?.scrollIntoView({ block: 'start' }), 200);
  }, [initialSection, loaded]);
  const o = q.data;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Previsión</h1>
          <p className="subtitle">Hacia dónde va tu dinero en las próximas semanas y qué puedes cambiar para ahorrar más. Todo se calcula con tu propio historial.</p>
        </div>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!o ? <Loading /> : !o.hasData ? (
        <Card><EmptyState title="Aún no hay movimientos" icon="sparkle" actions={<button className="btn primary" onClick={() => navigate('import')}>Importar extractos</button>}>Con uno o dos meses de movimientos, Hormiga podrá prever tu saldo, tus próximos pagos y dónde puedes ahorrar.</EmptyState></Card>
      ) : (
        <>
          {o.staleDays !== null && o.staleDays > 7 && (
            <Callout tone="warning">Tus movimientos llegan hasta el {formatDate(o.dataUntil!)}. Para una previsión fiable, sincroniza Gmail o importa los extractos recientes.</Callout>
          )}
          <BalanceCard o={o} />
          <IncomeCard o={o} />
          <div className="grid grid-2">
            <MonthCard o={o} />
            <UpcomingCard o={o} />
          </div>
          {o.seasonal.length > 0 && <SeasonalCard o={o} />}
          <PlanCard o={o} />
        </>
      )}
    </div>
  );
}

function BalanceCard({ o }: { o: ForecastOverview }) {
  const navigate = useNavigate();
  const c = chartColors();
  const b = o.balance;
  const data = useMemo(() => (b ? b.points.map((p) => ({ date: p.date, real: p.estimated ? null : p.balanceCents / 100, est: p.estimated ? p.balanceCents / 100 : null })) : []), [b]);
  if (!b) {
    return (
      <section id="balance" className="card" aria-label="Saldo previsto">
        <h2 className="card-title">Saldo previsto</h2>
        <Callout tone="info">{o.balanceNote} {o.balanceNote?.includes('Cuentas') && <button className="btn sm" onClick={() => navigate('accounts')}>Ir a Cuentas</button>}</Callout>
      </section>
    );
  }
  const tone = b.risk === 'negative' ? 'danger' : b.risk === 'low' ? 'warning' : 'success';
  return (
    <section id="balance" className="card" aria-label="Saldo previsto">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 className="card-title">Saldo previsto de tu cuenta corriente</h2>
        <span className="muted small">{b.accounts.join(', ')}</span>
      </div>
      <div className="hero-stats" style={{ borderTop: 0, padding: 0, margin: '8px 0 12px' }}>
        <div className="hero-stat"><span className="stat-label">Punto más bajo</span><span className={`stat-value num ${b.risk === 'ok' ? '' : 'gain-down'}`}>{formatCents(b.min.balanceCents)}</span><span className="stat-sub">el {formatDate(b.min.date)}</span></div>
        <div className="hero-stat"><span className="stat-label">Dentro de 60 días</span><span className="stat-value"><Money cents={b.end.balanceCents} /></span><span className="stat-sub">{formatDate(b.end.date)}</span></div>
        <div className="hero-stat"><span className="stat-label">Día de cobro</span><span className="stat-value">{b.payday ? `día ${b.payday}` : '—'}</span><span className="stat-sub">detectado en tus ingresos</span></div>
      </div>
      <div style={{ height: 240 }} role="img" aria-label={`Saldo previsto: mínimo de ${formatCents(b.min.balanceCents)} el ${formatDate(b.min.date)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={short} tick={{ fill: c.muted, fontSize: 12 }} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => `${Math.round(v).toLocaleString('es-ES')} €`} tick={{ fill: c.muted, fontSize: 12 }} width={78} />
            <Tooltip formatter={(v) => formatCents(Math.round(Number(v) * 100))} labelFormatter={(d) => formatDate(String(d))} contentStyle={{ background: c.surface, border: `1px solid ${c.grid}`, color: c.ink }} />
            <ReferenceLine y={b.lowThresholdCents / 100} stroke={c.c2} strokeDasharray="4 4" label={{ value: 'tu mínimo', fill: c.muted, fontSize: 11, position: 'insideTopRight' }} />
            <Area dataKey="real" name="Previsto" stroke={c.c1} fill={c.c1} fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="est" name="Estimado (sin datos aún)" stroke={c.c1} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Callout tone={tone}>
        {b.risk === 'negative'
          ? `Si no cambias nada, tu cuenta quedaría en negativo el ${formatDate(b.min.date)}. Mueve dinero de tu ahorro antes o aplaza algún gasto.`
          : b.risk === 'low'
            ? `Tu cuenta bajaría a ${formatCents(b.min.balanceCents)} el ${formatDate(b.min.date)}, por debajo de tu mínimo de ${formatCents(b.lowThresholdCents)}. Te avisaré con tiempo.`
            : `Tu cuenta no baja de ${formatCents(b.lowThresholdCents)} en los próximos 60 días.`}
      </Callout>
      <details className="small muted" style={{ marginTop: 8 }}>
        <summary>Cómo se calcula</summary>
        <ul>{b.explanation.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </section>
  );
}

function MonthCard({ o }: { o: ForecastOverview }) {
  const f = o.monthEnd;
  return (
    <section id="month" className="card" aria-label="Cierre del mes">
      <h2 className="card-title">Cómo acabará el mes</h2>
      {!f ? <p className="muted">Aún no hay movimientos de este mes.</p> : (
        <>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', margin: '8px 0' }}>
            <div><div className="stat-label">Gasto previsto</div><div className="stat-value"><Money cents={f.projectedSpendingCents} /></div></div>
            {f.projectedSavingsCents !== null && <div><div className="stat-label">Ahorro previsto</div><div className={`stat-value num ${f.projectedSavingsCents < 0 ? 'gain-down' : 'gain-up'}`}>{formatCents(f.projectedSavingsCents)}</div></div>}
          </div>
          <p className="small muted">Llevas {formatCents(f.spentSoFarCents)} en {f.dayOfMonth} de {f.daysInMonth} días; quedan {formatCents(f.pendingRecurringCents)} en recibos por llegar. Confianza {f.confidence === 'medium' ? 'media' : 'baja'}.</p>
          <details className="small muted"><summary>Cómo se calcula</summary><ul>{f.explanation.map((l) => <li key={l}>{l}</li>)}</ul></details>
        </>
      )}
    </section>
  );
}

function UpcomingCard({ o }: { o: ForecastOverview }) {
  const week = addDays(o.today, 7);
  return (
    <section id="upcoming" className="card" aria-label="Próximos 30 días">
      <h2 className="card-title">Próximos 30 días</h2>
      {o.upcoming.length === 0 ? <p className="muted">No hay cobros ni recibos previstos.</p> : (
        <ul className="timeline">
          {o.upcoming.slice(0, 14).map((e, i) => (
            <li key={`${e.date}-${e.label}-${i}`} className={e.date <= week ? 'soon' : ''}>
              <span className="tl-date">{short(e.date)}</span>
              <span className="tl-label">{e.label}{e.frequency && e.frequency !== 'monthly' ? <span className="muted small"> · {FREQUENCY_LABELS[e.frequency].toLowerCase()}</span> : null}</span>
              <span className={`tl-amount num ${e.amountCents > 0 ? 'gain-up' : ''}`}>{formatCents(e.amountCents, { signed: true })}</span>
            </li>
          ))}
        </ul>
      )}
      {o.upcoming.length > 14 && <p className="muted small">Y {o.upcoming.length - 14} más.</p>}
    </section>
  );
}

function SeasonalCard({ o }: { o: ForecastOverview }) {
  return (
    <section id="seasonal" className="card" aria-label="Meses caros que vienen">
      <h2 className="card-title">Meses caros que vienen</h2>
      <p className="muted small">El año pasado, estos meses gastaste bastante más de lo normal en algunas categorías. Apartar un poco cada mes evita el susto.</p>
      <ul className="plain-list">
        {o.seasonal.slice(0, 6).map((s) => (
          <li key={`${s.month}-${s.categoryId}`}>
            <strong>{formatMonth(s.month)} · {s.categoryName}:</strong> el año pasado {formatCents(s.lastYearCents)} (lo normal son {formatCents(s.usualCents)}). Prevé unos <strong>{formatCents(s.extraCents)}</strong> extra.
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanCard({ o }: { o: ForecastOverview }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(o.levers.filter((l) => l.suggested).map((l) => l.id)));
  const chosen = o.levers.filter((l) => selected.has(l.id));
  const extra = chosen.reduce((t, l) => t + l.monthlyCents, 0);
  const base = o.plan.baselineMonthlyCents ?? 0;
  const withPlan = base + extra;
  const c = chartColors();
  const series = useMemo(() => {
    const a = accumulate(0, base, 12);
    const b = accumulate(0, withPlan, 12);
    return a.map((v, i) => ({ m: i + 1, ahora: v / 100, plan: b[i]! / 100 }));
  }, [base, withPlan]);
  const toggle = (l: SavingsLeverDTO) => {
    const next = new Set(selected);
    if (next.has(l.id)) next.delete(l.id);
    else next.add(l.id);
    setSelected(next);
  };
  const budgetable = chosen.filter((l) => l.kind === 'category' && l.categoryId && l.targetCents);
  const applyBudgets = async () => {
    try {
      await api('budgets.setMany', { items: budgetable.map((l) => ({ categoryId: l.categoryId!, amountCents: l.targetCents! })) });
      invalidate();
      toast({ tone: 'info', message: `${budgetable.length === 1 ? 'Presupuesto creado' : `${budgetable.length} presupuestos creados`}. Te avisaré al 80 % y al pasarte.` });
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  const goals = [
    ...(o.plan.emergencyGapCents ? [{ name: 'Completar tu fondo de emergencia', remainingCents: o.plan.emergencyGapCents }] : []),
    ...o.plan.pots,
  ].slice(0, 5);
  return (
    <section id="plan" className="card" aria-label="Tu plan de ahorro">
      <h2 className="card-title">Tu plan de ahorro</h2>
      {o.levers.length === 0 ? (
        <p className="muted">Con tus datos actuales no hay recortes claros: tu gasto está en línea con tus mejores meses. Necesito al menos 6 meses de movimientos para comparar.</p>
      ) : (
        <>
          <p className="muted small">Marca lo que estás dispuesto a cambiar. Cada propuesta usa tus propios números: volver al nivel de tu mejor trimestre es realista porque ya lo hiciste.</p>
          <ul className="lever-list">
            {o.levers.map((l) => (
              <li key={l.id}>
                <label className="lever">
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l)} />
                  <span className="lever-body">
                    <span className="lever-title">{l.title} {o.plan.budgetedCategoryIds.includes(l.categoryId ?? -1) && <Badge tone="outline">con presupuesto</Badge>}</span>
                    <span className="small muted">{l.detail}</span>
                  </span>
                  <span className="lever-amount num">+{formatCents(l.monthlyCents)}<span className="muted small">/mes</span></span>
                </label>
              </li>
            ))}
          </ul>
          <div className="plan-summary">
            <div><div className="stat-label">Ahorro mensual ahora</div><div className="stat-value">{o.plan.baselineMonthlyCents === null ? '—' : formatCents(base)}</div></div>
            <div><div className="stat-label">Con tu plan</div><div className="stat-value gain-up">{formatCents(withPlan)}</div><div className="stat-sub">+{formatCents(extra)}/mes</div></div>
            <div><div className="stat-label">En un año, de más</div><div className="stat-value gain-up">{formatCents(extra * 12)}</div></div>
          </div>
          {o.plan.provisional && <p className="muted small">Tu ahorro actual es provisional: hay pocos meses de datos. {o.plan.baselineExplanation}</p>}
          <div style={{ height: 200 }} role="img" aria-label={`Ahorro acumulado en 12 meses: ${formatCents(base * 12)} ahora, ${formatCents(withPlan * 12)} con el plan`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="m" tickFormatter={(m: number) => `mes ${m}`} tick={{ fill: c.muted, fontSize: 12 }} />
                <YAxis tickFormatter={(v: number) => `${Math.round(v).toLocaleString('es-ES')} €`} tick={{ fill: c.muted, fontSize: 12 }} width={78} />
                <Tooltip formatter={(v) => formatCents(Math.round(Number(v) * 100))} labelFormatter={(m) => `Mes ${String(m)}`} contentStyle={{ background: c.surface, border: `1px solid ${c.grid}`, color: c.ink }} />
                <Line dataKey="ahora" name="A tu ritmo actual" stroke={c.muted} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                <Area dataKey="plan" name="Con tu plan" stroke={c.c1} fill={c.c1} fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {goals.length > 0 && (
            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>Meta</th><th className="num">Te falta</th><th className="num">A tu ritmo</th><th className="num">Con el plan</th></tr></thead>
              <tbody>
                {goals.map((g) => (
                  <tr key={g.name}><td>{g.name}</td><td className="num">{formatCents(g.remainingCents)}</td><td className="num">{monthsLabel(monthsToReach(g.remainingCents, base))}</td><td className="num">{monthsLabel(monthsToReach(g.remainingCents, withPlan))}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!budgetable.length} onClick={() => void applyBudgets()}>Convertir en presupuestos ({budgetable.length})</button>
            <button className="btn" onClick={() => navigate('recurring')}>Revisar suscripciones</button>
          </div>
          <p className="muted small">Los presupuestos vigilan cada categoría del plan y te avisan al 80 % y al pasarte. «Ahorro mensual ahora» es tu capacidad estimada (ingresos esperados − gastos medios).</p>
        </>
      )}
    </section>
  );
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function IncomeCard({ o }: { o: ForecastOverview }) {
  const list = o.income.sources.filter((s) => s.last12Cents >= 10000);
  if (!list.length) return null;
  const label = (k: string) => (k === 'payroll' ? 'Nómina' : k === 'employer_variable' ? 'Variable de tu empresa' : 'Otros ingresos');
  return (
    <section id="income" className="card" aria-label="Tus ingresos">
      <h2 className="card-title">Tus ingresos</h2>
      <p className="muted small">Agrupados por quién te paga. Lo que te transfiere la empresa de tu nómina aparte de ella (horas extra, incentivos, dietas…) cuenta como ingreso variable de tu empresa.</p>
      <table className="table">
        <thead><tr><th>Fuente</th><th className="num">Lo habitual</th><th>Cuándo</th><th className="num">Últimos 12 meses</th></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={`${s.kind}-${s.payer}`}>
              <td><div className="cell-main">{label(s.kind)}</div><div className="cell-sub">{s.payer}</div></td>
              <td className="num">{s.regular ? `${formatCents(s.monthlyCents)}/mes` : 'irregular'}</td>
              <td>
                {s.day ? `hacia el día ${s.day}` : '—'} <span className="muted small">· {s.monthsSeen} de 12 meses</span>
                {s.extraPays.length > 0 && <div className="small">Pagas extra: {s.extraPays.map((e) => `${MONTH_NAMES[e.month - 1]} (≈ ${formatCents(e.cents)})`).join(', ')}</div>}
              </td>
              <td className="num"><Money cents={s.last12Cents} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">Ingresos esperados: <strong>{formatCents(o.income.expectedMonthlyCents)}/mes</strong> y unos <strong>{formatCents(o.income.expectedYearCents)}</strong> al año con las pagas extra.</p>
    </section>
  );
}
