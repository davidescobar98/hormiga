import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, lastDayOfMonth, monthRange, parseSpanishDate } from '../../src/shared/dates';
import { makeYearInference } from '../../src/core/parsing/bbvaParser';

describe('parseSpanishDate', () => {
  it.each([
    ['03/01/2026', '2026-01-03'],
    ['3/1/26', '2026-01-03'],
    ['03-01-2026', '2026-01-03'],
    ['03.01.2026', '2026-01-03'],
    ['2026-01-03', '2026-01-03'],
    ['12 ENE 2026', '2026-01-12'],
    ['12-dic-25', '2025-12-12'],
    ['29/02/2024', '2024-02-29'],
  ])('%s → %s', (input, expected) => {
    expect(parseSpanishDate(input)).toBe(expected);
  });

  it.each(['31/02/2026', '00/01/2026', '32/01/2026', '12/13/2026', '29/02/2025', 'hola', ''])('rejects %s', (input) => {
    expect(parseSpanishDate(input)).toBeNull();
  });

  it('resolves dates without year from the statement period (December → January statements)', () => {
    const infer = makeYearInference('2025-12-15', '2026-01-14');
    expect(parseSpanishDate('20/12', infer)).toBe('2025-12-20');
    expect(parseSpanishDate('05/01', infer)).toBe('2026-01-05');
    expect(parseSpanishDate('05/01')).toBeNull();
  });
});

describe('calendar helpers', () => {
  it('months arithmetic', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-11', 3)).toBe('2026-02');
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
  });
  it('days arithmetic', () => {
    expect(daysBetween('2026-01-31', '2026-03-01')).toBe(29);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
