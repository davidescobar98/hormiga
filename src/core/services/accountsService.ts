import type { AccountDTO, AccountKind, CounterpartySummary, ExtraordinaryMovement, TransactionType } from '../../shared/types';

export const EXTRAORDINARY_CENTS = 1000000;
import { addDays, lastDayOfMonth, todayIso, type IsoDate, type YearMonth } from '../../shared/dates';
import { formatCents } from '../../shared/money';
import { balanceAt, balanceWithInterest, type Flow } from '../domain/accounts';
import { findKnownMerchant, normalizeText } from '../domain/merchant';
import { CAPITAL, hasKeyword, inferTransactionType, INTERNAL_TRANSFER, isCompanyName, PERSON_TRANSFER, type StatementKind } from '../domain/transactionType';
import { counterpartyKey, LARGE_TRANSFER_CENTS, matchInternalPairs, refineTransfer, type CounterpartyRole, type TransferContext, type TransferRefinement } from '../domain/transfers';
import type { AccountRow } from '../db/accountsRepo';
import { AppError } from '../errors';
import type { CategorizationService } from './categorizationService';
import type { Repos } from './context';

const TRANSFER_MODEL_VERSION = 4;

interface TransferRow {
  id: number;
  description_raw: string;
  description_normalized: string;
  amount_cents: number;
  type: TransactionType;
  category_id: number;
  category_locked: number;
  account_id: number | null;
  transfer_match_id: number | null;
  counter_account_id: number | null;
  merchant_key: string | null;
  statement_kind: StatementKind | null;
  date: string;
}

/** Accounts, their balances and how transfers between people and between your own accounts are treated. */
export class AccountsService {
  constructor(
    private readonly repos: Repos,
    private readonly categorization: CategorizationService,
    private readonly now: () => Date,
  ) {}

  private today(): IsoDate {
    return todayIso(this.now());
  }

  // ───────── Balances ─────────

  private flowsByAccount(): Map<number, Flow[]> {
    const map = new Map<number, Flow[]>();
    const push = (id: number, f: Flow) => map.set(id, [...(map.get(id) ?? []), f]);
    const manual = new Set(this.repos.accounts.list(true).filter((a) => a.sourceKind === 'manual').map((a) => a.id));
    for (const m of this.repos.accounts.movements()) {
      if (m.accountId !== null) push(m.accountId, { date: m.date, amountCents: m.amountCents });
      // A transfer to a manual (not imported) account of yours enters that account.
      if (m.counterAccountId !== null && manual.has(m.counterAccountId) && m.counterAccountId !== m.accountId) {
        push(m.counterAccountId, { date: m.date, amountCents: -m.amountCents });
      }
    }
    return map;
  }

  private balanceOf(a: AccountRow, flows: Flow[], date: IsoDate): number | null {
    if (a.anchorBalanceCents === null || !a.anchorDate || a.sourceKind === 'card') return null;
    const anchor = { balanceCents: a.anchorBalanceCents, date: a.anchorDate };
    return a.sourceKind === 'manual' ? balanceWithInterest(anchor, flows, a.annualRateBp, date) : balanceAt(anchor, flows, date);
  }

  list(): AccountDTO[] {
    const today = this.today();
    const flows = this.flowsByAccount();
    const from30 = addDays(today, -30);
    const stats = new Map(
      this.repos.db
        .all<{ account_id: number; n: number; first: string; last: string }>(
          'SELECT account_id, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM transactions WHERE account_id IS NOT NULL GROUP BY account_id',
        )
        .map((r) => [r.account_id, r]),
    );
    return this.repos.accounts.list().map((a) => {
      const f = flows.get(a.id) ?? [];
      const recent = f.filter((x) => x.date > from30 && x.date <= today);
      const s = stats.get(a.id);
      return {
        id: a.id,
        name: a.name,
        bank: a.bank,
        kind: a.kind,
        sourceKind: a.sourceKind,
        last4: a.last4,
        includeInNetWorth: a.includeInNetWorth,
        annualRateBp: a.annualRateBp,
        ownTransferTarget: a.ownTransferTarget,
        balanceCents: this.balanceOf(a, f, today),
        anchor: a.anchorBalanceCents !== null && a.anchorDate && a.anchorSource ? { balanceCents: a.anchorBalanceCents, date: a.anchorDate, source: a.anchorSource } : null,
        movementsCount: Number(s?.n ?? 0) + (a.sourceKind === 'manual' ? f.length : 0),
        firstDate: s?.first ?? null,
        lastDate: s?.last ?? (f.length ? f.map((x) => x.date).sort().at(-1)! : null),
        last30InCents: recent.filter((x) => x.amountCents > 0).reduce((t, x) => t + x.amountCents, 0),
        last30OutCents: -recent.filter((x) => x.amountCents < 0).reduce((t, x) => t + x.amountCents, 0),
      };
    });
  }

  /** Balances of accounts counted in net worth at the end of each month (null = unknown yet). */
  balancesAt(dates: IsoDate[]): { account: AccountRow; values: (number | null)[] }[] {
    const flows = this.flowsByAccount();
    return this.repos.accounts
      .list()
      .filter((a) => a.includeInNetWorth && a.sourceKind !== 'card')
      .map((a) => ({
        account: a,
        values: dates.map((d) => {
          const f = flows.get(a.id) ?? [];
          // Before the first known movement the account's history is unknown.
          const first = a.sourceKind === 'manual' ? a.anchorDate : f.map((x) => x.date).sort()[0] ?? a.anchorDate;
          if (!first || d < first) return null;
          return this.balanceOf(a, f, d);
        }),
      }));
  }

  monthEndBalances(months: YearMonth[]) {
    const today = this.today();
    return this.balancesAt(months.map((m) => (lastDayOfMonth(m) > today ? today : lastDayOfMonth(m))));
  }

  /** Money in current and savings accounts (included in net worth), today. */
  liquidCents(): number | null {
    const list = this.list().filter((a) => a.includeInNetWorth && (a.kind === 'current' || a.kind === 'savings') && a.balanceCents !== null);
    return list.length ? list.reduce((t, a) => t + a.balanceCents!, 0) : null;
  }

  // ───────── Editing ─────────

  update(input: { id: number; name?: string; kind?: AccountKind; includeInNetWorth?: boolean; annualRateBp?: number | null; ownTransferTarget?: boolean }): void {
    this.repos.accounts.update(input.id, input);
    if (input.ownTransferTarget !== undefined) this.refreshTransfers();
  }

  setBalance(id: number, balanceCents: number, date: IsoDate): void {
    if (date > this.today()) throw new AppError('VALIDATION', 'La fecha del saldo no puede ser futura.');
    this.repos.accounts.setAnchor(id, balanceCents, date, 'user');
  }

  createManual(input: { name: string; bank: string; kind: AccountKind; balanceCents: number; date: IsoDate; annualRateBp: number | null; ownTransferTarget: boolean }): number {
    if (!input.name.trim()) throw new AppError('VALIDATION', 'Ponle un nombre a la cuenta.');
    const id = this.repos.accounts.createManual(input);
    if (input.ownTransferTarget) this.refreshTransfers();
    return id;
  }

  merge(fromId: number, intoId: number): void {
    this.repos.accounts.merge(fromId, intoId);
    this.refreshTransfers();
  }

  deleteManual(id: number): void {
    this.repos.accounts.delete(id);
    this.refreshTransfers();
  }

  // ───────── Transfers ─────────

  transferContext(): TransferContext {
    const profile = this.repos.settings.getSettings().profile;
    const decisions = new Map(this.repos.accounts.counterparties().map((c) => [c.key, c]));
    return {
      decisions,
      ownerKeys: profile.ownerNames.map(normalizeText).filter((n) => n.split(' ').length >= 2),
      partnerKey: profile.partnerName ? normalizeText(profile.partnerName) || null : null,
      defaultOwnAccountId: this.repos.accounts.list().find((a) => a.ownTransferTarget)?.id ?? null,
    };
  }

  categoryFor(ref: TransferRefinement): number | null {
    if (ref.categoryId) return ref.categoryId;
    return ref.categoryKey ? this.repos.categories.idByKey(ref.categoryKey) : null;
  }

  private transferRows(): TransferRow[] {
    return this.repos.db.all<TransferRow>(
      `SELECT t.id, t.description_raw, t.description_normalized, t.amount_cents, t.type, t.category_id, t.category_locked, t.account_id,
              t.transfer_match_id, t.counter_account_id, m.key AS merchant_key, s.kind AS statement_kind, t.date
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN statements s ON s.document_id = t.document_id`,
    );
  }

  /**
   * Re-applies the transfer model to every movement the user has not fixed by hand: base semantics, counterparty
   * decisions and profile names, then pairs of transfers between imported accounts. Returns movements changed.
   */
  refreshTransfers(): number {
    const ctx = this.transferContext();
    const accountNames = new Map(this.repos.accounts.list(true).map((a) => [a.id, a.name]));
    let changed = 0;
    this.repos.db.transaction(() => {
      const rows = this.transferRows();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const target = new Map<number, { type: TransactionType; categoryId: number; source: 'HEURISTIC' | 'USER' | 'MERCHANT' | 'RULE' | 'UNKNOWN'; confidence: number; detail: string; ruleId: number | null; counter: number | null; match: number | null }>();

      for (const r of rows) {
        if (r.category_locked === 1) continue;
        const amount = Number(r.amount_cents);
        const transferish = !!hasKeyword(r.description_normalized, PERSON_TRANSFER) || !!hasKeyword(r.description_normalized, INTERNAL_TRANSFER);
        if (!transferish && r.transfer_match_id === null && r.counter_account_id === null) continue;
        const base = inferTransactionType(r.description_normalized, amount, r.statement_kind ?? 'account');
        const ref = refineTransfer(r.description_raw, r.description_normalized, amount, ctx);
        const refCategory = ref ? this.categoryFor(ref) : null;
        const type = ref && refCategory !== null ? this.categorization.alignType(ref.type, amount, this.repos.categories.get(refCategory)) : ref?.type ?? base.type;
        if (refCategory !== null) {
          target.set(r.id, { type, categoryId: refCategory, source: 'HEURISTIC', confidence: 0.9, detail: ref!.detail, ruleId: null, counter: ref!.counterAccountId, match: null });
        } else {
          const known = r.merchant_key ? findKnownMerchant(r.merchant_key) : null;
          const c = this.categorization.classify(r.description_normalized, r.merchant_key ? { key: r.merchant_key, known } : null, type);
          const aligned = c.source === 'USER' ? this.categorization.alignType(type, amount, this.repos.categories.get(c.categoryId)) : type;
          target.set(r.id, { type: aligned, categoryId: c.categoryId, source: c.source, confidence: c.confidence, detail: c.detail, ruleId: c.ruleId, counter: null, match: null });
        }
      }

      // Pairs between two imported accounts (both legs visible).
      const pairs = matchInternalPairs(
        rows
          .filter((r) => r.account_id !== null && r.category_locked === 0)
          .filter((r) => {
            const t = target.get(r.id)?.type ?? r.type;
            return t !== 'fee' && t !== 'cash_withdrawal';
          })
          .map((r) => ({
            id: r.id,
            accountId: r.account_id,
            date: r.date,
            amountCents: Number(r.amount_cents),
            transferish: !!hasKeyword(r.description_normalized, PERSON_TRANSFER) || !!hasKeyword(r.description_normalized, INTERNAL_TRANSFER),
            locked: false,
          })),
      );
      const transfersId = this.repos.categories.idByKey('transfers');
      for (const [a, b] of pairs) {
        const ra = byId.get(a)!;
        const rb = byId.get(b)!;
        const detail = `Traspaso entre tus cuentas: ${accountNames.get(ra.account_id!) ?? '?'} → ${accountNames.get(rb.account_id!) ?? '?'}`;
        target.set(a, { type: 'transfer', categoryId: transfersId, source: 'HEURISTIC', confidence: 0.95, detail, ruleId: null, counter: rb.account_id, match: b });
        target.set(b, { type: 'transfer', categoryId: transfersId, source: 'HEURISTIC', confidence: 0.95, detail, ruleId: null, counter: ra.account_id, match: a });
      }

      for (const [id, t] of target) {
        const r = byId.get(id)!;
        if (r.type === t.type && r.category_id === t.categoryId && r.counter_account_id === t.counter && r.transfer_match_id === t.match) continue;
        this.repos.transactions.setCategory(id, t.categoryId, t.source, t.confidence, t.detail, t.ruleId, false);
        this.repos.db.run('UPDATE transactions SET type = ?, counter_account_id = ?, transfer_match_id = ? WHERE id = ?', t.type, t.counter, t.match, id);
        changed++;
      }
    });
    return changed;
  }

  /** Runs once after updating to the new transfer model (existing data is reclassified; manual fixes are kept). */
  migrateIfNeeded(): number {
    const v = this.repos.settings.getRaw<number>('model.transfers') ?? 1;
    if (v >= TRANSFER_MODEL_VERSION) return 0;
    // 0.4.1: companies marked as "own account" (e.g. the employer paying the salary) go back to unreviewed.
    const wrong = this.repos.accounts.counterparties().filter((c) => c.role === 'own' && isCompanyName(c.key));
    for (const c of wrong) this.repos.accounts.deleteCounterparty(c.key);
    const n = this.refreshCapital() + this.refreshTransfers();
    this.repos.settings.setRaw('model.transfers', TRANSFER_MODEL_VERSION);
    return n;
  }

  /** Loan drawdowns and property operations (not fixed by hand) become neutral "Patrimonio y préstamos". */
  refreshCapital(): number {
    const capitalId = this.repos.categories.idByKey('capital');
    let changed = 0;
    this.repos.db.transaction(() => {
      const rows = this.repos.db.all<{ id: number; description_normalized: string; type: TransactionType; category_id: number }>(
        'SELECT id, description_normalized, type, category_id FROM transactions WHERE category_locked = 0',
      );
      for (const r of rows) {
        const k = hasKeyword(r.description_normalized, CAPITAL);
        if (!k || (r.type === 'transfer' && r.category_id === capitalId)) continue;
        this.repos.transactions.setCategory(r.id, capitalId, 'HEURISTIC', 0.85, `Operación patrimonial («${k.toLowerCase()}»): préstamo, compra o venta de un bien`, null, false);
        this.repos.db.run("UPDATE transactions SET type = 'transfer' WHERE id = ?", r.id);
        changed++;
      }
    });
    return changed;
  }

  // ───────── Extraordinary movements ─────────

  /** Very large movements (≥ 10.000 €) that are still counted as spending or income: candidates to review. */
  extraordinary(): ExtraordinaryMovement[] {
    const confirmed = new Set(this.repos.settings.getRaw<number[]>('extraordinary.confirmed') ?? []);
    return this.repos.db
      .all<{ id: number; date: string; amount_cents: number; description_raw: string; type: TransactionType; category_name: string }>(
        `SELECT t.id, t.date, t.amount_cents, t.description_raw, t.type, c.name AS category_name FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.is_excluded = 0 AND ABS(t.amount_cents) >= ? AND t.type IN ('expense','income','refund','fee','cash_withdrawal') AND c.excluded_from_spending = 0
         ORDER BY t.date DESC`,
        EXTRAORDINARY_CENTS,
      )
      .filter((r) => !confirmed.has(r.id))
      .map((r) => ({ id: r.id, date: r.date, amountCents: Number(r.amount_cents), description: r.description_raw, type: r.type, categoryName: r.category_name }));
  }

  /** "Es patrimonio" → neutral category (kept as a manual fix); "Es real" → keep it and stop asking. */
  resolveExtraordinary(id: number, asCapital: boolean): void {
    if (asCapital) {
      const capitalId = this.repos.categories.idByKey('capital');
      this.repos.transactions.setCategory(id, capitalId, 'USER', 1, 'Marcado por ti como operación patrimonial', null, true);
      this.repos.db.run("UPDATE transactions SET type = 'transfer' WHERE id = ?", id);
    } else {
      const list = this.repos.settings.getRaw<number[]>('extraordinary.confirmed') ?? [];
      this.repos.settings.setRaw('extraordinary.confirmed', [...new Set([...list, id])]);
    }
  }

  // ───────── Counterparties ─────────

  /** People and accounts on the other side of your transfers, largest first, with what you decided about them. */
  counterparties(): CounterpartySummary[] {
    const decided = new Map(this.repos.accounts.counterparties().map((c) => [c.key, c]));
    const groups = new Map<string, CounterpartySummary>();
    const rows = this.repos.db.all<{ description_raw: string; amount_cents: number; date: string; type: TransactionType }>(
      `SELECT description_raw, amount_cents, date, type FROM transactions WHERE is_excluded = 0 AND transfer_match_id IS NULL`,
    );
    for (const r of rows) {
      const key = counterpartyKey(r.description_raw);
      if (!key) continue;
      const g = groups.get(key) ?? {
        key, displayName: displayName(key), sentCents: 0, receivedCents: 0, count: 0, lastDate: r.date, largestCents: 0, needsReview: false, isCompany: false,
        role: decided.get(key)?.role ?? null, accountId: decided.get(key)?.accountId ?? null, categoryId: decided.get(key)?.categoryId ?? null,
      };
      const a = Number(r.amount_cents);
      if (a < 0) g.sentCents += -a;
      else g.receivedCents += a;
      g.largestCents = Math.max(g.largestCents, Math.abs(a));
      g.count++;
      if (r.date > g.lastDate) g.lastDate = r.date;
      groups.set(key, g);
    }
    for (const d of decided.values()) {
      if (!groups.has(d.key)) groups.set(d.key, { key: d.key, displayName: d.displayName, sentCents: 0, receivedCents: 0, count: 0, lastDate: '', largestCents: 0, role: d.role, accountId: d.accountId, categoryId: d.categoryId, needsReview: false, isCompany: false });
    }
    for (const g of groups.values()) {
      g.needsReview = g.role === null && g.largestCents >= LARGE_TRANSFER_CENTS && g.sentCents > 0;
      g.isCompany = isCompanyName(g.key);
    }
    return [...groups.values()].sort((a, b) => b.sentCents + b.receivedCents - (a.sentCents + a.receivedCents));
  }

  decideCounterparty(input: { key: string; displayName?: string; role: CounterpartyRole | null; accountId: number | null; categoryId: number | null }): number {
    if (input.role === null) this.repos.accounts.deleteCounterparty(input.key);
    else {
      if (input.role === 'own' && isCompanyName(input.key)) {
        throw new AppError('VALIDATION', 'Una empresa no puede ser una cuenta tuya. Si te paga (por ejemplo tu nómina), elige «Otra persona o empresa»: contará como ingreso.');
      }
      if (input.role === 'own' && input.accountId !== null) this.repos.accounts.get(input.accountId);
      if (input.role === 'other' && input.categoryId !== null) this.repos.categories.get(input.categoryId);
      this.repos.accounts.setCounterparty({ key: input.key, displayName: input.displayName ?? displayName(input.key), role: input.role, accountId: input.accountId, categoryId: input.categoryId });
    }
    return this.refreshTransfers();
  }

  /** Short explanation of internal transfers that leave the tracked accounts (money moved to untracked accounts of yours). */
  untrackedOwnTransfers(from: IsoDate, to: IsoDate): { outCents: number; count: number } {
    const r = this.repos.db.get<{ n: number; total: number | null }>(
      `SELECT COUNT(*) AS n, SUM(-amount_cents) AS total FROM transactions
       WHERE type = 'transfer' AND amount_cents < 0 AND transfer_match_id IS NULL AND counter_account_id IS NULL AND date >= ? AND date <= ?`,
      from, to,
    )!;
    return { outCents: Number(r.total ?? 0), count: Number(r.n) };
  }

  describeAnchor(a: AccountDTO): string {
    if (!a.anchor) return 'Saldo desconocido: indícalo una vez y Hormiga lo mantendrá con tus movimientos.';
    return `${a.anchor.source === 'user' ? 'Saldo indicado por ti' : 'Saldo impreso en el extracto'} el ${a.anchor.date}: ${formatCents(a.anchor.balanceCents)}.`;
  }
}

function displayName(key: string): string {
  return key.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
