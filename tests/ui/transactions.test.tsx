// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionsPage } from '../../src/renderer/src/pages/TransactionsPage';
import { ToastProvider } from '../../src/renderer/src/components/ui';
import type { CategoryWithStats, TransactionDTO } from '../../src/shared/types';

const cats: CategoryWithStats[] = [
  { id: 1, name: 'Supermercado', kind: 'essential', color: '#2f8f6b', isSystem: true, excludedFromSpending: false, spentCents: 0, txCount: 0, ruleCount: 0 },
  { id: 2, name: 'Otros', kind: 'neutral', color: '#a3a3a3', isSystem: true, excludedFromSpending: false, spentCents: 0, txCount: 0, ruleCount: 0 },
];
const tx: TransactionDTO = {
  id: 10, documentId: 1, date: '2026-08-02', bookingDate: null, descriptionRaw: 'COMPRA TARJ. MERCADONA 1234 MADRID', descriptionNormalized: 'COMPRA TARJ MERCADONA 1234 MADRID',
  merchantId: 5, merchantName: 'Mercadona', merchantRaw: 'MERCADONA 1234 MADRID', amountCents: -4520, currency: 'EUR', type: 'expense', categoryId: 2,
  categoryName: 'Otros', categoryColor: '#a3a3a3', classificationSource: 'UNKNOWN', classificationConfidence: 0, classificationDetail: null, categoryLocked: false,
  isExcluded: false, notes: null, recurringStatus: null, source: 'manual', createdAt: '', updatedAt: '',
};

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (channel: string, input?: unknown) => {
    switch (channel) {
      case 'transactions.list':
        return { items: [tx], total: 1, netCents: -4520 };
      case 'categories.list':
        return cats;
      case 'transactions.update':
        return {
          transaction: { ...tx, categoryId: 1, categoryName: 'Supermercado', document: null, rule: null },
          ruleSuggestion: { merchantId: 5, merchantName: 'Mercadona', categoryId: 1, categoryName: 'Supermercado', affectedCount: 3 },
        };
      case 'rules.create':
        return { rule: { id: 1 }, updatedTransactions: 3, input };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  (window as unknown as { hormiga: unknown }).hormiga = { invoke, on: () => () => {} };
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});

describe('Transactions screen', () => {
  it('changing a category offers to create a rule and creates it on confirmation', async () => {
    const user = userEvent.setup();
    render(<ToastProvider><TransactionsPage initial={{}} /></ToastProvider>);
    const select = await screen.findByLabelText('Categoría de Mercadona');
    await waitFor(() => expect(within(select as HTMLElement).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, '1');

    expect(invoke).toHaveBeenCalledWith('transactions.update', { id: 10, categoryId: 1 });
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(dialog).toHaveTextContent('Aplicar siempre la categoría Supermercado a los movimientos de Mercadona');
    expect(dialog).toHaveTextContent('3 movimiento(s) existentes');

    await user.click(within(dialog).getByRole('button', { name: 'Aplicar siempre', hidden: true }));
    expect(invoke).toHaveBeenCalledWith('rules.create', { matchType: 'merchant', pattern: '5', categoryId: 1, applyToExisting: true });
    await screen.findByText(/Regla creada/);
  });

  it('shows the original bank description for traceability', async () => {
    render(<ToastProvider><TransactionsPage initial={{}} /></ToastProvider>);
    expect(await screen.findByText('COMPRA TARJ. MERCADONA 1234 MADRID')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Abrir detalle de Mercadona/ });
    expect(within(row).getByText(/-45,20/)).toBeInTheDocument();
  });
});
