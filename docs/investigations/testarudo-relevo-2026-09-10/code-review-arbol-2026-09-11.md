# Code review del árbol NO commiteado — server · tpv · android · ios (11-sep-2026, 15:36–16:10)

**Auditor:** Fable 5.1 (Codex sin créditos). Cuatro lectores en paralelo (uno por repo) + verificación propia de cada P1 contra el árbol
vivo + corridas por `avq-verify`. Informes de los lectores: `code-review-arbol-2026-09-11-lectores/{server,tpv,ios,android}.md` (junto a este archivo).

🔴 **Léase con la hora enfrente.** Otras sesiones editaron los mismos archivos DURANTE la revisión (Android cableó el coordinador de
cancelación entre 15:33 y 15:58; la TPV cableó C.5/H.3 entre 15:36 y 15:57; el servidor empezó `desenlaceCanonico` (C.1) a las 16:04).
Cada hallazgo dice a qué foto corresponde; los P1 que quedan abajo los re-comprobé yo contra el archivo actual entre 15:50 y 16:10.

## Veredicto

| Repo | Veredicto | Motivo en una línea |
|---|---|---|
| **server** | **APROBADO CON CAMBIOS** (mecánica) · **NO DESPLEGABLE** (transición) | Plan D, sonda, lápida y C.6 aguantan la lectura y las 831 unitarias + 159 de integración; falta el flag por venue (I.6) y hay un P1 en el outbox de comisiones |
| **tpv** | **CON CAMBIOS — no commitear aún** | 4 P1 vivos de dinero/bloqueo; el árbol pasó por estados que no compilan; 4 archivos reescritos CRLF→LF |
| **android** | **EN CONSTRUCCIÓN** | tests-first en curso; a las 15:49 no compilaba, a las 15:58 ya estaba cableado; sin veredicto de compilación limpio (snapshot con KSP rancio) |
| **ios** | **CON CAMBIOS — la mitad «cancelación» es fachada** | 3 archivos nuevos son stubs que devuelven constantes; `details.requestId` nunca se llena; el 404 arma una llave sin salida contra el servidor de HOY |

Lo que el founder pidió ("nunca doble ni perdido") **no se viola en el servidor** con lo construido. Se viola hoy en la TPV por dos caminos
(P1-T1, P1-T3) y queda bloqueo sin salida en iOS/TPV por otros tres (P1-I1, P1-T2, P1-T4).

## Verificación ejecutada (árbol congelado por avq-verify en cada corrida)

| Qué | Resultado | Evidencia |
|---|---|---|
| server `tsc -p tsconfig.typecheck.json` | **0 errores**, local y Alienware COINCIDEN | `run-avoqado-server.Asdkim` |
| server jest unit `terminal|orderCancel|paymentEffects|referral|terminalRegistry|order-table` | **68 suites / 831 pruebas, 0 fallos**, COINCIDEN | `run-avoqado-server.TES4xK` |
| server jest integration (Postgres `codex_testarudo_test_20260909`) `terminalPaymentRecovery|orderCancelRoutes|paymentEffects*` | **7 suites / 159 pruebas, 0 fallos** (44 s) | `~/.claude/jobs/71c86fc4/tmp/review/verify-server-integration-3.txt` |
| android `testDebugUnitTest --tests com.avoqado.pos.payment.*` (15:49) | **NO COMPILA** el `main`: `PaymentFlowViewModel.kt:1861,1902` llaman `suspend cancelCurrentPayment()` fuera de corrutina | `run-avoqado-android.WIQgIe` |
| android ídem (16:04) | **INCONCLUSO por entorno**: el snapshot traía `build/generated/ksp` rancio («source file not found …Dao_Impl.kt»), Mac a load 413 | `run-avoqado-android.kqXTYl` |
| tpv `testSandboxDebugUnitTest` (15:54, JDK 24) | **INCONCLUSO**: «Type T not present» (trampa conocida del JDK; correr con zulu-17) | `run-avoqado-tpv.WL3eZ3` |
| tpv ídem (15:55, JDK 17) | **NO COMPILA** sandbox: `PaymentViewModel.kt:4845` llama `suspend runInfallible` fuera de corrutina (archivo en edición por otra sesión) | `run-avoqado-tpv.UmUtVK` |
| tpv ídem r2 (16:04, JDK 17) | **CANCELADA a las 16:29**: 24 min en la fila de avq-verify sin arrancar (otra sesión compilando la TPV; Mac a load 771). Pendiente: `JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testSandboxDebugUnitTest --offline -q` | — |
| ios | **no compilado** (xcodebuild pesa demasiado con la Mac a load 400–780); veredicto por lectura | — |

## P1 — dinero, pérdida de datos o bloqueo sin salida (verificados por mí contra el árbol)

### Servidor

**P1-S1 · Desplegar el árbol tal cual reserva desde el minuto uno las terminales con filas históricas (305 + 53 + 12 en prod).**
`terminal-payment.service.ts:228-236` `UNRESOLVED_FINANCIAL_OUTCOME` incluye TODO `TIMED_OUT` (sin mirar `failureCode`), `FAILED` con
`ACK_TIMEOUT|ACK_REJECTED|TPV_ERROR` y `CANCELLED` con `cancelDisposition ≠ ACCEPTED` — y la migración `20260909181000` crea esa columna en NULL.
HEAD (prod) sólo bloquea `SLOT_HELD`. No existe flag por venue ni cota de fecha (`grep` de `strictOutcome|predicadoEstricto|createdAt: { gte`
⇒ 0), `releaseUnknownRequest` no libera (`:2123`, «Release awaits execution confirmation») y la sonda sólo libera procedencia `[]` (las
históricas tienen `null`). **No es un defecto del código construido: es la pieza I.6 que falta (flag por venue apagado + conciliación B de las
375 filas) y está en la tabla de fases como pendiente.** Pero convierte el árbol en no desplegable hasta entonces.

**P1-S2 · Un efecto de comisión en `DEAD_LETTER` genera su reversa NEGATIVA al reembolsar, sin que la positiva exista** (outbox de otra sesión).
`commission-calculation.service.ts:360-364` mete en `originalCalcs` los efectos `PENDING|PROCESSING|DEAD_LETTER`; si la comisión positiva murió
tras 6 intentos, el reembolso crea la reversa negativa igual (se aplica por su propio efecto) y `commission-utils.ts:805,830` sigue restando esa
base para siempre. No hay reintento manual (`list_payment_effects` sólo lee). Ninguna prueba reembolsa sobre un DEAD_LETTER
(`paymentEffectsOutbox.integration.test.ts:345` llega al DEAD_LETTER y no reembolsa; `paymentEffectsReview:197` reembolsa sobre PENDING).

### TPV

**P1-T1 · El verificador de cobro incierto de AngelPay NO puede confirmar nada cuando el ViewModel se recreó ⇒ dinero cobrado sin registrar.**
`AngelPayChargeVerifier.kt:97` exige `!affiliation.isNullOrBlank() && mia.affiliation == affiliation`; la afiliación vive sólo en RAM
(`AngelPayPaymentViewModel.kt:584` `private var pendingProcessorAffiliation`, se asigna en `:799` y se pasa en `:2529`), NO está en el
`SavedStateHandle`. El escenario para el que existe el verificador es justo aquel en que la Activity del SDK mató `MainActivity` y el VM llega
nuevo: recupera el `attemptId` de la libreta (`:2119-2125`) pero no la afiliación, que está en la MISMA fila (`:801` la escribe en
`contextJson`; `LedgerUnknownRecovery.kt:35` ya la lee de ahí). Resultado: historial confirma el cobro, la app contesta `timeout`, fila
`INDETERMINADO`, terminal reservada. Arreglo: leerla de la libreta cuando el campo en RAM sea null. El test `AngelPayChargeVerifierTest.kt:167-170`
pasa por el motivo equivocado (usa `affiliation = "other"`).

**P1-T2 · Sin turno abierto, un cobro remoto se RECLAMA y no se contesta nada ⇒ UNKNOWN ⇒ terminal reservada (el servidor nuevo ya no libera por reloj).**
`PaymentViewModel.kt:3291-3298` (sandbox; production idéntico) publica `PaymentState.Error(... showOpenShiftButton = true)` sin `canRetry = false`,
y `PaymentState.kt:455` nace con `canRetry = true` ⇒ el observador del socket no emite. `AppNavigation.kt:374-378` ya reclamó la fila
(`prepareSocketPaymentRequest`) antes de esta guarda. Es la celda «sin turno» que el 10-sep se midió en la PAX y que la regla canónica manda
contestar con `failed + PRE_AUTHORIZATION`. Arreglo de una línea (`canRetry = false`); `openAttempt` corre DESPUÉS de la guarda, así que la
evidencia es legítima.

**P1-T3 · La recuperación de aprobaciones puede registrar un REEMBOLSO de AngelPay como VENTA; lo único que lo impide hoy es un campo ausente.**
`PaymentAttemptDao.kt:17-21` `getApprovalRecoveryCandidates` no filtra `kind`; `LedgerApprovalRecovery.kt` decide por procesador antes que por
ruta (`grep kind|ROUTE_REFUND` ⇒ 0 resultados en el archivo). Hoy corta porque el contexto del reembolso es un stub de 3 campos y `venueId`
no coincide — protección incidental por el orden de un `||`. La regla del repo ya dice «no desplegar sin separar los tipos». Arreglo de dos
líneas: `AND kind = 'SALE'` en la consulta y excluir `ROUTE_REFUND` en el `when`.

**P1-T4 · La lápida `NOT_FOUND_ANSWERED` puede matar una entrega legítima si la sonda gana la carrera al `receive`, y no hay palanca.**
`RemotePaymentInbox.kt:154-158` + `answerAbsent`: la sonda hace `getById` y, si es null, inserta la lápida sin ninguna condición de vigencia ni
de «esta solicitud está en vuelo en mi canal» (el Coordinator tiene `queuedRequestIds`/`reclamadasEnEsteProceso`). Si el servidor sondea una
fila que acaba de emitir (procedencia ya grabada), la entrega real llega después, `receive` la rechaza, el servidor no libera
(`NOT_FOUND_AFTER_DELIVERY`) y la lápida es irreversible (`markResolved` lista positiva `RECEIVED|PROCESSING`; cero `DELETE` en la bandeja).
La mitad del remedio es del servidor (no sondear filas con `lastDeliveredAt` reciente); la otra mitad es que la TPV no deje lápida de un
`requestId` que tiene en vuelo. `RemotePaymentInboxRoomTest` prueba sonda y entrega en secuencia, nunca concurrentes.

**P1-T5 · Un cancel del cajero en Nexgo (U100) ⇒ `INCIERTO` ⇒ `timeout` ⇒ terminal reservada y la fila `INDETERMINADO` bloquea los cobros siguientes.**
`AngelPayOutcomeClassifier.kt:95-101`: `U100` no está en `CODIGOS_RECHAZO_CONFIRMADO`; `CODIGOS_SIN_VEREDICTO` (`:58-63`) es código muerto.
Combinado con P1-T1 y con la barrera dura de `reserveTerminal` (sin filtro por venue), un gesto diario deja la Nexgo inservible. Deliberado a
nivel de clasificador; la consecuencia de sistema no está declarada. Decisión de producto pendiente (¿U100 acredita «no se cobró»? Sólo si el
SDK garantiza que un cancel del usuario nunca ocurre tras la autorización; si no, hace falta la palanca manual clase B).

### iOS

**P1-I1 · Un 404/422/400 del POST arma una llave durable IRRESOLUBLE contra el servidor de HOY, y el iPad no puede vender ni en efectivo.**
`CardChargeOutcome.swift:165-172` `mustReconcile` ahora incluye `[400, 404, 409, 422]` (HEAD sólo `isTransportFailure`). Con el servidor de
producción (sin lápida) la PAX dormida contesta 404 ⇒ GET 404 ×3 ⇒ `.undetermined` ⇒ llave armada; `forgetUnresolvedCharge()` es no-op
(`TerminalPaymentService.swift:203`), `chargeAgainDespiteUndetermined()` devuelve `false` (`PaymentFlowViewModel.swift:2453`), el botón
«Cobrar de nuevo» se retiró de `PaymentResultViews.swift` (3 → 1 ocurrencias, la que queda es texto), y `blockedByPendingCardCharge` corre
antes de elegir método (`:248-251`) ⇒ tampoco efectivo. Keychain sobrevive a reinstalar. **Es correcto contra el servidor del árbol** (la
lápida devuelve `FAILED/REJECTED_*` y suelta la llave), así que el orden de despliegue lo cubre: **iOS nunca antes que el servidor**. Pero el
503 `TERMINAL_PAYMENT_ADMISSION_RETRY` deja el mismo callejón incluso con el servidor nuevo: no hay fila, y iOS declara
`admissionRetryDelays` (`TerminalPaymentService.swift:217`) sin usarla (0 usos); Android sí reintenta el mismo POST
(`TerminalPaymentService.kt:383`).

**P1-I2 · La correlación por `details.requestId` está rota en dos puntos.** `APIClient.swift:655-661` construye `APIBusinessErrorDetails` sin
`requestId` (default `nil`, `:592`); `TerminalPaymentService.swift:328-336` `rejection(from:)` tampoco lo pasa. Aunque se implementara
`admissionRejectionMessage`, recibiría `nil`. `OrderCancelDecisionTests.swift:251-256` lo demuestra y hoy falla.

**P1-I3 · La cancelación durable (C.4/C.6/H.5) en iOS es FACHADA.** `OrderCancelDecision.swift`, `PendingOrderCancelCoordinator.swift`,
`PendingOrderCancelStore.swift` devuelven constantes (`find → nil`, `due → []`, textos `""`); `cancelPayment`/`cancelIdentity`/
`acknowledgeCancelVerdict` son stubs (`TerminalPaymentService.swift:738-754`); `cancelChargeAndOrder` sigue fire-and-forget
(`PaymentFlowViewModel.swift:1923-1931`); no hay migración GRDB (última `v15`, `DatabaseManager.swift:366`); nadie arranca el coordinador.
`OrderCancelDecisionTests`, `OrderCancelFlowTests` y `PendingOrderCancelStoreTests` (1 193 líneas) no pueden estar en verde. Y
`getPaymentStatus` descarta `outcome/outcomeEvidence/failureCode` (`TerminalPaymentService.swift:511`) aunque el DTO los decodifica. Encaja
con «En curso: la cancelación durable de Android e iOS» de la tabla de fases: es trabajo a medias, no un defecto escondido — pero **no debe
describirse como «iOS al día con Android»**.

### Android

**Estado, no hallazgo.** Los cinco tests de `Cancelacion*` nacieron entre 15:25 y 15:36 sin código de producción (TDD); a las 15:49 el `main`
no compilaba (`PaymentFlowViewModel.kt:1861,1902`); a las 15:58 el VM ya llama `cancelacionDeCobro.registrar/procesarAhora`
(`:1999, :2016, :2051, :2115, :2125`) y ya no llama `cancelCurrentPayment` directo; existen `CancelacionDeCobro.kt`, `…Coordinator.kt`,
`…Http.kt`, `…Module.kt`. Lo que sí quedó verificado y bien: llave antes del POST (`TerminalPaymentService.kt:232`), 409 correlacionado
(`refusedForAnotherRequest`), reintento del 503 de admisión con el mismo POST (`:383`), código HTTP del entero, deserialización tolerante.
`CardChargeDecision.fromTerminalStatus` (`CardChargeOutcome.kt:273-282`) confía en `FAILED` a secas — seguro hoy porque el servidor degrada a
`timeout` todo failed/cancelled sin evidencia, pero es un acoplamiento sin defensa del lado cliente.

## P2 que valen la pena (resumen; detalle en los informes de los lectores)

- **S** · `FAILED + PROCESSOR_DECLINED` tras un cancel `ACTIVE` deja `cancelDisposition: 'ACTIVE'` para siempre (`closeRow` `:1544` sólo escribe
  la disposición cuando `status === 'cancelled'`) — es el punto de C.1 que `desenlaceCanonico` (en construcción a las 16:04) debe cubrir.
- **S** · `abandoned-orders-cleanup.job.ts:124` y tres `order.deleteMany` (venue/demo cleanup) siguen fuera del inventario C.6; el test de
  arquitectura `orderCancelWriters.test.ts:26` sólo detecta `.order.update(Many)(`.
- **S** · `void this.markDelivered(...)` sin `.catch` en `:1195` (un P2024 ⇒ `unhandledRejection` ⇒ gracefulShutdown); preexistente pero dentro
  del bloque reescrito, y el árbol arregló la misma clase en `:1300` y `socketManager.ts:228`.
- **S** · `CREATE INDEX` sin `CONCURRENTLY` sobre `Payment` (`20260909213000`): bloquea INSERT/UPDATE mientras construye; medir tamaño en prod.
- **S** · `digitalReceipt.tpv.service.ts:92` transacción nueva sin `{timeout, maxWait}` en el camino síncrono del cobro (el resto del diff sí las fija).
- **S** · Barrido de filas liberadas (`:1993-2055`) vivo pero sin escritor y con ventana de 30 min: sólo alcanza lo que prod escribió en los 30 min
  previos al despliegue; `const released = 0` viaja como métrica.
- **S** · 503 de admisión: no deja lápida (no hay fila). Para las apps publicadas es un callejón nuevo (consultan, 404, llave). Propuesta: lápida
  `REJECTED_ADMISSION_TIMEOUT` escrita FUERA de la tx (el `@unique` de `requestId` la rechaza si la tx sí había commiteado).
- **T** · `cancelled + PROCESSOR_DECLINED` (pareja venenosa) cerrada a las 15:52 en dos capas (`PaymentViewModel.kt:4749-4750` sandbox,
  `RemotePaymentRequestDao.kt:180`) **sin prueba que la guarde**: borrar el `if` deja todo en verde.
- **T** · Cuatro archivos reescritos CRLF→LF (`AvoqadoDatabase.kt` 3 831 líneas de diff por 49 reales, `DatabaseModule.kt`,
  `MerchantSelectionContent.kt`, `PaymentViewModelTest.kt`): garantiza conflictos con las otras sesiones. Revertir el fin de línea o commit aparte.
- **T** · `fallbackToDestructiveMigrationOnDowngrade()` + Room v33→v34: un `INSTALL_VERSION` de retroceso borra libreta, bandeja y colas. Decisión
  declarada antes de publicar v34. Y `FACTORY_RESET` (`CommandExecutor.kt:1055-1077`) sigue borrando todo sin comprobar `findUnresolvedCharge()`.
- **T** · `cancelCashPayment()` publica `Cancelled` sin evidencia y sin tocar la bandeja (kiosco) ⇒ UNKNOWN si el cobro era remoto.
- **T** · La rama `LIBRE` de la barrera dura de la libreta (`AngelPayPaymentViewModel.kt:1747-1755`) rechaza un cobro remoto sin emitir nada.
- **T** · `coVerify(exactly = 0) { chargeVerifier.verificar(any()×5) }` con 6 parámetros reales: el `exactly = 0` pasa aunque se llame
  (`AngelPayPaymentViewModelTest.kt:2788, :2815`).
- **T** · Se quitó el redondeo de centavos en AngelPay (`:760-761`): más de 2 decimales lanza y el cobro queda rechazado sin `canRetry`.
- **I** · `StockCountType` no tolera un valor nuevo (`InventoryModels.swift:68-70`) mientras `StockCountStatus` sí; `BorradorDeConteo` lo lee con
  `try?` ⇒ el conteo del cajero desaparecería en silencio (el defecto de Mindform, otra vez).
- **I** · `.cancelling`/`.cancelPending` renderizan `EmptyView()` y atrás no sale (`PaymentFlowView.swift:401-406`).

## Lo que está BIEN (confirmado en código, no sólo por los lectores)

- **Servidor:** procedencia grabada antes de emitir en los dos protocolos y si no se graba no se emite (`:1015-1045`); `leerProcedencia` falla a
  seguro (`:216-232`); liberación por NOT_FOUND atómica dentro del `updateMany` (`:2652-2662`); lápida de admisión en la misma tx, lanzada tras el
  commit, sin ocupar ranura, ocho motivos (`:474-482`, `:712-748`); C.6 en los seis escritores de aplicación + VERDAD_EXTERNA con 🚨 en pos-sync y
  delivery; identidad de terminal por serial firmado (`socketManager.ts:189-192`) y `outcomeEvidence` descartado si no verificada (`:450`);
  `findReconcilablePayment` exige atribución física (`:1846-1866`); el ACK del replay ya se ejecuta (`:1418-1425`).
- **TPV:** toda escritura de la bandeja es CAS o `INSERT IGNORE`; `cancelarTrasReclamar`/`resolverDesenlaceNegativo` con `@Transaction` y
  reversión; la evidencia negativa la decide la libreta, no la pantalla; `markResolved` con lista positiva; `congelarArgumentosDeCobro` cierra los
  dos caminos de D.7 a la ENTRADA; `sessionAlignedWithSelectedMerchant` fail-closed y `asegurarSesionAntesDeEsperar` antes de `setCharging`
  (T26); H.3 aplicada en AngelPay (`retenerDesenlaceDeRechazo`/`emitirDeclinacionRetenida`); hunks production/sandbox idénticos;
  `MIGRATION_33_34` idempotente con `PRAGMA table_info` y test desde `schemas/33.json`.
- **iOS:** llave antes del POST y si el Keychain falla no se autoriza (`TerminalPaymentService.swift:365-373`); `persistPendingCardCharge` no pisa
  una llave viva; 409 correlacionado con paridad real (`CardChargeOutcome.swift:210-215`, `TerminalBusyRejectionTests:68-100`); código HTTP del error
  tipado; cambio en efectivo = recibido − cobrado; `colaTrasAdoptarLaCaja` pura y el CIERRE nunca viaja a caja ajena; `ReceiptLogoCache` arreglado.
- **Android:** llave antes del POST, 409 correlacionado, reintento acotado del 503, deserialización tolerante.

## Lo que NO pude verificar

- iOS no se compiló ni se corrió (xcodebuild con la Mac a load 400–780 la habría tumbado): los «no pueden pasar» de los tests de cancelación son
  deducción por lectura de stubs, no una corrida.
- Android y TPV no tienen un veredicto de compilación LIMPIO del árbol actual: los dos primeros intentos fallaron por código real de esa foto (ya
  cambiado) y los siguientes por entorno (KSP rancio en el snapshot; JDK).
- El censo de las 375 filas históricas en prod (P1-S1) se toma del relevo, no se volvió a contar.
- Nada en hardware: las celdas de la matriz de la regla canónica (sin turno, cancel durante el SDK, pantalla apagada) sólo se leyeron.
- El orden global de candados `StaffVenue`↔`Order` que introduce el congelado de comisiones dentro de la tx del dinero (deadlock posible; el
  SAVEPOINT lo recupera, pero conviene canario).
- El lado servidor de P1-T4: si el barrido sondea filas con `lastDeliveredAt` reciente decide si es diario o raro. No lo leí.

## Qué hacer, en orden

1. **TPV, antes de commitear:** P1-T2 (una línea), P1-T3 (dos líneas), P1-T1 (leer la afiliación de la libreta), prueba para la pareja venenosa,
   revertir CRLF→LF, y `assembleSandboxDebug` + `testSandboxDebugUnitTest` por `avq-verify` con `JAVA_HOME` zulu-17.
2. **Servidor:** cerrar C.1 (`desenlaceCanonico`, en curso) proyectando `cancelDisposition` y `outcome` coherentes; `.catch` en `:1195`; flag por
   venue (I.6) ANTES de cualquier despliegue; decidir DEAD_LETTER de comisiones (P1-S2) con la sesión del outbox.
3. **iOS:** terminar los stubs o quitarlos del árbol antes de cualquier build de TestFlight; llenar `details.requestId`; usar `admissionRetryDelays`;
   leer `outcome/outcomeEvidence` en el GET.
4. **Android:** esperar a que la sesión en curso termine el cableado y correr `testDebugUnitTest` con snapshot limpio (`--rerun-tasks` o borrar
   `build/generated/ksp` del snapshot).
5. **Despliegue:** sigue el orden de I.6 — servidor con predicado estricto apagado por venue → conciliar → APK por terminal → encender → POS al final.
