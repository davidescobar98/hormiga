import { describe, expect, it } from 'vitest';
import { centsToDecimalString, formatCents, mulDiv, parseAmountToCents, ratioBp, roundToEuros, sumCents } from '../../src/shared/money';

describe('parseAmountToCents', () => {
  it.each([
    ['1.234,56 €', 123456],
    ['1.234,56', 123456],
    ['-45,20', -4520],
    ['45,20-', -4520],
    ['+12,00 EUR', 1200],
    ['0,99', 99],
    ['12.345.678,90', 1234567890],
    ['1234,5', 123450],
    ['1234.56', 123456],
    ['(12,30)', -1230],
    ['−45,10', -4510],
    ['1 234,56 €', 123456],
    ['1.234', 123400],
    ['7', 700],
    ['EUR 3,10', 310],
  ])('parses %s', (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '1,2,3', '12,345,67', '--', '1.23.4', '12,3456'])('rejects %s', (input) => {
    expect(parseAmountToCents(input)).toBeNull();
  });

  it('never returns floats', () => {
    for (const s of ['0,10', '0,20', '0,30', '19,99', '1.000,01']) {
      expect(Number.isInteger(parseAmountToCents(s))).toBe(true);
    }
  });
});

describe('integer arithmetic', () => {
  it('0.1 + 0.2 has no floating point error in cents', () => {
    const a = parseAmountToCents('0,10')!;
    const b = parseAmountToCents('0,20')!;
    expect(sumCents([a, b])).toBe(30);
    expect(formatCents(sumCents([a, b]))).toMatch(/^0,30\s€$/);
  });

  it('sums thousands of small amounts exactly', () => {
    const values = Array.from({ length: 10000 }, () => 1); // 10.000 × 0,01 €
    expect(sumCents(values)).toBe(10000);
  });

  it('rejects non-integer cents', () => {
    expect(() => sumCents([1.5])).toThrow();
  });

  it('formats and converts', () => {
    expect(formatCents(123456)).toMatch(/^1\.234,56\s€$/);
    expect(formatCents(-4520)).toMatch(/^-45,20\s€$/);
    expect(formatCents(1200, { signed: true })).toMatch(/^\+12,00\s€$/);
    expect(centsToDecimalString(-4520)).toBe('-45,20');
    expect(centsToDecimalString(5)).toBe('0,05');
  });

  it('mulDiv, ratioBp and rounding', () => {
    expect(mulDiv(250000, 2000, 10000)).toBe(50000);
    expect(mulDiv(-101, 1, 2)).toBe(-51);
    expect(ratioBp(52000, 250000)).toBe(2080);
    expect(ratioBp(100, 0)).toBeNull();
    expect(roundToEuros(24800, 10)).toBe(25000);
  });
});
