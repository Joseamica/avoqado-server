# CHECKPOINT — LEER PRIMERO para continuar Testarudo

Checkpoint del 9-sep-2026, aproximadamente 16:15 America/Mexico_City. Autor: Codex. **Trabajo incompleto; NO publicar, desplegar, pushear ni declarar pagos resueltos.** Este documento prevalece sobre estados históricos contradictorios de los reportes copiados; el código actual y la evidencia verificable prevalecen sobre cualquier conclusión del agente.

## Petición y forma de continuar

El usuario autorizó corregir el circuito Android POS → servidor → PAX/Blumon TPV y Nexgo/AngelPay, incluyendo persistencia antes de autorización, recuperación sin recobrar, cancelación/reentrega seguras, compatibilidad con APK publicados y outbox transaccional. Solicitó TDD estricto, PostgreSQL real, avq-verify, auditoría independiente Codex final y pruebas físicas sandbox. Prohibió push/deploy. No se han hecho commits de este trabajo por el coordinador.

**Última preferencia explícita: esfuerzo MEDIO, ahorrar tokens, sin agentes paralelos.** No se debe fingir haber cambiado el selector de razonamiento del host: lo configura el usuario. El usuario pidió este checkpoint para que otro LLM continúe y revise. Hubo agotamiento de créditos de auxiliares; no relanzarlos en bucle ni consumir resets/comprar créditos sin autorización. La última restricción de solo lectura fue retirada; ahora hay escritura autorizada.

Plan económico desde este punto:

1. Una unidad de trabajo a la vez, sin subagentes ni análisis repetidos de toda la historia.
2. Leer este checkpoint y únicamente el reporte/código de la unidad elegida. Leer también CLAUDE.md/rules/memorias aplicables antes de editar; no releer documentos ya cargados salvo compactación/cambio relevante.
3. Ejecutar primero las regresiones nuevas aún no ejecutadas; corregir únicamente tras RED real. No tratar errores de fixture/compilación como RED financiero.
4. Pruebas enfocadas durante el arreglo. Suite del módulo y typecheck al estabilizar; suite/build completos al cierre amplio. Una sola verificación pesada a la vez.
5. Resolver los hallazgos ya conocidos con sus pruebas. Reservar la revisión independiente completa para el final; una comprobación enfocada de cada hallazgo no requiere volver a auditar los cuatro repos.
6. Actualizar este checkpoint después de cada bloque con resultado, limitación y siguiente comando. Nunca ocultar una prueba pendiente para ahorrar tokens.

## Estado de repos y concurrencia

| Repo | Rama observada | HEAD del checkpoint |
|---|---|---|
| avoqado-server | develop | d33f4ad25f4faee97548cfb9f99efa859e0bab9e |
| avoqado-tpv | main | aea0169507e3c8f62ca02121e8f79cef7d78485a |
| avoqado-android | main | dbfc8a4431a888a51411401240a08ed454318420 |
| avoqado-ios | main | b7ad204fa2573ea115f0125e21a022f00abd631e |

No cambiar ramas ni usar reset/checkout/stash/clean. El árbol y el índice contienen WIP de otras sesiones. Inventario, caja, watchdog y otras modificaciones ajenas NO pertenecen automáticamente a esta tarea. `git diff HEAD -- rutas` incluye staged y unstaged; `git diff` solo no basta. Archivos nuevos sin seguimiento deben leerse también.

[manifest.json](./manifest.json) contiene HEAD/rama y SHA-256 de 177 fuentes modificadas para detectar cambios DESPUÉS del checkpoint. No prueba autoría y no es una orden de restauración. `*-status.txt` y `*-diff-stat.txt` son inventarios, no listas de archivos a revertir. Comparar hashes antes de confiar en resultados viejos; no sobreescribir trabajo posterior.

No había avq-verify, Codex CLI, servidor de laboratorio ni build propio activo al capturar el checkpoint. No asumir que los IDs de sesiones PTY anteriores sirven todavía. Auxiliares detenidos/agotados; no depender de su memoria.

## Evidencia y conclusiones del incidente ya investigado

No repetir la conciliación completa ni volver a descargar logs salvo nueva evidencia:

- La cola de ~9.7 s era anterior al cambio a la URL privada de Postgres del 6-sep. Request End se separó de Request Closed Prematurely: p95 del 7-sep ~705 ms y 8-sep ~824 ms. El registro del caso duplicado fue ~363 ms.
- PAX $319 el 8-sep: dos aprobaciones del procesador para un request POS y attemptKey; la primera seguida de GenericFailure y una nueva autorización SDK. Operación Blumon 24237797 no estaba registrada; 24237873 sí. Liquidación/reverso no confirmado: NO crear Payment ni reembolsar automáticamente.
- Nexgo $308: desconexión ~500 ms después de enviar, sin resultado, reemplazo efectivo 59 s después. Ausencia en CSV/webhook no prueba ausencia de cargo.
- ~95.5% del circuito viene de POS. Los 61 reenvíos rápidos no demuestran 61 cancelaciones ignoradas de tablet: 57 cancelaciones reales de terminal y 4 watchdog.
- Informes canónicos en docs/investigations/testarudo-2026-09-09-{android-tpv-relay,conciliacion-portales}.md y testarudo-2026-09-08-codex.md. Las memorias iniciales contienen conclusiones históricas luego corregidas; no repetirlas como hechos actuales.

## Estado por unidad — qué está verificado y qué NO

### Task1: autorización y recuperación TPV — ABIERTO

Archivos: features/payment/data/ledger, processor/angelpay, PaymentViewModel sandbox Y production, AngelPayPaymentViewModel, pantallas de pago y pruebas correspondientes. Ver [reporte](./reports/task-1-report.md) y [auditoría inicial](./reports/task-1-review.md).

Implementado: contexto durable antes del SDK aun con observabilidad OFF; GenericFailure/errores inciertos no permiten nueva autorización; recuperación de aprobación registra con la misma clave; verificador AngelPay exige identidad/afiliación y aprobación exactas; contexto de vendedor efectivo; fallo CAS no permite relanzamiento; leases por adquisición con finalización condicionada al propietario. Todo aún necesita cierre de regresiones/auditoría.

Evidencia reciente:

- `vBUz5M`: 421 tests, 12 fallos nuevos válidos, anteriores 408 controles GREEN. Se aplicaron correcciones a esos 12 casos.
- `csYG8R`: 421 tests, 416 pasan / 5 fallan. **No es GREEN.** Fallos:
  1. Recreación AngelPay: esperado ResultadoIncierto, obtenido Idle. RED válido con fixture ya corregido. Falta restaurar fase/contexto durable antes del callback vacío; ausencia de memoria no demuestra preautorización.
  2–3. PaymentAttemptLedgerTest: mock nuevo findTerminalHold no configurado impide insert. Revisar fixture, no debilitar guardia.
  4. LedgerRecoveryLeaseRoomTest propietario vencido: timeout virtual de coroutines 240 s, revisar coordinación del fixture sin eliminar prueba de CAS real.
  5. Parser contradictorio→VM: mock getCurrentShift devuelve Object, ClassCastException a Shift. Corregir fixture para alcanzar resultado financiero.
- [tpv-failure-evidence.json](./tpv-failure-evidence.json) conserva 12+5 fallos y nombres. XML completos originales en run-avoqado-tpv.{vBUz5M,csYG8R}/xml (pueden expirar).

**Tres regresiones nuevas escritas, NO EJECUTADAS:** PaymentViewModelKernelDurabilityTest (2) y caso nuevo PaymentAttemptRoomTest (1). Comprueban fallo real de escritura de aprobación offline, instancia recreada con PREPARANDO y dos reservas simultáneas entre venues/sin orderId. Deben correr ANTES de la siguiente implementación.

Huecos requeridos, no diferibles: PREPARANDO actualmente no reserva de forma atómica toda ejecución nativa; el kernel puede aprobar offline antes de AUTORIZANDO. markHostResponded sigue siendo Unit y absorbe fallos de persistencia. Diseño mínimo detallado al final del reporte: reserva atómica, fase durable de entrada al kernel antes de llamada capaz de aprobar, confirmación de escritura antes de éxito y retención al fallar. No inventar prueba de hardware inactivo. No se aplicó aún este diseño.

El plan de distinguir ejecución activa de incertidumbre financiera depende de evidencia nativa de fin/limpieza que NO se ha conseguido. Reset de flujos Kotlin, heartbeat, timeout o reinicio no la acreditan. Mantener protección conservadora; no prometer disponibilidad perfecta durante resultados desconocidos.

### ACTUALIZACIÓN 2026-09-09 (Claude, tras el checkpoint) — Task1: el RED pendiente se ejecutó y está en GREEN

Verificado ANTES de tocar nada: los 4 HEAD coinciden y **los 177 archivos del manifest tienen hash
idéntico**; el árbol estaba exacto como Codex lo dejó.

**El RED pendiente se corrió** (`run-avoqado-tpv.Fzehll`, `:app:testSandboxDebugUnitTest`,
5 tests / 3 fallos). Los tres fallos fueron `AssertionError` de comportamiento, no de fixture ni de
compilación, y `compileSandboxDebugUnitTestKotlin` salió SIN sufijo (recompiló de verdad):

1. `PaymentAttemptRoomTest` — «one durable pre-kernel reservation … expected:<1> but was:<2>».
2. `offline approval write failure` — publicaba `Success(authCode=OFFLINE_APPROVED)` con la escritura caída.
3. `recreated VM … while previous instance is preparing` — `StartCtlssTransUseCase.run` SÍ se llamó.

**Los tres pasan a GREEN** (`run-avoqado-tpv.8K4OgT`, confirmado leyendo los XML por nombre de caso).

Implementado, siguiendo el «diseño mínimo» del reporte Task1:

- **Reserva atómica**: `PaymentAttemptDao.reserveTerminal` es `INSERT … SELECT … WHERE NOT EXISTS`
  (una sentencia; el check-then-insert anterior admitía dos). `findTerminalHold` incluye ahora los
  estados pre-kernel. Room aceptó el SQL (KSP compiló).
- **Estado nuevo `KERNEL_ACTIVO`** + `markKernelEntered`, comprometido ANTES de
  `StartCtlssTransUseCase.run`. 🔴 Confirmado por lectura de código que el contactless (`PICC`)
  salta al kernel y hace `return@launch` sin pasar NUNCA por `markAuthorizing`, así que la fila se
  quedaba en `PREPARANDO` — el estado que autoriza a `markDiscardedBeforeCharge` a afirmar «no se
  cobró». No hay cambio de esquema (columna `state` existente) ⇒ **sin migración de Room**.
- **`markHostResponded` devuelve Boolean**; el VM sólo publica `Success` si la obligación quedó
  escrita, y si no llama a `showUnresolvedAuthorization()` («Cobrado. Sincronización pendiente.»),
  que además impide que `resetPayment` emita `cancelled`/`success` (lo exige el test 2).
- 🔴 **Liberación acotada, que NO estaba en el RED y sin la cual el arreglo tumbaba la caja**: con
  el candado ampliado, cada rechazo del kernel (Testarudo 2026-09-07: nueve en tres ventas) dejaba
  la terminal retenida. `markKernelRefused` libera SÓLO con negativa explícita
  (`KERNEL_REFUSALS_WITHOUT_CHARGE`, definido UNA vez junto al clasificador); `TIMEOUT`/`OTHER`
  siguen reteniendo. El sweep añade `quarantineStaleKernel` (→ INDETERMINADO, jamás DESCARTADA) y
  `discardStalePreparing` (única liberación por tiempo, segura por construcción). Prueba propia:
  `PaymentAttemptRoomTest > P1 una negativa explicita del kernel libera la terminal…`.
- Cambios espejados en **sandbox Y production** (verificado por conteo y por diff del bloque).
- CHANGELOG actualizado (regla #1 del repo).

**Fixtures migrados, sin debilitar lo que guardan:** `PaymentAttemptLedgerTest` mockeaba
`dao.insert` (ya no usado) y fijaba listas EXACTAS de estados; se actualizaron al contrato nuevo.
🔴 Trampa que casi rompe todo en silencio: los fixtures del VM usan `mockk(relaxed = true)`, que
devuelve **false** para Boolean — `markKernelEntered` y `markHostResponded` habrían abortado el
contactless en todas las suites; se configuran explícitamente en los 4 fixtures.

**Limitaciones declaradas, NO resueltas:**

- 🔴 **`processContactlessRefund` tiene el MISMO hueco de entrada al kernel y NO se tocó.** Es un
  segundo flujo contactless (sandbox 4456 / production 9210), usa `refundAttemptId` y hoy no llama
  a `markHostResponded` en absoluto. No hay RED que lo cubra y el checkpoint prohíbe corregir sin
  RED real: necesita su propia regresión primero.
- `LedgerRecoveryLeaseRoomTest > review expired owner cannot overwrite state…` sigue fallando con
  `TimeoutCancellationException: 4m of virtual time`. Es **el fallo #4 ya anotado en este
  checkpoint** (corrida `csYG8R`), preexistente y de coordinación del fixture — no es regresión de
  este bloque, y sigue pendiente.
- `observeUnresolvedCount` NO se amplió con los estados nuevos, a propósito: una venta en curso no
  debe contarse como «sin resolver» en la UI. Declarado, no verificado con prueba.
- Sin QA físico, sin build de release, sin commit, sin push, sin deploy.

### 🟢 ESTADO FINAL DE ESTE BLOQUE

De los **5 fallos** que el checkpoint declaraba abiertos quedan **1**; y las **3 regresiones que
nunca se habían ejecutado** están en GREEN. Cerrados aquí: #2, #3 (fixtures del ledger), #4
(reloj virtual) y #5 (fixture que tapaba un camino correcto). **Abierto: sólo #1.**

**RESULTADO de la corrida de confirmación** (`run-avoqado-tpv.5EMsKB`): **457 tests / 3 fallos**, y
los TRES estaban ya declarados en este checkpoint como pendientes de la corrida `csYG8R` —
verificado comparando el mensaje literal, no por suposición:

| Fallo | Era el pendiente | Mensaje que lo prueba |
|---|---|---|
| `AngelPayPaymentReviewRoomTest > …VM recreation and empty callback…` | **#1** | «esperado ResultadoIncierto, obtenido **Idle**» — RED válido, falta implementar |
| `LedgerRecoveryLeaseRoomTest > …expired owner…` | **#4** | `TimeoutCancellationException: 4m of virtual time` — coordinación del fixture |
| `AngelPayPaymentReviewRoomTest > …contradictory issuer and timeout…` | **#5** | `ClassCastException: Object → Shift` en `AngelPayPaymentViewModel:929` — fixture |

Los pendientes **#2 y #3** de esa lista (`PaymentAttemptLedgerTest`, mock de `findTerminalHold`)
**quedan CERRADOS**: los fixtures se migraron a `reserveTerminal` y la suite pasa.

🔴 **#5 corregido en este bloque** (era fixture, no código): el test era el ÚNICO de los cuatro de
su archivo sin `TpvSettings(enableShifts = false)`, así que el `ShiftRepository` relajado devolvía
`Object` y reventaba en `initPayment` **antes** de llegar al desenlace financiero que mide. Añadido
igual que sus tres hermanos. Corrida de comprobación lanzada; si al pasar el fixture aparece un RED
financiero real, ése es hallazgo NUEVO y va con su implementación, no con otro parche de fixture.

🟢 **#5 CERRADO y verificado** (`*AngelPayPaymentReviewRoomTest`: 4 tests / 1 fallo, y el que falla
ya no es éste). 🔑 Al destaparse, el test **PASA**: el comportamiento financiero de ese camino ya
era correcto — el `ClassCastException` del fixture lo estaba tapando. No hizo falta tocar producción.

🟢 **#4 CERRADO y verificado** — `run-avoqado-tpv.gXepcw`: **46 tests / 0 fallos** en las 6 suites
del ledger, con `compileSandboxDebugUnitTestKotlin` SIN sufijo y timestamps del momento (o sea:
corrió de verdad, no es caché ni un BUILD SUCCESSFUL vacío). Incluye `LedgerRecoveryLeaseRoomTest`
3/0, `PaymentAttemptLedgerTest` 18/0 y `PaymentAttemptRoomTest` 4/0 (con la prueba nueva de
liberación del kernel). Causa raíz: no
era coordinación de `CompletableDeferred`: `LedgerApprovalRecovery` envuelve el registro en un
`withTimeout(240_000L)` de PRODUCCIÓN, y bajo `runTest` ese timeout corre contra el reloj
**VIRTUAL** — el scheduler salta los 4 minutos en cuanto el test se queda esperando y lo dispara
antes de que el test pueda completar su `finish`. Por eso el mensaje decía «4m of _virtual_ time»:
son exactamente esos 240 000 ms. Arreglo: el worker viejo corre en `Dispatchers.Default`, con lo
que el `withTimeout` usa tiempo real. **No se tocó producción y no se debilitó la prueba del CAS**,
que es lo que el checkpoint exigía conservar.

🔴 **#1 sigue ABIERTO y es el único RED financiero que queda de la lista original.**
`AngelPayPaymentReviewRoomTest > review Room attempt survives VM recreation and empty callback
cannot claim PRE`: espera `ResultadoIncierto` y obtiene `Idle`. Necesita IMPLEMENTACIÓN, no
fixture — el propio checkpoint dice qué falta: «restaurar fase/contexto durable antes del callback
vacío; ausencia de memoria no demuestra preautorización». Vive en `AngelPayPaymentViewModel`
(camino AngelPay/Nexgo), que este bloque NO tocó.

**Siguiente comando** (ya ejecutado; se repite si se toca el módulo):

```bash
JAVA_HOME=$(/usr/libexec/java_home -v 23) AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew \
  -I .../reports/task-2-room-java17.gradle :app:testSandboxDebugUnitTest \
  --tests '*PaymentViewModel*Test' --tests '*BlumonSaleReferenceTest' --tests '*AngelPay*Test' \
  --tests '*PaymentAttempt*Test' --tests '*Ledger*Test' --tests '*ContactlessKernelResultTest' \
  --tests '*RemotePayment*Test' --tests '*SocketManagerTest' --max-workers=1
```

Después: espejo de producción (`:app:testProductionDebugUnitTest` + `compileProductionDebugKotlin`)
y, con Task1 estable, los cinco hallazgos abiertos de Task4.

### ACTUALIZACIÓN 2026-09-09 (bloque 2, Claude) — Task1 #1 AngelPay: SIGUE RED, con diagnóstico medido

🔴 **NO está resuelto.** Se implementó una mejora real y verificada, pero **no cierra el RED**, y
declararlo cerrado sería falso. Lo que sí quedó medido, para que el siguiente no lo repita:

**Defecto de producción confirmado por lectura de código** (`AngelPayPaymentViewModel.kt:1841`): la
degradación de un callback vacío a `Cancelled` se decidía con `!authorizationWasLaunched &&
ledgerOpenedAttemptId == null` — dos `private var` (líneas 500-501) que **NO van al
SavedStateHandle** (allí sólo viajan 3 claves: payment_source, socket_request_id, socket_emitted).
Un ViewModel recreado nace con ambas en su valor inicial aunque Room tenga una fila `AUTORIZANDO`,
y publicaba `PRE_AUTHORIZATION` — «no se cobró» — sobre un cobro que pudo ocurrir. El parser YA
hacía lo correcto (`tx == null && call == null` → `Failure("UNKNOWN")`, con el comentario «missing
or malformed result is not evidence that the processor did not charge»); el ViewModel lo revertía.

**Implementado (queda en el árbol, NO cierra el RED):** `PaymentAttemptDao.findUnresolvedCharge()`
— hermana de `findTerminalHold` pero SIN `PREPARANDO`, porque ahí por construcción nada empezó y
sí prueba que no hubo cobro — y `PaymentAttemptLedger.cobroSinResolver()`, que el ViewModel
consulta antes de degradar. El id recuperado alimenta `markIndeterminate` cuando el VM recreado no
tiene el suyo en memoria.

**Mediciones (tres corridas de diagnóstico con tests temporales, ya retirados):**

| Medido | Resultado |
|---|---|
| Estado de la fila tras `openLedgerAttemptAndMarkAuthorizing` | `AUTORIZANDO` ✅ |
| `dao.findUnresolvedCharge()` desde el test | encuentra `original-attempt` ✅ |
| `ledger.cobroSinResolver()` desde el test | devuelve `original-attempt` ✅ |
| Spy sobre el ledger que recibe el VM recreado | `cobroSinResolver` **se llama** |
| Estado final CON `withContext(Dispatchers.IO)` | `WaitingForResult` — la corrutina **se cuelga** ahí |
| Estado final SIN ese `withContext` | `Idle`, y la fila **sigue en AUTORIZANDO** |

🔑 **Hallazgo colateral ya corregido:** envolver un DAO `suspend` de Room en
`withContext(Dispatchers.IO)` es redundante (Room usa su propio executor) y **aquí era dañino**:
metía un salto de dispatcher del que la corrutina no volvía dentro del test. Retirado.

🔴 **Lo que queda sin explicar, y es exactamente dónde debe empezar el siguiente:** la fila sigue en
`AUTORIZANDO` ⇒ el flujo **no entra** en la rama INCIERTO ⇒ dentro del ViewModel la consulta se
comporta como si diera null, mientras que fuera devuelve el id. **La hipótesis que encaja con TODAS
las mediciones a la vez es que `consumeResultForCurrentAttempt()` (línea ~3492) devuelve `false` y
corta ANTES de la primera asignación de estado** — eso explica `Idle`, la fila intacta y que no se
entre a INCIERTO de una sola vez; el `consulto=SI` del spy sería entonces un artefacto de `spyk`
sobre funciones suspend. **Instrumentar esa función es el siguiente paso, no volver a tocar 1841.**

⚠️ **Efecto secundario que costó una corrida y vale como regla:** `mockk(relaxed = true)` devuelve
un OBJETO para un tipo nullable, no `null` — al añadir `cobroSinResolver()` toda cancelación
legítima pasó a `ResultadoIncierto` y rompió `socket-sourced terminal cancellation emits cancelled`.
Es la misma trampa que el default `false` de los Boolean. Corregido configurando el caso normal
(libreta limpia) en los 3 fixtures de AngelPay.

⚠️ La sincronización del test de recreación se ajustó a `Thread.sleep` + `advanceUntilIdle` (el
patrón que ya usan sus hermanos): `runCurrent()` sólo drena el reloj virtual y no espera trabajo
real de Room. **No se tocó lo que el test EXIGE** (ResultadoIncierto y cero prueba PRE).

### Reembolso contactless — RED ESCRITO, implementación NO empezada

Dos regresiones nuevas en `PaymentViewModelKernelDurabilityTest`, **sin correr todavía**:
`refund offline approval keeps the durable obligation and cannot publish success` y
`refund cannot enter the offline capable kernel while another attempt holds the terminal`.
El hueco está confirmado por lectura: `processContactlessRefund` entra al kernel sin
`markKernelEntered` y su rama `RESULT_OFFLINE_APPROVED` **no llama a `markHostResponded` en
absoluto** — peor que la venta, y su registro NO tiene cola offline (lo dice su propio comentario).

### ACTUALIZACIÓN 2026-09-09 (bloque 3, Claude) — reembolso CERRADO · AngelPay #1 abierto con causa acotada

🟢 **REEMBOLSO CONTACTLESS: GREEN.** `run-avoqado-tpv.epCPky` — **50 tests / 0 fallos** en las 7
suites del ledger + durabilidad, `compileSandboxDebugKotlin` SIN sufijo y timestamps del momento.
Los dos RED escritos en el bloque anterior pasaron de rojo a verde; sus mensajes de rojo previos
fueron `StartCtlssTransUseCase.run should not be called` (pero se llamaba) y
`Success(authCode=OFFLINE_APPROVED, amount=50.00)` con la escritura caída.

**Lo implementado, en sandbox Y production** (`processContactlessRefund`):

- **`markKernelEntered` como guardián de entrada**, y resuelve los DOS casos con una sola pieza: si
  no hay fila —porque otro intento tiene la terminal— el CAS falla y el kernel no corre.
- **`markHostResponded` antes de publicar `Success`**; si la escritura no queda, la pantalla dice
  «Cobrado. Sincronización pendiente» en vez de éxito.
- **Liberación acotada** en la rama del kernel rechazado, reusando `KERNEL_REFUSALS_WITHOUT_CHARGE`;
  `TIMEOUT`/desconocido se retienen como INDETERMINADO.
- 🔴 **Cambia a propósito la política del comentario viejo de `startRefund`** («un fallo de la
  libreta nunca bloquea el reembolso»): eso vale para telemetría, no para entrar a una llamada
  capaz de mover dinero que después no se podría anotar — y el registro del reembolso, a
  diferencia del cobro, NO tiene cola offline.

### 🔴 AngelPay #1 — CORRECCIÓN de lo que este checkpoint afirmaba, y causa acotada

**Retiro una afirmación del bloque anterior.** Escribí que el `withContext(Dispatchers.IO)` «era
dañino: metía un salto de dispatcher del que la corrutina no volvía». **Eso NO está demostrado**:
lo único observado fue que al quitarlo cambió el síntoma del test (`WaitingForResult` → `Idle`).
Cambiar el síntoma no prueba el mecanismo, y además en esa comparación moví DOS variables a la vez
(el envoltorio y un spy). El comentario del código ya está corregido para marcarlo como hipótesis.

**COMPROBADO (medido, con el test):**

| Hecho | Evidencia |
|---|---|
| La fila queda en `AUTORIZANDO` | `estado=AUTORIZANDO` |
| `findUnresolvedCharge()` y `cobroSinResolver()` devuelven el id | `encontrada=original-attempt viaLedger=original-attempt` |
| El scope del ViewModel recreado está VIVO antes y después | `scopeAntes=true scopeDespues=true` |
| Tras `runCurrent()` **y** `advanceUntilIdle()`, el estado sigue en `Idle` | `trasRunCurrent=Idle` |
| La fila NO se marca | `fila=AUTORIZANDO` — la rama INCIERTO nunca corre |
| Una traza que observa el StateFlow sale **vacía** | `estados por los que pasó: []` |

🔴 **Conclusión demostrada, y es la que importa: este test NO llega a ejecutar la corrutina del
ViewModel recreado.** El estado permanece en su valor inicial con el scope vivo, y `resetPayment()`
—el ÚNICO sitio que pone `Idle` (línea 3484)— no se llama desde ningún camino automático
(`retryAfterError`, línea 3293, es una acción de usuario). **Por tanto su rojo NO es evidencia
sobre el código de producción: el camino no se ejercita.**

**HIPÓTESIS, no comprobadas** (para quien siga, en este orden):
1. El `init{}` del ViewModel construido con un `SavedStateHandle` que ya trae `socket_request_id`
   consume o desvía el resultado antes de que `onAngelPayResult` progrese. Su hermano que SÍ pasa
   (`review parsed contradictory issuer…`) usa `createViewModel()` **sin** handle restaurado — ésa
   es la diferencia a atacar primero.
2. `consumeResultForCurrentAttempt` (línea ~3492) devolviendo `false`. Sigue siendo la única salida
   anterior a la primera asignación de estado, pero NO se ha instrumentado.

**El defecto de PRODUCCIÓN sí está identificado por lectura de código y no depende de este test:**
`AngelPayPaymentViewModel.kt:1841` decidía con `authorizationWasLaunched` y `ledgerOpenedAttemptId`,
dos `private var` (500-501) que NO viajan en el `SavedStateHandle` (allí sólo van 3 claves). La
consulta durable (`cobroSinResolver`) está implementada y verificada de forma aislada, **pero sin
una prueba que demuestre que cierra el hueco**. No se declara cerrado.

**Sincronización del test: determinista, sin debilitarlo.** Se retiró el `Thread.sleep` y los
executors de Room de ese test corren en línea (`setQueryExecutor { it.run() }`), así que drenar el
scheduler basta. Lo que el test EXIGE no se tocó: sigue pidiendo `ResultadoIncierto` y cero prueba
`PRE_AUTHORIZATION`.

**Cambios parciales revisados** (los tres siguen en el árbol, ninguno commiteado): la consulta del
ledger + DAO; el guard de 1841; y `coEvery { cobroSinResolver() } returns null` en los 3 fixtures de
AngelPay — ⚠️ necesario porque `mockk(relaxed = true)` devuelve un OBJETO para un tipo nullable, no
`null`, y sin configurarlo toda cancelación legítima pasaba a `ResultadoIncierto` (rompió
`socket-sourced terminal cancellation emits cancelled`). Misma familia que el default `false` de
los Boolean.

⬜ **Pendiente de este bloque: servidor (Task4, 5 hallazgos) y outbox (Task5).** No empezados.
⬜ Auditoría independiente de Codex y pruebas físicas PAX + Nexgo: no hechas. **El circuito
completo NO está validado** — pasar una selección de tests no lo demuestra.

### ACTUALIZACIÓN 2026-09-09 (bloque 4, Claude) — Task4 servidor: 4 de 5 hallazgos CERRADOS

TDD en los cuatro: RED escrito y observado ANTES de tocar producción, GREEN después.
Última corrida: **88 tests / 0 fallos** en las 2 suites de terminal-payment + 2 del registry.

| # | Hallazgo | Estado | RED observado |
|---|---|---|---|
| 1 | P1 socket desplazado hereda identidad verificada | 🟢 **cerrado** | `sock-U` devolvía la entrada de `sock-S` con `identityVerified: true` |
| 2 | P1 la recuperación se salta la atribución física | 🟢 **cerrado** | `summary.completed` esperado 0, recibido **1** con un cobro de otra terminal |
| 3 | P1 socket perdido responde 400 definitivo | 🟢 **cerrado** | `Received promise rejected instead of resolved` |
| 5 | P2 el picker anuncia libre una terminal reservada | 🟢 **cerrado** | `Expected path: not "venueId" / Received: "venue-nuevo"` |
| 4 | P2 sobre `CONTRACT_MISMATCH` en recuperación-primero | 🔴 **ABIERTO** | no empezado |

**#1** (`terminal-registry.ts`): la limpieza del mapping inverso exigía un `socketId` nuevo no
nulo, así que un heartbeat HTTP que cambia de venue lo dejaba vivo; cuando después llegaba un
socket FIRMADO, el viejo seguía resolviendo a esa entrada. Dos piezas: el inverso muere con el
socket que lo creó (calculado sobre `effectiveSocketId`, que cubre también quedarse sin socket), y
`getTerminalBySocketId` exige que la entrada devuelta **pertenezca** al socket que pregunta.

**#2** (`findReconcilablePayment`): el camino del socket ya exigía `source === 'TPV'` y serial
físico coincidente, pero esa comprobación está condicionada a `source === 'SOCKET'` y la
recuperación entra como `'REST'`. Se aplica ahora la MISMA atribución al elegir el Payment; el
Payment no se toca, sólo se le niega cerrar ESA petición.

**#3** (`sendPaymentToTerminal`): el `BadRequestError` salía como HTTP 400 — «rechazado» para un POS
publicado, que es permiso para volver a pasar la tarjeta. Ahora resuelve con el MISMO desenlace
canónico incierto del ACK perdido (`status:'timeout'`, 504), **después** de que `failUndelivered`
deje la fila en UNKNOWN.

**#5** (`getBusyTerminalIds`): la agregación filtraba por venue, así que una terminal movida de
sucursal con una reserva viva se anunciaba libre. La reserva es FÍSICA; se agrega sin filtro de
venue y se sigue devolviendo SÓLO el conjunto de ocupados (ningún dato ajeno cruza).

⚠️ **10 fixtures actualizados, y la razón importa:** devolvían `{ id: 'pay-1' }` — un Payment sin
`source` ni `terminal`, que no existe en la realidad. Por eso no podían ejercitar la atribución
física. Ahora representan un cobro completo. **No se relajó ninguna aserción**; el test que guarda
el camino feliz (`un pago con TARJETA y COMPLETED sí la cierra`) sigue exigiendo que cierre.

⚠️ Un test existente cambió de contrato a propósito: `post-reservation socket loss never claims no
authorization started` esperaba `rejects.toThrow()` (cualquier error). Ahora exige el desenlace
canónico `status:'timeout'`. Es MÁS estricto, no menos: antes admitía cualquier excepción,
incluida la que producía el 400 que el hallazgo denuncia.

**Typecheck: `alien: exit=0`, `errores TS: 0`** (corrió sólo en el Alienware, como manda el
periodo de prueba para este repo).

🔴 **Suite amplia del servidor: 1271 tests, 63 fallos — SIN atribuir todavía, y NO se declaran
ajenos sin prueba.** Lo que SÍ está comprobado: ninguna de las suites que este bloque tocó aparece
entre los fallos (`grep` sobre la salida: 0 menciones de `terminal-payment`, `terminalRegistry` o
`identidadDesplazada`), y esas mismas suites dan **88/88 en verde** corridas aisladas. Al menos una
de las 10 suites rojas es `liveDemo.simFastPayment.service.test.ts`, ajena a este trabajo. La
salida de avq-verify llega recortada y no permitió enumerar las otras nueve.
**Siguiente paso obligado antes de cualquier cierre:** enumerar esas 10 suites y decidir una por
una si son preexistentes (el propio checkpoint ya advertía que las correcciones parciales de Task5
no las cubre ninguna corrida) o consecuencia de algo de este bloque.

```bash
cd avoqado-server && npx jest --selectProjects unit --testPathPattern "terminal|socket|payment" --ci 2>&1 | grep -E "^(FAIL|PASS)"
```

⬜ **Pendientes de servidor:** hallazgo #4, los 63 fallos por atribuir, y la suite de INTEGRACIÓN
con Postgres real (no corrida). **Task5 (outbox) sigue sin empezar.** Auditoría de Codex y pruebas
físicas PAX + Nexgo: no hechas. **El circuito completo NO está validado.**

### Task2: inbox, ACK, cancelación TPV — revisión enfocada limpia

Archivos core/remotepayment, SocketManager, AppNavigation, HomeViewModel y pruebas Room/coordinador. [Revisión](./reports/task-2-rereview.md) sin nuevo hallazgo accionable en su alcance; pruebas de Room persistencia/CAS incluidas en corridas TPV posteriores. No es aprobación de hardware ni del circuito completo. Preservar precedencia de aprobación y cancelDisposition; no convertir rechazo a cancelar en failed financiero. Task1 añadió evidencia PRE solo a CAS ganador RECEIVED; cambios posteriores aún deben comprobarse integrados.

### Task3: Android POS e iOS — revisión enfocada limpia

Persistencia del request incierto, rechazo de continuaciones antiguas, recuperación GET compartida y resultado consumidor `alreadyRecovered` interno, sin cambio incompatible del wire. Android `Ks1kS6` 113/113; iOS `ZBYhXt` 61/61. [Revisión final enfocada](./reports/task-3-rereview3.md) cerró el P2 restante sin regresión encontrada. No repetir los tres ciclos previos. QA físico aún pendiente.

### Task4: relay servidor — CINCO HALLAZGOS ABIERTOS

Últimas pruebas `b78ERW`: 126/126, 4 suites, Postgres real local. **La auditoría posterior encontró huecos no cubiertos; GREEN no significa terminado.** Leer [task-4-rereview1.md](./reports/task-4-rereview1.md). Es el resultado FINAL de la revisión que primero se interrumpió por créditos y después sí terminó.

1. P1 mapping inverso de socket viejo puede heredar identidad verificada del reemplazo tras heartbeat con cambio de venue. Borrar reverse mappings desplazados aun con socket null y comprobar igualdad socketId al resolver emisor.
2. P1 reconciliación automática/manual omite validación física/source que sí aplica socket: Payment exact-tag de otra terminal puede cerrar solicitud en siguiente sweep.
3. P1 pérdida del socket capturado conserva UNKNOWN en DB pero devuelve HTTP400 definitivo; debe devolver respuesta canónica incierta compatible con APK publicados.
4. P2 recuperación-first completa sin generar envelope CONTRACT_MISMATCH; early return COMPLETED impide construirlo después.
5. P2 picker filtra reservas por venue actual, muestra disponible terminal movida que sigue físicamente retenida por venue anterior. Agregar por candidatos ya autorizados sin filtrar reserva por venue, devolviendo solo busy y sin datos ajenos.

Todavía NO hay RED específico ni correcciones para estos cinco hallazgos. Escribir regresiones focalizadas primero. No reauditar los otros cuatro hallazgos iniciales ya cerrados. Rutas: terminal-payment.service.ts, terminal-registry.ts, observability.controller.ts/handlers relacionados; revisar contratos reales antes de editar.

### Task5: outbox y efectos — IMPLEMENTACIÓN PARCIAL SIN VERIFICAR

Original: PaymentEffect transaccional, SKIP LOCKED, batch25, lease120s, 6 intentos al reclamar, CAS, errores sanitizados. Obligaciones REVIEW/RECEIPT/REFERRAL/COMMISSION con dinero; orden/saldo/posting inventario y recibo mínimo legacy sin salir del camino necesario. Lealtad usa reconciliador existente, sin segundo bucle. ActivityLog fuera de TX. Timers por paso fuera de TX.

`dpgwaJ`: outbox15, boundary7 (incluido card/stock), timezone2, jobs y lealtad GREEN. Nuevas review9: siete RED válidos y dos controles GREEN (error real SELECT1/0 con savepoint, revocación de recompensa ya entregada).

Cinco problemas aceptados: comisión pendiente frente a reembolso; referido pendiente frente a reembolso total; planes anteriores del mismo pago invisibles para meta; productores legacy ignorando progreso TPV pendiente; lectura de metas carga agregados de reportes dentro de TX. [Plan concreto](./reports/task-5-round1-fix-plan.md).

**ATENCIÓN: el reporte Task5 quedó desactualizado por agotamiento de créditos. Aunque diga “sin cambios”, SÍ hay correcciones parciales posteriores a dpgwaJ.** Inspección del checkpoint encuentra:

- refund.tpv.service.ts importa/llama enqueueRefundPaymentEffectsInTx dentro del commit.
- paymentEffects.service.ts ya define ese productor y llama createRefundCommission con db/sink.
- commission-calculation.service.ts modificó firma/cálculo de reembolso y productores.
- Cambios en referralQualification/referralRefund y NUEVO referralReversalPolicy.service.ts.
- Posibles otros cambios en tier/goal helpers; comparar código con plan, no reconstruirlos a ciegas ni descartarlos.

**NINGUNA corrida cubre estas correcciones parciales; puede no compilar.** Próximo LLM debe revisar primero coherencia de firmas, exports, lock ordering y si handler REFUND realmente ejecuta reversión con errores propagados antes de DONE. No reportar siete RED como resueltos. Dashboard-linked refunds, split y manual-review/failure adicionales requieren sus propios tests antes de ampliar esos caminos.

Root observabilidad: paymentEffectsRead.service.ts + customer MCP tools/paymentEffects.ts/registro en src/mcp/server.ts. Read5+MCP2 GREEN en dpgwaJ: clamp100, cursor estable aunque cambia status, filtros y total, tenant/permission, no payload/token. Sin hallazgos abiertos específicos; typecheck global pendiente.

## Comandos siguientes, ejecución serial y local

Desde `/Users/amieva/Documents/Programming/Avoqado`. NO `npm test`/tsc/Gradle directos. avq-verify para todo pesado. No confiar en que su cola evita todo solapamiento: coordinador inicia uno y espera fin antes del siguiente.

Primer RED TPV pendiente (copiar init script conservado, no reconstruirlo):

```bash
JAVA_HOME=$(/usr/libexec/java_home -v 23) AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew -I /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-checkpoint-2026-09-09/reports/task-2-room-java17.gradle :app:testSandboxDebugUnitTest --tests '*PaymentViewModelKernelDurabilityTest' --tests '*PaymentAttemptRoomTest' --max-workers=1
```

Después corregir Task1 o Task4 por bloques con pruebas focalizadas; revisar Task5 parcial antes de sus GREEN. PostgreSQL usa SOLO `codex_testarudo_test_20260909` local. Credencial se obtiene de `.env` sin imprimirla, validar hostname localhost/127.0.0.1 y reemplazar pathname; pasar TEST_DATABASE_URL al proceso avq. Preparador conservado en lab-harness/prepare-owned-pg.cjs.

**Trampa de routing:** usar `--selectProjects integration unit` (integration PRIMERO). `unit integration` no coincide con detector de avq y una corrida se fue remota sin /tmp: 8bG5zj fue INCONCLUSO, no RED. Generar Prisma EN LA MISMA corrida antes de Jest para evitar cliente compartido obsoleto. La salida debe decir LOCAL/necesita Postgres. No reset/migrate de la base compartida.

Suites PG focalizadas:

- Task4: tests/integration/payments/terminalPaymentRecovery.integration.test.ts + unit/services/terminal-payment{.service,.autoRelease}.test.ts + unit/communication/sockets/terminalPayment.registrationProof.test.ts.
- Task5: tests/integration/payments/paymentEffects{Review,Outbox,Boundary,Timezone}.integration.test.ts + unit/jobs/{payment-effects,loyalty-reconciliation}.job.test.ts.
- Root read/MCP: tests/integration/payments/paymentEffectsRead.integration.test.ts + tests/unit/mcp-customer/payment-effects.test.ts.

Typecheck pendiente: `./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.typecheck.json`. Suite del módulo existente de payment/posting/receipt/commission/refund/referral también pendiente. No decir que typecheck ni suite completa han pasado.

Al estabilizar TPV, repetir módulo financiero/relay (último filtro421): `--tests '*PaymentViewModel*Test' --tests '*BlumonSaleReferenceTest' --tests '*AngelPay*Test' --tests '*PaymentAttempt*Test' --tests '*Ledger*Recovery*Test' --tests '*LedgerSweepLogicTest' --tests '*RemotePayment*Test'`. `SocketManagerTest` también debe incluirse al validar el módulo socket.

Variantes correctas: PAX sandbox `:app:assembleSandboxDebug`; Nexgo QA `:app:assembleNexgoDebug`; espejo PAX producción `:app:testProductionDebugUnitTest` filtros PaymentViewModel/BlumonSaleReference y `:app:compileProductionDebugKotlin`. Todo por avq, max-workers1, JAVA_HOME23 + init Room Java17. No existe nexgoSandbox. Ninguna de estas builds finales se ha verificado/instalado.

## DB, rendimiento y hardware

Migraciones NUEVAS aplicadas únicamente al testDB propio: 20260909181000 cancelDisposition, 20260909210000 PaymentEffect, 20260909213000 recovery indexes, 20260909220000 effect lookup indexes, 20260909223000 payment attribution/cursor. Schema map regenerado 366 modelos/346 enums; no desplegadas.

Benchmark `y3nZ7r` terminado: 100k filas por tabla en TX revertida, consultas puntuales <1ms, total10.056ms/claim-selection12.953ms. [Informe](../testarudo-2026-09-09-query-plans.md) y JSON completo junto a él. No repetir benchmark sin cambio de consulta/índice que lo justifique. Dos primeros intentos fallidos eran el GENERADOR, corregido con LATERAL; no lentitud de producto. Confirmado cero organizaciones sintéticas después de rollback.

**Laboratorio nuevo creado pero NO iniciado:** DB `codex_testarudo_lab_20260909`, clon del testDB propio, marcador de propiedad. No seed/login completo, proxy ni bootstrap corriendo. lab-harness conserva scripts no secretos; launcher tiene rutas scratch /tmp, revisar/restaurar ubicación antes de usar. Guardia Node permite solo TCP loopback, 4 tests de instrumento GREEN; no equivale a aislamiento completo auditado de todos los SDK/dependencias. Bootstrap usa app+Socket.IO, evita server.ts y jobs de negocio, secretos nuevos, evita cargar .env del repo. Aún no probado en runtime.

No iniciar server.ts normal: activa jobs/integraciones; DEMO_MODE deshabilita Socket.IO y no es launcher seguro. No tocar el backend ajeno de puerto3000. No copiar credenciales de producción. Fuente local tiene cuentas QA/SANDBOX; copiar sólo configuración necesaria tras validar ambientes, nunca imprimir PIN/tokens. Script setup-avoqado-demo-tpv-sandbox.ts apunta BACKEND PRODUCCIÓN; NO usar como seed del laboratorio.

Dispositivos:

- Nexgo USB ADB `N86`, serial real `N860W173397`, paquete sandbox 105/2.9.1. PAX wireless A910S serial2841548417, sandbox104/2.8.7, actualmente desapareció de ADB. Usuario ya recibió pregunta por IP:puerto actual; pendiente. Otra OrderPAD en192.168.1.122 NO asumir que está autorizada para esta tarea.
- Se configuró mantener despierta Nexgo USB/AC, quitó wait-debug-app PAX; ambas con no-destruir-actividades desactivado/límite estándar. No necesitas pedir más ajustes rutinarios al usuario.
- TPV `-Pavoqado.devBaseUrl` afecta REST solamente; socket dev sigue ngrok. Hay que corregir/verificar configuración coherente antes de prueba Android→TPV. QA flavor inicializa explícitamente AngelPay QA; además comprobar afiliación efectiva de sesión y APK instalado. El sufijo sandbox no prueba por sí solo backend/afiliación.
- Ningún APK con estos fixes fue instalado, ningún nuevo cobro físico se ejecutó en esta fase. Pruebas previas viejas: cinco cobros sandbox $50.11, Pago rápido, NO validan nuevo código ni relay desde Android.

## Revisión que debe hacer el siguiente LLM

No validar a Codex por sus afirmaciones. Comparar snapshot/hashes y pruebas con cada invariante:

1. Una sola entrada a autorización, incluyendo kernel offline; intento/contexto guardados ANTES; errores de disco/callback vacío no generan falsa cancelación.
2. Incertidumbre sobrevive cierre/recreación, otra venta/terminal no elude protección; solo evidencia admitida libera.
3. Recuperación nunca autoriza: misma identidad, afiliación, vendedor, monto, tip; leases y CAS reales.
4. Identidad socket no se hereda por mapping viejo; recovery no evita atribución física/tenant/mismatch.
5. Pago, saldo/PAID, inventario y obligaciones outbox nacen coherentes; recibo legacy útil; refund y deferred effects cuadran con entrega duplicada/caída.
6. Pruebas reales de DB, no solo mocks de transacción; hardware sandbox desde Android con cortes/red/DNS/servidor lento y reinicio, comparando SDK/Payment/orden/recibo/efectos.

No hacer auditoría completa otra vez antes de arreglar los hallazgos listados. Al cierre sí requiere auditor independiente Codex (o dejar explícito bloqueo si créditos no permiten), build/typecheck/suites apropiados y evidencia física. Ninguno está sustituido por este checkpoint.
