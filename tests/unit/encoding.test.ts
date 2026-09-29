import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|css|html|md)$/.test(name) ? [p] : [];
  });
}

describe('source encoding', () => {
  it('has no double-encoded UTF-8 (e.g. "JapÃ\u00B3n" instead of "Japón")', () => {
    const offenders = [...files('src'), ...files('docs'), 'README.md'].filter((f) => /Ã[\u0080-\u00BF]|Â[\u00A0-\u00BF]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
