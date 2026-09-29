import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface FingerprintInput {
  date: string;
  amountCents: number;
  descriptionNormalized: string;
}

/**
 * Stable identity of a movement across documents: date + amount + normalized description + occurrence index.
 * The occurrence index distinguishes genuinely repeated movements inside one document (two identical coffees
 * on the same day) while the same movement appearing in two overlapping statements maps to the same fingerprint.
 */
export function assignFingerprints<T extends FingerprintInput>(rows: T[]): (T & { fingerprint: string })[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amountCents}|${r.descriptionNormalized}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { ...r, fingerprint: sha256Hex(`v1|${base}|${occurrence}`) };
  });
}
