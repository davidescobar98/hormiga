/** Semicolon CSV (Spanish banks' usual separator) as bytes. */
export function buildCsv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';')).join('\n') + '\n');
}
