# Plan A — Blindaje del stack de dinero (avoqado-tpv)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los 9 defectos de la cola de registro de pagos de `avoqado-tpv` para que ninguna venta cobrada por el procesador se pierda,
se duplique ni se marque como sincronizada sin haberlo sido.

**Architecture:** Tres cambios de fondo. (1) La clasificación de errores deja de leer texto y pasa a leer **códigos HTTP tipados**,
preservados desde la capa de red. (2) La cola gana un estado intermedio `SYNCING` con **claim por token**, de modo que dos workers nunca
tomen la misma fila. (3) El retry deja de vivir dentro del worker (donde choca con el límite de 10 min de WorkManager) y pasa a WorkManager,
que ya sabe reintentar cuando vuelve la red.

**Tech Stack:** Kotlin · Jetpack Compose · Room 2.7 · WorkManager · Hilt · JUnit4 + MockK 1.13 + Truth 1.1.5 + Turbine 1.0 + Robolectric
4.11 · Room `MigrationTestHelper` (androidTest)

**Spec:** `docs/superpowers/specs/2026-07-24-tpv-mesas-offline-first-design.md` §4 **Repo:**
`/Users/amieva/Documents/Programming/Avoqado/avoqado-tpv` (rama `main`)

## Global Constraints

- **La cola NO es de cobro offline.** Es una cola de **registro post-autorización**: la tarjeta ya se cobró en línea a través del procesador
  y lo que falló fue anotar la venta en Avoqado. Cada fila perdida es dinero que el cliente sí pagó y que el venue no ve en sus libros,
  **sin recibo firmado que lo respalde**.
- **Nunca quitar ni renombrar un campo de una respuesta de API.** Campos nuevos: opcionales y con default.
- **Money = `BigDecimal`, en PESOS 1:1.** Nunca centavos, nunca `Float`/`Double`.
- **NO tocar `features/ordering/`** — es legacy y queda intacto (spec D-4). En particular **NO** arreglar los 11 `syncOrderImmediately` de
  `MenuViewModel.kt` (es F-2, saltada a propósito).
- **NO tocar el constraint `NetworkType.CONNECTED`** de `PaymentSyncScheduler.kt:85,174` — hace que WorkManager dispare al volver la red y
  está bien.
- **Nunca commitear sin permiso explícito del founder.** Los pasos de commit de este plan se ejecutan solo cuando el founder lo autorice.
- Correr `./gradlew testProductionDebugUnitTest` después de cada tarea; dejar el repo compilando.
- Fechas en tests siempre relativas (`System.currentTimeMillis() - N`), nunca hardcodeadas.

## Orden y por qué

F-6 → F-7 → F-8 → F-4 → F-9 → F-1 → F-10/F-11 → F-5 → F-3.

Primero lo irreversible (una venta marcada como sincronizada sin estarlo se borra a los 7 días y no deja rastro), después lo que pierde
ventas, después lo que las corrompe por concurrencia, y al final UX.

## File Structure

| Archivo                                                              | Responsabilidad                                           | Tarea   |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| `core/data/network/BackendHttpException.kt` **(nuevo)**              | Excepción tipada que preserva el status HTTP              | 1       |
| `features/payment/domain/usecase/RecordPaymentUseCase.kt`            | Emitir `BackendHttpException` en vez de perder el código  | 1, 8    |
| `features/payment/domain/sync/SyncOutcome.kt` **(nuevo)**            | Clasificador único: `Synced` / `Retryable` / `Permanent`  | 1       |
| `core/data/workers/PaymentSyncWorker.kt`                             | Consumir el clasificador; soltar el retry interno         | 1, 5    |
| `features/payment/data/repository/PaymentQueueRepositoryImpl.kt`     | `enqueue` honesto; claim/release                          | 2, 3    |
| `core/data/local/dao/PendingPaymentDao.kt`                           | Claim por token; `markSynced` con guarda; reset selectivo | 2, 3, 7 |
| `core/data/local/entity/PendingPaymentEntity.kt`                     | Campos `claim_token` / `claimed_at`; corregir KDoc        | 3, 7    |
| `core/data/local/AvoqadoDatabase.kt`                                 | Migración 27 → 28                                         | 3       |
| `core/util/PaymentSyncScheduler.kt`                                  | `enqueueUniqueWork`                                       | 4       |
| `features/payment/presentation/angelpay/AngelPayPaymentState.kt`     | Estado `Queued`                                           | 6       |
| `features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt` | Emitir `Queued`, no `Error`                               | 6       |
| `core/presentation/components/ConnectionBannerHost.kt` **(nuevo)**   | Dueño único de la franja superior                         | 9       |

---

## Task 1: F-6 — clasificar por código HTTP, no por texto

Hoy `PaymentSyncWorker.kt:247-257` hace `errorMessage.contains("409")` → `markSynced()`. Los reference numbers son numéricos (`000000409231`
contiene "409"), igual montos e ids. Un falso positivo marca como SUCCESS una venta que **nunca llegó al backend**, deja de reintentar, y a
los 7 días la fila se borra.

La causa raíz está una capa más abajo: `RecordPaymentUseCase.kt:281` devuelve `Result.failure(Exception(...))` y **el status HTTP se
pierde**. Por eso el worker no tiene más remedio que leer texto.

**Files:**

- Create: `app/src/main/java/com/jaac/avoqado_tpv/core/data/network/BackendHttpException.kt`
- Create: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcome.kt`
- Create: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcomeTest.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/usecase/RecordPaymentUseCase.kt:281-283`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt:242-307`

**Interfaces:**

- Produces: `BackendHttpException(val statusCode: Int, override val message: String)`; `SyncOutcome` sealed class con `Synced` / `Retryable`
  / `Permanent(reason: String)`; `classifySyncFailure(error: Throwable?): SyncOutcome`.
- Consumes: nada de tareas previas (es la primera).

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.domain.sync

import com.google.common.truth.Truth.assertThat
import com.jaac.avoqado_tpv.core.data.network.BackendHttpException
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class SyncOutcomeTest {

    @Test
    fun `409 real se considera sincronizado`() {
        val outcome = classifySyncFailure(BackendHttpException(409, "Duplicate payment"))
        assertThat(outcome).isInstanceOf(SyncOutcome.Synced::class.java)
    }

    @Test
    fun `un reference number que contiene 409 NO se considera sincronizado`() {
        // 🔴 El bug: "000000409231".contains("409") == true
        val outcome = classifySyncFailure(
            BackendHttpException(500, "Error registrando ref=000000409231"),
        )
        assertThat(outcome).isInstanceOf(SyncOutcome.Retryable::class.java)
    }

    @Test
    fun `un monto que contiene 400 NO se marca como permanente`() {
        val outcome = classifySyncFailure(
            BackendHttpException(503, "Servicio no disponible al cobrar 400.00"),
        )
        assertThat(outcome).isInstanceOf(SyncOutcome.Retryable::class.java)
    }

    @Test
    fun `4xx real es permanente`() {
        assertThat(classifySyncFailure(BackendHttpException(404, "Order not found")))
            .isInstanceOf(SyncOutcome.Permanent::class.java)
        assertThat(classifySyncFailure(BackendHttpException(401, "Unauthorized")))
            .isInstanceOf(SyncOutcome.Permanent::class.java)
    }

    @Test
    fun `5xx es reintentable`() {
        assertThat(classifySyncFailure(BackendHttpException(502, "Bad gateway")))
            .isInstanceOf(SyncOutcome.Retryable::class.java)
    }

    @Test
    fun `errores de red son reintentables`() {
        assertThat(classifySyncFailure(SocketTimeoutException("timeout")))
            .isInstanceOf(SyncOutcome.Retryable::class.java)
        assertThat(classifySyncFailure(IOException("Unable to resolve host")))
            .isInstanceOf(SyncOutcome.Retryable::class.java)
    }

    @Test
    fun `un error desconocido es reintentable, nunca sincronizado`() {
        // Regla de seguridad: ante la duda NUNCA marcar como sincronizado.
        // Perder un reintento es barato; perder una venta no.
        assertThat(classifySyncFailure(IllegalStateException("???")))
            .isInstanceOf(SyncOutcome.Retryable::class.java)
        assertThat(classifySyncFailure(null))
            .isInstanceOf(SyncOutcome.Retryable::class.java)
    }
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*SyncOutcomeTest*"` Expected: FAIL — `Unresolved reference: classifySyncFailure`

- [ ] **Step 3: Implementar la excepción tipada**

Crear `core/data/network/BackendHttpException.kt`:

```kotlin
package com.jaac.avoqado_tpv.core.data.network

/**
 * Error del backend que PRESERVA el status HTTP.
 *
 * Existe porque la clasificación retry-vs-fail se hacía leyendo el texto del
 * mensaje (`message.contains("409")`), y los reference numbers son numéricos:
 * "000000409231" contiene "409" y marcaba como sincronizada una venta que nunca
 * llegó al backend. Ver spec §4.2 F-6.
 *
 * Nunca clasificar por texto. Siempre por [statusCode].
 */
class BackendHttpException(
    val statusCode: Int,
    override val message: String,
    override val cause: Throwable? = null,
) : Exception(message, cause)
```

- [ ] **Step 4: Implementar el clasificador**

Crear `features/payment/domain/sync/SyncOutcome.kt`:

```kotlin
package com.jaac.avoqado_tpv.features.payment.domain.sync

import com.jaac.avoqado_tpv.core.data.network.BackendHttpException
import java.io.IOException

/** Resultado de clasificar un fallo al registrar un pago en el backend. */
sealed class SyncOutcome {
    /** El backend ya tiene el pago (409). La fila se cierra como SUCCESS. */
    data object Synced : SyncOutcome()

    /** Fallo transitorio (red, 5xx, desconocido). Se reintenta. */
    data object Retryable : SyncOutcome()

    /** Fallo de negocio permanente (4xx). No se arregla solo. */
    data class Permanent(val reason: String) : SyncOutcome()
}

/**
 * Clasifica un fallo de registro **por código**, nunca por el texto del mensaje.
 *
 * Regla de seguridad: ante la duda → [SyncOutcome.Retryable]. Perder un reintento
 * es barato; marcar como sincronizada una venta que no lo está es irreversible
 * (deja de reintentar y la fila se borra a los 7 días).
 */
fun classifySyncFailure(error: Throwable?): SyncOutcome = when {
    error is BackendHttpException && error.statusCode == 409 -> SyncOutcome.Synced

    error is BackendHttpException && error.statusCode in 400..499 ->
        SyncOutcome.Permanent("HTTP ${error.statusCode}: ${error.message}")

    error is BackendHttpException -> SyncOutcome.Retryable // 5xx y cualquier otro
    error is IOException -> SyncOutcome.Retryable          // red caída, timeout, DNS

    else -> SyncOutcome.Retryable                          // desconocido y null
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `./gradlew testProductionDebugUnitTest --tests "*SyncOutcomeTest*"` Expected: PASS (7 tests)

- [ ] **Step 6: Hacer que `RecordPaymentUseCase` emita el tipo**

En `RecordPaymentUseCase.kt`, donde hoy se construye el fallo (`:281-283`), envolver preservando el status. Localizar dónde el use case
detecta una respuesta HTTP no exitosa y reemplazar el `Exception(...)` genérico por:

```kotlin
return Result.failure(
    BackendHttpException(
        statusCode = response.code(),
        message = response.errorBody()?.string() ?: "Error registrando el pago",
    ),
)
```

Y en el `catch` de red, dejar pasar la `IOException` original en vez de envolverla en una `Exception` genérica (el clasificador la necesita
intacta):

```kotlin
} catch (e: IOException) {
    lastError = e   // ← NO envolver: classifySyncFailure() la lee como Retryable
    ...
}
```

Añadir el import `com.jaac.avoqado_tpv.core.data.network.BackendHttpException`.

- [ ] **Step 7: Reemplazar el string-matching del worker**

En `PaymentSyncWorker.kt`, borrar el bloque `:246-276` (los `errorMessage.contains(...)`) y sustituirlo por:

```kotlin
when (val outcome = classifySyncFailure(result.exceptionOrNull())) {
    is SyncOutcome.Synced -> {
        Timber.i(
            "✅ [Payment Sync] El backend ya tenía el pago (409) | ref=%s",
            payment.referenceNumber,
        )
        paymentQueueRepository.markSynced(payment.queueId)
        return true
    }

    is SyncOutcome.Permanent -> {
        Timber.e(
            "❌ [Payment Sync] Error permanente (no se reintenta) | ref=%s | %s",
            payment.referenceNumber,
            outcome.reason,
        )
        paymentQueueRepository.updateRetry(
            queueId = payment.queueId,
            retryCount = MAX_RETRY_ATTEMPTS,
            error = outcome.reason,
        )
        return false
    }

    is SyncOutcome.Retryable -> {
        // WorkManager reintenta cuando vuelva la red (Task 5). Aquí solo se registra.
        Timber.w("⚠️ [Payment Sync] Fallo transitorio | ref=%s", payment.referenceNumber)
        return false
    }
}
```

Añadir imports de `SyncOutcome` y `classifySyncFailure`.

- [ ] **Step 8: Correr toda la suite de pago**

Run: `./gradlew testProductionDebugUnitTest --tests "*Payment*"` Expected: PASS. Si algún test viejo esperaba el string-matching,
actualizarlo — el comportamiento nuevo es el correcto.

- [ ] **Step 9: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/network/BackendHttpException.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcome.kt \
        app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcomeTest.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/usecase/RecordPaymentUseCase.kt \
        app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt
git commit -m "fix(payments): clasificar el sync por código HTTP, no por texto del error

Un reference number como 000000409231 contiene \"409\" y hacía que el worker
marcara como sincronizada una venta que nunca llegó al backend. La fila dejaba
de reintentar y se borraba a los 7 dias, sin rastro.

Ahora el status HTTP se preserva en BackendHttpException y classifySyncFailure
decide por código. Ante la duda: Retryable, nunca Synced."
```

---

## Task 2: F-7 — `enqueue` no debe reportar éxito cuando la fila no entró

`PaymentQueueRepositoryImpl.kt:51-57`: el insert es `OnConflictStrategy.IGNORE` sobre el índice único de `reference_number`; si choca
devuelve rowId 0 y el repo responde **`Result.success(Unit)`**. Como las filas `FAILED` **nunca se borran** (`deleteOldSyncedPayments` solo
toca `SUCCESS`), un reference number repetido choca con un cadáver y el pago nuevo jamás entra a la cola. El cajero lee "EN COLA, se
completará automáticamente" y no hay nada que completar.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/PendingPaymentDao.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/PaymentQueueRepositoryImpl.kt:40-63`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/repository/PendingPaymentEnqueueTest.kt` (crear)

**Interfaces:**

- Consumes: nada de la Task 1.
- Produces: `PendingPaymentDao.findByReference(reference: String): PendingPaymentEntity?`. `enqueue` sigue devolviendo `Result<Unit>` (firma
  intacta) pero ahora `Result.failure` cuando el pago **no** quedó encolado.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.features.payment.data.repository

import com.google.common.truth.Truth.assertThat
import com.jaac.avoqado_tpv.core.data.local.dao.PendingPaymentDao
import com.jaac.avoqado_tpv.core.data.local.entity.PendingPaymentEntity
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Test

class PendingPaymentEnqueueTest {

    private val dao = mockk<PendingPaymentDao>(relaxed = true)
    private val repo = PaymentQueueRepositoryImpl(dao)

    @Test
    fun `insert normal devuelve exito`() = runTest {
        coEvery { dao.insert(any()) } returns 42L

        val result = repo.enqueue(queuedPayment(reference = "000000111111"))

        assertThat(result.isSuccess).isTrue()
    }

    @Test
    fun `choque con una fila PENDING del mismo pago devuelve exito`() = runTest {
        // Mismo pago encolado dos veces: ya está a salvo, no es un error.
        coEvery { dao.insert(any()) } returns 0L
        coEvery { dao.findByReference("000000111111") } returns
            entity(reference = "000000111111", status = "PENDING")

        val result = repo.enqueue(queuedPayment(reference = "000000111111"))

        assertThat(result.isSuccess).isTrue()
    }

    @Test
    fun `choque con un cadaver FAILED devuelve FALLO`() = runTest {
        // 🔴 El bug: la fila vieja bloquea el índice único para siempre y el pago
        // nuevo nunca entra a la cola, pero al cajero se le decía "EN COLA".
        coEvery { dao.insert(any()) } returns 0L
        coEvery { dao.findByReference("000000111111") } returns
            entity(reference = "000000111111", status = "FAILED")

        val result = repo.enqueue(queuedPayment(reference = "000000111111"))

        assertThat(result.isFailure).isTrue()
    }

    @Test
    fun `choque con una fila SUCCESS vieja devuelve FALLO`() = runTest {
        coEvery { dao.insert(any()) } returns 0L
        coEvery { dao.findByReference("000000111111") } returns
            entity(reference = "000000111111", status = "SUCCESS")

        val result = repo.enqueue(queuedPayment(reference = "000000111111"))

        assertThat(result.isFailure).isTrue()
    }
}
```

> **Nota para quien implemente:** `queuedPayment(...)` y `entity(...)` son helpers a escribir en el mismo archivo de test. Copiar la forma
> de `QueuedPayment` desde `features/payment/domain/model/QueuedPayment.kt` y la de `PendingPaymentEntity` desde
> `core/data/local/entity/PendingPaymentEntity.kt`, rellenando con valores mínimos válidos y `createdAt = System.currentTimeMillis()`.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*PendingPaymentEnqueueTest*"` Expected: FAIL — los dos últimos tests devuelven
`isSuccess`, no `isFailure`.

- [ ] **Step 3: Agregar la consulta al DAO**

En `PendingPaymentDao.kt`:

```kotlin
/**
 * Busca una fila por reference number.
 *
 * Se usa al chocar el índice único en [insert]: hay que distinguir "el mismo pago
 * ya está encolado y a salvo" (PENDING/SYNCING → OK) de "una fila vieja bloquea el
 * índice y este pago NO entró" (SUCCESS/FAILED → error). Ver spec §4.2 F-7.
 */
@Query("SELECT * FROM pending_payments WHERE reference_number = :reference LIMIT 1")
suspend fun findByReference(reference: String): PendingPaymentEntity?
```

- [ ] **Step 4: Hacer honesto el `enqueue`**

Reemplazar el bloque `:45-58` de `PaymentQueueRepositoryImpl.kt`:

```kotlin
if (id > 0) {
    Timber.i(
        "💾 [Payment Queue] Pago encolado | ref=${payment.referenceNumber} | " +
            "amount=${payment.amount} | queueId=$id",
    )
    return@withContext Result.success(Unit)
}

// rowId 0 = choque con el índice único de reference_number.
// Solo es benigno si la fila existente sigue viva (el MISMO pago, ya a salvo).
val existing = pendingPaymentDao.findByReference(payment.referenceNumber)
val stillQueued = existing?.syncStatus == "PENDING" || existing?.syncStatus == "SYNCING"

if (stillQueued) {
    Timber.w("⚠️ [Payment Queue] Pago ya encolado | ref=${payment.referenceNumber}")
    Result.success(Unit)
} else {
    // 🔴 Una fila SUCCESS/FAILED vieja bloquea el índice: este pago NO entró.
    // Reportarlo como fallo es lo que hace que el cajero vea el aviso rojo real
    // ("avisa al supervisor") en vez del falso "EN COLA".
    Timber.e(
        "❌ [Payment Queue] Encolado BLOQUEADO por fila previa (%s) | ref=%s",
        existing?.syncStatus ?: "desconocida",
        payment.referenceNumber,
    )
    Result.failure(
        IllegalStateException(
            "El pago no pudo encolarse: ya existe una fila ${existing?.syncStatus} " +
                "con reference ${payment.referenceNumber}",
        ),
    )
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `./gradlew testProductionDebugUnitTest --tests "*PendingPaymentEnqueueTest*"` Expected: PASS (4 tests)

- [ ] **Step 6: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/PendingPaymentDao.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/PaymentQueueRepositoryImpl.kt \
        app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/repository/PendingPaymentEnqueueTest.kt
git commit -m "fix(payments): no reportar 'encolado' cuando el pago no entro a la cola

Las filas FAILED nunca se borran, asi que un reference number repetido chocaba
con un cadaver, el insert se ignoraba y el repo devolvia success. El cajero leia
'EN COLA, se completara automaticamente' y no habia nada que completar."
```

---

## Task 3: F-8 — claim por token, para que dos workers nunca tomen la misma fila

`PendingPaymentDao.kt:58-63`: `getAllPending()` devuelve todo lo PENDING y **no existe estado intermedio ni claim**. Con dos workers vivos
(F-4), ambos leen las mismas filas y las registran en paralelo. Lo único que hoy evita el doble registro es que el backend deduplique — la
seguridad del dinero está fuera de la app.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entity/PendingPaymentEntity.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/PendingPaymentDao.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabase.kt:107-125`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/repository/PaymentQueueRepository.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/PaymentQueueRepositoryImpl.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt:136-146`
- Test: `app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/PendingPaymentClaimTest.kt` (crear)
- Test: `app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabaseMigrationTest.kt` (extender)

**Interfaces:**

- Consumes: `findByReference` de la Task 2 (el estado `SYNCING` ya se contempla ahí como "vivo").
- Produces: `PaymentQueueRepository.claimBatch(limit: Int): List<QueuedPayment>` y
  `PaymentQueueRepository.release(queueId: Long, retryCount: Int, error: String)`. El worker deja de llamar `getAllPending()`.

- [ ] **Step 1: Escribir el test de instrumentación que falla**

```kotlin
package com.jaac.avoqado_tpv.core.data.local

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test

class PendingPaymentClaimTest {

    private lateinit var db: AvoqadoDatabase
    private lateinit var dao: com.jaac.avoqado_tpv.core.data.local.dao.PendingPaymentDao

    @Before fun setup() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AvoqadoDatabase::class.java,
        ).build()
        dao = db.pendingPaymentDao()
    }

    @After fun teardown() = db.close()

    @Test
    fun dos_claims_concurrentes_no_toman_la_misma_fila() = runTest {
        repeat(10) { dao.insert(newPending(reference = "ref-$it")) }

        val (a, b) = listOf(
            async { dao.claimBatch(limit = 10, token = "A", now = 1_000, staleBefore = 0) },
            async { dao.claimBatch(limit = 10, token = "B", now = 1_000, staleBefore = 0) },
        ).awaitAll()

        val ids = a.map { it.id } + b.map { it.id }
        assertThat(ids).containsNoDuplicates()   // 🔴 el bug
        assertThat(ids).hasSize(10)              // y nada se pierde
    }

    @Test
    fun una_fila_reclamada_no_vuelve_a_salir() = runTest {
        dao.insert(newPending(reference = "ref-1"))

        val first = dao.claimBatch(limit = 10, token = "A", now = 1_000, staleBefore = 0)
        val second = dao.claimBatch(limit = 10, token = "B", now = 1_000, staleBefore = 0)

        assertThat(first).hasSize(1)
        assertThat(second).isEmpty()
    }

    @Test
    fun una_fila_abandonada_se_puede_reclamar_despues() = runTest {
        // Si el worker muere a media tanda, la fila queda en SYNCING. Debe poder
        // reclamarse pasado el umbral, o el pago se queda atorado para siempre.
        dao.insert(newPending(reference = "ref-1"))
        dao.claimBatch(limit = 10, token = "MUERTO", now = 1_000, staleBefore = 0)

        val reclaimed = dao.claimBatch(
            limit = 10, token = "NUEVO", now = 999_000, staleBefore = 900_000,
        )

        assertThat(reclaimed).hasSize(1)
    }

    @Test
    fun release_devuelve_la_fila_a_PENDING_con_el_retry_incrementado() = runTest {
        dao.insert(newPending(reference = "ref-1"))
        val claimed = dao.claimBatch(limit = 1, token = "A", now = 1_000, staleBefore = 0)

        dao.release(claimed.first().id, retryCount = 1, error = "red caida")

        val row = dao.findByReference("ref-1")!!
        assertThat(row.syncStatus).isEqualTo("PENDING")
        assertThat(row.retryCount).isEqualTo(1)
        assertThat(row.claimToken).isNull()
    }
}
```

> **Nota:** `newPending(reference)` es un helper a escribir en el mismo archivo; construye un `PendingPaymentEntity` mínimo válido con
> `createdAt = System.currentTimeMillis()` y `syncStatus = "PENDING"`.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew connectedProductionDebugAndroidTest --tests "*PendingPaymentClaimTest*"` Expected: FAIL — `Unresolved reference: claimBatch`

- [ ] **Step 3: Agregar los campos a la entidad**

En `PendingPaymentEntity.kt`, dentro del `data class`, añadir (aditivos, con default — no rompen nada existente):

```kotlin
/**
 * Token del worker que reclamó esta fila. NULL = libre.
 * Existe para que dos workers concurrentes no tomen el mismo pago y lo
 * registren dos veces. Ver spec §4.2 F-8.
 */
@ColumnInfo(name = "claim_token")
val claimToken: String? = null,

/** Epoch ms del claim. Permite reclamar filas abandonadas por un worker muerto. */
@ColumnInfo(name = "claimed_at")
val claimedAt: Long? = null,
```

Y añadir el índice al `@Entity`:

```kotlin
Index(value = ["claim_token"]), // claim/release del worker
```

- [ ] **Step 4: Escribir la migración 27 → 28**

En `AvoqadoDatabase.kt`, subir `version = 27` a `version = 28` (actualizando el comentario) y añadir junto a las migraciones existentes:

```kotlin
/**
 * v28: claim por token en pending_payments.
 *
 * Sin esto, dos workers concurrentes leen las mismas filas PENDING y registran
 * el mismo pago dos veces (la única defensa era la deduplicación del backend).
 * Aditiva y nullable: las filas existentes quedan sin reclamar, que es correcto.
 */
val MIGRATION_27_28 = object : Migration(27, 28) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE pending_payments ADD COLUMN claim_token TEXT")
        db.execSQL("ALTER TABLE pending_payments ADD COLUMN claimed_at INTEGER")
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS index_pending_payments_claim_token " +
                "ON pending_payments (claim_token)",
        )
    }
}
```

Registrarla donde se listan las demás (`.addMigrations(...)` en `DatabaseModule.kt` o en el builder del propio archivo — seguir el patrón ya
presente).

- [ ] **Step 5: Agregar claim y release al DAO**

En `PendingPaymentDao.kt`:

```kotlin
/**
 * Reclama hasta [limit] filas de forma atómica y devuelve exactamente las que
 * quedaron marcadas con [token].
 *
 * Toma filas PENDING, y también SYNCING abandonadas (claimed_at < staleBefore),
 * para que un worker muerto no deje pagos atorados para siempre.
 */
@Transaction
suspend fun claimBatch(limit: Int, token: String, now: Long, staleBefore: Long): List<PendingPaymentEntity> {
    markClaimed(limit, token, now, staleBefore)
    return getClaimed(token)
}

@Query("""
    UPDATE pending_payments
    SET sync_status = 'SYNCING', claim_token = :token, claimed_at = :now
    WHERE id IN (
        SELECT id FROM pending_payments
        WHERE sync_status = 'PENDING'
           OR (sync_status = 'SYNCING' AND claimed_at IS NOT NULL AND claimed_at < :staleBefore)
        ORDER BY created_at ASC
        LIMIT :limit
    )
""")
suspend fun markClaimed(limit: Int, token: String, now: Long, staleBefore: Long)

@Query("SELECT * FROM pending_payments WHERE claim_token = :token ORDER BY created_at ASC")
suspend fun getClaimed(token: String): List<PendingPaymentEntity>

/**
 * Suelta una fila reclamada y la devuelve a PENDING con el retry incrementado.
 * Si el retry llegó al tope, queda FAILED.
 */
@Query("""
    UPDATE pending_payments
    SET retry_count = :retryCount,
        last_error = :error,
        claim_token = NULL,
        claimed_at = NULL,
        sync_status = CASE
            WHEN :retryCount >= ${PendingPaymentEntity.MAX_RETRY_ATTEMPTS} THEN 'FAILED'
            ELSE 'PENDING'
        END
    WHERE id = :id
""")
suspend fun release(id: Long, retryCount: Int, error: String)
```

- [ ] **Step 6: Exponerlo en el repositorio**

En `PaymentQueueRepository.kt` (interfaz) añadir — sin quitar nada de lo existente:

```kotlin
/** Reclama hasta [limit] pagos para este worker. Ver spec §4.2 F-8. */
suspend fun claimBatch(limit: Int): List<QueuedPayment>

/** Suelta un pago reclamado que falló de forma transitoria. */
suspend fun release(queueId: Long, retryCount: Int, error: String)
```

En `PaymentQueueRepositoryImpl.kt`:

```kotlin
override suspend fun claimBatch(limit: Int): List<QueuedPayment> = withContext(Dispatchers.IO) {
    val now = System.currentTimeMillis()
    pendingPaymentDao
        .claimBatch(
            limit = limit,
            token = java.util.UUID.randomUUID().toString(),
            now = now,
            staleBefore = now - STALE_CLAIM_MS,
        )
        .map { it.toQueuedPayment() }
}

override suspend fun release(queueId: Long, retryCount: Int, error: String) =
    withContext(Dispatchers.IO) {
        pendingPaymentDao.release(queueId, retryCount, error)
    }

private companion object {
    /** Una fila SYNCING más vieja que esto se considera abandonada. */
    const val STALE_CLAIM_MS = 15 * 60 * 1000L
}
```

- [ ] **Step 7: Hacer que el worker use el claim**

En `PaymentSyncWorker.kt`, reemplazar `:136-149` (el `getAllPending()` + `.take(MAX_PAYMENTS_PER_RUN)`):

```kotlin
// Reclamar la tanda: otro worker corriendo en paralelo NO puede tomar estas filas.
val batch = paymentQueueRepository.claimBatch(MAX_PAYMENTS_PER_RUN)

if (batch.isEmpty()) {
    Timber.d("✅ [Payment Sync] No hay pagos pendientes por sincronizar")
    return Result.success()
}

Timber.i("🔄 [Payment Sync] ${batch.size} pagos reclamados para sincronizar")
```

Y en la rama `SyncOutcome.Retryable` de la Task 1, soltar la fila en vez de solo registrar:

```kotlin
is SyncOutcome.Retryable -> {
    Timber.w("⚠️ [Payment Sync] Fallo transitorio | ref=%s", payment.referenceNumber)
    paymentQueueRepository.release(
        queueId = payment.queueId,
        retryCount = payment.retryCount + 1,
        error = outcome.toString(),
    )
    return false
}
```

En la rama `Permanent`, cambiar `updateRetry(...)` por `release(payment.queueId, MAX_RETRY_ATTEMPTS, outcome.reason)` para que también
suelte el token.

- [ ] **Step 8: Extender el test de migración**

En `AvoqadoDatabaseMigrationTest.kt`, siguiendo el patrón de las migraciones ya cubiertas, añadir un caso 27 → 28 que verifique que una fila
`pending_payments` existente sobrevive con `claim_token` y `claimed_at` en NULL.

- [ ] **Step 9: Correr los tests**

Run: `./gradlew connectedProductionDebugAndroidTest --tests "*PendingPaymentClaimTest*" --tests "*AvoqadoDatabaseMigrationTest*"` Expected:
PASS

Run: `./gradlew testProductionDebugUnitTest --tests "*Payment*"` Expected: PASS

- [ ] **Step 10: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/local/ \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/repository/PaymentQueueRepository.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/PaymentQueueRepositoryImpl.kt \
        app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt \
        app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/
git commit -m "fix(payments): claim por token en la cola (Room v28)

getAllPending() devolvia todo lo PENDING sin estado intermedio, asi que dos
workers concurrentes tomaban las mismas filas y registraban el mismo pago dos
veces. La unica defensa era la deduplicacion del backend.

Ahora claimBatch() marca SYNCING con un token dentro de una transaccion y
devuelve solo lo reclamado. Las filas abandonadas por un worker muerto se
reclaman a los 15 min."
```

---

## Task 4: F-4 — un solo worker inmediato

`PaymentSyncScheduler.kt:177-181` usa `enqueue()` pelón, sin nombre único. Cada `runNow()` crea un worker independiente, y
`handleRecordFailure` llama `runNow()` en cada pago encolado.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/util/PaymentSyncScheduler.kt:170-184`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/core/util/PaymentSyncSchedulerTest.kt` (crear)

**Interfaces:**

- Consumes: el claim de la Task 3 (defensa en profundidad: aunque se colaran dos workers, el claim los separa).
- Produces: constante `PaymentSyncScheduler.IMMEDIATE_WORK_NAME`.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.core.util

import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.mockk
import io.mockk.verify
import org.junit.Test

class PaymentSyncSchedulerTest {

    @Test
    fun `runNow encola trabajo UNICO con politica KEEP`() {
        val workManager = mockk<WorkManager>(relaxed = true)
        val context = mockk<android.content.Context>(relaxed = true)
        mockkStatic(WorkManager::class)
        every { WorkManager.getInstance(context) } returns workManager

        PaymentSyncScheduler.runNow(context)

        // KEEP y no REPLACE: si ya hay uno corriendo queremos que TERMINE,
        // no reiniciarlo a media tanda.
        verify {
            workManager.enqueueUniqueWork(
                PaymentSyncScheduler.IMMEDIATE_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                any<OneTimeWorkRequest>(),
            )
        }
    }
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*PaymentSyncSchedulerTest*"` Expected: FAIL —
`Unresolved reference: IMMEDIATE_WORK_NAME`, y `enqueueUniqueWork` nunca se llama.

- [ ] **Step 3: Implementar**

En `PaymentSyncScheduler.kt`, añadir la constante junto a `PAYMENT_SYNC_WORK_NAME` y reemplazar `:177-181`:

```kotlin
/** Nombre único del worker inmediato. Sin esto, cada runNow() creaba uno nuevo. */
const val IMMEDIATE_WORK_NAME = "payment_sync_now"
```

```kotlin
val immediateWorkRequest = androidx.work.OneTimeWorkRequestBuilder<PaymentSyncWorker>()
    .setConstraints(constraints)
    .build()

// KEEP, no REPLACE: si ya hay un worker drenando la cola queremos que TERMINE.
// REPLACE lo mataria a media tanda y las filas reclamadas tendrian que esperar
// al umbral de stale-claim para volver a salir.
WorkManager.getInstance(context).enqueueUniqueWork(
    IMMEDIATE_WORK_NAME,
    androidx.work.ExistingWorkPolicy.KEEP,
    immediateWorkRequest,
)
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `./gradlew testProductionDebugUnitTest --tests "*PaymentSyncSchedulerTest*"` Expected: PASS

- [ ] **Step 5: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/util/PaymentSyncScheduler.kt \
        app/src/test/java/com/jaac/avoqado_tpv/core/util/PaymentSyncSchedulerTest.kt
git commit -m "fix(payments): un solo worker inmediato (enqueueUniqueWork KEEP)

runNow() usaba enqueue() sin nombre unico, y handleRecordFailure lo llama en
cada pago encolado: N pagos en cola => N workers sobre la misma tabla Room."
```

---

## Task 5: F-9 — sacar el retry del worker y dejárselo a WorkManager

`PaymentSyncWorker.kt:113,207-214`: 10 pagos × hasta 10 intentos × backoff de hasta 30s ≈ 40 min, y **WorkManager mata al worker a los 10**.
Se corta a media tanda pero el `retry_count` elevado ya quedó escrito y se acumula entre corridas, así que un pago bueno termina en
`FAILED`. Además el `delay()` interno pelea con el framework: el constraint `NetworkType.CONNECTED` ya hace que WorkManager reintente al
volver la red.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt:182-340`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorkerTest.kt` (crear)

**Interfaces:**

- Consumes: `classifySyncFailure` (Task 1), `claimBatch`/`release` (Task 3).
- Produces: `syncPayment` sin loop — un intento por corrida.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.core.data.workers

import com.google.common.truth.Truth.assertThat
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.system.measureTimeMillis

class PaymentSyncWorkerTest {

    @Test
    fun `un fallo transitorio hace UN intento, no diez`() = runTest {
        val repo = mockk<PaymentQueueRepository>(relaxed = true)
        val useCase = mockk<RecordPaymentUseCase>()
        coEvery { repo.claimBatch(any()) } returns listOf(queuedPayment("ref-1"))
        coEvery { useCase(any(), any(), any(), any()) } returns
            Result.failure(java.io.IOException("red caida"))

        val worker = buildWorker(repo, useCase)
        val elapsed = measureTimeMillis { worker.doWork() }

        // Un solo intento: el reintento lo hace WorkManager al volver la red.
        coVerify(exactly = 1) { useCase(any(), any(), any(), any()) }
        // Y sin dormir dentro del worker.
        assertThat(elapsed).isLessThan(2_000)
        coVerify { repo.release(any(), retryCount = 1, any()) }
    }

    @Test
    fun `el worker siempre devuelve success para no romper el periodico`() = runTest {
        val repo = mockk<PaymentQueueRepository>(relaxed = true)
        val useCase = mockk<RecordPaymentUseCase>()
        coEvery { repo.claimBatch(any()) } returns listOf(queuedPayment("ref-1"))
        coEvery { useCase(any(), any(), any(), any()) } returns
            Result.failure(java.io.IOException("red caida"))

        val result = buildWorker(repo, useCase).doWork()

        assertThat(result).isEqualTo(androidx.work.ListenableWorker.Result.success())
    }
}
```

> **Nota:** `buildWorker(...)` construye el `PaymentSyncWorker` con `TestListenableWorkerBuilder` (androidx.work:work-testing). Si la
> dependencia no está en `app/build.gradle.kts`, añadir `testImplementation("androidx.work:work-testing:2.9.0")` como parte de este paso.
> `queuedPayment(...)` es el helper de la Task 2.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*PaymentSyncWorkerTest*"` Expected: FAIL — se llama al use case 10 veces y el test
tarda >30s.

- [ ] **Step 3: Reemplazar `syncPayment` por un intento único**

Sustituir todo el cuerpo de `syncPayment` (`:202-340`) por:

```kotlin
/**
 * Intenta registrar UN pago, UNA vez.
 *
 * El retry NO vive aquí: el constraint NetworkType.CONNECTED hace que WorkManager
 * dispare al volver la red, y el periódico de 15 min es la garantía. Un loop con
 * delay() dentro del worker sumaba hasta ~40 min por tanda contra el límite de 10
 * de WorkManager: se moría a media tanda dejando retry_count inflado, y pagos
 * buenos acababan en FAILED. Ver spec §4.2 F-9.
 */
private suspend fun syncPayment(payment: QueuedPayment): Boolean {
    Timber.d("🔄 [Payment Sync] Sincronizando | ref=${payment.referenceNumber}")

    val result = try {
        recordPaymentUseCase(
            context = payment.toPaymentContext(),
            cardDetails = payment.toCardDetails(),
            authorizationNumber = payment.authorizationNumber ?: "",
            referenceNumber = payment.referenceNumber,
        )
    } catch (e: CancellationException) {
        throw e // worker cancelado: la fila queda SYNCING y se reclama por stale
    } catch (e: Exception) {
        Result.failure(e)
    }

    if (result.isSuccess) {
        Timber.i("✅ [Payment Sync] Sincronizado | ref=${payment.referenceNumber}")
        paymentQueueRepository.markSynced(payment.queueId)
        return true
    }

    return when (val outcome = classifySyncFailure(result.exceptionOrNull())) {
        is SyncOutcome.Synced -> {
            Timber.i("✅ [Payment Sync] El backend ya lo tenía (409) | ref=${payment.referenceNumber}")
            paymentQueueRepository.markSynced(payment.queueId)
            true
        }

        is SyncOutcome.Permanent -> {
            Timber.e("❌ [Payment Sync] Permanente | ref=${payment.referenceNumber} | ${outcome.reason}")
            paymentQueueRepository.release(payment.queueId, MAX_RETRY_ATTEMPTS, outcome.reason)
            false
        }

        is SyncOutcome.Retryable -> {
            Timber.w("⚠️ [Payment Sync] Transitorio | ref=${payment.referenceNumber}")
            paymentQueueRepository.release(
                queueId = payment.queueId,
                retryCount = payment.retryCount + 1,
                error = result.exceptionOrNull()?.message ?: "error transitorio",
            )
            false
        }
    }
}
```

Borrar las constantes `INITIAL_BACKOFF_MS` y `MAX_BACKOFF_MS` (`:100,106`) — ya no se usan.

- [ ] **Step 4: Correr los tests**

Run: `./gradlew testProductionDebugUnitTest --tests "*PaymentSyncWorkerTest*"` Expected: PASS, y en menos de 2 segundos.

- [ ] **Step 5: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt \
        app/src/test/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorkerTest.kt \
        app/build.gradle.kts
git commit -m "fix(payments): un intento por corrida; el retry es de WorkManager

10 pagos x 10 intentos x 30s de backoff = ~40 min contra el limite de 10 de
WorkManager. Se moria a media tanda con el retry_count ya inflado, y pagos
buenos acababan en FAILED."
```

---

## Task 6: F-1 — un cobro exitoso no se pinta como error

`AngelPayPaymentViewModel.kt:575` devuelve `AngelPayPaymentState.Error` cuando la tarjeta **sí** cobró y solo falló el registro. El texto ya
es correcto, pero el tipo de estado hace que el cajero vea pantalla roja en una operación que salió bien — y vuelva a cobrar por miedo.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentState.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt:575-583`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentScreen.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/PaymentState.kt` (equivalente Blumon)
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModelTest.kt:770-810` (extender)

**Interfaces:**

- Consumes: `enqueue` honesto de la Task 2 — el caso de `Result.failure` es ahora el que sí merece `Error`.
- Produces: `AngelPayPaymentState.Queued`.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `AngelPayPaymentViewModelTest.kt`:

```kotlin
@Test
fun `un cobro exitoso con registro encolado NO es un estado de Error`() = runTest {
    coEvery { paymentQueueRepository.enqueue(any()) } returns Result.success(Unit)

    val state = viewModel.handleRecordFailure(
        paymentLabel = "El pago",
        error = java.io.IOException("backend no respondio"),
        context = successfulCardContext(),
    )

    // 🔴 El bug: era Error. El cajero veia rojo y volvia a cobrar.
    assertThat(state).isInstanceOf(AngelPayPaymentState.Queued::class.java)
    val queued = state as AngelPayPaymentState.Queued
    assertThat(queued.message).contains("EN COLA")
    assertThat(queued.message).contains("NO vuelvas a cobrar")
}

@Test
fun `si el encolado TAMBIEN falla si es un Error real`() = runTest {
    coEvery { paymentQueueRepository.enqueue(any()) } returns
        Result.failure(IllegalStateException("no entro a la cola"))

    val state = viewModel.handleRecordFailure(
        paymentLabel = "El pago",
        error = java.io.IOException("backend no respondio"),
        context = successfulCardContext(),
    )

    assertThat(state).isInstanceOf(AngelPayPaymentState.Error::class.java)
    assertThat((state as AngelPayPaymentState.Error).message).contains("avisa al supervisor")
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*AngelPayPaymentViewModelTest*"` Expected: FAIL — `Unresolved reference: Queued`

- [ ] **Step 3: Agregar el estado**

En `AngelPayPaymentState.kt`, junto a `Success` y antes de `Error`:

```kotlin
/**
 * La tarjeta SÍ cobró; solo el registro en Avoqado quedó pendiente de sincronizar.
 *
 * Es un ÉXITO con matiz, NO un error: se renderiza en verde/ámbar. Antes esto
 * devolvía [Error] y el cajero veía pantalla roja en una operación que había
 * salido bien — y volvía a cobrar por miedo. Ver spec §4.2 F-1.
 *
 * [Error] queda reservado para cuando el encolado TAMBIÉN falla, que sí requiere
 * intervención humana.
 */
data class Queued(
    val message: String,
    val authCode: String,
    val amount: String,
    val tipAmount: String? = null,
    val referenceNumber: String? = null,
    val orderId: String? = null,
    val orderNumber: String? = null,
) : AngelPayPaymentState()
```

- [ ] **Step 4: Emitirlo desde el ViewModel**

En `AngelPayPaymentViewModel.kt`, reemplazar el `AngelPayPaymentState.Error(...)` de `:575-579` por:

```kotlin
AngelPayPaymentState.Queued(
    message = "$paymentLabel fue procesado, pero Avoqado no respondió. El registro quedó " +
        "EN COLA y se completará automáticamente al recuperar conexión. NO vuelvas a cobrar.",
    authCode = context.authorizationCode.orEmpty(),
    amount = queued.amount.toPlainString(),
    tipAmount = queued.tip.toPlainString(),
    referenceNumber = queued.referenceNumber,
    orderId = queued.orderId,
    orderNumber = queued.orderNumber,
)
```

La rama `else` (`:580-583`, cuando el encolado falla) se queda como está: ahí `Error` es correcto.

- [ ] **Step 5: Renderizarlo como éxito**

En `AngelPayPaymentScreen.kt`, añadir una rama para `AngelPayPaymentState.Queued` al `when` del estado. Reusar el composable de éxito que ya
existe, cambiando el color de acento a ámbar y mostrando `state.message` bajo el monto. **No** reusar el composable de error — el punto
entero es que no se vea rojo.

- [ ] **Step 6: Revisar el mismo patrón en Blumon**

Buscar el equivalente en el path de Blumon:

```bash
rg -n "PaymentState.Error" app/src/main/java/com/jaac/avoqado_tpv/features/payment/ \
   app/src/production/java app/src/sandbox/java | rg -i "cola|queue|encolad"
```

Si aparece el mismo "éxito-como-Error", aplicar el mismo arreglo en `PaymentState.kt` + su ViewModel y su pantalla. Si no aparece, anotarlo
en el commit — la revisión es parte del entregable.

- [ ] **Step 7: Correr los tests**

Run: `./gradlew testProductionDebugUnitTest --tests "*Payment*"` Expected: PASS

- [ ] **Step 8: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/features/payment/ \
        app/src/test/java/com/jaac/avoqado_tpv/features/payment/
git commit -m "fix(payments): un cobro exitoso ya no se pinta como error

La tarjeta cobraba, solo fallaba el registro, y el estado seguia siendo Error:
pantalla roja en una operacion que salio bien. El cajero volvia a cobrar por
miedo. Error queda para cuando el encolado TAMBIEN falla."
```

---

## Task 7: F-10 + F-11 — reset selectivo, `markSynced` con guarda, y el KDoc que miente

Tres arreglos pequeños en los mismos archivos. `resetAllFailed()` (`PendingPaymentDao.kt:172-177`, llamado desde `HomeViewModel.kt:896` y
`DeviceHealthViewModel.kt:388`) regresa **todos** los FAILED a PENDING con `retry_count = 0`, incluyendo los que fallaron por un 4xx
permanente → se reintentan para siempre. `markSynced` (`:72-77`) actualiza por `WHERE id = :id` sin verificar estado. Y el KDoc dice "3
attempts max" en cinco lugares cuando `MAX_RETRY_ATTEMPTS = 10`.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/PendingPaymentDao.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entity/PendingPaymentEntity.kt` (KDoc)
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt` (KDoc `:17-74,182-201`)
- Test: `app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/PendingPaymentClaimTest.kt` (extender)

**Interfaces:**

- Consumes: `SyncOutcome.Permanent` (Task 1) — es lo que marca una fila como no-reintentable.
- Produces: columna `permanent` en `pending_payments` (Room v29).

- [ ] **Step 1: Escribir los tests que fallan**

Añadir a `PendingPaymentClaimTest.kt`:

```kotlin
@Test
fun `resetAllFailed NO resucita los fallos permanentes`() = runTest {
    dao.insert(newPending(reference = "transitorio"))
    dao.insert(newPending(reference = "permanente"))
    val claimed = dao.claimBatch(limit = 2, token = "A", now = 1_000, staleBefore = 0)
    dao.release(claimed[0].id, retryCount = 10, error = "red")            // FAILED transitorio
    dao.markPermanentlyFailed(claimed[1].id, "HTTP 404: Order not found") // FAILED permanente

    val reset = dao.resetAllFailed()

    assertThat(reset).isEqualTo(1)
    assertThat(dao.findByReference("permanente")!!.syncStatus).isEqualTo("FAILED")
    assertThat(dao.findByReference("transitorio")!!.syncStatus).isEqualTo("PENDING")
}

@Test
fun `markSynced no puede voltear una fila FAILED`() = runTest {
    dao.insert(newPending(reference = "ref-1"))
    val claimed = dao.claimBatch(limit = 1, token = "A", now = 1_000, staleBefore = 0)
    dao.markPermanentlyFailed(claimed.first().id, "HTTP 404")

    dao.markSynced(claimed.first().id)

    assertThat(dao.findByReference("ref-1")!!.syncStatus).isEqualTo("FAILED")
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew connectedProductionDebugAndroidTest --tests "*PendingPaymentClaimTest*"` Expected: FAIL —
`Unresolved reference: markPermanentlyFailed`

- [ ] **Step 3: Agregar la columna y la migración 28 → 29**

En `PendingPaymentEntity.kt`:

```kotlin
/**
 * `true` cuando el fallo fue de negocio permanente (4xx). resetAllFailed() lo
 * respeta: reintentarlo cada reconexión no lo arregla y solo genera ruido.
 * Ver spec §4.2 F-10.
 */
@ColumnInfo(name = "permanent", defaultValue = "0")
val permanent: Boolean = false,
```

En `AvoqadoDatabase.kt`, subir a `version = 29` y añadir:

```kotlin
val MIGRATION_28_29 = object : Migration(28, 29) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE pending_payments ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0")
    }
}
```

- [ ] **Step 4: Arreglar las tres consultas**

En `PendingPaymentDao.kt`:

```kotlin
/** Marca un fallo de negocio permanente: resetAllFailed() no lo va a resucitar. */
@Query("""
    UPDATE pending_payments
    SET sync_status = 'FAILED', permanent = 1, last_error = :error,
        claim_token = NULL, claimed_at = NULL
    WHERE id = :id
""")
suspend fun markPermanentlyFailed(id: Long, error: String)
```

```kotlin
// markSynced: añadir la guarda de estado. Una fila FAILED nunca debe voltearse
// a SUCCESS por un markSynced tardío de un worker rezagado.
@Query("""
    UPDATE pending_payments
    SET sync_status = 'SUCCESS', claim_token = NULL, claimed_at = NULL
    WHERE id = :id AND sync_status IN ('PENDING', 'SYNCING')
""")
suspend fun markSynced(id: Long)
```

```kotlin
// resetAllFailed: excluir los permanentes.
@Query("""
    UPDATE pending_payments
    SET sync_status = 'PENDING', retry_count = 0
    WHERE sync_status = 'FAILED' AND permanent = 0
""")
suspend fun resetAllFailed(): Int
```

En `PaymentSyncWorker.kt`, la rama `SyncOutcome.Permanent` (Task 5) pasa a llamar
`paymentQueueRepository.markPermanentlyFailed(payment.queueId, outcome.reason)` en vez de `release(...)`. Añadir el método a la interfaz
`PaymentQueueRepository` y su impl, siguiendo el patrón de `release`.

- [ ] **Step 5: Corregir el KDoc que miente**

Reemplazar toda mención de "3 attempts" / "3 retries" / "Retry count >= 3" por 10, en:

- `PaymentSyncWorker.kt:24,41,45,64-66,191,196`
- `PendingPaymentDao.kt:83-84`
- `PendingPaymentEntity.kt:17`

Y quitar del KDoc del worker las líneas que describen el backoff exponencial interno (`:45,98-99,183-190`), que ya no existe tras la Task 5.

- [ ] **Step 6: Correr los tests**

Run: `./gradlew connectedProductionDebugAndroidTest --tests "*PendingPaymentClaimTest*"` Expected: PASS

Run: `./gradlew testProductionDebugUnitTest --tests "*Payment*"` Expected: PASS

- [ ] **Step 7: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/local/ \
        app/src/main/java/com/jaac/avoqado_tpv/core/data/workers/PaymentSyncWorker.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/repository/PaymentQueueRepository.kt \
        app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/PaymentQueueRepositoryImpl.kt \
        app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/
git commit -m "fix(payments): reset selectivo, markSynced con guarda y KDoc real (Room v29)

resetAllFailed() resucitaba tambien los 4xx permanentes con retry_count=0, asi
que se reintentaban en cada reconexion para siempre. markSynced podia voltear
una fila FAILED a SUCCESS. Y el KDoc decia '3 attempts' en cinco lugares cuando
MAX_RETRY_ATTEMPTS = 10."
```

---

## Task 8: F-5 — clasificar por código en los 4 sitios restantes

Los mismos `contains()` viven en cuatro archivos más. Un cambio de wording en el server rompe la clasificación **en silencio**: un error
transitorio se vuelve permanente o al revés.

**Files:**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/usecase/RecordPaymentUseCase.kt:310-328`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/repository/ActivationRepositoryImpl.kt:125,128,148,151`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/repository/TerminalConfigRepositoryImpl.kt:168,173,174`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/presentation/viewmodels/HomeViewModel.kt:807,808`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcomeTest.kt` (extender)

**Interfaces:**

- Consumes: `classifySyncFailure` y `BackendHttpException` (Task 1).
- Produces: nada nuevo — es la aplicación del clasificador ya existente.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `SyncOutcomeTest.kt`:

```kotlin
@Test
fun `isRetryable no se rompe si el server cambia el texto del mensaje`() {
    // Antes: message.contains("Error del servidor") / Regex("5\\d{2}").
    // Si el server traduce o reescribe el mensaje, la clasificacion se rompia
    // EN SILENCIO. Ahora solo importa el codigo.
    val conTextoNuevo = BackendHttpException(503, "Servicio temporalmente no disponible")
    assertThat(classifySyncFailure(conTextoNuevo)).isInstanceOf(SyncOutcome.Retryable::class.java)

    val enIngles = BackendHttpException(503, "Service temporarily unavailable")
    assertThat(classifySyncFailure(enIngles)).isInstanceOf(SyncOutcome.Retryable::class.java)

    val vacio = BackendHttpException(503, "")
    assertThat(classifySyncFailure(vacio)).isInstanceOf(SyncOutcome.Retryable::class.java)
}

@Test
fun `un 401 sigue siendo permanente sin importar el idioma`() {
    assertThat(classifySyncFailure(BackendHttpException(401, "No autorizado")))
        .isInstanceOf(SyncOutcome.Permanent::class.java)
    assertThat(classifySyncFailure(BackendHttpException(401, "")))
        .isInstanceOf(SyncOutcome.Permanent::class.java)
}
```

- [ ] **Step 2: Correr y verificar que pasa ya (el clasificador de Task 1 lo cubre)**

Run: `./gradlew testProductionDebugUnitTest --tests "*SyncOutcomeTest*"` Expected: PASS. El clasificador ya es correcto; lo que falta es
**usarlo** en los 4 sitios.

- [ ] **Step 3: Reemplazar el nido de `RecordPaymentUseCase`**

Borrar el bloque `:310-328` completo (los ~18 `contains()`) y sustituir la función por:

```kotlin
/**
 * ¿Vale la pena reintentar este error?
 *
 * Antes esto encadenaba ~18 `message.contains(...)`, incluido `Regex("5\\d{2}")`.
 * Cualquier cambio de wording en el server rompia la clasificacion en silencio.
 * Ahora delega en el clasificador unico por codigo. Ver spec §4.2 F-5.
 */
private fun isRetryable(error: Throwable?): Boolean =
    classifySyncFailure(error) is SyncOutcome.Retryable
```

Actualizar las llamadas al viejo helper para pasarle el `Throwable` en vez del `String`.

- [ ] **Step 4: Reemplazar en los otros tres archivos**

En `ActivationRepositoryImpl.kt`, `TerminalConfigRepositoryImpl.kt` y `HomeViewModel.kt`, sustituir cada
`message.contains("expired"|"timeout"|"network"|"UnknownHostException")` por `classifySyncFailure(error) is SyncOutcome.Retryable`,
asegurando que el `Throwable` llegue intacto hasta ahí (si alguna capa intermedia lo envuelve en una `Exception` genérica, pasar el
`cause`).

Para el caso específico de sesión expirada, usar el código, no el texto:

```kotlin
val sessionExpired = (error as? BackendHttpException)?.statusCode == 401
```

- [ ] **Step 5: Correr toda la suite**

Run: `./gradlew testProductionDebugUnitTest` Expected: PASS

- [ ] **Step 6: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/usecase/RecordPaymentUseCase.kt \
        app/src/main/java/com/jaac/avoqado_tpv/core/data/repository/ \
        app/src/main/java/com/jaac/avoqado_tpv/core/presentation/viewmodels/HomeViewModel.kt \
        app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/sync/SyncOutcomeTest.kt
git commit -m "fix(tpv): clasificar retry/fail por codigo en los 4 sitios restantes

RecordPaymentUseCase encadenaba ~18 contains() incluido Regex(5\\\\d{2}).
Cualquier cambio de wording en el server rompia la clasificacion en silencio."
```

---

## Task 9: F-3 — un solo dueño de la franja superior

Siete banners y dos fuentes de conectividad, sin dueño único. **Primero verificar cuáles se apilan de verdad** — no asumir.

**Files:**

- Create: `app/src/main/java/com/jaac/avoqado_tpv/core/presentation/components/ConnectionBannerHost.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/presentation/navigation/AppNavigation.kt`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/core/presentation/components/ConnectionBannerHostTest.kt` (crear)

**Interfaces:**

- Consumes: nada de tareas previas.
- Produces: `ConnectionBannerHost(modifier)` y `enum class BannerPriority`.

- [ ] **Step 1: Verificar qué se apila de verdad**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
rg -n "ConnectionBanner|DeviceAlertBanner|VenueStatusBanner|ShiftStatusBanner|AngelPayAuthBanner|PayLaterBanner|UnpaidTakeoutBanner" \
   -g '*.kt' app/src/main/java/com/jaac/avoqado_tpv/ | rg -v "^app.*components/(Connection|Device|Venue|Shift)"
```

Anotar en qué pantallas coinciden dos o más. **Solo consolidar los que realmente coexisten**; los que viven en pantallas distintas se quedan
donde están.

- [ ] **Step 2: Escribir el test que falla**

```kotlin
package com.jaac.avoqado_tpv.core.presentation.components

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class ConnectionBannerHostTest {

    @Test
    fun `con varias condiciones activas solo se muestra la de mayor prioridad`() {
        val visible = resolveVisibleBanner(
            offline = true,
            venueSuspended = true,
            shiftClosed = true,
        )
        // Sin conexion gana: es lo que explica por que todo lo demas falla.
        assertThat(visible).isEqualTo(BannerPriority.OFFLINE)
    }

    @Test
    fun `sin condiciones activas no se muestra nada`() {
        val visible = resolveVisibleBanner(
            offline = false,
            venueSuspended = false,
            shiftClosed = false,
        )
        assertThat(visible).isNull()
    }

    @Test
    fun `el orden de prioridad es estable`() {
        assertThat(resolveVisibleBanner(offline = false, venueSuspended = true, shiftClosed = true))
            .isEqualTo(BannerPriority.VENUE_SUSPENDED)
        assertThat(resolveVisibleBanner(offline = false, venueSuspended = false, shiftClosed = true))
            .isEqualTo(BannerPriority.SHIFT_CLOSED)
    }
}
```

- [ ] **Step 3: Correr y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*ConnectionBannerHostTest*"` Expected: FAIL —
`Unresolved reference: resolveVisibleBanner`

- [ ] **Step 4: Implementar el host**

Crear `ConnectionBannerHost.kt`:

```kotlin
package com.jaac.avoqado_tpv.core.presentation.components

/**
 * Prioridad de la franja superior. Solo se muestra UNA a la vez.
 *
 * El orden importa: sin conexión gana siempre porque explica por qué todo lo
 * demás está fallando. Un banner tapando a otro deja al cajero adivinando.
 */
enum class BannerPriority { OFFLINE, VENUE_SUSPENDED, SHIFT_CLOSED }

/** Función pura para poder testear la prioridad sin levantar Compose. */
fun resolveVisibleBanner(
    offline: Boolean,
    venueSuspended: Boolean,
    shiftClosed: Boolean,
): BannerPriority? = when {
    offline -> BannerPriority.OFFLINE
    venueSuspended -> BannerPriority.VENUE_SUSPENDED
    shiftClosed -> BannerPriority.SHIFT_CLOSED
    else -> null
}
```

Añadir en el mismo archivo el composable `ConnectionBannerHost(...)` que lea las fuentes (`ConnectivityObserver` / `ConnectionViewModel`) y
renderice el banner que devuelva `resolveVisibleBanner`, reusando los composables existentes para el contenido de cada uno.

- [ ] **Step 5: Montarlo una sola vez**

En `AppNavigation.kt`, colocar `ConnectionBannerHost()` en un único `Column` por encima del `NavHost` (patrón de `avoqado-android`:
`AvoqadoNavGraph.kt` monta ConnectivityBanner + QuarantineBanner en orden fijo). Quitar de las pantallas individuales los banners que
quedaron absorbidos, **solo los que el Step 1 confirmó que coexistían**.

- [ ] **Step 6: Correr los tests y compilar**

Run: `./gradlew testProductionDebugUnitTest --tests "*ConnectionBannerHostTest*"` Expected: PASS

Run: `./gradlew assembleProductionDebug` Expected: BUILD SUCCESSFUL

- [ ] **Step 7: Commit** _(solo con permiso del founder)_

```bash
git add app/src/main/java/com/jaac/avoqado_tpv/core/presentation/
git commit -m "refactor(tpv): un solo dueno de la franja de banners

Siete banners y dos fuentes de conectividad sin dueno unico podian encimarse.
ConnectionBannerHost resuelve una sola prioridad; sin conexion gana siempre
porque explica por que todo lo demas esta fallando."
```

---

## Apéndice — helpers de test compartidos

Las tareas 2, 3, 5 y 6 usan estos constructores. Escribirlos **una vez** en
`app/src/test/java/com/jaac/avoqado_tpv/features/payment/TestPayments.kt` (y una copia en `app/src/androidTest/.../TestPayments.kt` para los
tests de Room, que no ven el source set de `test`).

```kotlin
package com.jaac.avoqado_tpv.features.payment

import com.jaac.avoqado_tpv.core.data.local.entity.PendingPaymentEntity
import com.jaac.avoqado_tpv.features.payment.domain.model.QueuedPayment
import com.jaac.avoqado_tpv.features.payment.domain.processor.ProcessorType
import java.math.BigDecimal

/**
 * Pago encolado mínimo válido. Los campos opcionales toman su default del data
 * class — solo se nombran aquí los que NO tienen default.
 *
 * `createdAt` es relativo a propósito: una fecha hardcodeada convierte el test en
 * una bomba de tiempo.
 */
fun queuedPayment(
    reference: String = "000000111111",
    amount: BigDecimal = BigDecimal("50.00"),
    retryCount: Int = 0,
): QueuedPayment = QueuedPayment(
    referenceNumber = reference,
    venueId = "venue-test",
    staffId = "staff-test",
    amount = amount,
    tip = BigDecimal.ZERO,
    rating = null,
    merchantAccountId = "merchant-test",
    blumonSerialNumber = "",
    maskedPan = "**** 4242",
    cardBrand = "VISA",
    entryMode = "CHIP",
    isInternational = false,
    authorizationNumber = "123456",
    processor = ProcessorType.ANGELPAY,
    createdAt = System.currentTimeMillis(),
    retryCount = retryCount,
)

/** Fila de Room equivalente, para los tests que van contra el DAO. */
fun newPending(
    reference: String = "000000111111",
    status: String = "PENDING",
    retryCount: Int = 0,
): PendingPaymentEntity = PendingPaymentEntity(
    referenceNumber = reference,
    venueId = "venue-test",
    staffId = "staff-test",
    amount = "50.00",
    tip = "0.00",
    rating = null,
    merchantAccountId = "merchant-test",
    blumonSerialNumber = "",
    maskedPan = "**** 4242",
    cardBrand = "VISA",
    entryMode = "CHIP",
    isInternational = false,
    authorizationNumber = "123456",
    syncStatus = status,
    retryCount = retryCount,
    createdAt = System.currentTimeMillis(),
)

/** Alias que usa el test de la Task 2 al construir la fila existente del choque. */
fun entity(reference: String, status: String) = newPending(reference, status)
```

> **Al escribirlo:** abrir `features/payment/domain/model/QueuedPayment.kt` y `core/data/local/entity/PendingPaymentEntity.kt` y confirmar
> la lista exacta de parámetros sin default. Si alguno cambió (el repo se mueve), agregarlo aquí con un valor mínimo válido — **nunca**
> silenciar el error borrando el campo del modelo.

## Verificación final del plan

- [ ] `./gradlew testProductionDebugUnitTest` — PASS
- [ ] `./gradlew connectedProductionDebugAndroidTest` — PASS (requiere terminal o emulador)
- [ ] `./gradlew assembleProductionDebug` y `assembleSandboxDebug` — BUILD SUCCESSFUL
- [ ] `features/ordering/` sin cambios: `git diff --stat main -- app/src/main/java/com/jaac/avoqado_tpv/features/ordering/` vacío
- [ ] Room en v29 con las migraciones 27→28 y 28→29 cubiertas por `AvoqadoDatabaseMigrationTest`

## Qué NO cubre este plan

- **Plan B** — superficie `/tpv` en `avoqado-server` (rutas nuevas §7.2, reducer de intents bajo `/tpv`, extracción a servicios compartidos,
  `checkFeatureAccess`, y el hueco de seguridad §4.4).
- **Plan C** — el módulo `features/tables/` en la TPV. Depende de A y B.
- **F-2** — los 11 `syncOrderImmediately` de `MenuViewModel.kt`. Saltada a propósito (spec D-4): ese archivo queda huérfano cuando entre
  Mesas.
- **§4.3** — migrar las 2 llamadas a `dashboard/products` y `dashboard/categories`. Va en el Plan C, que es quien consume el menú.
