# Revisión de código — avoqado-tpv (trabajo NO commiteado)
**11-sep-2026 · sólo lectura · sin gradle, sin git mutante**

---

## 🔴 Lee esto primero: el árbol se movió DURANTE la revisión

El árbol de trabajo está compartido y **otra sesión estuvo cableando C.5 / H.3 mientras yo revisaba**. Medido, no supuesto:

| Hora | Qué pasó |
|---|---|
| 15:36:17 | `RemotePaymentRequestDao.kt` se reescribió (66 → 194 líneas) **entre dos lecturas mías** |
| 15:36:44 | congelé un snapshot de `app/src` para tener números de línea estables |
| 15:39–15:51 | aparecen `CobroRemotoDelPos.kt`, `MigracionV34RoomTest.kt`, `CancelTrasReclamarRoomTest.kt`, `app/schemas/34.json`; cambian el Inbox, el Coordinator, la Libreta, `SocketManager`, los dos `PaymentViewModel` y el de AngelPay |
| 15:52–15:58 | re-verifiqué en el árbol VIVO cada hallazgo de dinero |

**Consecuencia:** dos hallazgos P1 que eran reales a las 15:36 **ya estaban cerrados a las 15:58**. Los conservo abajo marcados `[CERRADO]` porque hay que comprobar que el cierre quedó completo y con prueba. Todo lo demás lo reconfirmé contra el árbol vivo (`[VIVO 15:58]`).

🔴 **Y el hecho operativo que más importa: a las 15:36 el árbol NO COMPILABA** — `PaymentAttemptLedger.kt:57` llamaba `dao.reserveTerminal(...)` con 10 de los 11 parámetros (el 11º, `terminalPaymentRequestId`, no tiene default), y los 6 `coEvery/coVerify` de `PaymentAttemptLedgerTest.kt` tenían 10 `any()`. Ya está corregido, pero **este árbol pasa por estados que no compilan**: nada de esto se commitea sin `assembleSandboxDebug` + `testSandboxDebugUnitTest` en verde por `avq-verify`.

---

## Resumen — los 7 P1 abiertos, en orden de lo que cuesta

| # | Qué | Dónde | Por qué duele |
|---|---|---|---|
| 1 | **El verificador de cobro incierto de AngelPay no puede confirmar NADA cuando el ViewModel se recreó** (la afiliación vive sólo en RAM y la condición la exige no-nula) | `AngelPayChargeVerifier.kt:97` + `AngelPayPaymentViewModel.kt:584,799,2523` | la tarjeta se cobró, el historial lo confirma, y la app no lo puede leer ⇒ **dinero cobrado sin registrar**. El dato durable ya está en la libreta (`processorAffiliation`) y nadie lo lee |
| 2 | **La lápida `NOT_FOUND_ANSWERED` puede matar una entrega legítima** si la sonda gana la carrera al `receive` | `RemotePaymentInbox.kt:166-174` | el cobro muere y la terminal queda reservada **sin palanca**, para siempre |
| 3 | **Un cancel del cajero (U100) en Nexgo ⇒ INCIERTO ⇒ `timeout` ⇒ terminal reservada** y la fila `INDETERMINADO` bloquea los cobros siguientes | `AngelPayOutcomeClassifier.kt:95-101` | un gesto diario deja la terminal inservible |
| 4 | **Sin turno abierto, un cobro remoto se RECLAMA y no se contesta nada** (`canRetry` por default = true) | `PaymentViewModel.kt:3291-3298` + `PaymentState.kt:455` | el defecto que la regla canónica manda arreglar; el servidor nuevo ya no libera por reloj |
| 5 | **La barrera dura de la libreta rechaza el cobro remoto EN SILENCIO** cuando la terminal está reservada por otra fila (rama `LIBRE`) | `AngelPayPaymentViewModel.kt:1747-1755` | reintroduce el callejón de Testarudo dentro del cambio hecho para cerrarlo |
| 6 | **La recuperación de aprobaciones puede registrar un REEMBOLSO de AngelPay como VENTA**; lo único que lo impide es un campo ausente | `PaymentAttemptDao.kt:17-21` + `LedgerApprovalRecovery.kt:62-72` | la regla ya dice «no desplegar sin separar los tipos»; arreglo de 2 líneas |
| 7 | **`FACTORY_RESET` borra libreta, bandeja y colas de dinero sin comprobar nada** | `CommandExecutor.kt:1055-1077` | preexistente, pero es el motivo por el que el plan D no puede creerle a un `NOT_FOUND` |

**Cerrados durante la revisión por la sesión en vuelo (verificar que quedaron con prueba):** `cancelled + PROCESSOR_DECLINED` (doble cierre, **sin test que lo guarde**) · el cableado C.5/H.3 completo · el rechazo del banco con «Reintentar» vivo (H.3 aplicada) · el reloj de abandono que dejaba «Reintentar».

🔴 **Antes de commitear:** el árbol pasó por un estado que no compilaba; corre `assembleSandboxDebug` + `testSandboxDebugUnitTest` por `avq-verify`, y **revierte el CRLF→LF de los 4 archivos reescritos** (P2-1) o sepáralos en su propio commit.


---

## Inventario

### A. Circuito de cobro remoto POS → servidor → TPV (el trabajo principal)

| Archivo | Qué cambió |
|---|---|
| `core/remotepayment/RemotePaymentInbox.kt` | Bandeja durable. Nuevo: sonda `probe()` con **lápida `NOT_FOUND_ANSWERED`**; `cancel()` con disposición ACTIVE/ACCEPTED/ALREADY_RESOLVED que ahora **también cancela una solicitud YA reclamada** vía `cancelarTrasReclamar`; `persistResult()` que enruta todo desenlace negativo por la libreta; `rejectUnclaimed()` |
| `core/remotepayment/RemotePaymentRequestDao.kt` | `resolveReceived`/`markResolved` escriben `final_emitted_at`; `contarIntentosBloqueadores`, `ultimoIntentoDeSolicitud`, `descartarPreparandoDeSolicitud`; y las dos transacciones que deciden el dinero: **`cancelarTrasReclamar`** y **`resolverDesenlaceNegativo`** |
| `core/remotepayment/RemotePaymentRequestEntity.kt` | +3 columnas (`cancel_accepted_at`, `execution_started_at`, `final_emitted_at`) + `tombstone()` |
| `core/remotepayment/RemotePaymentCoordinator.kt` | `prepareSocketPaymentRequest` (awaitReady → claim por venue → revalidar venue), `probeSocketPaymentRequest`, `reclamadasEnEsteProceso` (prueba de propiedad para el cancel). **Se retiró `paymentCancelRequests`** |
| `core/remotepayment/RemotePaymentPreAuthorizationFailure.kt` 🆕 | 12 líneas: el único helper que emite `failed + PRE_AUTHORIZATION` antes de tocar el SDK |
| `core/data/realtime/SocketManager.kt` | Handshake declara `terminalPaymentCancelDispositionVersion` y `terminalPaymentProbeVersion`; handler `terminal:payment_probe`; el cancel se resuelve en Room y contesta `terminal:payment_cancel_disposition`; `emitTerminalPaymentResult` acepta `outcomeEvidence` y persiste ANTES de emitir |
| `core/presentation/navigation/AppNavigation.kt` | `congelarArgumentosDeCobro` (D.7); admisión por `prepareSocketPaymentRequest`; los tres rechazos ahora con evidencia; banner de obligaciones pendientes; **se borró el colector `paymentCancelRequests`** |
| `core/presentation/viewmodels/HomeViewModel.kt` | `TerminalPaymentCancel -> Unit`; serial real a Crashlytics; disparadores T26 |
| `{production,sandbox}/…/PaymentViewModel.kt` | D.7 (`vinculoDeSolicitudFijado`), `authorizationUnresolved`/`negativeOutcomeEvidence`/`financialOperationStarted`, `emitirDesenlaceNegativo` único, cierre por abandono, la CERCA consultada antes de efectivo/cripto, `openAttempt` tras la validación de turno, write-ahead del kernel en el reembolso contactless, observador de fases |
| `features/payment/data/ledger/*` | `KERNEL_ACTIVO`, `legacy_shadow`, `reserveTerminal` con la CERCA del cobro remoto, `cercaDeSolicitud`, `iniciarEjecucionNoTarjeta`, `LedgerApprovalRecovery` y `LedgerUnknownRecovery` nuevos, el barrido los corre aunque SHADOW esté OFF |
| `core/data/local/AvoqadoDatabase.kt` + `core/di/DatabaseModule.kt` | Room **v33 → v34**, `MIGRATION_33_34` aditiva e idempotente |
| `features/remote_command/domain/CommandExecutor.kt` | `FETCH_ANGELPAY_MERCHANTS` con candado de dueño de sesión (T26). **FACTORY_RESET no se tocó** |

### B. Otras features, de otras sesiones, en el mismo diff

| Archivo | Qué es |
|---|---|
| `features/payment/domain/PaymentPhaseTracker.kt` 🆕 (287 l.) + `PaymentScreen.kt` + `CrashlyticsContext` | **Observador de fases** (Testarudo 8-sep): el reloj sale de la pantalla al VM, monotónico, por fase y por intento |
| `features/payment/presentation/ContactlessKernelResult.kt` | Catálogo de códigos del kernel EMV de PAX + `KERNEL_REFUSALS_WITHOUT_CHARGE` |
| `processor/angelpay/*` · `presentation/angelpay/*` · `TerminalConfigRepositoryImpl.kt` · `MerchantSelectionContent.kt` · `AvoqadoTPVApplication.kt` | **T26** (Nexgo: la auth se recupera sola, serial real del aparato, `TerminalConfigUnreachableException`) |
| `features/payment/domain/processor/PostOperationsAdapter.kt` | `integratorReference` para reconocer un cobro propio en el historial de AngelPay |

---

## Hallazgos

### P1 — dinero · pérdida de datos · bloqueo sin salida

#### P1-1 · La lápida `NOT_FOUND_ANSWERED` puede matar una entrega LEGÍTIMA y dejar la terminal reservada para siempre `[VIVO 15:58]`

```kotlin
// app/src/main/java/com/jaac/avoqado_tpv/core/remotepayment/RemotePaymentInbox.kt:154-174
suspend fun probe(requestId: String, venueId: String): RemotePaymentProbeAnswer {
    require(venueId.isNotBlank()) { "La sonda no puede dejar lápida sin venue" }
    val existing = dao.getById(requestId) ?: return answerAbsent(requestId, venueId)
    return answerFor(existing)
}
...
private suspend fun answerAbsent(requestId: String, venueId: String): RemotePaymentProbeAnswer {
    if (dao.insert(RemotePaymentRequestEntity.tombstone(requestId, venueId)) != -1L) {
        Timber.w("🪦 [RemotePaymentInbox] NOT_FOUND con lápida: $requestId no se ejecutará aunque llegue después")
        return RemotePaymentProbeAnswer(RemotePaymentProbeDisposition.NOT_FOUND)
    }
```

**Escenario, todo dentro de la TPV:** el servidor emite la solicitud (ya grabó `deliveryProvenance` antes del emit, plan D) y el barrido sondea esa MISMA fila. Si la sonda gana la carrera —su `getById` ve `null` y su `insert` de lápida entra antes que el `insert` de `receive`—:

1. la lápida queda escrita y se contesta `NOT_FOUND`;
2. la entrega real llega, `receive()` encuentra `NOT_FOUND_ANSWERED` y **rechaza** ⇒ `ack(accepted:false)`;
3. el servidor **no libera** —la procedencia NO está vacía— y audita `NOT_FOUND_AFTER_DELIVERY`; el ACK negativo lo lleva a `UNKNOWN/ACK_REJECTED`;
4. la lápida es **irreversible**: `answerFor` contesta `NOT_FOUND` cada vez (`:192`), `markResolved` la excluye por lista positiva (`RemotePaymentRequestDao.kt:74`, `status IN ('RECEIVED','PROCESSING')`), **nada borra filas de `remote_payment_requests`** (cero `DELETE`/prune en todo `main`, verificado), y `releaseUnknownRequest` del servidor no libera.

El cobro del cajero muere y la terminal queda reservada hasta conciliación manual — el P2-2 que la regla canónica ya declara sin palanca. **La mitad del remedio es del servidor** (no sondear una fila entregada hace segundos), pero la TPV escribe la lápida **sin ninguna condición de vigencia ni de «esta solicitud está en vuelo en mi canal»**, y `RemotePaymentCoordinator` ya tiene ese dato a mano (`queuedRequestIds`, `reclamadasEnEsteProceso`).

**Por qué ninguna prueba lo caza:** `RemotePaymentInboxRoomTest.kt` ejercita sonda y entrega **en secuencia**, nunca concurrentes sobre el mismo `requestId`. El único test de carrera del fichero (`:194-208`) es claim-vs-cancel, no probe-vs-receive.

#### P1-2 · Sin turno abierto, un cobro remoto se RECLAMA y se descarta sin contestar `[VIVO 15:58]`

```kotlin
// app/src/sandbox/.../PaymentViewModel.kt:3291-3298  (production: mismo bloque)
_isPaymentInProgress.value = false  // 🚦 Release guard
_state.value = PaymentState.Error(
    message = "No hay turno abierto.\n\n" +
             "Abre un turno para procesar pagos.",
    context = null,
    showOpenShiftButton = true  // ⭐ Show "Abrir Turno" button in dialog
)
return@launch
```

`PaymentState.Error.canRetry` vale **`true`** por default (`app/src/main/.../PaymentState.kt:455`), así que el observador del socket entra por la rama «retryable» y **no contesta nada al servidor**. Y la fila ya está en **PROCESSING**, porque `AppNavigation.kt:374-378` reclama con `prepareSocketPaymentRequest` antes de cualquier otra comprobación. Solicitud reclamada + sin desenlace + sin respuesta ⇒ UNKNOWN ⇒ terminal reservada.

Es el defecto que la regla canónica manda arreglar con todas sus letras —*«Debe contestar `failed + PRE_AUTHORIZATION` («abre la caja primero») antes de tocar el SDK»*— y **sigue abierto**. El árbol lo empeora respecto al APK publicado, porque el servidor nuevo ya no libera por reloj. La mitigación que apareció a las 15:52 (`programarCierreDelCobroRemoto`, `:4767-4782`) tapa el síntoma con un temporizador y emite `cancelled` con la evidencia que haya en la pantalla; no es la respuesta inmediata y acreditada que pide la regla. Arreglo correcto: pasar `canRetry = false` ahí y dejar que `emitirDesenlaceNegativo` lo cierre con `PRE_AUTHORIZATION` (es legítimo: nada tocó el SDK — `openAttempt` corre DESPUÉS de esta guarda).

#### P1-3 · La recuperación de aprobaciones puede registrar un REEMBOLSO de AngelPay como VENTA; lo único que hoy lo impide es un campo ausente `[VIVO 15:58]`

La consulta de candidatas **no filtra `kind`**:

```kotlin
// app/src/main/.../PaymentAttemptDao.kt:17-21
@Query("""SELECT * FROM payment_attempts WHERE venue_id = :venueId
    AND state IN ('HOST_RESPONDIO','AUTORIZADO','REGISTRO_FALLIDO')
    AND (host_approved = 1 OR state = 'AUTORIZADO') AND created_at < :olderThan AND verify_attempts < 5
    AND (lease_until IS NULL OR lease_until < :now) ORDER BY created_at ASC LIMIT 50""")
suspend fun getApprovalRecoveryCandidates(venueId: String, olderThan: Long, now: Long): List<PaymentAttemptEntity>
```

y el reconstructor decide por **procesador antes que por ruta**, así que un reembolso de AngelPay (`processor=ANGELPAY`, `recordingRoute=REFUND`) cae en la primera rama y acaba en el grabador de VENTAS:

```kotlin
// app/src/main/.../LedgerApprovalRecovery.kt:62-72
val context: PaymentContext = when {
    row.processor == PaymentAttemptEntity.PROCESSOR_ANGELPAY ->
        gson.fromJson(row.paymentContextJson, PaymentContext.AngelPayPayment::class.java)
            .copy(authorizationCode = row.authCode.orEmpty(), referenceNumber = row.referenceNumber.orEmpty())
    row.recordingRoute == PaymentAttemptEntity.ROUTE_ORDER -> …
    row.recordingRoute == PaymentAttemptEntity.ROUTE_FAST -> …
    else -> return null
}
```
```kotlin
// app/src/main/.../LedgerApprovalRecovery.kt:41-43
if (row.recordingRoute == PaymentAttemptEntity.ROUTE_ORDER)
    order.recordPayment(context, card, row.authCode.orEmpty(), row.referenceNumber.orEmpty())
else fast.recordPayment(context, card, row.authCode.orEmpty(), row.referenceNumber.orEmpty())
```

Hoy no explota por accidente: el contexto que guarda el reembolso de AngelPay es un stub de tres campos —`RecordAngelPayRefundUseCase.kt:144`, `{"originalPaymentId":…,"reference":…,"processor":"angelpay"}`— así que `context.venueId != row.venueId` es **el primer operando** de la guarda (`LedgerApprovalRecovery.kt:76`) y corta antes de que nada lance. **La protección es incidental y depende del orden de los operandos de un `||`.** El día que alguien enriquezca ese JSON —que es lo obvio siguiente— un reembolso aprobado se registra como venta y el negocio cobra dos veces. El reembolso de **Blumon** sí está a salvo por construcción (`route=REFUND` cae en el `else -> return null`).

La regla canónica ya lo declara: *«No desplegar esa recuperación sin separar los tipos de operación y verificar que un REFUND nunca se registra como SALE»* — **sigue sin separarse**. Arreglo de dos líneas: `AND kind = 'SALE'` en la consulta y `row.recordingRoute != ROUTE_REFUND` en el `when`.
**Ninguna prueba lo caza:** `LedgerApprovalRecoveryTest.kt` no siembra ni una fila `kind = REFUND`.

#### P1-4 · `FACTORY_RESET` borra la libreta, la bandeja y las colas de dinero sin comprobar nada `[VIVO 15:58]`

```kotlin
// app/src/main/.../CommandExecutor.kt:1055-1077
ackSelfDestructiveCommand(command, CommandResult.success("Factory reset completed"))
try {
    secureStorage.clearAll()
    …
    context.databaseList().forEach { dbName ->
        try {
            context.deleteDatabase(dbName)
```

El ACK va **antes** del borrado, que es lo correcto para el ACK (respuesta a la pregunta (i)) y está bien razonado en su KDoc `:417-433`. Lo que no hay es ninguna comprobación de dinero: `deleteDatabase("avoqado_database")` se lleva `payment_attempts` (filas `INDETERMINADO`/`AUTORIZADO` = dinero movido sin registrar), `remote_payment_requests` (con sus lápidas y sus resultados finales), `pending_payments` y `pending_refunds`.

Es preexistente, pero **ahora carga el diseño entero**: el propio plan D lo cita como el motivo por el que un `NOT_FOUND` de una bandeja durable no es creíble («esa bandeja puede haberse vaciado DESPUÉS de ejecutar el cobro … `FACTORY_RESET`»), y la regla canónica prohíbe borrar `avoqado_database*` como preparación rutinaria. Falta que el comando **rechace o avise** cuando `findUnresolvedCharge()` devuelve algo o `pending_payments`/`pending_refunds` no están vacías. Nota menor del mismo bloque: el ACK afirma `success("Factory reset completed")` **antes** de ejecutarlo; si `clearAll()` lanza, el servidor ya recibió un «completado» falso.

#### P1-5 · La prueba que dice guardar «un reembolso no puede darse por bueno sin quedar anotado» mide antes de que el flujo aterrice `[snapshot 15:36]`

```kotlin
// app/src/test/.../PaymentViewModelKernelDurabilityTest.kt:489
vm.startRefund(createRefundContext())
Thread.sleep(1500)
testDispatcher.scheduler.advanceUntilIdle()
coVerify(exactly = 1) { kernel.run(any()) }
assertThat(vm.state.value).isNotInstanceOf(PaymentState.Success::class.java)
// La obligación sigue viva en la libreta: hay algo que recuperar.
assertThat(dao.findTerminalHold()).isNotNull()
```

El propio fichero, en su test hermano de la VENTA (`:465-470`), documenta que sin esperar al aterrizaje «un `Success` publicado por error llegaría microsegundos tarde y la prueba pasaría igual», y por eso allí añadieron `esperarA { vm.state.value is PaymentState.Error }`. Aquí no está: `isNotInstanceOf(Success)` se satisface por «todavía no ha llegado», y `findTerminalHold()` es no-nulo por la fila `PREPARANDO`/`KERNEL_ACTIVO` que ya existía antes del kernel. **Las dos aserciones de dinero son verdaderas con y sin el arreglo.** Arreglo: los dos `Thread.sleep` → el `esperarA { … }` que ese mismo fichero ya usa en `:403`, y afirmar el estado final concreto como en `:470-472`.

#### P1-6 `[CERRADO 15:52 — falta la prueba]` · `cancelled + PROCESSOR_DECLINED`, la pareja que la propia libreta declara venenosa

A las 15:36 el emisor mandaba la evidencia con cualquier status (`snapshot sandbox/…/PaymentViewModel.kt:1488-1497`, `outcomeEvidence = negativeOutcomeEvidence`), y el camino que lo alcanza es el de todos los días: el banco declina ⇒ `negativeOutcomeEvidence = "PROCESSOR_DECLINED"`; la cajera cancela ⇒ `cancelPayment()` conserva esa evidencia porque `markDiscardedBeforeCharge` ya no puede ganar (la fila está DESCARTADA, no PREPARANDO). El coste lo escribe el propio equipo en `RemotePaymentRequestDao.kt:161-163`: *«un `cancelled + PROCESSOR_DECLINED` lo degrada a UNKNOWN y deja terminal y tablet bloqueadas»*.

**Cerrado a las 15:52, y por partida doble:**

```kotlin
// VIVO app/src/sandbox/.../PaymentViewModel.kt:4749-4750  (production:3983-3984, idéntico)
val evidencia = negativeOutcomeEvidence ?: "PRE_AUTHORIZATION".takeUnless { financialOperationStarted }
val status = if (evidencia == "PROCESSOR_DECLINED" && statusPreferido == "cancelled") "failed" else statusPreferido
```
y en la capa durable, que es la que de verdad manda (`RemotePaymentRequestDao.kt:180`): `if (evidencia == EVIDENCIA_RECHAZO_DEL_PROCESADOR) json.put("status", "failed")`.

🔴 **Lo que queda abierto: ninguna prueba guarda ninguna de las dos líneas.** `RemotePaymentOutcomeEvidenceTest.kt:47-49` sólo comprueba que la evidencia sobrevive la serialización de un `failed` que ya venía como `failed`; `PaymentViewModelTest.kt` menciona `outcomeEvidence`/`PROCESSOR_DECLINED` 4 veces y ninguna ejercita `emitirDesenlaceNegativo`. **Borrar el `if` de `:4750` deja todo en verde.** Y el filtro del borde (`SocketManager.kt:2027`) sigue aceptando la pareja venenosa si alguien vuelve a llamar al emisor desde otro sitio: la defensa vive en los llamadores, no en el borde.

#### P1-7 `[CERRADO 15:57]` · C.5 / H.3 estaba a medio cablear

A las 15:36 el DAO traía `cancelarTrasReclamar` y `resolverDesenlaceNegativo` **sin un solo llamador**, y `PaymentAttemptLedger` no tenía `iniciarEjecucionNoTarjeta` pese a que `CobroRemotoDelPos.kt:32` ya lo documentaba. A las 15:57 está completo y bien hecho: `RemotePaymentInbox.kt:123` y `:217` llaman a las dos transacciones, la prueba de propiedad viaja desde `RemotePaymentCoordinator.kt:149` (`reclamadasEnEsteProceso`), y la CERCA se consulta desde la Libreta (`:81`, `:369`, `:394`) y desde los tres ViewModels. **Nada que arreglar; queda como constancia de que el árbol atravesó ese estado.**

---

### P2 — defecto real sin dinero directo

#### P2-1 · Cuatro archivos reescritos por completo (CRLF → LF) en un árbol COMPARTIDO `[VIVO 15:58]`

```
core/data/local/AvoqadoDatabase.kt                  diff=3831 líneas   cambio real=49
core/di/DatabaseModule.kt                           diff= 971 líneas   cambio real= 3
payment/presentation/MerchantSelectionContent.kt    diff=1899 líneas   cambio real= 5
test/…/PaymentViewModelTest.kt                      diff=6113 líneas   cambio real=595
```

Comprobado: `git show HEAD:…/DatabaseModule.kt | grep -c $'\r'` → **485**; el archivo de trabajo → **0**. Con ~20 sesiones encima esto garantiza conflicto con cualquier otra que toque esos archivos, inutiliza `git blame`, y esconde 49 líneas de migración de Room dentro de 3831. **Revertir el cambio de fin de línea antes de commitear**, o dejarlo en un commit propio y sólo de eso.

#### P2-2 · La sonda puede cancelar una solicitud recién entregada, y le miente al POS `[VIVO 15:58]`

La cara benigna del P1-1: si `receive()` gana la carrera, la sonda pierde el `insert` de lápida, relee y cae en la rama RECEIVED de `answerFor`, que **cancela**:

```kotlin
// app/src/main/.../RemotePaymentInbox.kt:181-186
RemotePaymentRequestEntity.STATUS_RECEIVED -> {
    val cancelled = JSONObject().put("requestId", existing.requestId).put("status", "cancelled")
        .put("outcomeEvidence", "PRE_AUTHORIZATION")
        .put("errorMessage", "Cancelado por conciliación: la terminal nunca inició este cobro").toString()
    if (dao.resolveReceived(existing.requestId, cancelled, System.currentTimeMillis()) == 1) {
        RemotePaymentProbeAnswer(RemotePaymentProbeDisposition.RECEIVED_CANCELLED, cancelled)
```

No hay riesgo de dinero (`prepareSocketPaymentRequest` encuentra la fila RESOLVED, devuelve `NOT_CLAIMABLE` y no abre el SDK), pero el mensaje que llega al POS —«la terminal nunca inició este cobro»— **es falso**: la terminal la tenía y la iba a abrir. El cajero ve el cobro morirse solo, sin explicación posible.

#### P2-3 · `receive()` contesta `accepted:false` por tres motivos opuestos y el servidor no puede distinguirlos `[VIVO 15:58]`

El ACK negativo tiene un solo significado para el servidor (UNKNOWN/ACK_REJECTED). Pero `receive()` lo usa para: solicitud inválida, `requestId` repetido con otro contrato de dinero, y **lápida**. Las dos primeras son «no la pude guardar» (reintentable); la tercera es «la rechazo a propósito y para siempre». Son decisiones contrarias y viajan idénticas. El `Reject` debería llevar un código.

#### P2-4 · `cancelCashPayment()` publica `Cancelled` sin evidencia y sin tocar la bandeja `[VIVO 15:58]`

```kotlin
// app/src/sandbox/.../PaymentViewModel.kt (bloque cancelCashPayment)
val currentState = _state.value as? PaymentState.AwaitingCashConfirmation
…
_state.value = PaymentState.Cancelled
```

No pasa por ninguno de los candados de `cancelPayment()` (ni `authorizationUnresolved`, ni `markDiscardedBeforeCharge`, ni evidencia). Con `financialOperationStarted = true` —que `processCashPayment` pone— el observador emite `cancelled` **sin evidencia** ⇒ el servidor conserva UNKNOWN ⇒ terminal reservada por un efectivo de kiosco que nunca se registró. Es la familia del defecto «Efectivo en un cobro remoto» que la regla ya declara; `CobroRemotoDelPos.OCULTAR_EFECTIVO_Y_CRIPTO_EN_COBRO_REMOTO = true` lo mitiga para el remoto, no para el kiosco.

#### P2-5 · `fallbackToDestructiveMigrationOnDowngrade()` + bump a v34 = un `INSTALL_VERSION` de retroceso borra dinero `[VIVO 15:58]`

```kotlin
// app/src/main/.../DatabaseModule.kt:148-163
// ⚠️ WARNING: This will DELETE all local data including:
// - pending_payments (queued payments not yet synced)
…
.fallbackToDestructiveMigrationOnDowngrade()
```

El propio comentario de v34 lo reconoce («un regreso a 2.9.2 (v33) sería un downgrade DESTRUCTIVO»). Antes del bump, retroceder entre dos APK del mismo esquema no destruía nada; ahora sí, y `INSTALL_VERSION` es un comando remoto del panel sin ninguna comprobación previa. Es una decisión de producto, pero tiene que quedar dicha **antes** de publicar el APK v34.

#### P2-6 · `LedgerShadowSweepWorker` puede pasarse del límite de WorkManager `[VIVO 15:58]`

`doWork()` corre ahora `unknownRecovery.recover` + `approvalRecovery.recover` antes del barrido, y cada una toma hasta **50 filas × `withTimeout(240_000L)`**. WorkManager cancela a los 10 minutos. El dinero está a salvo (cada fila lleva su `lease_until` y se retoma), pero en un aparato con varias filas atoradas el barrido de mantenimiento —cuarentena, cierre, poda— **nunca llega a correr**.

#### P2-7 · `coVerify(exactly = 0) { chargeVerifier.verificar(any() ×5) }`: matcher más estrecho que la llamada real

`app/src/test/.../angelpay/AngelPayPaymentViewModelTest.kt:2788` y `:2815`. `verificar` tiene **6** parámetros (`AngelPayChargeVerifier.kt:60-67`, el sexto `affiliation: String? = null`); con 5 matchers MockK graba el sexto como `eq(null)`, mientras producción lo llama siempre con valor (`AngelPayPaymentViewModel.kt:2505-2508`). Si esa afiliación es no nula, **el `exactly = 0` pasa aunque `verificar` sí se haya llamado** — justo el invariante que el test dice guardar. El mismo fichero usa 6 matchers en `:399, :1333, :1444, :2692`: es un descuido, no una decisión. 8 ocurrencias de la forma corta en el árbol.

#### P2-8 · El test que dice guardar el CAS durable mockea justamente el CAS

`app/src/test/.../angelpay/AngelPayPaymentViewModelTest.kt:1463` — `coEvery { paymentAttemptLedger.markAuthorizing("attempt-X") } returnsMany listOf(true, false)` y luego comprueba que el VM reenvíe ese booleano. Nada del CAS de Room se ejecuta: un CAS roto daría el mismo verde. Lo que el nombre promete **sí** está cubierto, pero en otro fichero (`AngelPayPaymentReviewRoomTest.kt:385`, con Room real). Renombrarlo a lo que mide.

#### P2-9 · La CERCA de `reserveTerminal` no estaba cubierta en el snapshot

La cláusula `AND (:terminalPaymentRequestId IS NULL OR NOT EXISTS (SELECT 1 FROM remote_payment_requests cerca WHERE … 'NOT_FOUND_ANSWERED' OR cancel_accepted_at … OR final_emitted_at …))` (`PaymentAttemptDao.kt:108-113`) no tenía ni un test a las 15:36, y el único test con Room que ejercita `reserveTerminal` (`PaymentAttemptRoomTest.kt:29,33,40,52`) siempre pasa contexto `"{}"`, así que la rama nunca se evaluaba. **En vivo ya hay 7 referencias nuevas** (`CancelTrasReclamarRoomTest.kt`); hace falta re-auditarlo contra un snapshot fresco.

---

### P3 — calidad

- **`claimSocketPaymentRequest` quedó muerto** en producción: `AppNavigation` usa `prepareSocketPaymentRequest` y al método sólo lo llaman sus propias pruebas (`RemotePaymentCoordinatorTest.kt:20`, `RemotePaymentInboxRoomTest.kt:55…155`).
- **`SocketEvent.TerminalPaymentCancel` es código muerto**: `SocketManager` ya no lo emite y `HomeViewModel` lo recibe con `-> Unit`. El tipo y la rama deberían irse juntos.
- **`remote_payment_requests` no se poda nunca** (cero `DELETE` en `main`): una fila por solicitud y por lápida, para siempre. Hoy es inofensivo por tamaño; conviene decidirlo a propósito, sobre todo porque una poda **rompería** la garantía de la lápida.
- **El banner de obligaciones sólo se monta en `Home`** (`AppNavigation.kt:882`): un cobro pendiente deja de verse en cuanto el cajero entra a otra pantalla.
- **La sonda contesta el `ack` DESPUÉS del `emit`**: si el `emit` lanza, el `ack` no se llama y el servidor espera su timeout.
- **`paymentArgsHandle`** en la ruta AngelPay (`AppNavigation.kt:2824`) apunta al handle del lanzador **del que `congelarArgumentosDeCobro` ya borró las claves**: sus seis `clearPaymentArgs` (`:2846…:2919`) son no-ops. No hace daño; sobra.
- **`ramaDesconocida` sólo mira 900 caracteres** (`RechazoContactlessLiberaLaTerminalTest.kt:55-59`): un `markKernelRefused` más abajo de esa ventana no se detectaría. Tope arbitrario en una guarda de dinero.
- **Comentario que contradice su aserción** (`AngelPayOutcomeClassifierTest.kt:140-144`): dice «conserva el comportamiento de hoy (**rechazo**)» y la aserción exige `INCIERTO`.
- **`review missing posId …` fuerza `_state` por reflexión** (`PaymentViewModelWatchdogTest.kt:156-173`) en vez de disparar el camino real del posId ausente.
- **`OFF mode still durably marks…`** (`PaymentAttemptLedgerTest.kt:285-290`): configura `PaymentLedgerMode.OFF`, pero `isEnabled()` devuelve `true` literal y nunca consulta el repositorio — el `settingsRepository` del test es decorativo. Sigue siendo guarda de regresión válida; el nombre promete de más.
- **`cancel sobre lápida contesta ACTIVE`** (`RemotePaymentInboxTest.kt:213-219`) pasa por el CAS mockeado a 0, no por la lápida; cubierto de verdad en `RemotePaymentInboxRoomTest.kt:249` sobre Room real.

---

## Lo que está BIEN y vale confirmar

1. **Toda escritura de la bandeja es un CAS o un `INSERT … IGNORE`.** Revisé los cinco caminos de `RemotePaymentInbox` (`receive`, `cancel`, `probe`/`answerAbsent`, `persistResult`, `markProcessing*`): **ninguno** tiene un lee-decide-escribe sin la condición dentro de la propia sentencia — respuesta a la pregunta (b). Y las dos transacciones que sí necesitan leer para decidir (`cancelarTrasReclamar`, `resolverDesenlaceNegativo`) van con `@Transaction` y **revierten** con `CancelNoAceptado` si la escritura de la bandeja no gana, de modo que nunca queda un descarte de libreta suelto.
2. **La evidencia de un desenlace negativo ya NO la decide la pantalla, la decide la libreta** (`RemotePaymentInbox.kt:213-233` → `RemotePaymentRequestDao.kt:168-185`). Y si la libreta no acredita ningún «no se cobró» (intento incierto, en curso, heredado, o efectivo/cripto arrancado), **no se escribe nada**: la solicitud se conserva sin desenlace en vez de certificar un «no» que no consta. Es el corazón de la condición del founder y está bien resuelto.
3. **Una solicitud YA reclamada se puede cancelar, pero sólo con prueba** (`cancelarTrasReclamar`, `RemotePaymentRequestDao.kt:132-151`): exige PROCESSING, sin efectivo/cripto arrancado, sin cancel ni final previos, cero intentos bloqueadores, y —si no hay ningún intento— **prueba de propiedad en este proceso**, que es lo que impide aceptar un cancel tras un reinicio en el que nadie sabe qué quedó a medias.
4. **`persistResult` deja que una aprobación REAL gane sobre un cancelado/fallado previo**, con `replaceResolvedResult` condicionado al JSON anterior. Un cancel nunca pisa una aprobación.
5. **`markResolved` no puede tocar una lápida** — lista POSITIVA `status IN ('RECEIVED','PROCESSING')` (`RemotePaymentRequestDao.kt:71-76`), no una lista de exclusión: un estado nuevo no se cuela por default.
6. **El ACK del `payment_request` ya no depende de que la navegación tenga hueco** (`SocketManager.kt:1548-1554`): se acusa el recibo durable y, sólo si el canal estaba lleno, se resuelve con `rejectUnclaimed` **condicionado a RECEIVED**, así que un claim concurrente gana y no se rechaza un cobro que ya arrancó.
7. **Los tres rechazos de `AppNavigation` pasan por `rejectRemotePaymentBeforeAuthorization`** (`:387`, `:426`, `:452`), el único emisor de `PRE_AUTHORIZATION`. Eso cierra el defecto medido en hardware el 10-sep («rechazo sin evidencia → UNKNOWN en < 1 s»), y funciona porque `markResolved` acepta resolver desde `PROCESSING`.
8. **`congelarArgumentosDeCobro`** (`AppNavigation.kt:3248-3292`) resuelve los dos caminos del re-etiquetado de una vez: copia a la entrada propia **y borra del lanzador en el mismo paso**. Respuesta a la pregunta (d): la limpieza se hizo a la ENTRADA en vez de a la salida, que es lo correcto porque no depende de por dónde se salga (callback, atrás del sistema, pop del colector o muerte del proceso).
9. **`PaymentPhaseTracker` es thread-safe de verdad**: sus diez métodos públicos llevan `@Synchronized` (`:145,160,170,181,191,202,209,226,256`), que es exactamente lo que hace falta porque lo escriben el observador (`Dispatchers.Default`), el flujo de pago y los callbacks del SDK a la vez; y `claimStallReport()` es un check-and-set atómico, así que un atasco produce **un** evento aunque lo detecten los dos vigilantes.
10. **`LedgerUnknownRecovery` nunca convierte un INDETERMINADO en «no cobrado»**: sólo escribe cuando el verificador devuelve `Cobrado` (`:44-47`); vacío, parcial o fallido dejan la fila intacta. Respuesta directa a la pregunta (e): **no puede** fabricar un «no se cobró» sin evidencia del procesador; `LedgerApprovalRecovery` tampoco (su único desenlace negativo es `REGISTRO_FALLIDO`, jamás `DESCARTADA`).
11. **`MIGRATION_33_34` está bien escrita y probada**: `PRAGMA table_info` antes de cada `ALTER` (idempotente; el propio comentario explica que un duplicado sería un crash-loop sobre `pending_payments`), y `legacy_shadow = 1` **sólo cuando crea la columna**, así que una segunda pasada no marca como heredada una fila del APK nuevo. `app/schemas/34.json` y `MigracionV34RoomTest.kt` aterrizaron a las 15:39 y el test siembra una v33 real desde el JSON de esquema.
12. **Los hunks de `production` y `sandbox` son idénticos.** Comprobado dos veces (15:36 y 15:53) comparando el multiconjunto de líneas `+`/`-` de ambos diffs: coinciden. El desorden que se ve al comparar los diffs crudos es sólo que las dos variantes traen esas funciones en distinto orden — divergencia previa de los archivos, no de este cambio. Respuesta a la pregunta (j): **cumple la regla del repo**.

### Y del lote de pruebas, lo que de verdad guarda lo que dice

- `RemotePaymentInboxRoomTest.kt:194-208` — carrera real claim-vs-cancel, 10 rondas en `Dispatchers.IO`, `xor` exacto sobre Room real.
- `RemotePaymentInboxRoomTest.kt:235-250` — la lápida como promesa durable: tras `NOT_FOUND`, `receive` rechaza y los dos `markProcessing*` devuelven false.
- `PaymentAttemptRoomTest.kt:44-73` — el par que importa, con la aserción invertida en los dos sentidos: `markKernelRefused` libera la terminal y la siguiente venta entra; `markIndeterminate` la retiene y la siguiente **no**.
- `LedgerRecoveryLeaseRoomTest.kt:97-128` — el dueño con lease caducado no pisa el estado del sucesor; el `AND lease_until = :ownedLease` se ejecuta contra SQLite.
- `PaymentViewModelKernelDurabilityTest.kt:426-486` — aprobación offline con la escritura del desenlace fallando: espera al aterrizaje real, exige «No vuelvas a pasar la tarjeta», comprueba que no se emite ni `cancelled` ni `success`, y que un Ledger recreado ya no puede abrir otro intento.
- `AngelPayPaymentReviewRoomTest.kt:229-300` — VM muerto a media SDK + callback vacío, con DAO decorador (sin mockk) que cuenta consultas reales.
- `PaymentViewModelWatchdogTest.kt:219-250` — dos tests gemelos que invierten exactamente el booleano del arreglo.
- `ContactlessKernelResultTest.kt:172-186` — las constantes se fijan contra `RetCode` del jar de PAX; y en `:139-152` el comentario **documenta que la versión anterior del test pasaba con el fix roto** y cómo se apretó. Ese nivel de honestidad es el mejor indicador de calidad del lote.

---

## Lo que NO pude verificar

- **Que el árbol compile.** No corrí gradle (instrucción explícita). A las 15:36 NO compilaba; a las 15:58 el desajuste estaba corregido. **`assembleSandboxDebug` + `testSandboxDebugUnitTest` por `avq-verify` antes de cualquier commit.**
- **El lado servidor de la sonda.** Si el servidor sondea o no una fila entregada hace segundos decide si el P1-1 es un caso diario o un borde raro. Eso vive en `avoqado-server`.
- **Nada en hardware.** Las celdas de la matriz de la regla canónica (cancel durante el SDK, pantalla apagada, sin turno, arranque en frío) no se ejercitan leyendo código.
- **El estado FINAL del cableado C.5/H.3 y sus 7 referencias nuevas en tests**: aterrizaron después del snapshot; necesitan un snapshot fresco para auditarlas con números de línea fiables.
- **`AngelPayAuthPreviaCobroTest.kt` (19 tests) y `AngelPayAuthRepositoryTest.kt` (+12)**: revisados por nombres y muestreo, no test por test (~1.400 líneas).
- **Los 3 tests estáticos de fuente** (`ArgumentosDelCobroSeLeenUnaVezTest`, `RechazoContactlessLiberaLaTerminalTest`) leen rutas relativas `src/main/…`: asumen que el directorio de trabajo de Gradle es `app/`. No comprobé la configuración del task `test`; si no lo fuera, fallarían con `FileNotFoundException` en vez de en falso.

---

# Anexo · Riel AngelPay / Nexgo (T26 · H.3 · D.7 · verificación de cobro incierto)

Revisado aparte por su volumen (+947 líneas sólo en `AngelPayPaymentViewModel`). Cada hallazgo va marcado
`[ABIERTO EN VIVO]` o `[CERRADO EN VIVO]` según se comprobara contra el árbol de las 16:02.

## P1-A8 · El verificador de cobro incierto es INÚTIL justo en el escenario para el que existe `[ABIERTO EN VIVO]` 🔴

**El más grave del riel AngelPay, y pierde dinero en la dirección que cuesta.** Lo verifiqué yo mismo, línea por línea.

```kotlin
// app/src/main/.../angelpay/AngelPayChargeVerifier.kt:93-99
mia.reference.isNotBlank() &&
mia.processorType == ProcessorType.ANGELPAY &&
mia.status.uppercase() in setOf("APROBADA", "APPROVED") &&
!terminalSerial.isNullOrBlank() && mia.terminal == terminalSerial &&
(!affiliation.isNullOrBlank() && mia.affiliation == affiliation) &&
mia.operationType?.uppercase() in setOf("VENTA", "SALE") &&
mia.postOperationStatus.isNullOrBlank()) {
```

Con `affiliation == null` ese conjunto es **siempre falso**: el verificador no puede confirmar **ningún** cobro y devuelve `NoSePudoVerificar` pase lo que pase.

Y el campo que le llega es memoria pura:

```
$ grep -n "pendingProcessorAffiliation" .../AngelPayPaymentViewModel.kt
584:    private var pendingProcessorAffiliation: String? = null
799:        pendingProcessorAffiliation = runCatching { sdkGateway.getSessionInfo()?.affiliation }.getOrNull()
801:            addProperty("processorAffiliation", pendingProcessorAffiliation)
2523:            affiliation = pendingProcessorAffiliation,
3904:        pendingProcessorAffiliation = null
```

**No está en `savedStateHandle`** (comprobado: ese handle sólo guarda 5 claves, `:504-528`), y sólo se asigna dentro de `openLedgerAttemptAndMarkAuthorizing`. El escenario donde el verificador existe es exactamente aquel en el que la Activity del SDK de AngelPay mató a `MainActivity` y el ViewModel se recreó — y ese camino lo dice el propio código:

```kotlin
// app/src/main/.../angelpay/AngelPayPaymentViewModel.kt:2119-2125
// El id puede venir de la LIBRETA cuando este ViewModel es uno recreado: la
// fila existe aunque el objeto no la recuerde. Sin esto, el cobro quedaba
// AUTORIZANDO para siempre y nadie lo marcaba como «no sé qué pasó».
(currentPaymentAttemptId ?: cobroPendiente?.attemptId)?.let {
    paymentAttemptLedger.markIndeterminate(it, "AngelPay ${result.code}")
}
verificarCobroIncierto(result.message, result.code, null, null, null)
```

Recupera el `attemptId` de la libreta **y no recupera la afiliación**, que está en la MISMA fila. Resultado: **la tarjeta se cobró, el historial de AngelPay lo confirma, y la app no lo puede leer** ⇒ no se registra el `Payment`, se manda `timeout` al POS, y la fila queda `INDETERMINADO` (que además bloquea todo cobro posterior, ver P1-B8). Viola la prioridad #2 de la regla («nunca se pierde»).

🔑 **El dato durable ya existe y nadie lo usa:** `:801` escribe `processorAffiliation` dentro del `contextJson` de la libreta, y `LedgerUnknownRecovery.kt:35` ya lo lee de ahí (`text("processorAffiliation")`). El arreglo es leerlo de la libreta cuando el campo en RAM sea null.

**Por qué la prueba no lo caza:** `AngelPayChargeVerifierTest.kt:167-170` («unknown affiliation cannot confirm approval from another account») usa una transacción con `affiliation = "other"`, así que **pasa por el motivo equivocado**: con `affiliation = null` nada confirma, venga la afiliación correcta o no. No hay ninguna prueba con `affiliation = null` y la afiliación de la transacción CORRECTA.

## P1-B8 · Un cancel del cajero (U100) deja la terminal reservada, y la fila bloquea los cobros siguientes `[ABIERTO EN VIVO]`

```kotlin
// app/src/main/.../angelpay/AngelPayOutcomeClassifier.kt:95-101
val catalogo = codigoSdk?.trim()?.uppercase()
if (!catalogo.isNullOrBlank()) {
    return if (catalogo in CODIGOS_RECHAZO_CONFIRMADO) DesenlaceDelCobro.RECHAZADO_CONFIRMADO
    else DesenlaceDelCobro.INCIERTO
}
```

`U100` («Cancelado por el usuario») no está en `CODIGOS_RECHAZO_CONFIRMADO` ⇒ `INCIERTO`. La cadena completa: atrás del sistema → `markIndeterminate` → `verificarCobroIncierto` → el historial no confirma (o la afiliación es null, P1-A8) → `quedarSinVerificar` → `status = "timeout"` ⇒ `TIMED_OUT` ∈ `UNRESOLVED_FINANCIAL_OUTCOME` ⇒ **terminal reservada sin palanca**, y la fila `INDETERMINADO` de la libreta bloquea todo cobro siguiente por la barrera dura (abajo). Un gesto diario deja la terminal inservible.

Es **deliberado** a nivel de clasificador (`AngelPayOutcomeClassifierTest.kt:114-118` lo fija), pero la consecuencia de sistema —cancelar = terminal bloqueada— no está declarada en ninguna parte, y la prueba sólo fija el veredicto de la función pura, no el destino de la solicitud.

## P1-C8 · La barrera dura de la libreta deja el cobro remoto SIN desenlace, en silencio `[ABIERTO EN VIVO, parcial]`

El diff convierte la libreta de *best-effort* (`runCatching` + «charge continues unledgered») en **rechazo duro**:

```kotlin
// app/src/main/.../angelpay/AngelPayPaymentViewModel.kt:1747-1755 (gemelo en :1881-1889)
if (!openLedgerAttemptAndMarkAuthorizing(paymentAttemptId)) {
    _state.value = AngelPayPaymentState.Error(
        "No se pudo guardar el intento o esta venta tiene un cobro pendiente. No se inició otro cobro.",
        canRetry = false,
    )
    clearChargingOnTerminal()
    return
}
```

`reserveTerminal` rechaza cualquier intento nuevo mientras exista **una sola** fila no-legacy en `PREPARANDO|KERNEL_ACTIVO|AUTORIZANDO|INDETERMINADO|HOST_RESPONDIO|AUTORIZADO|REGISTRO_FALLIDO` — **sin filtro por venue** (`PaymentAttemptDao.kt:96-100`). Con un `INDETERMINADO` heredado (estado sin poda ni liberación manual), el siguiente `payment_request` navega, la barrera rechaza, y **no se emite nada al POS**: la tablet espera 330 s, el vigía parquea en `UNKNOWN`, terminal reservada. Es el callejón de Testarudo reintroducido por un cambio hecho para cerrarlo.

**En vivo ya hay `traducirBarreraRechazada()`**, que traduce la cerca (`CANCELADA_POR_EL_POS` / `CERRADA` / `LIBRE`). 🔴 **Pero la rama `LIBRE` sigue sin emitir nada al POS** — y `LIBRE` es justo «la terminal está reservada por otra fila de la libreta», el escenario de arriba. **Sigue abierto para ese caso.**

## P1-D8 `[CERRADO EN VIVO]` · Un rechazo del banco se emitía con «Reintentar» vivo sobre la MISMA solicitud

`AngelPayPaymentViewModel.kt:2387-2411` emitía el desenlace final en el instante mientras `ErrorContent` (`AngelPayPaymentScreen.kt:934-941`) ofrecía «Reintentar» sobre el mismo `requestId`, y `retryAfterError()` no lo bloqueaba. Con `PROCESSOR_DECLINED` el servidor cierra la fila como `FAILED/TPV_CONFIRMED_NO_CHARGE` ⇒ **ranura libre y llave de la tablet liberada**, con la terminal todavía capaz de cobrar esa venta: dos personas, dos pantallas, una orden = doble cobro. **Cerrado en vivo** por `retenerDesenlaceDeRechazo()` / `emitirDeclinacionRetenida()` (la regla H.3 «retener el rechazo, emitir el final sólo al salir») + el bloqueo en `retryAfterError`. Respuesta directa a la pregunta (c-i): **la regla H.3 está aplicada en el riel AngelPay**. Ninguna prueba reintenta **después** del final emitido (`AngelPayPaymentViewModelTest.kt:2869-2891` sólo prueba el reintento ANTES de que venza el reloj).

## P1-E8 `[CERRADO EN VIVO]` · El reloj de abandono cerraba la fila y dejaba «Reintentar» en pantalla

`:2618-2628` emitía `cancelled + PRE_AUTHORIZATION` (que el servidor acepta y libera) sin poner `solicitudCerradaAntesDeAutorizar = true` ni cambiar el estado: el cajero que volvía a los 3 minutos podía cobrar sobre un POS ya liberado. En vivo el bloque `if (declinacionRetenida != null)` marca la solicitud cerrada y pone `canRetry = false`.

---

## P2 del riel AngelPay

- **P2-A8 · La KDoc de `quedarSinVerificar` afirma lo contrario de lo que hace** `[ABIERTO]` — `:2543-2562` dice que `timeout` «cierra la fila sin dejar el slot de la terminal retenido». **Falso**: `TIMED_OUT` ∈ `UNRESOLVED_FINANCIAL_OUTCOME`, el slot **sí** queda retenido. El comportamiento es el correcto (conservador); lo que miente es la afirmación — y sobre ella se apoya la decisión de producto del P1-B8.
- **P2-B8 · Dos fallos pre-SDK gemelos con comportamientos OPUESTOS** `[ABIERTO]` — `:1710-1728` (auth) y `:1735-1745` (`sessionAlignedWithSelectedMerchant`) **no emiten nada**, mientras el MISMO fallo cien líneas antes (`asegurarSesionAntesDeEsperar`, `:1505`) sí llama a `fallaAntesDeAutorizar` y retiene un `failed + PRE_AUTHORIZATION`. Aquí consta igual de bien que nada capaz de autorizar empezó (la libreta no se abrió, el SDK no se tocó), así que el silencio no está justificado: la solicitud se queda sin responsable ⇒ UNKNOWN ⇒ terminal reservada. El comentario que lo justifica es anterior a `outcomeEvidence` y ya no describe el sistema. T26 hace este camino **más** probable (revalidación contra la sesión viva).
- **P2-C8 · Espera sin tope y sin salida en «Conectando con AngelPay…»** `[ABIERTO]` — `:1390-1394`, `candadoDeSesion.lock()` sin `withTimeout`. Quien puede tenerlo: `recoverIfStuck` (hasta 5 intentos con backoff ~39 s + red) o `refrescarComerciosParaElPanel` (~80 s). Y `ConectandoAngelPay` **no está en el `when` del botón atrás** (`AngelPayPaymentScreen.kt:433-441`, cae en `else -> { /* No back during processing */ }`): el cajero no puede salir. Choca con la prioridad #1 de la regla.
- **P2-D8 · `switchAccount` del reembolso salta el `candadoDeSesion`** `[ABIERTO]` — `AngelPayAuthRepository.kt:626` lo expone público y `AppNavigation.kt:237` lo llama sin tomar el candado; su único guard es `isCharging()`, que es **false** en la ventana «auth del cobro → `setCharging(true)`» que T26 existe para cerrar. El dinero lo protege `sessionAlignedWithSelectedMerchant` (bloquea el cobro), así que el daño es disponibilidad — pero el cobro muere por P2-B8, sin emitir nada.
- **P2-E8 · Se quitó el redondeo de centavos y ahora una excepción rechaza el cobro** `[ABIERTO]` — `:760-761` pasó de `.movePointRight(2).setScale(0, HALF_UP).longValueExact()` a `.movePointRight(2).longValueExact()`. Cualquier `BigDecimal` con más de 2 decimales lanza `ArithmeticException`, la atrapa el `catch` de `:791-794`, devuelve `false` y el cobro queda rechazado con `canRetry = false` (y, si es remoto, en silencio: P1-C8). Las propinas por porcentaje están a salvo (`updateTipSelection` usa `divide(…, 2, HALF_UP)`); **no se pudo demostrar** si la propina personalizada puede traer 3 decimales. Ninguna prueba cubre un importe con más de 2 decimales.

## P3 del riel AngelPay

- **`CODIGOS_SIN_VEREDICTO` es código muerto y su comentario miente**: `AngelPayOutcomeClassifier.kt:58-63` insiste en que es «una lista EXPLÍCITA, no un rango ni una categoría», pero `clasificar()` (`:82-102`) **nunca la lee** — la regla real es el complemento de `CODIGOS_RECHAZO_CONFIRMADO` (cero referencias en `main/` ni en `test/`). Su efecto práctico es el P1-B8.
- **`VerificacionDelCobro.NoCobrado` es inalcanzable**: `AngelPayChargeVerifier.kt:23-24` la declara, `verificar()` siempre sale por `NoSePudoVerificar` (`:127`), y la rama que la maneja (`:2533` del VM) es código muerto. La elección es correcta (un historial parcial no prueba ausencia); el tipo sugiere un camino que no existe.
- **`AngelPayResult.Cancelled` dejó de ser alcanzable desde el parser** (`AngelPayResultParser.kt:82-86` convierte el callback vacío en `Failure("…","UNKNOWN",null)`): su único productor es la degradación del VM en `:2081-2083`.
- **KDoc de `ensureAuthenticatedAs` obsoleta**: `AngelPayAuthRepository.kt:804-806` sigue diciendo «sus únicos call sites son el propio flujo de pago»; desde T26 también la llama la recuperación de fondo (`:212`).
- **Evidencia nula si ya hubo efectivo/cripto en el mismo VM**: `:956, :961, :970, :978, :1001, :1268` usan `"PRE_AUTHORIZATION".takeUnless { authorizationWasLaunched }`, y `startCashPayment`/`processCryptoPayment` ponen esa bandera en true ⇒ un fallo de validación posterior emitiría `failed` **sin evidencia**. Latente (normalmente `_socketResultEmitted` ya está puesto).

## Lo que está BIEN en el riel AngelPay — respuestas directas a (f)

1. **`sessionAlignedWithSelectedMerchant` es fail-closed de verdad** — `:2752` exige `enSesionViva == targetId`, y `comercioActivoEnSesionViva()` (`:2775-2783`) devuelve `null` ante cualquier excepción; `null == targetId` es falso ⇒ **no se cobra**. Revalidar contra la sesión VIVA (no la marca en memoria) es el arreglo correcto.
2. **`asegurarSesionAntesDeEsperar` corre ANTES de `setCharging(true)`** (`:1390-1420`) y dentro del `candadoDeSesion`. El orden de candados (`candadoDeSesion` → `nucleo`) es consistente en los cuatro entrypoints; no hay ruta inversa ⇒ **sin deadlock y sin ventana en la que el cobro use la sesión de otra afiliación**.
3. **`estaAtorada()` asume sesión viva cuando no puede preguntar** (`AngelPayAuthRepository.kt:143`, `.getOrDefault(true)` negado): la recuperación de fondo **nunca** toca una sesión que no pueda descartar; y `recuperarSiSigueAtorada` revalida dentro del `nucleo` (`:189-194`) además de dentro del `candadoDeSesion` (`AngelPayAuthRecovery.kt:153-155`). Los cuatro candados de `recoverIfStuck` (sin cobro, `tryLock` de dueño, una corrida a la vez, enfriamiento de 30 s) están puestos.
4. **Nunca cae a la cuenta primaria sin red** — `AngelPayAuthRepository.kt:837-849`: con `esFallaDeRed`, falla con `SIN_RED` en vez de autenticar la primaria. Es la regla de Amaena escrita en código, no en un comentario.
5. **El banner no promete lo que el código no cumple**: `AngelPayAuthBanner` ofrece «Reintentar» sólo donde reintentar sirve, y `Recuperando` apaga **sólo Tarjeta**, no Efectivo (`AngelPayMetodosDePago.bloqueoDeMetodosDePago`).
6. **D.7 tiene DOS puertas reales** — la navegación congela los argumentos una vez (`AppNavigation.kt:2792-2794`, `remember(backStackEntry)`) y el VM fija el vínculo en la primera llamada (`:259-274`), **persistido en `SavedStateHandle`** y con Crashlytics al detectar un id ajeno. El `LaunchedEffect` está **keyed** (`AngelPayPaymentScreen.kt:194-196`), **no corre en cada recomposición**, y el colector remoto hace pop a Home antes de empujar el cobro nuevo, así que un `requestId` nuevo siempre aterriza en un VM nuevo. Respuesta a la pregunta (d): **sí rechaza cambiar de requestId con un intento abierto, y la limpieza no depende de por dónde se salga.**
7. **La libreta guarda ahora un `PaymentContext` real** (`:765-778`) en vez de un JSON a mano: por eso lleva `terminalPaymentRequestId` y `processorAffiliation`, que es lo que hace posible la cerca C.5/H.3. Y `recordCardPayment` se partió por datos (`:2894-2900`) para que un cobro confirmado por verificación se registre **por el mismo camino** que uno normal.

## Lo que no se pudo verificar del riel AngelPay

- Si `sdkGateway.getSessionInfo()?.affiliation` devuelve null en la práctica en el caso **no** recreado (P1-A8): es `compileOnly` en variantes PAX y no hay hardware. Lo que sí está probado por lectura es que un ViewModel recreado llega con `null`.
- Si la propina personalizada puede producir más de 2 decimales (P2-E8): no se revisó el teclado que alimenta `updateCustomTip`.
- Si `retryAfterError` está al alcance del dedo en cada escenario de P1-D8/P1-E8: el cableado está verificado, pero no se ejercitó en un aparato — y la regla `todo-funciona-sin-red.md` exige exactamente eso.
- El comportamiento real del servidor ante `timeout` se leyó del código (`terminal-payment.service.ts:230-237, 1386-1424`), no de una corrida.
