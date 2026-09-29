import { useEffect, useState } from 'react';
import { api, useQuery } from '../api';
import { notesSince, type ReleaseNotes } from '../../../shared/changelog';
import { formatDate } from '../../../shared/dates';
import { Dialog } from './ui';

/** After an update, shows once what changed since the version the user last opened. */
export function WhatsNew({ lastSeenVersion }: { lastSeenVersion: string | null }) {
  const info = useQuery(() => api('app.info'), []);
  const [notes, setNotes] = useState<ReleaseNotes[]>([]);
  const current = info.data?.version ?? null;

  useEffect(() => {
    if (!current || current === lastSeenVersion) return;
    // Users coming from 0.1.0 have no record yet: show what came after it.
    const n = notesSince(lastSeenVersion ?? '0.1.0', current);
    if (n.length) setNotes(n);
    else void api('settings.update', { lastSeenVersion: current });
  }, [current, lastSeenVersion]);

  if (!notes.length || !current) return null;
  const close = () => {
    setNotes([]);
    void api('settings.update', { lastSeenVersion: current });
  };
  return (
    <Dialog open title={`Hormiga se ha actualizado a la versión ${current}`} onClose={close} footer={<button className="btn primary" onClick={close}>Entendido</button>}>
      <p className="muted small">Tus datos se han conservado. Esto es lo nuevo:</p>
      {notes.map((r) => (
        <section key={r.version}>
          <h3>Versión {r.version} <span className="muted small">· {formatDate(r.date)}</span></h3>
          <ul>{r.items.map((i) => <li key={i}>{i}</li>)}</ul>
        </section>
      ))}
    </Dialog>
  );
}
