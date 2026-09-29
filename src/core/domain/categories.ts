import type { CategoryKind } from '../../shared/types';

export interface SystemCategory {
  key: SystemCategoryKey;
  name: string;
  kind: CategoryKind;
  color: string;
  excludedFromSpending?: boolean;
}

export type SystemCategoryKey =
  | 'housing' | 'groceries' | 'restaurants' | 'transport' | 'fuel' | 'travel' | 'leisure' | 'shopping'
  | 'subscriptions' | 'technology' | 'health' | 'sport' | 'education' | 'utilities' | 'insurance' | 'taxes'
  | 'loans' | 'fees' | 'cash' | 'people' | 'shared' | 'transfers' | 'income' | 'other' | 'uncategorized';

/**
 * Default taxonomy. "kind" drives savings recommendations:
 * essential = hard to reduce, discretionary = reducible, neutral = not evaluated.
 * Users can change kinds from the Categories screen.
 */
export const SYSTEM_CATEGORIES: SystemCategory[] = [
  { key: 'housing', name: 'Vivienda', kind: 'essential', color: '#5b6b8c' },
  { key: 'groceries', name: 'Supermercado', kind: 'essential', color: '#2f8f6b' },
  { key: 'restaurants', name: 'Restaurantes', kind: 'discretionary', color: '#d9822b' },
  { key: 'transport', name: 'Transporte', kind: 'essential', color: '#3b82b8' },
  { key: 'fuel', name: 'Combustible', kind: 'essential', color: '#6a7fa0' },
  { key: 'travel', name: 'Viajes', kind: 'discretionary', color: '#1f9aa8' },
  { key: 'leisure', name: 'Ocio', kind: 'discretionary', color: '#b5559b' },
  { key: 'shopping', name: 'Compras', kind: 'discretionary', color: '#c2647a' },
  { key: 'subscriptions', name: 'Suscripciones', kind: 'discretionary', color: '#7b61c4' },
  { key: 'technology', name: 'Tecnología', kind: 'discretionary', color: '#4f6fd6' },
  { key: 'health', name: 'Salud', kind: 'essential', color: '#3aa17e' },
  { key: 'sport', name: 'Deporte', kind: 'discretionary', color: '#8aa33a' },
  { key: 'education', name: 'Educación', kind: 'essential', color: '#a0784a' },
  { key: 'utilities', name: 'Servicios', kind: 'essential', color: '#58809a' },
  { key: 'insurance', name: 'Seguros', kind: 'essential', color: '#6d6fa8' },
  { key: 'taxes', name: 'Impuestos', kind: 'essential', color: '#8c6d5b' },
  { key: 'loans', name: 'Préstamos', kind: 'essential', color: '#7a6a9a' },
  { key: 'fees', name: 'Comisiones', kind: 'neutral', color: '#c0504d' },
  { key: 'cash', name: 'Efectivo', kind: 'neutral', color: '#8a8f98' },
  { key: 'people', name: 'Bizum y transferencias', kind: 'neutral', color: '#8f7ab8' },
  { key: 'shared', name: 'Gastos compartidos', kind: 'essential', color: '#b0806a' },
  { key: 'transfers', name: 'Entre mis cuentas', kind: 'neutral', color: '#9aa0a8', excludedFromSpending: true },
  { key: 'income', name: 'Ingresos', kind: 'neutral', color: '#2e8b57', excludedFromSpending: true },
  { key: 'other', name: 'Otros', kind: 'neutral', color: '#a3a3a3' },
  { key: 'uncategorized', name: 'Sin clasificar', kind: 'neutral', color: '#c4c4c4' },
];

export const CATEGORY_COLORS = [
  '#2f8f6b', '#3b82b8', '#d9822b', '#7b61c4', '#b5559b', '#1f9aa8', '#c2647a', '#8aa33a',
  '#58809a', '#a0784a', '#4f6fd6', '#c0504d',
];
