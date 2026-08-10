# Observabilidad de los POS (android + iOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sacar de la ceguera total a las dos apps que toman órdenes en el salón. Hoy no reportan **nada**: ni crashes, ni errores manejados. Si una tablet truena a media comida, nadie se entera nunca.

**Architecture:** Terreno virgen en ambas, así que Sentry entra completo: crashes **y** errores manejados, con simbolicación automática (mapping de R8 en Android, dSYM en iOS). Un archivo por app concentra todo el trato con el SDK. La correlación con el backend viaja en el header `X-Correlation-ID` que el server ya honra.

**Tech Stack:** Kotlin + Jetpack Compose + OkHttp (`avoqado-android`) · SwiftUI + URLSession (`avoqado-ios`, iOS 15+) · `sentry-android` ≥8 · `sentry-cocoa` ≥8.

**Spec:** `docs/superpowers/specs/2026-08-08-observabilidad-de-errores-design.md`, Parte D.

**Repos:** `avoqado-android` y `avoqado-ios`.

## Por qué cada tarea toca las dos apps

La regla del workspace es que android e iOS se cambian **juntos**: un cambio de producto en una se porta a la otra en el mismo trabajo, nunca "después". Este plan la hace estructural en vez de dejarla a la memoria de quien ejecuta: **cada tarea entrega las dos plataformas**. Si el trabajo se detiene a mitad, se detiene en paridad, no con Android instrumentado e iOS ciego.

La simetría del código lo permite: los dos repos tienen los mismos nombres para las mismas piezas (`SyncOutbox`, `PaymentSyncService`, `PrintConfigRepository`, `PrintRoutingMapper`).

| Pieza | android | ios |
|---|---|---|
| Entrada de la app | `app/src/main/java/com/avoqado/pos/AvoqadoApp.kt` | `avoqado-ios/avoqado_iosApp.swift` |
| Capa de red | `core/di/NetworkModule.kt` (OkHttp) | `Services/APIClient.swift` |
| Cola offline | `core/data/sync/SyncOutbox.kt` | `Services/SyncOutbox.swift` |
| Cuarentena | `sync/presentation/QuarantineViewModel.kt` | (buscar equivalente) |
| Impresión | `printing/routing/PrintRoutingEngine.kt` | `Printing/Routing/PrintRoutingMapper.swift` |

## Global Constraints

- **Idioma del código: inglés.** Identificadores, comentarios y nombres de test en inglés.
- **Git: nunca commitear sin permiso explícito.** Los pasos muestran el comando; preguntar antes.
- **Un solo build pesado a la vez.** Antes de `./gradlew` o `xcodebuild`, verificar con `pgrep -fl "GradleDaemon|KotlinCompileDaemon|xcodebuild"`. La máquina es compartida con otras sesiones. Nunca dos builds tuyos en paralelo.
- **Paridad obligatoria.** Ninguna tarea se da por terminada con una sola plataforma. Si algo impide portar en el momento (falta hardware, worktree bloqueado), va **explícito en el reporte**, nunca en silencio.
- **Offline es estado normal, no error** (`.claude/rules/offline-first-y-hub-lan.md`). Un fallo de red que se convierte en intent encolado **no se reporta**. Solo el rechazo permanente (`REJECTED`). `RETRY` jamás.
- **Sin secretos al repo.** El auth token de Sentry va en `local.properties` (android) y en el entorno de CI / `.xcconfig` ignorado (iOS).
- **Contrato de tags idéntico en ambas:** `venueId`, `staffId`, `terminalSerial`, `appVersionCode`, `correlationId`. Los mismos nombres que usan el dashboard y el TPV. Filtrar por `venueId` igual en las cuatro consolas es la mayor parte del valor.

---

### Task 1: SDK, arranque y simbolicación en ambas apps

**Files:**
- android — Modify: `build.gradle.kts` (raíz), `app/build.gradle.kts`, `app/src/main/java/com/avoqado/pos/AvoqadoApp.kt`. Create: `app/src/main/java/com/avoqado/pos/core/observability/Telemetry.kt`
- ios — Modify: `avoqado-ios.xcodeproj` (SPM + fase de build), `avoqado-ios/avoqado_iosApp.swift`. Create: `avoqado-ios/Services/Telemetry.swift`

**Interfaces (idénticas en ambas plataformas, por contrato):**
- Produces: `Telemetry.start(dsn:environment:release:)`, `Telemetry.capture(_ error:tags:)`, `Telemetry.breadcrumb(category:message:data:)`, `Telemetry.setSession(venueId:staffId:terminalSerial:)`, `Telemetry.clearSession()`.

**Diferencia importante con el TPV:** aquí **sí** se deja que Sentry maneje los crashes no atrapados. El TPV los cede a Crashlytics porque ya los tenía; estas dos apps no tienen nada, así que apagar ese manejador las dejaría igual de ciegas ante lo más grave.

**Prerequisito:** proyectos `avoqado-android` y `avoqado-ios` creados en Sentry (P4 y P5 del spec) más el auth token (P6).

- [ ] **Step 1 (android): Add the plugin and dependency**

En el `build.gradle.kts` raíz:

```kotlin
    id("io.sentry.android.gradle") version "5.1.0" apply false
```

En `app/build.gradle.kts`, en `plugins`:

```kotlin
    id("io.sentry.android.gradle")
```

En `dependencies`:

```kotlin
    implementation("io.sentry:sentry-android:8.9.0")
```

Y al final del archivo:

```kotlin
sentry {
    org.set(providers.gradleProperty("sentryOrg").orElse(""))
    projectName.set("avoqado-android")
    // Release builds set isMinifyEnabled = true (app/build.gradle.kts:88). Without the
    // mapping upload, every stack trace reads a.b.c(SourceFile:1) and the whole plan is
    // pointless.
    includeProguardMapping.set(true)
    autoUploadProguardMapping.set(true)
    // Native symbols too: the release block already sets ndk { debugSymbolLevel = "FULL" }.
    uploadNativeSymbols.set(true)
}
```

Credenciales en `local.properties` (ya ignorado): `sentryOrg`, `sentry.auth.token`, `sentryDsn`. Exponer el DSN con `buildConfigField` en `defaultConfig`, igual que se hizo en el TPV.

- [ ] **Step 2 (ios): Add the SDK via SPM and the dSYM upload phase**

En Xcode, File → Add Package Dependencies → `https://github.com/getsentry/sentry-cocoa`, versión ≥ 8.0.0. El proyecto ya usa SPM (firebase-ios-sdk, GRDB), así que no hay que cambiar de gestor.

Añadir una **Run Script Phase** al target, **después** de "Embed Frameworks":

```bash
if [ -z "$SENTRY_AUTH_TOKEN" ]; then
  echo "warning: SENTRY_AUTH_TOKEN not set — skipping dSYM upload"
  exit 0
fi
sentry-cli debug-files upload --include-sources \
  --org "$SENTRY_ORG" --project avoqado-ios "$DWARF_DSYM_FOLDER_PATH"
```

Verificar que la configuración **Release** tenga `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`. Sin dSYM no hay nada que subir y los crashes llegan como direcciones hexadecimales.

- [ ] **Step 3 (android): Write Telemetry.kt**

Create `app/src/main/java/com/avoqado/pos/core/observability/Telemetry.kt`:

```kotlin
package com.avoqado.pos.core.observability

import android.content.Context
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryLevel
import io.sentry.android.core.SentryAndroid
import io.sentry.protocol.User

/**
 * The only file in this app that knows the Sentry SDK exists.
 *
 * Unlike the TPV, this app has no Crashlytics, so Sentry owns BOTH uncaught crashes and
 * handled errors. Turning off the uncaught handler here would leave the app blind to the
 * worst failures.
 *
 * The API mirrors avoqado-ios/Services/Telemetry.swift name for name, on purpose: the two
 * POS apps ship as a pair and a reader should be able to diff them.
 */
object Telemetry {

    fun start(context: Context, dsn: String?, environment: String, release: String) {
        if (dsn.isNullOrBlank()) return
        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.environment = environment
            options.release = release
            options.isSendDefaultPii = false
            options.tracesSampleRate = 0.0
        }
    }

    fun capture(error: Throwable, tags: Map<String, String> = emptyMap()) {
        Sentry.withScope { scope ->
            tags.forEach { (key, value) -> scope.setTag(key, value) }
            Sentry.captureException(error)
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

    /** A POS tablet is shared by the whole shift; identity must be set on login. */
    fun setSession(venueId: String?, staffId: String?, terminalSerial: String?) {
        venueId?.takeIf { it.isNotBlank() }?.let { Sentry.setTag("venueId", it) }
        terminalSerial?.takeIf { it.isNotBlank() }?.let { Sentry.setTag("terminalSerial", it) }
        staffId?.takeIf { it.isNotBlank() }?.let {
            Sentry.setTag("staffId", it)
            Sentry.setUser(User().apply { id = it })
        }
    }

    /** And cleared on logout, or the next waiter's errors get attributed to the previous one. */
    fun clearSession() {
        Sentry.setUser(null)
        Sentry.setTag("venueId", null)
        Sentry.setTag("staffId", null)
    }
}
```

- [ ] **Step 4 (ios): Write Telemetry.swift**

Create `avoqado-ios/Services/Telemetry.swift`, con la **misma API** nombre por nombre:

```swift
import Foundation
import Sentry

/// The only file in this app that knows the Sentry SDK exists.
///
/// Mirrors avoqado-android's core/observability/Telemetry.kt name for name: the two POS
/// apps ship as a pair, and a reader should be able to diff them side by side.
enum Telemetry {

    static func start(dsn: String?, environment: String, release: String) {
        guard let dsn, !dsn.isEmpty else { return }
        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = environment
            options.releaseName = release
            options.sendDefaultPii = false
            options.tracesSampleRate = 0.0
        }
    }

    static func capture(_ error: Error, tags: [String: String] = [:]) {
        SentrySDK.capture(error: error) { scope in
            tags.forEach { scope.setTag(value: $0.value, key: $0.key) }
        }
    }

    static func breadcrumb(category: String, message: String, data: [String: String] = [:]) {
        let crumb = Breadcrumb(level: .info, category: category)
        crumb.message = message
        crumb.data = data
        SentrySDK.addBreadcrumb(crumb)
    }

    static func setSession(venueId: String?, staffId: String?, terminalSerial: String?) {
        SentrySDK.configureScope { scope in
            if let venueId, !venueId.isEmpty { scope.setTag(value: venueId, key: "venueId") }
            if let terminalSerial, !terminalSerial.isEmpty { scope.setTag(value: terminalSerial, key: "terminalSerial") }
            if let staffId, !staffId.isEmpty {
                scope.setTag(value: staffId, key: "staffId")
                let user = User()
                user.userId = staffId
                scope.setUser(user)
            }
        }
    }

    static func clearSession() {
        SentrySDK.configureScope { scope in
            scope.setUser(nil)
            scope.removeTag(key: "venueId")
            scope.removeTag(key: "staffId")
        }
    }
}
```

- [ ] **Step 5: Start it on both**

android, en `AvoqadoApp.onCreate()`:

```kotlin
        Telemetry.start(
            context = this,
            dsn = BuildConfig.SENTRY_DSN,
            environment = BuildConfig.BUILD_TYPE,
            release = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
        )
```

ios, en `avoqado_iosApp.swift`, en el `init()` del `App`:

```swift
    init() {
        Telemetry.start(
            dsn: Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String,
            environment: Bundle.main.object(forInfoDictionaryKey: "APP_ENVIRONMENT") as? String ?? "release",
            release: "\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "")+\(Bundle.main.infoDictionary?["CFBundleVersion"] ?? "")"
        )
    }
```

El DSN de iOS entra por `Info.plist` alimentado desde un `.xcconfig` **ignorado por git**.

- [ ] **Step 6: Both build**

```bash
pgrep -fl "GradleDaemon|xcodebuild" | head
cd ../avoqado-android && ./gradlew assembleDebug
```

Después, y **no en paralelo**, el build de iOS desde Xcode o `xcodebuild`.

- [ ] **Step 7: Commit both** (pedir permiso, un commit por repo)

---

### Task 2: Identidad de sesión en ambas

**Files:**
- android — Modify: el sitio de login/logout y el de selección de venue
- ios — Modify: sus equivalentes

- [ ] **Step 1: Find the login, logout and venue-selection sites on both**

```bash
cd avoqado-android && grep -rn "fun login\|fun logout\|selectVenue\|setVenue" app/src/main/java --include="*.kt" | head -10
cd ../avoqado-ios && grep -rn "func login\|func logout\|selectVenue" avoqado-ios --include="*.swift" | head -10
```

Anotar `archivo:línea` de los seis sitios (tres por app) antes de editar.

- [ ] **Step 2: Call setSession on login and on venue change, clearSession on logout**

En los seis sitios. El de `clearSession` es el que **no** se puede olvidar: una tablet de POS la usa todo el turno gente distinta, y dejar la identidad anterior atribuye los errores del siguiente mesero al primero que entró.

- [ ] **Step 3: Verify parity between the two repos**

```bash
grep -rc "Telemetry.setSession\|Telemetry.clearSession" avoqado-android/app/src/main/java --include="*.kt" -r
grep -rc "Telemetry.setSession\|Telemetry.clearSession" avoqado-ios/avoqado-ios --include="*.swift" -r
```

Expected: mismo número de llamadas en ambas. Si difieren, falta portar un sitio.

- [ ] **Step 4: Build both and commit** (pedir permiso)

---

### Task 3: `X-Correlation-ID` en cada request

**Files:**
- android — Modify: `app/src/main/java/com/avoqado/pos/core/di/NetworkModule.kt`
- ios — Modify: `avoqado-ios/Services/APIClient.swift`

Sin esto, un error del POS y el 500 del backend que lo causó son dos hechos inconexos en dos consolas. El server ya honra el header entrante y CORS no aplica aquí (son clientes nativos), así que el lado del servidor ya está hecho.

- [ ] **Step 1 (android): Add an OkHttp interceptor**

En `NetworkModule.kt`, junto a los interceptores que ya existen:

```kotlin
/**
 * Stamps a correlation id on every request so a POS error and the server 500 it caused
 * can be found as one thing across two consoles.
 *
 * Also left as a breadcrumb: when a screen crashes later, the trail shows which calls
 * preceded it and each one links to a server log.
 */
class CorrelationIdInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val correlationId = java.util.UUID.randomUUID().toString()
        val request = chain.request().newBuilder()
            .header("X-Correlation-ID", correlationId)
            .build()

        val response = chain.proceed(request)

        Telemetry.breadcrumb(
            category = "api",
            message = "${request.method} ${request.url.encodedPath}",
            data = mapOf(
                "status" to response.code.toString(),
                "correlationId" to correlationId,
                // Path only, never the query string: it can carry ids and personal data.
                "path" to request.url.encodedPath,
            ),
        )
        return response
    }
}
```

Registrarlo en el `OkHttpClient.Builder` con `.addInterceptor(CorrelationIdInterceptor())`.

- [ ] **Step 2 (ios): Do the same in APIClient**

En `Services/APIClient.swift`, en el punto donde se arma cada `URLRequest`, añadir el header y el breadcrumb tras recibir la respuesta. Leer primero cómo se construyen los requests en ese archivo y seguir su patrón; **no** reescribir la capa de red para esto.

- [ ] **Step 3: Verify on both**

Con el server local corriendo, hacer una llamada desde cada app y confirmar en el log del server que llega el `correlationId` **y que es el mismo** que la app mandó. Ese emparejamiento es el entregable.

- [ ] **Step 4: Build both and commit** (pedir permiso)

---

### Task 4: Reportar fallos de API del servidor

**Files:** los mismos de la Tarea 3, en ambos repos.

- [ ] **Step 1: Capture only 5xx**

En el interceptor (android) y en el manejo de respuesta (ios):

```kotlin
if (response.code >= 500) {
    Telemetry.capture(
        IOException("API ${response.code} on ${request.url.encodedPath}"),
        tags = mapOf("correlationId" to correlationId, "httpStatus" to response.code.toString()),
    )
}
```

**No** capturar 401, 403, 404 ni 422: son respuestas legítimas del servidor a peticiones del cliente y la app ya las maneja.

- [ ] **Step 2: 🔴 Do NOT capture network failures**

Un fallo de red en un POS **no es un error**: es el estado normal de un salón sin internet, y la app lo convierte en un intent encolado. Verificar en ambos repos que el camino de red caída no llega a `Telemetry.capture`:

```bash
cd avoqado-android && grep -rn "orQueueOffline\|queueOfflineOrRethrow" app/src/main/java --include="*.kt" | head
cd ../avoqado-ios && grep -rn "queueOffline\|enqueueIntent" avoqado-ios --include="*.swift" | head
```

Esta verificación es la más importante de la tarea. Reportar el encolado llena la consola de falsos positivos y empuja a alguien a "arreglar" el offline, que está bien.

- [ ] **Step 3: Build both and commit** (pedir permiso)

---

### Task 5: Reportar intents rechazados permanentemente

**Files:**
- android — Modify: `app/src/main/java/com/avoqado/pos/core/data/sync/SyncOutbox.kt` y `sync/presentation/QuarantineViewModel.kt`
- ios — Modify: `avoqado-ios/Services/SyncOutbox.swift` y su equivalente de cuarentena

Un intent en cuarentena es una operación real de un mesero que **nunca llegó al servidor**: una mesa que no se abrió, un cobro que no se registró. Hoy queda en una pantalla que quizá nadie mira.

- [ ] **Step 1: Find where REJECTED is handled on both**

```bash
cd avoqado-android && grep -rn "REJECTED" app/src/main/java --include="*.kt" | head
cd ../avoqado-ios && grep -rn "rejected\|REJECTED" avoqado-ios --include="*.swift" | head
```

- [ ] **Step 2: Capture only the permanent rejection**

```kotlin
Telemetry.capture(
    IllegalStateException("Sync intent rejected: $intentType"),
    tags = mapOf("intentType" to intentType, "reason" to reason, "venueId" to venueId),
)
```

- [ ] **Step 3: 🔴 Verify RETRY is NOT captured**

`RETRY` es una condición transitoria por diseño (hoy solo `VERSION_CONFLICT`): el cliente lo deja PENDING y corta el batch para preservar el FIFO. Reportarlo sería ruido puro y, peor, invitaría a alguien a convertirlo en `REJECTED`, que es el P1 que ya ocurrió una vez y pierde el intent para siempre.

- [ ] **Step 4: Build both and commit** (pedir permiso)

---

### Task 6: Reportar fallos de impresión

**Files:**
- android — Modify: `app/src/main/java/com/avoqado/pos/printing/routing/PrintRoutingEngine.kt`
- ios — Modify: `avoqado-ios/Printing/Routing/PrintRoutingMapper.swift`

- [ ] **Step 1: Capture only after retries are exhausted**

Una impresora que tarda o que rechaza un intento es normal en un salón. Solo el fallo definitivo, con `printerRole` y `stationId` como tags.

- [ ] **Step 2: 🔴 Do NOT add any guard in front of printing**

Regla dura de este dominio (`.claude/rules/offline-first-y-hub-lan.md`): **el fail-safe de la impresión no puede ser no imprimir.** Ya hubo un bug donde un guard de configuración impedía imprimir comandas en locales sin estaciones. Este cambio **solo observa**; si al añadir el reporte aparece la tentación de validar algo antes de imprimir, no hacerlo.

- [ ] **Step 3: Build both and commit** (pedir permiso)

---

### Task 7: Verificación en dispositivos reales

Ninguna de estas se puede hacer en emulador ni simulador.

- [ ] **Step 1: Seeded handled error arrives, both platforms**

Con los tags `venueId`, `staffId`, `terminalSerial`, `appVersionCode`.

- [ ] **Step 2: Seeded crash arrives, both platforms**

Aquí Sentry **sí** debe recibirlo (a diferencia del TPV): estas apps no tienen Crashlytics.

- [ ] **Step 3: 🔴 Symbolication on RELEASE builds**

El paso que no se puede saltar, y tiene que ser **release firmado** en ambas: un debug no ofusca y daría un falso verde.

```bash
cd avoqado-android && ./gradlew assembleRelease
```

iOS: archive de Release, y confirmar en la salida que el dSYM se subió.

Esperado en Sentry: nombres reales de clase, método y línea. Si Android muestra `a.b.c(SourceFile:1)`, el mapping no se subió. Si iOS muestra direcciones hexadecimales, falta el dSYM. Cubre el criterio 9 del spec.

- [ ] **Step 4: 🔴 Offline behavior unchanged, both platforms**

Con el backend inalcanzable pero la LAN viva:

```bash
./gradlew assembleDebug -Pavoqado.devBaseUrl=http://<ip-del-mac>:3009/api/v1
```

Abrir una mesa, agregar items, cobrar en efectivo. Esperado: todo se encola, la UI **no** muestra error, y **no llegó ni un evento a Sentry**. Si llegó alguno, volver a la Tarea 4 paso 2.

- [ ] **Step 5: Kill switch on both**

Deshabilitar la client key de cada proyecto y confirmar que dejan de llegar eventos sin necesidad de un release. Volver a habilitarlas.

- [ ] **Step 6: Report parity honestly**

En el reporte final, declarar explícitamente qué se verificó **en hardware real** y qué se hizo solo por lectura de código. El precedente existe: el fix de impresión offline de iOS se hizo por paridad y lectura, y nunca se probó con un iPad y una impresora físicos. Si algo queda así, se dice.

---

## Notas para quien ejecute

**El orden importa poco después de la Tarea 1.** Las Tareas 3, 4, 5 y 6 son independientes entre sí. La 2 conviene temprano porque sin identidad los eventos de las otras llegan anónimos.

**El riesgo dominante es el ruido, no los bugs.** Estas apps viven en salones con WiFi malo. Si reportan cada bache, en dos semanas nadie mira la consola y habremos gastado el esfuerzo en empeorar la señal. Los pasos marcados 🔴 de las Tareas 4, 5 y 6 existen exactamente por eso, y son los que hay que revisar con más cuidado en el code review.

**Si el tiempo se acaba**, terminar en un múltiplo de tareas completas (las dos plataformas), nunca a mitad de una. Un plan detenido en la Tarea 4 con ambas apps al día es un buen estado; uno detenido con Android en la 6 e iOS en la 2 no lo es.
