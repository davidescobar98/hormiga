import { useEffect, useRef, useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { applyTheme } from '../App';
import type { AppSettings, DetectionConfig, IncomeMode, SettingsPatch, Theme } from '../../../shared/types';
import { Callout, Card, Dialog, Field, Loading, Segmented, useToast } from '../components/ui';
import { EmailConnectPanel, GoalEditor, IncomeEditor } from '../components/flows';
import { describeUpdate, useUpdateStatus } from '../components/UpdateBanner';
import { ProfileEditor } from '../components/ProfileEditor';
import { AuditCard } from '../components/AuditCard';
import { ProfilesCard } from '../components/Profiles';
import { AlertsSettingsCard, SecurityCard } from '../components/SecuritySettings';

const SECTIONS = [
  { id: 'profile', label: 'Tu perfil' },
  { id: 'email', label: 'Cuenta de correo' },
  { id: 'bbva', label: 'Detección' },
  { id: 'income', label: 'Ingresos' },
  { id: 'goal', label: 'Ahorro' },
  { id: 'security', label: 'Seguridad' },
  { id: 'alerts', label: 'Avisos' },
  { id: 'privacy', label: 'Privacidad y datos' },
  { id: 'appearance', label: 'Apariencia' },
  { id: 'updates', label: 'Actualizaciones' },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsPage({ initialSection }: { initialSection?: string }) {
  const settings = useQuery(() => api('settings.get'), []);
  const email = useQuery(() => api('email.status'), []);
  const info = useQuery(() => api('data.info'), []);
  const appInfo = useQuery(() => api('app.info'), []);
  const invalidate = useInvalidate();
  const toast = useToast();
  const refs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (initialSection) refs.current[initialSection]?.scrollIntoView({ block: 'start' });
  }, [initialSection, settings.data]);

  const update = async (patch: SettingsPatch, ok = 'Ajustes guardados.') => {
    try {
      const s = await api('settings.update', patch);
      if (patch.theme) applyTheme(s.theme);
      toast({ tone: 'info', message: ok });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };

  const s = settings.data;
  if (!s) return <div className="page"><Loading /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Ajustes</h1>
          <p className="subtitle">Todo se guarda en este equipo. Las credenciales se cifran con el almacén seguro del sistema.</p>
        </div>
      </div>
      <nav className="toolbar" aria-label="Secciones de ajustes">
        {SECTIONS.map((sec) => <button key={sec.id} className="btn sm ghost" onClick={() => refs.current[sec.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{sec.label}</button>)}
      </nav>

      <section ref={(el) => { refs.current.profile = el; }}>
        <Card title="Tu perfil" hint="Opcional: adapta las sugerencias a tu situación"><ProfileEditor profile={s.profile} /></Card>
      </section>

      <section ref={(el) => { refs.current.email = el; }}>
        <Card title="Cuenta de correo" hint="Gmail mediante OAuth 2.0. Hormiga nunca ve ni guarda tu contraseña.">
          <div className="stack">
            <EmailConnectPanel status={email.data} onChanged={() => { email.reload(); invalidate(); }} />
            <hr className="sep" />
            <label className="check">
              <input type="checkbox" checked={s.autoSyncOnStart} onChange={(e) => update({ autoSyncOnStart: e.target.checked })} />
              Buscar documentos nuevos automáticamente al abrir la aplicación
            </label>
          </div>
        </Card>
      </section>

      <section ref={(el) => { refs.current.bbva = el; }}>
        <DetectionCard settings={s} onSave={(d, lookback) => update({ detection: d, initialLookbackMonths: lookback }, 'Detección de extractos actualizada.')} />
      </section>

      <section ref={(el) => { refs.current.income = el; }}>
        <Card title="Ingresos" hint="Los extractos de tarjeta no suelen incluir tu nómina: configura aquí tus ingresos netos.">
          <div className="stack">
            <Field label="Fuente de ingresos para los cálculos">
              <Segmented<IncomeMode>
                label="Fuente de ingresos"
                value={s.incomeMode}
                onChange={(v) => update({ incomeMode: v })}
                options={[{ value: 'auto', label: 'Automático' }, { value: 'manual', label: 'Configurados' }, { value: 'documents', label: 'Detectados en documentos' }, { value: 'combined', label: 'Ambos' }]}
              />
            </Field>
            <p className="muted small">
              «Automático» (recomendado) usa la nómina y demás ingresos que aparezcan en tus extractos de cuenta y, en los meses sin ellos, lo que configures aquí. «Configurados» usa solo lo que indicas aquí (recomendado si tus extractos son de tarjeta). «Detectados» usa los abonos marcados como ingreso en extractos de cuenta. «Ambos» los suma: evita contar dos veces la misma nómina.
            </p>
            <IncomeEditor />
          </div>
        </Card>
      </section>

      <section ref={(el) => { refs.current.goal = el; }}>
        <Card title="Objetivo de ahorro">
          <GoalEditor />
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={s.principalAsSavings} onChange={(e) => update({ principalAsSavings: e.target.checked })} />
            Contar el capital que amortizas de tus préstamos como ahorro, no como gasto (solo los intereses son gasto). Necesita el préstamo registrado en «Patrimonio» con su cuadro de amortización.
          </label>
        </Card>
      </section>

      <section ref={(el) => { refs.current.security = el; }}>
        <SecurityCard />
      </section>

      <section ref={(el) => { refs.current.alerts = el; }}>
        <AlertsSettingsCard settings={s} />
      </section>

      <section ref={(el) => { refs.current.profiles = el; }}>
        <ProfilesCard />
      </section>

      <section ref={(el) => { refs.current.audit = el; }}>
        <AuditCard />
      </section>

      <section ref={(el) => { refs.current.privacy = el; }}>
        <PrivacyCard settings={s} info={info.data} dataDir={appInfo.data?.dataDir} onToggleKeep={(v) => update({ keepDocuments: v })} onToggleMarket={(v) => update({ marketDataEnabled: v })} onChanged={() => { info.reload(); invalidate(); }} />
      </section>

      <section ref={(el) => { refs.current.appearance = el; }}>
        <Card title="Apariencia">
          <Segmented<Theme> label="Tema" value={s.theme} onChange={(t) => update({ theme: t })} options={[{ value: 'system', label: 'Sistema' }, { value: 'light', label: 'Claro' }, { value: 'dark', label: 'Oscuro' }]} />
        </Card>
      </section>

      <section ref={(el) => { refs.current.updates = el; }}>
        <UpdatesCard autoUpdate={s.autoUpdate} onToggle={(v) => update({ autoUpdate: v })} />
      </section>

      {appInfo.data && (
        <p className="muted small">
          Hormiga {appInfo.data.version} · Registro técnico (sin datos financieros): <span className="mono">{appInfo.data.logFile}</span>
        </p>
      )}
    </div>
  );
}

function UpdatesCard({ autoUpdate, onToggle }: { autoUpdate: boolean; onToggle: (v: boolean) => void }) {
  const [status, setStatus] = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setStatus(await api('app.checkUpdates'));
    } finally {
      setBusy(false);
    }
  };
  const supported = status?.state !== 'unsupported';
  return (
    <Card title="Actualizaciones" hint={status ? `Versión instalada: ${status.currentVersion}` : undefined}>
      <div className="stack">
        <p>{describeUpdate(status)}</p>
        {supported && (
          <label className="check">
            <input type="checkbox" checked={autoUpdate} onChange={(e) => onToggle(e.target.checked)} />
            Descargar e instalar las nuevas versiones automáticamente (desde GitHub; no se envía ningún dato tuyo)
          </label>
        )}
        <div className="row">
          {supported && <button className="btn" disabled={busy || status?.state === 'checking' || status?.state === 'downloading'} onClick={check}>Buscar actualizaciones</button>}
          {status?.state === 'ready' && <button className="btn primary" onClick={() => void api('app.installUpdate')}>Reiniciar y actualizar</button>}
        </div>
        <p className="muted small">No hace falta desinstalar ni reinstalar: la nueva versión se descarga en segundo plano y se aplica al reiniciar. Tus datos se guardan aparte del programa y se conservan; si una versión cambia la estructura de la base de datos, antes se guarda una copia automática en la subcarpeta <span className="mono">backups</span> (las 5 últimas).</p>
      </div>
    </Card>
  );
}

function listToText(list: string[]): string {
  return list.join(', ');
}
function textToList(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function DetectionCard({ settings, onSave }: { settings: AppSettings; onSave: (d: DetectionConfig, lookback: number) => void }) {
  const d = settings.detection;
  const [domains, setDomains] = useState(listToText(d.senderDomains));
  const [addresses, setAddresses] = useState(listToText(d.senderAddresses));
  const [subject, setSubject] = useState(listToText(d.subjectKeywords));
  const [files, setFiles] = useState(listToText(d.filenameKeywords));
  const [minScore, setMinScore] = useState(d.minScore);
  const [lookback, setLookback] = useState(settings.initialLookbackMonths);
  return (
    <Card title="Detección de extractos en el correo" hint="Se reconocen los principales bancos españoles (BBVA, CaixaBank, imagin, Santander, Sabadell, ING, Openbank, Bankinter, Unicaja, Abanca, Kutxabank, Ibercaja, Cajamar, Caja Rural, EVO, MyInvestor, Revolut, N26). Añade aquí otros remitentes si tu banco no aparece.">
      <div className="stack">
        <div className="form-row">
          <Field label="Dominios del remitente" htmlFor="det-domains" help="Separados por comas. Se aceptan subdominios.">
            <input id="det-domains" className="input" value={domains} onChange={(e) => setDomains(e.target.value)} />
          </Field>
          <Field label="Direcciones concretas (opcional)" htmlFor="det-addr">
            <input id="det-addr" className="input" value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="extractos@bbva.com" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Palabras del asunto" htmlFor="det-subject">
            <input id="det-subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Palabras en el nombre del PDF" htmlFor="det-files">
            <input id="det-files" className="input" value={files} onChange={(e) => setFiles(e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Puntuación mínima para importar automáticamente" htmlFor="det-score" help="Entre 35 y 100. Los emails por debajo pero por encima de 35 se muestran como «posibles».">
            <input id="det-score" type="number" min={35} max={100} className="input" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
          </Field>
          <Field label="Periodo de búsqueda inicial (meses)" htmlFor="det-lookback">
            <input id="det-lookback" type="number" min={1} max={60} className="input" value={lookback} onChange={(e) => setLookback(Number(e.target.value))} />
          </Field>
        </div>
        <div>
          <button className="btn primary" onClick={() => onSave({ senderDomains: textToList(domains).map((x) => x.toLowerCase()), senderAddresses: textToList(addresses).map((x) => x.toLowerCase()), subjectKeywords: textToList(subject), filenameKeywords: textToList(files), minScore: Math.min(100, Math.max(35, minScore || 60)) }, Math.min(60, Math.max(1, lookback || 12)))}>
            Guardar detección
          </button>
        </div>
        <p className="muted small">Puntuación: remitente de un banco o añadido por ti +40/45, asunto con el nombre del banco +10, palabra clave en asunto +15, extracto adjunto (PDF, Excel, CSV o Norma 43) +25, palabra clave en el nombre del archivo +10. El nombre visible del remitente se ignora porque es fácil de falsificar.</p>
      </div>
    </Card>
  );
}

function PrivacyCard({ settings, info, dataDir, onToggleKeep, onToggleMarket, onChanged }: { settings: AppSettings; info: import('../../../shared/types').DataInfo | undefined; dataDir?: string; onToggleKeep: (v: boolean) => void; onToggleMarket: (v: boolean) => void; onChanged: () => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<'restore' | 'delete' | 'clear' | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<{ ok?: boolean; message?: string } | unknown>, fallback: string) => {
    setBusy(true);
    try {
      const r = (await fn()) as { ok?: boolean; cancelled?: boolean; message?: string };
      if (!r?.cancelled) toast({ tone: r?.ok === false ? 'error' : 'info', message: r?.message ?? fallback });
      onChanged();
      return r;
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const required = dialog === 'restore' ? 'RESTAURAR' : dialog === 'clear' ? 'BORRAR' : 'ELIMINAR';
  return (
    <Card title="Privacidad y datos" hint="Nada sale de tu equipo salvo las peticiones de solo lectura a Gmail y, si lo activas, la búsqueda de rentabilidades pasadas.">
      <div className="stack">
        <dl className="kv">
          <dt>Ubicación de los datos</dt>
          <dd><span className="mono">{dataDir ?? info?.dataDir}</span> <button className="btn link" onClick={() => api('data.openDataDir')}>Abrir carpeta</button></dd>
          <dt>Base de datos</dt>
          <dd>{info ? `${info.transactionsCount} movimientos · ${info.documentsCount} documentos · ${fmtBytes(info.dbSizeBytes)} · esquema v${info.schemaVersion}` : '…'}</dd>
          <dt>PDFs conservados</dt>
          <dd>{info ? `${info.retainedDocumentsCount} (${fmtBytes(info.retainedDocumentsBytes)})` : '…'}</dd>
        </dl>
        <label className="check">
          <input type="checkbox" checked={settings.keepDocuments} onChange={(e) => onToggleKeep(e.target.checked)} />
          Conservar una copia de los PDF originales en la carpeta privada de datos (útil para auditar o reprocesar)
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.marketDataEnabled} onChange={(e) => onToggleMarket(e.target.checked)} />
          Consultar datos de mercado en internet (Yahoo Finance): rentabilidades pasadas y cotizaciones de «Bolsa». Solo se envía el nombre, ticker o ISIN que busques y los símbolos que sigues; nunca tus datos, importes ni operaciones.
        </label>
        <div className="row">
          <button className="btn" disabled={!info?.retainedDocumentsCount || busy} onClick={() => act(() => api('import.deleteRetainedDocuments'), 'PDFs conservados eliminados.')}>Eliminar PDFs conservados</button>
        </div>
        <hr className="sep" />
        <h3>Exportar y copias de seguridad</h3>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => act(() => api('data.exportTransactions', { format: 'csv' }), 'Exportado.')}>Exportar movimientos (CSV)</button>
          <button className="btn" disabled={busy} onClick={() => act(() => api('data.exportTransactions', { format: 'json' }), 'Exportado.')}>Exportar todo (JSON)</button>
          <button className="btn" disabled={busy} onClick={() => act(() => api('data.backup'), 'Copia creada.')}>Exportar copia de seguridad</button>
          <button className="btn" disabled={busy} onClick={() => { setConfirmText(''); setDialog('restore'); }}>Restaurar copia</button>
        </div>
        <p className="muted small">La copia de seguridad es un archivo SQLite con todos tus datos financieros (sin credenciales de Gmail): guárdala en un lugar seguro.</p>
        <hr className="sep" />
        <h3>Datos de demostración</h3>
        <div className="row">
          {info?.hasDemoData ? (
            <button className="btn" disabled={busy} onClick={() => act(() => api('data.removeDemo'), 'Datos de demostración eliminados.')}>Eliminar datos de demostración</button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => act(() => api('data.loadDemo'), 'Datos de demostración cargados (ficticios).')}>Cargar 12 meses de datos ficticios</button>
          )}
        </div>
        <hr className="sep" />
        <h3>Borrar los datos cargados</h3>
        <p className="muted small">Borra todos los movimientos, extractos y documentos importados (también de Gmail) para empezar de cero o volver a cargarlos. Se conservan tu configuración, categorías y reglas, ingresos, objetivos, metas, patrimonio y la conexión con Gmail.</p>
        <div>
          <button className="btn" disabled={busy || !info?.transactionsCount && !info?.documentsCount} onClick={() => { setConfirmText(''); setDialog('clear'); }}>Borrar datos cargados…</button>
        </div>
        <hr className="sep" />
        <h3>Eliminar todos mis datos</h3>
        <Callout tone="danger">Borra movimientos, documentos conservados, estadísticas, reglas, ingresos, objetivos, configuración y credenciales de Gmail (revocando el acceso). No se puede deshacer.</Callout>
        <div>
          <button className="btn danger" onClick={() => { setConfirmText(''); setDialog('delete'); }}>Eliminar todos mis datos…</button>
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        title={dialog === 'restore' ? 'Restaurar copia de seguridad' : dialog === 'clear' ? 'Borrar los datos cargados' : 'Eliminar todos mis datos'}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDialog(null)}>Cancelar</button>
            <button
              className={`btn ${dialog === 'restore' ? 'primary' : 'danger solid'}`}
              disabled={confirmText !== required || busy}
              onClick={async () => {
                const r = await act(() => api(dialog === 'restore' ? 'data.restore' : dialog === 'clear' ? 'data.clearImported' : 'data.deleteAll', { confirmation: confirmText }), 'Hecho.');
                setDialog(null);
                if (r && (r as { ok?: boolean }).ok && dialog === 'delete') window.location.reload();
              }}
            >
              {dialog === 'restore' ? 'Elegir archivo y restaurar' : dialog === 'clear' ? 'Borrar datos cargados' : 'Eliminar definitivamente'}
            </button>
          </>
        }
      >
        {dialog === 'restore' ? (
          <p>Se sustituirán tus datos actuales por los de la copia. Antes se guardará un respaldo automático de la base de datos actual en la carpeta de datos. Se comprobará que la copia es de Hormiga y compatible con esta versión.</p>
        ) : dialog === 'clear' ? (
          <p>Se borrarán todos los movimientos, extractos y documentos importados, y las estadísticas calculadas con ellos. Se conservan configuración, categorías y reglas, ingresos, objetivos, metas, patrimonio y la conexión con Gmail, así que podrás volver a cargarlos.</p>
        ) : (
          <p>Esta acción elimina de forma permanente toda la información de Hormiga en este equipo y desconecta Gmail.</p>
        )}
        <Field label={`Escribe ${required} para confirmar`} htmlFor="confirm-text">
          <input id="confirm-text" className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </Field>
      </Dialog>
    </Card>
  );
}
