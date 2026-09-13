# El webhook como PRIMER confirmador del cobro remoto (AngelPay exacto · Blumon por combinación)

**Estado:** diseño listo, PENDIENTE del OK del founder. Escrito por Fable 5.1 (12-sep-2026) para que lo implemente Opus 5.
**Decisión del founder (12-sep):** «que nuestra principal fuente de verdad sea el webhook, pero que el webhook sea el primer
confirmador y lo demás el respaldo». AngelPay y Blumon le aseguran que SIEMPRE mandan el webhook. Medido en prod (30 días):
AngelPay 489/489 traen `integratorReference`, p50 1.5 s, llegan ANTES de que la terminal registre en 473/473; Blumon 1247/1249.
**Repos:** server · tpv. POS (android/ios) NO cambia: ya espera el cierre de la solicitud.

## Hechos del código que deciden el diseño (verificados el 12-sep)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| El webhook de AngelPay trae `integratorReference` = el `paymentAttemptId` que la TERMINAL inventa (`UUID.randomUUID()`), y el servidor no lo conoce hasta que la terminal registra | `AngelPayPaymentViewModel.kt:755`, `angelpay-webhook.service.ts:34` | Hoy el webhook no se puede atar a la `TerminalPaymentRequest`: queda PENDING y espera el registro de la terminal |
| `TerminalPaymentRequest.requestId` es un UUID generado por el POS y es `@unique` | `schema.prisma` (model TerminalPaymentRequest, línea 3) | Si el intento REMOTO usa `requestId` como `paymentAttemptId`, UNA llave recorre POS → servidor → terminal → AngelPay → webhook → `Payment.idempotencyKey` |
| `Payment` tiene `@@unique([venueId, idempotencyKey])` y el registro de la terminal devuelve el Payment existente ante llave repetida | `schema.prisma:4272`, `payment.tpv.service.ts:2026-2046` | Un Payment nacido del webhook con esa llave vuelve idempotente el registro posterior de la terminal (no hay doble Payment) |
| El fallback de propina (C208) REUSA la misma referencia | `AngelPaySdkGateway.kt:38-60` | Un `NOT_APPROVED` puede ir seguido de un `approved` con la MISMA llave: NOT_APPROVED solo NUNCA libera de inmediato |
| El webhook de Blumon NO trae una llave nuestra (`reference` es de Blumon y «no siempre presente»); el SDK no acepta una referencia nuestra | `blumon-webhook.service.ts:250,278` | Blumon no tiene camino exacto: sólo por combinación (serial físico + única solicitud en vuelo por terminal + monto ≥ pedido + ventana) |
| Un serial VIRTUAL de Blumon identifica la afiliación, no el aparato; `MerchantAccount` no guarda en qué terminal física vive | `blumon-seriales-virtuales.md`, `schema.prisma` (MerchantAccount) | Con serial virtual sólo se confirma si en ese venue hay UNA terminal en vuelo con ese merchant; si no, sigue siendo respaldo |
| No existe un evento servidor → terminal de «cobro confirmado» | `grep terminal:payment_` en `src/` | Hay que crear `terminal:payment_confirmed` para que la libreta pase a REGISTRADO y baje el banner |
| El registro TPV crea el Payment con `processorData.terminalPaymentRequestId` y `closeRowFromPaymentTx` cierra la solicitud | `terminal-payment.service.ts` | Este camino se queda tal cual como RESPALDO; sólo se vuelve idempotente cuando el webhook llegó primero |

## Invariantes (no negociables)

1. **Nunca dos Payments por un cobro.** La llave es `requestId`: webhook y terminal escriben sobre la MISMA `(venueId, idempotencyKey)`.
2. **Nunca liberar por un `NOT_APPROVED` aislado.** Gracia de 120 s sin `approved` de la misma llave y sin Payment; entonces `FAILED/PROCESSOR_DECLINED` (desenlace canónico, ya en la lista blanca) libera VENTA y RANURA.
3. **Un webhook `approved` que contradice una fila CANCELLED/TIMED_OUT/FAILED** cierra a COMPLETED y dispara el 🚨 existente («money moved despite cancel/close/release»). No se inventa otra alarma.
4. **Blumon nunca crea un Payment por combinación con serial virtual ambiguo.** Sólo con serial físico exacto o con una única terminal candidata.
5. **Los APK viejos no cambian de comportamiento**: su `integratorReference` no es el `requestId`, así que el webhook cae al camino de hoy (PENDING + backfill al registrar).
6. **Contrato aditivo**: ningún campo se quita; el evento nuevo lo ignoran los APK que no lo conocen.

## Tareas (TDD: la prueba en rojo primero; sabotajes en copia aislada, nunca en el árbol compartido)

### Servidor (`avoqado-server`)

- **T1 · Resolver la solicitud desde el webhook.** En `angelpay-webhook.service.ts`, cuando `status=approved` y NO hay Payment: buscar `TerminalPaymentRequest` por `requestId = integratorReference` en el venue del `MerchantAccount` del secreto. Pruebas: encuentra la fila; ignora una de otro venue; ignora si `integratorReference` no es un requestId.
- **T2 · Confirmar = crear el Payment + cerrar la fila, en UNA transacción** (`FOR UPDATE` sobre la Order como hace la admisión). Monto = `payload.amount/100`; propina = webhook − `request.amount` si ≥ 0 (si < 0 ⇒ DISCREPANCY, no cerrar); método CARD/UNKNOWN como ya registra AngelPay; `idempotencyKey = requestId`; `processorData` con `terminalPaymentRequestId`, `deviceSerialNumber` = terminal de la fila (no el `terminalSerial` del webhook, que se compara y si difiere ⇒ 🚨 y no cerrar); `shiftId` por `turnoAbiertoDelNegocio`; `merchantAccountId` del secreto. Reusar el registrador que ya usa el camino TPV (`recordOrderPayment` / fast) pasando la llave, NO un `payment.create` nuevo. Luego `closeRowFromPaymentTx` (que ya maneja `reopened` + 🚨). `ProviderEventLog` ⇒ MATCHED vía `'webhook-first'`. Pruebas: cierra SENT; cierra UNKNOWN; cierra TIMED_OUT/AUTO_RELEASED con 🚨; monto menor ⇒ DISCREPANCY sin cerrar; serial distinto ⇒ no cierra; segunda entrega del mismo webhook ⇒ idempotente por `eventId`.
- **T3 · El registro posterior de la terminal es idempotente y ENRIQUECE.** Cuando el registro TPV (order y fast) encuentra el Payment por llave y ese Payment nació del webhook, fusionar lo que sólo la terminal sabe (marca/últimos 4 para Blumon, recibo, `authorizationCode`, `referenceNumber`) sin tocar montos. Pruebas: fast y order; no duplica; no cambia `amount`/`tipAmount`.
- **T4 · `NOT_APPROVED` como evidencia de «no se cobró», con gracia.** Guardar el evento (hoy se marca ERROR y se tira) apuntando a la fila; un barrido (el `reconcileUnknownRequests` de 30 s) libera `FAILED/PROCESSOR_DECLINED` si pasaron 120 s sin `approved` ni Payment para esa llave. Pruebas: rechazo seguido de aprobación en 20 s ⇒ COMPLETED; rechazo solo ⇒ FAILED a los 120 s; nunca antes.
- **T5 · Avisar a la terminal.** Emitir `terminal:payment_confirmed { requestId, paymentId, amount, tipAmount, via:'webhook' }` a la terminal de la fila si está conectada (si no, lo verá por su barrido de respaldo). Sin ACK obligatorio: es informativo. Prueba: se emite al cerrar por webhook; no se emite al cerrar por registro de la terminal.
- **T6 · Blumon por combinación (fase 2, después de AngelPay).** En `blumon-webhook.service.ts`, cuando no hay Payment: resolver serial ⇒ terminal FÍSICA exacta (`Terminal.serialNumber`); si es virtual, `MerchantAccount` ⇒ venue ⇒ terminales del venue con solicitud en vuelo; sólo si hay EXACTAMENTE una candidata. Condiciones: fila SENT/UNKNOWN/CANCEL_REQUESTED, `webhook.amount ≥ request.amount`, webhook posterior a `createdAt` de la fila y dentro de `expiresAt + 10 min`, ninguna otra fila de esa terminal en vuelo. Entonces T2. Pruebas: serial físico cierra; virtual con una candidata cierra; virtual con dos ⇒ PENDING como hoy; monto menor ⇒ no.
- **T7 · MCP + bitácora.** `terminal_payment_requests` muestra `closedVia` (`terminal` / `webhook`); `ActivityLog` `TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` sólo cuando cierra una fila que NO estaba en vuelo (anomalía), no en el caso normal (ruido).

### Terminal (`avoqado-tpv`)

- **T8 · Una sola llave.** En `AngelPayPaymentViewModel.ensurePaymentAttemptId` (línea ~755): si `_socketRequestId != null`, el `paymentAttemptId` ES el `requestId` (ya es UUID). Así `integratorReference`, la libreta y `Payment.idempotencyKey` coinciden con la solicitud. Sandbox y production iguales. Pruebas: remoto ⇒ attemptId == requestId; local ⇒ UUID nuevo; el `openAttempt` con llave repetida sigue detectando REUSE (no se debilita).
- **T9 · Bajar el banner al recibir `terminal:payment_confirmed`.** `SocketManager` lo entrega a `RemotePaymentInbox.resolve(requestId, RESOLVED)` y a `PaymentAttemptLedger` (INDETERMINADO/HOST_RESPONDIO/AUTORIZADO/REGISTRO_FALLIDO ⇒ REGISTRADO con `paymentId`). Sólo estados que respalden esa solicitud; nunca toca un intento LOCAL. Pruebas: baja el conteo del banner; no toca una fila de otro requestId; idempotente.
- **T10 · Disparar `LedgerSweepScheduler.runOnceNow()` al nacer una incertidumbre** (misma línea que el 7-sep hizo con `PaymentSyncScheduler.runNow`). Es el respaldo cuando el socket no entregó T9.
- **T11 · CHANGELOG** (regla del repo).

## Orden de despliegue

1. Servidor (T1–T5, T7): inerte para los APK actuales (su `integratorReference` ≠ `requestId`).
2. APK Nexgo con T8–T10 **en la MISMA entrega** que los arreglos ya verificados (serial de la libreta, etc.): sin T8 el webhook no ata nada y hay que esperar otro ciclo del TMS de AngelPay.
3. Blumon (T6) después, con el APK PAX: el serial virtual pide además que Avoqado guarde qué terminal física lleva cada afiliación (columna nueva `MerchantAccount.terminalId`, dato a capturar por venue).

## Fuera de alcance (declarado)

- Que el webhook cree Payments de cobros LOCALES (Pago rápido en la terminal): no hay solicitud a la que atarlos; sigue el registro de la terminal + cola offline.
- Los 2 merchants de AngelPay sin webhook configurado (KEPLER A / Makadi, ESTOCOLMO / Doña Simona): registro en AngelPay, no código.
- Palanca manual para «terminal reservada sin salida» (P2-2): decisión aparte del founder.

---

## 🔴 AUDITORÍA DE CODEX (gpt-6-astra, xhigh, 12-sep 14:33–14:55, 2.27 M tokens, sesión `01a09752-ff09-7190-979b-44e80b5786ec`): NO APROBADO tal cual — 6 P1 · 5 P2 · 1 P3, y su decisión es **B** (desplegar lo verificado; el webhook en la siguiente entrega, rehecho)

Respuesta íntegra en el scratchpad de la sesión (`codex-webhook-primer-confirmador.txt`). Lo que cambia el diseño, verificado contra el código el mismo día:

| # | Hallazgo de Codex | Verificado | Consecuencia para la v2 |
|---|---|---|---|
| P1-1 | **T4 puede liberar una venta que SÍ cobró**: rechazo → el fallback (misma referencia) cobra → la aprobación llega después de los 120 s → el servidor ya liberó y otra terminal vuelve a cobrar. «Siempre llega» ≠ «llega en 120 s» | ✅ `AngelPaySdkGateway.kt:219` reúsa la referencia | **T4 se ELIMINA.** Un rechazo no demuestra que terminaron todos los intentos |
| P1-2 | **Blumon por combinación NO sirve para crear Payments**: un cobro LOCAL del mismo importe en ese aparato (PAX dormida que nunca recibió el remoto) cumple serial + monto + ventana y es OTRA venta; un serial virtual puede abarcar varios venues (`blumon-webhook.service.ts:123`); copiar el serial de la candidata al Payment convierte una suposición en «procedencia acreditada» (`terminal-payment.service.ts:1990`) | ✅ | **T6 se ELIMINA** hasta tener correlación exacta por transacción. `MerchantAccount.terminalId` identifica un aparato, no una venta |
| P1-3 | **T6 rompía «un solo Payment» con la PAX**: el webhook escribiría con `requestId` y la PAX con su propia llave; el índice único sólo choca con llaves IGUALES (`schema.prisma:4272`); la búsqueda por referencia va ANTES de la transacción (`payment.tpv.service.ts:2056`) | ✅ | Idem: sin identidad compartida no se crea nada |
| P1-4 | **T2 contaba la propina dos veces y mezclaba pesos con centavos**: `Payment.amount` EXCLUYE la propina (el propio webhook compara `amount + tipAmount`, `angelpay-webhook.service.ts:240`); el registrador recibe CENTAVOS y divide entre 100 (`payment.tpv.service.ts:2159`) | ✅ | Base y propina congeladas de la solicitud, en centavos; el webhook sólo confirma si `base + propina == amount`; **una diferencia NO se rellena como propina**: queda PENDING para el registro de la terminal |
| P1-5 | **Guardar el webhook no garantiza procesarlo tras una caída**: se inserta PENDING, el servidor muere antes del Payment, la reentrega devuelve `DUPLICATE` (`angelpay-webhook.service.ts:360,378`) y el backfill sólo concilia cuando YA existe Payment (`:574`) | ✅ | **Tarea nueva: procesamiento durable y reanudable de eventos PENDING** (job que retoma los `approved` con solicitud resoluble), probado con caída inmediatamente después de guardar |
| P1-6 | **El registrador dedup por `referenceNumber` sin exigir procesador, afiliación, orden ni monto** (`payment.tpv.service.ts:2056-2064`): dos cargos distintos con la misma referencia devuelven el Payment anterior | ✅ | Corregir esa deduplicación ANTES de reusar el registrador como autoridad del webhook |
| P2-1 | **T8 rompe el reintento tras un rechazo confirmado**: hoy se limpia la llave para generar OTRO intento (`AngelPayPaymentViewModel.kt:3758`); con `attemptId = requestId` el segundo intento sería REUSE en la libreta (`PaymentAttemptLedger.kt:70`) | ✅ | **T8 cambia de forma**: UNA llave POR INTENTO (UUID, como hoy) + la terminal registra en el servidor el vínculo `attemptId → requestId` ANTES de autorizar (evento nuevo `terminal:payment_attempt_opened`); el webhook resuelve la solicitud por ese vínculo |
| P2-2 | T2 no puede envolver `recordOrderPayment` en «una transacción»: abre la suya (`:1998`, `:2303`) ⇒ deadlock con el candado de Order; y el cierre puede regresar sin cerrar (`terminal-payment.service.ts:1961`): no marcar MATCHED sólo porque no lanzó | ✅ | Extraer el núcleo transaccional compartido respetando el orden de candados; MATCHED sólo con cierre confirmado |
| P2-3 | **T9 omite AUTORIZANDO**, el estado habitual cuando el webhook llega primero (1.5 s, con el SDK aún ocupando el aparato) (`PaymentAttemptLedger.kt:124`, `AngelPayPaymentViewModel.kt:2332`) | ✅ | El aviso NO cierra la libreta mientras el SDK esté dentro: persiste «servidor confirmó paymentId» y el camino de salida del SDK concilia; al reconectar la terminal CONSULTA el resultado durable (el socket sólo acelera) |
| P2-4 | T3 debe cubrir la CARRERA, no sólo el reintento posterior: la terminal cae a la rama P2002 (`payment.tpv.service.ts:2731`) que devuelve al ganador por otro camino sin enriquecer | ✅ | La misma fusión (autorización, referencia, tarjeta) en TODOS los retornos idempotentes, atómica y con detección de contradicciones |
| P2-5 | `FAILED/PROCESSOR_DECLINED` NO es desenlace canónico: el código exige `TPV_CONFIRMED_NO_CHARGE` con evidencia o un código de `CODIGOS_SIN_COBRO` (`terminal-payment.service.ts:~667`) | ✅ (el plan afirmaba lo contrario) | No ampliar la lista blanca para justificar T4 |
| P3-1 | T7: la bitácora debe usar la MISMA condición que la alarma (`reopened || CANCEL_REQUESTED`, `:2087`) | ✅ | Una sola regla |

**Sobre los APK en la calle** (Codex): 2.8.7 sigue sin replay; 2.9.2 con ACK no adquiere sonda; una fila entregada como LEGACY no se reenvía nunca (protección existente, `terminal-payment.service.ts:1713`, `:2965`) — sus intentos siguen dependiendo del registro de la terminal.

### Diseño v2 («más simple», de Codex, adoptado)

1. **Sólo AngelPay, con correlación EXACTA.** Blumon conserva su conciliación actual (nada de combinación).
2. **Una llave por intento** (UUID, como hoy) y **el vínculo `attemptId → requestId` se guarda en el servidor ANTES de autorizar** (evento `terminal:payment_attempt_opened { requestId, attemptId }`, persistido en la fila o en tabla hija; sin vínculo grabado el webhook no ata nada y todo sigue como hoy).
3. **Webhook `approved` y registro REST alimentan el MISMO registrador idempotente**: confirma el primero que llegue; el segundo enriquece en TODOS los retornos idempotentes. Importes en centavos, base + propina de la solicitud; discrepancia ⇒ PENDING, nunca «propina inventada».
4. **Se conservan todos los bloqueos actuales** (ranura por tiempo con la venta protegida, sonda, verificación por historial). **Se elimina** la liberación por rechazo + tiempo.
5. **Eventos PENDING procesados de forma durable y reanudable** (job), probado con caída tras guardar.
6. **La terminal recupera el resultado durable al reconectar** (consulta); `terminal:payment_confirmed` sólo acelera y NUNCA cierra una libreta en AUTORIZANDO con el SDK dentro.

### Orden de despliegue (Codex, opción B — y coincido)

1. Servidor verificado + migraciones · 2. APK Nexgo verificado por el TMS · 3. APK PAX verificado con firma de Blumon · 4. Android verificado · 5. **Siguiente entrega**: servidor con vínculo por intento + recuperación durable → Nexgo compatible → piloto AngelPay → ampliación. AngelPay NO exige otra entrega PAX.

**Cobertura barata para no perder un ciclo de Nexgo (propuesta mía, no de Codex, pendiente del founder):** meter en el APK Nexgo de ESTA entrega sólo el emit `terminal:payment_attempt_opened` (fire-and-forget; el servidor actual ignora eventos sin listener). Es el único cambio de terminal que la v2 necesita para AngelPay; si va ahora, la v2 del servidor entra después sin otro ciclo del TMS.

---

## Checkpoint 1 · Tareas de la v2, lado SERVIDOR (13-sep — propuesta para autorización de Codex ANTES de codear)

Hechos re-verificados el 13-sep antes de escribir esto: `angelpay-webhook.service.ts` casa el Payment por
`idempotencyKey` o `referenceNumber` = `integratorReference` (l.155-161) y guarda un `ProviderEventLog`
PENDING con idempotencia por `eventId` (l.347-378, `DUPLICATE` en replay); el registrador TPV es idempotente
por `venueId_idempotencyKey` (`payment.tpv.service.ts:2026`); `TerminalPaymentRequest` NO tiene ningún campo
para el vínculo intento→solicitud; los handlers de socket de terminal viven en `terminal-payment.service.ts`;
`reconcileUnknownRequests` corre cada 30 s desde `terminal-payment-watchdog.job.ts`.

Reglas del checkpoint: TDD (prueba en rojo primero), sabotajes en copia aislada, contrato aditivo, nada de
lo actual se debilita. Cada tarea nombra sus pruebas; ninguna toca la TPV.

- **S1 · El vínculo intento → solicitud, guardado ANTES de autorizar (v2.2).** Evento nuevo
  `terminal:payment_attempt_opened { requestId, attemptId }` que la terminal emitirá tras `openAttempt` y
  antes de lanzar el SDK. Persistencia propuesta: **tabla hija** `TerminalPaymentAttemptLink
  { id, requestId (FK), attemptId @unique, terminalId, createdAt }` y no una columna en la fila — porque un
  reintento legítimo tras un rechazo produce un `attemptId` NUEVO para la MISMA solicitud (es justo lo que
  tumbó a T8: `AngelPayPaymentViewModel.kt:3758` limpia la llave), así que una solicitud puede tener varios
  vínculos y el webhook ata por cualquiera. Reglas: sólo se acepta si la fila es de la terminal del JWT del
  socket y no está cerrada; `attemptId` repetido para otra solicitud ⇒ 🚨 y no se guarda. Sin vínculo
  grabado, el webhook no ata nada y todo sigue como hoy (invariante 5, APK viejos). Sin `ActivityLog`
  (alta frecuencia). Pruebas: guarda · rechaza terminal ajena · rechaza fila cerrada · dos intentos de una
  solicitud conviven · idempotente por `attemptId` · `attemptId` reusado en otra solicitud ⇒ 🚨.
- **S2 · El webhook `approved` ata por vínculo y confirma con el MISMO registrador (v2.1, v2.3).** En
  `angelpay-webhook.service.ts`, sin Payment y con `integratorReference` que case con un vínculo ⇒ resolver la
  solicitud (venue del `MerchantAccount` del secreto) y llamar al registrador idempotente del camino TPV con
  `idempotencyKey = attemptId` — nunca un `payment.create` nuevo. **Importes en centavos**: `amount =
  request.amountCents`, `tip = webhook − request.amountCents` si ≥ 0; si el webhook trae MENOS ⇒ el evento
  queda PENDING con motivo `AMOUNT_MISMATCH`, no se cierra y no se inventa propina. `deviceSerialNumber` =
  terminal de la fila; si el webhook trae serial y difiere ⇒ 🚨 y no cierra. Luego `closeRowFromPaymentTx`
  (ya maneja reopened + 🚨). `shiftId` por `turnoAbiertoDelNegocio`. Un `approved` que contradice
  CANCELLED/TIMED_OUT/FAILED ⇒ COMPLETED + la 🚨 existente (invariante 3). Pruebas: cierra SENT · cierra
  UNKNOWN · TIMED_OUT/AUTO_RELEASED ⇒ COMPLETED + 🚨 · monto menor ⇒ PENDING sin cerrar · serial distinto
  ⇒ no cierra · replay del mismo `eventId` ⇒ DUPLICATE · sin vínculo ⇒ camino de hoy (APK viejo).
- **S3 · El registro REST posterior de la terminal ENRIQUECE, no duplica (v2.3).** Cuando el registro TPV
  (order y fast) encuentra el Payment por llave y nació del webhook: fusiona lo que sólo la terminal sabe
  (recibo, `authorizationCode`, `referenceNumber`, marca/últimos 4) **sin tocar `amount`/`tipAmount`** y
  devuelve el Payment existente. En TODOS los retornos idempotentes. Pruebas: fast y order · no duplica ·
  no cambia montos · llena campos vacíos · no pisa campos ya puestos.
- **S4 · Eventos PENDING procesados de forma durable y reanudable (v2.5).** Un barrido (propuesta: el
  `terminal-payment-watchdog` de 30 s, o job propio si Codex lo prefiere) retoma los `ProviderEventLog`
  PENDING de AngelPay con vínculo resoluble y aplica S2. **Probado con caída tras guardar el evento y antes
  del Payment**: al reanudar, cierra sin duplicar; el `DUPLICATE` por `eventId` no puede impedir el retome.
  Un evento sin vínculo se queda PENDING y lo cierra el backfill actual cuando la terminal registra.
- **S5 · `terminal:payment_confirmed` sólo acelera (v2.6, mitad servidor).** Emitir
  `{ requestId, attemptId, paymentId, amountCents, tipCents, via:'webhook' }` a la terminal de la fila si
  está conectada; sin ACK obligatorio. Prueba: se emite al cerrar por webhook; no al cerrar por REST. (Lo que
  la terminal hace con él es del checkpoint 2, y NUNCA cierra una libreta en AUTORIZANDO con el SDK dentro.)
- **S6 · Consulta durable para la terminal al reconectar (v2.6, mitad servidor).** Endpoint por el que la
  terminal pregunta el desenlace de un intento (`GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId`):
  `COMPLETED + paymentId` / `PENDING` / cerrada-sin-cobro con su desenlace canónico. Pruebas: cada estado ·
  nunca contesta «no cobrado» sin desenlace canónico · sólo intentos de la terminal del JWT.
- **S7 · NO se libera por rechazo + tiempo (v2.4).** Un `declined` se guarda como evidencia apuntando al
  vínculo y NO transiciona la fila. Prueba negativa: `declined` + 120 s ⇒ la fila sigue como estaba. (Retira
  T4 de la v1.)
- **S8 · MCP + bitácora.** `terminal_payment_requests` muestra `closedVia` (`terminal`/`webhook`) y los
  vínculos; `ActivityLog` `TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` sólo cuando cierra una fila que NO estaba
  en vuelo.
- **S9 · Migraciones aditivas + `npm run schema:map` + CHANGELOG**, en el mismo cambio.

**Checkpoint 2 (terminal, Nexgo primero; después de que Codex autorice el 1):** N1 emitir
`payment_attempt_opened` tras `openAttempt` (fire-and-forget); N2 recibir `payment_confirmed` y llevar a
REGISTRADO **sólo** desde estados sin SDK dentro; N3 consultar S6 al reconectar; N4 `LedgerSweepScheduler.runOnceNow()`
al nacer una incertidumbre.

**Lo que este checkpoint NO hace, declarado:** Blumon (queda con su conciliación actual, v2.1); cobros LOCALES;
la palanca manual clase B; los dos merchants sin webhook (registro en AngelPay, no código).

