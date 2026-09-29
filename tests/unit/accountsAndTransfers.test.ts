import { describe, expect, it } from 'vitest';
import { balanceAt, balanceWithInterest, interestBetween } from '../../src/core/domain/accounts';
import { counterpartyKey, LARGE_TRANSFER_CENTS, matchInternalPairs, refineTransfer, type TransferContext } from '../../src/core/domain/transfers';
import { normalizeText } from '../../src/core/domain/merchant';
import { recommendedEmergencyMonths } from '../../src/core/domain/profile';
import { DEFAULT_PROFILE } from '../../src/core/db/settingsRepo';

const ctx = (over: Partial<TransferContext> = {}): TransferContext => ({ decisions: new Map(), ownerKeys: [], partnerKey: null, defaultOwnAccountId: null, ...over });
const refine = (raw: string, amount: number, c = ctx()) => refineTransfer(raw, normalizeText(raw), amount, c);

describe('counterparties of transfers', () => {
  it('reads the beneficiary from the detail, not from Bizum concepts', () => {
    expect(counterpartyKey('Transferencia realizada · Ana García López')).toBe('ANA GARCIA LOPEZ');
    expect(counterpartyKey('Transferencia recibida · De Empresa Ficticia S.L.U.')).toBe('EMPRESA FICTICIA S L U');
    expect(counterpartyKey('Bizum · ENVIADO: cena')).toBeNull();
    expect(counterpartyKey('Mercadona · Pago con tarjeta')).toBeNull();
  });
});

describe('transfer refinement', () => {
  it('transfers to your own name are neutral and go to your default account', () => {
    const r = refine('Transferencia realizada · Juan Pérez Ruiz', -50000, ctx({ ownerKeys: ['JUAN PEREZ RUIZ'], defaultOwnAccountId: 7 }));
    expect(r).toMatchObject({ type: 'transfer', categoryKey: 'transfers', counterAccountId: 7 });
  });

  it('the decision about a beneficiary wins: own (with account), partner, other (with category)', () => {
    const decisions = new Map([
      ['ANA GARCIA', { key: 'ANA GARCIA', role: 'partner' as const, accountId: null, categoryId: null }],
      ['CASERO SL', { key: 'CASERO SL', role: 'other' as const, accountId: null, categoryId: 12 }],
      ['JUAN PEREZ', { key: 'JUAN PEREZ', role: 'own' as const, accountId: 3, categoryId: null }],
    ]);
    const c = ctx({ decisions });
    expect(refine('Transferencia realizada · Ana Garcia', -30000, c)).toMatchObject({ type: 'expense', categoryKey: 'shared' });
    expect(refine('Transferencia recibida · Ana Garcia', 30000, c)).toMatchObject({ type: 'refund', categoryKey: 'shared' });
    expect(refine('Transferencia realizada · Casero SL', -70000, c)).toMatchObject({ type: 'expense', categoryId: 12 });
    expect(refine('Transferencia realizada · Juan Perez', -150000, c)).toMatchObject({ type: 'transfer', counterAccountId: 3 });
  });

  it('large transfers to unreviewed beneficiaries are assumed to be yours (liquidity kept); small ones are spending', () => {
    expect(refine('Transferencia realizada · Alguien Desconocido', -LARGE_TRANSFER_CENTS)).toMatchObject({ type: 'transfer', assumed: true });
    expect(refine('Transferencia realizada · Alguien Desconocido', -9999)).toBeNull();
    expect(refine('Bizum · ENVIADO: viaje', -200000)).toBeNull();
    expect(refine('Compra en tienda', -200000)).toBeNull();
  });
});

describe('internal transfer pairs between imported accounts', () => {
  const row = (id: number, accountId: number, date: string, amountCents: number, transferish = true) => ({ id, accountId, date, amountCents, transferish, locked: false });
  it('pairs opposite amounts in different accounts within 4 days, closest first, each leg once', () => {
    const pairs = matchInternalPairs([
      row(1, 1, '2026-09-01', -50000),
      row(2, 2, '2026-09-02', 50000),
      row(3, 2, '2026-09-04', 50000),
      row(4, 1, '2026-09-10', -30000),
      row(5, 1, '2026-09-10', 30000), // same account: never a pair
      row(6, 2, '2026-09-20', 30000), // too late
      row(7, 1, '2026-09-21', -1000, false),
      row(8, 2, '2026-09-21', 1000, false), // neither side looks like a transfer
    ]);
    expect(pairs).toEqual([[1, 2]]);
  });
});

describe('account balances', () => {
  const flows = [
    { date: '2026-09-02', amountCents: -1000 },
    { date: '2026-09-05', amountCents: 5000 },
    { date: '2026-09-10', amountCents: -2000 },
  ];
  it('derives any day from a known end-of-day balance, forwards and backwards', () => {
    const anchor = { balanceCents: 10000, date: '2026-09-05' };
    expect(balanceAt(anchor, flows, '2026-09-05')).toBe(10000);
    expect(balanceAt(anchor, flows, '2026-09-30')).toBe(8000);
    expect(balanceAt(anchor, flows, '2026-09-03')).toBe(5000);
    expect(balanceAt(anchor, flows, '2026-09-01')).toBe(6000);
  });

  it('remunerated manual accounts accrue interest on balance and transfers', () => {
    const anchor = { balanceCents: 1000000, date: '2025-01-01' };
    expect(balanceWithInterest(anchor, [], 300, '2026-01-01')).toBe(1030000);
    const withTransfer = balanceWithInterest(anchor, [{ date: '2025-07-02', amountCents: 100000 }], 300, '2026-01-01');
    expect(withTransfer).toBeGreaterThan(1130000);
    expect(withTransfer).toBeLessThan(1132000);
    expect(interestBetween(anchor, [], 300, '2025-01-01', '2026-01-01')).toBe(30000);
    expect(balanceWithInterest(anchor, [], null, '2026-01-01')).toBe(1000000);
  });
});

describe('recommended emergency fund', () => {
  it('grows with variable income, dependents and a mortgage', () => {
    expect(recommendedEmergencyMonths(DEFAULT_PROFILE).months).toBe(3);
    expect(recommendedEmergencyMonths({ ...DEFAULT_PROFILE, household: 'single' }).months).toBe(4);
    const r = recommendedEmergencyMonths({ ...DEFAULT_PROFILE, incomeStability: 'self_employed', dependents: 2, housing: 'mortgage', household: 'family' });
    expect(r.months).toBe(9);
    expect(r.reasons.join(' ')).toMatch(/autónomo.*a tu cargo.*hipoteca/);
    expect(recommendedEmergencyMonths({ ...DEFAULT_PROFILE, incomeStability: 'self_employed', dependents: 9, housing: 'mortgage' }).months).toBeLessThanOrEqual(12);
  });
});

describe('transfers to own savings by concept', () => {
  it('go to the default own account; card settlements do not', () => {
    const c = ctx({ defaultOwnAccountId: 9 });
    expect(refine('TRANSFERENCIA A CUENTA AHORRO PROPIA', -20000, c)).toMatchObject({ type: 'transfer', counterAccountId: 9 });
    expect(refine('Traspaso a otra cuenta · Cuenta ahorro', -50000, c)).toMatchObject({ type: 'transfer', counterAccountId: 9 });
    expect(refine('LIQUIDACION TARJETA CREDITO', -30000, c)).toBeNull();
  });
});

describe('companies are never your own account', () => {
  it('a salary by transfer from a company stays income even if it was marked as "own"', () => {
    const decisions = new Map([['EMPRESA FICTICIA S L U', { key: 'EMPRESA FICTICIA S L U', role: 'own' as const, accountId: 1, categoryId: null }]]);
    expect(refine('Transferencia recibida · De Empresa Ficticia S.L.U.', 88800, ctx({ decisions }))).toBeNull();
  });
});
