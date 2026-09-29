import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import type { NavParams } from '../App';
import { useNavigate } from '../App';
import { formatDate } from '../../../shared/dates';
import { formatCents, parseAmountToCents } from '../../../shared/money';
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type DocumentDTO, type ImportOutcome, type ReviewItem, type ScanResult, type SyncSummary, type TransactionType, type UpdateReviewItemInput } from '../../../shared/types';
import { Badge, Callout, Card, Dialog, EmptyState, ErrorBox, Field, Icon, Loading, useToast, centsToInput } from '../components/ui';
import { CandidatesReview, ImportButton, ImportOutcomeList } from '../components/flows';

export function ImportPage({ initial }: { initial: NavParams }) {
  const docs = useQuery(() => api('import.documents'), []);
  const email = useQuery(() => api('email.status'), []);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [reviewId, setReviewId] = useState<number | null>(initial.documentId ?? null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const connected = email.data?.state === 'connected';

  const needsReview = (docs.data ?? []).filter((d) => d.status === 'needs_review');

  const syncNow = async () => {
    setBusy('sync');
    setError(null);
    try {
      const s = await api('email.syncNow');
      setLastSync(s);
      invalidate();
      if (s.pendingCandidates > 0 && s.imported === 0 && s.trigger === 'manual') {
        const r = await api('email.scan');
        setScan(r);
      }
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const doScan = async () => {
    setBusy('scan');
    setError(null);
    try {
      setScan(await api('email.scan'));
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Documentos</h1>
          <p className="subtitle">Extractos importados, revisión de importación y sincronización con Gmail.</p>
        </div>
        <div className="toolbar">
          {connected && (
            <button className="btn" onClick={syncNow} disabled={!!busy}>
              {busy === 'sync' ? <span className="spinner" aria-hidden /> : <Icon name="refresh" />} Sincronizar ahora
            </button>
          )}
          <ImportButton onDone={setOutcomes} />
        </div>
      </div>

      <ImportOutcomeList outcomes={outcomes} />
      {error && <Callout tone="danger">{error}</Callout>}
      {lastSync && <Callout tone={lastSync.errors.some((e) => !e.subject) ? 'danger' : 'info'}>{lastSync.message}</Callout>}

      {needsReview.length > 0 && (
        <Card title="Revisión de importación" hint="Estos documentos no se han importado automáticamente porque algo no cuadraba. No cuentan en tus cifras hasta que los confirmes.">
          <div className="stack">
            {needsReview.map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div className="cell-main">{d.fileName}</div>
                  <div className="cell-sub">{d.reviewCount} fila(s) pendientes · {d.warnings[0] ?? ''}</div>
                </div>
                <button className="btn primary sm" onClick={() => setReviewId(d.id)}>Revisar</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Gmail"
        hint={connected ? `Conectado${email.data?.account ? ` · ${email.data.account}` : ''}` : 'No conectado: puedes importar documentos manualmente.'}
        actions={connected ? (
          <button className="btn sm" onClick={doScan} disabled={!!busy}>{busy === 'scan' ? <span className="spinner" aria-hidden /> : <Icon name="search" size={15} />} Buscar documentos</button>
        ) : (
          <button className="btn sm" onClick={() => navigate('settings', { section: 'email' })}>Configurar Gmail</button>
        )}
      >
        {email.data?.state === 'reauth_required' && <Callout tone="warning">{email.data.message ?? 'Vuelve a conectar tu cuenta de Gmail en Ajustes.'}</Callout>}
        {email.data?.lastSync && (
          <p className="small muted">
            Última sincronización: {new Date(email.data.lastSync.finishedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })} — {email.data.lastSync.message}
          </p>
        )}
        {scan && (
          <div style={{ marginTop: 12 }}>
            <p className="small muted" style={{ marginBottom: 8 }}>Emails de los últimos {scan.lookbackMonths} meses que parecen extractos de tus bancos. Marca los que quieras importar.</p>
            <CandidatesReview candidates={scan.candidates} onImported={(s) => { setLastSync(s); setScan(null); }} />
          </div>
        )}
        {connected && <PendingPasswords />}
      </Card>

      <Card title="Historial de documentos">
        {docs.error && <ErrorBox error={docs.error} onRetry={docs.reload} />}
        {!docs.data ? <Loading /> : docs.data.length === 0 ? (
          <EmptyState title="Todavía no has importado documentos" actions={<ImportButton onDone={setOutcomes} />}>
            Importa el PDF de BBVA, el Excel de movimientos de CaixaBank, imagin, Sabadell, Santander, ING, Openbank o BBVA, un CSV o un fichero Norma 43. Puedes mezclar bancos: cada movimiento guarda de qué documento viene.
          </EmptyState>
        ) : (
          <DocumentsTable docs={docs.data} onReview={setReviewId} />
        )}
      </Card>

      {reviewId !== null && <ReviewDialog documentId={reviewId} onClose={() => setReviewId(null)} />}
    </div>
  );
}

function PendingPasswords() {
  const pending = useQuery(() => api('email.pendingPasswords'), []);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const invalidate = useInvalidate();
  if (!pending.data?.length) return null;
  return (
    <div className="card flat stack" style={{ marginTop: 12 }}>
      <h3>{pending.data.length} documento(s) protegidos con contraseña</h3>
      <p className="small muted">Suele ser el DNI/NIE del titular (con letra). Se prueba en todos los pendientes y no se guarda en disco.</p>
      <div className="form-row">
        <Field label="Contraseña de los PDF" htmlFor="pw-all">
          <input id="pw-all" type="password" className="input" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div>
          <button className="btn primary" disabled={!password.trim()} onClick={async () => {
            try {
              const r = await api('email.unlockPending', { password: password.trim(), remember: true });
              setMsg(r.message);
              if (r.unlocked > 0) setPassword('');
              invalidate();
            } catch (err) {
              setMsg(toApiError(err).message);
            }
          }}>Desbloquear</button>
        </div>
      </div>
      {msg && <p className="small" role="status">{msg}</p>}
    </div>
  );
}

function DocumentsTable({ docs, onReview }: { docs: DocumentDTO[]; onReview: (id: number) => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [confirmDoc, setConfirmDoc] = useState<DocumentDTO | null>(null);
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Documento</th><th>Origen</th><th>Periodo</th><th className="right">Movimientos</th><th>Estado</th><th /></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  <div className="cell-main">{d.fileName}</div>
                  <div className="cell-sub" title={d.warnings.join(' ')}>
                    Importado {new Date(d.importedAt).toLocaleDateString('es-ES')} · SHA-256 {d.sha256Short}…{d.warnings.length ? ` · ${d.warnings.length} aviso(s)` : ''}
                  </div>
                </td>
                <td>
                  {d.source === 'email' ? 'Gmail' : d.source === 'demo' ? 'Demostración' : 'Manual'}
                  {d.bank && d.source !== 'demo' && <div className="cell-sub">{d.bank}</div>}
                </td>
                <td className="num small">{d.periodStart && d.periodEnd ? `${formatDate(d.periodStart)} – ${formatDate(d.periodEnd)}` : '—'}</td>
                <td className="right num">{d.txCount}</td>
                <td>
                  {d.status === 'imported' ? <Badge tone="positive">Importado</Badge> : <Badge tone="warning">Pendiente de revisión</Badge>}
                  {d.retained && <> <Badge tone="outline">PDF conservado</Badge></>}
                </td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {d.status === 'needs_review' && <button className="btn sm primary" onClick={() => onReview(d.id)}>Revisar</button>}{' '}
                  {d.retained && <button className="btn sm ghost" onClick={async () => { const r = await api('import.openDocument', { documentId: d.id }); if (!r.ok) toast({ tone: 'error', message: r.message }); }}>Abrir</button>}
                  <button className="btn sm ghost" onClick={() => setConfirmDoc(d)}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={!!confirmDoc}
        title="Eliminar documento"
        onClose={() => setConfirmDoc(null)}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmDoc(null)}>Cancelar</button>
            <button className="btn danger solid" onClick={async () => {
              const r = await api('import.discardDocument', { documentId: confirmDoc!.id });
              toast({ tone: 'info', message: `Documento eliminado junto con ${r.removedTransactions} movimiento(s).` });
              setConfirmDoc(null);
              invalidate();
            }}>Eliminar documento y movimientos</button>
          </>
        }
      >
        <p>Se eliminará «{confirmDoc?.fileName}» y sus {confirmDoc?.txCount} movimientos. Podrás volver a importarlo después.</p>
      </Dialog>
    </>
  );
}

function ReviewDialog({ documentId, onClose }: { documentId: number; onClose: () => void }) {
  const q = useQuery(() => api('import.review', { documentId }), [documentId]);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const r = q.data;
  const pending = r?.items.filter((i) => i.status === 'pending').length ?? 0;
  const accepted = r?.items.filter((i) => i.status === 'accepted') ?? [];
  const acceptedTotal = -accepted.reduce((a, i) => a + (i.amountCents ?? 0), 0);

  const update = async (item: ReviewItem, patch: ReviewPatch) => {
    setError(null);
    try {
      await api('import.updateReviewItem', { id: item.id, ...patch });
      q.reload();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  return (
    <Dialog
      open
      wide
      title="Revisión de importación"
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={async () => { await api('import.discardDocument', { documentId }); invalidate(); onClose(); toast({ tone: 'info', message: 'Documento descartado.' }); }}>Descartar documento</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cerrar</button>
          <button className="btn primary" disabled={pending > 0} title={pending > 0 ? 'Resuelve las filas pendientes' : undefined} onClick={async () => {
            try {
              const res = await api('import.confirmReview', { documentId });
              toast({ tone: 'info', message: `${res.inserted} movimientos importados${res.duplicatesSkipped ? `, ${res.duplicatesSkipped} duplicados omitidos` : ''}.` });
              invalidate();
              onClose();
            } catch (err) {
              setError(toApiError(err).message);
            }
          }}>Confirmar importación ({accepted.length})</button>
        </>
      }
    >
      {!r ? <Loading /> : (
        <>
          <p><strong>{r.document.fileName}</strong>{r.document.periodStart && r.document.periodEnd ? ` · ${formatDate(r.document.periodStart)} – ${formatDate(r.document.periodEnd)}` : ''}</p>
          {r.statementIssues.map((i) => <Callout key={i} tone="warning">{i}</Callout>)}
          {r.document.warnings.map((w) => <Callout key={w} tone="info">{w}</Callout>)}
          <p className="small muted">
            Comprueba cada fila con el documento original. Corrige las marcadas y acéptalas, o descártalas. Suma de filas aceptadas (cargos − abonos): <strong className="num">{formatCents(acceptedTotal)}</strong>.
          </p>
          {error && <Callout tone="danger">{error}</Callout>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Fecha</th><th>Descripción</th><th>Tipo</th><th className="right">Importe</th><th>Estado</th></tr></thead>
              <tbody>
                {r.items.map((i) => <ReviewRow key={i.id} item={i} onUpdate={(p) => update(i, p)} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

type ReviewPatch = Omit<UpdateReviewItemInput, 'id'>;

function ReviewRow({ item, onUpdate }: { item: ReviewItem; onUpdate: (p: ReviewPatch) => void }) {
  const [amount, setAmount] = useState(item.amountCents === null ? '' : centsToInput(item.amountCents));
  return (
    <>
      <tr style={{ opacity: item.status === 'discarded' ? 0.55 : 1 }}>
        <td>
          <input type="date" className="input compact" aria-label="Fecha" value={item.date ?? ''} onChange={(e) => e.target.value && onUpdate({ date: e.target.value })} />
        </td>
        <td style={{ minWidth: 260 }}>
          <input className="input compact" style={{ width: '100%' }} aria-label="Descripción" defaultValue={item.description} onBlur={(e) => e.target.value !== item.description && onUpdate({ description: e.target.value })} />
          <div className="cell-sub mono" title={item.rawText}>{item.rawText}</div>
        </td>
        <td>
          <select className="select compact" aria-label="Tipo" value={item.type} onChange={(e) => onUpdate({ type: e.target.value as TransactionType })}>
            {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</option>)}
          </select>
        </td>
        <td className="right">
          <input className="input compact num" style={{ width: 110, textAlign: 'right' }} aria-label="Importe (negativo = cargo)" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => { const c = parseAmountToCents(amount); if (c !== null && c !== item.amountCents) onUpdate({ amountCents: c }); }} />
        </td>
        <td>
          <select className="select compact" aria-label="Estado de la fila" value={item.status} onChange={(e) => onUpdate({ status: e.target.value as ReviewItem['status'] })}>
            <option value="pending">Pendiente</option>
            <option value="accepted">Aceptar</option>
            <option value="discarded">Descartar</option>
          </select>
        </td>
      </tr>
      {item.errors.length > 0 && item.status !== 'discarded' && (
        <tr>
          <td colSpan={5} style={{ paddingTop: 0 }}>
            <span className="small" style={{ color: 'var(--warning)' }}><Icon name="alert" size={13} /> {item.errors.join(' ')}</span>
          </td>
        </tr>
      )}
    </>
  );
}
