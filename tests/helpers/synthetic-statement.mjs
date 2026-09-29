// Generates FICTITIOUS BBVA-like statements as real PDFs (pdf-lib) for tests and E2E.
// No real names, card numbers, IBANs or amounts: everything here is synthetic.
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * @typedef {{ date: string, valueDate?: string, desc: string, cont?: string[], amount: string, balance?: string }} Row
 * @typedef {{
 *   kind?: 'card' | 'account',
 *   period?: [string, string],
 *   pages: Row[][],
 *   total?: string,
 *   opening?: string,
 *   closing?: string,
 *   omitBank?: boolean,
 *   extraLines?: string[],
 * }} StatementSpec
 */

/** @param {StatementSpec} spec @returns {Promise<Uint8Array>} */
export async function buildStatementPdf(spec) {
  const doc = await PDFDocument.create();
  doc.setTitle('Documento ficticio de pruebas');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 9;
  const kind = spec.kind ?? 'card';

  spec.pages.forEach((rows, pageIdx) => {
    const page = doc.addPage([595, 842]);
    let y = 800;
    const text = (t, x, f = font, s = size) => page.drawText(t, { x, y, size: s, font: f });
    const right = (t, xRight, f = font) => page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f });

    if (!spec.omitBank) text('BBVA', 40, bold, 14);
    y -= 18;
    text('DOCUMENTO FICTICIO - DATOS SINTETICOS PARA PRUEBAS', 40, font, 7);
    y -= 16;
    if (pageIdx === 0) {
      text(kind === 'card' ? 'EXTRACTO DE TARJETA DE CREDITO - LIQUIDACION' : 'EXTRACTO DE CUENTA', 40, bold, 11);
      y -= 16;
      text(kind === 'card' ? 'Tarjeta XXXX XXXX XXXX 0000' : 'Cuenta ES00 XXXX XXXX XX XXXXXX0000', 40);
      y -= 14;
      if (spec.period) {
        text(`Periodo: ${spec.period[0]} - ${spec.period[1]}`, 40);
        y -= 14;
      }
      if (spec.opening) {
        text('SALDO ANTERIOR', 40);
        right(spec.opening, 540);
        y -= 14;
      }
      for (const l of spec.extraLines ?? []) {
        text(l, 40);
        y -= 14;
      }
    }
    y -= 8;
    text('FECHA', 40, bold);
    if (kind === 'account') text('F.VALOR', 95, bold);
    text('CONCEPTO', 150, bold);
    right('IMPORTE', kind === 'account' ? 460 : 540, bold);
    if (kind === 'account') right('SALDO', 540, bold);
    y -= 16;

    for (const r of rows) {
      text(r.date, 40);
      if (r.valueDate) text(r.valueDate, 95);
      text(r.desc, 150);
      right(r.amount, kind === 'account' ? 460 : 540);
      if (r.balance) right(r.balance, 540);
      y -= 13;
      for (const c of r.cont ?? []) {
        text(c, 150);
        y -= 13;
      }
    }

    if (pageIdx === spec.pages.length - 1) {
      y -= 10;
      if (spec.total) {
        text('TOTAL MOVIMIENTOS', 150, bold);
        right(spec.total, 540, bold);
        y -= 14;
      }
      if (spec.closing) {
        text('SALDO FINAL', 150, bold);
        right(spec.closing, 540, bold);
        y -= 14;
      }
    }
    page.drawText(`Pagina ${pageIdx + 1} de ${spec.pages.length}`, { x: 480, y: 30, size: 8, font });
  });
  return doc.save();
}

/**
 * FICTITIOUS replica of the BBVA online banking "Últimos movimientos" PDF layout (newest first, running balance).
 * @param {{ pages: { date: string, concept: string, amount: string, balance: string, valueDate?: string, inlineValueDate?: boolean,
 *   detail?: string, detail2?: string, split?: 'amounts' | 'conceptAndAmounts' }[][] }} spec
 * `split` draws the row across the page break like the real document does.
 */
export async function buildWebMovementsPdf(spec) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 8;
  const pages = spec.pages.map(() => doc.addPage([595, 842]));
  const cursor = pages.map(() => 790);
  const put = (pi, x, t) => pages[pi].drawText(t, { x, y: cursor[pi], size, font });
  const right = (pi, xr, t) => pages[pi].drawText(t, { x: xr - font.widthOfTextAtSize(t, size), y: cursor[pi], size, font });
  const nl = (pi, dy = 12) => { cursor[pi] -= dy; };
  const drawn = pages.map(() => false);
  const header = (pi) => { if (drawn[pi]) return; drawn[pi] = true; put(pi, 40, 'Fecha'); put(pi, 110, 'Concepto'); right(pi, 470, 'Importe'); right(pi, 550, 'Saldo'); nl(pi, 16); };
  put(0, 40, 'Últimos movimientos');
  nl(0, 18);
  spec.pages.forEach((rows, pi) => {
    header(pi);
    rows.forEach((r, ri) => {
      const next = spec.pages[pi + 1];
      if (r.split && ri === rows.length - 1 && next) {
        // amounts (and maybe concept) stay here; date/concept/value lines go to the top of the next page
        if (r.split === 'conceptAndAmounts') put(pi, 110, r.concept);
        right(pi, 470, `${r.amount} €`); right(pi, 550, `${r.balance} €`); nl(pi);
        const np = pi + 1;
        header(np);
        put(np, 40, r.date); if (r.split === 'amounts') put(np, 110, r.concept); nl(np);
        put(np, 40, 'Fecha valor'); if (r.detail) put(np, 110, r.detail); nl(np);
        put(np, 40, r.valueDate ?? r.date); nl(np);
        return;
      }
      put(pi, 40, r.date); put(pi, 110, r.concept); right(pi, 470, `${r.amount} €`); right(pi, 550, `${r.balance} €`); nl(pi);
      if (r.inlineValueDate) {
        put(pi, 40, `Fecha valor ${r.valueDate ?? r.date}`); if (r.detail) put(pi, 150, r.detail); nl(pi);
      } else {
        put(pi, 40, 'Fecha valor'); if (r.detail) put(pi, 110, r.detail); nl(pi);
        put(pi, 40, r.valueDate ?? r.date); if (r.detail2) put(pi, 110, r.detail2); nl(pi);
      }
    });
    pages[pi].drawText('BANCO BILBAO VIZCAYA ARGENTARIA S.A. Documento ficticio para pruebas', { x: 40, y: 40, size: 6, font });
    pages[pi].drawText(`${pi + 1}/${spec.pages.length}`, { x: 540, y: 28, size: 7, font });
  });
  return doc.save();
}

/** A one-page card statement for August 2026 with a refund, a split description and a thousands separator. */
export function sampleCardSpec(overrides = {}) {
  return {
    kind: 'card',
    period: ['01/08/2026', '31/08/2026'],
    pages: [
      [
        { date: '02/08/2026', desc: 'COMPRA TARJ. MERCADONA 1234 MADRID', amount: '45,20' },
        { date: '03/08/2026', desc: 'NETFLIX.COM', amount: '12,99' },
        { date: '05/08/2026', desc: 'PAGO EN RESTAURANTE CASA FICTICIA', cont: ['CALLE INVENTADA 1'], amount: '38,50' },
        { date: '10/08/2026', desc: 'NOVEDADES BARRIO LUNA', amount: '22,00' },
        { date: '12/08/2026', desc: 'MUEBLES DEMO COMPRA SOFA', amount: '1.234,56' },
        { date: '20/08/2026', desc: 'DEVOLUCION COMPRA AMAZON EU', amount: '-19,99' },
      ],
    ],
    total: '1.333,26',
    ...overrides,
  };
}
