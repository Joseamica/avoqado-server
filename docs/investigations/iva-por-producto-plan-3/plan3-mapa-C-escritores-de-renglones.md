# Mapa C — escritores de renglones de orden (`OrderItem` / `OrderItemModifier` / totales derivados)

Repo leído: `avoqado-server/.claude/worktrees/iva-por-producto` (rama `iva-por-producto`, contiene
`develop` al 25-sep). Sólo lectura — nada modificado, nada ejecutado.

## Contexto: la cerradura "de la factura" todavía no existe

Busqué el mecanismo descrito ("una reserva de factura que también toma `Order FOR UPDATE` y
congela los renglones") en `src/services/fiscal/*` (cfdi.service.ts, cfdiGlobal.service.ts,
cfdiReconcile.service.ts, confirmarContratoDePrecio.service.ts) y no encontré ningún `FOR UPDATE`
sobre `"Order"` ni ninguna congelación de renglones ahí. Coincide con el estado declarado en
`CLAUDE.md` del workspace (IVA por producto: plan 1 hecho, plan 3 —"emisores con sellado, entrada
documental congelada, vida del intento"— **pendiente**, sin código). Este inventario es, por lo
tanto, el insumo para diseñar esa cerradura contra el estado REAL de los escritores de hoy — no una
comprobación contra un mecanismo ya construido.

## El candado canónico que SÍ existe hoy

`lockExistingOrderForPayment(tx, {venueId, orderId})` — `src/services/shared/paymentShiftClaim.ts:48`.
Hace exactamente `SELECT id FROM "Order" WHERE id=... AND "venueId"=... FOR UPDATE` y devuelve
`boolean` (si la fila sigue siendo de este venue). Es el candado que ya usan la admisión de un cobro
de terminal y el registro del dinero (`Order → Payment → Shift`).

Envoltura para cancelaciones, que además RELEE bajo el candado:
`lockAndReadOrderForCancel(tx, {venueId, orderId})` — `src/services/shared/orderCancelGuard.ts:47-60`,
y su hermana con más guardas `assertOrderCancellableUnderLock` (`orderCancelGuard.ts:112`).

**No existe hoy un helper equivalente para "lock + reread + mutar renglones + recalcular totales"**
de uso general. Cada escritor de renglones decide por su cuenta si toma algún candado, y la mayoría
no lo hace.

## Los DOS motores de recálculo de totales, y ninguno de los dos toma candado por sí solo

1. **`recalculateOrderTotals`** — `src/services/mobile/comp-item.mobile.service.ts:137-207`.
   Recibe opcionalmente un `tx`; si no se lo pasan usa `prisma` (fuera de cualquier transacción).
   Su ÚLTIMA escritura es:
   ```ts
   const updated = await db.order.update({
     where: { id: orderId },       // 🔴 SIN version en el where — no hay CAS aquí
     data: { subtotal, discountAmount, serviceChargeAmount, total, remainingBalance,
       version: { increment: 1 } },
   })
   ```
   Es un `UPDATE` ciego por `id`: ni `FOR UPDATE`, ni `WHERE version = X`. Su única protección es la
   que el LLAMADOR le dé (si el llamador ya sostiene un candado de fila en la MISMA tx, esta
   escritura hereda esa protección; si no, es una carrera abierta).

2. **El patrón inline de `order.tpv.service.ts`** (compItems, applyDiscount, voidItems): calcula el
   total con `computeStoredOrderTotal` y escribe con
   `tx.order.update({ where: { id: orderId, version: order.version }, ... }).catch(conflictoSiLaMovieron)`
   — SÍ lleva CAS por versión en el `where`. `voidItems` además toma el candado `FOR UPDATE`
   explícito (vía `lockAndReadOrderForCancel`) ANTES de tocar cualquier renglón, dentro de la MISMA
   transacción. Es el único escritor de renglones de todo el inventario que cumple el contrato
   completo (candado primero → releer bajo el candado → mutar → recalcular → CAS), y por eso es la
   referencia a copiar.

## Tabla de escritores

| # | file:line | Función | Qué muta | Candado de Order (cómo) | Mutación + totales en la MISMA tx | Relee bajo el candado | Notas |
|---|---|---|---|---|---|---|---|
| 1 | `src/services/tpv/order.tpv.service.ts:1381-2098` `addItemsToOrder` | `OrderItem.create/update`, `OrderDiscount.update`, `Order.subtotal/discountAmount/serviceChargeAmount/total/remainingBalance` | **Ninguno.** Toda la función corre con `prisma.*` sueltos — **no hay `prisma.$transaction` en absoluto** en esta función | **No** — cada `orderItem.create/update` y el `orderDiscount.update` son escrituras independientes, sin tx | No — el `order` que decide qué se crea/actualiza se leyó UNA vez al inicio, fuera de cualquier candado; nunca se relee | **NO CUMPLE.** Es la ruta MÁS usada (agregar productos, cambiar cantidad — se fusiona por upsert de línea, cortesía por línea). Sólo la escritura FINAL de `Order` lleva CAS (`updateMany({where:{id,version:order.version}})`, línea ~1979); las escrituras de `OrderItem` de en medio no llevan ninguna protección y pueden quedar aplicadas aunque el CAS final falle o aunque una reserva de factura interleave entre cualquiera de los pasos. Reusada también por el reducer offline (`sync.mobile.service.ts:914`, intent `ADD_ITEMS`) y por `addAreaTicketItems`… no — ver #14, `addAreaTicketItems` tiene SU PROPIO patrón, no reusa éste. |
| 2 | `src/services/tpv/order.tpv.service.ts:2219-2400` `removeOrderItem` | `OrderItem.delete`, `Order.subtotal/discountAmount/serviceChargeAmount/total/remainingBalance` | **Ninguno** — sin `$transaction` | No | No — mismo patrón: `order` leído una vez al inicio, usado para calcular todo | **NO CUMPLE, peor que #1.** Ni siquiera la escritura final lleva CAS: es `prisma.order.update({where:{id:orderId}, ...})` sin `version` en el `where`. El `orderItem.delete` y el `order.update` son dos llamadas sueltas — un crash entre ambas deja el renglón borrado con los totales viejos. |
| 3 | `src/services/tpv/order.tpv.service.ts:2478-2709` `compItems` | `OrderItem.update` (loop, marca `isCortesia`), `OrderServiceCharge` (vía `recalcularCargosPorServicio`), `Order.discountAmount/serviceChargeAmount/total/remainingBalance` | **Ninguno explícito.** El pre-read de `order` es `prisma.order.findUnique` (sin lock) ANTES de abrir la tx | **Sí** — todo el bloque (`orderItem.update` × N, recálculo de cargos, `tx.order.update`) vive dentro de UN `prisma.$transaction(async tx => {...})` | No — usa el `order` pre-leído fuera de la tx; no hay `findFirst`/`FOR UPDATE` DENTRO de la tx antes de mutar | **Parcial.** El `tx.order.update` final SÍ lleva CAS (`where:{id, version:order.version}` + `.catch(conflictoSiLaMovieron)`). Pero el candado de fila sobre `Order` no se toma hasta ESE `UPDATE` — hay una ventana, desde que arranca la tx hasta ese `UPDATE`, en la que nada bloquea a una reserva de factura que tome `FOR UPDATE` primero (ver análisis en el cuerpo del reporte). |
| 4 | `src/services/tpv/order.tpv.service.ts:2709-3061` `voidItems` | `OrderItem.deleteMany`, `OrderServiceCharge` (recalc), `OrderCustomer.deleteMany` (si anula todo), `Order.subtotal/serviceChargeAmount/total/remainingBalance/status` | **Sí — `FOR UPDATE` explícito, PRIMERO en la tx**, vía `lockAndReadOrderForCancel(tx,{venueId,orderId})` → `lockExistingOrderForPayment` (`SELECT id FROM "Order" ... FOR UPDATE`) | **Sí** — candado, relectura, `assertNoLiveTerminalCharge`, `orderItem.deleteMany`, recálculo de cargos y `tx.order.update` con CAS, todo dentro de la MISMA tx (`{timeout:15000, maxWait:5000}`) | **Sí** — `fresca = await lockAndReadOrderForCancel(...)` releé `version/paymentStatus/paidAmount/tipAmount` bajo el candado, y revalida `expectedVersion`/`paymentStatus` con esos valores frescos | **CUMPLE por completo.** Es la ÚNICA función de todo el inventario que hace candado→releer→mutar→recalcular→CAS en ese orden, dentro de una sola tx. Referencia a copiar para las demás. |
| 5 | `src/services/tpv/order.tpv.service.ts:3061-3307` `applyDiscount` | `Order.discountAmount/serviceChargeAmount/total/remainingBalance` (NO toca `OrderItem` directamente — descuento a nivel orden) | Ninguno explícito; pre-read sin lock | Sí — recálculo de cargos + `tx.order.update` con CAS en una sola tx | No | Mismo patrón parcial que `compItems` (CAS al final, sin candado desde el inicio). No es un escritor de `OrderItem`, pero sí de totales derivados de renglones. |
| 6 | `src/services/tpv/order.tpv.service.ts:3661-3817` `addSerializedItemToOrder` | `OrderItem.create`, `Order.subtotal/total/remainingBalance` | Ninguno | Sí — `orderItem.create` + `tx.order.update` en la misma `$transaction` | No — usa el `order` pre-leído fuera de la tx (`order.subtotal`, `order.discountAmount` de la prelectura, no de una relectura) | **NO CUMPLE, y es el peor de los tres "con tx":** el `tx.order.update` final es `where:{id:orderId}` **sin `version`** — ni CAS ni candado. Dos ventas seriadas concurrentes sobre la misma orden pueden pisarse el total sin que nada lo detecte. |
| 7 | `src/services/tpv/order.tpv.service.ts:912-1381` `createOrderWithItems` (línea 1181, `orderItem.create`) | Crea una orden NUEVA con sus renglones | N/A — la orden no existe todavía; no hay fila que una reserva de factura pueda estar sosteniendo | N/A (todo en una `$transaction` de creación) | N/A | Fuera de alcance del contrato: no hay orden preexistente que una reserva de factura pudiera tener bloqueada. |
| 8 | `src/services/mobile/order.mobile.service.ts:1556-1650` `splitOrderItems` | Crea orden nueva; `OrderItem.updateMany` (mueve renglones de `source` a la nueva orden); `OrderPromotion.updateMany`; llama `recalculateOrderTotals` para AMBAS órdenes | Ninguno | **Sí** — `order.create`, `orderItem.updateMany`, `orderPromotion.updateMany` y las DOS llamadas a `recalculateOrderTotals(..., tx)` están en la MISMA `prisma.$transaction` | No — `source` se lee con `prisma.order.findFirst` FUERA de la tx; dentro de la tx nunca se relee ni se bloquea la fila `source.id` | **NO CUMPLE.** La escritura final de `Order` (dentro de `recalculateOrderTotals`) es la ciega sin CAS descrita arriba — aquí no hereda protección de ningún candado previo, porque nadie tomó `FOR UPDATE` sobre `source.id` en esta tx. Los guards de negocio (sin descuentos/cargos manuales) se validan sólo con la lectura de fuera. |
| 9 | `src/services/mobile/order.mobile.service.ts:1706-1793` `splitOrderBySeat` | Mismo patrón que #8, N órdenes nuevas por asiento | Ninguno | Sí, mismo patrón que #8 | No | **NO CUMPLE**, idéntico a #8. |
| 10 | `src/services/mobile/order.mobile.service.ts:1843-2000` `mergeOrders` | `OrderItem.updateMany` (mueve TODOS los renglones de `source` a `target`), `OrderServiceCharge.deleteMany`, `Order.update` (contrato combinado en `target`), llama `recalculateOrderTotals` para ambas | **Sí — `FOR UPDATE` explícito y PRIMERO**, vía `tx.$queryRaw` crudo: `SELECT id FROM "Order" WHERE venueId=... AND id IN (source.id, target.id) ORDER BY id FOR UPDATE` | **Sí** — candado, relectura de `freshSource`/`freshTarget`, `assertNoLiveTerminalCharge`, `orderItem.updateMany`, `orderServiceCharge.deleteMany`, `order.update`, y las dos llamadas a `recalculateOrderTotals(..., tx)`, todo en la MISMA tx | **Sí** — `freshSource`/`freshTarget` se releen DENTRO del candado y se revalidan (status/paymentStatus/descuentos/cargos) contra esos valores frescos | **CUMPLE en el candado y la relectura** (segundo mejor ejemplo después de `voidItems`). La única brecha: la escritura final de `recalculateOrderTotals` sigue siendo el `UPDATE` ciego sin `WHERE version` — pero aquí SÍ hereda protección real, porque la fila ya está bajo `FOR UPDATE` desde el principio de esta misma tx, así que nadie más puede tocarla mientras tanto. |
| 11 | `src/services/mobile/order.mobile.service.ts:1431-1500` `applyOrderDiscount` | `OrderDiscount.create`, llama `recalculateOrderTotals` (fuera de cualquier tx propia — dos llamadas top-level sueltas: `orderDiscount.create` y luego `recalculateOrderTotals(orderId, ...)` sin `tx`) | Ninguno | **No** — son DOS operaciones de base de datos independientes, ninguna dentro de una `$transaction` | No | **NO CUMPLE, de la forma más simple**: ni siquiera hay un `$transaction` envolviendo el `create` + el recálculo. Un crash entre ambos deja el descuento creado sin reflejarse en `Order.total`. |
| 12 | `src/services/mobile/order.mobile.service.ts:1500-1548` `removeOrderDiscount` | `OrderDiscount.delete`, reversión de lealtad/sello (servicios importados), llama `recalculateOrderTotals` | Ninguno | **Sí** — `refundLoyaltyForOrderDiscount`, `refundStampRewardForOrderDiscount`, `orderDiscount.delete` y `recalculateOrderTotals(..., tx)` sí están dentro de una `prisma.$transaction` | No | Mejor que #11 (mutación+recálculo atómicos) pero sin candado ni CAS: la escritura final sigue siendo el `UPDATE` ciego de `recalculateOrderTotals`, sin protección propia en esta tx. |
| 13 | `src/services/mobile/comp-item.mobile.service.ts:31-83` `compOrderItem` | `OrderItem.update` (una fila, marca cortesía), llama `recalculateOrderTotals` | Ninguno | **No** — `prisma.orderItem.update(...)` y luego `recalculateOrderTotals(orderId, ...)` (sin `tx`) son dos llamadas top-level sueltas, sin transacción | No | **NO CUMPLE**, mismo patrón roto que #11. |
| 14 | `src/services/mobile/comp-item.mobile.service.ts:86-136` `compWholeOrder` | `OrderItem.update` × N (vía `prisma.$transaction(items.map(...))` — transacción de ARRAY, no de callback), llama `recalculateOrderTotals` DESPUÉS, fuera de esa transacción | Ninguno | **No** — las actualizaciones de renglones van en una tx (de array), pero el recálculo de `Order` es una llamada SEPARADA y posterior, sin tx compartida con la anterior | No | **NO CUMPLE.** Dos transacciones distintas: una para las líneas, otra (implícita, sin tx) para el total. Es reusado por el reducer offline (`sync.mobile.service.ts` intent `COMP_ORDER`). |
| 15 | `src/services/mobile/comp-item.mobile.service.ts:137-207` `recalculateOrderTotals` (el motor compartido) | `OrderDiscount.update` (recalcula %), `OrderServiceCharge.update`, `Order.subtotal/discountAmount/serviceChargeAmount/total/remainingBalance/version` | **Ninguno propio** — recibe `db` (puede ser `tx` o `prisma`) y no toma ningún candado por sí mismo | Depende del llamador | Depende del llamador | Escritura final SIN `WHERE version` (ver arriba). Es el punto único donde CASI todos los escritores "mobile" delegan su recálculo (comp, descuento, cargo, split, merge, promoción, lealtad, sello). Su seguridad es 100% prestada: segura sólo cuando el llamador YA tomó `FOR UPDATE` sobre la orden ANTES en la misma tx (caso `mergeOrders`); insegura en todos los demás casos de esta tabla. |
| 16 | `src/services/mobile/service-charge.mobile.service.ts:84-133` `applyServiceCharge` | `OrderServiceCharge.create`, llama `recalculateOrderTotals` (sin tx) | Ninguno | **No** — dos llamadas top-level sueltas | No | **NO CUMPLE**, mismo patrón que #11/#13. Reusado por el reducer offline (`APPLY_SERVICE_CHARGE`). |
| 17 | `src/services/mobile/service-charge.mobile.service.ts:134-162` `removeServiceCharge` | `OrderServiceCharge.delete`, llama `recalculateOrderTotals` (sin tx) | Ninguno | No | No | **NO CUMPLE**, idéntico a #16. |
| 18 | `src/services/mobile/service-charge.mobile.service.ts:164-224` `syncAutomaticServiceCharges` | `OrderServiceCharge.create/delete` (auto-aplicación por comensales), llama `recalculateOrderTotals` (sin tx) | Ninguno | No | No | **NO CUMPLE.** Se llama al abrir mesa y al cambiar comensales; puede correr concurrente con cualquier otro escritor de la misma orden sin ninguna serialización. |
| 19 | `src/services/promotions/promotion.service.ts:35-197` `applyPromotionToOrder` | `OrderPromotion.create`, `OrderItem.createMany` (renglones del combo), llama `recalculateOrderTotals(..., tx)` | Ninguno explícito; pre-read de `order`/`promotion` fuera de la tx | **Sí** — `orderPromotion.create`, `orderItem.createMany` y `recalculateOrderTotals(..., tx)` en la MISMA `prisma.$transaction` | No — no hay `FOR UPDATE` ni relectura de `order` dentro de la tx | **Parcial** (mutación+recálculo atómicos, sin candado ni CAS). El manejo de `P2002` (choque de `instanceId`) es correcto para idempotencia de replay, pero no protege contra una reserva de factura interleaved. |
| 20 | `src/services/promotions/promotion.service.ts:219-258` `removePromotionFromOrder` | `OrderItem.deleteMany` (por `orderPromotionId`), `OrderPromotion.delete`, llama `recalculateOrderTotals(..., tx)` | Ninguno | **Sí**, mismo patrón que #19 | No | **Parcial**, igual que #19. |
| 21 | `src/services/pos-sync/posSyncOrderItem.service.ts:31-111` `processPosOrderItemEvent` | Caso borrado: `orderItem.delete` SUELTO, sin tx, **y el propio código admite que no recalcula** ("Aquí deberías recalcular los totales de la orden padre" — comentario, línea ~46). Caso alta/edición: `orderItem.upsert` dentro de un `prisma.$transaction` pero TAMPOCO toca `Order` (mismo comentario repetido al final, línea ~110) | Ninguno | No (caso borrado); tx sin candado ni recálculo (caso alta/edición) | No | **NO CUMPLE, y es estructuralmente distinto**: este puente (SoftRestaurant) NUNCA deriva `Order.total` de los renglones — el total lo manda el POS externo y lo escribe `processPosOrderEvent` (`posSyncOrder.service.ts:365-369`) directamente desde el payload, sin mirar `OrderItem`. Los dos flujos (renglón y total) están desacoplados por diseño; el TODO explícito confirma que nadie cerró ese lazo. |
| 22 | `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts:250-350` (rama `esNueva`) | Crea orden NUEVA de repartidor con sus renglones (`OrderItem.create`, `OrderItemModifier.create`) | N/A — orden recién creada en la misma tx, no preexistente | Sí, todo dentro de `withDeliveryOrderLock` (ver más abajo) | N/A | Igual que #7: sin riesgo porque la orden no existe antes de esta llamada. |
| 23 | `src/services/delivery-channels/core/lineRemoval.service.ts:40-60` `applyLineRemoval` | `OrderItem.updateMany` (marca `removedAt`, NUNCA toca `Order.subtotal/total` — el ajuste de dinero se hace aparte como reembolso compensatorio) | Recibe `tx` del llamador; el propio módulo exige por convención que SIEMPRE se llame dentro de `withDeliveryOrderLock(orderId)` | Depende del llamador | Depende del llamador | El candado de esta familia (`withDeliveryOrderLock`, `src/services/delivery-channels/core/deliveryOrderLock.ts:16-24`) es un **advisory lock** (`pg_advisory_xact_lock(hashtextextended('delivery-order:'+orderId,0))`), NO un `SELECT ... FOR UPDATE` sobre la fila `"Order"`. Serializa entre sí a todas las operaciones de reparto sobre ese pedido, pero **no intersecta con un `FOR UPDATE` de `"Order"` tomado por otra ruta** (son espacios de candados distintos en Postgres) — salvo que el propio llamador, DENTRO de ese mismo advisory lock, tome ADEMÁS el `FOR UPDATE` de `Order` explícitamente (ver #24, que sí lo hace). |
| 24 | `src/services/delivery-channels/core/deliveryReconciliation.service.ts:78-180` (función de reconciliación, dentro de `withDeliveryOrderLock`) | Llama `applyLineRemoval` por cada renglón ausente en la foto del proveedor; NO reescribe `Order.subtotal/total` — el delta se liquida como reembolso (`Payment` con `provenance=PROVIDER_ADJUSTMENT`) en el código que sigue (fuera del rango leído aquí) | **Sí — combina los DOS candados**: primero el advisory `withDeliveryOrderLock`, y DENTRO de él, `lockExistingOrderForPayment(tx,{venueId,orderId})` (el `FOR UPDATE` canónico) ANTES de leer/tocar renglones — el comentario del código lo dice explícito: *"Serializa con un reembolso del dashboard en vuelo: ése toma `Order FOR UPDATE` sin el candado de reparto"* | Sí, `applyLineRemoval` y las lecturas de `filas`/`cobros` corren dentro de la misma tx que ya sostiene el `FOR UPDATE` | **Sí** — releé `vigente.status` bajo el candado antes de seguir | **CUMPLE la parte de candado+relectura**, al mismo nivel que `voidItems`/`mergeOrders`. No es un escritor clásico de `Order.total` (el dinero se corrige vía reembolso, no reescribiendo el total), así que el contrato de "recalcular totales en la misma tx" no aplica tal cual aquí — pero si el futuro mecanismo de factura reserva sobre `Order` con `FOR UPDATE`, ESTE escritor ya lo respeta. |
| 25 | `src/services/dashboard/discountEngine.service.ts:~838,~939,~1121` (aplicar cupón / descuento manual / descuento automático) | `OrderDiscount.create`, `Order.discountAmount/taxAmount/serviceChargeAmount/total/remainingBalance` (NO toca `OrderItem`) | Ninguno explícito | Sí — `orderDiscount.create` + `recalcularCargosPorServicio` + `tx.order.update` en la MISMA `prisma.$transaction` | No | `tx.order.update({where:{id:orderId}, ...})` **sin `version`** en el `where` — ni candado ni CAS. Mismo hueco que #6. |
| 26 | `src/services/tpv/discount.tpv.service.ts:~461` (cupón) | `OrderDiscount.create`, `Order.discountAmount/serviceChargeAmount/total/remainingBalance` | Ninguno explícito | Sí, mismo patrón que #25 | No | Igual que #25: `tx.order.update({where:{id:orderId}})` sin CAS. |
| 27 | `src/services/dashboard/order.dashboard.service.ts:446-604` `updateOrder` | Sólo `Order.status/customerId/customerName/tableId/servedById/...` — **explícitamente rechaza** editar `total/tipAmount/subtotal` a mano (los ignora con `logger.warn`) | Cuando `status` pasa a CANCELLED/DELETED: **sí**, vía `assertOrderCancellableUnderLock` (misma familia que `lockAndReadOrderForCancel`) | Sí, para el camino de cancelación | Sí, para el camino de cancelación | No es un escritor de renglones ni de totales derivados de renglones — se lista por completitud ("dashboard order editing"). El camino de cancelación SÍ sigue el contrato completo. |
| 28 | `src/services/dashboard/venue.dashboard.service.ts:410-436` (borrado de venue demo) | `OrderItem.deleteMany`, `OrderItemModifier.deleteMany` para TODAS las órdenes del venue | `FOR UPDATE` sobre `"Venue"` (no sobre `"Order"`) | Sí, dentro de una `$transaction` grande de borrado | N/A | Operación administrativa de borrado masivo de un negocio demo, no un flujo de venta — fuera del alcance real de "interleaving con una factura", pero aparece en el grep de escritores de `OrderItem` y se documenta por transparencia. |
| 29 | `src/services/onboarding/demoCleanup.service.ts:134`, `src/services/onboarding/demoSeed.service.ts:1330`, `src/services/cleanup/liveDemoCleanup.service.ts:337` | Borrado/siembra de datos DEMO | N/A | N/A | N/A | Fuera de alcance: no son ventas reales, son limpieza/siembra de ambientes demo. |
| 30 | `src/services/reservation/createOrderFromReservation.ts:247,265` | `OrderItem.create`, `OrderItemModifier.createMany` — orden NUEVA nacida de una reservación | N/A — orden nueva | N/A | N/A | Igual que #7/#22: sin riesgo, la orden no preexiste. |
| 31 | `src/services/mobile/areaTicket.mobile.service.ts:600-660` `addAreaTicketItems` (vale de área, V6) | `OrderItem.create` × N sobre una orden EXISTENTE (la del vale ya abierto) | **Implícito, vía CAS-como-lock**: `tx.order.updateMany({where:{id, venueId, version:order.version, paymentStatus:{in:['PENDING','PARTIAL']}}, data:{version:{increment:1}}})` se ejecuta PRIMERO, dentro de la tx — un `UPDATE` toma el row-lock de Postgres de inmediato y lo sostiene hasta el commit, así que en la práctica actúa como candado desde ese punto | **Sí** — el bump de versión, los `orderItem.create` en loop y el recálculo final (mencionado como "recompute desde TODOS los renglones", código no releído completo pero referenciado en el comentario de la línea ~438) están en la MISMA `prisma.$transaction` | Parcial — no hay un `SELECT...FOR UPDATE` explícito ni un `findFirst` posterior al bump, pero el `updateMany` con `WHERE version=X` sí falla (count=0 → 409) si alguien movió la orden entre la lectura y este punto, y a partir de que se ejecuta, la fila queda bloqueada para cualquier otro escritor concurrente | **El más cercano a "cumple" de los escritores mobile de líneas para una orden EXISTENTE**, después de `voidItems`/`mergeOrders`/`deliveryReconciliation`. La diferencia con `voidItems` es de forma, no de fondo: aquí el candado se adquiere IMPLÍCITAMENTE con el primer `UPDATE ... WHERE version=X` en vez de con un `SELECT ... FOR UPDATE` explícito — funcionalmente equivalente para bloquear a un `FOR UPDATE` concurrente sobre la misma fila, PERO no relee campos frescos de la orden bajo el candado antes de decidir qué renglones crear. |
| 32 | `src/services/mobile/sync.mobile.service.ts` (reducer offline; ver líneas 914, 1094, 1101, 1108, 1255, 1303, 1353) | No muta nada por sí mismo — **delega** en las funciones ya listadas: `ADD_ITEMS`→#1 (`addItemsToOrder`), `APPLY_DISCOUNT`→#11, `APPLY_SERVICE_CHARGE`→#16, `COMP_ORDER`→#14, `SPLIT_ORDER`→#8, `SPLIT_BY_SEAT`→#9, `MERGE_ORDERS`→#10 | Heredado de la función delegada | Heredado | Heredado | El reducer offline no añade ni quita candados: cada intent hereda EXACTAMENTE el nivel de cumplimiento de la función online correspondiente. Confirma que #1/#11/#14/#16 (los no-conformes) también son alcanzables por el camino de sincronización offline, no sólo por HTTP en línea. |

## Resumen

**Cumplen el contrato completo (candado `FOR UPDATE` PRIMERO, releer bajo el candado, mutar
renglones y recalcular totales en la MISMA transacción):**
- `voidItems` — `src/services/tpv/order.tpv.service.ts:2709` (el ejemplar de referencia)
- `mergeOrders` — `src/services/mobile/order.mobile.service.ts:1843` (candado de LAS DOS órdenes)
- La reconciliación de delivery — `src/services/delivery-channels/core/deliveryReconciliation.service.ts:78`
  (combina el advisory lock del canal con el `FOR UPDATE` canónico de `Order`; no reescribe
  `Order.total` directamente, liquida por reembolso, pero ya respeta el candado)

**Cumplen parcialmente** (mutación + recálculo sí atómicos en una `$transaction`, pero sin candado
`FOR UPDATE` tomado al inicio ni relectura fresca — el CAS por `version`, cuando existe, sólo se
aplica en la escritura FINAL de `Order`, dejando una ventana entre el arranque de la tx y esa
escritura donde una reserva de factura podría intercalarse):
`compItems`, `applyDiscount` (tpv), `removeOrderDiscount` (mobile), `applyPromotionToOrder`,
`removePromotionFromOrder`, `discountEngine.service.ts` (los tres caminos), `discount.tpv.service.ts`
(cupón), `addAreaTicketItems` (el más cercano a cumplir del grupo — el candado nace de un
`UPDATE...WHERE version=X` ejecutado primero, no de un `SELECT FOR UPDATE` explícito).

**NO cumplen** (mutación de renglones y recálculo de totales en llamadas SUELTAS, sin transacción
compartida, sin candado, y en varios casos sin siquiera CAS por versión en la escritura final):
- `addItemsToOrder` (`order.tpv.service.ts:1381`) — **la ruta más usada de todas** (agregar/editar
  cantidad/cortesía por línea desde el TPV, y reusada por el reducer offline)
- `removeOrderItem` (`order.tpv.service.ts:2219`) — ni siquiera el `Order.update` final lleva CAS
- `addSerializedItemToOrder` (`order.tpv.service.ts:3661`) — el `Order.update` final tampoco lleva CAS
- `splitOrderItems`, `splitOrderBySeat` (`order.mobile.service.ts`) — mueven renglones sin candado
  sobre la orden origen
- `applyOrderDiscount`, `compOrderItem`, `applyServiceCharge`, `removeServiceCharge`,
  `syncAutomaticServiceCharges` — cada uno hace DOS llamadas top-level sueltas (mutar, luego
  `recalculateOrderTotals` sin `tx`), sin transacción compartida siquiera
- `compWholeOrder` — usa una `$transaction` de ARRAY para las líneas y recalcula DESPUÉS, en una
  llamada separada
- `processPosOrderItemEvent` (pos-sync) — por diseño no recalcula nada desde los renglones (dos
  comentarios en el propio código lo admiten como pendiente); el total lo manda el POS externo

**Los dos motores de recálculo de totales, y su blindaje real:**
- El motor "mobile" (`recalculateOrderTotals`, `comp-item.mobile.service.ts:137`) termina SIEMPRE en
  un `db.order.update({where:{id:orderId}, ...})` **sin `version` en el `where`** — cero CAS, cero
  candado propio. Es seguro únicamente cuando el llamador ya sostiene `FOR UPDATE` sobre esa fila en
  la MISMA tx (así ocurre en `mergeOrders`); en los demás ~10 llamadores de esta tabla, es una
  escritura abierta.
- El patrón inline de TPV (`compItems`/`applyDiscount`/`voidItems`, todos en `order.tpv.service.ts`)
  SÍ usa `tx.order.update({where:{id, version: order.version}}).catch(conflictoSiLaMovieron)` — CAS
  real en cada uno, pero sólo `voidItems` toma además el `FOR UPDATE` explícito ANTES de mutar nada.

**El único candado de fila reutilizable que existe hoy** es `lockExistingOrderForPayment`
(`src/services/shared/paymentShiftClaim.ts:48`, un `SELECT ... FOR UPDATE` puro) y su envoltura para
cancelaciones `lockAndReadOrderForCancel`/`assertOrderCancellableUnderLock`
(`src/services/shared/orderCancelGuard.ts:47,112`). No existe hoy un helper equivalente pensado para
"lock + reread + mutar renglones + recalcular totales" de uso general — cada escritor que sí toma
candado (`voidItems`, `mergeOrders`, la reconciliación de delivery) lo hace copiando el mismo
`SELECT ... FOR UPDATE` a mano, no reusando una función compartida para ese flujo completo.
