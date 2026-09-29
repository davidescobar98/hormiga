import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { DocumentStore } from '../core/services/context';

/** Keeps original documents (only when enabled) inside the app's private data directory, named by SHA-256. */
export class FsDocumentStore implements DocumentStore {
  constructor(private readonly dir: string) {}

  private inside(path: string): string {
    const full = resolve(path);
    if (!full.startsWith(resolve(this.dir) + sep)) throw new Error('Ruta fuera del directorio de documentos');
    return full;
  }

  async save(sha256: string, extension: string, bytes: Uint8Array): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(sha256) || !/^(pdf|csv)$/.test(extension)) throw new Error('Nombre de documento no válido');
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${sha256}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  }

  async remove(path: string): Promise<void> {
    await rm(this.inside(path), { force: true });
  }

  async size(path: string): Promise<number> {
    try {
      return (await stat(this.inside(path))).size;
    } catch {
      return 0;
    }
  }

  resolveOwned(path: string): string {
    return this.inside(path);
  }
}
