import { useState } from 'react';
import { api, toApiError } from '../api';
import { useNavigate, type PageId } from '../App';
import type { AuditReport } from '../../../shared/types';
import { Badge, Callout, Card } from './ui';

const TONE = { ok: 'positive', info: 'info', warning: 'warning', error: 'negative' } as const;
const LABEL = { ok: 'Cuadra', info: 'Info', warning: 'Revisar', error: 'Error' } as const;

/** «Comprobar mis números»: runs the consistency checks over your data and explains any difference. */
export function AuditCard() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api('data.audit'));
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };
  const fix = async (f: NonNullable<AuditReport['checks'][number]['fix']>) => {
    setBusy(true);
    setError(null);
    try {
      for (const id of f.ruleIds) await api('rules.delete', { id });
    } catch (err) {
      setError(toApiError(err).message);
    }
    await run();
  };
  return (
    <Card title="Comprobar mis números" hint="Verifica que todo cuadra: ahorro, categorías, saldos frente a extractos, préstamos, presupuestos y duplicados. No cambia nada." actions={<button className="btn" disabled={busy} onClick={() => void run()}>{busy ? 'Comprobando…' : 'Comprobar ahora'}</button>}>
      {error && <Callout tone="danger">{error}</Callout>}
      {!report ? <p className="muted small">Pulsa «Comprobar ahora» para revisar tus datos.</p> : (
        <>
          <Callout tone={report.errors ? 'danger' : report.warnings ? 'warning' : 'success'}>
            {report.errors ? `${report.errors} ${report.errors === 1 ? 'comprobación no cuadra' : 'comprobaciones no cuadran'}.` : report.warnings ? `Todo cuadra, con ${report.warnings} ${report.warnings === 1 ? 'aviso' : 'avisos'} que conviene revisar.` : 'Todo cuadra.'}
          </Callout>
          <ul className="plain-list" aria-label="Resultados">
            {report.checks.map((c) => (
              <li key={c.id}>
                <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge> <strong>{c.label}.</strong> <span className="small">{c.detail}</span>
                {c.fix && c.status !== 'ok' && <> <button className="btn sm" disabled={busy} onClick={() => void fix(c.fix!)}>{c.fix.label}</button></>}
                {c.page && c.status !== 'ok' && <> <button className="btn link" onClick={() => navigate(c.page as PageId)}>Revisar</button></>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
