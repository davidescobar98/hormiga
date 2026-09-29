import { describe, expect, it } from 'vitest';
import { csvToDocument, parseCsv } from '../../src/core/parsing/csvParser';
import { BankTableParser as CsvStatementParser } from '../../src/core/parsing/tabularParser';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import { decodeText } from '../../src/core/parsing/registry';
import { buildGmailQuery, domainMatches, emailAddress, scoreMessage } from '../../src/core/email/detection';
import { DEFAULT_DETECTION } from '../../src/core/db/settingsRepo';
import { assignFingerprints } from '../../src/core/domain/fingerprint';
import { csvCell } from '../../src/core/services/dataService';
import type { EmailMessageMeta } from '../../src/core/email/types';

describe('CSV parsing', () => {
  it('handles quotes, delimiters and a preamble before the header', () => {
    const csv = 'Movimientos de la cuenta\n\nFecha;Fecha valor;Concepto;Importe;Saldo\n01/08/2026;01/08/2026;"COMPRA ""TIENDA""; CENTRO";-1.234,56;100,00\n02/08/2026;02/08/2026;ABONO NOMINA;2.000,00;2.100,00\n';
    const parsed = new CsvStatementParser().parse(csvToDocument(csv, 'x.csv'));
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0]!.descriptionRaw).toBe('COMPRA "TIENDA"; CENTRO');
    const n = normalizeStatement(parsed);
    expect(n.candidates.map((c) => c.amountCents)).toEqual([-123456, 200000]);
    expect(n.candidates[1]!.type).toBe('income');
    expect(n.periodStart).toBe('2026-08-01');
  });

  it('supports separate debit/credit columns', () => {
    const csv = 'Fecha,Concepto,Cargo,Abono\n03/08/2026,FARMACIA,"12,30",\n04/08/2026,DEVOLUCION ZARA,,"20,00"\n';
    const n = normalizeStatement(new CsvStatementParser().parse(csvToDocument(csv, 'x.csv')));
    expect(n.candidates.map((c) => c.amountCents)).toEqual([-1230, 2000]);
  });

  it('rejects CSVs without a recognisable header', () => {
    expect(() => new CsvStatementParser().parse(csvToDocument('a;b;c\n1;2;3\n', 'x.csv'))).toThrow(/cabecera/);
  });

  it('decodes Windows-1252 exports', () => {
    const bytes = new Uint8Array([0x43, 0x41, 0x46, 0x45, 0x54, 0x45, 0x52, 0xcd, 0x41]); // CAFETERÍA in cp1252
    expect(decodeText(bytes)).toBe('CAFETERÍA');
  });

  it('parseCsv ignores empty lines', () => {
    expect(parseCsv('a;b\n\n1;2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('deduplication fingerprints', () => {
  it('same movement in two documents → same fingerprint; repeated identical movements in one document → distinct', () => {
    const row = { date: '2026-08-02', amountCents: -250, descriptionNormalized: 'CAFETERIA EL RINCON' };
    const docA = assignFingerprints([row, row]);
    const docB = assignFingerprints([row]);
    expect(docA[0]!.fingerprint).not.toBe(docA[1]!.fingerprint);
    expect(docB[0]!.fingerprint).toBe(docA[0]!.fingerprint);
  });
});

describe('CSV export safety', () => {
  it('neutralises formula injection and escapes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('A;B')).toBe('"A;B"');
    expect(csvCell(null)).toBe('');
  });
});

const msg = (from: string, subject: string, attachments: { fileName: string; mimeType?: string }[]): EmailMessageMeta => ({
  id: 'm1', subject, from, date: '2026-08-01T00:00:00.000Z',
  attachments: attachments.map((a, i) => ({ key: `${i}`, fileName: a.fileName, mimeType: a.mimeType ?? 'application/pdf', sizeBytes: 1000, ref: 'r', inlineData: null })),
});

describe('BBVA email detection', () => {
  it('combines sender, subject and attachment signals', () => {
    const r = scoreMessage(msg('BBVA <avisos@comunica.bbva.com>', 'Tu extracto de tarjeta BBVA', [{ fileName: 'Extracto_082026.pdf' }]), DEFAULT_DETECTION);
    expect(r.classification).toBe('detected');
    expect(r.score).toBe(100);
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('still detects when the subject changes, thanks to other signals', () => {
    const r = scoreMessage(msg('notificaciones@bbva.es', 'Documentación disponible', [{ fileName: 'doc.pdf' }]), DEFAULT_DETECTION);
    expect(r.classification).toBe('detected');
  });

  it('ignores spoofed display names and look-alike domains', () => {
    const r = scoreMessage(msg('BBVA <bbva@bbva.com.malicioso.net>', 'Extracto', [{ fileName: 'extracto.pdf' }]), DEFAULT_DETECTION);
    expect(r.classification).not.toBe('detected');
    expect(domainMatches('x@evilbbva.com', 'bbva.com')).toBe(false);
    expect(domainMatches('x@a.bbva.com', 'bbva.com')).toBe(true);
  });

  it('never auto-imports messages without a PDF', () => {
    const r = scoreMessage(msg('x@bbva.com', 'Extracto BBVA', []), DEFAULT_DETECTION);
    expect(r.classification).toBe('ignored');
  });

  it('builds a read-only Gmail search query with sanitised terms', () => {
    const q = buildGmailQuery({ ...DEFAULT_DETECTION, senderDomains: ['bbva.com', 'x") OR (in:anywhere'] }, new Date(2026, 0, 5));
    expect(q).toContain('after:2026/01/05');
    expect(q).toContain('from:bbva.com');
    expect(q).not.toMatch(/[()"]/);
    expect(emailAddress('Banco <A@B.COM>')).toBe('a@b.com');
  });
});
