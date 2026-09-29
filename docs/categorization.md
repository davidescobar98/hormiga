# Categorización

Determinista, explicable y reproducible. Sin IA externa.

## Normalización de comercios (`domain/merchant.ts`)

1. Mayúsculas, sin acentos, solo letras/números (`normalizeText`).
2. Se eliminan prefijos bancarios («COMPRA TARJ.», «PAGO EN», «RECIBO», «PAYPAL *», «APPLE PAY»…) y restos de tarjeta.
3. Si aparece un **comercio conocido** (`domain/knowledge.ts`: ~120 marcas públicas con alias), se usa su nombre.
   Los alias cortos (≤ 4 letras, p. ej. «DIA», «BP») solo cuentan al principio del texto.
4. Si no: se quitan referencias numéricas, sufijos societarios (S.L., S.A.…), ciudades/países finales y se toman
   hasta 4 palabras. `MERCADONA 1234 BARCELONA`, `MERCADONA ES 00456` → clave `MERCADONA`, nombre «Mercadona».

La descripción original (`description_raw`) se conserva siempre.

## Pipeline (`domain/categorizer.ts`)

| Orden | Origen | Confianza | Ejemplo |
| --- | --- | --- | --- |
| 1 | `USER` — reglas creadas por ti (primero las de comercio, luego «contiene texto», la más larga gana) | 1,0 | Mercadona → Otros |
| 2 | `HEURISTIC` — semántica del movimiento: ingreso, transferencia, comisión, efectivo | 0,7 | «BIZUM A BAR PEPE» → Transferencias |
| 3 | `MERCHANT` — comercio conocido | 0,95 | Netflix → Suscripciones |
| 4 | `RULE` — palabras clave (farmacia, gasolinera, restaurante, alquiler…) | 0,75 | «FARMACIA LDO» → Salud |
| 5 | `UNKNOWN` — sin clasificar | 0 | — |

La heurística por tipo va antes que comercio/palabras clave porque decide si el movimiento es gasto: una transferencia
a un bar no debe contar como gasto en restaurantes. Las devoluciones heredan la categoría del comercio y restan de ella.

Cada movimiento guarda `classification_source`, `classification_confidence`, `classification_detail` (p. ej.
«Palabra clave «FARMACIA» (salud)») y `rule_id`, visibles en el detalle.

## Aprender de las correcciones

1. Cambias la categoría de un movimiento → queda **bloqueado** (`category_locked`, origen `USER`): ninguna
   recategorización automática lo tocará.
2. Si tiene comercio, Hormiga ofrece «Aplicar siempre esta categoría a los movimientos de X».
3. Al aceptar se crea una regla `merchant` con la **clave** del comercio (sobrevive a cambios de nombre visible) y se
   aplica a los movimientos existentes no bloqueados; los futuros la usan automáticamente.
4. Borrar una regla vuelve a clasificar los movimientos afectados con el pipeline normal.

## Tipos de gasto

Cada categoría es **esencial**, **discrecional** o **neutral** (editable). Se usa en la capacidad de ahorro y en las
recomendaciones. «Transferencias» e «Ingresos» nunca cuentan como gasto.
