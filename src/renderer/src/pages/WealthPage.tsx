import { useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatBp, formatCents } from '../../../shared/money';
import { formatDate, formatMonth, todayIso } from '../../../shared/dates';
import {
  ASSET_TYPES, ASSET_TYPE_LABELS, LIABILITY_TYPES,
  type AssetDTO, type AssetInput, type AssetType, type EarlyRepaymentDTO, type LoanScheduleRow, type MarketQuoteDTO, type MarketReturnsDTO, type ValuationMode,
} from '../../../shared/types';
import { monthsToTarget, simulate } from '../../../shared/simulator';
import { Badge, Callout, Card, Dialog, EmptyState, ErrorBox, EuroInput, Field, Loading, Money, Segmented } from '../components/ui';
import { chartColors } from '../components/charts';
import { useNavigate } from '../App';

/** Initial value recorded together with a new asset estimated by rate. */
interface AssetDraft extends Partial<AssetInput> {
  baseValueCents?: number | null;
  baseContributedCents?: number | null;
  baseDate?: string;
}

const LOAN_TYPES: AssetType[] = ['loan', 'mortgage'];

function modesFor(type: AssetType): { value: ValuationMode; label: string }[] {
  if (LOAN_TYPES.includes(type)) return [{ value: 'loan', label: 'Cuadro de amortización' }, { value: 'manual', label: 'Saldo manual' }];
  if (LIABILITY_TYPES.includes(type)) return [{ value: 'manual', label: 'Saldo manual' }];
  return [{ value: 'manual', label: 'Valor manual' }, { value: 'rate', label: 'Estimar con rentabilidad anual' }];
}

export function WealthPage() {
  const q = useQuery(() => api('wealth.overview'), []);
  const [editing, setEditing] = useState<AssetDraft | null>(null);
  const [valuing, setValuing] = useState<AssetDTO | null>(null);
  const [loanOf, setLoanOf] = useState<AssetDTO | null>(null);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const w = q.data;

  const assets = w?.assets.filter((a) => !a.isLiability) ?? [];
  const debts = w?.assets.filter((a) => a.isLiability) ?? [];
  const addNew = () => setEditing({ type: 'cash', institution: null, notes: null, mode: 'manual' });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Patrimonio e inversión</h1>
          <p className="subtitle">Cuentas, depósitos, fondos, acciones, hipotecas y préstamos. Puedes actualizar los valores a mano, estimarlos con una rentabilidad anual o calcular la deuda con su cuadro de amortización. No es asesoramiento financiero.</p>
        </div>
        <button className="btn primary" onClick={addNew}>Añadir activo o deuda</button>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!w ? <Loading /> : (
        <>
          <section className="card hero" aria-label="Patrimonio neto">
            <div className="hero-main">
              <span className="stat-label">Patrimonio neto</span>
              <span className="hero-figure num">{formatCents(w.netWorthCents)}</span>
              <span className="muted small">Cuentas + activos − deudas a día de hoy (valores estimados incluidos).</span>
            </div>
            <div className="hero-stats">
              <div className="hero-stat"><span className="stat-label">Activos</span><span className="stat-value"><Money cents={w.totalAssetsCents} /></span></div>
              <div className="hero-stat"><span className="stat-label">Deudas</span><span className="stat-value"><Money cents={w.totalLiabilitiesCents} /></span></div>
              <div className="hero-stat">
                <span className="stat-label">Inversiones: ganancia</span>
                <span className="stat-value">{w.investedContributedCents > 0 ? <Money cents={w.investedGainCents} signed /> : '—'}</span>
                <span className="stat-sub">{w.investedReturnBp !== null ? `${formatBp(w.investedReturnBp, 1)} sobre ${formatCents(w.investedContributedCents)} aportados` : 'Indica lo aportado al valorar'}</span>
              </div>
              <div className="hero-stat"><span className="stat-label">En metas de ahorro</span><span className="stat-value"><Money cents={w.potsSavedCents} /></span><span className="stat-sub">Registrado en «Metas»</span></div>
            </div>
          </section>

          {w.accounts.length > 0 && (
            <Card title="Cuentas bancarias" hint="Saldo calculado con tus movimientos" actions={<button className="btn sm" onClick={() => navigate('accounts')}>Gestionar cuentas</button>}>
              {w.accountsWithoutBalance > 0 && (
                <Callout tone="info">{w.accountsWithoutBalance === 1 ? 'A una cuenta le falta el saldo' : `A ${w.accountsWithoutBalance} cuentas les falta el saldo`}: indícalo en «Cuentas» para que cuente en tu patrimonio.</Callout>
              )}
              <table className="table">
                <tbody>
                  {w.accounts.map((a) => (
                    <tr key={a.id}>
                      <td><div className="cell-main">{a.name}</div><div className="cell-sub">{a.bank}{a.annualRateBp ? ` · ${formatBp(a.annualRateBp, 2)} TAE` : ''}</div></td>
                      <td className="right">{a.balanceCents === null ? <span className="muted">Saldo desconocido</span> : <Money cents={a.balanceCents} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {w.assets.length === 0 ? (
            <Card>
              <EmptyState title="Aún no has registrado tu patrimonio" icon="chart" actions={<button className="btn primary" onClick={addNew}>Añadir el primero</button>}>
                Añade tus cuentas remuneradas, depósitos, fondos, acciones, planes de pensiones, inmuebles, hipotecas o préstamos.
              </EmptyState>
            </Card>
          ) : (
            <>
              <div className="grid grid-main">
                <Card title="Evolución del patrimonio neto" hint="Valor a fin de mes: última valoración, estimación por rentabilidad o saldo pendiente del préstamo">
                  {w.history.length < 2 ? <p className="muted">Añade valoraciones en fechas distintas para ver la evolución.</p> : <NetWorthChart history={w.history} />}
                </Card>
                <Card title="Reparto de tus activos">
                  <div className="bar-list">
                    {w.allocation.map((a) => (
                      <div className="bar-row" key={a.type}>
                        <div className="bar-row-top"><span>{a.label}</span><span><span className="num">{formatCents(a.cents)}</span><span className="muted small num"> · {formatBp(a.shareBp, 0)}</span></span></div>
                        <div className="bar-track" aria-hidden><div className="bar-fill" style={{ width: `${(a.shareBp ?? 0) / 100}%`, background: 'var(--chart-1)' }} /></div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
              {assets.length > 0 && <AssetsTable title="Activos" items={assets} onValue={setValuing} onEdit={setEditing} onLoan={setLoanOf} />}
              {debts.length > 0 && <AssetsTable title="Deudas" items={debts} onValue={setValuing} onEdit={setEditing} onLoan={setLoanOf} />}
            </>
          )}

          <Simulator />
          <p className="muted small">
            Ahorrar e invertir son cosas distintas: invertir implica riesgo de pérdida. Las estimaciones usan la rentabilidad que tú indicas y las rentabilidades pasadas no garantizan las futuras. Hormiga no es asesoramiento financiero.
          </p>
        </>
      )}
      {editing && <AssetDialog initial={editing} onClose={() => setEditing(null)} />}
      {valuing && <ValuationDialog asset={valuing} onClose={() => { setValuing(null); invalidate(); }} />}
      {loanOf && <LoanDialog asset={loanOf} onClose={() => setLoanOf(null)} />}
    </div>
  );
}

function AssetsTable({ title, items, onValue, onEdit, onLoan }: { title: string; items: AssetDTO[]; onValue: (a: AssetDTO) => void; onEdit: (a: AssetDraft) => void; onLoan: (a: AssetDTO) => void }) {
  const invalidate = useInvalidate();
  const edit = (a: AssetDTO) => onEdit({
    id: a.id, name: a.name, type: a.type, institution: a.institution, notes: a.notes, mode: a.mode,
    annualRateBp: a.annualRateBp, monthlyContributionCents: a.monthlyContributionCents, symbol: a.symbol, rateSource: a.rateSource,
    principalCents: a.loan?.principalCents ?? null, termMonths: a.loan?.termMonths ?? null, startDate: a.loan?.startDate ?? null,
  });
  return (
    <Card title={title}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Nombre</th><th>Tipo</th><th className="right">{title === 'Deudas' ? 'Pendiente' : 'Valor'}</th><th className="right">{title === 'Deudas' ? 'Cuota' : 'Aportado'}</th><th className="right">{title === 'Deudas' ? 'Intereses pendientes' : 'Ganancia'}</th><th>Actualizado</th><th /></tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td><div className="cell-main">{a.name}</div>{a.institution && <div className="cell-sub">{a.institution}</div>}</td>
                <td>
                  {ASSET_TYPE_LABELS[a.type]}
                  {a.mode === 'rate' && <div className="cell-sub">{formatBp(a.annualRateBp, 2)} anual{a.monthlyContributionCents ? ` + ${formatCents(a.monthlyContributionCents)}/mes` : ''}</div>}
                  {a.loan && <div className="cell-sub">TIN {formatBp(a.loan.annualRateBp, 2)} · {Math.round(a.loan.termMonths / 12 * 10) / 10} años</div>}
                </td>
                <td className="right">
                  <Money cents={a.valueCents} />
                  {a.estimated && a.valueCents !== null && <div><Badge tone="info" title={a.loan ? 'Calculado con el cuadro de amortización' : `Estimado desde la valoración del ${a.baseDate ? formatDate(a.baseDate) : '—'}`}>Estimado</Badge></div>}
                </td>
                {a.loan ? (
                  <>
                    <td className="right"><Money cents={a.loan.paymentCents} /><div className="cell-sub">{a.loan.remainingPayments} cuotas restantes</div></td>
                    <td className="right"><Money cents={a.loan.remainingInterestCents} /></td>
                  </>
                ) : (
                  <>
                    <td className="right"><Money cents={a.contributedCents} /></td>
                    <td className="right">{a.gainCents === null ? <span className="muted">—</span> : <><Money cents={a.gainCents} signed /><div className="cell-sub">{formatBp(a.returnBp, 1)}</div></>}</td>
                  </>
                )}
                <td>
                  {a.loan ? <span className="muted small">Automático</span> : a.lastDate ? formatDate(a.lastDate) : <span className="muted">Sin valorar</span>}
                  {a.stale && <> <Badge tone="warning" title="Más de 90 días sin actualizar">Desactualizado</Badge></>}
                </td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {a.loan
                    ? <button className="btn sm primary" onClick={() => onLoan(a)}>Ver préstamo</button>
                    : <button className="btn sm primary" onClick={() => onValue(a)}>{a.mode === 'rate' ? 'Ajustar valor' : 'Actualizar valor'}</button>}{' '}
                  <button className="btn sm ghost" onClick={() => edit(a)}>Editar</button>
                  <button className="btn sm ghost" onClick={async () => { if (confirm(`¿Eliminar «${a.name}» y su historial de valoraciones?`)) { await api('wealth.deleteAsset', { id: a.id }); invalidate(); } }}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NetWorthChart({ history }: { history: { month: string; netWorthCents: number; assetsCents: number; liabilitiesCents: number }[] }) {
  const c = chartColors();
  const data = history.map((h) => ({ month: h.month, 'Patrimonio neto': h.netWorthCents, Activos: h.assetsCents, Deudas: h.liabilitiesCents }));
  return (
    <div style={{ height: 260 }} role="img" aria-label={`Patrimonio neto: de ${formatCents(history[0]!.netWorthCents)} a ${formatCents(history[history.length - 1]!.netWorthCents)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => formatMonth(m, 'short')} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(v: number) => formatCents(v, { compact: true })} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={80} />
          <Tooltip formatter={(v) => formatCents(Number(v))} labelFormatter={(m) => formatMonth(String(m))} />
          <Area dataKey="Activos" stroke={c.c3} fill={c.c3} fillOpacity={0.08} isAnimationActive={false} />
          <Line dataKey="Deudas" stroke={c.c2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
          <Line dataKey="Patrimonio neto" stroke={c.c1} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function PctInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return <div className="euro-input pct"><input id={id} className="input num" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}

const bpToText = (bp: number | null | undefined) => (bp === null || bp === undefined ? '' : String(bp / 100).replace('.', ','));

function parsePct(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function AssetDialog({ initial, onClose }: { initial: AssetDraft; onClose: () => void }) {
  const [a, setA] = useState<AssetDraft>({ baseDate: todayIso(), ...initial });
  const [rate, setRate] = useState(bpToText(initial.annualRateBp));
  const [termYears, setTermYears] = useState(initial.termMonths ? String(Math.round((initial.termMonths / 12) * 100) / 100).replace('.', ',') : '');
  const [market, setMarket] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const type = a.type ?? 'cash';
  const modes = modesFor(type);
  const mode: ValuationMode = modes.some((m) => m.value === a.mode) ? a.mode! : modes[0]!.value;

  const setType = (t: AssetType) => {
    const ms = modesFor(t);
    setA({ ...a, type: t, mode: ms.some((m) => m.value === a.mode) ? a.mode : ms[0]!.value });
  };

  const save = async () => {
    setError(null);
    if (!a.name?.trim()) return setError('Ponle un nombre.');
    const rateBp = parsePct(rate);
    const input: AssetInput = { id: a.id, name: a.name.trim(), type, institution: a.institution?.trim() || null, notes: a.notes?.trim() || null, mode, symbol: a.symbol ?? null, rateSource: a.rateSource ?? null };
    if (mode === 'rate') {
      if (rateBp === null) return setError('Indica la rentabilidad anual (puede ser 0 o negativa).');
      if (!a.id && (a.baseValueCents === null || a.baseValueCents === undefined)) return setError('Indica el valor actual del que partir.');
      Object.assign(input, { annualRateBp: rateBp, monthlyContributionCents: a.monthlyContributionCents ?? null });
    }
    if (mode === 'loan') {
      const years = Number(termYears.replace(',', '.'));
      if (!a.principalCents) return setError('Indica el capital prestado.');
      if (rateBp === null || rateBp < 0) return setError('Indica el tipo de interés nominal (TIN).');
      if (!Number.isFinite(years) || years <= 0 || years > 50) return setError('Indica el plazo en años (hasta 50).');
      if (!a.startDate) return setError('Indica la fecha de firma o de inicio.');
      Object.assign(input, { annualRateBp: rateBp, principalCents: a.principalCents, termMonths: Math.round(years * 12), startDate: a.startDate, symbol: null, rateSource: null });
    }
    try {
      const saved = await api('wealth.saveAsset', input);
      if (mode === 'rate' && !a.id && a.baseValueCents !== null && a.baseValueCents !== undefined) {
        await api('wealth.saveValuation', { assetId: saved.id, date: a.baseDate ?? todayIso(), valueCents: a.baseValueCents, contributedCents: type === 'cash' ? null : (a.baseContributedCents ?? a.baseValueCents), note: null });
      }
      invalidate();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  return (
    <Dialog open wide title={a.id ? 'Editar' : 'Añadir activo o deuda'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="form-row">
        <Field label="Nombre" htmlFor="as-name"><input id="as-name" className="input" maxLength={80} value={a.name ?? ''} onChange={(e) => setA({ ...a, name: e.target.value })} placeholder="Cuenta remunerada, fondo indexado, hipoteca…" /></Field>
        <Field label="Tipo" htmlFor="as-type">
          <select id="as-type" className="select" value={type} onChange={(e) => setType(e.target.value as AssetType)}>
            <optgroup label="Activos">{ASSET_TYPES.filter((t) => !LIABILITY_TYPES.includes(t)).map((t) => <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>)}</optgroup>
            <optgroup label="Deudas">{LIABILITY_TYPES.map((t) => <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>)}</optgroup>
          </select>
        </Field>
        <Field label="Entidad (opcional)" htmlFor="as-inst"><input id="as-inst" className="input" maxLength={80} value={a.institution ?? ''} onChange={(e) => setA({ ...a, institution: e.target.value })} /></Field>
      </div>

      {modes.length > 1 && (
        <div style={{ margin: '12px 0' }}>
          <Segmented label="Cómo calcular el valor" value={mode} options={modes} onChange={(m) => setA({ ...a, mode: m })} />
        </div>
      )}

      {mode === 'manual' && <p className="muted small">Registrarás su valor cuando quieras con «Actualizar valor»; se mantiene hasta la siguiente valoración.</p>}

      {mode === 'rate' && (
        <>
          <div className="form-row">
            <Field label="Rentabilidad anual (TAE)" htmlFor="as-rate" help="Para una cuenta remunerada, su TAE. Para fondos o acciones, tu supuesto; puede ser 0 o negativa.">
              <PctInput id="as-rate" value={rate} onChange={setRate} />
            </Field>
            <Field label="Aportación mensual (opcional)" htmlFor="as-monthly" help="Se suma cada mes en la fecha de la valoración.">
              <EuroInput id="as-monthly" valueCents={a.monthlyContributionCents ?? null} onChange={(v) => setA({ ...a, monthlyContributionCents: v })} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn sm" type="button" onClick={() => setMarket(true)}>Buscar rentabilidad histórica en internet…</button>
            {a.rateSource && <span className="muted small">Origen: {a.rateSource}</span>}
          </div>
          {!a.id && (
            <div className="form-row" style={{ marginTop: 12 }}>
              <Field label="Valor en la fecha" htmlFor="as-base"><EuroInput id="as-base" valueCents={a.baseValueCents ?? null} onChange={(v) => setA({ ...a, baseValueCents: v })} /></Field>
              <Field label="Fecha" htmlFor="as-base-date"><input id="as-base-date" type="date" className="input" max={todayIso()} value={a.baseDate ?? todayIso()} onChange={(e) => setA({ ...a, baseDate: e.target.value })} /></Field>
              {type !== 'cash' && (
                <Field label="Aportado hasta esa fecha" htmlFor="as-base-contrib" help="Si lo dejas vacío, se toma el mismo valor.">
                  <EuroInput id="as-base-contrib" valueCents={a.baseContributedCents ?? null} onChange={(v) => setA({ ...a, baseContributedCents: v })} />
                </Field>
              )}
            </div>
          )}
          <p className="muted small">El valor de hoy se estima desde la última valoración: crece a esa rentabilidad (interés compuesto diario) y suma las aportaciones mensuales. Cuando registres un valor real, la estimación parte de él.</p>
        </>
      )}

      {mode === 'loan' && (
        <>
          <div className="form-row">
            <Field label="Capital prestado" htmlFor="ln-principal"><EuroInput id="ln-principal" valueCents={a.principalCents ?? null} onChange={(v) => setA({ ...a, principalCents: v })} /></Field>
            <Field label="Tipo de interés (TIN)" htmlFor="ln-rate" help="Nominal anual, no la TAE. En hipotecas variables, el tipo vigente (Euríbor + diferencial)."><PctInput id="ln-rate" value={rate} onChange={setRate} /></Field>
            <Field label="Plazo (años)" htmlFor="ln-term"><input id="ln-term" className="input num" inputMode="decimal" value={termYears} onChange={(e) => setTermYears(e.target.value)} /></Field>
            <Field label="Fecha de firma" htmlFor="ln-start" help="La primera cuota se paga un mes después."><input id="ln-start" type="date" className="input" value={a.startDate ?? ''} onChange={(e) => setA({ ...a, startDate: e.target.value })} /></Field>
          </div>
          <p className="muted small">Sistema francés (cuota constante). Hormiga calcula cada mes el capital pendiente, los intereses pagados y los que quedan. Si tu tipo cambia, edita el préstamo.</p>
        </>
      )}

      <Field label="Notas (opcional)" htmlFor="as-notes"><textarea id="as-notes" className="textarea" maxLength={500} value={a.notes ?? ''} onChange={(e) => setA({ ...a, notes: e.target.value })} /></Field>
      {error && <Callout tone="danger">{error}</Callout>}
      {market && (
        <MarketDialog
          onClose={() => setMarket(false)}
          onUse={(bp, r, label) => { setRate(bpToText(bp)); setA({ ...a, symbol: r.symbol, rateSource: `${label} de ${r.name} (${r.symbol}), ${r.source}, consultado el ${formatDate(r.fetchedOn)}` }); setMarket(false); }}
        />
      )}
    </Dialog>
  );
}

function ValuationDialog({ asset, onClose }: { asset: AssetDTO; onClose: () => void }) {
  const history = useQuery(() => api('wealth.valuations', { assetId: asset.id }), [asset.id]);
  const [date, setDate] = useState(todayIso());
  const [value, setValue] = useState<number | null>(asset.valueCents);
  const [contributed, setContributed] = useState<number | null>(asset.contributedCents);
  const [error, setError] = useState<string | null>(null);
  const tracksContributions = !asset.isLiability && asset.type !== 'cash';
  const save = async () => {
    setError(null);
    if (value === null || value < 0) return setError('Indica el valor (0 o más).');
    try {
      await api('wealth.saveValuation', { assetId: asset.id, date, valueCents: value, contributedCents: tracksContributions ? contributed : null, note: null });
      history.reload();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open wide title={`Valor de «${asset.name}»`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cerrar</button><button className="btn primary" onClick={save}>Guardar valoración</button></>}>
      {asset.mode === 'rate' && <Callout tone="info">Este activo se estima al {formatBp(asset.annualRateBp, 2)} anual. Guardar un valor real corrige la estimación a partir de esa fecha.</Callout>}
      <div className="form-row">
        <Field label="Fecha" htmlFor="v-date"><input id="v-date" type="date" className="input" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={asset.isLiability ? 'Deuda pendiente' : 'Valor actual'} htmlFor="v-value"><EuroInput id="v-value" valueCents={value} onChange={setValue} /></Field>
        {tracksContributions && (
          <Field label="Total aportado hasta la fecha" htmlFor="v-contrib" help="Suma de todo lo que has metido (sin ganancias). Permite calcular la rentabilidad.">
            <EuroInput id="v-contrib" valueCents={contributed} onChange={setContributed} />
          </Field>
        )}
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      <h3>Historial</h3>
      {!history.data ? <Loading /> : history.data.length === 0 ? <p className="muted">Sin valoraciones todavía.</p> : (
        <table className="table">
          <thead><tr><th>Fecha</th><th className="right">Valor</th>{tracksContributions && <th className="right">Aportado</th>}<th /></tr></thead>
          <tbody>
            {history.data.map((v) => (
              <tr key={v.id}>
                <td className="num">{formatDate(v.date)}</td>
                <td className="right"><Money cents={v.valueCents} /></td>
                {tracksContributions && <td className="right"><Money cents={v.contributedCents} /></td>}
                <td className="right"><button className="btn sm ghost" onClick={async () => { await api('wealth.deleteValuation', { id: v.id }); history.reload(); }}>Eliminar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

function yearlySummary(rows: LoanScheduleRow[]) {
  const out = new Map<string, { year: string; paymentCents: number; interestCents: number; principalCents: number; balanceCents: number }>();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    const cur = out.get(y) ?? { year: y, paymentCents: 0, interestCents: 0, principalCents: 0, balanceCents: 0 };
    cur.paymentCents += r.paymentCents;
    cur.interestCents += r.interestCents;
    cur.principalCents += r.principalCents;
    cur.balanceCents = r.balanceCents;
    out.set(y, cur);
  }
  return [...out.values()];
}

function LoanDialog({ asset, onClose }: { asset: AssetDTO; onClose: () => void }) {
  const loan = asset.loan!;
  const sched = useQuery(() => api('wealth.loanSchedule', { assetId: asset.id }), [asset.id]);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [strategy, setStrategy] = useState<'reduce_term' | 'reduce_payment'>('reduce_term');
  const [sim, setSim] = useState<EarlyRepaymentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monthly, setMonthly] = useState(false);
  const thisYear = todayIso().slice(0, 4);

  const simulateRepayment = async () => {
    setError(null);
    setSim(null);
    if (!amount || amount <= 0) return setError('Indica cuánto amortizarías.');
    try {
      setSim(await api('wealth.earlyRepayment', { assetId: asset.id, date, amountCents: amount, strategy }));
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  const paidShare = loan.principalCents > 0 ? Math.round((loan.paidPrincipalCents * 10000) / loan.principalCents) : 0;
  return (
    <Dialog open wide title={`${ASSET_TYPE_LABELS[asset.type]}: «${asset.name}»`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      <div className="grid grid-4">
        <div className="stat-card"><span className="stat-label">Cuota mensual</span><span className="stat-value"><Money cents={loan.paymentCents} /></span><span className="stat-sub">TIN {formatBp(loan.annualRateBp, 2)}</span></div>
        <div className="stat-card"><span className="stat-label">Capital pendiente</span><span className="stat-value"><Money cents={loan.outstandingCents} /></span><span className="stat-sub">Amortizado el {formatBp(paidShare, 1)} de {formatCents(loan.principalCents)}</span></div>
        <div className="stat-card"><span className="stat-label">Intereses pagados</span><span className="stat-value"><Money cents={loan.paidInterestCents} /></span><span className="stat-sub">Pendientes: {formatCents(loan.remainingInterestCents)}</span></div>
        <div className="stat-card"><span className="stat-label">Cuotas</span><span className="stat-value num">{loan.paymentsMade} / {loan.termMonths}</span><span className="stat-sub">{loan.nextPaymentDate ? `Próxima: ${formatDate(loan.nextPaymentDate)} · fin ${formatDate(loan.endDate)}` : 'Préstamo terminado'}</span></div>
      </div>
      <p className="muted small">Coste total en intereses: {formatCents(loan.totalInterestCents)}. Cálculo con sistema francés; tu banco puede redondear distinto por céntimos o aplicar comisiones y seguros que aquí no se incluyen.</p>

      {loan.outstandingCents > 0 && (
        <>
          <h3>Simular amortización anticipada</h3>
          <div className="form-row">
            <Field label="Importe a amortizar" htmlFor="er-amount"><EuroInput id="er-amount" valueCents={amount} onChange={setAmount} /></Field>
            <Field label="Fecha" htmlFor="er-date"><input id="er-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Qué reducir" htmlFor="er-strategy">
              <select id="er-strategy" className="select" value={strategy} onChange={(e) => setStrategy(e.target.value as 'reduce_term' | 'reduce_payment')}>
                <option value="reduce_term">Reducir plazo (misma cuota)</option>
                <option value="reduce_payment">Reducir cuota (mismo plazo)</option>
              </select>
            </Field>
            <div style={{ alignSelf: 'end' }}><button className="btn primary" onClick={simulateRepayment}>Simular</button></div>
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
          {sim && (
            <Callout tone="success">
              Ahorrarías <strong>{formatCents(sim.interestSavedCents)}</strong> en intereses.{' '}
              {strategy === 'reduce_term'
                ? <>Terminarías en {formatDate(sim.newEndDate)} en lugar de {formatDate(sim.currentEndDate)} ({sim.currentRemainingPayments - sim.newRemainingPayments} cuotas menos).</>
                : <>La cuota bajaría de {formatCents(sim.currentPaymentCents)} a {formatCents(sim.newPaymentCents)}.</>}
              {' '}Capital pendiente tras amortizar: {formatCents(sim.outstandingAfterCents)}. Consulta la comisión por amortización anticipada de tu contrato.
            </Callout>
          )}
        </>
      )}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <h3>Cuadro de amortización</h3>
        <Segmented label="Detalle" value={monthly ? 'm' : 'y'} options={[{ value: 'y', label: 'Por año' }, { value: 'm', label: 'Por cuota' }]} onChange={(v) => setMonthly(v === 'm')} />
      </div>
      {!sched.data ? <Loading /> : (
        <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>{monthly ? 'Cuota' : 'Año'}</th><th className="right">Pagado</th><th className="right">Intereses</th><th className="right">Capital</th><th className="right">Pendiente</th></tr></thead>
            <tbody>
              {monthly
                ? sched.data.map((r) => (
                  <tr key={r.n} style={r.date <= todayIso() ? { opacity: 0.6 } : undefined}>
                    <td className="num">{r.n} · {formatDate(r.date)}</td>
                    <td className="right"><Money cents={r.paymentCents} /></td>
                    <td className="right"><Money cents={r.interestCents} /></td>
                    <td className="right"><Money cents={r.principalCents} /></td>
                    <td className="right"><Money cents={r.balanceCents} /></td>
                  </tr>
                ))
                : yearlySummary(sched.data).map((y) => (
                  <tr key={y.year} style={y.year < thisYear ? { opacity: 0.6 } : undefined}>
                    <td className="num">{y.year}{y.year === thisYear && <> <Badge tone="accent">Este año</Badge></>}</td>
                    <td className="right"><Money cents={y.paymentCents} /></td>
                    <td className="right"><Money cents={y.interestCents} /></td>
                    <td className="right"><Money cents={y.principalCents} /></td>
                    <td className="right"><Money cents={y.balanceCents} /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function MarketDialog({ onClose, onUse }: { onClose: () => void; onUse: (bp: number, r: MarketReturnsDTO, label: string) => void }) {
  const invalidate = useInvalidate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketQuoteDTO[] | null>(null);
  const [returns, setReturns] = useState<MarketReturnsDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const c = chartColors();

  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      const e = toApiError(err);
      setError({ code: e.code, message: e.message });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const search = async () => {
    if (query.trim().length < 2) return;
    setReturns(null);
    const r = await run(() => api('market.search', { query: query.trim() }));
    if (r) setResults(r);
  };
  const pick = async (symbol: string) => {
    const r = await run(() => api('market.returns', { symbol }));
    if (r) setReturns(r);
  };
  const enable = async () => {
    await api('settings.update', { marketDataEnabled: true });
    invalidate();
    setError(null);
    await search();
  };

  const horizons: { key: keyof MarketReturnsDTO['cagr']; label: string }[] = [
    { key: 'y1', label: 'Último año' }, { key: 'y3', label: 'Media anual 3 años' }, { key: 'y5', label: 'Media anual 5 años' },
    { key: 'y10', label: 'Media anual 10 años' }, { key: 'all', label: 'Media anual desde el inicio' },
  ];

  return (
    <Dialog open wide title="Rentabilidades pasadas" onClose={onClose} footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      <p className="muted small">Busca un fondo, ETF, acción o índice por nombre, ticker o ISIN. Solo se envía a Yahoo Finance el texto que busques; nunca tus datos. Datos públicos no oficiales; los fondos españoles pueden no aparecer.</p>
      <div className="row">
        <input className="input" style={{ flex: 1 }} aria-label="Buscar valor" placeholder="MSCI World, IWDA, IE00B4L5Y983, Apple…" maxLength={60} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <button className="btn primary" disabled={busy || query.trim().length < 2} onClick={search}>Buscar</button>
      </div>
      {error && (error.code === 'MARKET_DISABLED'
        ? <Callout tone="info">La consulta a internet está desactivada. ¿La activas? Solo se enviará el texto que busques. <button className="btn sm primary" onClick={enable}>Activar y buscar</button></Callout>
        : <Callout tone="danger">{error.message}</Callout>)}
      {busy && <Loading label="Consultando…" />}
      {results && !returns && (results.length === 0 ? <p className="muted">Sin resultados. Prueba con el ticker o el nombre del índice que replica.</p> : (
        <table className="table">
          <thead><tr><th>Nombre</th><th>Ticker</th><th>Tipo</th><th>Mercado</th><th /></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.symbol}>
                <td>{r.name}</td><td className="mono">{r.symbol}</td><td>{r.type}</td><td>{r.exchange}</td>
                <td className="right"><button className="btn sm" disabled={busy} onClick={() => pick(r.symbol)}>Ver rentabilidad</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {returns && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>{returns.name} <span className="muted mono small">{returns.symbol}{returns.currency ? ` · ${returns.currency}` : ''}</span></h3>
            <button className="btn sm ghost" onClick={() => setReturns(null)}>← Resultados</button>
          </div>
          <p className="muted small">Datos mensuales del {formatDate(returns.firstDate)} al {formatDate(returns.lastDate)} ({returns.years.toLocaleString('es-ES', { maximumFractionDigits: 1 })} años), con dividendos reinvertidos cuando la fuente los ajusta. Fuente: {returns.source}.</p>
          <table className="table">
            <tbody>
              {horizons.map((h) => (
                <tr key={h.key}>
                  <td>{h.label}</td>
                  <td className="right num">{formatBp(returns.cagr[h.key], 2)}</td>
                  <td className="right">{returns.cagr[h.key] !== null && <button className="btn sm" onClick={() => onUse(returns.cagr[h.key]!, returns, h.label)}>Usar esta rentabilidad</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-4" style={{ marginTop: 12 }}>
            <div className="stat-card"><span className="stat-label">En lo que va de año</span><span className="stat-value num">{formatBp(returns.ytdBp, 1)}</span></div>
            <div className="stat-card"><span className="stat-label">Volatilidad anual</span><span className="stat-value num">{formatBp(returns.volatilityBp, 1)}</span><span className="stat-sub">Últimos 5 años</span></div>
            <div className="stat-card"><span className="stat-label">Peor caída</span><span className="stat-value num">{formatBp(returns.maxDrawdownBp, 1)}</span><span className="stat-sub">Máximo a mínimo</span></div>
            <div className="stat-card"><span className="stat-label">Mejor / peor año</span><span className="stat-value num">{formatBp(returns.bestYearBp, 0)} / {formatBp(returns.worstYearBp, 0)}</span></div>
          </div>
          {returns.indexSeries.length > 2 && (
            <div style={{ height: 180, marginTop: 12 }} role="img" aria-label="Evolución de 100 invertidos al inicio">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={returns.indexSeries} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(0, 4)} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip formatter={(v) => Number(v).toLocaleString('es-ES')} labelFormatter={(d) => formatDate(String(d))} />
                  <Line dataKey="value" name="100 invertidos" stroke={c.c1} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          <Callout tone="warning">Rentabilidades pasadas no garantizan rentabilidades futuras. No incluye comisiones de tu producto ni impuestos, y puede diferir de la clase o divisa que tengas.</Callout>
        </>
      )}
    </Dialog>
  );
}

function pctToBp(text: string): number {
  return parsePct(text) ?? 0;
}

function Simulator() {
  const [initial, setInitial] = useState<number | null>(100000);
  const [monthly, setMonthly] = useState<number | null>(20000);
  const [rate, setRate] = useState('4');
  const [rateSource, setRateSource] = useState<string | null>(null);
  const [market, setMarket] = useState(false);
  const [inflation, setInflation] = useState('2');
  const [years, setYears] = useState(15);
  const [target, setTarget] = useState<number | null>(5000000);
  const c = chartColors();
  const input = { initialCents: initial ?? 0, monthlyCents: monthly ?? 0, annualRateBp: pctToBp(rate), years, inflationBp: pctToBp(inflation) };
  const result = useMemo(() => simulate(input), [input.initialCents, input.monthlyCents, input.annualRateBp, input.years, input.inflationBp]); // eslint-disable-line react-hooks/exhaustive-deps
  const toTarget = target ? monthsToTarget(target, input.initialCents, input.monthlyCents, input.annualRateBp) : null;
  const f = result.final;
  const data = result.points.map((p) => ({ year: p.year, Aportado: p.contributedCents, 'Valor estimado': p.valueCents, 'En euros de hoy': p.realValueCents }));
  return (
    <Card title="Simulador de ahorro e interés compuesto" hint="Educativo: los porcentajes son supuestos tuyos, no previsiones ni recomendaciones">
      <div className="form-row">
        <Field label="Capital inicial" htmlFor="s-init"><EuroInput id="s-init" valueCents={initial} onChange={setInitial} /></Field>
        <Field label="Aportación mensual" htmlFor="s-month"><EuroInput id="s-month" valueCents={monthly} onChange={setMonthly} /></Field>
        <Field label="Rentabilidad anual supuesta" htmlFor="s-rate" help={<>Puede ser 0 o negativa · <button type="button" className="btn link" onClick={() => setMarket(true)}>usar una histórica</button></>}>
          <PctInput id="s-rate" value={rate} onChange={(v) => { setRate(v); setRateSource(null); }} />
        </Field>
        <Field label="Inflación anual supuesta" htmlFor="s-inf"><PctInput id="s-inf" value={inflation} onChange={setInflation} /></Field>
        <Field label={`Plazo: ${years} años`} htmlFor="s-years"><input id="s-years" type="range" min={1} max={40} value={years} onChange={(e) => setYears(Number(e.target.value))} /></Field>
      </div>
      {rateSource && <p className="muted small">Rentabilidad: {rateSource}. El pasado no garantiza el futuro.</p>}
      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <div className="stat-card"><span className="stat-label">Total aportado</span><span className="stat-value"><Money cents={f.contributedCents} /></span></div>
        <div className="stat-card"><span className="stat-label">Valor estimado</span><span className="stat-value"><Money cents={f.valueCents} /></span></div>
        <div className="stat-card"><span className="stat-label">Crecimiento</span><span className="stat-value"><Money cents={f.growthCents} signed /></span></div>
        <div className="stat-card"><span className="stat-label">En euros de hoy</span><span className="stat-value"><Money cents={f.realValueCents} /></span><span className="stat-sub">Descontando la inflación supuesta</span></div>
      </div>
      <div style={{ height: 260, marginTop: 12 }} role="img" aria-label={`Simulación a ${years} años: ${formatCents(f.valueCents)} estimados, ${formatCents(f.contributedCents)} aportados`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="year" tickFormatter={(y: number) => `${y} a`} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v: number) => formatCents(v, { compact: true })} tick={{ fill: c.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={80} />
            <Tooltip formatter={(v) => formatCents(Number(v))} labelFormatter={(y) => `Año ${y}`} />
            <Area dataKey="Aportado" stroke={c.c3} fill={c.c3} fillOpacity={0.12} isAnimationActive={false} />
            <Line dataKey="Valor estimado" stroke={c.c1} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <Line dataKey="En euros de hoy" stroke={c.c2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="¿Cuándo llego a…?" htmlFor="s-target"><EuroInput id="s-target" valueCents={target} onChange={setTarget} /></Field>
        <p style={{ alignSelf: 'end', paddingBottom: 6 }}>
          {!target ? null : toTarget === null ? 'Con estos supuestos no se alcanza en 60 años.' : toTarget === 0 ? 'Ya lo tienes.' : <>En unos <strong>{Math.floor(toTarget / 12)} años y {toTarget % 12} meses</strong> con estos supuestos.</>}
        </p>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>Cómo se calcula</summary>
        <p className="small" style={{ marginTop: 6 }}>
          Cada mes: valor = valor × (1 + r) + aportación, con r = (1 + rentabilidad anual)^(1/12) − 1. «En euros de hoy» divide el valor por (1 + inflación)^años. No incluye comisiones ni impuestos, y las rentabilidades reales varían y pueden ser negativas.
        </p>
      </details>
      {market && <MarketDialog onClose={() => setMarket(false)} onUse={(bp, r, label) => { setRate(bpToText(bp)); setRateSource(`${label.toLowerCase()} de ${r.name} (${r.symbol})`); setMarket(false); }} />}
    </Card>
  );
}
