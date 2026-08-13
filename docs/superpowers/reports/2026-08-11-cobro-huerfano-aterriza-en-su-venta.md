# Verificación contra Postgres real — el cobro huérfano aterriza en SU venta

Plan: `docs/superpowers/plans/2026-08-11-cobro-huerfano-aterriza-en-su-venta.md` — Task 3 (final).

Las Tareas 1-2 (commits `5659744a`..`6b355178`) ya están cubiertas por unit tests con mocks — prueban la **decisión**
(`resolveFastPaymentTarget`) y el **desvío** (`recordFastPayment` delegando en `recordOrderPayment`). Lo que un mock no puede probar es que
la venta quede bien **de verdad**: que el `Payment` de Prisma exista, que cuelgue de la orden real (no de una `FAST-…` nueva), y que esa
orden real conserve sus líneas de producto. Esta tarea corre el flujo completo contra Postgres local (`av-db-25`) sin ningún mock.

## Desviación deliberada del brief — por qué

El Step 1 del brief original decía "usar una orden `PENDING` existente del venue". **No se hizo así.** Esta base de datos de desarrollo la
comparten varias sesiones de IA en paralelo (regla del workspace); tomar una orden `PENDING` al azar y pagarla le habría roto el trabajo a
quien la esté usando. En su lugar, el script creó su **propia orden dedicada** —con una línea de producto—, la usó, y borró **todo** lo que
creó al terminar (orden, línea, pago, fila de arbitraje, y cualquier fila dependiente). Detalle completo del razonamiento y de las FK
verificadas en el reporte de proceso (`task-3-report.md`, no commiteado — vive en `.superpowers/`, gitignored).

## Setup

- **Venue:** `cmpe64yq2001f9k92m0lbhmf4` (Restaurante El Atole) — `salesEnabled=true`.
- **Staff:** María González (`cmpe64z8k001s9k928rk7wx4l`), activa en el venue.
- **Orden dedicada:** `orderNumber` marcado `VERIF-HUERFANO-<timestamp>`, status inicial `PENDING`, **1 línea de producto** (`OrderItem` con
  `productId: null` + `productName` denormalizado — el mismo patrón "producto borrado" que el motor ya soporta; así el script nunca toca
  stock de un producto real de este venue compartido), `subtotal = total = $100`.
- **Solicitud de arbitraje:** `TerminalPaymentRequest` con `status: CANCELLED` (el escenario exacto del bug: el cajero canceló, pero la
  terminal cobró de todos modos) y `orderId` apuntando a la orden dedicada.
- **Cobro:** `recordFastPayment(venueId, paymentData)` con `terminalPaymentRequestId` apuntando a esa solicitud, `amount: 10000` centavos
  ($100, paga la orden completa), `method: CREDIT_CARD`, `idempotencyKey` propia.

## Qué se pidió comprobar (y se comprobó)

1. **El pago aterriza en la orden real, no en una `FAST-…` nueva.**
2. **Esa orden tenía líneas de producto** — exactamente lo que hoy se pierde.
3. **No se creó ninguna orden `FAST-…`** (conteo antes/después, mismo venue).

## Salida real del script (corrida limpia, exit code 0)

```
=== Verificación: cobro huérfano aterriza en SU venta === venue=cmpe64yq2001f9k92m0lbhmf4 run=1786511214543

Venue: Restaurante El Atole (cmpe64yq2001f9k92m0lbhmf4)
Staff de prueba: María González (cmpe64z8k001s9k928rk7wx4l)

✅ Orden dedicada creada: cmspmnfkd0001c9mumko3ekt4 (VERIF-HUERFANO-1786511214543) — 1 línea(s), total $100
✅ TerminalPaymentRequest VERIF-HUERFANO-1786511214543 creada — status=CANCELLED, orderId=cmspmnfkd0001c9mumko3ekt4

Baseline: 171 venta(s) FAST-… en el venue, 0 pago(s) en la orden dedicada.

[log] 🚨 [Terminal-payment] Payment recorded for an already-CANCELLED request — reconciled to
      COMPLETED (money moved despite cancel/close) { requestId: 'VERIF-HUERFANO-1786511214543',
      paymentId: 'cmspmnfov0006c9muqerm9m4g', priorStatus: 'CANCELLED' }
      ← esta alerta es la esperada: closeRowFromPaymentTx reconciliando exactamente el
        escenario del bug (solicitud CANCELLED, dinero que sí se movió).

✅ recordFastPayment devolvió payment id=cmspmnfov0006c9muqerm9m4g, orderId=cmspmnfkd0001c9mumko3ekt4, type=REGULAR

✅ el pago quedó en la orden REAL (1 pago(s), status COMPLETED, paymentStatus PAID)
✅ NO se creó venta FAST (antes 171, después 171)
   la orden tenía 1 línea(s) de producto — eso es exactamente lo que antes se perdía
✅ el Payment quedó type=REGULAR, no FAST — [REGULAR]
✅ la fila de arbitraje quedó COMPLETED con paymentId (closeRowFromPaymentTx corrió) — status=COMPLETED paymentId=cmspmnfov0006c9muqerm9m4g

🧹 Limpieza: 1 orden(es) + 1 pago(s) + fila(s) de arbitraje VERIF-* borradas
✅ no quedaron órdenes VERIF-HUERFANO-* (0)
✅ no quedaron TerminalPaymentRequest VERIF-* (0)

🎉 Verificación completa: todo en ✅
```

Corrida repetida una segunda vez (mismo venue, `run` distinto) para confirmar que no es un resultado de una sola vez: mismo resultado, exit
code `0`, mismas 6 líneas en ✅.

## Checks más allá de los dos pedidos por el brief

El script agregó dos comprobaciones extra, baratas y con alto valor de evidencia:

- **`Payment.type === 'REGULAR'`** — la ruta FAST pone `type: 'FAST'` explícito en el `Payment` que crea; `recordOrderPayment` no toca ese
  campo y usa el default del schema (`REGULAR`). Que el pago haya quedado `REGULAR` es una segunda señal, independiente del conteo de
  órdenes `FAST-…`, de que pasó por `recordOrderPayment` y no por la ruta vieja.
- **La fila de arbitraje quedó `COMPLETED` con `paymentId` poblado** — confirma que `closeRowFromPaymentTx` corrió dentro de la misma
  transacción que el `Payment` (Ronda 2 de Task 2 depende exactamente de esta escritura atómica para decidir si debe caer a FAST).

El script también toleraba que `recordFastPayment` **lanzara** una excepción (Ronda 2 de Task 2: un pre-flight post-commit puede rechazar y
relanzar el error ORIGINAL en vez de caer a FAST, precisamente para no duplicar un cobro que ya aterrizó) — en ese caso el script igual
habría verificado el estado real en Postgres en vez de asumir éxito por el valor de retorno. No hizo falta: las dos corridas completaron sin
excepción.

## Limpieza — qué se borró y cómo se confirmó

El script borró, en este orden (verificado contra `information_schema` real de Postgres, no contra el `.prisma` a ojo —
`PaymentAllocation.orderId` es `RESTRICT` y `CommissionCalculation.{orderId,paymentId}` son `SET NULL`, ninguno de los dos es `CASCADE`, así
que ambos necesitaban borrado explícito antes de tocar `Order`/`Payment`):

`PaymentAllocation` → `CommissionCalculation` (sí se creó una, el venue tiene un esquema de comisión activo) → `DigitalReceipt` →
`TransactionCost` → `VenueTransaction` → `SaleVerification` / `Review` / `RateCorrectionEntry` (no aplicaban) → `Payment` → `OrderItem` →
`Order` → `TerminalPaymentRequest`.

Confirmación **independiente** (fuera del propio script, vía `psql` directo, contando por los IDs reales que imprimió la corrida):

```
     t                            | count
-----------------------------------+-------
 Order                            |     0
 Payment                          |     0
 TransactionCost                  |     0
 DigitalReceipt                   |     0
 CommissionCalculation(byOrder)   |     0
 CommissionCalculation(byPayment) |     0
 VenueTransaction                 |     0
 PaymentAllocation                |     0
 OrderItem                        |     0
 TerminalPaymentRequest(VERIF)    |     0
 Order(VERIF)                     |     0
```

`SELECT COUNT(*) FROM "Order" WHERE "venueId"='cmpe64yq2001f9k92m0lbhmf4' AND "orderNumber" LIKE 'FAST-%'` — **171 antes de las dos
corridas, 171 después de las dos y de la limpieza.** El venue queda exactamente como estaba.

El script temporal (`scripts/tmp-verificar-cobro-huerfano.ts`) se borró; `git status` no lo muestra.

## Conclusión

El fix de las Tareas 1-2 se comprobó contra Postgres real, no solo contra mocks: un cobro cuya solicitud de arbitraje trae `orderId`
aterriza en esa orden real —conservando sus líneas de producto—, queda registrado como `Payment` tipo `REGULAR`, cierra la fila de
arbitraje, y no crea ninguna venta `FAST-…` sintética. El escenario probado es el del bug original: solicitud `CANCELLED` con dinero que sí
se movió.
