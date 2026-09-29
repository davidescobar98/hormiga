import { useEffect, useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { Callout, Dialog, Field, useToast } from './ui';

/**
 * Global popup: when emailed statements with password-protected PDFs are pending, asks once for the password
 * (usually the holder's DNI/NIE) and unlocks all of them. The password is never stored on disk.
 */
export function PendingPasswordPrompt() {
  const pending = useQuery(() => api('email.pendingPasswords'), []);
  const [dismissed, setDismissed] = useState<string>('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();

  // Re-check after a startup sync finishes in the background.
  useEffect(() => window.hormiga.on('sync.finished', () => pending.reload()), [pending.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = pending.data ?? [];
  const key = list.map((p) => p.messageId).sort().join(',');
  const open = list.length > 0 && dismissed !== key;

  const close = () => {
    setDismissed(key);
    setPassword('');
    setError(null);
  };

  const unlock = async () => {
    if (!password.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api('email.unlockPending', { password: password.trim(), remember });
      if (r.unlocked === 0) {
        setError(r.message);
      } else {
        toast({ tone: 'info', message: r.message });
        setPassword('');
        invalidate();
        pending.reload();
        if (r.remaining > 0) setError(r.message);
      }
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Documentos protegidos con contraseña"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Más tarde</button>
          <button className="btn primary" onClick={unlock} disabled={!password.trim() || busy}>
            {busy ? <span className="spinner" aria-hidden /> : null} Desbloquear {list.length > 1 ? `los ${list.length}` : ''}
          </button>
        </>
      }
    >
      <p>
        {list.length === 1 ? 'Hay 1 extracto' : `Hay ${list.length} extractos`} protegidos con contraseña. Muchos bancos (BBVA, entre otros) usan el
        <strong> DNI/NIE del titular</strong> (con letra, sin espacios ni guiones).
      </p>
      {list.length > 0 && (
        <ul className="evidence">
          {list.slice(0, 5).map((p) => <li key={p.messageId}>{p.subject ?? 'Email sin asunto'}</li>)}
          {list.length > 5 && <li>y {list.length - 5} más…</li>}
        </ul>
      )}
      <Field label="Contraseña de los PDF" htmlFor="pending-pw" error={error}>
        <input
          id="pending-pw"
          className="input"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && unlock()}
          autoFocus
        />
      </Field>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Usarla también para los próximos documentos mientras Hormiga esté abierta
      </label>
      <Callout tone="info">
        La contraseña solo se usa para abrir los PDF en este equipo. No se guarda en disco ni se envía a ningún sitio, y se olvida al cerrar Hormiga.
        Nunca introduzcas aquí la clave de tu banca online.
      </Callout>
    </Dialog>
  );
}
