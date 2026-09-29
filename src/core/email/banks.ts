import { normalizeText } from '../domain/merchant';

/**
 * Spanish banks and neobanks whose statement emails Hormiga looks for. Sender domains are matched on the real
 * address (subdomains included), never on the display name. Users can add more senders in Settings.
 */
export interface KnownBank {
  name: string;
  domains: string[];
  /** Words that identify the bank in a subject or file name (normalized, uppercase). */
  terms: string[];
}

export const KNOWN_BANKS: KnownBank[] = [
  { name: 'BBVA', domains: ['bbva.com', 'bbva.es'], terms: ['BBVA'] },
  { name: 'CaixaBank', domains: ['caixabank.com', 'caixabank.es', 'lacaixa.es'], terms: ['CAIXABANK', 'LA CAIXA'] },
  { name: 'imagin', domains: ['imaginbank.com', 'imagin.com'], terms: ['IMAGIN', 'IMAGINBANK'] },
  { name: 'Santander', domains: ['santander.es', 'bancosantander.es', 'gruposantander.es', 'santander.com'], terms: ['SANTANDER'] },
  { name: 'Sabadell', domains: ['bancsabadell.com', 'sabadell.com'], terms: ['SABADELL'] },
  { name: 'ING', domains: ['ing.es', 'ingdirect.es'], terms: ['ING'] },
  { name: 'Openbank', domains: ['openbank.es'], terms: ['OPENBANK'] },
  { name: 'Bankinter', domains: ['bankinter.com', 'bankinter.es'], terms: ['BANKINTER'] },
  { name: 'Unicaja', domains: ['unicaja.es', 'unicajabanco.es'], terms: ['UNICAJA'] },
  { name: 'Abanca', domains: ['abanca.com', 'abanca.es'], terms: ['ABANCA'] },
  { name: 'Kutxabank', domains: ['kutxabank.es', 'kutxabank.com'], terms: ['KUTXABANK'] },
  { name: 'Ibercaja', domains: ['ibercaja.es'], terms: ['IBERCAJA'] },
  { name: 'Cajamar', domains: ['cajamar.es', 'grupocooperativocajamar.es'], terms: ['CAJAMAR'] },
  { name: 'Caja Rural', domains: ['cajarural.com', 'ruralvia.com'], terms: ['CAJA RURAL', 'RURALVIA'] },
  { name: 'EVO Banco', domains: ['evobanco.com'], terms: ['EVO BANCO'] },
  { name: 'MyInvestor', domains: ['myinvestor.es'], terms: ['MYINVESTOR'] },
  { name: 'Revolut', domains: ['revolut.com'], terms: ['REVOLUT'] },
  { name: 'N26', domains: ['n26.com'], terms: ['N26'] },
];

export const KNOWN_BANK_DOMAINS = KNOWN_BANKS.flatMap((b) => b.domains);

/** Name of the first known bank mentioned in a text (subject, file name…), matched on whole words. */
export function bankMentioned(text: string): string | null {
  const t = ` ${normalizeText(text)} `;
  for (const b of KNOWN_BANKS) if (b.terms.some((term) => t.includes(` ${term} `))) return b.name;
  return null;
}
