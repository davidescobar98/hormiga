import { describe, expect, it } from 'vitest';
import { buildGmailQuery, isStatementAttachment, scoreMessage } from '../../src/core/email/detection';
import { bankMentioned } from '../../src/core/email/banks';
import { DEFAULT_DETECTION } from '../../src/core/db/settingsRepo';
import { GenericPdfStatementParser } from '../../src/core/parsing/genericPdfParser';
import { selectParser } from '../../src/core/parsing/registry';
import { normalizeStatement } from '../../src/core/parsing/normalize';
import type { ExtractedDocument } from '../../src/core/parsing/types';
import type { EmailMessageMeta } from '../../src/core/email/types';

const msg = (from: string, subject: string, files: { fileName: string; mimeType?: string }[]): EmailMessageMeta => ({
  id: 'm1', subject, from, date: '2026-08-01T00:00:00.000Z',
  attachments: files.map((a, i) => ({ key: `${i}`, fileName: a.fileName, mimeType: a.mimeType ?? 'application/octet-stream', sizeBytes: 1000, ref: 'r', inlineData: null })),
});

describe('statement emails from any bank', () => {
  it('detects statements of other Spanish banks by sender domain, even with an old BBVA-only configuration', () => {
    const oldConfig = { ...DEFAULT_DETECTION, senderDomains: ['bbva.com'] };
    for (const from of ['Santander <avisos@mail.bancosantander.es>', 'no-reply@caixabank.com', 'Sabadell <info@bancsabadell.com>', 'x@ing.es']) {
      expect(scoreMessage(msg(from, 'Tu extracto mensual', [{ fileName: 'extracto.pdf', mimeType: 'application/pdf' }]), oldConfig).classification).toBe('detected');
    }
  });

  it('accepts Excel, CSV and Norma 43 attachments, not images or other files', () => {
    expect(isStatementAttachment({ mimeType: 'application/vnd.ms-excel', fileName: 'movimientos.xls' })).toBe(true);
    expect(isStatementAttachment({ mimeType: 'text/plain', fileName: 'cuenta.n43' })).toBe(true);
    expect(isStatementAttachment({ mimeType: 'text/csv', fileName: 'mov.csv' })).toBe(true);
    expect(isStatementAttachment({ mimeType: 'image/png', fileName: 'logo.png' })).toBe(false);
    const r = scoreMessage(msg('no-reply@bankinter.com', 'Movimientos Bankinter', [{ fileName: 'movimientos.xlsx' }]), DEFAULT_DETECTION);
    expect(r.classification).toBe('detected');
    expect(r.reasons).toContain('El asunto menciona Bankinter');
  });

  it('unknown senders are only "possible" and spoofed display names still do not count', () => {
    expect(scoreMessage(msg('Santander <santander@santander.es.fraude.net>', 'Extracto', [{ fileName: 'extracto.pdf', mimeType: 'application/pdf' }]), DEFAULT_DETECTION).classification).not.toBe('detected');
    expect(scoreMessage(msg('amigo@gmail.com', 'Extracto', [{ fileName: 'extracto.pdf', mimeType: 'application/pdf' }]), DEFAULT_DETECTION).classification).toBe('possible');
  });

  it('matches bank names as whole words', () => {
    expect(bankMentioned('Tu extracto de ING')).toBe('ING');
    expect(bankMentioned('Viaje a Kingston')).toBeNull();
    expect(bankMentioned('Recibo La Caixa')).toBe('CaixaBank');
  });

  it('Gmail query covers other banks and attachment types, sanitised', () => {
    const q = buildGmailQuery(DEFAULT_DETECTION, new Date(2026, 0, 5));
    for (const t of ['from:caixabank.com', 'from:bancosantander.es', 'subject:sabadell', 'filename:xlsx', 'filename:n43', 'subject:extracto']) expect(q).toContain(t);
    expect(q).not.toMatch(/[()"]/);
  });
});

const pdf = (lines: string[], fileName = 'extracto.pdf'): ExtractedDocument => ({ fileName, mimeType: 'application/pdf', pages: [lines] });

describe('generic PDF statement reader (other banks)', () => {
  const santander = pdf([
    'Banco Santander, S.A.',
    'Extracto de cuenta del 01/08/2026 al 31/08/2026',
    'Fecha  Fecha valor  Concepto  Importe  Saldo',
    'Saldo anterior  1.000,00 €',
    '02/08  02/08  Compra tarjeta Mercadona  45,20  954,80',
    'MERCADONA SA MADRID',
    '05/08  05/08  Nómina empresa ficticia  1.500,00  2.454,80',
    '10/08  10/08  Recibo luz  60,00  2.394,80',
    'Página 1 de 1',
  ]);

  it('is chosen for other banks and reads rows, detail, year and signs from the running balance', () => {
    expect(selectParser(santander).id).toBe('generic-pdf-v1');
    const p = new GenericPdfStatementParser().parse(santander);
    expect(p.bank).toBe('Santander');
    expect(p.periodStart).toBe('2026-08-01');
    expect(p.transactions).toHaveLength(3);
    expect(p.transactions[0]).toMatchObject({ dateRaw: '02/08/2026', detailRaw: 'MERCADONA SA MADRID', amountRaw: '45,20', balanceRaw: '954,80' });
    expect(p.transactions[1]!.detailRaw).toBeNull();
    const n = normalizeStatement(p);
    expect(n.blockingIssues).toEqual([]);
    expect(n.candidates.map((c) => c.amountCents)).toEqual([-4520, 150000, -6000]);
    expect(n.candidates.every((c) => c.errors.length === 0)).toBe(true);
  });

  it('sends to review when there is nothing to verify the amounts against', () => {
    const p = new GenericPdfStatementParser().parse(pdf([
      'Sabadell · Movimientos 2026',
      '02/08/2026  Compra Amazon  19,99',
      '03/08/2026  Transferencia recibida  200,00',
      '04/08/2026  Bizum enviado  10,00',
    ]));
    expect(p.bank).toBe('Sabadell');
    expect(p.integrityErrors?.[0]).toMatch(/revisa los movimientos/);
    expect(normalizeStatement(p).blockingIssues.length).toBeGreaterThan(0);
  });

  it('flags rows whose amount does not match the balance change', () => {
    const p = new GenericPdfStatementParser().parse(pdf([
      'ING',
      '01/08/2026  Compra  10,00  90,00',
      '02/08/2026  Compra  10,00  75,00',
      '03/08/2026  Compra  5,00  70,00',
    ]));
    const n = normalizeStatement(p);
    expect(n.candidates.some((c) => c.errors.some((e) => /saldo/.test(e)))).toBe(true);
  });

  it('ignores documents that are not statements', () => {
    expect(new GenericPdfStatementParser().detect(pdf(['Factura 123', 'Total 45,00 €']))).toBe(0);
  });
});
