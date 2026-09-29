/** User-facing release notes, newest first. Shown once after updating to a newer version. */
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ReleaseNotes[] = [
  {
    version: '0.2.0',
    date: '2026-09-29',
    items: [
      'Actualizaciones automáticas: Hormiga descarga las nuevas versiones y se actualiza al reiniciar, sin reinstalar.',
      'Extractos por email de cualquier banco (BBVA, CaixaBank, Santander, Sabadell, ING, Openbank, Bankinter…): PDF, Excel, CSV o Norma 43.',
      'Lector genérico de PDF para otros bancos: si no puede comprobar los importes con el saldo, el extracto queda en revisión.',
      'Importa movimientos de CaixaBank, imagin, Sabadell y Santander (Excel/CSV) y ficheros Norma 43.',
      'Metas de ahorro y fondo de emergencia con aportaciones y plazo estimado.',
      'Patrimonio: cuentas remuneradas, depósitos, fondos y acciones estimados con una rentabilidad anual y aportación mensual.',
      'Rentabilidades pasadas de fondos, ETF, acciones e índices desde internet (opcional: solo se envía lo que buscas).',
      'Hipotecas y préstamos con cuadro de amortización, intereses pagados y pendientes, y simulador de amortización anticipada.',
      'Nueva opción para borrar solo los datos cargados y volver a importarlos.',
      'Copia automática de tu base de datos antes de cada cambio de estructura.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-28',
    items: ['Primera versión: Gmail, extractos BBVA, categorías, análisis, ahorro, recurrentes y recomendaciones.'],
  },
];

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Notes for versions newer than `lastSeen` and up to `current` (all up to `current` when `lastSeen` is null). */
export function notesSince(lastSeen: string | null, current: string): ReleaseNotes[] {
  return CHANGELOG.filter((r) => compareVersions(r.version, current) <= 0 && (lastSeen === null || compareVersions(r.version, lastSeen) > 0));
}
