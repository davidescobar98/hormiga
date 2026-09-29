import * as XLSX from 'xlsx';
import { AppError } from '../errors';
import { mapHeader } from './tabularParser';
import type { Cell, ExtractedDocument } from './types';

/**
 * Reads .xlsx, binary .xls (BIFF) and HTML tables saved as ".xls" with SheetJS CE 0.20.3 (official CDN build).
 * `raw: true` keeps text cells as text (Spanish "1.234,56" is parsed by Hormiga, not guessed by the library);
 * real numeric/date cells keep their native values. Formulas, macros and external links are never evaluated.
 */
export function extractSpreadsheet(input: Uint8Array | string, fileName: string, rawText?: string): ExtractedDocument {
  let wb: XLSX.WorkBook;
  try {
    wb = typeof input === 'string'
      ? XLSX.read(input, { type: 'string', raw: true, cellDates: false, cellFormula: false, cellHTML: false, dense: true })
      : XLSX.read(input, { type: 'array', raw: true, cellDates: false, cellFormula: false, cellHTML: false, dense: true });
  } catch (err) {
    throw new AppError('UNKNOWN_FORMAT', `«${fileName}» no se pudo leer como hoja de cálculo.`, err);
  }
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: null, blankrows: true }),
  }));
  if (sheets.length === 0) throw new AppError('UNKNOWN_FORMAT', `«${fileName}» no contiene hojas.`);
  // The first sheet that contains a movements header; otherwise the first sheet (the parser will explain what is missing).
  const chosen = sheets.find((s) => s.rows.slice(0, 40).some((r) => mapHeader(r))) ?? sheets[0]!;
  const text = [rawText?.slice(0, 20000) ?? '', ...wb.SheetNames, String(wb.Props?.Title ?? ''), String(wb.Props?.Company ?? '')].join(' ');
  return {
    fileName,
    mimeType: 'application/vnd.ms-excel',
    pages: [],
    table: chosen.rows,
    rawText: text,
    date1904: !!wb.Workbook?.WBProps?.date1904,
  };
}
