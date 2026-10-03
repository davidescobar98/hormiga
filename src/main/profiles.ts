import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileDTO, ProfilesState } from '../shared/types';

/*
 * Several people on the same computer, each with their own Hormiga: a separate folder per profile with its own
 * database, documents, Gmail connection, PIN and backups. Nothing is shared between profiles except this list
 * (names, colours and photos). The first profile keeps the original data folder ("data").
 */

interface StoredProfile extends ProfileDTO {
  /** Folder under the app's data directory. */
  dir: string;
}

interface Stored {
  profiles: StoredProfile[];
  activeId: string;
  askOnStart: boolean;
}

const FILE = 'profiles.json';
const MAX_PHOTO = 400_000;
export const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export class ProfileStore {
  private state: Stored;

  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {
    this.state = this.load();
  }

  private load(): Stored {
    const file = join(this.root, FILE);
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8')) as Stored;
        if (Array.isArray(s.profiles) && s.profiles.length && s.profiles.some((p) => p.id === s.activeId)) return s;
      } catch {
        // Fall through to a fresh list; the data folders are untouched.
      }
    }
    return { profiles: [{ id: 'main', name: 'Principal', color: '#0f6b5c', photo: null, createdAt: this.now().toISOString(), dir: 'data' }], activeId: 'main', askOnStart: true };
  }

  private save(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    const file = join(this.root, FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  get active(): StoredProfile {
    return this.state.profiles.find((p) => p.id === this.state.activeId)!;
  }

  dirOf(id: string): string {
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Perfil no encontrado');
    return join(this.root, p.dir);
  }

  list(chosen: boolean): ProfilesState {
    return {
      profiles: this.state.profiles.map(({ dir: _dir, ...p }) => p),
      activeId: this.state.activeId,
      askOnStart: this.state.askOnStart,
      // Ask who you are when several people use Hormiga and no one has chosen yet in this session.
      mustChoose: this.state.profiles.length > 1 && this.state.askOnStart && !chosen,
    };
  }

  create(input: { name: string; color: string; photo: string | null }): ProfileDTO {
    const name = input.name.trim().slice(0, 40);
    if (!name) throw new Error('Pon un nombre al perfil.');
    if (this.state.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Ya hay un perfil con ese nombre.');
    if (this.state.profiles.length >= 8) throw new Error('Como mucho 8 perfiles.');
    this.checkPhoto(input.photo);
    const id = randomBytes(6).toString('hex');
    const p: StoredProfile = { id, name, color: input.color, photo: input.photo, createdAt: this.now().toISOString(), dir: join('profiles', id) };
    mkdirSync(join(this.root, p.dir), { recursive: true });
    this.state.profiles.push(p);
    this.save();
    return { id, name, color: p.color, photo: p.photo, createdAt: p.createdAt };
  }

  update(id: string, patch: { name?: string; color?: string; photo?: string | null }): void {
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Perfil no encontrado');
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 40);
      if (!name) throw new Error('Pon un nombre al perfil.');
      if (this.state.profiles.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('Ya hay un perfil con ese nombre.');
      p.name = name;
    }
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.photo !== undefined) {
      this.checkPhoto(patch.photo);
      p.photo = patch.photo;
    }
    this.save();
  }

  setActive(id: string): void {
    if (!this.state.profiles.some((p) => p.id === id)) throw new Error('Perfil no encontrado');
    this.state.activeId = id;
    this.save();
  }

  setAskOnStart(v: boolean): void {
    this.state.askOnStart = v;
    this.save();
  }

  /** Deletes another profile and all its data (never the active one, never the last one). */
  remove(id: string): void {
    if (id === this.state.activeId) throw new Error('No puedes borrar el perfil que estás usando: cambia a otro primero.');
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Perfil no encontrado');
    this.state.profiles = this.state.profiles.filter((x) => x.id !== id);
    this.save();
    rmSync(join(this.root, p.dir), { recursive: true, force: true });
  }

  private checkPhoto(photo: string | null): void {
    if (photo === null) return;
    if (photo.length > MAX_PHOTO || !PHOTO_RE.test(photo)) throw new Error('La foto debe ser una imagen PNG, JPG o WebP pequeña.');
  }
}
