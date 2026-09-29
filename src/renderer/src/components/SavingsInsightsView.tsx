import { formatBp, formatCents } from '../../../shared/money';
import { formatDate, formatMonth } from '../../../shared/dates';
import { FREQUENCY_LABELS, type EmergencyInfo, type SavingsInsights } from '../../../shared/types';
import { useNavigate } from '../App';
import { Badge, Card, capitalize, Money } from './ui';

const SEGMENTS = [
  { key: 'essentialCents', label: 'Esenciales', color: 'var(--chart-3)' },
  { key: 'discretionaryCents', label: 'Discrecionales', color: 'var(--chart-2)' },
  { key: 'peopleCents', label: 'Bizum y transferencias', color: 'var(--chart-4, #8f7ab8)' },
  { key: 'otherCents', label: 'Otros (efectivo, comisiones…)', color: 'var(--muted)' },
  { key: 'savingsCents', label: 'Ahorro', color: 'var(--chart-1)' },
] as const;

/** Where the month's income went: a single stacked bar with a legend. */
export function MoneyFlowCard({ insights }: { insights: SavingsInsights }) {
  const f = insights.flow;
  const navigate = useNavigate();
  const base = Math.max(f.incomeCents, f.essentialCents + f.discretionaryCents + f.peopleCents + f.otherCents + Math.max(0, f.savingsCents));
  return (
    <Card title="Adónde va tu dinero" hint={capitalize(formatMonth(insights.month))}>
      {f.incomeCents <= 0 ? <p className="muted">Sin ingresos este mes: configura tus ingresos para ver el reparto.</p> : (
        <>
          <div className="flow-bar" role="img" aria-label={SEGMENTS.map((s) => `${s.label}: ${formatCents(Math.max(0, f[s.key]))}`).join(', ')}>
            {SEGMENTS.map((s) => {
              const v = Math.max(0, f[s.key]);
              return v > 0 ? <span key={s.key} style={{ width: `${(v * 100) / base}%`, background: s.color }} title={`${s.label}: ${formatCents(v)}`} /> : null;
            })}
          </div>
          <div className="flow-legend">
            {SEGMENTS.map((s) => (
              <div key={s.key} className="flow-item">
                <span className="dot" style={{ background: s.color }} aria-hidden />
                <span>{s.label}</span>
                <span className="num">{formatCents(f[s.key])}</span>
                <span className="muted small num">{formatBp(Math.round((f[s.key] * 10000) / f.incomeCents), 0)}</span>
              </div>
            ))}
          </div>
          {f.savingsCents < 0 && <p className="small" style={{ marginTop: 8 }}>Este mes gastaste {formatCents(-f.savingsCents)} más de lo que ingresaste.</p>}
          {f.movedToOwnCents > 0 && (
            <p className="small muted" style={{ marginTop: 8 }}>
              Además moviste <strong>{formatCents(f.movedToOwnCents)}</strong> a tus otras cuentas: no es gasto, sigue siendo tu dinero.{' '}
              <button className="btn link" onClick={() => navigate('accounts', { section: 'transfers' })}>Revisar transferencias</button>
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function BenchmarkCard({ insights }: { insights: SavingsInsights }) {
  const b = insights.benchmark;
  const rows = b
    ? [
        { label: 'Necesidades (esenciales)', value: b.needsBp, ref: 5000, better: 'lower' as const },
        { label: 'Deseos y resto de gastos', value: b.wantsBp, ref: 3000, better: 'lower' as const },
        { label: 'Ahorro', value: b.savingsBp, ref: 2000, better: 'higher' as const },
      ]
    : [];
  return (
    <Card title="Referencia 50/30/20" hint="Orientativa: 50 % necesidades, 30 % deseos, 20 % ahorro">
      {!b ? <p className="muted">Hace falta conocer tus ingresos del mes.</p> : (
        <div className="bar-list">
          {rows.map((r) => {
            const ok = r.better === 'lower' ? r.value <= r.ref : r.value >= r.ref;
            return (
              <div className="bar-row" key={r.label}>
                <div className="bar-row-top">
                  <span>{r.label}</span>
                  <span><span className="num">{formatBp(r.value, 0)}</span><span className="muted small"> · ref. {formatBp(r.ref, 0)}</span> {ok ? <Badge tone="positive">En línea</Badge> : <Badge tone="warning">{r.better === 'lower' ? 'Por encima' : 'Por debajo'}</Badge>}</span>
                </div>
                <div className="bar-track" aria-hidden>
                  <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(0, r.value / 100))}%`, background: ok ? 'var(--chart-1)' : 'var(--warning)' }} />
                  <div className="bar-ref" style={{ left: `${r.ref / 100}%` }} />
                </div>
              </div>
            );
          })}
          <p className="small muted">Es una regla general muy extendida, no un objetivo obligatorio: con alquiler alto o personas a cargo es normal que las necesidades pesen más.</p>
        </div>
      )}
    </Card>
  );
}

export function YearCard({ insights }: { insights: SavingsInsights }) {
  const y = insights.year;
  return (
    <Card title={`Tu ${y.year}`} hint={y.months ? `${y.months} ${y.months === 1 ? 'mes' : 'meses'} con datos` : undefined}>
      {y.months === 0 ? <p className="muted">Aún no hay meses de este año con ingresos y gastos.</p> : (
        <div className="grid grid-2">
          <div className="stat-card"><span className="stat-label">Ahorrado en el año</span><span className="stat-value"><Money cents={y.savedCents} /></span><span className="stat-sub">Media {formatCents(y.avgMonthlyCents)}/mes</span></div>
          <div className="stat-card"><span className="stat-label">Proyección a diciembre</span><span className="stat-value">{y.projectedCents !== null ? <Money cents={y.projectedCents} /> : '—'}</span><span className="stat-sub">Si mantienes tu media</span></div>
          <div className="stat-card">
            <span className="stat-label">Meses cumpliendo el objetivo</span>
            <span className="stat-value num">{y.monthsWithGoal ? `${y.monthsGoalMet} / ${y.monthsWithGoal}` : '—'}</span>
            <span className="stat-sub">{y.streak > 1 ? `Racha actual: ${y.streak} meses seguidos` : y.monthsWithGoal ? 'Sigue así' : 'Define un objetivo de ahorro'}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Mejor y peor mes</span>
            <span className="small">{y.best ? <>{capitalize(formatMonth(y.best.month, 'short'))}: <strong>{formatCents(y.best.cents)}</strong></> : '—'}</span>
            <span className="small">{y.worst ? <>{capitalize(formatMonth(y.worst.month, 'short'))}: <strong>{formatCents(y.worst.cents)}</strong></> : ''}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function CushionCard({ emergency, hasProfile }: { emergency: EmergencyInfo; hasProfile: boolean }) {
  const navigate = useNavigate();
  const target = emergency.essentialMonthlyCents * emergency.recommendedMonths;
  const have = emergency.liquidCents ?? emergency.savedCents;
  const months = emergency.essentialMonthlyCents > 0 ? have / emergency.essentialMonthlyCents : null;
  const pct = target > 0 ? Math.min(100, (have * 100) / target) : 0;
  return (
    <Card title="Colchón para imprevistos" hint={`Para ti: ${emergency.recommendedMonths} meses de gasto esencial`}>
      {emergency.essentialMonthlyCents === 0 ? <p className="muted">Hace falta al menos un mes completo de gastos para calcularlo.</p> : (
        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="stat-value"><Money cents={have} /></span>
            <span className="muted small">de {formatCents(target)}</span>
          </div>
          <div className="bar-track" aria-hidden><div className="bar-fill" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--chart-1)' : 'var(--warning)' }} /></div>
          <p className="small">
            {months !== null && <>Cubre <strong>{months.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses</strong> de gasto esencial ({formatCents(emergency.essentialMonthlyCents)}/mes). </>}
            {emergency.liquidCents !== null ? 'Calculado con el saldo de tus cuentas.' : 'Calculado con tu fondo de emergencia de «Metas» (indica el saldo de tus cuentas para afinarlo).'}
          </p>
          <p className="muted small">Por qué {emergency.recommendedMonths} meses: {emergency.recommendedReason}.</p>
          {!hasProfile && <button className="btn sm" onClick={() => navigate('settings', { section: 'profile' })}>Completar mi perfil para ajustarlo</button>}
        </div>
      )}
    </Card>
  );
}

export function UpcomingCard({ insights }: { insights: SavingsInsights }) {
  return (
    <Card title="Próximos pagos" hint="Recibos recurrentes en los próximos 60 días">
      {insights.upcoming.length === 0 ? <p className="muted">No hay pagos recurrentes previstos en los próximos 60 días.</p> : (
        <table className="table">
          <tbody>
            {insights.upcoming.slice(0, 8).map((u) => (
              <tr key={`${u.name}-${u.date}`}>
                <td className="num">{formatDate(u.date)}</td>
                <td>{u.name} <span className="muted small">· {FREQUENCY_LABELS[u.frequency].toLowerCase()}</span></td>
                <td className="right"><Money cents={u.amountCents} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {insights.nonMonthlyReserveCents > 0 && (
        <p className="small" style={{ marginTop: 8 }}>
          Tus pagos no mensuales ({insights.nonMonthly.map((n) => n.name).slice(0, 4).join(', ')}{insights.nonMonthly.length > 4 ? '…' : ''}) suman {formatCents(insights.nonMonthlyReserveCents * 12)} al año: apartar <strong>{formatCents(insights.nonMonthlyReserveCents)}/mes</strong> los cubre sin sustos.
        </p>
      )}
    </Card>
  );
}
