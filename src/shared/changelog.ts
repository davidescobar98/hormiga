/** User-facing release notes, newest first. Shown once after updating to a newer version. */
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ReleaseNotes[] = [
  {
    version: '1.0.0',
    date: '2026-10-03',
    items: [
      'Nueva sección «Previsión»: cómo evolucionará el saldo de tu cuenta corriente día a día en los próximos 60 días (nóminas, recibos, cuotas y tu gasto habitual), cómo acabarás el mes, los meses que suelen costarte más y un plan de ahorro con recortes concretos que puedes convertir en presupuestos con un clic.',
      'Tus ingresos, agrupados por quién te paga: nómina, pagas extra y lo que te transfiere tu propia empresa aparte de la nómina (horas extra, incentivos) cuentan como ingresos previsibles.',
      '«Pregunta a Hormiga»: un asistente que responde con tus datos («¿cuánto gasté en restaurantes en mayo?», «¿cómo acabaré el mes?», «¿cómo puedo ahorrar más?») sin enviarlos a ningún sitio. Ctrl+K para buscar cualquier página o ayuda.',
      'Nueva sección «Ayuda» con guías cortas de cada parte de la app, y un menú más sencillo agrupado en Ahorrar, Invertir y Más.',
      'Perfiles: varias personas en el mismo ordenador, cada una con su foto y sus datos totalmente separados (movimientos, documentos, Gmail, PIN y copias).',
      'Avisos importantes por email a tu propia dirección (opcional) y resumen semanal los lunes. Avisos nuevos: saldo bajo previsto, gasto por encima de lo habitual y meses caros que se acercan.',
      'Hormiga puede quedarse en la bandeja del sistema al cerrar la ventana, abrirse al iniciar Windows y mostrar un punto rojo en la barra de tareas cuando hay avisos.',
      '«Comprobar mis números» (Ajustes): verifica que todo cuadra (ahorro, categorías, saldos frente a extractos, préstamos, presupuestos, duplicados) y explica cualquier diferencia; las reglas demasiado generales se pueden borrar desde ahí.',
      'Gmail ya no pide volver a crear las credenciales: Hormiga las conserva hasta que tú las borres. Si la conexión caduca cada 7 días, la app te explica cómo evitarlo (publicar tu app de Google Cloud).',
      'Importación validada con los formatos de exportación de BBVA, CaixaBank, imagin, Santander, Sabadell, ING, Openbank, Bankinter, N26 y Revolut, además de cualquier CSV con columnas de cargo y abono. Volver a importar un extracto que se solapa con otro ya no duplica movimientos.',
      'Corregido: los presupuestos y medias usaban meses incompletos (un recibo de fin de mes aún no importado bajaba la media) y un mes con dos cuotas inflaba la media; ahora se usa lo habitual (mediana) de meses completos.',
      'Corregido: ya no se crean reglas sobre operaciones genéricas como Bizum o transferencias, que mezclaban gastos y devoluciones en una sola categoría.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-03',
    items: [
      'Nueva sección «Bolsa»: sigue acciones y ETF y recibe avisos cuando se cumplen reglas de compra (corrección dentro de una tendencia alcista, cruce dorado, precio objetivo). Antes de comprar comprueba que tu fondo de emergencia está cubierto y te indica un importe máximo orientativo.',
      'Registra tus compras y ventas: rentabilidad real en euros (tipo de cambio y comisiones incluidos), método FIFO, IRPF estimado, regla de los dos meses y avisos de venta (stop-loss, stop dinámico, objetivo de beneficio, pérdida de tendencia). Tú decides los porcentajes.',
      'Tu cartera de bolsa suma en «Patrimonio». Las transferencias a brókers y las compras de valores o fondos ya no cuentan como gasto.',
      'Cada cuenta comprueba que su saldo calculado cuadra con el saldo final de cada extracto importado y avisa si falta o sobra algún movimiento.',
      'Solo se envía a internet el símbolo de cada valor (con los datos de mercado activados); tus operaciones no salen de tu equipo. Las señales son reglas técnicas, no asesoramiento financiero.',
    ],
  },
  {
    version: '0.4.2',
    date: '2026-09-30',
    items: [
      'La cuota de tus préstamos se separa en intereses (gasto) y capital amortizado (reduce tu deuda, cuenta como ahorro), usando el préstamo registrado en «Patrimonio». Se puede desactivar en Ajustes.',
      'Si Windows no puede leer la conexión con Gmail guardada, Hormiga ahora lo avisa y te indica cómo volver a conectarla (antes la sincronización dejaba de funcionar sin decir nada).',
      'Los extractos marcados para reintentar se vuelven a descargar aunque sean antiguos.',
    ],
  },
  {
    version: '0.4.1',
    date: '2026-09-30',
    items: [
      'Corregido: una empresa (por ejemplo la que te paga la nómina por transferencia) marcada como «cuenta mía» dejaba de contar como ingreso. Esas marcas se han deshecho y ya no se permiten.',
      'Revisión de transferencias más clara: «Es una cuenta mía», «Mi pareja» y «Otra persona o empresa» (o «Me paga» si solo te envía dinero).',
    ],
  },
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
