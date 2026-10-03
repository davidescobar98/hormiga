import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, DataVersionContext, useQuery } from './api';
import { Icon, Loading, ToastProvider, ErrorBox, useToast } from './components/ui';
import { DashboardPage } from './pages/DashboardPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { RecurringPage } from './pages/RecurringPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SavingsPage } from './pages/SavingsPage';
import { ImportPage } from './pages/ImportPage';
import { SettingsPage } from './pages/SettingsPage';
import { GoalsPage } from './pages/GoalsPage';
import { WealthPage } from './pages/WealthPage';
import { AccountsPage } from './pages/AccountsPage';
import { StocksPage } from './pages/StocksPage';
import { ForecastPage } from './pages/ForecastPage';
import { HelpPage } from './pages/HelpPage';
import { Assistant, CommandPalette } from './components/Assistant';
import { ProfileGate, ProfileSwitcher } from './components/Profiles';
import { OnboardingPage } from './pages/OnboardingPage';
import { PendingPasswordPrompt } from './components/PasswordPrompt';
import { WhatsNew } from './components/WhatsNew';
import { UpdateBanner } from './components/UpdateBanner';
import { LockScreen } from './components/LockScreen';
import type { LockStatus } from '../../shared/types';
import type { Theme } from '../../shared/types';

export type PageId = 'dashboard' | 'transactions' | 'accounts' | 'categories' | 'recurring' | 'analytics' | 'savings' | 'goals' | 'wealth' | 'stocks' | 'import' | 'settings' | 'forecast' | 'help';

export interface NavParams {
  categoryId?: number;
  uncategorizedOnly?: boolean;
  merchantId?: number;
  from?: string;
  to?: string;
  documentId?: number;
  accountId?: number;
  section?: string;
}

const NavContext = createContext<(page: PageId, params?: NavParams) => void>(() => {});
export const useNavigate = () => useContext(NavContext);

/** Navigation grouped by what you want to do (a short, calm sidebar). */
const NAV_GROUPS: { label: string | null; items: { id: PageId; label: string; icon: string }[] }[] = [
  {
    label: null,
    items: [
      { id: 'dashboard', label: 'Resumen', icon: 'home' },
      { id: 'forecast', label: 'Previsión', icon: 'sparkle' },
      { id: 'transactions', label: 'Movimientos', icon: 'list' },
      { id: 'accounts', label: 'Cuentas', icon: 'wallet' },
    ],
  },
  {
    label: 'Ahorrar',
    items: [
      { id: 'savings', label: 'Ahorro', icon: 'piggy' },
      { id: 'goals', label: 'Metas', icon: 'target' },
      { id: 'recurring', label: 'Recurrentes', icon: 'repeat' },
    ],
  },
  {
    label: 'Invertir',
    items: [
      { id: 'wealth', label: 'Patrimonio', icon: 'briefcase' },
      { id: 'stocks', label: 'Bolsa', icon: 'trend' },
    ],
  },
  {
    label: 'Más',
    items: [
      { id: 'analytics', label: 'Análisis', icon: 'chart' },
      { id: 'categories', label: 'Categorías', icon: 'tag' },
      { id: 'import', label: 'Documentos', icon: 'file' },
      { id: 'settings', label: 'Ajustes', icon: 'settings' },
      { id: 'help', label: 'Ayuda', icon: 'info' },
    ],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function App() {
  const [version, setVersion] = useState(0);
  const invalidate = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => window.hormiga.on('data.changed', () => invalidate()), [invalidate]);
  const ctx = useMemo(() => ({ version, invalidate }), [version, invalidate]);
  return (
    <DataVersionContext.Provider value={ctx}>
      <ToastProvider>
        <ProfileGate>
          <LockGate />
        </ProfileGate>
      </ToastProvider>
    </DataVersionContext.Provider>
  );
}

let lastPlace: { page: PageId; params: NavParams } = { page: 'dashboard', params: {} };

/** Asks the main process whether the app is locked before loading any data. */
function LockGate() {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let alive = true;
    void api('lock.status').then((s) => alive && setStatus(s)).catch(() => alive && setStatus(null));
    const off = window.hormiga.on('lock.changed', (s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!status) return <Loading label="Abriendo Hormiga…" />;
  if (status.locked) return <LockScreen status={status} onUnlocked={(s) => { setStatus(s); setGeneration((g) => g + 1); }} />;
  // Remount after unlocking so every screen reloads its data.
  return <Shell key={generation} lockEnabled={status.enabled} />;
}

function Shell({ lockEnabled }: { lockEnabled: boolean }) {
  const settings = useQuery(() => api('settings.get'), []);
  // Restored after unlocking (the shell remounts to reload every screen).
  const [page, setPage] = useState<PageId>(lastPlace.page);
  const [params, setParams] = useState<NavParams>(lastPlace.params);
  const navigate = useCallback((p: PageId, prm: NavParams = {}) => {
    setPage(p);
    setParams(prm);
    lastPlace = { page: p, params: prm };
    document.querySelector('.main')?.scrollTo({ top: 0 });
    if (prm.section) setTimeout(() => document.getElementById(prm.section!)?.scrollIntoView({ block: 'start' }), 300);
  }, []);
  const toast = useToast();

  useEffect(() => {
    if (settings.data) applyTheme(settings.data.theme);
  }, [settings.data]);

  // Clicking a Windows notification opens the related page.
  useEffect(() => window.hormiga.on('app.navigate', (n) => navigate(n.page as PageId, n.section ? { section: n.section } : {})), [navigate]);

  useEffect(
    () =>
      window.hormiga.on('sync.finished', (s) => {
        if (s.trigger === 'startup' && (s.imported > 0 || s.errors.length > 0 || s.pendingCandidates > 0)) {
          toast({ tone: s.errors.some((e) => !e.subject) ? 'error' : 'info', message: `Sincronización automática: ${s.message}` });
        }
      }),
    [toast],
  );

  if (settings.error && !settings.data) return <div className="page"><ErrorBox error={settings.error} onRetry={settings.reload} /></div>;
  if (!settings.data) return <Loading label="Abriendo Hormiga…" />;
  if (!settings.data.onboardingCompleted) return <><OnboardingPage /><PendingPasswordPrompt /></>;

  return (
    <NavContext.Provider value={navigate}>
      <div className="app">
        <Sidebar page={page} onNavigate={navigate} lockEnabled={lockEnabled} />
        <main className="main" id="main">
          <UpdateBanner />
          {page === 'dashboard' && <DashboardPage />}
          {page === 'transactions' && <TransactionsPage key={JSON.stringify(params)} initial={params} />}
          {page === 'accounts' && <AccountsPage key={params.section ?? ''} initialSection={params.section} />}
          {page === 'categories' && <CategoriesPage />}
          {page === 'recurring' && <RecurringPage />}
          {page === 'analytics' && <AnalyticsPage />}
          {page === 'savings' && <SavingsPage />}
          {page === 'goals' && <GoalsPage />}
          {page === 'wealth' && <WealthPage />}
          {page === 'stocks' && <StocksPage key={params.section ?? ''} initialSection={params.section} />}
          {page === 'forecast' && <ForecastPage key={params.section ?? ''} initialSection={params.section} />}
          {page === 'help' && <HelpPage key={params.section ?? ''} initialSection={params.section} />}
          {page === 'import' && <ImportPage key={JSON.stringify(params)} initial={params} />}
          {page === 'settings' && <SettingsPage key={params.section ?? ''} initialSection={params.section} />}
        </main>
      </div>
      <PendingPasswordPrompt />
      <Assistant />
      <CommandPalette pages={NAV} />
      <WhatsNew lastSeenVersion={settings.data.lastSeenVersion} />
    </NavContext.Provider>
  );
}

function Sidebar({ page, onNavigate, lockEnabled }: { page: PageId; onNavigate: (p: PageId, params?: NavParams) => void; lockEnabled: boolean }) {
  const review = useQuery(() => api('import.reviewSummary'), []);
  const email = useQuery(() => api('email.status'), []);
  const lastSync = email.data?.lastSyncAt ? new Date(email.data.lastSyncAt) : null;
  return (
    <nav className="sidebar" aria-label="Navegación principal">
      <div className="brand">
        <div className="brand-mark" aria-hidden>H</div>
        <div>
          <div className="brand-name">Hormiga</div>
          <div className="brand-tagline">cada céntimo cuenta</div>
        </div>
      </div>
      <ProfileSwitcher onManage={() => onNavigate('settings', { section: 'profiles' })} />
      {NAV_GROUPS.map((g) => (
        <div key={g.label ?? 'main'} role="group" aria-label={g.label ?? 'Principal'}>
          {g.label && <div className="nav-group" aria-hidden>{g.label}</div>}
          {g.items.map((n) => (
            <button key={n.id} className="nav-item" aria-current={page === n.id ? 'page' : undefined} onClick={() => onNavigate(n.id)}>
              <Icon name={n.icon} />
              {n.label}
              {n.id === 'import' && (review.data?.documents ?? 0) > 0 && (
                <span className="nav-badge" title="Documentos pendientes de revisión">{review.data!.documents}</span>
              )}
              {n.id === 'settings' && (email.data?.state === 'reauth_required' || (email.data?.message && email.data.state !== 'connected')) && (
                <span className="nav-badge" title="Gmail necesita que vuelvas a conectarlo">!</span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="sidebar-footer">
        {lockEnabled && <button className="btn sm ghost" onClick={() => void api('lock.lockNow')}><Icon name="lock" size={15} /> Bloquear</button>}
        <div className="privacy-note">
          <Icon name="lock" size={15} />
          <span>Tus datos se guardan solo en este equipo.</span>
        </div>
        <div className="privacy-note">
          <Icon name="mail" size={15} />
          <span>
            {email.data?.state === 'connected'
              ? lastSync
                ? `Gmail · sincronizado ${lastSync.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`
                : 'Gmail conectado'
              : email.data?.state === 'reauth_required'
                ? 'Gmail: vuelve a conectar'
                : 'Gmail no conectado'}
          </span>
        </div>
      </div>
    </nav>
  );
}
