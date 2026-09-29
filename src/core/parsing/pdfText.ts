import { AppError } from '../errors';
import type { ExtractedDocument } from './types';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * Extracts text lines from a PDF, fully locally (Mozilla pdf.js). Throws typed AppErrors for
 * invalid, encrypted (password) and image-only documents. JavaScript evaluation inside PDFs is disabled.
 */
export async function extractPdfText(data: Uint8Array, fileName: string, password?: string): Promise<ExtractedDocument> {
  if (data.byteLength > MAX_DOCUMENT_BYTES) {
    throw new AppError('FILE_TOO_LARGE', `«${fileName}» supera el tamaño máximo admitido (25 MB).`);
  }
  if (!isPdfHeader(data)) {
    throw new AppError('PDF_INVALID', `«${fileName}» no es un PDF válido.`);
  }
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    // pdf.js may transfer/detach the buffer: always hand it a copy.
    data: new Uint8Array(data),
    password,
    // pdf.js ≥ 6 never evaluates code from fonts/PDFs (fix for GHSA-hq66-cqwq-w95j); no scripting API is enabled.
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (err) {
    const e = err as { name?: string; code?: number };
    if (e?.name === 'PasswordException') {
      if (e.code === 2) throw new AppError('PDF_PASSWORD_INCORRECT', `La contraseña de «${fileName}» no es correcta.`);
      throw new AppError('PDF_PASSWORD_REQUIRED', `«${fileName}» está protegido con contraseña. Introdúcela para procesarlo (no se guardará).`);
    }
    if (e?.name === 'InvalidPDFException') throw new AppError('PDF_INVALID', `«${fileName}» está dañado o no es un PDF válido.`, err);
    throw new AppError('PDF_INVALID', `No se pudo abrir «${fileName}» como PDF.`, err);
  }

  try {
    const pages: string[][] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter((i): i is TextItemLike => typeof (i as TextItemLike).str === 'string');
      pages.push(itemsToLines(items));
      page.cleanup();
    }
    const hasText = pages.some((lines) => lines.some((l) => l.trim().length > 0));
    if (!hasText) {
      throw new AppError('PDF_NO_TEXT', `«${fileName}» no contiene texto seleccionable (¿documento escaneado?). El reconocimiento óptico (OCR) no está soportado.`);
    }
    return { fileName, mimeType: 'application/pdf', pages };
  } finally {
    await task.destroy();
  }
}

export function isPdfHeader(data: Uint8Array): boolean {
  // "%PDF-" may be preceded by a few bytes of garbage; pdf.js tolerates up to 1024.
  const head = Buffer.from(data.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/** Groups positioned text items into visual lines (top to bottom), inserting double spaces at column gaps. */
export function itemsToLines(items: TextItemLike[]): string[] {
  // Whitespace-only items are ignored: gaps are recomputed from real glyph positions.
  const visible = items.filter((i) => i.str.trim().length > 0);
  const sorted = [...visible].sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
  const rows: { y: number; items: TextItemLike[] }[] = [];
  for (const item of sorted) {
    const y = item.transform[5]!;
    const tolerance = Math.max(2, (item.height || 8) * 0.35);
    const row = rows.find((r) => Math.abs(r.y - y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((row) => {
      const its = row.items.sort((a, b) => a.transform[4]! - b.transform[4]!);
      let line = '';
      let prevEnd: number | null = null;
      for (const it of its) {
        const x = it.transform[4]!;
        if (prevEnd !== null) {
          const gap = x - prevEnd;
          const fontSize = Math.abs(it.transform[0] ?? 0) || it.height || 8;
          if (gap > fontSize * 1.2) line += '  ';
          else if (gap > fontSize * 0.15 && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' ';
        }
        line += it.str;
        prevEnd = x + it.width;
      }
      return line.replace(/\s+$/, '').replace(/^\s+/, '').replace(/ {3,}/g, '  ');
    })
    .filter((l) => l.length > 0);
}
