import { useEffect, useRef, useState } from 'react';
import { api, toApiError } from '../api';
import type { LockStatus } from '../../../shared/types';
import { Icon } from './ui';

/** Shown instead of the app while locked. The main process refuses any data request until it is unlocked. */
export function LockScreen({ status, onUnlocked }: { status: LockStatus; onUnlocked: (s: LockStatus) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hello = status.windowsHello && status.helloAvailable;

  const tryHello = async () => {
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await api('lock.unlockHello'));
    } catch (err) {
      setError(toApiError(err).message);
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (hello) void tryHello();
    else input.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await api('lock.unlockPin', { pin }));
    } catch (err) {
      setError(toApiError(err).message);
      setPin('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="lock-screen" aria-label="Hormiga bloqueada">
      <form className="card lock-card" onSubmit={submit}>
        <div className="lock-icon" aria-hidden><Icon name="lock" size={28} /></div>
        <h1>Hormiga está bloqueada</h1>
        <p className="muted small">Introduce tu PIN{hello ? ' o usa Windows Hello' : ''} para ver tus finanzas.</p>
        <label className="sr-only" htmlFor="lock-pin">PIN</label>
        <input
          id="lock-pin"
          ref={input}
          className="input pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          disabled={busy}
        />
        {error && <p className="lock-error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || pin.length < 4}>Desbloquear</button>
        {hello && <button className="btn ghost" type="button" disabled={busy} onClick={tryHello}>Usar Windows Hello</button>}
      </form>
    </main>
  );
}
