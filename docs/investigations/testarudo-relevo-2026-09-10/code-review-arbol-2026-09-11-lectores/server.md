# Revisión de sólo lectura — `avoqado-server` (rama `develop`, árbol de trabajo sin commitear)
**Fecha:** 2026-09-11 · **HEAD:** `3000f3d0` · **Alcance:** `git diff HEAD -- src prisma` (4 197 inserciones / 1 718 borrados en 45 archivos) + `tests/` (6 663 / 209 en 47 archivos)
**Método:** sólo `git diff/show/status`, `sed -n`, `grep -n`. No se editó, compiló ni ejecutó nada. Cada `archivo:línea` sale de `grep -n`/`sed -n` sobre el árbol actual.

---

## 1. Inventario

### ÁREA A — Circuito de cobro remoto (POS → servidor → TPV)

| Archivo | Qué hace en este árbol |
|---|---|
| `src/services/terminal-payment.service.ts` (1 825 líneas cambiadas, 2 720 totales) | El núcleo. Admisión bajo candado con **lápida** (H.5/H.6), **procedencia de entrega** (`deliveryProvenance`, plan D), **sonda** `terminal:payment_probe`, `cancelDisposition`, predicado de bloqueo ampliado (`UNRESOLVED_FINANCIAL_OUTCOME`), watchdogs sin liberación por reloj |
| `src/communication/sockets/managers/socketManager.ts` | Identidad de terminal derivada del serial FIRMADO del token (`:189-192`); handshake lee `cancelDisposition`/`probe` versions; dos handlers nuevos (`payment_cancel_disposition`, `payment_probe_result`) gateados por `identityVerified`; `outcomeEvidence` descartado si la terminal no está verificada; replay y sonda al conectar con `.catch` |
| `src/communication/sockets/terminal-registry.ts` | `identityVerified` + versiones de capacidad; blindaje del mapping inverso `socketId → terminalId` (un socket no verificado ya no hereda la identidad de otro) |
| `src/controllers/mobile/terminal-payment.mobile.controller.ts` | Quita el 403 «otro venue» (lo decide el servicio con lápida); propaga `code` + `details.requestId` en 409/404/422/403/400/503; `getBusyTerminalIds` acotado a candidatos |
| `src/controllers/dashboard/terminals.superadmin.controller.ts` | Sólo el mensaje de «no se liberó» |
| `src/mcp/tools/terminals.ts` | `rejectedAtAdmission` + `failureCode` en `terminal_payment_requests`; descripciones de `release_terminal_payment` sin la promesa de liberación automática |
| `src/errors/AppError.ts` | `TerminalUnavailableError` (403/404/422), `TerminalPaymentAdmissionRetryError` (503), `TerminalBusyError` con `requestId` correlacionado, `OrderAlreadyPaidError` con `details` |
| `src/services/shared/orderCancelGuard.ts` (**nuevo**, 168 líneas) | C.6: `lockAndReadOrderForCancel`, `assertNoLiveTerminalCharge`, `assertOrderCancellableUnderLock`, `findLiveTerminalCharge`, `avisarOrdenCancelada` |
| `src/services/mobile/order.mobile.service.ts` | `cancelOrder` bajo el guard; `mergeOrders` con candado de las DOS órdenes en una sentencia + guard del ORIGEN; `createOrderWithItems` declarada EXENTA |
| `src/services/dashboard/order.dashboard.service.ts` | `deleteOrder` y el PUT (`updateOrder` → CANCELLED/DELETED) por el guard, dentro de una transacción; `version: {increment:1}`; `onOrderCancelled` + aviso por socket post-commit |
| `src/services/tpv/order.tpv.service.ts` | `voidItems` con candado al inicio, relectura bajo candado, `anulacionExigeOrdenSinCobroVivo` (G2, bloquea TODA anulación con cobro vivo), rechazo `ORDER_VOID_BELOW_PAID` |
| `src/services/mobile/areaTicketV7.mobile.service.ts` | `cancelAreaTicketCheckout` por el guard, jerarquía sesión → tickets → Order |
| `src/services/pos-sync/posSyncOrder.service.ts` | `processPosOrderDeleteEvent` como VERDAD_EXTERNA: candado + 🚨 + `ActivityLog` si había cobro vivo |
| `src/services/delivery-channels/core/cancelDeliveryOrder.service.ts` | Igual, VERDAD_EXTERNA |
| `src/mcp/tools/tables.ts` | `merge_table_check` devuelve `code`/`details` del `AppError` |
| `src/controllers/tpv/order-table.tpv.controller.ts` | `cuerpoDeError()` aditivo con `code`/`details` sólo para `AppError` |
| `src/services/mobile/sync.mobile.service.ts` | `details` en el ACK del intent; `P2028` pasa a TRANSITORIO |
| `prisma/migrations/20260909181000_…cancel_disposition` | `ADD COLUMN cancelDisposition TEXT` |
| `prisma/migrations/20260909213000_…recovery_indexes` | Índice en `TerminalPaymentRequest` + índice de expresión JSON en **`Payment`** |
| `prisma/migrations/20260909223000_…attribution_cursor` | 2 índices en `TerminalPaymentRequest` |
| `prisma/migrations/20260911150000_…delivery_provenance` | `ADD COLUMN IF NOT EXISTS deliveryProvenance JSONB` |

### ÁREA B — Payment-effects outbox (otra sesión; también dinero)

| Archivo | Qué hace |
|---|---|
| `src/services/tpv/paymentEffects.service.ts` (**nuevo**, 210) | Outbox: `enqueuePaymentEffect` (dentro de la tx financiera, con guarda de pertenencia), `claimPaymentEffects` (`FOR UPDATE SKIP LOCKED` + lease + token), `runClaimedPaymentEffect`, `failClaimedPaymentEffect`, `enqueuePaymentCommissionInTx` (SAVEPOINT), `enqueueRefundPaymentEffectsInTx` |
| `src/services/tpv/paymentEffectsRead.service.ts` (**nuevo**, 64) | Lectura paginada por cursor, `lastError` saneado |
| `src/jobs/payment-effects.job.ts` (**nuevo**, 73) | Barrido cada 30 s (`'16,46 * * * * *'`), latch `running`, lote de 25 |
| `src/mcp/tools/paymentEffects.ts` (**nuevo**) | `list_payment_effects` (`payments:read`) |
| `src/services/tpv/payment.tpv.service.ts` (1 438) | Retira los efectos post-commit síncronos (comisión, referido) y los encola dentro de la transacción (`enqueueCommittedPaymentEffects`, `:481-508`); `expectsSettlement` congelado (`:2609-2624`) |
| `src/services/tpv/refund.tpv.service.ts` | `enqueueRefundPaymentEffectsInTx` dentro de la tx del reembolso (`:984`) |
| `src/services/tpv/digitalReceipt.tpv.service.ts` (293) | `generateDigitalReceipt` envuelto en transacción con `Payment FOR UPDATE` + reuso del recibo más antiguo (idempotencia real) |
| `src/services/dashboard/commission/*` (5 archivos, ~490) | Todo acepta `db` (tx); `freezePaymentCommissionInTx` / `applyFrozenCommissionInTx`; `committedAndPendingCommissionProgress`; `alreadyCommissionedItemBase(..., includePending)`; corrección de `calculateFinalRate` (meta-como-nivel ya se paga) |
| `prisma/migrations/20260909210000_payment_effects_outbox` + `20260909220000_payment_effect_lookup_indexes` | Tabla `PaymentEffect` + 2 índices |
| `prisma/schema.prisma` | `PaymentEffect`, `cancelDisposition`, `deliveryProvenance`, 3 índices, comentarios de `TIMED_OUT`/`terminalReturnedAt`; back-relations en Venue/Order/Payment |

### ÁREA C — Otras features de otras sesiones

| Archivo | Qué hace |
|---|---|
| `src/services/referrals/referralReversalPolicy.service.ts` (**nuevo**) | `isOrderFullyReversed(orderId, venueId, db)` extraída, ahora acepta `tx` |
| `src/services/referrals/referralQualification.service.ts` | `onOrderPaid` toma `Order FOR UPDATE` y anula PENDING si la orden ya está revertida |
| `src/services/referrals/referralRefund.service.ts` | Pre-comprobación barata ampliada a PENDING; `revertQualifiedReferral` exportada, con lock y re-chequeo dentro de la tx |
| `src/jobs/loyalty-reconciliation.job.ts` | La base de puntos pasa a `total − tipAmount` |
| `src/jobs/jobSchedules.ts`, `src/server.ts`, `src/mcp/server.ts` | Registro del job y del tool nuevos |
| `prisma/seed.ts` | `status: 'CLOSED'` en un turno histórico (exigido por el CHECK de la migración `20260906010000`) |
| Tests | 9 archivos de integración nuevos (`terminalPaymentRecovery` 1 802 líneas, `orderCancelRoutes` 870, 5 de payment-effects, `money-watchdog-legacy`), 3 unitarios de arquitectura/sockets nuevos, y ~35 suites actualizadas |

---

## 2. Respuestas a los puntos verificados expresamente

**(a) `deliveryProvenance` antes de emitir, en los dos protocolos — ✅ CORRECTO.**
`terminal-payment.service.ts:1015-1045`: `entregar()` hace `await this.recordDelivery(...)` y **sólo si devuelve `true`** emite, tanto en el camino `legacy` (`:1036`) como en el durable (`:1041`). Si no se graba: `failUndelivered(..., 'DELIVERY_NOT_RECORDED')` y se responde `timeout` (nunca un rechazo). `recordDelivery` (`:1153-1183`) hace el append en jsonb con `$executeRaw` atómico y **nunca lanza** (devuelve `false`). El replay usa el mismo helper (`:1288-1290`) antes de su emit.

**(b) `replayPendingForTerminal` — ✅ CORRECTO.**
`:1279-1286`: procedencia `null` ⇒ `UNKNOWN_PROVENANCE`; alguna entrega `LEGACY` ⇒ `LEGACY_DELIVERY`; en ambos casos `auditReplaySkip` y `continue`. El ACK del replay se ejecuta de verdad: `:1303` `void this.registrarAckDeReplay(...).catch(...)` — método `async` (corre al llamarlo) con `.catch`, no un `prisma.x()` perezoso. `registrarAckDeReplay` (`:1193`) sólo confirma filas `PENDING`, así que un ACK tardío no revive una fila cerrada ni renueva una SENT.

**(c) La sonda — ✅ CORRECTO y conservador.**
`:2652-2662`: el `updateMany` lleva `acknowledgedAt: null, lastDeliveredAt: null, deliveryProvenance: { equals: { deliveries: [] } }, ...SIN_DESENLACE_ACREDITADO` — la condición «nunca entregada» va **dentro** del UPDATE. `null` ⇒ `NOT_FOUND_UNKNOWN_PROVENANCE` y con entregas ⇒ `NOT_FOUND_AFTER_DELIVERY`: se conserva la reserva y se audita **una vez** (`debeAuditar`, `:1123-1134`, memoria de proceso + consulta a `ActivityLog`) con backoff de re-sondeo de 15 min (`marcarEsperaDeSonda`). Un `acknowledgedAt` presente o una fila EN VUELO ⇒ contradicción 🚨, también auditada una vez (`:2598-2622`).

**(d) Lista blanca C.1 — ⚠️ NO IMPLEMENTADA; y sí, las filas históricas bloquean.** Ver **P1-1**.
Lo que hoy bloquea la terminal y la orden es `UNRESOLVED_FINANCIAL_OUTCOME` (`:230-236`): `PENDING|SENT|CANCEL_REQUESTED|UNKNOWN|TIMED_OUT` (**todo TIMED_OUT, sin mirar `failureCode`**) · `FAILED` con `ACK_TIMEOUT|ACK_REJECTED|TPV_ERROR` · `CANCELLED` con `cancelDisposition ≠ 'ACCEPTED'` (y la columna nace NULL). No existen `outcome`/`outcomeEvidence`/`evidenceClass`/`reconciliationRequired` en la respuesta, ni `desenlaceCanonico()`, ni flag por venue.

**(e) `cancelDisposition` en el GET.**
`getPaymentStatus` (`:1698`) lo devuelve **crudo**; `status` se traduce a `UNKNOWN` sólo por `hasUnprovenLegacyOutcome` (`:346-355`). Combinaciones reales:
- `null` — mientras nadie contestó la disposición (toda fila histórica, y todo APK sin `terminalPaymentCancelDispositionVersion`).
- `ACCEPTED` — lo escribe `handleCancelDispositionFromSocket` (`:2423`) y también `closeRow` cuando el resultado es `cancelled` **con** evidencia (`:1426`).
- `ACTIVE` — lo escribe la disposición; **nunca se limpia**.
- `ALREADY_RESOLVED` — **nunca llega a la columna**: `:2415` `if (event.disposition === 'ALREADY_RESOLVED' || !SLOT_HELD.includes(row.status)) return true` sale ANTES del `updateMany`. Un cliente que espere ese valor en el GET no lo verá jamás.
- Un `CANCELLED` final con evidencia **sí** sigue devolviendo `ACCEPTED` (correcto, es lo que pide I.3).
- 🔴 Un `FAILED` con `PROCESSOR_DECLINED` **después** de un cancel `ACTIVE` devuelve `status: FAILED` + `cancelDisposition: 'ACTIVE'` (ver **P2-1**).

**(f) Lápida de admisión (H.5/H.6) — ✅ APLICADA.**
`:712-748` `rechazar()` crea la fila dentro de la MISMA transacción (`status FAILED`, `failureCode REJECTED_…`, `expiresAt: new Date()`, `deliveryProvenance: {deliveries: []}`, `resultJson` con `httpStatus`/`code`/`message`/`details`) y **devuelve** el rechazo; se lanza **después del commit** (`:918`) y **nada se emite** (el emit vive sólo en la rama `'creada'`). Motivos cubiertos (`:474-482`, `MotivoDeRechazo`): `REJECTED_TERMINAL_NOT_CONNECTED` (404), `REJECTED_TERMINAL_NO_SOCKET` (422), `REJECTED_TERMINAL_OTHER_VENUE` (403), `REJECTED_TERMINAL_BUSY` / `REJECTED_ORDER_BUSY` (409), `REJECTED_ORDER_CANCELLED` (400), `REJECTED_ORDER_PAID` (409), `REJECTED_ORDER_NOT_FOUND` (400). Sin `requestId` del cliente no hay lápida (`:714`, declarado). La réplica reproduce el mismo error con `errorDeLapida` (`:518-578`) y el GET la devuelve `FAILED` con su `failureCode` (no se traduce a UNKNOWN, `:1697`). Ninguna lápida entra en `UNRESOLVED_FINANCIAL_OUTCOME` ni en `SIN_DESENLACE_ACREDITADO`, así que no ocupa ranura ni bloquea la orden. La contención de transacción sale como `TerminalPaymentAdmissionRetryError` 503 (`:874`, `:890`), nunca como «no se creó».

**(g) C.6 — inventario completo de escritores de cancelación/anulación de orden**

| Sitio | Pasa por la guarda | Evidencia |
|---|---|---|
| `services/mobile/order.mobile.service.ts:3249` `cancelOrder` | ✅ `assertOrderCancellableUnderLock` | `:3249` |
| `services/dashboard/order.dashboard.service.ts:623` `deleteOrder` | ✅ `assertOrderCancellableUnderLock` + `contarPagosRegistrados` | `:623-636` |
| `services/dashboard/order.dashboard.service.ts` `updateOrder` (PUT con CANCELLED/DELETED) | ✅ sólo si `status !== currentOrder.status` (ver **P3-1**) | `:527`, `:562` |
| `services/mobile/order.mobile.service.ts:1884` `mergeOrders` | ✅ candado de las dos órdenes `ORDER BY id FOR UPDATE` + `assertNoLiveTerminalCharge` del ORIGEN (el destino no, decisión G3) | `:1897`, `:1937` |
| `services/tpv/order.tpv.service.ts:2813` `voidItems` | ✅ `lockAndReadOrderForCancel` + `assertNoLiveTerminalCharge` (G2: **toda** anulación) | `:2813`, `:2827-2836` |
| `services/mobile/areaTicketV7.mobile.service.ts:1769` `cancelAreaTicketCheckout` | ✅ `assertOrderCancellableUnderLock` | `:1769` |
| `services/pos-sync/posSyncOrder.service.ts:561` `processPosOrderDeleteEvent` | ⚠️ VERDAD_EXTERNA: no rechaza; candado + 🚨 + `ActivityLog` | `:555-598` |
| `services/delivery-channels/core/cancelDeliveryOrder.service.ts:54` | ⚠️ VERDAD_EXTERNA igual | `:52-90` |
| `services/mobile/order.mobile.service.ts:1044` `createOrderWithItems` (limpieza de promoción fallida) | ⚠️ EXENTA declarada («EXENTA de §C.6», `:1040`) | — |
| `mcp/tools/tables.ts` `merge_table_check` | ✅ entra por `mergeOrders`; sólo traduce `code`/`details` | `:461-467` |
| `controllers/tpv/order-table.tpv.controller.ts` `cancelOrder`/`mergeOrders` | ✅ entran por los servicios de arriba | `:197`, `:151` (vía `cuerpoDeError`, `:54-66`) |
| **`jobs/abandoned-orders-cleanup.job.ts:124`** | 🔴 **NO** — `prisma.order.deleteMany` (borrado DURO) y fuera del inventario | ver **P2-2** |
| `services/dashboard/venue.dashboard.service.ts:448`, `services/cleanup/liveDemoCleanup.service.ts:308`, `services/onboarding/demoCleanup.service.ts:140` | 🔴 NO — `order.deleteMany` de borrado de venue/demo, fuera del inventario | ver **P2-2** |

**(h) Auto-release por reloj — ✅ RETIRADO.**
No hay ningún escritor de `AUTO_RELEASED` ni de `MANUAL_RELEASE` en `src/` (`grep`: sólo la constante `RELEASE_FAILURE_CODES:183`). `reconcileUnknownRequests` tiene `const released = 0` (`:1933`, variable muerta que sigue en el resumen devuelto) y `releaseUnknownRequest` termina en «Release awaits execution confirmation» sin liberar (`:2120-2124`). **Lo que queda VIVO del barrido de liberados** es la ventana de 30 min (`RELEASED_LATE_RECONCILE_WINDOW_MS:182` + `:1993-2055`): sigue buscando `TIMED_OUT` con `failureCode in ('AUTO_RELEASED','MANUAL_RELEASE')` y `updatedAt` ≥ ahora−30 min. En el árbol **nadie escribe esos códigos**, así que sólo puede alcanzar filas que producción (HEAD `d26bb746`) escribió en los 30 minutos previos al despliegue; pasada esa ventana esas filas ya no se vigilan. Ver **P2-3**.

**(i) `void prisma.` / promesas sin manejar en el diff.** Todos los `void logAction(...)` son seguros (`activity-log.service.ts:35` nunca lanza). Los `void this.<método async>(...)` sí se ejecutan (no son consultas perezosas). Quedan dos sitios sin `.catch`: `:1076` `void this.markDelivered(...)` (ver **P2-4**) y `:1323` `void this.closeRow(...).then(...)` (ver **P3-2**).

**(j) Migraciones.** Todas aditivas, **cero `DROP`**, ninguna toca datos. Sólo `20260911150000` es idempotente (`IF NOT EXISTS`); las demás son `CREATE`/`ADD COLUMN` de una sola pasada, que es el patrón normal de Prisma. `ADD COLUMN … TEXT/JSONB` sin default es metadata-only en PG ≥ 11 ⇒ sin lock largo. `docs/SCHEMA_MAP.md` **sí** está regenerado (2 apariciones de `PaymentEffect`) y `scripts/generate-schema-map.ts:327` ya tiene su entrada `MODEL_TO_DOMAIN`. 🔴 El riesgo de lock está en **`CREATE INDEX` sin `CONCURRENTLY` sobre `Payment`** (ver **P2-5**).

---

## 3. Hallazgos

### P1 — dinero, pérdida de datos o bloqueo sin salida

#### P1-1 · Al desplegar, el predicado nuevo reserva TODAS las terminales de Testarudo y Amaena — y no hay flag ni palanca

`src/services/terminal-payment.service.ts:228-236`:

```ts
// Historical transport failures and releases never established a financial result.
// This predicate protects the sale even when a legacy release freed its terminal.
const UNRESOLVED_FINANCIAL_OUTCOME: Prisma.TerminalPaymentRequestWhereInput = {
  OR: [
    { status: { in: [...SLOT_HELD, TerminalPaymentRequestStatus.TIMED_OUT] } },
    { status: TerminalPaymentRequestStatus.FAILED, failureCode: { in: ['ACK_TIMEOUT', 'ACK_REJECTED', 'TPV_ERROR'] } },
    { status: TerminalPaymentRequestStatus.CANCELLED, OR: [{ cancelDisposition: null }, { cancelDisposition: { not: 'ACCEPTED' } }] },
  ],
}
```

**Contraste medido contra producción:** `git show HEAD:src/services/terminal-payment.service.ts` sólo bloquea `SLOT_HELD` (`HEAD:280`, `HEAD:289`, `HEAD:416`, `HEAD:1525` — `status: { in: SLOT_HELD }`, es decir PENDING/SENT/CANCEL_REQUESTED/UNKNOWN). El árbol añade tres clases enteras de filas históricas. La migración `20260909181000` crea `cancelDisposition` **en NULL**, así que **toda** fila `CANCELLED` de producción cae en la tercera rama desde el primer minuto.

**Escenario concreto:** se despliega el servidor. `sendPaymentToTerminal` → `:766-777` encuentra `terminalBlocker` (una de las 305 filas históricas de la PAX `2841653112`, o las 53 de `n860w173400`, o las 12 de `n860w173570` que el relevo §2-ter midió el 11-sep) → **lápida `REJECTED_TERMINAL_BUSY` + 409** para todo cobro nuevo. Y `assertNoLiveTerminalCharge` (`orderCancelGuard.ts:82-94`) bloquea además cancelar/anular/fusionar cualquier orden que tenga una de esas filas. `releaseUnknownRequest` **no libera** (`:2123`) y la sonda sólo alcanza filas con procedencia `[]` — las históricas tienen `null`. **Queda sin salida de producto: ni cobrar, ni cancelar, ni liberar.**

**Qué pide el diseño y no está:** I.6 §1 exige «el **predicado estricto detrás de un flag POR VENUE, apagado**: nada nuevo bloquea», y I.3 exige que `AUTO_RELEASED`, `MANUAL_RELEASE` y `MANUAL_RECONCILE` entren a la lista blanca como UNRESOLVED **de forma explícita**, no por barrer todo `TIMED_OUT`. `grep -rn "strictOutcome|predicadoEstricto|TERMINAL_STRICT"` ⇒ **0 resultados**: el flag no existe.

**Por qué las pruebas no lo cazan:** `terminalPaymentRecovery.integration.test.ts:658` («released terminal does not permit reauthorizing its financially unresolved order») **afirma justamente el comportamiento nuevo** — es correcto como prueba de la regla, pero no hay ninguna que ejercite el árbol contra el CENSO histórico de producción, y no puede haberla: eso es una comprobación de datos (la consulta de inventario del relevo §2-ter), no un test.

---

#### P1-2 · `INVALID_COMMISSION_SNAPSHOT`: un efecto DEAD_LETTER sigue reservando base de comisión y además genera su reversa negativa

`src/services/dashboard/commission/commission-utils.ts:803-810` y `:820-838`:

```sql
SELECT COALESCE(SUM((payload->>'baseAmount')::numeric - COALESCE((payload->>'tipAmount')::numeric, 0)), 0) AS base
FROM "PaymentEffect" WHERE "orderId" = ${orderId} AND kind = 'COMMISSION'
  AND status IN ('PENDING', 'PROCESSING', 'DEAD_LETTER') AND payload->>'configId' = ${configId}
```

y `src/services/dashboard/commission/commission-calculation.service.ts:360-364`:

```ts
const pending = await db.paymentEffect.findMany({ where: { venueId: refundPayment.venueId, paymentId: originalPaymentId, kind: 'COMMISSION', status: { in: ['PENDING', 'PROCESSING', 'DEAD_LETTER'] } })
for (const effect of pending) {
  const data = effect.payload as unknown as (typeof originalCalcs)[number]
  if (data.configId && data.staffId && !originalCalcs.some(c => c.configId === data.configId && c.staffId === data.staffId)) originalCalcs.push(data)
}
```

**Escenario:** una comisión congelada llega a `DEAD_LETTER` (6 intentos agotados: `paymentEffects.service.ts:18` `MAX_ATTEMPTS = 6`, y `applyFrozenCommissionInTx` lanza `INVALID_COMMISSION_SNAPSHOT` si el payload no cuadra, `commission-calculation.service.ts:1305-1313`). La `CommissionCalculation` positiva **nunca se crea**. Después se reembolsa la venta: `createRefundCommission` mete ese payload en `originalCalcs` y **crea la reversa NEGATIVA** (que sí se aplica, por su propio efecto). El vendedor termina con una comisión negativa por dinero que nunca se le acreditó. En paralelo, `alreadyCommissionedItemBase` sigue restando esa base para siempre, así que ningún cobro posterior de la misma orden puede comisionar ese tramo.

Incluir `DEAD_LETTER` en la reserva de base es la decisión conservadora correcta y está comentada («Dead letters still reserve their obligation»); lo que falta es **no fabricar la reversa de una obligación que nunca se cumplió**, o bien un camino de recuperación del DEAD_LETTER. `list_payment_effects` sólo LEE (`mcp/tools/paymentEffects.ts:12`, «No reintenta trabajos»): no hay reintento manual en ningún lado.

**Por qué las pruebas no lo cazan:** `paymentEffectsOutbox.integration.test.ts:345` («preserves the public manual-review reason from enqueue through exhausted retries») llega hasta el DEAD_LETTER pero no reembolsa después; `paymentEffectsReview.integration.test.ts:197` («refund before commission delivery reverses the frozen original once») usa un efecto **PENDING**, no DEAD_LETTER — que es el caso sano.

---

### P2 — defecto real sin dinero directo (o dinero en un borde acotado)

#### P2-1 · Un rechazo del banco después de un cancel `ACTIVE` deja `cancelDisposition: 'ACTIVE'` para siempre

`src/services/terminal-payment.service.ts:1419-1427`:

```ts
const newStatus = resultToStatus(result.status)
const data: Prisma.TerminalPaymentRequestUpdateManyMutationInput = {
  status: newStatus,
  paymentId: result.paymentId ?? undefined,
  resultJson: result as unknown as Prisma.InputJsonValue,
  failureCode: result.status === 'failed' ? 'TPV_CONFIRMED_NO_CHARGE' : null,
  ...(result.status === 'cancelled' ? { cancelDisposition: 'ACCEPTED' } : {}),
}
```

**Escenario:** el cajero cancela desde la tablet → la terminal contesta `ACTIVE` (no pudo acreditar una cancelación segura) → `handleCancelDispositionFromSocket:2423` escribe `cancelDisposition = 'ACTIVE'`. Después el banco declina y la terminal emite `failed + PROCESSOR_DECLINED` → `closeRow` deja `status FAILED`, `failureCode TPV_CONFIRMED_NO_CHARGE` y **no toca `cancelDisposition`**. `hasUnprovenLegacyOutcome:346-355` no cubre ese `failureCode`, así que el GET (`:1690-1699`) devuelve `status: 'FAILED'` + `cancelDisposition: 'ACTIVE'`: la cancelación durable del POS del árbol (C.4, que lee `ACTIVE` como «sigue activo») no cierra nunca. Es literalmente lo que el diseño C.1 declara como el motivo de la proyección («hoy una fila rechazada por el banco tras un cancel ACTIVE deja a las apps del árbol en «sigue activo» para siempre») y la regla de I.3 («`null` sólo sustituye a `ACTIVE` cuando el desenlace ya es final por otra vía») **no está implementada**.

**Por qué las pruebas no lo cazan:** no hay ninguna que combine disposición `ACTIVE` seguida de un cierre final; `terminalPaymentRecovery.integration.test.ts:879` y `:900` prueban cada rama por separado y ninguna vuelve a leer `cancelDisposition` después del cierre.

#### P2-2 · `deleteMany` de órdenes queda FUERA del inventario de §C.6 — y una de las rutas borra en DURO

`tests/unit/architecture/orderCancelWriters.test.ts:26`:

```ts
const ESCRITURA_DE_ORDEN = /\.order\s*\.\s*update(?:Many)?\s*\(/
```

El detector sólo ve `update`/`updateMany`. `src/jobs/abandoned-orders-cleanup.job.ts:124` hace `prisma.order.deleteMany(...)` cada 15 min (`:28`) sobre órdenes `type TAKEOUT`, `status PENDING`, `paymentStatus PENDING`, **0 artículos** y más de 30 min de antigüedad (`:27`). `TerminalPaymentRequest.orderId` es una referencia SUAVE (sin FK, `prisma/schema.prisma:5043`): una fila `UNKNOWN` sobre una orden vacía de más de 30 min queda apuntando a una orden que ya no existe, y `findReconcilablePayment:1831` filtra `orderId` ⇒ ese cobro ya no puede conciliarse nunca por ese camino. Igual quedan fuera `services/dashboard/venue.dashboard.service.ts:448`, `services/cleanup/liveDemoCleanup.service.ts:308` y `services/onboarding/demoCleanup.service.ts:140`.

Además, el atribuidor de función del test (`:26-37`, `INICIO_DE_FUNCION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/`) sólo reconoce funciones declaradas a nivel de módulo: un escritor futuro dentro de un método de clase o de una arrow function se atribuiría a la función `function` más cercana por arriba, y su «cuerpo» incluiría ese rango entero ⇒ un marcador presente en OTRA función del mismo tramo satisfaría el `expect`. Hoy los 9 escritores inventariados son `export async function`, así que el test funciona; el riesgo es futuro.

#### P2-3 · La vigilancia de dinero tardío sobre filas liberadas quedó sin escritor y con ventana de 30 min

`src/services/terminal-payment.service.ts:180-183`:

```ts
const RELEASED_LATE_RECONCILE_WINDOW_MS = 30 * 60_000
const RELEASE_FAILURE_CODES = ['AUTO_RELEASED', 'MANUAL_RELEASE']
```

`:1993-2013` sigue barriendo `status TIMED_OUT` + `failureCode in RELEASE_FAILURE_CODES` + `updatedAt >= ahora − 30 min`, y es el único sitio que emite el 🚨 de doble cobro («Payment recorded for a RELEASED request», `:2022`). En el árbol **nadie escribe esos códigos** (confirmado por `grep`), así que: (a) es código muerto de aquí en adelante; (b) las filas que producción ya liberó por tiempo sólo se vigilarían si el dinero llegara dentro de los 30 min posteriores al despliegue. Es exactamente el pendiente I.2 («la vigilancia de dinero tardío de 72 h necesita un escritor vivo»). Y `const released = 0` (`:1933`) sigue viajando en el resumen devuelto y en el log (`:2058-2066`) como si fuera una métrica.

#### P2-4 · `void this.markDelivered(...)` sin `.catch` puede tumbar el proceso entero

`src/services/terminal-payment.service.ts:1076`:

```ts
            if (persisted) void this.markDelivered(requestId, venueId)
            logger.info(`📡 [TerminalPayment] Durable ACK received from socket ${socketId}`, { requestId, terminalId })
```

`markDelivered` (`:1208-1221`) es un `updateMany` sin guardia. Un `P2024` (pool agotado en una tormenta de reconexiones) produce un `unhandledRejection`, y `src/server.ts:326-355` convierte **todo** `unhandledRejection` en `gracefulShutdown` a propósito: un fallo transitorio del pool al confirmar un ACK apaga el servidor a media venta. El árbol arregló esta misma clase en los dos sitios hermanos y lo dejó escrito (`:1300-1303`, «`.catch` evita un rechazo sin manejar, que `server.ts` convierte en gracefulShutdown»; y `socketManager.ts:228-236`), pero éste quedó igual que en `HEAD:529`. **Preexistente, no introducido** — pero está dentro de un bloque reescrito en este diff y el criterio ya estaba explícito.

#### P2-5 · `CREATE INDEX` sin `CONCURRENTLY` sobre `Payment` bloquea las escrituras de pagos durante el despliegue

`prisma/migrations/20260909213000_terminal_payment_recovery_indexes/migration.sql`:

```sql
-- Prisma cannot express this JSON field index in its model. It supports exact,
-- tenant-scoped request recovery; time/amount similarity never proves identity.
CREATE INDEX "Payment_terminal_request_recovery_idx"
ON "Payment" ("venueId", ("processorData" #> '{terminalPaymentRequestId}'), "createdAt" DESC, "id" DESC);
```

`CREATE INDEX` no concurrente toma un `SHARE` sobre la tabla: **bloquea todo INSERT/UPDATE/DELETE de `Payment`** mientras se construye. `Payment` es la tabla de dinero más grande del sistema; en producción eso significa cobros rechazados o colgados durante la migración. Los tres índices de `TerminalPaymentRequest` (esta misma migración y `20260909223000`) tienen el mismo patrón pero sobre una tabla chica. `CONCURRENTLY` no puede correr dentro de la transacción de `prisma migrate`, así que la salida es aplicarlo a mano fuera de la migración o en ventana de baja actividad — **no lo pude medir**: no consulté producción (sólo lectura, y el brief prohíbe tocar la base).

#### P2-6 · `REFERRAL_AWAITS_SETTLEMENT`: un referido cuya liquidación tarda más de ~16 min se pierde en silencio

`src/services/tpv/paymentEffects.service.ts:94-101`:

```ts
    } else {
      const paid = await db.order.findFirst({
        where: { id: external.orderId ?? '', venueId: external.venueId, paymentStatus: 'PAID' },
        select: { id: true },
      })
      if (!paid) throw new Error('REFERRAL_AWAITS_SETTLEMENT')
      const { onOrderPaid } = await import('../referrals/referralQualification.service')
      await onOrderPaid({ orderId: paid.id, venueId: external.venueId })
```

El efecto REFERRAL se encola con `expectsSettlement` congelado dentro de la transacción (`payment.tpv.service.ts:2609-2624`), precisamente porque «SR and area-ticket flows retain their settlement owner» y liquidan DESPUÉS. Pero el backoff es `30_000 * 2 ** (attempts-1)` con `MAX_ATTEMPTS = 6` (`paymentEffects.service.ts:18`, `:163`): 30 s + 60 + 120 + 240 + 480 ≈ **15,5 minutos**, y entonces `DEAD_LETTER`. Si la liquidación de vales o de SR tarda más, el referido no califica nunca y no hay reintento manual. El único rastro es un DEAD_LETTER con `lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED'`, que no dice que era un referido esperando su liquidación.

#### P2-7 · El recibo digital síncrono pasa a depender de una transacción con timeout por defecto (5 s) y un `Payment FOR UPDATE`

`src/services/tpv/digitalReceipt.tpv.service.ts:92-99`:

```ts
    return await prisma.$transaction(async tx => {
      // Serialize every creation/replay for this payment. Historical duplicate
      // receipts remain valid; new callers consistently reuse the oldest one.
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`
      const existing = await tx.digitalReceipt.findFirst({
        where: { paymentId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (existing) return existing
```

La idempotencia real es una mejora clara. El precio es que ahora hay una transacción interactiva **sin opciones** (`grep -n '\$transaction' digitalReceipt.tpv.service.ts` ⇒ sólo `:92`), es decir con el `timeout: 5000` / `maxWait: 2000` por defecto de Prisma, en el camino SÍNCRONO de cada cobro (`payment.tpv.service.ts:2868` y `:4157`) y con un `FOR UPDATE` sobre el `Payment`. Bajo presión de pool, un `P2028` hace que el `catch` de arriba («Don't fail the payment if receipt generation fails») devuelva `digitalReceipt: null` — exactamente la condición que el propio `ensureDigitalReceiptResponse` documenta como causa del incidente Testarudo del 23-jun (2 781 reintentos del mismo cobro por una NPE en `FastPaymentRecorder.kt`). El efecto RECEIPT del outbox lo repara después, pero **no repara la respuesta**. Las demás transacciones nuevas de este diff sí fijan `{ timeout: 15_000, maxWait: 5_000 }` (`order.mobile.service.ts:1980` y `:3260`, `order.dashboard.service.ts:573` y `:638`, `order.tpv.service.ts:2962`, `areaTicketV7:1798`, `posSyncOrder:574`).

#### P2-8 · La comisión ahora se congela DENTRO de la transacción del dinero y añade `FOR UPDATE` sobre `StaffVenue`

`src/services/dashboard/commission/commission-calculation.service.ts:247-259`:

```ts
    if (payment.orderId) await db.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${payment.orderId} AND "venueId" = ${payment.venueId} FOR UPDATE`)
    const recipients = [ ... ].sort()
    if (recipients.length)
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM "StaffVenue" WHERE "venueId" = ${payment.venueId} AND "staffId" IN (${Prisma.join(recipients)}) ORDER BY "staffId" FOR UPDATE`,
      )
```

Es un candado NUEVO, ordenado por `staffId`, tomado **dentro** de la transacción del cobro (vía `enqueuePaymentCommissionInTx`, `paymentEffects.service.ts:173-198`), que ya sostiene `Order` y el turno. `StaffVenue` es una tabla grande y muy escrita. No encontré en el diff ningún análisis del orden global de candados frente a otras rutas que toquen `StaffVenue` y luego `Order` (asistencia, horarios, invitaciones), así que **no puedo descartar un ciclo**. El SAVEPOINT (`:177-196`) sí recupera de un 40P01, y `P2034` es transitorio en la cola offline (`sync.mobile.service.ts:110`), así que el peor caso conocido es latencia y reintentos — pero conviene confirmarlo con un canario, no por lectura.

#### P2-9 · `ALREADY_RESOLVED` nunca se persiste: el contrato que las apps del árbol esperan no puede observarse por GET

`src/services/terminal-payment.service.ts:2413-2416`:

```ts
    // A late/repeated cancellation cannot overwrite a financial result. The
    // terminal replays its actual result separately for ALREADY_RESOLVED.
    if (event.disposition === 'ALREADY_RESOLVED' || !SLOT_HELD.includes(row.status)) return true
    const accepted = event.disposition === 'ACCEPTED'
```

El `return true` sale antes del `updateMany`, así que la columna `cancelDisposition` sólo puede valer `null`, `'ACTIVE'` o `'ACCEPTED'`. La regla del circuito describe `ALREADY_RESOLVED` como una de las tres disposiciones del contrato y C.2 la lista en `cancelIntent`; si un cliente del árbol la busca en el GET, lee `null` y no puede distinguir «la terminal ya lo tenía resuelto» de «nadie contestó». El comentario justifica no PISAR el resultado (correcto), pero no justifica no REGISTRAR la disposición.

#### P2-10 · C.2 (POST cancel) no está: el POST sigue devolviendo sólo `success`/`message`

`src/controllers/mobile/terminal-payment.mobile.controller.ts:448-451`:

```ts
    return res.json({
      success: cancelled,
      message: cancelled ? 'Cancelación enviada a la terminal' : 'Terminal no conectada',
    })
```

Faltan `requestId`, `cancelIntent`, `cancelEmitted` y `payment` que pide C.2. Consecuencia concreta: `cancelPayment` devuelve `false` tanto cuando **no había fila que cancelar** (`:2374` `if (intent.count === 0) return false`) como cuando la terminal no está conectada — y el cuerpo dice «Terminal no conectada» en los dos casos. Un POS que reintente el cancel con el mismo `requestId` (C.4 lo hace mientras el GET diga PENDING/SENT/CANCEL_REQUESTED) recibe un mensaje que miente sobre por qué falló.

---

### P3 — calidad

- **P3-1 · `updateOrder` decide `cancelando` con una lectura fuera del candado.** `src/services/dashboard/order.dashboard.service.ts:527`: `const cancelando = (status === 'CANCELLED' || status === 'DELETED') && status !== currentOrder.status`. `currentOrder` se leyó antes de la transacción; si otra sesión canceló y luego un PUT trae `status:'CANCELLED'` con un `currentOrder` rancio que ya decía CANCELLED, el `escribir(prisma)` corre **sin** guarda. Hoy es un no-op semántico (escribe el mismo estado), pero la decisión de tomar la guarda no debería depender de una lectura sucia.
- **P3-2 · `void this.closeRow(...).then(...)` sin `.catch`** (`terminal-payment.service.ts:1323`). Hoy `closeRow` no puede rechazar (todos sus tramos riesgosos están en `try/catch` y `resultToStatus:383` tiene `default`), pero si alguien añade un `throw` el `unhandledRejection` apaga el proceso **y** el long-poll nunca resuelve.
- **P3-3 · Un resultado degradado borra el diagnóstico previo.** `:1424` `failureCode: result.status === 'failed' ? 'TPV_CONFIRMED_NO_CHARGE' : null`: un `cancelled`/`failed` SIN evidencia se degrada a `timeout` (`:1386-1391`) y la rama `late` (`:1438-1448`, que usa `SIN_DESENLACE_ACREDITADO`) reescribe la fila UNKNOWN poniendo `failureCode: null` y sustituyendo el `resultJson` por el envoltorio genérico. Se pierde el `ACK_TIMEOUT`/`ACK_REJECTED` anterior y lo que la terminal realmente reportó. El camino de la SONDA sí lo audita (`:2547-2568`); el del socket no.
- **P3-4 · `bloqueadorVisible` congela `ageSeconds` en la lápida.** `:584-596` calcula la antigüedad al escribir; la réplica (`errorDeLapida:542-549`) la devuelve tal cual, así que el cajero lee «hace 0 s» días después. El `requestId` y el monto sí siguen siendo útiles.
- **P3-5 · Comparación LEXICOGRÁFICA de fechas en JSON.** `commission-utils.ts:830` `AND payload->>'calculatedAt' >= ${start.toISOString()}` compara TEXTO. Funciona sólo porque el payload viene de `JSON.parse(JSON.stringify(...))` de un `Date` (siempre `…Z` con milisegundos) y `toISOString()` da el mismo formato; el lado de `CommissionCalculation` sí usa `utcTs()` tipado. Cualquier futuro payload con offset (`-06:00`) rompería el filtro **en silencio**.
- **P3-6 · `db !== prisma` como discriminador de política.** `commission-tier.service.ts:474` `if (db !== prisma)` elige si el progreso de nivel incluye las obligaciones pendientes. Un llamador que en el futuro pase `prisma` explícitamente dentro de un contexto de outbox obtendría la rama legacy sin ningún error.
- **P3-7 · `isTerminalBusy` quedó sin llamadores** (`terminal-payment.service.ts:623`; `grep` en `src/` sólo devuelve su definición y la de `getBusyTerminalIds`). Es la única versión acotada por venue del predicado de ocupación, así que dejarla viva invita a usar la semántica equivocada.
- **P3-8 · El mock global de `payment.findFirst` hace imposible que un test unitario ejercite la guarda de pertenencia del outbox.** `tests/__helpers__/setup.ts:471-473`: `prismaMock.payment.findFirst.mockImplementation(async (a) => esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : undefined)` — **devuelve el mismo `orderId` que se le pidió**, así que `if (!source || source.orderId !== input.orderId) throw new Error('PAYMENT_EFFECT_SOURCE_MISMATCH')` (`paymentEffects.service.ts:27`) no puede fallar nunca en unitarios, y un test que afirme «el efecto se encola» pasaría igual si la guarda se borrara. La guarda **sí** está cubierta en integración (`paymentEffectsOutbox.integration.test.ts:116`, «cross-venue source cannot enqueue»), que es lo que lo deja en P3. Riesgo colateral: `esConsultaDelOutbox` (`:5-11`) macheará cualquier `payment.findFirst({where:{id,venueId,status:'COMPLETED'}, select:{orderId:true}})` legítimo de otro servicio y le cambiará la respuesta por defecto en toda la suite unitaria.
- **P3-9 · `revertReferralRewardForOrder` perdió su log de «reembolso parcial».** El bloque borrado en `referralRefund.service.ts` incluía `logger.info('[referral] reversión omitida: la venta calificadora no está revertida en su totalidad (reembolso parcial)', …)`. El comportamiento se conserva (el re-chequeo vive ahora dentro de `revertQualifiedReferral:303`), pero un reembolso parcial sobre una venta con referido ya no deja rastro.
- **P3-10 · Trabajo duplicado en el reembolso.** `refund.tpv.service.ts:984` encola la comisión de reembolso en el outbox y `:1193` sigue llamando `createRefundCommission(...)` post-commit (fire-and-forget); `:1118` llama `onOrderRefunded` y el efecto `referral-refund:…:v1` hace lo mismo. Ambos pares son idempotentes y se serializan por el `Order FOR UPDATE` (`commission-calculation.service.ts:355-356` y `paymentEffects.service.ts:112-113`), así que no duplican — pero se paga dos veces el trabajo y una futura divergencia entre las dos rutas no la cazaría nada.
- **P3-11 · Efecto de política con payload inválido quema 6 intentos.** `enqueuePaymentCommissionInTx:184-191` encola `payload: { policyError: … }`; `applyFrozenCommissionInTx:1305` lanza `INVALID_COMMISSION_SNAPSHOT` porque `data.venueId` es `undefined`. Llega al `DEAD_LETTER` correcto (y `failClaimedPaymentEffect:167` conserva el motivo legible), pero después de 6 reintentos y ~16 min de ruido.
- **P3-12 · `paymentEffectsRead.service.ts` tiene sus `import` al FINAL del archivo** (`:62-64`). Es legal (hoisting), pero rompe la convención y hace que el archivo parezca truncado.
- **P3-13 · La ranura reservada no se describe cuando es de otro venue, pero la LÁPIDA sí se escribe.** `:768-776`: cualquier staff autenticado puede provocar la creación de filas `FAILED/REJECTED_…` en SU venue con `terminalId` arbitrarios (el registro se consulta bajo el candado y `normalizeTerminalId` acepta cualquier cadena), y tomar el `pg_advisory_xact_lock` de la llave de una terminal ajena durante la transacción. Impacto real bajo (filas propias, transacción corta), pero es una superficie nueva.

---

## 4. Lo que está BIEN y vale confirmar

1. **Procedencia antes del emit, sin excepciones.** `terminal-payment.service.ts:1015-1029`: si `recordDelivery` devuelve `false` **no se emite** y la fila se retiene como incierta (`DELIVERY_NOT_RECORDED`), en los dos protocolos. Es la pieza que cierra el «reejecución tras actualizar el APK».
2. **`leerProcedencia` falla hacia lo seguro.** `:216-232`: una sola entrada ilegible convierte TODA la procedencia en `null` (desconocida) en vez de filtrarla — y `null` nunca autoriza liberar ni reentregar. El comentario nombra exactamente por qué.
3. **La liberación por NOT_FOUND es atómica.** `:2652-2662`: `deliveryProvenance: { equals: { deliveries: [] } }` va dentro del `updateMany` junto con `acknowledgedAt: null`, `lastDeliveredAt: null` y `SIN_DESENLACE_ACREDITADO`. Una entrega que se grabe entre la lectura y el UPDATE no puede colarse.
4. **La lápida no ocupa nada.** `FAILED` no está en el índice parcial (`prisma/migrations/20260713161534_add_terminal_payment_request/migration.sql`, `WHERE status IN ('PENDING','SENT','CANCEL_REQUESTED','UNKNOWN')`) ni en los dos predicados de bloqueo (`:230-247`), y `expiresAt: new Date()` la deja vencida al nacer: ni sonda, ni replay, ni vigía.
5. **La contención de transacción NO se contesta como «no se creó».** `:874-895` + `AppError.ts:238-250`: `P2028`/`P2034` salen como 503 `TERMINAL_PAYMENT_ADMISSION_RETRY` («reintenta con el MISMO requestId»), y un choque repetido del índice sin bloqueador visible también (`:885-894`), nunca como 4xx.
6. **La identidad de la terminal ya no se hereda por un `socketId` reciclado.** `terminal-registry.ts:62-64` (dos guardias) + `:141-145` (`getTerminalBySocketId` exige `entry.socketId === socketId`) + `socketManager.ts:189-192` (el `terminalId` del handshake se descarta si contradice el serial FIRMADO del token). Y `socketManager.ts:450` descarta `outcomeEvidence` de una terminal no verificada, que es justo el campo con el que se declara «no se cobró».
7. **`findReconcilablePayment` exige atribución FÍSICA.** `:1846-1859`: `source === 'TPV'` y el serial acreditado (FK `terminal.serialNumber`, o `processorData.deviceSerialNumber`) normalizado tiene que coincidir con el de la fila; además rechaza un `Payment` ya reclamado por otra fila (`:1861-1866`). Es lo que impide cerrar la solicitud de una terminal con el cobro de otra.
8. **La base de lealtad quedó consistente entre los cuatro canales.** `loyalty-reconciliation.job.ts:123` `Math.max(0, Number(order.total) - Number(order.tipAmount ?? 0))` coincide ahora con `payment.tpv.service.ts:1336`, `order.dashboard.service.ts:901` y `customer.dashboard.service.ts:979`, y con el contrato escrito en `loyaltyOnPaidOrder.ts:43-46` («Base de venta y cargos sin propinas»). Era el único que pasaba el total con propina.

---

## 5. Lo que NO pude verificar (y por qué)

1. **El censo real de filas históricas de producción** (las 305 + 53 + 12 del relevo §2-ter). Sólo lectura y sin tocar la base: la afirmación de P1-1 es una deducción del predicado + la migración que crea `cancelDisposition` en NULL, cruzada con lo que el relevo ya midió. **Antes de desplegar hay que volver a contar.**
2. **El tamaño de `Payment` en producción**, que decide la gravedad real de P2-5. No consulté ninguna base.
3. **Nada compilado ni ejecutado**: no corrí `tsc`, ni jest, ni `avq-verify`. Todos los hallazgos son de lectura. En particular no puedo afirmar que el árbol typechea (hay 3 archivos con `MM` en `git status` — cambios encima de cambios ya indexados — y el árbol es compartido).
4. **El lado cliente**: qué hacen exactamente los APK publicados (Android 2.18.x / iOS 1.10.x) y los del árbol con `status: FAILED` + `cancelDisposition: 'ACTIVE'` (P2-1), con un 409 correlacionado repetido sobre una lápida, o con `digitalReceipt: null` (P2-7). Son repos distintos y esta revisión es del servidor.
5. **El orden global de candados** que P2-8 necesita para descartar un deadlock con `StaffVenue`: exige un inventario de todas las rutas que la bloquean, que no hice.
6. **Si las pruebas que cito PASAN.** Leí sus nombres y sus aserciones, no su resultado. La calidad de `terminalPaymentRecovery.integration.test.ts` (57 casos, incluidos los 7 de la lápida `(a)`–`(g)` con `expect(directEmit).not.toHaveBeenCalled()` y la comprobación de que la copia tardía reproduce el MISMO error) y de `orderCancelWriters.test.ts` es notablemente alta; el único defecto de prueba que encontré es P3-8.
7. **`prisma/seed.ts`** y `tests/integration/payments/paymentEffectsTimezone.integration.test.ts` sólo los hojeé.
