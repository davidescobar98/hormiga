import { createCore, type Core } from '../../src/core/app';
import { Database } from '../../src/core/db/database';
import type { EmailProvider, SecretVault } from '../../src/core/email/types';
import { nullLogger, type DocumentStore } from '../../src/core/services/context';
import type { MarketProvider } from '../../src/core/market/yahoo';

export class MemoryVault implements SecretVault {
  readonly data = new Map<string, string>();
  unreadable?: (name: string) => Promise<boolean>;
  isAvailable() {
    return true;
  }
  async get(name: string) {
    return this.data.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.data.set(name, value);
  }
  async delete(name: string) {
    this.data.delete(name);
  }
}

export class MemoryDocumentStore implements DocumentStore {
  readonly files = new Map<string, Uint8Array>();
  async save(sha: string, ext: string, bytes: Uint8Array) {
    const p = `/mem/${sha}.${ext}`;
    this.files.set(p, bytes);
    return p;
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async size(p: string) {
    return this.files.get(p)?.byteLength ?? 0;
  }
}

export interface TestCore extends Core {
  clock: { now: Date };
  vault: MemoryVault;
  store: MemoryDocumentStore;
}

export function makeCore(opts: { now?: string; path?: string; provider?: () => Promise<EmailProvider>; market?: MarketProvider } = {}): TestCore {
  const clock = { now: new Date(opts.now ?? '2026-09-15T10:00:00Z') };
  const db = Database.open(opts.path ?? ':memory:', () => clock.now.toISOString());
  const vault = new MemoryVault();
  const store = new MemoryDocumentStore();
  const core = createCore({
    db,
    now: () => clock.now,
    log: nullLogger,
    vault,
    documentStore: store,
    openExternal: async () => {},
    envOAuthClient: null,
    providerFactory: opts.provider,
    // Tests never reach the network: no market provider unless a fake is given.
    marketProvider: opts.market ?? null,
  });
  return { ...core, clock, vault, store };
}
