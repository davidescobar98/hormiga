# Bolsa: señales de compra y venta

«Bolsa» combina una **lista de seguimiento** con señales de compra, tu **cartera** (operaciones que registras tú) con
señales de venta, y el cálculo fiscal español de tus ventas. Todo es local salvo la consulta de cotizaciones.

> **No es asesoramiento financiero.** Las señales son reglas técnicas fijas y transparentes sobre precios públicos y
> sobre tus propios límites. No conocen noticias, resultados ni valoración de la empresa. Hormiga no es una entidad
> registrada en la CNMV ni sustituye a un asesor.

## Privacidad

- Hay que activar «datos de mercado» (`marketDataEnabled`, desactivado por defecto).
- Al proveedor (Yahoo Finance, endpoint público no oficial `v8/finance/chart`) solo se envía el **símbolo** de cada
  valor que sigues o tienes, y los pares de divisa `EURxxx=X`. Nunca importes, cantidades ni operaciones.
- Las operaciones se registran a mano y no salen del equipo. Sin datos de mercado la cartera se muestra a coste.

## Datos y frecuencia

- Cierres diarios de ~2 años (no ajustados por dividendos, comparables con tu precio de compra) y la última
  cotización (con retraso). Caché en `market_prices` / `market_symbols` (esquema v6), se conservan ~3 años.
- Con la app abierta se actualiza cada 2 horas (`scheduledMarket` en `src/main/index.ts`); a mano con
  «Actualizar cotizaciones». Un valor no se vuelve a pedir si se descargó hace menos de 30 minutos.
- Una cotización con más de 5 días se marca «desactualizada» y no genera señales ni avisos.

## Indicadores (`src/core/domain/stocks.ts`)

| Indicador | Definición |
|---|---|
| SMA50 / SMA200 | Media simple de los últimos 50 / 200 cierres |
| RSI(14) | RSI de Wilder (medias suavizadas de subidas y bajadas) |
| Máximo 52 semanas | Máximo de los últimos 252 cierres |
| Caída desde máximo | (máximo − último) / máximo |
| Cruce dorado / de la muerte | SMA50 cruza por encima / debajo de SMA200 en las últimas 5 sesiones |
| Pérdida de SMA200 | El cierre pasa de estar por encima a por debajo de SMA200 en las últimas 5 sesiones |

## Señales de compra (lista de seguimiento)

| Señal | Regla | Fuerza |
|---|---|---|
| Corrección en tendencia alcista | Último > SMA200, SMA50 > SMA200, caída desde máximo ≥ `dipPct` (10 %) y RSI ≤ 40 | Fuerte si RSI ≤ 30, si no moderada |
| Cruce dorado | Cruce dorado reciente y último > SMA200 | Moderada |
| Precio objetivo | Último ≤ el precio que fijaste | Fuerte |
| Sobreventa en tendencia bajista | Último < SMA200 y RSI ≤ 25 | Débil (solo se muestra) |

Antes de comprar se comprueba la **liquidez**: saldo de cuentas corrientes y de ahorro − fondo de emergencia
recomendado (meses recomendados por tu perfil × gasto esencial mensual). Si no hay excedente, la señal lo dice.
El importe orientativo máximo de una compra es `min(excedente, maxPositionPct × (cartera + excedente))`.

Si vendiste ese valor con pérdidas en los últimos 2 meses, se avisa de la **regla de los dos meses**.

## Señales de venta (tu cartera)

| Señal | Regla | Fuerza |
|---|---|---|
| Stop-loss | Resultado en euros (comisiones incluidas) ≤ −`stopLossPct` (15 %) | Fuerte |
| Stop dinámico | Caída desde el máximo desde tu primera compra ≥ `trailingStopPct` (20 %), si ese máximo superó tu precio medio (no se repite con el stop-loss) | Fuerte |
| Objetivo de beneficio | Resultado ≥ `takeProfitPct` (30 %) | Moderada |
| Pérdida de tendencia | Pérdida de SMA200 reciente (y cruce de la muerte si lo hay) | Moderada |
| Concentración | Peso > `maxPositionPct` (20 %), solo con suficientes valores para cumplirlo (≥ 5 con 20 %) | Débil (solo se muestra) |

Con pocos valores se muestra una nota de diversificación a nivel de cartera en lugar de una señal de venta.

## Avisos

`StocksService.alerts()` guarda en `stock_signal_state` desde cuándo está activa cada señal (símbolo + tipo). Se genera
**un aviso por episodio** (clave `stock:<símbolo>:<tipo>:<desde>`): si la señal desaparece y vuelve, avisa de nuevo.
Solo avisan las señales fuertes y moderadas con cotización al día; se pueden desactivar en «Tus reglas». Los avisos
entran en el sistema general (lista en la app y notificación de Windows si está activada; con la app bloqueada la
notificación no muestra detalles).

## Cálculos

- **Euros**: cada operación guarda su tipo de cambio (unidades de divisa por 1 €). Si no lo indicas, se usa el cierre
  de `EURxxx=X` de ese día. Las acciones de Londres cotizan en peniques (`GBp`): las operaciones se registran en libras.
- **Coste**: precio × cantidad / tipo de cambio + comisiones. **Venta**: importe − comisiones.
- **FIFO** por valor (obligatorio en España): cada venta consume primero las acciones más antiguas; el coste de un
  lote parcial es proporcional. No se puede registrar una venta sin acciones suficientes en esa fecha, ni borrar una
  compra que una venta posterior necesita.
- **Regla de los dos meses** (art. 33.5.f LIRPF): una pérdida no se computa si compraste valores homogéneos en los
  2 meses anteriores (y siguen en cartera tras la venta) o los compras en los 2 meses posteriores. Se muestran como
  «pérdidas aplazadas».
- **IRPF estimado** con la escala del ahorro: 19 % hasta 6.000 €, 21 % hasta 50.000 €, 23 % hasta 200.000 €, 27 %
  hasta 300.000 €, 30 % a partir de ahí. Por posición: impuesto marginal sobre lo ya realizado este año en Hormiga.
  No incluye intereses, dividendos ni ventas fuera de Hormiga.
- **Patrimonio**: la cartera suma a precio de mercado (o a coste si no hay cotización) en activos, patrimonio neto,
  inversiones y su histórico mensual. Si además tienes un activo manual de tipo «Acciones», se avisa del posible doble
  cómputo.
- **Movimientos bancarios** hacia brókers o de compra/venta de valores y fondos (DEGIRO, Trade Republic, Interactive
  Brokers, «COMPRA DE VALORES», «SUSCRIPCION FONDOS»…) se clasifican como movimiento entre tus cuentas: invertir no es
  gastar.
