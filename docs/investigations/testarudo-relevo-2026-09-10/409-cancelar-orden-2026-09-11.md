# 409 «Hay un cobro en curso en la terminal para esta orden» al cancelar desde la tablet — Testarudo, 11-sep-2026

> **Para el auditor (Codex):** verifica cada afirmación contra el código y los datos citados. No confíes en este
> resumen: confírmala o refútala con `archivo:línea`. Prioridad: dinero (cobro doble, cobro perdido, orden mal
> cerrada), después terminal atorada y órdenes huérfanas. Todo el acceso a producción es de **sólo lectura**.
> Nada de esto está commiteado ni desplegado. Escrito por la sesión «error_terminal_atascada» (fork del relevo Testarudo).

> **Corregido el 11-sep tras la auditoría de Codex**, que la otra sesión del relevo reenvió:
> 1. «No hubo cobro doble, son dos clientes» excedía la evidencia. Ahora §1.2 dice sólo lo que consta, con los
>    webhooks de Blumon como evidencia nueva. El portal de Blumon sigue sin revisarse.
> 2. La PAX de Testarudo tiene **304** filas históricas y 1 en vuelo al consultar, no 305 históricas (§3).
> 3. iOS **no secuencia**: el `await` vive en un `Task` aparte y `goBack()` corre fuera de él, sin esperarlo (§2.2).
>    Además, `cancelCurrentOrder()` no tiene ningún llamador en HEAD.
> El P1 de servidor que señaló Codex, la atomicidad de `cancelOrder`, lo toma la sesión del relevo.
> **El plan VIGENTE es §8** (corregido con la auditoría completa, `409-cancelar-orden-2026-09-11-auditoria-codex.md`).
> §4 se conserva tal como lo auditó Codex, porque su informe cita sus líneas.

## 1. Qué pasó (evidencia)

Línea de producción que vio el founder (Render → Better Stack):
`DELETE /api/v1/mobile/venues/:id/orders/:id` → **409**, `role=OWNER`, venue «Testarudo Cafe»
(`cmiowv1yu000aqa27mhhxrdqe`), `correlationId=fff12fb7-c4c0-405e-8da2-48f257727b4f`, `2026-09-11T16:23:04.946Z`.

### 1.1 Línea de tiempo (UTC; hora de Testarudo = UTC−6). Fuente: Better Stack, source `1720702` «render log stream»

| UTC | Petición / evento | Resultado | correlationId |
|---|---|---|---|
| 16:22:49.014 | `POST /mobile/.../orders` → orden `cmtx607hq01qlo82aohazdp79` (ORD-1789143769063), LATTE, subtotal 80 + propina 8 = **88** | 201 | 702ce655 |
| 16:22:49.226 | `POST /mobile/.../terminal-payment` (long-poll) → solicitud `2e183233-3593-47b5-9134-01a59245f054` a la PAX `2841653112` | ACK durable 16:22:49.705 (socket `GbrQGtalo1FvLAuDAAEv`) | e401409b |
| **16:23:04.926** | `DELETE /mobile/.../orders/cmtx607hq01q…` | **409** en 21.5 ms | **fff12fb7** |
| **16:23:04.985** | `POST /mobile/.../terminal-payment/cancel` (**59 ms DESPUÉS** del DELETE) | 200 en 16.8 ms | 903a9959 |
| 16:23:05.002 | fin del long-poll de la solicitud 2e183233 | 409 tras 15,776.9 ms | e401409b |
| 16:23:05–16:23:14 | `GET /terminal-payment/2e183233…` ×5 (la tablet consulta el estado) | 200 | varios |
| 16:23:22.079 | `POST /orders` → orden `cmtx60x1h01qto82a0hczobxq` (ORD-1789143802170), total 80 **sin propina** | 201 | f2b14dd0 |
| 16:23:25 · 16:23:27 · 16:23:32 | `POST /terminal-payment` ×3 | **409 «Terminal busy»** (P2002 en `TerminalPaymentRequest_active_slot`, terminalId 2841653112) | db4f11c1 · ff3f4c90 · 76aadda1 |
| 16:23:33.715 | `DELETE /orders/cmtx60x1h01q…` (esta orden nunca tuvo cobro) | 200, cancelada | c0943aac |
| ~16:23:38 | (base) solicitud 2e183233 → `CANCELLED`, `failureCode=CANCELLED`: gracia de 30 s del vigía | — | — |
| 16:23:42.591 | `POST /orders` → orden `cmtx61ctj01r5o82aasn36n1b` (ORD-1789143822626), total 88 | 201 | f6e93813 |
| 16:23:42.786 | `POST /terminal-payment` → solicitud `8f15d887…` | ACK 16:23:43.175 | 864ff7b0 |
| 16:23:49.294 | la PAX registra el cobro (`POST /tpv/venues/.../orders/cmtx61ctj01r…`) → Payment `cmtx61i1a0…` DEBIT_CARD, VISA, contactless, 80 + 8 | COMPLETED | c605e4b2 |

### 1.2 Estado en producción (consultado 16:39 UTC, sólo lectura)

- Solicitud `2e183233`: `CANCELLED`, `failureCode=CANCELLED`, `acknowledgedAt=16:22:49`, `updatedAt=16:23:38`.
- Orden `cmtx607hq01qlo82aohazdp79`: **`CONFIRMED` / `paymentStatus=PENDING`, $88, `updatedAt=16:22:49`** ⇒ quedó **huérfana**: abierta, sin pago, sin cobro vivo.
- Orden `cmtx60x1h01qto82a0hczobxq`: `CANCELLED`. Orden `cmtx61ctj01r5o82aasn36n1b`: `COMPLETED/PAID`.
- **Lo que consta sobre el dinero:** la orden del intento cancelado no tiene `Payment`. Tampoco quedó acreditado un
  segundo cargo bancario. En `ProviderEventLog`, que guarda los webhooks del procesador, Testarudo tiene entre
  16:15 y 16:30 UTC exactamente cuatro eventos `VENTA APROBADA`, cada uno ligado a su `Payment`:

  | Llegó | Monto | Operación | Payment |
  |---|---|---|---|
  | 16:15:43 | 132.25 | 24392391 | `cmtx5r3ap0…` |
  | 16:21:44 | 88.00 | 24392577 | `cmtx5ytot0…`, MASTERCARD, producto MOCHA |
  | 16:23:49 | 88.00 | 24392661 | `cmtx61i1a0…`, VISA, producto LATTE |
  | 16:26:01 | 187.00 | 24392735 | `cmtx64bko0…` |

  No hay ninguna aprobación entre 16:22:49 y 16:23:42, que es la ventana del intento `2e183233`. Los únicos eventos
  de Testarudo sin `Payment` hoy son rechazos `NOT_APPROVED`: tres de 231.00 entre 15:53 y 15:55, y dos de 473.00 a
  las 16:51. **Límite:** un webhook puede no llegar. La prueba definitiva de que no hubo cargo es el portal de
  Blumon, que no se revisó. Que las dos aprobaciones de $88 sean de dos clientes distintos es una inferencia, porque
  la marca y el producto difieren, pero no está probado.

## 2. Causa

### 2.1 Servidor en producción (`origin/main` = `0265daaa`, merge del PR #121, 10-sep 23:08 −0500): se comporta como está diseñado
- `src/services/mobile/order.mobile.service.ts:3214-3223`: `cancelOrder` llama a `hasChargeBlockingOrderCancel` y
  responde 409 `ConflictError` con ese mensaje.
- `src/services/terminal-payment.service.ts:867-878`: `hasChargeBlockingOrderCancel` bloquea `PENDING/SENT/UNKNOWN` y
  **excluye `CANCEL_REQUESTED` a propósito**. Su comentario (`:855-866`) supone que «el flujo de cancelar del POS
  cancela primero el cobro y la orden inmediatamente después».
- A las 16:23:04.926 la fila seguía `SENT` porque el cancel todavía no había llegado. El 409 es correcto: si el
  cliente acercaba la tarjeta, el cobro habría caído sobre una orden cancelada.
- La gracia: `:161` `CANCEL_GRACE_MS = 30_000` y `:980-986`. Un `CANCEL_REQUESTED` sin pago durante 30 s pasa a
  `CANCELLED/CANCELLED` y libera la terminal. Por eso hubo 3 × 409 «Terminal busy» durante unos 33 s.

### 2.2 POS Android — **causa raíz: carrera entre dos peticiones**
- `avoqado-android` HEAD `46c5cdc`, `app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt`:
  - `cancel()` `:1841`: en `:1847` llama a `terminalPaymentService.cancelCurrentPayment()` y en `:1862` lanza
    `viewModelScope.launch { orderRepository.cancelOrder(orderId) }`.
  - `cancelAndExit()` `:1877`: mismo patrón en `:1888` y `:1890`.
- `app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt` HEAD `:514` `cancelCurrentPayment()`:
  cancel **fire-and-forget** en un `Thread` crudo (`:527-528`). Regresa sin esperar a que el servidor registre el
  `CANCEL_REQUESTED`.
- Resultado: el DELETE y el cancel salen en paralelo. Si el DELETE llega primero (aquí 59 ms), recibe 409. La app
  muestra `_cancelFailure` («No se pudo cancelar la orden: … Sigue abierta — revísala en Órdenes.») y **nunca
  reintenta cancelar la orden** cuando el cobro termina ⇒ orden huérfana.
- **El árbol sin commitear NO lo cambia:** mismo código en `:1855/:1861/:1876` y `:1891/:1902/:1904`;
  `TerminalPaymentService.kt:535/:548` sigue siendo fire-and-forget. Verificado con `git diff HEAD`: los hunks de la
  tanda T15 no tocan estas funciones.
- iOS (`avoqado-ios` HEAD `b7ad204`) **no borra la orden al cancelar, pero tampoco secuencia**:
  - `avoqado-ios/Payment/PaymentFlowView.swift:236-238` lanza `await cancelCurrentPayment()` dentro de un `Task`
    aparte, y `:244` llama a `goBack()` fuera de ese `Task`, sin esperarlo.
  - `goBack()` pasa de `.sentToTerminal` a `.confirming` conservando la misma orden.
  - `PaymentFlowViewModel.swift:1862` `cancelCurrentOrder()` **no tiene ningún llamador** en HEAD (`git grep`).
  - Consecuencia: el iPad no dispara esta carrera concreta. Pero si el cajero abandona el cobro, nada cancela la orden
    por este camino. Es una posible fuente distinta de huérfanas, no medida en producción.

### 2.3 Impacto medido en producción (sólo lectura)

Órdenes huérfanas en los últimos 14 días: órdenes distintas en estado abierto con `paymentStatus=PENDING`, sin
`Payment`, con al menos una solicitud `CANCELLED/FAILED/TIMED_OUT` y ninguna `COMPLETED`:

| Venue | Solicitud terminó | failureCode | Órdenes | Monto | Mismo monto cobrado en otra orden ≤15 min |
|---|---|---|---|---|---|
| Testarudo | CANCELLED | – (la terminal lo confirmó) | 9 | 2,340.00 | 3 |
| Testarudo | CANCELLED | CANCELLED (gracia) | 9 | 1,085.25 | 6 |
| Testarudo | TIMED_OUT | MANUAL_RECONCILE | 1 | 135.00 | 0 |
| Testarudo | TIMED_OUT | AUTO_RELEASED | 1 | 308.00 | 0 |
| Testarudo | FAILED | TPV_ERROR | 1 | 264.00 | 0 |
| Amaena | CANCELLED | – | 2 | 1,402.50 | 0 |
| Amaena | FAILED | TPV_ERROR | 1 | 11.50 | 0 |

Totales: **Testarudo 21 órdenes, $4,132.25 · Amaena 3 órdenes, $1,414.00**. No todas vienen necesariamente de esta
carrera: las `TIMED_OUT` y `TPV_ERROR` no pasan por el DELETE.

Resultado de las solicitudes de Testarudo HOY, por terminal:
PAX `2841653112`: 32 COMPLETED, 7 CANCELLED (3 confirmadas por la terminal, 4 por gracia).
Nexgo `n860w173400`: 1 COMPLETED, 9 CANCELLED (4 confirmadas, 5 por gracia). Las 10 de la Nexgo tuvieron ACK.

## 3. Qué cambia con el trabajo sin commitear (plan D: servidor + TPV)

- Servidor del árbol, `terminal-payment.service.ts:1335`: `hasChargeBlockingOrderCancel` usa
  `UNRESOLVED_FINANCIAL_OUTCOME` (`:217`), que incluye `SLOT_HELD` (**con `CANCEL_REQUESTED`**) + `TIMED_OUT` +
  `FAILED` con `ACK_TIMEOUT/ACK_REJECTED/TPV_ERROR` + `CANCELLED` sin `cancelDisposition='ACCEPTED'`.
  ⚠️ El comentario de `order.mobile.service.ts:3217` («CANCEL_REQUESTED does NOT block») queda **falso** en el árbol.
- Vigía del árbol, `:1448-1459`: una solicitud en vuelo vencida, incluido un `CANCEL_REQUESTED` pasada la gracia, sin
  pago ⇒ `UNKNOWN/TIMED_OUT`. Retiene la terminal y dispara 🚨. Producción, en `:980-986`, la pasaba a `CANCELLED`.
- La migración `prisma/migrations/20260909181000_terminal_payment_cancel_disposition` agrega `cancelDisposition TEXT`
  **NULL y sin backfill**. En producción la columna no existe todavía. Filas históricas que el predicado del árbol
  contaría como no resueltas al desplegar:

  | Venue | Terminal | CANCELLED | TIMED_OUT | FAILED ACK/TPV | En vuelo ahora | Total |
  |---|---|---|---|---|---|---|
  | Testarudo | PAX 2841653112 | 296 | 1 | 7 | 1 | **304 históricas + 1 en vuelo** |
  | Testarudo | Nexgo n860w173400 | 34 | 1 | 18 | 0 | **53** |
  | Amaena | Nexgo n860w173570 | 9 | 0 | 3 | 0 | **12** |

- TPV del árbol: `core/presentation/viewmodels/HomeViewModel.kt:1092` **ignora** `TerminalPaymentCancel` (`-> Unit`).
  `core/remotepayment/RemotePaymentInbox.kt:100-112`: `cancel()` sólo acepta una solicitud todavía `RECEIVED`.
  `RemotePaymentCoordinator.kt:125` la reclama (`markProcessingForVenue`) **antes** de abrir la pantalla de cobro.
  Así, en cuanto la pantalla aparece, el cancel de la tablet recibe `ACTIVE` y la terminal sigue pidiendo tarjeta.
  Es el defecto «N3» ya declarado en `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md`. La TPV publicada
  (HEAD `aea0169`, v2.9.2), en `:1090`, sí pasa el cancel a `cancelSocketPaymentRequest` y regresa al inicio, sin
  mandar disposición.
- **Si se despliega todo tal como está**, la secuencia del 11-sep quedaría así:
  1. El DELETE recibe 409, tanto con la fila `SENT` como con `CANCEL_REQUESTED`. Da igual el orden en que lleguen.
  2. El cancel recibe `ACTIVE` y la terminal sigue pidiendo tarjeta.
  3. La orden queda abierta.
  4. La terminal queda retenida hasta que el cliente pague o el cajero cancele en la propia terminal. Con los APK
     publicados, que nunca mandan la disposición, queda retenida para siempre en `UNKNOWN/TIMED_OUT`.
  5. Las 304 filas históricas bloquean la PAX de Testarudo desde el primer minuto, salvo que se concilien antes.

## 4. Arreglo propuesto (a auditar)

**A. POS Android: secuenciar y reintentar** (requiere APK):
1. `cancelCurrentPayment()` pasa a `suspend` y devuelve el desenlace del `POST /terminal-payment/cancel`: registrado,
   ya resuelto o no encontrado.
2. `cancel()` y `cancelAndExit()` esperan el paso 1. Después consultan `GET /terminal-payment/{requestId}` hasta
   llegar a un estado final:
   - **No se cobró** (prod: `CANCELLED`; árbol: `CANCELLED`+`ACCEPTED` o `FAILED/TPV_CONFIRMED_NO_CHARGE`):
     `DELETE` de la orden.
   - **`COMPLETED`**: NO cancelar. Mostrar «Se cobró» y el recibo.
   - **Sigue en vuelo o `UNKNOWN`**: no cancelar. Mostrar «La terminal sigue con el cobro: cancélalo en la terminal
     o espera», y persistir en Room una intención durable de «cancelar la orden cuando el cobro cierre sin cargo».
     Esa intención se reproduce al reconectar y al arrancar la app.
3. Un 409 con este código en el DELETE no es un fallo final: queda la intención durable.
4. Pruebas: el DELETE nunca sale antes de que el cancel esté acusado; un 409 se reintenta tras `CANCELLED`; un
   `COMPLETED` no se cancela; muerte del proceso entre el cancel y el DELETE; sin red.
5. iOS, cambiado JUNTO con Android por regla del workspace: hay que secuenciar igual. Primero esperar el cancel,
   después volver a la pantalla anterior. Además, decidir qué pasa con la orden si el cajero abandona el cobro, porque
   `cancelCurrentOrder()` hoy no tiene llamadores. Con el servidor del árbol, cancelar la orden mientras la fila esté
   `CANCEL_REQUESTED` también recibiría 409.

**B. Servidor: alternativa o complemento, sin APK nuevo.** Al responder el 409, registrar la intención de cancelar
(columna en `Order` o `ActivityLog`). Cuando la solicitud cierre como «no se cobró» en `closeRow` o en el vigía,
cancelar la orden en la MISMA transacción, sólo si sigue sin pagos. Si el cobro se completa, descartar la intención.
Pregunta: ¿es seguro? ¿Qué pasa si el cajero ya rehízo la venta?

**C. TPV: decisión N3.** Aceptar el cancel de la tablet sobre una solicitud ya reclamada mientras el SDK no haya
entrado al kernel. Decide un CAS en la libreta: `PREPARANDO→DESCARTADA` contra `PREPARANDO→KERNEL`, gana el primero.
Si gana el cancel, responder `cancelled` + `outcomeEvidence=PRE_AUTHORIZATION` + disposición `ACCEPTED`. Si ya entró
al kernel, responder `ACTIVE` y mostrar un aviso visible en la terminal. AngelPay: definir el punto equivalente, que
sería antes de lanzar el Intent.

**D. Servidor del árbol, antes de desplegar:**
- Conciliar o declarar las 304/53/12 filas históricas. Es el paso 1 del plan D de Codex.
- Definir la compatibilidad con los APK que no mandan disposición.
- Corregir el comentario falso de `order.mobile.service.ts:3217`.

**E. Limpieza en producción (requiere OK del founder):** cancelar las 24 órdenes huérfanas sólo si no tienen
`Payment` y todas sus solicitudes terminaron sin cobro. Las que se cancelaron por gracia se contrastan antes con el
portal del procesador: un `CANCELLED` por gracia **no prueba** que no hubo cargo.

## 5. Preguntas concretas para el auditor

1. ¿La carrera explica por sí sola el 409 de las 16:23:04? ¿Hay otro camino de Android que borre la orden con un
   cobro vivo, por ejemplo al salir de la pantalla o en `TablesViewModel.cancelOrder`?
2. ¿Qué versión de la app tenía la Sunmi a esa hora? Hay que confirmar que `cancelCurrentPayment` era
   fire-and-forget también en esa versión.
3. En producción, ¿cancelar la orden con la fila en `CANCEL_REQUESTED` es seguro, si la PAX publicada puede seguir
   cobrando tras volver al inicio? El comentario de producción lo cubre con `closeRowFromPaymentTx` + 🚨.
4. A contra B: ¿cuál es más seguro? ¿B le miente al cajero? ¿Es atómico?
5. C: ¿se puede probar «todavía no se leyó la tarjeta» al momento del cancel, en Blumon y en AngelPay?
6. ¿Los criterios de la sección E bastan para cancelar las 21+3 huérfanas?
7. ¿Hay algo más en el árbol del plan D que empeore este caso y no esté listado aquí?

## 6. Lo que NO está verificado

- La versión de la app Android en la Sunmi a esa hora: la consulta del `userAgent` en Better Stack falló por timeout (524).
- Por qué la Nexgo tuvo 9 cancelaciones de 10. Hipótesis: la Nexgo recibe el cobro pero no enciende la pantalla, medido
  el 10-sep en la matriz.
- Que cada huérfana venga de esta carrera.
- Que no hubo cargo bancario en el intento cancelado: consta en los webhooks, pero falta el portal de Blumon.
- Que las dos aprobaciones de $88 sean de dos clientes distintos: es una inferencia.

## 7. Cómo se obtuvo (reproducible, sólo lectura)

- Better Stack: source `1720702`, tabla `t284025.render_log_stream`, ventana 16:22:40–16:24:00 UTC.
  Unir `remote(t284025_render_log_stream_logs)` con `s3Cluster(primary, t284025_render_log_stream_s3)` con `_row_type = 1`,
  y filtrar `raw LIKE '%cmiowv1yu000aqa27mhhxrdqe%' OR raw LIKE '%2e183233%'`.
- Producción: la URL vive en `RENDER_DATABASE_URL` de `avoqado-server/.env`. **Nunca imprimirla.**
  `PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000"`.
  - Solicitudes: `SELECT ... FROM "TerminalPaymentRequest" WHERE "venueId"='cmiowv1yu000aqa27mhhxrdqe' AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '8 hours' ORDER BY "createdAt";`
  - Huérfanas: órdenes abiertas con `paymentStatus='PENDING'`, sin `Payment`, sin solicitud `COMPLETED`, con solicitud
    `CANCELLED/FAILED/TIMED_OUT` en 14 días (`DISTINCT ON (o.id)`).
  - Filas que el árbol bloquearía: `status IN ('PENDING','SENT','CANCEL_REQUESTED','UNKNOWN','TIMED_OUT','CANCELLED') OR (status='FAILED' AND "failureCode" IN ('ACK_TIMEOUT','ACK_REJECTED','TPV_ERROR'))`,
    agrupadas por venue y terminal.

## 8. Plan corregido tras la auditoría de Codex (VIGENTE: sustituye a §4)

Codex prefiere A corregida más la garantía atómica del servidor. B no se acepta como atajo invisible después de un
rechazo. **Reparto:** servidor, atomicidad y contrato → sesión del relevo. Apps Android e iOS → esta sesión, cuando el
founder lo autorice. Todas las referencias de abajo se verificaron contra el árbol el 11-sep.

### 8.1 Servidor (sesión del relevo)
- **Atomicidad.** `cancelOrder` debe correr bajo el MISMO lock de `Order` que usan la admisión
  (`terminal-payment.service.ts:551`) y el registro (`payment.tpv.service.ts:2317`), y releer pagos y obligaciones
  dentro de la transacción. Hoy lee `paymentStatus` (`order.mobile.service.ts:3191`), consulta la reserva (`:3219`) y
  actualiza (`:3225`) con operaciones separadas. La admisión de una autorización NUEVA debe rechazar una orden
  `CANCELLED`. Registrar una aprobación que YA ocurrió sigue permitido, y se concilia.
- **Contrato aditivo que necesitan las apps.** No se rompe ningún campo existente:
  - El 409 del DELETE lleva un `code` propio y el `requestId` que bloquea. Hoy es un `ConflictError` sin code
    (`order.mobile.service.ts:3220`).
  - `GET /terminal-payment/:requestId` expone un desenlace canónico acreditado, o `failureCode` más la evidencia. Hoy
    devuelve `status` y `cancelDisposition`, pero no `failureCode`.
  - `POST /terminal-payment/cancel` devuelve el estado durable que registró. Hoy sólo dice «enviada» o «no conectada»
    (`terminal-payment.mobile.controller.ts:409-414`).
- Corregir el comentario falso de `order.mobile.service.ts:3217` y la prueba con nombre obsoleto
  (`tests/unit/services/mobile/order.mobile.service.test.ts:1034`).
- **Estado al 11-sep, según la sesión del relevo, SIN commitear:**
  - Hechas:
    - `cancelOrder` corre en una transacción con `FOR UPDATE` sobre `Order` y relee pagos y reserva dentro.
    - Nuevo `findChargeBlockingOrderCancel(venueId, orderId, client)`.
    - La admisión rechaza con 400 un cobro NUEVO sobre una orden `CANCELLED` o `DELETED`.
    - **Pieza 1 del contrato:** el 409 lleva `code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE'` y `details: { requestId }`
      del cobro que bloquea, el más reciente. El middleware serializa ambos y hay una prueba de integración que los fija.
    - El comentario falso de `order.mobile.service.ts` y los dos nombres obsoletos de pruebas, corregidos.
    - Corridas: integración 64/64 y unit 110/110. Los sabotajes seguían corriendo.
  - **Cierre, reportado por la misma sesión:** una revisión independiente no encontró P1 ni riesgo de deadlock. Sus
    P2 se cerraron con TDD y sabotaje:
    - La cola offline reintenta el `P2028`, el timeout de la transacción de `cancelOrder` con el pool saturado, en vez
      de mandarlo a cuarentena.
    - El 400 de la admisión para una orden cancelada lleva `code: 'ORDER_CANCELLED_NO_NEW_CHARGE'` y
      `details: { requestId }` (`terminal-payment.service.ts:570`).
    - Cancelar sin motivo ya no borra las notas del cliente.
    - Finales: unit 183/183, integración 65/65, typecheck 0. Nada commiteado.
    - Queda declarado que la ruta `/tpv` del cancel descarta `code` y `details`.
  - **Pendientes, a propósito:** las piezas 2 (desenlace canónico en el GET) y 3 (estado durable en el POST cancel).
    Son el contrato de A y se diseñan junto con los DTO de Android e iOS cuando el founder lo autorice, como pide Codex.
- **Tres rutas más cancelan una orden SIN mirar cobros de terminal ni tomar el lock** (verificado; nadie las ha tocado):
  - Dashboard: `src/services/dashboard/order.dashboard.service.ts:606` escribe `status: 'CANCELLED'`. Revisa
    `paymentStatus` y los Payments, pero no la reserva de terminal.
  - TPV, al anular todos los artículos: `src/services/tpv/order.tpv.service.ts:~2837-2849`. Es un `updateMany` con CAS
    de `version` que la pasa a `CANCELLED`, sin mirar la reserva.
  - `mergeOrders` sobre la orden ORIGEN: `src/services/mobile/order.mobile.service.ts:1826` hasta `~1936`, donde la
    pasa a `CANCELLED` dentro de su transacción, sin consultar la reserva. La encontró la revisión independiente.
  - Las tres deben usar el mismo lock y `findChargeBlockingOrderCancel`. Falta decidir quién las toma.

### 8.2 Apps: Android e iOS cambian JUNTOS
1. **Intención durable ANTES de la primera petición.** Se persiste `{intentId, orderId, requestId, venueId, actor,
   estado}` antes del POST cancel, y se reproduce al arrancar y al reconectar, con el mismo `requestId`. Hay que
   cubrir la muerte del proceso en cada punto de la secuencia.
2. **Secuencia.** Primero el POST cancel y esperar su respuesta. Después, el desenlace del intento:
   - **No se cobró, con evidencia.** Sólo cuenta la disposición `ACCEPTED`, `PRE_AUTHORIZATION` o `PROCESSOR_DECLINED`
     correlacionados con el intento. En ese caso se hace el DELETE de la orden.
   - **Se cobró.** No se cancela. Se muestra «Se cobró» y el recibo.
   - **Cualquier otro caso.** La orden queda en «cancelación pendiente», visible, sin borrarse y sin volver a autorizar.
3. **Nunca cuenta como «no se cobró»:** un `CANCELLED` por gracia del servidor actual, un 404, un error de red, un 409
   sin el `code` nuevo, ni que se agote la espera.
   **Códigos del contrato, ya en el servidor sin commitear:**
   - 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` con `details.requestId`: la orden sigue protegida por un cobro vivo.
     La intención queda pendiente.
   - 400 `ORDER_CANCELLED_NO_NEW_CHARGE` con `details.requestId`: el servidor prueba que ESE cobro nuevo no se creó.
     El POS puede soltar su llave durable, pero sólo si `details.requestId` es su propia solicitud.
4. **Android:** la pantalla no se va antes de conocer el desenlace.
   - `PaymentFlowScreen.kt:211-216` llama a `viewModel.cancel()` y a `onCancel()` juntos.
   - `PaymentFlowViewModel.kt:1855-1861` limpia las identidades antes del resultado.
   - `TerminalPaymentService.kt:548` usa un `Thread` fire-and-forget. Pasa a `suspend` y devuelve el estado registrado.
5. **iOS:**
   - `PaymentFlowView.swift:234-244`: esperar el cancel antes de `goBack()`.
   - `PaymentFlowViewModel.swift:1904-1905` borra `currentOrderId` aunque falle `cancelCurrentOrder()`. Eso se quita.
   - Decidir quién llama a `cancelCurrentOrder()`, que hoy no tiene llamadores.
6. **Mesas:** `TablesViewModel.kt:358-378` (`anularCuenta`) y `:416-430` (`bulkAnular`) cancelan directo y dependen de
   la atomicidad del servidor. Con el `code` nuevo muestran «cobro en curso» en vez de un fallo genérico.
7. **Con el servidor de HOY:** la app deja de mandar el DELETE antes del cancel y deja de esconder el fallo. Pero NO
   cierra sola la orden, porque el servidor actual no da evidencia: la orden queda en «cancelación pendiente» hasta que
   una persona la revise. El cierre automático llega con el servidor nuevo y con una TPV que mande evidencia.

### 8.3 Terminal: N3, con la frontera que Codex acepta
- El CAS debe competir contra TODA entrada capaz de mover dinero del mismo intento, no sólo contra «la pantalla aún
  no leyó».
  - PAX: `PaymentAttemptLedger` `markAuthorizing` (`:115`), `markKernelEntered` (`:142`) y el cancel desde
    PREPARANDO (`:327`).
  - AngelPay: el SDK integrado y también el Intent o fallback (`AngelPayPaymentViewModel.kt:723-734`).
- Una solicitud PROCESSING sin fila en la libreta no es evidencia de que nunca se ejecutó.
- **Si gana el cancel:** persistir el resultado de la bandeja y su disposición ANTES de anunciarlos.
- **Si gana el SDK:** conservar al receptor del resultado, mostrar el aviso en la terminal y no inventar
  `PRE_AUTHORIZATION`.
- Requiere pruebas físicas en PAX y en Nexgo.

### 8.4 Históricos y limpieza
- Las 304/53/12 filas históricas exigen conciliación acreditada por intento, persistida. Nunca se rellena `ACCEPTED`
  por antigüedad: «declararlas» no basta.
- Las 21+3 órdenes son CANDIDATAS, no autorizaciones de cancelación. Para cancelarlas hace falta:
  - una lista exacta con la evidencia de cada intento, consultando al procesador cuando falte un resultado fiable e
    incluyendo los negativos legacy sin evidencia;
  - relectura y cierre transaccional, conservando la trazabilidad;
  - aprobación del founder.

### 8.5 Pruebas exigibles (lista de Codex)
1. Android: invertir a propósito el orden de llegada de cancel y DELETE; proceso muerto antes del POST, tras el ACK y
   antes o después del DELETE; sin red; volver a la pantalla y arranque en frío; el mismo `requestId` durable.
2. Postgres real: cancelación contra admisión nueva y contra registro de pago; cancelación pedida con el cobro
   todavía activo; resultado final pagado; pagos parciales; una orden cancelada no admite una autorización nueva.
3. Backend antiguo: un `CANCELLED` por gracia nunca dispara el cierre «sin cargo»; un 409 ajeno, un 404 o un error de
   transporte no cuentan como evidencia.
4. B, si se adopta: intención obsoleta tras editar o reanudar la orden, job duplicado, caída antes o después del
   commit, y preservar los efectos de mesa y referidos.
5. PAX y Nexgo: cancel antes de la barrera, carrera con la barrera, kernel o SDK ya activo, aprobación tardía y
   respuestas perdidas. Una autorización y un registro por intento.
6. Paridad iOS y contratos aditivos. Typecheck, build y suites por avq-verify, leyendo su veredicto real.
