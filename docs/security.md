# Revisión de seguridad y privacidad

Revisión realizada al cerrar el MVP. Estado: ✅ aplicado · ⚠️ limitación conocida.

## OAuth / Gmail

- ✅ OAuth 2.0 para apps instaladas: navegador del sistema, loopback `127.0.0.1` en puerto aleatorio, PKCE S256,
  `state` de 192 bits verificado, timeout de 5 min, servidor cerrado tras la respuesta (tests en `tests/unit/oauth.test.ts`).
- ✅ Ámbito mínimo `gmail.readonly`: la app no puede enviar, modificar ni borrar correos.
- ✅ El proceso principal solo abre `https://accounts.google.com` desde el flujo OAuth; las ayudas usan URLs fijas.
- ✅ Desconectar revoca el token en Google (si hay conexión) y borra los tokens locales siempre.
- ⚠️ El «secreto» de un cliente OAuth de escritorio no es confidencial por diseño de Google; se guarda cifrado igualmente.

## Almacenamiento de secretos

- ✅ Tokens y cliente OAuth cifrados con Electron `safeStorage` (DPAPI en Windows, ligado a tu usuario) en
  `data/secrets/*.bin`. Nunca en SQLite, JSON de ajustes, `.env` ni `localStorage`.
- ✅ Si el sistema no ofrece almacenamiento seguro (p. ej. Linux sin llavero), Hormiga se niega a guardar credenciales.
- ✅ Contraseñas de PDF: solo en memoria durante el procesamiento; nunca se guardan ni se registran.

## Electron

- ✅ `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false`,
  DevTools desactivadas en producción, `app.enableSandbox()`.
- ✅ Preload mínimo: `invoke` sobre lista blanca de canales y `on` sobre lista blanca de eventos. Sin `fs`, rutas ni
  `ipcRenderer` expuestos.
- ✅ IPC: comprobación del origen del remitente (marco principal y origen exacto `app://hormiga/`), validación zod
  estricta de cada entrada, errores tipados sin trazas internas.
- ✅ UI servida por protocolo propio `app://hormiga` (sin privilegios extra de `file://`), con protección de path
  traversal (probada en E2E) y cabecera CSP.
- ✅ CSP: `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
  `frame-ancestors 'none'`. El renderer no puede acceder a internet (bloqueado también en `webRequest`).
- ✅ Navegación bloqueada fuera del origen de la app; `window.open` denegado; permisos (cámara, notificaciones…) denegados.
- ✅ Fuses: sin `RunAsNode`, sin `NODE_OPTIONS`, sin `--inspect`, validación de integridad del ASAR, carga solo desde ASAR,
  sin privilegios extra para `file://`.
- ✅ Instancia única.
- ⚠️ El instalador no está firmado con certificado de código.

## Sistema de archivos

- ✅ El renderer nunca envía rutas: los archivos se eligen con diálogos nativos en el proceso principal.
- ✅ Los PDF conservados se nombran por SHA-256 dentro de la carpeta privada y se verifican antes de abrir/borrar.
- ✅ Límite de 25 MB por documento.

## SQL e inyecciones

- ✅ Todas las consultas usan parámetros; las partes dinámicas (orden, columnas) salen de listas blancas.
- ✅ Consultas de Gmail saneadas (solo `[a-zA-Z0-9@._-]` en términos configurables).
- ✅ Exportación CSV neutraliza fórmulas (`=`, `+`, `-`, `@`).

## XSS

- ✅ React escapa todo; ESLint prohíbe `dangerouslySetInnerHTML`; CSP sin `unsafe-eval` ni scripts externos.
- ✅ pdf.js 6 (sin evaluación de código de fuentes/PDF; corrige GHSA-hq66-cqwq-w95j que afectaba a pdf.js 5).

## Logs

- ✅ JSON estructurado con rotación (2 MB). Nivel `info` en producción.
- ✅ Nunca se registran descripciones, importes, emails, asuntos ni tokens: claves sensibles redactadas y
  enmascarado de IBAN, tarjetas, emails y tokens (tests + comprobación E2E sobre el log real).

## Configuración y dependencias

- ✅ `.env` solo se lee en desarrollo y está en `.gitignore` junto con PDFs, bases de datos y copias.
- ✅ `npm audit --omit=dev`: 0 vulnerabilidades. Dependencias de producción: `google-auth-library`, `pdfjs-dist`, `zod` y
  `xlsx` (SheetJS CE 0.20.3 instalado desde el CDN oficial de SheetJS; la versión 0.18 de npm tiene vulnerabilidades
  conocidas). Las hojas se leen sin evaluar fórmulas, macros ni vínculos externos y con `raw: true`.

## Datos locales

- ✅ Todo en `%APPDATA%\Hormiga`. Sin telemetría.
- ✅ «Eliminar todos mis datos» exige escribir `ELIMINAR` y confirmar en un diálogo nativo.
- ⚠️ La base de datos y las copias de seguridad no están cifradas en reposo (protegidas por los permisos de tu
  usuario de Windows). Recomendado: BitLocker.

## Conexiones de red (versión 0.2.0)

| Destino | Cuándo | Qué se envía |
|---|---|---|
| Google (OAuth + Gmail API, solo lectura) | Si conectas Gmail | Token OAuth; se leen solo los emails candidatos a extracto |
| GitHub Releases (`github.com/davidescobar98/hormiga`) | Al abrir la app instalada y cada 6 h (desactivable en Ajustes → Actualizaciones) | Nada tuyo: solo la petición de la última versión (IP y versión de la app, como cualquier descarga) |
| Yahoo Finance (datos públicos) | Solo si activas «Consultar rentabilidades pasadas» y buscas | El texto buscado (nombre, ticker o ISIN) o el símbolo elegido; nunca importes ni posiciones |

Actualizaciones: electron-updater descarga el instalador de la release y comprueba su SHA-512 (publicado en
`latest.yml`) antes de instalarlo en silencio al reiniciar. Los ejecutables no están firmados con un certificado de
código (⚠️ Windows SmartScreen puede avisar en la primera instalación). Los datos viven en `%APPDATA%\Hormiga`, fuera de
la carpeta del programa, y antes de cada migración de esquema se guarda una copia en `data/backups`. La versión
portátil no se actualiza sola.
