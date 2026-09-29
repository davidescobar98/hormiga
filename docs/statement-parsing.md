# Procesamiento de extractos

```
PDF / CSV
  ↓ extractDocument()        pdf.js local (sin evaluación de código) → líneas por página con huecos de columna
  ↓ selectParser()           cada StatementParser puntúa el documento (detect); < 0,5 → «formato no reconocido»
  ↓ parser.parse()           RawTransaction[] tal cual aparecen + periodo, totales, saldos, tipo (tarjeta/cuenta)
  ↓ normalizeStatement()     fechas, importes (céntimos), signo, tipo, comercio, validaciones
  ↓ ImportService            importa si todo cuadra; si no → Revisión de importación
transactions
```

## Formatos BBVA soportados

| Parser | Documento | Validado con documento real |
| --- | --- | --- |
| `bbva-web-movimientos-v1` (`bbvaWebParser.ts`) | PDF «Últimos movimientos» de la cuenta, generado desde la banca online (ingresos y gastos, con saldo) | **Sí** — validado localmente con un documento real (no incluido en el repositorio): todas las filas cuadran con el saldo impreso |
| `bbva-pdf-v1` (`bbvaParser.ts`) | Extracto/liquidación mensual (tarjeta o cuenta) con totales | No — solo PDFs sintéticos |
| `tabla-bancaria-v1` (`tabularParser.ts`) | Excel (.xls/.xlsx), «.xls» que en realidad son tablas HTML, y CSV de cualquier banco | No — ficheros sintéticos con la estructura documentada de cada banco |
| `norma43-v1` (`norma43Parser.ts`) | Norma 43 / Cuaderno 43 de la AEB (texto de 80 posiciones) | Contra la especificación oficial de la AEB (2012), con ficheros sintéticos |

### Otros bancos (Excel / HTML / CSV)

La cabecera se busca en las 40 primeras filas (los bancos añaden filas con IBAN, titular o saldo) y las columnas se
asignan por nombre. El banco se identifica por la combinación de cabeceras y por marcas en el fichero:

| Banco | Exportación habitual | Cabeceras |
| --- | --- | --- |
| CaixaBank / imagin | `.xls` binario, cabecera en la 3.ª fila | Fecha · Fecha valor · Movimiento · Más datos · Importe · Saldo |
| Sabadell | `.xls`, fechas como número de serie de Excel | F. Operativa · Concepto · F. Valor · Importe · Saldo · Referencia 1/2 |
| Santander / Openbank | `.xls` (a menudo HTML) con ~7 filas previas | Fecha Operación · Fecha Valor · Concepto · Importe · Saldo |
| ING | `.xlsx` | F. Valor · Categoría · Subcategoría · Descripción · Comentario · Importe (€) · Saldo (€) |
| BBVA (Excel) | `.xlsx` | F.Valor · Fecha · Concepto · Movimiento · Importe · Divisa · Disponible · Observaciones |

Reglas: las celdas numéricas de Excel se convierten a céntimos directamente; el texto se interpreta con formato
español («1.234,56»); las fechas pueden ser texto (dd/mm/aaaa) o número de serie (sistemas 1900 y 1904). En CaixaBank,
el ruido «Fecha de operación: …» de «Más datos» se elimina. Si hay columna de saldo, se verifica cada fila como en el
PDF de BBVA. Fuentes: documentación pública de los bancos y los importadores de código abierto
[clair (CaixaBank)](https://github.com/adrisanchu/clair/pull/71), [manu-os (Sabadell)](https://github.com/elpiernitas/manu-os/pull/15),
[PersonalFinancer (Santander)](https://github.com/MatOtS/PersonalFinancer/pull/9) y [KashaFlow](https://github.com/KashaMalaga/KashaFlow).

### Norma 43

Registros 11 (cabecera y saldo inicial), 22 (movimiento: fechas AAMMDD, clave debe/haber, importe con 2 decimales
implícitos), 23 (hasta 5 conceptos complementarios, que forman la descripción), 33 (totales de control y saldo final)
y 88 (fin). El **concepto común** AEB fija el tipo cuando no es ambiguo (11 cajero → efectivo, 15 nómina → ingreso,
17 comisiones → comisión, 04 transferencias…). Se verifica «saldo inicial + movimientos = saldo final» y que los totales
del registro 33 coincidan; si no, el fichero va a revisión.

Los tests usan únicamente PDFs sintéticos (`tests/helpers/synthetic-statement.mjs`) que reproducen la maquetación, nunca
datos reales.

### «Últimos movimientos» (web)

Cada movimiento ocupa 2–3 líneas: `fecha concepto importe saldo`, `Fecha valor [fecha] detalle` y, a veces, la fecha
valor en una línea aparte. El detalle contiene el comercio real cuando el concepto es genérico («Adeudo a su cargo»
→ «N … OPERADORA», «Transferencia realizada» → beneficiario). En los saltos de página BBVA parte la fila: el importe
queda al pie de una página y la fecha/concepto al principio de la siguiente; el parser las vuelve a unir. El saldo de
cada fila permite verificar el importe y el signo de **todos** los movimientos.

## BbvaStatementParser (`src/core/parsing/bbvaParser.ts`)

Todo lo específico de BBVA está en la constante `BBVA_FORMAT`:

- `identity`: presencia de «BBVA» / «Banco Bilbao Vizcaya Argentaria».
- `transactionLine`: `fecha [fecha valor] concepto importe [saldo]`. Fechas `dd/mm/aaaa`, `dd/mm/aa`, `dd/mm`
  (el año se deduce del periodo, incluido el cambio diciembre→enero) y `12 ENE 2026`. Importes con miles y coma decimal,
  `€`/`EUR`, signo delante o detrás.
- Líneas de continuación: hasta 2 líneas sin fecha ni importe se añaden al concepto (descripciones partidas).
- `ignoredLines` / `nonTransactionDescriptions`: cabeceras, pies de página, «SALDO ANTERIOR», «TOTAL…».
- `period`, `periodEnd`, `openingBalance`, `closingBalance`, `declaredTotal`, `totalCharges/Credits`.
- `maskedNumber`: solo se guardan los **últimos 4 dígitos** de tarjeta/cuenta.
- Tipo de documento: *cuenta* si hay columna de saldo o menciones de cuenta; si no, *tarjeta*. En tarjeta los cargos
  van en positivo (`charges_positive`); en cuenta, en negativo.

## Normalización y validación (`normalize.ts`)

- Convención interna: `amountCents` entero, **positivo = entra dinero, negativo = sale**.
- Por fila: fecha válida, importe válido y ≠ 0, descripción no vacía, fecha dentro del periodo (−45/+5 días).
- Saldo impreso: si existe, se detecta el orden (antiguo→reciente o al revés), se corrige el signo que contradice la
  variación del saldo y se marcan las filas que no cuadran.
- Documento: el total declarado (tarjeta) o `saldo inicial + movimientos = saldo final` (cuenta) debe cuadrar al céntimo.
  Si no cuadra → incidencia bloqueante → **Revisión de importación**. Si el documento no trae totales, se avisa.
- Tipo de movimiento por palabras clave y signo: devolución, comisión, efectivo, transferencia (incluye liquidación
  de tarjeta desde la cuenta, para no contar dos veces), ingreso.

## CSV (`csvParser.ts`)

Delimitador automático (`;` `,` tabulador), comillas RFC 4180, cabecera buscada en las 30 primeras filas (columnas
fecha, concepto, importe o cargo/abono, fecha valor y saldo opcionales), UTF-8 o Windows-1252.

## Cómo adaptar el parser a un extracto BBVA real

1. En Ajustes → Privacidad activa «Conservar una copia de los PDF originales» (opcional) e importa el documento.
2. Si queda en revisión o falla, ejecuta localmente (sin subir el PDF a ningún sitio) un script que imprima
   `extractPdfText()` para ver las líneas tal como las reconstruye Hormiga.
3. Ajusta `BBVA_FORMAT` (regex de línea, cabeceras, totales) y añade un caso sintético equivalente en
   `tests/unit/parser.test.ts` **sin datos reales** (inventa conceptos e importes con la misma estructura).
4. `npm test`. Si el formato cambia en el futuro, sube la versión del parser (`bbva-pdf-v2`) para mantener la
   trazabilidad de qué analizador importó cada documento.

## Limitaciones

- No hay OCR: los PDFs escaneados (sin texto) se rechazan con un mensaje claro.
- Divisas: se asume EUR.
