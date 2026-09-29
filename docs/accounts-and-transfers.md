# Cuentas, transferencias y perfil

## Cuentas — `src/core/db/accountsRepo.ts`, `src/core/services/accountsService.ts`

- Cada extracto importado se asigna a una **cuenta** por banco + tipo (cuenta/tarjeta) + últimos dígitos
  impresos en la **cabecera** del documento (los números enmascarados de los movimientos son tarjetas o
  referencias y no se usan). Un extracto sin dígitos reutiliza la única cuenta de ese banco; uno con dígitos
  adopta la cuenta sin dígitos si solo hay una.
- **Saldo derivado** (`src/core/domain/accounts.ts`): se guarda un saldo conocido al final de un día (el
  «ancla»: impreso en el extracto o indicado por el usuario) y el saldo de cualquier día es
  `ancla + Σ movimientos posteriores hasta ese día − Σ movimientos entre ese día y el ancla`.
  El saldo impreso del último movimiento de un extracto verificado sustituye al ancla si es más reciente.
- **Cuentas manuales**: las que no se importan (p. ej. una remunerada en otro banco). Su saldo = saldo indicado
  + transferencias recibidas desde tus cuentas importadas − las que salen, con interés diario compuesto
  `(1 + TAE)^(días/365)` si se indica rentabilidad. Una de ellas puede ser el **destino por defecto** de las
  transferencias a tu nombre.
- Las cuentas cuentan en el patrimonio (activos y evolución mensual). Las tarjetas no tienen saldo propio.
- **Duplicados entre formatos**: si la misma cuenta llega en dos formatos (extracto mensual y «últimos
  movimientos», Excel…), un movimiento con la misma fecha e importe ya importado desde otro documento de esa
  cuenta se omite (emparejamiento por multiconjunto: dos cargos iguales el mismo día se respetan).

## Transferencias — `src/core/domain/transfers.ts`, `src/core/domain/transactionType.ts`

| Movimiento | Tratamiento |
|---|---|
| Traspaso, «cuenta ahorro», liquidación de tarjeta, aportación… | Entre tus cuentas: no es gasto ni ingreso |
| Transferencia o Bizum enviado a otra persona | Gasto («Bizum y transferencias», o su categoría real) |
| Bizum recibido | Devolución: compensa gastos compartidos |
| Transferencia recibida de una persona | Ingreso (de una empresa: ingreso) |
| Beneficiario = tu nombre (perfil) o marcado «Es mía» | Entre tus cuentas; entra en la cuenta indicada (mantienes la liquidez) |
| Beneficiario marcado «Mi pareja» / nombre de tu pareja | Gastos compartidos (esencial) |
| Transferencia ≥ 1.000 € a un beneficiario sin revisar | Se asume entre tus cuentas y se marca «sin revisar» |
| Importe igual y de signo contrario en otra cuenta importada (≤ 4 días) | Pareja de traspaso: ambos lados neutros |

El beneficiario es el texto del detalle tras « · » (normalizado, 6 palabras como máximo). Las decisiones se guardan
en `counterparties` y se aplican a movimientos pasados y futuros. Los cambios manuales de categoría
(`category_locked`) nunca se sobrescriben. Al actualizar a la versión 0.3.0 los movimientos existentes se
reclasifican una vez con este modelo.

## Perfil financiero — `src/core/domain/profile.ts`

Opcional y local: nombre en el banco, hogar, pareja, personas a cargo, vivienda, estabilidad de ingresos,
objetivos y categorías prioritarias. Se usa para:

- **Colchón recomendado**: 3 meses de gasto esencial, +2 con ingresos variables, +3 si eres autónomo/a, +1 por
  persona a cargo (máx. +3), +1 con hipoteca, +1 si vives solo/a; máximo 12.
- No sugerir recortes en las categorías prioritarias.
- Reconocer tus traspasos y los gastos compartidos con tu pareja.

## Ahorro ampliado — `src/core/domain/savingsInsights.ts`, `src/core/domain/moreRecommendations.ts`

- **Adónde va tu dinero**: ingresos → esenciales, discrecionales, Bizum y transferencias, otros y ahorro; el
  dinero movido a tus cuentas se muestra aparte (no es gasto).
- **Referencia 50/30/20** (orientativa), **tu año** (ahorro acumulado, media, proyección a diciembre, meses
  cumpliendo el objetivo y racha), **colchón** según tu perfil y **próximos pagos** (60 días) con la reserva
  mensual para pagos no mensuales.
- Sugerencias nuevas: colchón insuficiente, dinero parado en cuenta corriente (con una rentabilidad ilustrativa del
  2 % indicada como supuesto), subidas de precio de suscripciones, suscripciones solapadas, pagos no mensuales
  próximos, Bizum/transferencias sin categorizar, transferencias grandes sin revisar, «ganas más y gastas más»,
  tasa de ahorro baja, efectivo sin rastro, metas atrasadas y deuda cara con liquidez sobrante (cálculo con el
  cuadro de amortización). Ninguna recomienda productos.
