import type { FinancialProfile } from '../../shared/types';

/**
 * Recommended size of the emergency fund, in months of essential spending, from the user's situation.
 * Common guidance is 3–6 months; more when income is less predictable or others depend on you.
 */
export function recommendedEmergencyMonths(p: FinancialProfile): { months: number; reasons: string[] } {
  let months = 3;
  const reasons: string[] = ['base de 3 meses'];
  if (p.incomeStability === 'variable') {
    months += 2;
    reasons.push('+2 por ingresos variables');
  } else if (p.incomeStability === 'self_employed') {
    months += 3;
    reasons.push('+3 por ser autónomo/a');
  }
  if (p.dependents > 0) {
    const extra = Math.min(3, p.dependents);
    months += extra;
    reasons.push(`+${extra} por ${p.dependents === 1 ? 'una persona a tu cargo' : `${p.dependents} personas a tu cargo`}`);
  }
  if (p.housing === 'mortgage') {
    months += 1;
    reasons.push('+1 por tener hipoteca');
  }
  if (p.household === 'single' && p.dependents === 0 && p.incomeStability !== 'self_employed') {
    reasons.push('vives solo/a: nadie más aporta ingresos');
    months += 1;
  }
  return { months: Math.min(12, months), reasons };
}

export function hasProfile(p: FinancialProfile): boolean {
  return p.household !== null || p.housing !== null || p.incomeStability !== null || p.ownerNames.length > 0 || p.goals.length > 0;
}
