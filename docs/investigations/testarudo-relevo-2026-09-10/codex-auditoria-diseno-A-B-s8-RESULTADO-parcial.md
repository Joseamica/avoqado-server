# Auditoría Codex del diseño A/B/§8/Nexgo — RESULTADO PARCIAL (11-sep-2026)

Estado: **INCOMPLETA**. Hilo `01a091df-2fec-7e03-a370-1671adcf8289`, modelo gpt-6-astra, esfuerzo xhigh, sólo lectura, lanzado 19:08 UTC desde el root del workspace. Murió a los ~10 min con `turn.failed`:

> Your workspace is out of credits. Ask your workspace owner to refill in order to continue.

Sin `turn.completed`: NO hay veredicto global ni lista P1/P2/P3. Lo de abajo son los mensajes parciales que emitió mientras leía (55 comandos de lectura ejecutados). Reanudar cuando haya créditos:

```bash
codex exec resume 01a091df-2fec-7e03-a370-1671adcf8289 \
  "Continúa la auditoría donde la dejaste y entrega el informe completo en el formato pedido (veredicto + P1/P2/P3 con archivo:línea + lo que NO pudiste verificar)." \
  -c 'sandbox_mode="read-only"' -c 'model="gpt-6-astra"' -c 'model_reasoning_effort="xhigh"' --json
```

## Mensajes de Codex, verbatim, en orden

### Mensaje 1

Voy a leer completos el diseño, la regla y el relevo, y contrastarlos con el código del árbol de trabajo. Mantendré la revisión en solo lectura, sin builds ni operaciones de git.


### Mensaje 2

El diseño declara dos excepciones a la garantía de continuidad: la copia completa que restaura también el espejo y el replay de APK sin identidad. Voy a comprobar cómo se combinan con las entregas y ejecuciones reales, y qué evidencia exigiría B para cerrarlas.


### Mensaje 3

La premisa de A sobre los downgrades es falsa en el árbol actual: `DatabaseModule.kt:162` sí configura `fallbackToDestructiveMigrationOnDowngrade()`. Eso afecta tanto la recuperación tras restauraciones como la seguridad durante cambios de APK.


### Mensaje 4

B tiene una base de liberación inválida: la TPV reporta `Factory reset completed` antes de borrar datos y antes de matar el proceso. También confirmé que Nexgo puede emitir un rechazo final y conservar «Reintentar»; el diseño debe impedir que esa misma solicitud vuelva a autorizar después de liberarla.


### Mensaje 5

La cobertura de cancelación de órdenes omite rutas reales: hay una cancelación por compensación de promociones, otra por eventos de delivery y cambios de estado por POS-sync además del DELETE. También estoy comprobando C.3 frente a dos POST concurrentes con el mismo `requestId`: una lectura «no existe» no impide que la otra copia cree y ejecute el cobro.


## Qué leyó (comandos ejecutados, en orden)

- `/bin/zsh -lc pwd`
- `/bin/zsh -lc "wc -l 'avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md'"`
- `/bin/zsh -lc "wc -l 'avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md'"`
- `/bin/zsh -lc "wc -l 'avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md'"`
- `/bin/zsh -lc 'cat avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md'`
- `/bin/zsh -lc 'cat avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md'`
- `/bin/zsh -lc "sed -n '1,360p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '361,720p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '721,1100p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '200,400p' avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md"`
- `/bin/zsh -lc "sed -n '1,180p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '181,360p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '361,540p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '541,720p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '721,900p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc "sed -n '901,1070p' avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md"`
- `/bin/zsh -lc 'wc -l CLAUDE.md avoqado-server/CLAUDE.md avoqado-tpv/CLAUDE.md avoqado-android/CLAUDE.md avoqado-ios/CLAUDE.md'`
- `/bin/zsh -lc "rg --files avoqado-tpv/app/src avoqado-server/src avoqado-server/prisma avoqado-android/app/src avoqado-ios | rg '(RemotePayment|PaymentAttempt|DatabaseModule|SocketManager|socketManager|terminal-payment|terminal-registry|AngelPay.*(ViewModel|Manager|Screen)|TerminalConfigRepositoryImp`
- `/bin/zsh -lc "rg -n 'remote_payment_requests|RemotePaymentRequestDao|remotePaymentRequestDao' avoqado-tpv/app/src/main avoqado-tpv/app/src/sandbox avoqado-tpv/app/src/production"`
- `/bin/zsh -lc "nl -ba 'avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/remotepayment/RemotePaymentInbox.kt'"`
- `/bin/zsh -lc "nl -ba 'avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/remotepayment/RemotePaymentRequestDao.kt'"`
- `/bin/zsh -lc "nl -ba 'avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/remotepayment/RemotePaymentCoordinator.kt'"`
- `/bin/zsh -lc "rg -n 'FACTORY_RESET|deleteDatabase|deleteRecursively|reset|force|exitProcess' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/commands/CommandExecutor.kt"`
- `/bin/zsh -lc "rg -n 'remotePaymentInbox|persistResult|emitTerminalPayment|ack|probe|payment_cancel_disposition|terminalPayment' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/realtime/SocketManager.kt"`
- `/bin/zsh -lc "rg -n 'failureCode|outcomeEvidence|recordDelivery|registrarAckDeReplay|handleProbe|replayPending|sendPayment|FOR UPDATE|advisory|releaseUnknown|resultFromRow|cancelPayment|closeRow' avoqado-server/src/services/terminal-payment.service.ts"`
- `/bin/zsh -lc "rg -n 'allowBackup|backup|fullBackup|dataExtraction|applicationId|versionName|versionCode' avoqado-tpv/app/src/main/AndroidManifest.xml avoqado-tpv/app/src/main/res/xml/{backup_rules,data_extraction_rules}.xml avoqado-tpv/app/build.gradle.kts"`
- `/bin/zsh -lc "rg -n 'reserveTerminal|remotePayment|markKernel|markAuthor|PREPARANDO|StartEmvTrans|startEmvTrans|startIcc' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/ledger/PaymentAttempt{Ledger,Dao}.kt avoqado-tpv/app/src/production/java/com/jaac/avoqado_tpv/features/pa`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '190,425p;490,680p;720,1030p'"`
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/realtime/SocketManager.kt | sed -n '180,235p;1520,1640p;1990,2075p'"`
- `/bin/zsh -lc "rg --files avoqado-tpv/app/src/main | rg 'CommandExecutor|AngelPayAuth|AngelPayManager|AngelPay.*Manager'; nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt | sed -n '65,165p'"`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '595,680p;720,1025p'"`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '1040,1365p'"`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '1780,1875p;1980,2148p;2200,2245p;2310,2400p'"`
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/remote_command/domain/CommandExecutor.kt | sed -n '985,1135p'; rg -n 'COMPLETED|complete|executeFactoryReset|FACTORY_RESET' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/remote_command/domain/CommandExecut`
- `/bin/zsh -lc "rg -n 'FAILED|CANCELLED|UNKNOWN|cancelDisposition|outcome|refusedForAnotherRequest|TERMINAL_NOT_CONNECTED|reconciliationRequired' avoqado-android/app/src/main/java/com/avoqado/pos/payment/{domain/CardChargeOutcome.kt,data/TerminalPaymentService.kt,presentation/PaymentFlowViewModel.kt} `
- `/bin/zsh -lc "rg -n '_socketRequestId|initPayment|initialize|retry|Retry|authenticate|Auth|ensureAuthenticated|currentContext|paymentContext|startPayment|selectCash|cash|isPaymentInProgress' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentView`
- `/bin/zsh -lc "rg -n 'failureCode\\s*[:=]' avoqado-server/src avoqado-server/prisma/migrations"`
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt | sed -n '225,255p;455,510p;690,750p;870,1015p;1135,1245p;1450,1550p;3300,3387p;3390,3415p;3480,3510p'"`
- `/bin/zsh -lc "rg -n 'LaunchedEffect|initPayment|setSocketPayment|Error|retryAfterError|showCashOption|authState|isAuthenticated' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentScreen.kt; nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_t`
- `/bin/zsh -lc "rg -n 'paymentSource|socketRequestId|angelPayViewModel|angelPayPaymentViewModel|launchSingleTop|paymentInProgress|isPaymentInProgress' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/navigation/AppNavigation.kt"`
- `/bin/zsh -lc "rg -n 'fun |Mutex|withLock|setCharging|isCharging|isAuthenticated|authenticate|switchAccount|handleAuthExpiry|resolve|fallback' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/processor/angelpay/AngelPayAuthRepository.kt"`
- `/bin/zsh -lc "rg -n 'CANCELLED|DELETED|cancelOrder|mergeOrders|FOR UPDATE|cancelAreaTicketCheckout|paymentStatus' avoqado-server/src/services/mobile/order.mobile.service.ts avoqado-server/src/services/tpv/order.tpv.service.ts avoqado-server/src/services/dashboard/order.dashboard.service.ts avoqado-s`
- `/bin/zsh -lc "rg --files avoqado-tpv/app/src/main | rg 'AppNavigation.kt"'$'"'; rg -n \"status: (OrderStatus\\.)?['\\\"]?(CANCELLED|DELETED)|status = ['\\\"](CANCELLED|DELETED)|status: .*\\.status|cancelAreaTicketCheckout|assertOrderCancellable\" avoqado-server/src/services/{mobile,order*,tpv,dashbo`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/mobile/order.mobile.service.ts | sed -n '1000,1070p;1827,1985p;3180,3230p'; nl -ba avoqado-server/src/services/pos-sync/posSyncOrder.service.ts | sed -n '230,265p;295,325p;335,358p'"`
- `/bin/zsh -lc "rg -n \"status: (OrderStatus\\.)?['\\\"]?(CANCELLED|DELETED)|cancelAreaTicketCheckout|assertOrderCancellable\" avoqado-server/src/services -g '*.ts' -g '"'!*.test.ts'"'; rg -n 'paymentSource|socketRequestId|angelPayViewModel|angelPayPaymentViewModel|launchSingleTop|isPaymentInProgress|`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '1250,1355p'; rg -n 'getPaymentStatus|hasUnprovenLegacyOutcome|result:' avoqado-server/src/services/terminal-payment.service.ts; nl -ba avoqado-server/src/controllers/mobile/terminal-payment.mobile.controller.ts | `
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/presentation/navigation/AppNavigation.kt | sed -n '355,497p;2790,2848p'; nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/ledger/PaymentAttemptDao.kt | sed -n '30,110p;190,225p'; nl -ba avoqad`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/terminal-payment.service.ts | sed -n '1390,1425p;1530,1615p;1775,1838p'; nl -ba avoqado-server/src/services/delivery-channels/core/cancelDeliveryOrder.service.ts | sed -n '1,150p'; nl -ba avoqado-server/src/services/shared/orderCancelGuard.ts | sed -n`
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/res/xml/backup_rules.xml; nl -ba avoqado-tpv/app/src/main/res/xml/data_extraction_rules.xml; nl -ba avoqado-tpv/app/src/main/AndroidManifest.xml | sed -n '50,65p'; nl -ba avoqado-tpv/app/build.gradle.kts | sed -n '335,415p'; nl -ba avoqado-server/src/com`
- `/bin/zsh -lc "nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt | sed -n '260,375p;790,860p;1630,1692p'; rg -n 'fun .*recover|restore|recover|pendingExternal|lookup' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features`
- `/bin/zsh -lc "rg -n 'fun cancel|cancelCurrentPayment|cancelOrder|createdOrderId|orderCreated|createOrder|fun logout|pending|venueId' avoqado-android/app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt | tail -75; rg -n 'unresolved|SharedPreferences|commit\\(|venueId|cancel`
- `/bin/zsh -lc "rg -n 'FOR UPDATE|lockExistingOrder|lockCheckout|lock.*Ticket|checkoutSession' avoqado-server/src/services/shared/paymentShiftClaim.ts avoqado-server/src/services/tpv/payment.tpv.service.ts avoqado-server/src/services/mobile/areaTicketV7.mobile.service.ts | head -100; rg -n 'recalculat`
- `/bin/zsh -lc "nl -ba avoqado-server/src/services/mobile/comp-item.mobile.service.ts | sed -n '137,215p'; nl -ba avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/processor/angelpay/AngelPayAuthRepository.kt | sed -n '110,132p;190,256p;348,435p;449,568p'"`
- `/bin/zsh -lc "rg -n 'angelPayAuthRepository|hasServer|network|Network|app_terminal_serial|TerminalConfig.serialNumber' avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/presentation/viewmodels/HomeViewModel.kt | head -100; rg -n 'fetchConfig|onFailure|failure|cachedAngelPayAuth|catch|Result.fa`
- `/bin/zsh -lc "rg -n 'failureCode|failure_code|failUndelivered\\(' avoqado-server/src/services/terminal-payment.service.ts; rg -l 'terminalPaymentRequest|TerminalPaymentRequest' avoqado-server/scripts -g '*.ts' -g '*.js' -g '*.sql' -g '*.cjs' -g '*.mjs'; nl -ba avoqado-server/src/mcp/tools/terminals.`

---

## Verificación de Fable 5.1 de los cinco hallazgos parciales (11-sep, contra el árbol de trabajo)

Codex no llegó al informe. Cada mensaje parcial se contrastó con el código; abajo la evidencia, la severidad que
le correspondería en el formato pedido y el cambio al diseño. **Esto NO sustituye la auditoría completa**: cubre lo
que Codex alcanzó a decir, no las 8 preguntas.

### V1 · «Room ante downgrade: la app truena y los datos quedan intactos» es FALSO — P2 (premisa del diseño §0 y A.2)
- `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt:162` → `.fallbackToDestructiveMigrationOnDowngrade()`
  (y `:145` `fallbackToDestructiveMigrationFrom(dropAllTables = true, 1)`). El comentario `:147-160` declara la pérdida:
  pending_payments, draft_orders, verification_queue… y, por tanto, bandeja y libreta.
- Para A no abre un hueco de dinero: al bajar de versión Room tira TODAS las tablas, centinela incluida ⇒ caso «M sin S»
  ⇒ Rotar (A.3). Pero el diseño lo presenta como hipotético («si algún día se configura») y ya está configurado.
- **Cambio:** corregir la tabla del §0; declarar `INSTALL_VERSION` a una versión menor como evento destructivo de la
  misma clase que `FACTORY_RESET` (rota identidad, borra libreta y colas); B no puede usar `DEVICE_INSPECTED`
  («la bandeja o la libreta muestran el intento cerrado») después de un downgrade, porque ya no hay bandeja que mirar.

### V2 · `DEVICE_DECOMMISSIONED` se apoya en un ACK que se manda ANTES de borrar — P1 (B.1)
- `avoqado-tpv/…/features/remote_command/domain/CommandExecutor.kt:1055` → `ackSelfDestructiveCommand(command,
  CommandResult.success("Factory reset completed"))` se envía **antes** de `secureStorage.clearAll()`, del
  `deleteDatabase` (`:1070`, en un `try/catch` que se traga «Could not delete … (will be cleared on app restart)» —
  y el reinicio NO borra bases) y de `killProcess` (`:1090`).
- Escenario: entrega a la bandeja X (RECEIVED sin ACK) → operador manda FACTORY_RESET → `TerminalCommand` queda
  COMPLETED → `deleteDatabase` falla porque Room tiene la conexión abierta (WAL) → la bandeja y el espejo de
  `noBackupFilesDir` sobreviven → al reactivar, A.3 ve «S y M presentes, mismo id» ⇒ **Continúa** → la fila RECEIVED
  se reclama y cobra. Mientras tanto B liberó la solicitud por `DEVICE_DECOMMISSIONED` («verificada por el servidor
  contra TerminalCommand»). Cobro sobre una solicitud liberada.
- **Cambio:** `DEVICE_DECOMMISSIONED` exige que el servidor haya observado, DESPUÉS del comando, un handshake del mismo
  serial con identidad de bandeja distinta (X ⇒ DISCONTINUED/SUPERSEDED) o sin identidad; el `COMPLETED` del comando
  solo no basta. En la TPV: escribir un marcador durable «reset solicitado» en `noBackupFilesDir` ANTES del ACK y que
  A.3 lo trate como Rotar; borrar bases con la base cerrada (o `deleteDatabase` tras `close()`), y borrar también el
  espejo.

### V3 · Nexgo emite un rechazo FINAL y conserva «Reintentar» con el MISMO `requestId` — P1 (C.1 lista blanca + D + C.5)
- `avoqado-tpv/…/presentation/angelpay/AngelPayPaymentViewModel.kt:1942-1953`: ante `AngelPayResult.Failure` no
  recuperable pone `Error(canRetry = true)` **y** emite `failed + PROCESSOR_DECLINED` (o `PRE_AUTHORIZATION`, `:1902`).
- `:471-476`: el `_socketRequestId` **sobrevive al emit a propósito** («Clearing the id on emit … silently broke
  retry-after-decline»); sólo se limpia en `resetPayment` (`:3509-3511`).
- `:3321-3343` `retryAfterError`: con `confirmedNegativeOutcome = true` el reintento pasa, acuña `attemptId` nuevo y
  vuelve a SELECT_MERCHANT con el mismo monto; la fila de la libreta y el `Payment` llevan
  `terminalPaymentRequestId = _socketRequestId` (`:717`, `:1756`). `emitSocketResultIfSocketSourced` (`:3372`) NO emite
  un segundo resultado para el mismo id.
- Escenario: rechazo del banco → servidor recibe `failed + PROCESSOR_DECLINED` → C.1 lo clasifica NOT_CHARGED
  (evidencia TERMINAL) → fila FAILED, terminal liberada, tablet «no se cobró» y suelta su llave → cajero toca
  «Reintentar» en la N86 → tarjeta APROBADA → el `Payment` llega con el id liberado → el servidor concilia a COMPLETED
  con 🚨 «Payment recorded for a RELEASED request — check the order for a double charge»
  (`avoqado-server/src/services/terminal-payment.service.ts:1733-1736`). Si la tablet ya volvió a cobrar (solicitud
  nueva o «Tarjeta (otra terminal)»), es cobro doble; y el servidor sólo se entera por el registro del `Payment`, no
  por el socket.
- **Cambio:** en C.1, `PROCESSOR_DECLINED` sólo vale como NOT_CHARGED si la terminal NO puede reautorizar ese
  `requestId`; en D/C.5, tras emitir un desenlace final de un cobro con origen SOCKET el reintento queda bloqueado en
  la terminal (o produce un `requestId` nuevo correlacionado, nunca el liberado). Verificar el mismo patrón en Blumon
  (`PaymentViewModel` de production/sandbox): NO verificado aquí.

### V4 · C.6 omite rutas que cancelan órdenes — P2
- **Delivery (verdad externa, como POS-sync):** `avoqado-server/src/services/delivery-channels/core/cancelDeliveryOrder.service.ts:51`
  `tx.order.update({… status: OrderStatus.CANCELLED})`, llamado desde `providers/uber-eats/uber.eventProcessor.ts:89` y
  `:302` y `providers/rappi/rappi.eventProcessor.ts:86`. No aparece en la tabla de C.6. Un pedido de delivery cobrado en
  la puerta con terminal es plausible. **Cambio:** misma fila que «DELETE de POS-sync»: no se rechaza; 🚨 +
  `ActivityLog` si había cobro vivo.
- **Limpieza de promoción fallida:** `src/services/mobile/order.mobile.service.ts:1041-1047` cancela la orden recién
  creada fuera de toda transacción y sin el helper (best-effort). Como la orden nace y muere en la misma llamada, no
  puede tener cobro en terminal; **declararla exenta con ese motivo** en C.6 en vez de dejarla fuera.
- La «cancelación por compensación de promociones» que menciona Codex NO la encontré como escritor de `Order.status`
  (`comp-item.mobile.service.ts`, `promotion.service.ts` y `promotion-sales.dashboard.service.ts` no actualizan la
  orden a CANCELLED en mi grep): sin verificar.

### V5 · C.3: dos POST concurrentes con el mismo `requestId` — el 404 «prueba que no se creó» NO se sostiene — P1
- Hoy: `terminal-payment.service.ts:497-507` comprueba el registro **fuera** del candado y **antes** de buscar la fila;
  la búsqueda por `requestId` va dentro de `pg_advisory_xact_lock` (`:530-531`). C.3 invierte el orden pero deja el
  404 fuera del candado y **no escribe nada** (G7).
- Escenario (es exactamente el pendiente #1 de la regla: reintentos de OkHttp / conexiones medio abiertas): copia A del
  POST → no hay fila, terminal no registrada (Doze) → 404 `TERMINAL_NOT_CONNECTED` con `details.requestId` → la tablet
  suelta su llave durable. Copia B (ms después, la terminal reconecta) → no hay fila, registro OK → candado → `create`
  (`:599`) → la terminal cobra. La tablet cree que esa solicitud nunca existió; si vuelve a cobrar, cobro doble.
- **Cambio:** el 404 que afirme «no se creó» se emite DENTRO del candado y deja una fila lápida para ese `requestId`
  (`FAILED`, `failureCode = 'TERMINAL_NOT_CONNECTED'`, `outcomeEvidence = 'NEVER_DELIVERED'`,
  `deliveryProvenance = {deliveries: []}`): la copia B encuentra la fila y recibe la réplica FAILED, nunca crea ni
  ejecuta. G7 («sin tombstone antes de crear la fila») no aplica a esta admisión: aquí la fila ES el tombstone y la
  lista blanca de C.1 ya tiene `NEVER_DELIVERED`.

### Lo que Codex NO alcanzó y aquí tampoco se verificó
Las 8 preguntas del prompt siguen sin veredicto: A.3/A.8 (carreras sonda/replay/handshake, ACK tardío, dos variantes
en el mismo serial), la garantía «commit → fsync → efecto» en cada efecto, el centinela contra cada consulta del DAO
(`RemotePaymentRequestDao.kt:14-60`), el lote de las 375 filas, la lista blanca contra TODOS los escritores de
`failureCode`, G1/G2/G3, D.7 (`_socketRequestId` pegado al contexto de otra solicitud) y las combinaciones de
despliegue F. Confirmado de paso: `RemotePaymentRequestDao` sólo lo inyecta `RemotePaymentInbox`
(`RemotePaymentInbox.kt:42`, provider `DatabaseModule.kt:207`) y el DAO no tiene `@Delete` (`:31` único `@Insert`);
`AndroidManifest.xml:56-58` lleva `allowBackup="true"` con reglas vacías ⇒ Auto Backup sí restaura `databases/` y no
`no_backup/`, así que los casos «S sin M» y «S < M» de A.3 son reales.
