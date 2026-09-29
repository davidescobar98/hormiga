import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UpdateStatus } from '../../../shared/types';

export function useUpdateStatus(): [UpdateStatus | null, (s: UpdateStatus) => void] {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void api('app.updateStatus').then((s) => alive && setStatus(s)).catch(() => undefined);
    const off = window.hormiga.on('update.status', (s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return [status, setStatus];
}

/** Shown once a new version has been downloaded in the background. */
export function UpdateBanner() {
  const [status] = useUpdateStatus();
  const [hidden, setHidden] = useState(false);
  if (!status || status.state !== 'ready' || hidden) return null;
  return (
    <div className="update-banner" role="status">
      <span>Hormiga <strong>{status.version}</strong> está lista. Se instalará al cerrar la aplicación, o ahora mismo:</span>
      <button className="btn sm primary" onClick={() => void api('app.installUpdate')}>Reiniciar y actualizar</button>
      <button className="btn sm ghost" onClick={() => setHidden(true)}>Más tarde</button>
    </div>
  );
}

export function describeUpdate(s: UpdateStatus | null): string {
  if (!s) return '…';
  switch (s.state) {
    case 'unsupported':
      return 'Esta copia no se actualiza sola (versión portátil o de desarrollo). Instala Hormiga con el instalador para recibir actualizaciones automáticas.';
    case 'idle':
      return 'Actualizaciones automáticas preparadas.';
    case 'checking':
      return 'Buscando actualizaciones…';
    case 'none':
      return 'Tienes la última versión.';
    case 'downloading':
      return `Descargando la versión ${s.version ?? ''}${s.percent !== null ? ` (${s.percent} %)` : ''}…`;
    case 'ready':
      return `La versión ${s.version} está descargada y se instalará al reiniciar.`;
    case 'error':
      return s.message ?? 'No se pudo comprobar la actualización.';
  }
}
