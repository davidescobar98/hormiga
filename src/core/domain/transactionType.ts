import type { TransactionType } from '../../shared/types';
import { normalizeText } from './merchant';

export type StatementKind = 'card' | 'account' | 'generic';

const K = (list: string[]) => list.map(normalizeText);

const REFUND = K(['DEVOLUCION', 'DEVOL', 'ABONO COMPRA', 'ABONO POR DEVOLUCION', 'REEMBOLSO', 'REFUND', 'ANULACION', 'RETROCESION', 'ABONO OPERACION']);
const FEE = K(['COMISION', 'COMISIONES', 'CUOTA TARJETA', 'CUOTA ANUAL', 'CUOTA MANTENIMIENTO', 'GASTOS MANTENIMIENTO', 'MANTENIMIENTO CUENTA', 'INTERESES DEUDORES', 'INTERESES TARJETA', 'INTERESES APLAZAMIENTO', 'RECARGO', 'COMISION CAMBIO DIVISA']);
const CASH = K(['CAJERO', 'REINTEGRO', 'DISPOSICION EFECTIVO', 'DISP EFECTIVO', 'RETIRADA EFECTIVO', 'RETIRADA DE EFECTIVO', 'DISPOSICION CAJERO', 'ATM', 'RET EFECTIVO', 'RET EFEC']);
const TRANSFER = K(['TRANSFERENCIA', 'TRANSF', 'TRASPASO', 'BIZUM', 'ENVIO DE DINERO', 'LIQUIDACION TARJETA', 'LIQUIDACION DE TARJETA', 'PAGO TARJETA CREDITO', 'PAGO TARJETA DE CREDITO', 'CARGO TARJETA CREDITO', 'AMORTIZACION TARJETA', 'APORTACION', 'INGRESO EN EFECTIVO', 'INGRESO EFECTIVO']);
/** Incoming transfer from a company (payroll, expenses paid by the employer…). */
const COMPANY = K(['S L', 'S L U', 'SL', 'SLU', 'S A', 'S A U', 'SA', 'SAU']);
const INCOME = K(['NOMINA', 'SALARIO', 'PENSION', 'PRESTACION', 'ABONO NOMINA', 'SUBSIDIO', 'HONORARIOS']);

function has(text: string, keywords: string[]): string | null {
  const padded = ` ${text} `;
  return keywords.find((k) => padded.includes(` ${k} `)) ?? null;
}

export interface TypeInference {
  type: TransactionType;
  reason: string;
}

/**
 * Infers the financial semantics of a movement from its sign and description.
 * `amountCents` uses the "money in positive / money out negative" convention.
 */
export function inferTransactionType(descriptionNormalized: string, amountCents: number, kind: StatementKind): TypeInference {
  const t = descriptionNormalized;
  if (amountCents < 0) {
    // Fees first: "COMISION RET. EFECTIVO" is a fee, not a withdrawal.
    let k = has(t, FEE);
    if (k) return { type: 'fee', reason: `Contiene «${k}»` };
    k = has(t, CASH);
    if (k) return { type: 'cash_withdrawal', reason: `Contiene «${k}»` };
    k = has(t, TRANSFER);
    if (k) return { type: 'transfer', reason: `Contiene «${k}»` };
    return { type: 'expense', reason: 'Importe con cargo' };
  }
  if (amountCents > 0) {
    let k = has(t, REFUND);
    if (k) return { type: 'refund', reason: `Contiene «${k}»` };
    k = has(t, INCOME);
    if (k) return { type: 'income', reason: `Contiene «${k}»` };
    k = has(t, TRANSFER);
    if (k && k.startsWith('TRANSF') && has(t, COMPANY)) return { type: 'income', reason: 'Transferencia recibida de una empresa' };
    if (k) return { type: 'transfer', reason: `Contiene «${k}»` };
    if (kind === 'card') return { type: 'refund', reason: 'Abono en extracto de tarjeta' };
    return { type: 'income', reason: 'Abono en cuenta' };
  }
  return { type: 'unknown', reason: 'Importe cero' };
}
