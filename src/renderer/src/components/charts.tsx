import { Bar, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import { formatCents } from '../../../shared/money';
import { formatMonth } from '../../../shared/dates';
import type { CategoryBreakdown, MonthSummary } from '../../../shared/types';
import { formatBp } from '../../../shared/money';

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function chartColors() {
  return {
    c1: cssVar('--chart-1', '#0f6b5c'),
    c2: cssVar('--chart-2', '#c47a2c'),
    c3: cssVar('--chart-3', '#2f5f8a'),
    grid: cssVar('--chart-grid', '#e6e3da'),
    muted: cssVar('--muted', '#69717d'),
    ink: cssVar('--ink', '#1c2430'),
    surface: cssVar('--surface', '#ffffff'),
  };
}

const euroTick = (v: number) => formatCents(v, { compact: true });

interface TooltipPayload {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
}

function MoneyTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <div style={{ fontWeight: 650, marginBottom: 4 }}>{label ? formatMonth(label) : ''}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="dot" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="num">{formatCents(Number(p.value ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

/** Monthly spending (bars) vs income and savings (lines). Months without data are not drawn as zero. */
export function MonthlyChart({ months, height = 280, showIncome = true }: { months: MonthSummary[]; height?: number; showIncome?: boolean }) {
  const c = chartColors();
  const data = months.map((m) => ({
    month: m.month,
    Gasto: m.hasData ? m.spendingCents : null,
    Ingresos: m.hasData && m.incomeCents > 0 ? m.incomeCents : null,
    Ahorro: m.hasData && m.incomeCents > 0 ? m.savingsCents : null,
  }));
  const summary = months.filter((m) => m.hasData).map((m) => `${formatMonth(m.month)}: gasto ${formatCents(m.spendingCents)}`).join('; ');
  return (
    <div style={{ height }} role="img" aria-label={`Evolución mensual. ${summary}`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => formatMonth(m, 'short')} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={euroTick} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
          <Tooltip content={<MoneyTooltip />} cursor={{ fill: c.grid, opacity: 0.4 }} />
          <ReferenceLine y={0} stroke={c.grid} />
          <Bar dataKey="Gasto" fill={c.c2} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          {showIncome && <Line dataKey="Ingresos" stroke={c.c3} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />}
          {showIncome && <Line dataKey="Ahorro" stroke={c.c1} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MonthlyLegend({ showIncome = true }: { showIncome?: boolean }) {
  const c = chartColors();
  return (
    <div className="legend" aria-hidden>
      <span><span className="dot" style={{ background: c.c2 }} />Gasto</span>
      {showIncome && <span><span className="dot" style={{ background: c.c3 }} />Ingresos</span>}
      {showIncome && <span><span className="dot" style={{ background: c.c1 }} />Ahorro</span>}
    </div>
  );
}

/** Horizontal bars with name, amount and share. Readable without relying on colour. */
export function CategoryBars({ items, onSelect, max = 8 }: { items: CategoryBreakdown[]; onSelect?: (categoryId: number) => void; max?: number }) {
  const top = items.filter((i) => i.spentCents > 0).slice(0, max);
  const maxValue = Math.max(1, ...top.map((i) => i.spentCents));
  return (
    <div className="bar-list">
      {top.map((i) => (
        <div className="bar-row" key={i.categoryId}>
          <div className="bar-row-top">
            {onSelect ? (
              <button className="btn link" style={{ color: 'var(--ink)', fontWeight: 560 }} onClick={() => onSelect(i.categoryId)}>
                <span className="dot" style={{ background: i.color }} aria-hidden /> {i.name}
              </button>
            ) : (
              <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: i.color }} aria-hidden />{i.name}</span>
            )}
            <span>
              <span className="num">{formatCents(i.spentCents)}</span>
              <span className="muted small num"> · {formatBp(i.shareBp, 0)}</span>
            </span>
          </div>
          <div className="bar-track" aria-hidden>
            <div className="bar-fill" style={{ width: `${(i.spentCents / maxValue) * 100}%`, background: i.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TrendLines({ series, height = 260 }: { series: { categoryId: number; name: string; color: string; series: { month: string; cents: number }[] }[]; height?: number }) {
  const c = chartColors();
  const months = series[0]?.series.map((s) => s.month) ?? [];
  const data = months.map((m, idx) => {
    const row: Record<string, number | string> = { month: m };
    for (const s of series) row[s.name] = s.series[idx]?.cents ?? 0;
    return row;
  });
  return (
    <div style={{ height }} role="img" aria-label="Evolución mensual de las principales categorías">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => formatMonth(m, 'short')} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={euroTick} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
          <Tooltip content={<MoneyTooltip />} />
          {series.map((s) => (
            <Line key={s.categoryId} dataKey={s.name} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SavingsHistoryChart({ history, height = 240 }: { history: { month: string; savingsCents: number; targetCents: number | null }[]; height?: number }) {
  const c = chartColors();
  const data = history.map((h) => ({ month: h.month, Ahorro: h.savingsCents, Objetivo: h.targetCents }));
  return (
    <div style={{ height }} role="img" aria-label="Ahorro mensual frente al objetivo">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => formatMonth(m, 'short')} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={euroTick} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
          <Tooltip content={<MoneyTooltip />} />
          <ReferenceLine y={0} stroke={c.muted} />
          <Bar dataKey="Ahorro" fill={c.c1} radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
          <Line dataKey="Objetivo" stroke={c.c2} strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
