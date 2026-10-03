import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers/core';

function demoCore() {
  const core = makeCore();
  core.data.loadDemo();
  core.recurring.detect();
  return core;
}

describe('«Comprobar mis números» (audit)', () => {
  it('everything reconciles on consistent data: no errors', () => {
    const core = demoCore();
    const r = core.audit.run();
    expect(r.checks.filter((c) => c.status === 'error').map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    // The core identities always hold.
    for (const id of ['savings_identity', 'categories_sum', 'signs']) expect(byId[id]?.status, id).toBe('ok');
    expect(r.checks.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('flags a rule on a generic operation (Bizum) and offers to delete it; once deleted, it reconciles', () => {
    const core = demoCore();
    const ocio = core.repos.categories.list().find((c) => c.name === 'Ocio')!;
    // Rules like this were created by older versions (they can no longer be created from the app).
    const ruleId = core.repos.rules.upsert('merchant', 'BIZUM', ocio.id);
    expect(() => core.categorization.createRule({ matchType: 'merchant', pattern: 'BIZUM', categoryId: ocio.id } as never)).toThrow();
    const broad = core.audit.run().checks.find((c) => c.id === 'broad_rules')!;
    expect(broad.status).toBe('warning');
    expect(broad.detail).toMatch(/BIZUM/);
    expect(broad.fix).toEqual({ kind: 'delete_rules', ruleIds: [ruleId], label: 'Borrar la regla' });
    core.categorization.deleteRule(ruleId);
    const after = core.audit.run().checks.find((c) => c.id === 'broad_rules')!;
    expect(after.status).toBe('ok');
    expect(after.fix).toBeUndefined();
  });
});
