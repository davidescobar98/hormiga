# Arquitectura

## Capas

| Capa | Carpeta | Responsabilidad | Depende de |
| --- | --- | --- | --- |
| UI | `src/renderer` | Pantallas React, gráficos, formularios | `src/shared` (tipos) + `window.hormiga` |
| Puente | `src/preload` | Expone `invoke(canal)` y `on(evento)` con lista blanca | `src/shared/channels` |
| Main | `src/main` | Ciclo de vida, seguridad, IPC validado, diálogos, protocolo `app://`, vault, logs, empaquetado | `src/core`, Electron |
| Servicios | `src/core/services` | Casos de uso: importar, sincronizar, categorizar, analítica, datos | dominio, parsing, email, db |
| Dominio | `src/core/domain` | Lógica pura: dinero, comercios, tipos, categorizador, recurrencia, métricas, recomendaciones | `src/shared` |
| Parsing | `src/core/parsing` | PDF/CSV → texto → `StatementParser` → normalización/validación | dominio |
| Email | `src/core/email` | `EmailProvider`, `GmailEmailProvider`, detección, OAuth | google-auth-library |
| Persistencia | `src/core/db` | SQLite (`node:sqlite`), migraciones, repositorios | — |

ESLint impone las fronteras: el renderer no puede importar `electron`, `node:*`, `core` ni `main`; `core` no puede
importar Electron.

## Contrato IPC

`src/shared/api.ts` define `ApiMap` (canal → entrada/salida). `src/shared/channels.ts` contiene la lista blanca (con
comprobación de exhaustividad en compilación). `src/main/ipcSchemas.ts` valida cada entrada con zod (`strict`: claves
desconocidas rechazadas). Las respuestas viajan como `{ ok, data } | { ok: false, error: { code, message } }`.

## Modelo de datos (migración v1)

| Tabla | Contenido | Integridad |
| --- | --- | --- |
| `documents` | archivo importado: sha256, nombre, origen, estado, parser, avisos, ruta si se conserva | `sha256 UNIQUE` |
| `statements` | periodo, banco, tipo (tarjeta/cuenta), últimos 4 dígitos, total declarado y calculado, incidencias | FK documento, `UNIQUE(document_id)` |
| `email_imports` | mensajes procesados y su resultado | `UNIQUE(provider, message_id, attachment_key)` |
| `transactions` | fecha, fecha valor, descripción original y normalizada, comercio, importe (céntimos, +entrada/−salida), tipo, categoría, origen/confianza/detalle de clasificación, regla, bloqueo manual, exclusión, notas | `fingerprint UNIQUE`, FKs, `CHECK` de enums, índices por fecha, categoría, comercio y documento |
| `import_review_items` | filas en revisión (no cuentan en analítica) | `UNIQUE(document_id, row_index)` |
| `categories` | taxonomía (sistema + personalizadas), tipo esencial/discrecional/neutral | `name UNIQUE NOCASE` |
| `categorization_rules` | reglas del usuario (comercio / contiene texto) | `UNIQUE(match_type, pattern)` |
| `merchants` | comercio normalizado (clave estable + nombre visible) | `key UNIQUE` |
| `recurring_expenses` | detección por comercio, estado y decisión del usuario | `merchant_id UNIQUE` |
| `income` | ingresos configurados por periodo | `CHECK end ≥ start` |
| `savings_goals` | objetivo (€ o %) con vigencia | `effective_from UNIQUE` |
| `recommendations` | última generación + descartes del usuario | `key` PK |
| `settings`, `app_meta` | ajustes no secretos, id de app y versión de esquema | — |

Toda importación se escribe en una transacción (`BEGIN IMMEDIATE`, savepoints anidados): un fallo a mitad no deja
datos parciales. `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`.

## Evolución prevista

- Otros bancos: nuevo `StatementParser` registrado en `DEFAULT_PARSERS`.
- Otros proveedores de correo: implementar `EmailProvider` (IMAP/Outlook) y un `EmailAuthPort`.
- Open Banking / CSV bancarios: producen `ParsedStatement` o filas `InsertableRow` que reutilizan normalización,
  categorización y deduplicación.
- Sincronización cifrada, patrimonio, presupuestos: nuevas migraciones y servicios sin tocar el dominio actual.
