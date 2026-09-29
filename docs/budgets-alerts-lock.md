# Presupuestos, avisos, sincronización periódica y bloqueo

## Presupuestos — `src/core/domain/budgets.ts`, `src/core/services/budgetsService.ts`

- Un límite mensual por categoría de gasto (el mismo cada mes hasta que lo cambies). Tabla `budgets`.
- Gasto del mes = cargos − devoluciones de la categoría (igual que el resto de estadísticas).
- Estado: `ok`; `at_risk` si, a este ritmo, acabaría por encima (proyección lineal
  `gasto × días del mes ÷ días transcurridos`, solo en el mes en curso); `warning` al 80 %; `over` al superarlo.
- Sugerencia: media de los 3 meses completos anteriores, redondeada hacia arriba a 10 € (mínimo 10 €). Se proponen las
  6 categorías esenciales o discrecionales con más gasto medio (≥ 30 €/mes) que aún no tienen presupuesto.

## Avisos — `BudgetsService.refreshAlerts()`

Se calculan al abrir la app, tras cada sincronización o importación, al cambiar un presupuesto y cada hora. Cada aviso
tiene una clave única (tabla `alerts`), así que se muestra una sola vez; se olvidan a los 90 días.

| Aviso | Regla |
|---|---|
| Presupuesto al 80 % / superado | Una vez por categoría y mes |
| Cargo inusual | Últimos 7 días, ≥ 50 € y ≥ 2 × el mayor cargo anterior del mismo comercio (con ≥ 3 anteriores) |
| ¿Cargo duplicado? | Mismo comercio, importe (≥ 10 €) y día, últimos 7 días |
| Subida de precio | Pago recurrente cuyo último cargo supera al habitual (mediana de los 3 anteriores) ≥ 0,50 € y ≥ 2 % |
| Próximo pago | Recurrente no mensual ≥ 50 € en los próximos 7 días |
| Transferencias por revisar | Beneficiarios con transferencias ≥ 1.000 € sin clasificar |

Siempre aparecen en «Resumen → Avisos». Las **notificaciones de Windows** son opcionales (Ajustes → Avisos);
con la app bloqueada no muestran importes ni comercios.

## Sincronización periódica

Con la app abierta y Gmail conectado, busca extractos nuevos cada N horas (por defecto 6; configurable o solo al
abrir). Usa la misma búsqueda incremental de solo lectura.

## Bloqueo — `src/main/lock.ts`

- PIN de 4–8 cifras. Nunca se guarda: solo `scrypt(PIN, sal aleatoria de 16 bytes)` dentro del almacén seguro del
  sistema (DPAPI). Comparación en tiempo constante. Tras 3 fallos, pausas crecientes (5 s, 10 s, 20 s… hasta 5 min).
- Windows Hello (huella, cara o PIN de Windows) mediante `UserConsentVerifier` de Windows, invocado con un script
  fijo de PowerShell (sin datos del usuario). El PIN de Hormiga sirve siempre como alternativa.
- Mientras está bloqueada, el **proceso principal rechaza todos los canales IPC** salvo los de desbloqueo
  (`LOCK_CHANNELS`) y no envía eventos con datos; la interfaz solo muestra la pantalla de bloqueo.
- Se bloquea al abrir, al bloquear Windows y tras X minutos sin usar el ordenador (configurable).
- Desactivar el bloqueo o cambiar el PIN exige el PIN actual; el canal de ajustes no puede tocar el bloqueo.
- ⚠️ Protege la aplicación, no el archivo de base de datos en disco (queda protegido por la sesión de Windows).

## Operaciones patrimoniales y movimientos extraordinarios

- Categoría del sistema **«Patrimonio y préstamos»** (no cuenta como gasto ni ingreso): disposición de préstamos,
  formalización o cancelación de hipotecas, compraventas, arras… se detectan por el concepto.
- **Movimientos extraordinarios** (≥ 10.000 € que siguen contando como gasto o ingreso): se listan en «Análisis» y
  «Ahorro» para marcarlos con un clic como patrimonio (compra de vivienda o coche, venta, préstamo) o confirmar que son
  un gasto/ingreso real. Los impuestos y gastos de una compra sí son gasto.
