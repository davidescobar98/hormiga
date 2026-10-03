# Previsión, ingresos previsibles y plan de ahorro

Todo se calcula en el equipo con el historial de la persona. Ningún número se inventa: si falta un dato (por ejemplo
el saldo de la cuenta corriente) la pantalla lo explica en lugar de suponerlo.

## Meses completos

Las medias y presupuestos solo usan **meses completos**. La cobertura es la fecha más reciente entre el último
movimiento y el fin del periodo del último extracto. Un mes `m` está completo si es anterior al mes actual y la
cobertura llega al último día de `m` (o a un mes posterior). Así, un recibo de fin de mes aún no importado no rebaja
la media. «Lo habitual» es la **mediana** de los 3 últimos meses completos (un mes con dos cuotas no infla la media).

## Ingresos por pagador

- El pagador se extrae del concepto (`ABONO DE NOMINA`, `TRANSFERENCIA RECIBIDA DE`…), sin formas jurídicas.
- **Nómina**: importe habitual = mediana del pago mínimo mensual; día de cobro habitual.
- **Pagas extra**: meses en los que la nómina total supera 1,5 × la habitual.
- **Variable de la empresa**: transferencias del mismo pagador que la nómina (horas extra, incentivos); importe =
  mediana de los últimos 6 meses contando los meses sin pago.
- Una fuente es regular si aparece al menos 6 meses.

## Saldo previsto (60 días)

`saldo(d) = saldo inicial + Σ eventos previstos hasta d − (gasto variable habitual + traspasos habituales) por día × días`

- Saldo inicial: el saldo conocido de la cuenta corriente (o de las cuentas corrientes marcadas).
- Eventos: ingresos por pagador en su día y pagos recurrentes confirmados en su próxima fecha (si el último cargo
  esperado aún no aparece en los datos, se cuenta una sola vez).
- Gasto variable y traspasos: mediana de los 3 últimos meses; se excluyen operaciones puntuales ≥ 10.000 €.
- Riesgo: `ok`, `low` (por debajo del mínimo configurado) o `negative`.

## Estacionalidad y palancas

- **Meses caros** (próximos 3 meses): categorías cuyo gasto en ese mes del año pasado fue ≥ 1,5 × su media mensual de
  los 12 meses anteriores y al menos 100 € más (se necesitan 6 meses de historial en esa ventana).
- **Palancas**: volver al nivel de tu mejor trimestre en categorías recortables (como máximo a la mitad), suscripciones
  y comisiones. Categorías no recortables (vivienda, préstamos, impuestos, salud…) quedan fuera.
- El **plan** convierte las palancas elegidas en presupuestos mensuales con un clic.

## Avisos

`low_balance` (saldo previsto por debajo del mínimo), `spending_pace` (gasto del mes por encima de lo habitual a
estas alturas) y `seasonal` (se acerca un mes caro). Cada aviso se emite una vez por episodio.

## Comprobaciones

`tests/unit/forecast.test.ts` y `tests/integration/forecast.test.ts` verifican que la proyección es exactamente la
fórmula anterior (± 1 céntimo), y «Comprobar mis números» (`AuditService`) la revisa con los datos reales.
