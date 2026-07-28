# Plan C — Módulo Mesas offline-first (avoqado-tpv)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un módulo `features/tables/` en la TPV que replique el flujo de mesa de `avoqado-android`, adaptado a PAX y NEXGO, offline-first
para ordenar y manejo interno, hablando solo con `/api/v1/tpv/*`.

**Architecture:** Todo lo que el mesero hace sin red se guarda como **intent** en un outbox local (UUID + `seq` FIFO) y se reproduce contra
el reducer idempotente del server. El cobro con tarjeta es online por física (el procesador no soporta offline) y se muestra como estado, no
como error. El módulo no importa nada de `features/ordering/` (legacy) ni de `features/checkout/`.

**Tech Stack:** Kotlin · Jetpack Compose · Room 2.7 · Hilt · Retrofit · Socket.IO · JUnit4 + MockK + Truth + Turbine + Robolectric

**Spec:** `docs/superpowers/specs/2026-07-24-tpv-mesas-offline-first-design.md` **Repo:**
`/Users/amieva/Documents/Programming/Avoqado/avoqado-tpv` (rama `main`) **Depende de:** Plan A (cola de pagos blindada) y Plan B (rutas
`/tpv`). No empezar sin ambos.

## Global Constraints

- **Solo `/api/v1/tpv/*`.** Ni un `mobile/`, ni un `dashboard/` nuevo. La TPV hoy está en 125 `tpv/` y 0 `mobile/`; la Task 9 cierra las 2
  de `dashboard/` que quedan.
- **`features/tables/` no importa NADA de `features/ordering/` ni de `features/checkout/`.** Es la regla que hace que el legacy se pueda
  borrar después sin arrastrar el módulo nuevo.
- **NO tocar `features/ordering/`.** Sigue compilando y funcionando: es la red de seguridad.
- **🔴 LEER PRIMERO `avoqado-server/.claude/rules/offline-first-y-hub-lan.md`.** Es la regla canónica del contrato offline, escrita por la
  sesión que shipeó esto en Android + iOS + server. Lo que sigue son sus puntos que más pegan a este plan; ante cualquier discrepancia,
  **gana la regla**.
- **Los strings de tipo de intent son espejo EXACTO del server** (14 tipos al 2026-07-25). Construir contra lo que aterrice, no contra una
  foto. La Task 3 incluye el test que detecta el desfase.
- **Los tres estados de ack, y el del medio es el que se olvida:** `ACKED` (aplicado, terminal) · `REJECTED` (rechazo de negocio permanente
  → cuarentena visible) · `RETRY` (transitorio, hoy solo `VERSION_CONFLICT`: se queda PENDING y **corta el batch** para preservar el FIFO;
  **no se persiste**). Convertir un transitorio en `REJECTED` pierde el intent para siempre — fue un P1 real.
- **Identidad local — dos ids, no uno.** `localOrderId` (la orden; `OPEN_TABLE` lo mapea al id real) y `externalId` para las **líneas**:
  `ADD_ITEMS` inyecta `sync:<intentId>:<idx>`, determinista y por tanto predecible desde el cliente. Es lo que permite separar un cheque que
  **aún no sincroniza**. El `deviceId` se reusa del outbox — **no inventar otro**.
- **Dinero:** `PAY_CASH` viaja con `idempotencyKey` (= id del intent), el server deduplica por `[venueId, idempotencyKey]`; sin eso un
  reintento **cobra dos veces**. `ADD_ITEMS` usa CAS real sobre `version`, no incremento ciego. `SPLIT_ORDER` resuelve referencias
  **todo-o-nada**: si una no resuelve, rechaza (un cheque partido a medias cobra de menos a uno y de más a otro, y el mesero no tiene cómo
  notarlo).
- **Online-only a propósito** (no es olvido, no intentar encolarlo): quitar un descuento o cargo **ya aplicado**, cortesía de **un item ya
  enviado**, canje de lealtad, **pago con tarjeta**, turnos, login/logout.
- **Red caída ⇒ outbox. El server dijo que no ⇒ error al usuario.** Nunca se confunden. Es la regla que gobierna todo el módulo.
- **Cobro con tarjeta = online.** Sin red el botón va deshabilitado **con la razón**, y la cuenta queda abierta. Nunca pantalla roja.
- **En la TPV el canvas NO se edita.** Se asume que el plano del venue ya existe. Sin arrastrar, sin crear, sin borrar mesas.
- **Money = `BigDecimal`, PESOS 1:1.**
- **Nunca commitear sin permiso explícito del founder.**
- Gate por tarea: `./gradlew testProductionDebugUnitTest`. Gate final: build de los dos flavors.

## File Structure

```
features/tables/
├── domain/model/    DiningTable · TableOrder · OrderDetail · TableSession
├── data/
│   ├── api/         TablesApiService (Retrofit, SOLO tpv/…)
│   ├── local/       SyncIntentEntity · SyncIntentDao · TablesDatabase
│   ├── sync/        SyncOutbox · SyncIntentTypes · TableSyncCoordinator
│   └── TablesRepository (con orQueueOffline)
└── presentation/    TablesScreen · TableSheet · TableOrderScreen
                     TableMenuScreen · TableCheckoutScreen · QuarantineSheet
                     + ViewModels
```

**Referencia a espejar** (`avoqado-android`, ya probado en producción): `core/data/sync/SyncOutbox.kt` ·
`core/data/local/database/SyncIntentEntity.kt` · `tables/data/TableSyncCoordinator.kt` · `tables/data/TableSession.kt` ·
`tables/data/TableServiceRepository.kt` (`orQueueOffline`) · `tables/presentation/TablesScreen.kt` (`FloorCanvas` :508, `TableGrid` :584) ·
`sync/presentation/QuarantineViewModel.kt`

---

## Task 1: Modo restaurante — flag, toggle y tile

**Files:**

- Modify: `features/payment/domain/model/TpvSettings.kt`
- Modify: `core/data/network/dto/TpvSettingsDto.kt`
- Modify: `core/data/local/SecureStorage.kt`
- Modify: `features/settings/presentation/SettingsScreen.kt` + `SettingsViewModel.kt`
- Modify: `core/presentation/screens/WelcomeScreen.kt:794-952`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/domain/model/TpvSettingsRestaurantModeTest.kt`

**Interfaces:**

- Produces: `TpvSettings.restaurantModeEnabled: Boolean = false`; `NavRoute.Tables`.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun `restaurantModeEnabled es false por default`() {
    // Aditivo: las terminales viejas no deben ver Mesas de la nada.
    assertThat(TpvSettings().restaurantModeEnabled).isFalse()
}

@Test
fun `el DTO sin el campo cae al default`() {
    // Backend viejo o respuesta parcial: nunca debe romper el parseo.
    val dto = TpvSettingsDto(/* … resto con null … */ restaurantModeEnabled = null)
    assertThat(dto.toDomain().restaurantModeEnabled).isFalse()
}

@Test
fun `modo restaurante ON oculta el tile de Ordenes`() {
    // Nunca conviven los dos caminos hacia la misma mesa (spec D-4).
    val settings = TpvSettings(restaurantModeEnabled = true, showOrderManagement = true)
    assertThat(shouldShowOrderManagementTile(settings)).isFalse()
    assertThat(shouldShowTablesTile(settings)).isTrue()
}

@Test
fun `modo restaurante OFF deja el tile de Ordenes como estaba`() {
    val settings = TpvSettings(restaurantModeEnabled = false, showOrderManagement = true)
    assertThat(shouldShowOrderManagementTile(settings)).isTrue()
    assertThat(shouldShowTablesTile(settings)).isFalse()
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*TpvSettingsRestaurantModeTest*"`

- [ ] **Step 3: Añadir el flag**

En `TpvSettings.kt`, junto a los ~35 flags existentes:

```kotlin
/**
 * Muestra el módulo Mesas en el home. Espejo del PosMode.RESTAURANT de android.
 *
 * Default `false` y aditivo: una terminal con backend viejo o respuesta parcial
 * no ve Mesas de la nada. Al prenderlo, el tile "Órdenes" (legacy) se oculta —
 * nunca conviven dos caminos hacia la misma mesa (spec D-4).
 */
val restaurantModeEnabled: Boolean = false,
```

En `TpvSettingsDto.kt`: `@SerializedName("restaurantModeEnabled") val restaurantModeEnabled: Boolean?` y en el mapper
`restaurantModeEnabled = restaurantModeEnabled ?: false`. En `SecureStorage.kt`:
`putBoolean(KEY_TPV_RESTAURANT_MODE, settings.restaurantModeEnabled)` al guardar y `getBoolean(KEY_TPV_RESTAURANT_MODE, false)` al leer,
siguiendo el patrón de `:1190` y `:1258`.

- [ ] **Step 4: Añadir las funciones puras de visibilidad**

En el mismo archivo que `TpvSettings`:

```kotlin
/** El tile Mesas aparece solo con modo restaurante prendido. */
fun shouldShowTablesTile(settings: TpvSettings): Boolean = settings.restaurantModeEnabled

/**
 * El tile "Órdenes" (legacy) se esconde cuando Mesas está prendido.
 * `showOrderManagement` sigue en `true` a nivel global a propósito: las terminales
 * sin Mesas lo conservan.
 */
fun shouldShowOrderManagementTile(settings: TpvSettings): Boolean =
    settings.showOrderManagement && !settings.restaurantModeEnabled
```

- [ ] **Step 5: Cablear el toggle y el tile**

En `SettingsViewModel.kt`, añadir el toggle siguiendo el patrón de los de `:188-534`. En `WelcomeScreen.kt:822`, cambiar
`if (tpvSettings.showOrderManagement)` por `if (shouldShowOrderManagementTile(tpvSettings))`, y añadir el tile "Mesas" en el bloque
`:794-952` con `if (shouldShowTablesTile(tpvSettings))`, navegando a `NavRoute.Tables`. Aplicar el mismo gating de plan que los tiles
vecinos (**PRO+ con teaser visible**: en venue FREE se ve con candado y lleva a upsell — spec D-1). En `NavRoute.kt`, añadir
`object Tables : NavRoute("tables")`.

- [ ] **Step 6: Correr los tests**

Run: `./gradlew testProductionDebugUnitTest --tests "*TpvSettings*"` → PASS

- [ ] **Step 7: Commit** _(solo con permiso del founder)_

```bash
git commit -m "feat(tables): flag de modo restaurante, toggle y tile Mesas

Al prenderlo aparece Mesas y se oculta el tile Ordenes legacy: nunca conviven
dos caminos hacia la misma mesa. Aditivo, default false."
```

---

## Task 2: Modelos de dominio y `TablesApiService`

**Files:**

- Create: `features/tables/domain/model/{DiningTable,TableOrder,OrderDetail}.kt`
- Create: `features/tables/data/api/TablesApiService.kt`
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/tables/data/api/TablesApiServiceContractTest.kt`

**Interfaces:**

- Produces: `DiningTable(id, number, capacity, positionX, positionY, shape, rotation, status, areaId, areaName, currentOrder, openOrders)`;
  `TableOrder(id, orderNumber, total, version, …)`; `OrderDetail(items, payments, discounts, version)`.

- [ ] **Step 1: Escribir el test de contrato que falla**

```kotlin
@Test
fun `todas las rutas del servicio son del namespace tpv`() {
    // El TPV esta aislado a /api/v1/tpv/*. Un mobile/ o dashboard/ que se cuele
    // rompe la regla y nadie lo nota hasta produccion.
    val rutas = TablesApiService::class.java.declaredMethods.flatMap { method ->
        method.annotations.mapNotNull { annotation ->
            when (annotation) {
                is retrofit2.http.GET -> annotation.value
                is retrofit2.http.POST -> annotation.value
                is retrofit2.http.PUT -> annotation.value
                is retrofit2.http.DELETE -> annotation.value
                else -> null
            }
        }
    }

    assertThat(rutas).isNotEmpty()
    rutas.forEach { ruta ->
        assertThat(ruta).startsWith("tpv/")
    }
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew testProductionDebugUnitTest --tests "*TablesApiServiceContractTest*"`

- [ ] **Step 3: Escribir los modelos**

Espejar los de `avoqado-android/tables/data/TableModels.kt`, con `version: Int` en `TableOrder` y `OrderDetail` (concurrencia optimista) y
`positionX`/`positionY` como `Float?` normalizados 0–1.

- [ ] **Step 4: Escribir el `TablesApiService`**

```kotlin
interface TablesApiService {

    @GET("tpv/venues/{venueId}/tables")
    suspend fun getTables(@Path("venueId") venueId: String): Response<TablesResponse>

    @GET("tpv/venues/{venueId}/floor-elements")
    suspend fun getFloorElements(@Path("venueId") venueId: String): Response<FloorElementsResponse>

    @POST("tpv/venues/{venueId}/tables/{tableId}/open")
    suspend fun openTable(
        @Path("venueId") venueId: String,
        @Path("tableId") tableId: String,
        @Body body: OpenTableRequest,
    ): Response<OrderDetailResponse>

    @POST("tpv/venues/{venueId}/orders/{orderId}/items")
    suspend fun addItems(
        @Path("venueId") venueId: String,
        @Path("orderId") orderId: String,
        @Body body: AddOrderItemsRequest, // lleva `version`
    ): Response<OrderDetailResponse>

    @POST("tpv/venues/{venueId}/orders/{orderId}/split")
    suspend fun splitOrder(/* … */): Response<OrderDetailResponse>

    @POST("tpv/venues/{venueId}/orders/{orderId}/merge")
    suspend fun mergeOrders(/* … */): Response<OrderDetailResponse>

    @POST("tpv/venues/{venueId}/orders/{orderId}/discounts")
    suspend fun applyDiscount(/* … */): Response<OrderDetailResponse>

    @POST("tpv/venues/{venueId}/tables/{tableId}/clear")
    suspend fun clearTable(/* … */): Response<Unit>

    @POST("tpv/venues/{venueId}/sync/intents")
    suspend fun syncIntents(
        @Path("venueId") venueId: String,
        @Body body: SyncIntentsRequest,
    ): Response<SyncIntentsResponse>
}
```

Completar los `@Body` y tipos de respuesta contra lo que el **Plan B** dejó montado. Los DTO van en `features/tables/data/api/dto/`.

- [ ] **Step 5: Correr los tests** → PASS

- [ ] **Step 6: Commit** _(con permiso)_

---

## Task 3: El outbox — corazón del offline

**Files:**

- Create: `features/tables/data/local/{SyncIntentEntity,SyncIntentDao,TablesDatabase}.kt`
- Create: `features/tables/data/sync/{SyncOutbox,SyncIntentTypes}.kt`
- Test: `app/src/androidTest/.../SyncOutboxTest.kt`

**Interfaces:**

- Consumes: `TablesApiService.syncIntents` (Task 2).
- Produces: `SyncOutbox.enqueue(venueId, type, payload): String` · `replayNow(venueId)` · `rejectedIntents(venueId)` ·
  `dismissRejected(venueId, id)`.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun el_seq_se_asigna_en_transaccion_y_respeta_el_orden() = runTest {
    // Sin @Transaction, dos enqueue concurrentes pueden tomar el mismo seq y el
    // replay se desordena: un ADD_ITEMS llegaria ANTES de su OPEN_TABLE.
    val ids = (1..50).map { i ->
        async { outbox.enqueue("venue-a", SyncIntentTypes.ADD_ITEMS, payload(i)) }
    }.awaitAll()

    val seqs = dao.allForVenue("venue-a").map { it.seq }
    assertThat(seqs).containsNoDuplicates()
    assertThat(seqs).isInStrictOrder()
    assertThat(ids.toSet()).hasSize(50) // cada intent con su propio UUID
}

@Test
fun un_intent_ACKED_sale_de_la_cola() = runTest {
    val id = outbox.enqueue("venue-a", SyncIntentTypes.OPEN_TABLE, payload(1))
    outbox.applyAck(id, status = "ACKED", errorCode = null)
    assertThat(dao.pendingForVenue("venue-a")).isEmpty()
}

@Test
fun un_intent_RETRY_se_queda_PENDING_y_no_se_pierde() = runTest {
    // VERSION_CONFLICT es transitorio: el server dice "reintenta", no "no".
    val id = outbox.enqueue("venue-a", SyncIntentTypes.ADD_ITEMS, payload(1))
    outbox.applyAck(id, status = "RETRY", errorCode = "VERSION_CONFLICT")
    assertThat(dao.pendingForVenue("venue-a")).hasSize(1)
}

@Test
fun un_intent_REJECTED_va_a_cuarentena_visible() = runTest {
    // Rechazo de negocio permanente: NO se reintenta y NO desaparece — el mesero
    // tiene que poder verlo y decidir.
    val id = outbox.enqueue("venue-a", SyncIntentTypes.ADD_ITEMS, payload(1))
    outbox.applyAck(id, status = "REJECTED", errorCode = "TABLE_OWNED_BY_OTHER")

    assertThat(dao.pendingForVenue("venue-a")).isEmpty()
    assertThat(outbox.rejectedIntents("venue-a")).hasSize(1)
}

@Test
fun reproducir_el_mismo_intent_dos_veces_tiene_un_solo_efecto() = runTest {
    val id = outbox.enqueue("venue-a", SyncIntentTypes.PAY_CASH, payload(1))
    outbox.applyAck(id, status = "ACKED", errorCode = null)
    outbox.applyAck(id, status = "ACKED", errorCode = null) // duplicado

    assertThat(dao.allForVenue("venue-a").count { it.id == id }).isEqualTo(1)
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `./gradlew connectedProductionDebugAndroidTest --tests "*SyncOutboxTest*"`

- [ ] **Step 3: Escribir la entidad y el DAO**

Espejar `avoqado-android/core/data/local/database/SyncIntentEntity.kt`. Lo que **no** se puede simplificar: la asignación de `seq` va dentro
de un `@Transaction` junto al insert.

```kotlin
@Dao
interface SyncIntentDao {
    /**
     * Inserta el intent tomando el siguiente seq DENTRO de la misma transacción.
     *
     * Si el seq se leyera fuera, dos enqueue concurrentes tomarían el mismo número
     * y el replay se desordenaría: un ADD_ITEMS podría ordenarse antes de su
     * OPEN_TABLE y el reducer lo rechazaría. @Transaction serializa el par.
     */
    @Transaction
    suspend fun insertWithSeq(intent: SyncIntentEntity): Long {
        val next = (maxSeq(intent.venueId) ?: 0L) + 1
        insert(intent.copy(seq = next))
        return next
    }

    @Query("SELECT MAX(seq) FROM sync_intents WHERE venue_id = :venueId")
    suspend fun maxSeq(venueId: String): Long?

    @Insert
    suspend fun insert(intent: SyncIntentEntity)

    @Query("SELECT * FROM sync_intents WHERE venue_id = :venueId AND status = 'PENDING' ORDER BY seq ASC")
    suspend fun pendingForVenue(venueId: String): List<SyncIntentEntity>

    @Query("SELECT * FROM sync_intents WHERE venue_id = :venueId AND status = 'REJECTED' ORDER BY seq ASC")
    suspend fun rejectedForVenue(venueId: String): List<SyncIntentEntity>

    @Query("SELECT * FROM sync_intents WHERE venue_id = :venueId ORDER BY seq ASC")
    suspend fun allForVenue(venueId: String): List<SyncIntentEntity>
}
```

- [ ] **Step 4: Escribir el `SyncOutbox`**

Espejar la API de `avoqado-android/core/data/sync/SyncOutbox.kt` (`enqueue` :156, `replayNow` :177, `rejectedIntents` :253,
`dismissRejected` :259). `replayNow` manda el batch FIFO a `TablesApiService.syncIntents` y aplica los acks:

```kotlin
/**
 * Aplica el ack del server a un intent.
 *
 * ACKED   → aplicado, sale de la cola.
 * RETRY   → transitorio (VERSION_CONFLICT): se queda PENDING y se reintenta solo.
 * REJECTED→ rechazo de negocio permanente: va a cuarentena VISIBLE. No se
 *           reintenta y no desaparece — el mesero tiene que poder verlo.
 */
suspend fun applyAck(intentId: String, status: String, errorCode: String?) { /* … */ }
```

- [ ] **Step 5: Escribir `SyncIntentTypes` con el test de espejo**

```kotlin
/** Espejo EXACTO de SyncIntentType en el server. Un desfase falla en silencio. */
object SyncIntentTypes {
    const val OPEN_TABLE = "OPEN_TABLE"
    const val ADD_ITEMS = "ADD_ITEMS"
    const val PAY_CASH = "PAY_CASH"
    const val APPLY_DISCOUNT = "APPLY_DISCOUNT"
    const val APPLY_SERVICE_CHARGE = "APPLY_SERVICE_CHARGE"
    const val COMP_ORDER = "COMP_ORDER"
    const val UPDATE_DETAILS = "UPDATE_DETAILS"
    const val CANCEL_ORDER = "CANCEL_ORDER"
    const val MOVE_ORDER = "MOVE_ORDER"
    const val ASSIGN_ORDER = "ASSIGN_ORDER"
    const val CLEAR_TABLE = "CLEAR_TABLE"
    const val SPLIT_ORDER = "SPLIT_ORDER"
    const val SPLIT_BY_SEAT = "SPLIT_BY_SEAT"
    const val MERGE_ORDERS = "MERGE_ORDERS"

    val ALL = setOf(
        OPEN_TABLE, ADD_ITEMS, PAY_CASH, APPLY_DISCOUNT, APPLY_SERVICE_CHARGE,
        COMP_ORDER, UPDATE_DETAILS, CANCEL_ORDER, MOVE_ORDER, ASSIGN_ORDER,
        CLEAR_TABLE, SPLIT_ORDER, SPLIT_BY_SEAT, MERGE_ORDERS,
    )
}
```

Y el test que detecta el desfase (otra sesión sigue moviendo el reducer):

```kotlin
@Test
fun los_tipos_de_intent_son_espejo_exacto_del_server() {
    // Fuente: SyncIntentType en avoqado-server/src/services/mobile/sync.mobile.service.ts
    // Si el server agrega un tipo y aqui no, el TPV lo ignora EN SILENCIO.
    val delServer = setOf(
        "OPEN_TABLE", "ADD_ITEMS", "PAY_CASH", "APPLY_DISCOUNT", "APPLY_SERVICE_CHARGE",
        "COMP_ORDER", "UPDATE_DETAILS", "CANCEL_ORDER", "MOVE_ORDER", "ASSIGN_ORDER",
        "CLEAR_TABLE", "SPLIT_ORDER", "SPLIT_BY_SEAT", "MERGE_ORDERS",
    )
    assertThat(SyncIntentTypes.ALL).isEqualTo(delServer)
}
```

> **14 tipos al 2026-07-25.** `SPLIT_BY_SEAT` es tipo propio, no un flag de `SPLIT_ORDER`. La lista canónica vive en
> `avoqado-server/.claude/rules/offline-first-y-hub-lan.md` §2.1 — leerla al ejecutar, porque sigue creciendo. Un tipo que el server no
> conoce se rechaza con `UNKNOWN_INTENT_TYPE` y cae en cuarentena (no se pierde).

> **Al ejecutar esta tarea:** abrir `sync.mobile.service.ts` y copiar la unión `SyncIntentType` **de ese momento**. Si ganó tipos,
> agregarlos aquí y al test.

- [ ] **Step 6: Correr los tests** → PASS

- [ ] **Step 7: Commit** _(con permiso)_

---

## Task 4: `orQueueOffline` — la separación que gobierna el módulo

**Files:**

- Create: `features/tables/data/TablesRepository.kt`
- Test: `app/src/test/java/.../TablesRepositoryOfflineTest.kt`

**Interfaces:**

- Consumes: `SyncOutbox` (Task 3), `TablesApiService` (Task 2), `classifySyncFailure` (**Plan A Task 1**).
- Produces: `Result<T>.orQueueOffline(venueId, type, payload, fallback): Result<T>`.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun sin_red_el_intent_va_al_outbox_y_NO_es_error() = runTest {
    coEvery { api.addItems(any(), any(), any()) } throws IOException("sin red")

    val result = repo.addItems(venueId, orderId, items)

    assertThat(result.isSuccess).isTrue()          // el mesero sigue trabajando
    coVerify { outbox.enqueue(venueId, SyncIntentTypes.ADD_ITEMS, any()) }
}

@Test
fun si_el_server_RECHAZA_es_un_error_normal_y_NO_va_al_outbox() = runTest {
    // "El server dijo que no" != "no hay red". Encolar un rechazo de negocio lo
    // haria reintentarse para siempre contra una regla que no va a cambiar.
    coEvery { api.addItems(any(), any(), any()) } returns
        Response.error(400, "".toResponseBody())

    val result = repo.addItems(venueId, orderId, items)

    assertThat(result.isFailure).isTrue()
    coVerify(exactly = 0) { outbox.enqueue(any(), any(), any()) }
}

@Test
fun un_500_del_server_SI_va_al_outbox() = runTest {
    // 5xx es transitorio: el server esta caido, no dijo que no.
    coEvery { api.addItems(any(), any(), any()) } returns
        Response.error(500, "".toResponseBody())

    val result = repo.addItems(venueId, orderId, items)

    assertThat(result.isSuccess).isTrue()
    coVerify { outbox.enqueue(venueId, SyncIntentTypes.ADD_ITEMS, any()) }
}
```

- [ ] **Step 2: Correr y verificar que falla**

- [ ] **Step 3: Implementar**

```kotlin
/**
 * Si la llamada falló por RED, encola el intent y reporta éxito — el mesero sigue
 * trabajando y el outbox se encarga. Si el SERVER RECHAZÓ, propaga el error.
 *
 * Es la regla que gobierna el módulo entero, y la que el ordering legacy nunca
 * tuvo: ahí "no hay red" y "el server dijo que no" caían en el mismo camino y el
 * flujo se moría con el cliente enfrente.
 *
 * Reusa `classifySyncFailure` (Plan A) para no tener DOS definiciones de
 * "transitorio" que puedan divergir.
 */
suspend fun <T> Result<T>.orQueueOffline(
    venueId: String,
    type: String,
    payload: JsonObject,
    fallback: () -> T,
): Result<T> {
    if (isSuccess) return this

    return when (classifySyncFailure(exceptionOrNull())) {
        is SyncOutcome.Retryable -> {
            syncOutbox.enqueue(venueId, type, payload)
            Timber.i("📤 [Tables] Sin conexión — %s encolado", type)
            Result.success(fallback())
        }
        else -> this // el server dijo que no: error normal al usuario
    }
}
```

- [ ] **Step 4: Correr los tests** → PASS
- [ ] **Step 5: Commit** _(con permiso)_

---

## Task 5: `TableSession` y `TableSyncCoordinator`

**Files:**

- Create: `features/tables/domain/model/TableSession.kt`
- Create: `features/tables/data/sync/TableSyncCoordinator.kt`
- Test: `app/src/test/java/.../TableSyncCoordinatorTest.kt`

**Interfaces:**

- Consumes: `SyncOutbox` (Task 3).
- Produces: `TableSession` (singleton, `mode: ORDERING | PAYING`, `orderId` que puede ser un UUID local).

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun el_ack_de_OPEN_TABLE_promueve_el_uuid_local_al_orderId_real() = runTest {
    // Sin esto, la mesa abierta offline queda con un id que el server no conoce y
    // el cobro apuntaria a la nada.
    val localId = "local-uuid-123"
    session.open(tableId = "mesa-1", localOrderId = localId)

    coordinator.onAck(
        intentType = SyncIntentTypes.OPEN_TABLE,
        localOrderId = localId,
        serverOrderId = "orden-real-456",
    )

    assertThat(session.orderId).isEqualTo("orden-real-456")
}

@Test
fun los_intents_posteriores_usan_el_orderId_ya_promovido() = runTest {
    val localId = "local-uuid-123"
    session.open(tableId = "mesa-1", localOrderId = localId)
    coordinator.onAck(SyncIntentTypes.OPEN_TABLE, localId, "orden-real-456")

    val payload = session.buildAddItemsPayload(items)

    assertThat(payload["orderId"].asString).isEqualTo("orden-real-456")
}
```

- [ ] **Step 2: Correr y verificar que falla**
- [ ] **Step 3: Implementar** espejando `avoqado-android/tables/data/TableSession.kt` (:45, :79) y `TableSyncCoordinator.kt` (:23, :76)
- [ ] **Step 4: Correr los tests** → PASS
- [ ] **Step 5: Commit** _(con permiso)_

---

## Task 6: `TablesScreen` — canvas ⇄ lista

**Files:**

- Create: `features/tables/presentation/{TablesScreen,TablesViewModel,TableSheet}.kt`
- Modify: `core/presentation/navigation/AppNavigation.kt`
- Test: `app/src/test/java/.../TablesViewModelTest.kt`

**Interfaces:**

- Consumes: `TablesRepository` (Task 4), `TableSession` (Task 5).
- Produces: ruta `NavRoute.Tables` montada.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun en_pantalla_chica_el_modo_por_default_es_LISTA() {
    // Un canvas de 20 mesas en 480x480 (NEXGO) es inoperable.
    assertThat(defaultViewMode(ScreenProfile.CompactSquare)).isEqualTo(TableViewMode.LIST)
}

@Test
fun en_pantalla_grande_el_modo_por_default_es_CANVAS() {
    assertThat(defaultViewMode(ScreenProfile.RegularPortrait)).isEqualTo(TableViewMode.CANVAS)
}

@Test
fun el_toggle_persiste_la_eleccion_del_usuario() = runTest {
    viewModel.setViewMode(TableViewMode.CANVAS)
    assertThat(viewModel.viewMode.value).isEqualTo(TableViewMode.CANVAS)
}
```

- [ ] **Step 2: Correr y verificar que falla**

- [ ] **Step 3: Implementar**

`FloorCanvas` espejando `avoqado-android/tables/presentation/TablesScreen.kt:508` (BoxWithConstraints + offset sobre coordenadas
normalizadas 0–1, **sin** `detectDragGestures` — en la TPV el canvas no se edita) y `TableGrid` espejando `:584` (agrupado por `areaName`).
Toggle en la top bar. Paleta de estados espejando `:75-80`.

Suscribirse a `table_status_change` y `order_*` del `SocketManager` existente con debounce de ~800ms.

- [ ] **Step 4: Montar la ruta** en `AppNavigation.kt`, siguiendo el patrón de `NavRoute.FloorPlan` (`:1299`) pero **sin** reusar nada del
      legacy.

- [ ] **Step 5: Correr los tests y compilar** → PASS + `assembleProductionDebug`

- [ ] **Step 6: Commit** _(con permiso)_

---

## Task 7: `TableOrderScreen` y `TableMenuScreen` — rondas

**Files:**

- Create: `features/tables/presentation/{TableOrderScreen,TableOrderViewModel,TableMenuScreen,TableMenuViewModel}.kt`
- Test: `app/src/test/java/.../TableOrderViewModelTest.kt`

**Interfaces:**

- Consumes: Tasks 2–5.
- Produces: `TableOrderViewModel.sendRound()`.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun enviar_ronda_sin_red_encola_ADD_ITEMS_y_la_ronda_se_ve_como_enviada() = runTest {
    coEvery { api.addItems(any(), any(), any()) } throws IOException("sin red")

    viewModel.sendRound()

    coVerify { outbox.enqueue(any(), SyncIntentTypes.ADD_ITEMS, any()) }
    assertThat(viewModel.state.value.pendingItems).isEmpty()
    assertThat(viewModel.state.value.error).isNull()   // NO es un error
}

@Test
fun un_VERSION_CONFLICT_recarga_la_cuenta_y_avisa_sin_perder_nada() = runTest {
    coEvery { api.addItems(any(), any(), any()) } returns versionConflictResponse()

    viewModel.sendRound()

    assertThat(viewModel.state.value.notice).contains("La cuenta cambió")
    coVerify { repo.reloadOrder(any(), any()) }
}
```

- [ ] **Step 2: Correr y verificar que falla**
- [ ] **Step 3: Implementar** espejando `avoqado-android/tables/presentation/TableOrderViewModel.kt` (`sendRound` :295, write-ahead del
      intent :465-490). Vista de lo ya enviado a cocina (por rondas) vs lo pendiente.
- [ ] **Step 4: Correr los tests** → PASS
- [ ] **Step 5: Commit** _(con permiso)_

---

## Task 8: `TableCheckoutScreen` y la costura de pago

**Files:**

- Create: `features/tables/presentation/{TableCheckoutScreen,TableCheckoutViewModel}.kt`
- Test: `app/src/test/java/.../TableCheckoutViewModelTest.kt`

**Interfaces:**

- Consumes: `TableSession` (Task 5); `getPaymentRoute()` (`AppNavigation.kt:2927-2936`).
- Produces: navegación a la ruta de pago con `session.orderId` presembrado.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun el_cobro_apunta_a_la_orden_de_la_mesa_y_NO_crea_una_nueva() = runTest {
    // Espejo de PaymentFlowViewModel.kt:459-471 en android.
    session.open(tableId = "mesa-1", orderId = "orden-real-456")

    val payload = viewModel.buildPaymentPayload(amount = BigDecimal("150.00"))

    assertThat(payload.orderId).isEqualTo("orden-real-456")
    assertThat(payload.createsNewOrder).isFalse()
}

@Test
fun sin_red_el_boton_de_tarjeta_queda_deshabilitado_CON_la_razon() = runTest {
    // El procesador no soporta offline: es un ESTADO, no un error. La cuenta
    // sigue abierta y el mesero cobra cuando vuelva la señal.
    viewModel.onConnectivityChanged(online = false)

    val state = viewModel.state.value
    assertThat(state.cardPaymentEnabled).isFalse()
    assertThat(state.cardPaymentDisabledReason).isEqualTo("Necesita conexión")
    assertThat(state.error).isNull()
    assertThat(state.checkStaysOpen).isTrue()
}

@Test
fun sin_red_el_cobro_en_EFECTIVO_si_funciona() = runTest {
    viewModel.onConnectivityChanged(online = false)
    coEvery { api.addItems(any(), any(), any()) } throws IOException("sin red")

    viewModel.payCash(BigDecimal("150.00"))

    coVerify { outbox.enqueue(any(), SyncIntentTypes.PAY_CASH, any()) }
}

@Test
fun un_pago_parcial_regresa_al_cobro_con_el_restante() = runTest {
    session.open(tableId = "mesa-1", orderId = "orden-1", total = BigDecimal("200.00"))

    viewModel.onPaymentCompleted(amount = BigDecimal("120.00"))

    assertThat(viewModel.state.value.remaining).isEqualTo(BigDecimal("80.00"))
    assertThat(viewModel.state.value.tableReleased).isFalse()
}

@Test
fun al_llegar_a_cero_la_mesa_se_libera_sola() = runTest {
    session.open(tableId = "mesa-1", orderId = "orden-1", total = BigDecimal("200.00"))

    viewModel.onPaymentCompleted(amount = BigDecimal("200.00"))

    assertThat(viewModel.state.value.remaining).isEqualTo(BigDecimal.ZERO)
    assertThat(viewModel.state.value.tableReleased).isTrue()
}
```

- [ ] **Step 2: Correr y verificar que falla**

- [ ] **Step 3: Implementar**

Pantalla propia con restante, split (por monto / partes iguales / por items) y propina. **No importar nada de `features/checkout/`.** Para
el cargo con tarjeta, navegar a `getPaymentRoute()` con la sesión en modo `PAYING`, para que el pago se registre contra `session.orderId`.

- [ ] **Step 4: Correr los tests** → PASS
- [ ] **Step 5: Commit** _(con permiso)_

---

## Task 9: `QuarantineSheet` y migración de `dashboard/` a `tpv/`

**Files:**

- Create: `features/tables/presentation/{QuarantineSheet,QuarantineViewModel}.kt`
- Modify: `core/data/network/ApiService.kt:505,555`
- Test: `app/src/test/java/.../QuarantineViewModelTest.kt`

**Interfaces:**

- Consumes: `SyncOutbox.rejectedIntents` / `dismissRejected` (Task 3); las rutas del **Plan B Task 5**.

- [ ] **Step 1: Escribir el test que falla**

```kotlin
@Test
fun cada_tipo_de_intent_tiene_etiqueta_en_espanol() {
    // Un mesero no puede accionar sobre "ADD_ITEMS".
    assertThat(labelFor("OPEN_TABLE")).isEqualTo("Abrir mesa")
    assertThat(labelFor("ADD_ITEMS")).isEqualTo("Enviar ronda")
    assertThat(labelFor("PAY_CASH")).isEqualTo("Cobro en efectivo")
    assertThat(labelFor("CLEAR_TABLE")).isEqualTo("Liberar mesa")
}

@Test
fun todo_tipo_conocido_tiene_etiqueta() {
    // Un tipo nuevo del server sin etiqueta sale como texto crudo en pantalla.
    SyncIntentTypes.ALL.forEach { tipo ->
        assertThat(labelFor(tipo)).isNotEqualTo(tipo)
    }
}

@Test
fun un_rechazo_no_desaparece_hasta_que_el_mesero_lo_descarta() = runTest {
    coEvery { outbox.rejectedIntents(any()) } returns listOf(rejected("ADD_ITEMS"))

    viewModel.load("venue-a")
    assertThat(viewModel.state.value.items).hasSize(1)

    viewModel.dismiss("intent-1")
    coVerify { outbox.dismissRejected("venue-a", "intent-1") }
}
```

- [ ] **Step 2: Correr y verificar que falla**

- [ ] **Step 3: Implementar** espejando `avoqado-android/sync/presentation/QuarantineViewModel.kt:47-66`. Montar el sheet accesible desde
      `TablesScreen` con un badge cuando haya rechazos.

- [ ] **Step 4: Cerrar la fuga de namespace**

En `ApiService.kt`, cambiar `@GET("dashboard/venues/{venueId}/products")` (`:505`) y `@GET("dashboard/venues/{venueId}/categories")`
(`:555`) por `tpv/…` (destinos creados en el **Plan B Task 5**). Verificar que el shape de la respuesta no cambió, para no tocar parsers.

- [ ] **Step 5: Verificar que no queda ninguna fuga**

```bash
rg -n '"(mobile|dashboard)/' -g '*.kt' app/src/main/java/com/jaac/avoqado_tpv/ \
  | rg -v "features/referrals"
```

Expected: **vacío.** (Las 3 de referidos son deuda aparte, no de este plan.)

- [ ] **Step 6: Correr los tests** → PASS
- [ ] **Step 7: Commit** _(con permiso)_

---

## Verificación final del plan

- [ ] `./gradlew testProductionDebugUnitTest` — PASS
- [ ] `./gradlew connectedProductionDebugAndroidTest` — PASS
- [ ] `./gradlew assembleProductionDebug` y `assembleSandboxDebug` — BUILD SUCCESSFUL
- [ ] **Aislamiento del módulo:** `rg -n "features\.(ordering|checkout)" app/src/main/java/com/jaac/avoqado_tpv/features/tables/` →
      **vacío**
- [ ] **Legacy intacto:** `git diff --stat main -- app/src/main/java/com/jaac/avoqado_tpv/features/ordering/` → **vacío**
- [ ] **Sin fugas de namespace:** el comando de la Task 9 Step 5 → vacío
- [ ] **Espejo de tipos:** el test de la Task 3 pasa contra el `SyncIntentType` **actual** del server
- [ ] Prueba manual en NEXGO (480×480) y PAX: abrir mesa, ordenar, enviar ronda, cobrar en efectivo — **todo en modo avión**; luego
      reconectar y verificar que se drenó
- [ ] Prueba manual: dos TPVs sobre la misma mesa → el segundo recibe `TABLE_OWNED_BY_OTHER` en cuarentena visible

## 🔴 Hueco abierto — el TPV queda como isla frente al Hub LAN

El spec §9 daba por hecho que un "local hub" tipo Toast era idea de v2. **Es falso: Avoqado ya lo tiene shipeado** — módulo PREMIUM
`OFFLINE_LAN_HUB`, en `core/data/lan/` (Android) y `Services/LAN/` (iOS): leases de mesa con TTL 30s, época como fencing token, elección
determinista de árbitro y descubrimiento mDNS `_avoqado-pos._tcp`. Previene el doble-abre entre POS **sin internet**.

Este plan **no** conecta la TPV a esa malla. Consecuencia concreta: en un venue con iPads/Androids coordinándose por LAN, la TPV opera como
**isla** — puede abrir una mesa que los demás ya tienen tomada. El server lo detecta al reconectar (`TABLE_OWNED_BY_OTHER` → cuarentena
visible), así que no se corrompe dinero, pero el mesero se entera **tarde** en vez de que se le prevenga.

**Decisión pendiente del founder** (no bloquea este plan, pero hay que tomarla antes del go-live en un venue mixto): ¿la TPV se une al hub,
o se acepta que sea isla? Si se une, el trabajo vive en un plan aparte y sigue la regla de oro del hub: **degradar, nunca bloquear** — sin
hub, con el árbitro caído o con el permiso de red denegado, el POS sigue vendiendo. El hub previene conflictos, **jamás autoriza un cobro**.

## Recetas de prueba que ya existen (no reinventarlas)

De `offline-first-y-hub-lan.md` §6, verificadas en hardware:

- **"Sin internet" con la LAN viva** (el apagón real): `./gradlew assembleDebug -Pavoqado.devBaseUrl=http://<ip-del-mac>:3009/api/v1` — nada
  escuchando en 3009, la API falla y el WiFi sigue vivo.
- **Intermitencia — la prueba de fuego de la idempotencia:** `flaky-proxy.mjs` en modo `DROP_RESPONSE`: reenvía el request (el efecto **sí**
  ocurre) pero mata la respuesta, así que el cliente reintenta. Es el escenario exacto del doble cobro.
- **Peer LAN falso** sin segundo dispositivo:
  `dns-sd -R "Avoqado-POS-fake" "_avoqado-pos._tcp" local 9911 did=fake-device wired=1 boot=1000 venue=<venueId>`
- **Impresora ESC/POS falsa:** escuchar en `:9100` y decodificar lo que llega.

⚠️ Al probar leases a mano el TTL es 30s: entre tomar la mesa desde un peer y tocar en la terminal deben pasar **menos de 30s**, o caduca y
parece un bug que no lo es.

## Pendiente de lockstep al cerrar

- **Presentación de ventas** (si el Plan B Task 6 Step 5 se difirió): actualizar deck + one-pager + one-pager de cliente **y regenerar los 3
  PDFs**.
- **MCP:** confirmar que los tools de mesa cubren lo que el módulo expuso.
