# Hormiga — cada céntimo cuenta

Finanzas personales a partir de tus extractos BBVA. El nombre viene del «gasto hormiga» (los pequeños gastos que se
acumulan sin darnos cuenta) y de la hormiga ahorradora de la fábula.

Hormiga es una aplicación de escritorio (Windows 10/11; portable a macOS/Linux) que construye tu histórico financiero
personal a partir de los extractos/facturas que BBVA te envía por email. Localiza los emails en Gmail (solo lectura,
OAuth 2.0), descarga los PDF, extrae y valida los movimientos, los categoriza con reglas explicables, los guarda en una
base de datos local y calcula estadísticas, ahorro real, capacidad de ahorro, gastos recurrentes y recomendaciones.

**Todo es local.** No se envían movimientos, PDFs, emails ni estadísticas a ningún servicio. La única conexión externa
es la API de Gmail con permiso `gmail.readonly` (y, solo si lo activas, `gmail.send` para enviarte tus avisos a tu propia
dirección). No se usa IA externa: el asistente responde en tu equipo. Nunca se piden credenciales de banca online ni se
accede a la web de BBVA.

> Analizadores BBVA: el PDF de **«Últimos movimientos»** de la cuenta (banca online → Movimientos → descargar PDF)
> está validado con un documento real; el extracto mensual con totales solo con PDFs sintéticos
> (ver [docs/statement-parsing.md](docs/statement-parsing.md)). Si un documento no cuadra, no se importa en silencio:
> pasa a «Revisión de importación».

## Índice

- [Funcionalidades](#funcionalidades) · [Arquitectura](#arquitectura) · [Requisitos](#requisitos)
- [Instalación y desarrollo](#instalación-y-desarrollo) · [Configurar Gmail (OAuth)](#configurar-gmail-oauth)
- [Tests](#tests) · [Build y empaquetado](#build-y-empaquetado) · [Datos, privacidad y copias](#datos-privacidad-y-copias)
- [Troubleshooting](#troubleshooting) · [Documentación técnica](#documentación-técnica)

## Funcionalidades

- **Previsión** (1.0): saldo de la cuenta corriente día a día durante 60 días (cobros por pagador, recibos y cuotas en su
  fecha, gasto variable y traspasos habituales como mediana de los últimos meses), cierre previsto del mes, meses
  estacionalmente caros, palancas de ahorro concretas y un plan que se convierte en presupuestos. Ver
  [docs/forecast.md](docs/forecast.md).
- **Ingresos previsibles**: nómina, pagas extra y transferencias de la propia empresa (horas extra, incentivos)
  agrupadas por pagador.
- **Pregunta a Hormiga**: asistente local y determinista (sin IA externa) que responde con tus datos y con la ayuda
  integrada; **Ctrl+K** abre la paleta de comandos.
- **Perfiles**: varias personas en el mismo equipo, cada una con foto y una carpeta de datos independiente.
- **Avisos**: notificaciones de Windows, email opcional a tu propia dirección y resumen semanal; bandeja del sistema,
  inicio con Windows y punto rojo en la barra de tareas.
- **Comprobar mis números**: auditoría de consistencia (identidad de ahorro, suma de categorías, signos, saldos frente a
  extractos, cuadros de amortización, presupuestos, duplicados, reglas demasiado generales).
- **Otros bancos**: importa el Excel de movimientos de **CaixaBank, imagin, Sabadell, Santander, Openbank, ING,
  Bankinter y BBVA** (incluidos los «.xls» que en realidad son tablas HTML), los CSV de **N26** y **Revolut**, cualquier
  CSV con fecha/concepto/importe y ficheros
  **Norma 43** (AEB). Detecta el banco y verifica los saldos fila a fila cuando el fichero los trae.
- **Metas de ahorro** con fecha y aportaciones, **fondo de emergencia** (meses de gasto esencial cubiertos),
  **patrimonio** (activos, inversiones y deudas con valoraciones periódicas, rentabilidad sobre lo aportado) y
  **simulador** de interés compuesto con tus supuestos. Sin recomendaciones de productos.
- **Bolsa**: lista de seguimiento con señales de compra explicables (corrección en tendencia alcista, cruce dorado,
  precio objetivo), cartera con tus operaciones (FIFO, euros con el tipo de cambio de cada operación, comisiones), señales
  de venta (stop-loss, stop dinámico, objetivo de beneficio, pérdida de tendencia), IRPF estimado y regla de los dos meses.
  Avisos al empezar cada señal. Solo se envía el símbolo; no es asesoramiento financiero. Ver [docs/stocks.md](docs/stocks.md).
- **Ingestión**: Gmail (OAuth 2.0 + PKCE, solo lectura) con detección configurable de emails BBVA, revisión previa a la
  importación inicial, sincronización manual y automática al abrir, recuperación de pendientes tras semanas cerrada,
  tolerancia a fallos parciales. Importación manual de **PDF y CSV** (sin necesidad de Gmail).
- **Procesamiento**: extracción local de texto (pdf.js), `StatementParser` desacoplado (`BbvaStatementParser`,
  `CsvStatementParser`), normalización de importes españoles a céntimos enteros, fechas, líneas partidas, varias páginas,
  devoluciones, PDFs protegidos con contraseña (no se guarda), validación de totales y saldos.
- **Deduplicación**: SHA-256 del documento, id de mensaje + adjunto, periodo del extracto y huella de cada movimiento.
- **Revisión de importación** para documentos inconsistentes o filas dudosas: nada cuenta hasta que lo confirmas.
- **Categorización determinista** (reglas tuyas → semántica del movimiento → comercio conocido → palabras clave →
  sin clasificar), con origen y confianza registrados; **reglas aprendidas** de tus correcciones.
- **Normalización de comercios** («MERCADONA 1234 BARCELONA» → «Mercadona»), conservando siempre la descripción original.
- **Gastos recurrentes** (probable / confirmado / no recurrente), coste mensual y anual, próxima fecha estimada.
- **Ingresos** configurables por periodo (salario, recurrentes, extraordinarios) y **objetivo de ahorro** (€ o %).
- **Analítica**: resumen del mes, evolución, categorías, comercios, tendencias, medias 3/6/12 meses, comparaciones,
  previsión de fin de mes, perfil de gasto descriptivo.
- **Ahorro**: ahorro real, tasa, capacidad estimada con fórmula visible, escenarios actual/moderado/objetivo.
- **Recomendaciones** explicables con evidencia e impacto mensual/anual (nunca de inversión).
- **Datos**: exportación CSV/JSON, copia de seguridad y restauración validada, eliminar todos los datos, datos de demostración.
- Tema claro/oscuro, navegación por teclado, textos y estados vacíos comprensibles.

## Arquitectura

```
Renderer (React + Vite)          src/renderer   UI, sin acceso a Node
        │  window.hormiga.invoke(canal, datos)   (lista blanca de canales)
Preload (contextBridge)          src/preload
        │  IPC  → validación zod + comprobación de origen
Main (Electron)                  src/main       ventanas, diálogos, protocolo app://, almacén seguro, logs
        │
Aplicación / servicios           src/core/services   import, sync, categorización, analítica, datos…
Dominio (puro, testeable)        src/core/domain     dinero, comercios, categorizador, recurrencia, métricas, recomendaciones
Parsing                          src/core/parsing    PDF → texto → StatementParser → normalización/validación
Email                            src/core/email      EmailProvider (Gmail), detección BBVA, OAuth
Repositorios                     src/core/db         SQLite (node:sqlite), migraciones versionadas
Compartido                       src/shared          tipos, contrato IPC, dinero y fechas
```

- **Stack**: Electron 44 · React 19 · TypeScript · Vite (electron-vite) · SQLite integrado (`node:sqlite`, sin módulos
  nativos que recompilar) · pdf.js · google-auth-library · Recharts · zod · Vitest · Playwright (E2E) · electron-builder.
- `src/core` no depende de Electron: se testea en Node con dobles (vault en memoria, Gmail simulado).
- Detalles: [docs/architecture.md](docs/architecture.md).

## Requisitos

- Windows 10/11 x64 (desarrollo también posible en macOS/Linux).
- Node.js **≥ 22.13** (probado con 22.23) y npm.
- Para Gmail: una cuenta de Google y un proyecto propio de Google Cloud (gratuito). Ver más abajo.

## Instalación y desarrollo

```bash
npm install
```

```bash
npm run dev
```

Scripts:

| Script | Qué hace |
| --- | --- |
| `npm run dev` | App en modo desarrollo con recarga (Vite + Electron) |
| `npm test` | Tests unitarios, de integración y de UI (Vitest) |
| `npm run lint` | ESLint (incluye reglas de arquitectura: el renderer no puede importar Node/Electron/core) |
| `npm run typecheck` | TypeScript estricto (main + renderer) |
| `npm run check` | lint + typecheck + tests |
| `npm run build` | typecheck + compilación a `out/` |
| `npm start` | Ejecuta la app compilada |
| `npm run e2e` | E2E sobre la app Electron compilada (requiere `npm run build`) |
| `npm run package` | Instalador Windows (NSIS) en `release/` |
| `npm run package:dir` | App sin instalador en `release/win-unpacked/` |

Al abrir por primera vez aparece el asistente: privacidad → Gmail (opcional) → ingresos → objetivo → importar histórico
→ revisión. Puedes probar todo sin datos reales con **«Probar con datos de demostración»** (12 meses ficticios,
eliminables desde Ajustes).

## Configurar Gmail (OAuth)

Google exige que cada aplicación de escritorio use su propio cliente OAuth. Para uso personal basta con un proyecto en
modo «Testing» (no requiere verificación de Google):

1. Entra en <https://console.cloud.google.com/>, crea un proyecto (p. ej. «Hormiga personal»).
2. **APIs y servicios → Biblioteca → Gmail API → Habilitar**.
3. **Pantalla de consentimiento OAuth**: tipo *Externo*, estado *Testing*, añade tu dirección como *usuario de prueba*.
   Ámbito: `https://www.googleapis.com/auth/gmail.readonly` (solo lectura).
4. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación de escritorio**.
5. Copia el *ID de cliente* y el *secreto de cliente* en Hormiga → **Ajustes → Cuenta de correo** (se guardan cifrados
   con DPAPI). En desarrollo también puedes ponerlos en `.env` (ver [.env.example](.env.example)).
6. Pulsa **Conectar con Google**: se abre tu navegador; Hormiga recibe el código en `http://127.0.0.1:<puerto>` (PKCE +
   `state`). Hormiga nunca ve tu contraseña.

Notas: en modo *Testing* Google caduca los tokens de actualización a los 7 días; si ocurre, Hormiga muestra «Requiere
volver a conectar». Para evitarlo puedes publicar la app en tu proyecto (sigue siendo de uso privado).
Desconectar revoca el acceso en Google y borra los tokens locales.

## Tests

```bash
npm run check
```

- **Unitarios** (`tests/unit`): dinero (incl. `0,1 + 0,2`), fechas, comercios, categorizador, tipos de movimiento,
  recurrencia, métricas y ahorro (invariantes), recomendaciones (sin consejos de inversión), parser PDF con PDFs
  sintéticos (una/varias páginas, devolución, miles, línea partida, total incoherente, saldo, documento inválido), CSV,
  detección de emails, Gmail simulado, OAuth (PKCE, `state`, cancelación), logs seguros, validación IPC.
- **Integración** (`tests/integration`): documento → parser → normalización → SQLite → analítica; duplicados;
  solapes; revisión; reglas aprendidas; exportación; copia de seguridad; integridad; sincronización Gmail simulada.
- **UI** (`tests/ui`): cambio de categoría → propuesta de regla → creación.
- **E2E** (`npm run build && npm run e2e`): lanza la app Electron real con un perfil temporal y documentos sintéticos:
  seguridad del renderer, onboarding, importación, duplicado, regla aprendida, trazabilidad, ahorro, demo,
  exportación, copia, tema oscuro, ausencia de errores y de datos financieros en logs. Capturas en `.e2e-userdata/shots`.

Los fixtures son **PDFs sintéticos generados en el test** (`tests/helpers/synthetic-statement.mjs`): no hay datos reales
en el repositorio.

## Build y empaquetado

```bash
npm run package
```

Genera en `release/`:

- `Hormiga-<versión>-portable.exe`: **un único ejecutable para compartir** (no requiere instalación).
- `Hormiga-Setup-<versión>.exe`: instalador NSIS por usuario, x64 (accesos directos, desinstalador).

### Compartir con otras personas

**Para tus amigos y familia** hay una página de descarga sin código: <https://github.com/davidescobar98/hormiga-app>
(botón «Descargar Hormiga para Windows»). Una vez instalada, la app se actualiza sola.

El ejecutable no contiene ningún dato: ni movimientos, ni documentos, ni credenciales. Cada persona que lo abre empieza
con una base de datos vacía en su propio `%APPDATA%\Hormiga` (o en la carpeta de su perfil) y carga sus propios extractos (o usa los datos de
demostración). Para Gmail, cada persona configura su propio cliente OAuth (o el tuyo si la añades como usuario de
prueba en tu proyecto de Google Cloud); la importación manual de PDF funciona sin configurar nada. El paquete solo contiene `out/`
(código compilado, sin source maps) y las dependencias de producción (`google-auth-library`, `pdfjs-dist`, `zod`);
no incluye tests, fixtures, `.env` ni herramientas de desarrollo. Se aplican *Electron fuses* (sin `RunAsNode`, sin
`NODE_OPTIONS`, sin `--inspect`, integridad del ASAR, carga solo desde ASAR).

Verificación del ejecutable instalado:

```bash
"release/win-unpacked/Hormiga.exe" --self-test
```

Comprueba pdf.js + analizador, SQLite y el almacén seguro del sistema, sin tocar tus datos.

El instalador no está firmado con un certificado de código: Windows SmartScreen mostrará un aviso la primera vez.

## Datos, privacidad y copias

| Qué | Dónde |
| --- | --- |
| Base de datos | `%APPDATA%\Hormiga\data\hormiga.db` |
| PDFs conservados (solo si lo activas) | `%APPDATA%\Hormiga\data\documents\<sha256>.pdf` |
| Credenciales Gmail (cifradas DPAPI) | `%APPDATA%\Hormiga\data\secrets\*.bin` |
| Registro técnico (sin datos financieros) | `%APPDATA%\Hormiga\logs\hormiga.log` |

- La variable `HORMIGA_USER_DATA` permite usar otra carpeta de perfil (pruebas o uso portable).
- **Exportar**: Ajustes → Privacidad → CSV (separador `;`, coma decimal, UTF-8 con BOM) o JSON completo.
- **Copia de seguridad**: archivo `.hormiga-backup` (SQLite consistente vía `VACUUM INTO`). No incluye credenciales ni
  PDFs. **No está cifrado**: guárdalo en lugar seguro.
- **Restaurar**: se valida que sea una copia de Hormiga y de una versión compatible, se pide confirmación escrita y
  nativa, y la base actual se guarda como `hormiga.db.pre-restore-<fecha>` antes de sustituirla.
- **Eliminar todos mis datos**: confirmación escrita (`ELIMINAR`) + diálogo nativo; borra base de datos, PDFs,
  credenciales (revocando el acceso) y configuración.

Más detalle en [docs/security.md](docs/security.md).

## Troubleshooting

| Problema | Solución |
| --- | --- |
| «Documento con formato no reconocido» | El PDF no parece un extracto BBVA o cambió el formato. Prueba a exportar CSV desde la banca online e importarlo, y consulta [docs/statement-parsing.md](docs/statement-parsing.md). |
| Documento en «Revisión de importación» | Los totales no cuadraban o alguna fila no se entendió. Compara con el PDF, corrige/descarta filas y confirma. |
| «PDF protegido con contraseña» | Introduce la contraseña del documento (no la de la banca online). No se guarda. |
| «No hay conexión con Gmail» | Revisa internet; lo ya importado sigue disponible. Se reintentará en la próxima sincronización. |
| «Requiere volver a conectar» | Token caducado/revocado (en modo *Testing* caduca a los 7 días). Ajustes → Conectar con Google. |
| «Gmail ha denegado el acceso» | Habilita Gmail API en tu proyecto y concede el permiso de lectura al conectar. |
| «La base de datos está ocupada» | Cierra otras instancias de Hormiga (solo se permite una). |
| La app se abre como Node / no arranca en desarrollo | Algunos terminales exportan `ELECTRON_RUN_AS_NODE`; los scripts `npm run dev/start` lo eliminan automáticamente. |
| Aviso `ExperimentalWarning: SQLite` al ejecutar tests | Normal en Node 22: `node:sqlite` está marcado como experimental; la app usa la versión incluida en Electron. |
| Verificar una instalación | `Hormiga.exe --self-test`. |

## Documentación técnica

- [docs/forecast.md](docs/forecast.md) — previsión de saldo, ingresos por pagador, meses completos y plan de ahorro.
- [docs/stocks.md](docs/stocks.md) — Bolsa: indicadores, señales, FIFO, impuestos y avisos.
- [docs/mobile.md](docs/mobile.md) — plan para iOS y Android.
- [docs/budgets-alerts-lock.md](docs/budgets-alerts-lock.md) — presupuestos, avisos, sincronización periódica, bloqueo y operaciones patrimoniales.
- [docs/accounts-and-transfers.md](docs/accounts-and-transfers.md) — cuentas y saldos, transferencias, perfil y ahorro ampliado.
- [docs/architecture.md](docs/architecture.md) — capas, contrato IPC, modelo de datos.
- [docs/email-ingestion.md](docs/email-ingestion.md) — Gmail, detección, sincronización, deduplicación.
- [docs/statement-parsing.md](docs/statement-parsing.md) — pipeline de documentos y cómo adaptar el formato BBVA real.
- [docs/categorization.md](docs/categorization.md) — comercios, reglas y aprendizaje.
- [docs/financial-calculations.md](docs/financial-calculations.md) — fórmulas exactas.
- [docs/recommendations.md](docs/recommendations.md) — reglas de recomendación y umbrales.
- [docs/savings-and-wealth.md](docs/savings-and-wealth.md) — metas, fondo de emergencia, patrimonio y simulador.
- [docs/security.md](docs/security.md) — revisión de seguridad.
