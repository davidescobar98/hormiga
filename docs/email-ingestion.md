# Ingestión de email

## Componentes

- `EmailProvider` (`src/core/email/types.ts`): `search`, `getMessage`, `downloadAttachment`, `getAccount`.
- `GmailEmailProvider`: implementación con llamadas REST de solo lectura (`messages.list`, `messages.get`,
  `messages.attachments.get`, `profile`) sobre un cliente autorizado por `google-auth-library`.
- `GmailAuth`: OAuth 2.0 para apps instaladas (RFC 8252): navegador del sistema, redirección loopback
  `http://127.0.0.1:<puerto aleatorio>/oauth2callback`, PKCE S256, `state` aleatorio de 192 bits, timeout de 5 min,
  `access_type=offline`. Ámbito único: `https://www.googleapis.com/auth/gmail.readonly`.
- `SyncService`: estado de conexión, escaneo, importación seleccionada, sincronización incremental, reintento con
  contraseña.

## Detección de emails BBVA (`detection.ts`)

Se combinan señales configurables (Ajustes → BBVA):

| Señal | Puntos |
| --- | --- |
| Dirección exacta configurada | +45 |
| Dominio del remitente (o subdominio) configurado | +40 |
| El asunto contiene «BBVA» | +10 |
| Palabra clave en el asunto (extracto, resumen, factura, liquidación…) | +15 |
| Adjunta PDF | +25 (sin PDF la puntuación se limita a 34) |
| Palabra clave en el nombre del PDF | +10 |

`≥ minScore` (60 por defecto) → *detectado*; 35–59 → *posible* (se muestra para revisión, no se importa solo);
< 35 → ignorado. El nombre visible del remitente no puntúa (fácil de suplantar) y los dominios se comparan con límite
de etiqueta (`x@bbva.com.malicioso.net` no coincide).

La búsqueda en Gmail es amplia (`has:attachment filename:pdf after:<fecha> {from:<dominios> subject:bbva filename:bbva}`);
la clasificación final la hace la puntuación local.

## Sincronización

1. **Primera vez** (no hay mensajes procesados): solo se escanea el periodo inicial (12 meses por defecto) y se
   muestran los candidatos; el usuario marca cuáles importar. Así se revisa antes de una importación masiva.
2. **Siguientes**: al pulsar «Sincronizar ahora» o al abrir la app (si está activado), se buscan mensajes desde el
   inicio de la última sincronización correcta menos 7 días de solape. Si la app estuvo cerrada un mes, el intervalo
   cubre ese mes completo.
3. Cada mensaje detectado y no procesado se descarga e importa con `ImportService`. El resultado se registra en
   `email_imports` (`imported`, `duplicate`, `needs_review`, `password_required`, `failed`, `not_statement`, `skipped`).
4. Los fallos de un mensaje no detienen el resto. Los errores globales (sin conexión, autorización caducada, permisos,
   límite de peticiones) detienen la sincronización sin mover la ventana incremental, y se muestran con un mensaje claro.

## Deduplicación

| Nivel | Mecanismo |
| --- | --- |
| Mensaje | `UNIQUE(provider, message_id, attachment_key)`; los mensajes ya importados no se vuelven a descargar |
| Documento | SHA-256 del archivo (`documents.sha256 UNIQUE`) |
| Extracto | mismo banco + últimos 4 dígitos + periodo → aviso de extracto repetido |
| Movimiento | huella SHA-256 de fecha + importe + descripción normalizada + nº de aparición en el documento (`UNIQUE`) |

## PDFs protegidos

Si un adjunto pide contraseña, se registra como `password_required` y aparece en Documentos → Gmail. Al introducir la
contraseña se vuelve a descargar el adjunto y se procesa en memoria; la contraseña nunca se guarda.
