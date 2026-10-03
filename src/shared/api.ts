import type {
  AnalyticsRange, AnalyticsReport, AppInfo, AppSettings, SettingsPatch, Category, CategoryKind, CategoryWithStats, CreateRuleInput,
  CreateRuleResult, Dashboard, DataInfo, DocumentDTO, EmailStatus, FileActionResult, ImportOutcome, IncomeDTO,
  IncomeInput, Recommendation, RecurringDTO, RecurringStatus, ReviewDocument, ReviewItem, RuleDTO, SavingsGoalDTO,
  SavingsOverview, ScanResult, SyncProgressEvent, SyncSummary, TransactionDetail, TransactionPage, TransactionQuery,
  UpdateReviewItemInput, UpdateTransactionInput, UpdateTransactionResult, PotsOverview, PotInput, PotDTO, PotMovementDTO,
  WealthOverview, AssetInput, AssetDTO, ValuationDTO, ValuationInput, LoanScheduleRow, EarlyRepaymentDTO, MarketQuoteDTO, MarketReturnsDTO, UpdateStatus,
  AccountDTO, AccountUpdate, ManualAccountInput, CounterpartySummary, CounterpartyDecisionInput,
  BudgetsOverview, AlertDTO, LockStatus, LockConfigInput, ExtraordinaryMovement,
  StocksOverview, StocksRefreshResult, StockTradeInput, ForecastOverview, AssistantAnswer, AuditReport, ProfilesState,
} from './types';
import type { YearMonth } from './dates';

type Void = void | undefined;

/**
 * Complete contract between renderer and main. Every entry is one IPC channel.
 * Inputs are validated in main with zod (see src/main/ipcSchemas.ts).
 */
export interface ApiMap {
  'app.info': { input: Void; output: AppInfo };
  'app.updateStatus': { input: Void; output: UpdateStatus };
  'app.checkUpdates': { input: Void; output: UpdateStatus };
  'app.installUpdate': { input: Void; output: { ok: boolean } };
  'app.completeOnboarding': { input: Void; output: AppSettings };

  'profiles.list': { input: Void; output: ProfilesState };
  'profiles.create': { input: { name: string; color: string; photo: string | null }; output: ProfilesState };
  'profiles.update': { input: { id: string; name?: string; color?: string; photo?: string | null }; output: ProfilesState };
  'profiles.switch': { input: { id: string }; output: ProfilesState };
  'profiles.setAskOnStart': { input: { value: boolean }; output: ProfilesState };
  'profiles.delete': { input: { id: string }; output: ProfilesState };

  'settings.get': { input: Void; output: AppSettings };
  'settings.update': { input: SettingsPatch; output: AppSettings };

  'categories.list': { input: { from?: string; to?: string } | Void; output: CategoryWithStats[] };
  'categories.create': { input: { name: string; kind: CategoryKind; color: string }; output: Category };
  'categories.update': { input: { id: number; name?: string; kind?: CategoryKind; color?: string }; output: Category };
  'categories.delete': { input: { id: number }; output: { reassigned: number } };

  'transactions.list': { input: TransactionQuery; output: TransactionPage };
  'transactions.get': { input: { id: number }; output: TransactionDetail };
  'transactions.update': { input: UpdateTransactionInput; output: UpdateTransactionResult };

  'rules.list': { input: Void; output: RuleDTO[] };
  'rules.create': { input: CreateRuleInput; output: CreateRuleResult };
  'rules.delete': { input: { id: number }; output: { deleted: boolean } };

  'merchants.rename': { input: { merchantId: number; name: string }; output: { merchantId: number; merged: boolean } };

  'recurring.list': { input: Void; output: RecurringDTO[] };
  'recurring.setStatus': { input: { id: number; status: RecurringStatus }; output: RecurringDTO };
  'recurring.redetect': { input: Void; output: RecurringDTO[] };

  'income.list': { input: Void; output: IncomeDTO[] };
  'income.save': { input: IncomeInput; output: IncomeDTO };
  'income.delete': { input: { id: number }; output: { deleted: boolean } };

  'goal.get': { input: Void; output: SavingsGoalDTO | null };
  'goal.set': { input: SavingsGoalDTO | null; output: SavingsGoalDTO | null };

  'analytics.dashboard': { input: { month?: YearMonth } | Void; output: Dashboard };
  'analytics.report': { input: AnalyticsRange; output: AnalyticsReport };
  'analytics.savings': { input: { month?: YearMonth } | Void; output: SavingsOverview };

  'recommendations.list': { input: Void; output: Recommendation[] };
  'recommendations.dismiss': { input: { key: string }; output: { dismissed: boolean } };

  'import.pickAndImport': { input: Void; output: ImportOutcome[] };
  'import.withPassword': { input: { token: string; password: string; remember?: boolean }; output: ImportOutcome };
  'import.forgetPasswords': { input: Void; output: { forgotten: boolean } };
  'import.documents': { input: Void; output: DocumentDTO[] };
  'import.review': { input: { documentId: number }; output: ReviewDocument };
  'import.reviewSummary': { input: Void; output: { documents: number; items: number } };
  'import.updateReviewItem': { input: UpdateReviewItemInput; output: ReviewItem };
  'import.confirmReview': { input: { documentId: number }; output: { inserted: number; duplicatesSkipped: number } };
  'import.discardDocument': { input: { documentId: number }; output: { removedTransactions: number } };
  'import.openDocument': { input: { documentId: number }; output: FileActionResult };
  'import.deleteRetainedDocuments': { input: Void; output: { deleted: number } };

  'email.status': { input: Void; output: EmailStatus };
  'email.saveClientConfig': { input: { clientId: string; clientSecret: string }; output: EmailStatus };
  'email.clearClientConfig': { input: Void; output: EmailStatus };
  'email.connect': { input: { send?: boolean } | Void; output: EmailStatus };
  'email.disconnect': { input: Void; output: EmailStatus };
  'email.scan': { input: { lookbackMonths?: number } | Void; output: ScanResult };
  'email.importSelected': { input: { messageIds: string[] }; output: SyncSummary };
  'email.syncNow': { input: Void; output: SyncSummary };
  'email.retryPassword': { input: { messageId: string; password: string }; output: ImportOutcome[] };
  'email.pendingPasswords': { input: Void; output: { messageId: string; subject: string | null }[] };
  'email.unlockPending': { input: { password: string; remember: boolean }; output: { unlocked: number; remaining: number; newTransactions: number; message: string } };

  'data.info': { input: Void; output: DataInfo };
  'data.exportTransactions': { input: { format: 'csv' | 'json' }; output: FileActionResult };
  'data.backup': { input: Void; output: FileActionResult };
  'data.restore': { input: { confirmation: string }; output: FileActionResult };
  'data.deleteAll': { input: { confirmation: string }; output: FileActionResult };
  'data.loadDemo': { input: Void; output: { transactions: number } };
  'data.removeDemo': { input: Void; output: { removed: number } };
  'data.clearImported': { input: { confirmation: string }; output: FileActionResult };
  'data.openDataDir': { input: Void; output: FileActionResult };

  'pots.overview': { input: Void; output: PotsOverview };
  'pots.save': { input: PotInput; output: PotDTO };
  'pots.delete': { input: { id: number }; output: { deleted: boolean } };
  'pots.movements': { input: { potId: number }; output: PotMovementDTO[] };
  'pots.addMovement': { input: { potId: number; date: string; amountCents: number; note: string | null }; output: PotDTO };
  'pots.deleteMovement': { input: { id: number }; output: { deleted: boolean } };

  'wealth.overview': { input: Void; output: WealthOverview };
  'accounts.list': { input: Void; output: AccountDTO[] };
  'budgets.overview': { input: { month?: YearMonth } | Void; output: BudgetsOverview };
  'budgets.set': { input: { categoryId: number; amountCents: number | null }; output: BudgetsOverview };
  'alerts.list': { input: Void; output: AlertDTO[] };
  'alerts.markRead': { input: { key?: string } | Void; output: { ok: boolean } };
  'lock.status': { input: Void; output: LockStatus };
  'lock.unlockPin': { input: { pin: string }; output: LockStatus };
  'lock.unlockHello': { input: Void; output: LockStatus };
  'lock.lockNow': { input: Void; output: { ok: boolean } };
  'lock.configure': { input: LockConfigInput; output: LockStatus };
  'accounts.update': { input: AccountUpdate; output: AccountDTO[] };
  'accounts.setBalance': { input: { id: number; balanceCents: number; date: string }; output: AccountDTO[] };
  'accounts.createManual': { input: ManualAccountInput; output: AccountDTO[] };
  'accounts.merge': { input: { fromId: number; intoId: number }; output: AccountDTO[] };
  'accounts.deleteManual': { input: { id: number }; output: AccountDTO[] };
  'accounts.counterparties': { input: Void; output: CounterpartySummary[] };
  'accounts.extraordinary': { input: Void; output: ExtraordinaryMovement[] };
  'accounts.resolveExtraordinary': { input: { id: number; asCapital: boolean }; output: ExtraordinaryMovement[] };
  'accounts.decideCounterparty': { input: CounterpartyDecisionInput; output: { changed: number } };
  'wealth.saveAsset': { input: AssetInput; output: AssetDTO };
  'wealth.deleteAsset': { input: { id: number }; output: { deleted: boolean } };
  'wealth.valuations': { input: { assetId: number }; output: ValuationDTO[] };
  'wealth.saveValuation': { input: ValuationInput; output: AssetDTO };
  'wealth.deleteValuation': { input: { id: number }; output: { deleted: boolean } };
  'wealth.loanSchedule': { input: { assetId: number }; output: LoanScheduleRow[] };
  'wealth.earlyRepayment': { input: { assetId: number; date: string; amountCents: number; strategy: 'reduce_term' | 'reduce_payment' }; output: EarlyRepaymentDTO };
  'market.search': { input: { query: string }; output: MarketQuoteDTO[] };
  'market.returns': { input: { symbol: string }; output: MarketReturnsDTO };

  'forecast.overview': { input: Void; output: ForecastOverview };
  'budgets.setMany': { input: { items: { categoryId: number; amountCents: number }[] }; output: BudgetsOverview };
  'assistant.ask': { input: { question: string }; output: AssistantAnswer };
  'notify.testEmail': { input: Void; output: { ok: boolean } };
  'data.audit': { input: Void; output: AuditReport };

  'stocks.overview': { input: Void; output: StocksOverview };
  'stocks.refresh': { input: { force?: boolean } | Void; output: StocksRefreshResult };
  'stocks.addWatch': { input: { symbol: string }; output: StocksOverview };
  'stocks.removeWatch': { input: { symbol: string }; output: StocksOverview };
  'stocks.setTarget': { input: { symbol: string; targetPrice: number | null }; output: StocksOverview };
  'stocks.addTrade': { input: StockTradeInput; output: StocksOverview };
  'stocks.deleteTrade': { input: { id: number }; output: StocksOverview };

  'shell.openHelp': { input: { topic: HelpTopic }; output: { opened: boolean } };
}

export type HelpTopic = 'google-cloud-console' | 'gmail-api' | 'oauth-consent';

export type Channel = keyof ApiMap;
export type InputOf<C extends Channel> = ApiMap[C]['input'];
export type OutputOf<C extends Channel> = ApiMap[C]['output'];

export interface EventMap {
  'sync.progress': SyncProgressEvent;
  'sync.finished': SyncSummary;
  'data.changed': { reason: string };
  'update.status': UpdateStatus;
  'lock.changed': LockStatus;
  /** Open a page (clicking a notification). */
  'app.navigate': { page: string; section: string | null };
}
export type EventName = keyof EventMap;

export interface HormigaBridge {
  invoke<C extends Channel>(channel: C, ...args: InputOf<C> extends Void ? [input?: InputOf<C>] : [input: InputOf<C>]): Promise<OutputOf<C>>;
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void;
}
