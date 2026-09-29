import { useState } from 'react';
import { api, useQuery } from '../api';
import { useNavigate } from '../App';
import { addMonths, formatMonth, todayIso } from '../../../shared/dates';
import { formatBp, formatCents } from '../../../shared/money';
import type { Averages } from '../../../shared/types';
import { Callout, capitalize, Card, EmptyState, ErrorBox, Loading, Money, Segmented } from '../components/ui';
import { CategoryBars, MonthlyChart, MonthlyLegend, TrendLines } from '../components/charts';

type Preset = 'current' | '3' | '6' | '12' | 'custom';

export function AnalyticsPage() {
  const current = todayIso().slice(0, 7);
  const [preset, setPreset] = useState<Preset>('6');
  const [custom, setCustom] = useState({ from: addMonths(current, -11), to: current });
  const months = useQuery(() => api('analytics.dashboard'), []);
  const anchor = months.data?.availableMonths.includes(current) ? current : (months.data?.availableMonths.at(-1) ?? current);
  const range =
    preset === 'custom' ? custom
      : preset === 'current' ? { from: anchor, to: anchor }
        : { from: addMonths(anchor, -(Number(preset) - 1)), to: anchor };
  const q = useQuery(() => api('analytics.report', range), [range.from, range.to]);
  const navigate = useNavigate();
  const r = q.data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Análisis</h1>
          <p className="subtitle">{capitalize(formatMonth(range.from))}{range.from !== range.to ? ` – ${formatMonth(range.to)}` : ''}</p>
        </div>
        <div className="toolbar">
          <Segmented
            label="Periodo"
            value={preset}
            onChange={setPreset}
            options={[
              { value: 'current', label: anchor === current ? 'Mes actual' : 'Último mes' },
              { value: '3', label: '3 meses' },
              { value: '6', label: '6 meses' },
              { value: '12', label: '12 meses' },
              { value: 'custom', label: 'Personalizado' },
            ]}
          />
          {preset === 'custom' && (
            <>
              <label className="sr-only" htmlFor="an-from">Desde</label>
              <input id="an-from" type="month" className="input compact" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
              <label className="sr-only" htmlFor="an-to">Hasta</label>
              <input id="an-to" type="month" className="input compact" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
            </>
          )}
        </div>
      </div>

      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!r ? <Loading /> : r.monthsWithData === 0 ? (
        <Card><EmptyState title="Sin datos en este periodo" icon="chart">Elige otro periodo o importa extractos que lo cubran.</EmptyState></Card>
      ) : (
        <>
          <div className="grid grid-4">
            <Card><div className="stat-card"><span className="stat-label">Ingresos</span><span className="stat-value"><Money cents={r.totals.incomeCents} /></span></div></Card>
            <Card><div className="stat-card"><span className="stat-label">Gasto</span><span className="stat-value"><Money cents={r.totals.spendingCents} /></span>{r.totals.refundsCents > 0 && <span className="stat-sub">Neto de {formatCents(r.totals.refundsCents)} en devoluciones</span>}</div></Card>
            <Card><div className="stat-card"><span className="stat-label">Ahorro</span><span className="stat-value">{r.totals.incomeCents > 0 ? <Money cents={r.totals.savingsCents} /> : '—'}</span></div></Card>
            <Card><div className="stat-card"><span className="stat-label">Tasa de ahorro</span><span className="stat-value num">{formatBp(r.totals.savingsRateBp, 0)}</span></div></Card>
          </div>
          {r.monthsWithData < r.months.length && (
            <Callout tone="info">Solo {r.monthsWithData} de los {r.months.length} meses del periodo tienen datos. Los meses sin extracto no se cuentan como gasto cero.</Callout>
          )}

          <div className="grid grid-main">
            <Card title="Evolución mensual" actions={<MonthlyLegend showIncome={r.totals.incomeCents > 0} />}>
              {r.months.length < 2 ? <p className="muted">Selecciona un periodo de varios meses para ver la evolución.</p> : <MonthlyChart months={r.months} showIncome={r.totals.incomeCents > 0} />}
            </Card>
            <Card title="Medias mensuales" hint="Solo se muestran con histórico suficiente">
              <AveragesTable avg={r.averages} />
              <hr className="sep" style={{ margin: '14px 0' }} />
              <dl className="kv">
                <dt>Gasto recurrente</dt><dd><Money cents={r.fixedCents} /> <span className="muted small">({formatBp(r.recurringShareBp, 0)})</span></dd>
                <dt>Gasto variable</dt><dd><Money cents={r.variableCents} /></dd>
                <dt>Discrecional</dt><dd><Money cents={r.discretionaryCents} /></dd>
              </dl>
            </Card>
          </div>

          <div className="grid grid-2">
            <Card title="Categorías" hint="Gasto neto del periodo">
              <CategoryBars items={r.categories} max={12} onSelect={(categoryId) => navigate('transactions', { categoryId, from: `${range.from}-01`, to: `${range.to}-31` })} />
            </Card>
            <Card title="Comercios principales">
              <table className="table">
                <thead><tr><th>Comercio</th><th>Categoría</th><th className="right">Pagos</th><th className="right">Gasto</th></tr></thead>
                <tbody>
                  {r.merchants.map((m) => (
                    <tr key={m.merchantId} className="clickable" tabIndex={0} onClick={() => navigate('transactions', { merchantId: m.merchantId, from: `${range.from}-01`, to: `${range.to}-31` })} onKeyDown={(e) => e.key === 'Enter' && navigate('transactions', { merchantId: m.merchantId })}>
                      <td className="cell-main">{m.name}</td>
                      <td className="muted">{m.categoryName}</td>
                      <td className="right num">{m.txCount}</td>
                      <td className="right"><Money cents={m.spentCents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {r.months.length >= 2 && r.categoryTrends.length > 0 && (
            <Card title="Tendencia por categoría" hint="Las 6 categorías con más gasto">
              <TrendLines series={r.categoryTrends} />
              <div className="legend" style={{ marginTop: 8 }}>
                {r.categoryTrends.map((s) => <span key={s.categoryId}><span className="dot" style={{ background: s.color }} />{s.name}</span>)}
              </div>
            </Card>
          )}

          {r.profile.length > 0 && (
            <Card title="Patrones observados" hint="Descripción de tus datos, no una valoración">
              <ul className="feature-list">{r.profile.map((p) => <li key={p}>{p}</li>)}</ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function AveragesTable({ avg }: { avg: { avg3: Averages | null; avg6: Averages | null; avg12: Averages | null } }) {
  const rows: [string, Averages | null][] = [['3 meses', avg.avg3], ['6 meses', avg.avg6], ['12 meses', avg.avg12]];
  return (
    <table className="table">
      <thead><tr><th>Media</th><th className="right">Gasto</th><th className="right">Ahorro</th></tr></thead>
      <tbody>
        {rows.map(([label, a]) => (
          <tr key={label}>
            <td>{label}</td>
            {a ? (
              <>
                <td className="right"><Money cents={a.spendingCents} /></td>
                <td className="right">{a.incomeCents > 0 ? <Money cents={a.savingsCents} /> : '—'}</td>
              </>
            ) : (
              <td colSpan={2} className="right muted small">Histórico insuficiente</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
