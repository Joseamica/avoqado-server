# Cobro resiliente en red lenta — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un cobro con 3G o internet inestable pase igual, y que la pantalla nunca mienta sobre lo que está ocurriendo — sin reordenar el flujo del dinero.

**Architecture:** Tres componentes aditivos sobre el camino de cobro existente. Un observador de duración que sólo publica avisos de UI (nunca cancela nada), un blindaje de corrutina alrededor del registro, y telemetría diferida que viaja a cuestas del heartbeat. Ninguno reordena llamadas ni muta banderas del flujo.

**Tech Stack:** Kotlin, Jetpack Compose, Hilt, Room, OkHttp/Retrofit, Coroutines. Terminales PAX A910S (SDK Blumon) y NEXGO N86 (SDK AngelPay).

**Spec:** `docs/superpowers/specs/2026-08-06-tpv-cobro-resiliente-red-lenta-design.md`

## Global Constraints

- **Repo:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-tpv`, rama `main`. Task 5 también toca `avoqado-server` (`develop`).
- **Cero bytes nuevos en la ventana del cobro.** Nada manda tráfico de red mientras hay una tarjeta en juego.
- **El camino feliz queda byte-idéntico** en comportamiento: mismos estados, mismos tiempos, misma pantalla de éxito.
- **El vigilante NUNCA cancela la llamada del SDK.** Si el procesador aprobó y abandonamos, hay dinero movido que la app no conoce. Prohibido por diseño.
- **`PaymentViewModel.kt` de `production` y `sandbox` deben quedar byte-idénticos en el bloque tocado.** Verificar con `diff` antes de cada commit.
- **Esto toca "Cobrar" con autorización explícita del founder**, acotado a observación. No tocar `core/data/local/AvoqadoDatabase.kt`, `features/payment/domain/sync/SyncOutcome.kt`, ni `emv/`.
- Dinero es `BigDecimal` en pesos 1:1 — nunca `Double`, nunca centavos.
- **Sin commits sin permiso del founder.** Hay trabajo en curso suyo en `features/payment/**`, `emv/`, `features/ordering/presentation/menu/MenuViewModel.kt` — no tocar, revertir ni limpiar nada que no hayas escrito. Nunca `git add -A`, `git checkout .`, ni `git reset --hard`.
- **Build:** `export JAVA_HOME=$(/usr/libexec/java_home -v 23)`. Antes de cada Gradle: `pgrep -fl "GradleDaemon|KotlinCompileDaemon"` más CPU real — daemons ociosos a ~0% no bloquean, compilaciones activas sí. Los builds tardan minutos.
- **Kotlin anida comentarios de bloque**: un `/*` dentro de un KDoc (por ejemplo una ruta con glob) rompe el build con "Unclosed comment". Ya pasó en tres archivos de este repo.
- **Cada task termina con pasada de sabotaje**: romper lo que cada test protege, confirmar rojo, restaurar. El verde no es evidencia — en este proyecto una ronda de sabotaje pasó en falso porque el test no afirmaba el campo de dinero.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `features/payment/domain/AuthorizationWatchdog.kt` (nuevo) | Lógica pura: dado un tiempo transcurrido, ¿qué nivel de aviso corresponde? Sin corrutinas, sin Android, testeable en JVM. |
| `features/payment/domain/PaymentState.kt` (modificar) | Campo aditivo opcional para el aviso del vigilante en el estado de espera. |
| `features/payment/presentation/angelpay/AngelPayPaymentState.kt` (modificar) | Lo mismo para el riel AngelPay. |
| `PaymentViewModel.kt` production + sandbox (modificar) | Arrancar/parar el observador alrededor de la autorización Blumon. |
| `AngelPayPaymentViewModel.kt` (modificar) | Lo mismo para AngelPay; además envolver el registro en `NonCancellable`. |
| `features/payment/data/local/AuthAttemptTelemetryDao.kt` (nuevo) | Persistencia mínima de intentos de autorización. |
| `core/data/network/dto/HeartbeatDto.kt` (modificar) | Campo opcional aditivo con el lote de telemetría. |
| `avoqado-server: src/schemas/tpv.schema.ts` + servicio de heartbeat (modificar) | Aceptar y persistir el campo opcional. |

---

## Task 1: `AuthorizationWatchdog` — la lógica pura

Empezamos por lo que no toca nada: una función pura que traduce "llevo N milisegundos autorizando" en "qué le digo al cajero". Aislarla aquí hace que las tasks siguientes sólo tengan que cablearla.

**Files:**
- Create: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/AuthorizationWatchdog.kt`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/AuthorizationWatchdogTest.kt`

**Interfaces:**
- Produces: `enum class AuthWatchdogLevel { NONE, SLOW, VERY_SLOW }` y `fun authWatchdogLevel(elapsedMillis: Long): AuthWatchdogLevel`; constantes `AUTH_SLOW_THRESHOLD_MS = 8_000L` y `AUTH_VERY_SLOW_THRESHOLD_MS = 25_000L`. Las tasks 2 y 3 consumen exactamente estos nombres.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class AuthorizationWatchdogTest {

    @Test
    fun `antes del umbral no hay aviso`() {
        assertEquals(AuthWatchdogLevel.NONE, authWatchdogLevel(0L))
        assertEquals(AuthWatchdogLevel.NONE, authWatchdogLevel(7_999L))
    }

    @Test
    fun `a los 8 segundos avisa que sigue procesando`() {
        assertEquals(AuthWatchdogLevel.SLOW, authWatchdogLevel(8_000L))
        assertEquals(AuthWatchdogLevel.SLOW, authWatchdogLevel(24_999L))
    }

    @Test
    fun `a los 25 segundos escala a aviso fuerte`() {
        assertEquals(AuthWatchdogLevel.VERY_SLOW, authWatchdogLevel(25_000L))
        assertEquals(AuthWatchdogLevel.VERY_SLOW, authWatchdogLevel(600_000L))
    }

    @Test
    fun `un elapsed negativo no rompe y no avisa`() {
        // Un reloj que retrocede (cambio de hora, NTP) no debe disparar avisos.
        assertEquals(AuthWatchdogLevel.NONE, authWatchdogLevel(-1L))
    }
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `export JAVA_HOME=$(/usr/libexec/java_home -v 23) && ./gradlew testSandboxDebugUnitTest --tests "*AuthorizationWatchdogTest*"`
Expected: FAIL — no existe el símbolo `authWatchdogLevel`.

- [ ] **Step 3: Implementar**

```kotlin
package com.jaac.avoqado_tpv.features.payment.domain

/**
 * Traduce cuánto lleva la autorización en qué avisarle al cajero.
 *
 * 🔴 Esto NO cancela nada. La autorización del SDK sigue viva hasta que
 * responda: si el procesador aprobó y nosotros abandonáramos, habría dinero
 * movido que la app no conoce. Este archivo sólo decide texto de pantalla.
 */
enum class AuthWatchdogLevel { NONE, SLOW, VERY_SLOW }

/** A los 8s el cajero ya cree que se colgó. */
const val AUTH_SLOW_THRESHOLD_MS = 8_000L

/** A los 25s hay que decirle explícitamente que NO vuelva a cobrar. */
const val AUTH_VERY_SLOW_THRESHOLD_MS = 25_000L

fun authWatchdogLevel(elapsedMillis: Long): AuthWatchdogLevel = when {
    elapsedMillis >= AUTH_VERY_SLOW_THRESHOLD_MS -> AuthWatchdogLevel.VERY_SLOW
    elapsedMillis >= AUTH_SLOW_THRESHOLD_MS -> AuthWatchdogLevel.SLOW
    else -> AuthWatchdogLevel.NONE
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `./gradlew testSandboxDebugUnitTest --tests "*AuthorizationWatchdogTest*"`
Expected: PASS, 4/4.

- [ ] **Step 5: Sabotaje**

Cambia `>= AUTH_SLOW_THRESHOLD_MS` por `> AUTH_SLOW_THRESHOLD_MS`. Corre los tests: debe fallar exactamente `a los 8 segundos avisa que sigue procesando` (el caso del borde `8_000L`). Restaura y confirma verde. **Reporta el rojo** — sin él no hay evidencia.

- [ ] **Step 6: Commit** _(sólo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/AuthorizationWatchdog.kt app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/AuthorizationWatchdogTest.kt
git commit -m "feat(pagos): logica pura del vigilante de autorizacion"
```

---

## Task 2: Cablear el vigilante en el riel Blumon (PAX)

**Files:**
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/PaymentState.kt` (el estado de espera de tarjeta/autorización — `DetectingCard` está en `:350`, verifica cuál estado cubre la ventana de autorización antes de editar)
- Modify: `app/src/production/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt`
- Modify: `app/src/sandbox/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModelWatchdogTest.kt`

**Interfaces:**
- Consumes: `authWatchdogLevel(elapsedMillis)`, `AuthWatchdogLevel`, `AUTH_SLOW_THRESHOLD_MS`, `AUTH_VERY_SLOW_THRESHOLD_MS` de Task 1.
- Produces: un campo aditivo opcional en el estado de espera (nombre sugerido `watchdogLevel: AuthWatchdogLevel = AuthWatchdogLevel.NONE`) que Task 4 lee para pintar.

**Antes de escribir código:** abre `PaymentViewModel.kt` (production) y localiza dónde arranca la autorización del SDK y dónde llega su resultado. El flujo está documentado en el KDoc de `:158`: `PreTrans → DetectCard → StartEmvTrans → SaleIcc (ONLINE) → CompleteEmvTrans`. El observador arranca cuando empieza la llamada online y se detiene **en un `finally` que cubra todas las salidas** (éxito, declinación, error, cancelación). Un observador que no se apaga es una fuga.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.presentation

import com.jaac.avoqado_tpv.features.payment.domain.AuthWatchdogLevel
import io.mockk.clearMocks
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PaymentViewModelWatchdogTest {

    // ⚠️ StandardTestDispatcher, NO UnconfinedTestDispatcher: con Unconfined el
    // trabajo del init corre antes del verify y el test pasa en falso. Ya nos
    // mordio una vez en este repo.

    @Test
    fun `una autorizacion rapida nunca muestra aviso`() = runTest(StandardTestDispatcher()) {
        val vm = buildViewModelWithPendingAuthorization()
        advanceTimeBy(3_000L)
        assertEquals(AuthWatchdogLevel.NONE, vm.currentWatchdogLevel())
        completeAuthorization(vm)
        assertEquals(AuthWatchdogLevel.NONE, vm.currentWatchdogLevel())
    }

    @Test
    fun `a los 8 segundos sin respuesta aparece el aviso`() = runTest(StandardTestDispatcher()) {
        val vm = buildViewModelWithPendingAuthorization()
        advanceTimeBy(8_100L)
        assertEquals(AuthWatchdogLevel.SLOW, vm.currentWatchdogLevel())
    }

    @Test
    fun `a los 25 segundos escala`() = runTest(StandardTestDispatcher()) {
        val vm = buildViewModelWithPendingAuthorization()
        advanceTimeBy(25_100L)
        assertEquals(AuthWatchdogLevel.VERY_SLOW, vm.currentWatchdogLevel())
    }

    @Test
    fun `el vigilante NUNCA cancela la autorizacion`() = runTest(StandardTestDispatcher()) {
        // El invariante de dinero: pase lo que pase con el reloj, la llamada
        // del SDK sigue viva. Si el procesador aprobo y abandonamos, hay dinero
        // movido que la app no conoce.
        val vm = buildViewModelWithPendingAuthorization()
        advanceTimeBy(120_000L)
        assertEquals(true, authorizationCallStillActive(vm))
    }

    @Test
    fun `al terminar la autorizacion el observador se apaga`() = runTest(StandardTestDispatcher()) {
        val vm = buildViewModelWithPendingAuthorization()
        advanceTimeBy(9_000L)
        completeAuthorization(vm)
        advanceTimeBy(60_000L)
        // Sin fuga: ya no debe seguir escalando despues de terminar.
        assertEquals(AuthWatchdogLevel.NONE, vm.currentWatchdogLevel())
    }
}
```

> **Nota para el implementador:** los helpers `buildViewModelWithPendingAuthorization()`, `completeAuthorization(vm)`, `authorizationCallStillActive(vm)` y `currentWatchdogLevel()` los defines tú según cómo esté construido `PaymentViewModel` en este repo — mira `PaymentViewModelTest.kt` existente, que ya resuelve la construcción del ViewModel con sus dependencias mockeadas y usa reflexión para leer estado privado. Reusa ese patrón; no inventes uno nuevo. Usa `clearMocks` y `verify(exactly = 1)` donde verifiques llamadas.

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testSandboxDebugUnitTest --tests "*PaymentViewModelWatchdogTest*"`
Expected: FAIL — no existe `currentWatchdogLevel`.

- [ ] **Step 3: Agregar el campo aditivo al estado**

En `PaymentState.kt`, al estado que cubre la ventana de autorización, agrega un parámetro **con valor por defecto** para no romper ningún constructor existente:

```kotlin
    // Aviso del vigilante de autorizacion. Por defecto NONE: en el camino
    // feliz nadie lo ve y el comportamiento queda byte-identico.
    val watchdogLevel: AuthWatchdogLevel = AuthWatchdogLevel.NONE,
```

- [ ] **Step 4: Cablear el observador en production**

En `PaymentViewModel.kt` (production), alrededor de la llamada de autorización online:

```kotlin
        // 🔴 OBSERVADOR, NO TIMEOUT. Corre en paralelo y sólo publica avisos de
        // UI. Jamás cancela la autorización: si el procesador aprobó y
        // abandonáramos, habría dinero movido que la app no conoce.
        val watchdogStartedAt = System.currentTimeMillis()
        val watchdogJob = viewModelScope.launch {
            while (isActive) {
                delay(1_000L)
                val level = authWatchdogLevel(System.currentTimeMillis() - watchdogStartedAt)
                if (level != AuthWatchdogLevel.NONE) publishWatchdogLevel(level)
            }
        }
        try {
            // ... la llamada de autorización existente, SIN CAMBIOS ...
        } finally {
            // Cubre éxito, declinación, error y cancelación. Un observador que
            // no se apaga es una fuga que sigue escalando avisos sobre una
            // pantalla que ya cambió.
            watchdogJob.cancel()
            publishWatchdogLevel(AuthWatchdogLevel.NONE)
        }
```

- [ ] **Step 5: Replicar byte-idéntico en sandbox**

Aplica exactamente el mismo bloque en `app/src/sandbox/.../PaymentViewModel.kt`. Verifica:

```bash
diff <(sed -n '<inicio>,<fin>p' app/src/production/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt) \
     <(sed -n '<inicio>,<fin>p' app/src/sandbox/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt)
```
Expected: sin diferencias.

- [ ] **Step 6: Correr los tests**

Run: `./gradlew testSandboxDebugUnitTest --tests "*PaymentViewModel*"`
Expected: PASS — los nuevos y **toda la suite previa de `PaymentViewModelTest`**, que es el termómetro de que el camino feliz no cambió.

- [ ] **Step 7: Sabotaje**

Tres rondas, restaurando byte-idéntico entre cada una:
1. Quita el `watchdogJob.cancel()` del `finally` → debe fallar `al terminar la autorizacion el observador se apaga`.
2. Cambia el observador para que llame a `cancel()` sobre la corrutina de autorización → debe fallar `el vigilante NUNCA cancela la autorizacion`. **Ésta es la ronda que más importa**: es el invariante de dinero.
3. Arranca el observador con `watchdogStartedAt` fijo en 0 → debe fallar `una autorizacion rapida nunca muestra aviso`.

Reporta los tres rojos.

- [ ] **Step 8: Commit** _(sólo con permiso del founder)_

---

## Task 3: Cablear el vigilante en el riel AngelPay (NEXGO)

Mismo componente, otro riel. Va en su propia task porque un revisor podría aprobar Blumon y rechazar éste — son máquinas de estado distintas.

**Files:**
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentState.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayWatchdogTest.kt`

**Interfaces:**
- Consumes: lo mismo que Task 2.
- Produces: campo aditivo `watchdogLevel: AuthWatchdogLevel = AuthWatchdogLevel.NONE` en el estado de espera de AngelPay.

**Contexto que necesitas:** en AngelPay la autorización pasa por `createPaymentIntent()` del SDK y el resultado vuelve por `ActivityResult`. La espera del **registro** (`RecordingPayment`, `:1923` y `:2017`) es **otra cosa** y **no se toca en esta task** — ésa es la que bloquea la UI y tiene su propio diseño pendiente. Aquí sólo observas la ventana de autorización.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.presentation.angelpay

import com.jaac.avoqado_tpv.features.payment.domain.AuthWatchdogLevel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AngelPayWatchdogTest {

    @Test
    fun `autorizacion rapida sin aviso`() = runTest(StandardTestDispatcher()) {
        val vm = buildAngelPayViewModelAwaitingAuthorization()
        advanceTimeBy(3_000L)
        assertEquals(AuthWatchdogLevel.NONE, vm.currentWatchdogLevel())
    }

    @Test
    fun `a los 8 segundos aparece el aviso`() = runTest(StandardTestDispatcher()) {
        val vm = buildAngelPayViewModelAwaitingAuthorization()
        advanceTimeBy(8_100L)
        assertEquals(AuthWatchdogLevel.SLOW, vm.currentWatchdogLevel())
    }

    @Test
    fun `el vigilante no cancela la autorizacion de AngelPay`() = runTest(StandardTestDispatcher()) {
        val vm = buildAngelPayViewModelAwaitingAuthorization()
        advanceTimeBy(120_000L)
        assertEquals(true, angelPayAuthorizationStillActive(vm))
    }

    @Test
    fun `el observador no toca el estado RecordingPayment`() = runTest(StandardTestDispatcher()) {
        // RecordingPayment es la espera del REGISTRO, no de la autorizacion.
        // El vigilante no debe escribir sobre ella: tiene su propio diseño.
        val vm = buildAngelPayViewModelInRecordingPayment()
        advanceTimeBy(60_000L)
        assertEquals(true, vm.stateIsStillRecordingPayment())
    }
}
```

> Los helpers los defines siguiendo el patrón de `AngelPayPaymentViewModelTest.kt` (1806 líneas), que ya construye el ViewModel con sus mocks.

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testSandboxDebugUnitTest --tests "*AngelPayWatchdogTest*"`
Expected: FAIL.

- [ ] **Step 3: Agregar el campo aditivo y cablear**

Mismo patrón que Task 2: campo con default en el estado, observador con `try/finally` alrededor de la ventana de autorización, `publishWatchdogLevel` que sólo escribe si el estado actual **es** el de espera de autorización (nunca sobre `RecordingPayment` ni sobre un estado terminal).

- [ ] **Step 4: Correr los tests**

Run: `./gradlew testSandboxDebugUnitTest --tests "*AngelPay*"`
Expected: PASS — incluidos los tests existentes de `chargeAttemptActive` (`:1352`, `:1391`) y los del ledger de registro (`:1062`, `:1098`), que son el termómetro de este riel.

- [ ] **Step 5: Sabotaje**

Dos rondas: (a) hacer que el observador escriba sobre `RecordingPayment` → debe fallar `el observador no toca el estado RecordingPayment`; (b) hacer que cancele la autorización → debe fallar el test del invariante. Restaura y reporta los rojos.

- [ ] **Step 6: Commit** _(sólo con permiso del founder)_

---

## Task 4: Pintar los avisos en pantalla

**Files:**
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentScreen.kt`
- Modify: la pantalla de AngelPay que renderiza el estado de autorización (localízala desde `AngelPayPaymentState`)
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/WatchdogCopyTest.kt`

**Interfaces:**
- Consumes: `AuthWatchdogLevel` del estado, de Tasks 2 y 3.
- Produces: `fun watchdogMessage(level: AuthWatchdogLevel): String?` — pura, testeable sin Compose.

**El texto importa más que el código.** Un mensaje que no dice qué hacer no sirve. La regla del repo: nunca pintar un éxito encolado como error, y nunca mostrarle al cajero el error crudo del proveedor.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.presentation

import com.jaac.avoqado_tpv.features.payment.domain.AuthWatchdogLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchdogCopyTest {

    @Test
    fun `sin aviso no hay mensaje`() {
        assertNull(watchdogMessage(AuthWatchdogLevel.NONE))
    }

    @Test
    fun `el aviso lento pide no retirar la tarjeta`() {
        val msg = watchdogMessage(AuthWatchdogLevel.SLOW)!!
        assertTrue(msg.contains("no retires", ignoreCase = true))
    }

    @Test
    fun `el aviso fuerte instruye NO volver a cobrar`() {
        // Es la instruccion que evita el doble cobro: un cajero que ve un
        // spinner mudo vuelve a cobrar; uno que lee esto, espera.
        val msg = watchdogMessage(AuthWatchdogLevel.VERY_SLOW)!!
        assertTrue(msg.contains("no cobres de nuevo", ignoreCase = true))
    }

    @Test
    fun `ningun mensaje sugiere que el cobro fallo`() {
        // El cobro puede estar aprobandose en este momento. Decir "error"
        // aqui seria mentir sobre dinero en vuelo.
        listOf(AuthWatchdogLevel.SLOW, AuthWatchdogLevel.VERY_SLOW).forEach { level ->
            val msg = watchdogMessage(level)!!.lowercase()
            assertTrue(!msg.contains("error"))
            assertTrue(!msg.contains("fall"))
            assertTrue(!msg.contains("rechaz"))
        }
    }
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testSandboxDebugUnitTest --tests "*WatchdogCopyTest*"`
Expected: FAIL.

- [ ] **Step 3: Implementar el copy y renderizarlo**

```kotlin
fun watchdogMessage(level: AuthWatchdogLevel): String? = when (level) {
    AuthWatchdogLevel.NONE -> null
    AuthWatchdogLevel.SLOW ->
        "Sigue procesando… no retires la tarjeta"
    AuthWatchdogLevel.VERY_SLOW ->
        "La red está lenta. NO cobres de nuevo: revisa el resultado en Pagos antes de reintentar"
}
```

Renderízalo como banda no bloqueante bajo el indicador existente. **Contraste**: usa `onSurface` sobre el fondo del contenedor — en este repo un aviso quedó en 1.96:1 y hubo que subirlo a 16.17:1 para que se leyera en la terminal. No introduzcas colores nuevos; reusa los tokens del tema.

- [ ] **Step 4: Correr los tests**

Run: `./gradlew testSandboxDebugUnitTest --tests "*WatchdogCopyTest*"`
Expected: PASS, 4/4.

- [ ] **Step 5: Sabotaje**

Cambia el mensaje fuerte a "Error de red" → deben fallar `el aviso fuerte instruye NO volver a cobrar` y `ningun mensaje sugiere que el cobro fallo`. Restaura, confirma verde, reporta los rojos.

- [ ] **Step 6: Commit** _(sólo con permiso del founder)_

---

## Task 5: `NonCancellable` en el registro

Independiente de las anteriores. Es el hueco de dinero que encontró la auditoría: si el proceso muere a media reintento (hasta 5 con backoff, ~67.5 s peor caso), el cobro puede saltarse la cola offline — dinero cobrado, sin registro y sin encolar.

**Files:**
- Modify: `app/src/production/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt:658`, `:4737`, `:5235`, `:6241`
- Modify: `app/src/sandbox/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt:665`, `:5354`, `:5852`, `:6841`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt:1567`, `:1969`, `:2063`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/usecase/RecordPaymentNonCancellableTest.kt`

**Interfaces:**
- Consumes: `RecordPaymentUseCase.invoke(...)` (`RecordPaymentUseCase.kt:146`).
- Produces: nada nuevo — sólo blindaje.

**Verifica primero**: los números de línea son de hoy y el archivo cambia. Localiza los call sites con `grep -n "recordPaymentUseCase(" <archivo>` antes de editar.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.domain.usecase

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RecordPaymentNonCancellableTest {

    @Test
    fun `cancelar el scope a media grabacion no impide encolar`() = runTest(StandardTestDispatcher()) {
        // El escenario real: el proceso muere mientras reintenta (hasta 5
        // intentos, ~67.5s peor caso). Sin NonCancellable el cobro se pierde:
        // dinero cobrado, sin registro y sin fila en la cola.
        val harness = buildRecordingHarnessThatFailsThenGetsCancelled()
        harness.startRecording()
        harness.cancelScopeMidRetry()
        harness.awaitSettled()
        assertTrue(harness.paymentWasEnqueued())
    }

    @Test
    fun `CancellationException se relanza y no se traga`() {
        // CancellationException es RuntimeException en Kotlin: un
        // catch(Exception) se la come y rompe la cancelacion estructurada.
        val harness = buildRecordingHarness()
        var rethrown = false
        try {
            harness.recordAndThrow(CancellationException("test"))
        } catch (e: CancellationException) {
            rethrown = true
        }
        assertTrue(rethrown)
    }
}
```

> Construye el harness siguiendo `PaymentSyncWorkerTest.kt` y `PendingPaymentEnqueueTest.kt`, que ya montan la cola con sus mocks.

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testSandboxDebugUnitTest --tests "*RecordPaymentNonCancellableTest*"`
Expected: FAIL — hoy la cancelación se lleva la grabación.

- [ ] **Step 3: Envolver cada call site**

```kotlin
                val result = withContext(NonCancellable + Dispatchers.IO) {
                    recordPaymentUseCase(
                        // ... los mismos argumentos, SIN CAMBIOS ...
                    )
                }
```

Y donde se atrape el error, relanzar la cancelación **antes** del catch general:

```kotlin
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // ... manejo existente ...
                }
```

- [ ] **Step 4: Correr los tests**

Run: `./gradlew testSandboxDebugUnitTest --tests "*Payment*"`
Expected: PASS — incluida toda la suite existente de pagos y cola.

- [ ] **Step 5: Verificar paridad entre flavors**

```bash
diff <(grep -A6 "recordPaymentUseCase(" app/src/production/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt) \
     <(grep -A6 "recordPaymentUseCase(" app/src/sandbox/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt)
```
Expected: sin diferencias en el bloque tocado.

- [ ] **Step 6: Sabotaje**

Quita el `NonCancellable` de un call site → debe fallar `cancelar el scope a media grabacion no impide encolar`. Quita el rethrow de `CancellationException` → debe fallar el segundo test. Restaura ambos, confirma verde, reporta los rojos.

- [ ] **Step 7: Commit** _(sólo con permiso del founder)_

---

## Task 6: Telemetría de la pata invisible

Un cobro que nunca se autorizó por falta de red no deja rastro ni en `Payment` ni en `ProviderEventLog`. Esta task crea ese rastro.

**Files:**
- Create: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/local/AuthAttemptEntity.kt`
- Create: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/local/AuthAttemptDao.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/network/dto/HeartbeatDto.kt:35-50`
- Modify: el repositorio que arma el heartbeat (localízalo desde `HeartbeatRequestDto`)
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/AuthAttemptTelemetryTest.kt`

**Interfaces:**
- Consumes: `AuthWatchdogLevel` (Task 1) sólo para contexto; el dato real es el código del SDK y la duración.
- Produces: campo opcional `authAttempts: List<AuthAttemptDto>? = null` en `HeartbeatRequestDto`.

**Dónde guardarlo:** Room. **No toques `AvoqadoDatabase`** — está migrada en paralelo en otra rama y es la base del dinero. Usa una base propia como se hizo con el outbox de Mesas (`TablesDatabase`, v1), o la base de Mesas si aplica. Decide y documenta por qué.

**Privacidad:** sólo código de resultado, duración en ms, riel y timestamp. **Sin datos de tarjeta, sin montos, sin referencias.**

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthAttemptTelemetryTest {

    @Test
    fun `un intento fallido de red se registra con su codigo y duracion`() {
        val store = buildTelemetryStore()
        store.record(code = "N400", durationMs = 12_400L, rail = "BLUMON")
        val batch = store.drainBatch()
        assertEquals(1, batch.size)
        assertEquals("N400", batch[0].code)
        assertEquals(12_400L, batch[0].durationMs)
    }

    @Test
    fun `no se reporta mientras hay un cobro activo`() {
        // Invariante del spec: cero bytes nuevos en la ventana del cobro.
        val store = buildTelemetryStore()
        store.record(code = "N402", durationMs = 30_000L, rail = "ANGELPAY")
        assertEquals(null, store.batchForHeartbeat(chargeInProgress = true))
        assertTrue(store.batchForHeartbeat(chargeInProgress = false)!!.isNotEmpty())
    }

    @Test
    fun `la telemetria no guarda datos de tarjeta ni montos`() {
        val store = buildTelemetryStore()
        store.record(code = "S000", durationMs = 900L, rail = "BLUMON")
        val json = store.drainBatch().first().toString().lowercase()
        listOf("pan", "card", "amount", "monto", "reference").forEach {
            assertTrue("la telemetria filtro '$it'", !json.contains(it))
        }
    }

    @Test
    fun `el lote se limita para no crecer sin control`() {
        val store = buildTelemetryStore()
        repeat(500) { store.record(code = "N400", durationMs = 1_000L, rail = "BLUMON") }
        assertTrue(store.drainBatch().size <= 100)
    }
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testSandboxDebugUnitTest --tests "*AuthAttemptTelemetryTest*"`
Expected: FAIL.

- [ ] **Step 3: Implementar entidad, DAO y el campo aditivo del heartbeat**

En `HeartbeatDto.kt`, agregar **con default null** para que ningún cliente viejo se rompa:

```kotlin
    @SerializedName("authAttempts")
    val authAttempts: List<AuthAttemptDto>? = null
```

- [ ] **Step 4: Registrar los intentos en ambos rieles**

Donde llega el resultado de la autorización (los mismos puntos que Task 2 y 3), registrar código y duración. **Fire-and-forget**: un fallo de telemetría jamás debe afectar el cobro.

- [ ] **Step 5: Correr los tests**

Run: `./gradlew testSandboxDebugUnitTest --tests "*AuthAttempt*"`
Expected: PASS, 4/4.

- [ ] **Step 6: Sabotaje**

Quita el guard de `chargeInProgress` → debe fallar `no se reporta mientras hay un cobro activo`. Quita el tope del lote → debe fallar el test de límite. Restaura y reporta los rojos.

- [ ] **Step 7: Commit** _(sólo con permiso del founder)_

---

## Task 7: El server acepta la telemetría

**Files:**
- Modify: `avoqado-server: src/schemas/tpv.schema.ts` (el schema del heartbeat)
- Modify: el servicio de heartbeat de `/tpv`
- Test: `avoqado-server: tests/unit/schemas/` (sigue el patrón de los tests de schema existentes)

**Interfaces:**
- Consumes: el campo `authAttempts` que produce Task 6.

**Reglas del server:** mensajes Zod en español, sólo forma y formato. `authContext`, nunca `req.user`. Toda consulta filtra por `venueId`. **Aditivo**: los heartbeats que no manden el campo deben seguir pasando igual.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { heartbeatSchema } from '../../../src/schemas/tpv.schema'

describe('heartbeat con telemetría de autorización', () => {
  const base = {
    body: { terminalId: 'AVQD-2841548417', timestamp: new Date().toISOString(), status: 'ACTIVE' },
  }

  it('acepta el lote de intentos y lo conserva', () => {
    const r = heartbeatSchema.safeParse({
      ...base,
      body: { ...base.body, authAttempts: [{ code: 'N400', durationMs: 12400, rail: 'BLUMON' }] },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.authAttempts?.[0].code).toBe('N400')
  })

  it('un cliente viejo sin el campo sigue pasando', () => {
    // Nunca romper APKs instaladas: el campo es opcional.
    expect(heartbeatSchema.safeParse(base).success).toBe(true)
  })

  it('rechaza un lote absurdamente grande', () => {
    const many = Array.from({ length: 5000 }, () => ({ code: 'N400', durationMs: 1000, rail: 'BLUMON' }))
    const r = heartbeatSchema.safeParse({ ...base, body: { ...base.body, authAttempts: many } })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd avoqado-server && npx jest tests/unit/schemas`
Expected: FAIL.

- [ ] **Step 3: Agregar el campo opcional al schema y persistirlo**

- [ ] **Step 4: Correr el gate del server**

Run: `npm run test:unit` y `npm run audit:permissions`
Expected: PASS y exit 0. Nota: `npm run test:unit -- <path>` concatena al argumento del script y corre la suite completa (~7900 tests); usa `npx jest <path>` para uno solo. La suite tiene flakiness conocida dependiente del orden — si algo falla, córrelo aislado antes de concluir que es tuyo.

- [ ] **Step 5: Sabotaje**

Quita el `.optional()` del campo → debe fallar `un cliente viejo sin el campo sigue pasando`. Quita el `.max()` del arreglo → debe fallar el test del lote grande. Restaura y reporta los rojos.

- [ ] **Step 6: Commit** _(sólo con permiso del founder)_

---

## Task 8: Verificación en hardware real

Sin esto nada de lo anterior está probado. Los tests no ven una pantalla.

**Files:** ninguno — es verificación.

- [ ] **Step 1: Compilar los tres flavors**

Run: `./gradlew assembleSandboxDebug assembleProductionDebug assembleNexgoDebug`
Expected: BUILD SUCCESSFUL los tres.

- [ ] **Step 2: Instalar en PAX y verificar el vigilante**

Dispositivo `2841548417` (flavor sandbox). **Avisa antes de instalar.** Degrada la red según la receta del repo (`docs`/reglas de offline-first: `flaky-proxy.mjs` en modo `DROP_RESPONSE`, o `-Pavoqado.devBaseUrl` a un puerto muerto para la pata 2). Inicia un cobro y confirma:
- a los ~8 s aparece "Sigue procesando… no retires la tarjeta"
- a los ~25 s escala al aviso fuerte
- **la autorización sigue viva** — cuando la red vuelve, el cobro completa normal

⚠️ **Nunca apagues el WiFi del dispositivo**: es su único transporte adb y tumbarlo le cuesta al founder una reconexión física.

- [ ] **Step 3: Instalar en NEXGO y repetir**

Dispositivo `N86` (flavor nexgo). Mismo recorrido. Captura pantalla en tema claro y oscuro; guarda en `.superpowers/sdd/.../screenshots/` con prefijo `watchdog-`.

- [ ] **Step 4: Verificar el blindaje de la cola en hardware**

Con el registro fallando, mata el proceso de la app a media grabación (`adb shell am force-stop`) y confirma en la base local que **quedó fila en la cola**:

```bash
adb -s <device> shell "run-as com.jaac.avoqado_tpv.sandbox cat databases/avoqado_database" > /tmp/db.sqlite
# ⚠️ jala también -wal y -shm o lees datos viejos
sqlite3 /tmp/db.sqlite "SELECT id, amount, sync_status, order_id FROM pending_payments ORDER BY id DESC LIMIT 3;"
```

- [ ] **Step 5: Verificar la telemetría de punta a punta**

Provoca un fallo de red durante la autorización, restaura la red, espera un heartbeat, y confirma en producción que llegó:

```bash
psql "$DATABASE_URL" -c "SELECT ... FROM <tabla de telemetría> WHERE \"terminalId\" = ... ORDER BY \"createdAt\" DESC LIMIT 5;"
```

- [ ] **Step 6: Confirmar que el camino feliz no cambió**

Un cobro normal con red buena, en ambas terminales: **ningún aviso debe aparecer**, y la pantalla de éxito debe verse y tardar igual que antes.

- [ ] **Step 7: Reporte final**

Escribe qué se verificó en cada terminal, qué no se pudo ejercitar y por qué. Un "probado en unidad, no verificado en hardware" es una respuesta válida y útil; un reporte inflado no.
