import { addDays } from '../../src/shared/dates';
import type { DailyClose } from '../../src/core/domain/stocks';

/** 250 sessions rising from 100 to 200, then 10 sessions falling to 175. */
export function dipSeries(start = '2025-06-01'): DailyClose[] {
  const out: DailyClose[] = [];
  for (let i = 0; i < 250; i++) out.push({ date: addDays(start, i), close: 100 + (100 * i) / 249 });
  for (let k = 1; k <= 10; k++) out.push({ date: addDays(start, 249 + k), close: 200 - 2.5 * k });
  return out;
}
