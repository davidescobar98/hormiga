import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import type { ImportOutcome, ScanResult, SyncSummary } from '../../../shared/types';
import { Callout, Icon, useToast } from '../components/ui';
import { CandidatesReview, EmailConnectPanel, GoalEditor, ImportButton, ImportOutcomeList, IncomeEditor } from '../components/flows';

const STEPS = ['welcome', 'privacy', 'gmail', 'income', 'goal', 'history', 'review'] as const;
type Step = (typeof STEPS)[number];

export function OnboardingPage() {
  const [step, setStep] = useState<Step>('welcome');
  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(idx - 1, 0)]!);
  const invalidate = useInvalidate();
  const toast = useToast();
  const email = useQuery(() => api('email.status'), []);
  const info = useQuery(() => api('app.info'), []);
  const txCount = useQuery(() => api('data.info'), [step]);
  const uncategorized = useQuery(() => api('transactions.list', { uncategorizedOnly: true, limit: 1 }), [step]);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [sync, setSync] = useState<SyncSummary | null>(null);

  const finish = async () => {
    await api('app.completeOnboarding');
    invalidate();
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-steps" aria-label={`Paso ${idx + 1} de ${STEPS.length}`}>
          {STEPS.map((s, i) => <span key={s} className={i <= idx ? 'done' : ''} />)}
        </div>
        <div className="onboarding-body">
          {step === 'welcome' && (
            <>
              <h1>Bienvenido a Hormiga</h1>
              <p>Hormiga convierte los extractos que tus bancos te envían por email (o los que descargas) en un histórico claro de tus gastos: en qué gastas, cómo evoluciona, cuánto ahorras y dónde podrías ajustar.</p>
              <ul className="feature-list">
                <li><Icon name="mail" /> Busca tus extractos en Gmail (solo lectura) o impórtalos a mano.</li>
                <li><Icon name="tag" /> Clasifica los movimientos con reglas explicables que aprenden de tus correcciones.</li>
                <li><Icon name="piggy" /> Calcula tu ahorro real y tu capacidad de ahorro, con la fórmula a la vista.</li>
              </ul>
            </>
          )}
          {step === 'privacy' && (
            <>
              <h1>Tus datos se quedan en tu equipo</h1>
              <ul className="feature-list">
                <li><Icon name="lock" /> Movimientos, documentos y estadísticas se guardan en una base de datos local{info.data ? <>: <span className="mono small">{info.data.dataDir}</span></> : ''}.</li>
                <li><Icon name="check" /> No se envía nada a servidores externos. La única conexión es con Gmail, con permiso de solo lectura.</li>
                <li><Icon name="check" /> No se usa inteligencia artificial externa: las categorías y recomendaciones son reglas deterministas.</li>
                <li><Icon name="check" /> Nunca te pediremos las claves de tu banca online. Hormiga no accede a la web de ningún banco.</li>
                <li><Icon name="check" /> Por defecto no se conservan los PDF originales; puedes activarlo en Ajustes.</li>
              </ul>
            </>
          )}
          {step === 'gmail' && (
            <>
              <h1>Conectar Gmail</h1>
              <p className="muted">Opcional. Hormiga buscará los emails de tus bancos con extractos adjuntos cada vez que abras la aplicación.</p>
              <EmailConnectPanel status={email.data} onChanged={() => email.reload()} />
            </>
          )}
          {step === 'income' && (
            <>
              <h1>Tus ingresos</h1>
              <p className="muted">Los extractos de tarjeta no incluyen tu nómina. Indica tu salario neto mensual para calcular tu ahorro. Puedes añadir más ingresos después.</p>
              <IncomeEditor simple />
            </>
          )}
          {step === 'goal' && (
            <>
              <h1>Objetivo de ahorro</h1>
              <p className="muted">¿Cuánto te gustaría ahorrar cada mes? Te mostraremos si estás por encima, dentro o por debajo.</p>
              <GoalEditor compact />
            </>
          )}
          {step === 'history' && (
            <>
              <h1>Importar tu histórico</h1>
              {email.data?.state === 'connected' ? (
                <div className="stack">
                  <p className="muted">Busca en Gmail los extractos de tus bancos de los últimos meses y elige cuáles importar.</p>
                  {!scan && (
                    <div>
                      <button className="btn primary" disabled={scanning} onClick={async () => {
                        setScanning(true);
                        try {
                          setScan(await api('email.scan'));
                        } catch (err) {
                          toast({ tone: 'error', message: toApiError(err).message });
                        } finally {
                          setScanning(false);
                        }
                      }}>
                        {scanning ? <span className="spinner" aria-hidden /> : <Icon name="search" />} Buscar extractos en Gmail
                      </button>
                    </div>
                  )}
                  {scan && <CandidatesReview candidates={scan.candidates} onImported={(s) => { setSync(s); setScan(null); invalidate(); }} />}
                  {sync && <Callout tone="info">{sync.message}</Callout>}
                </div>
              ) : (
                <p className="muted">Importa tus movimientos: PDF de BBVA, Excel de CaixaBank, imagin, Sabadell, Santander, ING… o Norma 43. Puedes seleccionar varios a la vez.</p>
              )}
              <div className="row">
                <ImportButton primary={email.data?.state !== 'connected'} onDone={(o) => setOutcomes(o)} label="Importar documentos" />
                {!txCount.data?.transactionsCount && (
                  <button className="btn ghost" onClick={async () => { await api('data.loadDemo'); invalidate(); txCount.reload(); toast({ tone: 'info', message: 'Datos ficticios cargados. Podrás eliminarlos en Ajustes.' }); }}>
                    Probar con datos de demostración
                  </button>
                )}
              </div>
              <ImportOutcomeList outcomes={outcomes} />
              {txCount.data && <p className="muted small">{txCount.data.transactionsCount} movimientos en tu base de datos.</p>}
            </>
          )}
          {step === 'review' && (
            <>
              <h1>Todo listo</h1>
              {(uncategorized.data?.total ?? 0) > 0 ? (
                <Callout tone="info">Hay {uncategorized.data!.total} movimientos sin clasificar. En «Movimientos» puedes asignarles categoría; Hormiga te ofrecerá crear una regla para los siguientes.</Callout>
              ) : (
                <Callout tone="success">No hay movimientos pendientes de clasificar.</Callout>
              )}
              <p className="muted">Puedes cambiar cualquier ajuste más adelante desde «Ajustes».</p>
            </>
          )}
        </div>
        <div className="onboarding-foot">
          <button className="btn ghost" onClick={back} disabled={idx === 0}>Atrás</button>
          <div className="row">
            {step === 'gmail' && email.data?.state !== 'connected' && <button className="btn" onClick={next}>Continuar con importación manual</button>}
            {(step === 'income' || step === 'goal' || step === 'history') && <button className="btn ghost" onClick={next}>Omitir</button>}
            {step === 'review' ? (
              <button className="btn primary" onClick={finish}>Ir al resumen</button>
            ) : (
              (step !== 'gmail' || email.data?.state === 'connected') && <button className="btn primary" onClick={next}>Continuar</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
