import type { Category, CreateRuleInput, CreateRuleResult, RuleSuggestion, TransactionType, UpdateTransactionInput, UpdateTransactionResult } from '../../shared/types';
import { categorize, sortUserRules, type CategorizationResult, type UserRule } from '../domain/categorizer';
import { findKnownMerchant, normalizeMerchant, normalizeText, type MerchantResult } from '../domain/merchant';
import { AppError, invalid } from '../errors';
import type { Repos } from './context';

/** Owns every change to categories of movements: automatic classification, manual edits and learned rules. */
export class CategorizationService {
  private sortedRules: UserRule[] | null = null;

  constructor(private readonly repos: Repos, private readonly onChange: () => void = () => {}) {}

  /**
   * When the user (or a user rule) puts a movement in a category, the category decides whether it counts:
   * a Bizum/transfer moved to "Deporte" becomes spending; anything moved to "Transferencias" stops counting.
   */
  alignType(type: TransactionType, amountCents: number, category: Pick<Category, 'excludedFromSpending' | 'id'>): TransactionType {
    const transfersId = this.repos.categories.idByKey('transfers');
    const incomeId = this.repos.categories.idByKey('income');
    if (category.id === transfersId || category.id === this.repos.categories.idByKey('capital')) return 'transfer';
    if (category.id === incomeId) return amountCents > 0 ? 'income' : type;
    if (!category.excludedFromSpending && (type === 'transfer' || type === 'income' || type === 'unknown')) return amountCents < 0 ? 'expense' : 'refund';
    return type;
  }

  invalidateRules(): void {
    this.sortedRules = null;
  }

  private rules(): UserRule[] {
    this.sortedRules ??= sortUserRules(this.repos.rules.listForEngine());
    return this.sortedRules;
  }

  classify(descriptionNormalized: string, merchant: Pick<MerchantResult, 'key' | 'known'> | null, type: TransactionType): CategorizationResult {
    return categorize(
      { descriptionNormalized, merchantKey: merchant?.key ?? null, knownMerchant: merchant?.known ?? null, type },
      { userRules: [], categoryIdByKey: (k) => this.repos.categories.idByKey(k) },
      this.rules(),
    );
  }

  /** Re-applies the automatic pipeline to movements the user has not fixed manually. Returns how many changed. */
  recategorize(filter: { merchantKey?: string; contains?: string } = {}): number {
    let changed = 0;
    this.repos.db.transaction(() => {
      for (const t of this.repos.transactions.listUnlocked(filter)) {
        const known = t.merchantKey ? findKnownMerchant(t.merchantKey) : null;
        const r = this.classify(t.descriptionNormalized, t.merchantKey ? { key: t.merchantKey, known } : null, t.type);
        if (r.categoryId !== t.categoryId || filter.merchantKey || filter.contains) {
          this.repos.transactions.setCategory(t.id, r.categoryId, r.source, r.confidence, r.detail, r.ruleId, false);
          if (r.source === 'USER') {
            const aligned = this.alignType(t.type, t.amountCents, this.repos.categories.get(r.categoryId));
            if (aligned !== t.type) this.repos.transactions.setFields(t.id, { type: aligned });
          }
          if (r.categoryId !== t.categoryId) changed++;
        }
      }
    });
    return changed;
  }

  updateTransaction(input: UpdateTransactionInput): UpdateTransactionResult {
    const before = this.repos.transactions.get(input.id);
    let suggestion: RuleSuggestion | null = null;

    this.repos.db.transaction(() => {
      if (input.merchantName !== undefined) {
        const name = input.merchantName.trim();
        if (!name) throw invalid('El nombre del comercio no puede estar vacío.');
        const key = normalizeText(name);
        if (!key) throw invalid('El nombre del comercio debe contener letras o números.');
        const merchantId = this.repos.merchants.upsert(key, name);
        this.repos.transactions.setFields(input.id, { merchantId });
      }
      if (input.type !== undefined && input.type !== before.type) {
        this.repos.transactions.setFields(input.id, { type: input.type });
        if (!before.categoryLocked && input.categoryId === undefined) {
          const t = this.repos.transactions.get(input.id);
          const merchantKey = t.merchantId ? this.repos.merchants.get(t.merchantId).key : null;
          const r = this.classify(t.descriptionNormalized, merchantKey ? { key: merchantKey, known: findKnownMerchant(merchantKey) } : null, input.type);
          this.repos.transactions.setCategory(input.id, r.categoryId, r.source, r.confidence, r.detail, r.ruleId, false);
        }
      }
      if (input.isExcluded !== undefined) this.repos.transactions.setFields(input.id, { isExcluded: input.isExcluded });
      if (input.notes !== undefined) {
        const notes = input.notes === null ? null : input.notes.trim().slice(0, 2000) || null;
        this.repos.transactions.setFields(input.id, { notes });
      }
      if (input.categoryId !== undefined && input.categoryId !== before.categoryId) {
        const cat = this.repos.categories.get(input.categoryId);
        this.repos.transactions.setCategory(input.id, cat.id, 'USER', 1, 'Categoría asignada manualmente', null, true);
        if (input.type === undefined) {
          const aligned = this.alignType(before.type, before.amountCents, cat);
          if (aligned !== before.type) this.repos.transactions.setFields(input.id, { type: aligned });
        }
        const after = this.repos.transactions.get(input.id);
        if (after.merchantId) {
          const merchant = this.repos.merchants.get(after.merchantId);
          const existing = this.rules().find((r) => r.matchType === 'merchant' && r.pattern === merchant.key);
          if (!existing || existing.categoryId !== cat.id) {
            suggestion = {
              merchantId: merchant.id,
              merchantName: merchant.displayName,
              categoryId: cat.id,
              categoryName: cat.name,
              affectedCount: this.repos.transactions.countByMerchantExcept(merchant.id, input.id, cat.id),
            };
          }
        }
      }
    });
    this.onChange();
    return { transaction: this.repos.transactions.get(input.id), ruleSuggestion: suggestion };
  }

  createRule(input: CreateRuleInput): CreateRuleResult {
    this.repos.categories.get(input.categoryId);
    let pattern: string;
    if (input.matchType === 'merchant') {
      const id = Number(input.pattern);
      if (!Number.isInteger(id)) throw invalid('Comercio no válido.');
      pattern = this.repos.merchants.get(id).key;
    } else {
      pattern = normalizeText(input.pattern);
      if (pattern.length < 3) throw invalid('El texto de la regla debe tener al menos 3 caracteres alfanuméricos.');
    }
    let updated = 0;
    const ruleId = this.repos.db.transaction(() => {
      const id = this.repos.rules.upsert(input.matchType, pattern, input.categoryId);
      this.invalidateRules();
      if (input.applyToExisting) {
        updated = this.recategorize(input.matchType === 'merchant' ? { merchantKey: pattern } : { contains: pattern });
      }
      return id;
    });
    this.onChange();
    return { rule: this.repos.rules.get(ruleId), updatedTransactions: updated };
  }

  deleteRule(id: number): boolean {
    const rule = this.repos.rules.get(id);
    const deleted = this.repos.db.transaction(() => {
      const ok = this.repos.rules.delete(id);
      this.invalidateRules();
      this.recategorize(rule.matchType === 'merchant' ? { merchantKey: rule.pattern } : { contains: rule.pattern });
      return ok;
    });
    this.onChange();
    return deleted;
  }

  /** Resolves (or creates) the merchant row for a description. */
  merchantFor(descriptionRaw: string): { id: number; result: MerchantResult } {
    const result = normalizeMerchant(descriptionRaw);
    return { id: this.repos.merchants.upsert(result.key, result.display), result };
  }

  renameMerchant(merchantId: number, name: string): { merchantId: number; merged: boolean } {
    const trimmed = name.trim();
    if (!trimmed) throw invalid('El nombre del comercio no puede estar vacío.');
    if (trimmed.length > 120) throw new AppError('VALIDATION', 'El nombre es demasiado largo.');
    this.repos.merchants.rename(merchantId, trimmed);
    this.onChange();
    return { merchantId, merged: false };
  }
}
