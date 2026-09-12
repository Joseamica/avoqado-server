# Revisión avoqado-android — circuito de cobro remoto (11-sep-2026)

⚠️ **Nota de método, importante para leer este informe**: el árbol de trabajo estuvo en constante
movimiento durante toda la revisión — al menos 5 veces cambió el contenido de los archivos clave
mientras los leía (confirmado con `git status`/`md5` repetidos, entre las 15:44 y las 15:53 CST).
Es una sesión concurrente terminando de construir EXACTAMENTE esta feature en vivo, lo cual es
normal en este workspace (regla de concurrencia del `CLAUDE.md` raíz) y no un error mío de lectura.
**Congelé el análisis en la última foto estable** (archivos con hash idéntico en dos lecturas
separadas por 10+ s): `TerminalPaymentService.kt`, `CardChargeOutcome.kt`, `CancelacionDeCobro.kt`,
`CancelacionDeCobroCoordinator.kt`, `CancelacionDeCobroHttp.kt`, `CancelacionDeCobroModule.kt` y
`OrderRepository.kt` estables desde ~15:52 CST; `PaymentFlowViewModel.kt` fue el último en asentarse,
confirmado estable a las **15:53:41 CST** (dos lecturas idénticas). Todo lo que sigue es sobre esa foto.
Es muy posible que para cuando se lea este informe el hallazgo P1 principal ya esté cerrado — pero
en el momento revisado, no lo estaba, y lo dejo con cita exacta para que se verifique contra el
árbol vigente antes de dar nada por bueno.

## Inventario (foto final, `git status --short --untracked-files=all`)

**Circuito de cobro remoto (lo que pide el brief):**
- `app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt` (M, 1078 líneas) — POST/GET/cancel del cobro por terminal; llave durable; reconciliación de estado; ahora también `pedirCancelacion()`/`consultarEstado()` para la cancelación durable.
- `app/src/main/java/com/avoqado/pos/payment/domain/CardChargeOutcome.kt` (M) — `ChargeStatusProbe`, `CardChargeOutcome`, `CardChargeDecision` (decisión de "¿puedo reintentar el cobro?").
- `app/src/main/java/com/avoqado/pos/payment/domain/CancelacionDeCobro.kt` (??, nuevo) — decisión PURA "¿puedo BORRAR la orden tras cancelar?" (más estricta que `CardChargeDecision`).
- `app/src/main/java/com/avoqado/pos/payment/data/CancelacionesDeCobroStore.kt` (??, nuevo) — `IntencionDeCancelarCobro`, `FaseDeCancelacion`, persistencia en SharedPreferences.
- `app/src/main/java/com/avoqado/pos/payment/data/CancelacionDeCobroCoordinator.kt` (??, nuevo, 421 líneas) — máquina de estados que reproduce cancel → desenlace → DELETE de la orden como BARRERA.
- `app/src/main/java/com/avoqado/pos/payment/data/CancelacionDeCobroHttp.kt` (??, nuevo) — implementación real de `CancelacionDeCobroTransport` sobre `TerminalPaymentService` + `OrderRepository`.
- `app/src/main/java/com/avoqado/pos/payment/di/CancelacionDeCobroModule.kt` (??, nuevo) — bindings Hilt del store y el transport.
- `app/src/main/java/com/avoqado/pos/payment/data/OrderRepository.kt` (M) — `cancelOrder()` cambió de `Result<Unit>` a `ResultadoDeCancelarOrden` tipado (distingue `BloqueadaPorCobro` / `RechazoDeNegocio` / `NoExiste` / `SinRed` / `ErrorDeServidor`).
- `app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt` (M) — inyecta el coordinador (línea 103), lo consulta defensivamente en `handleStaleCardResult` (línea 1852), pero **`cancel()`/`cancelAndExit()` no lo usan** (ver Hallazgo #1).
- `app/src/main/java/com/avoqado/pos/core/data/network/ServerErrorText.kt` (M, no leído a fondo — fuera del foco del brief, aparenta ser texto de error compartido).
- `CHANGELOG.md` (M) — documenta SOLO tres cosas: el fix del 409 `TERMINAL_BUSY` correlacionado, el mensaje duplicado del cobro anterior, y el bug del cambio en efectivo. **No menciona la cancelación durable** — coherente con que, en la foto final, esa pieza sigue sin engancharse al flujo del cajero.
- Tests nuevos/modificados: `CardChargeDecisionTest.kt`, `TerminalPaymentServiceHttpTest.kt`, `PaymentFlowViewModelTest.kt`, `CancelacionDeCobroCoordinatorTest.kt`, `CancelacionDeCobroDecisionTest.kt`, `CancelacionTransportFalso.kt`, `CancelacionesDeCobroStoreTest.kt`, `CancelarOrdenHttpTest.kt`, `PaymentFlowCancelacionDurableTest.kt`, `TerminalPaymentCancelacionHttpTest.kt`.

**Otras features de otras sesiones (no son el circuito de cobro remoto, mezcladas en el mismo diff):**
- `PaymentFlowViewModel.kt` + `PaymentFlowViewModelTest.kt`: dos pruebas P1 y ~20 líneas sobre un bug DISTINTO — el cambio en efectivo (`finalChange`) se calculaba mal cuando el server devolvía `changeCents=0`, y el ticket imprimía el TOTAL como si fuera el "Recibido". Documentado en `CHANGELOG.md`. No lo audité a fondo por estar fuera del alcance pedido (dinero de EFECTIVO, no de terminal), pero la fórmula nueva (`cashReceivedCents - authoritativeTotal`, con `.coerceAtLeast(0)`) parece razonable a simple vista.
- `app/src/test/java/com/avoqado/pos/sync/CuarentenaCobroVivoTest.kt`, `app/src/test/java/com/avoqado/pos/tables/CobroVivoBloqueaAnularTest.kt` — no los leí (fuera del paquete `payment`, aparentan ser de otra sesión sobre "anular" mesas con cobro vivo — probablemente relacionado al mismo incidente del 11-sep pero en otro flujo). **Declarado como no verificado.**

## Hallazgos

### P1-1 — `PaymentFlowViewModel.cancel()`/`cancelAndExit()` llaman APIs con la firma VIEJA: no compila, y aunque compilara, el fix de la cancelación durable NO está enganchado

**El bug de fondo que motiva toda esta feature sigue vivo en el único lugar que importa: el botón "Cancelar" del cajero.**

`app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt:1950-1976`:
```kotlin
fun cancel() {
    isProcessingPayment = false
    paymentGeneration++
    undeterminedRequestId = null
    paymentIdempotencyKey = null
    // Cancel pending terminal payment if in progress
    terminalPaymentService.cancelCurrentPayment()
    ...
    createdOrderId?.let { orderId ->
        viewModelScope.launch {
            orderRepository.cancelOrder(orderId).onFailure { e ->
                ...
            }
        }
    }
}
```
y `cancelAndExit()` (líneas 1987-2004) hace lo mismo: `terminalPaymentService.cancelCurrentPayment()` suelto, seguido de `viewModelScope.launch { orderRepository.cancelOrder(orderId).fold(...) }` en un coroutine **aparte**.

Dos firmas cambiaron en el mismo commit-en-progreso y ninguna de las dos se propagó aquí:

1. `TerminalPaymentService.kt:726`: `suspend fun cancelCurrentPayment(): RespuestaDeCancelacion?` — es `suspend` ahora. Llamarla en la línea 1(956|998) de `PaymentFlowViewModel.kt`, dentro de un `fun` normal (no `suspend`, no envuelta en `launch{}`), **es un error de compilación de Kotlin** ("Suspend function should be called only from a coroutine or another suspend function").
2. `OrderRepository.kt` (diff): `cancelOrder()` pasó de devolver `Result<Unit>` a devolver `ResultadoDeCancelarOrden` (sealed class nueva: `Cancelada`, `BloqueadaPorCobro`, `RechazoDeNegocio`, `NoExiste`, `SinRed`, `ErrorDeServidor`). `.onFailure { }` y `.fold(onSuccess=, onFailure=)` son extensiones de `kotlin.Result<T>` — **no existen sobre `ResultadoDeCancelarOrden`**. Segundo error de compilación garantizado, en las mismas dos funciones.

**Y aunque alguien arregle sólo la compilación** (p. ej. envolviendo la llamada en `viewModelScope.launch` y cambiando `.onFailure`/`.fold` por un `when`), el defecto de fondo sigue sin resolverse mientras `cancel()`/`cancelAndExit()` no pasen por `CancelacionDeCobroCoordinator`: **el cancel del cobro y el DELETE de la orden siguen disparándose en corrutinas separadas, sin que el DELETE espere a que conste el desenlace del cancel.** Es exactamente el incidente que el propio código nuevo documenta:

`CancelacionDeCobroCoordinator.kt:62-66`:
```
* 🔴 **El borrado de la orden es BARRERA**: cancel → desenlace acreditado → DELETE, en ese orden y
* nunca en paralelo. El defecto que lo origina (producción, 11-sep-2026) mandaba el cancel y el
* DELETE a la vez: cuando el DELETE llegaba primero, el servidor contestaba 409
* `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`, se mostraba un toast genérico y la orden quedaba
* huérfana — nadie volvía a intentarlo.
```

`PaymentFlowViewModel.kt` inyecta el coordinador (`private val cancelacionDeCobro: CancelacionDeCobroCoordinator` en la línea 103) y lo **consulta** en un solo sitio, `handleStaleCardResult` (línea 1852, sólo lectura de `desenlaceConocido()`), pero **nunca llama `.registrar(...)` ni `.procesarAhora(...)` ni `.start()`** — confirmado con `grep -n "cancelacionDeCobro" PaymentFlowViewModel.kt`, que sólo devuelve esas dos líneas. El coordinador queda como código muerto desde el punto de vista de "qué dispara una cancelación": nadie lo alimenta.

**Escenario de fallo concreto** (el mismo del 11-sep, sin cambios): cajero cobra con tarjeta, toca "Cancelar" antes de que la terminal conteste. `cancel()` dispara `cancelCurrentPayment()` (POST a `/terminal-payment/cancel`) y, en paralelo, `orderRepository.cancelOrder(orderId)` (DELETE a `/orders/:orderId`). Si el DELETE llega al server antes de que el cancel del cobro esté resuelto, el server (con el guard C.6, `assertOrderCancellableUnderLock`) responde 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`. El cliente no interpreta ese código (ni antes ni ahora, en el call site real): `orderRepository.cancelOrder(orderId).onFailure { e -> ... _cancelFailure.value = "No se pudo cancelar la orden: ${e.message}..." }` — un mensaje genérico, sin reintento automático, sin esperar el desenlace del cobro. La orden queda abierta; el cajero ve un toast y probablemente reintenta a mano o se va — la orden huérfana persiste, tal como describe el incidente.

**Por qué las pruebas existentes no lo cazan:** las 505+322+98+129+605 líneas de tests nuevos (`CancelacionDeCobroCoordinatorTest`, `CancelacionDeCobroDecisionTest`, `CancelacionTransportFalso`, `CancelacionesDeCobroStoreTest`, `PaymentFlowCancelacionDurableTest`) prueban el **coordinador aislado** con un `CancelacionTransportFalso` inyectado a mano — nunca instancian `PaymentFlowViewModel` real y ejercitan su `cancel()`/`cancelAndExit()` contra el coordinador. Ninguna prueba verifica que `cancel()` LLAME a `cancelacionDeCobro.registrar(...)`. Es el patrón "se probó la pieza nueva, nunca se probó que quedara conectada" — el mismo patrón que ya cazó una vez esta sesión con `AlmacenQuePuedeFallar`/mocks de lista fija (memoria del repo `mock-de-modulo-con-lista-fija.md`).

**Impacto:** si esto llega a compilar tal cual está (falso — no compila), el defecto de producción del 11-sep seguiría reproducible al 100%. Y en el estado actual, el módulo simplemente no construye.

---

### P1-2 — `CardChargeDecision.fromTerminalStatus` sigue sin mirar `outcome`/`outcomeEvidence` para el camino de REINTENTAR el cobro (a diferencia de `CancelacionDeCobro`, que sí es estricto)

`CardChargeOutcome.kt:273-282`:
```kotlin
private fun fromTerminalStatus(probe: ChargeStatusProbe.Known): CardChargeOutcome =
    when {
        probe.cancelDisposition == "ACTIVE" -> CardChargeOutcome.Undetermined(...)
        probe.status == "COMPLETED" -> CardChargeOutcome.Undetermined(UNDETERMINED_MESSAGE)
        probe.status == "FAILED" -> CardChargeOutcome.NotCharged("El cobro fue rechazado. No se cobró la tarjeta.")
        probe.status == "CANCELLED" && probe.cancelDisposition == "ACCEPTED" -> CardChargeOutcome.NotCharged(...)
        else -> CardChargeOutcome.Undetermined(UNDETERMINED_MESSAGE)
    }
```
Con el `ChargeStatusProbe.Known` ya ampliado (`outcome`, `outcomeEvidence`, `evidenceClass`, `failureCode`, `reconciliationRequired`, `orderId`, `terminalId` — `CardChargeOutcome.kt:19-34`), esta función —la que decide si el POS puede OFRECER reintentar el cobro— **no lee ninguno de esos campos nuevos**. Sigue confiando en que `status == "FAILED"` sólo llega con evidencia.

**Verificado contra el servidor** (`avoqado-server/src/services/terminal-payment.service.ts:1384-1389`) que esto es SEGURO hoy: `closeRow()` degrada cualquier `failed`/`cancelled` SIN `outcomeEvidence` (`PRE_AUTHORIZATION`/`PROCESSOR_DECLINED`) a `status: 'timeout'` **antes** de escribirlo, y `getPaymentStatus` (server `terminal-payment.service.ts:1690-1703`) nunca expone un `CANCELLED` con `cancelDisposition` distinto de `ACCEPTED` — lo traduce a `UNKNOWN` vía `hasUnprovenLegacyOutcome()`. Así que, **hoy**, un `FAILED`/`CANCELLED+ACCEPTED` que llega al cliente ya viene garantizado por el servidor. No es un P1 de dinero en este instante.

**Por qué lo marco igual:** es un acoplamiento implícito y frágil — el cliente depende de una invariante del servidor que no verifica por sí mismo, mientras que 40 líneas más abajo en el MISMO paquete (`CancelacionDeCobro.decidir`, `CancelacionDeCobro.kt:144-168`) sí exige el campo `outcome`/`failureCode` explícitamente para la decisión más peligrosa (borrar una orden). Si el servidor alguna vez relaja esa garantía (o si una versión vieja del servidor la aplicaba distinto), `CardChargeDecision` no tiene defensa propia. Sugerido, no bloqueante: que `fromTerminalStatus` también consulte `outcome`/`outcomeEvidence` cuando estén presentes, igual que ya hace `CancelacionDeCobro`.

---

### P2-1 — `RespuestaDeCancelacion.esTransitoria` trata un 401 como transitorio, pero no hay evidencia de que el flujo de refresco de token se dispare antes del reintento en este camino

`TerminalPaymentService.kt` (`RespuestaDeCancelacion`, campo `esTransitoria`):
```kotlin
val esTransitoria: Boolean get() = http == null || http >= 500 || http == 408 || http == 429 || http == 401
```
El comentario dice "Un 401 entra aquí a propósito (token vencido: transitorio, se resuelve al refrescar la sesión)". La llamada a `pedirCancelacion` usa `statusClient` (cliente corto, 10 s, `FAIL_FAST_HEADER`) — el mismo cliente que en otras partes del archivo se documenta como diseñado para NO esperar un refresh de token con PIN (`TerminalPaymentService.kt:52-59`, comentario sobre `ForbiddenInterceptor`). Si el `Authenticator` de refresco de token (`TokenRefreshAuthenticator`, en `core/data/network`) no está en la cadena de `statusClient`, un 401 por token vencido **nunca se resuelve solo** y el coordinador reintentará indefinidamente con backoff creciente (hasta 300 s, `ESPERA_MAXIMA_MS`) sin que el 401 desaparezca — la cancelación quedaría "pendiente" para siempre en la práctica, aunque la etiqueta que ve el cajero diga `sinRed=false` (que es engañosa: no es falta de red, es sesión vencida).

**No pude verificar** si `statusClient` (que hereda de `baseClient.newBuilder()`) conserva el `.authenticator(tokenRefreshAuthenticator)` del cliente base — `OkHttpClient.newBuilder()` SÍ preserva el `authenticator` configurado en el padre salvo que se sobreescriba explícitamente, y no vi que `statusClient` lo sobreescriba. Si eso es así, el 401 sí se resolvería solo vía el authenticator antes de que la app vea el 401. **Marco esto como P2 con incertidumbre declarada**, no P1, porque la lectura más probable (dado que `statusClient` es un `.newBuilder()` del mismo `baseClient` inyectado que ya trae `tokenRefreshAuthenticator`) es que SÍ se resuelve solo.

---

### P3-1 — El mensaje de "Undetermined" tras cancelar no dice "sin conexión" cuando de verdad no hay red

`CardChargeDecision.UNDETERMINED_MESSAGE` = "Estamos confirmando el cobro. No vuelvas a pasar la tarjeta." se usa tanto para "no se pudo preguntar por falta de red" (`ChargeStatusProbe.Unreachable`) como para "el servidor contestó algo ambiguo". La regla del workspace (`todo-funciona-sin-red.md`) pide que offline sea un ESTADO que se DICE, no un error genérico. Esto no es peligroso (nunca ofrece reintento a ciegas), pero un cajero sin red no sabe si es su WiFi o el servidor. Cosmético, no bloqueante.

## Lo que está BIEN (confirmado contra el árbol y, cuando aplicaba, contra `avoqado-server`)

1. **La llave durable se escribe ANTES del POST.** `TerminalPaymentService.kt:232` (`persistPendingCardCharge` antes de `client.newCall(request).execute()`), y si falla el guardado, se rechaza el envío (`:234`) — cumple el invariante 1 del brief.
2. **`refusedForAnotherRequest` y la correlación del 409 `TERMINAL_BUSY` están bien construidos y bien probados.** `CardChargeOutcome.kt:162-166` exige que `blockingRequestId` sea DISTINTO del propio `requestId`; `TerminalPaymentService.kt` lo usa en el único punto correcto (al CREAR, nunca al consultar). `CardChargeDecisionTest.kt` y `TerminalPaymentServiceHttpTest.kt` cubren: nombra a otra solicitud → libera y NO consulta estado (verificado con `server.requestCount == 1`); nombra a la propia → sigue siendo incertidumbre; sin código o sin blocker → incertidumbre; concurrente con un cancel en vuelo → sigue sin liberar sin correlación.
3. **El servidor gate-ea `FAILED`/`CANCELLED` con evidencia ANTES de persistir**, verificado en `avoqado-server/src/services/terminal-payment.service.ts:1384-1389` y `:1690-1703` — esto hace seguro (hoy) que el cliente confíe en el `status` bruto en `fromTerminalStatus` (ver P1-2 para el matiz).
4. **El código HTTP siempre sale de `response.code` (Int), nunca de parsear texto** — verificado en todo `TerminalPaymentService.kt` (`responseCode in 200..299`, `responseCode == 409`, etc.). No hay ningún `message.contains("4")` ni similar en el paquete `payment`.
5. **Deserialización tolerante a valores desconocidos.** Todos los campos de estado (`status`, `cancelDisposition`, `outcome`, `failureCode`) son `String?` de texto libre, no enums de Kotlin — un valor nuevo del servidor cae al `else -> Undetermined` sin reventar el parseo. `Json { ignoreUnknownKeys = true }` en el cliente cubre además campos nuevos que el cliente no conoce.
6. **`unresolvedRequestId` se consulta ANTES de permitir un cobro nuevo** (`sendPaymentToTerminal`, primera línea: `unresolvedRequestId?.let { return ... inherited = true }`) — bloquea correctamente una segunda autorización mientras hay un cobro sin resolver.
7. **El watchdog de `WAIT_CEILING_MS` (330 s) cierra el socket y fuerza reconciliación en vez de "fallar"** — `sendPaymentToTerminal` línea ~278-289, con `ceilingExceeded.set(true)` + `call.cancel()`, y el catch de abajo lo traduce a `ChargeWaitEnding.CeilingExceeded` → `mustReconcile` → consulta de estado, nunca a un `Error` directo.
8. **`OrderRepository.cancelOrder` ahora sí distingue el 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`** de un 400 (cuenta pagada) o un 404 (ya no existe), vía `leerCancelacionDeOrden` (función PURA, fácil de testear por caso) — la pieza de datos está bien hecha; lo que falta es que el `ViewModel` la use (P1-1).

## Lo que NO pude verificar

- **No corrí `./gradlew compileDebugKotlin`** (fuera de alcance del brief: sólo lectura, sin gradle). Mi afirmación de "no compila" en P1-1 es un análisis de tipos manual (firma `suspend` vs llamada no-suspend; `ResultadoDeCancelarOrden` vs `.onFailure`/`.fold` de `kotlin.Result`), no una corrida real del compilador. Alta confianza, pero no es la misma garantía que un build.
- **`CancelarOrdenHttpTest.kt`, `TerminalPaymentCancelacionHttpTest.kt`, `CuarentenaCobroVivoTest.kt`, `CobroVivoBloqueaAnularTest.kt`**: no los leí a fondo por presupuesto de tiempo frente a la velocidad de cambio del árbol; es posible que alguno de estos ejercite justamente el call site de `PaymentFlowViewModel.cancel()` que yo marco como roto, lo cual reforzaría (o, si pasa en verde, contradiría — y ahí valdría la pena mirar si el mock oculta el problema de tipos) el hallazgo P1-1.
- **Si `statusClient.authenticator` hereda el refresco de token del `baseClient`** (P2-1): no encontré el punto donde `NetworkModule.provideOkHttpClient` construye el cliente base para confirmarlo con certeza en el tiempo disponible; until then lo dejo como incertidumbre declarada.
- **El estado de `app/src/main/java/com/avoqado/pos/core/data/network/ServerErrorText.kt`** (aparece modificado en el diff final): no lo leí; no sé si es un cambio relevante al circuito de cobro o accesorio.
- **El estado FINAL del árbol al momento en que esto se lea.** Dado lo activo que estaba el commit en progreso (6 cambios de estado observados en ~10 minutos), es razonable esperar que P1-1 pueda estar ya resuelto para cuando el founder o el resto del equipo lean este informe. **Recomendación operativa: antes de actuar sobre P1-1, releer `PaymentFlowViewModel.kt:cancel()` y `:cancelAndExit()` contra el árbol vigente** — si ya llaman a `cancelacionDeCobro.registrar(...)`/`.procesarAhora(...)` y usan un `when` sobre `ResultadoDeCancelarOrden`, el hallazgo está cerrado.
