# Plan: Hormiga para iOS y Android

Objetivo: la misma app (local-first, sin servidor propio) en el móvil, reutilizando el máximo de código.

## Qué se reutiliza tal cual

| Capa | Hoy | En el móvil |
|---|---|---|
| Interfaz (`src/renderer`) | React en Electron | La misma, dentro de **Capacitor** (WebView nativa) con ajustes de diseño táctil |
| Dominio (`src/core/domain`) | TypeScript puro | Igual |
| Servicios (`src/core/services`) | TypeScript, API SQL síncrona | Igual, sobre otra implementación de `Database` |
| Lectura de PDF (pdf.js) | Node | pdf.js en el navegador (ya es su entorno natural) |
| Contrato IPC (`src/shared/api.ts`) | `ipcRenderer` | Llamada directa en proceso (mismo `ApiMap`, sin IPC) |

## Qué cambia

1. **Base de datos.** `node:sqlite` no existe en el móvil. Se definirá una interfaz `SqlDriver` (síncrona, la que ya
   usa `Database`) con dos implementaciones: `node:sqlite` (escritorio) y **SQLite en WebAssembly** (móvil), con el
   fichero guardado en el almacenamiento privado de la app y **cifrado con AES-GCM**. La clave queda en el Keychain
   (iOS) / Keystore (Android).
2. **Secretos** (tokens de Gmail, PIN): de DPAPI a Keychain / Keystore mediante un plugin de almacenamiento seguro.
3. **Gmail OAuth**: de «loopback» de escritorio a cliente OAuth **iOS / Android** con esquema de URL propio y PKCE
   (mismo proyecto de Google Cloud, nuevos clientes).
4. **Bloqueo**: Face ID / huella en lugar de Windows Hello.
5. **Avisos**: notificaciones locales. La actualización de cotizaciones en segundo plano depende del sistema (iOS
   la permite solo de vez en cuando): los avisos de bolsa en el móvil serán «al abrir la app» y «cuando el sistema lo
   permita», no en tiempo real. Para tiempo real haría falta un servidor, que hoy descartamos por privacidad.
6. **Importar ficheros**: hoja de compartir del sistema («Abrir con Hormiga») y selector de archivos.

## Sincronizar PC y móvil

Opción recomendada: **sincronización cifrada de extremo a extremo en tu propio Google Drive** (carpeta oculta
`appDataFolder`, que solo ve Hormiga), reutilizando la cuenta de Google que ya conectas para Gmail. Se sube un
registro de cambios cifrado con una clave que solo tienen tus dispositivos (emparejados con un código QR). Ni Google
ni nadie más puede leer los datos. Alternativa más simple: cada dispositivo importa sus propios extractos de Gmail
(sin sincronizar categorías ni reglas).

## Distribución

- **Android**: APK firmado que se instala directamente (amigos incluidos) o Google Play (25 $ una vez).
- **iOS**: requiere cuenta de Apple Developer (99 $/año) para instalarla por **TestFlight** (hasta 10.000 personas) o
  App Store. Sin cuenta, solo se puede instalar desde un Mac con Xcode y caduca a los 7 días.

## Fases

1. Separar el núcleo de Node: interfaz `SqlDriver`, `Database` sobre ella, pruebas ejecutadas con ambos drivers.
2. Diseño adaptable (pantallas de 360–430 px, navegación inferior) en la app de escritorio, sin romper nada.
3. Proyecto Capacitor (Android primero, se prueba en emulador), almacenamiento cifrado, bloqueo biométrico.
4. Gmail en móvil y sincronización cifrada PC ↔ móvil.
5. iOS (TestFlight) y notificaciones locales.

Decisiones pendientes del propietario: cuenta de Apple Developer, y si se quiere sincronización entre dispositivos o
móvil independiente.
