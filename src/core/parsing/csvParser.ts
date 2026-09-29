import type { ExtractedDocument } from './types';


/** RFC 4180-style CSV parsing with auto-detected delimiter (";" "," or tab). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 20).join('\n');
  const delimiter = [';', '\t', ','].map((d) => ({ d, n: countOutsideQuotes(firstLines, d) })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function countOutsideQuotes(text: string, ch: string): number {
  let n = 0;
  let q = false;
  for (const c of text) {
    if (c === '"') q = !q;
    else if (!q && c === ch) n++;
  }
  return n;
}


/** CSV exports become a table handled by the bank table parser (same header detection as Excel exports). */
export function csvToDocument(text: string, fileName: string): ExtractedDocument {
  const rows = parseCsv(text);
  return { fileName, mimeType: 'text/csv', pages: [], table: rows, rawText: text.slice(0, 5000) };
}
