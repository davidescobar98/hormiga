import type { SyncProgressEvent } from '../shared/types';
import type { Database } from './db/database';
import { GmailAuth, type OAuthClientConfig } from './email/gmailAuth';
import { GMAIL_BASE, GmailEmailProvider } from './email/gmailProvider';
import type { EmailProvider, SecretVault } from './email/types';
import { AnalyticsService } from './services/analyticsService';
import { CategorizationService } from './services/categorizationService';
import { createRepos, type DocumentStore, type Logger, type Repos } from './services/context';
import { DataService } from './services/dataService';
import { ImportService } from './services/importService';
import { RecurringService } from './services/recurringService';
import { SyncService } from './services/syncService';
import { WealthService } from './services/wealthService';
import { AccountsService } from './services/accountsService';
import { BudgetsService } from './services/budgetsService';
import { YahooMarketProvider, type MarketProvider } from './market/yahoo';

export interface CoreDeps {
  db: Database;
  now: () => Date;
  log: Logger;
  vault: SecretVault;
  documentStore: DocumentStore;
  openExternal: (url: string) => Promise<void>;
  envOAuthClient: OAuthClientConfig | null;
  emitSyncProgress?: (e: SyncProgressEvent) => void;
  onDataChanged?: (reason: string) => void;
  /** Tests inject a fake provider instead of the real Gmail API. */
  providerFactory?: () => Promise<EmailProvider>;
  /** Public market data for past returns (tests inject a fake). */
  marketProvider?: MarketProvider | null;
}

export interface Core {
  repos: Repos;
  categorization: CategorizationService;
  recurring: RecurringService;
  importer: ImportService;
  analytics: AnalyticsService;
  sync: SyncService;
  data: DataService;
  gmailAuth: GmailAuth;
  wealth: WealthService;
  accounts: AccountsService;
  budgets: BudgetsService;
}

/** Composition root of the application layer (no Electron dependencies: fully testable in Node). */
export function createCore(deps: CoreDeps): Core {
  const repos = createRepos(deps.db, deps.now);
  repos.categories.ensureSystemCategories();
  const changed = (reason: string) => deps.onDataChanged?.(reason);

  const categorization = new CategorizationService(repos, () => changed('categorization'));
  const recurring = new RecurringService(repos, deps.now, () => changed('recurring'));
  const importer = new ImportService(repos, categorization, deps.documentStore, deps.log, () => {
    recurring.detect();
    changed('import');
  });
  const accounts = new AccountsService(repos, categorization, deps.now);
  importer.accounts = accounts;
  const analytics = new AnalyticsService(repos, deps.now);
  const gmailAuth = new GmailAuth(deps.vault, deps.openExternal, deps.log, deps.envOAuthClient);
  const providerFactory =
    deps.providerFactory ??
    (async () => {
      const client = await gmailAuth.getClient();
      return new GmailEmailProvider({
        get: async <T>(path: string, params?: Record<string, string | number | undefined>) => {
          const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined));
          const res = await client.request<T>({ url: `${GMAIL_BASE}${path}`, method: 'GET', params: clean, timeout: 30000, retry: true });
          return res.data;
        },
      });
    });
  const sync = new SyncService(repos, gmailAuth, providerFactory, importer, deps.log, deps.now, deps.emitSyncProgress);
  const data = new DataService(repos, importer, deps.now);
  data.accounts = accounts;
  const market = deps.marketProvider === undefined ? new YahooMarketProvider() : deps.marketProvider;
  const wealth = new WealthService(repos.pots, repos.assets, analytics, deps.now, market, () => repos.settings.getSettings().marketDataEnabled);
  wealth.accounts = accounts;
  wealth.profile = () => repos.settings.getSettings().profile;
  analytics.emergencyInfo = () => wealth.emergency(wealth.potDTOs());
  analytics.moreContext = () => {
    const pots = wealth.potDTOs();
    const e = wealth.emergency(pots);
    const list = accounts.list().filter((a) => a.includeInNetWorth && a.balanceCents !== null && a.sourceKind !== 'card');
    const sum = (kinds: string[]) => (list.length ? list.filter((a) => kinds.includes(a.kind)).reduce((t, a) => t + a.balanceCents!, 0) : null);
    return {
      profile: repos.settings.getSettings().profile,
      essentialMonthlyCents: e.essentialMonthlyCents,
      recommendedEmergencyMonths: e.recommendedMonths,
      recommendedEmergencyReason: e.recommendedReason,
      emergencyPotCents: e.savedCents,
      currentAccountsCents: sum(['current', 'other']),
      savingsAccountsCents: sum(['savings']),
      pots,
      loans: wealth.loanSummaries(),
      pendingTransferReviews: accounts.counterparties().filter((c) => c.needsReview).length,
    };
  };
  const budgets = new BudgetsService(repos, analytics, deps.now);
  budgets.pendingTransferReviews = () => accounts.counterparties().filter((c) => c.needsReview).length;
  return { repos, categorization, recurring, importer, analytics, sync, data, gmailAuth, wealth, accounts, budgets };
}
