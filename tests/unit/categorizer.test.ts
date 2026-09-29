import { describe, expect, it } from 'vitest';
import { categorize, type UserRule } from '../../src/core/domain/categorizer';
import { SYSTEM_CATEGORIES, type SystemCategoryKey } from '../../src/core/domain/categories';
import { normalizeMerchant, normalizeText } from '../../src/core/domain/merchant';
import { inferTransactionType } from '../../src/core/domain/transactionType';
import type { TransactionType } from '../../src/shared/types';

const ids = new Map(SYSTEM_CATEGORIES.map((c, i) => [c.key, i + 1]));
const idOf = (k: SystemCategoryKey) => ids.get(k)!;
const keyOf = (id: number) => [...ids.entries()].find(([, v]) => v === id)![0];

function run(desc: string, rules: UserRule[] = [], type?: TransactionType, amount = -1000) {
  const n = normalizeText(desc);
  const m = normalizeMerchant(desc);
  const t = type ?? inferTransactionType(n, amount, 'card').type;
  return categorize({ descriptionNormalized: n, merchantKey: m.key, knownMerchant: m.known, type: t }, { userRules: rules, categoryIdByKey: idOf });
}

describe('categorize', () => {
  it('uses known merchants (MERCHANT)', () => {
    const r = run('COMPRA TARJ. MERCADONA 1234 MADRID');
    expect(keyOf(r.categoryId)).toBe('groceries');
    expect(r.source).toBe('MERCHANT');
  });

  it('uses keyword rules (RULE)', () => {
    const r = run('FARMACIA LDO GARCIA 22');
    expect(keyOf(r.categoryId)).toBe('health');
    expect(r.source).toBe('RULE');
    expect(r.detail).toContain('FARMACIA');
  });

  it('uses type heuristics for fees, cash, transfers and income (HEURISTIC)', () => {
    expect(keyOf(run('COMISION MANTENIMIENTO CUENTA').categoryId)).toBe('fees');
    expect(keyOf(run('REINTEGRO CAJERO 1234').categoryId)).toBe('cash');
    expect(keyOf(run('TRASPASO A CUENTA AHORRO').categoryId)).toBe('transfers');
    // A Bizum to a bar is restaurant spending; to a person, its own spending category.
    expect(keyOf(run('BIZUM A BAR PEPE').categoryId)).toBe('restaurants');
    expect(keyOf(run('BIZUM ENVIADO JUAN').categoryId)).toBe('people');
    const inc = run('ABONO NOMINA EMPRESA', [], undefined, 200000);
    expect(keyOf(inc.categoryId)).toBe('income');
    expect(inc.source).toBe('HEURISTIC');
  });

  it('falls back to uncategorized (UNKNOWN)', () => {
    const r = run('XK77 SERVICIOS VARIOS QWERTY');
    expect(keyOf(r.categoryId)).toBe('uncategorized');
    expect(r.source).toBe('UNKNOWN');
    expect(r.confidence).toBe(0);
  });

  it('user rules have priority over everything (USER)', () => {
    const rules: UserRule[] = [{ id: 7, matchType: 'merchant', pattern: 'MERCADONA', categoryId: idOf('other') }];
    const r = run('MERCADONA 1234 BARCELONA', rules);
    expect(keyOf(r.categoryId)).toBe('other');
    expect(r.source).toBe('USER');
    expect(r.ruleId).toBe(7);
  });

  it('merchant rules beat contains rules; longer contains rules beat shorter', () => {
    const rules: UserRule[] = [
      { id: 1, matchType: 'contains', pattern: 'LUNA', categoryId: idOf('leisure') },
      { id: 2, matchType: 'contains', pattern: 'BARRIO LUNA', categoryId: idOf('shopping') },
    ];
    expect(keyOf(run('TIENDA DEL BARRIO LUNA', rules).categoryId)).toBe('shopping');
    const withMerchant = [...rules, { id: 3, matchType: 'merchant' as const, pattern: normalizeMerchant('TIENDA DEL BARRIO LUNA').key, categoryId: idOf('groceries') }];
    expect(keyOf(run('TIENDA DEL BARRIO LUNA', withMerchant).categoryId)).toBe('groceries');
  });

  it('refunds keep the merchant category so they net against it', () => {
    const r = run('DEVOLUCION COMPRA AMAZON EU', [], undefined, 1999);
    expect(keyOf(r.categoryId)).toBe('shopping');
  });
});

describe('inferTransactionType', () => {
  it.each([
    ['COMPRA MERCADONA', -100, 'card', 'expense'],
    ['DEVOLUCION COMPRA ZARA', 100, 'card', 'refund'],
    ['ABONO SIN CONCEPTO', 100, 'card', 'refund'],
    ['ABONO SIN CONCEPTO', 100, 'account', 'income'],
    ['ABONO NOMINA', 100, 'account', 'income'],
    ['COMISION EMISION TARJETA', -100, 'account', 'fee'],
    ['REINTEGRO CAJERO', -100, 'account', 'cash_withdrawal'],
    ['TRANSFERENCIA A CUENTA AHORRO', -100, 'account', 'transfer'],
    ['LIQUIDACION TARJETA CREDITO', -100, 'account', 'transfer'],
    ['TRANSFERENCIA REALIZADA JUAN PEREZ', -100, 'account', 'expense'],
    ['BIZUM ENVIADO CENA', -100, 'account', 'expense'],
    ['BIZUM RECIBIDO CENA', 100, 'account', 'refund'],
    ['TRANSFERENCIA RECIBIDA MARIA LOPEZ', 100, 'account', 'income'],
  ] as const)('%s (%d, %s) → %s', (desc, amount, kind, expected) => {
    expect(inferTransactionType(normalizeText(desc), amount, kind).type).toBe(expected);
  });
});
