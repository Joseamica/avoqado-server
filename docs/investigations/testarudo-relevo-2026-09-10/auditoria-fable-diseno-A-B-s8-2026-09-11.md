# Auditoría del diseño A/B/§8/Nexgo — Fable 5.1 (11-sep-2026, complementa la parcial de Codex)

Diseño auditado: `diseno-A-B-seccion8-2026-09-11.md`. Codex (gpt-6-astra, xhigh) murió a los 10 min sin créditos
tras 5 mensajes (`codex-auditoria-diseno-A-B-s8-RESULTADO-parcial.md`); esta pasada la hizo Fable 5.1 con cinco
lectores de sólo lectura (servidor A/B/contrato · TPV bandeja/libreta/Blumon · Nexgo · POS Android/iOS · rutas que
cancelan órdenes) y verificación propia de cada P1. Árboles de trabajo, no HEAD, salvo donde se dice «HEAD».
Nada se editó fuera de este archivo.

## VEREDICTO: RECHAZADO en su forma actual — 6 P1, 14 P2, 8 P3

No por A en sí (la identidad de bandeja es sólida en lo esencial) sino por cinco decisiones periféricas que dejan
abierta la ejecución de una solicitud YA liberada, y por una regla de A que se dispara sola en la primera
reconexión. Con los seis P1 aplicados pasa a APROBADO CON CAMBIOS. Los P2 pueden entrar en la implementación.

Condición de dinero (no se toca): nunca doble ni perdido; timeout, cancel, desconexión o ausencia de Payment NO
prueban ausencia de cargo.

---

## P1 — dinero, o terminal bloqueada sin salida

### P1-1 · C.3 + G7: el 404 «no se creó» sin lápida deja pasar la segunda copia del mismo POST
- **Escenario.** Tablet manda `POST /terminal-payment` con `requestId` R. OkHttp reintenta solo en fallo de
  conexión (`avoqado-android/.../core/di/NetworkModule.kt:60-72` no fija `retryOnConnectionFailure(false)`; iOS sin
  reintento propio pero con el mismo `requestId` en el cuerpo). Copia A llega con la PAX en Doze: C.3 busca la fila
  (no existe) → mira el registro (no conectada) → **404 `TERMINAL_NOT_CONNECTED` con `details.requestId`**. La tablet,
  que confía en ese código, suelta la llave durable (hoy ya suelta en cualquier 4xx no transitorio:
  `TerminalPaymentService.kt:359`, `.swift:433`). Copia B llega 200 ms después con la PAX recién reconectada: no hay
  fila → registro OK → candado → `create` (`terminal-payment.service.ts:599`) → emit → la PAX cobra. La tablet cree
  que R nunca existió; si vuelve a cobrar, doble.
- **Por qué el diseño no lo cubre.** Hoy el registro se comprueba FUERA del candado y ANTES de la búsqueda
  (`terminal-payment.service.ts:497-508` vs `:530-531`); C.3 invierte el orden pero deja el 404 fuera del candado y
  G7 prohíbe escribir nada antes de crear la fila. Es exactamente el pendiente #1 de la regla del circuito
  («nunca se envió» exige evidencia de TODAS las copias).
- **Cambio.** El 404 que afirme «no se creó» se emite DENTRO del `pg_advisory_xact_lock` y deja una fila lápida
  para R: `FAILED`, `failureCode='TERMINAL_NOT_CONNECTED'`, `outcomeEvidence='NEVER_DELIVERED'`,
  `deliveryProvenance={deliveries:[]}`. La copia B encuentra la fila y recibe la réplica FAILED; nunca crea ni
  ejecuta. G7 se acota: «sin lápida de CANCEL antes de crear la fila» sigue; la lápida de ADMISIÓN es obligatoria.
  El POS sólo suelta la llave con `code` + `details.requestId` correlacionado (patrón T15), nunca con un 404 pelón.

### P1-2 · C.1/D/C.5: Nexgo emite `failed + PROCESSOR_DECLINED` (final) y conserva «Reintentar» con el MISMO `requestId`
- **Evidencia.** `AngelPayPaymentViewModel.kt` (árbol, en edición por T26; líneas al cierre de esta pasada):
  `Failure` no recuperable ⇒ `Error(canRetry=true)` + emit `failed` con `PROCESSOR_DECLINED`/`PRE_AUTHORIZATION`
  (`:2030-2032`, `:1942-1953` antes de T26); el tag `_socketRequestId` SOBREVIVE al emit a propósito (`:471-476`
  / `:3486-3492`); `retryAfterError` (`:3448-3476`) bloquea sólo `solicitudCerradaAntesDeAutorizar && SOCKET`
  (la guarda nueva de T26 cubre `PRE_AUTHORIZATION`) y con `confirmedNegativeOutcome=true` deja pasar el reintento
  con `attemptId` nuevo y el MISMO `_socketRequestId`; `emitSocketResultIfSocketSourced` (`:3494-3522`) no emite un
  segundo resultado. Servidor: un `Payment` con el id liberado se concilia con 🚨 «Payment recorded for a RELEASED
  request — check the order for a double charge» (`terminal-payment.service.ts:1733-1736`).
- **Escenario.** Banco rechaza → servidor: NOT_CHARGED (evidencia TERMINAL), fila FAILED, terminal libre, tablet
  «no se cobró» y suelta la llave → el cajero toca «Reintentar» en la N86 → aprobada → `Payment` con el id liberado.
  Si la tablet ya volvió a cobrar (nueva solicitud o «Tarjeta (otra terminal)»), doble. El servidor sólo lo sabe
  cuando llega el registro del `Payment`, no por el socket.
- **Cambio.** (a) TPV: tras emitir un desenlace FINAL de un cobro con origen SOCKET, el reintento queda bloqueado
  («el POS decide: vuelve a mandarlo») o produce un `requestId` NUEVO correlacionado con el viejo; nunca reusa el
  liberado. (b) C.1: `PROCESSOR_DECLINED` cuenta como NOT_CHARGED sólo si la terminal declara que no puede
  reautorizar ese id (campo `final:true` en el resultado, versión de capacidad nueva); sin él ⇒ UNRESOLVED. (c)
  Blumon NO tiene este defecto: un rechazo reintentable no se emite (`PaymentViewModel.kt:1457-1460`, la fila queda
  en vuelo y la tablet espera 5 min: P3-5).

### P1-3 · B.1 `DEVICE_DECOMMISSIONED`: el ACK del FACTORY_RESET sale ANTES de borrar y el servidor no tiene con qué probarlo
- **Evidencia.** TPV `features/remote_command/domain/CommandExecutor.kt:1055` acusa «Factory reset completed» antes
  de `secureStorage.clearAll()`, del `deleteDatabase` (`:1070-1078`, `try/catch` que se traga «Could not delete …
  (will be cleared on app restart)», y el reinicio NO borra bases) y del `killProcess` (`:1090`). Servidor: no existe
  `TerminalCommand`; el comando queda `SENT` en `TpvCommandQueue` y la «prueba de borrado» es `deviceReboundAfter`
  (`terminals.superadmin.service.ts:85-101`: re-vinculación por `activation-status` posterior al comando), que
  tampoco prueba que la base se borró.
- **Escenario.** Entrega a X (RECEIVED, ACK perdido) → FACTORY_RESET → Room tiene la conexión abierta (WAL) →
  `deleteDatabase` falla en silencio → bandeja y espejo sobreviven → al reactivar, A.3 ve «S y M, mismo id» ⇒
  Continúa → la fila se reclama y cobra. B ya la liberó por `DEVICE_DECOMMISSIONED`.
- **Cambio.** `DEVICE_DECOMMISSIONED` exige que el servidor haya observado, DESPUÉS del comando, un handshake del
  mismo serial con identidad de bandeja DISTINTA (X ⇒ SUPERSEDED) o sin identidad; ni el ACK ni `deviceReboundAfter`
  bastan. TPV: escribir un marcador «reset solicitado» en `noBackupFilesDir` ANTES del ACK (A.3 lo trata como
  Rotar), cerrar Room antes de `deleteDatabase`, y borrar también el espejo.

### P1-4 · A.4/A.5: el contador «congelado» en las reconexiones dispara `COUNTER_REGRESSION` y descontinúa la bandeja para siempre
- **Evidencia.** `SocketManager.kt:203-232`: el mapa `auth` del handshake se construye UNA vez por `connect()` y
  socket.io lo reenvía tal cual en cada reconexión automática (lector TPV §4). A.4 lo asume («queda congelado…
  cota inferior»), pero A.5 manda «identidad ACTIVE con contador < `maxCounterObserved` ⇒ DISCONTINUED
  (COUNTER_REGRESSION), 🚨, socket no confiable» y A.10 fija que el HANDSHAKE dispara esa regla («Copia antigua,
  mismo id»). `maxCounterObserved` sube con cada ACK y sonda.
- **Escenario.** Arranque con contador c → handshake c → entrega, ACK con c+3 ⇒ marca c+3 → Doze corta el socket
  (la PAX de Testarudo lo hace decenas de veces al día) → reconexión automática con el `auth` viejo: c < c+3 ⇒
  COUNTER_REGRESSION ⇒ DISCONTINUED «nunca se reactiva» ⇒ toda solicitud en vuelo o futura de esa terminal queda
  sin A y sin replay (A.9) hasta B. El primer día, en todas las terminales.
- **Cambio.** El handshake lee el contador ACTUAL del centinela en cada `connect`/`reconnect_attempt` (socket.io
  permite mutar `auth` antes de reconectar), o la regla de regresión se evalúa sólo contra la marca del ÚLTIMO
  HANDSHAKE (no contra ACK/sonda). Y `DISCONTINUED(COUNTER_REGRESSION)` se revierte a ACTIVE si un handshake
  posterior trae contador ≥ su propia marca (una copia restaurada nunca lo consigue: su contador es menor).

### P1-5 · B.1 `LEGACY_NO_RESUME` sobre filas de procedencia desconocida entregadas a una bandeja durable (Nexgo 2.9.x)
- **Evidencia.** `RemotePaymentInbox.receive` persiste RECEIVED antes del ACK (`RemotePaymentInbox.kt:44-82`) y el
  coordinador reclama al arrancar tras `awaitInitialization()` SIN comprobar edad ni vigencia
  (`RemotePaymentCoordinator.kt:114-132`; regla del circuito, «Espera de inicialización»). Producción: las Nexgo
  llevan 2.9.1 (relevo §2-ter) — con bandeja — y 53 + 12 de las 375 filas históricas son suyas.
- **Escenario.** Lote B libera una fila RECEIVED de la N86 con base «legacy/desconocida + la app se reinició»;
  la app arranca, reclama la fila y cobra. Un reinicio no impide reanudar en 2.9.x: sólo lo impide en 2.8.7 (sin
  bandeja).
- **Cambio.** `LEGACY_NO_RESUME` sólo para terminales cuyo APK al momento de la entrega NO tenía bandeja
  (2.8.x, por `Terminal.appVersion` histórico o por fecha de instalación); para 2.9.x se resuelve con la SONDA tras
  instalar el APK del árbol conservando Room (RESOLVED/ACTIVE/NOT_FOUND con lápida) y, si contesta ACTIVE, con
  `DEVICE_INSPECTED` + portal, nunca en lote ciego.

### P1-6 · F: el orden «APK primero» no es seguro con flota MIXTA ni con filas en vuelo en el momento de instalar
- **Evidencia.** (a) Servidor del árbol con una terminal 2.8.7/2.9.2 todavía en el venue ⇒ el primer rechazo del
  banco o cancel deja UNKNOWN sin sonda ni salida (P1-1 de la auditoría del 10-sep, relevo). (b) HEAD reproduce al
  reconectar toda fila en vuelo con `expiresAt > now` según las capacidades del socket ACTUAL
  (`git show HEAD:src/services/terminal-payment.service.ts` `:578-583`, sin procedencia) ⇒ al instalar el APK nuevo
  sobre una PAX 2.8.7 con una fila SENT viva, HEAD la reentrega a una bandeja que no la tiene ⇒ ejecución doble.
  (c) HEAD ignora los campos nuevos del handshake y del resultado (`socketManager.ts:197` sólo lee
  `terminalPaymentAckVersion`): ese lado sí es seguro.
- **Cambio.** F.2 con dos compuertas: el servidor se despliega sólo cuando el 100 % de las terminales ACTIVAS de
  cada venue reportan la versión nueva (`Terminal.appVersion`; o semántica por capacidad en el servidor, plan D de
  Codex); y cada APK se instala con esa terminal SIN filas en vuelo ni UNKNOWN (consulta previa por `terminalId`).
  El POS del árbol NO puede salir antes que el servidor (con HEAD nunca ve `CANCELLED+ACCEPTED` ni `outcome`, así
  que su cancelación durable no cierra jamás): iOS con `releaseType=MANUAL`.

---

## P2

- **P2-1 · §0/A.2/B.1 · La premisa «downgrade sin fallbackToDestructiveMigration» es FALSA.**
  `DatabaseModule.kt:162` `.fallbackToDestructiveMigrationOnDowngrade()` (+ `:145`). A sobrevive (tira la centinela ⇒
  «M sin S» ⇒ Rotar) pero el §0 debe corregirse y `INSTALL_VERSION` a versión menor tratarse como evento destructivo
  (rota identidad, borra libreta y colas); `DEVICE_INSPECTED` no puede mirar una bandeja que ya no existe.
- **P2-2 · A.5/A.9 · «Nunca se reactiva» + dos variantes en el mismo serial.** `build.gradle.kts:67,96-124,236-244`:
  `production` y `sandbox` conviven con paquetes y bases distintas ⇒ identidades X e Y que se turnan ⇒ tras X→Y→X,
  X queda SUPERSEDED para siempre: sus entregas no se liberan por A ni se reentregan. Cambio: reactivar si el
  contador ≥ su propia marca; y NO admitir cobros en un socket no confiable (código pre-fila + lápida, P1-1) en vez
  de entregarle con `inboxTrusted=false`.
- **P2-3 · A.3 · Las filas en cuarentena (`RECEIVED_PRE_ROTATION`) no tienen salida.** Contestan ACTIVE para
  siempre; B exige «cerrado» (`DEVICE_INSPECTED`) o respuesta no ACTIVE. Cambio: base explícita en B para
  cuarentenadas = inspección + portal sin operación en la ventana + la app ya no puede reclamarlas (están fuera del
  claim por diseño).
- **P2-4 · B.1 `TERMINAL_FINAL_ANSWER` acepta respuestas que no prueban nada.** Un NOT_FOUND de OTRA identidad
  (Y) no dice nada de X (por eso A lo rechaza) y un RESOLVED-`success` sin Payment es contradicción clase C, no
  «no se cobró». Cambio: sólo RESOLVED con `failed/cancelled` + evidencia, o RECEIVED_CANCELLED; nunca NOT_FOUND ni
  RESOLVED-success. Además hoy no existe `lastProbe*` en la fila (`unaccreditedProbeAnswers` vive en memoria,
  `terminal-payment.service.ts:449`): las tres columnas nuevas son obligatorias para que B sea verificable.
- **P2-5 · A.2 · Factibilidad: la bandeja no tiene ninguna transacción hoy.** Ni `@Transaction` ni `withTransaction`
  en `RemotePaymentInbox.kt`/`RemotePaymentRequestDao.kt`; cada mutación es UNA sentencia CAS. «Contador en la misma
  transacción» exige envolver cada CAS + `UPDATE centinela` en `withTransaction` y que el `insert IGNORE` de un
  duplicado NO suba el contador (o sí, pero declarado). El centinela no rompe consultas: la única que cuenta filtra
  `status='PROCESSING'` (`Dao:14-24`) y `getById` (`:34`) lo devuelve a propósito. Espejo permanentemente
  inescribible (disco lleno) ⇒ TODO cobro remoto acaba PROCESSING/ACTIVE: definir alerta y rotación.
- **P2-6 · C.1 · La lista blanca debe ir por (status, failureCode) y cubrir lo que HEAD ya escribió.** Hoy:
  `cancelled + PROCESSOR_DECLINED` se degrada a `timeout` (`:1098-1102`); `resultToStatus('timeout')` ⇒ UNKNOWN y
  ningún escritor pone `status=TIMED_OUT` (`:370-382`); el watchdog escribe `UNKNOWN/TIMED_OUT` (`:1507`); producción
  (HEAD) escribe `TIMED_OUT/AUTO_RELEASED` y `MANUAL_RELEASE`. Todos ⇒ UNRESOLVED. `TPV_CONFIRMED_NO_CHARGE` ⇒
  NOT_CHARGED sólo con la condición de P1-2. `CONTRACT_MISMATCH` ⇒ CHARGED + `reconciliationRequired`.
- **P2-7 · C.6 · Rutas fuera de la tabla.** Delivery: `delivery-channels/core/cancelDeliveryOrder.service.ts:46-60`
  cancela sin `FOR UPDATE` ni guard (Uber `:89/:302`, Rappi `:86`) ⇒ misma fila que POS-sync (no rechazar; 🚨 +
  `ActivityLog` si hay cobro vivo). Limpieza de promoción fallida `order.mobile.service.ts:1039-1047` (fuera de
  transacción, exenta porque la orden nace y muere en la misma llamada: declararlo). Nota: la mayor parte de C.6
  YA está construida en el árbol (`orderCancelGuard.ts`; usado en `:3241`, dashboard `:562/:621`, vales `:1768`,
  `voidItems :2813-2836`, fusión `:1931`): el diseño debe describir el estado real, no proponerlo de cero.
- **P2-8 · C.6/G2 · Anular artículos en una orden PARTIAL absorbe el sobrepago en silencio.** G2 bloquea con cobro
  de terminal VIVO, pero con `Payment` YA registrados sólo rechaza PAID y «anular todo» (`order.tpv.service.ts:
  2819-2826`); una anulación parcial deja `Math.max(0, newTotal - paid)` (`:2873`) sin reembolso ni alerta. Cambio:
  si `newTotal < paid` ⇒ rechazar o crear obligación de reembolso con 🚨.
- **P2-9 · C.5/C.4 · Efectivo en un cobro remoto sigue sin decidir y es una ruta de doble registro medida.**
  Blumon y AngelPay ofrecen efectivo sin condición (`AngelPayPaymentScreen.kt:610`; Blumon emite `success` con
  `cardDetails=CASH` y sin método, `PaymentViewModel.kt:1437-1451`) y el servidor sólo cierra con tarjeta. Mientras
  se decide: ocultar efectivo/cripto para `paymentSource=SOCKET` (una línea) o aceptar CASH como cierre con método.
- **P2-10 · C.4 · La intención durable debe incluir la orden que nace DESPUÉS de que el cajero salió.** Android
  `cancel()` desde Processing (`PaymentFlowViewModel.kt:1855-1883`): cancel fire-and-forget (`TerminalPaymentService.kt:
  549-570`, respuesta no leída) + `cancelOrder` en paralelo + salida inmediata; si `createdOrderId` aún es null, la
  orden que llegue después queda huérfana. iOS nunca cancela la orden (`cancelCurrentOrder()` sin llamadores). La
  intención tiene que atarse al `requestId` y resolver la orden por `TerminalPaymentRequest.orderId` cuando exista.
- **P2-11 · B.3 · La «vigilancia de 72 h» no tiene hoy escritor.** El barrido de liberadas busca `TIMED_OUT +
  AUTO_RELEASED/MANUAL_RELEASE` (`:1711-1718`), que nadie escribe en el árbol; ventana 30 min; `money-integrity-
  watchdog` no mira `TerminalPaymentRequest`. Cambio: el barrido vigila por `outcomeEvidence ∈ {NOT_FOUND_CONTINUOUS_
  INBOX, OPERATOR_RECONCILED, NEVER_DELIVERED, PROCESSOR_DECLINED}` durante 72 h y busca `Payment` por serial+importe
  aunque no traigan `requestId` (P2-1 del 10-sep: `findReconcilablePayment` sólo alcanza los etiquetados).
- **P2-12 · D · El diseño describe como pendiente lo que otra sesión ya tiene a medias, y el banner miente.**
  Árbol: auth antes de la espera de 8 s (`AngelPayPaymentViewModel.kt:1329-1336`), `AuthErrorKind` con `SIN_RED` sin
  fallback (`AngelPayAuthRepository.kt:715-735`), `app_terminal_serial` real (`CrashlyticsContext.kt:55-67`); pero
  `AngelPayAuthRecovery.recoverIfStuck` devuelve siempre `OMITIDA_NO_ATORADA` (`AngelPayAuthRecovery.kt:63-64`, «fase
  ROJA»), nadie lo llama desde Home (`HomeViewModel.kt:109` sólo inyecta) y el banner dice «se reintenta sola»
  (`AngelPayAuthBanner.kt:164`). Coordinar con esa sesión; no re-diseñar.
- **P2-13 · D · Dos listas de códigos divergentes.** `confirmedNegativeEvidence` (`{G500,G504,E605,E606}` o código
  de 2 caracteres) contra `AngelPayOutcomeClassifier.CODIGOS_RECHAZO_CONFIRMADO` (40 códigos, incl. D308). Un rechazo
  que sólo la segunda reconoce viaja como `PRE_AUTHORIZATION` aunque el SDK ya se lanzó. Una sola tabla.
- **P2-14 · C.2 · El cancel no queda en la procedencia y el handler del POST cancel devuelve 500 genérico.**
  `recordDelivery` sólo se llama en `:758` y `:1006`; `cancelTerminalPayment` (`controller:415-424`) pierde `code`,
  `details` y `statusCode`. Registrar el cancel como entrega (`kind:'CANCEL'`) y propagar errores tipados.

## P3

- **P3-1 · C.5 · La verificación pendiente «chip aprueba sin host» ya está cubierta:** `markAuthorizing` va antes de
  `SaleIcc/SaleCtls` (`PaymentViewModel.kt:3942-3970`) y `markKernelEntered` antes del kernel contactless (`:4755`);
  el cancel sólo descarta desde PREPARANDO (`PaymentAttemptLedger.kt:326-341`). Cerrar el punto como verificado.
- **P3-2 · A.5 · `register` tiene 3 llamadores con aridades 3/4/8** (`socketManager.ts:204`, `observability.
  controller.ts:255`, `heartbeat.tpv.controller.ts:249`): el objeto de opciones del diseño debe impedir que un
  heartbeat borre `inboxTrusted`/identidad.
- **P3-3 · A.5 · Replay y sonda corren en paralelo hoy** (`socketManager.ts:230-237`); pasar a secuencial es correcto
  y barato. El cruce entrega-en-tránsito/sonda ya lo cierra la lápida del plan D.
- **P3-4 · C.6 · `SyncIntentAck` no tiene `details`** (`sync.mobile.service.ts:79-92`): la cola offline pone en
  cuarentena `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` sin el `requestId` bloqueador. Añadir `details`.
- **P3-5 · C.1 · Blumon no reporta al POS un rechazo reintentable** (`PaymentViewModel.kt:1457-1460`): la tablet
  espera 5 min. Emitir un evento informativo no final (`declined_retryable`) sin cerrar la fila.
- **P3-6 · G3 · Fusión: el destino con cobro en vuelo cambia de total** bajo un importe ya fijado ⇒ acaba PARTIAL,
  no sobrepago; aceptable, pero avisar en el POS. `TerminalPaymentRequest.orderId` del origen queda apuntando a una
  orden CANCELLED/$0 y `recordOrderPayment` no mira `Order.status` (`payment.tpv.service.ts:1998-2110`): sólo lo
  protege el candado compartido.
- **P3-7 · Socket `ORDER_UPDATED` ausente** en fusión, DELETE/PUT del dashboard y vales (lector de rutas §6).
- **P3-8 · D.7 · No se reproduce en el árbol:** VM con scope de destino (`AngelPayPaymentScreen.kt:129`),
  `AppNavigation.kt:399-447` hace `popUpTo(Home)` y limpia args antes de una solicitud nueva, `Idle` sólo vía
  `resetPayment` (`:3646`). HEAD 2.9.2 (donde se observó 27d380e9) NO se revisó.

## G1/G2/G3

G1 correcta. G2 correcta y corta: extenderla a `Payment` ya registrados (P2-8). G3 aceptable con P3-6.

## Lo que NO pude verificar
- Producción: las 375 filas y su reparto por terminal (dato del diseño, sólo lectura de otra sesión).
- HEAD 2.9.2 de la TPV para D.7 y para el comportamiento de `retryAfterError` publicado.
- Que `AngelPayChargeVerifier.verificar` consulte de verdad el historial (sólo se leyó su contrato).
- Carreras de dos hilos sobre Room en la TPV (no hay pruebas ejecutadas en esta pasada; es lectura de código).
- Comportamiento de socket.io ante mutación de `auth` en `reconnect_attempt` en la versión Android usada (P1-4
  propone la técnica; hay que probarla en aparato).

---

## Cruce con la recopilación de la sesión hermana (`investigado-11-sep-diseno-A-B-s8.md`, 40 hallazgos, 13:41)

Leída después de cerrar esta auditoría. Convergencia en 5 de los 6 P1 de arriba (lápida de admisión = su «no se
creó sin lápida» y H.5/H.6; reintento Nexgo = su «NOT_CHARGED no definitivo» y H.3; contador congelado = su
COUNTER_REGRESSION; B `TERMINAL_FINAL_ANSWER` = su P1 de B-contrato; despliegue/375 = su «no se pueden conciliar
antes»). Lo que ELLA encontró y esta pasada NO, verificado aquí en el código antes de aceptarlo:

- **`cancelDisposition` en `null` cuando `outcome ≠ UNRESOLVED` (diseño C.1, línea 270) rompe la ÚNICA vía de
  «no se cobró» por cancel de las apps publicadas.** Android 2.18.x e iOS 1.10.x sólo leen `status/inProgress/
  paymentId/cancelDisposition` y liberan la llave con `CANCELLED + ACCEPTED` (`CardChargeOutcome.kt:256-265`,
  `.swift:307-320`); con `null` caen a `Undetermined` y la llave no se suelta nunca. **P1 nuevo.** Cambio: conservar
  `cancelDisposition='ACCEPTED'` siempre que la evidencia sea `CANCEL_ACCEPTED`; proyectar `null` sólo para `ACTIVE`
  cuando el desenlace ya es final por otra vía.
- **Espejo sin `fsync` del directorio + Room en WAL sin `synchronous` explícito** (`DatabaseModule.kt:166`, sin
  `PRAGMA synchronous`): en Android el WAL usa `normal` por defecto, así que un corte de luz puede perder
  transacciones ya confirmadas Y el `rename` del espejo. Base y espejo retroceden juntos ⇒ «Continúa» sobre un
  estado anterior a una ejecución. **P1 aceptado.** Cambio: `fsync` del directorio tras el `rename` y
  `PRAGMA synchronous=FULL` (o `EXTRA`) en `avoqado_database`; la regla «commit → fsync → efecto» exige que el commit
  sea durable de verdad.
- **D.7 sí tiene mecanismo en el árbol:** `AngelPayPaymentScreen.kt:192-195` re-etiqueta el VM en cada
  recomposición con `(paymentSource, socketRequestId)`; cuando `AppNavigation` escribe los args de la solicitud
  NUEVA en el handle antes del `popUpTo`, la pantalla VIEJA todavía compuesta se re-etiqueta con B y su cierre por
  abandono emite `cancelled + PRE_AUTHORIZATION` de B mientras el VM nuevo la cobra. Corrige mi P3-8 («no se
  reproduce»): mi lector miró el scope del VM y no la ventana entre escribir el handle y el pop. **P1 aceptado.**
- **`abandoned-orders-cleanup.job.ts:124` hace `order.deleteMany` sin candado ni consulta de cobros** (y
  `demoCleanup`, `venue.dashboard.service.ts:448`, `liveDemoCleanup`). Mi lector buscó escritores de
  `status=CANCELLED` y no borrados físicos. Falta en C.6. P2.
- «El otro lado del candado» (efectivo/liquidar/separar cuenta con un cobro de terminal vivo), el cobro LOCAL de la
  PAX invisible para «cobro vivo», la libreta SHADOW de 2.9.2 al instalar el APK, y «rechazo en la PAX + salida del
  cajero = sin salida automática»: coherentes con lo leído aquí; no se reverificaron línea a línea en esta pasada.

Lo que esta pasada aporta y la recopilación no lista con ese ángulo: `LEGACY_NO_RESUME` es falso en 2.9.x (la
bandeja reanuda tras reinicio; P1-5); el servidor no tiene `TerminalCommand` y `deviceReboundAfter` no prueba el
borrado (P1-3); la vigilancia «72 h» no tiene escritor vivo (P2-11); replay y sonda en paralelo (P3-3); `register`
con tres aridades (P3-2); C.5 chip ya cubierto por `markAuthorizing` (P3-1); C.6 ya construida en gran parte (P2-7).

Refutaciones suyas que comparto: `failed + PRE_AUTHORIZATION` + auth recuperada NO reabre el reintento (guarda
`solicitudCerradaAntesDeAutorizar`, T26); «único escritor / contador en la misma transacción» es factibilidad, no
hueco de dinero (mi P2-5 queda como nota de implementación).
