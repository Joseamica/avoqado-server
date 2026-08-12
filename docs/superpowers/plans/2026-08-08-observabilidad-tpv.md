# Observabilidad del TPV: Sentry como segundo sumidero — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los errores **manejados** del TPV — los que hoy se atrapan, se loguean y nadie vuelve a ver — lleguen agrupados y simbolicados
a Sentry, sin tocar ni duplicar lo que Crashlytics ya cubre.

**Architecture:** El TPV ya tiene una capa de observabilidad madura (`core/observability/`) con `ObservabilityManager` como fachada y
`CrashlyticsContext` para el contexto. Este plan **no siembra llamadas a Sentry por el código**: añade Sentry como un **segundo sumidero
detrás de la fachada existente**. Un solo lugar decide qué va a dónde, y el reparto con Crashlytics queda separado por punto de llamada, no
por deduplicación.

**Tech Stack:** Kotlin, Jetpack Compose, Hilt, Timber, `io.sentry:sentry-android` ≥8, plugin de Gradle de Sentry.

**Spec:** `docs/superpowers/specs/2026-08-08-observabilidad-de-errores-design.md`, Parte D.

**Repo:** `avoqado-tpv`. Rutas relativas a `app/src/main/java/com/jaac/avoqado_tpv/`.

## Global Constraints

- **Idioma del código: inglés.** Identificadores, comentarios y nombres de test en inglés.
- **Git: nunca commitear sin permiso explícito.** Los pasos muestran el comando; preguntar antes.
- **Un solo build de Gradle a la vez.** Antes de `./gradlew`, verificar con `pgrep -fl "GradleDaemon|KotlinCompileDaemon"` que no haya otro
  corriendo: la máquina es compartida con otras sesiones. Si hay uno ajeno, esperar; si no hay ninguno y sobran daemons ociosos,
  `./gradlew --stop` los libera.
- **No se quita Crashlytics.** Convive. Consolidar es una decisión posterior con datos.
- **No romper el comportamiento offline.** Un fallo de red que se convierte en intent encolado **no es un error** y no se reporta
  (`.claude/rules/offline-first-y-hub-lan.md`). Reportarlo llenaría la consola de ruido y empujaría a alguien a "arreglar" algo que está
  bien.
- **El auth token de Sentry va en `local.properties`**, que ya está en `.gitignore`. Nunca en el repo.
- **Sin llaves nuevas de Crashlytics.** Las que existen (`session_venue_id`, `app_terminal_serial`…) se quedan como están: hay historial y
  consultas construidas sobre ellas.

---

## File Structure

| Archivo                                              | Responsabilidad                                                         | Tarea |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `app/build.gradle.kts:377`                           | SDK + plugin de Sentry en el bloque `release`                           | 1     |
| `core/observability/SentrySink.kt`                   | **Nuevo.** Init y el envío a Sentry. El único archivo que conoce el SDK | 1     |
| `core/observability/ObservabilityManager.kt:218,247` | `logError` y `logCritical` también van a Sentry                         | 3     |
| `core/observability/SentryContext.kt`                | **Nuevo.** Espeja el contexto de sesión a tags de Sentry                | 2     |
| `core/observability/CrashlyticsContext.kt`           | Sin cambios. Se lee para replicar los puntos de llamada                 | 2     |
| Puntos de captura de dominio                         | Pago, intent rechazado, impresión                                       | 4     |

Que **solo `SentrySink.kt` importe el SDK** es deliberado: si mañana el DSN cambia de proveedor, o se decide consolidar con Crashlytics, se
toca un archivo.

---

### Task 1: SDK, simbolicación e inicialización

**Files:**

- Modify: `app/build.gradle.kts`
- Create: `core/observability/SentrySink.kt`
- Modify: `AvoqadoTPVApplication.kt`
- Modify: `local.properties` (local, no commiteado) y `.gitignore` si hace falta

**Interfaces:**

- Consumes: nada.
- Produces: `SentrySink.initialize(context: Context, dsn: String?)`,
  `SentrySink.captureHandled(throwable: Throwable, tags: Map<String, String>)`,
  `SentrySink.breadcrumb(category: String, message: String, data: Map<String, String>)`.

**Prerequisito:** proyecto `avoqado-tpv` creado en Sentry (P3 del spec), su DSN, y el auth token (P6).

**Lo que hace que esta tarea valga:** el plugin de Gradle sube el mapping de R8 en cada build de release. Sin él, con
`isMinifyEnabled = true` (`app/build.gradle.kts:377`), los stack traces llegarían como `a.b.c(SourceFile:1)`. Es la razón por la que móvil
va a Sentry y no a Better Stack.

- [ ] **Step 1: Add the plugin and the dependency**

En el `build.gradle.kts` **raíz**, junto al de Crashlytics (línea ~8):

```kotlin
    id("io.sentry.android.gradle") version "5.1.0" apply false
```

En `app/build.gradle.kts`, en el bloque `plugins` (junto a `id("com.google.firebase.crashlytics")`):

```kotlin
    id("io.sentry.android.gradle")
```

En `dependencies`, junto a la línea de Crashlytics (~690):

```kotlin
    implementation("io.sentry:sentry-android:8.9.0")  // Handled errors; Crashlytics keeps native crashes
```

Y al final del archivo, la configuración del plugin:

```kotlin
sentry {
    org.set(providers.gradleProperty("sentryOrg").orElse(""))
    projectName.set("avoqado-tpv")
    // Uploads the R8 mapping on every release build. Without this, obfuscated stack
    // traces are unreadable and the whole exercise is pointless.
    includeProguardMapping.set(true)
    autoUploadProguardMapping.set(true)
    // The SDK's own auto-instrumentation is off: this app already has its own
    // observability layer and we do not want two sources of the same breadcrumb.
    tracingInstrumentation { enabled.set(false) }
    autoInstallation { enabled.set(false) }
}
```

- [ ] **Step 2: Put the credentials outside the repo**

En `local.properties` (ya ignorado por git):

```
sentryOrg=<org>
sentry.auth.token=<token>
sentryDsn=<dsn>
```

Verificar que `local.properties` esté en `.gitignore`. Si no lo está, **añadirlo antes de seguir**.

Exponer el DSN al código vía `buildConfigField` en `app/build.gradle.kts`, dentro de `defaultConfig`:

```kotlin
        buildConfigField(
            "String",
            "SENTRY_DSN",
            "\"${providers.gradleProperty("sentryDsn").getOrElse("")}\"",
        )
```

- [ ] **Step 3: Write the sink**

Create `core/observability/SentrySink.kt`:

```kotlin
package com.jaac.avoqado_tpv.core.observability

import android.content.Context
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryLevel
import io.sentry.android.core.SentryAndroid

/**
 * The only file in the app that knows the Sentry SDK exists.
 *
 * Everything else talks to ObservabilityManager. Keeping the SDK behind one file means
 * changing provider, or consolidating with Crashlytics later, is a one-file change.
 *
 * Division of labour with Crashlytics, by call site rather than by deduplication:
 *   - Crashlytics: uncaught crashes and ANRs. Untouched by this plan.
 *   - Sentry: handled errors, which today are caught, logged and never seen again.
 * The SDK is initialized with its uncaught-exception handler DISABLED, which is what
 * makes a duplicate event impossible rather than merely unlikely.
 */
object SentrySink {

    fun initialize(context: Context, dsn: String?, environment: String, release: String) {
        if (dsn.isNullOrBlank()) return

        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.environment = environment
            options.release = release
            // Crashlytics owns uncaught crashes and ANRs. This is the guard that makes
            // double-reporting structurally impossible.
            options.isEnableUncaughtExceptionHandler = false
            options.isAnrEnabled = false
            // No PII and no performance transactions (quota, see S-1 in the spec).
            options.isSendDefaultPii = false
            options.tracesSampleRate = 0.0
        }
    }

    fun captureHandled(throwable: Throwable, tags: Map<String, String> = emptyMap()) {
        Sentry.withScope { scope ->
            tags.forEach { (key, value) -> scope.setTag(key, value) }
            Sentry.captureException(throwable)
        }
    }

    fun breadcrumb(category: String, message: String, data: Map<String, String> = emptyMap()) {
        Sentry.addBreadcrumb(
            Breadcrumb().apply {
                this.category = category
                this.message = message
                this.level = SentryLevel.INFO
                data.forEach { (key, value) -> setData(key, value) }
            },
        )
    }
}
```

- [ ] **Step 4: Initialize it at app startup**

En `AvoqadoTPVApplication.kt`, en `onCreate()`, **junto a la inicialización de Crashlytics que ya existe** (buscarla primero; no duplicar el
arranque de la capa de observabilidad):

```kotlin
        SentrySink.initialize(
            context = this,
            dsn = BuildConfig.SENTRY_DSN,
            environment = BuildConfig.BUILD_TYPE,
            release = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
        )
```

- [ ] **Step 5: Verify the app builds and boots**

Antes de compilar, comprobar que no haya otro build corriendo:

```bash
pgrep -fl "GradleDaemon|KotlinCompileDaemon" | head
./gradlew assembleDebug
```

Expected: compila. Si la máquina está saturada va a tardar; **no cancelar**.

- [ ] **Step 6: Verify a release build uploads the mapping**

```bash
./gradlew assembleRelease
```

Expected: en la salida aparece la subida del mapping de ProGuard a Sentry. Si no aparece, revisar `sentry.auth.token` en `local.properties`.
Sin esta subida, la Tarea 5 no puede pasar.

- [ ] **Step 7: Commit** (pedir permiso)

```bash
git add build.gradle.kts app/build.gradle.kts app/src/main/java/com/jaac/avoqado_tpv/core/observability/SentrySink.kt app/src/main/java/com/jaac/avoqado_tpv/AvoqadoTPVApplication.kt
git commit -m "feat(observability): add Sentry for handled errors, with R8 mapping upload"
```

---

### Task 2: Espejar el contexto de sesión

**Files:**

- Create: `core/observability/SentryContext.kt`
- Modify: los sitios que ya llaman a `CrashlyticsContext.setSessionContext` / `clearSessionContext`

**Interfaces:**

- Consumes: `SentrySink` de la Tarea 1.
- Produces: `SentryContext.setAppContext(...)`, `SentryContext.setSessionContext(venueId, staffId, staffRole)`,
  `SentryContext.clearSessionContext()`.

**Decisión de nombres, y por qué difiere de Crashlytics.** `CrashlyticsContext` usa `session_venue_id`, `app_terminal_serial`,
`app_version_code`. Sentry va a usar los nombres del contrato del spec: `venueId`, `staffId`, `terminalSerial`, `appVersionCode`. No es
inconsistencia: esos son los nombres que **el dashboard, android e iOS también van a usar**, y el valor de la consola está en poder filtrar
`venueId` igual en las cuatro apps. Las llaves de Crashlytics se quedan como están porque ya hay historial construido sobre ellas.

- [ ] **Step 1: Read the existing context file first**

```bash
sed -n '30,115p' app/src/main/java/com/jaac/avoqado_tpv/core/observability/CrashlyticsContext.kt
```

Cada función pública que se lea aquí necesita su gemela en `SentryContext`. **No inventar la firma**: copiar la que existe.

- [ ] **Step 2: Write the mirror**

Create `core/observability/SentryContext.kt`, con una función por cada una de `CrashlyticsContext`, usando los nombres del contrato:

```kotlin
package com.jaac.avoqado_tpv.core.observability

import io.sentry.Sentry

/**
 * Mirrors CrashlyticsContext onto Sentry tags.
 *
 * Tag names deliberately follow the cross-platform contract (venueId, staffId,
 * terminalSerial, appVersionCode) rather than Crashlytics' snake_case keys: the dashboard
 * and the two POS apps use these same names, and filtering by venueId identically across
 * all four consoles is most of the value.
 *
 * Only ids. Never a name, an email or a phone number.
 */
object SentryContext {

    fun setAppContext(buildVariant: String, environment: String, appVersionName: String, appVersionCode: String, terminalSerial: String?) {
        Sentry.setTag("buildVariant", buildVariant)
        Sentry.setTag("appVersionName", appVersionName)
        Sentry.setTag("appVersionCode", appVersionCode)
        terminalSerial?.takeIf { it.isNotBlank() }?.let { Sentry.setTag("terminalSerial", it) }
    }

    fun setSessionContext(venueId: String?, staffId: String?, staffRole: String?) {
        venueId?.takeIf { it.isNotBlank() }?.let { Sentry.setTag("venueId", it) }
        staffId?.takeIf { it.isNotBlank() }?.let {
            Sentry.setTag("staffId", it)
            Sentry.setUser(io.sentry.protocol.User().apply { id = it })
        }
        staffRole?.takeIf { it.isNotBlank() }?.let { Sentry.setTag("staffRole", it) }
    }

    /**
     * Called on logout. A PAX terminal is shared by every waiter on the shift, so leaving
     * the previous session's tags would attribute the next person's errors to whoever
     * logged in first.
     */
    fun clearSessionContext() {
        Sentry.setUser(null)
        Sentry.setTag("venueId", null)
        Sentry.setTag("staffId", null)
        Sentry.setTag("staffRole", null)
    }
}
```

- [ ] **Step 3: Call it wherever CrashlyticsContext is already called**

```bash
grep -rn "CrashlyticsContext\." app/src/main/java --include="*.kt"
```

En **cada** sitio, añadir la llamada gemela a `SentryContext` inmediatamente después. No mover ni cambiar la de Crashlytics.

- [ ] **Step 4: Verify parity**

```bash
grep -c "CrashlyticsContext\.setSessionContext\|CrashlyticsContext\.clearSessionContext" -r app/src/main/java --include="*.kt"
grep -c "SentryContext\.setSessionContext\|SentryContext\.clearSessionContext" -r app/src/main/java --include="*.kt"
```

Expected: los dos números coinciden. Si el de Sentry es menor, falta un sitio y el más peligroso de olvidar es el de `clear`.

- [ ] **Step 5: Build and commit** (pedir permiso)

```bash
./gradlew assembleDebug
git add app/src/main/java/com/jaac/avoqado_tpv/core/observability/ app/src/main/java/com/jaac/avoqado_tpv/
git commit -m "feat(observability): mirror session context onto Sentry tags"
```

---

### Task 3: Enrutar los errores manejados por la fachada

**Files:**

- Modify: `core/observability/ObservabilityManager.kt:218` (`logError`) y `:247` (`logCritical`)
- Modify: `core/observability/ObservabilityManager.kt:265` (`addBreadcrumb`)

**Interfaces:**

- Consumes: `SentrySink` de la Tarea 1.
- Produces: nada nuevo. El efecto es que todo `logError`/`logCritical` con excepción llega a Sentry.

Ésta es la tarea que hace el trabajo. Todo lo que ya llama a `logError` con un `Throwable` empieza a reportarse **sin tocar ningún sitio de
llamada**, igual que el formato de Winston en el server.

- [ ] **Step 1: Read the current signatures before changing them**

```bash
sed -n '218,290p' app/src/main/java/com/jaac/avoqado_tpv/core/observability/ObservabilityManager.kt
```

Anotar la firma exacta de `logError` y `logCritical` (qué parámetros reciben, si el `Throwable` es opcional). El paso siguiente se ajusta a
lo que se lea, no al revés.

- [ ] **Step 2: Route the throwable to Sentry**

Dentro de `logError`, después de lo que ya hace y **sin quitar nada**, añadir:

```kotlin
        // Handled errors are exactly what Crashlytics does not see: they were caught,
        // logged, and until now nobody looked at them again.
        throwable?.let {
            SentrySink.captureHandled(it, mapOf("tag" to tag) + metadata.mapValues { entry -> entry.value.toString() })
        }
```

Lo mismo en `logCritical`.

**No** enrutar `logInfo` ni `logWarning`: son volumen y no son fallos. Un warning que importa debería ser un error.

- [ ] **Step 3: Route breadcrumbs**

Dentro de `addBreadcrumb` (`:265`), añadir:

```kotlin
        SentrySink.breadcrumb(category, message, data)
```

- [ ] **Step 4: Verify the metadata does not leak PII**

```bash
grep -rn "logError(" app/src/main/java --include="*.kt" | head -30
```

Revisar los `metadata` que se pasan en esos sitios. Si alguno incluye nombre de cliente, teléfono, correo o datos de tarjeta, **quitarlo del
metadata en ese sitio de llamada** antes de continuar. El SDK ya no lo va a filtrar por ti y el evento sale del dispositivo.

- [ ] **Step 5: Build and commit** (pedir permiso)

```bash
./gradlew assembleDebug
git add app/src/main/java/com/jaac/avoqado_tpv/core/observability/ObservabilityManager.kt
git commit -m "feat(observability): route handled errors and breadcrumbs to Sentry"
```

---

### Task 4: Los puntos de captura de dominio

**Files:**

- Modify: los ViewModels de pago (`AngelPayPaymentViewModel`, el `PaymentViewModel` de Blumon)
- Modify: el reducer/manejo de `REJECTED` en la sincronización (`features/tables/data/local/SyncIntentDao.kt` y su coordinador)
- Modify: el motor de impresión

**Interfaces:**

- Consumes: `ObservabilityManager.logError` (Tarea 3).
- Produces: nada nuevo.

Los cinco puntos del contrato del spec, de los cuales al TPV le aplican tres (no procesa órdenes ni impresión de comanda igual que un POS
completo, pero sí recibos).

- [ ] **Step 1: Locate the exact call sites**

```bash
grep -rn "handleRecordFailure" app/src/main/java --include="*.kt"
grep -rn "REJECTED" app/src/main/java --include="*.kt" | head -10
```

Anotar `archivo:línea` de cada uno antes de editar.

- [ ] **Step 2: Payment failure**

En el manejo de fallo de pago, añadir un `logError` con el código de error del proveedor como metadata estructurada (no concatenado en el
mensaje, o cada código genera su propia huella y la agrupación se rompe):

```kotlin
observabilityManager.logError(
    tag = "Payment",
    message = "Payment failed",
    throwable = error,
    metadata = mapOf("processor" to processor, "errorCode" to errorCode, "amount" to amount.toString()),
)
```

**Ojo con el bug conocido:** `AngelPayPaymentViewModel.handleRecordFailure` pinta como pantalla de Error un cobro que en realidad **se
encoló bien** (`.claude/rules/offline-first-y-hub-lan.md`). Ese camino **no** se reporta como error: encolado es éxito. Si al leer el código
el camino sigue confundiendo ambos, **anotarlo en el reporte** y no reportarlo a Sentry; arreglar la UI es otro trabajo.

- [ ] **Step 3: Permanently rejected sync intent**

Solo el rechazo **permanente**. `RETRY` es transitorio por diseño y reportarlo sería ruido:

```kotlin
observabilityManager.logError(
    tag = "Sync",
    message = "Intent rejected permanently",
    throwable = null,
    metadata = mapOf("intentType" to intentType, "reason" to rejectionReason),
)
```

- [ ] **Step 4: Print failure after retries are exhausted**

Solo tras agotar reintentos, nunca al primer fallo: una impresora que tarda es normal en un salón.

- [ ] **Step 5: Verify nothing reports a queued-offline success**

```bash
grep -rn "orQueueOffline\|queueOfflineOrRethrow" app/src/main/java --include="*.kt" | head
```

Confirmar que ninguno de los caminos que encolan termina llamando a `logError`. **Ésta es la verificación más importante de la tarea:** si
se reporta el encolado, se llena la consola de falsos positivos y alguien va a "arreglar" el offline.

- [ ] **Step 6: Build and commit** (pedir permiso)

```bash
./gradlew assembleDebug
git add app/src/main/java/
git commit -m "feat(observability): report payment, sync-rejection and print failures"
```

---

### Task 5: `X-Correlation-ID` en cada request (Parte E del spec)

**Files:**

- Create: `core/data/network/interceptors/CorrelationIdInterceptor.kt`
- Modify: `core/di/NetworkModule.kt:112-118`

**Interfaces:**

- Consumes: `SentrySink.breadcrumb` de la Tarea 1.
- Produces: cada request sale con el header `X-Correlation-ID` y deja un breadcrumb con ese id.

Sin esto, un error del TPV y el 500 del backend que lo causó son dos hechos inconexos en dos consolas distintas. El server ya honra el
header entrante y aquí no hay CORS de por medio (cliente nativo), así que el lado del servidor ya está hecho: esta tarea es la mitad que
falta.

- [ ] **Step 1: Write the interceptor**

Create `core/data/network/interceptors/CorrelationIdInterceptor.kt`:

```kotlin
package com.jaac.avoqado_tpv.core.data.network.interceptors

import com.jaac.avoqado_tpv.core.observability.SentrySink
import okhttp3.Interceptor
import okhttp3.Response
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stamps a correlation id on every outgoing request and leaves the round trip as a
 * breadcrumb.
 *
 * The server already honors an inbound X-Correlation-ID and echoes it back, so this one
 * header is what lets a terminal error and its server-side 500 be found as a single thing
 * across two consoles.
 *
 * Path only, never the query string: it can carry ids and personal data, and this
 * breadcrumb leaves the device.
 */
@Singleton
class CorrelationIdInterceptor @Inject constructor() : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val correlationId = UUID.randomUUID().toString()
        val request = chain.request().newBuilder()
            .header("X-Correlation-ID", correlationId)
            .build()

        val response = chain.proceed(request)

        SentrySink.breadcrumb(
            category = "api",
            message = "${request.method} ${request.url.encodedPath}",
            data = mapOf(
                "status" to response.code.toString(),
                "correlationId" to correlationId,
                "path" to request.url.encodedPath,
            ),
        )
        return response
    }
}
```

- [ ] **Step 2: Register it in the chain**

En `core/di/NetworkModule.kt`, añadirlo al `OkHttpClient.Builder` (`:112-118`). Va **después** de `authInterceptor` y `tenantInterceptor`,
para que el breadcrumb refleje el request tal como sale de verdad, con sus headers de auth y de tenant ya puestos:

```kotlin
            .addInterceptor(authInterceptor)        // Add JWT token + version headers
            .addInterceptor(tenantInterceptor)      // Add venueId
            .addInterceptor(correlationIdInterceptor) // Correlation id + api breadcrumb
            .addInterceptor(versionGateInterceptor) // 🚨 Handle 426 Upgrade Required
```

Añadirlo también como parámetro de `provideOkHttpClient` (`:104-111`), siguiendo el patrón de inyección de los otros interceptores del
archivo.

- [ ] **Step 3: 🔴 Do NOT capture failures here**

Este interceptor **solo observa**. Los fallos de red ya los maneja la capa de offline convirtiéndolos en intents encolados, y capturar aquí
duplicaría con la Tarea 4 y reportaría el encolado como error, que es justo lo que no se debe hacer.

- [ ] **Step 4: Verify the header actually travels**

Con el server local corriendo y el TPV apuntado a él, hacer cualquier operación y confirmar en el log del server que llega el
`correlationId`, **y que es el mismo valor** que aparece en el breadcrumb del evento de Sentry. Ese emparejamiento es el entregable de la
tarea; sin él, el header es decorativo.

- [ ] **Step 5: Build and commit** (pedir permiso)

```bash
pgrep -fl "GradleDaemon|KotlinCompileDaemon" | head
./gradlew assembleDebug
git add app/src/main/java/com/jaac/avoqado_tpv/core/data/network/interceptors/CorrelationIdInterceptor.kt app/src/main/java/com/jaac/avoqado_tpv/core/di/NetworkModule.kt
git commit -m "feat(observability): send a correlation id on every TPV request"
```

---

### Task 6: Verificación en hardware

- [ ] **Step 1: Seed a handled error on a debug build and confirm it arrives**

Instalar el debug en una PAX y provocar un error manejado. Debe aparecer en Sentry con los tags `venueId`, `staffId`, `terminalSerial`,
`appVersionCode`.

- [ ] **Step 2: Confirm it did NOT arrive in Crashlytics**

Misma ventana de tiempo, consola de Firebase. Esperado: **cero**. Cubre el criterio 10 del spec.

- [ ] **Step 3: Seed an uncaught crash and confirm the reverse**

Debe aparecer en **Crashlytics** y **no** en Sentry, porque `isEnableUncaughtExceptionHandler = false`. Si aparece en ambas, ese flag no se
aplicó.

- [ ] **Step 4: Verify symbolication on a RELEASE build**

Éste es el paso que no se puede saltar, y tiene que ser un build de **release firmado**, no un debug: el debug no ofusca y daría un falso
verde.

```bash
./gradlew assembleProductionRelease
```

Instalar, provocar un error manejado y confirmar en Sentry que el stack muestra nombres reales de clase y método, no `a.b.c(SourceFile:1)`.
Cubre el criterio 9 del spec.

- [ ] **Step 5: Verify the correlation thread end to end**

Tomar el `correlationId` de un breadcrumb de un evento real en Sentry y buscarlo en el log stream de Better Stack (source `1720702`). Debe
aparecer el request correspondiente del server, con su `venueId`. Ese salto entre las dos consolas es la Parte E funcionando.

- [ ] **Step 6: Verify the kill switch**

Deshabilitar la client key en Sentry, provocar otro error, confirmar que no llega. Volver a habilitarla.

- [ ] **Step 7: Verify offline behavior is unchanged**

Con el `flaky-proxy.mjs` en modo `DROP_RESPONSE` o apuntando a un puerto muerto (`-Pavoqado.devBaseUrl=http://<ip>:3009/api/v1`), hacer un
cobro en efectivo y confirmar que:

- el cobro se encola y la UI **no** muestra error,
- **no** llegó ningún evento a Sentry.

Si llegó alguno, volver al paso 5 de la Tarea 4.

---

## Notas para quien ejecute

**La Tarea 3 es la que entrega el valor.** Las 1 y 2 la habilitan; la 4 añade los casos que hoy ni siquiera pasan por `logError`; la 5
conecta el hilo con el backend. Si el tiempo se acaba, 1+2+3 ya es un cambio útil y coherente por sí solo.

**El riesgo real no es técnico, es de ruido.** Un TPV que reporta cada bache de WiFi como error hace que en dos semanas nadie mire la
consola. Los pasos 5 de la Tarea 4 y 6 de la Tarea 5 existen por eso.

**Lo que este plan no hace:** quitar Crashlytics, tocar el hub LAN, y reportar `RETRY`. Están en "Out of Scope" del spec con su razón.
