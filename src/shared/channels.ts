import type { Channel, EventName } from './api';

/** Allow-list used by the preload script. Kept free of runtime dependencies. */
export const CHANNELS = [
  'app.info', 'app.completeOnboarding',
  'settings.get', 'settings.update',
  'categories.list', 'categories.create', 'categories.update', 'categories.delete',
  'transactions.list', 'transactions.get', 'transactions.update',
  'rules.list', 'rules.create', 'rules.delete',
  'merchants.rename',
  'recurring.list', 'recurring.setStatus', 'recurring.redetect',
  'income.list', 'income.save', 'income.delete',
  'goal.get', 'goal.set',
  'analytics.dashboard', 'analytics.report', 'analytics.savings',
  'recommendations.list', 'recommendations.dismiss',
  'import.pickAndImport', 'import.withPassword', 'import.forgetPasswords', 'import.documents', 'import.review', 'import.reviewSummary',
  'import.updateReviewItem', 'import.confirmReview', 'import.discardDocument', 'import.openDocument',
  'import.deleteRetainedDocuments',
  'email.status', 'email.saveClientConfig', 'email.clearClientConfig', 'email.connect', 'email.disconnect',
  'email.scan', 'email.importSelected', 'email.syncNow', 'email.retryPassword', 'email.pendingPasswords', 'email.unlockPending',
  'data.info', 'data.exportTransactions', 'data.backup', 'data.restore', 'data.deleteAll', 'data.loadDemo',
  'data.removeDemo', 'data.openDataDir', 'data.clearImported',
  'app.updateStatus', 'app.checkUpdates', 'app.installUpdate',
  'pots.overview', 'pots.save', 'pots.delete', 'pots.movements', 'pots.addMovement', 'pots.deleteMovement',
  'wealth.overview', 'wealth.saveAsset', 'wealth.deleteAsset', 'wealth.valuations', 'wealth.saveValuation', 'wealth.deleteValuation',
  'wealth.loanSchedule', 'wealth.earlyRepayment', 'market.search', 'market.returns',
  'shell.openHelp',
] as const satisfies readonly Channel[];

// Compile-time check that every Channel is listed exactly (missing entries fail typecheck).
type Missing = Exclude<Channel, (typeof CHANNELS)[number]>;
const _exhaustive: Missing extends never ? true : Missing = true;
void _exhaustive;

export const EVENTS = ['sync.progress', 'sync.finished', 'data.changed', 'update.status'] as const satisfies readonly EventName[];

export const IPC_PREFIX = 'hormiga:';
