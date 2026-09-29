import type { DetectionConfig } from '../../shared/types';
import { normalizeText } from '../domain/merchant';
import type { EmailMessageMeta } from './types';
import { bankMentioned, KNOWN_BANK_DOMAINS, KNOWN_BANKS } from './banks';

export interface DetectionResult {
  score: number;
  classification: 'detected' | 'possible' | 'ignored';
  reasons: string[];
}

export const POSSIBLE_THRESHOLD = 35;

/** Extracts the bare address from a From header: "Banco <x@y.com>" → "x@y.com". */
export function emailAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

export function domainMatches(address: string, domain: string): boolean {
  const host = address.split('@')[1] ?? '';
  const d = domain.trim().toLowerCase().replace(/^@/, '');
  return !!d && (host === d || host.endsWith(`.${d}`));
}

/** Attachments Hormiga can import: PDF statements and movement exports (Excel, CSV, Norma 43). */
export function isStatementAttachment(a: { mimeType: string; fileName: string }): boolean {
  return a.mimeType === 'application/pdf' || /\.(pdf|xlsx?|csv|n43|q43|aeb)$/i.test(a.fileName);
}

/**
 * Scores how likely a message is a bank statement (any bank). Combines several configurable signals so that a change
 * of subject or sender does not silently break detection. The display name is ignored (easy to spoof).
 */
export function scoreMessage(msg: EmailMessageMeta, cfg: DetectionConfig): DetectionResult {
  const reasons: string[] = [];
  let score = 0;
  const address = emailAddress(msg.from);
  if (cfg.senderAddresses.some((a) => a.trim().toLowerCase() === address)) {
    score += 45;
    reasons.push('Remitente reconocido');
  } else if ([...cfg.senderDomains, ...KNOWN_BANK_DOMAINS].some((d) => domainMatches(address, d))) {
    score += 40;
    reasons.push(`Dominio del remitente (${address.split('@')[1]})`);
  }
  const subject = normalizeText(msg.subject);
  const bank = bankMentioned(msg.subject);
  if (bank) {
    score += 10;
    reasons.push(`El asunto menciona ${bank}`);
  }
  const subjectKw = cfg.subjectKeywords.map(normalizeText).find((k) => k && ` ${subject} `.includes(` ${k} `));
  if (subjectKw) {
    score += 15;
    reasons.push(`Asunto contiene «${subjectKw.toLowerCase()}»`);
  }
  const pdfs = msg.attachments.filter(isStatementAttachment);
  if (pdfs.length > 0) {
    score += 25;
    reasons.push(pdfs.length === 1 ? 'Adjunta un documento' : `Adjunta ${pdfs.length} documentos`);
    const fileKw = cfg.filenameKeywords
      .map(normalizeText)
      .find((k) => k && pdfs.some((p) => normalizeText(p.fileName).includes(k)));
    if (fileKw) {
      score += 10;
      reasons.push(`Nombre del adjunto contiene «${fileKw.toLowerCase()}»`);
    }
  } else {
    reasons.push('Sin extracto adjunto (PDF, Excel, CSV o Norma 43)');
    score = Math.min(score, POSSIBLE_THRESHOLD - 1);
  }
  score = Math.min(100, score);
  const classification = score >= cfg.minScore ? 'detected' : score >= POSSIBLE_THRESHOLD ? 'possible' : 'ignored';
  return { score, classification, reasons };
}

function gmailDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Gmail search query: messages with a statement-like attachment after a date that come from a known bank or a
 * configured sender, or mention a bank or a statement keyword. Scoring decides afterwards what is imported.
 */
export function buildGmailQuery(cfg: DetectionConfig, after: Date): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, '');
  const senders = [...new Set([...cfg.senderAddresses, ...cfg.senderDomains, ...KNOWN_BANK_DOMAINS].map(safe).filter(Boolean))];
  const names = [...new Set(KNOWN_BANKS.flatMap((b) => b.terms.filter((t) => !t.includes(' ') && t.length > 3)).map((t) => t.toLowerCase()))];
  const keywords = [...new Set(cfg.subjectKeywords.map((k) => safe(normalizeText(k).toLowerCase())).filter((k) => k.length > 3))];
  const terms = [...senders.map((s) => `from:${s}`), ...names.map((n) => `subject:${n}`), ...names.map((n) => `filename:${n}`), ...keywords.map((k) => `subject:${k}`)];
  return `has:attachment {filename:pdf filename:xls filename:xlsx filename:csv filename:n43} after:${gmailDate(after)} {${terms.join(' ')}}`;
}
