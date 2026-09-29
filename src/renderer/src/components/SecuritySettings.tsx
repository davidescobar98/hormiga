import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import type { AppSettings, LockConfigInput } from '../../../shared/types';
import { Callout, Card, Dialog, Field, Loading, useToast } from './ui';

const AUTO_LOCK = [
  { value: 0, label: 'Solo al abrir Hormiga' },
  { value: 5, label: 'Tras 5 minutos sin usar el ordenador' },
  { value: 15, label: 'Tras 15 minutos sin usar el ordenador' },
  { value: 30, label: 'Tras 30 minutos sin usar el ordenador' },
  { value: 60, label: 'Tras 1 hora sin usar el ordenador' },
];

export function SecurityCard() {
  const q = useQuery(() => api('lock.status'), []);
  const [dialog, setDialog] = useState<'enable' | 'change' | 'disable' | null>(null);
  const toast = useToast();
  const s = q.data;

  const configure = async (input: LockConfigInput, ok: string) => {
    try {
      await api('lock.configure', input);
      toast({ tone: 'info', message: ok });
      q.reload();
      return true;
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
      return false;
    }
  };

  return (
    <Card title="Seguridad" hint="Bloquea Hormiga para que nadie más pueda ver tus finanzas en este ordenador">
      {!s ? <Loading /> : (
        <div className="stack">
          {!s.enabled ? (
            <>
              <p className="small">Con el bloqueo activado, Hormiga pide tu PIN{s.helloAvailable ? ' o Windows Hello (huella, cara o PIN de Windows)' : ''} al abrirse y cuando dejas el ordenador sin usar. Mientras está bloqueada no muestra ni envía ningún dato.</p>
              <div><button className="btn primary" onClick={() => setDialog('enable')}>Activar bloqueo con PIN</button></div>
            </>
          ) : (
            <>
              <Callout tone="success">Bloqueo activado.</Callout>
              {s.helloAvailable && (
                <label className="check">
                  <input type="checkbox" checked={s.windowsHello} onChange={(e) => void configure({ windowsHello: e.target.checked }, e.target.checked ? 'Windows Hello activado.' : 'Windows Hello desactivado.')} />
                  Desbloquear con Windows Hello (huella, cara o PIN de Windows)
                </label>
              )}
              <Field label="Bloquear automáticamente" htmlFor="lock-auto">
                <select id="lock-auto" className="select" value={s.autoLockMinutes} onChange={(e) => void configure({ autoLockMinutes: Number(e.target.value) }, 'Guardado.')}>
                  {AUTO_LOCK.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <p className="muted small">También se bloquea cuando bloqueas Windows.</p>
              <div className="row">
                <button className="btn" onClick={() => void api('lock.lockNow')}>Bloquear ahora</button>
                <button className="btn ghost" onClick={() => setDialog('change')}>Cambiar PIN</button>
                <button className="btn ghost" onClick={() => setDialog('disable')}>Desactivar bloqueo</button>
              </div>
            </>
          )}
          <p className="muted small">El bloqueo protege la aplicación. El archivo de datos sigue en tu carpeta de usuario de Windows, protegido por tu sesión: usa una contraseña de Windows.</p>
        </div>
      )}
      {dialog && s && <PinDialog mode={dialog} helloAvailable={s.helloAvailable} onClose={() => setDialog(null)} onSave={configure} />}
    </Card>
  );
}

function PinDialog({ mode, helloAvailable, onClose, onSave }: { mode: 'enable' | 'change' | 'disable'; helloAvailable: boolean; onClose: () => void; onSave: (i: LockConfigInput, ok: string) => Promise<boolean> }) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [hello, setHello] = useState(helloAvailable);
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);

  const save = async () => {
    setError(null);
    if (mode !== 'enable' && !current) return setError('Introduce tu PIN actual.');
    if (mode !== 'disable') {
      if (!/^\d{4,8}$/.test(pin)) return setError('El PIN debe tener entre 4 y 8 cifras.');
      if (pin !== repeat) return setError('Los dos PIN no coinciden.');
    }
    const ok =
      mode === 'enable' ? await onSave({ enabled: true, pin, windowsHello: hello }, 'Bloqueo activado.')
      : mode === 'change' ? await onSave({ pin, currentPin: current }, 'PIN cambiado.')
      : await onSave({ enabled: false, currentPin: current }, 'Bloqueo desactivado.');
    if (ok) onClose();
  };
  const title = mode === 'enable' ? 'Activar bloqueo' : mode === 'change' ? 'Cambiar PIN' : 'Desactivar bloqueo';
  return (
    <Dialog open title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>{mode === 'disable' ? 'Desactivar' : 'Guardar'}</button></>}>
      <div className="form-row">
        {mode !== 'enable' && <Field label="PIN actual" htmlFor="pin-cur"><input id="pin-cur" className="input" type="password" inputMode="numeric" autoComplete="off" value={current} onChange={(e) => setCurrent(digits(e.target.value))} /></Field>}
        {mode !== 'disable' && (
          <>
            <Field label="Nuevo PIN (4–8 cifras)" htmlFor="pin-new"><input id="pin-new" className="input" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(digits(e.target.value))} /></Field>
            <Field label="Repite el PIN" htmlFor="pin-rep"><input id="pin-rep" className="input" type="password" inputMode="numeric" autoComplete="off" value={repeat} onChange={(e) => setRepeat(digits(e.target.value))} /></Field>
          </>
        )}
      </div>
      {mode === 'enable' && helloAvailable && <label className="check"><input type="checkbox" checked={hello} onChange={(e) => setHello(e.target.checked)} />Permitir también Windows Hello</label>}
      <p className="muted small">El PIN no se guarda: solo una huella cifrada en el almacén seguro de Windows. Si lo olvidas, tendrás que restaurar una copia de seguridad o borrar los datos.</p>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

export function AlertsSettingsCard({ settings }: { settings: AppSettings }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const update = async (patch: Partial<AppSettings>) => {
    try {
      await api('settings.update', patch);
      toast({ tone: 'info', message: 'Guardado.' });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  return (
    <Card title="Avisos y sincronización" hint="Los avisos siempre aparecen en «Resumen»; las notificaciones de Windows son opcionales">
      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={settings.notifications.enabled} onChange={(e) => void update({ notifications: { enabled: e.target.checked } })} />
          Mostrar notificaciones de Windows: presupuestos al 80 % o superados, cargos inusuales o duplicados, subidas de precio, pagos anuales próximos y transferencias grandes por revisar
        </label>
        <Field label="Buscar extractos nuevos en Gmail mientras Hormiga está abierta" htmlFor="sync-every">
          <select id="sync-every" className="select" value={settings.syncIntervalHours} onChange={(e) => void update({ syncIntervalHours: Number(e.target.value) })}>
            <option value={0}>Solo al abrir la aplicación</option>
            <option value={3}>Cada 3 horas</option>
            <option value={6}>Cada 6 horas</option>
            <option value={12}>Cada 12 horas</option>
            <option value={24}>Una vez al día</option>
          </select>
        </Field>
        <p className="muted small">Con Hormiga bloqueada, las notificaciones no muestran importes ni comercios.</p>
      </div>
    </Card>
  );
}
