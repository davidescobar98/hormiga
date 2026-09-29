import { safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretVault } from '../core/email/types';

/**
 * Secrets encrypted with Electron safeStorage: DPAPI on Windows (bound to the Windows user),
 * Keychain on macOS, libsecret/kwallet on Linux. Never stored in SQLite, JSON settings, .env or localStorage.
 */
export class SafeStorageVault implements SecretVault {
  constructor(private readonly dir: string) {}

  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring Electron falls back to a hard-coded key: treat as unavailable.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  }

  private file(name: string): string {
    if (!/^[a-z0-9.]+$/i.test(name)) throw new Error('Nombre de secreto no válido');
    return join(this.dir, `${name}.bin`);
  }

  async get(name: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      return safeStorage.decryptString(await readFile(this.file(name)));
    } catch {
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.isAvailable()) throw new Error('Almacenamiento seguro no disponible');
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(name)}.tmp`;
    await writeFile(tmp, safeStorage.encryptString(value), { mode: 0o600 });
    await rename(tmp, this.file(name));
  }

  async unreadable(name: string): Promise<boolean> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file(name));
    } catch {
      return false;
    }
    if (!this.isAvailable()) return true;
    try {
      safeStorage.decryptString(bytes);
      return false;
    } catch {
      return true;
    }
  }

  async delete(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}
