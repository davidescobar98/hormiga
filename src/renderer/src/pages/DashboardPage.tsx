import { Fragment, useState } from 'react';
import { api, useInvalidate, useQuery } from '../api';
import { useNavigate } from '../App';
import { formatBp, formatCents } from '../../../shared/money';
import { formatMonth } from '../../../shared/dates';
import { FREQUENCY_LABELS } from '../../../shared/types';
import { Badge, Callout, capitalize, Card, Delta, EmptyState, ErrorBox, Icon, Loading, Money, MonthSelect, ProgressBar } from '../components/ui';
import { CategoryBars, MonthlyChart, MonthlyLegend } from '../components/charts';
import { ImportButton, RecommendationCard } from '../components/flows';

function GoalsAndWealthCard() {
  const pots = useQuery(() => api('pots.overview'), []);
  const wealth = useQuery(() => api('wealth.overview'), []);
  const navigate = useNavigate();
  const p = pots.data;
  const w = wealth.data;
  if (!p || !w || (p.pots.length === 0 && w.assets.length === 0)) return null;
  const coverage = p.emergency.coverageTenths === null ? null : p.emergency.coverageTenths / 10;
  return (
    <Card title="Metas y patrimonio" actions={<button className="btn sm ghost" onClick={() => navigate('goals')}>Ver metas</button>}>
      <dl className="kv">
        {w.assets.length > 0 && <><dt>Patrimonio neto</dt><dd><Money cents={w.netWorthCents} /></dd></>}
        {p.emergency.potId && <><dt>Fondo de emergencia</dt><dd>{coverage === null ? '—' : `${coverage.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses de gasto esencial`}</dd></>}
        {p.pots.filter((x) => x.kind === 'goal').slice(0, 3).map((x) => (
          <Fragment key={x.id}><dt>{x.name}</dt><dd><ProgressBar valueBp={x.progressBp} label={`Progreso de ${x.name}`} /><span className="muted small"><Money cents={x.savedCents} /> de <Money cents={x.targetCents} /></span></dd></Fragment>
        ))}
      </dl>
    </Card>
  );
}

function comparisonLabel(label: string): string {
  if (label === 'Mes anterior') return 'el mes anterior';
  return label.replace(/^Media (\d+) meses$/, 'la media de $1 meses');
}

export function DashboardPage() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const q = useQuery(() => api('analytics.dashboard', month ? { month } : undefined), [month]);
  const navigate = useNavigate();
  const invalidate = useInvalidate();

  if (q.error && !q.data) return <div className="page"><ErrorBox error={q.error} onRetry={q.reload} /></div>;
  if (!q.data) return <div className="page"><Loading /></div>;
  const d = q.data;

  if (!d.hasData) {
    return (
      <div className="page">
        <div className="page-header"><h1>Resumen</h1></div>
        <Card>
          <EmptyState
            title="No tienes movimientos todavía"
            actions={
              <>
                <ImportButton />
                <button className="btn" onClick={() => navigate('settings', { section: 'email' })}><Icon name="mail" /> Conectar Gmail</button>
                <button className="btn ghost" onClick={async () => { await api('data.loadDemo'); invalidate(); }}>Ver con datos de demostración</button>
              </>
            }
          >
            Importa tus movimientos (PDF de BBVA, Excel de CaixaBank, imagin, Sabadell, Santander, ING… o Norma 43) o conecta Gmail para que Hormiga encuentre los extractos de BBVA automáticamente.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const s = d.summary;
  const proj = d.projection;
  const savings = proj ? proj.savingsCents : s.savingsCents;
  const rate = proj ? proj.savingsRateBp : s.savingsRateBp;
  const goal = proj ? proj.goal : s.goal;
  const monthLabel = formatMonth(d.referenceMonth);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Resumen</h1>
          <p className="subtitle">
            {d.isCurrentCalendarMonth ? 'Mes en curso' : 'Último mes con datos'} · {d.monthsOfData} {d.monthsOfData === 1 ? 'mes' : 'meses'} de histórico
          </p>
        </div>
        <div className="toolbar">
          <MonthSelect value={d.referenceMonth} months={d.availableMonths} onChange={setMonth} label="Mes del resumen" />
        </div>
      </div>

      {(d.reviewPending > 0 || d.uncategorizedCount > 0) && (
        <div className="stack">
          {d.reviewPending > 0 && (
            <Callout tone="warning">
              Hay {d.reviewPending} movimiento(s) pendientes de revisión que aún no cuentan en tus cifras.{' '}
              <button className="btn link" onClick={() => navigate('import')}>Revisar importación</button>
            </Callout>
          )}
          {d.uncategorizedCount > 0 && (
            <Callout tone="info">
              {d.uncategorizedCount} movimiento(s) sin clasificar.{' '}
              <button className="btn link" onClick={() => navigate('transactions', { uncategorizedOnly: true })}>Clasificarlos</button>
            </Callout>
          )}
        </div>
      )}

      <section className="card hero" aria-label={`Resumen de ${monthLabel}`}>
        <div className="hero-main">
          <span className="stat-label">Gasto de {monthLabel}{d.isCurrentCalendarMonth ? ' (hasta hoy)' : ''}</span>
          <span className="hero-figure num">{formatCents(s.spendingCents)}</span>
          {d.projection && d.comparisons.length > 0 && <span className="muted small">Previsión a fin de mes frente a:</span>}
          <div className="chips">
            {d.comparisons.length === 0 && <span className="muted small">Aún no hay suficientes meses para comparar.</span>}
            {d.comparisons.map((c) => (
              <Delta key={c.label} deltaCents={c.deltaCents} deltaBp={c.deltaBp} reliable={c.reliable} label={comparisonLabel(c.label)} />
            ))}
          </div>
          {s.refundsCents > 0 && <span className="muted small">Incluye {formatCents(s.refundsCents)} de devoluciones descontadas.</span>}
          {d.forecast && (
            <div className="card flat" style={{ padding: '10px 12px' }}>
              <div className="stat-label">Previsión a fin de mes · estimación {d.forecast.confidence === 'low' ? 'provisional' : 'orientativa'}</div>
              <div className="row" style={{ gap: 16, marginTop: 4 }}>
                <span>Gasto <strong className="num">{formatCents(d.forecast.projectedSpendingCents)}</strong></span>
                {d.forecast.projectedSavingsCents !== null && <span>Ahorro <strong className="num">{formatCents(d.forecast.projectedSavingsCents)}</strong></span>}
              </div>
              <details style={{ marginTop: 4 }}>
                <summary>Cómo se calcula</summary>
                <ul className="evidence">{d.forecast.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
              </details>
            </div>
          )}
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="stat-label">Ingresos</span>
            <span className="stat-value"><Money cents={s.incomeCents} /></span>
            <span className="stat-sub">{s.incomeCents > 0 ? s.incomeSource : <button className="btn link" onClick={() => navigate('settings', { section: 'income' })}>Configurar ingresos</button>}</span>
          </div>
          <div className="hero-stat">
            <span className="stat-label">{proj ? 'Ahorro previsto' : 'Ahorro'}</span>
            <span className="stat-value">{savings !== null && s.incomeCents > 0 ? <Money cents={savings} /> : <span className="muted">—</span>}</span>
            <span className="stat-sub">{proj ? 'Ingresos − gasto previsto a fin de mes' : 'Ingresos − gasto'}</span>
          </div>
          <div className="hero-stat">
            <span className="stat-label">{proj ? 'Tasa prevista' : 'Tasa de ahorro'}</span>
            <span className="stat-value num">{formatBp(rate, 0)}</span>
            <span className="stat-sub">{rate === null ? 'Sin ingresos en el mes' : 'Ahorro / ingresos'}</span>
          </div>
          <div className="hero-stat">
            <span className="stat-label">Objetivo</span>
            {goal ? (
              <>
                <span className="stat-value"><Money cents={goal.targetCents} /></span>
                <ProgressBar valueBp={goal.progressBp} label="Progreso hacia el objetivo de ahorro" />
                <span className="stat-sub">
                  <Badge tone={goal.status === 'below' ? 'warning' : 'positive'}>
                    {proj ? 'Previsión: ' : ''}{goal.status === 'above' ? 'por encima' : goal.status === 'on_track' ? 'dentro del objetivo' : 'por debajo'}
                  </Badge>
                </span>
              </>
            ) : (
              <>
                <span className="stat-value muted">—</span>
                <span className="stat-sub"><button className="btn link" onClick={() => navigate('savings')}>Definir objetivo</button></span>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="grid grid-main">
        <Card title="Evolución" hint="Gasto, ingresos y ahorro por mes" actions={<MonthlyLegend showIncome={d.monthly.some((m) => m.incomeCents > 0)} />}>
          {d.monthly.length < 2 ? (
            <p className="muted">Aún no hay suficientes meses para mostrar una evolución.</p>
          ) : (
            <MonthlyChart months={d.monthly} showIncome={d.monthly.some((m) => m.incomeCents > 0)} />
          )}
        </Card>
        <Card title="En qué gastas" hint={capitalize(monthLabel)} actions={<button className="btn sm ghost" onClick={() => navigate('analytics')}>Ver análisis</button>}>
          {d.topCategories.length === 0 ? <p className="muted">Sin gasto en este mes.</p> : (
            <CategoryBars items={d.topCategories} onSelect={(categoryId) => navigate('transactions', { categoryId, from: `${d.referenceMonth}-01`, to: `${d.referenceMonth}-31` })} />
          )}
        </Card>
      </div>

      <div className="grid grid-main">
        <Card title="Recomendaciones" hint="Basadas únicamente en tus datos" actions={<button className="btn sm ghost" onClick={() => navigate('savings')}>Ver ahorro</button>}>
          {d.recommendations.length === 0 ? (
            <p className="muted">No hay nada destacable que revisar ahora mismo.{d.monthsOfData < 3 ? ' Con más meses de histórico podremos detectar tendencias.' : ''}</p>
          ) : (
            <div className="stack">
              {d.recommendations.map((r) => (
                <RecommendationCard key={r.key} rec={r} onDismiss={async () => { await api('recommendations.dismiss', { key: r.key }); invalidate(); }} />
              ))}
            </div>
          )}
        </Card>
        <div className="stack" style={{ gap: 16 }}>
          <Card title="Gastos recurrentes" actions={<button className="btn sm ghost" onClick={() => navigate('recurring')}>Ver todos</button>}>
            {d.recurring.activeCount === 0 ? (
              <p className="muted">No se han detectado gastos recurrentes todavía.</p>
            ) : (
              <div className="stack">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span><strong className="num">{formatCents(d.recurring.monthlyCents)}</strong>/mes</span>
                  <span className="muted small num">{formatCents(d.recurring.annualCents)}/año · {d.recurring.activeCount} activos</span>
                </div>
                <ul className="feature-list">
                  {d.recurring.top.map((r) => (
                    <li key={r.id} style={{ justifyContent: 'space-between' }}>
                      <span>{r.merchantName} <span className="muted small">· {FREQUENCY_LABELS[r.frequency].toLowerCase()}</span></span>
                      <Money cents={r.monthlyCents} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <GoalsAndWealthCard />
          <Card title="Estado de los datos">
            <dl className="kv">
              <dt>Último documento</dt>
              <dd>{d.lastDocument ? <>{d.lastDocument.fileName}<div className="muted small">{new Date(d.lastDocument.importedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</div></> : <span className="muted">Solo datos de demostración</span>}</dd>
              <dt>Última sincronización</dt>
              <dd>{d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : <span className="muted">Nunca</span>}</dd>
            </dl>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm" onClick={() => navigate('import')}>Documentos</button>
            </div>
          </Card>
        </div>
      </div>
      {d.previous && (
        <p className="muted small">
          Mes anterior ({formatMonth(d.previous.month)}): gasto {formatCents(d.previous.spendingCents)}
          {d.previous.incomeCents > 0 ? `, ahorro ${formatCents(d.previous.savingsCents)}` : ''}.
        </p>
      )}
    </div>
  );
}
