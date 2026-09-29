import { describe, expect, it } from 'vitest';
import { normalizeMerchant, normalizeText } from '../../src/core/domain/merchant';

describe('normalizeText', () => {
  it('uppercases, strips accents and punctuation', () => {
    expect(normalizeText('  Pagó en  Cafetería "El Rincón", S.L. ')).toBe('PAGO EN CAFETERIA EL RINCON S L');
  });
});

describe('normalizeMerchant', () => {
  it.each([
    'MERCADONA 1234 BARCELONA',
    'MERCADONA ES 00456',
    'MERCADONA',
    'COMPRA TARJ. 4B MERCADONA 1234 MADRID',
    'PAGO CON TARJETA MERCADONA S.A.',
  ])('groups "%s" as Mercadona', (raw) => {
    const m = normalizeMerchant(raw);
    expect(m.key).toBe('MERCADONA');
    expect(m.display).toBe('Mercadona');
  });

  it('recognises aliases of known merchants', () => {
    expect(normalizeMerchant('AMZN MKTP ES*2K4 AMAZON.ES').display).toBe('Amazon');
    expect(normalizeMerchant('PAYPAL *NETFLIX').display).toBe('Netflix');
    expect(normalizeMerchant('REPSOL E.S. 5521 ALCOBENDAS').display).toBe('Repsol');
    expect(normalizeMerchant('APPLE.COM/BILL ITUNES.COM').known?.subscription).toBe(true);
  });

  it('cleans unknown merchants: prefixes, reference numbers, legal suffixes and trailing cities', () => {
    const m = normalizeMerchant('PAGO EN BAR LA ESQUINA 004512 S.L. MADRID');
    expect(m.key).toBe('BAR LA ESQUINA');
    expect(m.display).toBe('Bar la Esquina');
    expect(m.known).toBeNull();
  });

  it('keeps a stable key for the same merchant with different noise', () => {
    const a = normalizeMerchant('TIENDA DEL BARRIO LUNA 1234');
    const b = normalizeMerchant('COMPRA TIENDA DEL BARRIO LUNA 9876 VALENCIA');
    expect(a.key).toBe(b.key);
  });

  it('does not match short aliases in the middle of other words', () => {
    expect(normalizeMerchant('PAGO EN INDIANA JONES STORE').display).not.toBe('Dia');
    expect(normalizeMerchant('DIA 3421 MADRID').display).toBe('Dia');
  });
});
