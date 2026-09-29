# Cálculos financieros

Todos los importes son **enteros en céntimos** (`number` entero, exacto hasta 2^53). Nunca se usan floats para sumar;
la división por 100 solo ocurre al mostrar. Porcentajes en puntos básicos (1 % = 100 bp).

## Semántica

| Tipo | Signo | Cuenta como |
| --- | --- | --- |
| `expense`, `fee`, `cash_withdrawal` | − | gasto |
| `refund` | + | resta del gasto de su categoría (se muestra aparte) |
| `income` | + | ingreso (según el modo de ingresos) |
| `transfer` | ± | nada (entre cuentas propias, liquidación de tarjeta, Bizum) |
| `unknown` | ± | nada |

Movimientos excluidos (`is_excluded`) y categorías «Transferencias»/«Ingresos» no cuentan.

## Métricas de un mes

```
gasto bruto   = Σ −importe  (expense, fee, cash_withdrawal)
devoluciones  = Σ importe   (refund)
gasto         = gasto bruto − devoluciones
ingresos      = según modo: automático (por defecto: los detectados en tus extractos de cuenta y, si un mes no
                tiene, los configurados) | configurados | detectados en documentos | ambos
ahorro real   = ingresos − gasto
tasa de ahorro = ahorro / ingresos            (solo si ingresos > 0)
gasto fijo    = gasto de comercios con recurrencia probable/confirmada
gasto variable = gasto − gasto fijo
discrecional  = gasto en categorías discrecionales
```

Invariantes probados en tests: `Σ gasto por categoría = gasto`, `ingresos − gasto = ahorro`, `fijo + variable = gasto`,
la suma del documento coincide con su total, `0,10 + 0,20 = 0,30`.

**Ingresos configurados**: salario y recurrentes cuentan cada mes entre «desde» y «hasta»; extraordinarios solo en su
mes. Así se modela un cambio de sueldo (cerrar el anterior y abrir uno nuevo).

**Objetivo**: importe fijo o % de ingresos. Estado: *por encima* si ahorro > objetivo + 5 %; *dentro* si está a ±5 %;
*por debajo* en otro caso. Un objetivo se aplica a todo el histórico.

## Medias y comparaciones

- Media N meses = media de los N meses naturales que terminan en el mes indicado; **solo se muestra si los N tienen
  datos** (si no: «histórico insuficiente»). Los meses sin extracto no cuentan como gasto cero.
- Comparaciones del resumen: frente al mes anterior y a las medias de 3 y 6 meses **anteriores**.
- Mes en curso: se compara la **previsión de fin de mes**, no el gasto parcial, y se marca como orientativa.

## Capacidad de ahorro estimada

Ventana = últimos meses **completos** con datos (máx. 6). Con menos de 3: «Estimación provisional: solo hay X meses».

```
  ingreso mensual esperado        (salario + recurrentes del mes siguiente; o media de ingresos detectados)
− gastos fijos esperados          (Σ coste mensual equivalente de recurrentes activos)
− gasto esencial variable         (media en categorías esenciales, sin recurrentes)
− otros gastos variables          (media en categorías neutrales: efectivo, comisiones, otros, sin clasificar)
− gasto discrecional              (media en categorías discrecionales, sin recurrentes)
= capacidad de ahorro estimada
```

La pantalla Ahorro muestra cada término con su valor y explicación.

**Escenarios**

- *Situación actual*: la capacidad estimada.
- *Reducción moderada*: capacidad + 15 % del gasto discrecional.
- *Objetivo personal*: reducción discrecional necesaria = (objetivo − capacidad) / discrecional; si supera el 100 %,
  se indica que no basta con el gasto discrecional.

Coste mensual equivalente de un recurrente: semanal × 52/12, mensual × 1, bimestral / 2, trimestral / 3, anual / 12.

## Previsión del mes en curso

```
gasto variable hasta hoy = gasto − recurrentes ya cobrados
ritmo        = variable hasta hoy / día × días del mes
histórico    = media del gasto variable de hasta 3 meses anteriores
peso w       = día / días del mes
variable previsto = max(variable hasta hoy, w·ritmo + (1−w)·histórico)
gasto previsto    = recurrentes cobrados + recurrentes pendientes este mes + variable previsto
ahorro previsto   = ingresos del mes − gasto previsto
```

Confianza «orientativa» con ≥ 3 meses de histórico y día ≥ 10; si no, «provisional». Nunca se presenta como certeza.
