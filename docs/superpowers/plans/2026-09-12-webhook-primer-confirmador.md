# El webhook como PRIMER confirmador del cobro remoto (AngelPay exacto · Blumon por combinación)

**Estado:** diseño listo, PENDIENTE del OK del founder. Escrito por Fable 5.1 (12-sep-2026) para que lo implemente Opus 5. **Decisión del
founder (12-sep):** «que nuestra principal fuente de verdad sea el webhook, pero que el webhook sea el primer confirmador y lo demás el
respaldo». AngelPay y Blumon le aseguran que SIEMPRE mandan el webhook. Medido en prod (30 días): AngelPay 489/489 traen
`integratorReference`, p50 1.5 s, llegan ANTES de que la terminal registre en 473/473; Blumon 1247/1249. **Repos:** server · tpv. POS
(android/ios) NO cambia: ya espera el cierre de la solicitud.

## Hechos del código que deciden el diseño (verificados el 12-sep)

| Hecho                                                                                                                                                                              | Dónde                                                               | Consecuencia                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El webhook de AngelPay trae `integratorReference` = el `paymentAttemptId` que la TERMINAL inventa (`UUID.randomUUID()`), y el servidor no lo conoce hasta que la terminal registra | `AngelPayPaymentViewModel.kt:755`, `angelpay-webhook.service.ts:34` | Hoy el webhook no se puede atar a la `TerminalPaymentRequest`: queda PENDING y espera el registro de la terminal                                          |
| `TerminalPaymentRequest.requestId` es un UUID generado por el POS y es `@unique`                                                                                                   | `schema.prisma` (model TerminalPaymentRequest, línea 3)             | Si el intento REMOTO usa `requestId` como `paymentAttemptId`, UNA llave recorre POS → servidor → terminal → AngelPay → webhook → `Payment.idempotencyKey` |
| `Payment` tiene `@@unique([venueId, idempotencyKey])` y el registro de la terminal devuelve el Payment existente ante llave repetida                                               | `schema.prisma:4272`, `payment.tpv.service.ts:2026-2046`            | Un Payment nacido del webhook con esa llave vuelve idempotente el registro posterior de la terminal (no hay doble Payment)                                |
| El fallback de propina (C208) REUSA la misma referencia                                                                                                                            | `AngelPaySdkGateway.kt:38-60`                                       | Un `NOT_APPROVED` puede ir seguido de un `approved` con la MISMA llave: NOT_APPROVED solo NUNCA libera de inmediato                                       |
| El webhook de Blumon NO trae una llave nuestra (`reference` es de Blumon y «no siempre presente»); el SDK no acepta una referencia nuestra                                         | `blumon-webhook.service.ts:250,278`                                 | Blumon no tiene camino exacto: sólo por combinación (serial físico + única solicitud en vuelo por terminal + monto ≥ pedido + ventana)                    |
| Un serial VIRTUAL de Blumon identifica la afiliación, no el aparato; `MerchantAccount` no guarda en qué terminal física vive                                                       | `blumon-seriales-virtuales.md`, `schema.prisma` (MerchantAccount)   | Con serial virtual sólo se confirma si en ese venue hay UNA terminal en vuelo con ese merchant; si no, sigue siendo respaldo                              |
| No existe un evento servidor → terminal de «cobro confirmado»                                                                                                                      | `grep terminal:payment_` en `src/`                                  | Hay que crear `terminal:payment_confirmed` para que la libreta pase a REGISTRADO y baje el banner                                                         |
| El registro TPV crea el Payment con `processorData.terminalPaymentRequestId` y `closeRowFromPaymentTx` cierra la solicitud                                                         | `terminal-payment.service.ts`                                       | Este camino se queda tal cual como RESPALDO; sólo se vuelve idempotente cuando el webhook llegó primero                                                   |

## Invariantes (no negociables)

1. **Nunca dos Payments por un cobro.** La llave es `requestId`: webhook y terminal escriben sobre la MISMA `(venueId, idempotencyKey)`.
2. **Nunca liberar por un `NOT_APPROVED` aislado.** Gracia de 120 s sin `approved` de la misma llave y sin Payment; entonces
   `FAILED/PROCESSOR_DECLINED` (desenlace canónico, ya en la lista blanca) libera VENTA y RANURA.
3. **Un webhook `approved` que contradice una fila CANCELLED/TIMED_OUT/FAILED** cierra a COMPLETED y dispara el 🚨 existente («money moved
   despite cancel/close/release»). No se inventa otra alarma.
4. **Blumon nunca crea un Payment por combinación con serial virtual ambiguo.** Sólo con serial físico exacto o con una única terminal
   candidata.
5. **Los APK viejos no cambian de comportamiento**: su `integratorReference` no es el `requestId`, así que el webhook cae al camino de hoy
   (PENDING + backfill al registrar).
6. **Contrato aditivo**: ningún campo se quita; el evento nuevo lo ignoran los APK que no lo conocen.

## Tareas (TDD: la prueba en rojo primero; sabotajes en copia aislada, nunca en el árbol compartido)

### Servidor (`avoqado-server`)

- **T1 · Resolver la solicitud desde el webhook.** En `angelpay-webhook.service.ts`, cuando `status=approved` y NO hay Payment: buscar
  `TerminalPaymentRequest` por `requestId = integratorReference` en el venue del `MerchantAccount` del secreto. Pruebas: encuentra la fila;
  ignora una de otro venue; ignora si `integratorReference` no es un requestId.
- **T2 · Confirmar = crear el Payment + cerrar la fila, en UNA transacción** (`FOR UPDATE` sobre la Order como hace la admisión). Monto =
  `payload.amount/100`; propina = webhook − `request.amount` si ≥ 0 (si < 0 ⇒ DISCREPANCY, no cerrar); método CARD/UNKNOWN como ya registra
  AngelPay; `idempotencyKey = requestId`; `processorData` con `terminalPaymentRequestId`, `deviceSerialNumber` = terminal de la fila (no el
  `terminalSerial` del webhook, que se compara y si difiere ⇒ 🚨 y no cerrar); `shiftId` por `turnoAbiertoDelNegocio`; `merchantAccountId`
  del secreto. Reusar el registrador que ya usa el camino TPV (`recordOrderPayment` / fast) pasando la llave, NO un `payment.create` nuevo.
  Luego `closeRowFromPaymentTx` (que ya maneja `reopened` + 🚨). `ProviderEventLog` ⇒ MATCHED vía `'webhook-first'`. Pruebas: cierra SENT;
  cierra UNKNOWN; cierra TIMED_OUT/AUTO_RELEASED con 🚨; monto menor ⇒ DISCREPANCY sin cerrar; serial distinto ⇒ no cierra; segunda entrega
  del mismo webhook ⇒ idempotente por `eventId`.
- **T3 · El registro posterior de la terminal es idempotente y ENRIQUECE.** Cuando el registro TPV (order y fast) encuentra el Payment por
  llave y ese Payment nació del webhook, fusionar lo que sólo la terminal sabe (marca/últimos 4 para Blumon, recibo, `authorizationCode`,
  `referenceNumber`) sin tocar montos. Pruebas: fast y order; no duplica; no cambia `amount`/`tipAmount`.
- **T4 · `NOT_APPROVED` como evidencia de «no se cobró», con gracia.** Guardar el evento (hoy se marca ERROR y se tira) apuntando a la fila;
  un barrido (el `reconcileUnknownRequests` de 30 s) libera `FAILED/PROCESSOR_DECLINED` si pasaron 120 s sin `approved` ni Payment para esa
  llave. Pruebas: rechazo seguido de aprobación en 20 s ⇒ COMPLETED; rechazo solo ⇒ FAILED a los 120 s; nunca antes.
- **T5 · Avisar a la terminal.** Emitir `terminal:payment_confirmed { requestId, paymentId, amount, tipAmount, via:'webhook' }` a la
  terminal de la fila si está conectada (si no, lo verá por su barrido de respaldo). Sin ACK obligatorio: es informativo. Prueba: se emite
  al cerrar por webhook; no se emite al cerrar por registro de la terminal.
- **T6 · Blumon por combinación (fase 2, después de AngelPay).** En `blumon-webhook.service.ts`, cuando no hay Payment: resolver serial ⇒
  terminal FÍSICA exacta (`Terminal.serialNumber`); si es virtual, `MerchantAccount` ⇒ venue ⇒ terminales del venue con solicitud en vuelo;
  sólo si hay EXACTAMENTE una candidata. Condiciones: fila SENT/UNKNOWN/CANCEL_REQUESTED, `webhook.amount ≥ request.amount`, webhook
  posterior a `createdAt` de la fila y dentro de `expiresAt + 10 min`, ninguna otra fila de esa terminal en vuelo. Entonces T2. Pruebas:
  serial físico cierra; virtual con una candidata cierra; virtual con dos ⇒ PENDING como hoy; monto menor ⇒ no.
- **T7 · MCP + bitácora.** `terminal_payment_requests` muestra `closedVia` (`terminal` / `webhook`); `ActivityLog`
  `TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` sólo cuando cierra una fila que NO estaba en vuelo (anomalía), no en el caso normal (ruido).

### Terminal (`avoqado-tpv`)

- **T8 · Una sola llave.** En `AngelPayPaymentViewModel.ensurePaymentAttemptId` (línea ~755): si `_socketRequestId != null`, el
  `paymentAttemptId` ES el `requestId` (ya es UUID). Así `integratorReference`, la libreta y `Payment.idempotencyKey` coinciden con la
  solicitud. Sandbox y production iguales. Pruebas: remoto ⇒ attemptId == requestId; local ⇒ UUID nuevo; el `openAttempt` con llave repetida
  sigue detectando REUSE (no se debilita).
- **T9 · Bajar el banner al recibir `terminal:payment_confirmed`.** `SocketManager` lo entrega a
  `RemotePaymentInbox.resolve(requestId, RESOLVED)` y a `PaymentAttemptLedger` (INDETERMINADO/HOST_RESPONDIO/AUTORIZADO/REGISTRO_FALLIDO ⇒
  REGISTRADO con `paymentId`). Sólo estados que respalden esa solicitud; nunca toca un intento LOCAL. Pruebas: baja el conteo del banner; no
  toca una fila de otro requestId; idempotente.
- **T10 · Disparar `LedgerSweepScheduler.runOnceNow()` al nacer una incertidumbre** (misma línea que el 7-sep hizo con
  `PaymentSyncScheduler.runNow`). Es el respaldo cuando el socket no entregó T9.
- **T11 · CHANGELOG** (regla del repo).

## Orden de despliegue

1. Servidor (T1–T5, T7): inerte para los APK actuales (su `integratorReference` ≠ `requestId`).
2. APK Nexgo con T8–T10 **en la MISMA entrega** que los arreglos ya verificados (serial de la libreta, etc.): sin T8 el webhook no ata nada
   y hay que esperar otro ciclo del TMS de AngelPay.
3. Blumon (T6) después, con el APK PAX: el serial virtual pide además que Avoqado guarde qué terminal física lleva cada afiliación (columna
   nueva `MerchantAccount.terminalId`, dato a capturar por venue).

## Fuera de alcance (declarado)

- Que el webhook cree Payments de cobros LOCALES (Pago rápido en la terminal): no hay solicitud a la que atarlos; sigue el registro de la
  terminal + cola offline.
- Los 2 merchants de AngelPay sin webhook configurado (KEPLER A / Makadi, ESTOCOLMO / Doña Simona): registro en AngelPay, no código.
- Palanca manual para «terminal reservada sin salida» (P2-2): decisión aparte del founder.

---

## 🔴 AUDITORÍA DE CODEX (gpt-6-astra, xhigh, 12-sep 14:33–14:55, 2.27 M tokens, sesión `01a09752-ff09-7190-979b-44e80b5786ec`): NO APROBADO tal cual — 6 P1 · 5 P2 · 1 P3, y su decisión es **B** (desplegar lo verificado; el webhook en la siguiente entrega, rehecho)

Respuesta íntegra en el scratchpad de la sesión (`codex-webhook-primer-confirmador.txt`). Lo que cambia el diseño, verificado contra el
código el mismo día:

| #    | Hallazgo de Codex                                                                                                                                                                                                                                                                                                                                                                                                          | Verificado                                         | Consecuencia para la v2                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------- |
| P1-1 | **T4 puede liberar una venta que SÍ cobró**: rechazo → el fallback (misma referencia) cobra → la aprobación llega después de los 120 s → el servidor ya liberó y otra terminal vuelve a cobrar. «Siempre llega» ≠ «llega en 120 s»                                                                                                                                                                                         | ✅ `AngelPaySdkGateway.kt:219` reúsa la referencia | **T4 se ELIMINA.** Un rechazo no demuestra que terminaron todos los intentos                                                                                                                                                                                  |
| P1-2 | **Blumon por combinación NO sirve para crear Payments**: un cobro LOCAL del mismo importe en ese aparato (PAX dormida que nunca recibió el remoto) cumple serial + monto + ventana y es OTRA venta; un serial virtual puede abarcar varios venues (`blumon-webhook.service.ts:123`); copiar el serial de la candidata al Payment convierte una suposición en «procedencia acreditada» (`terminal-payment.service.ts:1990`) | ✅                                                 | **T6 se ELIMINA** hasta tener correlación exacta por transacción. `MerchantAccount.terminalId` identifica un aparato, no una venta                                                                                                                            |
| P1-3 | **T6 rompía «un solo Payment» con la PAX**: el webhook escribiría con `requestId` y la PAX con su propia llave; el índice único sólo choca con llaves IGUALES (`schema.prisma:4272`); la búsqueda por referencia va ANTES de la transacción (`payment.tpv.service.ts:2056`)                                                                                                                                                | ✅                                                 | Idem: sin identidad compartida no se crea nada                                                                                                                                                                                                                |
| P1-4 | **T2 contaba la propina dos veces y mezclaba pesos con centavos**: `Payment.amount` EXCLUYE la propina (el propio webhook compara `amount + tipAmount`, `angelpay-webhook.service.ts:240`); el registrador recibe CENTAVOS y divide entre 100 (`payment.tpv.service.ts:2159`)                                                                                                                                              | ✅                                                 | Base y propina congeladas de la solicitud, en centavos; el webhook sólo confirma si `base + propina == amount`; **una diferencia NO se rellena como propina**: queda PENDING para el registro de la terminal                                                  |
| P1-5 | **Guardar el webhook no garantiza procesarlo tras una caída**: se inserta PENDING, el servidor muere antes del Payment, la reentrega devuelve `DUPLICATE` (`angelpay-webhook.service.ts:360,378`) y el backfill sólo concilia cuando YA existe Payment (`:574`)                                                                                                                                                            | ✅                                                 | **Tarea nueva: procesamiento durable y reanudable de eventos PENDING** (job que retoma los `approved` con solicitud resoluble), probado con caída inmediatamente después de guardar                                                                           |
| P1-6 | **El registrador dedup por `referenceNumber` sin exigir procesador, afiliación, orden ni monto** (`payment.tpv.service.ts:2056-2064`): dos cargos distintos con la misma referencia devuelven el Payment anterior                                                                                                                                                                                                          | ✅                                                 | Corregir esa deduplicación ANTES de reusar el registrador como autoridad del webhook                                                                                                                                                                          |
| P2-1 | **T8 rompe el reintento tras un rechazo confirmado**: hoy se limpia la llave para generar OTRO intento (`AngelPayPaymentViewModel.kt:3758`); con `attemptId = requestId` el segundo intento sería REUSE en la libreta (`PaymentAttemptLedger.kt:70`)                                                                                                                                                                       | ✅                                                 | **T8 cambia de forma**: UNA llave POR INTENTO (UUID, como hoy) + la terminal registra en el servidor el vínculo `attemptId → requestId` ANTES de autorizar (evento nuevo `terminal:payment_attempt_opened`); el webhook resuelve la solicitud por ese vínculo |
| P2-2 | T2 no puede envolver `recordOrderPayment` en «una transacción»: abre la suya (`:1998`, `:2303`) ⇒ deadlock con el candado de Order; y el cierre puede regresar sin cerrar (`terminal-payment.service.ts:1961`): no marcar MATCHED sólo porque no lanzó                                                                                                                                                                     | ✅                                                 | Extraer el núcleo transaccional compartido respetando el orden de candados; MATCHED sólo con cierre confirmado                                                                                                                                                |
| P2-3 | **T9 omite AUTORIZANDO**, el estado habitual cuando el webhook llega primero (1.5 s, con el SDK aún ocupando el aparato) (`PaymentAttemptLedger.kt:124`, `AngelPayPaymentViewModel.kt:2332`)                                                                                                                                                                                                                               | ✅                                                 | El aviso NO cierra la libreta mientras el SDK esté dentro: persiste «servidor confirmó paymentId» y el camino de salida del SDK concilia; al reconectar la terminal CONSULTA el resultado durable (el socket sólo acelera)                                    |
| P2-4 | T3 debe cubrir la CARRERA, no sólo el reintento posterior: la terminal cae a la rama P2002 (`payment.tpv.service.ts:2731`) que devuelve al ganador por otro camino sin enriquecer                                                                                                                                                                                                                                          | ✅                                                 | La misma fusión (autorización, referencia, tarjeta) en TODOS los retornos idempotentes, atómica y con detección de contradicciones                                                                                                                            |
| P2-5 | `FAILED/PROCESSOR_DECLINED` NO es desenlace canónico: el código exige `TPV_CONFIRMED_NO_CHARGE` con evidencia o un código de `CODIGOS_SIN_COBRO` (`terminal-payment.service.ts:~667`)                                                                                                                                                                                                                                      | ✅ (el plan afirmaba lo contrario)                 | No ampliar la lista blanca para justificar T4                                                                                                                                                                                                                 |
| P3-1 | T7: la bitácora debe usar la MISMA condición que la alarma (`reopened                                                                                                                                                                                                                                                                                                                                                      |                                                    | CANCEL_REQUESTED`, `:2087`)                                                                                                                                                                                                                                   | ✅  | Una sola regla |

**Sobre los APK en la calle** (Codex): 2.8.7 sigue sin replay; 2.9.2 con ACK no adquiere sonda; una fila entregada como LEGACY no se reenvía
nunca (protección existente, `terminal-payment.service.ts:1713`, `:2965`) — sus intentos siguen dependiendo del registro de la terminal.

### Diseño v2 («más simple», de Codex, adoptado)

1. **Sólo AngelPay, con correlación EXACTA.** Blumon conserva su conciliación actual (nada de combinación).
2. **Una llave por intento** (UUID, como hoy) y **el vínculo `attemptId → requestId` se guarda en el servidor ANTES de autorizar** (evento
   `terminal:payment_attempt_opened { requestId, attemptId }`, persistido en la fila o en tabla hija; sin vínculo grabado el webhook no ata
   nada y todo sigue como hoy).
3. **Webhook `approved` y registro REST alimentan el MISMO registrador idempotente**: confirma el primero que llegue; el segundo enriquece
   en TODOS los retornos idempotentes. Importes en centavos, base + propina de la solicitud; discrepancia ⇒ PENDING, nunca «propina
   inventada».
4. **Se conservan todos los bloqueos actuales** (ranura por tiempo con la venta protegida, sonda, verificación por historial). **Se
   elimina** la liberación por rechazo + tiempo.
5. **Eventos PENDING procesados de forma durable y reanudable** (job), probado con caída tras guardar.
6. **La terminal recupera el resultado durable al reconectar** (consulta); `terminal:payment_confirmed` sólo acelera y NUNCA cierra una
   libreta en AUTORIZANDO con el SDK dentro.

### Orden de despliegue (Codex, opción B — y coincido)

1. Servidor verificado + migraciones · 2. APK Nexgo verificado por el TMS · 3. APK PAX verificado con firma de Blumon · 4. Android
   verificado · 5. **Siguiente entrega**: servidor con vínculo por intento + recuperación durable → Nexgo compatible → piloto AngelPay →
   ampliación. AngelPay NO exige otra entrega PAX.

**Cobertura barata para no perder un ciclo de Nexgo (propuesta mía, no de Codex, pendiente del founder):** meter en el APK Nexgo de ESTA
entrega sólo el emit `terminal:payment_attempt_opened` (fire-and-forget; el servidor actual ignora eventos sin listener). Es el único cambio
de terminal que la v2 necesita para AngelPay; si va ahora, la v2 del servidor entra después sin otro ciclo del TMS.

---

## Checkpoint 1 · Tareas de la v2, lado SERVIDOR — 🟢 AUTORIZADO POR CODEX CON CAMBIOS OBLIGATORIOS (13-sep 11:26)

Veredicto textual (gpt-6-astra xhigh, auditoría de diseño sobre S1–S9 tal como se propusieron a las 11:0x): **«autorizo arrancar el
checkpoint 1 CON CAMBIOS obligatorios. S1–S9 tal como están escritos no quedan autorizados. La tabla hija es correcta, pero faltan garantías
que eviten duplicar registros, perder un cobro durante una caída o dejar al POS esperando después de cobrar.»** Lo que sigue son las tareas
YA con esas condiciones incorporadas; ninguna línea de código existe todavía. Reglas: TDD (rojo primero), sabotajes en copia aislada,
contrato aditivo, nada actual se debilita.

### Orden OBLIGATORIO (de Codex; backend primero, migraciones antes del código que las consume)

1. **S-LEGACY** · 2. **S9** (esquema + migraciones aditivas, con las garantías de concurrencia) · 3. **S1** ·
2. **S0 + S3** · 5. **S2 + S7** · 6. **S4** · 7. **S6 + S5** · 8. **S8**, cierre documental de S9 y verificación completa antes de
   desplegar. 🔴 La aprobación **NO incluye** el atajo de publicar sólo el emit en Nexgo: esa compatibilidad necesita la auditoría del
   checkpoint 2.

### Las tareas

- **S-LEGACY · Caracterización y regresión de los APK actuales (paso 1, en ROJO antes de tocar nada).** «Sin vínculo sigue como hoy» no
  basta cuando se modifican funciones compartidas. Demostrar, sin el evento nuevo: no nace ningún Payment por webhook ni por el worker ·
  REST order/fast, cola offline, reintentos con y sin llave y la conciliación actual siguen iguales · no se exige campo, ACK ni capacidad
  nueva · se conservan las reglas LEGACY de no-reentrega y de sonda por capacidad · Blumon TPV y los cobros locales no cambian · los
  reintentos válidos antiguos siguen deduplicándose incluso conviviendo con Payments nacidos del camino nuevo. 🔴 Las reglas financieras
  nuevas quedan **delimitadas por correlación durable válida**: no se cambian heurísticas legacy en general «porque sólo afectará al
  webhook».
- **S9 · Esquema y migraciones aditivas (paso 2, PRERREQUISITO, no último paso)** + `npm run schema:map` en el mismo cambio + CHANGELOG al
  cierre. Deben traer las garantías de concurrencia acordadas en S0/S1.
- **S1 · El vínculo intento → solicitud (v2.2), en TABLA HIJA**
  `TerminalPaymentAttemptLink { id, requestId (FK), attemptId @unique, venueId, terminalId, createdAt }` — varios `attemptId` por solicitud,
  porque un reintento tras rechazo produce uno nuevo (`AngelPayPaymentViewModel.kt:3758` limpia la llave; es lo que tumbó T8). Codex la
  aceptó y exige: **dueño inmutable por intento** (solicitud, venue y terminal autenticada; nunca se reasigna) · distinguir **repetición del
  mismo vínculo** (idempotente aunque la solicitud haya terminado), **apertura de intento nuevo** y **recuperación tardía de evidencia** (no
  autoriza volver a ejecutar el SDK) · **ACK emitido DESPUÉS del commit**; un timeout de ese ACK no bloquea el cobro ni autoriza otro
  intento (se conserva el camino actual de registro y recuperación) · 🔴 el `fire-and-forget` del checkpoint 2 NO satisface «guardado antes
  de autorizar» por sí solo. Sólo se acepta si la fila es de la terminal del JWT del socket y no está cerrada; `attemptId` reusado en otra
  solicitud ⇒ 🚨 y no se guarda. Sin `ActivityLog`.
- **S0 · El registrador compartido, preparado ANTES de habilitar la creación por webhook (paso 4).** Dos condiciones que Codex ya había
  señalado y que S1–S9 no recogían: **(a) deduplicación por identidad suficiente** — hoy order y fast devuelven un Payment por venue +
  referencia aunque sea de otra orden, afiliación, procesador o importe (`payment.tpv.service.ts:2056`, `:3569`); la referencia sola no
  puede decidir un éxito del camino nuevo, y la resolución exacta debe cubrir el caso en que el matcher actual «encuentra» un Payment antes
  de llegar a S2. **(b) núcleo transaccional común** — `recordOrderPayment` abre su propia transacción (`:2303`) y no puede invocarse dentro
  de otra con candados; el webhook y REST deben compartir el núcleo financiero, conservar el orden de locks y **comprobar el ganador y el
  cierre real**: `closeRowFromPaymentTx` devuelve `void`, tiene salidas sin cerrar y captura errores (`terminal-payment.service.ts:1921`),
  así que «no lanzó» ≠ MATCHED. 🔴 **Invariante nueva: una solicitud tiene UN único ganador financiero canónico, decidido antes de crear o
  contabilizar otro Payment, dentro de la misma transacción, también con `orderId` nulo — y webhook, REST y worker pasan por esa misma
  decisión.** Hoy el índice sólo protege `(venueId, idempotencyKey)` (`schema.prisma:4272`): dos intentos A y B de la misma solicitud, ambos
  aprobados, producen dos Payments y `closeRowFromPaymentTx` retorna «ya COMPLETED» _después_ de haber creado el segundo (`:1943`). Y la
  distinción que importa: **«un Payment por cobro» y «un ganador por solicitud» son reglas distintas** — si el banco cobró dos veces, el
  segundo intento acreditado es una POSIBLE SEGUNDA CAPTURA: evidencia durable + conciliación, nunca «duplicado resuelto» ni fusión
  silenciosa. Prueba obligatoria: A y B aprobados, secuenciales y concurrentes, combinando webhook/REST/worker ⇒ un solo ganador; ninguna
  segunda captura desaparece ni se reconoce como la primera.
- **S3 · El registro REST posterior ENRIQUECE, no duplica (paso 4, con S0).** En todos los retornos idempotentes: **fusión atómica**;
  distinguir campo vacío/provisional (`UNKNOWN`) de dato acreditado; **señalar contradicciones** de identidad, importe o afiliación en vez
  de esconderlas; sin tocar `amount`/`tipAmount`. 🔴 Y la economía del pago: la marca llega del BIN por el SDK
  (`AngelPayPaymentViewModel.kt:3093`) y el webhook no la conoce; `createTransactionCost` calcula con método, marca e internacionalidad
  (`transactionCost.service.ts:229`) y rellenar `cardBrand` después NO recalcula ese costo. Política explícita: costo pendiente hasta
  acreditar la marca, o corrección idempotente del costo sin alterar base/propina ni repetir el ingreso.
- **S2 · El webhook `approved` confirma con el MISMO registrador (paso 5).** Sin Payment y con `integratorReference` que case con un vínculo
  ⇒ resolver la solicitud (venue del `MerchantAccount` del secreto) y pasar por el núcleo de S0 con `idempotencyKey = attemptId`. 🔴
  **Importes, corregidos por Codex:** `base = request.amountCents`, `propina = request.tipCents`, y se crea por webhook **SÓLO si
  `webhook.amount == base + propina`**; cualquier diferencia, hacia arriba o hacia abajo ⇒ PENDING / `AMOUNT_MISMATCH`, sin cerrar y sin
  inventar propina (la fórmula `tip = webhook − base` que proponía yo aceptaba $130 e inventaba $30: el mismo defecto que rechazó la v2). El
  fallback C208 NO cambia el total — manda `amountCents = subtotal + propina` con `tipCents = 0` y la misma referencia
  (`AngelPaySdkGateway.kt:163`, VM `:1822`) — así que no hace falta otro vínculo ni otro desglose; si algún APK redujera el total, S1 no
  contiene evidencia que lo autorice y queda pendiente para el registro acreditado de la terminal. 🔴 **Comprobar `status === 'approved'`
  expresamente**: hoy el receptor continúa si `status` está ausente (`angelpay-webhook.service.ts:383`) y esa tolerancia de conciliación no
  puede volverse autoridad para crear dinero. **Autoridades financieras que se conservan:** el turno por `claimShiftForCompletedPayment`
  dentro de la transacción (`paymentShiftClaim.ts:205`), nunca una consulta a `turnoAbiertoDelNegocio`; orden, vendedor y cliente
  congelados; la afiliación acreditada por el secreto del webhook no se sustituye por la primaria ni se pierde porque después se desactivó
  (el registrador actual tiene fallbacks que borran esa atribución, `payment.tpv.service.ts:2242`). `deviceSerialNumber` = terminal de la
  fila; si el webhook trae serial y difiere ⇒ 🚨 y no cierra. Un `approved` que contradice CANCELLED/TIMED_OUT/FAILED ⇒ COMPLETED + la 🚨
  existente (invariante 3). Pruebas obligatorias: C208 → `approved` con la misma referencia y el mismo total · `approved` → `declined`
  entregado tarde · `approved` después de 120 s · diferencia arriba y abajo · 🔴 un `declined` guardado como PENDING por una caída **jamás**
  crea Payment · cierra SENT · cierra UNKNOWN · TIMED_OUT/AUTO_RELEASED ⇒ COMPLETED + 🚨 · serial distinto ⇒ no cierra · replay del
  `eventId` ⇒ DUPLICATE · sin vínculo ⇒ camino de hoy.
- **S7 · NO se libera por rechazo + tiempo (paso 5, con S2; v2.4).** Un `declined` se guarda como evidencia apuntando al vínculo y no
  transiciona la fila **ni se vuelve elegible para crear Payment**. Prueba negativa: `declined` + 120 s ⇒ la fila sigue como estaba. (Retira
  T4 de la v1.)
- **S4 · Eventos PENDING procesados de forma durable (paso 6) — WORKER PROPIO, no el watchdog.** Codex: el watchdog de 30 s usa un
  `isRunning` en memoria y ejecuta en serie (`terminal-payment-watchdog.job.ts:54`); no excluye otra instancia y una pasada lenta retrasa
  las siguientes. Exige: **selección y claim atómicos, lease recuperable y token de propietario** (patrón del outbox del kiosco
  `kioskOutreach.service.ts:127` y de `PaymentEffect` `paymentEffects.service.ts:32`, que además comprueba al dueño antes de aplicar) ·
  lotes acotados, orden estable, reintentos espaciados, límites de concurrencia · exclusión o comprobación transaccional común frente al
  receptor inmediato y al backfill · los eventos sin vínculo o con discrepancia no monopolizan los lotes · fallos agotados visibles y
  recuperables, nunca convertidos en «no cobrado». 🔴 El lease NO sustituye la idempotencia financiera (S0). Pruebas: dos workers · lease
  vencido · caída tras guardar el webhook · caída durante la transacción · caída tras el commit y antes de avisar · reentrega DUPLICATE con
  el trabajo pendiente todavía recuperable.
- **S6 · Consulta durable para la terminal, POR INTENTO (paso 7).** `GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId`: separa
  **resultado del intento** y **estado de la solicitud**, comprueba la identidad del Payment y **nunca atribuye a A el Payment de B**;
  conserva la incertidumbre cuando falta evidencia; un intento inexistente, un timeout o un rechazo aislado NO equivalen a «no cobrado».
  Sólo intentos de la terminal del JWT.
- **S5 · Avisar a la terminal Y despertar al POS (paso 7, con S6).** Emitir
  `terminal:payment_confirmed { requestId, attemptId, paymentId, amountCents, tipCents, via:'webhook' }` a la terminal si está conectada
  (sin ACK obligatorio; nunca cierra una libreta en AUTORIZANDO con el SDK dentro — checkpoint 2). 🔴 **Y lo que faltaba:** hoy cerrar la
  fila NO resuelve `pendingPayments` (`terminal-payment.service.ts:1394`), así que el temporizador contesta timeout a los 5 min aunque ya
  exista el Payment y el controlador lo vuelve HTTP 504 (`terminal-payment.mobile.controller.ts:127`). Despertar al solicitante **después
  del commit** y recuperar el resultado durable si el aviso se pierde o el solicitante vive en otra instancia. Prueba: se emite y se
  despierta al cerrar por webhook; no al cerrar por REST (que ya despierta por su camino).
- **S8 · MCP + bitácora (paso 8).** `terminal_payment_requests` muestra `closedVia` (`terminal`/`webhook`) — **conservando quién ganó
  originalmente** — y los vínculos; `ActivityLog` `TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` con **exactamente la condición de alarma
  existente** (`reopened || CANCEL_REQUESTED`, `terminal-payment.service.ts:2087`), no «no estaba en vuelo».

**Checkpoint 2 (terminal, Nexgo primero; sólo cuando Codex autorice el 2):** N1 emitir `payment_attempt_opened` tras `openAttempt` con ACK
posterior al commit (S1); N2 recibir `payment_confirmed` y llevar a REGISTRADO **sólo** desde estados sin SDK dentro; N3 consultar S6 al
reconectar, por intento; N4 `LedgerSweepScheduler.runOnceNow()` al nacer una incertidumbre.

**Fuera de este checkpoint, declarado:** Blumon (conserva su conciliación actual, v2.1); cobros LOCALES; la palanca manual clase B; los dos
merchants sin webhook (registro en AngelPay, no código).

## Bitácora de ejecución del checkpoint 1 (13-sep-2026, orden obligatorio de Codex)

| Paso        | Estado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidencia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-LEGACY    | 🟢 hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `tests/integration/payments/webhookPrimerConfirmador.legacy.integration.test.ts`: **11 caracterizaciones VERDES** (webhook approved sin Payment ⇒ PENDING/AWAITING_PAYMENT y cero dinero; DUPLICATE por `eventId`; `status` ausente tolerado sin crear dinero; declined = evidencia sin liberar; webhook antes/después del REST con el backfill actual; DISCREPANCY sin tocar dinero; reintentos con llave en orden y en venta rápida; reintento legacy sin llave por referencia; cobro local sin solicitud no toca nada) y **4 adversariales ROJAS por la invariante** (A y B aprobados de la misma solicitud, secuencial y concurrente, con y sin orden ⇒ hoy dos Payments COMPLETED; línea 424). Las reglas de no-reentrega y sonda por capacidad siguen fijadas en `terminalPaymentRecovery.integration.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S9          | 🟢 hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `prisma/schema.prisma` (+39): `TerminalPaymentAttemptLink` (FK a `requestId` con cascade, `attemptId @unique` = dueño inmutable), `TerminalPaymentRequest.closedVia`, `Payment.terminalPaymentRequestId` con **índice único PARCIAL** `Payment_terminal_request_winner_key` (sólo COMPLETED no REFUND ⇒ UN ganador por solicitud en la base; la segunda captura cabe como PENDING), `ProviderEventLog.attemptId` + lease (`attempts`, `nextAttemptAt`, `leaseUntil`, `claimToken`, `lastError`, mismo vocabulario que `PaymentEffect`). Migración a mano `20260913170000_terminal_payment_attempt_link` (aditiva, `IF NOT EXISTS`, sin migración de datos), aplicada en la base desechable y en `av-db-25` (estaba al día; hay un dev server vivo de este árbol). `docs/SCHEMA_MAP.md` regenerado (368 modelos). Pruebas: `terminalPaymentAttemptLink.schema.integration.test.ts` **9/9** (unicidad del dueño, FK+cascade, ganador único en la base, PENDING y REFUND caben, sin solicitud no restringe, columnas nuevas). ⚠️ La base también impone UNA solicitud en vuelo por terminal (`TerminalPaymentRequest_active_slot`): los fixtures usan una terminal por solicitud.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S1          | 🟢 hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `terminalPaymentService.handleAttemptOpenedFromSocket` + `findAttemptLink` (`terminal-payment.service.ts`), evento `terminal:payment_attempt_opened` cableado en `socketManager.ts` (identidad verificada del mismo venue ANTES de tocar el servicio; el ack lleva el veredicto entero: `LINKED` / `ALREADY_LINKED` / `LATE_EVIDENCE` con `requestStatus` y `executionAuthorized`, o `INVALID` / `NOT_OWNER` / `ATTEMPT_OWNED_BY_OTHER_REQUEST`). El índice único de `attemptId` es el ÚNICO árbitro del dueño (sin pre-lectura: un sabotaje demostró que la pre-lectura volvía código muerto el manejo de la carrera); el ack sale después de escribir; sin `ActivityLog`. Pruebas: `terminalPaymentAttemptLink.socket.integration.test.ts` **14/14** (dueño, idempotencia también con la solicitud cerrada, varios intentos, UNKNOWN en vuelo, 5 entregas simultáneas ⇒ 1 fila, otra solicitud ⇒ 🚨 sin escribir, otra terminal/venue ⇒ NOT_OWNER, serial con o sin prefijo, payload inválido, evidencia tardía en COMPLETED/CANCELLED/TIMED_OUT/FAILED, consulta del dueño) + guardia de fuente del cableado + suite unitaria del servicio 93/93. Sabotajes en copia aislada (`$CLAUDE_JOB_DIR/tmp/sab-s1.py`): SA/SB/SC/SD caen exactamente en sus pruebas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S0 + S3     | 🟢 hecho (13-sep 14:xx) — diseño revisado por Codex (xhigh, 12:44): **APROBADO CON CAMBIOS**, 5 P1 + 4 P2 incorporados (abajo). `terminalPaymentService.arbitrarRegistroDeSolicitud` (FOR UPDATE sobre la solicitud antes del turno; `NO_REQUEST` / `INVALID_ASSOCIATION` con 🚨 / `WINNER` / `RETRY_OF_WINNER` / `SECOND_CAPTURE`); evidencia `Payment PENDING` + `processorData.reconciliation` + `ActivityLog TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE` + recibo, colgada de la venta del ganador (sin orden nueva, turno, VenueTransaction, allocations, efectos, costo ni verificación); `closeRowFromPaymentTx` → `CloseRowOutcome` (solicitud ANTES que Payment también desde el socket; CAS por `paymentId: null`; la columna del ganador y `closedVia` en la misma escritura; COMPLETED sin `paymentId` liga sin alarma); `identidadDelCobro.ts` (referencia sin llave exige importe/propina/orden/afiliación); `registroRepetido.ts` (S3: `COALESCE` + `jsonb` con el existente ganando, contradicciones a bitácora, reparación del vínculo en retornos idempotentes); vales: `lockAreaTicketCheckoutHierarchy` antes del arbitraje y preparación sólo para quien sigue; controlador: `authenticatedTerminalSerial` SIEMPRE del JWT y sin verificación para segundas capturas; migración `20260913180000` (`IS DISTINCT FROM`). **Pruebas:** `webhookPrimerConfirmador.registrador.integration.test.ts` 19/19, las 4 adversariales de S-LEGACY en verde, recuperación/S1/S9 intactas (140/140 en 5 suites), 17 suites unitarias 336/336 (guardia de candados APRETADA: jerarquía → arbitraje → preparación → turno; manifiesto con la evidencia como `exclude`), typecheck 0. **Sabotajes** (`$CLAUDE_JOB_DIR/tmp/sab-s0.py`, 8): todos caen en sus pruebas; SA (sin candado sobre la solicitud) sólo tumba la concurrente SIN orden porque en la ruta de orden el candado de la `Order` ya serializa — defensa en profundidad, declarada. ⬜ Pendiente de Codex P2 «costo pendiente durable» → se resuelve en S2 (Payments nacidos del webhook, sin marca acreditada). | `closeRowFromPaymentTx` devuelve `CloseRowOutcome`, liga COMPLETED sin `paymentId`, CAS por `paymentId: null` PRIMERO y la columna del ganador DESPUÉS; `identidadDelCobro.ts` (identidad suficiente); pruebas `webhookPrimerConfirmador.registrador.integration.test.ts` (7/13 verdes, faltan segunda captura y S3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S2 + S7     | 🟢 hecho (13-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `confirmarPorVinculo` en `angelpay-webhook.service.ts`: el `approved` crea dinero SÓLO con correlación exacta (vínculo S1 → solicitud; venue del merchant del secreto = venue del vínculo, si no `ERROR/LINK_VENUE_MISMATCH`; `status === 'approved'` explícito; `webhook.amount == base + propina` exacto, si no PENDING/`AMOUNT_MISMATCH` sin inventar propina), y entra por el MISMO registrador (`recordOrderPayment`/`recordFastPayment` con `registradoVia: 'webhook'`, serial autenticado del vínculo, cajero de la solicitud si sigue activo): mismo arbitraje (ganador ⇒ `CONFIRMED` y fila `closedVia: 'webhook'`; reintento ⇒ `MATCHED`; otro intento ⇒ `SECOND_CAPTURE` con evidencia PENDING y evento `PROCESSED/POSSIBLE_SECOND_CAPTURE`). El Payment nacido del webhook lleva `methodProvisional` y `costPending`: NO se calcula costo normal (Codex P2) — se encola DENTRO de la transacción un `PaymentEffect TRANSACTION_COST` (`deferredTransactionCost.service.ts`: se calcula al acreditar la marca / cerrar el método provisional, o al vencer el plazo de 2 h; esperar no consume intentos; nunca para segundas capturas); el REST posterior con la misma llave enriquece marca, PAN, modo y **método real** (S3) y destraba el costo. S7: todo `send_transaction` guarda `attemptId`; `declined` = `ERROR/NOT_APPROVED` con `attemptId`, sin tocar la fila, y un `approved` posterior del mismo intento sí crea. S5 mínimo: `confirmFromWebhook` despierta el long-poll del POS y emite `terminal:payment_confirmed` a la terminal (sin ACK) sólo cuando el webhook fue el primer confirmador. **Pruebas:** `webhookPrimerConfirmador.webhook.integration.test.ts` 11/11; regresión 140/140; unitarias del webhook 34/34 (+ `deferredTransactionCost.test.ts`); typecheck 0. **Sabotajes** (`sab-s2.py`, 7): venue del vínculo, importe exacto, status explícito, `closedVia`, costo pendiente, `attemptId`, método provisional — todos caen en sus pruebas. ⚠️ Declarado: la arbitraje dentro de la transacción es fail-open (🚨 y registro sin ligar) igual que la lectura previa de la fila — dentro de una transacción real un fallo de conexión aborta todo; sólo cambia el desenlace de un fallo lógico.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S4          | 🟢 hecho (13-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `angelpayEventWorker.service.ts` (nuevo): `claimPendingAngelPayEvents` reclama con `WITH picked … FOR UPDATE SKIP LOCKED` sólo `PENDING` de `send_transaction` con `nextAttemptAt` vencido y lease nulo o vencido, estampa `claimToken` + `leaseUntil` (2 min) y sube `attempts` **al reclamar**; agotado (40) ⇒ `ERROR/RETRIES_EXHAUSTED` visible y recuperable sin tocar la solicitud ni inventar «no cobrado»; `runClaimedAngelPayEvent` entra por `reconciliarEventoPendiente` (extraída de `processAngelPayWebhook`: el receptor y el worker corren el MISMO cuerpo) con el token como `propietario` en las 10 escrituras finales (`updateMany where {id, claimToken}` — un lease vencido y reclamado por otro no puede pisar el estado); sin vínculo todavía ⇒ vuelve a PENDING con backoff 2 min × 2ⁿ (tope 1 h), `nextAttemptAt` como orden y lease liberado. El receptor reserva sus 60 s (`nextAttemptAt = now + 60 s` al insertar) para que la reentrega DUPLICATE y el worker no se pisen; las filas legacy (`nextAttemptAt` NULL) no se tocan. Job `angelpay-event-worker.job.ts` (`'13,43 * * * * *'`, sin solaparse consigo mismo, cableado en `server.ts`). 🔴 **Hueco cazado por la prueba del lease vencido:** el backfill del REST (`reconcileAngelPayWebhookForPayment`) marcaba PROCESSED un evento que el worker tenía reclamado — ahora excluye los eventos con lease vigente (el dueño los cierra con su token; prueba unitaria apretada para fijar las DOS cláusulas del `where`). **Pruebas:** `webhookPrimerConfirmador.worker.integration.test.ts` 11/11 (claim atómico con 5 workers ⇒ 1 dueño; lease vencido se retoma con token nuevo y el vigente se respeta; el dueño viejo no escribe y el dinero no se duplica; DUPLICATE con trabajo pendiente; agotamiento; backoff; confirma cuando llega el vínculo; declined no libera; legacy intacto), `angelpay-event-worker.job.test.ts` 2/2, webhook unitarias 34/34, regresión integración 162/162 (7 suites), unitarias 470/470 (29 suites), typecheck 0. **Sabotajes** (`sab-s4.py`, 5: claim sin lease · escrituras sin dueño · receptor sin reserva · sin agotamiento visible · sin backoff): cada uno cae exactamente en su prueba, control 0/11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S6 + S5     | 🟢 hecho (13-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **S6** `terminalPaymentService.consultarIntentoDeTerminal({attemptId, venueId, terminalSerial})` + `GET /tpv/venues/:venueId/terminal-payment/attempts/:attemptId` (`terminal-payment.tpv.controller.ts`, `authenticateTokenMiddleware` + `validateVenueAccess`; la identidad es la TERMINAL del JWT, no el rol: sin `terminalSerialNumber` ⇒ 403 `TERMINAL_IDENTITY_REQUIRED`). Contesta por separado el **resultado del intento** (`attempt`: el Payment cuya llave es ESTE `attemptId` — nunca el de otro intento — con `outcome` `RECORDED` / `SECOND_CAPTURE_EVIDENCE` (su Payment PENDING + `winnerPaymentId`) / `NOT_RECORDED`, `recordedVia`, `isWinner`, y la evidencia del procesador SOBRE ESE INTENTO `APPROVED`/`DECLINED`/`NONE` con su fecha) y el **estado de la solicitud** (`request`: `proyectarEstado` de siempre + `closedVia` + `winnerAttemptId`). Un intento desconocido, de otra terminal o de otro venue se ve IGUAL (null ⇒ 404 `ATTEMPT_NOT_FOUND` con `outcome: NO_EVIDENCE`); ningún valor significa «no cobrado» (un timeout/UNKNOWN de la solicitud, un declined o la ausencia de Payment quedan `NOT_RECORDED` + `UNRESOLVED`). **S5** `confirmFromWebhook` despierta al POS del long-poll con `success + paymentId` y emite `terminal:payment_confirmed {requestId, attemptId, paymentId, amountCents, tipCents, via:'webhook'}` (sin ACK) sólo cuando el webhook fue el primer confirmador; el cierre por REST no pasa por ahí. 🔴 **Lo que faltaba:** el long-poll ya no contesta timeout a ciegas — al vencer RELEE la fila (`desenlaceDurableAlVencer`) y `resolvePendingFromDurableState()` (batch, lo llama el vigía cada tick tras las conciliaciones) despierta con el resultado durable a un POS cuya fila ya quedó COMPLETED con Payment (aviso perdido o confirmado en otra instancia); sólo con dinero acreditado (`CHARGED`), nunca inventa un desenlace. **Pruebas:** `webhookPrimerConfirmador.terminal.integration.test.ts` 13/13 (ganador por webhook · nunca atribuye a B el Payment de A · sin dinero/eventos · declined · approved sin dinero (AMOUNT_MISMATCH) · UNKNOWN/TIMED_OUT · desconocido · otra terminal · otro venue · serial con/sin prefijo · despertar + aviso · REST no pasa por confirm y la recuperación durable despierta · la recuperación no toca a un POS en vuelo), `tests/api-tests/tpv/terminal-payment-attempts.api.test.ts` 6/6 con el Express real (401 · 403 sin identidad · 403 venue ajeno · 404 NO_EVIDENCE ×2 sin «NOT_CHARGED» en el cuerpo · 200), `terminal-payment-watchdog.job.test.ts` 2/2 (cableado y orden), regresión unitaria 82 suites / 1092, typecheck 0. `tests/__helpers__/setup.ts` enumera ahora `providerEventLog` (mock de lista fija). **Sabotajes** (`sab-s6.py`, 9: sin acotar a la terminal · sin acotar al venue · Payment por solicitud en vez de por llave · recuperación que inventa · confirm sin despertar · sin aviso · 404 que dice «no cobrado» · sin candado de identidad · vigía sin recuperación): cada uno cae exactamente en su prueba, controles 0/13, 0/6, 0/2. ⬜ Para el checkpoint 2 (terminal): N2 recibir `payment_confirmed` sólo desde estados sin SDK dentro; N3 consultar S6 al reconectar, por intento. |
| S8 + cierre | 🟢 hecho (13-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `CloseRowOutcome` devuelve también `previousStatus` y `alarmed` (= `reopened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |     | CANCEL_REQUESTED`, la MISMA condición que ya disparaba la 🚨 «dinero por webhook sobre una solicitud cerrada o en cancelación»); el registrador escribe `ActivityLog TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK` (`registrarConfirmacionAnomalaPorWebhook`, fuera de la transacción, nunca lanza) SÓLO bajo `alarmed`— la confirmación normal por webhook no es ruido de bitácora. El MCP`terminal_payment_requests`muestra`closedVia`, los intentos (`attempts`, con su Payment y evidencia) y `winnerAttemptId`, todo con `take`explícito (el guard`findManySinTopeGuard`cazó dos listas sin tope y se acotaron). CHANGELOG bajo`[Unreleased] › Added`. **Pruebas:** webhook 4 (confirmación normal NO escribe bitácora · sobre CANCELADA escribe · sobre CANCEL_REQUESTED escribe · reabierta escribe), MCP unitarias +2 (`closedVia`conservando al ganador ·`attempts`/`winnerAttemptId`). **Sabotajes** (`sab-s8.py`, 3: bitácora en toda confirmación · condición no canónica · MCP esconde `closedVia`): cada uno cae exactamente en su prueba. **Verificación previa a la auditoría final:** integración 179/179 (8 suites), api 50/50, unitarias 4 shards (2 verdes; los fallos de los otros 2 son ajenos: eventloop-budget bajo carga y catálogo maestro, documentados), typecheck 5.8 COINCIDEN 0, build COINCIDEN, `audit:permissions`limpio, migraciones al día,`pre-migration-check`ALL CLEAR (bajo Node 24 exige`TS_NODE_TRANSPILE_ONLY=1` y heap grande). 🔴 **Auditoría final de Codex (gpt-6-astra, xhigh, 13-sep 14:45): RECHAZADO — 7 P1 · 8 P2**, los 7 P1 verificados contra el código real antes de aceptarlos; ver «Ronda 1» abajo. |

### 🔴 Ronda 1 de la auditoría final de Codex (13-sep 14:45): RECHAZADO con 7 P1 · 8 P2 → todos cerrados con TDD y sabotajes (13-sep, tarde)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-final-last.md`. Cada P1 se verificó contra el código ANTES de aceptarlo (los siete
eran reales). Todo se hizo en rojo primero (17 pruebas nuevas en rojo, `r1-red.txt`) y se cerró con sabotajes en la copia aislada
(`sab-r1.py`, 20; `sab-r1b.py`, 3): **cada sabotaje cae exactamente en su prueba, controles en verde**.

- **P1-1 · La identidad EXACTA manda sobre la referencia débil.** `transactionId`/`referenceNumber` son `yyMMddHHmmss`: dos cobros del mismo
  segundo colisionan, y el matcher débil corría ANTES del vínculo S1 (marcaba PROCESSED sobre el Payment de OTRO intento y perdía éste).
  Ahora: (a) con `integratorReference` y vínculo, el evento va DIRECTO a `confirmarPorVinculo`; (b) el matcher débil, con llave fuerte
  presente, sólo acepta un Payment SIN llave o con la MISMA (`AND [débil, OR [idempotencyKey null | = llave]]`); (c) el backfill del REST
  salta un evento cuya llave es de OTRO intento; (d) el registrador: dos llaves DISTINTAS nunca se deduplican por referencia
  (`motivo: 'LLAVE'`). 🔑 **El arnés destapó que (a) era defensa en profundidad y NO estaba probada**: con (b) puesta, quitar el
  vínculo-primero no tumbaba nada. El caso que sólo (a) protege es un Payment LEGACY sin llave (APK viejo) con la misma referencia: el débil
  lo casaría (un Payment sin llave es lo único que puede casar un webhook legacy) y el intento A quedaría sin dinero. Prueba añadida — y con
  ella salió un P1 propio: el registrador deduplicaba el cobro del VÍNCULO contra ese Payment sin llave (`mismo: true`). Cerrado con
  `exigeLlave` (un entrante acreditado por vínculo nunca es un Payment sin llave) y, del diseño S0-a que Codex ya había exigido y no estaba
  implementado, la referencia sin llave exige además **misma terminal** (`motivo: 'TERMINAL'`, serial físico del
  JWT/`processorData.deviceSerialNumber`) y **misma solicitud** (`'SOLICITUD'`). Un reintento legacy de la MISMA terminal sigue siendo uno
  solo. Pruebas: webhook 4 (con orden · sin orden · backfill/registrador · legacy sin llave), registrador 4 (llaves distintas con orden ·
  sin orden · dos terminales · misma terminal), unitarias de identidad 13.
- **P1-2 · El serial del webhook se compara con la terminal del vínculo.** Un webhook FIRMADO que dice otra terminal (`terminalIdentityKey`,
  con o sin `AVQD-`) conserva la evidencia y alarma (`ERROR/LINK_TERMINAL_MISMATCH`), sin crear ni cerrar dinero. Pruebas: 3 (contradice ·
  coincide con otro prefijo/caja · sin serial no bloquea).
- **P1-3 · La afiliación acreditada por el webhook se conserva aunque esté desactivada.** El merchant lo acredita el secreto del propio
  webhook; desactivarlo después no cambia por dónde pasó el dinero. Antes el registrador la borraba (`merchantAccountId = undefined`) y el
  costo caía al PRIMARY. Sólo cuando `registradoVia === 'webhook'`; el REST sigue igual.
- **P1-4 · S3 no pierde lo que el REST acredita.** (a) `ReintentoDelGanadorDeLaSolicitud` (orden y venta rápida) devolvía al ganador SIN
  consolidar: el REST que perdía la carrera bajo el candado traía marca, PAN, modo y método reales y se tiraban — ahora consolida como los
  retornos idempotentes. (b) El webhook inventaba `isInternational: false` y, como el JSON existente gana, tapaba el `true` del REST: ahora
  no escribe la llave. Pruebas: 2 (internacionalidad · carrera bajo `FOR UPDATE` con transacción manual que crea al ganador y suelta
  mientras el REST espera).
- **P1-5 · El costo diferido converge o no termina.** `settleDeferredTransactionCost` reescrito: el costo persistido es la verdad y repara
  SIEMPRE `Payment.feeAmount/netAmount` (`venueChargeAmount + venueFixedFee`, `amount − fee`) y la `VenueTransaction`
  (`feeAmount/netAmount/netSettlementAmount`); si la VenueTransaction no se puede actualizar devuelve `false` (el efecto reintenta) y
  `costPending: false` sólo al converger (jsonb `||`). Suite nueva `webhookPrimerConfirmador.costoDiferido.integration.test.ts` (9) con un
  fake de `createTransactionCost` que SÓLO inserta la fila —el estado que deja un corte del servicio real—: costo ya en la base · sin costo
  · VenueTransaction caída y convergencia al reintentar · idempotente · esperando · segunda captura sin costo.
- **P1-6 · Reembolso durante la espera del costo.** Al cerrar el costo se crean los costos NEGATIVOS de los REFUND cuyo
  `processorData.originalPaymentId` es este Payment (`createRefundTransactionCost`, idempotente por Payment del reembolso; parcial
  proporcional, total con el fijo). Pruebas: 3 (parcial · total · reembolso ajeno intacto).
- **P1-7 · Procedencia en S6.** El Payment con la llave del intento sólo se atribuye si su procedencia lo ata a ESTA solicitud (columna,
  `processorData.terminalPaymentRequestId` o `reconciliation.requestId`) o, sin solicitud, a ESTA terminal (serial); si no, `NOT_RECORDED` +
  `paymentContradiction: true` (campo nuevo, aditivo) y 🚨 — nunca «no cobrado». La evidencia se acota al `venueId` del vínculo (un approved
  recibido por el merchant de OTRO venue, `LINK_VENUE_MISMATCH`, no es evidencia); un `approved` antiguo se busca aparte (no lo esconde el
  tope de los últimos 10); `type NULL` cuenta como REGULAR. Pruebas: 4.
- **P2 (8):** el receptor escribe como DUEÑO (token propio desde el insert; el worker que lo reclame después invalida sus escrituras
  tardías) y el backfill RECLAMA el evento con CAS (`PENDING` y sin lease vigente) ANTES de estampar · toda huella sobre
  `Payment.processorData` se fusiona en SQL sobre el valor VIGENTE (`estamparProcessorData`, jsonb `||`; ya no hay `update` con spread de
  una lectura vieja — unitarias del webhook adaptadas, 37) · `executionAuthorized` se decide con el estado VIGENTE tras escribir el vínculo
  y sólo para PENDING/SENT (UNKNOWN y CANCEL_REQUESTED conservan evidencia sin autorizar; prueba que cancela ENTRE la lectura y la escritura
  con un espía sobre el insert) · el controlador decide la SaleVerification por lo DURABLE (`PENDING` + `reconciliation.kind`), no por la
  marca transitoria (un replay HTTP de una segunda captura ya no crea verificación; unitarias 8) · `costPending` visible en el MCP
  `list_payments` (`summary.completed.costPendingCount` / `netProvisional`, mismo `where` del listado) · recuperación durable por lotes de
  100 · la prueba de caída del worker corta DENTRO de la transacción · el long-poll vence de verdad en las pruebas
  (`TERMINAL_PAYMENT_LONG_POLL_MS`, nunca en producción).
- **Verificación de la ronda:** integración webhook+registrador+legacy 63/63, terminal+webhook 42/42, las 5 suites del checkpoint 105/105,
  costo 9/9, socket 16/16; unitarias webhook 37, controlador 8, identidad 13, MCP pagos 10, servicio de terminal 94, validación de merchant
  18; prettier y eslint limpios. 🔴 El typecheck 5.8 (avq, local y Alienware COINCIDEN) cazó 3 `TS2353` que jest no ve (`paymentId` no vive
  en `ProviderEventLogUpdateManyMutationInput`: el input correcto para `updateMany` con FK es el `Unchecked`) — corregidos. Re-verificación
  de la ronda 1: typecheck 5.8 0 errores (local y Alienware COINCIDEN), 4 shards unitarios en verde (4058 · 4682 · 3765 · 4523; el único
  fallo local fue la sonda de carga del event loop, idéntica a HEAD y verde en DUAL exacta; el shard 4 local reventó por memoria y su
  reintento coincidió), integración de pagos 16 suites / 300, api 50/50.

### 🔴 Ronda 2 de la auditoría final de Codex (13-sep, tarde): RECHAZADO otra vez — 7 cerrados · 8 parciales · 4 P1 nuevos (N1–N4) · 5 P2 → todos cerrados con TDD y sabotajes

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r2-last.md`. Cada hallazgo se verificó contra el código antes de aceptarlo (todos
eran reales, incluidos los cuatro nuevos, que los propios arreglos de la ronda 1 expusieron). 22 pruebas nuevas en rojo primero
(`r2-red-int.txt`), y 16 sabotajes en la copia aislada (`sab-r2.py`, `sab-r2a.py`): **cada uno cae exactamente en su prueba, controles en
verde**.

- **P1-1 (candidatos) · el reintento legacy elige SU Payment.** `findFirst` por referencia devolvía un candidato arbitrario y descartarlo se
  convertía en permiso para crear (una venta rápida de más sin cargo). Ahora `elegirRegistroPorReferencia` examina TODOS los candidatos de
  la referencia (`findMany`, tope 10, más reciente primero; un entrante sin llave prefiere al candidato sin llave) y sólo se crea cuando
  NINGUNO tiene identidad suficiente. 🔑 La prueba destapó que el registrador guardaba en `processorData.deviceSerialNumber` el serial del
  CUERPO, no el acreditado por el JWT (T10): la regla TERMINAL comparaba un lado acreditado contra otro que no lo era. Se conserva el
  acreditado.
- **P1-1 (backfill) · el vínculo S1 manda aunque el candidato no tenga llave.** Un evento PENDING de A (con vínculo, receptor muerto) ya no
  se cierra con el REST legacy sin llave de la misma referencia: con `integratorReference`, el backfill sólo se lo atribuye a un Payment con
  la MISMA llave, o sin llave cuando NO existe vínculo para esa llave.
- **N2 · la identidad por vínculo también en REST.** `exigeLlave` sólo se activaba por `registradoVia === 'webhook'`: el REST de A (con
  vínculo) que llegaba ANTES del webhook se deduplicaba contra el legacy sin llave, cerraba la solicitud con él y el webhook de A nacía como
  segunda captura (dos cargos, una venta). Ahora `identidadAcreditadaPorVinculo` consulta el vínculo de la llave del entrante (sólo si hay
  candidatos) en los dos caminos; y una transición legítima (Payment sin llave reutilizado por un REST con llave) deja
  `idempotencyKey = COALESCE(idempotencyKey, llave)` como asociación durable.
- **N1 · el método del webhook nunca acredita.** Un webhook repetido (otro `eventId`) o retomado tras un corte volvía a pasar por el
  registrador y `planDeConsolidacion` tomaba su `CREDIT_CARD` inventado como real: cerraba `methodProvisional`, habilitaba el costo con
  crédito doméstico y el REST con débito internacional quedaba en contradicción. Ahora el plan ignora el método cuando
  `entrante.registradoVia === 'webhook'`. **P2-2:** `consolidarRegistroRepetido` decide el plan sobre la fila VIGENTE con
  `SELECT … FOR UPDATE` dentro de una transacción (sólo Payment: sin ciclo con Order → Solicitud → Payment → Turno) — una copia vieja que
  aún cree provisional el método ya no puede pisar lo que otro registro acreditó.
- **P1-3 · costo con la afiliación ACREDITADA.** `createTransactionCost` sustituía por PRIMARY una afiliación que ya no estaba en la
  configuración del venue: el costo del proveedor y la liquidación quedaban a nombre de una afiliación por la que el dinero nunca pasó.
  Ahora resuelve `merchantAccount` por id y lo conserva (provider cost + `TransactionCost. merchantAccountId`); si ya no existe, lanza
  (pendiente recuperable); sólo la tarifa del negocio cae al slot PRIMARY cuando esa afiliación no tiene slot (la regla «nunca peor que
  PRIMARY» que ya existía).
- **P1-5 · metadatos de liquidación.** El diferido reparaba comisión y neto pero no `estimatedSettlementDate` / `settlementConfigId` /
  `netSettlementAmount`: ahora los recalcula con `calculatePaymentSettlement` cuando faltan y no termina si esa escritura falla. **P2
  (aritmética):** la comisión y el neto se proyectan con `Prisma.Decimal` sin redondeo intermedio (redondea la columna, igual que
  `createTransactionCost`).
- **N3 · todos los reembolsos.** El diferido leía sólo los primeros 50 reembolsos y marcaba `costPending:false`: el 51.º se quedaba fuera
  del saldo por tarjeta para siempre. Ahora recorre páginas de 50 con cursor estable y no termina hasta la última; idempotente por Payment
  del reembolso.
- **N4 · reembolso con propina.** `createRefundTransactionCost` (helper previo, activado por la recuperación) usaba sólo `abs(amount)`: una
  devolución total de base $100 + propina $10 quedaba «parcial» (100/110), no revertía la comisión entera ni devolvía el fijo ($0.75 sin
  revertir). Ahora el total devuelto es `abs(amount) + abs(tipAmount)`. Pruebas: total · parcial · sólo propina (unitarias 4 e integración
  2).
- **P1-7 · procedencia también en la evidencia.** Un approved del MISMO venue con el serial de OTRA terminal (`LINK_TERMINAL_MISMATCH`) ya
  no vale como `APPROVED`: se declara `evidenceContradiction: true` (campo aditivo) y la evidencia se elige entre los eventos de ESTA
  terminal (los approved se leen como lista de 10, no `findFirst`), sin descartar un approved legítimo con importe discrepante.
- **P2 nuevos:** un fallo OPERATIVO del diferido (VenueTransaction, reembolso, liquidación) se PROPAGA — el efecto cuenta el intento, hace
  backoff y llega a `DEAD_LETTER` visible — en vez de reprogramarse para siempre con `attempts: 0`; el backfill reclama y estampa en UNA
  transacción y estrena `claimToken` (una escritura tardía del receptor con su token viejo ya no regresa `PROCESSED → PENDING`); el webhook
  clasifica el replay de una segunda captura con el módulo compartido `segundaCaptura.ts` (durable), igual que el controlador; el MCP trae
  aparte los vínculos de las llaves ganadoras (`attemptsTruncated` cuando la lista tocó el tope); la prueba de carrera del webhook usa una
  barrera OBSERVABLE (`pg_stat_activity`, `wait_event_type = 'Lock'` sobre `TerminalPaymentRequest`) y REST con DÉBITO + internacional.
- **Verificación de la ronda:** integración webhook 28 · registrador 28 · costo 13 · terminal 21 (las cuatro suites 89/89), unitarias
  identidad 16 · registroRepetido 7 · webhook 37 · MCP 12 · reembolso 4 · afiliación 3 · controlador 8 · costo diferido 5 · efectivo
  duplicado 16 · venta rápida 24 + 35 · servicio de terminal 94; prettier y eslint limpios. Sabotajes (`sab-r2.py` 15 + `sab-r2a.py` 1):
  sólo-el-primer-candidato · serial del cuerpo · backfill sin S1 · vínculo sólo en webhook · método del webhook acredita · plan sobre la
  copia vieja · reembolsos en una página · reembolso sin propina · sin metadatos de liquidación · fallo operativo como espera · evidencia
  sin procedencia · backfill sin token nuevo · segunda captura por la marca transitoria · MCP sin el ganador · afiliación sustituida por
  PRIMARY — cada uno cae en su prueba. Typecheck, shards y **tercera auditoría de Codex** en curso al escribir esto.

### 🔴 Ronda 3 de la auditoría final de Codex (13-sep 16:33): RECHAZADO — 4 P1 (R3-1 · R3-2 · P1-3 · P1-5) · 7 P2 · 1 P3 · 5 críticas a las pruebas → todos cerrados con TDD y sabotajes

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r3-last.md`. Cada hallazgo se verificó contra el código antes de aceptarlo (todos
eran reales). La regla del founder se mantuvo en los dos límites: ningún arreglo interrumpe un cobro (lo que no se puede acreditar queda
PENDIENTE y VISIBLE, nunca bloquea el registro) y ninguno abre un cobro doble, una venta perdida ni una venta sin cargo.

- **R3-1 · el candidato número 11.** La búsqueda por referencia leía «los 10 más recientes» y un reintento legítimo más antiguo se convertía
  en OTRA venta registrada. Ahora `buscarRegistroPorReferencia` (exportada) lleva los DISCRIMINADORES en la CONSULTA (venue, referencia,
  importe, propina, orden objetivo, afiliación, sin reembolsos) y recorre páginas de 10 con cursor estable hasta resolver la identidad o
  agotar el conjunto (un tope de 100 páginas se declara con 🚨 y se registra como cobro nuevo: un subconjunto agotado nunca acredita
  ausencia). Un entrante sin llave prefiere a los candidatos sin llave (`nulls first`). La búsqueda devuelve la regla de identidad que usó
  (`exigeLlave`) y la consolidación la HEREDA: un `exigeLlave: true` fijo habría rechazado bajo el candado la transición legítima APK viejo
  → nuevo. Pruebas: once legacy de once terminales con la misma referencia (venta rápida y orden) → el replay de la más vieja la encuentra
  en la segunda página; doce cobros de otro importe no son candidatos; guarda unitaria de la FORMA de la consulta y de la paginación (5).
- **R3-2 · la asociación concurrente de una llave.** Dos escritores con llaves distintas podían elegir al mismo legacy B y el segundo
  confirmaba el Payment equivocado (o quedaba a medias con un P2002). Ahora `consolidarRegistroRepetido` revalida bajo el candado las ANCLAS
  de identidad de la fila viva (llave, solicitud, terminal) con la misma regla con la que se eligió — el dinero, la orden y la afiliación no
  cambian de dueño y siguen siendo contradicciones con bitácora —; si otro escritor la acreditó en medio devuelve `null` y el registrador
  vuelve a resolver el intento (hasta 3 veces) en vez de confirmar al candidato anterior; y una violación de unicidad de
  `(venueId, idempotencyKey)` —P2002 o, en SQL crudo, P2010 con el código 23505 de Postgres (medido)— devuelve al DUEÑO durable de la llave.
  Pruebas: K1 y K2 esperan JUNTOS el candado marcado `/* consolidacion */` sobre B (barrera identificada por pid: Postgres encola, el
  segundo espera al primero y la cadena termina en el candado de la prueba) → uno se queda con B y el otro nace aparte; identidad perdida
  bajo el candado → `null` sin tocar nada; llave ya de otro Payment → el dueño. 🔑 Un reintento REAL repite la autorización: una auth
  distinta sobre la misma referencia es contradicción (regla de la ronda 2), así que la carrera se prueba con la misma.
- **P1-3 · la tarifa se congela al cobrar.** El costo de una afiliación retirada de la configuración caía a PRIMARY (8 % contra 2.5 % sobre
  $1,000 son $55). Ahora el registrador resuelve el slot que la afiliación ocupa HOY (`slotDeLaAfiliacion`, desde
  `getEffectivePaymentConfig`, nunca lanza) y lo conserva en `processorData.pricingSlot` (altas normales y segunda captura);
  `createTransactionCost` usa el slot congelado para una afiliación fuera de la configuración y NUNCA cae a PRIMARY: sin slot, o con slot
  sin tarifa vigente, lanza `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED`, que el costo diferido convierte en obligación durable y visible
  (`PaymentEffect.lastError = AFFILIATION_PRICING_UNRESOLVED`, `return false`, sin consumir intentos) y converge cuando la afiliación vuelve
  a la configuración. El cobro nunca se interrumpe. Pruebas: unitarias (6: slot congelado, sin slot, slot sin tarifa, afiliación borrada,
  sin afiliación, en configuración), registrador (PRIMARY / SECONDARY / null) y costo REAL (M2 al 2.5 % retirada antes del costo → 2.5 %, no
  8 %; sin slot → pendiente visible → recupera).
- **P1-5 · la liquidación es una obligación durable.** Sin configuración de liquidación el efecto terminaba y el saldo quedaba sin fecha
  para siempre. Ahora `anotarEspera(paymentId, 'AWAITING_SETTLEMENT_CONFIGURATION')` escribe el motivo en el efecto (PROCESSING/PENDING) y
  devuelve `false`; al configurarla, converge. El fixture trae la configuración de fábrica (los cuatro tipos de tarjeta). Pruebas con costo
  fake (diferido) y con costo real.
- **P2 · S6 por páginas.** Diez approved de OTRA terminal escondían un approved propio antiguo (`NONE`, o `DECLINED` con un rechazo propio
  reciente). Ahora la evidencia se recorre por páginas de 25 (hasta 8) con procedencia; las contradicciones que S2 ya rechazó
  (`LINK_TERMINAL_MISMATCH`) se CUENTAN aparte, así se declaran aunque el approved propio salga en la primera página; y cada página se
  recorre entera. Pruebas: approved propio detrás de 30 ajenos + declined propio reciente → `APPROVED` + contradicción; sin approved propio
  → `DECLINED`, nunca «no cobrado».
- **P2 · MCP por solicitud.** El tope global de vínculos dejaba a otra solicitud con `attempts: []` y «completa». Ahora la ventana es POR
  SOLICITUD (`ROW_NUMBER() OVER (PARTITION BY "requestId")` ≤ 25, `$queryRaw`) y los conteos reales salen de un `groupBy`: `attemptsTotal`
  (aditivo) y `attemptsTruncated` sólo cuando falta algo. El backfill acota su `findMany` (`take: 25`, orden estable).
- **P2 · el receptor que perdió la propiedad.** Sus dos escrituras finales PENDING (`AMOUNT_MISMATCH`, `AWAITING_PAYMENT`) comprueban el
  conteo del CAS: con cero filas releen el desenlace DURABLE del evento y contestan ESO (`MATCHED`/`SECOND_CAPTURE`/`DISCREPANCY`/`ERROR`
  con `message: RESOLVED_BY_ANOTHER_OWNER`), nunca «huérfano».
- **P2 · una sola proyección monetaria.** `proyeccionMonetaria.ts` (`proyectarComisionYNeto`) la usan `createTransactionCost`, el diferido y
  `calculateNetSettlementAmount`: valores a la escala PERSISTIDA (4), comisión a 2, neto = importe − comisión. $1.11 al 2.25 %: 0.024975 →
  0.0250 → $0.03 / $1.08 en los TRES escritores — la prueba contra las escalas reales de Postgres destapó que la LIQUIDACIÓN escribía $1.09
  (importe − comisión sin redondear, redondeado por la columna): dos verdades para el mismo peso, ahora una.
- **P2 · segunda captura con provisionalidad.** La evidencia nacida del webhook lleva `registradoVia: 'webhook'` + `methodProvisional: true`
  en la raíz de `processorData`: el REST de B con débito enriquece sin contradicción, sigue PENDING y sin costo.
- **P2 · margen del reembolso.** El margen revertido sale de los COMPONENTES revertidos (los fijos no se devuelven en un parcial): devolver
  $55 de $110 revierte −0.275, no −0.375.
- **P3 · techo de reembolsos con continuación.** Agotado el presupuesto de páginas por ejecución, el efecto queda PENDIENTE
  (`REFUND_COSTS_CONTINUE_NEXT_RUN`) y el siguiente intento salta lo ya costeado. Sin prueba del techo de 10,000; la continuación la prueba
  el corte entre páginas (el 30.º reembolso truena → 29 costeados; el segundo cierre termina los 23 sin duplicar).
- **Las cinco críticas a las pruebas:** «ninguna contradicción» se comprueba en las LLAMADAS a `logAction` (mockeado en integración), no en
  la tabla; el costo REAL se ejercita de punta a punta (webhook repetido → REST débito internacional → `createTransactionCost` real con
  tarifas de la base, con y sin orden) en `webhookPrimerConfirmador.costoReal`; la unitaria de afiliación afirma la LIQUIDACIÓN de M2
  (llamada y escritura); la barrera de carrera IDENTIFICA su conexión y su bloqueador por pid (`pg_blocking_pids`), excluye a los que ya
  esperaban y siempre suelta el candado — una aserción fallida dejó antes una transacción `idle in transaction` cuatro minutos bloqueando la
  limpieza de la suite entera —; la prueba negativa del backfill ejecuta el backfill ella misma en vez de esperar 400 ms; y los 52
  reembolsos llevan un corte.
- **Verificación de la ronda (13-sep, tarde):** integración contra la base desechable — registrador 35 · costo real 5 · costo diferido 16 ·
  terminal 23 · webhook 29 · legacy 15 · worker 11 · socket 16 (**150/150**); unitarias — proyección 4 · afiliación 6 · reembolso 6 · costo
  16 · herencia 15 · diferido 5 · MCP 13 · webhook 39 · registroRepetido 7 · identidad 16 · discriminadores 5 · servicio de terminal 94 ·
  liquidación 34 · efectivo duplicado 16 · venta rápida 35 + 8 · liveDemo 20 · controlador 8; prettier limpio, eslint sin errores (2 avisos
  previos ajenos a la ronda); `typecheck:fast` 0.
- **Sabotajes de la ronda (`sab-r3.py`, 23, copia aislada; controles en verde): cada uno cae exactamente en su prueba.** R3-A búsqueda que
  se rinde tras la primera página (caen las dos de «once legacy») · R3-B discriminadores fuera de la consulta (guarda unitaria) · R3-C sin
  revalidación bajo el candado (caen «K1 y K2 esperan JUNTOS» y «devuelve null») · R3-D unicidad sin dueño · R3-E `exigeLlave: true` fijo en
  la consolidación (nacen tres) · P1-3-F sin congelar el slot · P1-3-G sin slot cae a PRIMARY · P1-3-H slot congelado ignorado · P1-3-I slot
  sin tarifa cae a PRIMARY · P1-3-J el diferido propaga en vez de dejar la obligación · P1-5-K la liquidación ausente termina igual · P1-5-L
  la obligación sin `lastError` · P2-M S6 una sola página · P2-N S6 se detiene en la primera contradicción · P2-O recorte del MCP sin
  declarar · P2-P ventana sin partición · P2-Q el receptor ignora el CAS · P2-R proyección sin escala persistida · P2-S el diferido con su
  aritmética · P2-V la liquidación con su propio neto · P2-W S6 sin el conteo de contradicciones · P2-T segunda captura sin provisionalidad
  · P2-U margen × ratio. 🔑 **P2-W no cayó a la primera**: la contradicción de la página 1 también la detecta el barrido, así que el conteo
  era defensa en profundidad hasta que una prueba lo aisló (approved propio reciente + 24 rechazos propios en la página 1
  - 30 contradicciones más antiguas ⇒ sólo el conteo la declara); con esa prueba cae. Por lo mismo P2-N ya no tumba la de la ronda 2 (el
    conteo la cubre): las dos capas están escritas en el código para que nadie borre una creyendo que la otra sobra.
- **Verificación pesada (avq-verify, 13-sep noche):** typecheck 5.8 **0 errores** (local y Alienware COINCIDEN,
  `run-avoqado-server.HoMJqI`); suite unitaria completa en 4 shards **17,072 pruebas / 0 fallos**, los cuatro COINCIDEN (4069 · 4698 · 3767
  · 4538; 14 saltadas de siempre); carpeta completa `tests/integration/payments` **17 suites / 333 pruebas** en verde contra la base
  desechable (`run-avoqado-server.RkHEOT`); API `terminal-payment-attempts` **6/6** COINCIDEN. 🔴 La primera pasada de los shards 1 y 3 cayó
  en DOS guardas de arquitectura — y las dos eran mías: el inventario de `findMany` sin tope tenía que ENCOGER (el backfill del webhook ya
  está acotado con `take: 25`) y la guarda de paginación estable no reconocía el `orderBy` con spread + `as const` de la búsqueda paginada
  (no «termina en `id`» para su analizador). Corregidos: inventario encogido y `orderBy` literal constante
  `[{ idempotencyKey: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'desc' }]` — con o sin llave en el entrante, porque
  los candidatos con OTRA llave se descartan igual (LLAVE) y traer primero los sin llave sólo acorta el recorrido, nunca cambia la elección
  (registrador 35 · legacy 15 · webhook 29 repetidas en verde). El `DIFIEREN` de esa primera pasada era el falso positivo del ORDEN
  documentado en el workspace (mismo fallo y mismos totales en los dos lados). Shards 1 y 3 repetidos: COINCIDEN, 0 fallos.
- **Cuarta auditoría de Codex:** lanzada con estos resultados (`prompt-codex-cp1-r4.txt`); el veredicto decide el push a `develop` y el
  arranque del checkpoint 2.

#### Lo que Codex exigió sobre el diseño de S0 + S3 (revisión de diseño, 13-sep 12:44) — y cómo se incorpora

- **P1-1 · Deduplicación por referencia.** Dos intentos DISTINTOS acreditados (llaves distintas) **nunca** se deduplican por referencia
  aunque coincidan solicitud, referencia, importe y afiliación: el arbitraje decide ganador/segunda captura. La referencia sin llave
  (legacy) exige además procesador, terminal (serial) y solicitud cuando estén disponibles; afiliación ausente no demuestra identidad. En
  venta rápida no se compara la orden materializada contra el `null` de la solicitud (rompería el reintento rápido sin llave). Pruebas:
  colisión A/B con referencia idéntica; reintento fast sin llave.
- **P1-2 · El `requestId` del payload no decide qué cobro se excluye de ventas.** Antes de clasificar se acredita venue, terminal (serial
  del JWT — el controlador sólo inyecta `deviceSerialNumber` cuando el body no lo trae, así que el serial autenticado viaja en un campo
  propio que el body no puede poner), orden y pertenencia del intento (si existe vínculo S1, debe coincidir). Una asociación inválida
  registra el cobro NORMAL sin ligar ni tocar al ganador ajeno, con 🚨.
- **P1-3 · Vales.** `lockAreaTicketCheckoutForPayment` rechaza una sesión ya pagada (409) y crea/modifica intentos: B quedaría fuera sin
  evidencia. Se conserva el prefijo `session → tickets → Order`, se toma después `TerminalPaymentRequest` y se decide; sólo el ganador
  ejecuta la preparación y los efectos de vales. Prueba A/B sobre una orden con vales, con B posterior a la finalización de A.
- **P1-4 · Rama completa de evidencia.** `Payment.orderId` es obligatorio: la evidencia cuelga de la orden VALIDADA del ganador (en venta
  rápida, la orden materializada por el ganador; nunca otra venta rápida pagada). Salida específica antes de allocations, costos, efectos,
  `Payment/APPLY` de la ruta integrada y las verificaciones que crea el controlador. El 2xx devuelve el Payment de B (contrato de respuesta
  conservado), nunca el de A. Pruebas: ausencia de Order nueva, turno sin incremento, sin VenueTransaction, sin allocations, sin efectos,
  sin APPLY.
- **P1-5 · Un solo protocolo de candados.** `closeRowFromPaymentTx` toma la SOLICITUD antes que el Payment (también desde el socket): nunca
  Payment → Request contra Request → Payment. Los retornos idempotentes (llave, referencia, P2002) REPARAN el vínculo si falta.
  `bound: true` = los dos vínculos escritos y el ganador real; un P2002 del índice del ganador no es un reintento por llave y nunca devuelve
  otro intento en silencio.
- **P2 · Índice parcial y `type NULL`**: `"type" <> 'REFUND'` excluía NULL; migración `20260913180000` con `IS DISTINCT FROM` (aplicada en
  desechable y `av-db-25`) y caso NULL en la prueba. **P2 · Costo**: nunca costo normal para una segunda captura; para un Payment nacido sin
  marca/método acreditados (webhook, S2) el costo queda PENDIENTE durable y recuperable (no depende de que vuelva el REST) y nunca se
  presenta como comisión cero. **P2 · S3**: la fusión es sobre valores VIGENTES (SQL `COALESCE` por columna y `entrante || processorData`
  con el existente ganando), comprobando el resultado y releyendo si pierde la condición; contradicciones de identidad intento/solicitud
  también se señalan. **P2 · compatibilidad**: se demuestra en ejecución (checkpoint 2 para la libreta con el SDK activo; S5 para despertar
  al POS) antes de desplegar.

### 🔴 Ronda 4 de la auditoría final de Codex (13-sep 18:05): RECHAZADO — 6 P1 (R4-1 · R4-2 · R4-3 · R4-4 · R4-5 · R4-6) · 7 P2 · 1 P3 · 1 crítica a las pruebas → todos cerrados con TDD y sabotajes (13-sep, noche)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r4-veredicto.md`. Cada hallazgo se verificó contra el código antes de aceptarlo
(los seis P1 eran reales; de la ronda 3 dio por CERRADOS P1-5, backfill, CAS, proyección, segunda captura provisional y margen, y por
PARCIALES R3-1, R3-2, P1-3, S6 y MCP). Los dos límites del founder se conservan: ningún arreglo interrumpe un cobro (lo que no se puede
demostrar se REINTENTA o queda PENDIENTE y visible) y ninguno abre un cobro doble, una venta perdida ni una venta sin cargo. Regla nueva que
sale de esta ronda: **la resolución por referencia DEMUESTRA o no demuestra — nunca crea a ciegas.**

- **R4-1 · el cursor sobre una llave MUTABLE.** La paginación ordenaba por `idempotencyKey` (que la propia consolidación escribe) con cursor
  `{ id }`: si otro escritor le acreditaba su llave al décimo candidato entre dos páginas, el undécimo desaparecía y el replay legítimo
  nacía como otra venta; y agotar las 100 páginas terminaba en «crear». Ahora `buscarRegistroPorReferencia` recorre DOS pasadas (sin llave,
  con llave) con KEYSET sobre columnas INMUTABLES (`createdAt desc, id desc`, predicado `(createdAt, id) <` sin cursor de Prisma), acepta
  `excluir` (candidatos que ya contradijeron) y, agotadas 1,000 páginas, devuelve `agotado: true` que el registrador convierte en **503
  reintentable** (`PAYMENT_REGISTRATION_UNRESOLVED_SEARCH_EXHAUSTED`, `RegistroNoResuelto` extiende `ServiceUnavailableError`): la terminal
  vuelve a mandar el mismo cobro y no nace un duplicado. Pruebas: unitarias de la FORMA (orden inmutable, predicado keyset de la segunda
  página, dos pasadas, `excluir` en la consulta, 1,000 páginas ⇒ agotado sin registro) y de integración (páginas llenas de candidatos ajenos
  ⇒ 503 y CERO Payments; la BARRERA que Codex pidió: entre la primera y la segunda página «otro escritor» acredita una llave al décimo y el
  undécimo se encuentra igual).
- **R4-2 · la consolidación INCIERTA y el presupuesto agotado.** El `catch` devolvía el existente sin haber comprobado nada y tres pérdidas
  de identidad seguían hacia «crear». Ahora `consolidarRegistroRepetidoDetallado` distingue CONSOLIDADO · CONTRADICE · DUENO · PERDIDO ·
  INCIERTO (la envoltura `consolidarRegistroRepetido` conserva la semántica de identidad FUERTE para los retornos por llave y por ganador),
  y `resolverPorReferencia` (presupuesto 5) sólo devuelve EXISTENTE con CONSOLIDADO o DUENO; PERDIDO vuelve a resolver; INCIERTO o
  presupuesto agotado ⇒ 503 reintentable (`…_CONSOLIDATION_UNCERTAIN` / `…_RETRY_BUDGET_EXHAUSTED`). **P2 de esta ronda:** la respuesta se
  arma con el Payment RESUELTO (recibo, cliente, vales del dueño durable), nunca con el candidato con el que se entró. Pruebas: la
  transacción del candado revienta ⇒ 503 sin Payment nuevo; cinco pérdidas ⇒ 503; DUENO ⇒ la respuesta lleva el id y el recibo del dueño.
- **R4-6 · la contradicción con identidad DÉBIL absorbía un cargo.** Misma referencia, importe, terminal y orden pero OTRA autorización (o
  tarjeta, modo de entrada, afiliación acreditada) devolvía «el existente»: el segundo cargo desaparecía. Ahora CONTRADICE excluye al
  candidato y sigue; sin candidatos que demuestren, es una **COLISIÓN DE REFERENCIA**: `Payment PENDING` con
  `processorData.reconciliation = { kind: 'POSSIBLE_REFERENCE_COLLISION', referenceNumber, candidates:[{paymentId, orderId, campos}] }`,
  colgado de la venta (en venta rápida, de la venta del candidato que contradijo: nunca otra venta), fuera de turno, VenueTransaction,
  efectos, costo y lealtad; 🚨 + `TERMINAL_PAYMENT_POSSIBLE_REFERENCE_COLLISION`; la respuesta a la terminal es 2xx con ESTE Payment, su
  recibo y `possibleReferenceCollision` (queda REGISTRADO en su libreta). `esEvidenciaDeConciliacion` (segunda captura O colisión) es lo que
  el controlador consulta para no crear SaleVerification. 🔑 La crítica de Codex a la prueba legacy era cierta y era del FIXTURE: la
  autorización se derivaba del `attemptId`, así que todo replay «legacy» llegaba con OTRA autorización. Un reintento real repite la del
  banco: ahora se deriva de la REFERENCIA (`AUTH-<ref>`), y los nueve replays que dependían de ese accidente siguen verdes por la razón
  correcta. Pruebas: colisión con orden y en venta rápida (PENDING, candidatos, bitácora, el original intacto, la orden pagada UNA vez, sin
  efectos); el replay real (misma auth) sigue siendo uno; un candidato que contradice no tapa al que sí es este cobro; unitaria de
  `tipoDeEvidencia`.
- **R4-3 · `pricingSlot` no congelaba nada.** `getEffectivePricing` ignoraba la fecha y una etiqueta de slot apunta a la tarifa que HOY
  ocupa ese slot (sustituir la afiliación del slot, o editar la tarifa en sitio, cobraba 8 % sobre un cargo contratado al 2.5 %). Ahora
  `getEffectivePricing(venueId, accountType?, at)` evalúa la vigencia A LA FECHA (y `findActiveVenuePricingStructure` la pasa); el
  registrador congela, junto al slot, las TASAS de la afiliación acreditada (`tarifaCongeladaDeLaAfiliacion` → `processorData.pricing`:
  slot, estructura del negocio con origen/accountType/tasas/ IVA/fijo, y estructura del proveedor con tasas/fijo; en altas normales, segunda
  captura y colisión); `createTransactionCost` usa el snapshot si existe y es de la MISMA afiliación (`tarifaCongeladaDelPago`), con los ids
  sólo como trazabilidad (a null si la fila ya no existe); sin snapshot sigue el camino de la ronda 3 (slot congelado, a la fecha del
  cobro). Pruebas: unitarias (el snapshot manda aunque hoy M2 sea PRIMARY y M3 ocupe SECONDARY al 8 %; la edición en sitio tampoco lo
  cambia; un snapshot de otra afiliación se ignora; sin snapshot la tarifa se pide con `createdAt`; el resolvedor congela slot, tasas y
  fecha; `getEffectivePricing` con fecha en la consulta, venue y organización) y de integración con tarifas REALES (M2 cobró como SECONDARY
  2.5 % → M3 pasa a SECONDARY, la fila se edita al 8 % y M2 a PRIMARY → el diferido cobra 2.5 %; el REST también congela y su costo síncrono
  las usa).
- **R4-4 · el REST sin obligación de costo.** El nuevo motivo (`COST_PENDING_AFFILIATION_PRICING_UNRESOLVED`) sólo era obligación en el
  diferido; por REST se registraba en un log y el cobro quedaba con comisión cero para siempre. Ahora `encolarObligacionDeCosto` encola el
  efecto `TRANSACTION_COST` DENTRO de la transacción financiera para TODO cobro COMPLETED que no sea efectivo (`ASSURE_COST` con plazo «ya»;
  el del webhook conserva `AWAITING_ACCREDITED_CARD_DATA`); el cálculo síncrono, si termina, CIERRA la obligación (`cerrarObligacionDeCosto`
  → DONE) y, si falla, la anota (`anotarCostoNoCalculado`: `costPending: true` + `lastError` = `AFFILIATION_PRICING_UNRESOLVED` o
  `TRANSACTION_COST_FAILED`) para que el worker la retome y converja. Dos guardas contra la carrera con el worker (que reclama `PENDING` con
  `nextAttemptAt ≤ ahora`): la obligación del REST nace con su primer intento un minuto después (el cálculo síncrono de la misma petición la
  cierra antes; el worker sólo la toma si no lo hizo), y si al fallar el cálculo síncrono el costo YA existe (otro escritor lo persistió),
  no se marca `costPending`: la obligación se cierra. Pruebas: REST normal ⇒ efecto DONE en la misma llamada; afiliación retirada ANTES de
  cobrar ⇒ COMPLETED sin costo, obligación PENDIENTE y visible con su primer intento a un minuto, `costPending`, y converge al devolver la
  afiliación (venta rápida y orden); efectivo ⇒ sin obligación; unitarias de anotar/cerrar (motivos, costo ya existente, nunca lanzan).
- **R4-5 · el vínculo tardío durante el matcher débil.** El sello débil (evento PROCESSED sobre un Payment sin llave del mismo segundo) no
  volvía a mirar S1 y un vínculo que llegara después no reencolaba nada: el intento real se quedaba sin confirmación. Ahora la rama MATCHED
  toma el candado del evento (`/* evento */ FOR UPDATE`) y vuelve a consultar el vínculo DENTRO de la transacción: con vínculo, confirma por
  él; sin vínculo, sella bajo el candado (y el resultado del CAS decide la respuesta). Y
  `recuperarEventosDebilesPorVinculo(attemptId, requestId)` —llamada desde `handleAttemptOpenedFromSocket` sólo con un vínculo NUEVO, nunca
  sobre el ACK— toma el candado de los eventos del intento y REABRE los PROCESSED sellados sobre un Payment cuya llave no es el intento
  (PENDING, `LINK_ARRIVED_AFTER_WEAK_MATCH`, sin Payment, `nextAttemptAt` ya, reclamo limpio); el Payment equivocado conserva la huella como
  `angelpayWebhookRevoked` (nunca se borra evidencia). El candado serializa las dos carreras (sello ↔ vínculo). Pruebas: sello débil sobre
  B legacy → vínculo de A → evento reabierto, B revocada, el worker confirma A por el vínculo (2 Payments, fila COMPLETED por webhook);
  carrera con la comprobación previa ciega → bajo el candado se ve el vínculo y B queda intacta; evento sellado sobre el Payment correcto y
  vínculo repetido (ALREADY_LINKED) no tocan nada; socket: la recuperación se dispara sólo con vínculo nuevo y su fallo no rompe el ACK;
  unitarias del candado y de la re-consulta.
- **P2 · el fallo del registrador ignoraba el CAS** (L514): ahora pasa por `desenlaceDurableSiPerdioLaPropiedad` (prueba con otro dueño que
  ya terminó el evento ⇒ `MATCHED · RESOLVED_BY_ANOTHER_OWNER`). **P2 · calendario de liquidación**: `projectPaymentSettlement` usa
  `proyectarComisionYNeto` (comisión a 2 decimales, neto = bruto − comisión; prueba $1.11). **P2 · S6 exacto**: la evidencia se resuelve en
  UNA consulta SQL (CTE) sin presupuesto de páginas — contradicciones (`LINK_TERMINAL_MISMATCH` o serial normalizado EN SQL con la misma
  regla que `terminalIdentityKey`), último approved propio y último veredicto propio; 🔑 la prueba existente «ganó por webhook» destapó la
  lógica trivalente de SQL (`"errorReason" = 'X'` es NULL en un evento sano y anulaba la contradicción entera): `IS NOT DISTINCT FROM`.
  Pruebas: 300 ajenos + 49 rechazos propios + 1 approved propio antiguo ⇒ APPROVED con su fecha, una sola consulta; el serial propio con
  prefijo y otra caja no es contradicción. **P2 · MCP**: `attemptsRequestId` + `attemptsAfter` recorren TODOS los intentos de una solicitud
  (25 por página, keyset `(createdAt, attemptId)`, `attemptsNextCursor`, cursor ajeno rechazado). **P2 · `list_payment_effects`**:
  `TRANSACTION_COST` consultable y los motivos `AWAITING_SETTLEMENT_CONFIGURATION` · `AFFILIATION_PRICING_UNRESOLVED` ·
  `REFUND_COSTS_CONTINUE_NEXT_RUN` · `TRANSACTION_COST_FAILED` visibles (son obligaciones del negocio, no «requiere revisión»). **P3 ·
  reembolsos**: los ya costeados se excluyen EN LA CONSULTA (`transactionCost: { is: null }`), keyset `(createdAt, id)` y presupuesto
  configurable (`DEFERRED_COST_REFUND_PAGE` / `DEFERRED_COST_REFUND_MAX_PAGES`); la prueba corta AL AGOTAR páginas (10 por página, 2 por
  ejecución, 52 reembolsos ⇒ 20 · 20 · 12, cada reembolso costeado UNA vez).

**Verificación de la ronda 4:** `typecheck:fast` (TS 7) 0 errores; 17 archivos unitarios tocados o guardas de arquitectura 158/158
(discriminadores 8 · evidencia 3 · lectura de efectos 5 · afiliación 12 · herencia · calendario · MCP efectos 3 · MCP terminales 3 nuevas ·
webhook unit 41 · fecha de tarifa 3 · guardas `findManySinTope`, `pagination-stability`, `rawSqlDateBind`, `catalog-no-internals`);
integración de pagos 8 suites / **176** pruebas (registrador 44 · costo real 11 · webhook 33 · terminal 26 · costo diferido 18 · legacy 15 ·
worker 11 · socket 17) contra la base desechable; prettier y eslint limpios (las 2 advertencias preexistentes); **29 sabotajes en copia
aislada, 29/29 caen cada uno en su(s) prueba(s)** (`sab-r4.py`, `sab-r4.txt`: controles en verde — registrador 44 · costo real 11 · costo
diferido 18 · terminal 26 · webhook 33 · socket 17 y 8 archivos unitarios; entre ellos: sin el predicado keyset la búsqueda se agota y los
«once legacy» de R3-1 reciben 503 en vez de encontrar a la vieja; sin la segunda pasada, el replay legacy de un cobro con llave crea otro;
el catch genérico devolviendo el existente vuelve a confirmar un candidato sin validar; la contradicción absorbida hace desaparecer los tres
cobros de R4-6; el costo sin snapshot cobra el 8 % de hoy; sin obligación el REST queda con comisión cero; sin la re-consulta bajo el
candado la carrera del vínculo sella sobre B; sin la recuperación el evento sigue PROCESSED sobre B; el serial sin normalizar convierte al
propio con prefijo en contradicción; los reembolsos ya costeados vuelven a entrar y el corte entre páginas duplica; el presupuesto sin
entorno termina en una sola ejecución; la obligación del REST reclamable de inmediato y el `costPending` sobre un costo ya existente caen en
las suyas). **Verificación pesada por `avq-verify` sobre el árbol FINAL (DUAL: Mac y Alienware, 13-sep noche):** typecheck 5.8 **0 errores,
COINCIDEN**; suite unitaria completa en 4 shards **17,090 pruebas / 0 fallos, los cuatro COINCIDEN** (359+357+358+358 suites; 14 skipped);
integración de pagos completa (local, base desechable) **17 suites / 357 pruebas / 0 fallos**; API `terminal-payment-attempts` 6/6 COINCIDEN
(tras apuntar su doble de evidencia a la consulta SQL de S6); las dos sondas de carga de catálogo que salieron rojas SÓLO en el Alienware en
la primera corrida (`catalogImportDurableEventLoop` y `catalogImportCanonical`, sin cambios contra HEAD) pasaron 5/5 en serie DUAL — la
contaminación de carga documentada, no el código. 🔴 La primera corrida pesada destapó TRES dobles unitarios que pasaban por la forma vieja
del código, todos apretados sin debilitar nada: la guarda `paymentShiftClaim.callers` exige declarar CADA `payment.create` (la evidencia de
colisión entra al manifiesto como `exclude`, igual que la segunda captura); `payment.cash-duplicado` distinguía la búsqueda por referencia
por `where.referenceNumber` (ahora vive en `where.AND[0]`, y su doble devolvía la ráfaga como candidatos); y `fastPaymentCustomer` dependía
de que la consolidación devolviera «el existente» cuando su Prisma simulado hacía fallar el candado — justo el comportamiento que R4-2
retira (ahora declara CONSOLIDADO con el candidato: mide el customerLink, no la consolidación).

### 🔴 Ronda 5 de la auditoría final de Codex (13-sep 20:11): RECHAZADO — 6 P1 (R5-1 · R5-2 · R5-3 · R5-4 · R5-5 · R5-6) · 5 P2 · 1 P3 → todos cerrados con TDD y sabotajes (13-sep, noche)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r5-veredicto.md`. De la ronda 4 dio por CERRADOS R4-1 y R4-2 y por PARCIALES R4-3
a R4-6 (cada parcial es uno de los P1 de abajo); todos los P2/P3 de la ronda 4 y la crítica a las pruebas, CERRADOS. Los seis P1 se
verificaron contra el código antes de aceptarlos y los seis eran reales. Los dos límites del founder se conservan: nada interrumpe un cobro
(lo que no converge queda PENDIENTE y visible, o la terminal reintenta) y nada abre un cobro doble, una venta perdida ni una venta sin
cargo.

- **R5-1 · la contradicción reparaba la solicitud.** `consolidarRegistroRepetidoDetallado` corría `closeRowFromPaymentTx` ANTES de devolver
  CONTRADICE: un legacy B con la misma referencia y OTRA autorización quedaba como ganador de la solicitud Q, y el cargo real K2 llegaba
  después como «segunda captura». Ahora la reparación exige `plan.contradicciones.length === 0` (un candidato que contradice no es el cargo
  de la solicitud). Pruebas (registrador): venta rápida — B legacy; K1 con `requestId` Q y sin vínculo ⇒ evidencia, Q sigue SENT sin
  `paymentId` y B sin `terminalPaymentRequestId`; K2 con `requestId` Q nace COMPLETED y gana Q; con orden — la colisión tampoco liga Q.
- **R5-2 · la tarifa se congelaba ANTES del TIER-2.** En las dos rutas `tarifaDeLaAfiliacion` corría con el `merchantAccountId` que mandó el
  APK, antes de que TIER-2/3 lo sustituyera por el resuelto por serial: snapshot (slot y tasas) de M1 en un Payment atribuido a M2 — y como
  `tarifaCongeladaDelPago` exige la MISMA afiliación, el diferido caía al `pricingSlot` de M1 (PRIMARY 8 %) en cuanto M2 saliera de la
  configuración. Ahora se congela DESPUÉS del bloque TIER-1/2/3 sobre la afiliación definitiva (sin afiliación ⇒ sin snapshot). Pruebas
  (costo real): merchant inexistente + serial ⇒ M2 con snapshot de M2 (SECONDARY 2.5 %) y costo síncrono $3; merchant INACTIVO recuperado a
  M2, costo síncrono borrado (simula el proceso muerto) y M2 retirada de la configuración ⇒ el diferido cobra 2.5 % (con el snapshot de M1
  salían $8.50).
- **R5-3 · «existe la fila del costo» no es «obligación cumplida».** La venta rápida descartaba `{ feeAmount, netAmount }` (Payment y
  VenueTransaction con comisión 0 y la obligación DONE) y `createTransactionCost` absorbía la liquidación faltante (warn y éxito). Ahora hay
  UN solo criterio de cumplimiento: `convergerCostoDeTransaccion(payment)` (extraído del worker: costo persistido → proyecciones en Payment
  y VenueTransaction → liquidación → reembolsos → `costPending: false`) y `asegurarCostoSincrono` lo usa en las dos rutas: cierra la
  obligación SÓLO al converger; si no, queda PENDIENTE con motivo (`AWAITING_SETTLEMENT_CONFIGURATION` · `AFFILIATION_PRICING_UNRESOLVED` ·
  `TRANSACTION_COST_FAILED`) y `costPending` si además no hay costo persistido. `anotarCostoNoCalculado` ya NO cierra la obligación cuando
  existe la fila (la cierra el worker al converger). **P2-e · guard atómico:** `marcarCostPendingSiNoHayCosto` es UN
  `UPDATE … WHERE NOT EXISTS (TransactionCost)` — sin ventana entre «comprobar» y «escribir». Pruebas (costo real): venta rápida por REST ⇒
  8.5 / 91.5 en Payment y VenueTransaction, liquidación y DONE; con orden igual; sin configuración de liquidación ⇒ costo y proyecciones
  persistidos, obligación PENDING/`AWAITING_SETTLEMENT_CONFIGURATION`, converge al configurarla; el fallo síncrono con costo existente no
  marca `costPending` ni cierra. Unit: la forma del SQL (`NOT EXISTS`), 0 filas ⇒ no cierra.
- **R5-4 · candado + S1 en las TRES ramas débiles.** Helper único `escribirPorIdentidadDebil` (candado `FOR UPDATE` del evento → releer el
  vínculo de la llave → CAS del dueño → huella sólo si el reclamo aplicó) para el sello MATCHED, el cruce de comercio, la discrepancia y el
  backfill (`llaveDelIntento` = la llave del evento cuando no es la del propio Payment). Con vínculo bajo el candado: `decidirPorElVinculo`
  en el receptor (confirmar por el vínculo o PENDING/AWAITING_PAYMENT) y «se deja al worker» en el backfill. El cruce y la discrepancia
  pasan además a respetar el CAS del dueño (antes escribían sin mirar el resultado). Pruebas: 6 unitarias (orden candado → S1 → escritura, y
  «con vínculo no se escribe», por rama) y 3 carreras de integración (discrepancia ⇒ AMOUNT_MISMATCH contra el contrato de la solicitud y B
  sin `angelpayDiscrepancy`; cruce ⇒ CONFIRMED por el vínculo y B sin huella; backfill ⇒ el evento sigue PENDING para el worker y B sin
  huella).
- **R5-5 · la reapertura es DURABLE.** Vínculo y reapertura en UNA transacción
  (`recuperarEventosDebilesPorVinculo(attemptId, requestId, tx)`): no existe vínculo sin reapertura; si la reapertura falla, el INSERT se
  revierte y el handler falla (la terminal reintenta el anuncio — el ACK sólo llega con lo durable). ALREADY_LINKED también vuelve a mirar
  (idempotente, fuera de la transacción, sin tocar el ACK). La prueba del socket que «codificaba la pérdida» se reescribió, y la de «la
  cancelación entre la lectura y la escritura» inyecta ahora dentro de la transacción del vínculo. Pruebas: webhook — reapertura caída ⇒ sin
  vínculo y evento intacto sobre B, al reintentar vínculo + reabierto; socket ×2.
- **R5-6 · `type` NULL.** `SIN_REEMBOLSOS = { OR: [{ type: null }, { type: { not: 'REFUND' } }] }` en la búsqueda por referencia (dentro del
  `AND` de la base) y en la comprobación «¿aterrizó mi cobro?» de la delegación; el cruce de comercio del webhook igual. Pruebas: replay
  legacy con `type` NULL (venta rápida y orden) ⇒ uno solo; unit de la forma. Declarado FUERA del checkpoint (misma clase, otros dominios):
  `priorCompletedPayments.ts`, `blumon-webhook.service.ts`, dashboards.
- **P2 · colisión reconocida en `confirmarPorVinculo` y en S6.** `tipoDeEvidencia` ⇒ acción `REFERENCE_COLLISION`, motivo
  `POSSIBLE_REFERENCE_COLLISION`, nunca `firstConfirmer`; el desenlace durable lo mapea igual; S6 `REFERENCE_COLLISION_EVIDENCE` (aditivo:
  el valor es nuevo y nadie lo consumía). Prueba: K1 con llave y sin vínculo contradice a B ⇒ evidencia con la llave K1; después vínculo +
  approved ⇒ PROCESSED/POSSIBLE_REFERENCE_COLLISION sobre la evidencia, la solicitud sigue sin ganador, un solo COMPLETED, S6 lo dice. 🔴
  **Decisión NO tomada a propósito** (diseño con Codex/founder antes de codificar): promover esa evidencia a venta cuando la identidad
  fuerte llega después — hoy queda como evidencia visible con 🚨, que no es cobro doble ni venta perdida ni venta sin cargo.
- **P2 · cliente sobre evidencia.** `ordenPropia(registro)` ⇒ `null` cuando lo devuelto es evidencia (segunda captura o colisión) en los
  tres retornos idempotentes de la venta rápida: el cliente no se liga a la venta del CANDIDATO. Unit.
- **P2 · revocación por IDENTIDAD + historial.** `reabrirEventosDebiles` sólo revoca si la huella vigente es de ESTE evento (`eventId`; una
  huella vieja sin `eventId` cuenta por `integratorReference`), apila en `angelpayWebhookRevocations` y deja la última en
  `angelpayWebhookRevoked`; el backfill estampa `eventId`. Pruebas: la huella de OTRO evento (el webhook legacy del propio B) no se revoca;
  dos reaperturas sobre B ⇒ dos revocaciones.
- **P2 · validador estricto del snapshot.** Una tasa es un número finito o una cadena numérica no vacía (null, booleanos y `''` ya no valen
  0 o 1); cargo fijo e IVA número o null. Unit ×9.
- **P3 · trim canónico.** `PATRON_SQL_TRIM_COMO_JS` (la misma clase de espacios que `String.prototype.trim`) en el SQL de S6. Prueba: tab,
  LF, NBSP y BOM alrededor del serial ⇒ propio, no contradicción.

**Verificación de la ronda 5:** `typecheck:fast` (TS 7) 0 errores; los 5 archivos unitarios tocados 47 · 6 · 22 · 36 · 8; integración de
pagos completa contra la base desechable **17 suites / 376 pruebas** (registrador 48 · costo real 17 · webhook 40 · socket 18 · terminal 27
· las otras 12 suites 226); prettier y eslint limpios (las 2 advertencias preexistentes); **22 sabotajes en copia aislada (`sab-r5.py`,
`sab-r5.txt`)** — cada uno cae en su(s) prueba(s), 22/22 (controles en verde: registrador 48 · costo real 17 · webhook 40 · socket 18 ·
terminal 27 y los 5 archivos unitarios). 🔑 Lección operativa: `npx jest --selectProjects unit <ruta>` corre el proyecto ENTERO —
`--selectProjects` es variádico y se traga la ruta como nombre de proyecto; un archivo se corre con `--runTestsByPath`. **Verificación
pesada por `avq-verify` sobre el árbol FINAL (DUAL: Mac y Alienware, 13-sep 21:19-21:47):** typecheck 5.8 **0 errores, COINCIDEN**; suite
unitaria completa en 4 shards **17,108 pruebas / 0 fallos, los cuatro COINCIDEN** (4,098 + 4,702 + 3,776 + 4,532; 359+357+358+358 suites, 14
skipped); integración de pagos completa (local, base desechable) **17 suites / 376 pruebas / 0 fallos**; API `terminal-payment-attempts`
**6/6 COINCIDEN**. Las seis corridas avisaron `⚠️ vigencia` (el árbol compartido se movió), pero se midió que **ningún archivo del
checkpoint —ni ningún otro del árbol— cambió su mtime entre el arranque y el final de la cadena**: el veredicto describe el código actual.

### 🔴 Ronda 6 de la auditoría final de Codex (13-sep 22:06): RECHAZADO — 3 P1 (R6-1 · R6-2 · R6-3) · 6 P2 → todos cerrados con TDD y sabotajes certificados (13/14-sep)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r6-veredicto.md`. De la ronda 5 dio por CERRADOS R5-1, R5-2, R5-3 (rutas
denunciadas), R5-5, R5-6, P2-a/b/c y P3, y por PARCIALES R5-4 (⇒ R6-3), P2-d y P2-e. Los tres P1 se verificaron contra el código antes de
aceptarlos y los tres eran reales. R6-2 era un MECANISMO NUEVO, así que —regla del founder tras los tres rechazos del 13-sep— se diseñó CON
Codex antes de codificar: `prompt-codex-diseno-r6-2.txt` → `codex-diseno-r6-2-respuesta.md` (a–l: todo ACEPTADO CON CAMBIOS salvo (g),
RECHAZADO y rehecho como exigió). Los dos límites del founder se conservan.

- **R6-1 · el reintento buscaba con la afiliación que MANDÓ el APK.** La deduplicación por referencia (S0-a) exigía «misma afiliación» con
  el `merchantAccountId` crudo del payload, pero el primer registro se había guardado con la afiliación DEFINITIVA (TIER-2/3, recuperada por
  serial): un replay legacy idéntico (M1 inactiva + serial que acredita M2) no encontraba su Payment y creaba OTRA venta COMPLETED — una
  autorización, dos ventas. Ahora `resolverAfiliacionDelCobro` corre en las dos rutas ANTES de la deduplicación (DIRECTA · POR_SERIAL ·
  RECUPERADA_POR_SERIAL · INACTIVA_ACREDITADA_POR_WEBHOOK · SIN_RESOLVER · SIN_AFILIACION) y esa única identidad se usa en el filtro, la
  consolidación y el registro; el valor del APK se conserva como evidencia (`merchantAccountIdFromApk` + `merchantResolvedVia`); una
  resolución INCIERTA (la base falla al buscar por serial) rechaza con `RegistroNoResuelto('AFFILIATION_RESOLUTION_UNCERTAIN')` (503
  reintentable), nunca «sin afiliación». Pruebas (costo real): venta rápida y orden — primer registro (merchant inexistente/inactivo +
  serial de M2) nace atribuido a M2; el replay IDÉNTICO sin llave devuelve el MISMO Payment y no crea otro movimiento financiero; la
  resolución incierta no crea nada.
- **R6-2 · un evento insertado DESPUÉS de la consulta del vínculo se sellaba sobre otro Payment.** El candado de fila no cubre una fila que
  aún no existe: L publicaba el vínculo y consultaba eventos (ninguno); el receptor insertaba E y el escritor débil lo sellaba sobre B
  leyendo un S1 todavía invisible; L commiteaba con ACK. Diseño (Codex): **exclusión por intento** — `candadoDeIntento`
  (`src/services/tpv/candadoDeIntento.ts`): `pg_advisory_xact_lock(NS::int, hashtext(llave))` en un namespace reservado (`7_310_113`,
  espacio de dos llaves separado de los advisory de una llave del repo), `SET LOCAL lock_timeout` (8 s por defecto, por debajo de los 10 s
  de Prisma; `TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS`) en su propia sentencia y la lectura de S1 en otra (fotografía nueva bajo READ COMMITTED).
  Lo toman como PRIMERA sentencia la publicación del vínculo (dentro de su transacción, antes del INSERT), la reapertura idempotente
  (ALREADY_LINKED, transacción propia) y TODO escritor débil con llave (sello, cruce, discrepancia, backfill). Si vence: la transacción
  entera revierte — el vínculo no se escribe (la terminal reintenta el anuncio) y el escritor débil no sella (E conserva su estado durable).
  Orden exigido y fijado por una **guardia estática** (`tests/unit/architecture/candadoDeIntentoOrden.guard.test.ts`): vínculo = advisory →
  INSERT → eventos `(createdAt, id)` FOR UPDATE → Payments DISTINTOS en `id ASC` `FOR NO KEY UPDATE` → revocaciones (dos reaperturas con
  Payments compartidos en orden inverso ya no pueden interbloquearse); escritor débil = advisory → evento → S1 → CAS → huella. La MISMA
  normalización (`llaveDeIntento`: trim, ≤ 64) al persistir `ProviderEventLog.attemptId`, al bloquear y al consultar. Pruebas de
  intercalación (webhook, 4) con `pg_locks`/`pg_blocking_pids` identificando PID bloqueador, bloqueado y llave: (T1) el vínculo consultó
  (ninguno) y no commiteó, llega el approved débil ⇒ el escritor ESPERA el advisory de L; al commitear ve el vínculo y confirma A por él (B
  intacta, A con su venta y su solicitud, sin otro anuncio); (T2) la inversa: el escritor sella E sobre B sin commitear, L espera; al
  commitear, L reabre E y el worker confirma A; (T3) timeout con el advisory tomado por otra transacción: `publicar` y
  `processAngelPayWebhook` vencen sin escribir (sin vínculo, E PENDING, B sin huella), y el anuncio REPETIDO (ALREADY_LINKED) también vence;
  libre, recuperación completa; (T4) A1 sobre B1/B2 y A2 sobre B2/B1 a la vez (segunda terminal) ⇒ sin interbloqueo, los cuatro eventos
  reabiertos y cada Payment revoca EXACTAMENTE su sello vigente (R5 P2: por identidad). Unit: el advisory precede al `FOR UPDATE` del evento
  con la llave normalizada y la espera acotada.
- **R6-3 · la discrepancia DÉBIL quedaba ERROR aunque el vínculo demostrara el cargo.** `reabrirEventosDebiles` reabre también
  `ERROR/AMOUNT_MISMATCH` con `paymentId` (juzgada contra OTRO Payment), revoca `angelpayDiscrepancy` por identidad del evento (la
  discrepancia estampa `eventId`, en receptor y backfill) y apila `angelpayDiscrepancyRevocations`; los rechazos bancarios (`NOT_APPROVED`)
  y la discrepancia por identidad FUERTE (PENDING sin `paymentId`) no se tocan. Pruebas: B legacy $100 ref R, approved de A por $105.50 ⇒
  discrepancia débil sobre B; S1 de A→Q ($105.50) ⇒ reabierta, B sin `angelpayDiscrepancy` (revocada con historial), el worker confirma A
  por $105.50; un declined y una discrepancia fuerte siguen como estaban.
- **P2 · `costPending` con UN criterio + P2-e remanente + la unidad de convergencia (diseño B de Codex, (f)/(g)/(h)/(i)).** Codex RECHAZÓ el
  mutex sostenido por una transacción mientras el trabajo usaba el cliente global (escrituras tardías tras vencer; pool agotado). Ahora
  `convergerCostoDeTransaccion` es UNA transacción real por lote acotado: la fila del Payment con `FOR NO KEY UPDATE NOWAIT` como primera
  sentencia (el mutex es la fila que ya existe; **NO KEY** —no `FOR UPDATE` como propuso Codex— para no bloquear los INSERT ajenos que
  referencian el Payment por FK: recibo, reembolso, efecto; misma fuerza que la reapertura) → relectura BAJO el candado → costo
  (`createTransactionCost(paymentId, tx)`) → proyecciones → liquidación (`calculatePaymentSettlement(…, tx)`) → reembolsos
  (`createRefundTransactionCost(…, tx)`, lote acotado que se confirma y continúa) → `costPending` y la transición AUTORIZADA de la
  obligación (REST sólo PENDING; worker con `id` + `claimToken`) dentro de la misma unidad. Todo con el MISMO `tx`
  (`transactionCost.service` y `settlementCalculation.service` reciben `db`). La CONTENCIÓN (55P03) es un desenlace propio
  (`CONTENDIDO`/`CONTENDIDA`): no converge, no cambia `costPending`, no cierra; el worker reprograma sin consumir intento.
  `costPending: true` NACE con la obligación en la transacción financiera de las dos rutas (el `NOT EXISTS` desapareció); «convergió» es
  cumplimiento DURABLE (`false` sólo con todo escrito); `NO_APLICA` explícito. (i): sin VenueTransaction (`updateMany.count !== 1` o
  relectura `null`) ⇒ PENDIENTE `VENUE_TRANSACTION_MISSING`, nunca convergida. Pruebas (costo diferido): contención REST ⇒ `CONTENDIDA` sin
  costo, marca intacta y obligación PENDING, después converge; contención WORKER ⇒ `false` sin tocar su reclamo, después DONE con su token;
  **presupuesto VENCIDO** (Codex (h)): la primera corrida se queda a media unidad con 300 ms, la segunda contiende y luego converge, la
  escritura TARDÍA de la primera falla contra su transacción cerrada y NO revierte `costPending: false` ni DONE; VT ausente ⇒ PENDIENTE con
  motivo, converge al existir. (costo real): `costPending` nace true cuando la unidad síncrona falla por un error operativo (venta rápida y
  orden). Unit: NOWAIT como primera sentencia; contención ≠ fallo.
- **P2-d remanente · `"0x10"`.** El validador del snapshot exige un decimal estricto (`DECIMAL` regex + finitud tras convertir):
  hexadecimal, binario, `12abc`, infinito por longitud, vacío y espacios se rechazan; `1e2` como cadena vale.
- **P2 · la prueba del backfill era no determinista (200 ms).** Ahora captura la promesa REAL del lanzamiento fire-and-forget con un espía
  instalado ANTES del REST y la espera antes de instalar el `mockResolvedValueOnce(null)`.
- **(l) · runner CERTIFICADO** (`sab-r6.py`): control en verde sobre las suites ENTERAS (sin `-t`: una caída colateral en cualquier prueba
  del archivo se ve y tiene que estar declarada); huella HEAD + sha256 del WIP (diff de `src/tests/prisma` + CONTENIDO de los archivos
  nuevos sin seguimiento) + sha256 del propio runner en cada resultado; cada subcadena declarada se resuelve a EXACTAMENTE una prueba de las
  suites que corre su sabotaje, y TODAS se validan antes de mutar nada (una ambigua invalida el manifiesto); la copia aislada se comprueba
  byte a byte contra el árbol y cada mutación (uno o varios archivos) se revierte y se verifica; una caída por TIMEOUT, hook o error que no
  es de aserción NO elimina al mutante (INCONCLUSO); selección vacía, «Test suite failed to run» sin pruebas caídas y totales que no cuadran
  con el detalle ⇒ INCONCLUSO (si un hook cae DESPUÉS de las pruebas y Jest omite la lista ✓/✕, las caídas se reconstruyen sólo de los
  bloques de aserción y sólo si cuadran con el total); veredicto por sabotaje = cayó al menos una · todas las caídas declaradas · todas las
  declaradas cayeron; resultados JSON (`sab-r6-resultados.json`, con la mutación aplicada) + log íntegro por sabotaje (`sab-r6-logs/`). 🔑
  Tres lecciones del runner: (1) las pruebas de contención se escriben con una CARRERA (`Promise.race` de 3 s ⇒ `'BLOQUEADA'`) para que un
  mutante sin `NOWAIT` caiga por aserción y no por el timeout de Jest — con el timeout, además, la corrida bloqueada seguía viva durante la
  limpieza y tumbaba el hook; (2) quitar SÓLO el candado del vínculo no es una mutación: la reapertura (que el vínculo llama dentro de su
  transacción) lo vuelve a tomar —reentrante— antes de consultar los eventos; la certificable es «el camino del vínculo NUNCA toma el
  candado» (vínculo + reapertura), y el orden «candado ANTES del INSERT» lo fija la guardia estática; (3) ampliar sólo el filtro de la
  reapertura a cualquier ERROR tampoco alcanza a un declined (no tiene Payment: defensa estructural) — la mutación certificable es «alguien
  reabre también los ERROR sin Payment». Sabotajes nuevos: el camino del vínculo sin candado; el escritor débil sin candado; la reapertura
  idempotente sin candado; Payments sin orden; S1 leído ANTES del candado; mutex sin NOWAIT; `costPending` sin nacer; cierre del worker
  fuera de la unidad; VT ausente leída como convergida (dos capas); contención leída como convergencia; la reapertura tocando ERROR sin
  Payment; más los de R6-1 y R6-3 y los de la ronda 5 reanclados a la unidad.

**Verificación de la ronda 6:** integración de pagos (base desechable): registrador 48 · costo real 22 · costo diferido 22 · webhook 46 ·
socket 18 · terminal 27; unit: webhook 47 · obligación 7 · afiliación 25 · guardia estática 6 · cliente rápido 36 · discriminadores;
prettier y eslint limpios en lo tocado; 36/36 sabotajes CERTIFICADOS en copia aislada (`sab-r6.py`: huella HEAD 03e7ac38 + WIP sha256
a7bbb25ef03b6bc4; corrida completa `sab-r6.txt` 32/36 + repetición acotada `sab-r6-parcial2.txt` 4/4 sobre la MISMA huella tras corregir
cuatro declaraciones/mutaciones del manifiesto —R5-I/R5-J truenaban en vez de fallar por aserción; R5-L y R6-F tumbaban además una prueba no
declarada que sí es consecuencia legítima—; JSON `sab-r6-resultados.json` con la mutación por sabotaje y `sab-r6-logs/` con la salida
íntegra; 124 declaraciones, cada una resuelta a UNA prueba; controles en verde con las suites ENTERAS: registrador 48 · costo real 22 ·
costo diferido 22 · webhook 46 · socket 18 · terminal 27 · unit webhook 47 · obligación 7 · afiliación 28 · cliente rápido 36 ·
discriminadores 8 · guardia 6). Detalle por sabotaje:

```
36/36 certificados · huella HEAD 03e7ac38 + WIP sha256 a7bbb25ef03b6bc4 (935958 bytes) · 2026-09-13T23:33:39
✅ R5-A · una consolidación que CONTRADICE vuelve a reparar la solicitud co · 2 caída(s) / 2 declarada(s) · 21.4 s
✅ R5-B · la tarifa se congela sobre la afiliación que MANDÓ el APK, no sob · 2 caída(s) / 2 declarada(s) · 9.6 s
✅ R5-C · el costo síncrono cierra la obligación aunque NO haya convergido  · 5 caída(s) / 5 declarada(s) · 15.0 s
✅ R5-D · la convergencia deja de proyectar la comisión en el Payment · 20 caída(s) / 20 declarada(s) · 14.4 s
✅ R5-F · «existe la fila del costo» vuelve a cerrar la obligación sin proy · 7 caída(s) / 7 declarada(s) · 5.5 s
✅ R5-G · el helper débil ignora el vínculo que ve bajo el candado · 15 caída(s) / 15 declarada(s) · 17.4 s
✅ R5-H · el helper débil escribe SIN tomar el candado del evento · 5 caída(s) / 5 declarada(s) · 3.2 s
✅ R5-I · el cruce de comercio no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 15.8 s
✅ R5-J · la discrepancia no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 19.5 s
✅ R5-K · el backfill no relee el vínculo de la llave del evento · 3 caída(s) / 3 declarada(s) · 18.4 s
✅ R5-L · la reapertura vuelve a ser best-effort FUERA de la transacción de · 11 caída(s) / 11 declarada(s) · 24.7 s
✅ R5-M · el vínculo REPETIDO deja de mirar los eventos débiles · 1 caída(s) / 1 declarada(s) · 2.1 s
✅ R5-N · la búsqueda por referencia vuelve a excluir los `type` NULL · 3 caída(s) / 3 declarada(s) · 22.6 s
✅ R5-O · el cruce de comercio vuelve a excluir los `type` NULL · 1 caída(s) / 1 declarada(s) · 2.1 s
✅ P2-P · la colisión devuelta por la llave se lee como MATCHED en el webho · 1 caída(s) / 1 declarada(s) · 16.0 s
✅ P2-Q · S6 no distingue la colisión de un NOT_RECORDED · 1 caída(s) / 1 declarada(s) · 16.9 s
✅ P2-R · el retorno idempotente liga al cliente a la orden del candidato a · 1 caída(s) / 1 declarada(s) · 3.1 s
✅ P2-S · la revocación deja de exigir la identidad del evento · 2 caída(s) / 2 declarada(s) · 15.9 s
✅ P2-T · el historial de revocaciones se pisa (sólo queda la última) · 1 caída(s) / 1 declarada(s) · 16.4 s
✅ P2-U · el validador del snapshot vuelve a aceptar null, booleanos y hexa · 9 caída(s) / 9 declarada(s) · 1.6 s
✅ P3-V · el SQL de S6 vuelve a recortar sólo espacios ASCII · 1 caída(s) / 1 declarada(s) · 9.2 s
✅ R6-A · la deduplicación vuelve a usar la afiliación que MANDÓ el APK (no · 2 caída(s) / 2 declarada(s) · 8.5 s
✅ R6-B · una resolución incierta de la afiliación vuelve a leerse como «si · 1 caída(s) / 1 declarada(s) · 10.6 s
✅ R6-C · la discrepancia DÉBIL deja de reabrirse al llegar el vínculo · 1 caída(s) / 1 declarada(s) · 16.6 s
✅ R6-D · la reapertura toca también los rechazos bancarios y la discrepanc · 1 caída(s) / 1 declarada(s) · 16.8 s
✅ R6-E · la discrepancia deja de llevar la identidad del evento (la revoca · 1 caída(s) / 1 declarada(s) · 16.8 s
✅ R6-F · el camino del vínculo NUNCA toma el candado del intento (ni al pu · 5 caída(s) / 5 declarada(s) · 25.2 s
✅ R6-G · el escritor por identidad DÉBIL NO toma el candado del intento · 4 caída(s) / 4 declarada(s) · 26.3 s
✅ R6-H · la reapertura (también la idempotente, con transacción propia) NO · 2 caída(s) / 2 declarada(s) · 17.6 s
✅ R6-I · los Payments de la reapertura se bloquean SIN orden (interbloqueo · 1 caída(s) / 1 declarada(s) · 1.2 s
✅ R6-O · el escritor DÉBIL lee S1 ANTES de tomar el candado (fotografía vi · 2 caída(s) / 2 declarada(s) · 17.7 s
✅ R6-J · el mutex del costo espera (sin NOWAIT): dos corridas se intercala · 5 caída(s) / 5 declarada(s) · 13.9 s
✅ R6-K · `costPending` deja de nacer con la obligación (lo decidiría el cá · 2 caída(s) / 2 declarada(s) · 8.7 s
✅ R6-L · el worker deja de cerrar su obligación DENTRO de la unidad · 1 caída(s) / 1 declarada(s) · 5.8 s
✅ R6-M · una VenueTransaction ausente se lee como convergida · 1 caída(s) / 1 declarada(s) · 5.6 s
✅ R6-N · la contención se lee como convergencia · 4 caída(s) / 4 declarada(s) · 7.0 s
```

Cadena `avq-verify` DUAL (typecheck 5.8, 4 shards, integración, API) sobre el árbol final: typecheck 5.8 (`tsconfig.typecheck.json`) **0
errores, local y Alienware COINCIDEN**; suite unitaria completa en 4 shards **17,135 pruebas** (4,104 + 4,715 + 3,778 + 4,538;
359+359+358+358 suites; shards 1 y 4 COINCIDEN con 0 fallos; shards 2 y 3 marcaron `DIFIEREN` con **un solo fallo por lado en archivos
DISTINTOS de la familia documentada de presupuesto del event loop** —local `catalogImportCanonical.service.test.ts`, Alienware
`catalogImportDurableEventLoop.service.test.ts` y `catalogWorkbook.eventloop-budget.test.ts`—, los tres idénticos a HEAD y ajenos al
checkpoint; repetidos los tres archivos EXACTOS con `--runInBand` en DUAL: **9/9 en ambos lados, COINCIDEN** ⇒ probe de carga no
determinista, no código (regla del workspace); se conserva el resultado de los shards como evidencia y no se tocó lógica de negocio);
integración de pagos completa contra la base desechable **17 suites / 391 pruebas / 0 fallos**; API `terminal-payment-attempts` **6/6
COINCIDEN**. Las corridas avisaron `⚠️ vigencia` (el árbol compartido se movió), y se midió que ningún archivo del checkpoint cambió durante
la cadena. (corridas `avq-r6-*.txt`, evidencia `run-avoqado-server.5fVW79` y `.tda3ZB`; 14-sep 00:0x).. 🔑 Lección: un `jest.spyOn` sobre un
export del MISMO módulo no intercepta la llamada interna; espiar un export de OTRO módulo importado sí (CJS accede por propiedad al llamar)
— así se inyectó el fallo operativo en `createTransactionCost`. Y una prueba con dos transacciones abiertas SIN `finally` que suelte la
barrera deja la suite colgada.

### 🔴 Ronda 7 de la auditoría final de Codex (14-sep 00:37): RECHAZADO — 2 P1 (R7-1 · R7-2) · 6 P2 parciales ((c) · (e) · (g) · (h) · (k) · (l)) · P2-d · motivos públicos → todos cerrados con TDD y sabotajes certificados con resultados estructurados (14-sep, madrugada)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r7-veredicto.md`. De la ronda 6 dio por CERRADOS R6-1, R6-2, R6-3, P2
(`costPending`), P2-e, P2 (VenueTransaction) y P2 (backfill); por PARCIALES P2-d y el runner; del diseño (a–l) CERRADOS a, b, d, f,
i, j y PARCIALES c, e, g, h, k, l. Confirmó correcto: no hay ciclo vínculo–registrador (la FK de la solicitud detiene al vínculo
ANTES de tomar eventos/Payments), `FOR NO KEY UPDATE NOWAIT` como mutex del costo, ninguna escritura financiera por el cliente
global, la normalización del webhook y la afiliación dentro de una llamada. Los dos P1 son hallazgos NUEVOS de familias ya
cerradas (R6-2/R5-4 y R6-1) — Codex lo dijo así («fue una omisión de alcance del diseño, no un incumplimiento del orden»)—, así que
no hubo ronda de diseño nueva: son extensiones del protocolo del intento y de la identidad del cobro con el cambio exacto que él
exigió. Los dos límites del founder se conservan.

- **R7-1 · la consolidación REST decidía con una ausencia VIEJA de S1 y podía apropiarse de otra venta.** La búsqueda por
  referencia calculaba `exigeLlave` consultando S1 FUERA de toda transacción y se lo pasaba a la consolidación, que sólo
  bloqueaba el Payment: si el vínculo A→Q se publicaba (y hasta se confirmaba) entre esa lectura y el `COALESCE` de la llave, un
  legacy B sin llave se convertía en «este cobro», recibía la llave de A y podía cerrar Q — dos cargos, una venta, y la
  reapertura ya no lo repara (omite un Payment que ya tiene esa llave). Ahora `consolidarRegistroRepetidoDetallado`
  (`registroRepetido.ts`) es un escritor MÁS del protocolo del intento: `candadoDeIntento` (advisory del intento, primera
  sentencia) → `Payment FOR UPDATE` (`/* consolidacion */`) → relectura del Payment → S1 releído en OTRA sentencia
  (`exigeLlaveVigente = registradoVia === 'webhook' || !!vinculoVigente`) → identidad revalidada con ESA regla → plan. El
  `exigeLlave` del llamador desapareció de `RegistroEntrante` y del registrador (`payment.tpv.service.ts`); `OPCIONES_DE_TRANSACCION_DEL_INTENTO`.
  Guardia estática nueva (orden advisory → Payment → S1 → identidad; `entrante.exigeLlave` y `busqueda.exigeLlave` prohibidos).
  Pruebas (registrador, 3, con `pg_locks`/`pg_blocking_pids`): (1) la publicación de A→Q está ABIERTA (advisory tomado, INSERT sin
  commit) cuando el REST de A va a consolidar sobre B ⇒ la consolidación ESPERA el advisory (bloqueador = la transacción del
  vínculo); al commitear, relee S1, B ya no es este cobro, A nace aparte y gana Q, B intacta y sin llave; (2) el vínculo se
  publica y COMMITEA entre la búsqueda y la consolidación (el escenario exacto de Codex, con una barrera tras la búsqueda: espía
  sobre `prisma.terminalPaymentAttemptLink.findUnique`) ⇒ mismo desenlace; (3) …y si además el webhook CONFIRMA A por el vínculo
  en esa ventana, el REST resuelve al Payment de A (el confirmado), no a B.
- **R7-2 · un cambio de afiliación entre replays convertía la misma autorización en otra venta.** Resolver UNA vez por llamada no
  conserva la identidad ENTRE llamadas: el registro nació bajo M1 (activa entonces), el negocio desactivó M1 y movió el serial a
  M2, el replay idéntico resolvió a M2 y la búsqueda excluía el Payment de M1 ⇒ `NUEVO` ⇒ otra venta y otro movimiento. Ahora la
  afiliación es un CONJUNTO de identidades en los dos lados (`afiliacionesDe`: la definitiva + la que mandó el APK;
  `HuellaDelCobro.merchantAccountIdDelApk`, `RegistroEntrante.merchantAccountIdDelApk`, `afiliacionDelApkDelRegistro(processorData)`):
  la búsqueda por referencia admite `merchantAccountId IN (conjunto)` ∪ `processorData.merchantAccountIdFromApk ∈ conjunto` ∪ `null`
  ∪ (misma `authorizationNumber`, para que un candidato de OTRA afiliación se JUZGUE en vez de esconderse en la consulta); la
  identidad (`esElMismoCobroPorReferencia`) y el plan de consolidación contrastan conjuntos: si se cruzan es el mismo cargo y el
  Payment CONSERVA su afiliación registrada (nunca se reescribe); si no se cruzan, sólo una autorización DISTINTA demuestra otro
  cargo (`AFILIACION`); sin esa prueba es `AFILIACION_INCIERTA` y el registrador la convierte en EVIDENCIA de colisión (PENDING,
  `POSSIBLE_REFERENCE_COLLISION`, sin movimiento financiero), nunca en venta nueva. Pruebas (costo real, 4): venta rápida y orden —
  registro bajo M1 activa → desactivar M1 y mover el serial a M2 → replay IDÉNTICO sin llave (el APK sigue mandando M1) ⇒ mismo
  Payment, afiliación histórica M1, ningún incremento de `VenueTransaction`, la cuenta no se cobra dos veces; replay SIN afiliación
  del APK con el serial ya en M2 y la misma autorización ⇒ evidencia de colisión; otra AUTORIZACIÓN con otra afiliación ⇒ venta
  nueva. Unit (identidad, 4; discriminadores; registro repetido).
- **P2-d · el snapshot de tarifa distingue estados y no se cae a la configuración de hoy.** `leerTarifaCongelada` ⇒ AUSENTE (sin
  `pricing`) · VALIDO · **SIN_TARIFA** (legible, de la MISMA afiliación, `venue: null`: al cobrar no tenía tarifa contratada ⇒ el costo
  queda PENDIENTE `AFFILIATION_PRICING_UNRESOLVED` hasta que la afiliación vuelva a tener tarifa, comportamiento R3/R4 que Codex ya
  había aceptado) · **INVALIDO** con motivo (`pricing` que no es objeto, sin afiliación, de OTRA afiliación, slot desconocido, tasas
  del negocio que no son objeto o con una tasa inválida, `includesTax` que no es booleano ni null — `"false"` no es «sin IVA»). Un
  INVALIDO lanza `COST_PENDING_INVALID_PRICING_SNAPSHOT: … (<motivo>)`; la unidad de convergencia lo anota como obligación con
  nombre (`motivoDeCostoPendiente` ⇒ `INVALID_PRICING_SNAPSHOT`, `costPending: true`, PENDIENTE), no como fallo operativo a
  reintentar a ciegas. Pruebas: unit (tri-estado con motivos; `createTransactionCost` rechaza y no crea costo ante OTRA afiliación e
  `includesTax` cadena); integración (costo real): snapshot corrompido bajo OTRA afiliación ⇒ `cerrar` false, sin costo, efecto
  PENDING `INVALID_PRICING_SNAPSHOT`, `costPending: true`, fee 0; reparado ⇒ converge con la tarifa CONGELADA (2.5 %), no con la de
  hoy (8 %). Motivos públicos: `VENUE_TRANSACTION_MISSING` e `INVALID_PRICING_SNAPSHOT` salen tal cual en `listPaymentEffects`.
- **(c) READ COMMITTED EXPLÍCITO.** `OPCIONES_DE_TRANSACCION_DEL_INTENTO = { timeout: 10_000, isolationLevel: ReadCommitted }` en
  el vínculo, el escritor débil, la reapertura y la consolidación; la unidad de costo abre con `{ timeout: presupuesto,
  isolationLevel: ReadCommitted }`. Guardia estática (cuenta los usos por archivo y prohíbe `{ timeout: 10_000 }` a secas tras un
  `candadoDeIntento`). Sabotaje dinámico: con REPEATABLE READ la relectura de S1 tras esperar el advisory es la fotografía VIEJA y
  la prueba (1) de R7-1 cae.
- **(g) la unidad de costo lee TODO por el mismo cliente.** `getEffectivePaymentConfig(venueId, db)`, `getEffectivePricing(…, db)`,
  `findActiveProviderCostStructure(…, db)` y `findActiveVenuePricingStructure(…, db)` reciben el cliente transaccional; en
  `createTransactionCost` no queda ningún `prisma.`. Guardia estática + aserción unit (`configMock`/`pricingMock` reciben el
  cliente).
- **(e) actores por PID.** T1/T2 (webhook) instrumentan `$transaction` con un Proxy que captura `pg_backend_pid()` de las
  transacciones que toman el advisory de A, y las aserciones de `pg_locks`/`pg_blocking_pids` comparan con ESOS PID (bloqueador y
  bloqueado nombrados), no con «alguien espera esa llave»; el backfill de `legacyB` se espera explícitamente para que no haya un
  tercero. (k) el backfill acredita que la llamada explícita consumió el `null` (`espiaS1` llamada una vez con A y resuelta null).
  (h) la caducidad ya no duerme 500 ms: captura el PID de la primera corrida, observa en `pg_stat_activity` que su transacción se
  cerró (tras el timeout de Prisma la sesión queda `active`, no `idle in transaction`) y libera las barreras en `finally`; y
  existe el caso «contendida sobre una marca previamente `false`/DONE» (no revierte nada).
- **(l) el runner CERTIFICA con resultados ESTRUCTURADOS** (`sab-r7.py`): cada suite corre con `--json --outputFile`; una caída sólo
  cuenta si es de ASERCIÓN (`failureDetails[].matcherResult`, o el error propio de `expect(...).rejects/.resolves` sobre una promesa
  mal resuelta — Jest lo lanza sin `matcherResult`; verificado con una suite de forma); un timeout («Exceeded timeout»), un `throw`
  ajeno o un hook caído (`beforeAll/afterAll` ⇒ «Test suite failed to run», `numRuntimeErrorTestSuites`) ⇒ INCONCLUSO SIEMPRE,
  aunque además haya aserciones caídas (ya no se reconstruye nada del texto); el CONJUNTO de pruebas ejecutadas (fullName) bajo
  el sabotaje se compara con el del control de la misma suite (una de más, de menos o que no corrió ⇒ INCONCLUSO); cada caída se
  guarda con archivo + nombre completo; la mutación va ÍNTEGRA en el JSON; el JSON crudo de Jest de cada corrida se conserva en
  `sab-r7-logs/`. 🔑 El criterio estricto destapó DOS formas en que una prueba «mataba» al mutante sin afirmar nada: (1) un
  `findUniqueOrThrow` sobre la fila que el mutante deja de crear tumba la prueba con un error de Prisma, no con una aserción — las
  8 suites del checkpoint (99 sitios) pasaron a `exigir(prisma.x.findUnique(…))` (`webhookCheckpoint.fixture.ts`: `not.toBeNull`
  explícito); (2) una barrera `await b.enPausa` sobre un actor que el mutante ya no identifica (R6-G: el escritor débil sin candado
  nunca «toma el advisory» que dispara la pausa) espera hasta el timeout de Jest — las barreras pasaron a `pausadaEn(ms)`
  (`Promise.race` acotado + `expect(...).toBe(true)`), y la prueba K1/K2 afirma que NINGUNO de los dos registros rechaza (bajo
  REPEATABLE READ el segundo caía con 503 por serialización). La mutación de R5-L que dejaba trabajo colgante (fire-and-forget que
  tumbaba el `afterAll`) se sustituyó por la variante «reapertura FUERA de la transacción del vínculo pero esperada tras el
  commit», que no deja nada en vuelo. R6-A (la
  huella de búsqueda con la afiliación del APK) quedó como mutante EQUIVALENTE tras R7-2 —la búsqueda y la identidad aceptan la
  identidad del APK POR DISEÑO— y se sustituyó por R6-A′ sobre la RESOLUCIÓN (una inactiva recuperada por serial se registra bajo la
  inactiva). Sabotajes nuevos: consolidación sin advisory; consolidación que ignora el S1 releído; búsqueda sin la afiliación del
  APK ni la evidencia; identidad estricta (nunca INCIERTA); plan de consolidación por UN campo; INCIERTA registrada como venta;
  snapshot INVALIDO tratado como ausente; `includesTax` cadena aceptada; motivos públicos ocultos; snapshot ilegible anotado como
  fallo operativo; REPEATABLE READ; lecturas de configuración y de tarifa por el cliente global.

**Verificación de la ronda 7:** integración de pagos del checkpoint (base desechable, `--runInBand`): registrador 51 · costo
real 27 · costo diferido 23 · webhook 46 · socket 18 · terminal 27 · legacy 14 · worker 10 (las 8 suites = 216 en verde en el árbol
final); unit: webhook 47 · obligación 8 · afiliación 41 · guardia estática 9 · cliente rápido 36 · discriminadores 8 · identidad 20 ·
registro repetido 7 · motivos públicos 7 · herencia 15 · `terminal-payment.service` (244 en las 11 suites tocadas + 15 + 41 vecinas);
typecheck rápido (TS 7) 0 errores; prettier y eslint limpios en lo tocado (3 advertencias preexistentes en HEAD). **49/49 sabotajes
CERTIFICADOS con resultados estructurados sobre el árbol FINAL** (`sab-r7.py`: huella HEAD 03e7ac38 + WIP sha256 acd26cf902965960;
corrida definitiva `sab-r7.txt`; JSON `sab-r7-resultados.json` con la mutación ÍNTEGRA y cada caída con archivo + nombre completo;
`sab-r7-logs/` con la salida y el JSON crudo de Jest por corrida; 154 declaraciones, cada una resuelta a UNA prueba; controles en
verde con las suites ENTERAS). Antes hubo una corrida parcial (los 15 nuevos: 8/15), una exploratoria completa (45/49) y una
definitiva previa (49/49, huella b7d17326, antes de corregir una prueba unitaria ajena a los sabotajes que la cadena avq destapó);
lo que corrigieron fue el MANIFIESTO o las PRUEBAS, nunca una aserción aflojada: R5-L/R7-1b/R7-2a/R6-A′/R6-2c/R7-g2/R5-D/R6-J/R6-N/P2-U
(declaraciones ajustadas por la evidencia — cada caída añadida es consecuencia directa de la mutación), P2-d-d y K1/K2 (`.resolves`
explícito), R5-F (`exigir()`), R6-G (`pausadaEn`). Detalle por sabotaje:

```
49/49 certificados · huella HEAD 03e7ac38 + WIP sha256 acd26cf902965960 (988670 bytes) · 2026-09-14T02:58:34
✅ R5-A · una consolidación que CONTRADICE vuelve a reparar la solicitud co · 2 caída(s) / 2 declarada(s) · 20.8 s
✅ R5-B · la tarifa se congela sobre la afiliación que MANDÓ el APK, no sob · 2 caída(s) / 2 declarada(s) · 10.2 s
✅ R5-C · el costo síncrono cierra la obligación aunque NO haya convergido  · 5 caída(s) / 5 declarada(s) · 17.1 s
✅ R5-D · la convergencia deja de proyectar la comisión en el Payment · 22 caída(s) / 22 declarada(s) · 19.6 s
✅ R5-F · «existe la fila del costo» vuelve a cerrar la obligación sin proy · 7 caída(s) / 7 declarada(s) · 7.1 s
✅ R5-G · el helper débil ignora el vínculo que ve bajo el candado · 15 caída(s) / 15 declarada(s) · 17.5 s
✅ R5-H · el helper débil escribe SIN tomar el candado del evento · 5 caída(s) / 5 declarada(s) · 3.1 s
✅ R5-I · el cruce de comercio no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 16.4 s
✅ R5-J · la discrepancia no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 17.2 s
✅ R5-K · el backfill no relee el vínculo de la llave del evento · 3 caída(s) / 3 declarada(s) · 18.7 s
✅ R5-L · la reapertura vuelve a ser best-effort FUERA de la transacción de · 4 caída(s) / 4 declarada(s) · 25.0 s
✅ R5-M · el vínculo REPETIDO deja de mirar los eventos débiles · 1 caída(s) / 1 declarada(s) · 1.9 s
✅ R5-N · la búsqueda por referencia vuelve a excluir los `type` NULL · 3 caída(s) / 3 declarada(s) · 24.5 s
✅ R5-O · el cruce de comercio vuelve a excluir los `type` NULL · 1 caída(s) / 1 declarada(s) · 2.1 s
✅ P2-P · la colisión devuelta por la llave se lee como MATCHED en el webho · 1 caída(s) / 1 declarada(s) · 15.9 s
✅ P2-Q · S6 no distingue la colisión de un NOT_RECORDED · 1 caída(s) / 1 declarada(s) · 16.8 s
✅ P2-R · el retorno idempotente liga al cliente a la orden del candidato a · 1 caída(s) / 1 declarada(s) · 3.0 s
✅ P2-S · la revocación deja de exigir la identidad del evento · 2 caída(s) / 2 declarada(s) · 17.1 s
✅ P2-T · el historial de revocaciones se pisa (sólo queda la última) · 1 caída(s) / 1 declarada(s) · 16.7 s
✅ P2-U · el validador del snapshot vuelve a aceptar null, booleanos y hexa · 10 caída(s) / 10 declarada(s) · 1.6 s
✅ P3-V · el SQL de S6 vuelve a recortar sólo espacios ASCII · 1 caída(s) / 1 declarada(s) · 9.4 s
✅ R6-A′ · una afiliación INACTIVA que el serial recupera se registra bajo  · 2 caída(s) / 2 declarada(s) · 9.8 s
✅ R6-B · una resolución incierta de la afiliación vuelve a leerse como «si · 1 caída(s) / 1 declarada(s) · 9.8 s
✅ R6-C · la discrepancia DÉBIL deja de reabrirse al llegar el vínculo · 1 caída(s) / 1 declarada(s) · 16.3 s
✅ R6-D · la reapertura toca también los rechazos bancarios y la discrepanc · 1 caída(s) / 1 declarada(s) · 16.7 s
✅ R6-E · la discrepancia deja de llevar la identidad del evento (la revoca · 1 caída(s) / 1 declarada(s) · 16.9 s
✅ R6-F · el camino del vínculo NUNCA toma el candado del intento (ni al pu · 5 caída(s) / 5 declarada(s) · 26.5 s
✅ R6-G · el escritor por identidad DÉBIL NO toma el candado del intento · 4 caída(s) / 4 declarada(s) · 31.4 s
✅ R6-H · la reapertura (también la idempotente, con transacción propia) NO · 2 caída(s) / 2 declarada(s) · 17.7 s
✅ R6-I · los Payments de la reapertura se bloquean SIN orden (interbloqueo · 1 caída(s) / 1 declarada(s) · 1.1 s
✅ R6-O · el escritor DÉBIL lee S1 ANTES de tomar el candado (fotografía vi · 2 caída(s) / 2 declarada(s) · 17.9 s
✅ R6-J · el mutex del costo espera (sin NOWAIT): dos corridas se intercala · 6 caída(s) / 6 declarada(s) · 18.6 s
✅ R6-K · `costPending` deja de nacer con la obligación (lo decidiría el cá · 2 caída(s) / 2 declarada(s) · 9.9 s
✅ R6-L · el worker deja de cerrar su obligación DENTRO de la unidad · 1 caída(s) / 1 declarada(s) · 7.2 s
✅ R6-M · una VenueTransaction ausente se lee como convergida · 1 caída(s) / 1 declarada(s) · 7.4 s
✅ R6-N · la contención se lee como convergencia · 5 caída(s) / 5 declarada(s) · 6.5 s
✅ R7-1a · la consolidación por referencia NO toma el candado del intento · 2 caída(s) / 2 declarada(s) · 26.8 s
✅ R7-1b · la consolidación IGNORA el vínculo releído bajo el candado (sólo · 2 caída(s) / 2 declarada(s) · 22.5 s
✅ R7-2a · la búsqueda por referencia vuelve a exigir SÓLO la afiliación de · 4 caída(s) / 4 declarada(s) · 14.2 s
✅ R7-2b · conjuntos de afiliación que no se cruzan ⇒ siempre «otro cargo»  · 2 caída(s) / 2 declarada(s) · 22.8 s
✅ R7-2c · el plan de consolidación contrasta la afiliación como UN campo ( · 2 caída(s) / 2 declarada(s) · 16.4 s
✅ R7-2d · un descarte AFILIACION_INCIERTA se registra como VENTA NUEVA (no · 1 caída(s) / 1 declarada(s) · 13.1 s
✅ P2-d-a · un snapshot de tarifa INVALIDO se trata como AUSENTE (se calcul · 3 caída(s) / 3 declarada(s) · 14.1 s
✅ P2-d-b · `includesTax` como cadena se acepta en el snapshot · 2 caída(s) / 2 declarada(s) · 1.7 s
✅ P2-d-c · los motivos VENUE_TRANSACTION_MISSING e INVALID_PRICING_SNAPSHO · 2 caída(s) / 2 declarada(s) · 1.1 s
✅ P2-d-d · un snapshot ilegible se anota como fallo OPERATIVO (TRANSACTION · 2 caída(s) / 2 declarada(s) · 12.1 s
✅ R6-2c · el protocolo del intento abre en REPEATABLE READ (la relectura d · 4 caída(s) / 4 declarada(s) · 27.4 s
✅ R7-g · la unidad de costo lee la configuración de pagos por el cliente G · 2 caída(s) / 2 declarada(s) · 2.9 s
✅ R7-g2 · la tarifa del negocio se lee por el cliente GLOBAL · 2 caída(s) / 2 declarada(s) · 2.4 s
```


Verificación pesada por `avq-verify` (DUAL: Mac y Alienware) sobre el árbol final (14-sep 02:0x–02:4x; corridas `avq-r7-*.txt` y `avq-r7b-*.txt`): typecheck 5.8 (`tsconfig.typecheck.json`) **0 errores, local y Alienware COINCIDEN**; suite unitaria completa en 4 shards **17,158 pruebas** (4,119 + 4,715 + 3,785 + 4,539; 359+359+358+358 suites): shards 1, 3 y 4 COINCIDEN con 0 fallos a la primera; el shard 2 marcó `DIFIEREN` en la primera pasada por DOS causas distintas —(a) 5 fallos en `transactionCost.inheritance.test.ts` en los DOS lados, una prueba unitaria MÍA que no había corrido y cuyas aserciones exactas de `toHaveBeenCalledWith` no esperaban el argumento `db` que (g) añadió a `getEffectivePaymentConfig`/`getEffectivePricing` (corregida aceptando el cliente: 15/15; ninguna aserción aflojada); (b) 1 fallo sólo en el Alienware en `catalogImportDurableEventLoop.service.test.ts`, la familia documentada de presupuesto del event loop— y REPETIDO tras el arreglo: **4,715 pruebas (8 omitidas), 0 fallos, COINCIDEN**, y el archivo EXACTO de timing con `--runInBand` en DUAL **1/1 en ambos lados, COINCIDEN** ⇒ probe de carga no determinista, no código (regla del workspace); integración de pagos completa contra la base desechable **17 suites / 400 pruebas / 0 fallos**; API `terminal-payment-attempts` **6/6 COINCIDEN**. Las corridas avisaron `⚠️ vigencia` (el árbol compartido se movió); comprobado con `diff -rq` contra la copia certificada que el ÚNICO archivo del checkpoint que cambió durante la cadena fue esa prueba unitaria, y la certificación de sabotajes se repitió sobre el árbol final (huella acd26cf902965960).

### 🔴 Ronda 8 de la auditoría final de Codex (14-sep 03:0x–03:2x, gpt-6-astra xhigh): RECHAZADO — 2 P1 (R8-1 · R8-2) · 4 P2 ((l) · (g) · snapshot incompleto · prueba P2-d) → todos cerrados con TDD y sabotajes certificados (14-sep, madrugada)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r8-veredicto.md`. De la ronda 7 dio por CERRADOS R7-1 (las tres pruebas
con `pg_locks`, la guardia del orden), R7-2 en su escenario original, (g) salvo una lectura, (l) salvo la mezcla de errores, y los
motivos públicos; por PARCIALES P2-d (un `venue` omitido) y R8-2 (consumo de `SIN_TARIFA`). Confirmó correcto: la prueba (2) de
R7-1 pausa la lectura correcta; READ COMMITTED es NECESARIO para este protocolo (no una preferencia de las pruebas); `FOR NO KEY
UPDATE NOWAIT` como mutex del costo; la intersección de afiliaciones no fusiona autorizaciones distintas; la OR de autorización
no cruza venue. Los dos P1 son otra vez hallazgos NUEVOS de familias ya cerradas (R6-1/R7-2 y R3/R4): «el escenario original de
R7-2 está cerrado; falta aplicar su regla completa de identidad incierta» y «no afirmo que toda esta rama naciera en R7; el nuevo
estado tampoco la cierra» — extensiones con el cambio exacto que él exigió, sin ronda de diseño nueva. Los dos límites del founder
se conservan: ningún cobro se interrumpe; ninguna venta nace dos veces ni se cobra una comisión que nadie acreditó.

- **R8-1 · un replay legacy sin autorización quedaba fuera de la búsqueda y volvía a crear una venta.** La consulta de R7-2 sólo
  admitía afiliación nula, intersección de identidades o igualdad de autorización PRESENTE: un APK legacy que registra $100 con
  referencia R y serial S (sin merchant, sin autorización, sin llave, sin solicitud — el contrato lo admite: `tpv.schema.ts`),
  cuya respuesta se pierde, y cuyo serial el negocio mueve de M1 a M2 antes del reintento, mandaba EXACTAMENTE el mismo payload
  y la OR excluía el registro histórico (M1, sin identidad del APK ni autorización comparable) ⇒ cero candidatos ⇒ `NUEVO` ⇒ otro
  Payment y otra VenueTransaction por un solo cargo bancario. Ahora la AFILIACIÓN NO filtra en SQL (`payment.tpv.service.ts`, la
  `AND` de la búsqueda es sólo `SIN_REEMBOLSOS` sobre venue + referencia + importe + propina + orden objetivo): la única regla
  de identidad vive en `esElMismoCobroPorReferencia` — los candidatos de otra afiliación LLEGAN ahí y salen como `AFILIACION`
  (otro cargo, sólo con autorizaciones presentes y DISTINTAS) o `AFILIACION_INCIERTA` (evidencia PENDING
  `POSSIBLE_REFERENCE_COLLISION`, sin movimiento financiero), nunca se esconden en la consulta con un criterio paralelo. La
  prueba unitaria de la consulta fija que `where` no lleve `merchantAccountId`, `merchantAccountIdFromApk` ni
  `authorizationNumber`. Pruebas exigidas (costo real, 3): venta rápida y orden — primer registro legacy SIN merchant NI
  autorización (sólo el serial) bajo M1 → el negocio mueve el serial a M2 → replay IDÉNTICO ⇒ evidencia PENDING, UN solo
  Payment COMPLETED con la referencia, la orden pagada UNA vez, sin incremento financiero, el registro de M1 intacto; y la
  autorización en UN solo lado (el registro la tiene y el replay no, y al revés) ⇒ evidencia, nunca venta nueva. El caso de
  afiliaciones disjuntas con autorizaciones realmente distintas (venta nueva) se conserva.
- **R8-2 · un snapshot `SIN_TARIFA` podía cobrar PRIMARY y declarar cumplida la obligación.** El registrador congela
  `slot: SECONDARY, venue: null` cuando la afiliación ocupa un slot SIN estructura vigente al cobrar; la unidad de costo sólo
  consumía `VALIDO`, así que ese Payment caía a la rama «M2 sigue en SECONDARY» con `tarifaCongelada = false`, no encontraba
  SECONDARY, y el fallback a PRIMARY (8 %) proyectaba $80 de comisión sobre $1,000 y cerraba DONE: una tarifa que el snapshot no
  acredita, sin corrupción ni carrera. Ahora `createTransactionCost` consume `SIN_TARIFA` EXPLÍCITAMENTE: conserva la afiliación
  acreditada y su slot HISTÓRICO, marca la tarifa como congelada y busca la estructura de ESE slot A LA FECHA DEL COBRO; si no
  existe ⇒ `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED` (obligación PENDING, `costPending`, motivo público), JAMÁS PRIMARY ni el
  slot que la afiliación ocupe hoy. Sin slot histórico (`slot: null`, la afiliación estaba fuera de la configuración al cobrar),
  la única recuperación es la R3/R4 —que la afiliación VUELVA a la configuración y su slot tenga tarifa vigente a la fecha del
  cobro—, y sin eso también queda pendiente. El fallback a PRIMARY queda escrito como lo que es: SÓLO para un Payment sin snapshot
  (`lecturaCongelada.estado === 'AUSENTE'`: manual/QR o anterior al registrador). Pruebas unitarias (6): el escenario de Codex
  (M2 en SECONDARY, sin tarifa SECONDARY, PRIMARY 8 % disponible ⇒ lanza `AFFILIATION_PRICING_UNRESOLVED`, PRIMARY ni se
  consulta, no nace costo); cambio posterior de slot (hoy M2 es PRIMARY ⇒ sigue pendiente); M2 fuera de la configuración ⇒
  pendiente sin sustituir la afiliación; recuperación LEGÍTIMA (el slot histórico vuelve a tener tarifa vigente a la fecha ⇒
  2.5 % sobre M2 con SU estructura); `slot: null` con M2 hoy en SECONDARY sin tarifa ⇒ pendiente; `slot: null` con M2 fuera ⇒
  pendiente sin consultar tarifa alguna. Pruebas exigidas (costo real, 3, con la estructura SECONDARY desactivada y PRIMARY
  disponible): registro REAL por REST con M2 configurada como SECONDARY ⇒ Payment COMPLETED, snapshot `slot: SECONDARY,
  venue: null`, costo inexistente, obligación PENDING `AFFILIATION_PRICING_UNRESOLVED`, `costPending: true`, fee 0; cambio
  posterior de slot (M2 a PRIMARY) ⇒ sigue pendiente; una tarifa SECONDARY al 8 % creada HOY con vigencia desde mañana ⇒ sigue
  pendiente (no es la tarifa histórica); recuperación legítima (la estructura SECONDARY vuelve a estar vigente a la fecha del
  cobro) ⇒ converge al 2.5 % sobre M2, fee 3, `costPending: false`; el mismo escenario por WEBHOOK (costo diferido, y con M2
  retirada después tampoco cae a PRIMARY); y con orden (la cuenta queda pagada, el costo pendiente y visible).
- **P2 · (l): el runner aceptaba una prueba con una aserción caída Y además un error de otra naturaleza.** El JSON de R7-1a de la
  ronda 7 traía, en la misma prueba, la aserción `false`/`true` y un 503 `PAYMENT_REGISTRATION_UNRESOLVED_CONSOLIDATION_UNCERTAIN`
  aterrizado después (la promesa del REST quedaba sin manejador cuando la aserción cortaba la prueba antes de su `await`). Ahora
  `es_asercion` clasifica TODOS los errores de cada prueba caída —`failureDetails[i].matcherResult` o el mensaje propio de
  `expect(...).rejects/.resolves`— y basta uno ajeno para que la prueba NO cuente ⇒ INCONCLUSO; `sab-r7.py --selftest` lo
  demuestra con casos fijos y con el JSON REAL de R7-1a (ahora INCONCLUSO). Y las pruebas de carrera capturan al lanzarlas las
  promesas en vuelo (`enVuelo` en el fixture: nunca sin manejador, espera ACOTADA en el `finally`, `resultado()` relanza): las
  tres de R7-1, K1/K2, el REST contra la transacción del webhook, las dos intercalaciones vínculo↔escritor débil y las dos
  corridas contendidas del costo. R7-1a se recertificó sobre el árbol corregido con UNA sola caída, de aserción.
- **P2 · (g): el fallback a PRIMARY conservaba una lectura por el cliente global.** `findActiveVenuePricingStructure(…, 'PRIMARY',
  …)` recibe `db`; la guardia estática cuenta TODAS las llamadas de la unidad (`getEffectivePaymentConfig` 1,
  `findActiveProviderCostStructure` 1, `findActiveVenuePricingStructure` 2, `calculatePaymentSettlement` 1) y exige `db` como
  último argumento en cada una; prueba unitaria nueva que ejercita el fallback con un cliente DISTINTO del global (snapshot
  AUSENTE, afiliación en SECONDARY sin tarifa ⇒ la consulta de PRIMARY recibe `tx`).
- **P2 · snapshot incompleto confundido con «sin tarifa».** `{pricing:{merchantAccountId, slot}}` sin el campo `venue` devolvía
  `SIN_TARIFA`; ahora un `venue` OMITIDO (o `undefined`) es INVALIDO `VENUE_AUSENTE` — sólo el `venue: null` EXPLÍCITO que
  escribe el registrador es «sin tarifa». Dos casos unitarios nuevos.
- **P2 · prueba P2-d:** antes de reparar el snapshot ilegible, la tarifa SECONDARY de hoy se edita al 8 % EN SITIO; el costo sigue
  saliendo al 2.5 % (el congelado), lo que demuestra «congelada frente a la de hoy» en vez de coincidir con la configuración.
- 🔴 **Hallazgo propio de la cadena de verificación, no de Codex: el typecheck del CI INCLUYE `tests/` y el pre-commit no.**
  `npm run typecheck` (= `tsc --noEmit` con `tsconfig.json`, lo que corre GitHub al pushear) reportó **7 errores** en pruebas del
  checkpoint que ninguna cadena anterior vio: `tsconfig.typecheck.json` (el de avq-verify en las rondas 1–7) sólo cubre `src/` y
  ts-jest transpila con `isolatedModules` (sin tipos). Los 7: `terminalPaymentAttemptLink.socket.integration.test.ts` leía
  `.outcome` sobre la UNIÓN `AttemptLinkAck` (×5; ahora `exitoso(ack)` afirma `success` antes de leerlo — una aserción, no un
  `as`), `angelpay-webhook.service.test.ts` usaba `this.update` en un getter dentro de la fábrica de `jest.mock` (`this` se tipa
  `{}`; ahora `update` y `updateMany` son el MISMO `jest.fn` por referencia) y `costoDiferido.integration.test.ts` tipaba el
  callback del `$transaction` espiado como `unknown` en vez de `Promise<unknown>`. Ninguna aserción se aflojó. El push habría
  roto el CI. Desde esta ronda la cadena avq corre los DOS typechecks (el del CI y el de `src/`).

**Sabotajes certificados (copia aislada `$J/sab-server`, runner `sab-r7.py`, resultados estructurados):** 56 mutaciones — las 49
de las rondas 5–7 (R7-2a REANCLADA: reintroduce el filtro de afiliación de R6-1, que ahora tumba también las tres pruebas de
R8-1) más R8-1a (la cláusula de afiliación de la ronda 7 vuelve a la consulta: caen la prueba de la consulta y las tres de R8-1;
las de R7-2 siguen pasando, como diseñó Codex), R8-2a (el escenario de Codex: `SIN_TARIFA` sin tarifa congelada + fallback
abierto ⇒ caen 4 unitarias y las 3 de integración), R8-2b (sólo sin tarifa congelada: la obligación cae como fallo operativo sin
nombre), R8-2c (sin slot histórico ni de hoy cae a PRIMARY ⇒ caen la unitaria y las tres pruebas R3/R4 de afiliación retirada),
R8-2d (el slot de hoy gana al histórico), R8-P2 (un `venue` omitido se lee como `SIN_TARIFA`) y R8-g (el fallback lee por el
cliente global ⇒ caen la guardia y la unitaria del fallback).

**Certificación DEFINITIVA de sabotajes (14-sep 04:14–04:40, runner `sab-r7.py` sha `7f7e3f6be0de2c52`, copia aislada
`$J/sab-server`, huella HEAD `03e7ac38` + WIP sha256 `43e538db89a89f88` (1,014,626 bytes), resultados estructurados en
`sab-r7-resultados.json`, corrida `sab-r7.txt`, JSON crudo de Jest y logs en `sab-r7-logs/`): 56/56 certificados · 197 caídas =
197 declaraciones · 0 INCONCLUSOS · 0 supervivientes · TODOS los errores de cada prueba caída son de aserción (el clasificador
estricto de R8 (l)) · el conjunto ejecutado de cada suite = el del control · las 15 suites de control en verde antes de mutar ·
la copia aislada idéntica al árbol principal antes y después (`diff -rq src tests prisma` vacío). La corrida EXPLORATORIA previa
(`sab-r8-exploratoria-1.txt`, 51/56 sobre la huella `241637d2bf14b1f3`) sólo destapó declaraciones INCOMPLETAS en la dirección
buena — las pruebas nuevas de R8-1/R8-2/(g) también caen bajo R5-C, R5-D, R7-2b, R7-2d y R7-g2 — sin un solo INCONCLUSO ni
mutante superviviente; se declararon con esa evidencia y se repitió TODO sobre el árbol final (que además incluye las 3
correcciones de tipos de las pruebas). R7-1a, la que Codex objetó, cae ahora con UN solo error, de aserción.

```
56/56 certificados · huella HEAD 03e7ac38 + WIP sha256 43e538db89a89f88 (1014626 bytes) · 2026-09-14T04:39:57
✅ R5-A · una consolidación que CONTRADICE vuelve a reparar la solicitud co · 2 caída(s) / 2 declarada(s) · 43.1 s
✅ R5-B · la tarifa se congela sobre la afiliación que MANDÓ el APK, no sob · 2 caída(s) / 2 declarada(s) · 29.4 s
✅ R5-C · el costo síncrono cierra la obligación aunque NO haya convergido  · 7 caída(s) / 7 declarada(s) · 46.9 s
✅ R5-D · la convergencia deja de proyectar la comisión en el Payment · 25 caída(s) / 25 declarada(s) · 46.4 s
✅ R5-F · «existe la fila del costo» vuelve a cerrar la obligación sin proy · 7 caída(s) / 7 declarada(s) · 15.5 s
✅ R5-G · el helper débil ignora el vínculo que ve bajo el candado · 15 caída(s) / 15 declarada(s) · 52.6 s
✅ R5-H · el helper débil escribe SIN tomar el candado del evento · 5 caída(s) / 5 declarada(s) · 9.2 s
✅ R5-I · el cruce de comercio no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 36.8 s
✅ R5-J · la discrepancia no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 36.0 s
✅ R5-K · el backfill no relee el vínculo de la llave del evento · 3 caída(s) / 3 declarada(s) · 43.9 s
✅ R5-L · la reapertura vuelve a ser best-effort FUERA de la transacción de · 4 caída(s) / 4 declarada(s) · 43.4 s
✅ R5-M · el vínculo REPETIDO deja de mirar los eventos débiles · 1 caída(s) / 1 declarada(s) · 4.4 s
✅ R5-N · la búsqueda por referencia vuelve a excluir los `type` NULL · 3 caída(s) / 3 declarada(s) · 45.0 s
✅ R5-O · el cruce de comercio vuelve a excluir los `type` NULL · 1 caída(s) / 1 declarada(s) · 4.8 s
✅ P2-P · la colisión devuelta por la llave se lee como MATCHED en el webho · 1 caída(s) / 1 declarada(s) · 26.8 s
✅ P2-Q · S6 no distingue la colisión de un NOT_RECORDED · 1 caída(s) / 1 declarada(s) · 24.1 s
✅ P2-R · el retorno idempotente liga al cliente a la orden del candidato a · 1 caída(s) / 1 declarada(s) · 6.0 s
✅ P2-S · la revocación deja de exigir la identidad del evento · 2 caída(s) / 2 declarada(s) · 23.7 s
✅ P2-T · el historial de revocaciones se pisa (sólo queda la última) · 1 caída(s) / 1 declarada(s) · 24.1 s
✅ P2-U · el validador del snapshot vuelve a aceptar null, booleanos y hexa · 10 caída(s) / 10 declarada(s) · 3.1 s
✅ P3-V · el SQL de S6 vuelve a recortar sólo espacios ASCII · 1 caída(s) / 1 declarada(s) · 13.4 s
✅ R6-A′ · una afiliación INACTIVA que el serial recupera se registra bajo  · 2 caída(s) / 2 declarada(s) · 16.7 s
✅ R6-B · una resolución incierta de la afiliación vuelve a leerse como «si · 1 caída(s) / 1 declarada(s) · 20.8 s
✅ R6-C · la discrepancia DÉBIL deja de reabrirse al llegar el vínculo · 1 caída(s) / 1 declarada(s) · 28.0 s
✅ R6-D · la reapertura toca también los rechazos bancarios y la discrepanc · 1 caída(s) / 1 declarada(s) · 32.9 s
✅ R6-E · la discrepancia deja de llevar la identidad del evento (la revoca · 1 caída(s) / 1 declarada(s) · 29.7 s
✅ R6-F · el camino del vínculo NUNCA toma el candado del intento (ni al pu · 5 caída(s) / 5 declarada(s) · 41.7 s
✅ R6-G · el escritor por identidad DÉBIL NO toma el candado del intento · 4 caída(s) / 4 declarada(s) · 43.9 s
✅ R6-H · la reapertura (también la idempotente, con transacción propia) NO · 2 caída(s) / 2 declarada(s) · 31.0 s
✅ R6-I · los Payments de la reapertura se bloquean SIN orden (interbloqueo · 1 caída(s) / 1 declarada(s) · 2.5 s
✅ R6-O · el escritor DÉBIL lee S1 ANTES de tomar el candado (fotografía vi · 2 caída(s) / 2 declarada(s) · 42.4 s
✅ R6-J · el mutex del costo espera (sin NOWAIT): dos corridas se intercala · 6 caída(s) / 6 declarada(s) · 27.3 s
✅ R6-K · `costPending` deja de nacer con la obligación (lo decidiría el cá · 2 caída(s) / 2 declarada(s) · 21.3 s
✅ R6-L · el worker deja de cerrar su obligación DENTRO de la unidad · 1 caída(s) / 1 declarada(s) · 11.8 s
✅ R6-M · una VenueTransaction ausente se lee como convergida · 1 caída(s) / 1 declarada(s) · 12.0 s
✅ R6-N · la contención se lee como convergencia · 5 caída(s) / 5 declarada(s) · 13.3 s
✅ R7-1a · la consolidación por referencia NO toma el candado del intento · 2 caída(s) / 2 declarada(s) · 41.6 s
✅ R7-1b · la consolidación IGNORA el vínculo releído bajo el candado (sólo · 2 caída(s) / 2 declarada(s) · 31.3 s
✅ R7-2a · la búsqueda por referencia vuelve a exigir SÓLO la afiliación de · 7 caída(s) / 7 declarada(s) · 20.1 s
✅ R8-1a · la consulta vuelve a filtrar por afiliación con la cláusula de l · 4 caída(s) / 4 declarada(s) · 19.3 s
✅ R7-2b · conjuntos de afiliación que no se cruzan ⇒ siempre «otro cargo»  · 5 caída(s) / 5 declarada(s) · 17.6 s
✅ R7-2c · el plan de consolidación contrasta la afiliación como UN campo ( · 2 caída(s) / 2 declarada(s) · 18.8 s
✅ R7-2d · un descarte AFILIACION_INCIERTA se registra como VENTA NUEVA (no · 4 caída(s) / 4 declarada(s) · 19.3 s
✅ P2-d-a · un snapshot de tarifa INVALIDO se trata como AUSENTE (se calcul · 3 caída(s) / 3 declarada(s) · 23.5 s
✅ P2-d-b · `includesTax` como cadena se acepta en el snapshot · 2 caída(s) / 2 declarada(s) · 4.4 s
✅ P2-d-c · los motivos VENUE_TRANSACTION_MISSING e INVALID_PRICING_SNAPSHO · 2 caída(s) / 2 declarada(s) · 3.1 s
✅ P2-d-d · un snapshot ilegible se anota como fallo OPERATIVO (TRANSACTION · 2 caída(s) / 2 declarada(s) · 27.2 s
✅ R6-2c · el protocolo del intento abre en REPEATABLE READ (la relectura d · 4 caída(s) / 4 declarada(s) · 47.1 s
✅ R7-g · la unidad de costo lee la configuración de pagos por el cliente G · 2 caída(s) / 2 declarada(s) · 6.8 s
✅ R7-g2 · la tarifa del negocio se lee por el cliente GLOBAL · 3 caída(s) / 3 declarada(s) · 6.1 s
✅ R8-g · el FALLBACK a PRIMARY lee la tarifa por el cliente GLOBAL · 2 caída(s) / 2 declarada(s) · 6.0 s
✅ R8-2a · el escenario de Codex: un snapshot SIN_TARIFA no cuenta como tar · 7 caída(s) / 7 declarada(s) · 25.8 s
✅ R8-2b · un snapshot SIN_TARIFA no cuenta como tarifa congelada (el fallb · 7 caída(s) / 7 declarada(s) · 22.5 s
✅ R8-2c · sin slot histórico y sin slot de hoy, la afiliación cae a PRIMAR · 4 caída(s) / 4 declarada(s) · 22.5 s
✅ R8-2d · el slot de HOY gana al slot histórico · 2 caída(s) / 2 declarada(s) · 29.8 s
✅ R8-P2 · un snapshot sin el campo `venue` se lee como SIN_TARIFA · 2 caída(s) / 2 declarada(s) · 3.2 s
```

Verificación pesada por avq-verify (DUAL: Mac y Alienware) sobre el árbol final (14-sep 03:2x–05:0x; corridas `avq-r8-*.txt` y
`avq-r8b-typecheck-ci.txt`; sin `AVQ_KEEP`, las carpetas run-… no se conservan en verde): typecheck del CI (`npm run typecheck` =
`tsc --noEmit` con `tsconfig.json`, que INCLUYE `tests/` y `scripts/`) — primera corrida **7 errores en 3 pruebas del checkpoint,
idénticos en local y Alienware (COINCIDEN)**, corregidos sin aflojar aserciones y REPETIDO sobre el árbol final: **0 errores, local y
Alienware COINCIDEN**; typecheck 5.8 de `src/` (`tsconfig.typecheck.json`) **0 errores, COINCIDEN**; suite unitaria completa en 4
shards **17,153 pruebas pasadas de 17,167 (14 omitidas): 4,128/4,128 · 4,707/4,715 · 3,784/3,785 · 4,534/4,539 — los cuatro COINCIDEN
con 0 fallos a la primera** (esta vez el probe de timing del event loop no apareció en ningún lado); integración de pagos completa
contra la base desechable **17 suites / 406 pruebas / 0 fallos** (sólo local: necesita Postgres); API `terminal-payment-attempts`
**6/6 COINCIDEN**. Todas las corridas avisaron `⚠️ vigencia` (el árbol compartido se movió por otras sesiones); comprobado con
`diff -rq src tests prisma` contra la copia certificada (rsync del 04:14) que NINGÚN archivo del checkpoint cambió durante la cadena
ni después.


**Novena auditoría de Codex (14-sep 05:01–05:2x, gpt-6-astra xhigh; `prompt-codex-cp1-r9.txt`, 81 KB; hilo
`01a09f94-4fef-7ff0-b76c-82580e13dfa3`): RECHAZADO** — veredicto íntegro en `codex-cp1-r9-veredicto.md`. Ver «Ronda 9» abajo.

### 🔴 Ronda 9 de la auditoría final de Codex (14-sep 05:2x): RECHAZADO — 1 P1 (R9-1) · 3 P2 (`jsonb_strip_nulls` sobre el snapshot · tarifa heredada de la organización en la FK · (l) remanente) · 1 P3 (selftest) → todos cerrados con TDD y sabotajes certificados (14-sep, madrugada)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r9-veredicto.md`. De la ronda 8 dio por CERRADOS R8-1, (g), el snapshot
sin `venue` y la prueba P2-d; por PARCIALES R8-2 (la recuperación por el slot de hoy) y (l) (los actores capturados pero no siempre
examinados). Recalculó la huella (`03e7ac38` + `43e538db89a89f88`) y revisó los 102 JSON de la certificación: 197 caídas de
aserción, ningún error mixto. Confirmó correcto: R8-1 tal como se exigió (dos llaves presentes y distintas se descartan por LLAVE
antes de comparar afiliaciones; los replays de R8-1 son idénticos), R8-2a/R8-2b no equivalentes, la prueba WEBHOOK de R8-2 ejercita la
unidad real, y los cierres anteriores (advisory → Payment, S1 bajo READ COMMITTED, mutex del costo, todo por `tx`). El P1 es un
hallazgo nuevo de la familia R3/R4/R8-2 («No reabre el escenario original de SECONDARY sin estructura: ése está corregido»); y Codex
RETIRÓ su aceptación anterior de la recuperación R3/R4: «Mi aceptación anterior de esa recuperación dejó incompleta la acreditación
histórica. Bajo la regla explícita de R8, volver a la configuración no basta.» No hubo ronda de diseño: el cambio exigido QUITA un
mecanismo (la inferencia del slot por la configuración de hoy), no añade uno. Los dos límites del founder se conservan.

- **R9-1 · `SIN_TARIFA` todavía convertía configuración actual en acreditación histórica.** Con `slot: null` (la afiliación
  estaba FUERA de la configuración al cobrar), `slotHistorico ?? slotDeHoy` tomaba el slot que la afiliación ocupa HOY y buscaba
  su estructura «a la fecha del cobro»: M2 procesa $1,000 fuera de la configuración; PRIMARY (de M1) tenía un 8 % vigente desde
  antes; hoy se configura M2 como PRIMARY ⇒ $80 de comisión y obligación DONE — «que M2 ocupe PRIMARY hoy no demuestra que esa
  tarifa correspondiera a su cargo anterior». Y la acreditación de las TASAS también estaba incompleta: `getEffectivePricing`
  comprueba vigencia y `active`, pero las filas se editan EN SITIO (tasas y `effectiveFrom`, `venuePricing.service.ts`), así que una
  estructura creada después y RETRODATADA, o una antigua editada hoy, también se seleccionaba — y «añadir `createdAt <= fecha`
  no cierra el segundo caso». Ahora la rama `SIN_TARIFA` de `createTransactionCost` es UNA sola cosa: «sin tarifa contratada al
  cobrar» es un hecho histórico que ninguna configuración posterior cambia ⇒ `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED`
  SIEMPRE, sin consultar tarifa alguna (ni PRIMARY, ni el slot de hoy, ni el slot histórico, ni una fila retrodatada, reactivada o
  editada). La obligación queda PENDIENTE y visible hasta una acreditación EXPLÍCITA de ese cargo — mecanismo declarado FUERA del
  checkpoint 1 (necesita responsable y procedimiento: hoy no hay palanca; es la misma familia que la evidencia de colisión). La
  recuperación R3/R4 «al devolver la afiliación a la configuración» que las rondas 3–8 aceptaron queda RETIRADA (las pruebas
  cambian de «converge» a «sigue pendiente»). Unitarias (`transactionCost.afiliacionAcreditada.test.ts`, describe «Codex R8-2 /
  R9-1», 8 casos): escenario de Codex (SECONDARY sin tarifa, PRIMARY 8 %) ⇒ pendiente y NINGUNA tarifa consultada; cambio posterior
  de slot; M2 fuera; el slot histórico «vuelve a tener» tarifa ⇒ sigue pendiente; `slot: null` → hoy PRIMARY con 8 % antiguo ⇒
  pendiente; `slot: null` → otro slot (TERTIARY) con tarifa ⇒ pendiente; `slot: null` → hoy SECONDARY sin tarifa ⇒ pendiente;
  `slot: null` y fuera ⇒ pendiente. Integración (costo real, describe «Codex R8-2 / R9-1»): registro REAL por REST con SECONDARY
  desactivada ⇒ COMPLETED, snapshot `{slot: 'SECONDARY', venue: null}`, 0 costos, PENDING `AFFILIATION_PRICING_UNRESOLVED`,
  `costPending`, fee 0 → M2 a PRIMARY ⇒ pendiente → SECONDARY 8 % creada hoy vigente mañana ⇒ pendiente → SECONDARY 2.5 % creada
  hoy RETRODATADA ⇒ pendiente → la original reactivada ⇒ pendiente → la original editada al 8 % ⇒ pendiente; `slot: null` (M2
  fuera al cobrar) → hoy PRIMARY ⇒ pendiente → de vuelta en SECONDARY 2.5 % ⇒ pendiente; WEBHOOK y con orden ⇒ pendiente
  también tras reactivar; y las tres pruebas R3/R4 de afiliación retirada («converge al devolver la afiliación») ahora afirman
  «sigue pendiente al devolverla».
- **P2 · un replay normal destruía el `venue: null` que exige el validador.** La consolidación aplicaba `jsonb_strip_nulls` al
  JSON COMPLETO existente, que borra también los nulos ANIDADOS: registro con SECONDARY sin tarifa → replay normal con datos de
  tarjeta o serial (`hayRelleno`, aunque coincidan) → `pricing.venue` desaparecía → la siguiente convergencia decía
  `INVALID_PRICING_SNAPSHOT` (un snapshot «corrupto» que nadie corrompió). Ahora `registroRepetido.ts` quita SÓLO los nulos de
  PRIMER nivel del `processorData` existente (los únicos que el `||` puede rellenar), con `jsonb_object_agg` sobre `jsonb_each`
  filtrando `'null'::jsonb`, y `COALESCE` a `'{}'` para el objeto vacío: el snapshot se conserva byte a byte, incluidos sus
  nulos semánticos. No se aflojó el validador. Pruebas (costo real, 2): registro SIN_TARIFA → replay legacy idéntico (mismo
  Payment) → `pricing` `toEqual` al de antes y `venue: null` presente → sigue `AFFILIATION_PRICING_UNRESOLVED` (nunca
  `INVALID_PRICING_SNAPSHOT`); y un snapshot VÁLIDO con `venue.fixedFeePerTransaction: null` (SECONDARY contratada sin cargo
  fijo) → replay → el nulo sobrevive → el costo converge al 2.5 % SIN cargo fijo (fee 2.5) aunque la tarifa de hoy vuelva a $0.50.
- **P2 · recuperar una tarifa heredada de la organización reventaba por clave foránea.** `findActiveVenuePricingStructure`
  devolvía `pricing[0]` perdiendo `source`; sin snapshot (`congelada` null) su id iba directo a `TransactionCost.venuePricingStructureId`,
  cuya FK sólo referencia `VenuePricingStructure` — un id de `OrganizationPricingStructure` ⇒ rollback y costo sin recuperar
  aunque la tarifa heredada existiera (hueco previo al checkpoint, para todo Payment sin snapshot en un venue que hereda la
  tarifa de su organización). Ahora el helper devuelve la estructura CON `source` y la creación del costo pone el id sólo si
  `source === 'venue'` (el mismo tratamiento de trazabilidad que ya tenían los snapshots válidos). Unitarias (2): tarifa heredada
  ⇒ costo con sus tasas y `venuePricingStructureId: null`; tarifa del venue ⇒ conserva el id. Integración (costo real, con
  `OrganizationPricingStructure` REAL): Payment sin `pricing` (anterior al registrador, con `pricingSlot` legacy) en un venue sin
  SECONDARY propia y con SECONDARY heredada ⇒ converge al 2.5 %, fee 3, `venuePricingStructureId` null — un mock de
  `transactionCost.create` no detectaba este defecto.
- **P2 · (l) remanente: los actores se capturaban pero no siempre se examinaban.** `enVuelo.asentadaEn` devolvía `true` tanto
  para éxito como para rechazo, `false` al vencer, y los `finally` ignoraban ambos: tras una aserción caída, un 503 capturado
  quedaba registrado sólo como aserción y una operación sin terminar podía esconderse tras los 15 s. Ahora existe `actores.ts`
  (módulo PURO, `tests/integration/payments/`, con prueba unitaria propia `tests/unit/testing/actoresEnVuelo.test.ts`, 7 casos):
  `lanzar(nombre, promesa)` captura al lanzar; `cerrar(fallo)` —DESPUÉS de soltar las barreras— espera acotada a TODOS y decide:
  un actor sin asentar ⇒ `Error('INCONCLUSO — actores sin asentar … · fallo original: …')` (no es una aserción: el runner lo
  clasifica INCONCLUSO, con el fallo original en el mensaje y en `cause`); un actor que rechazó y que ya nadie iba a examinar
  (porque hubo un fallo previo) ⇒ lo mismo; sin problemas relanza el fallo previo o deja seguir; `resultado()` relanza como
  `await promesa` (con `.resolves` es una aserción); y `examinados()` —última línea de la prueba— denuncia todo actor lanzado
  que nadie miró. Las pruebas de carrera pasaron a «recoger y afirmar después»: lo observado bajo los candados se guarda en
  variables, se sueltan las barreras, `cerrar`, se afirman los desenlaces de los actores (`await expect(actor.resultado()).resolves…`)
  y DESPUÉS lo observado — así un mutante se detecta por aserción sin esconder ningún desenlace: las tres de R7-1, K1/K2, el REST
  contra la transacción del webhook (T1 también es un actor), las dos intercalaciones vínculo↔escritor débil y las tres corridas
  contendidas del costo. `enVuelo` se retiró del fixture.
- **P3 · el selftest del «JSON real» podía pasar sin probarlo.** El JSON de R7-1a (ronda 7, con la aserción + el 503) vive ahora
  como FIXTURE INMUTABLE (`sab-selftest-r7-1a-mixto.json`, sólo lectura) y `--selftest` EXIGE que contenga el caso mixto (cero
  casos mixtos ⇒ FALLÓ).
- 🔴 Riesgos que Codex dejó fuera del bloqueo, tal cual: el presupuesto de búsqueda (1,000 páginas de 10) puede agotarse y
  repetirse indefinidamente (503, sin progreso eventual) — medir la distribución de candidatos y latencias antes de desplegar;
  dos cargos legacy DISTINTOS del mismo venue que sólo difieren en afiliación quedan como evidencia (el «venta nueva» anterior
  tampoco demostraba nada); el POS recibe 201 con Payment PENDING y recibo (`FastPaymentRecorder.kt:128` lo acepta como éxito;
  binarios publicados no validados); la evidencia la resuelve una persona contrastando el portal del procesador — no hay
  promoción automática.

**Sabotajes certificados (copia aislada, runner `sab-r7.py`, resultados estructurados):** 57 mutaciones — las 49 de las rondas 5–7
más R8-1a, R8-P2, R8-g (ronda 8) y, nuevos, R9-1a (la rama `SIN_TARIFA` deja de existir y el snapshot se trata como AUSENTE: caen
las 8 unitarias y las 7 de integración que lo fijan, incluidas las tres de R3/R4 que ahora afirman «sigue pendiente»), R9-2a (la
consolidación vuelve a `jsonb_strip_nulls` sobre todo el snapshot: caen las dos pruebas del snapshot conservado), R9-3a (el id de
la tarifa heredada vuelve a la FK: caen la unitaria y la de integración con `OrganizationPricingStructure` real), R9-la y R9-lb
(`actores.cerrar` deja pasar un rechazo no examinado / un actor sin asentar: caen sus unitarias). R8-2a..d se retiraron: anclaban
en la recuperación que R9-1 eliminó.

**Certificación DEFINITIVA de sabotajes (14-sep 06:1x–06:38, runner `sab-r7.py` sha `df128cad59414de1`, copia aislada
`$J/sab-server`, huella HEAD `03e7ac38` + WIP sha256 `8a95896b6c0453b1` (1,038,601 bytes), resultados estructurados en
`sab-r7-resultados.json`, corrida `sab-r7.txt`, JSON crudo y logs en `sab-r7-logs/`): 57/57 certificados · 196 caídas = 196
declaraciones · 0 INCONCLUSOS · 0 supervivientes · las 16 suites de control en verde antes de mutar · la copia aislada idéntica
al árbol antes y después. La corrida EXPLORATORIA (`sab-r9-exploratoria.txt`, 54/57, huella `79dbbdeb53b6cf56`) destapó tres cosas,
todas corregidas con esa evidencia: R5-C tumba también las dos pruebas nuevas que dejan la obligación pendiente (declaradas);
R9-1a tumba además la prueba del replay (declarada) y NO tumba la unitaria «M2 ya FUERA … slot histórico SECONDARY sin tarifa»
(bajo el mutante la rama legacy sin `pricingSlot` también lanza UNRESOLVED: mismo desenlace, no es detector — retirada de esa
declaración con la razón escrita); y R9-3a salió INCONCLUSO porque bajo el mutante la FK reventaba como error suelto de Prisma —
la prueba pasó a afirmar `await expect(cerrar(p.id)).resolves.toBe(true)`, que bajo el mutante cae como ASERCIÓN (la definición
de (l)). R7-1a sigue cayendo con UN solo error, de aserción (test (1), ahora por `.resolves` sobre el REST).

```
57/57 certificados · huella HEAD 03e7ac38 + WIP sha256 8a95896b6c0453b1 (1038601 bytes) · 2026-09-14T06:37:59
✅ R5-A · una consolidación que CONTRADICE vuelve a reparar la solicitud co · 2 caída(s) / 2 declarada(s) · 38.8 s
✅ R5-B · la tarifa se congela sobre la afiliación que MANDÓ el APK, no sob · 2 caída(s) / 2 declarada(s) · 21.3 s
✅ R5-C · el costo síncrono cierra la obligación aunque NO haya convergido  · 9 caída(s) / 9 declarada(s) · 28.6 s
✅ R5-D · la convergencia deja de proyectar la comisión en el Payment · 22 caída(s) / 22 declarada(s) · 29.8 s
✅ R5-F · «existe la fila del costo» vuelve a cerrar la obligación sin proy · 7 caída(s) / 7 declarada(s) · 10.2 s
✅ R5-G · el helper débil ignora el vínculo que ve bajo el candado · 15 caída(s) / 15 declarada(s) · 23.7 s
✅ R5-H · el helper débil escribe SIN tomar el candado del evento · 5 caída(s) / 5 declarada(s) · 4.5 s
✅ R5-I · el cruce de comercio no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 19.5 s
✅ R5-J · la discrepancia no decide por el vínculo aunque lo vea · 1 caída(s) / 1 declarada(s) · 20.7 s
✅ R5-K · el backfill no relee el vínculo de la llave del evento · 3 caída(s) / 3 declarada(s) · 23.2 s
✅ R5-L · la reapertura vuelve a ser best-effort FUERA de la transacción de · 4 caída(s) / 4 declarada(s) · 34.1 s
✅ R5-M · el vínculo REPETIDO deja de mirar los eventos débiles · 1 caída(s) / 1 declarada(s) · 4.3 s
✅ R5-N · la búsqueda por referencia vuelve a excluir los `type` NULL · 3 caída(s) / 3 declarada(s) · 41.3 s
✅ R5-O · el cruce de comercio vuelve a excluir los `type` NULL · 1 caída(s) / 1 declarada(s) · 3.7 s
✅ P2-P · la colisión devuelta por la llave se lee como MATCHED en el webho · 1 caída(s) / 1 declarada(s) · 24.0 s
✅ P2-Q · S6 no distingue la colisión de un NOT_RECORDED · 1 caída(s) / 1 declarada(s) · 34.5 s
✅ P2-R · el retorno idempotente liga al cliente a la orden del candidato a · 1 caída(s) / 1 declarada(s) · 6.0 s
✅ P2-S · la revocación deja de exigir la identidad del evento · 2 caída(s) / 2 declarada(s) · 24.4 s
✅ P2-T · el historial de revocaciones se pisa (sólo queda la última) · 1 caída(s) / 1 declarada(s) · 26.8 s
✅ P2-U · el validador del snapshot vuelve a aceptar null, booleanos y hexa · 10 caída(s) / 10 declarada(s) · 3.0 s
✅ P3-V · el SQL de S6 vuelve a recortar sólo espacios ASCII · 1 caída(s) / 1 declarada(s) · 15.2 s
✅ R6-A′ · una afiliación INACTIVA que el serial recupera se registra bajo  · 2 caída(s) / 2 declarada(s) · 26.8 s
✅ R6-B · una resolución incierta de la afiliación vuelve a leerse como «si · 1 caída(s) / 1 declarada(s) · 21.8 s
✅ R6-C · la discrepancia DÉBIL deja de reabrirse al llegar el vínculo · 1 caída(s) / 1 declarada(s) · 27.6 s
✅ R6-D · la reapertura toca también los rechazos bancarios y la discrepanc · 1 caída(s) / 1 declarada(s) · 29.2 s
✅ R6-E · la discrepancia deja de llevar la identidad del evento (la revoca · 1 caída(s) / 1 declarada(s) · 27.9 s
✅ R6-F · el camino del vínculo NUNCA toma el candado del intento (ni al pu · 5 caída(s) / 5 declarada(s) · 36.5 s
✅ R6-G · el escritor por identidad DÉBIL NO toma el candado del intento · 4 caída(s) / 4 declarada(s) · 49.2 s
✅ R6-H · la reapertura (también la idempotente, con transacción propia) NO · 2 caída(s) / 2 declarada(s) · 33.8 s
✅ R6-I · los Payments de la reapertura se bloquean SIN orden (interbloqueo · 1 caída(s) / 1 declarada(s) · 2.9 s
✅ R6-O · el escritor DÉBIL lee S1 ANTES de tomar el candado (fotografía vi · 2 caída(s) / 2 declarada(s) · 37.3 s
✅ R6-J · el mutex del costo espera (sin NOWAIT): dos corridas se intercala · 6 caída(s) / 6 declarada(s) · 31.4 s
✅ R6-K · `costPending` deja de nacer con la obligación (lo decidiría el cá · 2 caída(s) / 2 declarada(s) · 23.2 s
✅ R6-L · el worker deja de cerrar su obligación DENTRO de la unidad · 1 caída(s) / 1 declarada(s) · 14.7 s
✅ R6-M · una VenueTransaction ausente se lee como convergida · 1 caída(s) / 1 declarada(s) · 14.5 s
✅ R6-N · la contención se lee como convergencia · 5 caída(s) / 5 declarada(s) · 16.0 s
✅ R7-1a · la consolidación por referencia NO toma el candado del intento · 2 caída(s) / 2 declarada(s) · 49.8 s
✅ R7-1b · la consolidación IGNORA el vínculo releído bajo el candado (sólo · 2 caída(s) / 2 declarada(s) · 49.2 s
✅ R7-2a · la búsqueda por referencia vuelve a exigir SÓLO la afiliación de · 7 caída(s) / 7 declarada(s) · 59.6 s
✅ R8-1a · la consulta vuelve a filtrar por afiliación con la cláusula de l · 4 caída(s) / 4 declarada(s) · 36.0 s
✅ R7-2b · conjuntos de afiliación que no se cruzan ⇒ siempre «otro cargo»  · 5 caída(s) / 5 declarada(s) · 28.6 s
✅ R7-2c · el plan de consolidación contrasta la afiliación como UN campo ( · 2 caída(s) / 2 declarada(s) · 30.4 s
✅ R7-2d · un descarte AFILIACION_INCIERTA se registra como VENTA NUEVA (no · 4 caída(s) / 4 declarada(s) · 22.3 s
✅ P2-d-a · un snapshot de tarifa INVALIDO se trata como AUSENTE (se calcul · 3 caída(s) / 3 declarada(s) · 28.4 s
✅ P2-d-b · `includesTax` como cadena se acepta en el snapshot · 2 caída(s) / 2 declarada(s) · 4.3 s
✅ P2-d-c · los motivos VENUE_TRANSACTION_MISSING e INVALID_PRICING_SNAPSHO · 2 caída(s) / 2 declarada(s) · 2.8 s
✅ P2-d-d · un snapshot ilegible se anota como fallo OPERATIVO (TRANSACTION · 2 caída(s) / 2 declarada(s) · 28.5 s
✅ R6-2c · el protocolo del intento abre en REPEATABLE READ (la relectura d · 4 caída(s) / 4 declarada(s) · 46.7 s
✅ R7-g · la unidad de costo lee la configuración de pagos por el cliente G · 2 caída(s) / 2 declarada(s) · 6.9 s
✅ R7-g2 · la tarifa del negocio se lee por el cliente GLOBAL · 3 caída(s) / 3 declarada(s) · 6.5 s
✅ R8-g · el FALLBACK a PRIMARY lee la tarifa por el cliente GLOBAL · 2 caída(s) / 2 declarada(s) · 6.9 s
✅ R9-1a · un snapshot SIN_TARIFA vuelve a tratarse como AUSENTE (se resuel · 14 caída(s) / 14 declarada(s) · 28.2 s
✅ R9-2a · la consolidación vuelve a `jsonb_strip_nulls` sobre TODO el snap · 2 caída(s) / 2 declarada(s) · 23.3 s
✅ R9-3a · el id de una tarifa heredada de la ORGANIZACIÓN vuelve a la FK ` · 2 caída(s) / 2 declarada(s) · 27.1 s
✅ R9-la · `actores.cerrar` deja pasar un rechazo NO examinado detrás de un · 1 caída(s) / 1 declarada(s) · 3.0 s
✅ R9-lb · `actores.cerrar` deja pasar un actor que NO se asentó · 1 caída(s) / 1 declarada(s) · 3.1 s
✅ R8-P2 · un snapshot sin el campo `venue` se lee como SIN_TARIFA · 2 caída(s) / 2 declarada(s) · 3.0 s
```

Verificación pesada por avq-verify (DUAL: Mac y Alienware) sobre el árbol final (14-sep 05:4x–07:0x; corridas `avq-r9-*.txt` y
`avq-r9b-*.txt`): typecheck del CI (`npm run typecheck`, incluye `tests/` y `scripts/`) **0 errores, local y Alienware COINCIDEN**,
repetido sobre el árbol FINAL tras el último retoque de una prueba (`avq-r9b-typecheck-ci.txt`): **0 errores, COINCIDEN**; typecheck
5.8 de `src/` **0 errores, COINCIDEN**; suite unitaria completa en 4 shards **17,164 pruebas pasadas de 17,178 (14 omitidas):
4,132/4,132 · 4,707/4,715 · 3,791/3,792 · 4,534/4,539**: shards 1, 2 y 4 COINCIDEN con 0 fallos a la primera; el shard 3 marcó
`DIFIEREN` por UN fallo sólo en la Mac —`catalogWorkbook.eventloop-budget.test.ts` («freezes the 50 ms budget…» midió 135 ms con la
certificación de sabotajes corriendo al lado; archivo SIN cambios respecto a HEAD), la familia documentada de probes de presupuesto
del event loop— y el archivo EXACTO repetido con `--runInBand` en DUAL da **4/4 en ambos lados, COINCIDEN** ⇒ probe de carga no
determinista, no código (regla del workspace); integración de pagos completa contra la base desechable **17 suites / 410 pruebas /
0 fallos** (sólo local: necesita Postgres); API `terminal-payment-attempts` **6/6 COINCIDEN**. Comprobado con `diff -rq src tests
prisma` contra la copia certificada que NINGÚN archivo del checkpoint cambió durante la cadena ni después.

**Décima auditoría de Codex (14-sep 07:1x–07:4x, gpt-6-astra xhigh; `prompt-codex-cp1-r10.txt`, 67 KB; hilo
`01a0a004-0db8-7620-8394-494a8e1a4566`): RECHAZADO** — veredicto íntegro en `codex-cp1-r10-veredicto.md`. Ver «Ronda 10» abajo.

### 🔴 Ronda 10 de la auditoría final de Codex (14-sep 07:4x): RECHAZADO — 1 P1 (R10-1) · 2 P2 ((l) remanente · SIN_TARIFA sin configuración) · 1 P3 (textos) → todos cerrados con TDD y sabotajes certificados (14-sep, mañana)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r10-veredicto.md`. De la ronda 9 dio por CERRADOS R9-1 (la rama
`SIN_TARIFA` lanza incondicionalmente; `slotHistorico ?? slotDeHoy` desapareció), el strip de nulos (sólo primer nivel, con
replay real y snapshot conservado), la FK (origen conservado; integración con estructura de organización real) y el selftest
(fixture inmutable `0444` con el caso mixto); por PARCIAL (l). Recalculó la huella (`03e7ac38` + `8a95896b6c0453b1`), `diff`
limpio contra la copia certificada, 102 JSON con 196 caídas de aserción y ningún error mixto. Confirmó correcto: la fusión de
nulos es superficial y ningún relleno legítimo dependía de borrar nulos anidados; `COALESCE` cubre el objeto vacío; ningún otro
escritor pone un id de organización en esa FK (`createRefundTransactionCost` copia la FK del costo original); las pruebas nuevas
prueban lo que dicen (`aTexto` conserva el `null` del fijo); las de retrodatación/edición son regresiones útiles de UNA regla; y
**sobre el 503: «sí cuenta como aserción cuando la prueba exige explícitamente que ese REST termine correctamente mediante
`.resolves` … No retiro esa certificación ni exijo que todo error operativo afirmado sea inconcluso. Lo inconcluso es esconder
otro desenlace o dejar un actor sin terminar.»** El P1 es de la familia R3/R4/R8-2/R9-1: «El `SIN_TARIFA` correctamente
persistido ya está protegido. El hueco está en cómo nace el snapshot cuando una lectura falla.» Sin ronda de diseño (es el
mismo protocolo del snapshot, con el cambio exacto exigido). Los dos límites del founder se conservan.

- **R10-1 · fallar al congelar la tarifa convertía un cobro nuevo en «sin snapshot» y habilitaba PRIMARY.** `tarifaDeLaAfiliacion`
  (registrador) capturaba CUALQUIER error y devolvía `{slot: null, pricing: null}`; y `tarifaCongeladaDeLaAfiliacion` leía la
  tarifa del negocio y el costo del proveedor en un `Promise.all` con un solo `catch`: bastaba que fallara la consulta del
  PROVEEDOR para perder también la tarifa del negocio ya leída. El lector trataba `pricing: null` como AUSENTE ⇒ M2 en SECONDARY
  sin tarifa ⇒ fallback a PRIMARY ⇒ $80 sobre $1,000 y obligación DONE — por REST y por webhook, sin SQL ni cambio de
  configuración. Ahora: (a) cada lectura se captura POR SEPARADO (`capturaFallida: { configuracion?, negocio?, proveedor? }` con el
  mensaje, no la excepción) y la evidencia obtenida se conserva — si sólo falló el proveedor, la tarifa del negocio congelada
  manda y el costo del proveedor se toma de su configuración a la fecha; (b) si ni siquiera se pudo intentar, el registrador
  guarda `tarifaConCapturaFallida` (`capturaFallida.total`) — nunca `pricing: null` con afiliación; (c) el lector tiene el estado
  `CAPTURA_FALLIDA` (configuración, negocio o total fallidos; va ANTES de mirar `venue`, porque con slot y `venue: null`
  parecería SIN_TARIFA) ⇒ `COST_PENDING_PRICING_CAPTURE_FAILED` ⇒ motivo público `PRICING_CAPTURE_FAILED`, sin consumir
  intentos, y NUNCA se relee la tarifa «a la fecha del cobro» al recuperarse la base (eso sería reconstruir la historia desde la
  configuración de hoy, R9-1); (d) `pricing: null` CON afiliación registrada es INVALIDO (`PRICING_NULO_CON_AFILIACION`) — sólo
  es AUSENTE sin afiliación (manual/QR, que el registrador escribe así). Unitarias (`transactionCost.afiliacionAcreditada.test.ts`,
  describe «Codex R10-1», 7 casos + 4 del lector): proveedor fallido ⇒ VALIDO con `provider: null` y el marcador; tarifa fallida ⇒
  `capturaFallida.negocio`, proveedor conservado, CAPTURA_FALLIDA; configuración fallida ⇒ `capturaFallida.configuracion`; sin
  fallo no hay marcador; el escenario de Codex ⇒ PRICING_CAPTURE_FAILED sin consultar tarifa; sólo proveedor fallido ⇒ 2.5 %
  congelado + 2 % del proveedor; `pricing: null` con afiliación ⇒ INVALIDO. Integración (costo real, describe «Codex R10-1», 6,
  con fallos INYECTADOS en la lectura real —`prisma.providerCostStructure.findFirst`, `getEffectivePricing`,
  `getEffectivePaymentConfig`— y la base recuperada después): REST con proveedor fallido ⇒ converge al 2.5 %; el escenario de
  Codex (SECONDARY sin tarifa + proveedor fallido) ⇒ SIN_TARIFA, pendiente `AFFILIATION_PRICING_UNRESOLVED`, nunca $80; tarifa
  fallida ⇒ COMPLETED, `capturaFallida.negocio`, PENDING `PRICING_CAPTURE_FAILED`, fee 0, sigue así con la base sana, y un replay
  del APK viejo conserva el marcador byte a byte; con orden y configuración fallida ⇒ cuenta PAID, pendiente; WEBHOOK con tarifa
  fallida ⇒ pendiente al vencer el plazo; y el motivo es público en la lectura de efectos.
- **P2 · sin configuración de pagos, `SIN_TARIFA` perdía su motivo y podía morir en DEAD_LETTER.** `createTransactionCost` exigía la
  configuración efectiva ANTES de leer el snapshot: sin configuración (ni venue ni organización) salía por el error genérico y el
  worker consumía intentos. Ahora el snapshot se clasifica PRIMERO —INVALIDO, CAPTURA_FALLIDA y SIN_TARIFA lanzan su motivo sin
  tocar la configuración— y sólo VALIDO/AUSENTE la exigen. Unitarias (4): SIN_TARIFA / CAPTURA_FALLIDA / INVALIDO sin
  configuración ⇒ su motivo y `getEffectivePaymentConfig` NO se llama; AUSENTE ⇒ el error genérico (ése sí depende de ella).
  Integración: SIN_TARIFA + `venuePaymentConfig` borrada ⇒ sigue PENDING `AFFILIATION_PRICING_UNRESOLVED`, `attempts` intactos.
- **P2 · (l) remanente: el examen podía terminar antes de revisar a todos los actores.** Dos huecos concretos: tras `cerrar`, si
  caía la aserción del vínculo no se ejecutaban la del REST ni `examinados()`; y `carrera(intento.resultado())` marcaba examinado
  al PEDIR el desenlace, así que una carrera ganada por el reloj «acreditaba» un examen que no ocurrió. Ahora `actores.ts` tiene
  `afirmar(fase)`: la fase de aserciones corre dentro y, si una cae a medias, los actores que quedaban se examinan igual — un
  rechazo entre ellos ⇒ `INCONCLUSO` conservando el fallo original (mensaje y `cause`); si la fase termina bien, `examinados()`
  exige que nadie quedara sin mirar; y `carrera(actor, ms)` compite el actor contra el reloj y devuelve su desenlace como DATO
  (`BLOQUEADA` ⇒ sigue sin examinar; `ASENTADA` ⇒ examinado); `resultado()` marca sólo al ENTREGAR (tras asentarse) y no se usa
  para competir contra relojes. Las 11 pruebas de carrera pasaron a «recoger → soltar → `cerrar(fallo)` → `afirmar(…)`», la de
  presupuesto VENCIDO incluida (la primera corrida es un actor cuyo rechazo esperado se AFIRMA con `.rejects`). Unitarias de
  `actores` (11): `afirmar` con rechazo pendiente ⇒ INCONCLUSO con el original; con todo resuelto ⇒ relanza el original; termina
  bien con un actor sin examinar ⇒ INCONCLUSO; `carrera` ganada por el reloj no acredita, ganada por el actor sí.
- **P3 · textos que prometían la recuperación eliminada.** El comentario del lector decía «hasta que la afiliación vuelva a tener
  tarifa» y la tool del MCP `payment_effects` presentaba `AFFILIATION_PRICING_UNRESOLVED` como «ya no tiene tarifa en la
  configuración». Ahora ambos dicen lo que es: al cobrar NO había tarifa contratada, un hecho histórico que configurar una tarifa
  hoy no resuelve — hace falta acreditar ese cargo explícitamente; y el MCP lista además `PRICING_CAPTURE_FAILED`,
  `INVALID_PRICING_SNAPSHOT` y `VENUE_TRANSACTION_MISSING`.
- 🔴 Riesgos que Codex dejó fuera del bloqueo, tal cual: «pendiente» no es comisión gratis ni venta perdida (la venta sigue
  COMPLETED; `feeAmount: 0` y neto bruto son provisionales; el balance expone `uncostedCount/uncostedAmount` y el calendario no
  proyecta liquidación sin costo) — operación y clientes deben ver esa distinción y la cola permanente necesita responsable;
  borrar `pricing` por SQL habilita AUSENTE (no hay marca independiente); la corrección masiva de tarifas (`rateCorrectionApply`)
  puede recalcular y crear costos sin mirar el snapshot — es una acción administrativa con bitácora, NO una acreditación del
  cargo (la frase «hoy no hay palanca» necesita esa precisión); la acreditación explícita futura debe identificar Payment y cargo,
  conservar tasas exactas (fijo e IVA), exigir permiso financiero, dejar actor/motivo/antes/después, ser idempotente y consumirse
  bajo el mismo mutex; medir el crecimiento de obligaciones permanentes y el presupuesto de búsqueda; validar los binarios.

**Sabotajes certificados (copia aislada, runner `sab-r7.py`, resultados estructurados):** 63 mutaciones — las 57 de la ronda 9 (R9-1a
reanclada) más R10-1a (la captura vuelve a ser todo-o-nada y el registrador guarda `pricing: null`), R10-1b (el lector ignora
`capturaFallida`), R10-1d (`pricing: null` con afiliación vuelve a ser AUSENTE), R10-2a (`PRICING_CAPTURE_FAILED` se anota como
fallo operativo), R10-la (`afirmar` deja pasar un rechazo no examinado) y R10-lb (`carrera` acredita examen aunque gane el reloj).

**Certificación DEFINITIVA de sabotajes (14-sep 08:22–08:37, runner `sab-r7.py` sha `dabe16680ddd8dab`, copia aislada
`$J/sab-server`, huella HEAD `03e7ac38` + WIP sha256 `04db676334c67f02` (1,074,413 bytes), resultados estructurados en
`sab-r7-resultados.json`, corrida `sab-r7.txt`, JSON crudo y logs en `sab-r7-logs/`; corrió SOLA, sin la cadena avq al lado):
63/63 certificados · 232 caídas = 232 declaraciones · 0 INCONCLUSOS · 0 supervivientes · las 16 suites de control en verde antes de
mutar (467 pruebas) · la copia aislada idéntica al árbol antes y después (`diff -rq src tests prisma` = 0). La corrida EXPLORATORIA
(`sab-r10-exploratoria.txt`, 55/63, huella `8bb8f73bcc36bdb4`, runner `ef787af3039140d3`, 07:37–08:00, con la cadena avq corriendo al
lado) destapó ocho desajustes, todos resueltos con esa evidencia y ninguno aflojando una prueba: cuatro CAÍDAS NO DECLARADAS que son
detectores nuevos legítimos y se declararon — R5-C tumba también las cinco pruebas nuevas de la ronda que dejan la obligación
pendiente (P2 sin configuración, escenario de Codex, tarifa fallida, configuración fallida con orden, motivo público); P2-d-a tumba las
dos de `pricing: null` con afiliación e INVALIDO sin configuración; R9-1a tumba además SIN_TARIFA sin configuración, el P2 y el
escenario de Codex (17 caídas en total); y R9-2a tumba la de «tarifa fallida … el replay conserva el marcador byte a byte» (el strip
profundo borra el `venue: null` del snapshot con captura fallida) —; y cuatro INCONCLUSOS, ninguno del código: R5-D, R6-J y R6-N
porque bajo esos mutantes la prueba de presupuesto VENCIDO caía por el rechazo P2028 de la primera corrida sin que ninguna aserción lo
examinara (la definición estricta de (l) lo clasifica como «error ajeno»), y la prueba pasó a AFIRMAR ese rechazo esperado PRIMERO
(`await expect(primera.resultado()).rejects.toThrow(/expired|already closed|Transaction API error|P2028/i)` dentro de `afirmar`), con lo
que bajo el mutante cae como ASERCIÓN; y R5-N porque dos pruebas del registrador («el reintento del PROPIO ganador» y «sin serial
autenticado») vencieron su transacción con la máquina saturada por la cadena avq — en la definitiva, sola, R5-N cae 3/3 declaradas
sin ningún vencimiento. Los seis sabotajes nuevos de la ronda: R10-1a 4/4, R10-1b 11/11, R10-1d 2/2, R10-2a 5/5, R10-la 1/1, R10-lb
1/1.

```
✅ R10-1a · la captura vuelve a ser todo-o-nada: la lectura de la tarifa de · 4 caída(s) / 4 declarada(s) · 16.7 s
✅ R10-1b · el lector ignora `capturaFallida` (una captura fallida del nego · 11 caída(s) / 11 declarada(s) · 15.8 s
✅ R10-1d · `pricing: null` CON afiliación vuelve a leerse como AUSENTE (la · 2 caída(s) / 2 declarada(s) · 1.2 s
✅ R10-2a · el motivo PRICING_CAPTURE_FAILED se anota como fallo operativo  · 5 caída(s) / 5 declarada(s) · 15.8 s
✅ R10-la · `actores.afirmar` deja pasar un rechazo que la fase de asercion · 1 caída(s) / 1 declarada(s) · 1.5 s
✅ R10-lb · `actores.carrera` acredita examen aunque gane el reloj · 1 caída(s) / 1 declarada(s) · 1.5 s
✅ R9-1a · un snapshot SIN_TARIFA vuelve a tratarse como AUSENTE (se resuel · 17 caída(s) / 17 declarada(s) · 14.5 s
✅ R5-D · la convergencia deja de proyectar la comisión en el Payment · 23 caída(s) / 23 declarada(s) · 19.2 s
✅ R5-N · la búsqueda por referencia vuelve a excluir los `type` NULL · 3 caída(s) / 3 declarada(s) · 23.4 s
✅ R6-J · el mutex del costo espera (sin NOWAIT): dos corridas se intercala · 6 caída(s) / 6 declarada(s) · 18.6 s
✅ R6-N · la contención se lee como convergencia · 5 caída(s) / 5 declarada(s) · 8.4 s
```

Verificación pesada por avq-verify (DUAL: Mac y Alienware) sobre el árbol final (14-sep 07:5x–08:5x; corridas `avq-r10-*.txt` y
`avq-r10b-*.txt`): typecheck del CI (`npm run typecheck`, incluye `tests/` y `scripts/`) **0 errores, local y Alienware COINCIDEN**,
repetido sobre el árbol FINAL tras corregir la unitaria del registrador (`avq-r10b-typecheck-ci.txt`): **0 errores, COINCIDEN**;
typecheck 5.8 de `src/` **0 errores, COINCIDEN**; suite unitaria completa en 4 shards **17,185 pruebas pasadas de 17,199 (14
omitidas): 4,148/4,148 · 4,707/4,715 · 3,795/3,796 · 4,535/4,540** (359 + 359 + 359 + 358 suites): el shard 1 falló a la primera en
LOS DOS lados con **1 fallo idéntico** (`payment.tpv.service.test.ts`: `tarifaConCapturaFallida is not a function` — el `jest.mock`
de lista fija de esa unitaria enumeraba los exports de `transactionCost.service` y no vio el nuevo; corregido con
`...jest.requireActual(...)`, la trampa ya documentada de los mocks con lista fija) y REPETIDO sobre el árbol final: **359 suites /
4,148 pruebas / 0 fallos, COINCIDEN**; el shard 2 marcó `DIFIEREN` por UN fallo sólo en el Alienware —
`catalogImportDurableEventLoop.service.test.ts` («yields through maximum nested bindings…», archivo SIN cambios respecto a HEAD),
la familia documentada de probes de presupuesto del event loop— y el archivo EXACTO repetido con `--runInBand` en DUAL da **1/1 en
ambos lados, COINCIDEN** ⇒ probe de carga no determinista, no código (regla del workspace); shards 3 y 4 COINCIDEN con 0 fallos a la
primera; integración de pagos completa contra la base desechable **17 suites / 417 pruebas / 0 fallos**, dos veces (antes y después
del arreglo del mock; sólo local: necesita Postgres); API `terminal-payment-attempts` **6/6 COINCIDEN**. Las corridas avisaron `⚠️
vigencia` (el árbol compartido se movió: trabajo AJENO de otra sesión); comprobado con `diff -rq src tests prisma` contra la copia
certificada que NINGÚN archivo del checkpoint cambió durante la cadena ni después (0 diferencias en los tres directorios).

**Undécima auditoría de Codex (14-sep 08:57–09:22, gpt-6-astra xhigh; `prompt-codex-cp1-r11.txt`, 65 KB; 8.2 M tokens de
entrada, 7.7 M en caché): RECHAZADO** — veredicto íntegro en `codex-cp1-r11-veredicto.md`. Ver «Ronda 11» abajo.

### 🔴 Ronda 11 de la auditoría final de Codex (14-sep 09:22): RECHAZADO — 1 P1 (R11-1) · 2 P2 ((l) remanente en K1/K2 y la consolidación en vuelo · la consolidación borraba el `pricing: null` que R10 protege) · 2 P3 (marcador vacío · cobertura declarada mayor que la demostrada) → todos cerrados con TDD y sabotajes certificados (14-sep, mañana)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r11-veredicto.md`. Recalculó la huella (`03e7ac38` + `04db676334c67f02`,
1,074,413 bytes), `diff` limpio contra la copia certificada, y contrastó los 63 manifiestos con los 111 JSON conservados: 232 caídas
declaradas, ningún error mixto. De la ronda 10 dio por CERRADOS R10-1 (captura por lectura, marcador `total` en el registrador,
lector que distingue null con afiliación y captura fallida), el P2 de la configuración (clasificación antes de exigirla) y el P3 de
los textos; por PARCIAL (l). Confirmó correcto: los dos registradores capturan antes de persistir y S2 entra por ellos; backfill y
reapertura conservan `pricing`; la consolidación conserva los objetos con `capturaFallida` y sus nulos anidados; el fallo exclusivo
del proveedor es aceptable (la consulta posterior es el costo que paga Avoqado, con la afiliación del Payment y `db`); la precedencia
del marcador antes de `venue` es conservadora; las inyecciones alcanzan la lectura real (`db = prisma`); el fixture sin
configuración deja también sin configuración a la organización; los sabotajes R10 atacan productor, lector, null y clasificación
pública (1a es compuesto); y los cierres anteriores se conservan. **El P1 es un hallazgo nuevo de la familia R3/R4/R8-2/R9-1/R10-1:
ninguna lectura falla — la composición era inconsistente.** Sin ronda de diseño: Codex nombró el cambio exacto («una consulta conjunta
o una captura con snapshot consistente») y el mecanismo es el de siempre de Postgres (REPEATABLE READ = instantánea única). Los dos
límites del founder se conservan.

- **R11-1 · dos lecturas CORRECTAS podían congelar una combinación afiliación→slot→tarifa que nunca existió.** La captura leía la
  configuración (qué slot ocupa M2) y después la tarifa de ese slot por el cliente global: dos instantes distintos de la base. Entre
  ambas cabían dos operaciones ordinarias del superadmin —poner a M3 en SECONDARY (`venuePricing.service.ts:379`) y editar esa
  estructura al 8 % en sitio (`:796`)— y el snapshot salía `{merchantAccountId: M2, slot: SECONDARY, creditRate: 0.08}`, VALIDO, sin
  `capturaFallida`: $80 y $920 netos sobre $1,000 en vez de $25 y $975, y la obligación podía cerrar DONE. Ahora
  `tarifaCongeladaDeLaAfiliacion` lee configuración y tarifa DENTRO de una transacción `REPEATABLE READ` de sólo lectura (la
  instantánea se fija en la primera consulta; `getEffectivePaymentConfig(venueId, tx)` y `getEffectivePricing(venueId, slot, at, tx)`
  ven la MISMA base); el costo del proveedor sigue aparte, por el cliente global (no forma parte de esa asociación, y así la
  inyección de fallos de R10 sigue alcanzando la lectura real). Cada lectura se sigue capturando por separado dentro de la
  transacción (medido en Postgres: un error de base en la lectura de la tarifa aborta la transacción, la captura conserva el
  marcador `negocio` y el `COMMIT` no lanza); si la transacción falla EN SÍ (abrirla o cerrarla) sin que ninguna lectura haya dejado
  su marca, se guarda `capturaFallida.total` — nunca `pricing: null`, nunca se lanza. Pasar el mismo cliente en READ COMMITTED no
  bastaría (cada sentencia vería la base de su instante): hay sabotaje que lo demuestra. La captura corre FUERA de la transacción
  del registrador en los dos caminos (`payment.tpv.service.ts` ~:2970 y ~:4457, nivel superior de la función), así que no anida
  transacciones. Unitarias (`transactionCost.afiliacionAcreditada.test.ts`, describe «Codex R11-1»): abre UNA transacción con
  `isolationLevel: 'RepeatableRead'` y pasa SU cliente a las dos lecturas (un objeto distinto del global, aportado por el mock) mientras
  el proveedor se lee por el global; la intercalación simulada (la tarifa por otro cliente ya dice 8 %, por la vista de la captura
  2.5 %) congela 2.5 %; la transacción que falla en sí ⇒ `capturaFallida.total`, proveedor conservado, CAPTURA_FALLIDA. Integración
  (costo real, describe «Codex R11-1», 3): la intercalación REAL durante la captura —un `spyOn` de `getEffectivePaymentConfig` que
  llama a la lectura real con el cliente de la transacción y, antes de devolver, por el cliente global pone a M3 en SECONDARY y edita
  esa tarifa al 8 %— por REST rápido, con orden y WEBHOOK: el snapshot es M2 + SECONDARY + 2.5 % (sin marcador), la configuración de
  hoy ya dice M3, y el costo converge a $2.50 + $0.50 sobre $100 — nunca $8.50.
- **P2 · (l) remanente: un agregado tiraba el segundo rechazo, y una carrera vivía fuera del protocolo.** En K1/K2 (registrador)
  `Promise.all([k1.resultado(), k2.resultado()])` entregaba sólo el primer rechazo mientras `resultado()` marcaba examinados a los
  dos: el segundo desenlace desaparecía y `afirmar` ya no tenía nada que denunciar. Ahora cada desenlace se afirma POR SEPARADO
  dentro de `afirmar` (si K1 cae, K2 se examina igual: un rechazo ⇒ INCONCLUSO con el fallo original). La consolidación en vuelo de
  «una fila que OTRO escritor ya acreditó» entra al protocolo (`lanzar` → `cerrar(fallo)` → `afirmar` con `.resolves.toBeNull()`):
  antes, si caía la observación bajo el candado, su `await` no se ejecutaba. Unitarias de `actores` (+3): dos rechazos DISTINTOS (la
  fase afirma K1 y cae; K2 no se pierde: INCONCLUSO lo nombra con su mensaje y conserva el original en `cause`); una aserción que
  cae ANTES de examinar a nadie con un actor rechazado ⇒ INCONCLUSO, y con todos resueltos se relanza tal cual; y una GUARDIA
  estática: ninguna prueba de pagos agrega `resultado()` con `Promise.all/race/allSettled/any` (comprobado que atrapa la línea
  vieja). Codex confirmó: `.resolves` sigue siendo una aserción legítima y `carrera` con `{ok:false}` sí acredita examen cuando la
  prueba afirma ese desenlace.
- **P2 · la consolidación borraba el `pricing: null` que R10 declara INVALIDO.** La limpieza de nulos de primer nivel del
  `processorData` existente (R9 (P2)) quitaba también `pricing: null`, y un replay normal lo convertía en «sin snapshot» (AUSENTE ⇒
  la tarifa de hoy, o PRIMARY sin `pricingSlot`). Ningún productor normal del checkpoint escribe ese null con afiliación (por eso
  Codex no lo subió a P1), pero rompía la defensa contra el dato viejo o alterado. Ahora la limpieza sólo toca los nulos de las
  llaves que ESE relleno trae (`… WHERE e.value <> 'null' OR NOT (nuevo ? e.key)`): marca, últimos 4, banco, serial…; el snapshot
  nunca se limpia porque el relleno nunca trae `pricing`. Integración: `pricing: null` con afiliación (escrito a mano sobre un cobro
  con captura fallida) ⇒ INVALID_PRICING_SNAPSHOT pendiente; un replay normal lo conserva byte a byte y la obligación sigue
  pendiente, sin costo ni comisión.
- **P3 · el marcador dependía de que el error tuviera mensaje.** `new Error('')` (o un error de Prisma cuya primera línea es vacía)
  dejaba `{negocio: ''}` y la comprobación por «verdad» lo leía como si nada hubiera fallado ⇒ SIN_TARIFA (motivo histórico
  equivocado, aunque sin habilitar PRIMARY). Ahora `mensajeDe` nunca devuelve vacío (mensaje, o nombre y código del error, o «(error
  sin mensaje)») y el lector decide por la PRESENCIA del campo (`typeof === 'string'`), con dos detectores distintos (uno por cada
  defensa) y sabotajes separados.
- **P3 · cobertura declarada mayor que la demostrada.** La prueba R4-3 del REST prometía «aunque la tarifa cambie un segundo después»
  y no la cambiaba: ahora edita SECONDARY al 8 % tras el cobro y afirma que ni el costo escrito ni un cierre repetido se mueven. Y el
  mutante que faltaba —«sólo `capturaFallida.proveedor` también invalida la evidencia del negocio»— entra al runner como R11-4a,
  certificando que las pruebas que Codex señaló (unitaria e integración) sí lo detectan.
- 🔴 Riesgos que Codex dejó fuera del bloqueo, tal cual: VALIDO todavía exige que exista la configuración de pagos de hoy antes del
  `findUnique` de la afiliación (sin ninguna, termina como fallo operativo/DEAD_LETTER: no reabre SIN_TARIFA); `rateCorrectionApply`
  puede crear costos sin mirar el snapshot (riesgo administrativo ya identificado, no una acreditación explícita); operación y APK
  publicados (responsable de las pendientes permanentes, comisión/neto provisionales, validar los binarios ante ACK perdido,
  webhook primero y reanuncio sin repetir el SDK — nada de eso lo certifican las pruebas del servidor).

**Sabotajes certificados (copia aislada, runner `sab-r7.py`, resultados estructurados):** 69 mutaciones — las 63 de la ronda 10
(R9-2a, R10-1a y R10-1b reancladas sobre las líneas nuevas; R9-2a y R10-1a con las caídas nuevas declaradas) más R11-1a (la captura
lee por el cliente GLOBAL, dos vistas), R11-1b (la transacción pierde REPEATABLE READ), R11-2a (la consolidación vuelve a borrar todos
los nulos de primer nivel), R11-3a (el marcador puede quedar vacío), R11-3b (el lector decide por «verdad») y R11-4a (sólo el
proveedor fallido invalida la evidencia del negocio).

**Decisión del founder (14-sep 10:0x), tras preguntar «hemos estado de auditoría en auditoría gastando tokens… ¿no sería mejor
que Codex te diga exactamente qué hacer?»:** medido, once auditorías, ~65 M tokens de entrada a Codex (94 % en caché), 25–40 min
cada una, hallazgos por ronda 7 → 4 → 4 → 6 → 6 → 3 → 2 → 2 → 1 → 1 → 1 P1 y las últimas cuatro de la misma familia; cada tabla de
Codex daba por CERRADO lo de la ronda anterior (salvo (l), PARCIAL tres veces): el auditor no rechazaba lo hecho, destapaba la
siguiente capa. Eligió la opción recomendada —**la duodécima NO es otra auditoría del diff: es UNA PASADA EXHAUSTIVA** de la
familia «tarifa congelada + convergencia» y del resto del checkpoint, con definición de hecho; se cierra todo de una vez y
después UNA auditoría de autorización— con la condición «que quede más rápido pero absolutamente no descuidando la calidad del
código; prefiero que quede bien > tiempo de entrega». Memoria: `feedback-auditorias-de-codex-una-pasada-exhaustiva-no-por-capas`.

**Certificación DEFINITIVA de sabotajes (14-sep 10:31–10:49, runner `sab-r7.py` sha `5da3abb0f6fb0561`, copia aislada
`$J/sab-server`, huella HEAD `03e7ac38` + WIP sha256 `8f672be12b6994f4` (1,095,901 bytes), resultados estructurados en
`sab-r7-resultados.json`, corrida `sab-r7.txt`, JSON crudo y logs en `sab-r7-logs/`; con la cadena avq y Codex corriendo al lado):
69/69 certificados a la primera · 266 caídas = 266 declaraciones · 0 INCONCLUSOS · 0 supervivientes · las 16 suites de control en
verde antes de mutar (445 pruebas). Es la SEGUNDA definitiva: la primera (09:58–10:17, huella `c099233d9efb6c93`, 68/69 + R11-4a
repetida con `SAB_ONLY` tras declarar un detector más ⇒ 69/69, archivada en `sab-r7-resultados-r11-definitiva-1-fusionada.json`)
certificó un árbol que la cadena avq tumbó por TIPOS: `npm run typecheck` (CI, DUAL) cazó `TS2339: Property 'pricing' does not
exist on type 'never'` en la captura nueva — TypeScript no ve las asignaciones hechas dentro del callback de `$transaction` y
estrechaba la variable del cierre a `null`/`never`; jest no lo detecta porque transpila sin comprobar tipos. Se reescribió sin tocar
la lógica (la transacción DEVUELVE `{ slot, negocio }`), typecheck del CI 0 (local, incremental), 94 unitarias y 48 de costo real en
verde, R10-1a y R11-1a reanclados, y la certificación se repitió entera sobre ese árbol. La copia aislada fue idéntica al árbol al
arrancar; al terminar difería en 22 archivos AJENOS que otra sesión reformateó con prettier a las 10:38 (comisiones, referidos,
reembolsos del dashboard, recibo, pruebas de la terminal): ninguno del checkpoint, sólo formato. La
corrida EXPLORATORIA (`sab-r11-exploratoria.txt`, 62/69, huella `65e47c9ee6c2579b`, runner `f2ed806fe310e623`, 09:39–09:56, sola)
destapó siete desajustes, todos resueltos con esa evidencia y ninguno aflojando una prueba: seis CAÍDAS NO DECLARADAS que son
detectores nuevos legítimos y se declararon — R5-C, P2-d-a y P2-d-d tumban también la prueba del `pricing: null` de primer nivel
(exige la obligación pendiente con INVALID_PRICING_SNAPSHOT); R5-D tumba las tres intercalaciones reales y la R4-3 del REST
corregida (afirman `feeAmount`); R10-1b tumba las tres pruebas nuevas del marcador (leen CAPTURA_FALLIDA por el lector); R10-la
tumba los dos casos nuevos de `afirmar` —; y UN INCONCLUSO, R11-4a, porque la unitaria «con sólo el proveedor fallido al cobrar, el
costo converge…» llamaba a `createTransactionCost` sin afirmarlo (bajo el mutante rechazaba con
`COST_PENDING_PRICING_CAPTURE_FAILED` como error suelto): ahora la convergencia SE AFIRMA (`await expect(...).resolves.toBeDefined()`),
con lo que bajo el mutante cae como ASERCIÓN. En la definitiva, R11-4a destapó todavía un detector más sin declarar (la unitaria R10-1
«si SÓLO falló la consulta del proveedor, la evidencia del negocio se conserva y se usa»), declarado y repetido. Los seis sabotajes
nuevos de la ronda: R11-1a 6/6, R11-1b 4/4, R11-2a 1/1, R11-3a 1/1, R11-3b 1/1, R11-4a 6/6; R9-2a 4/4 y R10-1a 6/6 con sus caídas
nuevas.

```
✅ R11-1a · la captura lee la configuración y la tarifa por el cliente GLOB · 6 caída(s) / 6 declarada(s) · 16.2 s
✅ R11-1b · la transacción de captura pierde el nivel REPEATABLE READ (cada · 4 caída(s) / 4 declarada(s) · 17.0 s
✅ R11-2a · la consolidación vuelve a borrar TODOS los nulos de primer nive · 1 caída(s) / 1 declarada(s) · 14.0 s
✅ R11-3a · el marcador de captura fallida puede quedar VACÍO (un error sin · 1 caída(s) / 1 declarada(s) · 1.5 s
✅ R11-3b · el lector vuelve a decidir por la «verdad» del marcador (una ca · 1 caída(s) / 1 declarada(s) · 1.2 s
✅ R11-4a · sólo el PROVEEDOR fallido también invalida la evidencia del neg · 6 caída(s) / 6 declarada(s) · 14.2 s
```

Verificación pesada por avq-verify (DUAL: Mac y Alienware) sobre el árbol de la ronda (14-sep 10:18–10:5x; corridas `avq-r11-*.txt`,
lanzada ANTES del arreglo de tipos): typecheck del CI (`npm run typecheck`) **1 error en los DOS lados, COINCIDEN** — el `TS2339` de
arriba, corregido en el acto (typecheck del CI **0** en local tras el arreglo; la repetición DUAL sobre el árbol final va en la cadena
de la ronda 12, junto con los cierres de la pasada exhaustiva); typecheck 5.8 de `src/` el mismo error, COINCIDEN; suite unitaria
completa en 4 shards **17,192 pruebas pasadas de 17,207 (14 omitidas): 4,153/4,153 · 4,706/4,715 · 3,798/3,799 · 4,535/4,540** (359
+ 359 + 359 + 358 suites): shards 1, 3 y 4 COINCIDEN con 0 fallos a la primera; el shard 2 marcó `DIFIEREN` por UN fallo sólo en la
Mac — `catalogImportCanonical.service.test.ts` («yields inside one maximum-nesting staged line…», esperaba < 50 ms y midió 86.6 ms
con la certificación de sabotajes y Codex corriendo al lado; archivo SIN cambios respecto a HEAD), la familia documentada de probes
de presupuesto del event loop — pendiente de la repetición exacta con `--runInBand` en DUAL en la cadena de la ronda 12 (regla del
workspace); integración de pagos completa contra la base desechable **17 suites / 421 pruebas / 0 fallos** (sólo local: necesita
Postgres); API `terminal-payment-attempts` **6/6 COINCIDEN**. Ese árbol y el final sólo difieren en el tipado de la captura (misma
lógica): las 16 suites de control de la certificación definitiva-2 (445 pruebas, unitarias e integración del checkpoint) corrieron en
verde sobre el árbol final.

**Duodécima auditoría de Codex (14-sep 10:18, gpt-6-astra xhigh; `prompt-codex-cp1-r12.txt`, 65 KB): LANZADA como PASADA
EXHAUSTIVA** — veredicto en `codex-cp1-r12-veredicto.md` cuando termine.

### 🔴 Ronda 12 de la auditoría final de Codex (14-sep 10:18–10:48, gpt-6-astra xhigh, 2.1 M tokens; PASADA EXHAUSTIVA por decisión del founder): RECHAZADO — 7 P1 (R12-1 … R12-7) · 8 P2 bloqueantes (R12-8 … R12-15) · 2 P2/P3 no bloqueantes (R12-16 · R12-17) · 1 P3 (R12-18) · una DEFINICIÓN DE HECHO de 18 invariantes y una tabla de cobertura por rama → TODO cerrado con TDD y sabotajes certificados, en UNA sola pasada (14-sep, mediodía y tarde)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r12-veredicto.md` (50 KB; prompt `prompt-codex-cp1-r12.txt`, 65 KB, el checkpoint
entero y no sólo el diff de la ronda 11). Dio por CERRADOS los cinco de la ronda 11 (R11-1 y los cuatro P2/P3) y verificó los 69
sabotajes con sus 266 caídas contra los JSON conservados. La huella que auditó fue `03e7ac38` + `c099233d9efb6c93`; la del árbol al
terminar la auditoría era `9c7eb2ce273e8e62` (el arreglo del estrechamiento a `never` de la captura —«revisé ese delta: no reabre
R11-1»— y 22 archivos reformateados por otra sesión). Nada fue un desacuerdo: cada hallazgo se verificó contra el código real antes de
aceptarlo (regla del founder), y los dieciocho resultaron ciertos. **Ningún P1 de esta ronda es de la familia R8–R11 salvo R12-1
(«distinto intervalo temporal»)**: la pasada completa destapó lo que las once auditorías por capas no miraban — el arbitraje del
ganador, la deduplicación legacy sin llave, la administración (corrección de tarifas, edición y borrado del dashboard), los escritores
de Blumon, el rearme por S1, el backfill y las herramientas de prueba.

Los dos límites del founder se conservan en cada cierre: el cobro nunca se interrumpe (todo defecto deja el Payment COMPLETED y la
venta pagada; lo que cambia es que el costo queda PENDIENTE y VISIBLE en vez de mal calculado) y nunca hay doble cobro, venta perdida
ni venta sin cobro (R12-6 y R12-7 son exactamente eso).

- **R12-1 (P1) · S4 congelaba una tarifa POSTERIOR al cobro y al ingreso durable del webhook.** El receptor dejaba el evento PENDING
  (durable) y, si el proceso moría antes de registrar, S4 lo recuperaba horas después y `tarifaDeLaAfiliacion` capturaba la tarifa de
  ESE momento: 2.5 % → 8 % editado en sitio = $80 en vez de $25 sobre $1,000, VALIDO y sin que fallara lectura alguna. Ahora la captura
  ocurre AL INGRESO —la primera evidencia bancaria aceptada— y viaja DENTRO del evento durable (`payload._avoqado.tarifaCongeladaAlIngreso`,
  `capturarTarifaAlIngreso`: nunca lanza; una captura que ni siquiera pudo intentarse queda como marcador TOTAL); el registrador
  recibe `tarifaCongeladaAlIngreso` en `paymentData` (sólo lo pone el servidor) y para `registradoVia: 'webhook'` NUNCA captura
  «ahora»: consume ESA captura, y un evento recuperable SIN ella (anterior a la regla) nace con `capturaFallida.total:
  SIN_CAPTURA_AL_INGRESO` — pendiente con PRICING_CAPTURE_FAILED, nunca VALIDO desde la configuración de hoy. Integración (costo real,
  describe «Codex R12-1», 5): la captura persistida en el evento y el Payment con exactamente ESA captura (mismo `frozenAt`); el
  escenario de Codex (corte tras el ingreso → SECONDARY al 8 % → S4 real ⇒ 2.5 %, $2.50 + $0.50, nunca $8.50); corte + slot REASIGNADO
  (M3 ocupa SECONDARY, M2 sale) ⇒ M2 en SECONDARY al 2.5 %, VALIDO; tarifa HEREDADA de la organización, editada al 8 % antes de
  recuperar ⇒ 2.5 % origen organización, `venuePricingStructureId` null; evento sin captura ⇒ marcador y pendiente. Unitaria: el insert
  PENDING estampa la captura. Codex lo dijo y queda dicho: capturar al ingreso NO demuestra la tarifa del instante bancario cuando
  hubo demora offline y edición en sitio — eso pide tarifas históricas inmutables o evidencia previa a la autorización, y no se
  anuncia como resuelto.
- **R12-2 (P1) · una afiliación en DOS slots elegía la tarifa por orden del ternario.** Con M2 en PRIMARY (8 %) y SECONDARY (2.5 %) la
  captura tomaba la primera coincidencia; el camino legacy la segunda: dos comisiones distintas para el mismo cargo. Ahora
  `slotsDeLaAfiliacion` cuenta coincidencias dentro de la MISMA vista de captura: más de una ⇒ `capturaFallida.configuracion:
  AFILIACION_EN_VARIOS_SLOTS: PRIMARY,SECONDARY`, ninguna tarifa se lee, costo pendiente con PRICING_CAPTURE_FAILED; la unidad de costo
  repite el criterio para un Payment SIN snapshot (la configuración de hoy ambigua ⇒ pendiente). Y los ESCRITORES lo rechazan (400 con
  código `AFFILIATION_IN_SEVERAL_SLOTS`, `slotsDeAfiliacion.ts`, módulo puro): alta y edición PARCIAL sobre la configuración RESULTANTE
  del venue (`venuePaymentConfig.service.ts`), del superadmin (`venuePricing.service.ts`) y de la organización (controlador); el respaldo
  contra dos ediciones concurrentes es un CHECK en la base (`20260914150000_payment_config_slots_distintos`, `NOT VALID`: una
  configuración ambigua histórica no tumba el deploy — el cobro la declara captura fallida). Integración (5): el CHECK rechaza escribir,
  REST rápido, con orden y WEBHOOK pendientes con el motivo y cero comisión arbitraria, Payment sin snapshot con la afiliación hoy en dos
  slots. Unitarias: captura y unidad (2) + escritores (6).
- **R12-3 (P1) · vencer dos horas convertía un método INVENTADO en costo definitivo.** El webhook inventa `CREDIT_CARD` (AngelPay no
  manda el método) y lo marca `methodProvisional: true`; el plazo de la obligación «acreditaba» el tipo de tarjeta y escribía un costo
  de crédito (2.5 %) sobre un débito (1 %): definitivo, porque la convergencia lo reutiliza; el REST tardío ya no lo corregía. Ahora
  `costoListoParaCalcular` es «el método está acreditado» (nunca el reloj); el plazo sólo ESCALA la espera (`AWAITING_ACCREDITED_CARD_DATA`
  → `AWAITING_ACCREDITED_CARD_DATA_OVERDUE`, visibles en la cola y en `payment_effects`); y el criterio vive también DENTRO de la unidad,
  bajo el mutex (`COST_PENDING_AWAITING_ACCREDITED_CARD_DATA`): un llamador directo (backfill, script) recibe la misma espera. Un motivo
  PERMANENTE del snapshot (SIN_TARIFA, captura fallida, ilegible) manda sobre la espera. Integración (5): webhook → plazo vencido →
  REST tardío que acredita DÉBITO (2 %), AMEX (3.5 %) e INTERNACIONAL (4.5 %) ⇒ costo, Payment y VenueTransaction con ESA tarifa;
  carrera worker ↔ REST (fila tomada ⇒ CONTENDIDO sin consumir intento; después, el método acreditado); y el llamador DIRECTO de la
  unidad ⇒ PENDIENTE con el motivo, sin costo. Unitaria: método provisional con snapshot VALIDO ⇒ no calcula.
- **R12-4 (P1) · `rateCorrectionApply` y su reversa se saltaban la evidencia histórica.** Recalcular sin clasificar el snapshot, o
  crear/borrar `TransactionCost` sin tocar la obligación, convertía una corrección administrativa en «acreditación» (un SIN_TARIFA de
  $1,000 con CREATE_COST al 8 % quedaba «convergido» a $80) o dejaba DONE sin costo tras la reversa. Ahora UN criterio en UN sitio
  (`cobroDelProtocolo.ts`: `cobrosDelProtocolo` en SQL —`processorData ? 'pricing'` (incluido `null`) o EXISTS obligación
  TRANSACTION_COST en cualquier estado— y `bloquearPayments` con `FOR NO KEY UPDATE`, el mismo mutex que la convergencia): preview y
  apply comparten la partición (`partirPorProtocolo`) y apply la REVALIDA bajo el mutex antes de escribir (`excluidosTarde`); reverse
  la aplica sobre las entradas del lote; todo excluido se explica (`excludedProtocolCount / PaymentIds / Reason`, en la respuesta y en
  `ActivityLog`), y `paymentCount` es el corregido de verdad. Integración (`rateCorrection.protocolo`, 5): VALIDO+DONE, SIN_TARIFA,
  CAPTURA_FALLIDA, INVALIDO y `pricing: null` INTACTOS en los DOS modos de apply, el legacy sí se corrige, preview y apply coinciden;
  el criterio es UNO u OTRO (snapshot sin obligación y obligación sin snapshot siguen excluidos); reverse DESPUÉS de converger; CARRERA
  con el worker (entra al protocolo entre la lectura y la escritura ⇒ excluido bajo el mutex). Hasta que exista una corrección
  INTEGRADA con acreditación y convergencia, no hay otra forma de tocar un cobro del protocolo.
- **R12-5 (P1) · editar y borrar un Payment desde el dashboard podía destruir la verdad financiera del checkpoint.** `PUT` cambiaba
  importe, propina, estado, método e identidad del cargo sin mutex y `DELETE` se llevaba en cascada venta, snapshot y obligación, y
  dejaba la solicitud apuntando a un id inexistente. Ahora, bajo el mutex del Payment (`bloquearPayments(tx, [id], 'proteccion')`) y
  releyendo la fila, un cobro del protocolo rechaza con **409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL`** (con los campos) cualquier cambio
  de `amount / tipAmount / status / method / cardBrand / maskedPan / authorizationNumber / referenceNumber / entryMode` y el borrado; los
  NO-OP pasan (la misma proyección de siempre); reembolso, anulación y corrección económica van por sus flujos. Integración
  (`paymentDashboard.protocolo`, 22: cada campo × cobro con costo PENDIENTE y ya CONVERGIDO, DELETE, no-op, CARRERA con la convergencia
  —el PUT espera el mutex y después decide—, y un cobro ANTERIOR al protocolo que se sigue editando y borrando); unitarias (8); y la
  capa HTTP real con supertest (`paymentProtocol.api.test.ts`, 6: ADMIN y OWNER 409, estado 409, no-op 200, DELETE 409, rol de piso 403
  antes del servicio).
- **R12-6 (P1) · un `timeout` por socket podía imponer como GANADOR una venta ajena.** `handlePaymentResultFromSocket` escribía
  `paymentId: result.paymentId ?? undefined` para CUALQUIER estado; un timeout/failed/cancelled con un `paymentId` (el campo lo admite
  la interfaz) dejaba la fila apuntando a B —un cobro de otra venta— y tanto el árbitro como el cierre («ya ligada») lo creían: el
  cargo auténtico A quedaba fuera como «segunda captura». Ahora (a) PRODUCTOR: un resultado no-success NO escribe ganador (ni columna
  ni `resultJson` ni al POS; 🚨 si lo traía); (b) ÁRBITRO: el puntero de la fila no decide por sí solo — se valida con el criterio
  COMPARTIDO del cierre financiero (`procedenciaDelPagoDeSolicitud.ts`, puro: etiqueta de ESTA solicitud —columna o
  `processorData.terminalPaymentRequestId`— y terminal acreditada; fases `ligar` = COMPLETED y `ganador` = COMPLETED | REFUNDED, tag
  exigido) y un puntero sin procedencia se ignora con 🚨 y bitácora `TERMINAL_PAYMENT_UNACCREDITED_WINNER_IGNORED` (una vez por
  puntero, con motivo `PAYMENT_TAGGED_FOR_ANOTHER_REQUEST | NOT_TAGGED_FOR_THIS_REQUEST | NO_TERMINAL_IDENTITY | TERMINAL_MISMATCH`)
  cayendo a la columna del ganador; (c) CIERRE: «ya ligada» sólo si el puntero es un cobro ACREDITADO de esta solicitud; si no, se
  reemplaza EXACTAMENTE ese puntero (CAS `where: { requestId, venueId, paymentId: punteroAReemplazar }` — nunca sobre un ganador
  acreditado escrito en medio); el reintento del mismo Payment sigue siendo ALREADY_BOUND sin releer; y un ganador REEMBOLSADO sigue
  siendo el ganador. Integración (registrador, describe «R12-6»): PRODUCTOR (timeout / failed / cancelled con `paymentId` ⇒ fila sin
  ganador; y un timeout tardío sobre UNKNOWN) y LECTOR independiente (fila HISTÓRICA contaminada apuntando a B: A gana Q por REST rápido,
  con orden y webhook, con bitácora, B sigue siendo su venta; un cobro de esta terminal pero de otra venta tampoco; el reembolsado
  conserva al ganador; la fila ligada sólo por `processorData` sigue siendo ganador). Unitarias del cierre (3). Codex: «no afirmo que
  un APK publicado emita hoy ese payload» — el defecto es que un campo no acreditado decidía quién ganó.
- **R12-7 (P1) · dos replays SIMULTÁNEOS sin llave del mismo cargo creaban DOS ventas.** La resolución por referencia corría FUERA de
  la transacción de creación: los dos veían ausencia y los dos creaban COMPLETED, venta e ingreso ($200 por $100 cobrados); con llave
  lo evita el índice único, sin llave no había nada. Ahora la transacción de creación de un registro SIN llave toma como PRIMERA
  sentencia un candado consultivo transaccional por (venue, referencia) (`candadoDeReferencia.ts`: namespace propio `7_310_114` +
  `hashtext(venue:ref)`, `/* referencia */` observable en `pg_stat_activity`, `lock_timeout` acotado a min(espera del intento, 3.5 s)
  y restablecido a 0 tras adquirir para no cambiar cómo esperan los candados de fila; si vence ⇒ `RegistroNoResuelto` reintentable) y,
  ya con el candado, VUELVE A RESOLVER la referencia (READ COMMITTED, fotografía nueva): si ahora existe, aborta la creación y devuelve
  el existente (`RegistroYaExistentePorReferencia`, con sus recibos); si es colisión, la registra como evidencia; si no, crea. Orden
  documentado: referencia → [vales → tickets →] Order → TerminalPaymentRequest → Payment → Shift; con llave NO se toma; NO se impone
  `UNIQUE(referenceNumber)`. Integración (4): venta rápida y con orden — los dos esperan JUNTOS el candado (sostenido por la prueba como
  montaje) y al soltar nace UN Payment, UNA venta, UN ingreso y el MISMO resultado para ambos; CONTROL: dos cargos legítimamente
  DISTINTOS con la misma referencia ($100 y $150) siguen siendo dos — serializa, no deduplica (R4-6 manda: misma afiliación + otra
  autorización es COLISIÓN, por eso el control usa importes distintos); un registro CON llave no espera aunque la prueba sostenga el
  candado.
- **R12-8 (P2) · VALIDO exigía la configuración de pagos de HOY.** Sin ninguna (venue y organización) la obligación moría como fallo
  operativo. Ahora con snapshot VALIDO la afiliación se resuelve por `findUnique` con el cliente de la unidad y se consume el snapshot;
  la configuración sólo se pide para AUSENTE. Integración: el negocio borra sus configuraciones tras el cobro ⇒ converge al 2.5 %
  congelado, la configuración no se consulta. Unitaria: ídem con el mock.
- **R12-9 (P2) · el lector aceptaba snapshots monetarios INCOMPLETOS.** Un `includesTax` omitido no es «no incluye IVA» (2.5 % + IVA
  sobre $1,000 son $29, no $25) ni un cargo fijo omitido es «cero». Ahora los campos que el productor escribe siempre tienen que estar
  PRESENTES (`CAMPO_AUSENTE_x` ⇒ INVALIDO; el null EXPLÍCITO sigue valiendo lo de siempre) y el marcador `capturaFallida` tiene FORMA
  (objeto plano con cadenas; una cadena suelta, un número o un null en un campo ⇒ `CAPTURA_FALLIDA_ILEGIBLE`, INVALIDO — nunca
  habilita VALIDO). Unitarias (2): cada campo omitido por separado (contra el null explícito) y el marcador mal formado.
- **R12-10 (P2) · los escritores de Blumon reponían un `costPending` viejo.** El webhook (MATCHED y DISCREPANCY) y el job de
  auditoría leían el JSON, fusionaban en memoria y REEMPLAZABAN: leían `costPending: true`, la convergencia terminaba (false/DONE) y el
  reemplazo dejaba el cargo marcado pendiente con su obligación terminada — sin trabajador que lo reparara — y pisaba el snapshot y los
  enriquecimientos. Ahora `parcheDeProcessorData.ts`: un `||` ATÓMICO de Postgres sobre el valor VIGENTE, sólo con las llaves propias
  del escritor, con `soloSiFalta` decidido en la MISMA sentencia (idempotencia atómica; `NULL`/legacy se trata como `{}`). Integración
  (costo real, 4): cada escritor detenido tras su lectura, convergencia en medio, reanudado ⇒ false/DONE, snapshot, etiqueta y llaves
  de Blumon intactos; y la idempotencia atómica (un segundo MATCHED no pisa la primera recepción). Unitarias: el SQL del parche y que
  `payment.update` no se toca (webhook 3, job 1).
- **R12-11 (P2) · S1 no reactivaba toda la evidencia que el vínculo permitía resolver.** Un approved PENDING con `nextAttemptAt` en el
  futuro (backoff), uno AGOTADO (ERROR/RETRIES_EXHAUSTED, attempts=40) o un sello DÉBIL terminado en el intento 40 quedaban muertos al
  llegar el vínculo (la prueba anterior los adelantaba con SQL). Ahora `reabrirEventosDebiles`, bajo el candado del intento: (a) PENDING
  ⇒ se ADELANTA (idempotente); (b) AGOTADO sin Payment ⇒ PENDING con `attempts: 0`, UNA sola vez (marcador durable
  `_avoqado.rearmadoPorVinculo` con `attemptsAntes`); la reapertura débil también rearma el presupuesto una vez; nunca un rechazo
  bancario (NOT_APPROVED), un LINK_*_MISMATCH ni una discrepancia FUERTE; repetir ALREADY_LINKED no reinicia el presupuesto. Integración
  (worker, 5), incluido «un declined en backoff o agotado tampoco se adelanta ni se rearma».
- **R12-12 (P2) · el backfill certificaba un importe ilegible o un rechazo bancario.** `Number('abc')` = NaN esquivaba la discrepancia
  y caía en MATCHED; un declined que quedó PENDING por un corte antes del filtro recibía el sello. Ahora el backfill exige `type:
  'send_transaction'` en la consulta (`take: 25` primero, R12-14 de paso), verifica el ESTADO bancario (no aprobado ⇒ ERROR/NOT_APPROVED,
  nunca MATCHED) y el IMPORTE (ausente = compatibilidad legacy; no cadena/número, vacío, no entero en centavos o negativo ⇒ PENDING con
  `INVALID_AMOUNT`, sin Payment ni huella). Integración (webhook, 6): importe ilegible / no entero / vacío, declined, otro tipo, y el
  CONTROL aprobado con 10000 centavos que sí se sella.
- **R12-13 (P2) · trabajos y barreras de las pruebas quedaban fuera de la finalización común.** Un UPDATE de montaje que fallaba, un
  mutex adquirido sin cleanup, una barrera sin soltar o un backfill lanzado antes de un fallo podían disfrazarse de aserción financiera
  caída o dejar un cuelgue. Ahora `actores.ts` registra desde el lanzamiento también los trabajos de MONTAJE (`montaje(nombre,
  promesa)`: su rechazo es INCONCLUSO por sí mismo, se examine o no, conservando su causa), suelta TODAS las barreras con `liberar({...})`
  (captura cada error de liberación y lo suma al INCONCLUSO de `cerrar`; nunca se salta `cerrar`), y `cerrar`/`afirmar` incluyen
  montajes y liberaciones. Convertidos al protocolo: el candado sostenido de R12-7 (registrador), la fila tomada por otro
  (costoDiferido), S5 y los long-poll de la terminal, T1 y el backfill drenado del webhook, y la pareja de claims del worker. La
  guardia estática ve agregados MULTILÍNEA y ALIAS (`const r1 = k1.resultado()` dentro de `Promise.race`) y se declara LIMITADA (no
  es un verificador de JavaScript). Unitarias de `actores` (+7: guardia reforzada, montaje ×2, liberación ×2, afirmar, sin
  `unhandledRejection`).
- **R12-14 (P2) · la captura cargaba TODAS las tarifas vigentes para quedarse con una.** Ahora `getEffectivePricingForSlot`
  (`organization-payment-config.service.ts`) resuelve UN slot con `findFirst` (misma vigencia y mismo orden `effectiveFrom desc`, venue
  primero y organización de respaldo, MISMA forma de respuesta); la captura y `findActiveVenuePricingStructure` la usan; los consumidores
  que LISTAN siguen con `getEffectivePricing` (nada se recorta en silencio). Integración: dos SECONDARY elegibles ⇒ la más reciente, y
  `getEffectivePricingForSlot` es lo que se consulta (la lista no). Y —del cuadro de cobertura de Codex, «escape individual de lecturas
  de organización»— la intercalación REAL a nivel ORGANIZACIÓN: la tarifa heredada se edita al 8 % ENTRE las dos lecturas y el snapshot
  sigue siendo 2.5 % origen organización (la lectura de la organización también sale de la vista REPEATABLE READ de la captura).
- **R12-15 (P2) · un reembolso posterior a DONE perdía para siempre su costo negativo.** Si la creación síncrona del costo negativo
  fallaba (transitorio), no había trabajo durable que la retomara. Ahora `asegurarObligacionDeCostoNegativo(tx, original, reembolso)`
  corre DENTRO de la transacción del reembolso (TPV y dashboard), bajo el mutex del original: reabre la obligación DONE (attempts 0,
  `lastError: REFUND_COST`, `refundCostRequests` acumulados en el payload) o la encola si el original es legacy con costo; una obligación
  PENDING/PROCESSING se respeta (VIGENTE). El worker converge copiando el costo ORIGINAL a prorrata (`createRefundTransactionCost`), nunca
  consulta tarifas nuevas. Integración (costo real, 6): TPV y dashboard — original DONE → reembolso → fallo transitorio → el worker crea
  EXACTAMENTE un costo negativo con proyecciones correctas; CONTROL sin fallo (no duplica); parcial $40 de $100 a prorrata; CONCURRENCIA
  con una corrida YA RECLAMADA (el reembolso espera el mutex y reabre la obligación que esa corrida cerró — un solo costo negativo).
- **R12-16 (P2, no bloqueante) · el MCP entregaba fee/net por pago sin decir que eran provisionales.** `list_payments` marca POR
  PAGO `costPending` y `feeProvisional` (`costoPendienteDe`: sólo la marca sale, nunca el JSON del procesador) y la descripción lo
  explica. Unitaria: un pago convergido y otro pendiente, distinguidos uno por uno.
- **R12-17 (P3) · una prueba prometía costo síncrono y permitía reparación diferida.** `costoSincronoAl25` afirma costo, fee/net y
  `costPending: false` INMEDIATAMENTE tras el REST, antes de reparar; `costoAl25` es la convergencia (repetible).
- **R12-18 (P3) · comentarios que sugerían reparar la historia editando configuración.** Reescritos: con snapshot (VALIDO / SIN_TARIFA /
  CAPTURA_FALLIDA / INVALIDO) la caída a PRIMARY no existe; un cargo cuya tarifa no consta sólo se resuelve con una acreditación
  EXPLÍCITA, fuera de la unidad.

**Certificación DEFINITIVA de sabotajes (14-sep 14:18–15:12, runner `sab-r7.py` sha `4693a3f260dbc138`, copia aislada `$J/sab-server`,
huella HEAD `03e7ac38` + WIP sha256 `ade1bf7c3b49ccbe` (1,440,075 bytes), resultados estructurados en `sab-r7-resultados.json` (copia
`sab-r12-definitiva-resultados.json`), corrida `sab-r12-definitiva.txt` + `sab-r12-definitiva-repeticion.txt`, JSON crudo y logs en
`sab-r7-logs/`): 125/125 certificados · 494 caídas = 494 declaraciones · 0 INCONCLUSOS · 0 supervivientes · las 26 suites de
control en verde antes de mutar (registrador 66 · costo real 76 · costo diferido 23 · webhook 52 · socket 18 · terminal 27 · worker 16 ·
rateCorrection protocolo 6 · dashboard protocolo 22 · api protocolo 6; unitarias: webhook 47 · obligación 11 · afiliación 81 · cliente
rápido 36 · discriminadores 8 · guardia estática 9 · identidad 20 · registro repetido 7 · motivos públicos 8 · actores 20 ·
terminal-payment 96 · blumon webhook 3 · blumon audit job 7 · updateStatus 12 · mcp payments 11 · S2 plazo 6). La primera pasada completa
dio 122/125 y los tres restantes eran DECLARACIONES (no código ni pruebas): R5-D tenía una prueba de más («idempotencia ATÓMICA» no
afirma la comisión), R9-2a una de menos (el escenario WEBHOOK de R9-1, que ahora acredita por REST, también exige que el `venue: null`
del snapshot SIN_TARIFA sobreviva al replay) y R12-13c una de más (con fallo previo `cerrar` rechaza igual por los rechazos y el
mensaje conserva la parte de la liberación — sólo la liberación SIN fallo previo lo detecta); corregidas y repetidas con `SAB_ONLY`
sobre la MISMA huella (3/3), como en la R11. El `diff -rq src tests prisma` contra la copia certificada = 0 diferencias al terminar.
**125 sabotajes en total: los 69 de las rondas 5–11 (con las caídas nuevas de esta ronda declaradas — la organización intercalada cae
también bajo R11-1a/1b y R5-D; `costPending` bajo R6-K; PRICING_CAPTURE_FAILED bajo R10-1b/R10-2a; la colisión de R4-6 y sus hermanas
bajo R12-7c; los replays de R12-7 bajo R6-2c…) más 56 nuevos de la ronda 12**, uno por rama del cuadro de cobertura de Codex (captura ·
lector · convergencia · consolidación · backfill · reapertura · administración · pruebas concurrentes):

```
✅ R12-6a · PRODUCTOR: el resultado no-success del socket vuelve a escrib · 2 caída(s) / 2 declarada(s) · 38.8 s
✅ R12-6b · ÁRBITRO: el puntero de la fila se cree sin procedencia (cualq · 3 caída(s) / 3 declarada(s) · 42.2 s
✅ R12-6c · CIERRE: «ya ligada» vuelve a decidirse por la mera existencia · 5 caída(s) / 5 declarada(s) · 37.8 s
✅ R12-6d · CRITERIO: en fase «ganador» un cobro SIN la etiqueta de esta  · 2 caída(s) / 2 declarada(s) · 41.3 s
✅ R12-6e · CRITERIO: un ganador REEMBOLSADO deja de contar como ganador  · 1 caída(s) / 1 declarada(s) · 32.8 s
✅ R12-7a · venta RÁPIDA: la creación de un registro sin llave deja de to · 2 caída(s) / 2 declarada(s) · 41.8 s
✅ R12-7b · con ORDEN: lo mismo en `recordOrderPayment` · 1 caída(s) / 1 declarada(s) · 38.2 s
✅ R12-7c · RELECTURA: bajo el candado ya no se vuelve a resolver la refe · 7 caída(s) / 7 declarada(s) · 33.1 s
✅ R12-7d · CON LLAVE: un registro con llave también toma el candado de l · 1 caída(s) / 1 declarada(s) · 37.8 s
✅ R12-7e · la LLAVE del candado deja de ser (venue, referencia): cada re · 3 caída(s) / 3 declarada(s) · 46.8 s
✅ R12-10a · MATCHED: el webhook vuelve a leer-fusionar-reemplazar el JSO · 2 caída(s) / 2 declarada(s) · 33.0 s
✅ R12-10b · DISCREPANCY: la rama de discrepancia vuelve a reemplazar el  · 2 caída(s) / 2 declarada(s) · 29.8 s
✅ R12-10c · JOB de auditoría: la marca antispam vuelve a estamparse con  · 2 caída(s) / 2 declarada(s) · 29.8 s
✅ R12-10d · IDEMPOTENCIA: el MATCHED deja de exigir «si no lo tenía ya»  · 1 caída(s) / 1 declarada(s) · 28.5 s
✅ R12-10e · el parche atómico ignora `soloSiFalta` (la condición de la s · 1 caída(s) / 1 declarada(s) · 29.6 s
✅ R12-10f · el parche REEMPLAZA el JSON en vez de fusionarlo (`||` sobre · 2 caída(s) / 2 declarada(s) · 28.0 s
✅ R12-11a · ADELANTAR: un PENDING con `nextAttemptAt` en el futuro ya no · 1 caída(s) / 1 declarada(s) · 8.0 s
✅ R12-11b · AGOTADO: un ERROR/RETRIES_EXHAUSTED sin Payment ya no se rea · 2 caída(s) / 2 declarada(s) · 6.9 s
✅ R12-11c · PRESUPUESTO: la reapertura débil vuelve a PENDING sin poner  · 1 caída(s) / 1 declarada(s) · 7.9 s
✅ R12-11d · IDEMPOTENCIA: el rearme del agotado deja de ser una sola vez · 1 caída(s) / 1 declarada(s) · 7.4 s
✅ R12-11e · APPROVED: el rearme deja de exigir evidencia approved (un de · 1 caída(s) / 1 declarada(s) · 6.9 s
✅ R12-12a · ESTADO: el backfill deja de mirar el estado bancario (un dec · 1 caída(s) / 1 declarada(s) · 20.0 s
✅ R12-12b · IMPORTE: un importe ilegible, no entero o vacío deja de rech · 3 caída(s) / 3 declarada(s) · 22.4 s
✅ R12-12c · TIPO: el backfill vuelve a aceptar eventos de OTRO tipo con  · 1 caída(s) / 1 declarada(s) · 20.8 s
✅ R12-4a · PREVIEW/PARTICIÓN: la partición previa deja de consultar el p · 3 caída(s) / 3 declarada(s) · 8.5 s
✅ R12-4b · REVALIDACIÓN: apply deja de volver a preguntar bajo el mutex  · 1 caída(s) / 1 declarada(s) · 8.6 s
✅ R12-4c · REVERSE: la reversa deja de excluir los cobros que entraron a · 1 caída(s) / 1 declarada(s) · 9.0 s
✅ R12-4d · CRITERIO: la obligación TRANSACTION_COST deja de contar (sólo · 3 caída(s) / 3 declarada(s) · 11.4 s
✅ R12-4e · CRITERIO: el snapshot presente deja de contar (sólo la obliga · 1 caída(s) / 1 declarada(s) · 19.5 s
✅ R12-5a · PUT: el cambio de un campo protegido deja de rechazarse con 4 · 27 caída(s) / 27 declarada(s) · 26.2 s
✅ R12-5b · DELETE: borrar un cobro del protocolo deja de rechazarse · 3 caída(s) / 3 declarada(s) · 19.9 s
✅ R12-5c · NO-OP: cualquier campo enviado cuenta como cambio (un no-op l · 4 caída(s) / 4 declarada(s) · 18.1 s
✅ R12-15a · TPV: el reembolso por terminal deja de asegurar la obligació · 3 caída(s) / 3 declarada(s) · 28.0 s
✅ R12-15b · DASHBOARD: el reembolso por dashboard deja de asegurar la ob · 1 caída(s) / 1 declarada(s) · 29.1 s
✅ R12-15c · REAPERTURA: una obligación DONE ya no se reabre (sólo se «as · 4 caída(s) / 4 declarada(s) · 27.7 s
✅ R12-1a · INGRESO: el receptor deja de capturar la tarifa al ingreso (e · 24 caída(s) / 24 declarada(s) · 27.2 s
✅ R12-1b · REGISTRADOR: un cobro nacido del webhook vuelve a capturar la · 7 caída(s) / 7 declarada(s) · 26.2 s
✅ R12-1c · S4: la recuperación deja de leer la captura del ingreso del e · 23 caída(s) / 23 declarada(s) · 27.3 s
✅ R12-2a · CAPTURA: con la afiliación en dos slots la captura vuelve a e · 4 caída(s) / 4 declarada(s) · 34.1 s
✅ R12-2b · UNIDAD: sin snapshot y con la afiliación HOY en dos slots, el · 2 caída(s) / 2 declarada(s) · 32.6 s
✅ R12-3a · el plazo vencido vuelve a «acreditar» el método provisional ( · 5 caída(s) / 5 declarada(s) · 35.2 s
✅ R12-3c · una MARCA de tarjeta vuelve a acreditar el método aunque siga · 1 caída(s) / 1 declarada(s) · 31.5 s
✅ R12-3b · la UNIDAD deja de rechazar el método provisional (sólo la pue · 2 caída(s) / 2 declarada(s) · 25.1 s
✅ R12-8a · la unidad vuelve a EXIGIR la configuración de pagos de hoy au · 2 caída(s) / 2 declarada(s) · 26.4 s
✅ R12-9a · el marcador `capturaFallida` deja de exigir FORMA (una cadena · 1 caída(s) / 1 declarada(s) · 1.2 s
✅ R12-9b · un campo monetario OMITIDO en el snapshot vuelve a leerse com · 2 caída(s) / 2 declarada(s) · 1.2 s
✅ R12-14a · la consulta acotada del slot ordena al revés (congela la est · 1 caída(s) / 1 declarada(s) · 24.4 s
✅ R12-14b · la captura vuelve a consultar la LISTA entera (`getEffective · 5 caída(s) / 5 declarada(s) · 25.2 s
✅ R12-14c · la lectura de la tarifa HEREDADA de la organización se escap · 1 caída(s) / 1 declarada(s) · 22.3 s
✅ R12-16a · `costoPendienteDe` deja de leer la marca (todo pago sale com · 1 caída(s) / 1 declarada(s) · 2.9 s
✅ R12-13a · `montaje` registra el trabajo como un actor común (su rechaz · 3 caída(s) / 3 declarada(s) · 1.6 s
✅ R12-13b · `liberar` se detiene en la primera liberación que falla (las · 2 caída(s) / 2 declarada(s) · 1.5 s
✅ R12-13c · `cerrar` ignora los errores de liberación (un verde con una  · 1 caída(s) / 1 declarada(s) · 1.9 s
✅ R12-13d · `afirmar` deja de denunciar un montaje caído cuando la fase  · 1 caída(s) / 1 declarada(s) · 1.6 s
✅ R12-13e · la guardia estática vuelve a leer sólo la PRIMERA línea del  · 1 caída(s) / 1 declarada(s) · 1.6 s
✅ R12-13f · la guardia estática deja de detectar los ALIAS de `resultado · 1 caída(s) / 1 declarada(s) · 1.6 s
```

🔴 **Lo que destapó la corrida EXPLORATORIA (`sab-r12-exploratoria.txt`, 90/124, huella `00ae0abbcfa96dd8`) y ninguna prueba en verde
veía** — todo apretado, nada aflojado, y la definitiva se repitió entera sobre el árbol corregido: (a) la carrera worker ↔ REST de R12-3
NO esperaba a que su candado estuviera tomado (el worker entraba antes del `FOR UPDATE` y contestaba por el método provisional, no por la
contención): flaky, caía bajo catorce mutantes ajenos; ahora espera `tomado`; (b) los dos replays de R12-7 se examinaban con `await`
suelto — bajo R6-2c (REPEATABLE READ) rechazaban con 503 y salían como «error ajeno» (INCONCLUSO): ahora cada replay se afirma como
desenlace (`acreditado`), y R6-2c los certifica; (c) las cuatro pruebas de R12-13 leían `err.message` sobre un `undefined` y `liberar`
se esperaba a pelo: ahora `cerrar`/`liberar` se afirman (`toBeInstanceOf(Error)`, `{ ok: true, fallidas }`), y la prueba de `afirmar`
ejercita de verdad `afirmar` (sin `cerrar`, con la fase tragándose el rechazo del montaje) — R12-13d sobrevivía porque la prueba llamaba
a `cerrar`; (d) los no-op de R12-5 no usaban `.resolves` (un 409 salía como error suelto ⇒ INCONCLUSO); (e)
`transactionCost.inheritance.test.ts` mockeaba el módulo de configuración con LISTA FIJA sin `getEffectivePricingForSlot` (10 caídas en la
suite unitaria completa: la trampa `mock-de-modulo-con-lista-fija` otra vez) y `deferredTransactionCost.test.ts` fijaba la semántica
VIEJA del plazo (3 caídas; reescrita al contrato R12-3, con `esperaDeMarcaVencida`, y entra al runner como suite `S2 plazo` con el
mutante R12-3c «una MARCA de tarjeta vuelve a acreditar»); (f) dos pruebas del webhook (el escenario WEBHOOK de R9-1 y el de captura
fallida de R10-1) dejaron de ejercitar la UNIDAD de costo cuando el método provisional pasó a ser la puerta del worker (R12-3): bajo
R9-1a y R10-2a ya no caían — ahora acreditan por REST y afirman que la unidad deja el MISMO motivo; (g) la carrera de R12-4 inyectaba la
obligación ANTES de la partición previa, donde la revalidación bajo el mutex no hacía falta (R12-4b sobrevivía): ahora hay DOS carreras,
una antes de la partición y otra justo antes del mutex (`bloquearPayments` espiado); (h) R12-6b no cae en la ruta con orden porque
`whereElegibleComoCobroDeSolicitud` ya filtra por `orderId` (defensa en profundidad de la consulta, documentada en el runner, no un
detector) y «sin slot congelado (M2 fuera al cobrar)» dejó de ser detector de R9-1a (con R12-2/R12-8 la rama sin snapshot lanza
UNRESOLVED igual) — documentado, como su hermana; (i) los títulos hoja de `it.each`/`describe.each` tienen que ser ÚNICOS para el
runner (se incluye la variante en el título); y (j) el typecheck del CI cazó un `TS18047` (`ev.eventId` nullable de Prisma) en una
prueba nueva que jest no ve.

**Verificación pesada por avq-verify sobre el árbol FINAL (huella `ade1bf7c3b49ccbe`, la misma de la certificación; 14-sep 15:12–15:35,
corridas `avq-r12-*-final.txt`, `avq-r12-int.txt`, `avq-r12-api.txt`, `avq-r12-flaky-exactos.txt`; DUAL Mac + Alienware con la bandera
`forzar-dual` puesta):** lint **0 errores** (65 avisos, todos preexistentes y ajenos a este checkpoint: `console.error` de los hooks de
referidos, `SOLTADA_POR_POLITICA` y `resolveBlumonSerialToMerchantId` sin usar, un import en una prueba vieja); typecheck del CI (`npm run
typecheck`, incluye `tests/` y `scripts/`) **0 errores COINCIDEN** (local 156 s / alien 24 s); suite unitaria completa en 4 shards
**17,226 pruebas pasadas de 17,240 (14 omitidas), 0 fallos, los CUATRO shards COINCIDEN**: 4,160/4,160 · 4,708/4,716 · 3,808/3,809 ·
4,550/4,555; integración de pagos completa contra la base desechable **19 suites / 503 pruebas / 0 fallos** (sólo local: necesita
Postgres); API `terminal-payment-attempts` + `paymentProtocol` **12/12 COINCIDEN**. La cadena de la parte A (árbol PREVIO a las
correcciones de la exploratoria, `avq-r12-*.txt`) había dado: typecheck del CI 1 error COINCIDEN (el `TS18047`, corregido), typecheck 5.8
de `src/` 0 COINCIDEN, y en los shards **13 fallos MÍOS** —los 10 de `transactionCost.inheritance.test.ts` (mock de lista fija) y los 3 de
`deferredTransactionCost.test.ts` (semántica vieja del plazo), corregidos arriba— más tres fallos de la familia documentada de probes de
presupuesto del event loop y de `supertest` por loopback, en archivos SIN cambios respecto a `main`: `catalogImportCanonical` y
`catalogImportDurableEventLoop` sólo en el Alienware (shard 2 DIFIEREN) y `storesAnalysis.sales-export` sólo en la Mac (shard 3 DIFIEREN).
Clasificados por la regla del workspace con la repetición EXACTA de los tres archivos con `--runInBand` en DUAL: **3 suites / 16 pruebas / 0
fallos, COINCIDEN** (y en la parte B los cuatro shards enteros COINCIDIERON sin ellos) ⇒ contaminación de carga, no código; no se tocó
lógica de negocio y la bandera `forzar-dual` sigue donde estaba (la plantó otra divergencia el 10-sep). Al terminar, la huella del árbol
(`src`/`tests`/`prisma`) recalculada es exactamente `ade1bf7c3b49ccbe` y `diff -rq` contra la copia certificada = 0: la evidencia
corresponde al código entregado (invariante 18 de la definición de hecho).

**Decimotercera auditoría de Codex (14-sep, gpt-6-astra xhigh; `gen-prompt-r13.py` ⇒ `prompt-codex-cp1-r13.txt`, `lanzar-codex-r13.sh`):
la de AUTORIZACIÓN** — comprobación de los 18 invariantes de su definición de hecho y de la tabla de cobertura, no otro descubrimiento;
veredicto en `codex-cp1-r13-veredicto.md`.

### 🔴 Ronda 13 — la auditoría de AUTORIZACIÓN de Codex (14-sep 15:4x–16:1x, gpt-6-astra xhigh, 6.3 M tokens): RECHAZADO — 12 hallazgos de R12 CERRADOS · 6 PARCIALES · 7 nuevos (R13-1 … R13-3 P1 de código · R13-4 … R13-5 y R13-7 P2 de código/recuperación · R13-6 P2 de certificación) + la tabla de cobertura por rama con detectores que faltaban → TODO cerrado con TDD, sabotajes certificados e INYECCIONES en los consumidores reales del protocolo de actores, en UNA sola pasada (14-sep, tarde)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r13-veredicto.md` (42 KB; prompt `prompt-codex-cp1-r13.txt`, 115 KB — el
checkpoint entero, la definición de hecho de 18 invariantes de R12 y la tabla de cobertura). Confirmó que la evidencia corresponde al
árbol (HEAD `03e7ac38`, huella `ade1bf7c3b49ccbe`, 125/125 sabotajes, 494 caídas declaradas, `diff -rq` cero, cadena de avq); de la
definición de hecho dio **11 invariantes CUMPLIDOS, 5 PARCIALES (2, 6, 11, 15, 18) y 2 INCUMPLIDOS (14 «la administración no elude el
protocolo» y 17 «todos los trabajos de prueba terminan y se examinan»)**; y su decisión fue explícita: «El push y el checkpoint 2 deben
esperar a los siete cierres concretos de R13 y a su certificación sobre la siguiente huella. No necesito otra decisión del founder».
Cada hallazgo se verificó contra el código real antes de aceptarlo (regla del founder): los siete resultaron ciertos. Los dos límites del
founder se conservan en cada cierre: el cobro nunca se interrumpe y nunca hay doble cobro, venta perdida ni venta sin cobro.

- **R13-1 (P1) · el REST que CREA con la misma llave ANTES de S4 capturaba la tarifa «ahora».** R12-1 hizo que el receptor capturara al
  ingreso y que S4 consumiera esa captura, pero el selector (`tarifaDeLaAfiliacion`) distinguía por el ORIGEN de la llamada, no por la
  primera evidencia durable del cargo: approved de A ingresa con SECONDARY al 2.5 % + $0.50, el registrador falla, un administrador edita
  la tarifa al 8 %, y el REST de la terminal llega con la misma llave antes de S4 ⇒ no encuentra Payment, captura 8 % y registra $8.50
  sobre $100; S4 encuentra después ese Payment y CONSERVA su snapshot — la captura durable de 2.5 % nunca se usa (R12-1a/1b/1c estaban
  certificados y el defecto seguía). Ahora la EVIDENCIA DURABLE DEL INGRESO vive en un módulo propio (`src/services/tpv/evidenciaDeIngreso.ts`:
  `evidenciaDurableDelIngreso` — la primera evidencia APROBADA del intento en el venue, acotada a 10 filas, clasificada en
  `CON_CAPTURA` / `SIN_CAPTURA` / `OTRA_AFILIACION`; `tarifaCapturadaAlIngresoDe` se mudó ahí, el webhook la re-exporta) y el selector es
  COMÚN a los orígenes: el REST consulta esa evidencia por la llave canónica del intento (`llaveDeIntento`) ANTES de capturar; con captura
  la consume tal cual (mismo `frozenAt`); un evento pertinente SIN captura (anterior a la regla) conserva la incertidumbre
  (`capturaFallida.total: SIN_CAPTURA_AL_INGRESO`, pendiente hasta acreditar); un evento del intento recibido por OTRA afiliación
  (`_avoqado.receivedByMerchantAccountId` ≠ la afiliación atribuida) NO acredita ésta ni autoriza capturar la de hoy
  (`EVIDENCIA_DE_INGRESO_DE_OTRA_AFILIACION`, pendiente y visible); y un fallo al consultar la evidencia cae al `catch` como captura
  fallida, nunca a capturar «ahora». Sólo captura al cobrar quien es de verdad la primera evidencia (REST sin evento previo: control). Nunca
  se confía en una captura enviada por el cliente. Pruebas nuevas (`costoReal`, describe «Codex R13-1»): el escenario de Codex INVERTIDO
  (corte tras el ingreso → 8 % → REST antes de S4) por venta rápida y con orden — el Payment nace con la captura del ingreso (2.5 %, mismo
  `frozenAt`), el costo síncrono es $3 y S4 después encuentra ese Payment y conserva el snapshot; evento pertinente sin captura ⇒
  `SIN_CAPTURA_AL_INGRESO` / `PRICING_CAPTURE_FAILED` / 0 costos; CONTROL sin evento previo (8 % ⇒ fee $8.50); PERTENENCIA (evento por M2,
  cobro atribuido a PRIMARY ⇒ pendiente con motivo). Sabotajes **R13-1a** (el REST ignora la evidencia durable), **R13-1b** (deja de
  comprobar la pertenencia) y **R13-1c** (un evento sin captura ya no conserva la incertidumbre).
- **R13-2 (P1) · el PUT del dashboard clasificaba bajo el mutex y ESCRIBÍA después de soltarlo.** La transacción de protección terminaba
  en la clasificación y el UPDATE legacy corría fuera: un reembolso real podía tomar el mutex, encolar `TRANSACTION_COST`
  (`asegurarObligacionDeCostoNegativo`) y meter el cobro al protocolo; el PUT, ya clasificado como legacy, escribía $120 encima —
  importe original y saldo reembolsable alterados después de devolver un cargo real. Ahora `updatePayment` hace relectura, clasificación,
  validación (la prohibición de completar dinero por el editor y el no-op de estado) y UPDATE en la MISMA transacción que posee el mutex,
  también cuando la clasificación es legacy (`PROYECCION_DEL_PAYMENT` compartida; `logAction` fuera). Pruebas nuevas (`paymentDashboard.protocolo`,
  describe «Codex R13-2»): el PUT detenido DESPUÉS de clasificar como legacy (espía sobre `cobrosDelProtocolo`, con el mutex tomado) — el
  reembolso real ESPERA el mutex (bloqueado por el pid del PUT, observado en `pg_stat_activity`), al reanudar el PUT commitea $120 y sólo
  entonces el reembolso entra al protocolo sobre $120 (`costPending: true`, obligación PENDING, un REFUND); y la SONDA sobre
  `prisma.payment.update` (sólo dispara si el PUT escribiera con el cliente GLOBAL, fuera de toda transacción): el invariante «el importe con
  el que el cobro ENTRÓ al protocolo es el que conserva» — en el código correcto la sonda nunca dispara. Sabotaje **R13-2a** (el UPDATE
  legacy vuelve a escribirse fuera de la transacción del mutex): la SONDA lo detecta de forma determinista (entra con $100, queda $120).
- **R13-3 (P1) · el editor de verificaciones de venta cambiaba `Payment.amount` y `Payment.method` a ciegas, por HTTP y por MCP.**
  `editOrgSaleVerification` (PATCH autorizado con `sale-verifications:edit` y la tool MCP `edit_sale_verification` con `confirm:true`) no
  consultaba `cobrosDelProtocolo` ni tomaba el mutex: un cobro de $100 con snapshot y costo DONE podía quedar en $120 o pasar CARD→CASH
  mientras la evidencia bancaria, el costo y la venta seguían referidos al cargo anterior (invariante 14). Ahora la decisión ECONÓMICA se
  toma bajo el mutex del Payment (`bloquearPayments … 'proteccion'`, relectura de importe y método VIGENTES, `cobrosDelProtocolo`): un
  cambio real de importe o de forma de pago sobre un cobro del protocolo se rechaza con **409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL`** (con
  `details.fields` y el motivo compartido) y NADA se escribe — ni el Payment ni la verificación ni la bitácora; los no-op (mismo importe y
  misma forma), la revisión (FAILED con notas), el tipo de venta y un cobro anterior al protocolo pasan como siempre. El controlador propaga
  `code`/`details` y la tool del MCP devuelve `ok:false` con el `code` (sin auditar como escritura). Pruebas nuevas: integración contra
  Postgres (`saleVerificationEdit.protocolo.integration.test.ts`, 12: PENDING REAL nacido del webhook y DONE por REST × importe / forma /
  ambos ⇒ 409 con foto intacta; controles de revisión y no-op; legacy editable con bitácora; y la CARRERA con la unidad de costo — el editor
  espera el mutex bloqueado por ese pid y decide 409), API con Express real (`saleVerificationEdit.api.test.ts`, +4: OWNER PATCH importe ⇒
  409 sin escribir, forma ⇒ 409, revisión sin dinero ⇒ 200 sin tocar el Payment, no-op ⇒ 200) y MCP (`sale-verification-writes.test.ts`,
  +1). Sabotajes **R13-3a** (deja de consultar el protocolo: caen las 9 de integración + API) y **R13-3b** (decide sin el mutex: cae la
  carrera).
- **R13-4 (P2) · un estado bancario PRESENTE pero ilegible obtenía MATCHED en el backfill.** La condición sólo rechazaba una cadena NO
  vacía distinta de `approved`: `status: 123`, `{}` o `""` saltaban el rechazo y llegaban al sello (que además guardaba ese estado ilegible).
  Ahora el estado se clasifica EXPLÍCITAMENTE en un solo sitio (`src/services/tpv/estadoBancario.ts` · `clasificarEstadoBancario`:
  APROBADO / RECHAZADO / AUSENTE / INVALIDO) para el receptor y para el backfill: el rechazo legible cierra `ERROR/NOT_APPROVED`; el
  INVALIDO conserva la evidencia PENDING con motivo **`INVALID_STATUS`** (acción nueva `INVALID_STATUS` en el receptor; el backfill no sella,
  no crea Payment ni huella); el campo AUSENTE sigue siendo la compatibilidad legacy, delimitada aparte. Pruebas nuevas: unitaria pura del
  clasificador (`estadoBancario.test.ts`, 20), backfill real con `123`, `{}`, `""` y espacios con importe correcto e identidad coincidente
  ⇒ PENDING/`INVALID_STATUS` sin Payment ni huella, más el CONTROL legacy (campo ausente ⇒ PROCESSED) y el RECEPTOR con `status: 123`
  (no crea dinero, evento PENDING con motivo y sin captura; una aprobación legible posterior sí crea). Sabotajes **R13-4a** (el
  clasificador trata lo ilegible como ausente) y **R13-4b** (el backfill deja de detenerse ante lo ilegible).
- **R13-5 (P2) · la recuperación del costo negativo no convergía su marca ni sus proyecciones.** (1) Reabrir DONE → PENDING por un
  reembolso no ponía `costPending: true`: tras un fallo transitorio la obligación estaba pendiente y el original seguía anunciando costo
  final. (2) `createRefundTransactionCost` creaba SÓLO el `TransactionCost`: ambos canales nacen con fee 0 y neto = bruto negativo, y
  nadie proyectaba el costo negativo en el Payment y la VenueTransaction del reembolso — original $100/fee $3/neto $97 con un reembolso
  total: los costos decían «comisión revertida $3» y las proyecciones sumaban neto −$3. Ahora `asegurarObligacionDeCostoNegativo` reactiva la
  marca al registrar trabajo nuevo (REABIERTA y ENCOLADA); `proyectarCostoDelReembolso` deriva fee/neto del reembolso desde su costo
  negativo PERSISTIDO con la MISMA regla monetaria (`proyeccionDelCosto`: fee −$3 / neto −$97 en total, fee −$1.00 / neto −$39 en un parcial
  de $40 — original + reembolso suman 0/0) y la escribe en Payment y VenueTransaction (fee, neto, `netSettlementAmount`) sólo si difieren;
  la unidad de convergencia recorre los reembolsos CON TRABAJO PENDIENTE (`reembolsosConTrabajoPendiente`: sin costo, o con costo pero con
  proyecciones distintas de las que su costo dicta — la regla monetaria expresada en SQL para que lo cumplido quede fuera de la consulta y
  la continuación durable de R4 se conserve) y un reembolso SIN VenueTransaction impide converger (`REFUND_VENUE_TRANSACTION_MISSING`,
  como R6 (i) para el original); y el costo SÍNCRONO post-commit de los dos canales (`costearYProyectarReembolso`: crea si falta —P2002 =
  ya existe— y proyecta) deja el reembolso proyectado sin esperar al worker. Se mantiene la política de componentes/fijos. Pruebas: los
  ocho casos de R12-15 (TPV y dashboard × falla transitoria / control) afirman ahora también la proyección del reembolso
  (`proyeccionDelReembolso`) y `costPending: true` inmediatamente después del fallo; nuevas: costo negativo YA EXISTENTE con proyecciones
  incompletas reparado por la siguiente corrida (×2), PARCIAL proyectado en el costo síncrono (×2), la concurrencia con la corrida
  reclamada afirma la marca; en `costoDiferido` los reembolsos de la fixture nacen con su VenueTransaction (como los canales reales), las
  pruebas de costo negativo afirman la proyección, y un reembolso sin VenueTransaction deja la obligación PENDIENTE con motivo y converge al
  existir la fila. Sabotajes **R13-5a** (reabrir sin marca), **R13-5b** (encolar sin marca), **R13-5c** (sin proyección del reembolso),
  **R13-5d** (vuelve a recorrer sólo los reembolsos sin costo), **R13-5e** (un reembolso sin VenueTransaction ya no bloquea) y **R13-5f** (el
  costo síncrono deja de proyectar).
- **R13-6 (P2) · la certificación permitía fixtures sin cierre común y una variante PENDING que era DONE.** Cinco instancias concretas:
  (a) la CARRERA del dashboard montaba su transacción sin actores, con la primera aserción antes de cualquier `finally` y `soltar` sólo en
  el camino normal; (b) la CONCURRENCIA de `costoReal` lanzaba montaje y reembolso sin actores; (c) `sosteniendoElCandado` (registrador)
  hacía `esperar` y `pidsQueEsperan` ANTES del `try` — si la segunda consulta fallaba, la barrera no se soltaba y el llamador no llegaba a
  `A.cerrar`; (d) en `costoDiferido` `expect(otro.llego)` iba antes del bloque cuya finalización libera y cierra; (e) la variante «PENDIENTE»
  del dashboard llamaba al REST real, que calcula el costo SÍNCRONO: ya era DONE. Ahora (a) y (b) usan el protocolo de actores (montaje +
  actores desde su lanzamiento, primera espera y aserción DENTRO del bloque cuyo `finally` libera, `cerrar` siempre, `afirmar`); (c) el
  helper nunca rechaza — espera, consulta y cuerpo van dentro del `try`, devuelve `fallo` y los cuatro llamadores llegan siempre a
  `A.cerrar(fallo)`; (d) la comprobación del montaje y el lanzamiento del actor van dentro del `try` (no se lanza nada contra una fila
  libre); (e) el PENDING es REAL: nace del webhook (método provisional ⇒ la unidad no corre) y se AFIRMA (`costPending: true`, obligación
  PENDING, sin costo, ligado a su solicitud) antes del PUT/DELETE; el CONVERGIDO afirma DONE y costo. Y, como exigió la tabla, los
  consumidores reales se certifican con FALLOS INYECTADOS: el runner gana el modo **`inyeccion(...)`** — muta un archivo de PRUEBA en un
  punto concreto y certifica que la suite termina con EXACTAMENTE las caídas declaradas, cada una con el mensaje esperado (regex), sin
  timeouts (barreras liberadas, trabajos asentados) y sin caídas colaterales: **R13-6a** (dashboard: la primera espera falla ⇒ cae con esa
  causa), **R13-6b** (la consulta del montaje falla en Postgres ⇒ `INCONCLUSO — montaje fallido: […division by zero…] · fallo original: …`),
  **R13-6c** (la liberación falla ⇒ `INCONCLUSO — liberación fallida: […]`), **R13-6d** (registrador: la segunda consulta del montaje falla ⇒
  los cuatro consumidores caen con esa causa, ninguno colgado), **R13-6e** (`filaTomadaPorOtro`: el montaje rechaza antes de la barrera ⇒
  INCONCLUSO nombrando el montaje en los tres consumidores) y **R13-6f** (`costoReal`: el reembolso rechaza de forma concurrente y una
  aserción anterior a examinarlo cae ⇒ INCONCLUSO conservando el rechazo Y el fallo original).
- **R13-7 (P2) · la pregunta INVERSA de R12-6: «otra solicitud apunta a MI Payment».** El cierre (`findFirst({ paymentId, requestId ≠ })` ⇒
  `PAYMENT_BOUND_ELSEWHERE`) y el barrido vetaban por MERA EXISTENCIA del puntero: Q-ajena UNKNOWN con `paymentId = P` (el antiguo productor
  no-success) impedía que Q-real cerrara con P aunque P estuviera acreditado para Q-real por etiqueta y terminal — Q-real seguía reteniendo
  la terminal con su cobro demostrado. Ahora `reclamacionesAjenas` (compartido por el cierre y el barrido): sólo una reclamación
  ACREDITADA por el mismo criterio (`procedenciaDelPagoDeSolicitud`, fase «ganador»: elegible para esa solicitud —misma orden si la tiene—,
  etiquetado con ella y cobrado en su terminal) veta, conservando al dueño auténtico; un puntero sin procedencia es un ALIAS contaminado:
  🚨, bitácora **`TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED`** (solicitud, Payment, dueña auténtica, motivo, estado previo, origen) y se
  retira EXACTAMENTE ese puntero (CAS sobre su valor — nunca se sobrescribe una reclamación acreditada concurrente). Acotado a 10 filas y
  al mismo venue. Pruebas nuevas (`terminal.integration`, describe «Codex R13-7»): el escenario histórico (P acreditado para Q-real, Q-real
  UNKNOWN sin puntero, Q-ajena UNKNOWN en otra terminal apuntando a P) cerrado por REPLAY (registro repetido) y por BARRIDO
  (`reconcileUnknownRequests`) — Q-real COMPLETED tardía y ligada, el alias retirado con bitácora, y la observación S6 (`consultarIntentoDeTerminal`:
  `isWinner`, `CHARGED`); los dos controles inversos (dueño acreditado ⇒ `PAYMENT_BOUND_ELSEWHERE` en el cierre; en el barrido, la columna que
  acredita a otra solicitud se conserva); unitarias del cierre y del barrido (veto por procedencia; alias resuelto con CAS, 🚨 y bitácora).
  Sabotajes **R13-7a** (el cierre veta por mera existencia), **R13-7b** (el barrido descarta por mera existencia), **R13-7c** (una reclamación
  acreditada deja de vetar) y **R13-7d** (el alias se registra pero no se resuelve).
- **Cobertura por rama que la tabla de R13 pedía, cerrada con detectores:** captura — unitaria «el CALLBACK termina bien y DESPUÉS
  `$transaction` rechaza» (lo leído NO se congela: `capturaFallida.total`, CAPTURA_FALLIDA; sabotaje **R13-C6**) y ABORTO SQL REAL dentro
  de la transacción de captura (`SELECT 1/0` por el cliente de la transacción ⇒ el cobro pasa, `capturaFallida` con «division by zero»,
  `PRICING_CAPTURE_FAILED`, nunca PRIMARY ni la tarifa de hoy, tampoco al «recuperarse» la base); convergencia — el WORKER con un token
  AJENO converge pero la obligación reclamada por otro token NO transiciona, sólo el dueño la cierra (sabotaje **R13-C1**: el cierre del
  worker deja de filtrar por el token propietario); consolidación — el snapshot se conserva byte a byte en sus cuatro estados (VALIDO /
  SIN_TARIFA / CAPTURA_FALLIDA / INVALIDO) ante un replay normal que sí enriquece (sabotaje **R13-C2**: la consolidación pierde `pricing`) y
  `costPending` no se copia de la lectura obsoleta cuando la obligación converge entre la lectura previa y la consolidación bajo el candado
  (sabotaje **R13-C3**); backfill — el sello es un parche atómico: con una copia obsoleta en mano (marca true, snapshot viejo) y otro
  escritor que ya convergió y cambió el snapshot, añade la huella y no repone la marca ni pisa el snapshot (sabotaje **R13-C4**: reemplaza en
  vez de parchar); reapertura/revocación — la revocación conserva las llaves monetarias del Payment equivocado byte a byte y sólo retira la
  huella de SU evento (sabotaje **R13-C5**: pierde `pricing`/`costPending`/`pricingSlot` aunque conserve la revocación y su historial).
- **Autorrevisión (14-sep, 17:3x, antes de la certificación definitiva): el keyset de reembolsos de R13-5 ataba un `Date` CRUDO en
  `$queryRaw`.** `reembolsosConTrabajoPendiente` paginaba con `r."createdAt" > ${ultimo.createdAt}`: un `Date` así llega como `timestamptz`
  y Postgres lo compara tras convertirlo con la zona de la SESIÓN — en la base local (`America/Mexico_City`) la página siguiente arrancaba
  6 h antes de su corte (repetía filas: trabajo idempotente pero presupuesto quemado en vano); en Render (UTC) daba la casualidad de acertar.
  Es exactamente la trampa que la regla del repo fija con el guard estático `tests/unit/architecture/rawSqlDateBindGuard.test.ts` — que
  con ese bind FALLABA (los shards unitarios lo habrían destapado). Va por `utcTs` (`src/utils/sqlDates.ts`), el guard vuelve a verde y el
  runner gana el sabotaje **R13-8** (el keyset vuelve al bind crudo ⇒ cae el guard). Ninguna otra consulta nueva de la ronda ata fechas.

**Certificación de la Ronda 13 (runner `sab-r7.py`, ahora con `inyeccion(...)`; respaldo `sab-r7.pre-r13.py`, bloque `sab-r13-bloque.py`):**
**156/156 CERTIFICADOS** en la segunda pasada completa (14-sep 19:14–20:15, 3 572 s de Jest): **150 sabotajes + 6 inyecciones**, 31 controles
en verde antes de sabotear, **640 declaraciones** (cada una resuelta a UNA prueba) + 11 caídas esperadas con su causa (regex) en las inyecciones,
huella `HEAD 03e7ac38 · wip 5633e1956c0c9014` (un solo runner: `5e35307c0e1402eb`), resultados estructurados en `sab-r13-definitiva-2-resultados.json`.
La **primera pasada completa** (18:12–19:13, huella `ccc3166140369e16`) dio 137/156 y los 19 restantes se reconciliaron **sin aflojar una sola
prueba**, cada uno con la caída leída en el JSON: (a) **catorce sabotajes viejos que ahora tumban también pruebas nuevas de la ronda 13** —
R5-C (+5), R5-D (+11) y R5-F (+1) ya en la exploratoria; R6-L (el token ajeno afirma que el dueño cierra dentro de la unidad), R9-2a y R11-2a (los
snapshots byte a byte con nulos), R10-1a, R10-1b, R10-2a, R11-1a y R12-14b (las pruebas de captura fallida / aborto SQL / evidencia sin captura o
de otra afiliación leen CAPTURA_FALLIDA por el lector, exigen la transacción de captura y el motivo público), R12-6d (el alias contaminado de R13-7
se resuelve por el mismo criterio de etiqueta), R12-1a (las tres pruebas de R13-1 consumen la captura del ingreso), R13-5c (+ la continuación
durable 20 · 20 · 12: sin proyecciones escritas la página de «trabajo pendiente» sigue devolviendo lo ya costeado), R13-C4 (+5: reemplazar en vez de
parchar borra el resto del `processorData`) y R13-C2 (+14: todo replay con snapshot que después mira snapshot o costo pierde `pricing`) — todas
caídas legítimas del defecto simulado, declaradas; (b) 🔑 **dos mutantes que quedaron EQUIVALENTES por el propio cierre de la ronda 13**
(SOBREVIVIÓ): **R12-1b** — «un cobro nacido del webhook ignora el origen» ya no cambia nada porque el selector común de R13-1 cae al camino de la
evidencia durable y encuentra SU propio evento con la captura (defensa en profundidad) ⇒ redefinido como DOBLE ruptura (origen + evidencia), con
la unión de caídas; y **R13-C3** — meter la marca `costPending` obsoleta en el RELLENO nunca puede pisar nada porque en la fusión
`relleno || existente` la fila existente gana para toda llave presente ⇒ redefinido para que la copia obsoleta viaje en `sobrescribir` (la única
parte que sí pisa) y sólo cuando la lectura previa la traía; (c) **R13-2a tumbaba de más por culpa del mutante**: mi reconstrucción del UPDATE
legacy fuera del mutex copiaba dos campos y la prueba legacy pedía `cardBrand` — el mutante reproduce ahora el UPDATE COMPLETO fuera del mutex y la
única caída es la SONDA de la carrera, que es la propiedad que certifica; (d) **R13-3b quedó INCONCLUSO por el ORDEN de las aserciones** de la
carrera del editor: afirmaba «esperó el mutex» ANTES de examinar el 409 del PATCH —que en esa prueba es el desenlace ESPERADO— y el protocolo de
actores, correctamente, lo reportó como «rechazo sin examinar» en vez de como la caída que era; reordenadas (actores primero, propiedad después) en
esa prueba y en su gemela del dashboard; (e) 🔴 **las inyecciones R13-6b/6e destaparon un defecto del PROPIO protocolo de actores**: `mensaje()`
tomaba la PRIMERA línea del error, y los errores de Prisma EMPIEZAN con un salto de línea ⇒ `montaje fallido: [transacción …: ]` sin causa
(la regex `division by zero` no casaba). Ahora colapsa el mensaje a una línea (unitaria 20/20). Nada de esto cambió código de producción: el
único cambio de `src/` posterior a la exploratoria es el `utcTs` de la autorrevisión, ya incluido en la huella certificada.

**Verificación pesada por avq-verify sobre el árbol FINAL:** lint 0 errores (66 avisos preexistentes) · typecheck del CI (`npm run typecheck`, incluye tests/ y scripts/) **0 errores, local y Alienware COINCIDEN** · typecheck 5.8 de `src` 0 errores COINCIDEN · **suite unitaria en 4 shards: 4182 + 4708 + 3808 + 4553 = 17 251 pruebas, 0 fallos, los cuatro COINCIDEN** local/Alienware · **integración de pagos completa: 20 suites, 546 pruebas, 0 fallos** (sólo en la Mac, con la base desechable) · API del checkpoint (terminal-payment, paymentProtocol, saleVerificationEdit): 20/20 COINCIDEN · repetición EXACTA `--runInBand` DUAL de los tres archivos flaky documentados: 16/16 COINCIDEN. ⚠️ La parte A (árbol previo a dos retoques de tipos en pruebas) destapó **4 errores de tipos en dos suites de integración mías** (una tabla `as const` que TypeScript no podía inferir —TS7024— y una espía sobre `prisma.payment.update` sin cast), corregidos y re-verificados (0 errores COINCIDEN), y un **DIFIEREN en el shard 3 por las dos suites de referidos ajenas** (`onOrderPaid`, `referralRefund.service`: pasan en la Mac, cayeron en el Alienware con «Number of calls: 0», cuarta vez desde el 13-sep, archivos idénticos en los dos lados y con WIP ajeno sólo de prettier) — NO se reporta como verde por sí mismo: en la parte B el mismo shard 3 COINCIDIÓ (3808/3808) y la repetición EXACTA DUAL de esos dos archivos dio 40/40 COINCIDEN ⇒ intermitencia del entorno remoto, no del código; queda una tarea aparte (chip) para la causa raíz. La huella del árbol al terminar la cadena (`wip 5633e1956c0c9014`) es exactamente la certificada por la definitiva-2; los avisos «otra sesión movió el árbol» son WIP ajeno fuera de src/tests/prisma. Evidencia: `avq-r13-*-final.txt`, `avq-r13-int.txt`, `avq-r13-api.txt`, `avq-r13-flaky-exactos.txt`, `avq-r13-referidos-exactos.txt`.

**Decimocuarta auditoría de Codex (gpt-6-astra xhigh; `gen-prompt-r14.py` ⇒ `prompt-codex-cp1-r14.txt`, `lanzar-codex-r14.sh`): la de
AUTORIZACIÓN sobre la siguiente huella** — los siete cierres de R13 y la cobertura por rama, contra los 18 invariantes; veredicto en
`codex-cp1-r14-veredicto.md`.

### 🔴 Ronda 14 — la segunda auditoría de AUTORIZACIÓN de Codex (14-sep 20:4x–21:1x, gpt-6-astra xhigh): RECHAZADO — 5 de los 7 hallazgos de R13 CERRADOS · 2 PARCIALES (R13-4 · R13-6) · 13 invariantes CUMPLIDOS · 3 PARCIALES (6 · 15 · 18) · 2 INCUMPLIDOS (14 · 17) · 5 hallazgos nuevos (R14-1 · R14-2 P1 de código · R14-3 · R14-4 P2 de código/recuperación · R14-5 P2 de certificación) → TODO cerrado con TDD, sabotajes certificados e inyecciones, con el DISEÑO de los tres mecanismos nuevos consultado a Codex ANTES de codificar (14-sep, noche)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r14-veredicto.md` (prompt `prompt-codex-cp1-r14.txt`: el checkpoint entero, la
sección «Ronda 13», la certificación 156/156 y la cadena avq). Confirmó huella, controles y resultados (HEAD `03e7ac38`, `diff -rq` cero,
cadena avq); dio por CERRADOS R13-1, R13-2, R13-3, R13-5 y R13-7 «implementados como se exigió», y por PARCIALES R13-4 (`status:null`
presente seguía leyéndose como ausente; tres clasificadores distintos) y R13-6 (un consumidor real seguía saltando el cierre común); y su
decisión fue explícita: «El push y el checkpoint 2 deben esperar a los cinco cierres de R14 y a su certificación sobre la siguiente huella».
Cada hallazgo se verificó contra el código real antes de aceptarlo (regla del founder): los cinco resultaron ciertos. **Regla nueva
aplicada por primera vez en esta ronda (memoria `no-perseguir-huecos-que-el-auditor-ya-excluyo`): los tres cierres que necesitaban un
MECANISMO nuevo se DISEÑARON CON CODEX antes de escribir código** (`prompt-codex-r14-diseno.txt` → `codex-r14-diseno-respuesta.md`): aprobó
(A) para R14-1, original→reembolso con relectura para R14-2, y (A) NOWAIT + SAVEPOINT «con recuperación garantizada» para R14-4; cambió
R14-3 a «normalización idéntica en JavaScript y SQL» y aprobó las inyecciones de R14-5. Los dos límites del founder se conservan en cada
cierre: el cobro nunca se interrumpe y nunca hay doble cobro, venta perdida ni venta sin cobro.

- **R14-1 (P1) · la tarifa todavía podía elegirse desde una evidencia POSTERIOR.** Tres caminos: (A) un segundo webhook del MISMO
  intento (otro `eventId`, misma llave) ingresaba con SU captura (la tarifa ya editada al 8 %) y el registrador la usaba porque
  `tarifaDeLaAfiliacion` devolvía «la captura del evento que originó esta llamada» sin preguntar cuál fue la PRIMERA evidencia durable; el
  mismo defecto si S4 procesaba E2 antes que E1; (B) la carrera de ingreso — el REST capturaba «ahora» en el instante en que el ingreso del
  webhook todavía no era visible; (C) el selector recortaba a 10 filas ANTES de filtrar aprobados — diez `declined` escondían al `approved`
  con captura. Cierre (diseño A de Codex): la PRIMERA evidencia durable del intento gobierna la tarifa, y se elige EN SQL
  (`evidenciaDurableDelIngreso`, `src/services/tpv/evidenciaDeIngreso.ts`): `estadoBancarioSql(payload->'payload'->'status') = 'APROBADO'`
  va en el `WHERE` y el orden es durable (`createdAt ASC, id ASC`, `LIMIT 1`) — ya no hay recorte antes del filtro; el selector es el MISMO
  para los tres orígenes (`tarifaDeLaAfiliacion(db, venueId, merchantAccountId, origen)` sin retorno temprano por origen: CON_CAPTURA la
  consume tal cual, SIN_CAPTURA / OTRA_AFILIACION conservan la incertidumbre como `capturaFallida`, y un webhook SIN evidencia visible de su
  propio ingreso —imposible bajo el candado— se guarda como `EVIDENCIA_DE_INGRESO_NO_VISIBLE`, nunca captura «ahora»); y el orden durable
  se garantiza con el candado del intento: el INGRESO del evento (`ingresarEventoDelIntento`, `angelpay-webhook.service.ts`) corre en una
  transacción READ COMMITTED del protocolo que toma `candadoDeIntento` como primera sentencia, fecha el evento **estrictamente después del
  último del intento** (`max(createdAt) + 1 ms` si el reloj fuera igual o anterior — marcador SQL `/* ingreso del intento */`) e inserta
  bajo el candado (si la espera del candado vence, 55P03, se persiste SIN serializar con 🚨 — nunca se pierde un evento); y las dos
  transacciones de dinero del REST (`recordFastPayment` y `recordOrderPayment`, `payment.tpv.service.ts`) toman ESE MISMO candado como
  primera sentencia antes de leer la evidencia y capturar. Pruebas (`webhookPrimerConfirmador.costoReal.integration.test.ts`, describe
  «Codex R14-1»): E1 (2.5 %) cuyo registrador muere → tarifa editada al 8 % → E2 del mismo intento crea el Payment con la captura de E1 (fee
  $3, no $8.50) y la recuperación de E1 conserva ese snapshot; S4 procesando E2 ANTES que E1 ⇒ ídem; CARRERA REST ↔ ingreso (el REST toma
  el candado y captura «ahora» al 2.5 %; el ingreso que llega después no la mueve; y la inversa: con el ingreso en vuelo el REST ESPERA el
  candado —observado en `pg_locks`— y consume la captura del ingreso); LÍMITE (diez `declined` antes del `approved` ⇒ se usa el approved);
  ORDEN DURABLE (dos ingresos del mismo intento reciben `createdAt` estrictamente creciente aunque el reloj no avance). Sabotajes
  **R14-1a** (recorte antes de filtrar, en memoria) · **R14-1b** (la venta rápida deja de tomar el candado del intento) · **R14-1c** (el
  ingreso inserta suelto) · **R14-1d** (el ingreso conserva el candado pero fecha con el reloj); y los ocho viejos que la refactorización
  desancló (R5-B, R12-7a/7b/7d, R12-1b, R12-1c, R13-1a, R12-11e) reanclados y recertificados. La guardia estática
  (`candadoDeIntentoOrden.guard.test.ts`) cuenta ahora TRES transacciones del protocolo en el webhook y fija que la llave del ingreso es la
  MISMA variable que va al candado y a la fila (`attemptId: llaveDelIntento`).
- **R14-2 (P1) · el REEMBOLSO de un cobro del protocolo quedaba fuera de la protección administrativa.** `cobrosDelProtocolo` sólo
  reconocía `pricing` propio u obligación propia; el REFUND nace sin snapshot y su obligación vive en el ORIGINAL, así que PUT y DELETE del
  dashboard lo trataban como legacy: OWNER cambia `amount` del reembolso a −$120 (o lo borra, con su costo negativo y su venta en
  cascada) y la devolución bancaria se queda sin contrapartida. Cierre (diseño aprobado): la pertenencia alcanza a todo REFUND cuyo original
  pertenece, con el MISMO predicado que la unidad de costo usa para encontrarlos (`type = 'REFUND'`, `processorData->>'originalPaymentId'`,
  mismo venue — `cobroDelProtocolo.ts`: `pertenenciaPropiaSql(alias)` aplicado a `p` y a `o`); y quien protege toma los candados en el
  ORDEN de la unidad, ORIGINAL → reembolso (`bloquearConSuOriginal`: lee el puntero sin candado, bloquea el original, bloquea el reembolso,
  RELEE el puntero bajo el candado y, si cambió mientras esperaba, `ROLLBACK TO SAVEPOINT` suelta lo tomado y vuelve a empezar — nunca
  adquiere otro original después del reembolso; tres intentos y 409 `PAYMENT_PROTOCOL_LOCK_UNSTABLE`). `updatePayment` y `deletePayment`
  (`payment.dashboard.service.ts`) usan ese candado; el 409 `PAYMENT_PROTECTED_BY_COST_PROTOCOL` conserva su código y NOMBRA al original
  (`details.originalPaymentId`, aditivo) con un mensaje propio del reembolso; los no-op siguen pasando. Consecuencia del criterio
  compartido: la corrección genérica de tarifas también EXCLUYE al reembolso de un original del protocolo (y lo explica). Pruebas
  (`paymentDashboard.protocolo.integration.test.ts`, describe «Codex R14-2»): reembolso por los DOS canales (TPV `recordRefund` y dashboard
  `issueRefund`) × obligación del original PENDING (la creación síncrona del costo negativo falla: reembolso sin costo, obligación reabierta
  `REFUND_COST`) y DONE (costo negativo convergido, fee −3 / neto −97 en Payment y VenueTransaction, worker cerró la obligación) × ocho PUT
  económicos + DELETE + NO-OP: 409 con código, campos y el original nombrado, y la foto del par (reembolso, original, eventos, solicitud,
  cuántos reembolsos apuntan al original) IDÉNTICA antes y después; CONTROL: el reembolso de un legacy sin costo se edita y borra;
  CARRERA con la unidad del ORIGINAL (con la fila del original tomada, el PUT sobre el REFUND espera ESE mutex y, mientras espera, la fila
  del reembolso está LIBRE — sonda `FOR NO KEY UPDATE NOWAIT` — y después decide 409); RELECTURA bajo el candado (el puntero cambia
  mientras el PUT espera el original viejo ⇒ el PUT suelta ese candado, vuelve a leer y decide contra el par ACTUAL: viejo LIBRE, nuevo y
  reembolso TOMADOS; el `UPDATE` que reapunta lleva `lock_timeout` para que un orden equivocado caiga por aserción y no por cuelgue); y en
  `rateCorrection.protocolo`: el reembolso queda excluido de preview y apply e intacto, el de un legacy sí se corrige. Sabotajes
  **R14-2a** (el criterio vuelve a la pertenencia propia) · **R14-2b** (orden reembolso → original) · **R14-2c** (sin relectura) ·
  **R14-2d/2e** (PUT/DELETE bloquean sólo su fila y el 409 deja de nombrar al original); R12-4d/4e y R12-5a/5b reanclados.
- **R14-3 (P2) · el estado bancario seguía con interpretaciones incompatibles.** `null` presente se clasificaba AUSENTE (y el backfill
  seguía hacia MATCHED); captura al ingreso y confirmación por vínculo exigían `approved` EXACTO (una aprobación con mayúsculas o espacios
  no capturaba); S6 extraía el estado como TEXTO (`->>`) y publicaba `123` o `{}` como DECLINED. Cierre (Codex: «normalización idéntica en
  JavaScript y SQL»): `clasificarEstadoBancario` — `undefined` ⇒ AUSENTE, `null` presente ⇒ INVALIDO, no-string/vacío ⇒ INVALIDO, `approved`
  (recortado con la clase de espacios de `trim()`, minúsculas) ⇒ APROBADO, si no RECHAZADO — y su gemelo `estadoBancarioSql(expr)` (tipo
  JSON primero, `PATRON_SQL_TRIM_COMO_JS`, mismas cinco ramas), usados por la captura al ingreso, la confirmación por vínculo, el rearme del
  worker, el selector de evidencia (`WHERE`) y S6 (`coalesce(payload->payload->status, payload->status)`). Pruebas: unitaria
  `estadoBancario.test.ts` (25: null ⇒ INVALIDO, espacios Unicode), NUEVA `estadoBancario.sql.integration.test.ts` (22: matriz JS≡SQL por
  `$queryRaw` con `::jsonb` y un `WHERE` real), receptor `status: null` ⇒ INVALID_STATUS y `'  Approved  '` / `'\tapproved '` ⇒
  CONFIRMED con captura (mismo `frozenAt`), backfill `it.each` + `null presente`, S6 con `123`, `{}`, `null`, `' \t'` ⇒ evidencia NONE y
  aprobación normalizada con importe distinto ⇒ APPROVED. Sabotajes **R14-3a … R14-3e** (null como ausente; captura exacta; confirmación
  exacta; S6 como texto; `btrim` en vez de la clase de espacios — que también tumba «sólo tab y salto», declarado).
- **R14-4 (P2) · la limpieza de aliases introducía una ESPERA CIRCULAR entre solicitudes.** El cierre tomaba su solicitud → su Payment →
  y, para retirar un alias, OTRA solicitud; con Q1→P2 y Q2→P1 (punteros cruzados) y dos replays simultáneos, T1 (Q1, P1) esperaba Q2 y T2
  (Q2, P2) esperaba Q1: interbloqueo, un cierre abortaba y su solicitud seguía UNKNOWN con la captura ya hecha. Cierre (diseño A de Codex,
  «con recuperación garantizada»): `retirarAliasAjeno` (`terminal-payment.service.ts`) toma cada fila ajena con `FOR UPDATE NOWAIT` dentro
  de un `SAVEPOINT`; 55P03 ⇒ `ROLLBACK TO SAVEPOINT` (la transacción propia sigue sana) y el alias se DIFIERE con bitácora
  `TERMINAL_PAYMENT_CONTAMINATED_ALIAS_DEFERRED`; cualquier otro error propaga; tomada ⇒ RELECTURA del puntero, orden, terminal y estado bajo
  el candado (si ya no apunta aquí, nada; si ahora está ACREDITADA, veta) y CAS exacto sobre su valor; una reclamación acreditada sigue
  vetando desde la lista sin candado (vetar no escribe). El barrido corre la limpieza en una transacción REAL con el orden del cierre
  (`findReconcilablePayment`: solicitud propia FOR UPDATE → Payment FOR UPDATE → ajenas sin esperar), y **recupera lo diferido aunque el cierre
  que lo difirió ya haya terminado COMPLETED**: `retirarAliasPropio` — una fila UNKNOWN cuyo puntero no es un cobro acreditado suyo lo
  suelta bajo su propio candado, releyendo y revalidando la procedencia antes del CAS, con bitácora `…ALIAS_RESOLVED` (origen `barrido`);
  un puntero ACREDITADO (incluido un ganador REFUNDED, no elegible para ligar) se conserva. Pruebas (`webhookPrimerConfirmador.terminal.integration.test.ts`,
  describe «Codex R14-4»): CARRERA con aliases cruzados y una puerta de dos llegadas (los dos cierres poseen su solicitud y su Payment antes de
  limpiar ⇒ ninguno espera, los dos terminan, Q1→P1 y Q2→P2, dos ventas, S6 correcto en las dos terminales, exactamente dos DIFERIDOS y
  ningún RESUELTO); CONTROL del puntero que cambió ANTES del CAS (la fila ajena reapunta entre la lista sin candado y el candado ⇒ la
  relectura lo ve, nada se retira, su puntero nuevo se conserva); BARRIDO recupera lo DIFERIDO (alias retirado con bitácora, el acreditado
  cierra la fila, el REFUNDED se conserva, la segunda pasada no retira nada). Las dos unitarias del alias (`terminal-payment.service.test.ts`)
  modelan ahora la relectura NOWAIT y el savepoint. Sabotajes **R14-4a** (`FOR UPDATE` esperando) · **R14-4b** (sin relectura) · **R14-4c**
  (diferido silenciado) · **R14-4d** (el barrido deja de recuperar el alias propio) · **R14-4e** (limpieza fuera de una transacción real);
  R13-7b/7d reanclados.
- **R14-5 (P2) · un consumidor real seguía saltando el cierre común.** `registroConBackfillDrenado` (webhook) sólo llegaba a `B.cerrar()`
  en el camino feliz. Cierre (aprobado): el helper captura el fallo original en `try/catch` y en `finally` hace `try { await B.cerrar(fallo) }
  finally { espia.mockRestore() }` — el backfill lanzado se drena SIEMPRE, la causa original se conserva, y si además el backfill rechaza
  el desenlace es INCONCLUSO con AMBAS causas; restaurar el espía ocurre aunque `cerrar` lance. Inyecciones **R14-5a … R14-5d** en el
  consumidor real (el registrador falla después de lanzar el backfill; la primera espera falla; el backfill rechaza de forma concurrente ⇒
  INCONCLUSO nombrando el montaje; ambas causas a la vez), cada una con exactamente las caídas y la causa declaradas en los cinco
  consumidores del helper (**R14-5d** es la que detecta quitar `cerrar`).

**Certificación de la Ronda 14 (runner `sab-r7.py`): 179/179 CERTIFICADOS sobre la huella FINAL `HEAD 03e7ac38 · wip b1adaa5bc0ec7ee1`**
(tercera pasada completa, 01:04–02:14, 175/179 — más la repetición acotada de las cuatro inyecciones sobre la MISMA huella, 02:15–02:20, que
las lleva a 179/179; resultados estructurados en `sab-r7-resultados.json`, copia en `sab-r14-definitiva-3-resultados.json`): **169 sabotajes +
10 inyecciones**, 32
controles en verde antes de sabotear (dos nuevos: `estadoBancario.sql` JS≡SQL y la guardia de binds de fecha; el «33» que decía aquí era una
errata que Codex señaló en R15), **816 declaraciones** (cada una
resuelta a UNA prueba) + 35 caídas esperadas con su causa en las inyecciones. Antes, tres pasadas acotadas (`SAB_ONLY`) certificaron cada cierre
al terminarlo — R14-1 (12/12 con los ocho reanclados), R14-2/R14-4 (13/16, con dos INCONCLUSOS y un mutante malformado corregidos), R14-3
y R14-5 en la sesión anterior — y la **primera pasada completa** (23:03–23:57, huella `639a5b383a164315`) dio **162/179**; los 17 restantes se
reconciliaron **sin aflojar una sola prueba**, cada uno con la caída leída en el JSON: (a) **once sabotajes viejos que ahora tumban también
pruebas nuevas de la ronda 14** — R5-D, R11-1a/1b y R13-C2 (las pruebas de R14-1 afirman el fee proyectado y el snapshot, y la carrera pausa
DENTRO de la captura, donde sin la vista única entra la edición al 8 %), R12-1a y R12-14b (sin captura al ingreso o sin `getEffectivePricingForSlot`
los escenarios de R14-1 no encuentran la captura), R12-4a (la partición previa también excluye el REFUND), R12-5c (los no-op sobre el REFUND),
R13-1c (S4 con evento sin captura), R13-4a/4b (null presente y espacios Unicode) y R13-7a (vetar por mera existencia deja sin cerrar los
replays cruzados) — todas caídas legítimas del defecto simulado, declaradas; (b) 🔑 **tres mutantes que R14-1 dejó sin discriminar en UNA
prueba** (DECLARADA NO CAYÓ): R5-G, R6-G y R6-O dejaron de tumbar «la publicación del vínculo consultó eventos (ninguno)…» porque ahora el
INGRESO del evento toma el candado del intento ANTES que el escritor débil y espera al vínculo por su cuenta (defensa en profundidad, como
R12-1b en la ronda 13); la prueba se hizo precisa (afirma que quien espera es el pid del INGRESO, `pids.ingresos`, y que el escritor débil toma
el candado después) y esa declaración se retiró de los tres — que siguen certificados por «la inversa», el timeout del candado, la guardia
estática y el resto de sus declaraciones; (c) **cuatro INCONCLUSOS por caídas que no eran aserciones**, corregidos en las pruebas: `capturaDe`
reventaba con `TypeError` sobre un evento sin captura (ahora afirma la captura), la CARRERA de R14-1 esperaba la pausa sin tope (ahora
`pausadaEn(5000)` por aserción), las dos pruebas del receptor normalizado comparaban `frozenAt` con acceso directo (ahora `toMatchObject`), y
la unitaria del barrido dejaba `$queryRaw` sin valor por defecto (un mutante que llegaba a la relectura NOWAIT tropezaba con `undefined`);
(d) **R14-2b/2d quedaron INCONCLUSOS en la pasada acotada por el ORDEN de las aserciones** de la prueba de relectura (afirmaba propiedades
antes de examinar el PUT, que bajo el mutante queda en 409): actores primero, propiedad después — el mismo defecto que R13-3b; (e) **R14-4e
estaba malformado** (un arrow function nunca invocado): rehecho como la forma vieja sin transacción y certificado por la unitaria (contra
Postgres un SAVEPOINT fuera de transacción REVIENTA, no cae por aserción — la propia base impide ese estado). La **segunda pasada completa**
(23:59–01:04, huella `ce27583465d8ea33`) dio **177/179** y destapó dos más: (f) 🔑 **R13-7c quedó EQUIVALENTE por el propio cierre de R14-4**
(DECLARADA NO CAYÓ en los dos controles inversos): el veto de una reclamación acreditada vive ahora en DOS sitios —la lista sin candado y la
RELECTURA bajo el candado de `retirarAliasAjeno`— y quitar sólo el primero deja al segundo vetando (defensa en profundidad, como R12-1b y
R13-C3 en la ronda 13) ⇒ redefinido como DOBLE ruptura; (g) 🔴 **«el sello del backfill es un PARCHE atómico» dejó de observar el parche por
una CARRERA de la propia prueba**: el backfill fire-and-forget del registrador competía con el sello explícito de la prueba, y según quién
ganara el mutante R13-C4 pasaba (el sello del registrador reemplazaba `processorData` ANTES del `UPDATE` que la prueba usa como «otro
escritor», que lo volvía a completar) — ahora el evento nace RESERVADO (lease vigente), el registro pasa por `registroConBackfillDrenado`
(que drena ese backfill sin poder reclamarlo), se afirma que sigue PENDING, se libera el lease y el sello explícito es el ÚNICO sello: la
prueba observa el parche siempre. La **tercera pasada completa** (01:04–02:14, huella final) dio **175/179**: (h) el arreglo de (g) convirtió esa
prueba en el SEXTO consumidor de `registroConBackfillDrenado`, así que las cuatro inyecciones R14-5a…5d también la tumban con la causa
inyectada — declarada en las cuatro (con la misma regex de causa que los otros cinco consumidores) y repetidas acotadas sobre la MISMA
huella, que el runner fusiona en el JSON sólo si la huella coincide. Ningún cambio de `src/` posterior a la primera pasada; los únicos cambios
fueron pruebas, declaraciones y el escape de un NBSP literal en un comentario (lint).

**Verificación pesada por avq-verify sobre el árbol FINAL:** lint 0 errores (66 avisos preexistentes) · typecheck del CI (`npm run typecheck`, incluye tests/ y scripts/) **0 errores, local y Alienware COINCIDEN** · typecheck 5.8 de `src` 0 errores COINCIDEN · **suite unitaria en 4 shards: 4187 + 4708 + 3808 + 4553 = 17 256 pruebas, 0 fallos propios** — shards 1 y 4 COINCIDEN; los shards 2 y 3 marcaron DIFIEREN por las tres sondas de presupuesto del event loop del catálogo ya documentadas en el workspace (`catalogImportCanonical`, `catalogImportDurableEventLoop` y `catalogWorkbook.eventloop-budget`: archivos idénticos a HEAD, código ajeno; en la parte A cayó una en la Mac con la certificación corriendo al lado, en la parte B cayeron en el Alienware con la Mac en verde), y la repetición EXACTA `--runInBand` DUAL de esos archivos dio **16/16 y 4/4 COINCIDEN** ⇒ contención de carga, no código · **integración de pagos completa: 21 suites, 629 pruebas, 0 fallos** (sólo en la Mac, con la base desechable; incluye la nueva `estadoBancario.sql`) · API del checkpoint (terminal-payment, paymentProtocol, saleVerificationEdit): 20/20 COINCIDEN · referidos exactos (los dos archivos ajenos que divergieron en R13): 40/40 COINCIDEN. ⚠️ La parte A (árbol previo a tres retoques de pruebas) destapó **1 error de lint** (un NBSP literal en un comentario de cabecera de la suite SQL de estado bancario, escapado) y **1 error de tipos en una prueba de integración mía** (un cast sobre la captura del ingreso, TS2352, tipado con `frozenAt`), corregidos y re-verificados en la parte B (0 y 0, COINCIDEN). La huella del árbol al terminar la cadena (`wip b1adaa5bc0ec7ee1`) es exactamente la certificada por la definitiva-3 (179/179); los avisos «otra sesión movió el árbol» son WIP ajeno fuera de src/tests/prisma. Evidencia: `avq-r14-*-final.txt`, `avq-r14-int.txt`, `avq-r14-api.txt`, `avq-r14-flaky-exactos.txt`, `avq-r14-eventloop-exacto.txt`, `avq-r14-referidos-exactos.txt`.

**Decimoquinta auditoría de Codex (gpt-6-astra xhigh; `gen-prompt-r15.py` ⇒ `prompt-codex-cp1-r15.txt`, `lanzar-codex-r15.sh`): la de
AUTORIZACIÓN sobre la siguiente huella** — los cinco cierres de R14 (y los dos parciales de R13) contra los 18 invariantes y la cobertura por
rama; veredicto en `codex-cp1-r15-veredicto.md`.

### 🔴 Ronda 15 — la tercera auditoría de AUTORIZACIÓN de Codex (15-sep 03:3x–04:0x, gpt-6-astra xhigh): RECHAZADO — 4 de los 5 hallazgos de R14 CERRADOS · R14-1 PARCIAL (el fallback del ingreso) · R13-4 CERRADO · R13-6 PARCIAL (la prueba del timeout) · 13 invariantes CUMPLIDOS · 3 PARCIALES (5 · 6 · 18) · 2 INCUMPLIDOS (14 · 17) · 3 hallazgos nuevos (R15-1 · R15-2 P1 de código · R15-3 P2 de certificación) → TODO cerrado con TDD, sabotajes certificados e inyecciones, con el DISEÑO de los dos mecanismos nuevos consultado a Codex ANTES de codificar (15-sep, madrugada)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r15-veredicto.md` (prompt `prompt-codex-cp1-r15.txt`). Confirmó huella, controles y
resultados (HEAD `03e7ac38`, `wip b1adaa5bc0ec7ee1`, `diff -rq` cero contra `sab-server`, 244 JSON de ejecución, 816 caídas por aserción y 35
fallos esperados de inyecciones contrastados; señaló la errata de los «33» controles: son 32); dio por CERRADOS R14-2 (para PUT/DELETE del
REFUND), R14-3, R14-4, R14-5 y R13-4 «implementados como se diseñaron», y por PARCIALES R14-1 (el camino normal cumple; «el fallback de
timeout lo incumple: inserta sin candado ni fecha monótona y su captura sigue siendo elegible») y R13-6 (los dos montajes de la prueba del
timeout esperan antes del `try/finally`); y su decisión fue explícita: «El push y el checkpoint 2 deben esperar al cierre y certificación de
R15-1, R15-2 y R15-3». Cada hallazgo se verificó contra el código real antes de aceptarlo (regla del founder): los tres resultaron ciertos.
**Los dos cierres que necesitaban un MECANISMO nuevo se DISEÑARON CON CODEX antes de escribir código** (`prompt-codex-r15-diseno.txt` →
`codex-r15-diseno-respuesta.md`): para R15-1 aprobó la persistencia excepcional con incertidumbre conservada y cambió dos cosas —el selector
decide marca y primer aprobado en UNA sola sentencia, y la recuperación **conserva** una marca durable de «orden histórico no acreditado»
(un orden de recuperación no demuestra la prioridad histórica; el marcador del Payment se conserva hasta acreditación explícita, sin
convergencia automática), en transacción propia con orden intento → eventos revalidando el claim (S4 reclama con `SKIP LOCKED`, sin candado
del intento)—; para R15-2 aceptó NOWAIT y exclusión por contención en vez de esperar, exigiendo originales dentro y fuera del lote
(deduplicados y ordenados) ANTES del lote, savepoint exterior por intento e interiores por NOWAIT, relectura de tipo/venue/puntero de TODOS
los candidatos y la precisión de que el 409 llega DESPUÉS de actualizar la tarifa vigente («409 ≠ no se escribió nada»); para R15-3 aprobó el
protocolo de actores con el `finally` exterior que restaura entorno y espías aunque `cerrar` lance, y las cuatro inyecciones. Los dos límites
del founder se conservan en cada cierre: el cobro nunca se interrumpe y nunca hay doble cobro, venta perdida ni venta sin cobro.

- **R15-1 (P1) · el FALLBACK del ingreso volvía a permitir que una evidencia posterior gobernara la tarifa.** El camino normal serializa
  (candado → máximo → fecha estricta → INSERT bajo el candado), pero ante 55P03 se omitían los cuatro pasos y la captura del evento seguía
  siendo elegible: E1 (2.5 %) PENDING fechado en el futuro → tarifa al 8 % → otra transacción sostiene el candado → E2 (misma llave, 8 %)
  vence y entra por el INSERT global con una fecha ANTERIOR a E1 → REST/S4 eligen E2 por `ORDER BY createdAt, id` ⇒ fee $8.50 en vez de
  $3, y recuperar E1 después conserva el snapshot ya elegido. Cierre (diseño aprobado): el fallback conserva la evidencia pero la persiste
  MARCADA (`_avoqado.ingresoSinCandado: { en }`, dentro del evento, junto a su captura — `ingresarEventoDelIntento` pasa la marca al
  insertador); el selector (`evidenciaDurableDelIngreso`, `evidenciaDeIngreso.ts`) decide en UNA sentencia (CTEs `intento`/`primera`,
  columnas `sinOrden` · `primeraId` · `primeraPayload`) y, si algún evento del intento lleva la marca, responde el tipo nuevo
  `ORDEN_NO_ACREDITADO` — el registrador (`tarifaDeLaAfiliacion`) lo convierte en captura fallida con motivo público
  `EVIDENCIA_DE_INGRESO_SIN_ORDEN` (pendiente y visible hasta una acreditación explícita; nunca CON_CAPTURA de nadie ni la tarifa de hoy);
  y la RECUPERACIÓN (`ordenarIngresosPendientesBajoCandado`: pendientes = marca sin `ordenadoEn`, `ORDER BY id FOR UPDATE`, cada uno fechado
  `max(createdAt) + 1 ms` sobre el intento —sin el reloj— y `jsonb_set(…ordenadoEn…)`, la marca se CONSERVA) corre bajo el candado en el
  siguiente ingreso normal del intento (antes de fechar el evento nuevo) y desde S4 (`ordenarIngresosSinCandado`, exportada: fast path sin
  candado si no hay pendientes; si los hay, transacción PROPIA READ COMMITTED — candado del intento como PRIMERA sentencia → revalidación
  del claim `/* reclamo vigente */` (con un token que ya no es el vigente no ordena nada) → orden — llamada en `runClaimedAngelPayEvent`
  ANTES de reconciliar, dentro del `try` que deja el evento PENDING si la espera vence). Límite declarado: si el propio receptor logra
  registrar el Payment justo después del fallback (el candado se liberó entre las dos esperas), ese evento queda PROCESSED con la marca y
  sin `ordenadoEn` hasta el siguiente ingreso o S4 del intento — el selector ya lo trata como incertidumbre, así que la tarifa no depende de
  ese orden. Pruebas (`webhookPrimerConfirmador.costoReal.integration.test.ts`,
  describe «Codex R15-1», cada fallback con OTRA transacción sosteniendo el candado y `TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS=300` real, protegido
  con el protocolo de actores y restaurado en `finally`): FALLBACK (E1 fechado 5 s en el futuro → 8 % → E2 por el fallback queda marcado y
  ANTES de E1; S4 lo ordena DESPUÉS de E1 con `ordenadoEn`; el único Payment nace con `EVIDENCIA_DE_INGRESO_SIN_ORDEN`, fee nunca $8.50 ni
  $3, los dos eventos sellados sobre él, la marca permanece y el REST no la levanta; otra pasada no reordena); RECUPERACIÓN ANTES DEL PRIMER
  PAYMENT (E2 por el fallback → el siguiente ingreso normal (E3 rechazado) lo ordena `+1 ms` y nace después → el REST sigue viendo
  ORDEN_NO_ACREDITADO); VARIOS PENDIENTES (E2 y E3 por el fallback, ordenados por `id` uno tras otro, los dos después del futuro de E1, un
  Payment con incertidumbre y tres eventos sellados); CANDADO (la recuperación de S4 con un token ajeno no ordena; con el claim vigente y el
  candado sostenido por otra transacción ESPERA —pid en `pg_locks`— sin ordenar, y al soltarse ordena `+1 ms`); y las carreras que Codex
  pedía para las dos direcciones: INVERSA venta rápida y con orden (el INGRESO de E1 tiene el candado, pausado dentro de su transacción con
  el evento sin insertar; la edición al 8 % y el REST llegan mientras tanto; el REST ESPERA —pid observado— y consume la captura del ingreso:
  snapshot 2.5 % con el `frozenAt` de E1, fee $3) y CARRERA con ORDEN (la contraparte de R14-1b: `recordOrderPayment` toma el candado y el
  ingreso espera). La prueba del timeout de la suite del webhook afirma también la marca y la incertidumbre del Payment por el camino del
  escritor débil. Sabotajes **R15-1a** (fallback sin marca) · **R15-1b** (el selector ignora la marca si hay un aprobado) · **R15-1c** (dos
  sentencias; sólo la guardia estática) · **R15-1d** (recuperación con el reloj) · **R15-1e** (la recuperación borra la marca) · **R15-1f**
  (S4 ordena sin el candado) · **R15-1g** (el ingreso normal deja de ordenar) · **R15-1h** (S4 reconcilia sin recuperar) · **R15-1i** (el
  registrador ignora ORDEN_NO_ACREDITADO) · **R15-1j** (con ORDEN la transacción del dinero deja de tomar el candado); R14-1a reanclado al
  selector de una sentencia y R14-1b ampliado con la INVERSA. La guardia estática cuenta ahora CUATRO transacciones del protocolo en el
  webhook y fija: ingreso = candado → recuperación → `/* ingreso del intento */`; S4 = transacción propia con el candado como primera
  sentencia → reclamo vigente → orden, y ANTES de reconciliar; el selector en UNA `db.$queryRaw` con `sinOrden` y `primeraId`; la
  recuperación con `FOR UPDATE`, `jsonb_set` (nunca `#-`) y sin `Date.now()`.
- **R15-2 (P1) · apply/reverse clasificaban el REEMBOLSO sin proteger el original del que depende su pertenencia.** Bloqueaban sólo
  `paymentIds`; la pertenencia (R14-2) depende de OTRA fila (el original, que el alcance por fecha puede dejar fuera del lote), y `bloquearPayments(id ASC)`
  podía tomar el reembolso ANTES que su original (el orden inverso al de la unidad): un lote con R1 (histórico, legacy) y sin P, pausado
  tras clasificar; un reembolso real R2 sobre P encola la obligación en P ⇒ R1 ya pertenece al protocolo, y apply seguía con su clasificación
  y sustituía costo y proyecciones (−$3.50 en vez de la copia del costo original). Cierre (diseño aprobado): módulo nuevo
  `src/services/shared/candadosDelLote.ts` — `bloquearLoteConOriginales(tx, { venueId, paymentIds })`: `SAVEPOINT lote_del_protocolo` por
  intento → fotografía sin candado (tipo, venue, `processorData->>'originalPaymentId'`) → ORIGINALES de los reembolsos, dentro y fuera del
  lote, únicos y en `id ASC`, cada uno con `FOR NO KEY UPDATE NOWAIT` y savepoint interior (55P03 ⇒ «ocupado»: aparta a todos sus
  reembolsos y, si está en el lote, a sí mismo — la corrección no espera a la unidad de costo) → el LOTE no apartado en `id ASC`
  (`bloquearPayments`, esperando) → RELECTURA de tipo/venue/puntero de TODOS los candidatos y comparación con la fotografía (si algo cambió,
  `ROLLBACK TO SAVEPOINT` suelta TODOS los candados del intento y reinicia; tres intentos y 409 `RATE_CORRECTION_LOCK_UNSTABLE`);
  apply y reverse clasifican (`cobrosDelProtocolo`) y escriben SÓLO lo bloqueado, con los candados puestos hasta el commit, y explican lo
  apartado (`excludedBusyPaymentIds` / `excludedBusyCount` / `excludedBusyReason`, aditivo, también en la bitácora); el 409 de apply llega
  DESPUÉS del paso que actualiza la estructura vigente y el mensaje lo declara («la estructura de tarifas VIGENTE ya quedó actualizada;
  ningún cobro histórico se tocó», `details.liveRatesUpdated`). El módulo va aparte de `cobroDelProtocolo.ts` a propósito: la fase del lote
  llama a `bloquearPayments` a través del módulo hermano, así las pruebas pausan ENTRE las dos fases sin ganchos en producción. Residuo
  declarado: la fase del lote sí espera, y dos lotes concurrentes con originales cruzados con sus lotes pueden interbloquearse (40P01:
  Postgres aborta uno y la transacción perdedora revierte sus escrituras — si es un apply, su lote queda FAILED y se reintenta; si es un
  reverse, el lote conserva APPLIED y el reverse se repite; precisión de Codex R16). Pruebas (`rateCorrection.protocolo.integration.test.ts`, describe «Codex
  R15-2»; sondas `FOR NO KEY UPDATE NOWAIT` en transacción propia): ORIGINAL FUERA DEL LOTE, OCUPADO (original legacy fuera del alcance y
  tomado por otra transacción: apply no espera —termina con ese candado puesto—, el reembolso queda LIBRE y apartado como ocupado, el
  legacy tomado y corregido, bitácora); ORIGINAL LEGACY FUERA DEL LOTE (el original está TOMADO durante la clasificación y la escritura
  aunque no esté en el lote); CARRERA con un reembolso REAL (el escenario de Codex: P histórico con costo $3, R1 histórico dentro del lote;
  apply pausado tras clasificar; R2 real sobre P ESPERA —`carrera` 2 s ⇒ BLOQUEADA— y entra sólo tras el commit: P entra al protocolo
  DESPUÉS); ORDEN INVERSO DE IDS (reembolso re-identificado con un id menor que su original: pausado entre las dos fases, el original está
  tomado y el reembolso libre); RELECTURA (el puntero cambia O1 → O2 con O1 ya tomado: reinicio, O2 tomado y O1 libre en el segundo
  intento) y su variante de tres cambios ⇒ 409 con el mensaje y `liveRatesUpdated: true`, lote FAILED, sin entradas, candados sueltos, la
  tarifa vigente al 8 %; VARIOS REEMBOLSOS del mismo original (dos parciales apartados con el original ocupado, corregidos con él libre);
  REVERSE con un original ocupado (él y su reembolso quedan como el lote los dejó, el resto se revierte, lote REVERSED). Las unitarias de
  apply/reverse stubean la FILA de la fotografía y los savepoints. Sabotajes **R15-2a** (sin fase de originales) · **R15-2b** (originales
  esperando, sin NOWAIT) · **R15-2c** (sin relectura) · **R15-2d/2e** (apply/reverse escriben también lo apartado) · **R15-2f** (el 409 deja
  de declarar la tarifa vigente); R12-4b/4c reanclados a la revalidación sobre lo bloqueado. La guardia estática fija el orden
  originales-NOWAIT → lote → relectura → rollback dentro del savepoint exterior, el `FOR NO KEY UPDATE NOWAIT` con su savepoint interior,
  la llamada a través del módulo hermano y que apply/reverse ya no llaman a `bloquearPayments` directamente.
- **R15-3 (P2) · la prueba del timeout del candado podía abandonar sus montajes antes del `finally`.** Sus dos transacciones «ajenas» se
  lanzaban y se esperaban (la segunda sin límite propio) ANTES del `try/finally`: un rechazo en la adquisición o en la primera espera dejaba
  el montaje sin examinar y podía terminar por el timeout de Jest. Cierre (aprobado): la prueba vive en el protocolo `actores` — cada
  montaje se registra al lanzarlo (`montaje('candado ajeno del intento', …)`), las esperas son acotadas (`pausadaEn`, `carrera` de 10 s para
  cada actor cuyo desenlace esperado es el 55P03), las barreras se sueltan en `finally` con `liberar`, `cerrar`/`afirmar` deciden, y la
  espera acortada del candado se restaura en un `finally` EXTERIOR que corre aunque `cerrar` lance. Inyecciones **R15-3a … R15-3d** en esa
  prueba (el montaje falla en Postgres ⇒ INCONCLUSO nombrándolo con el fallo original; la primera espera falla ⇒ la barrera se suelta y la
  prueba cae con esa causa; la liberación rota ⇒ INCONCLUSO con la liberación nombrada; un actor que nunca se asienta ⇒ `cerrar` decide
  INCONCLUSO dentro de su plazo, no el timeout de Jest, y el `finally` exterior deja la espera restaurada).

**Certificación de la Ronda 15 (runner `sab-r7.py`): 199/199 CERTIFICADOS sobre la huella FINAL `HEAD 03e7ac38 · wip 23ba2087a7dcb7da`** (tercera pasada completa, 09:02–10:49, `sab-r15-definitiva-3.txt`, resultados estructurados en `sab-r7-resultados.json`, copia en `sab-r15-definitiva-3-resultados.json`): **185 sabotajes + 14 inyecciones**, 32 controles en verde antes de sabotear, **913 declaraciones** (cada una resuelta a UNA prueba) + 39 caídas esperadas con su causa en las inyecciones — 16 sabotajes y 4 inyecciones nuevos de la ronda 15, y 15 sabotajes viejos ampliados con las pruebas nuevas. Antes, la **primera pasada completa** (sobre la huella
`decb9b4e8f2353de`) se abortó al añadir las carreras INVERSAS que Codex pedía (el árbol quedaba superado antes de terminar) y la **segunda
pasada completa** (07:1x–08:5x, huella `2470ae6213a7e237`, `sab-r15-definitiva-2.txt`, JSON en `sab-r15-definitiva-2-resultados.json`) dio
**179/199**; los 20 restantes se reconciliaron **sin aflojar una sola prueba**, cada uno con la caída leída en el JSON: (a) **quince sabotajes
viejos que ahora tumban también pruebas nuevas de la ronda 15** — R5-C (la obligación pendiente por orden no acreditado también se cerraría
sin converger), R5-D (las carreras INVERSAS y con ORDEN afirman el fee proyectado), R9-2a y R13-C2 (el sello posterior de E1 sobre el
Payment pisa o pierde el snapshot con incertidumbre), R10-1b y R10-2a (la captura fallida `EVIDENCIA_DE_INGRESO_SIN_ORDEN` se leería como
SIN_TARIFA/VALIDO o se anotaría como fallo operativo), R11-1a/1b y R12-14b (la carrera con ORDEN pausa dentro de la captura), R12-4b (sin
revalidación bajo los candados la carrera con un reembolso real no llega a su pausa), R12-1a/1c y R13-1a (el REST que espera al ingreso no
consume su captura), R12-1b (S4 registra «ahora»), R14-1b y R14-1c (sin candado en la venta rápida o en el ingreso no hay fallback, ni
recuperación, ni espera del REST) — todas caídas legítimas del defecto simulado, declaradas; (b) 🔑 **R5-H quedó sin discriminar en TRES
unitarias por el motivo equivocado**: detectaban «el candado del evento» como *cualquier* `FOR UPDATE` sobre `ProviderEventLog`, y el INGRESO
ahora hace uno (la recuperación de los ingresos sin candado, `/* ingresos sin candado */ … FOR UPDATE`) — el mutante que quita el candado del
escritor débil pasaba. Las tres pruebas se hicieron precisas (el candado del escritor débil se reconoce por SU marcador `/* evento */`; el
advisory que se compara es el que lo precede; y el fechado del ingreso `data: { createdAt }` no cuenta como escritura del escritor débil),
verificado aplicando el mutante a mano en la copia aislada: vuelven a caer las cuatro; (c) **una CARRERA con un reembolso REAL contaba
llamadas** (la revalidación era «la tercera») y R12-4a, al quitar la partición previa, movía el conteo — ahora identifica la revalidación por
el cliente de la TRANSACCIÓN (las particiones van con el cliente global), y la única declaración que queda es R12-4b (que quita la llamada
instrumentada); (d) **dos caídas TRANSITORIAS por carga, no del mutante**: bajo P3-V el long-poll «aviso perdido» contestó `timeout` porque el
vínculo + el REST tardaron más que su ventana de 2.5 s (load > 100) — la ventana pasa a 10 s y, si aun así el REST cerrara la fila con la
ventana vencida, la prueba termina INCONCLUSO nombrándolo (nunca un rojo falso); y bajo R15-2e el `convergido()` de la PRIMERA prueba de
`rateCorrection.protocolo` devolvió `PENDIENTE` una sola vez en ~200 corridas de esa suite (no se pudo reproducir; el helper afirma ahora el
motivo durable de la obligación junto al desenlace para que la próxima vez sea diagnosticable). Ningún cambio de `src/` posterior a la
segunda pasada salvo `candadosDelLote.ts` (un candidato ausente en las dos fotografías no cuenta como cambio; los inexistentes se reportan;
etiqueta del log) — hecho ANTES de lanzar la tercera pasada.

**Verificación pesada por avq-verify sobre el árbol FINAL (cadena `lanzar-avq-r15.sh`, después de la certificación, nunca a la vez):** lint 0
errores (66 avisos preexistentes) · typecheck del CI (`npm run typecheck`, incluye tests/ y scripts/) **0 errores, local y Alienware
COINCIDEN** (125 s / 126 s) · **suite unitaria en 4 shards: 4187 + 4707 + 3810 + 4553 = 17 257 pruebas, 0 fallos propios** — shards 1, 3 y 4
COINCIDEN sin fallos; el shard 2 cayó UNA prueba en los dos lados (COINCIDEN): `catalogImportCanonical.service.test.ts` («yields inside one
maximum-nesting staged line…»), la sonda de presupuesto del event loop del catálogo ya documentada en el workspace (código ajeno, archivo
idéntico a HEAD), y su repetición EXACTA `--runInBand` DUAL dio **4/4 COINCIDEN** ⇒ contención de carga, no código · **integración de pagos
completa: 21 suites, 644 pruebas, 0 fallos** (sólo en la Mac, con la base desechable; incluye las 16 pruebas nuevas de la ronda y la del
timeout reescrita) · API del checkpoint (terminal-payment, paymentProtocol, saleVerificationEdit): 20/20 COINCIDEN. Los avisos «otra sesión
movió el árbol» son WIP ajeno fuera de src/tests/prisma: la huella de src/tests/prisma al terminar la cadena es exactamente la certificada
(`23ba2087a7dcb7da`). Evidencia: `avq-r15-lint.txt`, `avq-r15-typecheck-ci.txt`, `avq-r15-shard-{1..4}.txt`, `avq-r15-int.txt`, `avq-r15-api.txt`,
`avq-r15-flaky-exactos.txt`.

**Decimosexta auditoría de Codex (gpt-6-astra xhigh; `gen-prompt-r16.py` ⇒ `prompt-codex-cp1-r16.txt`, `lanzar-codex-r16.sh`): la de
AUTORIZACIÓN sobre la siguiente huella** — los tres cierres de R15 (y los dos parciales R14-1 / R13-6) contra los 18 invariantes y la
cobertura por rama; veredicto en `codex-cp1-r16-veredicto.md`.

### 🔴 Ronda 16 — la cuarta auditoría de AUTORIZACIÓN de Codex (15-sep 11:0x–11:4x, gpt-6-astra xhigh, 4.07 M tokens, sesión `01a0a61b-aec3-75a0-a73f-4ff22e0b32f1`): RECHAZADO — R15-1 · R15-2 · R15-3 CERRADOS «implementados como se diseñaron» · 16 invariantes CUMPLIDOS · 1 PARCIAL (18) · 1 INCUMPLIDO (14) · 3 hallazgos nuevos (R16-1 P1 de código · R16-2 · R16-3 P2 de certificación) → TODO cerrado con TDD, sabotajes certificados e inyecciones; ningún mecanismo nuevo (R16-1 reusa el helper de R14-2) (15-sep, mediodía)

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r16-veredicto.md` (prompt `prompt-codex-cp1-r16.txt`). Confirmó huella, controles
y resultados (HEAD `03e7ac38`, `wip 23ba2087a7dcb7da`, 199/199, 913 declaraciones, 39 caídas esperadas), dio por CERRADOS R15-1, R15-2 y
R15-3 y por CERRADOS también los parciales R14-1 y R13-6, y no encontró faltantes bloqueantes nuevos en el receptor, el ingreso, S4, el
registrador, el lector de snapshot, la convergencia, la consolidación, el backfill ni la reapertura; su decisión: «El push y el checkpoint 2
deben esperar al cierre y certificación de R16-1, R16-2 y R16-3. No necesito una decisión del founder». Cada hallazgo se verificó contra
el código real antes de aceptarlo (regla del founder): los tres resultaron ciertos. Los dos límites del founder se conservan: el cobro nunca
se interrumpe y nunca hay doble cobro, venta perdida ni venta sin cobro.

- **R16-1 (P1) · el editor de verificaciones de venta clasificaba un REEMBOLSO sin proteger su ORIGINAL.**
  `editOrgSaleVerification` (`sale-verification.org.dashboard.service.ts`) tomaba sólo `existing.payment.id`; pero un REFUND pertenece al
  protocolo POR SU ORIGINAL (`cobrosDelProtocolo`, R14-2), y esa fila quedaba libre. Escenario reproducible con las APIs reales
  (`createSaleVerification` valida id y venue sin excluir un REFUND): original histórico P ($100, costo $3, sin snapshot ni obligación),
  reembolso histórico parcial R1 (−$40) con verificación; el OWNER edita esa verificación con `amount: 40`, el editor clasifica R1 «legacy»
  y se detiene antes del UPDATE; un segundo reembolso real R2 (−$30) toma P, asegura su obligación (`asegurarObligacionDeCostoNegativo`,
  ENCOLADA para un original con costo) y commitea sin necesitar R1; R1 ya pertenece al protocolo por P, y el editor seguía con su
  clasificación y cambiaba R1 de −$40 a **+$40** devolviendo éxito: movimientos reales $100 − $40 − $30 = $30 contra importes registrados
  $100 + $40 − $30 = $110 — **$80 sin movimiento bancario que los respalde**. Cierre (sin mecanismo nuevo, como pidió Codex): el editor toma
  el PAR con el helper de R14-2 `bloquearConSuOriginal(tx, { paymentId, venueId }, 'proteccion')` —original → reembolso, con relectura del
  puntero y reinicio por savepoint— ANTES de releer, clasificar y escribir, conserva los dos candados hasta commitear y mantiene el 409
  `PAYMENT_PROTECTED_BY_COST_PROTOCOL` y la atomicidad de Payment, verificación y bitácora (`{ existe: false }` ⇒ 404 «Venta no
  encontrada»). Un cobro que no es reembolso toma sólo su fila, como antes. Pruebas (`saleVerificationEdit.protocolo.integration.test.ts`,
  describe «Codex R16-1», la verificación del REFUND creada por el servicio real): **ORIGINAL PRIMERO** (R2 pausado tras asegurar la
  obligación de P, con P tomado y sin commit; el editor ESPERA el candado de P bloqueado por el pid de R2 —`/* proteccion */` en
  `pg_stat_activity`—, mientras espera R1 sigue LIBRE —sonda NOWAIT— y la obligación de P aún no es visible; al commitear R2 el editor relee,
  clasifica a R1 por su original y responde 409: la foto completa de R1 (importe −$40, método, costo, obligación, venta), la verificación y la
  bitácora quedan idénticas y P entró al protocolo por R2) y **EDITOR PRIMERO** (el editor pausado tras clasificar sostiene P Y R1 —las dos
  sondas NOWAIT dicen TOMADA—; R2 real ESPERA el `FOR UPDATE` de P bloqueado por el pid del editor; al reanudar, el editor escribe +$40 con
  la clasificación que hizo —cierta con P tomado— y sólo entonces R2 entra y mete a P al protocolo: serializado, nunca cruzado). Las
  ventanas de observación son cortas (2 s) a propósito: una espera ausente cae por ASERCIÓN, no por vencer el presupuesto de la transacción
  pausada. Vistas en ROJO primero con el defecto real (la promesa RESUELTA con `amount: 40`; `p: 'LIBRE'`, `r2Bloqueado: false`). El double
  de Prisma de la suite API stubea la foto del Payment y los savepoints del helper. Sabotaje **R16-1a** (el editor vuelve a bloquear SÓLO la
  fila del reembolso conservando la clasificación por el original ⇒ caen las dos); R13-3a y R13-3b declaran también las dos pruebas nuevas
  (sin consultar el protocolo o sin candado alguno tampoco se protege el par).
- **R16-2 (P2) · las sondas «el REST/el ingreso ESPERA el candado» aceptaban CUALQUIER PID.** `pidsEsperandoElCandadoDelIntento` era
  `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`: cualquier advisory sin conceder —de otra prueba, de otra llave, de
  otra base— la satisfacía, y las cuatro carreras de $3 frente a $8.50 (fast y con orden, en las dos direcciones) y la recuperación de S4
  podían certificarse por el motivo equivocado. Cierre: un **observatorio de candados** (`observatorioDeCandados`, en la suite de costo
  real) instrumenta `prisma.$transaction` con un Proxy que registra, desde la PROPIA conexión de cada actor, quién PIDE el candado de qué
  intento (`pg_backend_pid()` justo antes de `pg_advisory_xact_lock(NS_CANDADO_INTENTO, hashtext(llave))`) y a quién le fue CONCEDIDO (cuando
  la sentencia vuelve); la espera se ATRIBUYE (`esperaAtribuida(llave)`): el actor es un pid que pidió ESA llave y no la tiene, el poseedor el
  pid al que ESA llave le fue concedida, y en `pg_locks` (`datname = current_database()`, `classid = NS_CANDADO_INTENTO`, `objsubid = 2`,
  `objid = hashtext(llave)` como oid) el actor figura sin conceder con el poseedor en `pg_blocking_pids`; opcionalmente pausa un actor
  dentro de su transacción tras un marcador SQL (absorbe a `pausarElIngreso`). Las cuatro carreras y la recuperación de S4 afirman ahora
  `{ actor, poseedor }` con `actor ≠ poseedor`. **CONTRAPRUEBA** (describe «Codex R16-2»): un poseedor de A y otro de B; un waiter AJENO
  sobre B deja un advisory sin conceder —la sonda vieja lo cuenta (≥ 1)— y la atribuida a A responde NINGUNA tres veces seguidas; un actor
  que pide A por el camino real (`candadoDeIntento` en transacción propia) sí la satisface, con el pid que pidió A como actor y el que la
  tenía concedida como poseedor, y la pareja de B es otra, disjunta (cuatro pids distintos). Inyección **R16-2a** (la sonda vuelve a ser la
  vieja ⇒ la contraprueba cae con `ATRIBUIDA`, sin caídas colaterales). Las carreras fast/orden en ambos sentidos y la recuperación S4 se
  recertifican con los sabotajes que ya las declaraban (R14-1b/1c, R15-1f/1j, R15-1a…).
- **R16-3 (P2) · R15-3d no alcanzaba la aserción que decía certificar la restauración.** La inyección añadía
  `expect(process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS).toBeUndefined()` DESPUÉS del bloque cuyo `cerrar` lanza el INCONCLUSO: nunca se
  ejecutaba, y el JSON acreditaba el cierre acotado pero no la restauración. Cierre: la prueba del timeout instala y restaura la espera en
  una envoltura (`conEsperaAcotada(ms, fase)`) cuya comprobación corre DESPUÉS del desenrollado excepcional —también cuando `cerrar` lanza—,
  compara con el valor PREVIO guardado (no tiene por qué ser `undefined`) y, si no quedó restaurado, cae con `ENTORNO NO RESTAURADO — … quedó
  en X (antes: Y)` CONSERVANDO la causa original en el mensaje; si quedó restaurado, relanza la causa tal cual. R15-3d queda sin la aserción
  inalcanzable y con una regex ESTRICTA (`\A(?!.*ENTORNO NO RESTAURADO).*INCONCLUSO — actores sin asentar…`): si la restauración fallara, el
  INCONCLUSO esperado seguiría apareciendo y aun así NO certificaría. Inyecciones **R16-3a** (la restauración se OMITE con el actor colgado
  ⇒ cae nombrando el entorno no restaurado y la causa original) y **R16-3b** (la espera previa era `5000` y la «restauración» la borra en vez
  de reponerla ⇒ cae comparando con el valor previo, sin causa original porque las fases pasaron).
- **Dos arreglos que salieron de la certificación (no de Codex), cada uno con la caída leída en el JSON:** (a) **el worker de AngelPay
  (S4) devuelve el lote reclamado en orden DETERMINISTA** — `claimPendingAngelPayEvents` elegía el lote con `ORDER BY "nextAttemptAt",
  "createdAt", id … FOR UPDATE SKIP LOCKED` pero lo devolvía por el `RETURNING` de un `UPDATE … FROM`, que NO conserva ese orden (depende
  del plan: con dos filas salió invertido bajo R12-11d en la pasada 2, y la prueba «orden estable (lo más antiguo primero) y lote acotado»
  afirmaba un orden que el código no garantizaba); ahora una CTE `reclamados` recoge el `RETURNING` y la selección final vuelve a ordenar
  (`SELECT * FROM reclamados ORDER BY …`): el worker procesa lo más antiguo primero por construcción; (b) **el fixture de integración purga
  los fixtures HUÉRFANOS** (`purgarFixturesHuerfanos`, mismo prefijo, > 20 min) al crearse — una corrida matada a medias deja el
  `afterAll(destruir)` sin correr y sus obligaciones PENDING quedan en la base desechable, donde `claimPaymentEffects` (que no filtra por
  venue) las reclama desde OTRA suite: en la pasada 1, bajo R9-1a, la prueba R12-15 de costo real lanzó «Venue s0-… has no payment
  configuration» por un `s0-…` del registrador de una pasada abortada el 15-sep de madrugada (9 huérfanos acumulados desde el 13-sep en la
  base de certificación, 8 en la de desarrollo; purgados). El umbral de 20 min protege a un fixture vivo de otra suite con el mismo prefijo
  bajo avq-verify (dos suites usan `s2`); (c) **la prueba N1 del webhook drena el backfill del webhook que CREA el Payment** — el
  registrador lanza un backfill fire-and-forget también cuando el Payment nace del webhook (vuelve a sellar su propio evento por el parche
  atómico), y N1 leía el Payment inmediatamente: bajo el mutante R13-C4 (el sello REEMPLAZA en vez de parchar) N1 caía sólo cuando el
  backfill ganaba la carrera (4 de 5 pasadas; en la pasada 4 pasó ⇒ «DECLARADA NO CAYÓ»). `registroConBackfillDrenado` se generalizó a
  `conBackfillDrenado(accion)` (REST o webhook; el montaje se llama «backfill del registrador») y N1 lee después de drenarlo: el
  detector es determinista en las dos direcciones (3/3 caídas con el mutante en la copia aislada). N1 es el séptimo consumidor de las
  inyecciones R14-5a…5d (reancladas a `resultado = await accion()`).

**Certificación de la Ronda 16 (runner `sab-r7.py`): 203/203 CERTIFICADOS sobre la huella FINAL `HEAD 03e7ac38 · wip 477a25c9b6e395b7`**
(quinta pasada completa, 18:2x–19:56, `sab-r16-definitiva-5.txt`, resultados estructurados en `sab-r7-resultados.json`, copia en
`sab-r16-definitiva-5-resultados.json`): **186 sabotajes + 17 inyecciones**, 32 controles en verde antes de sabotear, **919 declaraciones**
(cada una resuelta a UNA prueba) + 46 caídas esperadas con su causa en las inyecciones — 1 sabotaje (R16-1a) y 3 inyecciones (R16-2a ·
R16-3a · R16-3b) nuevos, R13-3a/3b ampliados con las dos pruebas del reembolso, R15-3d con la regex estricta, R14-5a…5d con N1. Antes, una **pasada
ACOTADA** (`SAB_ONLY`, `sab-r16-acotada.txt`: R13-3a/3b · R16-1a · R14-1b/1c · R15-1f/1j · R15-3d · R16-2a · R16-3a/3b ⇒ 11/11, los
controles limitados a las 5 suites que tocaba) y dos pasadas completas que cayeron UNA cosa cada una, ninguna de la ronda: la **pasada 1**
(huella `c74e94c94e795376`, `sab-r16-definitiva-1.txt`, JSON en `-1-resultados.json`) dio **202/203** con R9-1a INCONCLUSO por el fixture
huérfano `s0-…` de una pasada abortada (arreglo (b) de arriba); la **pasada 2** (huella `e2274620506a63ac`, `sab-r16-definitiva-2.txt`, JSON
en `-2-resultados.json`) dio **202/203** con R12-11d «CAÍDA NO DECLARADA: orden estable (lo más antiguo primero) y lote acotado» por el orden
no garantizado del `RETURNING` (arreglo (a) de arriba); la **pasada 3** (huella `84b9fc93ade73273`, `sab-r16-definitiva-3.txt`, JSON en
`-3-resultados.json`) dio **203/203**, pero la cadena avq posterior destapó un double unitario del editor (`sale-verification.org.edit-
feedback.test.ts`, fuera de las 32 suites del runner) sin los stubs del candado nuevo — corregido, con lo que la huella cambió—; la **pasada
4** (huella `fe7cfbfff1d2fb1a`, `sab-r16-definitiva-4.txt`, JSON en `-4-resultados.json`) dio **202/203** con R13-C4 «DECLARADA NO CAYÓ:
N1 · un webhook REPETIDO…» por la carrera del backfill (arreglo (c) de arriba). Ninguna prueba se aflojó: los cierres fueron en el fixture,
en el worker, en el double y en el drenado de N1, y la pasada final corrió sobre el árbol con todos.

**Verificación pesada por avq-verify sobre la versión CERTIFICADA (cadena `lanzar-avq-r16.sh` + `lanzar-avq-r16-resto.sh`, después de la
certificación, nunca a la vez):** lint 0 errores (66 avisos preexistentes) · typecheck del CI (incluye tests/ y scripts/) **0 errores, local
y Alienware COINCIDEN** · **suite unitaria en 4 shards: 4187 + 4707 + 3810 + 4553 = 17 258 pruebas, 0 fallos propios** — shards 1, 3 y 4
COINCIDEN; el shard 2 cayó UNA prueba SÓLO en el Alienware: la sonda de presupuesto del event loop del catálogo
(`catalogImportDurableEventLoop.service.test.ts`, código ajeno idéntico a HEAD), `expect(Math.max(...samples)).toBeLessThan(50)` con
**123.7 ms** medidos (en la cadena anterior, sobre el mismo contenido: 67.1 ms en el shard 2 y 98.3 ms en `catalogWorkbook.eventloop-
budget.test.ts` en el shard 3, donde el Alienware además murió por heap) corriendo shards de ~4 700 pruebas con 2 workers; la repetición
EXACTA en serie DUAL de los dos archivos pasó en las dos máquinas (1/1 y 4/4, COINCIDEN) ⇒ intermitentes de ENTORNO por contención de CPU,
con esa evidencia, no defectos del código bajo prueba · **integración de pagos completa: 21 suites, 647 pruebas, 0 fallos** (sólo en la
Mac, base desechable; incluye las 3 pruebas nuevas de la ronda) · API del checkpoint: 20/20 COINCIDEN. Lint, typecheck y shards 1-3
corrieron sobre el árbol principal mientras contenía la versión certificada (huella avq `c075929b1296e1e6`); shard 4, integración, API y
repeticiones sobre el worktree `cp1-certificada` (commit `2d31922d`, `AVQ_TREE`) después de que el founder dejara limpio el árbol
principal al commitear el WIP en `huge_tpv_related_changes`. Entorno acreditado: dependencias idénticas a HEAD y cliente de Prisma
compartido semánticamente idéntico al schema certificado, comprobado antes y después. Evidencia: `avq-r16-*.txt`, `cadena1-avq-r16-*.txt`,
`avq-r16-texto.txt`, carpetas `run-avoqado-server.{CFdGIT,4gK7gU,HrBqZn,WgXUTM,lVDAp4,rhyXgJ}`.

### 🟢 Ronda 17 — la quinta auditoría de AUTORIZACIÓN de Codex (15-sep 20:34–21:0x, gpt-6-astra xhigh, 3.13 M tokens, acotada por instrucción del founder): **AUTORIZADO** para pushear `2d31922d` a `develop` y arrancar el checkpoint 2 — R16-1 · R16-2 · R16-3 CERRADOS «implementados como se exigieron» · **los 18 invariantes CUMPLIDOS** · los tres arreglos de la certificación CORRECTOS · el delta ajeno (20 archivos) es SÓLO FORMATO y seguro de integrar · ningún hallazgo nuevo bloqueante

Veredicto íntegro: `~/.claude/jobs/b1e1a1b3/tmp/codex-cp1-r17-veredicto.md` (prompt `prompt-codex-cp1-r17.txt`, lanzado sobre el worktree
`cp1-certificada` = commit `2d31922d`). Codex reconstruyó la huella `477a25c9b6e395b7` desde el commit, comparó código, pruebas y schema con
`sab-server` (sólo un `.DS_Store` de diferencia), contrastó los 32 controles y **282 JSON** de ejecución (919 caídas por aserción y 46 causas
de inyección, sin discrepancias), el snapshot conservado del shard 2 de avq y el cliente de Prisma compartido (schema equivalente ignorando
espacios). Cierres: R16-1 (el editor llama a `bloquearConSuOriginal` antes de releer, clasificar y escribir; R16-1a 2/2 por aserción;
R13-3a 11/11 y R13-3b 3/3 recertificados; «implementado exactamente con el mecanismo exigido»), R16-2 (observatorio: pid desde la conexión
transaccional que pide el advisory, `pg_locks` por base/namespace/`objsubid`/hash unsigned, poseedor entre `pg_blocking_pids(actor)`; la
contraprueba observa tres NINGUNA con el waiter de B y cuatro pids distintos; R16-2a cae sólo en ella), R16-3 (envoltura que compara con el
valor previo DESPUÉS del desenrollado conservando la causa; R15-3d sólo el INCONCLUSO; R16-3a/3b caen por la restauración). Los tres arreglos
de la certificación: orden del worker CORRECTO (no altera importes, identidad ni exclusividad), purga de huérfanos CORRECTA para el entorno
certificado (valida la base desechable antes; no va a producción; el umbral de 20 min es operativo, no una prueba universal de abandono) y
N1 drenado CORRECTO (R13-C4 8/8, R14-5a…5d 7/7). Delta ajeno: los 7 archivos de `src/` y las 13 pruebas «conservan una estructura sintáctica
equivalente a `03e7ac38`» (formato de prettier, sin cambio funcional); `snap-page.yml` es una captura textual sin código ni credenciales.
Precisión de conteo de Codex sobre avq: 17 258 unitarias aprobadas en la Mac; en el Alienware 17 257 y la caída del catálogo (123.7 ms
contra 50 ms), separada por la repetición exacta. Riesgos que NO bloquean (sección 6): CP2 en aparato (ACK perdido, reinicio, desconexión,
reanuncio, recuperación, sin captura bancaria automática ante incertidumbre); `ingresoSinCandado` conserva la incertidumbre tras ordenar;
**scripts históricos de backfill** (`backfill-refund-transaction-costs.ts:92`, `backfill-refund-shift-totals.ts:125`) escriben reembolsos
sin el par original → reembolso — fuera del cierre y NO habilitados sobre pagos del protocolo sin revisión específica; residuo 40P01 de
la corrección por lotes; la purga de huérfanos no debe reutilizarse como limpieza general; una aserción final redundante a `undefined`
en la prueba del timeout (limpieza opcional, fuera del cierre); despliegue backend primero con migraciones e índices validados sobre datos
reales y presupuesto de conexiones/esperas de los workers. Cierre textual: «Los tres bloqueos de R16 quedan cerrados y certificados sobre
`2d31922d`. Puedes pushear ese commit a `develop` y comenzar el checkpoint 2. No necesito una decisión ni cambios adicionales del founder».

**Integración en `develop` (15-sep, noche):** el contenido certificado y auditado (`2d31922d` sin `snap-page.yml`) entra en DOS commits por
rutas sobre `03e7ac38`: el checkpoint (129 rutas, este mensaje) y el WIP ajeno arrastrado (20 rutas, mensaje propio que cita la revisión
acotada de R17). Demostración previa al push (`integrar-cp1.sh`): `git diff 2d31922d develop -- src tests prisma` vacío.

### Diseño de S0 + S3 (13-sep, antes de codificar; revisión de Codex en curso)

**Dónde se decide el ganador.** Dentro de la transacción de los DOS registradores actuales (`recordOrderPayment` y `recordFastPayment`),
cuando el payload trae `terminalPaymentRequestId`: (1) se toma `SELECT … FOR UPDATE` sobre la fila `TerminalPaymentRequest` (orden de
candados: Order → TerminalPaymentRequest → Payment → Shift; la venta rápida no tiene Order y empieza en la solicitud), **antes** de
`claimShiftForCompletedPayment` y de crear cualquier Payment; (2) el ganador existente es `row.paymentId` (filas históricas, ligadas sólo
por `processorData`) o el Payment `COMPLETED` no-REFUND con `Payment.terminalPaymentRequestId = requestId` (el índice único parcial de S9
garantiza que hay a lo sumo uno); (3) si NO hay ganador ⇒ este intento es el ganador: se crea como hoy, y el vínculo fila↔Payment lo
escribe `closeRowFromPaymentTx` en la MISMA transacción, que pasa a devolver el desenlace
(`{ bound: true, reopened, contractMismatch } | { bound: false, reason }`) en vez de `void`, escribe la columna `terminalPaymentRequestId`
junto con `paymentId` (nunca por separado), y deja de salir en falso cuando la fila ya está `COMPLETED` **sin** `paymentId` (cerrada por
socket antes del registro: hoy ese caso nunca ligaba); (4) si SÍ hay ganador y su `idempotencyKey` es la de este intento ⇒ reintento del
propio ganador (lo resuelve la red de P2002 de siempre); (5) si hay ganador y es OTRO intento ⇒ **POSIBLE SEGUNDA CAPTURA**: el Payment se
crea con `status: PENDING` (nunca COMPLETED: fuera de ventas, turno, liquidación y lealtad), con `terminalPaymentRequestId` y
`processorData.reconciliation = { kind: 'POSSIBLE_SECOND_CAPTURE', requestId, winnerPaymentId, detectedAt, via }`, SIN reclamar turno, SIN
`VenueTransaction`, SIN tocar los totales de la orden, SIN efectos; 🚨 en el log y `ActivityLog TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE`
(rastro durable que el dueño puede leer: aquí el `ActivityLog` SÍ va, a diferencia de S1, porque es una anomalía de dinero y no tráfico). La
respuesta a la terminal es 2xx con ese Payment: el dinero queda REGISTRADO como evidencia, que es lo que impide que desaparezca. Webhook
(S2) y worker (S4) entran por estos mismos registradores, así que pasan por la misma decisión.

**Identidad suficiente para deduplicar (S0-a).** La deduplicación por `referenceNumber` sin llave (orden `:2056`, venta rápida `:3569`)
exige además: mismo `orderId` cuando el existente lo tiene y difiere del objetivo ⇒ NO es el mismo cobro; mismo importe y misma propina; y
misma afiliación cuando ambos la traen. Las referencias de Blumon y AngelPay son `yyMMddHHmmss` y colisionan entre terminales en el mismo
segundo: un reintento legítimo (misma referencia, mismo importe, misma orden) se sigue deduplicando; una colisión deja de robarle su Payment
a otra venta. Lo que el matcher del webhook «encuentra» por referencia sola no decide un éxito: S2 resuelve por vínculo.

**S3 · enriquecer sin duplicar.** En los retornos idempotentes (llave o referencia) el registro posterior de la terminal RELLENA lo vacío o
provisional del Payment existente en UNA escritura condicional (`updateMany` con la condición «sigue vacío» en el `where`): `maskedPan`,
`cardBrand`, `entryMode`, `authorizationNumber`, `referenceNumber`,
`processorData.{cardBrand,last4,typeOfCard,bank,blumonOperationNumber,deviceSerialNumber}`; nunca `amount`/`tipAmount`. Una contradicción
(importe, propina, afiliación o `orderId` distintos del existente) NO se fusiona: se deja el Payment intacto, 🚨 y
`ActivityLog TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION` con los dos valores. **Costo de transacción:** `createTransactionCost` calcula con
método, marca e internacionalidad y no recalcula al rellenar la marca; política: cuando el Payment nació sin marca acreditada (webhook), el
costo NO se crea (queda pendiente) y se crea al acreditar la marca en el enriquecimiento, una sola vez (idempotente por `paymentId`), sin
alterar base ni propina ni repetir ingreso.

**Pruebas (rojo primero):** las 4 adversariales de S-LEGACY pasan a verde; fila COMPLETED sin `paymentId` ⇒ el primer registro liga y el
segundo es segunda captura; la segunda captura no reclama turno, no crea `VenueTransaction`, no altera `paidAmount`, deja bitácora;
`closeRowFromPaymentTx` devuelve `bound`/motivo y escribe la columna junto con `paymentId`; misma referencia con distinto importe ⇒ dos
Payments (no se roba la venta); misma referencia, mismo importe y misma orden sin llave ⇒ uno; enriquecimiento rellena sólo lo vacío y una
contradicción no toca dinero; sabotajes en copia aislada.
