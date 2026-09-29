import type { TransactionType } from '../../shared/types';
import { normalizeText } from './merchant';

export type StatementKind = 'card' | 'account' | 'generic';

const K = (list: string[]) => list.map(normalizeText);

const REFUND = K(['DEVOLUCION', 'DEVOL', 'ABONO COMPRA', 'ABONO POR DEVOLUCION', 'REEMBOLSO', 'REFUND', 'ANULACION', 'RETROCESION', 'ABONO OPERACION']);
const FEE = K(['COMISION', 'COMISIONES', 'CUOTA TARJETA', 'CUOTA ANUAL', 'CUOTA MANTENIMIENTO', 'GASTOS MANTENIMIENTO', 'MANTENIMIENTO CUENTA', 'INTERESES DEUDORES', 'INTERESES TARJETA', 'INTERESES APLAZAMIENTO', 'RECARGO', 'COMISION CAMBIO DIVISA']);
const CASH = K(['CAJERO', 'REINTEGRO', 'DISPOSICION EFECTIVO', 'DISP EFECTIVO', 'RETIRADA EFECTIVO', 'RETIRADA DE EFECTIVO', 'DISPOSICION CAJERO', 'ATM', 'RET EFECTIVO', 'RET EFEC']);
/** Money that stays yours: moved between your own accounts, card settlements, contributions to your own products. */
export const INTERNAL_TRANSFER = K([
  'TRASPASO', 'TRASPASOS', 'ENTRE CUENTAS', 'CUENTA PROPIA', 'CUENTAS PROPIAS', 'A MI CUENTA', 'MISMA TITULARIDAD', 'CUENTA AHORRO',
  'CUENTA DE AHORRO', 'CUENTA REMUNERADA', 'HUCHA', 'LIQUIDACION TARJETA', 'LIQUIDACION DE TARJETA', 'PAGO TARJETA CREDITO',
  'PAGO TARJETA DE CREDITO', 'CARGO TARJETA CREDITO', 'AMORTIZACION TARJETA', 'APORTACION', 'INGRESO EN EFECTIVO', 'INGRESO EFECTIVO',
]);
/** Money that changes what you own rather than what you spend or earn: loan drawdowns, property deals… */
export const CAPITAL = K([
  'DISPOSICION DE PRESTAMO', 'DISPOSICION PRESTAMO', 'DISPOSICION DE CREDITO', 'ABONO PRESTAMO', 'ABONO DE PRESTAMO', 'FORMALIZACION PRESTAMO',
  'FORMALIZACION DE PRESTAMO', 'FORMALIZACION HIPOTECA', 'FORMALIZACION DE HIPOTECA', 'CANCELACION HIPOTECA', 'CANCELACION DE HIPOTECA',
  'CANCELACION PRESTAMO', 'CANCELACION DE PRESTAMO', 'COMPRAVENTA', 'ARRAS',
]);

/** Transfers and Bizum with other people: spending (out) or money received (in) unless they turn out to be yours. */
export const PERSON_TRANSFER = K(['TRANSFERENCIA', 'TRANSFERENCIAS', 'TRANSF', 'TRANSFER', 'BIZUM', 'ENVIO DE DINERO', 'ORDEN DE PAGO']);
/** Incoming transfer from a company (payroll, expenses paid by the employer…). */
const COMPANY = K(['S L', 'S L U', 'SL', 'SLU', 'S A', 'S A U', 'SA', 'SAU', 'S COOP', 'SOCIEDAD LIMITADA', 'SOCIEDAD ANONIMA']);

/** A company (S.L., S.A.…) can pay you or charge you, but it is never one of your own accounts. */
export function isCompanyName(normalized: string): boolean {
  return !!hasKeyword(normalized, COMPANY);
}
const INCOME = K(['NOMINA', 'SALARIO', 'PENSION', 'PRESTACION', 'ABONO NOMINA', 'SUBSIDIO', 'HONORARIOS']);

export function hasKeyword(text: string, keywords: string[]): string | null {
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
 * "transfer" means money moved between your own accounts (neutral for spending and savings). Transfers and Bizum
 * with other people are spending when sent and offset spending (Bizum) or count as income (transfers) when received;
 * the user's decisions about each beneficiary (own account, partner, other) refine this later.
 */
export function inferTransactionType(descriptionNormalized: string, amountCents: number, kind: StatementKind): TypeInference {
  const t = descriptionNormalized;
  const capital = hasKeyword(t, CAPITAL);
  if (capital && amountCents !== 0) return { type: 'transfer', reason: `Operación patrimonial («${capital}»): no es gasto ni ingreso` };
  if (amountCents < 0) {
    // Fees first: "COMISION RET. EFECTIVO" is a fee, not a withdrawal.
    let k = hasKeyword(t, FEE);
    if (k) return { type: 'fee', reason: `Contiene «${k}»` };
    k = hasKeyword(t, CASH);
    if (k) return { type: 'cash_withdrawal', reason: `Contiene «${k}»` };
    k = hasKeyword(t, INTERNAL_TRANSFER);
    if (k) return { type: 'transfer', reason: `Movimiento entre tus cuentas («${k}»)` };
    k = hasKeyword(t, PERSON_TRANSFER);
    if (k) return { type: 'expense', reason: `Pago a otra persona («${k}»)` };
    return { type: 'expense', reason: 'Importe con cargo' };
  }
  if (amountCents > 0) {
    let k = hasKeyword(t, REFUND);
    if (k) return { type: 'refund', reason: `Contiene «${k}»` };
    k = hasKeyword(t, INCOME);
    if (k) return { type: 'income', reason: `Contiene «${k}»` };
    k = hasKeyword(t, INTERNAL_TRANSFER);
    if (k) return { type: 'transfer', reason: `Movimiento entre tus cuentas («${k}»)` };
    k = hasKeyword(t, PERSON_TRANSFER);
    if (k === 'BIZUM') return { type: 'refund', reason: 'Bizum recibido: compensa gastos compartidos' };
    if (k && hasKeyword(t, COMPANY)) return { type: 'income', reason: 'Transferencia recibida de una empresa' };
    if (k) return { type: 'income', reason: `Dinero recibido de otra persona («${k}»)` };
    if (kind === 'card') return { type: 'refund', reason: 'Abono en extracto de tarjeta' };
    return { type: 'income', reason: 'Abono en cuenta' };
  }
  return { type: 'unknown', reason: 'Importe cero' };
}
