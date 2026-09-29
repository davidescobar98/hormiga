# Metas de ahorro, fondo de emergencia y patrimonio

Todo es **registro y cálculo con tus datos**. Hormiga no mueve dinero, no se conecta a brókers y no recomienda productos
financieros. Ahorrar (reservar dinero) e invertir (asumir riesgo esperando rentabilidad) se tratan por separado.

## Metas («huchas») — `src/core/domain/pots.ts`

Cada meta tiene objetivo, fecha opcional y movimientos (aportaciones +, retiradas −) que registras tú.

```
ahorrado          = Σ movimientos
pendiente         = max(0, objetivo − ahorrado)
meses restantes   = meses naturales hasta la fecha objetivo (el mes en curso cuenta)
necesario al mes  = ⌈pendiente / meses restantes⌉
plan lineal hoy   = objetivo × días transcurridos desde la creación / días totales
estado            = por delante / según el plan / por detrás (±5 % del objetivo sobre el plan lineal),
                    completada, fecha superada o sin fecha
```

La pantalla compara la suma de «necesario al mes» de todas las metas con tu **capacidad de ahorro estimada**
(ver [financial-calculations.md](financial-calculations.md)) y avisa si no encajan, sin juicios.

## Fondo de emergencia

Es una meta especial (una sola activa).

```
gasto esencial mensual = media de los últimos meses completos (máx. 6) en categorías esenciales, recurrentes incluidos
cobertura (meses)      = fondo de emergencia / gasto esencial mensual
```

Se muestran como referencia 3 y 6 meses de gasto esencial, un rango habitual en educación financiera; la cifra
adecuada depende de cada situación.

## Patrimonio — `src/core/domain/wealth.ts`

Activos (cuentas, depósitos, fondos, acciones/ETF, planes de pensiones, cripto, inmuebles, otros) y deudas (préstamos,
hipoteca, tarjeta) con **valoraciones fechadas** que introduces tú (una por activo y día).

```
valor en una fecha     = última valoración anterior o igual a esa fecha
patrimonio neto        = Σ activos − Σ deudas
ganancia (inversiones) = valor − total aportado (solo si registras lo aportado)
rentabilidad simple    = ganancia / aportado
```

La evolución muestra el patrimonio neto a fin de cada mes. Un activo sin actualizar en 90 días se marca como
«desactualizado». No incluye cotizaciones automáticas, impuestos ni comisiones.

## Simulador — `src/shared/simulator.ts`

Interés compuesto con aportaciones mensuales, con **supuestos que eliges tú** (rentabilidad, inflación, plazo):

```
r mensual = (1 + rentabilidad anual)^(1/12) − 1
cada mes:  valor = valor × (1 + r) + aportación        (redondeado al céntimo)
euros de hoy = valor / (1 + inflación)^años
```

También calcula cuánto tardarías en llegar a una cifra. Está verificado contra la fórmula cerrada en los tests. Es una
herramienta educativa: las rentabilidades reales varían y pueden ser negativas.
