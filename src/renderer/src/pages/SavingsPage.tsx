import { useState } from 'react';
import { api, useInvalidate, useQuery } from '../api';
import { formatMonth } from '../../../shared/dates';
import { formatBp, formatCents } from '../../../shared/money';
import { Badge, Callout, capitalize, Card, EmptyState, ErrorBox, Loading, Money, MonthSelect } from '../components/ui';
import { SavingsHistoryChart } from '../components/charts';
import { GoalEditor, RecommendationCard } from '../components/flows';
import { useNavigate } from '../App';
import { BenchmarkCard, CushionCard, MoneyFlowCard, UpcomingCard, YearCard } from '../components/SavingsInsightsView';
import { BudgetsCard } from '../components/BudgetsCard';
import { ExtraordinaryCard } from '../components/ExtraordinaryCard';

export function SavingsPage() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const q = useQuery(() => api('analytics.savings', month ? { month } : undefined), [month]);
  const recs = useQuery(() => api('recommendations.list'), []);
  const months = useQuery(() => api('analytics.dashboard'), []);
  const settings = useQuery(() => api('settings.get'), []);
  const profile = settings.data?.profile;
  const hasProfile = !!profile && (profile.household !== null || profile.incomeStability !== null || profile.housing !== null || profile.ownerNames.length > 0);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const s = q.data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Ahorro</h1>
          <p className="subtitle">Ahorro real (ingresos − gastos) y capacidad estimada a partir de tu histórico. Hormiga no ofrece consejos de inversión.</p>
        </div>
        {s && months.data && <MonthSelect value={s.month} months={months.data.availableMonths} onChange={setMonth} label="Mes" />}
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!s ? <Loading /> : !s.hasData ? (
        <Card><EmptyState title="Aún no hay datos para calcular tu ahorro" icon="piggy">Importa extractos y configura tus ingresos para ver tu ahorro real y tu capacidad de ahorro.</EmptyState></Card>
      ) : (
        <>
          {s.summary.incomeCents === 0 && (
            <Callout tone="warning">
              No hay ingresos para {formatMonth(s.month)}. El ahorro se calcula como ingresos − gastos.{' '}
              <button className="btn link" onClick={() => navigate('settings', { section: 'income' })}>Configurar ingresos</button>
            </Callout>
          )}
          <section className="card hero" aria-label="Ahorro del mes">
            <div className="hero-main">
              <span className="stat-label">Ahorro de {formatMonth(s.month)}</span>
              <span className="hero-figure num">{s.summary.incomeCents > 0 ? formatCents(s.summary.savingsCents) : '—'}</span>
              <span className="muted small">{formatCents(s.summary.incomeCents)} de ingresos − {formatCents(s.summary.spendingCents)} de gasto</span>
              {s.summary.principalRepaidCents > 0 && <span className="muted small">Además has amortizado {formatCents(s.summary.principalRepaidCents)} de capital de tu préstamo: no es gasto, reduce tu deuda.</span>}
              {s.goalStatus && (
                <div className="row">
                  <Badge tone={s.goalStatus.status === 'below' ? 'warning' : 'positive'}>
                    {s.goalStatus.status === 'above' ? 'Por encima del objetivo' : s.goalStatus.status === 'on_track' ? 'Dentro del objetivo' : 'Por debajo del objetivo'}
                  </Badge>
                  <span className="small">{s.goalStatus.description}</span>
                </div>
              )}
            </div>
            <div className="hero-stats">
              <div className="hero-stat">
                <span className="stat-label">Objetivo</span>
                <span className="stat-value">{s.goalStatus ? <Money cents={s.goalStatus.targetCents} /> : '—'}</span>
                <span className="stat-sub">{s.goal ? (s.goal.mode === 'percent' ? `${formatBp(s.goal.percentBp, 0)} de ingresos` : 'Importe fijo') : 'Sin objetivo'}</span>
              </div>
              <div className="hero-stat">
                <span className="stat-label">Diferencia</span>
                <span className="stat-value">{s.goalStatus ? <Money cents={s.goalStatus.differenceCents} signed /> : '—'}</span>
                <span className="stat-sub">Ahorro − objetivo</span>
              </div>
              <div className="hero-stat">
                <span className="stat-label">Tasa de ahorro</span>
                <span className="stat-value num">{formatBp(s.summary.savingsRateBp, 0)}</span>
                <span className="stat-sub">Ahorro / ingresos</span>
              </div>
              <div className="hero-stat">
                <span className="stat-label">Medias</span>
                <span className="small">3 meses: {s.avg3 ? <strong><Money cents={s.avg3.savingsCents} /></strong> : <span className="muted">histórico insuficiente</span>}</span>
                <span className="small">6 meses: {s.avg6 ? <strong><Money cents={s.avg6.savingsCents} /></strong> : <span className="muted">histórico insuficiente</span>}</span>
              </div>
            </div>
          </section>

          {!hasProfile && settings.data && (
            <Callout tone="info">
              Cuéntale a Hormiga un poco de ti (con quién vives, tus ingresos, lo que más valoras y tu nombre en el banco) para que las sugerencias se ajusten a tu situación y reconozca tus traspasos entre cuentas.{' '}
              <button className="btn link" onClick={() => navigate('settings', { section: 'profile' })}>Completar mi perfil</button>
            </Callout>
          )}
          <ExtraordinaryCard />
          <section id="budgets"><BudgetsCard /></section>
          <div className="grid grid-main">
            <MoneyFlowCard insights={s.insights} />
            <BenchmarkCard insights={s.insights} />
          </div>
          <div className="grid grid-3">
            <YearCard insights={s.insights} />
            <CushionCard emergency={s.emergency} hasProfile={hasProfile} />
            <UpcomingCard insights={s.insights} />
          </div>

          <Card title="Sugerencias para ahorrar" hint="Calculadas con tus datos; ninguna recomienda productos financieros">
            {!recs.data ? <Loading /> : recs.data.length === 0 ? <p className="muted">Sin sugerencias por ahora.</p> : (
              <div className="grid grid-2">
                {recs.data.slice(0, 10).map((r) => (
                  <RecommendationCard key={r.key} rec={r} onDismiss={async () => { await api('recommendations.dismiss', { key: r.key }); invalidate(); }} />
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-main">
            <Card title="Capacidad de ahorro estimada" hint="Fórmula completa, con tus datos">
              {s.capacity.notes.map((n) => <Callout key={n} tone="warning">{n}</Callout>)}
              <div className="formula" style={{ marginTop: s.capacity.notes.length ? 12 : 0 }}>
                {s.capacity.lines.map((l) => (
                  <div key={l.label} className={`formula-row ${l.op === '=' ? 'total' : ''}`}>
                    <span className="formula-op" aria-hidden>{l.op === '+' ? '' : l.op === '-' ? '−' : '='}</span>
                    <div>
                      <div>{l.label}</div>
                      <div className="muted small">{l.explanation}</div>
                    </div>
                    <span className="num">{l.op === '-' ? '−' : ''}{formatCents(l.cents)}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Objetivo de ahorro">
              <GoalEditor />
            </Card>
          </div>

          <Card title="Escenarios" hint="Estimaciones mensuales, no garantías">
            <div className="grid grid-3">
              {s.scenarios.map((sc) => (
                <div key={sc.id} className={`scenario ${sc.id === 'goal' ? 'highlight' : ''}`}>
                  <span className="stat-label">{sc.label}</span>
                  <span className="stat-value"><Money cents={sc.monthlySavingsCents} />/mes</span>
                  {sc.id === 'goal' && !sc.achievable && <Badge tone="warning">Exigente</Badge>}
                  <p className="small muted">{sc.explanation}</p>
                </div>
              ))}
              {s.scenarios.length < 3 && (
                <div className="scenario">
                  <span className="stat-label">Objetivo personal</span>
                  <p className="small muted">Define un objetivo para ver cuánto tendrías que ajustar tu gasto.</p>
                </div>
              )}
            </div>
          </Card>

          <Card title="Ahorro por mes" hint="Barras: ahorro real · línea: objetivo">
            {s.history.length === 0 ? <p className="muted">Sin meses con datos.</p> : <SavingsHistoryChart history={s.history} />}
          </Card>
          <p className="muted small">
            {capitalize(formatMonth(s.month))} · {s.monthsOfData} meses de datos. Ahorrar es la diferencia entre lo que ingresas y lo que gastas; Hormiga no recomienda productos financieros ni inversiones.
          </p>
        </>
      )}
    </div>
  );
}
