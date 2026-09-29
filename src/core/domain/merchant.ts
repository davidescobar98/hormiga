import { DESCRIPTION_PREFIXES, KNOWN_MERCHANTS, LEGAL_SUFFIXES, TRAILING_LOCATIONS, type KnownMerchant } from './knowledge';

/** Uppercase, accent-free, alphanumeric tokens separated by single spaces. Deterministic. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const norm = (list: string[]) => [...new Set(list.map(normalizeText).filter(Boolean))];

const PREFIXES = norm(DESCRIPTION_PREFIXES).sort((a, b) => b.length - a.length);
const LOCATIONS = new Set(norm(TRAILING_LOCATIONS));
const MULTI_WORD_LOCATIONS = norm(TRAILING_LOCATIONS).filter((l) => l.includes(' '));
const SUFFIXES = new Set(norm(LEGAL_SUFFIXES));
const NOISE_TOKENS = new Set(['WWW', 'COM', 'HTTPS', 'HTTP', 'NET', 'ORG', 'EU', 'TARJ', 'TARJETA', 'TJ', 'REF', 'N', 'NUM', 'NO']);

interface CompiledKnown {
  merchant: KnownMerchant;
  alias: string;
  anywhere: boolean;
}

const KNOWN: CompiledKnown[] = KNOWN_MERCHANTS.flatMap((m) =>
  norm(m.aliases).map((alias) => ({ merchant: m, alias, anywhere: alias.replace(/ /g, '').length >= 5 })),
).sort((a, b) => b.alias.length - a.alias.length);

export interface MerchantResult {
  /** Stable grouping key, e.g. "MERCADONA". */
  key: string;
  /** Human friendly name, e.g. "Mercadona". */
  display: string;
  /** Merchant text as found in the description after removing bank prefixes. */
  raw: string;
  known: KnownMerchant | null;
}

function containsTokens(haystack: string, needle: string, atStart: boolean): boolean {
  if (atStart) return haystack === needle || haystack.startsWith(`${needle} `);
  return ` ${haystack} `.includes(` ${needle} `);
}

export function stripPrefixes(text: string): string {
  let t = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      if (t === p) break;
      if (t.startsWith(`${p} `)) {
        t = t.slice(p.length + 1);
        changed = true;
        break;
      }
    }
    // Card fragments such as "TARJ 1234", "XXXX1234", "4B 1234" at the start
    const card = /^(TARJ(ETA)?|TJ)( [0-9X*]+)+ /.exec(t) ?? /^X{2,}[0-9]* /.exec(t);
    if (card) {
      t = t.slice(card[0].length);
      changed = true;
    }
    // Leading dates/times accidentally kept in the description
    // Leftover card digits after a prefix ("COMPRA TARJ. 1234 LIDL").
    const digits = /^\d{3,6} (?=[A-Z])/.exec(t);
    if (digits) {
      t = t.slice(digits[0].length);
      changed = true;
    }
    const lead = /^\d{1,2} \d{1,2}( \d{2,4})? /.exec(t);
    if (lead) {
      t = t.slice(lead[0].length);
      changed = true;
    }
  }
  return t;
}

export function findKnownMerchant(cleaned: string): KnownMerchant | null {
  for (const k of KNOWN) {
    if (containsTokens(cleaned, k.alias, !k.anywhere)) return k.merchant;
  }
  return null;
}

export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 && /^(de|la|el|y|en|del|los|las)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}

const GENERIC_CONCEPT = /^(BIZUM|TRANSFERENCIA|TRASPASO|ADEUDO|RECIBO|CARGO|ABONO|INGRESO|DEVOLUCION|RET|REINTEGRO|COMISION|LIQUIDACION|RECARGA|PAGO RECIBO)\b/;
const GENERIC_DETAIL = /^(PAGO CON TARJETA|COMPRA CON TARJETA|OTROS|COMPRA|PAGO)?$/;

/**
 * Chooses the text that identifies the counterparty. When the concept is generic ("ADEUDO A SU CARGO",
 * "TRANSFERENCIA REALIZADA") the detail line holds the real merchant ("N 0000… OPERADORA" → "OPERADORA").
 * Bizum notes are free text written by people, so Bizum movements are grouped as "Bizum".
 */
export function merchantSourceFor(concept: string, detail: string | null | undefined): string {
  const c = normalizeText(concept);
  if (/^BIZUM\b/.test(c)) return 'Bizum';
  if (!detail || !GENERIC_CONCEPT.test(c)) return concept;
  if (findKnownMerchant(stripPrefixes(c))) return concept;
  const d = normalizeText(detail)
    .replace(/\bN \d{6,}\b/g, ' ')
    .replace(/^(ENVIADO|RECIBIDO|DE|A|PARA|CONCEPTO|ORDENANTE|BENEFICIARIO)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return GENERIC_DETAIL.test(d) ? concept : d;
}

/**
 * Extracts a normalized merchant from a raw bank description.
 * "COMPRA TARJ. 1234 MERCADONA 1234 BARCELONA" → { key: "MERCADONA", display: "Mercadona" }.
 */
export function normalizeMerchant(descriptionRaw: string): MerchantResult {
  const text = normalizeText(descriptionRaw);
  const withoutPrefix = stripPrefixes(text);
  const known = findKnownMerchant(withoutPrefix) ?? findKnownMerchant(text);
  if (known) {
    const key = normalizeText(known.display);
    return { key, display: known.display, raw: withoutPrefix || text, known };
  }

  let tokens = withoutPrefix.split(' ').filter(Boolean);
  // Drop reference numbers, store codes and masked card numbers.
  tokens = tokens.filter((t) => !(/\d/.test(t) && (t.length >= 3 || /^\d+$/.test(t))) && !/^X{2,}/.test(t));
  tokens = tokens.filter((t) => !NOISE_TOKENS.has(t));
  // Remove trailing legal suffixes / locations / country codes (possibly several).
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const joined = tokens.join(' ');
    const multi = MULTI_WORD_LOCATIONS.find((l) => joined.endsWith(` ${l}`));
    if (multi) {
      tokens = joined.slice(0, -multi.length - 1).split(' ');
      changed = true;
      continue;
    }
    const last = tokens[tokens.length - 1]!;
    if (SUFFIXES.has(last) || LOCATIONS.has(last) || last.length === 1) {
      tokens.pop();
      changed = true;
    }
  }
  tokens = tokens.filter((t) => !SUFFIXES.has(t));
  tokens = tokens.slice(0, 4);
  const knownAfterCleanup = findKnownMerchant(tokens.join(' '));
  if (knownAfterCleanup) return { key: normalizeText(knownAfterCleanup.display), display: knownAfterCleanup.display, raw: withoutPrefix || text, known: knownAfterCleanup };
  const key = tokens.join(' ') || withoutPrefix || text || 'DESCONOCIDO';
  return { key, display: titleCase(key), raw: withoutPrefix || text, known: null };
}
