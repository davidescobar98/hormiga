export interface Row {
  date: string;
  valueDate?: string;
  desc: string;
  cont?: string[];
  amount: string;
  balance?: string;
}
export interface StatementSpec {
  kind?: 'card' | 'account';
  period?: [string, string];
  pages: Row[][];
  total?: string;
  opening?: string;
  closing?: string;
  omitBank?: boolean;
  extraLines?: string[];
}
export function buildStatementPdf(spec: StatementSpec): Promise<Uint8Array>;
export function sampleCardSpec(overrides?: Partial<StatementSpec>): StatementSpec;
export interface WebRow {
  date: string;
  concept: string;
  amount: string;
  balance: string;
  valueDate?: string;
  inlineValueDate?: boolean;
  detail?: string;
  detail2?: string;
  split?: 'amounts' | 'conceptAndAmounts';
}
export function buildWebMovementsPdf(spec: { pages: WebRow[][] }): Promise<Uint8Array>;
export function buildLinesPdf(pages: string[][]): Promise<Uint8Array>;
