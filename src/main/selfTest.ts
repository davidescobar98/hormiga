import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../core/db/database';
import { extractPdfText } from '../core/parsing/pdfText';
import { BbvaStatementParser } from '../core/parsing/bbvaParser';
import { normalizeStatement } from '../core/parsing/normalize';
import type { SecretVault } from '../core/email/types';
import * as XLSX from 'xlsx';
import { extractSpreadsheet } from '../core/parsing/spreadsheet';
import { BankTableParser } from '../core/parsing/tabularParser';

/** Tiny synthetic PDF ("BBVA - DOCUMENTO FICTICIO", one fake movement) used to verify pdf.js in the packaged app. */
const SAMPLE_PDF =
  'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyMDcKPj4Kc3RyZWFtCnicjVDBakJBDLznK/ZcKM3mTXazIB6sb+mhl8L+QBEtSntQpN/f7BOVgoIsGUh2yMxkT4tGHPo7fNHL2/r7d33crj6fMxeDcbYSLLQNCUJ7pzgxY4gcCof2QzMIRBOisCyFAVQMqlhCMap3PksoPkNHrzqx1DGqdgb6T0TGiKpnXp2HtqP2RGOjD9rfc1kyJJkbsDsu08nlwINIdTRH6d2QHlMQZjbWYumWgl0UemIVdx6nG4yIjyZQv1ARzrf2i14j+A3ltZv/t/gP3TZiLQplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9UeXBlIC9PYmpTdG0KL04gNQovRmlyc3QgMjYKL0xlbmd0aCAzOTUKPj4Kc3RyZWFtCnic1VPfa9wwDH73X6HH7qFY8Tn+MY6D613Swigt7WClpQ9pYo6MYpfEN7r/flJybSnb6HMxwpa+T5JlSwUgKNAaFmAdaCgXCkowhYblUsjvv58CyMtmF0Yhv/XdCHeEIlzBvZCbtI8ZCrFaiTfupsnNY9qJ2QkKJr8wLofU7dswwLKu6hrRIqLRJAZRbWnfkHgSRTphytGZxOqDkM0uEBdrwupZjJ19GJ+45cG/op24hjnbmavdrL/m5VzVHEN9dB+/EvI8ddsmBzjaflWoDHrl0ZSFNrdf6DmG0OT0eYub7t+n+N8K3/1znWIW8nr/kCeVjYWQJ80YGAF5Fh5/hdy3jZBVbFPXxx3IH31cx7F/MbyPyA3DbTME7qqpb+RVGNN+aKmRmDdF5sNr8GOL3lHl1nnq3cnlDfNWK+NUadzfGP+Aw9I78y+/ErXxCu0Bo2vKm4uHn6Gd0rNaPefT68wvNRvYdh66vjlJzzQjSIv+BwqFPCnrGFPm2ZmmJmaqkDVzmCRy/gMwzNtYCmVuZHN0cmVhbQplbmRvYmoKCjggMCBvYmoKPDwKL1NpemUgOQovUm9vdCAyIDAgUgovSW5mbyAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDQxCi9XIFsgMSAyIDIgXQovSW5kZXggWyAwIDkgXQo+PgpzdHJlYW0KeJwVxLERADAIA7E3cJc2LRtk/wUJViFgJjjg5MKlK3FBels2fFs6Ao4KZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVmCjc5MwolJUVPRg==';

export interface SelfTestResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * `Hormiga.exe --self-test`: verifies the packaged runtime (PDF engine, SQLite, OS secret storage)
 * without touching the user's data. Prints JSON and exits with 0/1.
 */
export async function runSelfTest(vault: SecretVault): Promise<SelfTestResult> {
  const checks: SelfTestResult['checks'] = [];
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      checks.push({ name, ok: false, detail: String((err as Error)?.message ?? err) });
    }
  };
  await check('pdf', async () => {
    const doc = await extractPdfText(new Uint8Array(Buffer.from(SAMPLE_PDF, 'base64')), 'selftest.pdf');
    const n = normalizeStatement(new BbvaStatementParser().parse(doc));
    const c = n.candidates[0];
    if (!c || c.amountCents !== -4520 || c.date !== '2026-08-02') throw new Error('Resultado inesperado del analizador');
    return 'pdf.js + analizador BBVA OK';
  });
  await check('spreadsheet', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Fecha', 'Concepto', 'Importe', 'Saldo'], ['02/08/2026', 'MERCADONA', -45.2, 954.8]]), 'M');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'biff8' }) as ArrayBuffer);
    const n = normalizeStatement(new BankTableParser().parse(extractSpreadsheet(bytes, 'selftest.xls')));
    if (n.candidates[0]?.amountCents !== -4520) throw new Error('Resultado inesperado del lector de Excel');
    return 'SheetJS + lector de tablas OK';
  });
  await check('sqlite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hormiga-selftest-'));
    try {
      const db = Database.open(join(dir, 't.db'));
      const v = db.schemaVersion;
      db.close();
      return `SQLite OK (esquema v${v})`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await check('secure-storage', () => {
    if (!vault.isAvailable()) throw new Error('Almacén seguro del sistema no disponible');
    return 'Almacén seguro del sistema disponible';
  });
  return { ok: checks.every((c) => c.ok), checks };
}
