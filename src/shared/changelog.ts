/** User-facing release notes, newest first. Shown once after updating to a newer version. */
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ReleaseNotes[] = [
  {
    version: '0.4.0',
    date: '2026-09-30',
    items: [
      'Presupuestos mensuales por categoría, con sugerencias según tus últimos meses, previsión a fin de mes y avisos al 80 % y al superarlos.',
      'Avisos en «Resumen» (y, si quieres, notificaciones de Windows): cargos inusuales o duplicados, subidas de precio, pagos anuales próximos y transferencias por revisar.',
      'Bloqueo con PIN o Windows Hello al abrir, al bloquear Windows o tras un tiempo sin usar el ordenador.',
      'Búsqueda de extractos en Gmail cada pocas horas mientras Hormiga está abierta.',
      'Nuevo lector de los extractos mensuales de cuenta de BBVA que llegan por email (validado con un extracto real).',
      'Nueva categoría «Patrimonio y préstamos»: comprar una vivienda, recibir un préstamo o vender ya no descuadra tu ahorro.',
      'Revisión de movimientos extraordinarios (10.000 € o más) para marcarlos como patrimonio con un clic.',
      'Tus decisiones sobre beneficiarios («Es mía», «Mi pareja»…) se aplican también a las transferencias recibidas.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-29',
    items: [
      'Nueva sección «Cuentas»: cada cuenta con su saldo calculado automáticamente a partir de tus movimientos.',
      'Cuentas manuales (por ejemplo tu cuenta remunerada en otro banco): su saldo crece con cada traspaso y sus intereses.',
      'Transferencias entre tus cuentas: no cuentan como gasto y mantienes la liquidez. Las transferencias grandes sin revisar se tratan así hasta que lo confirmes.',
      'Bizum y transferencias a otras personas cuentan como gasto; asigna a cada beneficiario su categoría (alquiler → Vivienda) una sola vez.',
      'Tu perfil (opcional): hogar, pareja, personas a cargo, ingresos y prioridades para adaptar las sugerencias y tu colchón recomendado.',
      'Ahorro ampliado: adónde va tu dinero, referencia 50/30/20, tu año, colchón para imprevistos y próximos pagos.',
      'Más sugerencias: dinero parado, subidas de precio, suscripciones solapadas, pagos anuales próximos, deudas caras…',
      'Los adjuntos que no son extractos ya no aparecen como errores, y los extractos mensuales de BBVA en revisión se vuelven a intentar.',
      'Los movimientos de la misma cuenta importados en dos formatos ya no se cuentan dos veces.',
    ],
  },
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
