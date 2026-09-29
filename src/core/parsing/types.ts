import type { StatementKind } from '../domain/transactionType';
import type { TransactionType } from '../../shared/types';
import type { IsoDate } from '../../shared/dates';

/** A spreadsheet/CSV cell as read from the file (numbers and dates keep their native type when the format has one). */
export type Cell = string | number | boolean | Date | null;

export type DocumentMime = 'application/pdf' | 'text/csv' | 'application/vnd.ms-excel' | 'text/x-norma43';

/** Content of a document: text lines per page (PDF, Norma 43) and/or a table (Excel, HTML tables, CSV). */
export interface ExtractedDocument {
  fileName: string;
  mimeType: DocumentMime;
  pages: string[][];
  /** Tabular documents: every row of the first sheet that contains a movements table. */
  table?: Cell[][];
  /** Raw text used to identify the bank (HTML source, sheet names…). Never persisted. */
  rawText?: string;
  /** Excel workbooks using the 1904 date system (old Mac files). */
  date1904?: boolean;
}

/** One movement exactly as found in the document, before any interpretation. */
export interface RawTransaction {
  page: number;
  line: number;
  rawText: string;
  dateRaw: string;
  valueDateRaw: string | null;
  descriptionRaw: string;
  /** Secondary text printed under the concept (merchant, payer, reference…), when the format has it. */
  detailRaw?: string | null;
  amountRaw: string;
  balanceRaw: string | null;
  /** Movement kind declared by the format itself (e.g. Norma 43 common concept codes). */
  typeHint?: TransactionType | null;
}

export type SignConvention =
  /** Charges printed as positive numbers (typical credit card statements). */
  | 'charges_positive'
  /** Charges printed as negative numbers (typical account statements and CSV exports). */
  | 'charges_negative';

export interface ParsedStatement {
  parserId: string;
  bank: string;
  kind: StatementKind;
  signConvention: SignConvention;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  /** Only the last 4 digits of a card/account number, never the full number. */
  accountHint: string | null;
  /** Net total of charges minus credits as declared by the document, in positive-charge convention. */
  declaredTotalCents: number | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  transactions: RawTransaction[];
  /** Non-fatal problems found while parsing (unrecognised lines, etc.). */
  issues: string[];
  /** Structural checks of the format that failed (e.g. control totals): the document goes to review. */
  integrityErrors?: string[];
  /** Every row carries a running balance, so amounts are verified row by row instead of against a total. */
  verifiedByBalances?: boolean;
}

export interface StatementParser {
  readonly id: string;
  readonly bank: string;
  /** Confidence 0..1 that this parser understands the document. */
  detect(doc: ExtractedDocument): number;
  parse(doc: ExtractedDocument): ParsedStatement;
}
