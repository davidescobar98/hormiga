import { AppError } from '../errors';
import { BbvaStatementParser } from './bbvaParser';
import { BbvaWebMovementsParser } from './bbvaWebParser';
import { csvToDocument } from './csvParser';
import { GenericPdfStatementParser } from './genericPdfParser';
import { isNorma43, Norma43Parser } from './norma43Parser';
import { extractPdfText, isPdfHeader, MAX_DOCUMENT_BYTES } from './pdfText';
import { extractSpreadsheet } from './spreadsheet';
import { BankTableParser } from './tabularParser';
import type { ExtractedDocument, StatementParser } from './types';

export const DEFAULT_PARSERS: StatementParser[] = [
  new BbvaWebMovementsParser(),
  new BbvaStatementParser(),
  new Norma43Parser(),
  new BankTableParser(),
  // Last resort for PDFs of other banks: only trusted when the printed balances verify it.
  new GenericPdfStatementParser(),
];

export const MIN_PARSER_CONFIDENCE = 0.5;

export const SUPPORTED_EXTENSIONS = ['pdf', 'csv', 'txt', 'xls', 'xlsx', 'html', 'htm', 'n43', 'aeb', 'q43'];

export function selectParser(doc: ExtractedDocument, parsers: StatementParser[] = DEFAULT_PARSERS): StatementParser {
  const ranked = parsers.map((p) => ({ p, score: p.detect(doc) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < MIN_PARSER_CONFIDENCE) {
    throw new AppError(
      'UNKNOWN_FORMAT',
      `«${doc.fileName}» no se reconoce como un extracto compatible: PDF de movimientos con fechas e importes, Excel/CSV de movimientos (CaixaBank, imagin, Sabadell, Santander, ING, BBVA…) o Norma 43.`,
    );
  }
  return best.p;
}

export type DocumentFormat = 'pdf' | 'xlsx' | 'xls' | 'html' | 'norma43' | 'csv';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** Detects the real format from the content (banks often name HTML tables ".xls"). */
export function detectFormat(bytes: Uint8Array, fileName: string): DocumentFormat {
  if (isPdfHeader(bytes)) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls';
  const head = decodeText(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<') && /<(html|table|\?xml|meta|body|head|!doctype)/.test(head)) return 'html';
  if (isNorma43(decodeText(bytes.subarray(0, 16384)))) return 'norma43';
  if (/\.(csv|txt)$/i.test(fileName)) return 'csv';
  if (/\.pdf$/i.test(fileName)) return 'pdf';
  if (/\.(n43|aeb|q43)$/i.test(fileName)) return 'norma43';
  throw new AppError('UNKNOWN_FORMAT', `«${fileName}» no es un formato admitido (PDF, Excel, CSV o Norma 43).`);
}

/** Decodes text bytes as UTF-8, falling back to Windows-1252 (common in Spanish bank exports). */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(bytes);
}

export async function extractDocument(bytes: Uint8Array, fileName: string, password?: string): Promise<ExtractedDocument> {
  const format = detectFormat(bytes, fileName);
  if (format === 'pdf') return extractPdfText(bytes, fileName, password);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new AppError('FILE_TOO_LARGE', `«${fileName}» supera el tamaño máximo admitido (25 MB).`);
  switch (format) {
    case 'xlsx':
    case 'xls':
      return extractSpreadsheet(bytes, fileName);
    case 'html': {
      const text = decodeText(bytes);
      return extractSpreadsheet(text, fileName, text);
    }
    case 'norma43': {
      const text = decodeText(bytes);
      return { fileName, mimeType: 'text/x-norma43', pages: [text.split(/\r?\n/)] };
    }
    case 'csv':
      return csvToDocument(decodeText(bytes), fileName);
  }
}
