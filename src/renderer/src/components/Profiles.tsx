import { useRef, useState, type ReactNode } from 'react';
import { api, toApiError, useQuery } from '../api';
import type { ProfileDTO, ProfilesState } from '../../../shared/types';
import { Callout, Card, Dialog, Field, Loading, useToast } from './ui';

const COLORS = ['#0f6b5c', '#2f5f8a', '#b5559b', '#c47a2c', '#7b61c4', '#b3412e', '#3aa17e', '#5b6b8c'];

export function Avatar({ p, size = 36 }: { p: Pick<ProfileDTO, 'name' | 'color' | 'photo'>; size?: number }) {
  const initials = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return p.photo ? (
    <img src={p.photo} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} />
  ) : (
    <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: p.color, color: '#fff', display: 'inline-grid', placeItems: 'center', fontWeight: 700, fontSize: size * 0.4, flex: 'none' }}>{initials}</span>
  );
}

/** Resizes a picked image to a small square JPEG data URL (kept only on this computer). */
async function toPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      i.src = url;
    });
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const s = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Before anything loads: who is using Hormiga? (only when there are several profiles). */
export function ProfileGate({ children }: { children: ReactNode }) {
  const q = useQuery(() => api('profiles.list'), []);
  const [busy, setBusy] = useState<string | null>(null);
  if (q.error) return <>{children}</>;
  if (!q.data) return <Loading label="Abriendo Hormiga…" />;
  if (!q.data.mustChoose) return <>{children}</>;
  const pick = async (id: string) => {
    setBusy(id);
    await api('profiles.switch', { id });
    // Same profile: continue here. Another one: Hormiga restarts with that profile's data.
    q.reload();
  };
  return (
    <div className="profile-picker">
      <h1>¿Quién usa Hormiga?</h1>
      <p className="muted">Cada perfil tiene sus propios movimientos, documentos y conexión con Gmail.</p>
      <div className="profile-grid">
        {q.data.profiles.map((p) => (
          <button key={p.id} className="profile-tile" disabled={!!busy} onClick={() => void pick(p.id)}>
            <Avatar p={p} size={88} />
            <span>{busy === p.id ? 'Abriendo…' : p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Active profile at the top of the sidebar, with a menu to switch. */
export function ProfileSwitcher({ onManage }: { onManage: () => void }) {
  const q = useQuery(() => api('profiles.list'), []);
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const active = q.data.profiles.find((p) => p.id === q.data!.activeId)!;
  const others = q.data.profiles.filter((p) => p.id !== active.id);
  return (
    <div className="profile-switcher">
      <button className="profile-current" aria-expanded={open} aria-label={`Perfil: ${active.name}. Cambiar de perfil`} onClick={() => setOpen((o) => !o)}>
        <Avatar p={active} size={28} />
        <span className="profile-name">{active.name}</span>
        <span aria-hidden className="muted small">▾</span>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {others.map((p) => (
            <button key={p.id} role="menuitem" onClick={() => void api('profiles.switch', { id: p.id })}>
              <Avatar p={p} size={22} /> Cambiar a {p.name}
            </button>
          ))}
          <button role="menuitem" onClick={() => { setOpen(false); onManage(); }}>{others.length ? 'Gestionar perfiles' : 'Añadir otra persona'}</button>
        </div>
      )}
    </div>
  );
}

/** Settings: add, edit and delete profiles. */
export function ProfilesCard() {
  const q = useQuery(() => api('profiles.list'), []);
  const toast = useToast();
  const [editing, setEditing] = useState<ProfileDTO | 'new' | null>(null);
  const run = async (fn: () => Promise<ProfilesState>, ok?: string) => {
    try {
      await fn();
      q.reload();
      if (ok) toast({ tone: 'info', message: ok });
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  if (!q.data) return null;
  return (
    <Card title="Perfiles" hint="Varias personas en el mismo ordenador, cada una con sus datos por separado" actions={<button className="btn" onClick={() => setEditing('new')}>Añadir perfil</button>}>
      <ul className="plain-list">
        {q.data.profiles.map((p) => (
          <li key={p.id} className="row" style={{ gap: 12, alignItems: 'center' }}>
            <Avatar p={p} size={40} />
            <div style={{ flex: 1 }}>
              <strong>{p.name}</strong> {p.id === q.data!.activeId && <span className="muted small">· perfil actual</span>}
            </div>
            <button className="btn sm" onClick={() => setEditing(p)}>Editar</button>
            {p.id !== q.data!.activeId && <button className="btn sm" onClick={() => void run(() => api('profiles.switch', { id: p.id }))}>Cambiar a este</button>}
            {p.id !== q.data!.activeId && <button className="btn sm danger" onClick={() => void run(() => api('profiles.delete', { id: p.id }))}>Borrar</button>}
          </li>
        ))}
      </ul>
      {q.data.profiles.length > 1 && (
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={q.data.askOnStart} onChange={(e) => void run(() => api('profiles.setAskOnStart', { value: e.target.checked }))} />
          Preguntar quién usa Hormiga al abrirla
        </label>
      )}
      <p className="muted small">Cada perfil guarda sus movimientos, documentos, metas, conexión con Gmail, PIN y copias en su propia carpeta. Para proteger tu perfil de los demás, activa un PIN en «Seguridad».</p>
      {editing && <ProfileDialog profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
    </Card>
  );
}

function ProfileDialog({ profile, onClose, onSaved }: { profile: ProfileDTO | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? COLORS[1]!);
  const [photo, setPhoto] = useState<string | null>(profile?.photo ?? null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const save = async () => {
    setError(null);
    try {
      if (profile) await api('profiles.update', { id: profile.id, name, color, photo });
      else await api('profiles.create', { name, color, photo });
      onSaved();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open title={profile ? 'Editar perfil' : 'Nuevo perfil'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>Guardar</button></>}>
      <div className="row" style={{ gap: 16, alignItems: 'center' }}>
        <Avatar p={{ name: name || '?', color, photo }} size={72} />
        <div className="stack" style={{ gap: 6 }}>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { setPhoto(await toPhoto(f)); } catch (err) { setError((err as Error).message); } } }} />
          <button className="btn sm" onClick={() => file.current?.click()}>{photo ? 'Cambiar foto' : 'Añadir foto'}</button>
          {photo && <button className="btn sm link" onClick={() => setPhoto(null)}>Quitar foto</button>}
        </div>
      </div>
      <Field label="Nombre" htmlFor="profile-name">
        <input id="profile-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre de la persona" />
      </Field>
      <div className="row" style={{ gap: 6 }} role="radiogroup" aria-label="Color">
        {COLORS.map((c) => (
          <button key={c} role="radio" aria-checked={c === color} aria-label={`Color ${c}`} onClick={() => setColor(c)} style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: c === color ? '3px solid var(--ink)' : '2px solid transparent', cursor: 'pointer' }} />
        ))}
      </div>
      {!profile && <Callout tone="info">El nuevo perfil empieza vacío: al cambiar a él, Hormiga se reiniciará y te guiará para importar sus extractos.</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
