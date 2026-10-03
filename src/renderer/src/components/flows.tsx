import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatBp, formatCents } from '../../../shared/money';
import { addMonths, todayIso } from '../../../shared/dates';
import type { EmailCandidate, EmailStatus, ImportOutcome, IncomeDTO, IncomeKind, Recommendation, SavingsGoalDTO, SyncSummary } from '../../../shared/types';
import { Badge, Callout, Dialog, EuroInput, Field, Icon, Money, Segmented, useToast } from './ui';

const currentMonth = () => todayIso().slice(0, 7);
/** Onboarding default: the salary also applies to the history that is about to be imported. */
/** A single goal applies to the whole history, so past months can be compared with it. */
const GOAL_APPLIES_FROM = '2000-01';
const historyStart = () => addMonths(currentMonth(), -12);

// ───────── Import with password handling ─────────

export function ImportOutcomeList({ outcomes }: { outcomes: ImportOutcome[] }) {
  if (!outcomes.length) return null;
  const tone = (o: ImportOutcome) => (o.status === 'imported' ? 'success' : o.status === 'duplicate' ? 'info' : o.status === 'failed' ? 'danger' : 'warning');
  return (
    <div className="stack" aria-live="polite">
      {outcomes.map((o, i) => (
        <Callout key={`${o.fileName}-${i}`} tone={tone(o)}>
          <strong>{o.fileName}</strong> — {o.message}
        </Callout>
      ))}
    </div>
  );
}

/** "Importar documento" button: native file picker in main, then password prompt when needed. */
export function ImportButton({ onDone, primary = true, label = 'Importar documento' }: { onDone?: (o: ImportOutcome[]) => void; primary?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ImportOutcome | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [pwError, setPwError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [results, setResults] = useState<ImportOutcome[]>([]);

  const finish = (list: ImportOutcome[]) => {
    const waiting = list.find((o) => o.status === 'password_required');
    setResults(list);
    if (waiting) setPending(waiting);
    invalidate();
    onDone?.(list);
  };

  const pick = async () => {
    setBusy(true);
    try {
      finish(await api('import.pickAndImport'));
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!pending?.pendingToken) return;
    setBusy(true);
    setPwError(null);
    try {
      const outcome = await api('import.withPassword', { token: pending.pendingToken, password, remember });
      if (outcome.status === 'password_required') {
        setPwError(outcome.message);
      } else {
        setPending(null);
        setPassword('');
        finish(results.map((r) => (r.pendingToken === pending.pendingToken ? outcome : r)));
      }
    } catch (err) {
      setPwError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={`btn ${primary ? 'primary' : ''}`} onClick={pick} disabled={busy}>
        {busy ? <span className="spinner" aria-hidden /> : <Icon name="upload" />} {label}
      </button>
      {results.length > 0 && !onDone && <ImportOutcomeList outcomes={results} />}
      <Dialog
        open={!!pending}
        title="Documento protegido"
        onClose={() => { setPending(null); setPassword(''); }}
        footer={
          <>
            <button className="btn" onClick={() => { setPending(null); setPassword(''); }}>Cancelar</button>
            <button className="btn primary" onClick={submitPassword} disabled={!password || busy}>Desbloquear e importar</button>
          </>
        }
      >
        <p>«{pending?.fileName}» está protegido con contraseña. Muchos bancos (BBVA, entre otros) usan el <strong>DNI/NIE del titular</strong> (con letra).</p>
        <Callout tone="info">La contraseña solo se usa para abrir el archivo en este equipo: no se guarda en disco y se olvida al cerrar Hormiga. Nunca introduzcas aquí la clave de tu banca online.</Callout>
        <Field label="Contraseña del PDF" htmlFor="pdf-pw" error={pwError}>
          <input id="pdf-pw" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitPassword()} autoFocus />
        </Field>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Usarla también para los próximos documentos mientras Hormiga esté abierta
        </label>
      </Dialog>
    </>
  );
}

// ───────── Savings goal ─────────

export function GoalEditor({ onSaved, compact }: { onSaved?: () => void; compact?: boolean }) {
  const goal = useQuery(() => api('goal.get'), []);
  const [mode, setMode] = useState<'amount' | 'percent' | null>(null);
  const [amount, setAmount] = useState<number | null | undefined>(undefined);
  const [pct, setPct] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const g = goal.data;
  const m = mode ?? g?.mode ?? 'amount';
  const a = amount === undefined ? (g?.amountCents ?? null) : amount;
  const p = pct ?? (g?.percentBp != null ? String(g.percentBp / 100).replace('.', ',') : '');

  const save = async () => {
    setError(null);
    let payload: SavingsGoalDTO;
    if (m === 'amount') {
      if (a === null || a <= 0) return setError('Introduce un importe mayor que cero.');
      payload = { mode: 'amount', amountCents: a, percentBp: null, effectiveFrom: g?.effectiveFrom ?? GOAL_APPLIES_FROM };
    } else {
      const n = Number(p.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || n > 100) return setError('Introduce un porcentaje entre 0 y 100.');
      payload = { mode: 'percent', amountCents: null, percentBp: Math.round(n * 100), effectiveFrom: g?.effectiveFrom ?? GOAL_APPLIES_FROM };
    }
    try {
      await api('goal.set', payload);
      toast({ tone: 'info', message: 'Objetivo de ahorro guardado.' });
      invalidate();
      onSaved?.();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  return (
    <div className="stack">
      <Segmented label="Tipo de objetivo" value={m} onChange={(v) => setMode(v)} options={[{ value: 'amount', label: 'Importe fijo (€/mes)' }, { value: 'percent', label: '% de ingresos' }]} />
      <div className="form-row">
        {m === 'amount' ? (
          <Field label="Objetivo mensual" htmlFor="goal-amount">
            <EuroInput id="goal-amount" valueCents={a} onChange={setAmount} placeholder="700,00" />
          </Field>
        ) : (
          <Field label="Porcentaje de tus ingresos" htmlFor="goal-pct">
            <div className="euro-input pct"><input id="goal-pct" className="input num" inputMode="decimal" value={p} onChange={(e) => setPct(e.target.value)} placeholder="20" /></div>
          </Field>
        )}
        <div className="row">
          <button className="btn primary" onClick={save}>Guardar objetivo</button>
          {g && !compact && (
            <button className="btn ghost" onClick={async () => { await api('goal.set', null); invalidate(); }}>Quitar objetivo</button>
          )}
        </div>
      </div>
      {error && <div className="field"><span className="error" role="alert">{error}</span></div>}
      {g && (
        <p className="muted small">
          Objetivo actual: {g.mode === 'amount' ? `${formatCents(g.amountCents ?? 0)}/mes` : `${formatBp(g.percentBp, 0)} de los ingresos`}.
        </p>
      )}
    </div>
  );
}

// ───────── Income ─────────

const INCOME_KINDS: { value: IncomeKind; label: string; help: string }[] = [
  { value: 'salary', label: 'Salario neto', help: 'Se aplica cada mes desde el mes de inicio.' },
  { value: 'recurring', label: 'Otro ingreso recurrente', help: 'Alquileres cobrados, pensiones, etc.' },
  { value: 'extraordinary', label: 'Extraordinario', help: 'Solo cuenta en el mes indicado (pagas extra, bonus…).' },
];

export function IncomeEditor({ simple }: { simple?: boolean }) {
  const list = useQuery(() => api('income.list'), []);
  const [editing, setEditing] = useState<Partial<IncomeDTO> | null>(simple ? { kind: 'salary', label: 'Salario', startMonth: historyStart(), endMonth: null } : null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();

  const save = async () => {
    if (!editing) return;
    setError(null);
    if (!editing.amountCents || editing.amountCents <= 0) return setError('Introduce un importe mayor que cero.');
    try {
      await api('income.save', {
        id: editing.id,
        kind: editing.kind ?? 'salary',
        label: editing.label?.trim() || INCOME_KINDS.find((k) => k.value === editing.kind)!.label,
        amountCents: editing.amountCents,
        startMonth: editing.startMonth ?? currentMonth(),
        endMonth: editing.kind === 'extraordinary' ? null : (editing.endMonth ?? null),
      });
      toast({ tone: 'info', message: 'Ingreso guardado.' });
      setEditing(simple ? { kind: 'salary', label: 'Salario', startMonth: historyStart(), endMonth: null } : null);
      invalidate();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  return (
    <div className="stack">
      {(list.data?.length ?? 0) > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Concepto</th><th>Tipo</th><th>Desde</th><th>Hasta</th><th className="right">Importe</th><th /></tr>
            </thead>
            <tbody>
              {list.data!.map((i) => (
                <tr key={i.id}>
                  <td className="cell-main">{i.label}</td>
                  <td>{INCOME_KINDS.find((k) => k.value === i.kind)?.label}</td>
                  <td className="num">{i.startMonth}</td>
                  <td className="num">{i.kind === 'extraordinary' ? '—' : (i.endMonth ?? 'Sin fin')}</td>
                  <td className="right"><Money cents={i.amountCents} /></td>
                  <td className="right">
                    <button className="btn sm ghost" onClick={() => setEditing(i)}>Editar</button>
                    <button className="btn sm ghost" onClick={async () => { await api('income.delete', { id: i.id }); invalidate(); }} aria-label={`Eliminar ${i.label}`}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <div className="card flat stack">
          <div className="form-row">
            <Field label="Tipo" htmlFor="inc-kind">
              <select id="inc-kind" className="select" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as IncomeKind })}>
                {INCOME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </Field>
            <Field label="Concepto" htmlFor="inc-label">
              <input id="inc-label" className="input" value={editing.label ?? ''} onChange={(e) => setEditing({ ...editing, label: e.target.value })} maxLength={80} />
            </Field>
            <Field label={editing.kind === 'extraordinary' ? 'Importe' : 'Importe mensual neto'} htmlFor="inc-amount">
              <EuroInput id="inc-amount" valueCents={editing.amountCents ?? null} onChange={(c) => setEditing({ ...editing, amountCents: c ?? undefined })} placeholder="2.500,00" />
            </Field>
            <Field label={editing.kind === 'extraordinary' ? 'Mes' : 'Desde'} htmlFor="inc-start">
              <input id="inc-start" type="month" className="input" value={editing.startMonth ?? currentMonth()} onChange={(e) => setEditing({ ...editing, startMonth: e.target.value })} />
            </Field>
            {editing.kind !== 'extraordinary' && !simple && (
              <Field label="Hasta (opcional)" htmlFor="inc-end">
                <input id="inc-end" type="month" className="input" value={editing.endMonth ?? ''} onChange={(e) => setEditing({ ...editing, endMonth: e.target.value || null })} />
              </Field>
            )}
          </div>
          <p className="muted small">{INCOME_KINDS.find((k) => k.value === editing.kind)?.help} Para un cambio de sueldo, pon fecha de fin al anterior y añade uno nuevo.</p>
          {error && <span className="error small" role="alert" style={{ color: 'var(--negative)' }}>{error}</span>}
          <div className="row">
            <button className="btn primary" onClick={save}>{editing.id ? 'Guardar cambios' : 'Añadir ingreso'}</button>
            {!simple && <button className="btn" onClick={() => setEditing(null)}>Cancelar</button>}
          </div>
        </div>
      ) : (
        <div>
          <button className="btn" onClick={() => setEditing({ kind: 'salary', label: '', startMonth: currentMonth(), endMonth: null })}>Añadir ingreso</button>
        </div>
      )}
    </div>
  );
}

// ───────── Gmail connection ─────────

export function EmailConnectPanel({ status, onChanged }: { status: EmailStatus | undefined; onChanged: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [send, setSend] = useState(true);
  const toast = useToast();

  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (success) toast({ tone: 'info', message: success });
      onChanged();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  if (!status) return null;
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={status.state === 'connected' ? 'positive' : status.state === 'reauth_required' ? 'warning' : 'neutral'}>
          <Icon name={status.state === 'connected' ? 'check' : 'mail'} size={13} />
          {status.state === 'connected' ? `Conectado${status.account ? ` · ${status.account}` : ''}` : status.state === 'reauth_required' ? 'Requiere volver a conectar' : status.state === 'disconnected' ? 'No conectado' : 'Sin configurar'}
        </Badge>
        <span className="muted small">{status.canSend ? 'Permisos: leer extractos y enviarte tus avisos a ti mismo.' : 'Permiso: solo lectura (gmail.readonly).'}</span>
      </div>
      {status.message && <Callout tone="warning">{status.message}</Callout>}
      {status.weeklyExpiryLikely && (
        <Callout tone="info">
          Google ha cortado la conexión justo una semana después de autorizarla: tu proyecto de Google Cloud está en modo «Prueba» y en ese modo la autorización caduca a los 7 días. Para que no vuelva a pasar: Google Cloud Console → Google Auth Platform → Audiencia → «Publicar app» (es una app personal: al conectar verás el aviso de «app no verificada», es normal). Después pulsa «Volver a conectar».{' '}
          <button className="btn link" onClick={() => api('shell.openHelp', { topic: 'oauth-consent' })}>Abrir la pantalla de Audiencia</button>
        </Callout>
      )}

      {status.state === 'not_configured' && (
        <div className="stack">
          <Callout tone="info">
            Para conectar Gmail necesitas un cliente OAuth propio de tipo «Aplicación de escritorio» en Google Cloud (gratuito). Los pasos están en el README.{' '}
            <button className="btn link" onClick={() => api('shell.openHelp', { topic: 'google-cloud-console' })}>Abrir Google Cloud Console</button>
          </Callout>
          <div className="form-row">
            <Field label="ID de cliente" htmlFor="oauth-id">
              <input id="oauth-id" className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" autoComplete="off" />
            </Field>
            <Field label="Secreto de cliente" htmlFor="oauth-secret">
              <input id="oauth-secret" className="input mono" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
            </Field>
          </div>
          <div>
            <button className="btn primary" disabled={!clientId || !clientSecret || !!busy} onClick={() => run('save', () => api('email.saveClientConfig', { clientId: clientId.trim(), clientSecret: clientSecret.trim() }), 'Cliente OAuth guardado de forma cifrada.')}>
              Guardar credenciales del cliente
            </button>
          </div>
        </div>
      )}

      {(status.state === 'disconnected' || status.state === 'reauth_required') && (
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Enviarme también mis avisos importantes por correo (a mi propia dirección)
          </label>
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={() => run('connect', () => api('email.connect', { send }), 'Cuenta de Gmail conectada.')}>
              {busy === 'connect' ? <span className="spinner" aria-hidden /> : <Icon name="mail" />} {busy === 'connect' ? 'Esperando autorización en el navegador…' : status.state === 'reauth_required' ? 'Volver a conectar' : 'Conectar con Google'}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => run('clear', () => api('email.clearClientConfig'))}>Usar otro cliente OAuth</button>
          </div>
          <p className="muted small">Tu ID y secreto de cliente se conservan: no hace falta crear ni pegar nada nuevo para volver a conectar.</p>
        </div>
      )}
      {status.state === 'connected' && (
        <div className="row">
          {!status.canSend && <button className="btn" disabled={!!busy} onClick={() => run('connect', () => api('email.connect', { send: true }), 'Permiso para enviarte avisos concedido.')}>Permitir enviarme avisos por correo</button>}
          <button className="btn danger" disabled={!!busy} onClick={() => run('disconnect', () => api('email.disconnect'), 'Cuenta desconectada y acceso revocado.')}>Desconectar</button>
        </div>
      )}
      <p className="muted small">Para que Google no corte la conexión cada 7 días, tu proyecto de Google Cloud debe estar publicado (Audiencia → «Publicar app»), no en modo «Prueba».</p>
      {busy === 'connect' && <p className="muted small">Se ha abierto tu navegador con la pantalla de Google. Hormiga nunca ve tu contraseña.</p>}
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}

/** Review list of detected emails before importing them. */
export function CandidatesReview({ candidates, onImported }: { candidates: EmailCandidate[]; onImported: (s: SyncSummary) => void }) {
  const importable = candidates.filter((c) => c.attachments.length > 0 && c.processedStatus !== 'imported' && c.processedStatus !== 'duplicate');
  const [selected, setSelected] = useState<Set<string>>(new Set(importable.filter((c) => c.classification === 'detected').map((c) => c.messageId)));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidate();
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  if (candidates.length === 0) return <Callout tone="info">No se han encontrado emails de bancos con extractos adjuntos en el periodo buscado. Puedes ampliar el periodo o añadir remitentes en Ajustes → Detección.</Callout>;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th><span className="sr-only">Seleccionar</span></th><th>Fecha</th><th>Asunto y remitente</th><th>Adjuntos</th><th>Detección</th></tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const disabled = !importable.includes(c);
              return (
                <tr key={c.messageId}>
                  <td>
                    <input type="checkbox" aria-label={`Importar ${c.subject}`} disabled={disabled} checked={selected.has(c.messageId)} onChange={() => toggle(c.messageId)} />
                  </td>
                  <td className="num">{new Date(c.date).toLocaleDateString('es-ES')}</td>
                  <td>
                    <div className="cell-main">{c.subject || '(sin asunto)'}</div>
                    <div className="cell-sub">{c.from}</div>
                  </td>
                  <td className="small">{c.attachments.map((a) => a.fileName).join(', ') || '—'}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Badge tone={c.classification === 'detected' ? 'accent' : 'warning'} title={c.reasons.join(' · ')}>
                        {c.classification === 'detected' ? 'Detectado' : 'Posible'} · {Math.round(c.scoreBp / 100)}
                      </Badge>
                      {c.processedStatus && <Badge tone="outline">{processedLabel(c.processedStatus)}</Badge>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={selected.size === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const s = await api('email.importSelected', { messageIds: [...selected] });
              toast({ tone: s.errors.some((e) => !e.subject) ? 'error' : 'info', message: s.message });
              invalidate();
              onImported(s);
            } catch (err) {
              toast({ tone: 'error', message: toApiError(err).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="download" />} Importar {selected.size} seleccionado(s)
        </button>
        <span className="muted small">Pasa el ratón sobre la detección para ver los motivos.</span>
      </div>
    </div>
  );
}

export function processedLabel(s: string): string {
  return ({ imported: 'Importado', duplicate: 'Ya importado', needs_review: 'En revisión', password_required: 'Requiere contraseña', failed: 'Error', not_statement: 'Ignorado (no es un extracto)', skipped: 'Sin PDF' } as Record<string, string>)[s] ?? s;
}

// ───────── Recommendations ─────────

export function RecommendationCard({ rec, onDismiss }: { rec: Recommendation; onDismiss?: () => void }) {
  return (
    <article className={`reco ${rec.tone}`} aria-label={rec.title}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{rec.title}</h3>
        <div className="row" style={{ gap: 6 }}>
          {rec.tone === 'positive' && <Badge tone="positive">Buen dato</Badge>}
          {rec.tone === 'opportunity' && <Badge tone={rec.priority === 'high' ? 'warning' : 'outline'}>{rec.priority === 'high' ? 'Prioridad alta' : rec.priority === 'medium' ? 'Prioridad media' : 'Prioridad baja'}</Badge>}
          {onDismiss && <button className="btn ghost sm" onClick={onDismiss} aria-label={`Descartar recomendación ${rec.title}`}><Icon name="x" size={14} /></button>}
        </div>
      </div>
      <p>{rec.description}</p>
      {rec.estimatedMonthlyImpactCents !== null && (
        <div className="reco-impact">
          <span>Impacto estimado: <strong>{formatCents(rec.estimatedMonthlyImpactCents)}/mes</strong></span>
          <span><strong>{formatCents(rec.estimatedAnnualImpactCents ?? 0)}/año</strong></span>
        </div>
      )}
      <details>
        <summary>Por qué lo vemos</summary>
        <p className="small" style={{ marginTop: 6 }}>{rec.reason}</p>
        {rec.evidence.length > 0 && <ul className="evidence">{rec.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
      </details>
    </article>
  );
}
