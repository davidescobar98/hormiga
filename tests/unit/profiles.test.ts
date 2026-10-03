import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from '../../src/main/profiles';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

describe('profiles', () => {
  it('starts with the existing data as the first profile; each new one gets its own folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'hormiga-profiles-'));
    const s = new ProfileStore(root);
    expect(s.list(false)).toMatchObject({ activeId: 'main', mustChoose: false, profiles: [{ id: 'main', name: 'Principal' }] });
    expect(s.dirOf('main')).toBe(join(root, 'data'));
    const ana = s.create({ name: 'Ana', color: '#b5559b', photo: PHOTO });
    const dir = s.dirOf(ana.id);
    expect(dir).not.toBe(s.dirOf('main'));
    expect(existsSync(dir)).toBe(true);
    // With two people, Hormiga asks who is using it (until someone chooses in this session).
    expect(s.list(false).mustChoose).toBe(true);
    expect(s.list(true).mustChoose).toBe(false);
    s.setAskOnStart(false);
    expect(s.list(false).mustChoose).toBe(false);
    // Persisted.
    const again = new ProfileStore(root);
    expect(again.list(true).profiles.map((p) => p.name)).toEqual(['Principal', 'Ana']);
    expect(again.list(true).profiles[1]!.photo).toBe(PHOTO);
  });

  it('validates names and photos, and never deletes the active profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'hormiga-profiles-'));
    const s = new ProfileStore(root);
    expect(() => s.create({ name: ' ', color: '#000000', photo: null })).toThrow(/nombre/);
    expect(() => s.create({ name: 'principal', color: '#000000', photo: null })).toThrow(/Ya hay/);
    expect(() => s.create({ name: 'Ana', color: '#000000', photo: 'data:text/html;base64,PHNjcmlwdD4=' })).toThrow(/foto/);
    const m = s.create({ name: 'Ana', color: '#000000', photo: null });
    writeFileSync(join(s.dirOf(m.id), 'hormiga.db'), 'x');
    expect(() => s.remove('main')).toThrow(/estás usando/);
    s.setActive(m.id);
    expect(s.active.id).toBe(m.id);
    s.setActive('main');
    const dir = s.dirOf(m.id);
    s.remove(m.id);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, 'data'))).toBe(false); // the main folder is never created or touched by the list
    expect(s.list(true).profiles).toHaveLength(1);
  });
});
