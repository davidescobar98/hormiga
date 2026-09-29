import type { ClassificationSource, RuleMatchType, TransactionType } from '../../shared/types';
import type { SystemCategoryKey } from './categories';
import { KEYWORD_RULES, type KnownMerchant } from './knowledge';
import { normalizeText } from './merchant';
import { CAPITAL, hasKeyword, PERSON_TRANSFER } from './transactionType';

export interface UserRule {
  id: number;
  matchType: RuleMatchType;
  /** merchant: merchant key (e.g. "MERCADONA"); contains: normalized text. */
  pattern: string;
  categoryId: number;
}

export interface CategorizationInput {
  descriptionNormalized: string;
  merchantKey: string | null;
  knownMerchant: KnownMerchant | null;
  type: TransactionType;
}

export interface CategorizationContext {
  userRules: UserRule[];
  categoryIdByKey: (key: SystemCategoryKey) => number;
}

export interface CategorizationResult {
  categoryId: number;
  source: ClassificationSource;
  confidence: number;
  detail: string;
  ruleId: number | null;
}

const COMPILED_KEYWORDS = KEYWORD_RULES.flatMap((r) =>
  r.keywords.map((k) => ({ keyword: normalizeText(k), category: r.category, label: r.label })),
)
  .filter((k) => k.keyword.length > 0)
  .sort((a, b) => b.keyword.length - a.keyword.length);

const TYPE_CATEGORY: Partial<Record<TransactionType, { key: SystemCategoryKey; label: string }>> = {
  income: { key: 'income', label: 'movimiento de ingreso' },
  transfer: { key: 'transfers', label: 'transferencia' },
  fee: { key: 'fees', label: 'comisión bancaria' },
  cash_withdrawal: { key: 'cash', label: 'retirada de efectivo' },
};

function containsWords(text: string, needle: string): boolean {
  return ` ${text} `.includes(` ${needle} `);
}

/** Sorts user rules so the most specific wins: merchant rules first, then longer "contains" patterns. */
export function sortUserRules(rules: UserRule[]): UserRule[] {
  return [...rules].sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'merchant' ? -1 : 1;
    if (a.pattern.length !== b.pattern.length) return b.pattern.length - a.pattern.length;
    return b.id - a.id;
  });
}

export function matchUserRule(input: Pick<CategorizationInput, 'descriptionNormalized' | 'merchantKey'>, rules: UserRule[]): UserRule | null {
  for (const r of rules) {
    if (r.matchType === 'merchant' && input.merchantKey && input.merchantKey === r.pattern) return r;
    if (r.matchType === 'contains' && r.pattern && containsWords(input.descriptionNormalized, r.pattern)) return r;
  }
  return null;
}

/**
 * Deterministic categorization pipeline. Order:
 * 1. user rules (USER) — always win
 * 2. movement semantics for non-purchases (HEURISTIC): income, transfer, fee, cash withdrawal
 * 3. known merchant dictionary (MERCHANT)
 * 4. keyword rules (RULE)
 * 5. transfers/Bizum with other people (HEURISTIC, "Bizum y transferencias")
 * 6. uncategorized (UNKNOWN)
 * Step 2 runs before merchant/keywords because the type (e.g. a transfer) determines whether the movement is
 * spending at all; a "BIZUM A BAR PEPE" must not be counted as restaurant spending.
 */
export function categorize(input: CategorizationInput, ctx: CategorizationContext, sortedRules?: UserRule[]): CategorizationResult {
  const rules = sortedRules ?? sortUserRules(ctx.userRules);
  const rule = matchUserRule(input, rules);
  if (rule) {
    return {
      categoryId: rule.categoryId,
      source: 'USER',
      confidence: 1,
      detail: rule.matchType === 'merchant' ? 'Regla creada por ti para este comercio' : `Regla creada por ti: contiene «${rule.pattern}»`,
      ruleId: rule.id,
    };
  }

  const capital = hasKeyword(input.descriptionNormalized, CAPITAL);
  if (capital) {
    return { categoryId: ctx.categoryIdByKey('capital'), source: 'HEURISTIC', confidence: 0.85, detail: `Operación patrimonial («${capital.toLowerCase()}»): préstamo, compra o venta de un bien`, ruleId: null };
  }

  const byType = TYPE_CATEGORY[input.type];
  if (byType) {
    return { categoryId: ctx.categoryIdByKey(byType.key), source: 'HEURISTIC', confidence: 0.7, detail: `Tipo de movimiento: ${byType.label}`, ruleId: null };
  }

  if (input.knownMerchant) {
    return {
      categoryId: ctx.categoryIdByKey(input.knownMerchant.category),
      source: 'MERCHANT',
      confidence: 0.95,
      detail: `Comercio conocido: ${input.knownMerchant.display}`,
      ruleId: null,
    };
  }

  for (const k of COMPILED_KEYWORDS) {
    if (containsWords(input.descriptionNormalized, k.keyword)) {
      return { categoryId: ctx.categoryIdByKey(k.category), source: 'RULE', confidence: 0.75, detail: `Palabra clave «${k.keyword}» (${k.label})`, ruleId: null };
    }
  }

  // Transfers and Bizum with other people that no rule explains: their own category, which still counts as spending.
  const person = hasKeyword(input.descriptionNormalized, PERSON_TRANSFER);
  if (person && (input.type === 'expense' || input.type === 'refund')) {
    return { categoryId: ctx.categoryIdByKey('people'), source: 'HEURISTIC', confidence: 0.6, detail: `${person === 'BIZUM' ? 'Bizum' : 'Transferencia'} con otra persona: cuenta como gasto (puedes moverlo a su categoría real)`, ruleId: null };
  }

  return { categoryId: ctx.categoryIdByKey('uncategorized'), source: 'UNKNOWN', confidence: 0, detail: 'Ninguna regla coincide', ruleId: null };
}
