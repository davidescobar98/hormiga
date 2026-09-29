import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatBp, formatCents } from '../../../shared/money';
import { formatDate, todayIso } from '../../../shared/dates';
import type { PotDTO, PotInput, PotStatus, PotsOverview } from '../../../shared/types';
import { Badge, Callout, Card, Dialog, EmptyState, ErrorBox, EuroInput, Field, Loading, Money, ProgressBar, useToast } from '../components/ui';

const COLORS = ['#2f8f6b', '#1f9aa8', '#3b82b8', '#7b61c4', '#d9822b', '#c2647a', '#8aa33a'];

const STATUS: Record<PotStatus, { label: string; tone: 'positive' | 'warning' | 'info' | 'outline' | 'neutral' }> = {
  done: { label: 'Completada', tone: 'positive' },
  ahead: { label: 'Por delante del plan', tone: 'positive' },
  on_track: { label: 'Según el plan', tone: 'info' },
  behind: { label: 'Por detrás del plan', tone: 'warning' },
  overdue: { label: 'Fecha superada', tone: 'warning' },
  no_date: { label: 'Sin fecha', tone: 'outline' },
};

export function GoalsPage() {
  const q = useQuery(() => api('pots.overview'), []);
  const [editing, setEditing] = useState<Partial<PotInput> | null>(null);
  const [moving, setMoving] = useState<{ pot: PotDTO; sign: 1 | -1 } | null>(null);
  const [history, setHistory] = useState<PotDTO | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const o = q.data;

  const remove = async (p: PotDTO) => {
    if (!confirm(`¿Eliminar «${p.name}» y sus ${p.movementsCount} movimientos? No afecta a tus cuentas reales.`)) return;
    await api('pots.delete', { id: p.id });
    invalidate();
    toast({ tone: 'info', message: 'Meta eliminada.' });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Metas de ahorro</h1>
          <p className="subtitle">Aparta dinero para objetivos concretos y para imprevistos. Registra aquí lo que reservas; Hormiga no mueve dinero.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ kind: 'goal', color: COLORS[(o?.pots.length ?? 0) % COLORS.length], targetDate: null })}>Nueva meta</button>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!o ? <Loading /> : (
        <>
          <div className="grid grid-3">
            <Card><div className="stat-card"><span className="stat-label">Ahorrado en metas</span><span className="stat-value"><Money cents={o.totalSavedCents} /></span><span className="stat-sub">{o.pots.length} meta(s)</span></div></Card>
            <Card><div className="stat-card"><span className="stat-label">Necesario al mes</span><span className="stat-value"><Money cents={o.requiredMonthlyTotalCents} /></span><span className="stat-sub">Para llegar a tiempo a todas las metas con fecha</span></div></Card>
            <Card>
              <div className="stat-card">
                <span className="stat-label">Capacidad de ahorro estimada</span>
                <span className="stat-value">{o.capacityCents === null ? '—' : <Money cents={o.capacityCents} />}</span>
                <span className="stat-sub">{o.capacityCents === null ? 'Importa movimientos para estimarla' : o.capacityProvisional ? 'Estimación provisional (poco histórico)' : 'Según tu histórico (ver «Ahorro»)'}</span>
              </div>
            </Card>
          </div>

          {o.insights.length > 0 && (
            <div className="stack">
              {o.insights.map((i) => <Callout key={i.text} tone={i.tone === 'positive' ? 'success' : i.tone === 'warning' ? 'warning' : 'info'}>{i.text}</Callout>)}
            </div>
          )}

          <EmergencyCard o={o} onCreate={(target) => setEditing({ kind: 'emergency', name: 'Fondo de emergencia', targetCents: target, targetDate: null, color: COLORS[0] })} onEdit={(p) => setEditing(p)} />

          <Card title="Tus metas">
            {o.pots.filter((p) => p.kind === 'goal').length === 0 ? (
              <EmptyState title="Aún no tienes metas" icon="piggy" actions={<button className="btn primary" onClick={() => setEditing({ kind: 'goal', color: COLORS[1], targetDate: null })}>Crear la primera</button>}>
                Un viaje, la entrada de una casa, un coche… Define cuánto y para cuándo, y Hormiga te dice cuánto apartar cada mes.
              </EmptyState>
            ) : (
              <div className="grid grid-2">
                {o.pots.filter((p) => p.kind === 'goal').map((p) => (
                  <PotCard key={p.id} pot={p} onAdd={() => setMoving({ pot: p, sign: 1 })} onWithdraw={() => setMoving({ pot: p, sign: -1 })} onEdit={() => setEditing(p)} onDelete={() => remove(p)} onHistory={() => setHistory(p)} />
                ))}
              </div>
            )}
          </Card>
          <p className="muted small">Las metas son un registro de lo que decides reservar. Hormiga no ofrece productos financieros ni consejos de inversión.</p>
        </>
      )}
      {editing && <PotDialog initial={editing} onClose={() => setEditing(null)} />}
      {moving && <MovementDialog pot={moving.pot} sign={moving.sign} onClose={() => setMoving(null)} />}
      {history && <HistoryDialog pot={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function EmergencyCard({ o, onCreate, onEdit }: { o: PotsOverview; onCreate: (target: number) => void; onEdit: (p: PotDTO) => void }) {
  const e = o.emergency;
  const pot = o.pots.find((p) => p.kind === 'emergency');
  const [moving, setMoving] = useState<1 | -1 | null>(null);
  const months = e.coverageTenths === null ? null : e.coverageTenths / 10;
  return (
    <Card title="Fondo de emergencia" hint="Dinero reservado para imprevistos (avería, paro, salud…)">
      <div className="grid grid-main">
        <div className="stack">
          <div className="row" style={{ alignItems: 'baseline', gap: 16 }}>
            <span className="hero-figure num" style={{ fontSize: 34 }}>{months === null ? '—' : `${months.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses`}</span>
            <span className="muted">de gasto esencial cubiertos</span>
          </div>
          <div aria-hidden style={{ position: 'relative' }}>
            <ProgressBar valueBp={months === null ? 0 : Math.min(10000, Math.round((months / 6) * 10000))} label="Cobertura del fondo de emergencia sobre 6 meses" />
            <div className="row small muted" style={{ justifyContent: 'space-between', marginTop: 4 }}><span>0</span><span>3 meses</span><span>6 meses</span></div>
          </div>
          <p className="small muted">{e.explanation}</p>
          <div className="row">
            {pot ? (
              <>
                <button className="btn primary" onClick={() => setMoving(1)}>Aportar</button>
                <button className="btn" onClick={() => setMoving(-1)}>Retirar</button>
                <button className="btn ghost" onClick={() => onEdit(pot)}>Editar objetivo</button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={e.essentialMonthlyCents === 0} onClick={() => onCreate(e.suggestedTargetCents.months6 || 300000)}>Crear fondo de emergencia</button>
                {e.essentialMonthlyCents === 0 && <span className="small muted">Importa movimientos para calcular tu gasto esencial.</span>}
              </>
            )}
          </div>
        </div>
        <dl className="kv">
          <dt>Gasto esencial mensual</dt><dd><Money cents={e.essentialMonthlyCents} /> <span className="muted small">({e.monthsUsed} meses)</span></dd>
          <dt>Reservado</dt><dd><Money cents={e.savedCents} /></dd>
          <dt>Referencia 3 meses</dt><dd><Money cents={e.suggestedTargetCents.months3} /></dd>
          <dt>Referencia 6 meses</dt><dd><Money cents={e.suggestedTargetCents.months6} /></dd>
          {pot && <><dt>Tu objetivo</dt><dd><Money cents={pot.targetCents} /> <span className="muted small">({formatBp(pot.progressBp, 0)})</span></dd></>}
        </dl>
      </div>
      {moving && pot && <MovementDialog pot={pot} sign={moving} onClose={() => setMoving(null)} />}
    </Card>
  );
}

function PotCard({ pot, onAdd, onWithdraw, onEdit, onDelete, onHistory }: { pot: PotDTO; onAdd: () => void; onWithdraw: () => void; onEdit: () => void; onDelete: () => void; onHistory: () => void }) {
  const s = STATUS[pot.status];
  return (
    <article className="scenario" style={{ borderLeft: `4px solid ${pot.color}` }} aria-label={pot.name}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{pot.name}</h3>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="stat-value"><Money cents={pot.savedCents} /></span>
        <span className="muted">de <Money cents={pot.targetCents} /></span>
      </div>
      <ProgressBar valueBp={pot.progressBp} label={`Progreso de ${pot.name}`} />
      <div className="small muted">
        {pot.status === 'done'
          ? '¡Objetivo alcanzado!'
          : pot.targetDate
            ? <>Faltan <strong><Money cents={pot.remainingCents} /></strong> para el {formatDate(pot.targetDate)} · aparta <strong><Money cents={pot.requiredMonthlyCents} />/mes</strong> durante {pot.monthsLeft} {pot.monthsLeft === 1 ? 'mes' : 'meses'}</>
            : <>Faltan <strong><Money cents={pot.remainingCents} /></strong>. Añade una fecha para calcular cuánto apartar al mes.</>}
        {pot.expectedTodayCents !== null && pot.status !== 'done' && pot.status !== 'overdue' && <> · según el plan hoy deberías llevar <Money cents={pot.expectedTodayCents} /></>}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn sm primary" onClick={onAdd}>Aportar</button>
        <button className="btn sm" onClick={onWithdraw} disabled={pot.savedCents <= 0}>Retirar</button>
        <button className="btn sm ghost" onClick={onHistory}>Movimientos ({pot.movementsCount})</button>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={onEdit}>Editar</button>
        <button className="btn sm ghost" onClick={onDelete}>Eliminar</button>
      </div>
    </article>
  );
}

function PotDialog({ initial, onClose }: { initial: Partial<PotInput>; onClose: () => void }) {
  const [p, setP] = useState<Partial<PotInput>>(initial);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const save = async () => {
    setError(null);
    if (!p.name?.trim()) return setError('Ponle un nombre.');
    if (!p.targetCents || p.targetCents <= 0) return setError('Indica un objetivo mayor que cero.');
    try {
      await api('pots.save', { id: p.id, name: p.name.trim(), kind: p.kind ?? 'goal', targetCents: p.targetCents, targetDate: p.targetDate || null, color: p.color ?? COLORS[0]! });
      invalidate();
      toast({ tone: 'info', message: 'Meta guardada.' });
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open title={p.id ? 'Editar meta' : p.kind === 'emergency' ? 'Fondo de emergencia' : 'Nueva meta'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="form-row">
        <Field label="Nombre" htmlFor="pot-name"><input id="pot-name" className="input" value={p.name ?? ''} maxLength={60} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Viaje, coche, entrada piso…" /></Field>
        <Field label="Objetivo" htmlFor="pot-target"><EuroInput id="pot-target" valueCents={p.targetCents ?? null} onChange={(c) => setP({ ...p, targetCents: c ?? undefined })} /></Field>
        {p.kind !== 'emergency' && (
          <Field label="Fecha objetivo (opcional)" htmlFor="pot-date"><input id="pot-date" type="date" className="input" min={todayIso()} value={p.targetDate ?? ''} onChange={(e) => setP({ ...p, targetDate: e.target.value || null })} /></Field>
        )}
      </div>
      <Field label="Color">
        <div className="row" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={p.color === c} aria-label={c} onClick={() => setP({ ...p, color: c })} style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: p.color === c ? '3px solid var(--ink)' : '2px solid var(--surface)', cursor: 'pointer' }} />
          ))}
        </div>
      </Field>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function MovementDialog({ pot, sign, onClose }: { pot: PotDTO; sign: 1 | -1; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(pot.requiredMonthlyCents && sign === 1 ? pot.requiredMonthlyCents : null);
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const save = async () => {
    setError(null);
    if (!amount || amount <= 0) return setError('Indica un importe mayor que cero.');
    if (sign === -1 && amount > pot.savedCents) return setError(`No puedes retirar más de lo reservado (${formatCents(pot.savedCents)}).`);
    try {
      await api('pots.addMovement', { potId: pot.id, date, amountCents: sign * amount, note: note.trim() || null });
      invalidate();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open title={`${sign === 1 ? 'Aportar a' : 'Retirar de'} «${pot.name}»`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>{sign === 1 ? 'Registrar aportación' : 'Registrar retirada'}</button></>}>
      <div className="form-row">
        <Field label="Importe" htmlFor="mv-amount"><EuroInput id="mv-amount" valueCents={amount} onChange={setAmount} /></Field>
        <Field label="Fecha" htmlFor="mv-date"><input id="mv-date" type="date" className="input" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Nota (opcional)" htmlFor="mv-note"><input id="mv-note" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function HistoryDialog({ pot, onClose }: { pot: PotDTO; onClose: () => void }) {
  const q = useQuery(() => api('pots.movements', { potId: pot.id }), [pot.id]);
  const invalidate = useInvalidate();
  return (
    <Dialog open title={`Movimientos de «${pot.name}»`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      {!q.data ? <Loading /> : q.data.length === 0 ? <p className="muted">Sin movimientos todavía.</p> : (
        <table className="table">
          <thead><tr><th>Fecha</th><th>Nota</th><th className="right">Importe</th><th /></tr></thead>
          <tbody>
            {q.data.map((m) => (
              <tr key={m.id}>
                <td className="num">{formatDate(m.date)}</td>
                <td className="muted">{m.note ?? ''}</td>
                <td className="right"><Money cents={m.amountCents} signed /></td>
                <td className="right"><button className="btn sm ghost" aria-label="Eliminar movimiento" onClick={async () => { await api('pots.deleteMovement', { id: m.id }); invalidate(); q.reload(); }}>Eliminar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

