import type { AccountKind, TransactionType } from '../../shared/types';
import type { CounterpartyDecision, CounterpartyRole } from '../domain/transfers';
import { AppError, notFound } from '../errors';
import type { Database } from './database';

export interface AccountRow {
  id: number;
  name: string;
  bank: string;
  kind: AccountKind;
  sourceKind: 'account' | 'card' | 'manual';
  last4: string | null;
  anchorBalanceCents: number | null;
  anchorDate: string | null;
  anchorSource: 'user' | 'statement' | null;
  includeInNetWorth: boolean;
  annualRateBp: number | null;
  ownTransferTarget: boolean;
}

interface RawAccount {
  id: number; name: string; bank: string; kind: AccountKind; source_kind: 'account' | 'card' | 'manual'; last4: string | null;
  anchor_balance_cents: number | null; anchor_date: string | null; anchor_source: 'user' | 'statement' | null;
  include_in_net_worth: number; annual_rate_bp: number | null; own_transfer_target: number;
}

const toRow = (r: RawAccount): AccountRow => ({
  id: r.id, name: r.name, bank: r.bank, kind: r.kind, sourceKind: r.source_kind, last4: r.last4,
  anchorBalanceCents: r.anchor_balance_cents === null ? null : Number(r.anchor_balance_cents), anchorDate: r.anchor_date, anchorSource: r.anchor_source,
  includeInNetWorth: r.include_in_net_worth === 1, annualRateBp: r.annual_rate_bp, ownTransferTarget: r.own_transfer_target === 1,
});

export interface AccountMovement {
  id: number;
  accountId: number | null;
  counterAccountId: number | null;
  date: string;
  amountCents: number;
  type: TransactionType;
}

export interface CounterpartyRow extends CounterpartyDecision {
  id: number;
  displayName: string;
}

export class AccountsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  list(includeArchived = false): AccountRow[] {
    return this.db.all<RawAccount>(`SELECT * FROM accounts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY source_kind = 'card', bank, id`).map(toRow);
  }

  get(id: number): AccountRow {
    const r = this.db.get<RawAccount>('SELECT * FROM accounts WHERE id = ?', id);
    if (!r) throw notFound('La cuenta');
    return toRow(r);
  }

  /**
   * Account for an imported statement: same bank, kind and last digits. A statement without digits reuses the
   * single account of that bank and kind; a statement with digits adopts an existing account that had none.
   */
  resolveForStatement(bank: string, statementKind: 'card' | 'account' | 'generic', last4: string | null): number {
    const sourceKind = statementKind === 'card' ? 'card' : 'account';
    const same = this.db.all<RawAccount>('SELECT * FROM accounts WHERE bank = ? AND source_kind = ? AND archived = 0 ORDER BY id', bank, sourceKind);
    const exact = same.find((a) => (a.last4 ?? '') === (last4 ?? ''));
    if (exact) return exact.id;
    if (!last4 && same.length === 1) return same[0]!.id;
    const unnamed = same.find((a) => a.last4 === null);
    if (last4 && unnamed && same.every((a) => a.last4 === null || a.id === unnamed.id)) {
      this.db.run('UPDATE accounts SET last4 = ?, updated_at = ? WHERE id = ?', last4, this.now().toISOString(), unnamed.id);
      return unnamed.id;
    }
    const ts = this.now().toISOString();
    const name = `${bank} · ${sourceKind === 'card' ? 'tarjeta' : 'cuenta'}${last4 ? ` ···${last4}` : ''}`;
    return this.db.run(
      `INSERT INTO accounts(name, bank, kind, source_kind, last4, include_in_net_worth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      name, bank, sourceKind === 'card' ? 'card' : 'current', sourceKind, last4, sourceKind === 'card' ? 0 : 1, ts, ts,
    ).lastInsertRowid;
  }

  createManual(input: { name: string; bank: string; kind: AccountKind; balanceCents: number; date: string; annualRateBp: number | null; ownTransferTarget: boolean }): number {
    const ts = this.now().toISOString();
    return this.db.transaction(() => {
      if (input.ownTransferTarget) this.db.run('UPDATE accounts SET own_transfer_target = 0');
      return this.db.run(
        `INSERT INTO accounts(name, bank, kind, source_kind, anchor_balance_cents, anchor_date, anchor_source, include_in_net_worth,
           annual_rate_bp, own_transfer_target, created_at, updated_at) VALUES (?, ?, ?, 'manual', ?, ?, 'user', 1, ?, ?, ?, ?)`,
        input.name.trim(), input.bank.trim() || 'Otro banco', input.kind, input.balanceCents, input.date, input.annualRateBp, input.ownTransferTarget, ts, ts,
      ).lastInsertRowid;
    });
  }

  update(id: number, patch: { name?: string; kind?: AccountKind; includeInNetWorth?: boolean; annualRateBp?: number | null; ownTransferTarget?: boolean }): void {
    const a = this.get(id);
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      if (patch.ownTransferTarget) this.db.run('UPDATE accounts SET own_transfer_target = 0');
      this.db.run(
        'UPDATE accounts SET name = ?, kind = ?, include_in_net_worth = ?, annual_rate_bp = ?, own_transfer_target = ?, updated_at = ? WHERE id = ?',
        patch.name?.trim() || a.name, patch.kind ?? a.kind, patch.includeInNetWorth ?? a.includeInNetWorth,
        patch.annualRateBp !== undefined ? patch.annualRateBp : a.annualRateBp, patch.ownTransferTarget ?? a.ownTransferTarget, ts, id,
      );
    });
  }

  /** User-entered balance at the end of a day. */
  setAnchor(id: number, balanceCents: number, date: string, source: 'user' | 'statement'): void {
    this.get(id);
    this.db.run('UPDATE accounts SET anchor_balance_cents = ?, anchor_date = ?, anchor_source = ?, updated_at = ? WHERE id = ?', balanceCents, date, source, this.now().toISOString(), id);
  }

  /** A statement's closing balance becomes the anchor unless the user entered a more recent one. */
  offerStatementBalance(id: number, balanceCents: number, date: string): void {
    const a = this.get(id);
    if (a.anchorDate && a.anchorDate > date) return;
    if (a.anchorSource === 'user' && a.anchorDate === date) return;
    this.setAnchor(id, balanceCents, date, 'statement');
  }

  /** Moves everything from one account into another (the same account imported with and without digits). */
  merge(fromId: number, intoId: number): void {
    if (fromId === intoId) throw new AppError('VALIDATION', 'Elige dos cuentas distintas.');
    const from = this.get(fromId);
    const into = this.get(intoId);
    this.db.transaction(() => {
      this.db.run('UPDATE transactions SET account_id = ? WHERE account_id = ?', intoId, fromId);
      this.db.run('UPDATE transactions SET counter_account_id = ? WHERE counter_account_id = ?', intoId, fromId);
      this.db.run('UPDATE statements SET account_id = ? WHERE account_id = ?', intoId, fromId);
      this.db.run('UPDATE counterparties SET account_id = ? WHERE account_id = ?', intoId, fromId);
      if (!into.anchorDate || (from.anchorDate && from.anchorDate > into.anchorDate)) {
        this.db.run('UPDATE accounts SET anchor_balance_cents = ?, anchor_date = ?, anchor_source = ? WHERE id = ?', from.anchorBalanceCents, from.anchorDate, from.anchorSource, intoId);
      }
      this.db.run('DELETE FROM accounts WHERE id = ?', fromId);
    });
  }

  delete(id: number): void {
    const a = this.get(id);
    if (a.sourceKind !== 'manual') throw new AppError('VALIDATION', 'Solo se pueden eliminar las cuentas manuales. Las importadas desaparecen al borrar sus documentos.');
    this.db.run('DELETE FROM accounts WHERE id = ?', id);
  }

  /** Removes imported accounts that no longer have statements or movements. */
  pruneEmpty(): void {
    this.db.run(`DELETE FROM accounts WHERE source_kind <> 'manual'
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id)
      AND NOT EXISTS (SELECT 1 FROM statements s WHERE s.account_id = accounts.id)`);
  }

  /** Movements that change account balances: own movements and transfers from/to manual accounts. */
  movements(): AccountMovement[] {
    return this.db.all<{ id: number; account_id: number | null; counter_account_id: number | null; date: string; amount_cents: number; type: TransactionType }>(
      'SELECT id, account_id, counter_account_id, date, amount_cents, type FROM transactions WHERE account_id IS NOT NULL OR counter_account_id IS NOT NULL',
    ).map((r) => ({ id: r.id, accountId: r.account_id, counterAccountId: r.counter_account_id, date: r.date, amountCents: Number(r.amount_cents), type: r.type }));
  }

  // ───── Counterparties ─────

  counterparties(): CounterpartyRow[] {
    return this.db.all<{ id: number; key: string; display_name: string; role: CounterpartyRole; account_id: number | null; category_id: number | null }>(
      'SELECT * FROM counterparties ORDER BY display_name',
    ).map((r) => ({ id: r.id, key: r.key, displayName: r.display_name, role: r.role, accountId: r.account_id, categoryId: r.category_id }));
  }

  setCounterparty(d: { key: string; displayName: string; role: CounterpartyRole; accountId: number | null; categoryId: number | null }): void {
    this.db.run(
      `INSERT INTO counterparties(key, display_name, role, account_id, category_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, account_id = excluded.account_id, category_id = excluded.category_id`,
      d.key, d.displayName, d.role, d.role === 'own' ? d.accountId : null, d.role === 'other' ? d.categoryId : null, this.now().toISOString(),
    );
  }

  deleteCounterparty(key: string): void {
    this.db.run('DELETE FROM counterparties WHERE key = ?', key);
  }
}
