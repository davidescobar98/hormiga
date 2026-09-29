import type { Database } from '../db/database';
import { CategoriesRepo, MerchantsRepo, RulesRepo } from '../db/catalogRepo';
import { DocumentsRepo, EmailImportsRepo } from '../db/documentsRepo';
import { GoalsRepo, IncomeRepo, RecommendationsRepo, RecurringRepo } from '../db/planningRepo';
import { SettingsRepo } from '../db/settingsRepo';
import { TransactionsRepo } from '../db/transactionsRepo';
import { AssetsRepo, PotsRepo } from '../db/wealthRepo';
import { AccountsRepo } from '../db/accountsRepo';

/** Values are sanitized by the logger (sensitive keys redacted, IBAN/cards/emails/tokens masked). */
export type LogData = Record<string, unknown>;

/** Structured logger. Callers must never pass descriptions, amounts, tokens or personal data. */
export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface Repos {
  db: Database;
  settings: SettingsRepo;
  categories: CategoriesRepo;
  merchants: MerchantsRepo;
  rules: RulesRepo;
  transactions: TransactionsRepo;
  documents: DocumentsRepo;
  emailImports: EmailImportsRepo;
  income: IncomeRepo;
  goals: GoalsRepo;
  recurring: RecurringRepo;
  recommendations: RecommendationsRepo;
  pots: PotsRepo;
  assets: AssetsRepo;
  accounts: AccountsRepo;
}

export function createRepos(db: Database, now: () => Date): Repos {
  return {
    db,
    settings: new SettingsRepo(db, now),
    categories: new CategoriesRepo(db, now),
    merchants: new MerchantsRepo(db, now),
    rules: new RulesRepo(db, now),
    transactions: new TransactionsRepo(db, now),
    documents: new DocumentsRepo(db, now),
    emailImports: new EmailImportsRepo(db, now),
    income: new IncomeRepo(db, now),
    goals: new GoalsRepo(db, now),
    recurring: new RecurringRepo(db, now),
    recommendations: new RecommendationsRepo(db, now),
    pots: new PotsRepo(db, now),
    assets: new AssetsRepo(db, now),
    accounts: new AccountsRepo(db, now),
  };
}

/** Where original documents are kept when the user enables it. Implemented with the filesystem in main. */
export interface DocumentStore {
  save(sha256: string, extension: string, bytes: Uint8Array): Promise<string>;
  remove(path: string): Promise<void>;
  size(path: string): Promise<number>;
}

export const noDocumentStore: DocumentStore = {
  async save() {
    throw new Error('Almacenamiento de documentos no disponible');
  },
  async remove() {},
  async size() {
    return 0;
  },
};
