import { parseAmountToCents } from '../../shared/money';
import { parseSpanishDate, toIso } from '../../shared/dates';
import { normalizeText } from '../domain/merchant';
import { AppError } from '../errors';
import type { Cell, ExtractedDocument, ParsedStatement, RawTransaction, StatementParser } from './types';

/*
 * Movements exported as a table by Spanish banks (Excel .xls/.xlsx, ".xls" that are really HTML tables, or CSV).
 * The header row is located dynamically (banks add preamble rows with IBAN, holder, balance…), columns are mapped
 * by name, and the bank is identified from header fingerprints and markers in the file.
 *
 * Formats researched from public documentation and open-source importers (no real data):
 *  - CaixaBank / imagin: .xls (BIFF), header on row 3: Fecha · Fecha valor · Movimiento · Más datos · Importe · Saldo
 *  - Sabadell: .xls, dates as Excel serials: F. Operativa · Concepto · F. Valor · Importe · Saldo · Referencia 1 · Referencia 2
 *  - Santander / Openbank: .xls (often HTML) with ~7 preamble rows: Fecha Operación · Fecha Valor · Concepto · Importe · Saldo
 *  - ING: F. Valor · Categoría · Subcategoría · Descripción · Comentario · Importe (€) · Saldo (€)
 *  - BBVA (Excel): F.Valor · Fecha · Concepto · Movimiento · Importe · Divisa · Disponible · Observaciones
 *  - N26 (CSV): Fecha · Beneficiario · Número de cuenta · Tipo de transacción · Referencia de pago · Categoría ·
 *    Cantidad (EUR) · … (ISO dates, dot decimals)
 *  - Revolut (CSV): Type · Product · Started Date · Completed Date · Description · Amount · Fee · Currency · State ·
 *    Balance (dot decimals; reverted, declined and pending rows are not movements; the fee is charged on top)
 */

type Column = 'date' | 'valueDate' | 'description' | 'secondary' | 'detail' | 'amount' | 'debit' | 'credit' | 'balance' | 'fee' | 'state';

const ALIASES: Record<Column, string[]> = {
  date: ['COMPLETED DATE', 'FECHA DE FINALIZACION', 'FECHA COMPLETADA', 'FECHA', 'F OPERACION', 'FECHA OPERACION', 'FECHA DE OPERACION', 'F OPERATIVA', 'FECHA OPERATIVA', 'FECHA CONTABLE', 'FECHA OPER', 'DATE', 'BOOKING DATE', 'FECHA MOVIMIENTO'],
  valueDate: ['FECHA VALOR', 'F VALOR', 'FVALOR', 'VALUE DATE', 'STARTED DATE', 'FECHA DE INICIO'],
  description: ['CONCEPTO', 'DESCRIPCION', 'DESCRIPTION', 'DETALLE', 'CONCEPTO MOVIMIENTO', 'MOVIMIENTO', 'BENEFICIARIO', 'PAYEE'],
  // "Movimiento" is secondary when a "Concepto" column also exists (BBVA Excel: Concepto = merchant, Movimiento = kind).
  secondary: ['MOVIMIENTO'],
  detail: ['MAS DATOS', 'OBSERVACIONES', 'COMENTARIO', 'BENEFICIARIO ORDENANTE', 'INFORMACION ADICIONAL', 'CONCEPTO AMPLIADO', 'REFERENCIA DE PAGO', 'PAYMENT REFERENCE'],
  amount: ['IMPORTE', 'IMPORTE EUR', 'IMPORTE EUROS', 'CANTIDAD', 'CANTIDAD EUR', 'AMOUNT', 'AMOUNT EUR'],
  debit: ['CARGO', 'CARGOS', 'DEBE', 'GASTO', 'GASTOS'],
  credit: ['ABONO', 'ABONOS', 'HABER', 'INGRESO', 'INGRESOS'],
  balance: ['SALDO', 'SALDO EUR', 'SALDO DISPONIBLE', 'DISPONIBLE', 'BALANCE'],
  fee: ['FEE', 'COMISION'],
  state: ['STATE', 'ESTADO'],
};

/** Rows that are not (yet) movements: reverted, declined or pending operations (Revolut, N26…). */
const NOT_BOOKED = new Set(['REVERTED', 'DECLINED', 'FAILED', 'PENDING', 'CANCELLED', 'REVERTIDA', 'REVERTIDO', 'RECHAZADA', 'RECHAZADO', 'PENDIENTE', 'CANCELADA', 'CANCELADO', 'FALLIDA']);

type Mapping = Partial<Record<Column, number>>;

export function mapHeader(row: Cell[]): Mapping | null {
  const map: Mapping = {};
  row.forEach((cell, idx) => {
    if (typeof cell !== 'string') return;
    const n = normalizeText(cell);
    if (!n) return;
    // "Movimiento" becomes the description only if no "Concepto"/"Descripción" column exists; decided below.
    if (n === 'MOVIMIENTO') {
      if (map.secondary === undefined) map.secondary = idx;
      return;
    }
    for (const col of Object.keys(ALIASES) as Column[]) {
      if (col === 'secondary' || map[col] !== undefined) continue;
      if (ALIASES[col].includes(n)) {
        map[col] = idx;
        return;
      }
    }
  });
  if (map.description === undefined && map.secondary !== undefined) {
    map.description = map.secondary;
    delete map.secondary;
  }
  const hasAmount = map.amount !== undefined || (map.debit !== undefined && map.credit !== undefined);
  // Some exports (ING) only have "F. Valor": use it as the movement date.
  if (map.date === undefined && map.valueDate !== undefined) {
    map.date = map.valueDate;
    delete map.valueDate;
  }
  if (map.date === undefined || map.description === undefined || !hasAmount) return null;
  return map;
}

interface BankProfile {
  bank: string;
  /** Header fingerprint (normalized header cells that must all exist). */
  headers: string[];
  /** Markers searched in the file text (preamble cells, sheet names, raw HTML). */
  markers?: RegExp;
}

// Order matters: the most specific fingerprints first.
const PROFILES: BankProfile[] = [
  { bank: 'Sabadell', headers: ['F OPERATIVA', 'CONCEPTO', 'IMPORTE'], markers: /sabadell/i },
  { bank: 'CaixaBank / imagin', headers: ['MOVIMIENTO', 'MAS DATOS', 'IMPORTE'], markers: /caixabank|la caixa|imagin/i },
  { bank: 'ING', headers: ['F VALOR', 'DESCRIPCION', 'IMPORTE'], markers: /\bING\b|ing direct/i },
  { bank: 'BBVA', headers: ['CONCEPTO', 'MOVIMIENTO', 'IMPORTE', 'DISPONIBLE'], markers: /\bBBVA\b/i },
  { bank: 'Openbank', headers: ['FECHA OPERACION', 'CONCEPTO', 'IMPORTE'], markers: /open ?bank/i },
  { bank: 'Santander', headers: ['FECHA OPERACION', 'CONCEPTO', 'IMPORTE'], markers: /santander/i },
  { bank: 'Bankinter', headers: ['FECHA CONTABLE', 'FECHA VALOR', 'DESCRIPCION', 'IMPORTE'], markers: /bankinter/i },
  { bank: 'Revolut', headers: ['COMPLETED DATE', 'DESCRIPTION', 'AMOUNT', 'STATE'], markers: /revolut/i },
  { bank: 'N26', headers: ['BENEFICIARIO', 'CANTIDAD EUR'], markers: /\bN26\b/ },
];

const TEXT_ONLY_MARKERS: [string, RegExp][] = [
  ['imagin', /\bimagin(bank)?\b/i],
  ['CaixaBank / imagin', /caixabank|la caixa/i],
  ['Sabadell', /sabadell/i],
  ['Openbank', /open ?bank/i],
  ['Santander', /santander/i],
  ['BBVA', /\bBBVA\b/i],
  ['ING', /ing direct|\bING\b/],
  ['Bankinter', /bankinter/i],
  ['Unicaja', /unicaja/i],
  ['Abanca', /abanca/i],
  ['Kutxabank', /kutxabank/i],
  ['Cajamar', /cajamar/i],
  ['Revolut', /revolut/i],
  ['N26', /\bN26\b/],
];

export function identifyBank(headerRow: Cell[], text: string): string {
  const headers = new Set(headerRow.filter((c): c is string => typeof c === 'string').map(normalizeText));
  // A marker in the file wins when both a marker and a matching fingerprint agree (Santander vs Openbank share headers).
  const byHeaders = PROFILES.filter((p) => p.headers.every((h) => headers.has(h)));
  for (const p of byHeaders) if (p.markers?.test(text)) return p.bank === 'CaixaBank / imagin' && /\bimagin/i.test(text) ? 'imagin' : p.bank;
  for (const [bank, re] of TEXT_ONLY_MARKERS) if (re.test(text)) return bank;
  return byHeaders[0]?.bank ?? 'Otro banco';
}

export interface ExcelDateOptions {
  date1904?: boolean;
}

/** Excel serial date → ISO (1900 system with the Lotus leap-year bug, or 1904 system). */
export function excelSerialToIso(serial: number, opts: ExcelDateOptions = {}): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const days = Math.floor(serial) + (opts.date1904 ? 1462 : 0);
  // 25569 = days between 1899-12-30 and 1970-01-01 (1900 system incl. the fictitious 29/02/1900).
  const ms = (days - 25569) * 86_400_000;
  const d = new Date(ms);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function cellToDate(cell: Cell, opts: ExcelDateOptions): string | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return toIso(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
  if (typeof cell === 'number') return excelSerialToIso(cell, opts);
  const s = String(cell).trim();
  if (!s) return null;
  return parseSpanishDate(s) ?? parseSpanishDate(s.split(' ')[0] ?? '');
}

/** Numeric cells are exact enough for cents (bank exports have ≤2 decimals); text uses Spanish parsing. */
export function cellToCents(cell: Cell): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.round(cell * 100) : null;
  return parseAmountToCents(String(cell));
}

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/\s+/g, ' ').trim();
}

/** CaixaBank adds "Fecha de operación: DD-MM-YYYY" to "Más datos": noise for the description. */
function cleanDetail(text: string): string {
  return text
    .replace(/fecha de operaci[oó]n:?\s*\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')
    .trim();
}

export class BankTableParser implements StatementParser {
  readonly id = 'tabla-bancaria-v1';
  readonly bank = 'Tabla';

  detect(doc: ExtractedDocument): number {
    if (!doc.table) return 0;
    return doc.table.slice(0, 40).some((r) => mapHeader(r)) ? 0.9 : 0;
  }

  parse(doc: ExtractedDocument): ParsedStatement {
    const rows = doc.table ?? [];
    let headerIdx = -1;
    let map: Mapping | null = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      map = mapHeader(rows[i]!);
      if (map) {
        headerIdx = i;
        break;
      }
    }
    if (!map) {
      throw new AppError('UNKNOWN_FORMAT', `No se encontró la cabecera de movimientos en «${doc.fileName}». Se necesitan columnas de fecha, concepto e importe (o cargo/abono).`);
    }
    const cols = map;
    const header = rows[headerIdx]!;
    const preambleText = rows.slice(0, headerIdx).flat().map(cellText).join(' ');
    const bank = identifyBank(header, `${preambleText} ${doc.rawText ?? ''} ${doc.fileName}`);
    const dateOpts: ExcelDateOptions = { date1904: doc.date1904 };

    const transactions: RawTransaction[] = [];
    const issues: string[] = [];
    let emptyStreak = 0;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i]!;
      const get = (c: Column): Cell => (cols[c] !== undefined ? (r[cols[c]!] ?? null) : null);
      const dateCell = get('date');
      const description = cellText(get('description'));
      if (cols.state !== undefined && NOT_BOOKED.has(normalizeText(cellText(get('state'))))) continue;
      let amountCents = cellToCents(get('amount'));
      const fee = cols.fee !== undefined ? cellToCents(get('fee')) : null;
      if (amountCents !== null && fee) amountCents -= Math.abs(fee);
      if (amountCents === null && cols.debit !== undefined && cols.credit !== undefined) {
        const debit = cellToCents(get('debit')) ?? 0;
        const credit = cellToCents(get('credit')) ?? 0;
        amountCents = debit === 0 && credit === 0 ? null : Math.abs(credit) - Math.abs(debit);
      }
      if (!cellText(dateCell) && !description && amountCents === null) {
        // Tables end with blank rows followed by footers (totals, legal text): stop after a few blanks.
        if (++emptyStreak >= 3) break;
        continue;
      }
      emptyStreak = 0;
      const date = cellToDate(dateCell, dateOpts);
      // Footer rows ("Total", "Saldo final", legal text…) have no valid date and/or no amount: they are not movements.
      if (!date && /^(total|saldo|suma|importe total)/i.test(cellText(dateCell) || description)) continue;
      if (!date && amountCents === null) continue;
      const secondary = cellText(get('secondary'));
      const detail = cleanDetail([secondary, cellText(get('detail'))].filter(Boolean).join(' · '));
      const balance = cellToCents(get('balance'));
      transactions.push({
        page: 1,
        line: i + 1,
        rawText: r.map(cellText).filter(Boolean).join(' | '),
        dateRaw: date ?? cellText(dateCell),
        valueDateRaw: cellToDate(get('valueDate'), dateOpts),
        descriptionRaw: description,
        detailRaw: detail || null,
        amountRaw: amountCents === null ? cellText(get('amount')) : centsToRaw(amountCents),
        balanceRaw: balance === null ? null : centsToRaw(balance),
      });
    }
    if (transactions.length === 0) issues.push('La tabla no contiene movimientos.');
    const withBalance = transactions.filter((t) => t.balanceRaw !== null).length;
    const dates = transactions.map((t) => parseSpanishDate(t.dateRaw) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t.dateRaw) ? t.dateRaw : null)).filter((d): d is string => !!d).sort();
    const iban = /\b[A-Z]{2}\d{2}(?:[ ]?[\dA-Z]{4}){4,7}\b/.exec(preambleText.replace(/-/g, ' '));
    return {
      parserId: this.id,
      bank,
      kind: 'account',
      signConvention: 'charges_negative',
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      accountHint: iban ? iban[0].replace(/\s/g, '').slice(-4) : null,
      declaredTotalCents: null,
      openingBalanceCents: null,
      closingBalanceCents: null,
      transactions,
      issues,
      verifiedByBalances: transactions.length > 0 && withBalance >= transactions.length * 0.6,
    };
  }
}

function centsToRaw(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
