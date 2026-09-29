# Recomendaciones

Motor determinista en `src/core/domain/recommendations.ts`. Solo usa tus datos; no usa servicios externos ni IA.
Se evalúa sobre el **último mes completo con datos** y su histórico.

Cada recomendación incluye: `title`, `description`, `reason`, `evidence` (datos concretos), `estimatedMonthlyImpact`,
`estimatedAnnualImpact` (= mensual × 12), `priority` y `category`. Prioridad por impacto: alta ≥ 100 €/mes, media ≥ 40 €.

| Tipo | Condición | Impacto estimado |
| --- | --- | --- |
| `category_increase` | Categoría del mes ≥ 30 € y ≥ 25 % por encima de la media de los 3 meses anteriores (los 3 con datos) | diferencia con la media |
| `subscriptions` | ≥ 2 suscripciones activas | coste de la más barata (cancelar una) |
| `discretionary_reduction` | Categoría discrecional con media ≥ 100 €/mes y ≥ 10 % del gasto (últimos 3 meses) | media − objetivo (−20 %, redondeado a 10 €) |
| `frequent_small_purchases` | Mismo comercio ≥ 8 compras/mes con ticket medio ≤ 15 € | 50 % del gasto mensual en él |
| `fees` | Comisiones/intereses en los últimos 3 meses (prioridad alta si se repiten) | media mensual de comisiones |
| `atypical_month` | Gasto > media de hasta 6 meses previos en ≥ 20 % y > 1,5 desviaciones típicas | — (informativa, con las categorías que más subieron) |
| `goal_gap` / `goal_met` | Objetivo definido: diferencia entre objetivo y ahorro medio (3 meses) | brecha mensual |
| `savings_rate_up` | Tasa de ahorro ≥ 3 puntos sobre la media de 3 meses | — (positiva) |
| `category_decrease` | Categoría discrecional ≥ 15 % y ≥ 20 € por debajo de su media | — (positiva) |
| `uncategorized` | ≥ 5 movimientos sin clasificar | — (organización) |

Ejemplo (`discretionary_reduction`):

> **Restaurantes** — Has gastado una media de 310,00 €/mes durante los últimos 3 meses. Reducirlo hasta 250,00 €/mes
> supondría aproximadamente 60,00 €/mes y 720,00 €/año.

## Seguridad del contenido

- Solo se habla de organización, presupuestos, reducción de gastos, ahorro y hábitos.
- Nunca se recomienda comprar/vender activos, invertir, criptomonedas ni contratar productos financieros. Un test
  (`tests/unit/recommendations.test.ts`) comprueba que ningún texto generado contiene ese vocabulario.
- Lenguaje descriptivo, sin juicios personales; también se generan observaciones positivas.
- Puedes descartar una recomendación: no vuelve a mostrarse mientras sus datos no cambien (clave estable).
