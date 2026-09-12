# Nexgo: la terminal no cobra con tarjeta tras arrancar sin red (AngelPay) — verificación por código, 11-sep-2026

Origen: Testarudo, 11-sep, ~4 h sin poder cobrar con tarjeta en la N86 (evidencia de la sesión hermana
`error_terminal_atascada`: Crashlytics dd82e1c1…, 6676ed40… con variantes 71ce8cd2 y f6673c87; 10 cobros remotos
CANCELLED entre 14:43 y 17:57 UTC). Verificación de sólo lectura por un agente, sobre el árbol de trabajo
(en HEAD 2.9.2 la estructura es la misma con ~19 líneas menos en el VM).

Alias (bajo `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/`):
AUTH `features/payment/data/processor/angelpay/AngelPayAuthRepository.kt` · RES `…/AngelPayCredentialResolver.kt` ·
MREP `…/AngelPayMerchantRepository.kt` · VM `features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt` ·
SCR `…/AngelPayPaymentScreen.kt` · BAN `…/AngelPayAuthBanner.kt` · HOME `core/presentation/viewmodels/HomeViewModel.kt` ·
CONN `core/presentation/viewmodels/ConnectionViewModel.kt` · TCR `core/data/repository/TerminalConfigRepositoryImpl.kt` ·
APP `AvoqadoTPVApplication.kt` · TC `core/domain/TerminalConfig.kt` · CTX `core/observability/CrashlyticsContext.kt`

## Las cuatro causas (confirmadas)

1. **La auth no se reintenta.** `triggerAngelPayStartupAuthIfApplicable()` corre una vez, en `HOME:270` (init) →
   `ensureAuthenticated()` `HOME:1479`. Sin red: `resolve()` falla, el self-heal `fetchConfig` falla (`AUTH:206-212`,
   sólo log), `resolve()` falla otra vez ⇒ `AuthError` (`AUTH:215-224`). La caché de credenciales vive sólo en memoria
   (`TCR:53/58/65`, a propósito por la regla del PIN). Al volver la red, el colector `HOME:897-935` llena la caché vía
   `retryFetchMerchantsAndReinitSDK → refreshMerchants → fetchConfig` (`HOME:903-905, 946`) pero **nunca toca AngelPay**.
   La auth sólo vuelve con logout/login, `selectMerchant → switchAccount` (`VM:1185`; el selector se oculta con un solo
   comercio, `SCR:606`) o el comando `FETCH_ANGELPAY_MERCHANTS` (`CommandExecutor.kt:1270`).
2. **La espera del comercio corre antes de la única línea que autentica.** `startCardPayment` (`VM:1256`) →
   `if (!waitForMerchantToSettle())` (`VM:1293`) → `startSdkCardPayment` (`VM:1323`, cuerpo `VM:1451`) →
   `ensureAuthenticatedAs` (`VM:1490`). La espera (`VM:1350-1388`) es pasiva: `withTimeoutOrNull(8_000)` sobre
   `activeAngelPayMerchantId`, que sólo cambia con auth u operación de comercio (`MREP:84, 98, 158, 176, 226`). Con un
   solo comercio `_currentMerchant` se autoselecciona (`VM:780-783`). Resultado: 8 s → «Cambio de merchant no se
   completó. Reintenta.» y «Reintentar» (`VM:3307`) repite el ciclo. Precedente: `CHANGELOG.md:387` (Amaena).
3. **El error de red se muestra como «faltan credenciales».** `MissingAngelPayCredsError` (`RES:138`, `RES:98-100`,
   texto fijo `RES:183-184`). Causa: `TCR:164-167` convierte `UnknownHostException` en `Exception(msg)` sin causa. El
   banner lo muestra en inglés, truncado a 60 caracteres, sin botón (`BAN:116-121`), sólo en «Método de pago»
   (`SCR:463`). Peor: sin red, `ensureAuthenticatedAs` lo interpreta como «la cuenta ya no existe» y hace **fallback a
   la cuenta primaria** (`AUTH:547-553`); el candado de alineación (`VM:1515`) evita cobrar por otra afiliación.
4. **`app_terminal_serial` equivocado.** `APP:165-171` pasa `TerminalConfig.serialNumber`, que en ese momento es
   `DEFAULT_SERIAL "2841548417"` (`TC:51, 61`); además ese campo es el serial del COMERCIO Blumon. El serial real ya
   viaja en `terminal_id` (`ObservabilityManager.kt:124`, desde `HOME:346`).

## Mapa

- `AngelPayAuthState`: Unauthenticated, Authenticating, SelectingMerchant(merchants, temporaryToken), Authenticated,
  AuthError(message), AccountSuspended (nadie lo escribe), ConfigMismatchBanner. `_state` en `AUTH:70`,
  `currentAngelPayAccountId` en `AUTH:83`. Comercio activo `MREP:58`, `inFlightSwitch` `MREP:62`, `operationMutex`
  `MREP:56`. **`AngelPayAuthRepository` no tiene mutex.**
- Llamadores de `ensureAuthenticated`: `HOME:1479`, `CommandExecutor.kt:1270`, `VM:1492`, `AUTH:495/530/553`.
  De `ensureAuthenticatedAs`: `VM:1490`, `AUTH:493`. Otras re-auth: `switchAccount` (`VM:1185`, `AppNavigation.kt:237`,
  `CommandExecutor.kt:1252`), `completeMerchantSelection` (`VM:1211`), `handleAuthExpiry` (`VM:2477`).
- Regla de Amaena (`AUTH:481-519`, `VM:1173-1181`, `VM:1482-1492`, `VM:1515-1528`, `VM:2482-2528`): la re-auth
  genérica cae en `angelpayAccounts[0]`; en el camino de cobro se autentica con la cuenta del comercio elegido; el
  candado `sessionAlignedWithSelectedMerchant` (fail-closed) va antes de cualquier lanzamiento del SDK.

## Ganchos de red

`ConnectionEventManager.connectionRestoredEvents` (SharedFlow replay=0, emitido en `CONN:618-623` sólo con
`reconnectionAttempts>0`; ya lo escuchan `HOME:900`, `ShiftViewModel:258`, `MenuViewModel:463`) ·
`ConnectionStateManager.connectionState.hasServer` (StateFlow, `CONN:388/463`; lo usa `DeviceHealthViewModel:119`) ·
`onSuccess` de `refreshMerchants` (`HOME:948`) · `NetworkMonitor.networkStateFlow` no basta (Wi-Fi arriba con DNS caído
no dispara) · `SocketManager.isConnected` (`HOME:662`).

## Pruebas existentes

`AngelPayAuthRepositoryTest.kt` (542 líneas; `:354` resolver falla → AuthError; `:431-511` Amaena) ·
`AngelPayCredentialResolverTest.kt` (3; `resolveByAccountId` sin pruebas) · `AngelPayMerchantRepositoryTest.kt` ·
`AngelPayPaymentViewModelTest.kt` (con WIP de otra sesión; `:307`, `:350` guard de 8 s; `:547-780` D308/Amaena).
🔴 `testSandboxDebugUnitTest` compila con `ANGELPAY_SDK_ENABLED=false` (`build.gradle.kts:43`): `startCardPayment`
no llega a la ruta del SDK; existe el atajo `launchSdkRequest` (`VM:1615-1618`). `HomeViewModelTest` corre con
`SUPPORTED_PROCESSOR=BLUMON` (la rama AngelPay no se prueba ahí). `TerminalConfigRepositoryImplTest` sólo prueba
`mapNetworkErrorToUserMessage`.

## Riesgos

Sabores (sólo `nexgo`/`nexgoProd`; el `Provider.get()` dentro del candado `APP:175-181`; nada en PaymentViewModel de
sandbox/production) · Amaena (auth previa siempre `ensureAuthenticatedAs`; sin red nunca fallback a la primaria; el
reintento de fondo no llama `switchAccount`; alineación fail-closed) · Concurrencia (hoy nada impide dos auth a la vez;
el Mutex de Kotlin no es reentrante y hay llamadas anidadas `AUTH:530/553`, `:493/495` ⇒ cerrar sólo el núcleo privado o
compartir un `Deferred`; el reintento debe consultar `isCharging()`, porque la rama de sesión obsoleta hace logout
`AUTH:124`) · UI (con `Authenticating` se apagan Tarjeta **y Efectivo**, `SCR:595-597`, hasta ~39 s, `AUTH:248-251`,
`:763-785` ⇒ el reintento de fondo no debe bloquear el efectivo; enfriamiento contra tormentas) · Cobro remoto (cuando
falla la espera no se emite resultado, `VM:1379-1383` ⇒ el POS termina en UNKNOWN; un fallo de auth antes del SDK sí
acredita `failed + PRE_AUTHORIZATION`) · Salida interina sin reiniciar: `FETCH_ANGELPAY_MERCHANTS` desde el dashboard ·
Nota: en Nexgo `HOME:951` llama `initializeBlumonSDK()` sin el candado `ENABLE_PAX_SDK` (inofensivo, ruido).

## Evidencia de producción de los dos «Result not emitted» (sesión hermana, sólo lectura)

- 77ca56fb: enviado 15:41:57.504, ACK 15:41:57.699, cancel de la tablet 15:42:04.859 (la espera de 8 s seguía); el
  aviso cae ~15:42:09; CANCELLED 15:42:38 (gracia + vigía). Carrera sin daño: el cancel dejó RESOLVED y `markResolved`
  devolvió false. Orden `cmtx4jnp901d8o82anq2gvou7` (ORD-1789141317301, $286), 0 pagos.
- 27d380e9: enviado 15:46:41.394, ACK 15:46:41.639, cancel 15:46:43.606. Su aviso cae ~15:53:50, 7 min después, con el
  contexto de pago de 77ca56fb (intento 2dca91b9, $286, orden cmtx4jnp…). 27d380e9 es OTRA orden
  (`cmtx4pqps01euo82aw77787rw`, ORD-1789141601143, $313.50), CANCELLED 15:46:43.792, 0 pagos. Ningún `Payment` del venue
  menciona esos `requestId`; AngelPay no registra transacciones de la N86 entre 00:02 y 18:12 ⇒ el «Reintentar» de las
  15:53:50 no cobró. Los clientes pagaron en la PAX AVQD-2841653112 con órdenes nuevas ($260 DEBIT 15:42:23 y $285 CREDIT
  15:47:04, sin la propina del 10 % que traían las solicitudes).
- Dato de herramienta: `remote(t284025_render_log_stream_logs)` sí conserva horas; `s3Cluster` no devolvió nada para
  esa ventana.
