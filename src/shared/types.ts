import type { Cents } from './money';
import type { IsoDate, YearMonth } from './dates';

// ───────────────────────── Domain enums ─────────────────────────

export const TRANSACTION_TYPES = ['expense', 'income', 'refund', 'transfer', 'cash_withdrawal', 'fee', 'unknown'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  expense: 'Gasto',
  income: 'Ingreso',
  refund: 'Devolución',
  transfer: 'Entre mis cuentas',
  cash_withdrawal: 'Retirada de efectivo',
  fee: 'Comisión',
  unknown: 'Desconocido',
};

/** Types that count as spending (money out). Refunds reduce spending; transfers/income/unknown do not count. */
export const SPENDING_TYPES: readonly TransactionType[] = ['expense', 'fee', 'cash_withdrawal'];

export const CLASSIFICATION_SOURCES = ['USER', 'RULE', 'MERCHANT', 'HEURISTIC', 'UNKNOWN'] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const CLASSIFICATION_SOURCE_LABELS: Record<ClassificationSource, string> = {
  USER: 'Tú',
  RULE: 'Regla por palabra clave',
  MERCHANT: 'Comercio conocido',
  HEURISTIC: 'Heurística por tipo',
  UNKNOWN: 'Sin clasificar',
};

export const CATEGORY_KINDS = ['essential', 'discretionary', 'neutral'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  essential: 'Esencial',
  discretionary: 'Discrecional',
  neutral: 'Neutral',
};

export type RecurringStatus = 'probable' | 'confirmed' | 'dismissed';
export const RECURRING_STATUS_LABELS: Record<RecurringStatus, string> = {
  probable: 'Probablemente recurrente',
  confirmed: 'Confirmado recurrente',
  dismissed: 'No recurrente',
};
export type RecurringFrequency = 'weekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'annual';
export const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  weekly: 'Semanal',
  monthly: 'Mensual',
  bimonthly: 'Bimestral',
  quarterly: 'Trimestral',
  annual: 'Anual',
};

export type DocumentSource = 'manual' | 'email' | 'demo';
export type DocumentStatus = 'imported' | 'needs_review' | 'discarded';
export type IncomeMode = 'auto' | 'manual' | 'documents' | 'combined';
export type IncomeKind = 'salary' | 'recurring' | 'extraordinary';
export type Theme = 'system' | 'light' | 'dark';

// ───────────────────────── Entities / DTOs ─────────────────────────

export interface Category {
  id: number;
  name: string;
  kind: CategoryKind;
  color: string;
  isSystem: boolean;
  /** System categories whose movements never count as spending (Transferencias, Ingresos). */
  excludedFromSpending: boolean;
}

export interface CategoryWithStats extends Category {
  spentCents: Cents;
  txCount: number;
  ruleCount: number;
}

export interface TransactionDTO {
  id: number;
  documentId: number | null;
  date: IsoDate;
  bookingDate: IsoDate | null;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchantId: number | null;
  merchantName: string | null;
  merchantRaw: string | null;
  amountCents: Cents;
  currency: string;
  type: TransactionType;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  classificationSource: ClassificationSource;
  classificationConfidence: number;
  classificationDetail: string | null;
  categoryLocked: boolean;
  isExcluded: boolean;
  notes: string | null;
  recurringStatus: RecurringStatus | null;
  source: DocumentSource | null;
  accountId: number | null;
  accountName: string | null;
  /** Set when the movement is one leg of a transfer between two of the user's accounts. */
  transferMatchId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionDetail extends TransactionDTO {
  document: {
    id: number;
    fileName: string;
    source: DocumentSource;
    importedAt: string;
    parserId: string | null;
    periodStart: IsoDate | null;
    periodEnd: IsoDate | null;
    emailSubject: string | null;
  } | null;
  rule: { id: number; matchType: RuleMatchType; pattern: string } | null;
}

export type TransactionSort = 'date' | 'amount' | 'merchant' | 'category';

export interface TransactionQuery {
  search?: string;
  categoryId?: number;
  type?: TransactionType;
  from?: IsoDate;
  to?: IsoDate;
  merchantId?: number;
  accountId?: number;
  includeExcluded?: boolean;
  onlyExcluded?: boolean;
  uncategorizedOnly?: boolean;
  sort?: TransactionSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface TransactionPage {
  items: TransactionDTO[];
  total: number;
  netCents: Cents;
}

export interface UpdateTransactionInput {
  id: number;
  categoryId?: number;
  merchantName?: string;
  type?: TransactionType;
  isExcluded?: boolean;
  notes?: string | null;
}

export interface RuleSuggestion {
  merchantId: number;
  merchantName: string;
  categoryId: number;
  categoryName: string;
  /** Other movements of the same merchant that would change category. */
  affectedCount: number;
}

export interface UpdateTransactionResult {
  transaction: TransactionDetail;
  ruleSuggestion: RuleSuggestion | null;
}

export type RuleMatchType = 'merchant' | 'contains';

export interface RuleDTO {
  id: number;
  matchType: RuleMatchType;
  pattern: string;
  displayPattern: string;
  categoryId: number;
  categoryName: string;
  createdAt: string;
  matchCount: number;
}

export interface CreateRuleInput {
  matchType: RuleMatchType;
  /** merchant: merchant id as string; contains: text to find in the description. */
  pattern: string;
  categoryId: number;
  applyToExisting: boolean;
}

export interface CreateRuleResult {
  rule: RuleDTO;
  updatedTransactions: number;
}

// ───────────────────────── Import / documents ─────────────────────────

export type ImportStatus = 'imported' | 'needs_review' | 'duplicate' | 'password_required' | 'failed' | 'cancelled';

export interface ImportOutcome {
  status: ImportStatus;
  fileName: string;
  message: string;
  documentId: number | null;
  inserted: number;
  duplicatesSkipped: number;
  reviewCount: number;
  /** Present when status = password_required: pass it back with the password. Valid for 10 minutes. */
  pendingToken: string | null;
  errorCode: ErrorCode | null;
}

export interface DocumentDTO {
  id: number;
  fileName: string;
  source: DocumentSource;
  sha256Short: string;
  importedAt: string;
  status: DocumentStatus;
  parserId: string | null;
  documentKind: string | null;
  bank: string | null;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  txCount: number;
  reviewCount: number;
  retained: boolean;
  warnings: string[];
  emailSubject: string | null;
}

export type ReviewItemStatus = 'pending' | 'accepted' | 'discarded';

export interface ReviewItem {
  id: number;
  documentId: number;
  rowIndex: number;
  rawText: string;
  date: IsoDate | null;
  description: string;
  amountCents: Cents | null;
  type: TransactionType;
  errors: string[];
  status: ReviewItemStatus;
}

export interface ReviewDocument {
  document: DocumentDTO;
  statementIssues: string[];
  items: ReviewItem[];
}

export interface UpdateReviewItemInput {
  id: number;
  date?: IsoDate;
  description?: string;
  amountCents?: Cents;
  type?: TransactionType;
  status?: ReviewItemStatus;
}

// ───────────────────────── Email ─────────────────────────

export type EmailConnectionState = 'not_configured' | 'disconnected' | 'connected' | 'reauth_required';

export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  trigger: 'manual' | 'startup' | 'selection';
  scanned: number;
  detected: number;
  imported: number;
  duplicates: number;
  needsReview: number;
  passwordRequired: number;
  failed: number;
  /** Attachments that turned out not to be statements (bank notices, contracts…): not errors. */
  ignored: number;
  newTransactions: number;
  pendingCandidates: number;
  errors: { code: ErrorCode; message: string; subject?: string }[];
  /** Human readable one-liner. */
  message: string;
}

export interface EmailStatus {
  state: EmailConnectionState;
  provider: 'gmail';
  account: string | null;
  clientConfigured: boolean;
  scope: string;
  lastSyncAt: string | null;
  lastSync: SyncSummary | null;
  lastDocument: { fileName: string; importedAt: string } | null;
  message: string | null;
}

export interface EmailCandidate {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  scoreBp: number;
  classification: 'detected' | 'possible' | 'ignored';
  reasons: string[];
  attachments: { fileName: string; sizeBytes: number }[];
  processedStatus: string | null;
}

export interface ScanResult {
  candidates: EmailCandidate[];
  query: string;
  lookbackMonths: number;
}

export interface SyncProgressEvent {
  phase: 'searching' | 'downloading' | 'processing' | 'done';
  current: number;
  total: number;
  message: string;
}

// ───────────────────────── Settings ─────────────────────────

export interface DetectionConfig {
  senderDomains: string[];
  senderAddresses: string[];
  subjectKeywords: string[];
  filenameKeywords: string[];
  /** Score threshold (0-100) to auto-import a message. Messages between 35 and this are "possible". */
  minScore: number;
}

export interface AppSettings {
  theme: Theme;
  keepDocuments: boolean;
  incomeMode: IncomeMode;
  initialLookbackMonths: number;
  autoSyncOnStart: boolean;
  onboardingCompleted: boolean;
  detection: DetectionConfig;
  /** Allows looking up public past returns (only the searched symbol leaves the computer). Off by default. */
  marketDataEnabled: boolean;
  /** Last app version whose release notes were shown. */
  lastSeenVersion: string | null;
  /** Download and install new versions automatically (installed Windows app only). */
  autoUpdate: boolean;
  /** Optional personal context that tailors suggestions. Stored only on this computer. */
  profile: FinancialProfile;
}

export const HOUSEHOLDS = ['single', 'couple', 'shared_flat', 'family'] as const;
export type Household = (typeof HOUSEHOLDS)[number];
export const HOUSEHOLD_LABELS: Record<Household, string> = { single: 'Vivo solo/a', couple: 'En pareja', shared_flat: 'Piso compartido', family: 'Con mi familia (padres, hijos…)' };

export const HOUSINGS = ['rent', 'mortgage', 'owned', 'family'] as const;
export type Housing = (typeof HOUSINGS)[number];
export const HOUSING_LABELS: Record<Housing, string> = { rent: 'Alquiler', mortgage: 'Vivienda con hipoteca', owned: 'Vivienda propia pagada', family: 'Vivo con familia / sin coste' };

export const INCOME_STABILITIES = ['stable', 'variable', 'self_employed'] as const;
export type IncomeStability = (typeof INCOME_STABILITIES)[number];
export const INCOME_STABILITY_LABELS: Record<IncomeStability, string> = { stable: 'Nómina estable', variable: 'Ingresos variables (comisiones, temporal…)', self_employed: 'Autónomo/a' };

export const LIFE_GOALS = ['emergency', 'home', 'travel', 'debt', 'retirement', 'education', 'family', 'invest'] as const;
export type LifeGoal = (typeof LIFE_GOALS)[number];
export const LIFE_GOAL_LABELS: Record<LifeGoal, string> = {
  emergency: 'Tener un colchón para imprevistos', home: 'Comprar vivienda', travel: 'Viajar', debt: 'Quitarme deudas',
  retirement: 'Jubilación', education: 'Formación / estudios', family: 'Familia / hijos', invest: 'Empezar a invertir',
};

export interface FinancialProfile {
  /** Names as they appear in bank transfers ("ANA GARCIA…"): transfers to/from them are between your own accounts. */
  ownerNames: string[];
  household: Household | null;
  /** Partner's name as it appears in transfers/Bizum: those movements count as shared household spending. */
  partnerName: string | null;
  /** People who depend financially on you (children, relatives). */
  dependents: number;
  housing: Housing | null;
  incomeStability: IncomeStability | null;
  /** Categories you value most: suggestions will not ask you to cut them. */
  priorityCategoryIds: number[];
  goals: LifeGoal[];
}

export interface UpdateStatus {
  state: 'unsupported' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  /** Version being downloaded or ready to install. */
  version: string | null;
  percent: number | null;
  message: string | null;
}

export interface IncomeDTO {
  id: number;
  kind: IncomeKind;
  label: string;
  amountCents: Cents;
  startMonth: YearMonth;
  endMonth: YearMonth | null;
}

export interface IncomeInput {
  id?: number;
  kind: IncomeKind;
  label: string;
  amountCents: Cents;
  startMonth: YearMonth;
  endMonth: YearMonth | null;
}

export interface SavingsGoalDTO {
  mode: 'amount' | 'percent';
  amountCents: Cents | null;
  percentBp: number | null;
  effectiveFrom: YearMonth;
}

// ───────────────────────── Analytics ─────────────────────────

export interface GoalStatus {
  targetCents: Cents;
  differenceCents: Cents;
  status: 'above' | 'on_track' | 'below';
  progressBp: number | null;
  description: string;
}

export interface MonthSummary {
  month: YearMonth;
  incomeCents: Cents;
  incomeSource: string;
  grossExpensesCents: Cents;
  refundsCents: Cents;
  spendingCents: Cents;
  savingsCents: Cents;
  savingsRateBp: number | null;
  fixedCents: Cents;
  variableCents: Cents;
  discretionaryCents: Cents;
  txCount: number;
  hasData: boolean;
  goal: GoalStatus | null;
}

export interface CategoryBreakdown {
  categoryId: number;
  name: string;
  color: string;
  kind: CategoryKind;
  spentCents: Cents;
  shareBp: number | null;
  txCount: number;
}

export interface MerchantBreakdown {
  merchantId: number;
  name: string;
  categoryName: string;
  spentCents: Cents;
  txCount: number;
}

export interface Comparison {
  label: string;
  baseCents: Cents;
  currentCents: Cents;
  deltaCents: Cents;
  deltaBp: number | null;
  monthsUsed: number;
  reliable: boolean;
}

export interface Forecast {
  month: YearMonth;
  dayOfMonth: number;
  daysInMonth: number;
  spentSoFarCents: Cents;
  pendingRecurringCents: Cents;
  projectedVariableCents: Cents;
  projectedSpendingCents: Cents;
  expectedIncomeCents: Cents | null;
  projectedSavingsCents: Cents | null;
  confidence: 'low' | 'medium';
  explanation: string[];
}

export interface RecurringDTO {
  id: number;
  merchantId: number;
  merchantName: string;
  categoryId: number;
  categoryName: string;
  status: RecurringStatus;
  frequency: RecurringFrequency;
  kind: 'subscription' | 'fixed';
  averageCents: Cents;
  lastDate: IsoDate;
  nextDate: IsoDate;
  occurrences: number;
  monthlyCents: Cents;
  annualCents: Cents;
  confidenceBp: number;
  reason: string;
}

export interface RecurringSummary {
  activeCount: number;
  subscriptionCount: number;
  monthlyCents: Cents;
  annualCents: Cents;
  top: RecurringDTO[];
}

export type RecommendationTone = 'opportunity' | 'positive' | 'info';
export type Priority = 'high' | 'medium' | 'low';

export interface Recommendation {
  key: string;
  type: string;
  title: string;
  description: string;
  reason: string;
  evidence: string[];
  estimatedMonthlyImpactCents: Cents | null;
  estimatedAnnualImpactCents: Cents | null;
  priority: Priority;
  category: string | null;
  tone: RecommendationTone;
}

export interface Dashboard {
  hasData: boolean;
  referenceMonth: YearMonth;
  availableMonths: YearMonth[];
  isCurrentCalendarMonth: boolean;
  summary: MonthSummary;
  previous: MonthSummary | null;
  comparisons: Comparison[];
  topCategories: CategoryBreakdown[];
  monthly: MonthSummary[];
  recommendations: Recommendation[];
  recurring: RecurringSummary;
  forecast: Forecast | null;
  /** For the month in progress: savings/goal based on the month-end forecast instead of partial spending. */
  projection: { spendingCents: Cents; savingsCents: Cents | null; savingsRateBp: number | null; goal: GoalStatus | null } | null;
  reviewPending: number;
  uncategorizedCount: number;
  lastDocument: { fileName: string; importedAt: string; source: DocumentSource } | null;
  lastSyncAt: string | null;
  monthsOfData: number;
}

export interface AnalyticsRange {
  from: YearMonth;
  to: YearMonth;
}

export interface Averages {
  months: number;
  spendingCents: Cents;
  incomeCents: Cents;
  savingsCents: Cents;
}

export interface AnalyticsReport {
  range: AnalyticsRange;
  months: MonthSummary[];
  monthsWithData: number;
  totals: { incomeCents: Cents; spendingCents: Cents; savingsCents: Cents; savingsRateBp: number | null; refundsCents: Cents };
  categories: CategoryBreakdown[];
  merchants: MerchantBreakdown[];
  categoryTrends: { categoryId: number; name: string; color: string; series: { month: YearMonth; cents: Cents }[] }[];
  recurringShareBp: number | null;
  fixedCents: Cents;
  variableCents: Cents;
  discretionaryCents: Cents;
  averages: { avg3: Averages | null; avg6: Averages | null; avg12: Averages | null };
  profile: string[];
}

export interface FormulaLine {
  label: string;
  cents: Cents;
  op: '+' | '-' | '=';
  explanation: string;
}

export interface CapacityEstimate {
  provisional: boolean;
  monthsUsed: number;
  expectedIncomeCents: Cents;
  fixedCents: Cents;
  essentialVariableCents: Cents;
  neutralVariableCents: Cents;
  discretionaryCents: Cents;
  capacityCents: Cents;
  lines: FormulaLine[];
  notes: string[];
}

export interface SavingsScenario {
  id: 'actual' | 'moderate' | 'goal';
  label: string;
  monthlySavingsCents: Cents;
  discretionaryReductionBp: number;
  achievable: boolean;
  explanation: string;
}

export interface SavingsOverview {
  month: YearMonth;
  hasData: boolean;
  summary: MonthSummary;
  goal: SavingsGoalDTO | null;
  goalStatus: GoalStatus | null;
  avg3: Averages | null;
  avg6: Averages | null;
  capacity: CapacityEstimate;
  scenarios: SavingsScenario[];
  history: { month: YearMonth; savingsCents: Cents; targetCents: Cents | null; rateBp: number | null }[];
  monthsOfData: number;
  insights: SavingsInsights;
  /** Recommended emergency fund for the user's situation and how much of it the money in accounts covers. */
  emergency: EmergencyInfo;
}

export interface SavingsInsights {
  month: YearMonth;
  /** Where the month's income went. */
  flow: {
    incomeCents: Cents;
    essentialCents: Cents;
    discretionaryCents: Cents;
    peopleCents: Cents;
    otherCents: Cents;
    savingsCents: Cents;
    /** Moved to your other accounts: still yours (liquidity), shown apart from spending. */
    movedToOwnCents: Cents;
  };
  /** Shares of income for the 50/30/20 reference (needs / wants / savings), in basis points. */
  benchmark: { needsBp: number; wantsBp: number; savingsBp: number } | null;
  year: {
    year: number;
    savedCents: Cents;
    months: number;
    avgMonthlyCents: Cents;
    projectedCents: Cents | null;
    monthsWithGoal: number;
    monthsGoalMet: number;
    streak: number;
    best: { month: YearMonth; cents: Cents } | null;
    worst: { month: YearMonth; cents: Cents } | null;
  };
  upcoming: { name: string; date: IsoDate; amountCents: Cents; frequency: RecurringFrequency }[];
  upcomingTotalCents: Cents;
  nonMonthly: { name: string; annualCents: Cents; nextDate: IsoDate; frequency: RecurringFrequency }[];
  /** Monthly amount to put aside so non-monthly payments (annual insurance, quarterly bills…) never catch you out. */
  nonMonthlyReserveCents: Cents;
}

// ───────────────────────── Data management ─────────────────────────

export interface DataInfo {
  dataDir: string;
  dbSizeBytes: number;
  transactionsCount: number;
  documentsCount: number;
  retainedDocumentsCount: number;
  retainedDocumentsBytes: number;
  hasDemoData: boolean;
  schemaVersion: number;
}

export interface FileActionResult {
  ok: boolean;
  cancelled: boolean;
  message: string;
  path: string | null;
}

export interface AppInfo {
  version: string;
  isDev: boolean;
  platform: string;
  dataDir: string;
  logFile: string;
}

// ───────────────────────── Errors ─────────────────────────

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'PDF_INVALID'
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PASSWORD_INCORRECT'
  | 'PDF_NO_TEXT'
  | 'DUPLICATE_DOCUMENT'
  | 'UNKNOWN_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'DB_BUSY'
  | 'BACKUP_INVALID'
  | 'GMAIL_NOT_CONFIGURED'
  | 'GMAIL_NOT_CONNECTED'
  | 'GMAIL_AUTH_EXPIRED'
  | 'GMAIL_PERMISSION'
  | 'GMAIL_OFFLINE'
  | 'GMAIL_RATE_LIMITED'
  | 'GMAIL_ERROR'
  | 'OAUTH_CANCELLED'
  | 'OAUTH_TIMEOUT'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'MARKET_DISABLED'
  | 'MARKET_OFFLINE'
  | 'MARKET_ERROR'
  | 'INTERNAL';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };

// ───────────────────────── Savings pots (metas) ─────────────────────────

export type PotKind = 'goal' | 'emergency';
export type PotStatus = 'done' | 'ahead' | 'on_track' | 'behind' | 'no_date' | 'overdue';

export interface PotDTO {
  id: number;
  name: string;
  kind: PotKind;
  targetCents: Cents;
  targetDate: IsoDate | null;
  color: string;
  savedCents: Cents;
  remainingCents: Cents;
  progressBp: number;
  monthsLeft: number | null;
  /** Monthly amount needed from now on to reach the target on time. */
  requiredMonthlyCents: Cents | null;
  /** Where the pot should be today if saving evenly since it was created. */
  expectedTodayCents: Cents | null;
  status: PotStatus;
  movementsCount: number;
  lastMovementDate: IsoDate | null;
  createdAt: string;
}

export interface PotMovementDTO {
  id: number;
  potId: number;
  date: IsoDate;
  amountCents: Cents;
  note: string | null;
}

export interface PotInput {
  id?: number;
  name: string;
  kind: PotKind;
  targetCents: Cents;
  targetDate: IsoDate | null;
  color: string;
}

export const ACCOUNT_KINDS = ['current', 'savings', 'card', 'investment', 'other'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  current: 'Cuenta corriente', savings: 'Cuenta de ahorro / remunerada', card: 'Tarjeta', investment: 'Cuenta de inversión', other: 'Otra',
};

export interface AccountDTO {
  id: number;
  name: string;
  bank: string;
  kind: AccountKind;
  sourceKind: 'account' | 'card' | 'manual';
  last4: string | null;
  includeInNetWorth: boolean;
  /** Remunerated manual accounts: TAE used to estimate interest. */
  annualRateBp: number | null;
  /** Receives transfers to your own name when the destination account is not imported. */
  ownTransferTarget: boolean;
  /** Balance today: known balance ± movements after/before it. Null until a balance is known. */
  balanceCents: Cents | null;
  anchor: { balanceCents: Cents; date: IsoDate; source: 'user' | 'statement' } | null;
  movementsCount: number;
  firstDate: IsoDate | null;
  lastDate: IsoDate | null;
  /** Money in / out over the last 30 days (internal transfers included). */
  last30InCents: Cents;
  last30OutCents: Cents;
}

export interface AccountUpdate {
  id: number;
  name?: string;
  kind?: AccountKind;
  includeInNetWorth?: boolean;
  annualRateBp?: number | null;
  ownTransferTarget?: boolean;
}

export interface ManualAccountInput {
  name: string;
  bank: string;
  kind: AccountKind;
  balanceCents: Cents;
  date: IsoDate;
  annualRateBp: number | null;
  ownTransferTarget: boolean;
}

export type CounterpartyRole = 'own' | 'partner' | 'other';

export interface CounterpartySummary {
  /** Name as printed by the bank, normalized. */
  key: string;
  displayName: string;
  sentCents: Cents;
  receivedCents: Cents;
  count: number;
  largestCents: Cents;
  lastDate: IsoDate;
  role: CounterpartyRole | null;
  accountId: number | null;
  categoryId: number | null;
  /** Not reviewed and with a large transfer: currently assumed to be one of your own accounts. */
  needsReview: boolean;
}

export interface CounterpartyDecisionInput {
  key: string;
  displayName?: string;
  role: CounterpartyRole | null;
  accountId: number | null;
  categoryId: number | null;
}

export interface EmergencyInfo {
  /** Average monthly essential spending (essential categories, recurring or not). */
  essentialMonthlyCents: Cents;
  monthsUsed: number;
  savedCents: Cents;
  /** Months of essential spending covered by the emergency pot, in tenths (35 = 3,5 meses). */
  coverageTenths: number | null;
  potId: number | null;
  suggestedTargetCents: { months3: Cents; months6: Cents };
  /** Recommended months for your situation (profile) and why. */
  recommendedMonths: number;
  recommendedReason: string;
  /** Money in current/savings accounts (included in net worth), for context. */
  liquidCents: Cents | null;
  explanation: string;
}

export interface PotsOverview {
  pots: PotDTO[];
  emergency: EmergencyInfo;
  totalSavedCents: Cents;
  requiredMonthlyTotalCents: Cents;
  capacityCents: Cents | null;
  capacityProvisional: boolean;
  insights: { tone: 'info' | 'positive' | 'warning'; text: string }[];
}

// ───────────────────────── Wealth (patrimonio) ─────────────────────────

export const ASSET_TYPES = ['cash', 'deposit', 'fund', 'stocks', 'pension', 'crypto', 'real_estate', 'other', 'loan', 'mortgage', 'credit_card'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  cash: 'Cuenta / efectivo',
  deposit: 'Depósito',
  fund: 'Fondo de inversión',
  stocks: 'Acciones / ETF',
  pension: 'Plan de pensiones',
  crypto: 'Criptoactivos',
  real_estate: 'Inmueble',
  other: 'Otro activo',
  loan: 'Préstamo',
  mortgage: 'Hipoteca',
  credit_card: 'Deuda de tarjeta',
};
export const LIABILITY_TYPES: readonly AssetType[] = ['loan', 'mortgage', 'credit_card'];
/** Types where "contributed vs value" (gain) makes sense. */
export const INVESTMENT_TYPES: readonly AssetType[] = ['deposit', 'fund', 'stocks', 'pension', 'crypto', 'real_estate', 'other'];

export type ValuationMode = 'manual' | 'rate' | 'loan';

export interface LoanInfo {
  principalCents: Cents;
  annualRateBp: number;
  termMonths: number;
  startDate: IsoDate;
  paymentCents: Cents;
  outstandingCents: Cents;
  paidPrincipalCents: Cents;
  paidInterestCents: Cents;
  totalInterestCents: Cents;
  remainingInterestCents: Cents;
  paymentsMade: number;
  remainingPayments: number;
  nextPaymentDate: IsoDate | null;
  endDate: IsoDate;
}

export interface AssetDTO {
  id: number;
  name: string;
  type: AssetType;
  isLiability: boolean;
  institution: string | null;
  notes: string | null;
  mode: ValuationMode;
  annualRateBp: number | null;
  monthlyContributionCents: Cents | null;
  symbol: string | null;
  rateSource: string | null;
  /** True when the value is calculated (rate or loan), not a valuation the user entered for today. */
  estimated: boolean;
  /** Date of the real valuation an estimate starts from. */
  baseDate: IsoDate | null;
  loan: LoanInfo | null;
  valueCents: Cents | null;
  contributedCents: Cents | null;
  gainCents: Cents | null;
  returnBp: number | null;
  lastDate: IsoDate | null;
  valuationsCount: number;
  stale: boolean;
}

export interface AssetInput {
  id?: number;
  name: string;
  type: AssetType;
  institution: string | null;
  notes: string | null;
  mode?: ValuationMode;
  annualRateBp?: number | null;
  monthlyContributionCents?: Cents | null;
  symbol?: string | null;
  rateSource?: string | null;
  principalCents?: Cents | null;
  termMonths?: number | null;
  startDate?: IsoDate | null;
}

export interface LoanScheduleRow {
  n: number;
  date: IsoDate;
  paymentCents: Cents;
  interestCents: Cents;
  principalCents: Cents;
  balanceCents: Cents;
}

export interface EarlyRepaymentDTO {
  outstandingBeforeCents: Cents;
  outstandingAfterCents: Cents;
  currentPaymentCents: Cents;
  newPaymentCents: Cents;
  currentRemainingPayments: number;
  newRemainingPayments: number;
  currentEndDate: IsoDate;
  newEndDate: IsoDate;
  interestSavedCents: Cents;
}

export interface MarketQuoteDTO {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

export interface MarketReturnsDTO {
  symbol: string;
  name: string;
  currency: string | null;
  source: string;
  fetchedOn: IsoDate;
  firstDate: IsoDate;
  lastDate: IsoDate;
  years: number;
  cagr: { y1: number | null; y3: number | null; y5: number | null; y10: number | null; all: number | null };
  ytdBp: number | null;
  volatilityBp: number | null;
  maxDrawdownBp: number | null;
  worstYearBp: number | null;
  bestYearBp: number | null;
  /** Yearly (last point of each year) prices normalised to 100, for a small chart. */
  indexSeries: { date: IsoDate; value: number }[];
}

export interface ValuationDTO {
  id: number;
  assetId: number;
  date: IsoDate;
  valueCents: Cents;
  contributedCents: Cents | null;
  note: string | null;
}

export interface ValuationInput {
  assetId: number;
  date: IsoDate;
  valueCents: Cents;
  contributedCents: Cents | null;
  note: string | null;
}

export interface WealthOverview {
  assets: AssetDTO[];
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  investedValueCents: Cents;
  investedContributedCents: Cents;
  investedGainCents: Cents;
  investedReturnBp: number | null;
  allocation: { type: AssetType; label: string; cents: Cents; shareBp: number | null }[];
  history: { month: YearMonth; assetsCents: Cents; liabilitiesCents: Cents; netWorthCents: Cents }[];
  potsSavedCents: Cents;
  /** Bank accounts (imported or manual) counted in net worth, with their derived balances. */
  accounts: AccountDTO[];
  accountsTotalCents: Cents;
  /** Accounts whose balance is still unknown (the user has to enter it once). */
  accountsWithoutBalance: number;
}
