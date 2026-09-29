import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogData, Logger } from '../core/services/context';

type Level = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_BYTES = 2 * 1024 * 1024;

const SENSITIVE_KEYS = /token|secret|password|passwd|authorization|cookie|iban|card|pan|amount|cents|description|concepto|subject|email|account/i;

/** Masks things that must never reach disk even by mistake: IBANs, card numbers, emails, bearer tokens. */
export function scrub(text: string): string {
  return text
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){4,7}\b/g, '[IBAN]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[NUM]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/(ya29\.|1\/\/)[\w-]+/g, '[TOKEN]')
    .replace(/(bearer\s+)[\w.-]+/gi, '$1[TOKEN]');
}

export function sanitize(data: LogData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      const e = v as { name?: string; message?: string; code?: unknown } | undefined;
      out.err = e ? { name: e.name, code: e.code, message: scrub(String(e.message ?? e)).slice(0, 300) } : null;
    } else if (SENSITIVE_KEYS.test(k) && !/^(code|count|documentId|inserted|duplicates|review|scanned|imported|failed)$/.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) {
      out[k] = v;
    } else {
      out[k] = scrub(String(v)).slice(0, 300);
    }
  }
  return out;
}

/** JSON-lines logger with size-based rotation (one backup). Minimal, structured, no financial payloads. */
export function createFileLogger(file: string, level: Level, alsoConsole: boolean): Logger {
  mkdirSync(dirname(file), { recursive: true });
  const write = (lvl: Level, msg: string, data?: LogData) => {
    if (ORDER[lvl] > ORDER[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: scrub(msg), ...(data ? sanitize(data) : {}) });
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* logging must never crash the app */
    }
    if (alsoConsole) (lvl === 'error' ? console.error : console.log)(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
