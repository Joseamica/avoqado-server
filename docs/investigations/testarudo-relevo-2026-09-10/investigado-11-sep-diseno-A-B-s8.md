# Lo investigado el 11-sep sobre el diseño A/B/§8/Nexgo — recopilación para auditar

Recopilación SIN análisis nuevo, por pedido del founder (él audita con Codex; yo implemento). Nada de A ni B está
programado. Fuentes: la revisión interna del diseño v1 (6 revisores independientes con un escéptico por hallazgo grave;
detenida a las 13:36 con 32 de 40 veredictos), la investigación D.7 (sólo lectura), la auditoría parcial de Codex (se
quedó sin créditos) con su verificación por otra sesión y por mí, y datos de producción en sólo lectura.

Diseño auditado: `diseno-A-B-seccion8-2026-09-11.md` (v1; la sección H de v2 ya incorpora V1–V5 de Codex).

## 1. Resumen: hallazgos graves y su verificación

| Frente | Hallazgo | Sev. original | Escéptico | Sev. final |
|---|---|---|---|---|
| rutas-candados | El otro lado del candado: cobrar en efectivo o liquidar con un cobro de terminal vivo, y sobre una orden CANCELLED | P1 | CONFIRMADO | P2 |
| rutas-candados | Las rutas que BAJAN el saldo sin cancelar no pasan por el helper; separar cuenta produce cobro doble | P1 | CONFIRMADO | P2 |
| rutas-candados | Para el diseño, «cobro vivo» es sólo TerminalPaymentRequest: un cobro LOCAL de la PAX sobre una orden existente es invisible | P1 | CONFIRMADO | P2 |
| rutas-candados | G2 sólo bloquea con cobro vivo; en PARTIAL deja anular lo ya pagado y bajar el total por debajo de lo cobrado | P1 | CONFIRMADO | P2 |
| rutas-candados | El job abandoned-orders-cleanup BORRA órdenes (hard delete en cascada) sin candado ni consulta de cobros | P1 | CONFIRMADO | P2 |
| rutas-candados | La cuarentena del CANCEL_ORDER o MERGE_ORDERS no detiene los intents que dependen de él | P2 | REFUTADO | P3 |
| rutas-candados | Más candados de Order ⇒ más P2028 en la admisión, y ese error sale como 500 sin código: llave irresoluble | P2 | CONFIRMADO | P2 |
| rutas-candados | Los códigos del helper chocan con lo que la TPV publicada hace con 409 y 400 (en removeOrderItem, bucle de resincronización) | P2 | CONFIRMADO | P3 |
| A-dinero | Room borra y recrea la base EN CALIENTE ante corrupción: el centinela desaparece a media sesión y la identidad X sigue en memoria | P1 | CONFIRMADO | P2 |
| A-dinero | «temporal + fsync + rename» sin fsync del directorio: tras un apagón el espejo y la base retroceden JUNTOS y el arranque ve «Continua» con R borrada | P1 | CONFIRMADO | P1 |
| A-dinero | El downgrade destructivo SÍ existe: la excepción de replay de A.9 puede reejecutar un cobro, y el argumento del riesgo residual es falso | P1 | CONFIRMADO | P2 |
| A-dinero | El contador congelado y las respuestas en desorden disparan COUNTER_REGRESSION falsas; DISCONTINUED nunca se revierte y la TPV no se entera | P2 | CONFIRMADO | P2 |
| A-dinero | El límite de las copias restauradas es mayor que «copia completa con root», y la marca de agua no ve nada justo en el caso que A quiere resolver | P2 | CONFIRMADO | P3 |
| A-factibilidad-TPV | El CAS del cancel no cubre el estado «entre intentos» (rechazo reintentable): el cajero cancela en la tablet y la terminal cobra igual | P1 | CONFIRMADO | P1 |
| A-factibilidad-TPV | El NOT_CHARGED canónico no es definitivo: la TPV reintenta la MISMA solicitud después de emitir failed+PROCESSOR_DECLINED | P1 | CONFIRMADO | P1 |
| A-factibilidad-TPV | El handshake congelado choca con COUNTER_REGRESSION: la primera reconexión por Doze tras una liberación descontinúa la bandeja para siempre y deja la terminal reservada | P1 | CONFIRMADO | P1 |
| A-factibilidad-TPV | El §0 es falso: el downgrade de Room ES destructivo, y la v34 de C.5 vuelve destructivo el rollback del APK nuevo (borra cobros aprobados sin registrar) | P1 | CONFIRMADO | P2 |
| A-factibilidad-TPV | El socket conecta antes de la verificación de identidad, y si falla se oculta también la capacidad: el servidor la trata como una 2.9.x y le aplica el replay del plan D | P2 | REFUTADO | P3 |
| A-factibilidad-TPV | «Único escritor» y contador en la misma transacción: huecos concretos del DAO actual y escritores nuevos que introduce C.5 | P2 | REFUTADO | P3 |
| N3-apps | AngelPay reporta «no se cobró» y deja reintentar el MISMO cobro remoto en la terminal | P1 | CONFIRMADO | P1 |
| N3-apps | En la PAX la evidencia de negativa es de la pantalla, no del intento: un rechazo viejo certifica un intento incierto | P1 | CONFIRMADO | P1 |
| N3-apps | Tarjeta declinada en la PAX + salida del cajero de la TPV = terminal y tablet bloqueadas sin salida automática | P1 | CONFIRMADO | P1 |
| N3-apps | «No se creó» no queda escrito: un POST tardío o duplicado desmiente el cancel antes de la fila (G7) y el 404 de C.3 | P1 | CONFIRMADO | P1 |
| N3-apps | Tras cambiar de usuario o de sucursal, la llave y la intención quedan irresolubles y la tablet ya no puede cobrar con tarjeta | P2 | CONFIRMADO | P3 |
| N3-apps | Cancelar mientras se crea la orden todavía manda el cobro, y si se pierde la respuesta la intención no sabe qué orden borrar | P2 | CONFIRMADO | P3 |
| N3-apps | «Sin conexión: la cancelación se enviará sola» miente cuando la terminal tiene LTE | P2 | CONFIRMADO | P3 |
| despliegue-pruebas-nexgo | Las 375 filas no se pueden conciliar «antes» del servidor que trae B, y el servidor de hoy sigue fabricando bloqueadores hasta el minuto del despliegue | P1 | CONFIRMADO | P1 |
| despliegue-pruebas-nexgo | El contador del handshake se queda congelado en cada reconexión automática: A declara COUNTER_REGRESSION en falso y la identidad queda descontinuada para siempre | P1 | CONFIRMADO | P1 |
| despliegue-pruebas-nexgo | La pantalla que sale re-etiqueta la VM vieja con la solicitud NUEVA y, al morir, emite un «cancelled + PRE_AUTHORIZATION» acreditado mientras la VM nueva cobra | P1 | CONFIRMADO | P1 |
| despliegue-pruebas-nexgo | «failed + PRE_AUTHORIZATION» deja vivo «Reintentar» sobre la MISMA solicitud: con la auth recuperada en segundo plano, cobra algo que el POS ya dio por no cobrado | P1 | REFUTADO | P3 |
| despliegue-pruebas-nexgo | La recuperación de fondo autentica la PRIMARIA mientras el cobro autentica fuera de isCharging: el SDK cobra por otra afiliación después de pasar el candado de alineación | P1 | SIN TERMINAR | — |
| despliegue-pruebas-nexgo | Con el servidor nuevo, una TPV que siga en 2.9.2 queda bloqueada al primer rechazo, y las apps POS publicadas se quedan con llaves que no se pueden resolver | P1 | SIN TERMINAR | — |
| despliegue-pruebas-nexgo | Al instalar el APK del árbol, la libreta que dejó la 2.9.2 en modo SHADOW bloquea la terminal, y no hay forma de regresar a 2.9.2 | P1 | SIN TERMINAR | — |
| B-contrato | TERMINAL_FINAL_ANSWER acepta precisamente las respuestas que el servidor ya rechazó como evidencia, incluida una que dice «cobré» | P1 | CONFIRMADO | P1 |
| despliegue-pruebas-nexgo | D no tiene pruebas y la tarea por defecto no llega a su código; A.10 no cubre la transición real del día del despliegue | P2 | SIN TERMINAR | — |
| B-contrato | La equivalencia escrita («fuera de vuelo y outcome UNRESOLVED») saca las filas EN VUELO del candado por orden y del candado para cancelar una orden | P1 | CONFIRMADO | P2 |
| B-contrato | Poner cancelDisposition en null cuando el desenlace es final deja sin resolución la llave de Android 2.18.3 y del iOS del árbol | P1 | SIN TERMINAR | — |
| B-contrato | C.3 no cierra el P1-3 para la app que lo produce, deja 422/403 sin código, y su 404 no prueba «no se creó» si se decide fuera del candado | P1 | SIN TERMINAR | — |
| B-contrato | Una solicitud que la terminal deja en PROCESSING contesta ACTIVE para siempre y B la rechaza: terminal y orden bloqueadas, y la única salida borra el dinero pendiente de toda la terminal | P1 | SIN TERMINAR | — |
| B-contrato | El modo lote da por revisadas 375 filas con una sola revisión que el servidor no puede comprobar que las cubra | P1 | SIN TERMINAR | — |

## 2. Auditoría parcial de Codex (V1–V5), verificada

| # | Hallazgo | Verificación | Sev. |
|---|---|---|---|
| V1 | El downgrade de Room SÍ es destructivo (`DatabaseModule.kt:162`); el §0 del diseño decía lo contrario | Confirmado por otra sesión y por mí (mi búsqueda previa falló por la sintaxis de zsh). A sobrevive (rota); el downgrade borra libreta y colas | P2 |
| V2 | `FACTORY_RESET` manda el ACK «completed» ANTES de borrar (`CommandExecutor.kt:1055`) y el borrado va en un try/catch que se traga el fallo (`:1070`) | Confirmado | P1 para la base DEVICE_DECOMMISSIONED de B |
| V3 | Nexgo emite `failed + PROCESSOR_DECLINED` final y deja «Reintentar» con el MISMO requestId | Confirmado en `AngelPayPaymentViewModel.kt` (~1942-1953 emite; el id sobrevive al emit ~471-476). Producción: 6 filas COMPLETED/TPV_ERROR (31-ago a 10-sep, Nexgo de Amaena y Testarudo) = rechazo seguido de reintento aprobado; las 6 órdenes con UN solo pago | P1 |
| V4 | Faltan rutas que cancelan órdenes en C.6 | Parcial: delivery (`cancelDeliveryOrder.service.ts:51`, Uber ~89/~302, Rappi ~86) y limpieza de promoción fallida (`order.mobile.service.ts:1041-1047`); «compensación de promociones» no se encontró | P2 |
| V5 | C.3: dos copias del mismo POST; la primera recibe 404 «no se creó», la segunda crea y cobra | Confirmado: el registro se revisa fuera del candado (`terminal-payment.service.ts:~497-507` vs `:530`). Extensión mía: el 409 TERMINAL_BUSY correlacionado de T15 tiene el mismo hueco | P1 |

Referencia de mercado para V3 (buscada en vivo): en Square Terminal un checkout sólo termina COMPLETED o CANCELED; un
rechazo no lo cierra ([doc](https://developer.squareup.com/docs/terminal-api/square-terminal-payments),
[foro 2020](https://developer.squareup.com/forums/t/keep-checkout-in-progress-instead-of-cancel-after-a-swipe-failure-for-customer-to-retry/215)).

## 3. Investigación D.7 (sospecha: id de una solicitud pegado al contexto de pago de otra)

**Confirmado: True**

### resumen

En el código SÍ existen dos formas de que el id de una solicitud (B) quede con el contexto de pago de otra (A): (1) cuando B tapa la pantalla de A, la pantalla de A que va saliendo se «re-etiqueta» con el id de B; al morir su VM le manda al servidor un «cancelled» de B que es falso, y en el árbol lo manda con evidencia PRE_AUTHORIZATION, que el servidor acepta y usa para liberar la terminal; (2) si un cobro remoto se abrió sobre Cobrar/Mesas y se sale con el botón atrás del sistema, sus argumentos se quedan en esa pantalla y el siguiente cobro LOCAL sale como remoto B, con la propina y (en venta rápida) la orden de B. PERO el incidente de 27d380e9 NO se explica por eso: el contexto de A en el evento de Crashlytics viene de llaves globales viejas (setPaymentContext nunca se limpia y B nunca llegó a tocar «Tarjeta»), y los logs no muestran ningún «Reintentar»: el aviso sale 201 ms después de un onResume, que es lo que produce un pop que quedó congelado mientras la pantalla estaba apagada. Ese día no se movió dinero.

En corto: el defecto existe en el código de 2.9.2 y del árbol, pero no fue lo que pasó el 11-sep. Se arregla con tres cambios chicos en la TPV, cada uno con una prueba que hoy falla. No necesito nada de ti para seguir; lo único que falta es decidir si esto entra en la tanda de la Nexgo (D).

### mecanismo

Rutas relativas a /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/. VM = features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt · NAV = core/presentation/navigation/AppNavigation.kt · SCR = …/angelpay/AngelPayPaymentScreen.kt. Líneas «HEAD:» = git show HEAD (2.9.2).

P1 · Qué pasa cuando llega B mientras el VM guarda el estado de A.
- El VM NO se reutiliza. hiltViewModel() está atado a la entrada de la navegación (SCR HEAD:128). El colector de NAV (HEAD:351-465) hace esto: si A está «trabajando» (Switching, SelectingMerchant, Charging…; isChargeAttemptActive publicado en VM HEAD:734-755), rechaza B con «Ya hay un pago en proceso» (NAV HEAD:385-400). Si A está resuelta (Error/rechazo, Success, Queued, Idle, Cancelled), hace pop hasta Home (NAV HEAD:405-412), escribe los argumentos de B en el handle de Home (HEAD:414, 437-458) y empuja una entrada NUEVA (HEAD:462). Para Nexgo, awaitPaxPaymentReady devuelve true sin suspender (HEAD:3226-3228), así que el pop, el set y el push pasan en la misma corrida.
- El VM nuevo de B: setSocketPaymentSource(B) (SCR HEAD:193-195 → VM HEAD:220-241), initPayment porque su estado es Idle (SCR HEAD:207; VM HEAD:949-957 asigna importe, propina y orden) y un attemptId nuevo (VM HEAD:965; ensurePaymentAttemptId HEAD:657-666 lo genera sólo si es null). Hasta aquí todo está limpio.

P2 · El camino 1: re-etiquetar la pantalla que sale.
La pantalla lee paymentSource/socketRequestId de `navController.previousBackStackEntry` (NAV HEAD:2795-2796). Eso se calcula respecto al TOPE ACTUAL del navController, no respecto a la entrada de A. Que la pantalla que sale se vuelva a componer durante el pop y vuelva a leer ese valor está verificado en hardware por el propio equipo (CHANGELOG.md:366, commit f697b1c, N86 a9e7503e/35503e76; comentario en VM HEAD:228-236). En el caso del cancel, lo que lee es (null,null), y eso quedó blindado. En el caso de una solicitud nueva, con la pila [Home, B], lo que lee es el handle de Home con (SOCKET, B). El guard sólo corta cuando el valor es nulo o es el mismo id (HEAD:236-237). Por eso asigna _socketRequestId=B y además RESETEA _socketResultEmitted=false (HEAD:238-240). Como el estado de A no es Idle, no se vuelve a llamar initPayment (SCR HEAD:207). Resultado: el VM de A queda con importe, propina, orden y attemptId de A, y el id de B.

P3 · Qué hace ese VM mezclado.
- Reintentar o cobrar desde él: no es alcanzable en la práctica. El VM vive sólo mientras dura la salida de la pantalla (el fade por defecto de NavHost). Durante ese tiempo la pantalla de B queda encima, en un Surface que bloquea los toques. En teoría: retryAfterError (HEAD:2962-2970) vuelve a «Método de pago» con pendingAmount de A, conservando el attemptId. Un cobro registraría amount/tip/orderId de A con terminalPaymentRequestId=B (VM HEAD:2235-2245, :2339).
- Lo que SÍ pasa solo: al terminar la salida, onCleared → emitCancelledIfAbandoned (HEAD:3041-3083). Con A en Error/Idle/Cancelled, sinDineroEnVuelo es true (HEAD:3260-3284). Entonces emite «cancelled» para B y markResolved(B) lo acepta desde PROCESSING (RemotePaymentRequestDao HEAD: `status != 'RESOLVED'`). El POS recibe «cancelado» de un cobro cuya pantalla sigue viva en la N86. Si luego se cobra B ahí, el pago llega tarde y dispara 🚨; si el cajero ya cobró en otra terminal, es un cobro doble. Si la actividad está detenida (pantalla apagada), Compose pausa su reloj de cuadros (frame clock) y ese «cancelled» falso sale MINUTOS después.

P2/P3 · El camino 2: un cobro local marcado como remoto.
El colector escribe los argumentos de B en `currentBackStackEntry` (NAV HEAD:414), que puede ser Cobrar o Mesas. Al salir con los callbacks de la pantalla, los argumentos se limpian (paymentArgsHandle, HEAD:2811/2818/2828). Con el botón atrás del sistema NO se limpian: no hay BackHandler en SCR, así que NavHost hace pop solo. Cobrar vuelve a poner argumentos sin limpiar (NAV HEAD:1314-1345: sólo initialAmount, entryPoint y, si es orden, orderId). Deja vivos paymentSource, socketRequestId, externalTipCents, externalRating, skipReview y, en venta rápida, el orderId de B. Lo mismo pasa en las rutas de Mesas y de venta serializada. El siguiente cobro local: VM nuevo, setSocketPaymentSource(SOCKET,B), initPayment(importe local, orderId de B en venta rápida, pendingTip = propina de B (HEAD:950), sin pantalla de propina). Se le cobra al cliente importe local + propina de B y se registra con terminalPaymentRequestId=B y la orden de B.

Incidente del 11-sep (Crashlytics PROD, evento de 27d380e9, eventTime 15:58:02 del aparato, que va ~4m13s adelantado):
- Las llaves payment_* son globales («No need to clear», CrashlyticsContext.kt HEAD:92-111) y sólo se escriben en startCardPayment/cash/crypto (VM HEAD:1260, 1674, 2705).
- No hay ningún «Merchant switch did not settle» después de las 15:46:21: B nunca tocó Tarjeta, así que las llaves siguen siendo las de A.
- La secuencia es `onResume evictAll` 15:58:01.714 → «Result not emitted» 27d380e9 15:58:01.915: encaja con el onCleared del VM de B al completarse un pop congelado. No se ve ningún Reintentar (los Timber.i no llegan a Crashlytics).

### head

2.9.2 (git show HEAD):
- VM:220-241 setSocketPaymentSource (acepta cualquier id distinto no nulo y resetea emitted en :240).
- VM:456-471 claves en SavedStateHandle.
- VM:949-965 initPayment (contexto + attemptId).
- VM:1237-1275 startCardPayment (setPaymentContext :1260).
- VM:2206-2245 recordCardPayment (amount/tip/orderId de pending* + terminalPaymentRequestId=_socketRequestId :2241).
- VM:2962-2970 retryAfterError (no limpia attemptId).
- VM:3041-3083 emitCancelledIfAbandoned/onCleared.
- VM:3086-3127 resetPayment.
- SCR:128 hiltViewModel · SCR:193-195 re-etiquetado por (source,id) · SCR:207 init sólo con estado Idle.
- NAV:385-412 ocupado / pop de pantalla vieja · NAV:414-462 escribe B en el handle del tope y empuja.
- NAV:469-506 handler de cancel (limpia previous y navega a Home).
- NAV:1314-1345 Cobrar sin clearPaymentArgs.
- NAV:2760-2828 composable AngelPay (lee previousBackStackEntry :2761-2796; limpia sólo en los callbacks).
- NAV:3159-3198 clearPaymentArgs · NAV:3207-3211 prepareManualPaymentArgs (sólo Welcome/FastPaymentEntry).
- RemotePaymentCoordinator.kt:124-149 cancel (marca RESOLVED).
- SocketManager.kt:1946-1990 («Result not emitted» :1980).
Nota: el riel Blumon (production/PaymentViewModel.kt:2013-2019) asigna sin ningún guard y su composable también lee previousBackStackEntry (NAV:1729-1730): el camino 2 aplica igual a PAX.

### arbol

Árbol de trabajo:
- VM:227-251 setSocketPaymentSource: mismo defecto (guards :243-244, reset :247).
- VM:877-984 initPayment · VM:1256/1279/1293 startCardPayment.
- VM:2576-2586 y :2689-2699 registro con amount/orderId de pending* y terminalPaymentRequestId=_socketRequestId.
- VM:3307-3330 retryAfterError: ahora limpia attemptId (:3316-3318) y se bloquea con desenlace incierto (:3311-3314).
- VM:3402-3436 emitCancelledIfAbandoned: ahora manda outcomeEvidence (:3433) = confirmedNegativeEvidence de A o PRE_AUTHORIZATION si A no lanzó autorización. Esas banderas NO se resetean al re-etiquetar. Por eso el «cancelled» falso de B sale con evidencia prestada de A.
- VM:763-773 chargeAttemptActive.
- NAV:420-447 ocupado / pop de pantalla vieja (igual) · NAV:449-486 escribe B y empuja (externalTipCents :466, paymentSource :480, socketRequestId :481).
- El handler de cancel se QUITÓ (N3): tras un cancel remoto la pantalla se queda, y salir con atrás del sistema deja los argumentos pegados con más frecuencia.
- NAV:1339 Cobrar sin limpiar · NAV:2775-2811 composable AngelPay igual · SCR:194-195 y :208 igual.
- RemotePaymentInbox.kt:92-97 markResolved acepta desde PROCESSING.
- SocketManager.kt:1999-2040 manda outcomeEvidence.

### servidor

Servidor del árbol, /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:

- «cancelled» falso de B (camino 1): closeRow (:1096-1172) acepta cancelled+PRE_AUTHORIZATION como acreditado (:1100) y deja B CANCELLED con cancelDisposition ACCEPTED (:1137). Libera la terminal y el POS suelta la llave aunque la pantalla de B siga viva. Con cancelled+PROCESSOR_DECLINED (la evidencia prestada de un rechazo de A) lo degrada a timeout, y B queda UNKNOWN y reservada. Si después se cobra B de verdad, closeRowFromPaymentTx lo reabre a COMPLETED con 🚨 «money moved despite cancel» (:1348).

- Payment con terminalPaymentRequestId=B pero importe y orden de A (registro por orden, payment.tpv.service.ts:2549-2560):
  - Si la fila B tiene orderId, closeRowFromPaymentTx filtra el Payment por orderId de la fila (:1219). No lo encuentra y sale con `if (!payment) return` (:1223), SIN log y SIN 🚨. B no se cierra. El pago se aplica a la orden de A, pero la fila de A tampoco se cierra, porque el Payment lleva B. La recuperación (findReconcilablePayment :1533-1573) también filtra por orderId y por la etiqueta processorData.terminalPaymentRequestId, que sólo escribe closeRowFromPaymentTx (:1283-1292). Nadie lo concilia nunca: dinero de A cobrado con las filas A y B diciendo «no cobrado».
  - Si B es venta rápida (sin orderId), sí la cierra: misma terminal (:1238-1262), COMPLETED + failureCode CONTRACT_MISMATCH (:1299-1314) + 🚨 contract mismatch (:1329). Queda detectado, pero la fila B apunta a un pago que era de A.

- Cobro local marcado B (camino 2) por /fast: recordFastPayment lee la fila B (payment.tpv.service.ts:3332-3410). Si trae orderId, resolveFastPaymentTarget (fastPaymentTarget.ts:67-78) delega a recordOrderPayment de la orden de B: el dinero del carrito local aterriza en la orden de B, con los productos, cliente y vendedor de B. Luego cierra B como COMPLETED con CONTRACT_MISMATCH si los importes difieren (:4023-4034 → :1299-1329). No verifiqué qué hace recordOrderPayment con una orden B ya CANCELLED.

### arregloPropuesto

Arreglo mínimo (TPV, main/ + el espejo del riel Blumon):
1. Un VM = una solicitud. En setSocketPaymentSource (VM árbol :243-247), si _socketRequestId ya no es null y llega OTRO id, ignorarlo con Timber.w (que llega a Crashlytics) y no tocar _socketResultEmitted. Mismo candado en production/sandbox PaymentViewModel.setSocketPaymentSource.
2. Leer los argumentos UNA vez por entrada. En el composable AngelPay (NAV árbol :2775-2811) y en el de Payment (NAV :1729), capturar el handle de la entrada anterior en el primer compose, con remember keyed por el id de la entrada, y dejar de releer `navController.previousBackStackEntry` en cada recomposición. Así la pantalla que sale nunca ve los argumentos del cobro siguiente. Esto elimina el camino 1 desde la raíz; el paso 1 queda como defensa en profundidad.
3. Argumentos remotos de un solo uso. Todas las entradas locales que empujan a getPaymentRoute (Cobrar NAV :1339, Mesas, TableCheckout, venta serializada) pasan por clearPaymentArgs antes de escribir, como ya hace prepareManualPaymentArgs. Y al salir la entrada de cobro por cualquier camino (incluido atrás del sistema, vía DisposableEffect/ON_DESTROY de la entrada), se borran del handle las claves de socket (paymentSource, socketRequestId, socketProcessedByStaffId, externalTipCents, externalRating, externalSkipReview, skipReview y orderId).
Servidor (opcional, defensa): que closeRowFromPaymentTx registre un 🚨 cuando el Payment trae terminalPaymentRequestId pero su orderId no coincide con la fila (hoy :1223 sale en silencio).

### pruebaPropuesta

1. AngelPayPaymentViewModelTest (JVM, falla hoy): `setSocketPaymentSource("SOCKET","A")` → `initPayment("260.00", orderId="ordA", externalTipCents=2600)` → dejar el estado en Error → `emitSocketResultForTest("failed")` → `setSocketPaymentSource("SOCKET","B")` → `emitCancelledIfAbandoned()`. Esperado: `socketRequestIdForTest() == "A"` y `verify(exactly = 0) { socketManager.emitTerminalPaymentResult("B", any(), …) }`. Hoy da "B" y emite cancelled para B. Espejo en PaymentViewModelTest (Blumon).
2. PaymentNavigationStateTest (JVM, ya existe para prepareManualPaymentArgs): un SavedStateHandle con claves de un remoto previo (paymentSource=SOCKET, socketRequestId=B, externalTipCents=2600, skipReview=true, orderId=ordB) → preparar los argumentos de Cobrar con payload Fast → deben desaparecer las claves de socket, propina externa, skipReview y orderId. Hoy sobreviven.
3. Instrumentada (androidTest, Compose + NavHost real): Home → cobro A llevado a Error → llega B por el colector → comprobar que el VM de A nunca recibe setSocketPaymentSource(B). Y el caso atrás del sistema sobre un remoto abierto desde Cobrar → el cobro local siguiente no lleva socketRequestId.
Sabotaje: quitar cada guard en una copia aislada tiene que tumbar exactamente su prueba. QA en la N86 real: B tapando un Error de A (camino 1) y un remoto sobre Cobrar con atrás del sistema (camino 2), leyendo logcat, la tabla TerminalPaymentRequest y el log del backend.

## 4. Revisión interna: hallazgos completos por frente

### A-factibilidad-TPV

Revisé el lado TPV de A (A.2–A.4) y de N3 (C.5) contra el árbol de trabajo real de avoqado-tpv, con apoyo puntual del servidor.

Respuestas a las preguntas del ángulo:
- ¿`RemotePaymentInbox` es el único escritor? Sí, en el código principal, pero sólo por convención. Todas las escrituras de `remote_payment_requests` pasan por el DAO, y al DAO sólo lo llama la bandeja: insert (`RemotePaymentInbox.kt:54,136`), markProcessingForVenue (`:86`, que llama el coordinador en `RemotePaymentCoordinator.kt:125`), markProcessing (`:89`; su llamador `claimSocketPaymentRequest` no tiene usos), markResolved (`:92`, vía `persistResult` desde `SocketManager.kt:2034`), resolveReceived (cancel `:104`, sonda `:154`, rejectUnclaimed `:170`) y replaceResolvedResult (`:184`).
  - Otras tres cosas borran la tabla sin pasar por el DAO: `FACTORY_RESET` (`CommandExecutor.kt:1068-1070`), el downgrade destructivo de Room (`DatabaseModule.kt:162`) y el manejador de corrupción de SQLite.
  - Lectores: getById, `observePendingObligationCount` (`DAO:14-24`, usado en `AppNavigation.kt:882`), las pruebas Room y la prueba de migración de androidTest (`AvoqadoDatabaseMigrationTest.kt:568-655`). LedgerApprovalRecovery, LedgerUnknownRecovery y LedgerShadowSweepWorker no tocan la tabla.
  - Qué se rompe con el centinela o el contador: el `markResolved` con lista negativa y el `receive` que rechaza estados desconocidos (hallazgo 6).
- Efectos visibles, todos detrás de un método suspend de la bandeja:
  - ACK: `SocketManager.kt:1545-1560`.
  - Disposición de cancel: `:1589-1593`.
  - Respuesta de la sonda: `:1621-1627`.
  - Resultado: `:2034-2050`; también llega por rejectUnclaimed y por `RemotePaymentPreAuthorizationFailure.kt:11`.
  - Arranque del SDK: tras el claim en `AppNavigation.kt:374-398`.
  - Por eso «commit → espejo → efecto» sí se puede garantizar, siempre que el espejo se escriba dentro de la bandeja antes de retornar.
- El socket conecta en `HomeViewModel.init` (`:242`) y en el login (`LoginViewModel.kt:161`) sin esperar ninguna verificación. `connect()` no es suspend y fija el `auth` una sola vez (`SocketManager.kt:203-215`). La librería socket.io-client 2.1.1 reenvía ese mismo mapa en cada reconexión automática, y el servidor relee el handshake y lanza replay y sonda en cada conexión (`socketManager.ts:189-236`). De ahí salen los hallazgos 3 y 5.
- Migración v34: no choca por número. `main` está en v33 y la v32 de `develop` es idéntica a la de `main`; `codex/payment-safety-phase-0` tiene otra v31, pero no está desplegada. El problema real es que el dato del §0 es falso: el downgrade destructivo está activo (hallazgo 4).
- Cerca y CAS: se pueden implementar. `reserveTerminal` es un único INSERT…SELECT, y el cancel cabe en `withTransaction`. No rompen el reintento tras rechazo, pero justamente por eso dejan abiertos dos caminos de dinero (hallazgos 1 y 2).

En corto: el lado TPV del diseño se puede construir, pero tiene cuatro defectos de dinero o de bloqueo:
1. La cancelación desde la tablet no cubre el momento más común, cuando la tarjeta ya se rechazó y la terminal ofrece «Reintentar».
2. Un «no se cobró» que el servidor da por definitivo todavía puede convertirse en cobro desde la terminal.
3. La primera reconexión por reposo de la batería mata la identidad de la bandeja para siempre.
4. El diseño cree que volver a un APK anterior conserva los datos, y no es así.

Necesito que decidan tres cosas antes de programar:
- si el «Reintentar» de un cobro remoto ya rechazado sigue existiendo;
- si C.5 se hace sin cambiar el esquema de la base;
- si el handshake lleva un identificador por arranque del proceso.

#### 1. [P1] El CAS del cancel no cubre el estado «entre intentos» (rechazo reintentable): el cajero cancela en la tablet y la terminal cobra igual

- **Sección:** C.5 (N3)
- **Escenario:** Nexgo recibe el cobro remoto R. El cliente acerca la tarjeta por encima del límite contactless y sale E608 (aviso EMV reintentable). AngelPay pasa la libreta a DESCARTADA, no emite resultado, deja la fila de la bandeja en PROCESSING y muestra Error con «Reintentar». El cajero de la tablet toca Cancelar.

C.5 sólo acepta dos casos: una fila PREPARANDO correlacionada, o PROCESSING SIN fila de libreta. Aquí hay una fila DESCARTADA, así que el cancel responde ACTIVE y no se pone la cerca.

El cajero de la terminal inserta el chip y toca Reintentar. Se abre un intento nuevo, `reserveTerminal` pasa (sólo mira lápida o cancel aceptado) y la terminal cobra. El POS está en «Cancelación pendiente»; si el cliente ya pagó en efectivo, se le cobra dos veces. Este es el momento en que un cajero más probablemente cancela (problema con la tarjeta).

Lo mismo ocurre en Blumon tras un rechazo del kernel contactless.
- **Evidencia:** `AngelPayPaymentViewModel.kt:2076` markHostResponded(approved=false) ⇒ DESCARTADA (`PaymentAttemptLedger.kt:169`).
`:2134` confirmedNegativeOutcome=true.
`:2170-2190` Error canRetry=true, aviso EMV retenido sin emitir.
`:3307-3320` retryAfterError lo permite y anula el attemptId (intento nuevo).
`RemotePaymentInbox.kt:100-113` el cancel sobre PROCESSING responde ACTIVE.
`PaymentAttemptDao.kt:71-92` la reserva no mira la bandeja.
Blumon sandbox `PaymentViewModel.kt:5582-5592` markKernelRefused ⇒ DESCARTADA y Error «Preserve context for smart retry».
Diseño C.5, líneas 317-320.
- **Arreglo propuesto:** Ampliar la condición de aceptación de C.5:
- La fila está PROCESSING y fue reclamada en este proceso.
- No tiene `execution_started_at`.
- TODAS las filas de libreta correlacionadas (instr sobre `terminalPaymentRequestId`) están en PREPARANDO (se pasan a DESCARTADA en la misma transacción) o en DESCARTADA.
- Ninguna está en KERNEL_ACTIVO…REGISTRO_FALLIDO, REGISTRADO, ENTREGADA_A_COLA o CERRADA.

Si se cumple: poner la cerca, cancelar el temporizador `programarCierreDeCobroAbandonado` y persistir un `cancelled` con evidencia PROCESSOR_DECLINED si algún intento llegó al host, o PRE_AUTHORIZATION si no (igual que ya hace el cierre por abandono en `:2386-2390`).

Pruebas: E608 → cancel ⇒ ACCEPTED ⇒ Reintentar rechazado por la cerca. Lo mismo para el rechazo del kernel en Blumon, en las dos variantes.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No pude refutarlo. El escenario coincide con el código del árbol de trabajo y con el texto de C.5.

(1) E608 está en la lista de rechazos confirmados del clasificador. Por eso la libreta pasa por markHostResponded(approved=false) y queda en DESCARTADA.
(2) El VM de AngelPay no emite resultado para un aviso EMV recuperable. Deja la fila de la bandeja en PROCESSING y muestra Error con canRetry=true.
(3) retryAfterError sólo se bloquea si el desenlace es incierto. Aquí confirmedNegativeOutcome=true, así que deja pasar el reintento y anula el attemptId, lo que produce un intento nuevo.
(4) C.5 acepta el cancel en dos casos, y este no cabe en ninguno. El CAS PREPARANDO→DESCARTADA no encuentra ninguna fila en PREPARANDO, y la rama «PROCESSING sin fila de libreta» tampoco aplica porque sí hay fila (la DESCARTADA). Lo mismo pasa con cualquier lectura de «sin filas bloqueadoras». Por eso el cancel responde ACTIVE y la cerca, que depende de cancel_accepted_at, nunca se pone.
(5) reserveTerminal no incluye DESCARTADA entre los estados que retienen la terminal, así que el siguiente toque a Tarjeta cobra.

En Blumon (sandbox y production con los mismos hunks) pasa lo mismo. markKernelRefused deja la fila en DESCARTADA, PaymentState.Error trae canRetry=true por defecto, y el observador del socket mantiene pendiente la solicitud en los errores reintentables. Blumon además no tiene temporizador de abandono.

Hay otra incoherencia que refuerza el hallazgo. Con la libreta apagada, markHostResponded no escribe, y el mismo estado caería en la rama «sin fila», que sí se acepta. O sea, el resultado depende del modo de la libreta y no de la evidencia.

Mantengo P1. Es el mismo defecto N3 que la regla marca 🔴 («el cliente puede pagar un cobro que el cajero ya canceló»), y queda abierto justo en la ventana donde cancelar es más probable: hubo un problema con la tarjeta y la terminal ofrece «Reintentar» sin ningún aviso, porque sólo se avisa cuando el cancel se acepta. Hay un atenuante que no baja la severidad. El sistema registra bien el cobro tardío: el servidor lo concilia a COMPLETED y el POS lo aplica como «se cobró». El doble cobro al cliente requiere que se cobre otra vez por otro medio. Pero el servidor móvil de efectivo no consulta TerminalPaymentRequest, y C.4 no bloquea ventas nuevas mientras la cancelación está pendiente. Es el mismo patrón de doble cobro con intervención humana del incidente del 14-jul.
  - Evidencia: TPV (árbol de trabajo):
- `AngelPayOutcomeClassifier.kt:69-73`: E608 está en CODIGOS_RECHAZO_CONFIRMADO, y `:97` devuelve RECHAZADO_CONFIRMADO.
- `AngelPayPaymentViewModel.kt:2084-2092`: markHostResponded(approved=false) cuando no hay forma de sesión expirada.
- `PaymentAttemptLedger.kt:169`: approved=false se convierte en STATE_DESCARTADA.
- `AngelPayPaymentViewModel.kt:2148`: confirmedNegativeOutcome=true. En `:2149` la evidencia de E608 queda en PRE_AUTHORIZATION (no está en G500/G504/E605/E606).
- `AngelPayPaymentViewModel.kt:2178-2204`: Error(canRetry=true). isRecoverableEmvAdvisory retiene el resultado sin emitir y llama a programarCierreDeCobroAbandonado.
- `AngelPayPaymentViewModel.kt:1942-1948`: segundo sitio con el mismo patrón.
- `AngelPayPaymentViewModel.kt:3321-3339`: retryAfterError sólo bloquea si el desenlace es incierto; anula currentPaymentAttemptId y ledgerOpenedAttemptId y cancela el temporizador de abandono.
- `RemotePaymentInbox.kt:99-112`: cancel() sólo acepta RECEIVED; en PROCESSING devuelve ACTIVE.
- `PaymentAttemptDao.kt:71-92`: la reserva de reserveTerminal sólo mira PREPARANDO…REGISTRO_FALLIDO/INDETERMINADO; no incluye DESCARTADA ni la bandeja.
- El contexto de la libreta lleva terminalPaymentRequestId (`AngelPayPaymentViewModel.kt:602`), así que la correlación con instr es posible.

Blumon:
- sandbox `PaymentViewModel.kt:5582-5592` y production `:4799`: markKernelRefused (`PaymentAttemptLedger.kt:308-317`, PREPARANDO/KERNEL_ACTIVO → DESCARTADA) y después Error con contexto para reintentar.
- `PaymentState.kt:452-455`: canRetry=true por defecto.
- sandbox `PaymentViewModel.kt:1456-1460`: «Retryable error reached, keeping Android request pending».

Diseño:
- `diseno-A-B-seccion8-2026-09-11.md:317-320`: sólo PREPARANDO→DESCARTADA o PROCESSING sin fila con prueba de propiedad; si no, ACTIVE; la cerca exige cancel aceptado.
- `:325-326`: el aviso en pantalla sólo existe cuando el cancel se aceptó.

Servidor:
- Las rutas de efectivo móvil no consultan TerminalPaymentRequest (grep en `src/services/mobile` sin resultados).
  - Arreglo corregido: Ampliar C.5 con un tercer caso aceptable: «entre intentos». Se decide en UNA transacción Room junto con la bandeja:
- La fila de la bandeja está en PROCESSING, del mismo venue, sin lápida y sin execution_started_at.
- Existe al menos una fila de libreta correlacionada (instr sobre terminalPaymentRequestId).
- TODAS las correlacionadas están en DESCARTADA o en PREPARANDO. Las PREPARANDO pasan a DESCARTADA en la misma transacción.
- Ninguna está en KERNEL_ACTIVO, AUTORIZANDO, INDETERMINADO, HOST_RESPONDIO, AUTORIZADO, REGISTRO_FALLIDO, REGISTRADO, ENTREGADA_A_COLA o CERRADA.

En este caso NO hace falta exigir «reclamada en este proceso». La fila DESCARTADA ya es evidencia durable de que no se cobró; exigirlo sólo rechazaría el cancel tras un reinicio sin ganar seguridad. La prueba de propiedad se queda sólo para la rama sin filas.

Si se cumple:
- Escribir cancel_accepted_at y resolver la fila con un «cancelled» durable, en la misma transacción.
- La evidencia NO se infiere del estado de la libreta, porque DESCARTADA no distingue un aviso EMV de una declinación del host. Se toma de la clasificación del intento: persistir la evidencia negativa en la fila de libreta al marcarla (en E608 hoy el VM calcula PRE_AUTHORIZATION) y usar la del último intento.
- El evento local lleva ACCEPTED al VM. En AngelPay, cancelarCierrePorAbandono(), marcar _socketResultEmitted y pasar a Cancelado sin «Reintentar». En Blumon, pasar a PaymentState.Cancelled, para que el observador no emita otro resultado distinto.
- La cerca debe comprobarse DENTRO del INSERT…SELECT de reserveTerminal (NOT EXISTS de una fila de bandeja con cancel_accepted_at o lápida para ese terminalPaymentRequestId), no con una lectura previa. Si no, un reintento y un cancel simultáneos pueden ganar los dos.
- Si el reintento ya llegó a KERNEL_ACTIVO o más allá ⇒ ACTIVE, como hoy.

Aparte, dar a Blumon un cierre por abandono equivalente al de AngelPay: hoy su ventana queda abierta hasta el vigía del servidor.

Pruebas (con sabotaje):
- AngelPay: E608 → cancel ⇒ ACCEPTED, y el siguiente toque a Tarjeta es rechazado por la cerca.
- Cancel concurrente con un reintento que ya reservó PREPARANDO ⇒ ACCEPTED y el intento descartado.
- Cancel con reintento en KERNEL_ACTIVO ⇒ ACTIVE.
- Blumon, rechazo del kernel contactless, en sandbox y production con los mismos hunks.
- Tras reiniciar el proceso con la fila DESCARTADA ⇒ ACCEPTED.
- Libreta apagada: mismo resultado que con libreta encendida, sin depender del modo.

#### 2. [P1] El NOT_CHARGED canónico no es definitivo: la TPV reintenta la MISMA solicitud después de emitir failed+PROCESSOR_DECLINED

- **Sección:** C.1 / C.4 / C.5
- **Escenario:** Cobro remoto R ligado a una orden que creó el flujo del POS.

1. El banco rechaza (G500). AngelPay emite failed+PROCESSOR_DECLINED y el servidor pone FAILED; con C.1 eso es NOT_CHARGED.
2. En el POS, C.4 cancela o borra la orden y el cajero cobra en efectivo.
3. En la terminal, el otro cajero vuelve a insertar la tarjeta y toca Reintentar. El intento nuevo lleva el mismo `terminalPaymentRequestId` y el cobro se aprueba.
4. El éxito reemplaza al failed en la bandeja, pero no se reemite por el socket. El Payment se registra por REST sobre la orden CANCELADA: `recordOrderPayment` no filtra por estado. Si la orden se borró, cae como venta rápida por ORDER_NOT_FOUND.
5. El servidor reconcilia FAILED→COMPLETED con 🚨.

Resultado: tarjeta más efectivo, y un registro sobre una orden cancelada.
- **Evidencia:** `AngelPayPaymentViewModel.kt:2135` evidencia PROCESSOR_DECLINED.
`:2193` emite failed.
`:2170-2173` canRetry=true.
`:3339-3346` el `_socketRequestId` sobrevive a propósito para el reintento.
`:715` el contexto del intento nuevo lleva `terminalPaymentRequestId`.
`:3358` `_socketResultEmitted` impide reemitir el éxito.
`RemotePaymentInbox.kt:179-186` un success reemplaza al failed.
Servidor: `terminal-payment.service.ts:1348` FAILED→COMPLETED «money moved despite cancel/close».
`payment.tpv.service.ts:2102-2109` busca la orden sólo por id y venue.
Diseño C.1 líneas 260-262, C.4 líneas 290-296.
- **Arreglo propuesto:** Escoger una de dos opciones y escribirla en el diseño.

(a) Cerrar el reintento: cuando un resultado no-success de una solicitud remota queda persistido, `reserveTerminal` rechaza cualquier intento nuevo con ese `terminalPaymentRequestId` (la cerca también sobre RESOLVED no-success). La pantalla dice «Pide al POS que vuelva a enviar el cobro».

(b) Conservar el reintento en sesión: el rechazo duro de un cobro remoto no emite failed; se retiene como el aviso E608, con cierre por abandono. Al emitir, se aplica la cerca.

En las dos: para solicitudes remotas, que un success no reemplace en silencio a un resultado ya emitido (🚨 y revisión). Verificar el mismo patrón en Blumon. Prueba: rechazo → Reintentar ⇒ sin nuevo intento, o POS en UNRESOLVED hasta el abandono.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No pude refutarlo. Revisé cada paso contra el árbol de trabajo. En AngelPay, un rechazo del banco se reporta como definitivo, pero la terminal conserva el botón «Reintentar» sobre la MISMA solicitud remota. Si ese reintento se aprueba, el Payment viaja con el mismo terminalPaymentRequestId y el servidor pasa la fila de FAILED a COMPLETED; sólo deja un log 🚨. Con C.1, esa fila FAILED+PROCESSOR_DECLINED se proyecta como NOT_CHARGED canónico. C.4 actúa sobre ese resultado: da el cobro por no hecho y cancela o borra la orden. El diseño no dice nada de este reintento. Su única cerca (C.5, en reserveTerminal) cubre lápida y cancel aceptado, no un resultado no-success ya emitido.

Hay tres correcciones al escenario.
(1) El paso 4 es falso en AngelPay. El éxito NO reemplaza al failed en la bandeja. El guard `_socketResultEmitted` corta la llamada antes de llegar a `SocketManager.emitTerminalPaymentResult` → `persistResult`. La bandeja se queda con «failed» aunque sí se cobró, y eso empeora la sonda y el replay. El reemplazo de `persistResult` sólo se alcanza si alguien emite.
(2) El daño no depende de C.4. Si el cajero cobra en efectivo sobre la MISMA orden, sin cancelarla, el reintento aprobado deja tarjeta más efectivo igual. El defecto ya existe hoy: el propio código lo describe como flujo diseñado. C.1 y C.4 lo agravan: certifican NOT_CHARGED y automatizan la cancelación o el borrado.
(3) Blumon NO sigue el mismo patrón. Un error con canRetry=true retiene el resultado sin emitir. Uno no reintentable emite failed y limpia `_socketRequestId`. Es un defecto de AngelPay, y Blumon ya aplica la opción (b).

El escenario es realista. No hay reloj de abandono para un rechazo normal: en la rama que no es E608, la pantalla de Error con Reintentar queda puesta indefinidamente. El gesto natural es «intenta con otra tarjeta» en la misma terminal, y ya pasó en Amaena, donde reintentaron a ciegas y aprobó al segundo intento. Otra variante: si el POS reenvía una solicitud nueva después del reintento aprobado, puede haber un segundo cargo con tarjeta. Se mantiene P1: es dinero cobrado dos veces y un contrato canónico que es falso.
  - Evidencia: TPV AngelPayPaymentViewModel.kt, árbol de trabajo:
- :2135 `confirmedNegativeEvidence = ... "PROCESSOR_DECLINED"` para G500, G504, E605, E606 y el código vacío.
- :2185-2188 `Error(canRetry = true)`.
- :2204-2206 fuera de E608 emite `failed` con PROCESSOR_DECLINED. No se programa cierre por abandono (`programarCierreDeCobroAbandonado` sólo corre en la rama E608, :2202).
- :3321-3343 `retryAfterError()` pasa la guarda porque `confirmedNegativeOutcome = true`. Pone `currentPaymentAttemptId = null` (intento nuevo ante el procesador) y NO toca `_socketRequestId`.
- :464-478 el id y la bandera de emitido viven en SavedStateHandle. El comentario dice que el id sobrevive a propósito para el «retry-after-decline … cashier retries ON THE TERMINAL → card APPROVED».
- :717 el contexto del intento nuevo lleva `terminalPaymentRequestId = _socketRequestId`.
- :724-725 `markAuthorizing` reinicia `confirmedNegativeOutcome = false`.
- :3371-3375 `if (_socketResultEmitted) … skipping`: el éxito no se reemite ni se persiste.

SocketManager.kt:2033-2034 `persistResult` sólo se llama dentro de `emitTerminalPaymentResult`. Por eso RemotePaymentInbox.kt:179-186 (el success reemplaza al failed) es inalcanzable en este camino.

PaymentAttemptDao.kt:69-86 `reserveTerminal` bloquea por estados de la libreta y por `orderId`, nunca por `terminalPaymentRequestId`. El intento rechazado sale del conjunto de bloqueo y el nuevo reserva sin problema.

Blumon sandbox PaymentViewModel.kt:1463-1479 con canRetry retiene el resultado sin emitir; uno no reintentable emite y hace `_socketRequestId = null`.

Servidor:
- terminal-payment.service.ts:1339-1352 FAILED, CANCELLED o CANCEL_REQUESTED → COMPLETED, sólo con `logger.error 🚨`.
- :217-223 `UNRESOLVED_FINANCIAL_OUTCOME` sólo cuenta FAILED con ACK_TIMEOUT, ACK_REJECTED o TPV_ERROR. Un FAILED por rechazo no bloquea `cancelOrder` (:1379-1392).
- payment.tpv.service.ts:2102-2109 busca la orden sólo por id y venue, sin filtrar por status. En la transacción (2300-2420) no hay chequeo de CANCELLED. Una orden inexistente da ORDER_NOT_FOUND (:2135), y la TPV cae a venta rápida.

Diseño:
- C.1 (líneas 260-262) FAILED con código de lista blanca ⇒ NOT_CHARGED.
- C.4 (290-296) NOT_CHARGED acreditado ⇒ borrar la orden.
- C.5 (líneas 324-325) la cerca sólo cubre lápida y cancel aceptado.
- En todo el diseño no aparece «Reintentar» dentro de un cobro remoto rechazado, salvo la sospecha D.7, que es otro caso.
  - Arreglo corregido: Escribirlo en el diseño como invariante: «un resultado no-success que la TPV ya EMITIÓ para una solicitud remota es final para esa solicitud».

Recomendación: la opción (a), porque es la única que mantiene cierto el NOT_CHARGED canónico de C.1.
1. En AngelPayPaymentViewModel.retryAfterError(): si `_paymentSource == "SOCKET"` y `_socketResultEmitted`, NO se inicia otro intento. Se hace resetPayment y la pantalla dice «Este cobro lo pidió el POS y ya se le avisó que fue rechazado. Pide al POS que vuelva a enviarlo».
2. Cerca durable, la misma que C.5 extendida: `reserveTerminal` rechaza un intento cuyo `terminalPaymentRequestId` tenga en la bandeja una fila RESOLVED con resultado no-success. Hoy el id sólo está en `payment_context_json`: usar un fragmento `instr` como el de `orderId`, o una columna en la migración v34 que ya se planea. Cubre la VM recreada y cualquier otro camino.

La opción (b), retener el failed como Blumon y como E608 con cierre por abandono, es aceptable si el founder prefiere conservar el reintento en sesión. Cuesta que el POS espere en UNRESOLVED hasta el abandono, y el cierre debe emitir failed sólo si no arrancó otro intento.

En las dos opciones:
(i) Servidor: un Payment con terminalPaymentRequestId sobre una fila FAILED o CANCELLED sigue conciliándose (el dinero se movió), pero `desenlaceCanonico` debe devolver CHARGED con `reconciliationRequired = true`. Además, asiento durable en ActivityLog, no sólo el log 🚨.
(ii) El coordinador de C.4 debe tolerar NOT_CHARGED → CHARGED después de haber cerrado: banner «Se cobró después de cancelar: revisar», nunca un descarte silencioso.
(iii) recordOrderPayment sobre una orden CANCELLED debe registrar y marcar para revisión, sin rechazar (hay dinero cobrado).
(iv) Nota: Blumon ya retiene los errores reintentables; sólo falta verificar que un rechazo no reintentable no quede con Reintentar en pantalla.

Prueba TDD en la TPV: rechazo G500 remoto → retryAfterError ⇒ sin openAttempt nuevo y sin reserva. Con la VM recreada y la bandeja en RESOLVED failed ⇒ reserveTerminal = -1. Sabotaje: quitar la cerca hace fallar las dos pruebas.

#### 3. [P1] El handshake congelado choca con COUNTER_REGRESSION: la primera reconexión por Doze tras una liberación descontinúa la bandeja para siempre y deja la terminal reservada

- **Sección:** A.4 / A.5 / A.8 / A.10
- **Escenario:** 1. La app arranca y el handshake lleva contador 10.
2. Se pierde el ACK de R. La sonda recibe NOT_FOUND con lápida y contador 14; A.8 libera R y sube la marca a 14.
3. Doze corta el socket y la librería reconecta sola con el mismo `auth` (contador 10).
4. A.5: ACTIVE con contador menor que la marca ⇒ DISCONTINUED(COUNTER_REGRESSION), 🚨 falsa y alerta a ops, socket no confiable. «Nunca se reactiva», y la terminal no rota porque localmente todo cuadra (S = M).
5. Desde ahí, A.9 no reentrega nada entregado a X y ningún NOT_FOUND libera: el siguiente ACK perdido deja la terminal reservada hasta una conciliación B manual.

Con las reconexiones por Doze medidas en Testarudo, esto pasa justo después de la primera vez que A funciona. Si el ACK o la disposición también suben la marca (A.4 los envía), pasa a diario.

A.4 llama al valor congelado «cota inferior», pero A.5 y A.10 exigen COUNTER_REGRESSION por handshake: el diseño se contradice.
- **Evidencia:** `SocketManager.kt:203-215` el `auth` se arma una vez con buildMap.
`:218-223` reconexión automática de la librería (socket.io-client 2.1.1, `build.gradle.kts:704`), que reenvía el mismo `opts.auth` en cada CONNECT.
Servidor `socketManager.ts:189-236`: re-registro, replay y sonda en cada conexión.
Diseño: A.4 líneas 91-92 (cota inferior) contra A.5 línea 109 (regresión), A.8 paso 5 líneas 137-138 (sube la marca), A.10 línea 169, A.9 línea 152 (exige socket confiable).
- **Arreglo propuesto:** - Agregar `terminalPaymentInboxBootId` (aleatorio por proceso) al handshake. El servidor sólo evalúa regresión cuando cambia el bootId; con el mismo bootId el contador es cota inferior y nunca descontinúa.
- Además, refrescar el contador en cada reconexión con un mapa `auth` mutable, actualizado en `Manager.EVENT_RECONNECT_ATTEMPT` con el S durable actual (nunca menor que lo ya reportado).
- Pruebas nuevas: liberación → reconexión automática del mismo proceso ⇒ sigue ACTIVE y confiable; proceso nuevo con contador menor que la marca ⇒ COUNTER_REGRESSION.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No se puede refutar. El diseño se contradice a sí mismo, y el código actual confirma que el escenario ocurre.

A.4 dice que en las reconexiones automáticas el contador del handshake llega congelado y que el servidor lo toma como «cota inferior». Pero A.5 aplica a TODA conexión la regla «ACTIVE con contador menor que la marca ⇒ DISCONTINUED(COUNTER_REGRESSION)». Y A.10 («copia antigua, mismo id») exige justo esa regla en el handshake. El servidor no tiene forma de distinguir una reconexión del mismo proceso de un proceso nuevo, porque nada en el handshake lo dice.

La marca sube por encima del valor congelado en cuanto A funciona: A.8, paso 5, «sube la marca» al contador del evento, y ese contador ya incluye la escritura de la lápida, así que es al menos el valor del arranque más 1. Desde ese momento, la siguiente reconexión automática (Doze, cierre del transporte, ping timeout) manda el contador viejo y el servidor la descontinúa.

Tres cosas agravan el daño:
- A.5 dice «nunca se reactiva».
- La TPV sólo rota por inconsistencias locales al arrancar (A.3), y aquí S = M, así que no rota. Tampoco hay ninguna señal del servidor que la haga rotar. La identidad queda descontinuada hasta un FACTORY_RESET o una pérdida de datos. Si la app se reinicia, vuelve con el mismo inboxId y sigue descontinuada.
- A.9 exige un socket confiable para reentregar. Eso significa que se pierde también el replay DURABLE que el plan D sí hace hoy: la terminal queda PEOR que la línea base. Una entrega perdida en una reconexión ya no se reentrega, vence y queda como UNKNOWN. Y ningún NOT_FOUND la libera, porque A.6 guarda inboxTrusted=false y A.8, regla 2, lo exige verdadero. Termina reservada hasta la conciliación B manual.

Se suman una 🚨 falsa y una alerta a ops cada vez.

No hay riesgo de cobro doble (falla del lado seguro), pero anula la recuperación automática que decidió el founder justo después de su primer éxito, y le quita a Testarudo el replay que hoy funciona. Por eso sostengo P1.

Matiz a la versión del revisor: con el diseño tal como está, ni el ACK ni la disposición suben la marca. Sólo la suben el handshake y A.8. Así que el defecto no ocurre «a diario» sin A: aparece a partir de la primera liberación por A. Sí pasaría a diario si la implementación usara también el inboxCounter del ACK o de la disposición que manda A.4.
  - Evidencia: TPV, `SocketManager.kt:203-215`: `auth = buildMap {...}` se arma una sola vez dentro de `connect()`, con `reconnection=true` y `reconnectionAttempts=Int.MAX_VALUE` (`:218-223`).
- `onDisconnect` (`:579-584`) sólo emite Disconnected: no reconstruye el socket.
- Las reconstrucciones explícitas son sólo `connect()` y `reconnectWithFreshToken` (`HomeViewModel.kt:608` al refrescar el token, `:659` al restaurar sesión). Por eso Doze y el cierre del transporte pasan por la reconexión automática de la librería.

Librería `io.socket:socket.io-client:2.1.1` (`build.gradle.kts:704`), fuente del jar en la caché de Gradle:
- `Socket.java:61,74`: `this.auth = opts.auth` (guarda la referencia al mapa).
- `:269-273`: `onopen()` manda `new JSONObject(this.auth)` en cada apertura.
- `:83-86`: onopen se engancha a `Manager.EVENT_OPEN`, que se dispara también en cada reconexión.
- `Manager.java:505`: emite `EVENT_RECONNECT_ATTEMPT` justo antes de `self.open(...)`.
Conclusión: cada reconexión automática reenvía el mismo contador congelado.

Servidor, `socketManager.ts:183-236`: cada CONNECTION hace lo mismo (`terminalRegistry.register` más `replayPendingForTerminal` y `probeUnresolvedForTerminal`), sin distinguir la reconexión del arranque. Ahí iría `observeInboxIdentity` según A.5.

Diseño:
- A.4, líneas 89-91: valor congelado = «cota inferior».
- A.5, líneas 105-111: la regresión se evalúa al conectar; DISCONTINUED «nunca se reactiva»; socket no confiable.
- A.8, líneas 137-138: «sube la marca» al contador del evento.
- A.9, líneas 150-152: el replay exige socket confiable.
- A.10, línea 169: COUNTER_REGRESSION por handshake.
- A.3: la TPV sólo rota con S≠M al arrancar; no existe un camino del servidor a la TPV que la haga rotar.
- La auditoría parcial de Codex (`codex-auditoria-diseno-A-B-s8-RESULTADO-parcial.md`) no lo menciona.
  - Arreglo corregido: 1. **Principal: `terminalPaymentInboxBootId`** en el handshake. Es un UUID aleatorio por proceso, generado después de la verificación de A.3.
   - El servidor guarda `lastBootId` en `TerminalPaymentInbox`.
   - Con el MISMO bootId, el contador del handshake es cota inferior: sube la marca si es mayor y nunca descontinúa.
   - Sólo cuando el bootId CAMBIA se compara contra `maxCounterObserved` completo, incluida la marca que subió A.8. Esa comparación es correcta: todo contador que la TPV reportó ya estaba en Room y en el espejo con fsync, así que un proceso nuevo con la base intacta arranca con S ≥ cualquier valor reportado. Un S menor sólo sale de una copia restaurada o de una transacción perdida.
   - La restauración de una copia exige reiniciar el proceso (Room está abierta), así que siempre llega con un bootId nuevo.
   - Hay que corregir la redacción de A.4, A.5 y A.10 para que no se contradigan.

2. **Refuerzo opcional:** refrescar el contador en cada reconexión automática.
   - Usar un mapa `auth` MUTABLE, porque el de `buildMap` queda de sólo lectura y `put` lanzaría excepción.
   - Actualizarlo en `socket.io().on(Manager.EVENT_RECONNECT_ATTEMPT)` con el último contador ya persistido y con fsync, leído de un valor en memoria que mantiene `RemotePaymentInbox`. No consultar Room en el hilo de eventos.
   - Nunca poner un valor menor que el ya reportado.
   - Por sí solo no basta sin el bootId: la versión de A.8 hoy no lo garantiza, y además lo explícito es mejor que depender de una carrera.

3. **Endurecimiento:** que una descontinuación no deje la terminal peor que el plan D.
   - El servidor avisa a la TPV (en la respuesta del connect, o con un evento) que su identidad está descontinuada, y la TPV rota (A.3, con cuarentena) en vez de vivir como no confiable para siempre.
   - Mientras el socket no sea confiable, el replay de filas DURABLE que no llevan identidad no debe quedar peor que en el plan D.

4. **Pruebas nuevas:**
   - En integración: liberación por A.8 → handshake del mismo bootId con el contador original, menor que la marca ⇒ sigue ACTIVE y confiable, sin 🚨, y el replay funciona.
   - bootId nuevo con contador menor que la marca ⇒ COUNTER_REGRESSION.
   - bootId nuevo con contador mayor o igual a la marca ⇒ ACTIVE.
   - En la TPV: el mapa de auth refleja el contador actual en `EVENT_RECONNECT_ATTEMPT`, y el bootId se conserva entre reconexiones y cambia al reiniciar el proceso.
   - Física: un Doze forzado (`dumpsys deviceidle force-idle` y luego `unforce`) después de una liberación por A, en la PAX.

#### 4. [P1] El §0 es falso: el downgrade de Room ES destructivo, y la v34 de C.5 vuelve destructivo el rollback del APK nuevo (borra cobros aprobados sin registrar)

- **Sección:** §0 / A.2 / A.9 / C.5 (v34) / F.2
- **Escenario:** El APK nuevo (base v34 por C.5) tiene dos cobros con tarjeta aprobados en `pending_payments` porque el internet está malo. Aparece un defecto y se revierte a 2.9.2 (v33) con INSTALL_VERSION. Room destruye `pending_payments`, `payment_attempts`, `pending_refunds` y la bandeja: cobros hechos sin registro. Sin la v34, ese mismo rollback sería v33→v33 y no borraría nada.

Además, INSTALL_VERSION no borra la activación, así que la app bajada reconecta en segundos. Eso agranda el riesgo residual que declara A.9 («un borrado también quita la activación»): entre dos APK con bandeja durable y distinta versión de base, la bandeja queda vacía con el token vivo, y el plan D reentrega filas SENT dentro de los 5 minutos ⇒ puede reejecutar.

Y la razón que da A.2 para poner el centinela en la misma tabla no es lo que hace Room: al bajar a un APK que no conoce `remote_payment_requests`, la bandeja y el centinela sobreviven mientras la libreta y las colas se borran.
- **Evidencia:** `DatabaseModule.kt:147-162` `.fallbackToDestructiveMigrationOnDowngrade()`, cuyo propio comentario dice «This will DELETE all local data including pending_payments».
`CommandExecutor.kt:1059` sólo FACTORY_RESET borra SecureStorage; INSTALL_VERSION no.
Room 2.7.0 (`build.gradle.kts:753`): la variante sin argumento sólo borra las tablas que conoce la app vieja.
Servidor `terminal-payment.service.ts:182-185` y `964-969`: el replay incluye SENT.
Diseño §0 línea 29, A.2 líneas 47-49, A.9 líneas 157-158, C.5 línea 321.
- **Arreglo propuesto:** - Corregir el §0.
- Hacer C.5 sin cambio de esquema, con estados nuevos en `status` como ya se hizo con la lápida (p. ej. `CANCEL_ACCEPTED` y `EXECUTING_NON_CARD`), e incluirlos en el conteo de obligaciones. Así el rollback a 2.9.2 no es un downgrade de base.
- Agregar a F: no hay INSTALL_VERSION hacia una base menor mientras haya colas o libreta abiertas (lo bloquean el servidor y la terminal), o bien retirar `fallbackToDestructiveMigrationOnDowngrade`.
- Declarar en A.9 el riesgo por downgrade con la activación viva.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: El núcleo del hallazgo se sostiene; dos de sus ramas secundarias no.

CONFIRMADO:
(1) El §0 del diseño es falso. `DatabaseModule.kt:162` tiene `.fallbackToDestructiveMigrationOnDowngrade()`. Está así en el árbol de trabajo y en HEAD desde el commit 2b261cd. El comentario de :151 dice «This will DELETE all local data including pending_payments». El CHANGELOG-archive-3:163 dice que se conservó a propósito «para rollback vía INSTALL_VERSION». El dashboard avisa de pérdida de datos en todo downgrade (`tpv.json` `downgradeWarningTitle`/`downgradeDataLoss1` «Pending payments not synced will be lost»). La propia regla auditada (`cobro-remoto-pos-a-tpv.md`) ya dice «downgrade por INSTALL_VERSION, que es destructivo». O sea, el diseño contradice al código y a la regla.

(2) La v34 de C.5 es lo que vuelve destructivo el rollback del APK nuevo. 2.8.8 (106), 2.9.1 (105) y 2.9.2 (107) están todas en Room v33, y v33 ya conoce `pending_payments`, `payment_attempts`, `pending_refunds` y `remote_payment_requests` (@Database de HEAD). Un rollback de v34 a 2.9.2 cruza la versión de esquema. El flag que decide es el del APK VIEJO (2.9.2 lo tiene), así que Room tira y recrea esas tablas: los cobros aprobados sin registrar se pierden. Sin la v34 el rollback sería v33→v33, sin migración ni borrado. El centinela de A no toca el esquema, así que C.5 es el único cambio de esquema del diseño.

(3) INSTALL_VERSION no borra la activación. Sólo FACTORY_RESET llama `secureStorage.clearAll()` (CommandExecutor ~:1059), y Room no toca SharedPreferences. La justificación de A.9 («un borrado también quita la activación») no vale para un downgrade.

LO QUE NO SE SOSTIENE O ESTÁ SOBREDIMENSIONADO:
(a) El disparador concreto «revertir con INSTALL_VERSION» no está demostrado en producción. `executeInstallVersion` sólo intenta el downgrade con `pm install -r -d`, lanzado desde el proceso de la app tras copiar el APK a /data/local/tmp. Una app sin privilegios no puede escribir ahí (SELinux untrusted_app) ni obtiene INSTALL_PACKAGES firmada con debug.keystore. Si falla, el propio código devuelve «DOWNGRADE no permitido… En producción use PAXSTORE» (:824-831). El daño exige un canal que haga downgrade EN SITIO: PAXSTORE en PAX, o el TMS de AngelPay en Nexgo (que es justo el canal por el que se distribuye Nexgo), o firmware debuggable en QA. Y si el rollback real es desinstalar y reinstalar, se pierde todo, activación incluida, con o sin v34.

(b) La rama de «reejecución por replay» queda refutada por el propio diseño. A.9 salta la reentrega con `NO_INBOX_IDENTITY` cuando las entregas traen identidad y el socket no, que es el caso v34→2.9.2. Si el APK bajado sí tiene A, el caso «M sin S» lo hace rotar y la reentrega se salta con `OTHER_INBOX`. La excepción de plan D sólo aplica entre APK durables sin identidad, y todos (2.8.8–2.9.2) comparten v33, así que entre ellos no hay downgrade destructivo. Lo único que falta corregir es el texto de la justificación de A.9.

(c) La crítica a A.2 no es un defecto. Al bajar a v33 el centinela sí se va con la bandeja, como dice el diseño. Sólo al bajar a menos de v32 sobrevive la tabla, y entonces la bandeja está intacta: no finge continuidad sobre filas que perdió. La libreta sí se pierde en ese caso, pero ese problema es de la libreta, no de la identidad.

Severidad: la pérdida de cobros aprobados es dinero real y silenciosa, pero requiere un rollback en sitio por un canal privilegiado cuya factibilidad no se verificó. INSTALL_VERSION, tal como está codificado, probablemente falla en producción. Por eso P2 y no P1. El §0 debe corregirse sí o sí, porque el plan de despliegue (F.2, APK primero) contempla revertir.
  - Evidencia: - avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt:147-162: `.fallbackToDestructiveMigrationOnDowngrade()`, comentario «This will DELETE all local data including pending_payments». `git diff HEAD` sin cambios; introducido en 2b261cd.
- CHANGELOG-archive-3.md:163: «el fallbackToDestructiveMigrationOnDowngrade() intencional para rollback vía INSTALL_VERSION».
- avoqado-web-dashboard/src/locales/en/tpv.json:257-261 (y fr): el dashboard avisa «DOWNGRADE DETECTED - DATA LOSS … Pending payments not synced will be lost».
- `git show <c>:AvoqadoDatabase.kt`: 2.8.8 (vc106), 2.9.1 (vc105) y 2.9.2 (vc107) en `version = 33`. Las entidades de v33 incluyen PendingPaymentEntity, PaymentAttemptEntity, PendingRefundEntity y RemotePaymentRequestEntity.
- Diseño: §0 línea 29 «Sin fallbackToDestructiveMigration*: la app truena y los datos quedan intactos» (falso); C.5 línea 321 «Migración Room v34»; A.9 líneas 157-158 «un borrado también quita la activación».
- CommandExecutor.kt:768-831: detecta el downgrade, intenta `pm install -r -d` con copia a /data/local/tmp (:873-941) y, si falla, devuelve «DOWNGRADE no permitido… En producción use PAXSTORE». El comentario de :773-777 dice que en dispositivos sin root fallará.
- CommandExecutor.kt ~:1059: sólo FACTORY_RESET hace `secureStorage.clearAll()`.
- AndroidManifest.xml:49: declara INSTALL_PACKAGES (ProtectedPermissions); no se concede a una app firmada con debug.keystore.
- Diseño A.9: `NO_INBOX_IDENTITY` (entregas con identidad y socket sin ella) salta el replay. A.3 «M sin S ⇒ Rotar». Con eso la reentrega tras el downgrade queda cubierta.
- Room 2.7.0 (build.gradle.kts:753): la variante sin argumento equivale a dropAllTables=false, que tira sólo las tablas que conoce el APK viejo. Para v33 son todas las de dinero.
- terminal-payment.service.ts:182-186 `IN_FLIGHT` incluye SENT, y :964-969 el replay consulta IN_FLIGHT con `expiresAt > now`. Confirmado, pero A.9 lo filtra.
  - Arreglo corregido: 1. Corregir el §0: Room SÍ tiene downgrade destructivo, y todo cruce de versión de esquema al revertir borra pending_payments, payment_attempts, pending_refunds y la bandeja. Quitar esa fila como premisa de A.2 y A.9.
2. C.5 sin cambio de esquema. Expresar «cancel aceptado» y «ejecución no-tarjeta iniciada» con estados nuevos en `status` (p. ej. `CANCEL_ACCEPTED`, `EXECUTING_NON_CARD`) o dentro de `final_result_json`, igual que se hizo con la lápida, y contarlos en las obligaciones y en la cerca de `reserveTerminal`. Así revertir a 2.9.2 queda v33→v33. Regla general para F: ningún APK que pueda necesitar rollback durante el despliegue sube la versión de Room.
3. Corregir la opción «retirar fallbackToDestructiveMigrationOnDowngrade». Quitarlo del APK nuevo NO protege un rollback a 2.9.2, porque el que decide es el builder del APK viejo. Sólo protege rollbacks futuros hacia APK construidos después, y a cambio el downgrade deja la terminal en crash-loop (sin poder cobrar) hasta volver a subir. Es decisión aparte, no el arreglo de esto.
4. Agregar a F un candado para INSTALL_VERSION hacia un versionCode menor. En el servidor/dashboard: bloquearlo, no sólo avisar, si la terminal reporta obligaciones abiertas (pending_payments, libreta no cerrada, pending_refunds, bandeja no RESOLVED); para eso el heartbeat tendría que informar esos conteos. En la terminal: el APK que ejecuta el comando rechaza el downgrade si hay obligaciones. Declarar que PAXSTORE y el TMS de AngelPay se saltan ese candado; para esos canales el procedimiento de rollback exige comprobar antes que las colas estén vacías.
5. A.9: reescribir la justificación del riesgo residual. Un downgrade vacía la base con la activación viva. Declarar que el caso queda cubierto por `NO_INBOX_IDENTITY` y por la rotación M-sin-S, y que entre APK durables sin identidad (2.8.8–2.9.2) no hay downgrade destructivo porque comparten v33.
6. Verificar en hardware, antes de apoyarse en ello, si INSTALL_VERSION con versionCode menor realmente instala en una PAX de producción y en una Nexgo, y si el TMS de AngelPay hace downgrade en sitio o desinstala. Eso decide si esto es P1 o P2 en la práctica.

#### 5. [P2] El socket conecta antes de la verificación de identidad, y si falla se oculta también la capacidad: el servidor la trata como una 2.9.x y le aplica el replay del plan D

- **Sección:** A.3 / A.4 / A.9
- **Escenario:** Arranque en frío: `HomeViewModel.init` llama `connectSocketIfNeeded()` de inmediato y `connect()` arma el `auth` al instante. La verificación todavía necesita abrir Room (y correr la 33→34) y leer el espejo, así que casi siempre pierde la carrera.

Por A.4, sin verificación no se anuncia identidad ni `terminalPaymentInboxVersion`, y además el `auth` queda fijo para todas las reconexiones del mismo Socket. Consecuencias:
- En el caso normal, todas las entregas de esa sesión quedan sin `inboxId`: A nunca las libera (regla 2) y A.9 las salta después (NO_INBOX_IDENTITY). A queda apagada en la práctica.
- En el caso malo (copia vieja restaurada con R en RECEIVED): el servidor no la distingue de una 2.9.x, reentrega R (SENT, menos de 5 min) y `receive` entrega la fila RECEIVED existente antes de la cuarentena ⇒ claim ⇒ vuelve a cobrar un R que en la línea real ya se cobró.
- **Evidencia:** `HomeViewModel.kt:242` y `:622-666`; `LoginViewModel.kt:161-166`.
`SocketManager.kt:183-215`: connect no es suspend y el `auth` es fijo; `reconnectWithFreshToken` también llama connect.
`RemotePaymentInbox.kt:69-70`: una fila RECEIVED existente ⇒ Deliver.
No existe gancho de arranque en Application.
Diseño A.4 líneas 90-91, A.9 línea 156.
- **Arreglo propuesto:** - Crear un `InboxIdentityGate` (singleton) que arranque en `Application.onCreate`.
- `SocketManager.connect` espera el gate dentro de `socketScope`, y TODAS las entradas de la bandeja (receive, probe, cancel, claim) lo esperan también, para que la cuarentena termine antes de procesar cualquier evento.
- Anunciar siempre `terminalPaymentInboxVersion`; `inboxId` y el contador sólo con la verificación hecha.
- Servidor: capacidad sin identidad ⇒ no confiable y SIN replay (no aplicar la excepción de 2.9.x).
- **Escéptico:** REFUTADO → severidad P3
  - Razón: El escenario P2 no se sostiene contra el diseño. Da por hecho una implementación que contradice el propio diseño, y su caso dañino exige condiciones que el diseño no produce.

(1) El diseño ordena la verificación ANTES del socket. A.3 se titula «verificación al arrancar (antes de conectar el socket)». A.4 dice que la identidad viaja «sólo después de la verificación del arranque». Que HOY `HomeViewModel.init` llame `connectSocketIfNeeded()` sin esperar describe el código anterior a A, que todavía no existe. No describe un defecto del diseño. «Casi siempre pierde la carrera» sólo pasa si alguien implementa A sin cumplir A.3.

(2) El caso malo (volver a cobrar R tras restaurar una copia vieja) exige que las entregas previas de R NO lleven identidad. A.9 sólo conserva el replay del plan D cuando «NI las entregas NI el socket tienen identidad». Si R se entregó con identidad X y el socket vuelve sin ella, la regla aplica `NO_INBOX_IDENTITY` y lo salta. Con la verificación bien ordenada, eso requiere que la verificación falle en dos sesiones seguidas. Los casos de la tabla A.3 no fallan: todos terminan en continuar, crear o rotar, y un espejo ilegible también rota. Sólo quedan un error de E/S o de Room. Además la restauración tendría que entrar dentro de la vigencia de 5 min, con R todavía en IN_FLIGHT después de haberse cobrado. Y el propio diseño declara que un borrado o una reinstalación quitan la activación.

(3) Aun así, un fallo de verificación deja el sistema en el comportamiento del plan D, el que ya está en el árbol. No lo deja por debajo.

Lo que SÍ queda, como hueco de redacción (P3):
- El diseño no enumera los tres puntos que arman el `auth`: `HomeViewModel:659`, `LoginViewModel:161` y `SocketManager.reconnectWithFreshToken:334→connect`.
- No dice que las entradas de la bandeja esperen a la cuarentena.
- «si falló, no se anuncia identidad» es ambiguo: no aclara si también se oculta `terminalPaymentInboxVersion`. Si se oculta, el servidor no distingue un APK nuevo con la verificación fallida de uno sin A, y aplica la excepción de 2.9.x donde debería fallar cerrado.
- A.10 no incluye una prueba de ese orden.
  - Evidencia: Diseño A.3 (título): «verificación al arrancar (antes de conectar el socket)». A.4 (líneas 90-91): «Sólo después de la verificación del arranque; si falló, no se anuncia identidad. En reconexiones automáticas el valor queda congelado». A.9 (líneas 155-156): «NO_INBOX_IDENTITY (entregas con identidad y socket sin ella…)» y la excepción «si NI las entregas NI el socket tienen identidad».

TPV, hoy: `HomeViewModel.kt:242` llama `connectSocketIfNeeded()` en `init`, y `:659` llama `socketManager.connect`. `LoginViewModel.kt:161` llama `socketManager.connect`. `SocketManager.kt:183-236`: `connect()` no es suspend y arma `auth` de forma síncrona con `forceNew`. `SocketManager.kt:334-340`: `reconnectWithFreshToken()` llama `connect(url, freshToken, currentTerminalId)`. `RemotePaymentInbox.kt:69-70`: una fila `RECEIVED` existente ⇒ Deliver (esto es cierto). `AvoqadoTPVApplication.kt:62`: `onCreate` existe, con campos `@Inject`, así que el gancho sí se puede poner. `AndroidManifest.xml:56`: `allowBackup="true"`, y las reglas de backup son las de plantilla.

Servidor: `terminal-payment.service.ts:874`: protocolo DURABLE si `ackVersion >= 1`. `:953-1000`: `replayPendingForTerminal` exige `terminalPaymentAckVersion >= 1`, IN_FLIGHT y `expiresAt > now`, y salta LEGACY y procedencia desconocida. `socketManager.ts:227-236`: el replay y la sonda se disparan en paralelo al conectar. El diseño ya lo cambia a secuencial en A.5.
  - Arreglo corregido: Aclaraciones al diseño; no hace falta rehacer la arquitectura.

1. En A.3/A.4, nombrar el mecanismo:
   - Un `InboxIdentityGate` singleton que arranque en `AvoqadoTPVApplication.onCreate`.
   - `SocketManager` construye el `auth` sólo con el resultado del gate, esperándolo dentro de su propio scope. Así quedan cubiertos los tres llamadores (`HomeViewModel`, `LoginViewModel` y `reconnectWithFreshToken`) sin cambiar su firma.
   - `receive`, `probe`, `cancel` y `markProcessing` esperan el mismo gate, para que la cuarentena termine antes de procesar cualquier evento.

2. Cambiar «si falló, no se anuncia identidad» por:
   - El APK nuevo SIEMPRE anuncia `terminalPaymentInboxVersion`. `inboxId` y el contador viajan sólo con la verificación hecha.
   - En el servidor (A.9), capacidad sin identidad ⇒ socket no confiable y SIN replay (motivo `NO_INBOX_IDENTITY`). La excepción del plan D queda sólo para sockets que no declaran la capacidad (2.9.x).
   - Si la verificación falla, la TPV no reclama filas `RECEIVED` preexistentes hasta que el gate quede resuelto.

3. Agregar a A.10:
   - Una prueba unitaria: `connect` con el gate pendiente no emite el handshake, y un evento de bandeja espera la cuarentena.
   - Una prueba de integración: capacidad sin `inboxId` ⇒ no hay replay.

#### 6. [P2] «Único escritor» y contador en la misma transacción: huecos concretos del DAO actual y escritores nuevos que introduce C.5

- **Sección:** A.2 / A.3 / C.5
- **Escenario:** 1. `markResolved` usa una lista negativa (`status NOT IN ('RESOLVED','NOT_FOUND_ANSWERED')`): resolvería el centinela o una fila `RECEIVED_PRE_ROTATION` si alguien le pasa ese id.
2. `receive` rechaza cualquier estado desconocido con `accepted:false`: la reentrega de una fila en cuarentena termina en ACK_REJECTED ⇒ UNKNOWN, no en el «ACK sin ejecutar» que promete A.3.
3. C.5 agrega escritores fuera de la bandeja:
   - el CAS del cancel toca `payment_attempts` y `remote_payment_requests`;
   - la cerca de `reserveTerminal` lee la bandeja desde PaymentAttemptDao y hoy sólo recibe `orderJsonFragment`, no el `requestId`;
   - `execution_started_at` lo escribirían los VM de efectivo y cripto.
   Si una de esas escrituras no sube el contador ni el espejo, una copia restaurada con el mismo contador pero sin `cancel_accepted_at` pasa por «continua» y la cerca desaparece, después de haberle contestado ACCEPTED al servidor.
4. Las pruebas de la bandeja usan un DAO mock relajado: no pueden probar el contador transaccional.
- **Evidencia:** `RemotePaymentRequestDao.kt:60-65` markResolved con lista negativa.
`RemotePaymentInbox.kt:75` `else -> Reject`.
`DatabaseModule.kt:206-208`: el DAO se inyecta por Hilt; la exclusividad es sólo convención.
`PaymentAttemptDao.kt:71-92` reserveTerminal.
`RemotePaymentInboxTest.kt:13` mockk relajado.
`observePendingObligationCount` (`DAO:14-24`) filtra `status='PROCESSING'`: no ve el centinela, pero tampoco verá un estado nuevo de ejecución si no se agrega.
- **Arreglo propuesto:** - Marcar el DAO como `internal` y agregar una prueba-guarda que falle si otra clase lo referencia o escribe en la tabla.
- Toda mutación como método `@Transaction` del DAO que incluya `counter = counter + 1` del centinela, con listas positivas de estado (RECEIVED y PROCESSING).
- Una rama explícita para la cuarentena: ACK positivo sin ejecutar.
- El CAS del cancel y `execution_started_at` viven en la bandeja (que recibe PaymentAttemptDao y usa `AvoqadoDatabase.withTransaction`) y pasan por el mismo camino commit→espejo.
- `reserveTerminal` recibe el `requestId` como parámetro.
- Mover las pruebas a Room con Robolectric.
- **Escéptico:** REFUTADO → severidad P3
  - Razón: El diseño ya exige lo que el hallazgo pide, y ninguno de los cuatro escenarios lleva a un cobro doble ni a un cobro perdido cuando se sigue contra el código.

(1) `markResolved` usa una lista negativa, pero sólo se llega a él por `persistResult` (`SocketManager.kt:2034`), con el `requestId` del cobro que se está ejecutando. Ese id sólo existe si antes hubo un `Deliver`. El diseño rechaza en `receive` el id reservado del centinela. Una fila `RECEIVED_PRE_ROTATION` nunca produce `Deliver`, y la rotación ocurre al arrancar, antes del socket, sin nada en vuelo. AngelPay tampoco abre la puerta: su resultado tardío llega sobre una fila que se reclamó antes (PROCESSING), y ésa no pasa a cuarentena. Es higiene de código, no un camino alcanzable. Además A.2 ya manda excluir el centinela de toda consulta.

(2) Hoy, la reentrega de un estado desconocido termina en `Reject`, y el servidor la vuelve UNKNOWN. Pero A.9 bloquea el replay hacia otra bandeja (`OTHER_INBOX`), y después de rotar el `inboxId` es otro, así que la reentrega casi no ocurre. Si ocurriera, UNKNOWN conserva la reserva: es el desenlace conservador. Falta implementar una rama, el diseño no está mal.

(3) La premisa necesita una mutación que no suba el contador, y A.2 dice lo contrario: el contador sube en cada mutación, «cancel CAS» incluido, y la bandeja es el único escritor. Aun suponiendo que se violara, el daño no aparece. Una copia tomada después del reclamo y antes del cancel deja la fila en PROCESSING. PROCESSING nunca vuelve a ejecutarse: `receive` da `AckOnly` y la sonda da ACTIVE. El servidor ya tiene la fila CANCELLED y no la reentrega. Con el proceso nuevo, un cancel sobre PROCESSING tampoco puede ganar, porque C.5 exige prueba de propiedad «en este proceso». Nadie crea un intento nuevo para ese `requestId`, así que la cerca de `reserveTerminal` nunca entra en juego. Además, la cerca sólo LEE la bandeja: no es un escritor y no toca el contador. Y el `requestId` ya viaja dentro de `contextJson`.

(4) Es falso que las pruebas «no puedan» cubrir el contador. Ya existe `RemotePaymentInboxRoomTest`, con Robolectric y un Room en memoria. A.10 del diseño prescribe exactamente eso: «Room de Robolectric… el contador sube en cada mutación dentro de la transacción». `observePendingObligationCount` no necesita cambiar, porque el diseño no agrega ningún status de ejecución (`cancel_accepted_at` y `execution_started_at` son columnas).

Queda un hueco real, pero de redacción. A.2 enumera las mutaciones que suben el contador y no incluye `execution_started_at`. C.5 no dice que sus dos CAS (el del cancel y el de `execution_started_at`) vivan en `RemotePaymentInbox`, que hoy sólo recibe `RemotePaymentRequestDao`. Una parte del arreglo propuesto tampoco sirve: `internal` no restringe nada aquí, porque la bandeja, la libreta, la inyección de Hilt y los ViewModels están en el mismo módulo `:app`.
  - Evidencia: - `RemotePaymentRequestDao.kt:60-65`: `markResolved` tiene lista negativa. Su único llamador de producción es `RemotePaymentInbox.persistResult` ← `SocketManager.kt:2034`, que emite el resultado de un cobro en curso. En los otros caminos de la bandeja, `rejectUnclaimed`, `cancel` y el RECEIVED de la sonda usan `resolveReceived` (lista positiva, `status='RECEIVED'`), y la lápida de la sonda es un `insert` con IGNORE que nunca pisa una fila existente.
- `RemotePaymentCoordinator.kt:107-110`: el reclamo (`markProcessing`) ocurre antes de navegar o abrir el SDK. `RemotePaymentInbox.kt:71`: PROCESSING ⇒ `AckOnly`. `RemotePaymentInbox.kt:149`: sonda ⇒ ACTIVE. `RemotePaymentInbox.kt:162`: un estado desconocido (el centinela) ⇒ ACTIVE en la sonda. En `cancel` (`:104-112`), el centinela no está en RECEIVED ⇒ ACTIVE.
- `RemotePaymentInbox.kt:75`: `else -> Reject`. Diseño A.9: el replay sólo va a la misma bandeja confiable, así que una fila en cuarentena no se reentrega a la identidad nueva.
- Diseño A.2: el contador sube en cada mutación, con «cancel CAS» en la lista, y `RemotePaymentInbox es el único escritor`. En esa lista falta `execution_started_at`. C.5 no dice dónde viven sus CAS. Diseño A.10: la TPV se prueba con Room de Robolectric.
- `app/src/test/.../RemotePaymentInboxRoomTest.kt:24-41`: `@RunWith(RobolectricTestRunner)` con `Room.inMemoryDatabaseBuilder(AvoqadoDatabase)`. El mock relajado de `RemotePaymentInboxTest.kt:13` es otra suite.
- `PaymentAttemptDao.kt:71-92`: `reserveTerminal` es un INSERT…SELECT sobre `payment_attempts`, no escribe en la bandeja. `contextJson` ya lleva `terminalPaymentRequestId` (el mismo `instr` que usa `observePendingObligationCount`, DAO `:23`).
- `settings.gradle.kts`: toda la bandeja, la libreta y `DatabaseModule` están en `:app` ⇒ `internal` no aísla nada.
- `AndroidManifest.xml:56`: `allowBackup=true` con reglas por defecto, así que una restauración de la base sin el espejo es plausible. Pero con eso S<M ⇒ rotar. Sólo quedaría «continua» con el mismo contador si alguien violara A.2.
  - Arreglo corregido: Son cambios de redacción al diseño, sin rediseño:
1. En A.2, agregar `execution_started_at` a la lista de mutaciones que suben el contador. En C.5, decir explícitamente que el CAS del cancel después del reclamo (libreta `PREPARANDO→DESCARTADA` + `cancel_accepted_at`) y el CAS de `execution_started_at` son métodos de `RemotePaymentInbox`. Esos métodos reciben `PaymentAttemptDao` (o `AvoqadoDatabase.withTransaction`) y pasan por el mismo orden commit → espejo → efecto visible. Los ViewModels de efectivo y cripto llaman a la bandeja, nunca a un DAO.
2. Al agregar el centinela y la cuarentena, pasar `markResolved` a una lista positiva (`status IN ('RECEIVED','PROCESSING')`), conservando que un resultado de éxito tardío siga ganando por `replaceResolvedResult`.
3. Hacer explícita en `receive` la rama `RECEIVED_PRE_ROTATION`: ACK sin ejecutar, como promete A.3. También vale dejar el `Reject`, que produce UNKNOWN y es conservador, pero el diseño debe decir cuál de los dos.
4. En vez de `internal` (no aísla nada dentro de `:app`), una prueba-guarda estática: que falle si alguna clase, fuera de `RemotePaymentInbox`, `DatabaseModule` y `AvoqadoDatabase`, referencia `RemotePaymentRequestDao` o contiene un `UPDATE`/`INSERT`/`DELETE` sobre `remote_payment_requests`.
5. Las pruebas del contador van en la `RemotePaymentInboxRoomTest` que ya existe (Robolectric + Room). No hace falta mover la suite con mocks.
6. La cerca de `reserveTerminal` puede usar el `requestId` que ya viaja en `contextJson`, o recibirlo como parámetro. Es sólo una lectura y no afecta el contador.

#### 7. [P3] El aviso de cancel viaja por un bus que tira eventos: la lectura de chip sigue con la fila ya DESCARTADA

- **Sección:** C.5 (aviso en pantalla)
- **Escenario:** En hora pico llega una ráfaga de más de 10 eventos (`order_updated`, `notification_count_updated`) justo cuando entra el cancel aceptado. El `SharedFlow` descarta el evento más viejo y la pantalla de Blumon se queda en «Acerca o inserta».

En contactless lo salva la cerca (markKernelEntered falla). En chip, en cambio, StartEmvTrans corre con la fila ya DESCARTADA porque nadie detiene la lectura: el caso TC offline que el diseño deja pendiente se vuelve más probable.
- **Evidencia:** `SocketManager.kt:154-158`: replay=1, extraBufferCapacity=10, DROP_OLDEST.
Blumon sandbox `PaymentViewModel.kt:3351` openAttempt (PREPARANDO), `:3606` StartEmvTrans, `:4726` markAuthorizing (la barrera llega después del chip).
- **Arreglo propuesto:** - La pantalla de cobro observa la fila durable de su `requestId` (Flow de Room sobre `status` o la marca de cancel) y llama `stopDetectCard`; el evento del socket queda sólo como acelerador.
- Comprobar la cerca también justo antes de StartEmvTrans.
- **Escéptico:** no aplica (P3 sin verificar)

#### 8. [P3] Dos variantes de la app con el mismo serial se turnan la identidad: SUPERSEDED «nunca se reactiva» y A muere en las dos

- **Sección:** A.5
- **Escenario:** En la PAX del gimnasio, la app de producción y la variante `.demo` (que apunta a producción y reporta el serial `AVQD-2841548418`) tienen bandejas distintas. Cada conexión descontinúa la identidad de la otra y ninguna vuelve a ser confiable. Se escribe un ActivityLog en cada alternancia.

Esto también arruina las pruebas físicas de A.10 en PAX de QA donde convivan variantes. B.1 ya reconoce el turno entre variantes, pero A.5 lo vuelve permanente.
- **Evidencia:** `.claude/rules/avoqado-demo-variant.md`: `applicationIdSuffix=".demo"`, backend de producción y serial fijo en DeviceInfoManager.
Diseño A.5 líneas 107-108 y B.1 líneas 207-208.
- **Arreglo propuesto:** - Opción 1: incluir el `applicationId` en el handshake y en la llave (`@@unique([terminalKey, appId, inboxId])`, un ACTIVE por terminal y app).
- Opción 2: permitir reactivar una identidad SUPERSEDED cuando vuelve con contador mayor o igual que la marca. SUPERSEDED no es un compromiso; COUNTER_REGRESSION sí lo es.
- **Escéptico:** no aplica (P3 sin verificar)

### rutas-candados

Revisé C.6, G2 y G3 contra el código del árbol. No encontré un ciclo de candados nuevo si el helper toma el FOR UPDATE de Order como primera operación. Cancelar orden, admisión, registro de pago y vales siguen el orden advisory → Order o sesión → vales → Order, y ninguna de las rutas del diseño toma el advisory. G3 aguanta: sumar artículos a la cuenta destino no genera sobrepago. El defecto de fondo es otro: el diseño trata como problema «las rutas que cancelan», y el dinero se descuadra en cualquier ruta que BAJA lo que se debe o que COBRA mientras hay un cobro vivo.

Estas rutas quedan fuera de la tabla C.6: separar cuenta (produce cobro doble), cortesía de toda la cuenta, quitar plato, descuento y canje; cobrar en efectivo o liquidar desde el dashboard (produce efectivo + tarjeta); el job que BORRA órdenes vacías; y los cobros locales de la PAX, que no dejan fila en el servidor. G2 además deja pasar, en PARTIAL, la anulación de platos ya pagados y la baja del total por debajo de lo cobrado. En la cola offline, la cuarentena del CANCEL o del MERGE no detiene los intents que dependen de él. Un P2028 en la admisión sale como 500 sin código, y el POS se queda con una llave que no puede resolver. Los códigos nuevos chocan con lo que la TPV publicada ya hace con 409 y 400; con 409 en removeOrderItem entra en un bucle de resincronización.

En corto: el candado nuevo protege «cancelar la cuenta», pero todavía hay 7 u 8 caminos por los que se cobra de más o dos veces con un cobro de terminal en curso. Mi recomendación es cambiar la regla de «no cancelar» a «no bajar lo que se debe ni cobrar por otro lado mientras la terminal cobra». Necesito que decidas si esa regla general entra en este mismo trabajo.

#### 1. [P1] Las rutas que BAJAN el saldo sin cancelar no pasan por el helper; separar cuenta produce cobro doble

- **Sección:** C.6 / G2
- **Escenario:** Mesa 5, O1 de $300 (3 platos de $100). La tablet A manda un cobro remoto de $300 a la PAX (fila SENT; PAX dormida o el cliente tarda). En el iPad, el mesero separa el plato 3 a otra cuenta (splitOrderItems) o usa «dividir por puesto»: O1 queda en $200 y nace O2 de $100 PENDING. La PAX aprueba $300 y payment.tpv los registra sobre O1 (el pago siempre se registra; $100 de sobrepago). Después O2 se cobra aparte: el cliente paga $400 por $300 de comida. El sobrepago también ocurre con: cortesía de toda la cuenta (compWholeOrder deja O1 en $0 mientras la PAX cobra $300; se llega por la ruta online, por la cola offline COMP_ORDER y por el MCP), compItems, removeOrderItem y applyDiscount de /tpv, y applyOrderDiscount, quitar cargo por servicio, canje de sello y canje de puntos en móvil.
- **Evidencia:** Único llamador de findChargeBlockingOrderCancel: /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/mobile/order.mobile.service.ts:3226. splitOrderItems 1547-1668 sólo rechaza PAID/PARTIAL (1574), sin FOR UPDATE ni consulta de cobros. splitOrderBySeat 1693/1716, igual. /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/mobile/comp-item.mobile.service.ts:31-135: sin candado; compWholeOrder pone total 0 en cada línea. /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/order.tpv.service.ts: compItems 2465/2481, removeOrderItem 2216/2257 (el delete va fuera de la transacción en 2267), applyDiscount 2993/3021: sólo rechazan PAID. Sin consulta de cobros también: wallet/redeemStampReward.service.ts:81, mobile/loyalty.mobile.service.ts:104, mobile/service-charge.mobile.service.ts:71,170. Rutas que llegan ahí: sync.mobile.service.ts:1095-1100 (COMP_ORDER offline) y src/mcp/tools/tables.ts:305,374,406,448 (cortesía, separar, separar por puesto, fusionar).
- **Arreglo propuesto:** Redefinir el helper: la pregunta no es «¿se puede cancelar?» sino «¿puede bajar lo que se debe?». Renombrarlo a assertOrderMoneyMutableUnderLock(tx,…), tomar el FOR UPDATE de Order como PRIMERA operación y exigirlo en TODA mutación que reduzca total/subtotal, mueva o borre OrderItem, o cambie descuentos o cargos: split, split por puesto, cortesía por línea y de toda la cuenta, quitar línea, aplicar descuento, quitar cargo, canjes de sello y de puntos, promociones. Agregar esas rutas a la tabla C.6 (también sus reducers offline y las tools del MCP). Agregar una guardia estática que falle si un servicio escribe Order.total/discountAmount/serviceChargeAmount o hace orderItem.delete*/updateMany({orderId}) sin pasar por el helper.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No pude refutarlo. El diseño deja abierto ese hueco y lo reconoce a medias. Su §C.6 se limita a las rutas que CANCELAN, pero incluye «Anular artículos» porque «una parcial deja un sobrepago» (G2). Ese mismo razonamiento vale para separar la cuenta, dividir por puesto, las cortesías, quitar una línea, los descuentos y los canjes, y ninguna de esas rutas entra en la tabla ni en el helper.

El escenario se sostiene con el código del árbol:
- La admisión guarda un `amountCents` fijo con `orderId` y no lo compara con el saldo.
- La TPV cobra en modo OrderPayment con ese `orderId`.
- `recordOrderPayment` registra el pago SIEMPRE, aunque supere el total. Sólo avisa (🚨 Sobrepago + ActivityLog), nunca rechaza.
- Las rutas que bajan el saldo sólo miran PAID/PARTIAL, sin candado y sin consultar si hay un cobro vivo.

La ventana es más larga de lo que dice el hallazgo. La PAX puede aprobar y el registro quedarse en la cola offline durante minutos (el reintento es cada 15 min). Todo ese tiempo la orden parece «sin pagar» en el iPad, y el cobro sigue vivo en el servidor (UNRESOLVED), así que el candado propuesto sí lo atraparía.

Bajo la severidad a P2 por cuatro razones:
1. El defecto ya existe hoy: no lo introduce el diseño.
2. Exige que un SEGUNDO aparato modifique la misma orden mientras dura el cobro.
3. El sobrepago no es silencioso: se registra, grita en Better Stack y el vigilante lo pesca. Ningún dinero queda sin registro, y el excedente se puede reembolsar.
4. No compromete la parte A/B del diseño.

Aun así es dinero del cliente cobrado de más, y con el mismo criterio que el diseño ya aplicó a G2 debe entrar en la tabla C.6.

El arreglo propuesto necesita dos ajustes:
- La guardia estática, tal como está redactada («falla si un servicio escribe Order.total… sin el helper»), es demasiado amplia. `recalculateOrderTotals` y `payment.tpv` escriben `total` legítimamente, y también suben el saldo agregar artículos, quitar un descuento o aplicar un cargo. Tiene que acotarse a las operaciones que REDUCEN el saldo.
- El helper que decide PAID/PARTIAL no debe exigir el 400 en las rutas que ya tienen sus propios mensajes.
  - Evidencia: Todas las rutas son del árbol de trabajo; todas las citas se verificaron leyendo el código.
- Admisión, `avoqado-server/src/services/terminal-payment.service.ts:549-620`: toma el FOR UPDATE de Order y rechaza la orden CANCELLED/DELETED, la PAID y la que ya tiene un cobro sin desenlace (`UNRESOLVED_FINANCIAL_OUTCOME`). Crea la fila con `amountCents` y `orderId` sin compararlos con el saldo. El comentario de :564 dice que registrar una aprobación ya ocurrida «es otro camino y no se toca».
- El payload lleva `orderId` (:708-719 y replay :993-1004). La TPV cobra en modo dual: `avoqado-tpv/.../core/remotepayment/RemotePaymentCoordinator.kt:29-42` («orderId set: OrderPayment flow»).
- `avoqado-server/src/services/tpv/payment.tpv.service.ts:699-775`: `newTotal = max(0, subtotal−discount) + serviceCharge + tips`, `overpaidBy = totalPaid − newTotal`. Si es > 0 hace `logger.error('🚨 [Sobrepago]…')` + `ActivityLog SOBREPAGO_DETECTADO`. El comentario dice que el pago SIEMPRE se registra y NUNCA se rechaza.
- `src/services/mobile/order.mobile.service.ts`:
  - `splitOrderItems` 1548-1668: lee con `prisma.order.findFirst` fuera de la transacción, rechaza sólo PAID/PARTIAL (1575), descuentos y cargos manuales; mueve OrderItem y recalcula. Sin FOR UPDATE ni consulta de cobros de terminal.
  - `splitOrderBySeat` 1694-1790: igual (1717).
  - `applyOrderDiscount` 1423-1489: igual.
  - El helper del árbol sólo se usa en `cancelOrder` (:3206). `assertNoLiveTerminalCharge` está importado en :33 pero no se usa en ninguna otra parte.
- `src/services/shared/orderCancelGuard.ts` (sin seguimiento en git, en construcción): el comentario de cabecera limita la regla a «toda ruta que cancela o anula».
- `src/services/mobile/comp-item.mobile.service.ts`: `compOrderItem` (:31) y `compWholeOrder` (:62-105) sólo miran PAID/PARTIAL; `compWholeOrder` pone `total: 0` en cada línea y recalcula, sin candado.
- `src/services/tpv/order.tpv.service.ts`: `removeOrderItem` 2216/2257, `compItems` 2465/2481, `voidItems` 2696/2725 y `applyDiscount` 2993/3021 sólo rechazan PAID.
- Caminos que llegan a esas rutas:
  - la cola offline COMP_ORDER, `src/services/mobile/sync.mobile.service.ts:1094-1099`;
  - el MCP, `src/mcp/tools/tables.ts:305` (cortesía), :374 (separar), :406 (separar por puesto) y :448 (fusionar).
- Diseño `diseno-A-B-seccion8-2026-09-11.md`: §C.6 (líneas 331-350) sólo trae cancelar, DELETE/PUT del dashboard, anular artículos, fusión, vales y POS-sync. G2 (:421) justifica el bloqueo de la anulación con «una anulación parcial bajo un cobro produce sobrepago». No hay una sola mención a separar la cuenta, cortesías, descuentos ni canjes.

Límites de lo verificado:
- No verifiqué en hardware que el iPad ofrezca separar la cuenta mientras la tablet cobra. El servidor no lo impide, y los clientes no conocen los cobros que lanzó otro aparato.
- Tampoco verifiqué el pago posterior de O2: depende de una acción humana.
  - Arreglo corregido: Ampliar §C.6 de «rutas que cancelan» a «rutas que BAJAN lo que se debe» y registrarlo como decisión G10 (hermana de G2).

1. Generalizar el helper (`shared/orderCancelGuard.ts`) en dos piezas:
   - `lockAndReadOrderForMoneyChange(tx, {venueId, orderId})`: candado de Order como PRIMERA operación dentro de la transacción + relectura.
   - `assertNoLiveTerminalCharge(tx, …)`, que ya existe, con un mensaje propio: «Hay un cobro en curso en la terminal por esta cuenta; espera su resultado antes de separarla, cortesiarla o descontarla». Mismo código 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` + `details.requestId`, o uno aditivo `ORDER_BALANCE_CHANGE_BLOCKED_BY_TERMINAL_CHARGE`.
   - Cada ruta conserva sus propios 400 de PAID/PARTIAL.
   - Nunca tomar el advisory de terminal aquí.

2. Aplicarlo a toda mutación que REDUZCA subtotal o total, o que saque OrderItem de la orden:
   - `splitOrderItems` y `splitOrderBySeat`: bloquear el ORIGEN, igual que en la fusión.
   - `compOrderItem` y `compWholeOrder`.
   - En `/tpv`: `compItems`, `removeOrderItem` (con el delete dentro de la transacción) y `applyDiscount`.
   - En móvil: `applyOrderDiscount`; quitar un cargo por servicio; el canje de puntos (`loyalty.mobile.service`) y el de sello (`redeemStampReward`, salvo `applyStampRewardToNewOrder` sobre una orden recién creada sin cobro); los descuentos manuales o del motor sobre una orden existente (`discount.tpv.service`); la baja de cantidad en la edición de artículos si existe.
   - Esas mutaciones hoy leen fuera de la transacción: hay que reestructurarlas para que la relectura y la escritura ocurran bajo el candado.
   - Las operaciones que SUBEN el saldo (agregar artículos, quitar un descuento, aplicar un cargo) no se bloquean.
   - Variante opcional, menos restrictiva: permitir la reducción cuando el saldo resultante siga ≥ la suma de los `amountCents` vivos. G2 eligió bloquear siempre; por consistencia, bloquear.

3. Rutas de entrada:
   - En la cola offline, COMP_ORDER, SPLIT y DISCOUNT bloqueados van a cuarentena con un aviso específico, igual que CANCEL/MERGE.
   - Las tools del MCP (`tables.ts` cortesía, separar y separar por puesto) devuelven el mismo motivo.
   - Android e iOS leen el código nuevo con su mensaje (cambiados juntos).

4. Guardia estática ACOTADA: enumerar explícitamente la lista blanca de servicios que reducen el saldo y exigir que cada uno llame al helper. No sirve una regla genérica sobre escrituras de `Order.total`, porque `recalculateOrderTotals` y `payment.tpv` las hacen legítimamente.

5. Pruebas contra Postgres real:
   - Con una fila SENT/UNKNOWN sobre O1, separar, cortesiar o descontar ⇒ 409 y O1 intacta.
   - Carrera bajo candado: la reducción espera a una admisión en `pg_stat_activity`.
   - Un sabotaje por ruta en copia aislada.

#### 2. [P1] El otro lado del candado: cobrar en efectivo o liquidar con un cobro de terminal vivo, y sobre una orden CANCELLED

- **Sección:** C.6
- **Escenario:** O1 de $200 con cobro remoto SENT en la PAX. Otro aparato (o el botón «Ya pagó de otra forma») registra $200 en efectivo con payCashOrder, y O1 queda PAID/COMPLETED. La PAX aprueba $200 y se registra como sobrepago: el cliente pagó dos veces ($200 en efectivo y $200 con tarjeta). Pasa lo mismo con settleOrder, createManualPayment y settleCustomerBalance del dashboard y con la confirmación de B4Bit. Además payCashOrder no lee status. C.4 cancela la orden tras NOT_CHARGED; si un PAY_CASH offline de otro aparato estaba en cola, al reproducirse se registra sobre la orden CANCELLED y la pasa a COMPLETED. La admisión de un cobro de terminal sí rechaza CANCELLED; el efectivo no.
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/mobile/order.mobile.service.ts:2214 payCashOrder. La relectura dentro de la transacción no selecciona status ni consulta cobros; el CAS de 2522 acepta PENDING/PARTIAL y 2534 escribe status COMPLETED. No hay ninguna referencia a terminalPayment en src/services/dashboard/order.dashboard.service.ts (settleOrder 637) ni en manualPayment.service.ts. La admisión rechaza CANCELLED/DELETED en /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:565-572: las dos puertas no son simétricas.
- **Arreglo propuesto:** Bajo el mismo FOR UPDATE de Order, en payCashOrder online, settleOrder, createManualPayment, settleCustomerBalance, ligas de pago y B4Bit: si findChargeBlockingOrderCancel ≠ null ⇒ 409 ORDER_HAS_LIVE_TERMINAL_CHARGE con details.requestId (el POS primero cancela el cobro por la vía de C.4). En línea, rechazar CANCELLED/DELETED igual que la admisión. En la reproducción offline (PAY_CASH) el efectivo ya entró y no se puede rechazar: se registra, pero con 🚨, ActivityLog y reconciliationRequired en la orden y en la fila de la terminal, nunca en silencio. Agregar pruebas de integración de efectivo + tarjeta sobre la misma orden con Postgres real.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No pude refutarlo. El diseño C.6 protege sólo un lado del candado de Order: cancelar o anular con un cobro de terminal vivo. No protege el otro lado: registrar efectivo o liquidar mientras la orden tiene un cobro de terminal vivo, ni cobrar sobre una orden CANCELLED. Además es incoherente consigo mismo. G2 bloquea anular artículos porque «una anulación parcial bajo un cobro produce sobrepago», pero deja pasar un efectivo por el total, que produce un sobrepago completo.

Verificado en el árbol:
(1) payCashOrder toma el FOR UPDATE de Order, pero su relectura no selecciona `status` y no consulta TerminalPaymentRequest. Su CAS acepta paymentStatus PENDING/PARTIAL y, si queda saldada, escribe status COMPLETED.
(2) cancelOrder deja paymentStatus en PENDING y sólo pone status CANCELLED. Por eso un PAY_CASH sobre una orden cancelada pasa el CAS y la «revive» como COMPLETED, sin 🚨. La reproducción offline (sync.mobile PAY_CASH) llama directo a payCashOrder, y assertOwnership sólo mira de quién es la mesa.
(3) settleOrder del dashboard tampoco mira `status` ni el cobro de terminal.
(4) Si la PAX aprueba después, payment.tpv.service registra el cobro sobre una orden ya PAID como 🚨 [Sobrepago], con ActivityLog SOBREPAGO_DETECTADO y `wasAlreadyPaid`. El cliente pagó dos veces.
(5) La admisión de un cobro de terminal sí rechaza CANCELLED/DELETED bajo el mismo lock (terminal-payment.service.ts:565-572). La asimetría existe.

Correcciones al hallazgo:
(a) createManualPayment YA rechaza CANCELLED/DELETED (manualPayment.service.ts:198). A esa ruta sólo le falta el chequeo del cobro vivo.
(b) Es un hueco PREEXISTENTE, no algo que introduzca el diseño. Aun así pertenece al alcance del mecanismo que C.6 construye.
(c) Los números de línea se movieron por el WIP. Hoy son la relectura en 2434, el CAS en 2558 y COMPLETED en 2570.

Bajo la severidad de P1 a P2. En el mismo aparato Android el camino está cerrado: la llave durable del cobro sin confirmar hace que startFlow muestre «Cobro sin confirmar» antes de ofrecer métodos. El doble cobro exige que alguien registre el pago en OTRO aparato o en el dashboard mientras la terminal tiene el cobro vivo. Y el desenlace no es silencioso: 🚨 + ActivityLog + vigilante. El caso de la orden CANCELLED revivida sí es silencioso, pero es integridad de datos (el efectivo existe), no un doble cargo. B4Bit y las ligas de pago no las verifiqué.
  - Evidencia: avoqado-server/src/services/mobile/order.mobile.service.ts:2215 (payCashOrder); :2434-2446 relectura en la tx sin `status` ni consulta de cobros; :2558 CAS `paymentStatus in [PENDING, PARTIAL]`; :2570 `status: 'COMPLETED'`.
avoqado-server/src/services/mobile/order.mobile.service.ts ~3214 cancelOrder: sólo `status: 'CANCELLED'`, paymentStatus sigue en PENDING.
avoqado-server/src/services/mobile/sync.mobile.service.ts:1001 el replay PAY_CASH llama a payCashOrder con isOfflineReplay:true, sin chequeo de estado; assertOwnership (:598) sólo valida quién tiene la mesa.
avoqado-server/src/services/dashboard/order.dashboard.service.ts:637-750 settleOrder: FOR UPDATE + CAS, sin `status` ni terminalPaymentRequest.
avoqado-server/src/services/dashboard/manualPayment.service.ts:198 SÍ rechaza CANCELLED/DELETED (corrige el hallazgo); no consulta el cobro vivo.
avoqado-server/src/services/terminal-payment.service.ts:565-572 la admisión rechaza CANCELLED/DELETED; :1379 findChargeBlockingOrderCancel; shared/orderCancelGuard.ts assertNoLiveTerminalCharge lo usan sólo las rutas de cancelación.
avoqado-server/src/services/tpv/payment.tpv.service.ts:728-775: la tarjeta sobre una orden PAID se registra siempre, con 🚨 [Sobrepago] y ActivityLog (`wasAlreadyPaid`).
Diseño: C.6 se titula «Rutas que cancelan órdenes» y ninguna fila cubre cobros o liquidaciones; la justificación de G2 es la misma clase de sobrepago.
avoqado-android PaymentFlowViewModel.kt ~1740: la llave durable hace que startFlow muestre «Cobro sin confirmar» antes de ofrecer métodos. Con eso el mismo aparato queda cerrado.
  - Arreglo corregido: Extender C.6 con un segundo helper, `assertOrderPayableUnderLock(tx, {venueId, orderId, canal})`, con el mismo orden de candados (Order FOR UPDATE, nunca el advisory de terminal) y relectura dentro del lock.

En línea, en payCashOrder no offline, settleOrder, settleCustomerBalance, createManualPayment y las confirmaciones de liga de pago y de B4Bit, después de verificar su comportamiento:
(1) status CANCELLED/DELETED ⇒ 400 `ORDER_CANCELLED_NO_NEW_CHARGE`, igual que la admisión. createManualPayment ya lo hace y sólo hay que unificarlo.
(2) findChargeBlockingOrderCancel ≠ null ⇒ 409 `ORDER_HAS_LIVE_TERMINAL_CHARGE` con details.requestId: «consulta o cancela el cobro de la terminal primero» (la vía de C.4).
(3) Como el efectivo ya puede estar en la mano del cajero y un UNKNOWN atascado puede durar mucho (las 375 filas históricas), agregar una salida explícita. Registrar con un permiso administrativo (MANAGER+ o el de B) marcando la orden y la fila de terminal con reconciliationRequired, con ActivityLog y 🚨. Así el cajón no queda con dinero sin registrar. Nunca en silencio.

En la reproducción offline (PAY_CASH) no se rechaza: el dinero ya entró. Se registra, pero si la orden estaba CANCELLED/DELETED o tenía un cobro vivo: 🚨, ActivityLog, reconciliationRequired y NO se sube status a COMPLETED en silencio. La orden queda marcada para revisión.

En Android e iOS: leer el 409 nuevo, correlacionado por requestId, con su propio mensaje.

Pruebas de integración con Postgres real:
- Efectivo mientras hay un cobro SENT/UNKNOWN ⇒ 409 sin Payment.
- Efectivo sobre CANCELLED en línea ⇒ 400; en replay ⇒ registrado con 🚨 y sin COMPLETED silencioso.
- settleOrder con cobro vivo ⇒ 409.
- Carrera admisión vs. efectivo esperando el lock en pg_stat_activity: sólo gana uno.
- Sabotaje de cada guarda.

#### 3. [P1] Para el diseño, «cobro vivo» es sólo TerminalPaymentRequest: un cobro LOCAL de la PAX sobre una orden existente es invisible

- **Sección:** C.6
- **Escenario:** El mesero lleva la PAX a la mesa 4 y cobra O1 ($300) desde Cobrar mesas/órdenes (celda 9 de la regla): no se crea fila TerminalPaymentRequest. Mientras el SDK lee la tarjeta, en la tablet se anulan todos los platos (voidItems ⇒ CANCELLED, total 0, platos borrados) o se cancela la cuenta (la mesa se libera y se revierten referidos). El helper da el OK. La PAX aprueba $300 y payment.tpv, que no mira status, deja la orden PAID/COMPLETED: $300 registrados sobre una orden de $0 sin platos (sobrepago que no aparece en inventario), o una cuenta cancelada que revive fuera de su mesa. Pasa lo mismo con un pago B4Bit pendiente o una liga de pago abierta sobre la orden.
- **Evidencia:** Predicado del helper: /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1379-1392 (sólo terminalPaymentRequest). /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/payment.tpv.service.ts:941-944 escribe status COMPLETED sin consultar CANCELLED (grep de CANCELLED en ese archivo: 0 coincidencias). Anular todo: order.tpv.service.ts:2799 (deleteMany), 2845 (CANCELLED). Pago cripto sobre orden: src/services/b4bit/b4bit.service.ts:1147.
- **Arreglo propuesto:** (a) Que la TPV registre en el servidor la intención de cobro local sobre una orden existente ANTES de entrar al kernel: una fila con el attempt_id de la libreta como llave y el mismo predicado UNRESOLVED, que se cierra al registrar el pago o con evidencia negativa. El helper la consulta. (b) Mientras eso no exista, en payment.tpv: un Payment que llega a una orden CANCELLED/DELETED, o que deja pagado > total, genera 🚨, ActivityLog y reconciliationRequired en vez de pasar la orden a COMPLETED en silencio. (c) El helper también consulta pagos B4Bit pendientes y ligas activas de la orden.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: El núcleo se sostiene, pero el hallazgo exagera partes y la severidad. (1) Cierto: el helper del árbol (orderCancelGuard.ts → findChargeBlockingOrderCancel, terminal-payment.service.ts:1377-1392) sólo consulta TerminalPaymentRequest. Un cobro LOCAL de la PAX sobre una orden que ya existe no deja ningún rastro en el servidor antes de entrar al kernel. La TPV no tiene ningún endpoint previo: el cobro llega sólo por POST tpv/venues/{venueId}/orders/{orderId} después de la aprobación, y la validación local de la orden en PaymentViewModel está comentada. O sea que G2 («bloquea toda anulación con un cobro vivo») promete más de lo que el diseño cubre, y el diseño no lo declara. (2) Cierto: recordOrderPayment no lee Order.status y escribe status COMPLETED/PAID cuando isFullyPaid (payment.tpv.service.ts:942). Si alguien cancela la cuenta con cancelOrder (se conserva el total, se libera la mesa, se revierten referidos) mientras el SDK lee la tarjeta, al registrarse el cobro la orden REVIVE a COMPLETED sin ninguna alerta. (3) Exagerado: con anulación parcial o total bajo el cobro, el sobrepago SÍ se ve. El bloque 🚨 [Sobrepago] (payment.tpv.service.ts:737-778) registra y escribe ActivityLog SOBREPAGO_DETECTADO. Lo único cierto de «no aparece» es que no se descuenta el inventario de los platos borrados. (4) Refutado: B4Bit ya tiene justo el candado que pide el arreglo (b4bit.service.ts:1212-1229: si la orden está CANCELLED/DELETED, 🚨, la orden no se toca y devuelve ORDER_NOT_CHARGEABLE). Las ligas de pago siempre crean su propia orden (paymentLink.service.ts:1598, 2468, 3345), así que no existe «una liga abierta sobre la orden». (5) Severidad: no hay cobro doble, no se pierde dinero y el Payment siempre queda registrado y en reportes. Además es un hueco que YA existe en producción, no algo que el diseño introduzca. El daño es que una orden cancelada revive en silencio (se descuadran mesa, referidos y auditoría) y que el inventario no se descuenta en la anulación total. Eso es P2, no P1. (6) El arreglo (a) tal como está redactado es inadecuado. Exigir una fila en el servidor ANTES del kernel en cada cobro local metería un viaje de red obligatorio en el camino del dinero. Eso choca con que la TPV cobre y encole cuando el servidor no responde (regla sin-red, escenario LTE) y con la prioridad 1 de la regla (que el cobro pase sin demoras evitables).
  - Evidencia: - avoqado-server/src/services/shared/orderCancelGuard.ts:61-75 y 93-126: assertOrderCancellableUnderLock hace PAID/PARTIAL y luego assertNoLiveTerminalCharge; lo único que consulta es terminalPaymentService.findChargeBlockingOrderCancel.
- avoqado-server/src/services/terminal-payment.service.ts:1377-1392: findFirst sobre terminalPaymentRequest con UNRESOLVED_FINANCIAL_OUTCOME. No mira ninguna otra tabla.
- avoqado-tpv/.../core/data/network/ApiService.kt y features/payment/data/api/PaymentApiService.kt:164: el único POST de cobro sobre una orden existente es `tpv/venues/{venueId}/orders/{orderId}`, posterior a la aprobación. No hay endpoint de intención, bloqueo ni sesión previo al kernel. Los archivos de ledger/* no hacen llamadas de red.
- avoqado-tpv/app/src/sandbox/.../PaymentViewModel.kt:3277-3300: la validación local de la orden está deshabilitada (bloque comentado «Optional validation path (disabled)»).
- avoqado-server/src/services/tpv/payment.tpv.service.ts:2115-2138: recordOrderPayment sólo valida que la orden exista en el venue, nunca su status. En :942 escribe `status: 'COMPLETED'` si isFullyPaid. grep de CANCELLED|DELETED en el archivo: 0.
- payment.tpv.service.ts:737-778: 🚨 [Sobrepago] con ActivityLog SOBREPAGO_DETECTADO (fire-and-forget). Cubre la anulación parcial y la total bajo el cobro.
- avoqado-server/src/services/mobile/order.mobile.service.ts:3219-3270 (cancelOrder): pone status CANCELLED sin tocar el total y libera la mesa. Un cobro de $300 que llega después ⇒ isFullyPaid ⇒ COMPLETED sin alerta.
- avoqado-server/src/services/tpv/order.tpv.service.ts:2795-2845 (voidItems, anular todo): deleteMany de platos, total 0, CANCELLED/PENDING. El cobro posterior dispara 🚨 Sobrepago y revive la orden a COMPLETED; el inventario de esos platos ya no se descuenta.
- avoqado-server/src/services/b4bit/b4bit.service.ts:1212-1229: el guard «UNA ORDEN CANCELADA NO SE RESUCITA» ya existe (🚨 y untouched('ORDER_NOT_CHARGEABLE')). Refuta la parte B4Bit.
- avoqado-server/src/services/dashboard/paymentLink.service.ts:1598, 2468, 3345: la liga siempre hace tx.order.create. No se engancha a una orden existente.
  - Arreglo corregido: 1) Diseño C.6 y G2: declarar explícitamente que «cobro vivo» = TerminalPaymentRequest sin desenlace acreditado, y que un cobro LOCAL de la PAX sobre una orden existente (Cobrar mesas/órdenes, división) no es visible para el servidor antes de la aprobación. Es un límite que ya existe hoy, no algo que el diseño resuelva.
2) En su lugar, cerrar el efecto en el servidor, copiando el patrón que ya tiene B4Bit. En recordOrderPayment (y revisar los caminos gemelos: payCashOrder móvil, manualPayment, settleOrder del dashboard), bajo el FOR UPDATE de Order, releer status. Si la orden está CANCELLED/DELETED: el Payment se registra SIEMPRE (la tarjeta ya se cobró, nunca se rechaza), la orden NO pasa a COMPLETED en silencio, 🚨 con un token estable, ActivityLog (p. ej. PAYMENT_ON_CANCELLED_ORDER) y reconciliationRequired. Decidir una sola política para todos los canales (dejarla CANCELLED como B4Bit, o reabrirla con aviso) y probarla con integración contra Postgres: cobro concurrente con cancelOrder y con voidItems de todo.
3) Si el founder quiere además prevención (no sólo detección): la TPV avisa best-effort de su intención de cobro local (con el attempt_id de la libreta) en paralelo al kernel, NUNCA como barrera antes del SDK. El helper la trata como bloqueador sólo mientras esté abierta y dentro de una vigencia corta. Sin red, el cobro sigue igual y el punto 2 cubre el resultado.
4) Quitar del arreglo el inciso (c): B4Bit ya tiene el guard, y las ligas de pago no se ligan a órdenes existentes. El sobrepago en una anulación parcial ya alerta; lo único que queda sin cubrir es el inventario no descontado de los platos borrados, que se atiende con el mismo 🚨 del punto 2.

#### 4. [P1] G2 sólo bloquea con cobro vivo; en PARTIAL deja anular lo ya pagado y bajar el total por debajo de lo cobrado

- **Sección:** G2
- **Escenario:** A (división por producto): O1 con platos A/B/C de $100 cada uno. El cliente 1 paga A por PERPRODUCT ($100, asignación a A). Sin cobro vivo, el mesero anula A: voidItems sólo rechaza PAID, y la asignación queda huérfana (FK ON DELETE SET NULL). El total baja a $200 con $100 pagados, así que al cliente 2 se le piden $100 por B y C, que valen $200. Se pierden $100 y el reembolso de A nunca ocurre. B (monto libre): hay $250 pagados de $300 (PARTIAL) y se anula C ($100), así que el total baja a $200, por debajo de lo pagado. max(0, …) lo tapa: la orden queda PARTIAL con saldo 0 y $50 de sobrepago sin aviso ni reembolso. El diseño sólo rechaza «anular todo» en PARTIAL. Al revés, bloquear TODA anulación con cobro vivo impide casos inofensivos (quitar un refresco de $30 de una cuenta de $300 con un cobro de $100 por monto libre).
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/order.tpv.service.ts:2725 (sólo PAID), 2799 (deleteMany), 2831 (newRemainingBalance = max(0, …)); el mismo recorte está en removeOrderItem 2332, compItems 2567 y applyDiscount 3118. Asignación por plato: src/services/tpv/payment.tpv.service.ts:2571-2583. FK: prisma/migrations/20250612162608_your_migration_name/migration.sql:1190 (PaymentAllocation_orderItemId_fkey ON DELETE SET NULL).
- **Arreglo propuesto:** Convertir G2 en un invariante de dinero, verificado bajo el candado: rechazar (400 con código propio) si nuevo total sin propina < pagado neto sin propina + Σ amountCents de cobros vivos, y rechazar anular, quitar o cortesiar líneas con PaymentAllocation.orderItemId (reembolso primero, como Square). Aplicarlo en voidItems, removeOrderItem, compItems, applyDiscount y sus equivalentes móviles. Así se cierra el hueco de PARTIAL y deja de bloquearse lo inofensivo. Agregar pruebas de tabla con split PERPRODUCT, CUSTOMAMOUNT, propina y cargo por servicio.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: El núcleo se sostiene contra el árbol de trabajo. En la TPV, voidItems sólo rechaza PAID. Anular todo en PARTIAL también se rechaza, pero una anulación parcial en PARTIAL se permite a propósito. El comentario en order.tpv.service.ts:2822-2823 lo dice ("Una anulación parcial sobre una PARTIAL sigue permitida"), y el diseño §C.6/G2 lo repite. Nada revisa PaymentAllocation.orderItemId. El renglón pagado se borra y su asignación queda huérfana (FK ON DELETE SET NULL). El saldo se tapa con max(0, …). La justificación del propio G2 ("una anulación parcial bajo un cobro produce sobrepago") vale igual para un cobro ya COMPLETED, que el diseño deja abierto. Y G2 bloquea también casos inofensivos: con un cobro vivo de $100 en una cuenta de $300, quitar $30 no crea sobrepago. Hay una asimetría que refuerza el hallazgo: el móvil applyOrderDiscount (order.mobile.service.ts:1429) ya rechaza PARTIAL, y el applyDiscount de la TPV (3064) no.

Bajo la severidad a P2 y corrijo el escenario, por cuatro razones:
(1) El defecto es preexistente. El diseño no lo introduce ni lo empeora, y queda fuera del circuito de cobro remoto: es el G2 mal acotado, no un hueco nuevo.
(2) Escenario A mal descrito: el restaurante no "pierde $100". Si al cliente 2 se le cobra el saldo ($100), se cobran $200 por B y C, que es correcto: el cliente 1 pagó un plato anulado y subsidió al 2, así que queda un reembolso pendiente mal atribuido. Si se le cobra por producto ($200), el restaurante recibe $300 por $200: sobrepago de $100.
(3) Escenario B, "queda PARTIAL sin aviso", es inexacto a medio plazo. paid-order-reconciler (criterio pagadaPeroAbierta: cobrado ≥ base canónica) cierra la orden. Además, el vigilante money-integrity-watchdog alerta 'SOBREPAGO' (job :202-226), así que el equipo de operaciones sí se entera, después del hecho. Lo que falta es un rechazo o aviso en el momento y el reembolso.
(4) Exige una acción deliberada del personal (con motivo y staffId). No es una carrera ni un fallo silencioso del sistema.
Sigue siendo un defecto objetivo de dinero que el diseño legaliza de forma explícita. Por eso no se refuta.
  - Evidencia: avoqado-server/src/services/tpv/order.tpv.service.ts:
- voidItems: prelectura, sólo PAID (:2736). Bajo el candado, PAID (:2819) y PARTIAL sólo con isVoidingAllItems (:2824). anulacionExigeOrdenSinCobroVivo devuelve siempre true (:2464-2466), es decir, bloquea toda anulación con cobro vivo. deleteMany de los renglones sin mirar asignaciones (:2836-2842). newRemainingBalance = Math.max(0, newTotal - currentPaidAmount) (:2873). paymentStatus no se toca.
- El mismo patrón en removeOrderItem (:2258 sólo PAID, :2333 max(0)), compItems (:2492, :2578), applyDiscount (:3064, :3161) y addItems (:1447/:1973).
- En este archivo no hay ninguna comprobación de allocation antes de borrar; sólo include o lectura en :124, :209, :299-302.

Asignación por plato: payment.tpv.service.ts:2571-2583 (PERPRODUCT crea PaymentAllocation con orderItemId y amount = item.total).

FK: prisma/migrations/20250612162608_your_migration_name/migration.sql:1190 (PaymentAllocation_orderItemId_fkey ON DELETE SET NULL). Ninguna migración posterior la cambia; 20250724233515 sólo toca paymentId.

Contrapeso existente: src/jobs/money-integrity-watchdog.job.ts:202-226 (check SOBREPAGO: Σ Payment.amount COMPLETED no-REFUND > baseQueDebeCubrirseSql) y src/services/shared/pagadaPeroAbierta.ts (el barrido cierra órdenes con cobrado ≥ base).

Asimetría: src/services/mobile/order.mobile.service.ts:1429 y :1498 rechazan descuento o quitar descuento en PAID o PARTIAL.

Diseño: diseno-A-B-seccion8-2026-09-11.md:341 ("bloquea toda anulación con un cobro vivo … anular todo en PARTIAL se rechaza") y :421 (G2).
  - Arreglo corregido: Reemplazar G2 por un invariante de dinero que se evalúe bajo el mismo candado Order FOR UPDATE que ya toma voidItems, extendido a removeOrderItem, compItems y applyDiscount de la TPV.

(a) Rechazar con 400 y código propio (p. ej. ORDER_EDIT_BELOW_PAID) si la base canónica nueva (la de baseQueDebeCubrirseSql: max(0, subtotal − descuento) + cargo por servicio + max(0, IVA), sin propina) queda por debajo de la suma de dos cosas:
- lo cobrado neto: Σ Payment.amount COMPLETED no-REFUND menos Σ reembolsos. Aquí sí se restan los reembolsos, a diferencia de COBRO_QUE_CUBRE; si no, reembolsar primero nunca desbloquearía la anulación. Se deja declarado que esto contrasta con la regla "un reembolso no reabre saldo".
- Σ amountCents de los cobros vivos de terminal de esa orden (sin tip).

(b) Rechazar anular, quitar o cortesiar un renglón que tenga PaymentAllocation.orderItemId de un pago no reembolsado. Primero va el reembolso, como Square.

(c) Con eso se retira el bloqueo total de G2: una anulación que deja la base ≥ cobrado + vivos se permite aunque haya un cobro en curso.

(d) Alinear con el móvil, que hoy es más estricto con los descuentos en PARTIAL, o llevar el móvil al mismo invariante. Debe haber una sola regla, en un helper compartido.

Pruebas de tabla con PERPRODUCT (anular el plato pagado), CUSTOMAMOUNT (anular hasta quedar por debajo de lo cobrado, o dejarlo igual), propina, cargo por servicio porcentual, IVA separado (taxAmount > 0), reembolso previo y cobro vivo. Cada caso debe verificarse rompiendo el helper a propósito.

Aparte, aunque no bloquea: el vigilante SOBREPAGO ya detecta el síntoma después del hecho, así que no hace falta un aviso nuevo del lado de operaciones.

#### 5. [P1] El job abandoned-orders-cleanup BORRA órdenes (hard delete en cascada) sin candado ni consulta de cobros

- **Sección:** C.6 (ruta faltante)
- **Escenario:** Orden TAKEOUT O1 con cobro remoto. En una TPV alguien quita el último plato (removeOrderItem no bloquea el último ni cancela) y O1 queda con 0 platos, PENDING/PENDING. La fila de la terminal queda UNKNOWN (PAX dormida). A los 30 min el job hace deleteMany de O1. Cuando la PAX despierta, el registro de la aprobación recibe ORDER_NOT_FOUND y cae a venta rápida. closeRowFromPaymentTx exige que el Payment tenga la orderId de la fila, así que la fila no se cierra aunque el Payment exista: queda UNRESOLVED para siempre, con la terminal y la llave del POS bloqueadas hasta B. TerminalPaymentRequest.orderId no tiene FK, así que nada impide el borrado. Y Payment.order es onDelete Cascade: una orden histórica «PENDING con pagos COMPLETED» sin platos (estado inconsistente reconocido en el propio código) se lleva sus Payments.
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/jobs/abandoned-orders-cleanup.job.ts:81-129 (findMany sin tope + deleteMany). En prisma/schema.prisma, Payment.order tiene onDelete: Cascade y TerminalPaymentRequest.orderId es un String sin @relation. src/services/tpv/payment.tpv.service.ts:2135 (ORDER_NOT_FOUND). src/services/terminal-payment.service.ts:1219 (exige payment.orderId = before.orderId). src/services/tpv/order.tpv.service.ts:2216-2340 (removeOrderItem sin cancelación en el último plato). Estados inconsistentes admitidos: src/services/dashboard/order.dashboard.service.ts:593-596.
- **Arreglo propuesto:** Agregar el job a la tabla C.6: por cada orden, una transacción con el helper (FOR UPDATE; sin filas de terminal con esa orderId fuera de COMPLETED; cero Payments de cualquier tipo) y soft-cancel en lugar de deleteMany. Tratar el último plato quitado como cancelación protegida. En closeRowFromPaymentTx, si la orden de la fila ya no existe y el Payment trae processorData.terminalPaymentRequestId = requestId, del mismo serial acreditado, cerrar con 🚨 en vez de ignorar.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No pude refutar el escenario principal: cada eslabón está en el código del árbol de trabajo. Le bajo la severidad a P2 por tres motivos.

(1) No se pierde dinero ni se cobra dos veces. El cobro queda registrado en una venta rápida (FAST) y el fallback emite un 🚨 («recordOrderPayment tronó al delegar — el cobro cae a venta rápida»), así que alguien se entera. Lo que se pierde es disponibilidad: la terminal queda reservada y la llave del POS atorada hasta la liberación B. También se pierden los renglones de la venta real.

(2) El disparador es una combinación poco común:
- la orden es TAKEOUT (en Android el carrito usa DINE_IN por defecto; TAKEOUT sólo sale con «Para llevar» o con órdenes creadas en la TPV);
- la aprobación se registra tarde, con la fila en UNKNOWN;
- y un operador quita en la TPV TODOS los artículos de una orden que tiene un cobro en vuelo.

(3) La segunda mitad del hallazgo, «se lleva sus Payments por cascada», queda en gran parte refutada. PaymentAllocation.orderId es ON DELETE RESTRICT (migración 20250612162608, línea 1193), y todas las rutas de cobro con orden crean ese PaymentAllocation (payment.tpv.service.ts:2577/2588/3983, order.mobile.service.ts:2674, manualPayment.service.ts:429). Una orden con pagos asignados no se borra: el deleteMany completo falla y aborta el lote cada 15 minutos. Eso es otro defecto, un «lote envenenado», pero no destruye Payments. Sólo quedan expuestos Payments heredados sin asignación, y además tendrían que caer en la intersección TAKEOUT + 0 artículos + PENDING/PENDING.

Hay un hueco adicional que sostiene el hallazgo con más fuerza que el propio job. removeOrderItem (DELETE /tpv/venues/:venueId/orders/:orderId/items/:itemId) NO está en la tabla C.6: esa tabla cubre voidItems («Anular artículos»), que sí usa anulacionExigeOrdenSinCobroVivo. Por la razón de G2, quitar CUALQUIER artículo con un cobro vivo baja el total y deja un sobrepago cuando el cobro aterriza, aunque el job nunca corra.

El arreglo propuesto también tiene una falla. Pide que el Payment traiga processorData.terminalPaymentRequestId === requestId, pero la venta rápida NO estampa ese campo al crear el Payment (payment.tpv.service.ts:3883-3905): sólo lo escribe closeRowFromPaymentTx cuando logra cerrar la fila. Con esa condición la fila nunca cerraría. Además findReconcilablePayment filtra por orderId igual que closeRowFromPaymentTx, así que tampoco la recupera el barrido.
  - Evidencia: Servidor (árbol de trabajo):

- src/jobs/abandoned-orders-cleanup.job.ts:82-130 — findMany sin take (TAKEOUT, PENDING/PENDING, createdAt < ahora−30 min), filtrado en memoria de las órdenes con items.length===0 y prisma.order.deleteMany por ids, sin transacción, sin candado y sin consultar TerminalPaymentRequest ni Payment. Se arranca en src/server.ts:505 cada 15 min.
- prisma/schema.prisma:
  - Payment.order es onDelete: Cascade (la migración 20250724231726 cambió el FK a ON DELETE CASCADE);
  - TerminalPaymentRequest.orderId es String? sin @relation (ninguna FK impide el borrado);
  - PaymentAllocation.order no declara onDelete ⇒ ON DELETE RESTRICT (migración 20250612162608:1193).
- src/services/tpv/order.tpv.service.ts:2217-2440 — removeOrderItem sólo rechaza paymentStatus==='PAID'. No toma candado ni revisa cobros de terminal vivos, borra el último artículo sin cancelar la orden y la deja PENDING/PENDING con 0 artículos. La guarda de G2 (anulacionExigeOrdenSinCobroVivo, :2464) sólo se usa en voidItems (:2827).
- Clientes: la TPV lo llama desde MenuScreen.kt:461 → MenuViewModel.removeItem, y también desde la cola offline (OrderSyncCoordinator.kt:1467).
- La admisión del cobro no cambia el estado de la orden: en terminal-payment.service.ts sólo hay un findFirst en :558, sin update de Order.
- payment.tpv.service.ts:2134-2135 — recordOrderPayment lanza ORDER_NOT_FOUND. recordFastPayment con terminalPaymentRequestId delega a la orden de la fila (resolveFastPaymentTarget → existingOrder); al tronar y verificar not-landed cae a FAST con 🚨 (:3500-3512) y crea una orden nueva.
- Luego llama closeRowFromPaymentTx (:4023-4034). Ese cierre busca el Payment con orderId: before.orderId (terminal-payment.service.ts:1219) y regresa sin cerrar.
- findReconcilablePayment (:1541) también filtra por orderId de la fila.
- Una sonda RESOLVED/success pasa por closeRow → closeRowFromPaymentTx (:2232-2281, :1107): tampoco cierra. La fila queda en UNRESOLVED_FINANCIAL_OUTCOME.
- El processorData de la venta rápida al crearse (:3883-3905) no incluye terminalPaymentRequestId.
  - Arreglo corregido: 1) Agregar a la tabla C.6 dos rutas.

a) DELETE /tpv/.../orders/:orderId/items/:itemId (removeOrderItem), con el mismo helper y la misma regla G2:
- candado de Order FOR UPDATE al inicio y relectura con CAS de versión;
- 409 ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE con details.requestId ante CUALQUIER cobro de terminal vivo o sin desenlace sobre la orden, no sólo cuando se quita el último artículo;
- quitar el último artículo se trata como cancelación protegida (assertOrderCancellableUnderLock);
- en la cola offline de la TPV, un REMOVE_ITEM bloqueado va a cuarentena con aviso, igual que CANCEL_ORDER y MERGE_ORDERS.

b) El job abandoned-orders-cleanup:
- lote acotado (take + cursor);
- una transacción por orden con FOR UPDATE y relectura (0 artículos, PENDING/PENDING, TAKEOUT);
- se omite la orden si existe cualquier TerminalPaymentRequest con ese orderId que no esté en un desenlace acreditado, o si existe cualquier Payment (type nulo incluido);
- soft-cancel (CANCELLED + ActivityLog) en vez de deleteMany. Quitar el hard delete también elimina el lote envenenado por el RESTRICT de PaymentAllocation: hoy una sola orden con asignaciones hace fallar el borrado de todas cada 15 minutos.

2) Cierre defensivo cuando la orden de la fila ya no existe.

No condicionarlo a processorData.terminalPaymentRequestId, porque la venta rápida no lo lleva al crearse. Hay dos opciones:
- estampar terminalPaymentRequestId en el processorData del Payment de la venta rápida cuando el payload trae la llave, dentro de la misma transacción;
- o, en closeRowFromPaymentTx, si before.orderId no existe (comprobado dentro de la transacción), aceptar el Payment recién creado que se pasa por parámetro, siempre que el importe cuadre y el serial acreditado coincida con before.terminalId. Cerrar con failureCode ORDER_MISSING + 🚨 y ActivityLog.

Aplicar la misma relajación en findReconcilablePayment, para que el barrido y la sonda también recuperen la fila. Sin evidencia de serial, la fila se conserva para B.

3) Declarar aparte el lote envenenado por PaymentAllocation RESTRICT si se mantiene algún borrado físico.

#### 6. [P2] La cuarentena del CANCEL_ORDER o MERGE_ORDERS no detiene los intents que dependen de él

- **Sección:** C.6 / cola offline
- **Escenario:** La tablet B, sin red, cancela O1 (mesa 5), abre la mesa 5 para otra familia (OPEN_TABLE con localOrderId O2), agrega $120 y cobra $120 en efectivo. Al reconectar, O1 tiene un cobro vivo y el CANCEL_ORDER queda REJECTED en cuarentena, pero el lote sigue: applyOpenTable → assignTable devuelve la orden ACTIVA de la mesa (O1) y mapea O2→O1, así que ADD_ITEMS y PAY_CASH caen en O1: dos familias en una sola cuenta con un cobro de terminal encima. Con MERGE: B fusiona S en T y cobra $500 en efectivo. El MERGE se rechaza y el PAY_CASH va a T, que debe $200: payCashOrder recorta al saldo y reporta $300 como changeCents que el aparato offline nunca devolvió. Resultado: sobrante de $300 en el corte, y S sigue con su cobro de terminal; si aprueba, S pagó dos veces. Además, SyncIntentAck no lleva details, así que el «aviso específico» no puede nombrar el requestId que bloquea.
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/mobile/sync.mobile.service.ts:570-586 (un code que no es reintentable ⇒ REJECTED y el lote continúa), 647-693 (applyOpenTable → tableService.assignTable, que reusa la orden activa), 76-91 (SyncIntentAck sin details), 1111-1114 (CANCEL_ORDER). Recorte a saldo y cambio en payCashOrder (order.mobile.service.ts, bloque «Un cobro MAYOR al saldo no es una venta mayor: es CAMBIO»).
- **Arreglo propuesto:** Barrera de dependencias en el servidor. Al rechazar un CANCEL o MERGE por ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE, marcar su orderId, su tableId y los localRefs asociados como retenidos para el resto del lote y de la cola de ese aparato. Los intents dependientes vuelven como RETRY con DEPENDENCY_HELD; OPEN_TABLE nunca adopta la orden retenida. PAY_CASH debe llevar expectedTotalCents o la versión que vio el aparato; si difiere, se registra con 🚨 (el efectivo ya entró) en vez de recortar a «cambio». Agregar details al ack. Evaluar clasificar el 409 nuevo como RETRY acotado (el cobro vivo se resuelve en ≤5 min o por B) antes de mandarlo a cuarentena.
- **Escéptico:** REFUTADO → severidad P3
  - Razón: Las piezas del servidor que cita el hallazgo existen. Un REJECTED no corta el lote: sólo lo corta un RETRY. `applyOpenTable` usa `assignTable`, que reutiliza la orden activa de la mesa. `payCashOrder` recorta el pago al saldo y devuelve el exceso como `changeCents`. `SyncIntentAck` no trae `details`. Pero el escenario necesita un disparador que ninguno de los dos POS produce hoy.

Caso de la cancelación: después de un CANCEL_ORDER sin red, ni Android ni iOS marcan la mesa como libre en su estado local. El `refresh` falla, y `hydrateFromCache` sólo hidrata si la lista de mesas está vacía. Tampoco existe un `markTableFreeLocally`. Así que la mesa 5 sigue ocupada por O1, también si la app se reinicia (el caché trae O1). OPEN_TABLE sólo se encola cuando la mesa está disponible (`table.isAvailable`, que es `!hasOpenCheck`), y «Abrir mesa» sólo aparece en ese estado. Por eso nunca nace la O2 que el servidor mapearía a O1 en silencio: el mesero sigue viendo O1.

Caso de la fusión: después de un MERGE sin red, `loadCheck` falla y la cuenta local de T sigue siendo la del caché ($200). «Cobrar» siembra el carrito con `table.primaryCheck.total`, y la app manda siempre el total exacto. El PAY_CASH sería de $200, no de $500. No hay cambio fantasma de $300 ni cobro doble de S por esa ruta.

Lo que sí queda en pie es menor. El ack no lleva `details`, así que el aviso de cuarentena puede ser específico por `errorCode` y mensaje, pero no puede nombrar el `requestId` ni el monto que bloquea. Y seguir el lote después de un REJECTED es una propiedad general de la cola que ya existía: cualquier cancelación rechazada por PAID o PARTIAL se comporta igual. No es algo que introduzca la sección C.6. Mandar el 409 nuevo como RETRY sería peor: cortaría el lote y dejaría detenidos los cobros en efectivo posteriores mientras la reserva siga en UNKNOWN, y hoy no hay liberación manual.
  - Evidencia: Servidor:
- `avoqado-server/src/services/mobile/sync.mobile.service.ts:484-500`: sólo un RETRY hace `break`; un REJECTED se persiste y el lote continúa.
- `sync.mobile.service.ts:574-585`: un `code` que no está en `RETRYABLE_ERROR_CODES` produce REJECTED.
- `sync.mobile.service.ts:76-91`: `SyncIntentAck` no tiene `details`.
- `sync.mobile.service.ts:684`: `applyOpenTable` llama a `tableService.assignTable`.
- `src/services/shared/orderCancelGuard.ts:81`: lanza `ConflictError(..., ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE, details)`; `details` se pierde en el ack.
- `src/services/mobile/order.mobile.service.ts:2484-2527`: `cambioCents = max(0, amount - saldoCents)`, el recorte del efectivo.
- `order.mobile.service.ts:1928-1937`: la fusión ya bloquea el origen.

Android:
- `avoqado-android/.../tables/presentation/TablesViewModel.kt:358-380`: `anularCuenta` sin red da éxito, llama a `refresh` (falla) y no libera la mesa localmente.
- `tables/data/TableServiceRepository.kt:140-185`: `refresh` cae a `hydrateFromCache`, que sólo actúa si `_tables` está vacío; el único mutador local es `markTableOccupiedLocally`.
- `tables/data/TableModels.kt:39`: `hasOpenCheck`; `:105`: `isAvailable = !hasOpenCheck && status != "RESERVED"`.
- `TablesScreen.kt:808-832`: «Abrir mesa y ordenar» sólo aparece con `table.isAvailable`.
- `TablesViewModel.kt:211-238`: `openTableOffline` es el único que encola OPEN_TABLE.
- `TableOrderViewModel.kt:988-1004` (`mergeFrom`) y `:184-220` (`loadCheck` sin red no cambia la cuenta): no hay total fusionado local.
- `TablesViewModel.kt` `startCobrar`: siembra el carrito con `primaryCheck.total`.

iOS, mismo patrón:
- `avoqado-ios/avoqado-ios/Tables/TablesViewModel.swift:358-376`
- `Tables/TableOrderViewModel.swift:788-801` y `:996-1010`
- `Tables/TableServiceRepository.swift:61-121`: `hydrateFromCache` exige `tables.isEmpty`; sólo existe `markTableOccupiedLocally`.

Diseño:
- `diseno-A-B-seccion8-2026-09-11.md:331-349`: la sección C.6 no cambia cómo el cliente refleja localmente la cancelación ni la fusión.
  - Arreglo corregido: 1. Agregar `details` al `SyncIntentAck` de forma aditiva (opcional, y los clientes viejos lo ignoran). En `applyIntent`, copiar `error.details` cuando el `errorCode` sea `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`: `requestId`, `orderId` (origen, en la fusión) y el monto si ya viaja. Así la cuarentena de Android e iOS puede decir qué cobro bloquea («Hay un cobro de $X en curso en la terminal; espera su resultado y vuelve a intentar»). Guardarlo en `resultJson` o en una columna para que el replay idempotente (`ackFromExisting`) devuelva el mismo `details`. Mantener REJECTED, no RETRY: un RETRY cortaría el lote y dejaría esperando los cobros en efectivo posteriores mientras la reserva siga en UNKNOWN.

2. Documentar en C.6 el invariante que hoy impide la cascada: el POS no refleja localmente una cancelación ni una fusión hecha sin red (la mesa sigue ocupada y la cuenta queda como en el caché). Agregar una prueba en cada app que lo fije: después de `anularCuenta` sin red, la mesa no queda `isAvailable`; después de `mergeFrom` sin red, el total de Cobrar no cambia.

3. Si algún día se decide liberar la mesa localmente o mostrar el total fusionado sin red, en ese mismo cambio hace falta la barrera de dependencias del servidor que propone el hallazgo: retener `orderId`, `tableId` y `localRef`; que OPEN_TABLE no adopte una orden retenida; y que PAY_CASH lleve `expectedTotalCents` y registre con 🚨 en vez de recortar a cambio.

#### 7. [P2] Más candados de Order ⇒ más P2028 en la admisión, y ese error sale como 500 sin código: llave irresoluble

- **Sección:** C.3
- **Escenario:** La PAX registra un cobro de la mesa (payment.tpv financial_commit con Order FOR UPDATE, varios segundos bajo carga) mientras la tablet manda otro cobro sobre la misma orden; o el helper nuevo en merge, void o DELETE retiene la fila Order. reserve() corre con los defaults de Prisma (maxWait 2 s, timeout 5 s) ⇒ P2028/P2024. La transacción se revierte, así que no hay fila. El controlador cae al 500 genérico sin code ni requestId. Android lo toma como fallo de transporte, conserva la llave y consulta; el GET da 404, que por regla no acredita nada ⇒ «cobro sin confirmar» sin salida para esa venta. C.3 sólo cubre ORDER_CANCELLED_NO_NEW_CHARGE y TERMINAL_NOT_CONNECTED.
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:623 (prisma.$transaction(reserve) sin opciones) y 552 (FOR UPDATE de Order dentro). /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/mobile/terminal-payment.mobile.controller.ts:188-199 (500 sin code). cancelOrder, en cambio, usa timeout 15 s / maxWait 5 s (order.mobile.service.ts:3244). /Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/domain/CardChargeOutcome.kt:181 y TerminalPaymentService.kt:322,432.
- **Arreglo propuesto:** En C.3, envolver reserve: si el error es un P2028/P2024/P2034 que Prisma lanza ANTES del COMMIT (transacción revertida), releer por requestId fuera de la transacción. Si la fila existe ⇒ réplica; si no ⇒ 503 TERMINAL_CHARGE_NOT_CREATED con details.requestId, que prueba «no se creó», y Android/iOS liberan la llave. Cualquier otro error (conexión caída durante el COMMIT) conserva el 500, porque ahí no hay prueba. Dar a reserve timeouts explícitos y agregar una prueba de integración con un FOR UPDATE ajeno retenido sobre la orden.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No lo pude refutar. El núcleo se sostiene contra el código. La causa que da el revisor sí está exagerada; el defecto, no.

1) `reserve` corre con `prisma.$transaction(reserve)` sin opciones (terminal-payment.service.ts:623). Prisma no tiene opciones globales (`prismaClient.ts` no define `transactionOptions`). Así que aplican los valores por defecto: `maxWait` de 2 s para conseguir conexión y `timeout` de 5 s. Dentro de `reserve` se toman el advisory de la terminal y el `FOR UPDATE` de Order (:552).

2) Otros dueños del candado de Order pueden retenerlo más de 5 s: `cancelOrder` (order.mobile.service.ts:3244, 15 s) y la anulación de la TPV (order.tpv.service.ts:2939, `timeout 15_000`). `financial_commit` de payment.tpv usa 5 s por defecto. Con `reserve` esperando más que su presupuesto, sale P2028. La transacción se revierte y la fila nunca queda visible.

3) El controlador sólo mapea `TerminalBusyError`, `OrderAlreadyPaidError`, dos mensajes y `BadRequestError`. P2028 cae al 500 genérico, sin `code` ni `requestId` (terminal-payment.mobile.controller.ts:188-199).

4) Android (`CardChargeDecision.mustReconcile`: ≥500 reconcilia) conserva la llave, consulta, y el GET responde 404. En el último intento, `decide(NotFound)` da `Undetermined`. iOS hace lo mismo (CardChargeOutcome.swift:150,166). No hay salida: la regla «404 sostenido ⇒ nunca se envió» sigue siendo una decisión pendiente. La cancelación durable de C.4 trata el 404 como «pendiente», así que tampoco la cierra.

5) El diseño no menciona 5xx en ningún lugar. C.3 dice cerrar el P1-3, «llave irresoluble», pero sólo cubre ORDER_CANCELLED_NO_NEW_CHARGE y TERMINAL_NOT_CONNECTED.

Matiz que corrige el hallazgo: el disparador más probable no son «más candados de Order». Esas rutas (C.6) son raras y duran milisegundos, y parte ya está en el árbol (merge :1891, anular :2939). El disparador probable es la saturación del pool. Con el pool de 18 lleno (ya pasó en prod el 2026-06-23 con P2024), el `maxWait` de 2 s de `reserve` es el límite más estricto de toda la petición. Da P2028 «Unable to start a transaction» sin haber creado nada. En ese incidente, cada tablet que intentara cobrar se quedaría con una llave irresoluble. El defecto ya existía y el diseño lo deja abierto aunque dice cerrarlo. No mueve dinero de más: bloquea la venta y obliga a intervenir a mano. Por eso P2.
  - Evidencia: - avoqado-server/src/services/terminal-payment.service.ts:528-621 (`reserve`: advisory `pg_advisory_xact_lock`, `SELECT … FOR UPDATE` de Order en :552 y el create) y :623 (`prisma.$transaction(reserve)` sin opciones). El catch de :625 sólo procesa `isPrismaUniqueViolation`; el resto lo relanza.
- avoqado-server/src/utils/prismaClient.ts: `new PrismaClient` sin `transactionOptions`, `connection_limit=18` y `pool_timeout` de 10 s por defecto.
- Dueños del candado de Order con presupuesto de 15 s: order.mobile.service.ts:3244 (`cancelOrder`) y order.tpv.service.ts:2939 (`{ timeout: 15_000, maxWait: 5_000 }`). `financial_commit` en payment.tpv.service.ts:2302-2627 corre con los valores por defecto y toma `lockExistingOrderForPayment` en :2317.
- avoqado-server/src/controllers/mobile/terminal-payment.mobile.controller.ts:132-199: el catch no reconoce errores de Prisma y devuelve `500 {success:false, message:'Error interno del servidor'}`.
- avoqado-android/.../payment/domain/CardChargeOutcome.kt:173-181 (`mustReconcile`, `isTransportFailure >= 500`) y :191-197 (`NotFound` en el intento final ⇒ `Undetermined`). TerminalPaymentService.kt:357-367 (`resolveOutcome`) y :424-427 (404 ⇒ `NotFound`, «no acredita ausencia de cargo»).
- avoqado-ios/avoqado-ios/Payment/CardChargeOutcome.swift:150,166-167: la misma clasificación.
- diseno-A-B-seccion8-2026-09-11.md:280-286 (C.3 lista sólo dos códigos y afirma cerrar P1-3). En el documento no aparece «500», 5xx, P2028 ni `timeout` para `reserve`.
- Tabla de proyectos: la regla «404 sostenido + antigüedad ⇒ nunca se envió» sigue como decisión pendiente, así que el POS no tiene otra salida.
  - Arreglo corregido: Añadir en C.3 una tercera prueba de «no se creó», pensada para errores de Prisma antes del commit, además de los dos códigos:

(a) Dar a `reserve` opciones explícitas coherentes con quienes retienen Order: `timeout` de 15 s y `maxWait` de 5 s, como `cancelOrder`. Así una espera normal del candado no aborta la admisión.

(b) Envolver `prisma.$transaction(reserve)`. Si el error es `PrismaClientKnownRequestError` con código P2028 (timeout o «unable to start», o sea, el commit nunca se ejecutó) o P2034 (conflicto o deadlock abortado por Postgres), releer por `requestId` y `venueId` fuera de la transacción:
- Si la fila existe ⇒ `validateReplayContract` y réplica.
- Si no existe ⇒ lanzar un error tipado que el controlador convierta en `503 {status:'failed', code:'TERMINAL_CHARGE_NOT_CREATED', details:{requestId}}`.
- Si la relectura también falla (P2024 por pool agotado, P1001/P1017 por conexión) ⇒ conservar el 500 sin código, porque ahí no hay prueba.
- No incluir P2024 en la lista de «no creado»: dentro de una transacción interactiva el pool se agota como P2028. P2024 sale de consultas sueltas, así que no prueba nada del commit.

(c) Android e iOS, cambiados juntos: liberar la llave sólo con `code == TERMINAL_CHARGE_NOT_CREATED` y `details.requestId == ` la propia llave. Un 503 sin código o con otro `requestId` sigue reconciliando. El texto dice que ESE cobro no se envió.

(d) Pruebas de integración contra Postgres:
- otra transacción retiene `FOR UPDATE` de la orden más allá del `timeout` de `reserve` ⇒ 503 con `requestId` y ninguna fila;
- pool agotado ⇒ P2028 al iniciar ⇒ el mismo 503;
- un commit que sí ocurrió ⇒ réplica, no 503.

(e) Declarar en el diseño que cualquier otro 5xx previo a la fila (por ejemplo, un fallo de BD antes de `reserve`) sigue siendo irresoluble. Cerrarlo del todo exige que el servidor cree la fila antes de toda comprobación que pueda fallar, o la regla de antigüedad que el founder aún no decide.

#### 8. [P2] Los códigos del helper chocan con lo que la TPV publicada hace con 409 y 400 (en removeOrderItem, bucle de resincronización)

- **Sección:** C.6 / clientes
- **Escenario:** Con la guardia en voidItems, la TPV 2.9.x recibe 409 y muestra «La orden fue modificada por otra terminal», y el cajero reintenta; un 400 muestra «La orden ya está pagada». Ninguno de los dos dice «hay un cobro en curso». Si la guardia se extiende a removeOrderItem (hallazgo 1), el 409 entra a OrderSyncCoordinator como ConflictException ⇒ attemptAutoResolveConflict refresca del servidor y, como el borrado local sigue pendiente, llama markDirty: vuelve a mandar el mismo DELETE, recibe otro 409 y repite mientras la fila siga UNRESOLVED (con las UNKNOWN históricas, indefinidamente). Un 400, en cambio, se vuelve PermanentSyncException ⇒ se descarta la operación y el borrador queda SYNCED con un texto falso. Aparte: el diseño dice que el PUT del dashboard «pasa por la misma cancelación protegida». Si eso se implementa llamando cancelOrder(), que abre su propia prisma.$transaction, desde dentro de otra transacción que ya actualizó la fila Order, la segunda conexión espera un candado que tiene la propia petición hasta el P2028.
- **Evidencia:** /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/OrderRepositoryImpl.kt:729-739 (voidItems: 409 ⇒ «modificada por otra terminal», 400 ⇒ «ya está pagada»), 512 y 527-528 (removeOrderItem: 409 ⇒ Conflict; 400/403/404/422 ⇒ Permanent). OrderSyncCoordinator.kt:1001-1012, 1070-1107 (auto-resolución ⇒ markDirty con borrados pendientes), 1129-1150. /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/mobile/order.mobile.service.ts:3197 (cancelOrder abre su propia transacción).
- **Arreglo propuesto:** Fijar en el diseño una tabla de código HTTP × cliente publicado × efecto antes de programar. Ningún estado da un mensaje honesto en la TPV vieja (sus textos están fijos por código HTTP), así que la guardia en /tpv no se despliega hasta que la flota lea code/details (el APK va primero, como dice F.2). En el APK nuevo, un rechazo por cobro vivo marca la operación como retenida con backoff (no markDirty inmediato) y la reintenta cuando el cobro se resuelve. El helper sólo recibe tx; prohibir con una prueba estática llamar a cancelOrder() o a otra función que abra su propia transacción desde dentro de una transacción de cancelación.
- **Escéptico:** CONFIRMADO → severidad P3
  - Razón: Sólo sobrevive una parte, la menor: la TPV publicada (2.9.x) enseña un texto falso cuando recibe el 409 del cobro vivo al anular artículos. Las otras dos afirmaciones del hallazgo, las que lo subían a P2, no se sostienen.

1) El bucle infinito en removeOrderItem es FALSO. En la auto-resolución, `cacheBackendOrder` reescribe la orden con `draftOrderDao.insert` (REPLACE). Según el comentario del propio executeSync, eso borra en cascada los renglones por la FK, y después se reinsertan los renglones del servidor como SYNCED. El renglón que se quería borrar sigue en el servidor, porque el DELETE fue rechazado. Así, su marca DELETED local desaparece: la reescribe el REPLACE del renglón con el mismo id y la cascada del REPLACE de la orden. Por eso `getDeletedItemsByOrder` sale vacío, `hasPending` es false, no se llama `markDirty` y se emite `Synced`. No se reintenta el DELETE. El efecto real sería otro: el borrado se deshace en silencio y el artículo reaparece sin mensaje. No toca dinero, porque la orden conserva el artículo. Además, en el árbol actual `removeOrderItem` del servidor NO lleva la guardia (order.tpv.service.ts:2217-2275). El escenario depende de otro hallazgo.

2) El «400 con texto falso» no aplica al cobro vivo. El helper devuelve 400 sólo con PAID/PARTIAL y 409 con cobro vivo. Con PAID, «La orden ya está pagada» es cierto. Con PARTIAL es impreciso, pero ese texto ya existía y no lo introduce el diseño.

3) El P2028 del PUT del dashboard está REFUTADO por el código real. La WIP ya lo implementa llamando `assertOrderCancellableUnderLock(tx, …)` dentro de su única transacción, no `cancelOrder()`. `onOrderCancelled` va después del commit. El módulo de la guardia prohíbe por escrito anidar transacciones propias. El diseño ya fija que el helper recibe `tx`.

Lo que se confirma: voidItems en la TPV mapea cualquier 409 a «La orden fue modificada por otra terminal» e ignora `code`/`message` (OrderRepositoryImpl.kt:729-739). El servidor de la WIP sí manda el 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` con `code`, `details` y un mensaje honesto. El cajero ve un error engañoso y reintenta a mano; cada intento recibe otro 409. No hay bucle automático ni riesgo de dinero: la guardia bloquea igual. Y el diseño no planea ningún cambio en avoqado-tpv que lea ese código: C.4 cubre Android/iOS y C.5 la cancelación del cobro. Así que «el APK va primero» (F.2) no arregla el texto: ese APK tampoco lo leería. Es un defecto de pantalla honesta (prioridad 4 de la regla), no de dinero. Por eso baja a P3.
  - Evidencia: TPV:
- app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/OrderRepositoryImpl.kt:729-739 (voidItems: 409 ⇒ ConflictException «modificada por otra terminal», 400 ⇒ «ya está pagada», sin leer `code`).
- Mismo archivo, :512-513 y :527-528 (removeOrderItem: 409 ⇒ Conflict; 400/403/404/422 ⇒ PermanentSyncException).
- features/ordering/presentation/menu/MenuViewModel.kt:2163-2200 (voidItems: sólo snackbar «Error al anular items: …», sin reintento automático).
- features/ordering/domain/OrderSyncCoordinator.kt:1001-1012 (Conflict ⇒ attemptAutoResolveConflict). Mismo archivo, :1070-1107 (cacheBackendOrder, luego hasPending y luego markDirty sólo si quedan DELETED/PENDING). Mismo archivo, :478-525 (cacheBackendOrder: `draftOrderDao.insert` de la orden y `draftOrderItemDao.insert` de cada renglón del servidor como SYNCED). Mismo archivo, :1463-1480 (el DELETE usa `deletedItem.id` = id del servidor).
- core/data/local/dao/DraftOrderDao.kt:145 (`@Insert(onConflict = REPLACE)` de la orden).
- core/data/local/dao/DraftOrderItemDao.kt (`insert` también REPLACE; DELETED es sólo `sync_status`).
- core/data/local/entities/DraftOrderItemEntity.kt:45-50 (FK con `onDelete = CASCADE`).
- El comentario del propio coordinador en executeSync (Step 3): «insert() with REPLACE strategy DELETEs order row, triggering FK CASCADE on all items».
- grep de `ORDER_CANCEL_BLOCKED` en avoqado-tpv/app/src: 0 resultados.

Servidor (WIP):
- src/services/tpv/order.tpv.service.ts:2217-2275 (removeOrderItem sin guardia).
- Mismo archivo, :2805-2836 (voidItems: `lockAndReadOrderForCancel` + `assertNoLiveTerminalCharge`, 409 con mensaje propio).
- src/services/shared/orderCancelGuard.ts:13-19 (prohíbe llamar dentro de la tx funciones que abren su propia transacción) y :75-85 (409 con `code` + `details.requestId`).
- src/services/dashboard/order.dashboard.service.ts:524-576 (el PUT que cancela usa el helper con `tx` en una sola `$transaction`; `onOrderCancelled` después del commit).
- src/controllers/tpv/order-table.tpv.controller.ts:48-62 (`cuerpoDeError` añade `code`/`details` de forma aditiva).

Diseño: §C.6 (helper con `tx`; «Las rutas /tpv devuelven code y details de forma aditiva»). §C.4/§C.5 no incluyen que avoqado-tpv lea el código nuevo. §F.2 (APK primero).
  - Arreglo corregido: Descartar del hallazgo el bucle de removeOrderItem y el riesgo P2028: no aplican al código actual. Añadir al diseño, en §C.6 o §C.5, la parte cliente en avoqado-tpv, que hoy falta:

(a) En `OrderRepositoryImpl.voidItems` (y en `removeOrderItem`, si otro hallazgo le extiende la guardia), leer `code` y `details.requestId` del cuerpo del error antes del mapeo por código HTTP. Con `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`, devolver un error tipado que muestre «Hay un cobro en curso en la terminal para esta orden…», sin «modificada por otra terminal».

(b) Si la guardia se extiende a `removeOrderItem`, en el sync ese error NO debe ir a `attemptAutoResolveConflict`: hoy deshace el borrado en silencio y el artículo reaparece sin aviso. Tampoco a `PermanentSyncException`. Debe conservar el renglón en DELETED con el aviso visible y reintentarlo cuando el cobro se resuelva (con backoff, sin reintento inmediato).

(c) Declarar en §F que en la TPV 2.9.x el texto seguirá siendo «La orden fue modificada por otra terminal» mientras no se actualice. Es residual y no toca dinero, porque la guardia bloquea igual.

(d) No hace falta nueva prueba estática contra transacciones anidadas por este motivo: el PUT ya usa el helper con `tx`, y la regla está escrita en orderCancelGuard.ts. Si se quiere blindar, basta con una prueba que compruebe la FORMA del PUT (helper dentro de la misma `$transaction`).

### A-dinero

Revisé A (A.1–A.10) contra el código real de la TPV, del servidor y de las librerías (Room 2.7.0, sqlite-android 2.5.0, socket.io-client 2.1.1). La regla A.8 sí cubre los tres caminos por los que RemotePaymentInbox.probe contesta hoy NOT_FOUND. Un APK sin identidad no puede falsificar `tombstone === true`: 2.9.2 no declara sonda y la regla 3 exige un socket confiable. La lápida, las entregas duplicadas y el ACK tardío se resuelven bien por la llave primaria y el CAS. El problema de fondo es otro: «continuidad de la bandeja» solo se comprueba al arrancar, y encontré tres caminos por los que el servidor liberaría un cobro que la terminal ya hizo:
(1) Room borra y recrea la base en caliente cuando detecta corrupción, sin reiniciar la app.
(2) El espejo se escribe sin fsync del directorio, así que tras un corte de luz la base y el espejo pueden volver atrás juntos.
(3) El §0 afirma que Room no tiene downgrade destructivo, y sí lo tiene (DatabaseModule.kt:162). Con eso, el riesgo residual de A.9 es más grande de lo que dice el diseño.
Además, la regla de «retroceso del contador» choca con el contador congelado de las reconexiones automáticas y con las respuestas de sonda que llegan en desorden. Eso apaga A para siempre en la terminal y deja todo en B. Y el límite de las copias restauradas es mayor que «root»: run-as en builds de depuración, y restaurar solo el .db dejando el -wal.

En corto: el diseño va bien encaminado, pero tal como está escrito puede declarar «no se cobró» sobre un cobro que sí pasó en tres situaciones concretas (base corrupta, apagón, regreso a una versión anterior). Los arreglos son baratos y van escritos en cada hallazgo. No necesito nada de ti; conviene aplicar los arreglos al diseño antes de programar.

#### 1. [P1] Room borra y recrea la base EN CALIENTE ante corrupción: el centinela desaparece a media sesión y la identidad X sigue en memoria

- **Sección:** A.2 / A.3 (verificación sólo al arrancar)
- **Escenario:** Se entrega R a X y el ACK se pierde (UNKNOWN/ACK_TIMEOUT, acknowledgedAt NULL). La TPV reclama R y el SDK cobra. Después una consulta detecta corrupción (flash barata, apagón): el callback por defecto de Room cierra la base y borra sus archivos, y Room la vuelve a crear vacía DENTRO DEL MISMO PROCESO, sin reinicio, así que la verificación del arranque de A.3 no corre. Llega la sonda de R: getById devuelve null y se escribe la lápida. El incremento del contador ya no encuentra centinela. El diseño no dice qué hacer en ese caso: si la implementación usa el contador en memoria, o recrea el centinela con el X que tiene en memoria, contesta (X, c+n ≥ marca, tombstone:true). Pasan las reglas 1 a 6 (sin ACK ni posesión) ⇒ FAILED/TPV_INBOX_NOT_FOUND ⇒ el POS lee NOT_CHARGED y cobra otra vez. Pasa lo mismo si QA sustituye el archivo con run-as con la app viva, como en la prueba física de A.10.
- **Evidencia:** sqlite-android 2.5.0, SupportSQLiteOpenHelper.android.kt:188-218: el onCorruption por defecto cierra la base y borra los archivos. room-runtime 2.7.0, RoomOpenHelper.android.kt: sólo sobrescribe onCreate (:64) y onOpen (:131), así que Room recrea el esquema al reabrir. avoqado-tpv DatabaseModule.kt:84-168: el builder no instala ni Callback ni errorHandler. El diseño A.3 verifica «al arrancar (antes de conectar el socket)» y A.2 no exige comprobar que el centinela exista en cada transacción.
- **Arreglo propuesto:** Agregar a A.2 que cada transacción de la bandeja haga CAS sobre el centinela: `UPDATE … SET counter=counter+1 WHERE request_id=SENTINEL AND inbox_id=:idEnMemoria AND counter=:esperado` y exigir exactamente 1 fila. Si afecta 0 filas: abortar la transacción, envenenar la identidad en memoria (no anunciarla, no contestar sonda, ACK ni cancel, no abrir el SDK) y forzar un reinicio, que en el arranque rota por «M sin S» o por discrepancia. Registrar un RoomDatabase.Callback con onCreate y onDestructiveMigration que también envenene la identidad. NOT_FOUND sólo se contesta desde dentro de esa transacción. Pruebas: borrar el archivo de la base con el proceso vivo y después sondear; sustituir el archivo con run-as con la app abierta.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No lo pude refutar. El mecanismo es real y el hueco del diseño también. Android borra y recrea la base en caliente dentro del mismo proceso. Entre A.2 y A.3 sólo se comprueba la continuidad al arrancar, y no dicen qué hacer si el centinela desaparece a media sesión. Que el hueco termine en un doble cobro depende de cómo se implemente. Si el centinela se reescribe con el inboxId y el contador que están en memoria, el resultado es inseguro. Y el propio diseño invita a hacerlo así, porque guarda {inboxId, counter} como JSON en final_result_json: eso empuja a leer, modificar y reescribir desde memoria. En ese caso el espejo sigue subiendo con la misma X, así que al reiniciar S ≥ M y la continuidad falsa queda acreditada para siempre, no sólo en ese proceso. Si en cambio el contador se relee de Room, el centinela recreado empieza en 0. Entonces falla la regla 5 (contador < marca), X pasa a DISCONTINUED y no se libera nada.

Bajo la severidad a P2 porque hace falta una coincidencia rara: (a) que salte un SQLITE_CORRUPT en ese proceso; (b) que la solicitud sin ACK se haya ejecutado y que ni su resultado ni una respuesta de sonda previa hayan llegado al servidor, porque cualquiera de las dos marcaría terminalHeldAt (A.7) y la regla 6 bloquearía; (c) que la implementación elija el camino que reescribe desde memoria. Aun así, cerrarlo es obligatorio antes de implementar A. Es la garantía central de A («NOT_FOUND sólo con continuidad acreditada»), las consecuencias son de dinero, y la prueba física de A.10 con run-as puede provocarlo a voluntad si se hace con la app abierta.
  - Evidencia: Evidencia de Android y Room, leída en los fuentes del caché de Gradle:
- sqlite-android 2.5.0, SupportSQLiteOpenHelper.android.kt:188-222. El onCorruption por defecto cierra la base y borra sus archivos, o sólo los borra si la base no estaba abierta.
- sqlite-framework 2.5.0, FrameworkSQLiteOpenHelper.android.kt:123. El DatabaseErrorHandler llama a callback.onCorruption.
- room-runtime-android 2.7.0 (la versión de app/build.gradle.kts:753):
  - Ni RoomOpenHelper (javap: sólo onConfigure, onCreate, onUpgrade, onDowngrade y onOpen) ni RoomConnectionManager.SupportOpenHelperCallback (RoomConnectionManager.android.kt:144-170) sobrescriben onCorruption.
  - SupportSQLiteConnectionPool.android.kt:32-36 obtiene la conexión con un getter que llama a supportDriver.open → openHelper.writableDatabase (SupportSQLiteDriver.android.kt:26) en cada uso. Así, la siguiente consulta reabre la base, SQLite crea un archivo nuevo en versión 0 y onCreate recrea todas las tablas vacías sin reiniciar el proceso.

Evidencia en avoqado-tpv:
- DatabaseModule.kt:84-165 no tiene addCallback, openHelperFactory ni errorHandler. grep de onCorruption, DatabaseErrorHandler y RoomDatabase.Callback en app/src/main: 0 resultados.
- RemotePaymentInbox.kt:123-138: hoy, si getById devuelve null, escribe la lápida y contesta NOT_FOUND. Con el servidor del plan D eso es inofensivo, porque NOT_FOUND tras una entrega no libera. Con A.8 sería liberable si viaja X con un contador ≥ la marca.
- FACTORY_RESET (CommandExecutor.kt:1066-1090) NO reproduce el escenario: deleteDatabase desvincula los archivos, pero la conexión abierta sigue viendo el inodo viejo hasta el killProcess, un segundo después.

Evidencia del diseño:
- A.3 titula «verificación al arrancar (antes de conectar el socket)».
- A.2 exige subir el contador en la misma transacción, pero no exige que el centinela exista ni que coincida con la identidad cargada.
- A.4 no dice de dónde salen el inboxId y el inboxCounter de la respuesta de la sonda.
- En A.10 la restauración física con run-as no exige que la app esté detenida.

Corrección lateral al §0 del diseño: dice que Room no tiene fallbackToDestructiveMigration* en downgrade, pero DatabaseModule.kt:162 tiene .fallbackToDestructiveMigrationOnDowngrade(). Ese camino destruye la base al abrirla, así que la verificación del arranque lo cubre como «M sin S»; pero la fila del §0 es falsa, y confirma el motivo de poner el centinela en la misma tabla.
  - Arreglo corregido: 1) En A.2, dentro de la misma transacción Room de cada mutación de la bandeja (recibir, reclamar, resolver, lápida, cancel CAS, cuarentena):
   - leer el centinela de la base;
   - exigir que exista y que su inboxId sea el cargado al arrancar;
   - incrementar el contador con CAS, exigiendo exactamente 1 fila afectada.
   Conviene guardar inboxId y counter en columnas propias, o hacer el CAS con json_extract, para no reescribir el JSON desde memoria.
   Si afecta 0 filas: abortar la transacción, con lo que la lápida tampoco queda escrita.

2) Todo inboxId e inboxCounter que viaje en el ACK, la sonda o la disposición de cancel sale del valor leído en esa transacción, nunca de memoria. El espejo sólo se actualiza desde ese valor tras un CAS exitoso, y nunca «repara» el centinela.

3) Envenenar la identidad cuando la continuidad se rompe en caliente. Envenenar significa:
   - no anunciarla;
   - no contestar NOT_FOUND;
   - contestar accepted:false al recibir;
   - no abrir el SDK.
   Después, terminar el proceso para que el arranque rote por «M sin S». Se envenena en dos casos:
   - (a) el CAS del punto 1 afecta 0 filas;
   - (b) se detecta corrupción. Para eso, instalar un SupportSQLiteOpenHelper.Factory que envuelva el callback y sobrescriba onCorruption; RoomDatabase.Callback no expone onCorruption. Además, un RoomDatabase.Callback.onCreate/onDestructiveMigration que envenene sólo si la identidad ya estaba verificada en este proceso: en una instalación limpia, onCreate es el caso legítimo «ni S ni M».

4) Pruebas:
   - Robolectric: con la bandeja viva, cerrar la base y borrar sus archivos; después sondear una solicitud entregada. Nunca debe salir NOT_FOUND con X, y el espejo no cambia.
   - Física: sustituir el archivo con run-as con la app abierta, como prueba aparte.
   - En A.10, la restauración con run-as para comprobar «rota: S < M» se hace con la app detenida (force-stop).

5) Corregir la fila del §0 sobre el downgrade.

#### 2. [P1] «temporal + fsync + rename» sin fsync del directorio: tras un apagón el espejo y la base retroceden JUNTOS y el arranque ve «Continua» con R borrada

- **Sección:** A.2 (espejo) y A.3 (corte de luz)
- **Escenario:** La base está en WAL, donde Android usa por defecto synchronous=NORMAL; el propio diseño admite que un commit puede perderse. Un checkpoint deja S durable en c. Luego se recibe R (c+1), se escribe el espejo (c+1) y se manda el ACK, que se pierde. Se reclama R (c+2), se escribe el espejo (c+2) y el SDK cobra. Hay un corte de luz antes de que el journal de ext4/F2FS confirme los renames (unos segundos, porque nadie hizo fsync del directorio): el espejo vuelve a c y el WAL sin sincronizar hace volver S a c. Resultado S=c ≥ M=c ⇒ «Continua», con R y su fila de la libreta perdidas. El handshake X con c no es regresión, porque el servidor nunca vio c+1. La sonda de R contesta NOT_FOUND con lápida c+1 y el servidor libera ⇒ doble cobro. Justo el corte de luz del que habla la regla del workspace.
- **Evidencia:** Texto del diseño A.2: «Escritura atómica (temporal + fsync + rename)», sin fsync del directorio padre. DatabaseModule.kt:166 `.setJournalMode(WRITE_AHEAD_LOGGING)` y ningún PRAGMA synchronous. La sincronización WAL por defecto de AOSP es NORMAL (config db_wal_sync_mode). A.3 da por «Continua» cualquier S ≥ M.
- **Arreglo propuesto:** Exigir en A.2 este orden: fsync del temporal → rename → fsync del directorio padre (Os.open(dir, O_RDONLY) + Os.fsync). Sólo después, cualquier efecto visible: ACK, respuesta de sonda, disposición o arranque del SDK. Nota: AtomicFile tampoco hace fsync del directorio. Además, poner `PRAGMA synchronous=FULL` en la conexión de escritura (Callback.onOpen) para que S nunca retroceda por un apagón. Eso también evita que cada corte de luz rote la identidad y mande a B filas legítimas. Prueba física: cortar la corriente (no un reboot) con el SDK cobrando y revisar que el arranque rote o que la fila siga ahí.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No lo pude refutar. Revisé el diseño, el código y una PAX A910S conectada por USB, y el escenario se sostiene en el hardware real. Hago dos correcciones al hallazgo; ninguna le baja la severidad.

Por qué se sostiene:
(1) A.2 promete «temporal + fsync + rename» y en ningún lado hace fsync del directorio. Además, A.3 da por hecho que el espejo es durable: la fila «S.counter < M.counter ⇒ Rotar (también detecta un corte de luz que perdió transacciones)» sólo protege si M sobrevive al apagón.
(2) La base no hace fsync en cada commit. Room abre en WAL (DatabaseModule.kt:166, 422, 465) y ningún PRAGMA cambia el synchronous. Desde el API 28, el valor por defecto de AOSP es db_wal_sync_mode = NORMAL; en el 27 era FULL. La PAX corre Android 12 (API 31), así que un commit puede perderse tras un apagón o un reinicio forzado.
(3) El servidor del árbol deja abierto justo el camino del escenario. Cuando se pierde el ACK, la fila pasa a UNKNOWN/ACK_TIMEOUT y no se vuelve a entregar, porque IN_FLIGHT sólo incluye PENDING, SENT y CANCEL_REQUESTED. En la ruta durable, lastDeliveredAt sólo se escribe con el ACK, así que sigue nulo y el CAS de A.8 regla 6 puede cumplirse. La marca de agua de A.5 no lo detecta, porque c+1 y c+2 nunca llegaron al servidor.

Corrección 1: ext4 no sirve de ejemplo; el caso real es F2FS. En ext4, jbd2 confirma transacciones que abarcan todo el sistema de archivos. El fsync del temporal c+2 también confirma el rename de c+1, así que queda M ≥ c+1 > S = c y la terminal rota, que es lo seguro. En F2FS no pasa eso: el fsync de un archivo usa roll-forward sin checkpoint, y un rename no se conserva hasta el siguiente checkpoint (el intervalo por defecto es 60 s). Así, M y S sí pueden volver juntos a c. La PAX medida monta /data en F2FS. Además, la ventana dura hasta unos 60 s, no «unos segundos».

Corrección 2: el disparador no es sólo el corte de luz. La PAX y la Nexgo tienen batería, así que un apagón de la red eléctrica no las apaga. Pero un kernel panic, un reset del watchdog o un reinicio forzado con el botón producen la misma vuelta atrás en F2FS.

Corrección al arreglo: con fsync_mode=nobarrier, que es lo que tiene esta PAX, un fsync de archivo no vacía la caché del dispositivo. Por eso `PRAGMA synchronous=FULL` no garantiza que S sobreviva a un corte de corriente real; sólo protege ante un panic o un reset en caliente. Lo que sí hace durable al espejo es el fsync del directorio: en F2FS ese fsync fuerza un checkpoint, y el checkpoint sí vacía la caché. Sobre A.2 conviene declarar que la seguridad no descansa en que S sea durable; descansa en que M lo sea: si S retrocede, la terminal rota.
  - Evidencia: - Diseño: /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md
  - A.2 dice: «Escritura atómica (temporal + `fsync` + `rename`)… Orden obligatorio: commit de Room → `fsync` del espejo → efecto visible». No menciona el fsync del directorio.
  - A.3 dice: «Mismo inboxId, S.counter < M.counter | Rotar (… también detecta un corte de luz que perdió transacciones)».
- TPV: /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt:166, 422 y 465 usan `.setJournalMode(WRITE_AHEAD_LOGGING)`. En app/src no hay ningún `PRAGMA synchronous`.
- AOSP (SDK local, ~/Library/Android/sdk/platforms/*/data/res/values/config.xml): db_wal_sync_mode vale FULL en android-27 y NORMAL en android-28, 34, 35 y 36.
- PAX A910S 2841548417 (lectura por adb, sin modificar nada):
  - `getprop ro.build.version.release` = 12 y `ro.build.version.sdk` = 31.
  - `/data type f2fs (… fsync_mode=nobarrier …)`.
  - `dumpsys dbinfo com.jaac.avoqado_tpv.sandbox` muestra avoqado_database con openFlags=805306368 (WAL habilitado) y syncMode vacío, o sea el valor por defecto, NORMAL.
  - debug.sqlite.wal.syncmode está vacío.
- Servidor: /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts
  - :182: IN_FLIGHT = PENDING, SENT, CANCEL_REQUESTED, así que el replay no vuelve a entregar una fila UNKNOWN.
  - :796-803: un ACK perdido pasa la fila a UNKNOWN con failureCode 'ACK_TIMEOUT'.
  - :887: lastDeliveredAt sólo se escribe en LEGACY; en DURABLE se escribe con el ACK (:912, :927). Si el ACK se pierde, queda nulo, que es lo que exige el CAS de A.8 regla 6.
- Semántica de los sistemas de archivos (razonamiento, no medido en la terminal):
  - ext4 (jbd2): fsync(temp c+2) confirma la transacción que contiene el rename de c+1 ⇒ M ≥ c+1 ⇒ S < M ⇒ rota. En ext4 el escenario no se da tal cual.
  - F2FS: el fsync de un archivo nuevo se recupera por roll-forward sin checkpoint, y el rename no se recupera ⇒ M puede volver a c.
  - fsync_mode=nobarrier: el fsync de un archivo no manda FLUSH al dispositivo. El checkpoint sí lo manda, y el fsync de un directorio fuerza un checkpoint (CP_NON_REGULAR).
- No verificado: el sistema de archivos de la Nexgo N86 (no estaba conectada) y el cp_interval de F2FS en la PAX (sin permiso para leerlo).
  - Arreglo corregido: 1. A.2, orden exigido para el espejo: escribir el temporal, luego fsync(temp), luego rename, luego fsync del directorio padre (`Os.open(noBackupFilesDir.path, O_RDONLY)` + `Os.fsync(fd)` + close). Sólo después se permite cualquier efecto visible: ACK, respuesta de sonda, disposición de cancel, emisión de resultado o arranque del SDK. Si falla el fsync del directorio, se trata igual que un fallo del espejo: no hay efecto positivo. No usar AtomicFile, porque no hace fsync del directorio. En F2FS ese fsync fuerza un checkpoint, y es lo único que vacía la caché del dispositivo con fsync_mode=nobarrier. Hay que medir su costo en la A910S, porque ocurre al menos dos veces por cobro remoto (recibir y reclamar).

2. Declarar en A.2 y A.3 que la seguridad descansa en que M sea durable, no S. S puede retroceder (WAL con NORMAL) y la terminal rota, que es lo seguro. `PRAGMA synchronous=FULL` en Callback.onOpen queda como opcional, para evitar rotaciones de más ante un kernel panic. Hay que dejar escrito que en esta PAX (fsync_mode=nobarrier) FULL no garantiza que S sobreviva a un corte de corriente real, y medir su latencia en la terminal de 1 GB antes de adoptarlo.

3. Defensa en profundidad para el arranque (A.3): si existe un temporal del espejo recuperado con un contador mayor que M, o ilegible, se rota. F2FS recupera por roll-forward los temporales que recibieron fsync aunque el rename se haya perdido.

4. Pruebas:
   - Unitaria: inyectar un `FileSyncer` y comprobar el orden fsync(temp) → rename → fsync(dir) → efecto. También, que un fallo de fsync(dir) impide el ACK y la respuesta NOT_FOUND.
   - Física en la PAX (F2FS): reinicio abrupto con el SDK cobrando (sacar la batería o forzar el reset con el botón; un reboot limpio no sirve, porque sincroniza), con la solicitud R entregada y su ACK soltado a propósito. Al arrancar, la terminal debe rotar, o la fila debe seguir ahí. En ningún caso la sonda de R debe liberar la reserva.
   - Revisar el sistema de archivos y el fsync_mode de la Nexgo N86 antes de dar A por buena ahí.

#### 3. [P1] El downgrade destructivo SÍ existe: la excepción de replay de A.9 puede reejecutar un cobro, y el argumento del riesgo residual es falso

- **Sección:** §0 y A.9 (excepción para APK sin identidad)
- **Escenario:** Una terminal con APK que tiene ACK pero no identidad (2.9.2, Room 33) está cobrando R: la fila está SENT con expiresAt a +5 min. Llega un rollback por INSTALL_VERSION a otro APK sin identidad con Room menor y ACK (p. ej. nexgo-v2.9.0, Room 30), o en la transición, del APK del árbol sin A a 2.9.2. Room destruye todas las tablas: bandeja, lápidas, libreta y pending_payments. La activación vive en secureStorage y no en Room, así que sobrevive; la app reconecta en segundos. replayPendingForTerminal reentrega R porque ni las entregas ni el socket tienen identidad (excepción de A.9), y la bandeja vacía la ejecuta otra vez ⇒ el cliente paga dos veces. El diseño justifica el riesgo con «un borrado también quita la activación y la reactivación tarda más que la vigencia»: con un downgrade no se cumple ninguna de las dos cosas. De paso, §0 afirma «Room ante downgrade: la app truena y los datos quedan intactos» y «Ningún borrado… sólo FACTORY_RESET», y las dos cosas son falsas.
- **Evidencia:** avoqado-tpv DatabaseModule.kt:147-162: `.fallbackToDestructiveMigrationOnDowngrade()`, con un comentario que explica que existe para el rollback de INSTALL_VERSION. Está presente en v2.9.2, v2.8.7 y v2.7.0 (git show de cada tag). CommandExecutor.kt:1059 muestra que la activación vive en secureStorage. En el servidor, terminal-payment.service.ts:953-1000: el replay reentrega filas IN_FLIGHT con expiresAt>now y DURABLE.
- **Arreglo propuesto:** Corregir §0. Guardar en cada entrega el `appVersionCode` (header X-App-Version-Code) y la versión de esquema del socket, y negar el replay de la excepción A.9 cuando el socket actual difiera, auditándolo como INBOX_IDENTITY_CHANGED. En el servidor, rechazar un INSTALL_VERSION de downgrade mientras la terminal tenga filas IN_FLIGHT o sin desenlace acreditado. Con A presente, el downgrade queda cubierto por «M sin S ⇒ rotar»; agregar ese caso a las pruebas físicas: downgrade del APK con A a 2.9.2 y de regreso.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: El error de fondo es real. El diseño se equivoca en §0 y en A.2, y el argumento de A.9 para aceptar el riesgo residual no se sostiene ante un downgrade: el downgrade de Room SÍ es destructivo y conserva la activación. Pero el escenario tal como lo cuenta el revisor exagera por dónde entra y hasta dónde llega, así que baja a P2.

Lo confirmado:
(1) `fallbackToDestructiveMigrationOnDowngrade()` está en el árbol de trabajo (DatabaseModule.kt:162) y en los tags v2.9.2 (línea 162), v2.8.7 (159), v2.7.0 (144) y nexgo-v2.9.0 (153). Por eso §0 («la app truena y los datos quedan intactos»; «sólo FACTORY_RESET borra la base entera») es falso, y A.2 («si algún día se configura un downgrade destructivo») también: ya está configurado.
(2) La activación vive en secureStorage, no en Room, así que sobrevive a un downgrade. El «un borrado también quita la activación» de A.9 no se cumple en ese caso.
(3) El servidor reentrega filas en vuelo, con expiresAt > ahora y procedencia DURABLE, a un socket con ackVersion ≥ 1 (terminal-payment.service.ts:953-1030). Si A.9 conserva el replay sin identidad, una bandeja vaciada por el downgrade recibiría la solicitud como nueva y la ejecutaría. Nota: este riesgo ya existe hoy con el plan D. A no lo introduce; sólo lo hereda con una justificación falsa.

Lo que no se sostiene:
(a) Por INSTALL_VERSION no entra. Ese comando hace el downgrade con `Runtime.exec("pm install -r -d …")` desde el uid de la app, copiando antes el APK a /data/local/tmp. El propio código admite que fuera de un instalador de sistema falla: devuelve «DOWNGRADE BLOCKED … En producción use PAXSTORE» (CommandExecutor.kt:768-831). Además, las Nexgo consultan como SANDBOX y no tienen filas de AppUpdate. El vector real es un instalador de sistema: el TMS de AngelPay o PAXSTORE. Esto no lo pude verificar en hardware.
(b) Hoy sólo existe un par de APK que cumple «con ACK, sin identidad y con Room menor». Las APK de PAX con ACK (2.8.8 = 106, 2.9.1 = 105, 2.9.2 = 107) son todas Room 33, así que un downgrade entre ellas no borra nada. Un downgrade a 2.8.7 (Room 31) sí borra, pero ese APK no declara ACK y el servidor no le reentrega. El único par destructivo con replay es Nexgo 2.9.1/2.9.2 (Room 33) → nexgo-v2.9.0 (Room 30, declara ACK y tiene remote_payment_requests).
(c) El segundo ejemplo del revisor («del árbol sin A a 2.9.2») es falso: el árbol de trabajo también es Room 33 (AvoqadoDatabase.kt:162, sin MIGRATION_33_34), así que ese downgrade no borra.

Para que cobre dos veces hacen falta cinco cosas a la vez: que el TMS o PAXSTORE regrese una Nexgo a 2.9.0, que pase con un cobro remoto en vuelo, que el primer intento haya quedado autorizado, que la terminal reconecte dentro de los 5 min de vigencia, y que el cliente vuelva a pasar la tarjeta. Es un riesgo de dinero real pero de alcance estrecho, y se puede controlar como procedimiento operativo. Por eso P2 y no P1.
  - Evidencia: TPV:
- avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt:147-162: `.fallbackToDestructiveMigrationOnDowngrade()` con el comentario «DOWNGRADE SUPPORT (INSTALL_VERSION command rollback) … will DELETE all local data».
- `git show <tag>:…/DatabaseModule.kt` lo muestra en v2.9.2:162, nexgo-v2.9.0:153, v2.8.7:159 y v2.7.0:144.
- Versión de Room por APK: v2.9.2 = 33 (versionCode 107); 2.9.1 = 33 (105, commit 5ca0ef0); 2.8.8 = 33 (106, commit 200c398); v2.8.7 = 31 (104); nexgo-v2.9.0 = 30 (101). El árbol de trabajo también es 33.
- `put("terminalPaymentAckVersion","1")` en SocketManager.kt:211 aparece en aea0169, 5ca0ef0, 200c398 y nexgo-v2.9.0.
- nexgo-v2.9.0 crea `remote_payment_requests` (AvoqadoDatabase.kt:1721 de ese tag).
- CommandExecutor.kt:768-831 y 873-921: el downgrade de INSTALL_VERSION intenta `pm install -r -d -g` después de copiar a /data/local/tmp; si falla responde «DOWNGRADE BLOCKED: Android doesn't allow installing lower versionCode… En producción use PAXSTORE».

Servidor:
- avoqado-server/src/services/terminal-payment.service.ts:953-1030: el replay exige `terminalPaymentAckVersion ≥ 1`, estado IN_FLIGHT, `expiresAt > now`, `take: 1` y salta sólo lo LEGACY o de procedencia desconocida.
- terminal-payment.service.ts:874: el protocolo se calcula como `protocol: ackVersion < 1 ? 'LEGACY' : 'DURABLE'`, y `PAYMENT_TIMEOUT_MS = 300_000` (línea 159).
- terminal-registry.ts: register() no guarda appVersionCode.

Diseño:
- §0, filas «Borrado de filas… Sólo FACTORY_RESET» y «Room ante una versión anterior… datos quedan intactos».
- A.2: «si algún día se configura un downgrade destructivo».
- A.9: «un borrado también quita la activación».
  - Arreglo corregido: 1) Corregir §0 y A.2. El downgrade de Room SÍ es destructivo desde hace varias versiones (v2.7.0 en adelante) y conserva secureStorage. Por eso existe un borrado de la bandeja que NO quita la activación. La razón de meter el centinela dentro de remote_payment_requests pasa a ser el caso vigente, no uno hipotético.

2) En A.9, cerrar la excepción sin identidad para el caso de downgrade. Anotar en cada entrega de deliveryProvenance el versionCode de la app del socket; hoy terminal-registry no lo guarda, así que habría que mandarlo en el handshake o tomarlo del header X-App-Version-Code. Si la solicitud cae en la excepción sin identidad y el versionCode actual del socket es MENOR que el de alguna entrega previa, no reentregar y auditarlo una sola vez, por ejemplo como `APP_DOWNGRADED`. Decidir si también se niega cuando el versionCode sólo es DISTINTO: es más conservador, pero cubre un reinstalado con la misma versión. Declarar como único par vulnerable conocido Nexgo 2.9.1/2.9.2 → nexgo-v2.9.0.

3) Como procedimiento operativo, no pedir un rollback por TMS de AngelPay ni por PAXSTORE mientras la terminal tenga filas IN_FLIGHT o sin desenlace acreditado. Ese downgrade además borra pending_payments, o sea cobros aprobados que aún no se registran. Si se quiere, añadir la misma guarda a INSTALL_VERSION en el servidor. Tiene poco valor, porque ese camino ya choca con `pm install` desde el uid de la app, pero no estorba.

4) Con A presente, el downgrade de un APK con identidad a 2.9.x queda cubierto: el socket sin identidad cae en NO_INBOX_IDENTITY y el servidor no reentrega. Si el APK con A no sube la versión de Room (el centinela no la exige), el downgrade A → 2.9.2 ni siquiera borra. Agregar a las pruebas físicas, en una Nexgo de QA con inventario previo de bandeja, libreta y colas: downgrade 2.9.2 → nexgo-v2.9.0 con una fila SENT vigente (esperado: sin replay) y el ida y vuelta A ↔ 2.9.2.

#### 4. [P2] El contador congelado y las respuestas en desorden disparan COUNTER_REGRESSION falsas; DISCONTINUED nunca se revierte y la TPV no se entera

- **Sección:** A.4 / A.5 / A.8 regla 5
- **Escenario:** (a) La TPV conecta con contador 10 y en la sesión el servidor observa hasta 15. Doze corta el socket y socket.io reconecta solo reenviando el mismo mapa `auth`, que se armó una vez en connect(). Llega 10 < 15 y A.5 descontinúa X. El propio A.4 dice que el valor queda congelado y que es «cota inferior», así que A.4 y A.5 se contradicen. (b) probeUnresolvedForTerminal emite hasta 25 sondas en un bucle; la TPV contesta cada una en su propio coroutine y el servidor procesa cada probe_result de forma asíncrona. Las lápidas c+1 a c+3 entran al FOR UPDATE en desorden: la de c+1 se evalúa después de que la de c+3 subió la marca, y la regla 5 descontinúa X. Consecuencia: X no se reactiva nunca, la TPV sigue anunciando X porque nadie le avisa que rote, y su socket queda no confiable para siempre. A.9 salta entonces todos los replays, así que cada desconexión con un cobro en vuelo (Doze, la causa medida) termina en UNKNOWN y sólo sale por B, con un 🚨 falso de «copia restaurada». Las terminales con A quedan peor que las 2.9.x, justo lo que G8 quería evitar. Dos variantes con el mismo serial (gymDemo OVERRIDE_TERMINAL_SERIAL) producen el mismo estado permanente.
- **Evidencia:** TPV SocketManager.kt:206-215: el mapa auth se construye una vez por connect(). socket.io-client 2.1.1 (build.gradle.kts:704) reenvía opts.auth en cada CONNECT de reconexión. SocketManager.kt:1618: un socketScope.launch por cada sonda. Servidor terminal-payment.service.ts:2180: bucle de emisión de hasta 25 (PROBE_BATCH). socketManager.ts:395-412: handler asíncrono por evento. Diseño A.5: «contador < maxCounterObserved ⇒ DISCONTINUED»; A.8.5: «si no, la pasa a DISCONTINUED»; «nunca se reactiva». build.gradle.kts:328: override de serial.
- **Arreglo propuesto:** TPV: actualizar en sitio el mismo mapa `auth` antes de cada intento de reconexión (listener EVENT_RECONNECT_ATTEMPT del Manager) para que viaje el contador vivo. Servidor: en la regla 5, comparar la lápida contra la marca capturada AL EMITIR la sonda (guardarla por fila o hacerla viajar en la sonda), no contra la marca viva; un evento desordenado de la misma sesión nunca descontinúa. Avisar a la TPV (en la respuesta del handshake o con un evento) que su identidad está DISCONTINUED para que rote con cuarentena y recupere la confianza. Pruebas: reconexión automática después de varios ACK, y 25 NOT_FOUND concurrentes.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: Confirmado a medias. La variante (a) se sostiene; la (b) no.

(a) CONFIRMADA. El diseño se contradice a sí mismo. A.4 dice que en las reconexiones automáticas el contador «queda congelado» y que el servidor lo trata «como cota inferior». Pero A.5 (y el caso «Copia antigua» de A.10) descontinúa una identidad ACTIVE en cuanto el contador del handshake es menor que `maxCounterObserved`. El servidor no tiene forma de distinguir una reconexión automática de una copia restaurada. A.8 regla 5 sube la marca en cada NOT_FOUND que pasa las reglas 1–4, y ese NOT_FOUND es justo el caso para el que A existe: el ACK perdido. Así queda la secuencia:
1. conecta con c;
2. la sonda contesta NOT_FOUND con lápida y contador c+1;
3. la marca pasa a c+1 y la fila se libera;
4. Doze corta el socket y socket.io reconecta solo con c;
5. c < c+1 ⇒ DISCONTINUED(COUNTER_REGRESSION), con 🚨 y alerta a ops.

Es decir, la recuperación funciona una vez y la siguiente desconexión por Doze (la causa medida) la destruye. Además el diseño no tiene camino de vuelta: dice «nunca se reactiva», nada le avisa a la TPV y la TPV sólo rota por su propia verificación al arrancar. A partir de ahí el socket queda no confiable. A.9 salta los replays porque exige un socket confiable. Las entregas nuevas quedan con `inboxTrusted=false`, así que la regla 2 impide cualquier liberación futura, todo NOT_FOUND cae en B y la alerta de «copia restaurada» es falsa. En la dimensión del replay, las terminales con A quedan peor que las 2.9.x, que conservan el replay del plan D por G8/A.9.

(b) REFUTADA. Una lápida desordenada sólo puede descontinuar si hay DOS eventos que llegan a la regla 5 en la misma tanda. La regla 5 sólo se alcanza con filas entregadas a X, o sea, creadas después de A. La admisión (`terminal-payment.service.ts` :459/537/641, predicado `UNRESOLVED_FINANCIAL_OUTCOME`) rechaza con 409 TERMINAL_BUSY cualquier solicitud nueva mientras la terminal tenga una fila sin desenlace acreditado. Por eso nunca hay dos filas calificadas a la vez. Una sonda duplicada de la misma fila (al conectar y en el barrido) lee la lápida ya escrita y contesta con el mismo contador. Las filas legacy o históricas también escriben lápida y suben el contador de la TPV, pero fallan la regla 2 y nunca tocan la marca.

Exageraciones del hallazgo:
- «Cada desconexión con un cobro en vuelo termina en UNKNOWN» no es cierto. Si la TPV ya persistió la solicitud, su resultado viaja igual (el emit queda en buffer y se reproduce el resultado). Lo que se pierde es el replay y la liberación cuando la entrega o el ACK se perdieron.
- El caso de gymDemo con el serial repetido es un build interno de depuración y no pesa en la severidad.

Severidad P2: el fallo es cerrado (nunca libera ni cobra de más), pero anula la recuperación automática que eligió el founder desde su primer uso real, llena B de trabajo manual y dispara alertas falsas.
  - Evidencia: TPV, SocketManager.kt:206-217: el mapa `auth` se arma con `buildMap` (solo lectura) una sola vez por `connect()`.
- La reconexión automática está activa: `reconnection=true`, `reconnectionAttempts=Int.MAX_VALUE` (líneas 185-187 y 223-224).
- `onDisconnect` (:578-583) no llama a `connect()`: sólo emite eventos, así que el reintento lo hace la propia librería.

socket.io-client 2.1.1 (jar de fuentes en la caché de Gradle), Socket.java:
- :74 `this.auth = opts.auth`;
- :83 escucha `Manager.EVENT_OPEN` en cada (re)apertura;
- :269-273 `onopen()` manda `new JSONObject(this.auth)`. Reenvía la misma referencia y la lee en el momento del envío, así que mutar el mapa en sitio sí viajaría.
- :249/:430-446: los emits hechos sin conexión quedan en `sendBuffer` y se vacían al reconectar.

Diseño:
- A.4 (línea 92): «congelado… cota inferior».
- A.5 (líneas 108-111): «nunca se reactiva»; contador < marca ⇒ DISCONTINUED(COUNTER_REGRESSION).
- A.8.5 (línea 138): «si no, la pasa a DISCONTINUED… sube la marca».
- A.9 (líneas 150-156): replay sólo a socket confiable con el mismo `inboxId`.
- A.10 (línea 169): «Handshake de X con contador < marca ⇒ COUNTER_REGRESSION».
- No hay ningún mecanismo que avise a la TPV.

Refutación de (b):
- `terminal-payment.service.ts:217-223` (`UNRESOLVED_FINANCIAL_OUTCOME`) y las admisiones en :459, :537, :583 y :641 lanzan TerminalBusyError: una sola fila sin desenlace por terminal.
- La emisión de hasta 25 sondas (:2150-2190) y el `socketScope.launch` por sonda (TPV :1618, `Dispatchers.IO`) sí son concurrentes, pero con una sola fila calificada no hay dos lecturas de la regla 5 que puedan cruzarse.
  - Arreglo corregido: 1) TPV. El contador tiene que viajar vivo en cada CONNECT, no sólo en `connect()`. Tres pasos:
- sustituir `buildMap` por un mapa mutable y seguro entre hilos (`ConcurrentHashMap<String,String>`) guardado como campo;
- en el listener `Manager.EVENT_RECONNECT_ATTEMPT` (`socket.io().on(...)`) poner en ese mismo mapa el `inboxCounter` confirmado del espejo; `onopen` lo lee al enviar el CONNECT;
- anunciar sólo un valor ya comprometido en Room y en el espejo (el orden de A.2), nunca uno pendiente.

2) Servidor, defensa en profundidad. Dos opciones:
- que el contador del handshake NO descontinúe por sí solo si es menor que una marca que subió dentro de sesiones de la misma identidad y el retroceso no pasa de las observaciones de eventos posteriores al último handshake. Queda auditado como aviso, no como 🚨.
- o, más simple y consistente con A.4: que el handshake sólo SUBA la marca (cota inferior de verdad) y la detección de retroceso quede en los eventos (regla 5) y en la rotación de la propia TPV (A.3).
Corregir A.4, A.5 y A.10 para que digan lo mismo.

3) Salida de DISCONTINUED. Cuando el servidor observa una identidad DISCONTINUED:
- lo responde en el handshake o con un evento `terminal:inbox_discontinued` con el motivo;
- la TPV rota con la cuarentena de A.3 (RECEIVED ⇒ RECEIVED_PRE_ROTATION) y reconecta con la identidad Y;
- las entregas viejas a X siguen sin poder liberarse por Y (correcto; eso va por B), pero la terminal recupera la confianza para lo nuevo;
- se registra en Crashlytics y en `ActivityLog`.

4) La captura de la marca al emitir la sonda NO hace falta: la admisión de una sola fila por terminal impide el desorden entre filas calificadas. Basta con una prueba que lo fije (dos NOT_FOUND concurrentes de la misma fila ⇒ mismo contador, una sola transición).

Pruebas:
- integración contra Postgres: handshake de X con c ⇒ NOT_FOUND con c+1 libera ⇒ nuevo handshake de X con c (reconexión congelada). Con el arreglo 2 no descontinúa; y con el arreglo 1 el handshake llega con c+1.
- DISCONTINUED ⇒ respuesta de rotación ⇒ handshake con Y confiable.
- TPV (Robolectric): tras una mutación, el `EVENT_RECONNECT_ATTEMPT` deja el contador nuevo en el mapa que usa `onopen`.
- Física: después de una liberación A, forzar Doze (`dumpsys deviceidle force-idle`, luego `unforce`) y comprobar que X sigue ACTIVE.

#### 5. [P2] El límite de las copias restauradas es mayor que «copia completa con root», y la marca de agua no ve nada justo en el caso que A quiere resolver

- **Sección:** A.3 límite declarado y A.10 (pruebas físicas)
- **Escenario:** (a) Una copia completa (base + no_backup) no necesita root: los builds de QA (sandboxDebug, nexgo) son depurables y run-as copia todo el directorio de datos, y el propio plan de A.10 usa run-as. (b) La marca de agua de A.5 sólo detecta la copia si el servidor vio un contador mayor, pero en el caso objetivo de A (ACK perdido) el único aviso posterior a la copia es justamente ese ACK que se perdió. Una copia coherente tomada antes de recibir R, y restaurada, contesta NOT_FOUND con c+1 ≥ marca y el servidor libera un R que sí se cobró. (c) Si se restaura sólo avoqado_database dejando el -wal actual, SQLite aplica los frames nuevos del WAL sobre el archivo viejo sin comprobar que sean pareja. La página del centinela, que se reescribe en cada mutación y casi siempre está en el WAL, sale nueva; la página donde vivía R sale vieja. Queda S ≥ M con R ausente y el arranque dice «Continua», o bien la base queda corrupta y se cae en el hallazgo 1.
- **Evidencia:** avoqado-tpv build.gradle.kts:398-404: el buildType debug no desactiva debuggable. Diseño A.3: «copia completa… hecha con root»; A.10 físicas: «copia de la base con run-as y restauración posterior (rota: S < M)». Por el PK TEXT, la tabla es de rowid: el centinela (el primer rowid) y las filas posteriores quedan en páginas distintas en cuanto la tabla crece.
- **Arreglo propuesto:** Que el centinela guarde invariantes de la tabla (COUNT(*), MAX(rowid), MAX(updated_at)) y que el arranque los verifique junto con un `PRAGMA quick_check`; cualquier discrepancia ⇒ rotar. Anunciar identidad sólo cuando la app no es depurable (FLAG_DEBUGGABLE), o marcar las entregas a builds depurables como no confiables. Procedimiento de QA: app detenida, copiar y restaurar db+wal+shm juntos, y sumar como prueba negativa el caso «sólo .db con -wal vivo». Reescribir el límite: una copia completa coherente posterior a lo último que vio el servidor es indetectable. Si se quiere cerrar, cruzar NOT_FOUND con evidencia del procesador (el último número de operación del SDK contra los Payment registrados de ese serial).
- **Escéptico:** CONFIRMADO → severidad P3
  - Razón: Confirmo lo técnico, pero la severidad baja a P3. No hay ningún camino de campo que lleve a dinero; el defecto está en la redacción del límite y en el procedimiento de la prueba física.

(a) Cierto. El buildType debug no fija isDebuggable, así que las builds de QA son depurables, y con run-as se puede copiar /data/data/<pkg> entero, incluida no_backup. «Hecha con root» es inexacto: el propio A.10 usa run-as. Pero las builds que se entregan (productionRelease, nexgoProdRelease) no son depurables. Además, un `adb restore` sobre una build release sin backupAgent borra los datos de la app antes de restaurar, y ese borrado incluye no_backup. Queda «S sin M» y la terminal rota. En campo, la copia completa exige root.

(b) Cierto como precisión, no como hallazgo nuevo. A.3 ya lo plantea como condicional («la detecta SI el servidor vio un contador mayor»). Con el ACK perdido y sin otro evento posterior a la copia, la marca de agua no ve nada y una copia coherente anterior a R pasa como continua. Es preciso decir que la copia completa y coherente de después de lo último que vio el servidor es indetectable. Aun así, quien puede hacer esa copia (root o run-as) también puede editar la base a mano: borrar R, subir el centinela y recalcular el espejo, cuyo sha256 no tiene secreto. Por eso ninguna defensa del lado del cliente cierra el caso adversarial. Ni el centinela con invariantes, ni quick_check, ni FLAG_DEBUGGABLE. El modelo de amenaza de A es la vuelta atrás ACCIDENTAL. Cerrar el caso adversarial exige evidencia del procesador, y eso es terreno de B.

(c) Mecánicamente válido, porque la base principal corre en WAL. SQLite no comprueba que un -wal sea pareja del .db, y su documentación advierte que mezclar un .db con el WAL de otro momento corrompe o da estados inconsistentes. El efecto real es que la prueba física de A.10, «copia de la base con run-as y restauración posterior (rota: S < M)», no especifica si se copian y restauran también -wal y -shm. Restaurar sólo el .db con el WAL vivo no produce S < M de forma confiable: puede corromper la base o, según qué páginas estén en el WAL, dejar el centinela nuevo con R ausente. Así que la prueba puede dar un resultado sin sentido. No es un camino de producción: nadie en campo restaura sólo el .db con la app viva.

Por qué no es P2: no hay camino de producción. Todos los escenarios exigen acceso privilegiado a la terminal, y ese mismo acceso permite forjar cualquier estado. Lo que falla es el texto del límite declarado y el procedimiento de QA.

Además, gatear la identidad con FLAG_DEBUGGABLE apagaría A en todas las builds de QA e impediría justo las pruebas físicas que exige el founder.

Nota aparte, que no es de este hallazgo pero conviene revisar: §0 afirma «sin fallbackToDestructiveMigration*: la app truena y los datos quedan intactos», y DatabaseModule.kt:162 tiene `.fallbackToDestructiveMigrationOnDowngrade()`. Un downgrade SÍ borra la base. El centinela en la misma tabla (A.2) lo cubre y la terminal rota, pero el dato de §0 es falso.
  - Evidencia: - avoqado-tpv/app/build.gradle.kts:385-403: `buildTypes { release { isMinifyEnabled = true … } debug { isMinifyEnabled = false … } }`. No hay isDebuggable, así que debug es depurable por defecto y release no.
- avoqado-tpv/app/src/main/AndroidManifest.xml:56-58: `android:allowBackup="true"`. Las reglas de respaldo son las de ejemplo, vacías, y no hay `backupAgent`. Una restauración completa por adb limpia los datos de la app antes de escribir, así que no_backup desaparece y queda M sin S ⇒ rotar.
- avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt:166: `.setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)` en AvoqadoDatabase. Existe el -wal, así que el caso (c) aplica.
- DatabaseModule.kt:162: `.fallbackToDestructiveMigrationOnDowngrade()`. Contradice §0 del diseño.
- Diseño A.3, último párrafo: «Límite declarado: una copia completa … hecha con root, es indetectable … La marca de agua del servidor (A.5) la detecta si el servidor vio un contador mayor después de la copia». Está redactado como condicional.
- Diseño A.10, pruebas físicas: «copia de la base con `run-as` y restauración posterior (rota: S < M)». No dice si -wal y -shm entran en la copia y la restauración, ni con la app detenida.
- Diseño A.2: el espejo lleva `sha256` sin secreto, así que quien tenga acceso de archivo puede forjarlo.
- `noBackupFilesDir` todavía no se usa en app/src/main (grep vacío): el diseño no está implementado.
  - Arreglo corregido: Solo documentación y procedimiento. Nada de código de dinero.

1) Reescribir el límite de A.3: «Una copia completa y coherente del directorio de datos (base, -wal, -shm y no_backup), restaurada con root o con run-as en una build depurable, es indetectable para la terminal. El servidor sólo la detecta si vio un contador mayor después de la copia. En el caso de ACK perdido sin otro evento posterior, no la ve. Quien tiene ese acceso puede forjar cualquier estado de la bandeja (el sha256 del espejo no lleva secreto), así que A no defiende contra un actor con acceso privilegiado. Su alcance es la vuelta atrás accidental: restauración de respaldo, borrado, downgrade o corte de luz. Las builds de campo no son depurables, y un adb restore de una build release limpia los datos antes de restaurar ⇒ rota».

2) Precisar la prueba física de A.10:
- Caso positivo: con la app detenida (`am force-stop`), copiar avoqado_database, -wal y -shm juntos más no_backup; restaurarlos juntos, borrando antes el -wal y el -shm vivos.
- Caso de rotación esperada: restaurar la base completa (.db, -wal y -shm de la copia) SIN el espejo de no_backup ⇒ S < M ⇒ rota.
- Caso negativo documentado: restaurar sólo el .db con el -wal vivo. Resultado aceptable: rotación o base detectada como corrupta. Nunca «Continua» con R ausente. Si sale «Continua», queda anotado como límite conocido.

3) Endurecimiento opcional y barato (P3): al arrancar, correr `PRAGMA quick_check` sobre la base antes de dar la identidad por continua; si falla, rotar. No gatear la identidad con FLAG_DEBUGGABLE, porque apagaría A en QA e impediría las pruebas físicas. A lo sumo, que el handshake informe `debuggable` para dejarlo en la auditoría.

4) Corregir el dato de §0: el downgrade SÍ es destructivo (DatabaseModule.kt:162). Anotar que el centinela en la misma tabla (A.2) es justo lo que convierte ese borrado en «M sin S ⇒ rotar».

5) Cruzar NOT_FOUND con evidencia del procesador queda fuera de A. Es parte de la conciliación B.

#### 6. [P3] La liberación de A no revisa pagos candidatos en su transacción, y B sí

- **Sección:** A.8 regla 6
- **Escenario:** Si cualquiera de los huecos 1, 2, 3 o 5 declara una continuidad falsa sobre un R que sí se cobró, y el Payment ya llegó por un camino sin terminalPaymentRequestId (colas viejas, o el defecto D.7 del contexto pegado), la regla 6 libera igual (FAILED/TPV_INBOX_NOT_FOUND ⇒ NOT_CHARGED al POS) y el Payment sólo aparece después como 🚨 tardío. Ese pago ya estaba en la base en el momento de liberar.
- **Evidencia:** Servidor terminal-payment.service.ts:2366-2376: el UPDATE de la liberación NOT_FOUND actual no consulta Payment. El diseño B.3 exige «relectura de findReconcilablePayment» y descartar candidatos; A.8 no.
- **Arreglo propuesto:** Dentro de la misma transacción de las reglas 5 y 6, correr findReconcilablePayment y la búsqueda de candidatos de B.1 (pagos con tarjeta de la orden posteriores a la solicitud; mismo serial, importe y ventana). Si aparece alguno, no liberar y auditar POSSIBLE_PAYMENT. Es barato y limita el daño de cualquier falla de continuidad.
- **Escéptico:** no aplica (P3 sin verificar)

#### 7. [P3] Una migración futura que reconstruya remote_payment_requests puede perder filas y conservar el centinela

- **Sección:** A.2 (centinela en la misma tabla)
- **Escenario:** C.5 ya agrega columnas en Room v34. Si esa migración o una posterior reconstruye la tabla (CREATE nueva → INSERT SELECT con un filtro, un NOT NULL o un CHECK nuevo → DROP → RENAME) y deja fuera filas viejas pero copia el centinela, el arranque ve S ≥ M con el mismo id ⇒ «Continua», y un NOT_FOUND de una fila perdida liberaría.
- **Evidencia:** AvoqadoDatabase.kt:1810-1850: la historia de esta tabla ya incluye `CREATE TABLE IF NOT EXISTS` sobre una tabla huérfana del v30 de develop; la migración de C.5 está pendiente.
- **Arreglo propuesto:** Que el centinela lleve `schemaEpoch` y que toda migración que toque la tabla lo cambie, lo que fuerza una rotación con cuarentena en el primer arranque. Agregar una prueba de migración (MigrationTestHelper) que compare el conteo de filas antes y después.
- **Escéptico:** no aplica (P3 sin verificar)

### despliegue-pruebas-nexgo

Revisé las secciones E, F, A.10 y D contra el código real (árbol y HEAD de servidor, TPV y Android). Encontré 7 P1 y 1 P2. (1) El orden de despliegue no funciona tal como está escrito. B vive en el servidor nuevo, así que no se puede conciliar «antes» de desplegarlo. Mientras tanto, el servidor de hoy sigue fabricando filas bloqueadoras cada día, y con el servidor nuevo cualquier terminal que siga en 2.9.2 queda bloqueada al primer rechazo. Las apps POS publicadas se quedan con llaves que no se pueden resolver, y la libreta que la 2.9.2 dejó en modo SHADOW bloquea la terminal en cuanto se instala el APK nuevo, sin forma de regresar a la versión anterior. (2) En las pruebas, la de «Reinicio» pasa por el motivo equivocado. El contador del handshake se queda congelado en cada reconexión automática (Doze, cada deploy del servidor), así que A declara COUNTER_REGRESSION en falso y la identidad queda descontinuada para siempre. Además, D no tiene pruebas, y la tarea por defecto ni siquiera llega a su código. (3) En Nexgo hay tres caminos a cobro doble o a cobrar por otra afiliación. Primero: la pantalla que sale re-etiqueta la VM vieja con la solicitud nueva, y al morir emite un «cancelled + PRE_AUTHORIZATION» acreditado mientras la VM nueva cobra. Esto responde D.7; la evidencia de 27d380e9 se explica por las llaves de Crashlytics, que son globales y nunca se borran, así que no prueba nada. Segundo: D.6 deja vivo «Reintentar» después de haberle dicho al POS que no se cobró. Tercero: la recuperación de fondo de D.1 autentica la cuenta primaria mientras el cobro está autenticando fuera de isCharging, justo la ventana que D.2 crea. En lenguaje llano: el diseño es bueno, pero tal como está escrito, el día del despliegue muchas terminales se quedarían bloqueadas sin salida y la pantalla de Nexgo podría provocar cobros dobles. Hay que corregir el plan de despliegue en dos pasos y las tres piezas de Nexgo antes de programar. Lo único que no pude comprobar sin aparato es que la composición que sale se vuelva a pintar con los datos nuevos; el propio código dice que ya se observó en hardware (VM:234-239).

#### 1. [P1] Las 375 filas no se pueden conciliar «antes» del servidor que trae B, y el servidor de hoy sigue fabricando bloqueadores hasta el minuto del despliegue

- **Sección:** F.1 / F.2 / B.3 (despliegue)
- **Escenario:** Hoy, en producción (HEAD 3000f3d0), cada cancelación del POS termina en CANCELLED sin disposición cuando vence la gracia. Cada failed termina en FAILED/TPV_ERROR, y los UNKNOWN se autoliberan a TIMED_OUT/AUTO_RELEASED. La N86 de Testarudo sola generó 10 CANCELLED el 11-sep. La herramienta B (releaseByConciliation, su tabla, su permiso, lastProbe*) sólo existe en el servidor nuevo, así que F.1 («conciliar antes») es imposible. Además, durante la ventana «APK primero» (3–5 días de firma de Blumon, más el TMS de AngelPay) el servidor viejo sigue creando filas. El día del despliegue, sendPaymentToTerminal busca un bloqueador sin cota de tiempo ni de venue. Resultado: cada terminal que tenga una sola fila histórica contesta 409 desde su primer cobro. Las terminales migradas quedan bloqueadas por filas de su venue anterior, que el OWNER del venue nuevo no ve. B no tiene UI, así que sólo Avoqado puede liberar, desde MCP o superadmin. Y por C.6, las órdenes con una fila histórica tampoco se pueden cancelar.
- **Evidencia:** HEAD: git show HEAD:src/services/terminal-payment.service.ts :718 (failureCode 'TPV_ERROR') y :982-984 (CANCEL_REQUESTED→CANCELLED sin disposición). Árbol: src/services/terminal-payment.service.ts:217-224 (UNRESOLVED_FINANCIAL_OUTCOME: TIMED_OUT, FAILED TPV_ERROR y CANCELLED sin ACCEPTED) y :535-548 (terminalBlocker filtrado sólo por terminalId, sin venue ni fecha). Diseño B.3 «Pendiente de UI: ningún cliente llama hoy a la liberación». nexgo-auth-arranque-sin-red-2026-09-11.md: 10 CANCELLED entre 14:43 y 17:57.
- **Arreglo propuesto:** Desplegar en dos pasos. R1: esquema + B + escritura de disposición, sonda e identidad, con el predicado nuevo APAGADO por bandera (el bloqueo sigue siendo exactamente el de producción hoy; que el founder decida explícitamente si se mantiene el AUTO_RELEASED actual). Con R1 arriba, correr B en lote hasta un corte. R2 enciende el predicado sólo si una consulta previa por terminal (incluidas las filas de otros venues de terminales migradas) devuelve 0 bloqueadores, y hace una segunda pasada de B para lo creado entre el corte y el encendido. Declarar en B el alcance superadmin para las filas de venues anteriores.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No lo pude refutar. Lo que dice el hallazgo coincide con el código. Hay un solo matiz: el daño no es de dinero, porque el sistema falla cerrado. Es una caída del cobro remoto en los clientes piloto desde el primer minuto del despliegue, y el remedio que prescribe el diseño (F.1, «conciliar antes») no se puede ejecutar. Por eso lo dejo en P1 como bloqueante de despliegue.

(1) La herramienta B no existe en ningún servidor. releaseByConciliation, TerminalPaymentConciliation, el permiso terminal-payments:reconcile y lastProbe* no aparecen ni en src ni en schema.prisma del árbol, y menos en HEAD. En producción tampoco hay dónde anotar una conciliación que el predicado nuevo sepa leer: la columna cancelDisposition no existe en HEAD. La migración 20260909181000 la agrega en NULL sin rellenar nada, y su comentario dice literalmente «Legacy rows remain unknown». Conclusión: no hay nada que se pueda conciliar «antes del servidor nuevo».

(2) El servidor de producción (HEAD) sigue fabricando filas que el árbol trataría como bloqueadoras:
- cierra cada `failed` con failureCode 'TPV_ERROR' (HEAD :718);
- pasa cada CANCEL_REQUESTED a CANCELLED, sin disposición, al vencer la gracia (HEAD :980-984);
- mueve cada UNKNOWN a TIMED_OUT/AUTO_RELEASED (HEAD :1175).
Las tres formas caen dentro de UNRESOLVED_FINANCIAL_OUTCOME del árbol (:217-224). El 11-sep la N86 sola produjo 10 CANCELLED (nexgo-auth-arranque-sin-red-2026-09-11.md:5). La ventana «APK primero» de F.2 hace crecer las 375 filas en vez de cerrarlas: mientras el servidor sea el viejo, ni siquiera un APK nuevo puede dejar una disposición.

(3) La admisión del árbol busca el bloqueador sin cota de fecha ni de venue. Es a propósito: la reserva es del aparato (:535-548 terminalBlocker, y :472-483 el selector). Con el servidor nuevo arriba, cualquier terminal con una sola fila histórica contesta 409 TERMINAL_BUSY desde su primer cobro y además sale como ocupada en el selector. Si la fila es de otro venue, el 409 lleva requestId 'unknown' (:540-546): el OWNER del venue nuevo no puede ni nombrarla.

(4) La sonda no rescata esas filas. Las filas históricas tienen deliveryProvenance NULL, y un NOT_FOUND sólo libera cuando la procedencia es exactamente [] (queda NOT_FOUND_UNKNOWN_PROVENANCE). Un RECEIVED_CANCELLED sin evidencia queda como UNACCREDITED. A excluye expresamente las «solicitudes históricas». La PAX de Testarudo en 2.8.7 ni siquiera tiene bandeja.

(5) Mismo efecto sobre las órdenes. findChargeBlockingOrderCancel (:1379-1393) usa el mismo predicado por venueId+orderId, y lo llama assertOrderCancellableUnderLock desde todas las rutas de C.6. La admisión también bloquea un cobro nuevo sobre esa orden (:584-597).

(6) B no tiene pantalla: el diseño lo dice en B.3. Si la ruta móvil está acotada al venue, las filas de un venue anterior sólo las libera SUPERADMIN o el MCP.

La secuencia F.1→F.2→servidor es contradictoria tal como está escrita.
  - Evidencia: - Árbol, src/services/terminal-payment.service.ts:217-224: UNRESOLVED_FINANCIAL_OUTCOME cubre TIMED_OUT, FAILED con failureCode ACK_TIMEOUT/ACK_REJECTED/TPV_ERROR y CANCELLED con cancelDisposition nulo o distinto de ACCEPTED.
- Árbol, :535-548: el terminalBlocker se busca `where: { terminalId: lockKey, ...UNRESOLVED_FINANCIAL_OUTCOME }`, sin venue ni fecha. `visible` es null cuando la fila es de otro venue, y entonces el requestId sale como 'unknown'.
- Árbol, :472-483: getBusy agrupa por terminalId con el mismo predicado y sin venue («SIN filtro de venue a propósito»).
- Árbol, :1379-1393: findChargeBlockingOrderCancel usa el mismo predicado; lo llama src/services/shared/orderCancelGuard.ts (assertNoLiveTerminalCharge / assertOrderCancellableUnderLock) y order.mobile.service.ts:3240.
- HEAD (git show HEAD:src/services/terminal-payment.service.ts):
  - :718 `failureCode: result.status === 'failed' ? 'TPV_ERROR' : null`
  - :980-984 CANCEL_REQUESTED → `{status: CANCELLED, failureCode: 'CANCELLED'}`, sin disposición
  - :1175 UNKNOWN → `{status: TIMED_OUT, failureCode: 'AUTO_RELEASED'}`
  - HEAD:prisma/schema.prisma no tiene cancelDisposition.
- Migración prisma/migrations/20260909181000_terminal_payment_cancel_disposition/migration.sql: sólo `ADD COLUMN "cancelDisposition" TEXT`, con el comentario «Legacy rows remain unknown». La migración 20260911150000 deja deliveryProvenance en NULL para las filas históricas.
- `grep releaseByConciliation|TerminalPaymentConciliation|terminal-payments:reconcile|lastProbeDisposition` en src y prisma: 0 resultados.
- Diseño §0: 375 filas (343 CANCELLED sin disposición, 30 TPV_ERROR, 2 TIMED_OUT). §F.1 dice «antes del servidor nuevo», §F.2 «APK primero… Después el servidor», y B.3 «Pendiente de UI».
- nexgo-auth-arranque-sin-red-2026-09-11.md:5: 10 CANCELLED de la N86 entre 14:43 y 17:57 UTC.
  - Arreglo corregido: Reescribir F como un despliegue en dos pasos, con un corte explícito. Además, corregir un punto del arreglo propuesto: su R1 no puede ser «el bloqueo exactamente como en producción hoy», porque producción libera UNKNOWN por plazo (AUTO_RELEASED) y el founder rechazó eso el 10-sep.

R1, servidor nuevo con esquema, B, escritura de disposición, sonda e identidad:
- El predicado nuevo se aplica a la admisión, al selector y a C.6 SÓLO para filas creadas por el servidor nuevo, las que tienen deliveryProvenance no nulo. Toda fila nueva nace con `{deliveries: []}`, así que ese corte sale solo, sin bandera, y ninguna fila nueva se libera por tiempo.
- Las filas históricas (deliveryProvenance NULL, anteriores al despliegue) conservan en admisión y cancelación el trato que tienen hoy en producción, o sea que no bloquean. No es una regresión: hoy ya están libres. Aun así se listan como pendientes de B y quedan en la vigilancia de dinero tardío.
- Que el founder confirme por escrito ese trato a la historia, o que elija bloquearla.
- No reactivar AUTO_RELEASED.

Con R1 arriba, correr B en modo lote sobre las filas históricas hasta un corte, usando los exportes de Blumon y AngelPay.

R2, sólo si una consulta previa por terminal devuelve 0 filas históricas sin conciliar, también las de otros venues de terminales migradas: activar el predicado también para la historia (quitar la excepción de deliveryProvenance NULL) y hacer una segunda pasada de B.

Tres ajustes más:
- B debe permitir alcance SUPERADMIN o MCP sobre filas de un venue distinto del actual de la terminal. El 409 de admisión con requestId 'unknown' tiene que decir que el bloqueo es de otra sucursal y que lo libera Avoqado.
- F.2 debe decir explícitamente que durante la ventana del APK la cifra de 375 crece.
- F.5 (órdenes huérfanas) se ejecuta después de R1 más B, no antes.

#### 2. [P1] El contador del handshake se queda congelado en cada reconexión automática: A declara COUNTER_REGRESSION en falso y la identidad queda descontinuada para siempre

- **Sección:** A.4 / A.5 / A.10 (identidad)
- **Escenario:** La TPV del árbol construye el mapa auth una sola vez en connect(), y socket.io reconecta solo con esas mismas opciones. Ejemplo: la app arranca con el contador en 10 y manda handshake 10. Recibe cobros, contesta sondas y la marca del servidor sube a 15 (A.5/A.8.5). Doze corta el socket (medido en Testarudo: 3 latidos/h en horario de tienda y 9 reinicios en 4 días), o Render redeploya y toda la flota reconecta a la vez. Llega un handshake 10 < marca 15, y A.5 lo pasa a DISCONTINUED(COUNTER_REGRESSION) con 🚨; como «nunca se reactiva» y la TPV no rota (su S y M cuadran), el socket queda no confiable para siempre. Desde ahí A no libera nada (regla 3). A.9 tampoco reentrega filas en vuelo a ese socket, lo cual es una regresión frente al plan D. Resultado: una PAX dormida que perdió el ACK queda reservada esperando B sin UI, que es justo el caso P2-2 que A debía cerrar. A.4 dice que el valor se trata como cota inferior y A.5 hace lo contrario. En A.10, la prueba «Reinicio» fabrica un contador MAYOR y pasa por el motivo equivocado; la de «Copia antigua» no distingue una restauración de una reconexión normal.
- **Evidencia:** avoqado-tpv core/data/realtime/SocketManager.kt:203-215 (auth = buildMap{…} una sola vez) y :221-224 (reconnection=true, reconnectionAttempts=MAX). Diseño A.4 («En reconexiones automáticas el valor queda congelado: el servidor lo trata como cota inferior») contra A.5 («identidad ACTIVE con contador < maxCounterObserved ⇒ DISCONTINUED(COUNTER_REGRESSION)… nunca se reactiva»). Tabla A.10, fila «Reinicio».
- **Arreglo propuesto:** El contador del handshake es sólo cota inferior y nunca descontinúa por sí solo. Agregar terminalPaymentInboxBootId (aleatorio por proceso, emitido tras la verificación del arranque). Juzgar retroceso sólo en eventos vivos (ACK, sonda, disposición) con contador < marca, o en un handshake con bootId distinto y contador < marca. Opcionalmente, reconstruir auth en cada intento (mapa mutable actualizado en el evento de reintento de conexión). Pruebas nuevas: una de integración, «reconexión automática con contador congelado ⇒ sigue ACTIVE y confiable, y la sonda NOT_FOUND libera»; y dos físicas: cortar la red 60 s tras al menos un ACK sin reiniciar la app, y reiniciar el servidor con la terminal conectada.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: Intenté refutarlo y no pude: el defecto se sostiene con el código y con el propio diseño. Pasa incluso con la lectura más estricta, en la que la marca sólo sube al conectar y al liberar. Una sonda NOT_FOUND libera la fila y sube la marca al contador que viene después de escribir la lápida (A.8 paso 5). Ese contador vale al menos C0+1, siendo C0 el que se mandó en el handshake. En la siguiente reconexión automática del mismo proceso (Doze o redeploy de Render) viaja C0 congelado, que es menor que la marca. A.5 lo trata como DISCONTINUED(COUNTER_REGRESSION) y no se reactiva nunca. La TPV tampoco rota, porque S y M cuadran. Desde ahí el socket queda no confiable para siempre: A no vuelve a liberar y A.9 no reentrega. Es decir, el mecanismo se destruye justo después de su primer éxito, y en el perfil de conectividad donde ocurre la liberación (el ACK se pierde casi siempre porque se cae la red). A.4 («cota inferior») contradice a A.5. Hay además un segundo camino del mismo defecto que el revisor no vio. Las sondas salen en lote y sus respuestas se procesan en paralelo, así que pueden confirmarse en otro orden. Entonces la comprobación de A.8 paso 5 («maxCounterObserved ≤ inboxCounter, si no DISCONTINUED») también descontinúa en falso, aunque no haya reconexión. Por eso el arreglo del revisor, que juzga el retroceso en los eventos vivos, hereda ese problema y lo corrijo. No mueve dinero por error (falla cerrado). Mantengo P1 porque anula la recuperación que eligió el founder y empeora el replay respecto al plan D. La terminal queda reservada hasta la conciliación B, que no tiene pantalla (el caso P2-2 que A debía cerrar), y además dispara 🚨 falsas a ops.
  - Evidencia: TPV, avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/realtime/SocketManager.kt:203-215: `auth = buildMap{…}` se construye una sola vez dentro de connect(). En :221-224 están reconnection=true y reconnectionAttempts=Int.MAX_VALUE, con forceNew. onDisconnect (:578-583) sólo emite estado y no vuelve a llamar connect(). Sólo reconnect() y reconnectWithFreshToken() (:314-343, que se disparan al refrescar el token, HomeViewModel:608) reconstruyen auth. Un corte de red o de transporte reconecta dentro de socket.io-client 2.1.1 (build.gradle.kts:704) con el mismo mapa. Servidor: socketManager.ts:203 lee `socket.handshake.auth` en cada conexión nueva, así que cada reconexión pasaría por observeInboxIdentity con el valor congelado. Diseño: A.4 (líneas 90-92, «congelado… cota inferior»); A.5 (línea 109, «contador < maxCounterObserved ⇒ DISCONTINUED(COUNTER_REGRESSION)», y 107, «nunca se reactiva»); A.8 paso 5 (línea 138, «sube la marca» y «si no, la pasa a DISCONTINUED»); A.2 (la lápida incrementa el contador); A.9 (el replay exige un socket confiable con el mismo inboxId). Segundo camino: terminal-payment.service.ts, en probeUnresolvedForTerminal (~2169-2184), hace findMany con take: PROBE_BATCH y emite una sonda por fila. socketManager.ts:395-410 atiende 'terminal:payment_probe_result' en un handler async sin serializar. Tres lápidas con contadores 14/15/16 pueden confirmarse como 16→14, y el paso 5 descontinuaría con la de 14. A.10, fila «Reinicio»: fabrica un contador mayor, así que nunca ejercita la reconexión con el contador congelado. La fila «Copia antigua» no distingue una restauración de una reconexión normal.
  - Arreglo corregido: 1) El contador del handshake nunca descontinúa por sí solo cuando viene del mismo arranque. Se agrega `terminalPaymentInboxBootId`: un UUID aleatorio por proceso, generado después de la verificación del arranque (A.3). El servidor guarda por identidad los bootId que ya vio (o sólo el último). COUNTER_REGRESSION sólo aplica a un handshake con un bootId que no había visto y un contador menor que la marca: una restauración implica proceso nuevo, así que se sigue detectando. Con el mismo bootId, el contador es cota inferior: la marca sólo sube con GREATEST y el socket se confía si la identidad está ACTIVE.
2) Los eventos vivos (ACK, sonda, disposición) sólo SUBEN la marca con GREATEST y nunca descontinúan por contador menor. Dentro de un mismo arranque el contador ya es monótono (un solo escritor), y los handlers del servidor confirman en otro orden (sondas en lote). En A.8 paso 5 se sustituye «maxCounterObserved ≤ inboxCounter, si no DISCONTINUED» por: identidad X ACTIVE y bootId del socket igual a un arranque ya verificado de X; se sube la marca con GREATEST.
3) Opcional, verificándolo antes en la librería: pasar auth como un mapa mutable (ConcurrentHashMap) y actualizarlo en el mismo punto donde se escribe el espejo, antes de cualquier efecto visible. Así la reconexión automática lleva el contador actual (socket.io-client 2.x conserva la referencia de opts.auth). Aun así, la decisión tiene que descansar en el bootId, no en esto.
4) Pruebas de integración contra Postgres: «reconexión con el mismo bootId y el contador congelado, después de una liberación ⇒ sigue ACTIVE y confiable, el replay reentrega y un NOT_FOUND nuevo libera»; «tres NOT_FOUND del mismo lote procesados en orden inverso de contador ⇒ liberan los tres, la identidad sigue ACTIVE y hay una sola marca final»; «Copia antigua» reescrita como bootId nuevo con contador menor que la marca ⇒ COUNTER_REGRESSION; «Reinicio» con bootId nuevo y contador ≥ marca ⇒ confiable. Cada una con su sabotaje.
5) Pruebas físicas (PAX y Nexgo): cortar la red 60 s después de al menos una liberación por sonda y un ACK, sin reiniciar la app; reiniciar el servidor con la terminal conectada; forzar Doze con `dumpsys deviceidle force-idle` y luego `unforce`. En los tres casos la identidad sigue ACTIVE y no hay 🚨.

#### 3. [P1] La pantalla que sale re-etiqueta la VM vieja con la solicitud NUEVA y, al morir, emite un «cancelled + PRE_AUTHORIZATION» acreditado mientras la VM nueva cobra

- **Sección:** D.7 (Nexgo, árbol)
- **Escenario:** La N86 del árbol queda en Error transitorio de A («Cambio de merchant no se completó», que no emite nada) o en Cancelled; isChargeAttemptActive vale false en esos estados. Llega B. AppNavigation limpia, hace pop a Home, escribe los argumentos de B en el handle de Home y empuja otra pantalla de pago. La composición que sale lee navController.previousBackStackEntry, que es global y ahora apunta a Home con B. Su LaunchedEffect(paymentSource, socketRequestId) llama setSocketPaymentSource(SOCKET, B) sobre la VM vieja, que sólo ignora null o el mismo id, y además pone _socketResultEmitted=false. Al destruirse, onCleared→emitCancelledIfAbandoned emite cancelled para B con PRE_AUTHORIZATION (authorizationWasLaunched=false). La bandeja lo acepta sobre la fila PROCESSING de B y el servidor lo acredita como CANCELLED/ACCEPTED ⇒ NOT_CHARGED, mientras la VM nueva sigue cobrando B. El POS dice «se canceló, no se cobró», el cajero cobra por otro lado y el cliente completa B en la N86: cobro doble (el 🚨 llega después). En HEAD 2.9.2 el mismo re-etiquetado emite cancelled SIN evidencia, y el servidor nuevo no lo acredita: el peligro nace con la evidencia que añadió el árbol. «Reintentar» con contexto mezclado no es alcanzable por esta vía (la VM vieja está muriendo). «El contexto de otro cobro» que se ve en 27d380e9 se explica por las llaves de Crashlytics, que son globales al proceso y nunca se borran; no prueba ni descarta el defecto.
- **Evidencia:** AppNavigation.kt:420-486 (terminalGenuinelyBusy → pop a Home → handle.set de B → navigate) y :2776-2811 (args leídos de navController.previousBackStackEntry, no de la entrada propia). AngelPayPaymentScreen.kt:194-196. AngelPayPaymentViewModel.kt:243-247 (sólo ignora null o el mismo id), :765-771 (Error/Cancelled no activos), :3402-3435 (emitCancelledIfAbandoned con PRE_AUTHORIZATION) y :234-239 (re-ejecución al desmontarse, observada en hardware el 10-ago). RemotePaymentRequestDao.kt:60-65 (markResolved admite cualquier estado salvo RESOLVED o lápida). Servidor closeRow :1111-1113 y :1137 (cancelled+PRE_AUTHORIZATION ⇒ cancelDisposition ACCEPTED). CrashlyticsContext.kt:95-111 (sólo escribe llaves no nulas; no hay clear). PaymentViewModel sandbox:2137 (setSocketPaymentSource sin ninguna guarda).
- **Arreglo propuesto:** (1) setSocketPaymentSource rechaza un requestId distinto no nulo cuando ya tiene uno (🚨 + Crashlytics), en AngelPay y en los PaymentViewModel de sandbox y production. (2) El composable lee sus argumentos de su propia NavBackStackEntry (el parámetro it) o de un portador indexado por requestId, nunca de navController.previousBackStackEntry. (3) emitCancelledIfAbandoned sólo emite para el requestId que ESTA VM reclamó, ligado al contexto en initPayment. (4) Borrar las llaves de pago de Crashlytics en resetPayment/onCleared. Prueba de navegación: A en Error + llega B ⇒ la VM de A no emite nada para B.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No pude refutarlo: cada eslabón está en el código del árbol, y el más dudoso (que la pantalla que sale vuelva a leer previousBackStackEntry durante la transición) está verificado en hardware por el propio repo. El commit f697b1c (10-ago, N86, requestId a9e7503e) documenta que al desmontarse la pantalla su LaunchedEffect vuelve a correr con los valores del previousBackStackEntry nuevo. En el camino A→B, AppNavigation hace todo en un bloque síncrono dentro de collect, sin suspender: limpia Home, hace pop a Home, escribe los argumentos de B en el handle de Home y empuja la pantalla nueva. Cuando la composición de A se recompone, la pila es [Home, B], así que previousBackStackEntry ya es Home con los datos de B. setSocketPaymentSource(SOCKET, B) pasa las dos guardas (no es nulo y no es el mismo id), vuelve a poner _socketResultEmitted en false y solicitudCerradaAntesDeAutorizar en false. Al terminar el fade, onCleared llama a emitCancelledIfAbandoned. Ahí sinDineroEnVuelo(Error/Cancelled) da true y, con authorizationWasLaunched=false, la evidencia sale PRE_AUTHORIZATION. SocketManager lo escribe con markResolved, que acepta PROCESSING, y el servidor (closeRow) lo acepta como CANCELLED + cancelDisposition ACCEPTED y responde a la espera del POS. El POS lo traduce a NotCharged («El cobro se canceló. No se cobró la tarjeta.») y suelta la llave durable. El VM de B no consulta la bandeja ni el servidor antes de autorizar, así que sigue cobrando. Después, su success reemplaza al cancelled en Room y closeRowFromPaymentTx pasa la fila a COMPLETED, pero el POS ya dijo «no se cobró». Hay dos correcciones al escenario. (1) El error «Cambio de merchant no se completó» SÍ emite failed+PRE_AUTHORIZATION cuando consta que no se cobró (fallaAntesDeAutorizar). Si A fuera remoto y NO emitiera, el servidor retendría la terminal y B nunca llegaría. Los casos reales son: A remoto que ya emitió su fallo antes de autorizar (terminal libre, pantalla de Error arriba), o A iniciado en la terminal (sin fila en el servidor) que quedó en Error antes de autorizar. (2) El Cancelled del SDK sólo es peligroso si la evidencia negativa guardada es PRE_AUTHORIZATION. Si A traía PROCESSOR_DECLINED, el servidor rebaja un cancelled con esa evidencia a timeout: B queda en UNKNOWN (el POS ve «sin confirmar»), sin NotCharged y sin cobro doble. La variante de A iniciado en la terminal invalida el arreglo (1) tal como está: ese VM tiene _socketRequestId en null, así que la guarda «rechaza un id distinto cuando ya tiene uno» no lo detendría. La severidad P1 se sostiene: el POS le dice al cajero que no se cobró mientras la N86 cobra, y el camino de «pantalla de resultado vieja → cobro nuevo del POS» es intencional y diario (arreglo del 14-jul). Blumon no emite en onCleared, así que este camino exacto es sólo de Nexgo.
  - Evidencia: AppNavigation.kt ~420-486: terminalGenuinelyBusy exige isChargeAttemptActive; la rama de resultado viejo hace clearPaymentArgs(previousBackStackEntry) → navigate(Home){popUpTo(Home)} → currentBackStackEntry(=Home).savedStateHandle.set(paymentSource, socketRequestId=B…) → navigate(getPaymentRoute()), todo sin suspender. AppNavigation.kt ~2776-2811: el composable de AngelPayPayment lee paymentSource/socketRequestId de navController.previousBackStackEntry, no de su propia entrada; línea 877: currentBackStackEntryAsState en AppNavigation hace que la raíz se recomponga con cada cambio de pila. AngelPayPaymentScreen.kt:194-195: LaunchedEffect(paymentSource, socketRequestId) { setSocketPaymentSource(...) }. AngelPayPaymentViewModel.kt setSocketPaymentSource (~230-255): sólo sale antes si uno de los dos es nulo o si es el mismo id y la misma fuente; si no, asigna, pone _socketResultEmitted=false y solicitudCerradaAntesDeAutorizar=false; el comentario del propio método cita hardware del 2026-08-10 (N86, a9e7503e) y el commit f697b1c: «el LaunchedEffect vuelve a correr … porque el previousBackStackEntry cambia durante el pop». init ~778-790: Error y Cancelled no cuentan como activos. fallaAntesDeAutorizar ~1462-1483: el error de merchant SÍ emite failed+PRE_AUTHORIZATION si consta que no se cobró. emitCancelledIfAbandoned (~3400) + onCleared (~3452): emite cancelled con confirmedNegativeEvidence ?: PRE_AUTHORIZATION si !authorizationWasLaunched; sinDineroEnVuelo(~3797) da true para Error y Cancelled. SocketManager.kt:1999-2045: persistResult → markResolved antes de emitir; RemotePaymentRequestDao markResolved: WHERE status NOT IN ('RESOLVED','NOT_FOUND_ANSWERED'); RemotePaymentInbox.persistResult: un success posterior reemplaza al cancelled. El AngelPay VM no hace ninguna referencia a la bandeja ni al coordinador antes de autorizar. Servidor terminal-payment.service.ts closeRow (~1096-1140): cancelled+PRE_AUTHORIZATION pasa el filtro → CANCELLED con cancelDisposition ACCEPTED y resuelve la espera; cancelled+PROCESSOR_DECLINED se rebaja a timeout; closeRowFromPaymentTx lleva después cualquier fila a COMPLETED. Android CardChargeOutcome.kt:261: CANCELLED && ACCEPTED ⇒ NotCharged; TerminalPaymentService.kt:515: NotCharged ⇒ clearMatching(requestId) («reintentar es seguro»). Blumon PaymentViewModel sandbox:2137 no tiene guarda, pero su onCleared (9762) no emite resultado.
  - Arreglo corregido: (1) La causa raíz está en el composable. Congelar los argumentos del cobro por entrada: val args = remember(backStackEntry.id) { leer una sola vez previousBackStackEntry.savedStateHandle }, o copiarlos al savedStateHandle de la PROPIA entrada en su primera composición y leerlos siempre de ahí (it). Nunca volver a leer navController.previousBackStackEntry en recomposiciones. Aplicarlo igual al composable de Blumon (Payment). (2) Defensa en el VM: el enlace con el socket se acepta UNA sola vez, sólo mientras el VM está sin estrenar (state Idle, sin intento abierto ni authorizationWasLaunched, sin ningún desenlace previo). Cualquier otro tag no nulo se rechaza con 🚨 y Crashlytics, incluido el paso de null a B sobre un VM que ya cobró o falló en local. Una guarda que sólo mire «ya tiene otro requestId» deja abierta la variante del cobro iniciado en la terminal. Mismo cambio en los PaymentViewModel de sandbox y production. (3) Ligar la solicitud reclamada al contexto en initPayment. emitCancelledIfAbandoned y emitSocketResultIfSocketSourced sólo emiten para ese requestId, y nunca heredan la confirmedNegativeEvidence de otra solicitud. (4) Opcional y defensivo: antes de autorizar, que el VM compruebe que su fila de la bandeja sigue en PROCESSING. Si ya está RESOLVED, aborta antes del SDK y lo dice. (5) P3, aparte: borrar las llaves de pago de Crashlytics en resetPayment/onCleared. Pruebas: (a) A remoto en Error antes de autorizar, ya emitido, y llega B ⇒ el VM de A no emite nada para B; (b) A iniciado en la terminal en Error antes de autorizar (source null) y llega B ⇒ el VM de A no se re-etiqueta ni emite; (c) prueba de navegación en la que la pantalla que sale recompone después del handle.set de B y conserva sus argumentos de A.

#### 4. [P1] «failed + PRE_AUTHORIZATION» deja vivo «Reintentar» sobre la MISMA solicitud: con la auth recuperada en segundo plano, cobra algo que el POS ya dio por no cobrado

- **Sección:** D.6 + D.1 (Nexgo)
- **Escenario:** La auth falla sin red en un cobro remoto. D.6 emite failed+PRE_AUTHORIZATION → el servidor lo deja FAILED/TPV_CONFIRMED_NO_CHARGE → C.1 lo proyecta como NOT_CHARGED → el POS dice «no se cobró» y el cliente paga en la PAX, que es lo que pasó el 11-sep. Mientras tanto la N86 queda en Error(canRetry=true) con _socketRequestId intacto, porque los errores transitorios lo conservan a propósito. retryAfterError sólo bloquea si authorizationWasLaunched, y aquí es false. D.1 recupera la auth en segundo plano, alguien toca «Reintentar» y se cobra el mismo importe con el mismo requestId. La bandeja reemplaza el failed por success y el servidor reconcilia a COMPLETED con 🚨, pero tarde: el cliente ya pagó dos veces. Hoy no ocurre porque la auth atorada impide cobrar; D.1 y D.6 juntas lo habilitan. El mismo hueco existe con el reintento tras PROCESSOR_DECLINED, que conserva el enlace a propósito, ahora que C.4 actúa sobre NOT_CHARGED.
- **Evidencia:** AngelPayPaymentViewModel.kt:1494-1512 (fallo de auth → Error canRetry=true, sin limpiar _socketRequestId), :3307-3329 (retryAfterError; la guarda :3311-3312 exige authorizationWasLaunched) y :470-474 (el reintento tras rechazo conserva el enlace). RemotePaymentInbox.kt:181-185 (success reemplaza a failed). Servidor closeRow :1136 (TPV_CONFIRMED_NO_CHARGE) y closeRowFromPaymentTx :1197-1204 (cualquier fila no COMPLETED → COMPLETED).
- **Arreglo propuesto:** Cuando la VM emite cualquier desenlace NOT_CHARGED (PRE_AUTHORIZATION o PROCESSOR_DECLINED) de un cobro remoto, pasa a un estado final sin «Reintentar» («El POS ya sabe que no se cobró; vuelve a enviarlo desde el POS») y suelta el enlace. Además, la cerca durable de C.5 rechaza reserveTerminal para un requestId cuya fila de bandeja esté RESOLVED sin success. Prueba (en la variante Nexgo): la auth falla → se emite un solo failed+PRE_AUTHORIZATION y no se abre ningún intento de libreta posterior con ese requestId.
- **Escéptico:** REFUTADO → severidad P3
  - Razón: El escenario central no se sostiene en el árbol de trabajo. El texto de D.6 no dice qué pasa con «Reintentar», pero la implementación de D.6 que otra sesión está escribiendo ahora mismo en AngelPayPaymentViewModel.kt ya lo cierra. El archivo cambió de 3,695 a 3,829 líneas mientras lo leía; los números de línea del revisor salen de una versión anterior.

Cómo queda en el árbol:
- Un fallo de la auth previa pasa por `fallaAntesDeAutorizar`. Sólo emite `failed + PRE_AUTHORIZATION` si la solicitud es remota, no se lanzó nada (`!authorizationWasLaunched`) y la libreta no tiene cobros sin resolver. El vencimiento de la espera de 8 s del comercio va por el mismo camino.
- En ese caso marca `solicitudCerradaAntesDeAutorizar = true` y deja la VM en `Error(canRetry = false)` con el texto «Vuelve a cobrar desde el punto de venta».
- `ErrorContent` sólo pinta «Reintentar» si `canRetry` es verdadero. Además, `retryAfterError()` sale de inmediato con ese indicador puesto en una solicitud remota. «Regresar» llama a `resetPayment()`, que suelta `_socketRequestId`.
- El fallo de auth que queda dentro de `startSdkCardPayment` (`Error(canRetry = true)`) sigue sin emitir nada, a propósito. Sin «failed» en el POS no hay contradicción: si el reintento cobra, el long-poll todavía puede recibir el success.
- La prueba `P1 cobro remoto con la auth previa fallida avisa failed PRE_AUTHORIZATION y no ofrece reintentar` fija la emisión única, `canRetry = false` y que no se abre ningún intento de libreta.

La parte del rechazo del banco tampoco es nueva. El reintento tras PROCESSOR_DECLINED conserva el enlace a propósito para que el servidor concilie el cobro a COMPLETED, y así funciona hoy en producción. D.1 y D.6 no lo cambian. C.4 sólo borra la orden cuando el cajero pulsa «Cancelar» en el POS y consta NOT_CHARGED; no actúa en automático ante cualquier NOT_CHARGED.

Lo que queda son dos faltas menores:
1. El diseño no escribe la regla que la implementación sí cumple.
2. El indicador vive en memoria, no en `SavedStateHandle`. Si el proceso muere con la pantalla de error abierta, `_socketRequestId` se restaura y el indicador se pierde. El cajero tendría que volver a arrancar el cobro sobre esa solicitud. Es un caso borde sin demostrar; el revisor no lo planteó.
  - Evidencia: avoqado-tpv, árbol de trabajo a las 13:2x del 11-sep. Es WIP de otra sesión y se estaba editando durante la lectura: la primera lectura tenía 3,695 líneas y la segunda 3,829.
- AngelPayPaymentViewModel.kt:506-508: nuevo campo `solicitudCerradaAntesDeAutorizar` («la terminal ya no la cobra»).
- :1420-1428: la auth previa (`asegurarSesionAntesDeEsperar`) falla y llama a `fallaAntesDeAutorizar`.
- :1462-1485 (`fallaAntesDeAutorizar`): emite `failed` + `PRE_AUTHORIZATION` sólo con `esRemoto && !authorizationWasLaunched && cobroSinResolver() == null`; después pone el indicador en true y `_state = Error(canRetry = false, «…Vuelve a cobrar desde el punto de venta.»)`.
- :1519-1524: la espera del comercio vencida va por el mismo camino.
- :3448-3455 (`retryAfterError`): `if (solicitudCerradaAntesDeAutorizar && _paymentSource == "SOCKET") return` («Reintento BLOQUEADO: el POS ya fue avisado…»).
- :3641-3645 (`resetPayment`): limpia `_socketRequestId` y el indicador.
- :1638-1652: el fallo de auth dentro de `startSdkCardPayment` sigue en `canRetry = true` y SIN emitir; el comentario explica que emitir ahí causaría «stale failed → human double-charge».
- AngelPayPaymentScreen.kt:937: el botón «Reintentar» sólo existe con `state.canRetry`. :720-724: «Regresar» llama a `resetPayment()`.
- AngelPayAuthPreviaCobroTest.kt:285-310: comprueba una sola emisión `failed` + `PRE_AUTHORIZATION`, `canRetry` en false, 0 llamadas a `openAttempt` y 0 al SDK. :314-340 cubre la espera vencida.
- Reintento tras rechazo: :470-474 (el enlace sobrevive a la emisión «para que el servidor concilie») es un comportamiento anterior e intencional.
- Servidor, `closeRow`, terminal-payment.service.ts:1136-1141 (`TPV_CONFIRMED_NO_CHARGE`), y `closeRowFromPaymentTx`, :1178-1204: confirmados, pero sólo importarían si el reintento siguiera disponible, y no lo está.
- Diseño C.4: la orden sólo se borra con la intención explícita de «Cancelar» del cajero, no ante cualquier NOT_CHARGED.
  - Arreglo corregido: Sólo documentación y una prueba; el código de dinero ya cumple.
1. En el diseño D.6, escribir la regla que ya está implementada: «tras emitir `failed` + `PRE_AUTHORIZATION`, la VM queda en `Error(canRetry = false)`, `retryAfterError()` rechaza esa solicitud y «Regresar» suelta el enlace; el cobro se vuelve a mandar desde el POS».
2. Añadir a AngelPayAuthPreviaCobroTest el caso que falta: después de la emisión, llamar a `retryAfterError()` directamente y comprobar que no navega, que no hay una segunda emisión y que `openAttempt` sigue en 0 llamadas.
3. Opcional, para el caso borde de muerte del proceso: guardar `solicitudCerradaAntesDeAutorizar` en `SavedStateHandle`, igual que `_socketRequestId` y `_socketResultEmitted`. Así una VM recreada no puede volver a arrancar el cobro sobre esa solicitud.
No hace falta la cerca durable en `reserveTerminal` que propuso el revisor. Tampoco hay que cambiar el reintento tras PROCESSOR_DECLINED: ya funciona así en producción, a propósito, y se concilia a COMPLETED con 🚨.

#### 5. [P1] La recuperación de fondo autentica la PRIMARIA mientras el cobro autentica fuera de isCharging: el SDK cobra por otra afiliación después de pasar el candado de alineación

- **Sección:** D.1 / D.2 (Nexgo, regla de Amaena)
- **Escenario:** Venue con varias cuentas AngelPay (Amaena, n860w173570). D.2 mueve ensureAuthenticatedAs(cuenta elegida) antes de la espera, pero setCharging(true) sigue después, así que durante la auth del cobro isCharging=false. D.1 dispara recoverIfStuck, por ejemplo con el fetchConfig exitoso que hace el propio refreshTerminalConfigQuietly del cobro, o al volver la red. Como ensureAuthenticatedAs hizo logout, el SDK está sin sesión, y la recuperación llama ensureAuthenticated() sin cuenta, es decir, la primaria. El candado sobre el núcleo sólo pone las dos auth en fila: si gana la del cobro, la de fondo corre justo después y deja la sesión en la primaria. El candado de alineación lee la marca en memoria activeAngelPayMerchantId ANTES de abrir la libreta, validar el intent y lanzar el SDK. Si la auth de fondo (hasta ~39 s con reintentos) termina después de ese chequeo, el SDK cobra con la sesión primaria mientras el registro lleva el comercio elegido: es el incidente de Amaena ($4,344.50). FETCH_ANGELPAY_MERCHANTS entra por la misma ventana, porque llama ensureAuthenticated sin mirar isCharging. Aparte de esto, la auth de fondo pone el estado compartido en Authenticating y la pantalla apaga Tarjeta y Efectivo durante cada ciclo; el diseño no dice cómo evitarlo.
- **Evidencia:** AngelPayPaymentViewModel.kt:1293-1304 (la espera va antes de setCharging(true)), :1488-1493, :1519-1559 (orden: alineación → libreta → validación → lanzamiento) y :2507-2513 (la alineación lee activeAngelPayMerchantId en memoria). AngelPayAuthRepository.kt:195 (resolve() = cuenta primaria), :245 (Authenticating global), :251 (retryWithBackoff de 5 intentos), :267-271 (una auth exitosa siembra el comercio activo), :556-559 (logout en ensureAuthenticatedAs) y :798-806 (fetchConfig dentro de la auth). CommandExecutor.kt:1270. AngelPayPaymentScreen.kt:595-597.
- **Arreglo propuesto:** (1) Un solo dueño de la auth para todo el tramo auth → alineación → lanzamiento: un Mutex o Deferred que el cobro toma desde startCardPayment hasta el lanzamiento o el error. (2) recoverIfStuck usa tryLock, revalida DENTRO del candado todas sus condiciones (sin sesión, sin cobro), y trata como «cobro en curso» todo estado de la VM distinto de Idle/Error/Success/Cancelled. (3) Nunca autentica la primaria en un venue con varias cuentas: usa la cuenta del último comercio activo, o sólo marca «requiere auth» y deja que el cobro autentique. FETCH_ANGELPAY_MERCHANTS respeta el mismo candado. (4) Revalidar la alineación contra la sesión VIVA del SDK justo antes de launcher.launch. (5) Un estado de recuperación separado de Authenticating, para que el efectivo siga disponible.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 6. [P1] Con el servidor nuevo, una TPV que siga en 2.9.2 queda bloqueada al primer rechazo, y las apps POS publicadas se quedan con llaves que no se pueden resolver

- **Sección:** F.2 (combinaciones intermedias con clientes viejos)
- **Escenario:** (a) Terminales que no se actualizaron: las Nexgo sólo se actualizan por el TMS de AngelPay, fuera del control de Avoqado, y también hay terminales apagadas y repuestos. La 2.9.2 sólo declara ACK y manda failed/cancelled sin evidencia. El servidor nuevo convierte cada rechazo o cancelación en TIMED_OUT/UNKNOWN, no le manda sonda (exige probeVersion ≥ 1), y A no aplica. Resultado: el primer rechazo del día deja la terminal bloqueada hasta B, que no tiene UI. F no tiene ninguna compuerta que garantice «APK primero». (b) Apps POS publicadas: un 409 TERMINAL_BUSY o un 404 previo a crear la fila hacen que el Android publicado vaya a consultar el estado; el GET contesta 404 y queda Undetermined, con una llave durable que ya no se puede resolver (medido el 10-sep en la Sunmi, llave 39b349ef). El servidor nuevo multiplica esos 409, porque sus bloqueadores ya no se autoliberan, y C.3 sólo ayuda a las apps del árbol. La frase «funcionan con los dos servidores» es falsa en este caso. (c) Durante la ventana «APK primero», el defecto conocido del replay tras actualizar de 2.8.7 sigue vivo en el servidor viejo.
- **Evidencia:** TPV HEAD: git show HEAD:…/SocketManager.kt:211 (sólo terminalPaymentAckVersion); el VM de HEAD tiene 0 ocurrencias de outcomeEvidence. Servidor árbol: closeRow :1111-1115 (failed/cancelled sin evidencia ⇒ timeout), probeUnresolvedForTerminal :2158-2164 y :535-548 (409 sin crear fila). Android HEAD CardChargeOutcome.kt:111 (409/404 ⇒ reconciliar), :125-133 (NotFound final ⇒ Undetermined) y :193-201 (FAILED ⇒ NotCharged). Regla cobro-remoto §«Reejecución tras actualizar el APK».
- **Arreglo propuesto:** (a) El servidor nuevo no entrega cobros remotos a sockets sin disposición ≥ 2 y sonda ≥ 1: rechaza antes de crear la fila, con code y details.requestId. El encendido del predicado nuevo (ver el hallazgo del despliegue en dos pasos) se condiciona a que el heartbeat reporte la versión del árbol en el 100 % de las terminales activas del venue. (b) Registrar cada rechazo de admisión como una fila FAILED fuera del índice de ranura (failureCode ADMISSION_REJECTED, evidencia NEVER_DELIVERED, en la lista blanca de NOT_CHARGED), para que el GET de las apps publicadas devuelva FAILED → NotCharged y suelte la llave. (c) Rechazar INSTALL_VERSION mientras la terminal tenga filas en vuelo.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 7. [P1] Al instalar el APK del árbol, la libreta que dejó la 2.9.2 en modo SHADOW bloquea la terminal, y no hay forma de regresar a 2.9.2

- **Sección:** F.2 («APK nuevos primero») y C.5 (Room v34)
- **Escenario:** El servidor manda paymentLedgerMode 'SHADOW' por defecto, así que las 2.9.2 en producción escriben libreta y dejan filas abiertas. Casos medidos: un reembolso Blumon con TX_024 quedó AUTORIZANDO→INDETERMINADO, y una venta abortada quedó en PREPARANDO. El árbol reserva la terminal si existe cualquier fila en PREPARANDO…REGISTRO_FALLIDO, de cualquier venue y de cualquier tipo, reembolsos incluidos. El barrido sólo la pone en cuarentena como INDETERMINADO; la recuperación de desconocidos es sólo para AngelPay y exige processorAffiliation en el contexto, que las filas de 2.9.2 pueden no traer; y no hay liberación manual. Resultado: una PAX con un reembolso fallido de julio deja de cobrar todo en cuanto se actualiza. Y no hay retroceso: C.5 sube Room a v34, y la 2.9.2 (v33) truena sin migración destructiva (§0 del diseño). La única salida sería borrar la base (bandeja, libreta y pending_payments, que es dinero) o esperar 3–5 días otra firma.
- **Evidencia:** avoqado-server src/controllers/tpv/terminal.tpv.controller.ts:130 (SHADOW por defecto, igual en HEAD). avoqado-tpv PaymentAttemptDao.kt:69-92 (subconsulta hold sin venue ni kind). HEAD PaymentAttemptLedger (el modo ≠ OFF escribe). LedgerShadowSweepWorker.kt:162-169. LedgerUnknownRecovery.kt:25-37. AvoqadoDatabase.kt:162 (version = 33 hoy). Diseño §0 (downgrade: «la app truena»). Regla cobro-remoto §«Defectos conocidos»: la libreta deja filas que mienten.
- **Arreglo propuesto:** Agregar a F.2: (1) inventario previo por terminal (comando remoto o reporte en el heartbeat de las filas abiertas de libreta, por estado, venue y tipo); no instalar donde haya filas bloqueadoras hasta conciliarlas con evidencia. (2) Una vía de conciliación local auditada para filas heredadas, sin liberar por antigüedad. (3) Antes de desplegar, firmar un APK de retroceso: la 2.9.2 con esquema v34 y una migración sin efecto, para poder regresar sin borrar la base.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 8. [P2] D no tiene pruebas y la tarea por defecto no llega a su código; A.10 no cubre la transición real del día del despliegue

- **Sección:** A.10 y D (plan de pruebas)
- **Escenario:** La tarea testSandboxDebugUnitTest compila con ANGELPAY_SDK_ENABLED=false y FALLBACK=true, así que startCardPayment se va a app-to-app sin autenticar, y SUPPORTED_PROCESSOR=BLUMON se salta el disparador de Home. Una prueba de D.2 o D.6 escrita contra startCardPayment pasaría sin ejecutar el código nuevo; es una prueba que pasa por el motivo equivocado. En A.10 faltan: filas entregadas por 2.9.2 (sin inboxId) con un socket del árbol que ya tiene identidad; el primer arranque del árbol sobre una bandeja 2.9.2 no vacía («ni S ni M ⇒ crear»); dos variantes de la app en el mismo serial (nexgoProd corre como com.jaac.avoqado_tpv.sandbox), donde cada conexión descontinúa la identidad de la otra y ninguna vuelve a ser confiable. En físicas faltan: reconexión automática sin reiniciar la app, respuestas duplicadas desde el aparato, borrado por pm clear o reinstalación (no sólo FACTORY_RESET), y Nexgo con la Activity del SDK en primer plano cuando muere MainActivity.
- **Evidencia:** avoqado-tpv app/build.gradle.kts:43-44 (flags por defecto) y :203-204 (Nexgo: SDK encendido, sin fallback). AngelPayPaymentViewModel.kt:743-751 y :1325-1329. HomeViewModel.kt:1463-1466. nexgo-auth-arranque-sin-red-2026-09-11.md §Pruebas existentes. Diseño A.10 (tabla y lista de pruebas físicas), §D sin plan de pruebas, B.1 (dos variantes que se turnan la identidad).
- **Arreglo propuesto:** Exigir testNexgoDebugUnitTest (variante con el SDK encendido) por avq-verify para D, con pruebas nombradas: auth falla → un solo failed+PRE_AUTHORIZATION y sin «Reintentar»; recuperación de fondo concurrente con la auth del cobro en un venue con varias cuentas → no se lanza con la sesión desalineada; re-etiquetado de VM al navegar. Agregar a A.10 las filas de transición 2.9.2 → árbol y la de dos variantes (definir que la identidad sea por paquete + serial). Agregar las pruebas físicas: cortar la red sin reiniciar, respuestas duplicadas, pm clear o reinstalación, y la N86 con la Activity del SDK en primer plano cuando muere MainActivity.
- **Escéptico:** SIN TERMINAR (revisión detenida)

### B-contrato

Revisé B y el contrato C.1–C.3 contra el código real del árbol (servidor, TPV, Android HEAD 2.18.3, Android v2.18.1-38, iOS 1.10.2 y árbol, desktop). Encontré 6 defectos P1 y 2 P2.

Qué pasa en B: la base TERMINAL_FINAL_ANSWER da por buenas justo las respuestas que el servidor ya rechazó como evidencia, incluida una terminal que contesta «cobré en efectivo». Ahí la revisión del procesador sale limpia con verdad y B liberaría una venta que sí se cobró. Las filas que la terminal deja en PROCESSING responden ACTIVE para siempre, así que B nunca las libera y la única salida (FACTORY_RESET) borra el dinero pendiente de toda la terminal. El modo lote tampoco puede comprobar que su única revisión cubra 375 filas repartidas en 3 terminales, 2 procesadores y varios comercios.

Qué pasa en el contrato: tal como está escrito, el «predicado equivalente» de C.1 saca los cobros en vuelo del candado por orden (permite cobrar la misma cuenta en dos terminales). Poner cancelDisposition en null deja la llave de Android 2.18.3 y del iOS del árbol sin forma de resolverse. C.3 no arregla la llave atorada en la app que la produce (2.18.3 consulta el GET y recibe 404 para siempre). Además hay evidencia de rechazo del banco que hoy queda como UNRESOLVED, y DEVICE_INSPECTED se apoya en un acuse que la TPV manda antes de borrar nada.

Qué significa para ti: el diseño no está listo para programar B ni C.1/C.3 tal cual. Hay que corregir estos 8 puntos en el texto antes de escribir código.

#### 1. [P1] TERMINAL_FINAL_ANSWER acepta precisamente las respuestas que el servidor ya rechazó como evidencia, incluida una que dice «cobré»

- **Sección:** B.1 — base TERMINAL_FINAL_ANSWER (y comprobación de Payment previo)
- **Escenario:** Una tablet manda un cobro remoto de $286 a una Nexgo con la APK del árbol. En la terminal el cajero elige Efectivo, que la pantalla del cobro remoto ofrece (regla cobro-remoto, «Efectivo en un cobro remoto»). La TPV registra un Payment CASH que el servidor delega a la orden (payment.tpv.service.ts:3332-3410) y guarda en su bandeja RESOLVED(success, paymentId=efectivo). El servidor no puede cerrar la solicitud con efectivo, porque closeRowFromPaymentTx sólo acepta CREDIT/DEBIT (terminal-payment.service.ts:1214-1223), así que la fila queda UNKNOWN. La sonda contesta RESOLVED(success) y B lo guarda como lastProbeDisposition=RESOLVED «posterior a la última entrega»: la base queda «verificada por el servidor». La revisión del procesador sale, con verdad, NO_OPERATION, porque el efectivo no pasa por Blumon ni por AngelPay. La búsqueda de «un Payment para ese requestId» se hace «como hoy», con findReconcilablePayment, que sólo mira tarjeta (1531-1538), y los candidatos son sólo «pagos con tarjeta de la orden». Resultado: B libera la fila como FAILED/OPERATOR_RECONCILED_NO_CHARGE ⇒ outcome NOT_CHARGED, la tablet muestra «no se cobró» y el cajero vuelve a cobrarle a un cliente que ya pagó. La misma falla aparece con otras respuestas: (a) RESOLVED(success) con tarjeta cuyo registro está en la cola, o fue rechazado por atribución o importe (closeRowFromPaymentTx 1252-1277); (b) RESOLVED(failed/cancelled) sin evidencia, que la propia TPV considera sustituible por un success posterior (RemotePaymentInbox.kt:179-186); (c) ALREADY_RESOLVED, que el servidor ni siquiera evalúa (2123); (d) NOT_FOUND de otra bandeja, con COUNTER_REGRESSION o con posesión previa, que son justo los motivos por los que A.8 se niega a liberar. B.1 dice que INBOX_SUPERSEDED no basta porque dos variantes de la app comparten serial, pero acepta el NOT_FOUND de la variante que no tiene la solicitud.
- **Evidencia:** Por construcción, toda fila que sigue UNRESOLVED después de una respuesta no-ACTIVE es una cuya respuesta NO fue evidencia. Una respuesta sin evidencia se deja sin cambios y sólo se audita (terminal-payment.service.ts:2246-2277). Un success sin Payment ligable se degrada a timeout (1106-1123). Las respuestas con evidencia acreditada ya cierran solas. La sonda contesta sólo desde la bandeja, sin mirar la libreta (RemotePaymentInbox.kt:145-163). Diseño, líneas 196-213.
- **Arreglo propuesto:** Restringir TERMINAL_FINAL_ANSWER a dos casos: (1) un NOT_FOUND que cumpla las reglas 2-6 de A.8 (misma bandeja continua, lápida, sin posesión), o sea que B nunca acepte más que A; (2) un RESOLVED o ALREADY_RESOLVED con status failed/cancelled y outcomeEvidence acreditada. Cualquier `success` guardado por la terminal bloquea B. También lo bloquea cualquier Payment de CUALQUIER método (efectivo incluido) que lleve el requestId en processorData, que esté registrado en la orden después de createdAt, o que sea del mismo serial con el mismo importe. En esos casos se ofrece conciliar a COMPLETED con ese Payment; hoy eso sólo se hace por SQL. Guardar el resultado completo de la última sonda (status, evidencia, paymentId, inboxId, contador) y validar contra él, no sólo contra la disposición.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No se puede refutar, y el núcleo del hallazgo se sostiene en el código. Con una corrección sobre una premisa.

1. Tal como está escrito en B.1 (líneas 197-199), la base TERMINAL_FINAL_ANSWER acepta «sonda RESOLVED», sin mirar el status. Un RESOLVED(success) la cumple. Y esa base «la verifica el servidor»: el servidor daría por buena una base apoyada en una respuesta en la que la terminal dice que cobró.

2. El argumento «por construcción» es correcto. Las respuestas con evidencia acreditada ya cierran solas: RECEIVED_CANCELLED lleva PRE_AUTHORIZATION, un failed lleva PROCESSOR_DECLINED y un success tiene su Payment ligado. Una fila que sigue UNRESOLVED después de una respuesta que no es ACTIVE es justo una cuya respuesta no fue evidencia, así que la base sólo se aplica a respuestas que el servidor ya rechazó.

3. El caso del efectivo es real. La TPV registra CASH con terminalPaymentRequestId y emite success con paymentId. La bandeja lo contesta como RESOLVED. closeRowFromPaymentTx lo rechaza porque sólo acepta CREDIT/DEBIT, y lo rechaza antes de estampar el requestId, así que el Payment de efectivo nunca queda ligado. Por eso findReconcilablePayment (sólo tarjeta) tampoco lo encuentra, y la regla «si existe un Payment para ese requestId, no hay B» no lo detiene. B no guarda el paymentId que la terminal reportó. El diseño no ofrece ninguna salida a COMPLETED para efectivo, así que B queda como la única manera de liberar la terminal, y la etiqueta sería NOT_CHARGED.

4. Los casos (b), (c) y (d) también se sostienen:
   - (b) persistResult deja que un success posterior sustituya un failed/cancelled. Un failed/cancelled sin evidencia no prueba que el intento terminó.
   - (c) ALREADY_RESOLVED regresa antes de evaluar nada.
   - (d) B acepta el NOT_FOUND de una bandeja distinta, que es el mismo caso de las dos variantes de la app por el que el propio diseño rechaza INBOX_SUPERSEDED.

Corrección: el revisor exagera al decir que los candidatos son «sólo pagos con tarjeta de la orden». El segundo grupo («pagos del mismo serial con el mismo importe en la ventana») no filtra por método. Si se implementa tal cual, el efectivo aparecería como candidato. Pero eso sólo pasa la decisión a un operador que puede descartarlo, cuando la base se presenta como verificada por el servidor.

Otra atenuación: si la solicitud trae orderId y el efectivo liquidó la orden, un segundo cobro con terminal lo frena OrderAlreadyPaidError. Pero el cobro rápido de Android va sin orden (createdOrderId nulo) y ahí no hay freno.

Se queda en P1: el resultado es un NOT_CHARGED por dinero que sí entró, que es lo que la regla prohíbe expresamente («No liberar esa fila como sin dinero: el dinero SÍ entró»).
  - Evidencia: - Diseño, líneas 197-199: TERMINAL_FINAL_ANSWER = «sonda RESOLVED / RECEIVED_CANCELLED / NOT_FOUND, o disposición ACCEPTED / ALREADY_RESOLVED». No restringe el status y sólo guarda disposición, fecha e inboxId.
- Diseño, línea 214: «Si existe un Payment para ese requestId … como hoy».
- Diseño, líneas 215-217: candidatos. El segundo grupo es ambiguo en cuanto al método de pago.
- terminal-payment.service.ts:1098-1123: un failed/cancelled sin evidencia se degrada a timeout; un success sin Payment ligado, también.
- terminal-payment.service.ts:1212-1223: closeRowFromPaymentTx exige CREDIT/DEBIT y regresa antes de estampar terminalPaymentRequestId.
- terminal-payment.service.ts:1531-1541: findReconcilablePayment exige processorData.terminalPaymentRequestId y un método de tarjeta.
- terminal-payment.service.ts:2123: ALREADY_RESOLVED regresa true sin evaluar nada.
- terminal-payment.service.ts:2232-2277: una respuesta sin evidencia deja la fila intacta y sólo se audita.
- payment.tpv.service.ts:2440-2465 y 3883-3905: el processorData del Payment trae deviceSerialNumber, pero no terminalPaymentRequestId.
- payment.tpv.service.ts:2549-2561: el efectivo delegado a la orden llama a closeRowFromPaymentTx, que lo rechaza.
- TPV AngelPayPaymentScreen.kt:610: showCashOption = true.
- AngelPayPaymentViewModel.kt:1872-1922: el efectivo emite status=success con paymentId.
- RemotePaymentInbox.kt:146-148: la sonda contesta RESOLVED con el finalResultJson guardado.
- RemotePaymentInbox.kt:178-191: un success sustituye un failed/cancelled previo.
- terminal-payment.service.ts:574: OrderAlreadyPaidError sólo aplica con orderId.
- Android PaymentFlowViewModel.kt:1131-1136: en el cobro rápido con tarjeta, createdOrderId va nulo.
  - Arreglo corregido: Hacer bien lo que propone el revisor deja a TERMINAL_FINAL_ANSWER casi vacía. Un NOT_FOUND que cumpla las reglas 2-6 de A.8 ya lo libera A. Un failed/cancelled con evidencia acreditada ya se cierra solo. Lo que A rechaza por ACK o por posesión es una contradicción y no debe contar como base. Por eso se propone:

(1) Quitar TERMINAL_FINAL_ANSWER como base, o dejarla sólo como dato complementario de DEVICE_INSPECTED (que exige que alguien revise el aparato). Si se conserva, que excluya por completo:
   - cualquier success;
   - un failed/cancelled sin outcomeEvidence;
   - un ALREADY_RESOLVED cuyo resultado replicado no se haya evaluado;
   - un NOT_FOUND de un inboxId distinto al de todas las entregas, o con COUNTER_REGRESSION o posesión previa.

(2) Guardar el resultado completo de la última respuesta (status, outcomeEvidence, paymentId, inboxId, contador), no sólo la disposición.

(3) Cualquier success guardado por la terminal bloquea B. Lo mismo cualquier Payment COMPLETED, de cualquier método (efectivo incluido), que cumpla una de estas:
   - es el paymentId que reportó la terminal;
   - trae el requestId;
   - está en la orden y fue creado después de createdAt;
   - es del mismo serial, con el mismo importe y dentro de la ventana.
   Si la orden quedó PAID después de createdAt, también se bloquea.

(4) Para esos casos, agregar una conciliación a COMPLETED que acepte CASH (hoy sólo existe por SQL), validando venue, serial acreditado, importe y que el Payment no esté ligado a otra solicitud. Así B deja de ser la única salida.

(5) Que la lista de candidatos diga explícitamente «de cualquier método», con el efectivo señalado aparte.

(6) Por separado, resolver la decisión de producto pendiente: ocultar el efectivo en los cobros remotos, o aceptar CASH como cierre de la solicitud.

#### 2. [P1] La equivalencia escrita («fuera de vuelo y outcome UNRESOLVED») saca las filas EN VUELO del candado por orden y del candado para cancelar una orden

- **Sección:** C.1 — «equivalencia» del predicado de bloqueo
- **Escenario:** Si se implementa el texto literal junto con su prueba de tabla, UNRESOLVED_FINANCIAL_OUTCOME queda igual a SIN_DESENLACE_ACREDITADO. Ejemplo: la tablet A manda la orden O ($500) a la PAX-1; la fila queda SENT y el cliente tiene la tarjeta en la mano. La tablet B, o el dashboard, manda la misma O a la Nexgo-2. El índice parcial único es por terminalId, no por orden. El candado por orden (terminal-payment.service.ts:579-596) ya no ve la fila SENT, se crea la segunda solicitud y dos terminales cobran la misma cuenta. Con el mismo predicado, cancelOrder, el DELETE y la fusión (orderCancelGuard.ts:68 → findChargeBlockingOrderCancel, 1380-1392) dejan cancelar la orden con un cobro vivo, y el cobro cae sobre una orden cancelada. Además getBusyTerminalIds e isTerminalBusy (455-485) anuncian libre una terminal que está cobrando.
- **Evidencia:** Diseño, línea 268. Hoy UNRESOLVED_FINANCIAL_OUTCOME incluye SLOT_HELD (en vuelo) y SIN_DESENLACE_ACREDITADO lo excluye a propósito (terminal-payment.service.ts:217-235). Usos: 459, 480, 537, 583, 641, 1388.
- **Arreglo propuesto:** Definir UNRESOLVED_FINANCIAL_OUTCOME ≡ (outcome = UNRESOLVED), que ya incluye lo que está en vuelo porque desenlaceCanonico devuelve UNRESOLVED para PENDING/SENT/CANCEL_REQUESTED. Definir aparte SIN_DESENLACE_ACREDITADO ≡ (fuera de vuelo ∧ UNRESOLVED). Hacer dos pruebas de tabla, una por predicado, que incluyan las tres filas en vuelo, y una prueba de integración con Postgres real de dos terminales cobrando la misma orden.
- **Escéptico:** CONFIRMADO → severidad P2
  - Razón: No pude refutarlo: el defecto existe. En el diseño, «fuera de vuelo» significa siempre «excluye PENDING/SENT/CANCEL_REQUESTED» (líneas 140, 191 y 229, y el IN_FLIGHT del código). La línea 268 declara UNRESOLVED_FINANCIAL_OUTCOME equivalente a «fuera de vuelo y outcome UNRESOLVED», y además exige una prueba de tabla que falla si los dos divergen. Tomado al pie de la letra, el predicado de bloqueo termina idéntico a SIN_DESENLACE_ACREDITADO. Eso le quita la mitad «en vuelo», que es la que hoy protege la orden. El índice parcial único sólo cubre el terminalId (migración 20260713161534, línea 41), así que nada en la base impide que dos terminales cobren la misma orden. Toda la protección por orden depende de este predicado: la admisión (líneas 579-596), cancelOrder/DELETE/fusión (orderCancelGuard → findChargeBlockingOrderCancel, 1380-1392) y el selector de terminales (455-485). En la misma terminal el índice sigue atrapando el segundo cobro (P2002), pero la búsqueda de respaldo de la línea 641 ya no encontraría quién bloquea: devolvería un TERMINAL_BUSY con requestId 'unknown' y un log de «otra sucursal» engañoso. Bajo la severidad a P2 por dos razones. (1) La frase que sigue en el diseño («En producción no cambia nada: sólo existen TPV_ERROR, TIMED_OUT y CANCELLED sin disposición») deja ver que el autor quería la equivalencia sólo dentro del dominio fuera de vuelo; es texto ambiguo, no una decisión. (2) Las pruebas de integración contra Postgres atraparían parte de la regresión: 'cancelOrder waits for an in-progress admission…' bloquea con una fila PENDING y fallaría, y lo mismo varias aserciones isTerminalBusy con filas vivas. Lo que nadie cubre es el caso más caro: dos terminales admitiendo la misma orden. Por eso sigue siendo un defecto de dinero que hay que corregir en el texto antes de implementar.
  - Evidencia: diseno-A-B-seccion8-2026-09-11.md:268-270 (equivalencia más prueba de tabla); :140, :191, :229 (uso de «fuera de vuelo» = excluir filas vivas). terminal-payment.service.ts:175-186 (SLOT_HELD incluye PENDING/SENT/CANCEL_REQUESTED/UNKNOWN; IN_FLIGHT = PENDING/SENT/CANCEL_REQUESTED); :217-223 (UNRESOLVED_FINANCIAL_OUTCOME incluye ...SLOT_HELD); :226-235 (SIN_DESENLACE_ACREDITADO = lo mismo menos lo vivo, según su propio comentario). Usos del predicado de bloqueo: :459 isTerminalBusy, :480 getBusyTerminalIds, :537 bloqueo por terminal, :583 bloqueo por ORDEN (no hay índice por orden detrás), :641 respaldo tras P2002, :1388 findChargeBlockingOrderCancel. En shared/orderCancelGuard.ts:63, findLiveTerminalCharge/assertNoLiveTerminalCharge delegan a ese mismo predicado. Índice: prisma/migrations/20260713161534_add_terminal_payment_request/migration.sql:41, UNIQUE("terminalId") WHERE status IN (PENDING,SENT,CANCEL_REQUESTED,UNKNOWN), sólo por terminal. En el diseño, desenlaceCanonico devuelve UNRESOLVED para «todo lo demás» (C.1), lo que incluye las filas vivas. Red parcial: tests/integration/payments/terminalPaymentRecovery.integration.test.ts:1336 (cancelOrder con fila PENDING espera 409) y aserciones isTerminalBusy (:592, :756…). No encontré ninguna prueba de dos terminales sobre la misma orden.
  - Arreglo corregido: Cambiar el texto de C.1. UNRESOLVED_FINANCIAL_OUTCOME ≡ (desenlaceCanonico(row).outcome = UNRESOLVED), sin restricción de vuelo: incluye PENDING/SENT/CANCEL_REQUESTED/UNKNOWN y los históricos, y debe seguir conteniendo todos los estados del índice parcial único (SLOT_HELD), para que la búsqueda de respaldo tras P2002 (línea 641) encuentre al que bloquea. SIN_DESENLACE_ACREDITADO ≡ (status ∉ IN_FLIGHT) ∧ UNRESOLVED; es la base de la sonda, de A.8 y de B, y no se usa para bloquear. Pruebas: dos pruebas de tabla, una por predicado, que recorran todos los estados (incluidas las tres filas vivas y UNKNOWN) contra desenlaceCanonico y fallen si divergen. Además, una prueba de integración contra Postgres real: fila SENT de la orden O en la terminal 1 y admisión de O en la terminal 2 ⇒ 409 TERMINAL_BUSY con el requestId del bloqueador, y cero filas creadas. Y cancelOrder/DELETE/fusión de O con una fila SENT ⇒ 409 ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE. Corregir también la frase «En producción no cambia nada» para que diga que sólo aplica a las filas fuera de vuelo.

#### 3. [P1] Poner cancelDisposition en null cuando el desenlace es final deja sin resolución la llave de Android 2.18.3 y del iOS del árbol

- **Sección:** C.1 — proyección de cancelDisposition / compatibilidad con apps
- **Escenario:** El cajero manda $120 a la PAX y cancela antes de que la terminal lo reclame. La TPV del árbol contesta ACCEPTED y la fila queda CANCELLED con cancelDisposition=ACCEPTED (terminal-payment.service.ts:2130-2135; o closeRow con PRE_AUTHORIZATION, 1137). Con C.1, el outcome es NOT_CHARGED y el GET devuelve cancelDisposition=null. Android 2.18.3 (versionCode 40, HEAD 46c5cdc, APK firmado en iCloud) no lee `outcome` y sólo trata CANCELLED como NotCharged si cancelDisposition == "ACCEPTED" (CardChargeOutcome.kt:198 en HEAD). Con null lo trata como Undetermined. La fila ya es final y no va a cambiar, así que la llave durable nunca se suelta, y TerminalPaymentService (HEAD:221) devuelve Undetermined a todo cobro con tarjeta nuevo en esa tablet. Según G6, la llave sobrevive al logout. El iOS del árbol hace lo mismo (CardChargeOutcome.swift:313). F.2 dice que las apps POS «sin outcome conservan su lógica», y para esta build eso es falso.
- **Evidencia:** Diseño, línea 266. avoqado-android HEAD: CardChargeOutcome.kt:198 y TerminalPaymentService.kt:221. avoqado-ios del árbol: CardChargeOutcome.swift:311-316. Servidor: 1137 y 2130-2135 escriben ACCEPTED en filas NOT_CHARGED.
- **Arreglo propuesto:** Poner en null sólo una disposición distinta de ACCEPTED (ACTIVE) cuando outcome ≠ UNRESOLVED, y devolver siempre 'ACCEPTED' en las filas CANCELLED con NOT_CHARGED. Agregar una prueba de contrato que corra la función de decisión de cada cliente publicado o firmado (Android v2.18.1-38 y 2.18.3-40, iOS 1.10.2 y árbol, desktop PaymentFlow.recoverViaStatus) contra una tabla de filas del servidor. La prueba debe exigir que ninguna fila final quede Undetermined y que ninguna fila UNRESOLVED quede como NotCharged.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 4. [P1] C.3 no cierra el P1-3 para la app que lo produce, deja 422/403 sin código, y su 404 no prueba «no se creó» si se decide fuera del candado

- **Sección:** C.3 — códigos antes de crear la fila (y reordenamiento)
- **Escenario:** (a) Android 2.18.3 (HEAD) reconcilia CUALQUIER 400/404/409/422 del POST consultando el GET (CardChargeOutcome.kt:111 en HEAD) y no lee `code` ni `details.requestId`. Caso diario: la PAX está en Doze, el POST devuelve 404 TERMINAL_NOT_CONNECTED, el GET devuelve 404 porque no hay fila, y en el último intento queda Undetermined (HEAD:131-136). La llave queda armada para siempre y la tablet deja de poder cobrar con tarjeta (HEAD:221). Con el servidor nuevo pasa exactamente lo mismo, y B no puede ayudar porque no hay fila que conciliar. Lo mismo ocurre con 400 ORDER_CANCELLED_NO_NEW_CHARGE, con 409 TERMINAL_BUSY, con el 422 «sin socket» (controlador 172-177, sin código, que C.3 ni menciona) y con el 403 «otro establecimiento» (controlador 86-91), que se decide por el registro ANTES de buscar la fila: si la terminal se movió de sucursal con una fila UNKNOWN, el reintento recibe 403 en vez de la réplica. (b) Si «buscar la fila antes del registro» se hace fuera de la transacción, como sugiere el texto, un POST duplicado del mismo requestId puede ver «sin fila» y «desconectada» mientras el primero, que vio la terminal conectada, todavía no confirma. El duplicado puede venir del reintento silencioso de OkHttp sobre una conexión reciclada, que es el riesgo S1 de la regla. El segundo contesta un 404 que «prueba que no se creó» y el primero crea y entrega la solicitud.
- **Evidencia:** Diseño, líneas 282-286, y G7 (línea 426). terminal-payment.service.ts:496-507: el registro se consulta antes de la transacción. La transacción y su candado van en 528-599. Controlador: 86-91, 164-184. Android HEAD: CardChargeOutcome.kt:111, 131; TerminalPaymentService.kt:221.
- **Arreglo propuesto:** Rechazar de forma DURABLE en vez de sólo agregar un código. Dentro de la misma transacción de admisión, con el advisory lock sobre normalizeTerminalId(request.terminalId) (no hace falta el registro), buscar primero la fila existente y replicarla con validateReplayContract. Si no existe y la terminal está desconectada, sin socket, ocupada por otra solicitud, o la orden está cancelada o pagada, INSERTAR la fila de ese requestId como FAILED, con failureCode `NOT_DISPATCHED_<motivo>`, deliveryProvenance [] y evidencia NEVER_DELIVERED (NOT_CHARGED, clase SERVER), y responder con su réplica. Así el GET devuelve FAILED y todas las builds (2.18.1, 2.18.3, iOS 1.10.2, desktop) leen «no se cobró», y un POST posterior con el mismo requestId repite el rechazo en vez de crear y entregar. Mover el 403 del controlador después de la búsqueda de la fila.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 5. [P1] Una solicitud que la terminal deja en PROCESSING contesta ACTIVE para siempre y B la rechaza: terminal y orden bloqueadas, y la única salida borra el dinero pendiente de toda la terminal

- **Sección:** A.2 ↔ B.3 — filas PROCESSING sin salida
- **Escenario:** A.2 dice que si falla el espejo al reclamar, «la fila queda PROCESSING y contesta ACTIVE (conciliación B)». Pero B.3 rechaza cuando la última sonda es ACTIVE, y DEVICE_INSPECTED exige que la bandeja o la libreta muestren el intento cerrado; en ese caso la bandeja dice PROCESSING y la libreta no tiene fila. Lo mismo pasa con el defecto ya conocido de la regla: el proceso muere entre markProcessingForVenue y openAttempt, o después de que el SDK termina y antes de persistResult (SocketManager.kt:2033-2039, el único camino que resuelve la bandeja). answerFor(PROCESSING) siempre devuelve ACTIVE (RemotePaymentInbox.kt:149) y ninguna recuperación resuelve la bandeja desde la libreta (LedgerUnknownRecovery no la toca). El servidor bloquea la terminal (admisión por terminalId, terminal-payment.service.ts:537) y la orden (583, 1388) sin fecha de salida. La única base que queda es DEVICE_DECOMMISSIONED, o sea FACTORY_RESET, que borra pending_payments, pending_refunds y la libreta de TODA la terminal (CommandExecutor.kt:1059-1075). Con eso se pierden cobros aprobados de otras ventas que esperaban registrarse.
- **Evidencia:** Diseño, línea 61 (A.2) contra línea 230 (B.3) y línea 203 (DEVICE_INSPECTED). RemotePaymentInbox.kt:145-163. Regla cobro-remoto-pos-a-tpv.md, «Defectos conocidos» (PROCESSING sin intento correlacionado).
- **Arreglo propuesto:** Que la TPV pueda contestar con evidencia en vez de ACTIVE. Marcar execution_started_at (la columna que ya agrega C.5) con un CAS en Room ANTES de abrir la libreta y el SDK, también para tarjeta. En la sonda: si la fila está PROCESSING y execution_started_at IS NULL, hacer CAS a RESOLVED(failed, PRE_AUTHORIZATION) y contestar eso. Si la libreta tiene el intento correlacionado en DESCARTADA, CERRADA o REGISTRADO, contestar desde la libreta. Sólo en otro caso contestar ACTIVE. En B, sustituir la declaración libre de DEVICE_INSPECTED por un volcado estructurado que envíe la TPV (bandeja y libreta de ese requestId). Nunca usar FACTORY_RESET como salida documentada.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 6. [P1] El modo lote da por revisadas 375 filas con una sola revisión que el servidor no puede comprobar que las cubra

- **Sección:** B.3 — modo lote para las 375 filas históricas
- **Escenario:** La revisión del lote tiene UN proveedor, UNA ventana, UN identificador (posId o serial) y UN importe. Las 375 filas son de 3 terminales (PAX Testarudo 305, Nexgo Testarudo 53, Nexgo Amaena 12), de dos procesadores y de meses distintos. Una PAX con varios comercios cobra con un serial virtual distinto por comercio (avoqado-tpv/docs/PAYMENT_RECONCILIATION.md:46-59), y la fila no guarda con qué comercio se cobró (schema.prisma:5036-5087 no tiene columna de comercio). Una Nexgo puede quedar autenticada en otra cuenta AngelPay del venue (AngelPayAuthRepository.kt:134-146; la sección D menciona el fallback a la primaria). Un operador sube el exporte del serial físico de la PAX para julio–agosto y marca NO_OPERATION. Quedan «revisados» y se liberan como NOT_CHARGED los cobros hechos con el serial virtual del segundo comercio, las filas de las Nexgo y las filas fuera de la ventana. Para las históricas, LEGACY_NO_RESUME casi siempre se cumple (procedencia null y la app se reinició miles de veces), así que la revisión del procesador es la ÚNICA protección real de esas 375 filas.
- **Evidencia:** Diseño, líneas 193-194 y 232-233. En schema.prisma, TerminalPaymentRequest no tiene comercio y Terminal.assignedMerchantIds es el valor actual, no el de la fecha. PAYMENT_RECONCILIATION.md:46-59 (seriales virtuales).
- **Arreglo propuesto:** Agrupar el lote por (terminal, procesador, conjunto de comercios o afiliaciones asignados en esa fecha). El servidor rechaza toda fila de otro procesador o fuera de la ventana declarada, con un margen de al menos 3 h para registros tardíos. El exporte se sube como datos estructurados (CSV) y el servidor cruza cada fila por importe total y hora (con margen) contra las operaciones del exporte. Cualquier coincidencia exige una decisión explícita por fila. La revisión debe enumerar todos los posId o seriales virtuales (los MerchantAccount de la terminal en esa fecha) o todas las cuentas AngelPay del venue, y el servidor lo valida.
- **Escéptico:** SIN TERMINAR (revisión detenida)

#### 7. [P2] Hay evidencia acreditada que hoy queda UNRESOLVED, y la evidencia no vive en una columna escrita por el servidor

- **Sección:** C.1 — lista blanca y lista de escritores de failureCode/status
- **Escenario:** (a) En un cobro remoto el emisor rechaza la tarjeta (código 51, rechazo definitivo). El error permite reintentar con otra tarjeta y el cajero toca Atrás o Cancelar. La TPV del árbol emite cancelled con outcomeEvidence PROCESSOR_DECLINED (PaymentViewModel sandbox:6836 y 6876; production:6048 y 6088). closeRow degrada todo cancelled que no traiga PRE_AUTHORIZATION (terminal-payment.service.ts:1098-1102) y la fila queda UNKNOWN. La bandeja guarda RESOLVED(cancelled, PROCESSOR_DECLINED); cada sonda la toma como acreditada (2249), closeRow la vuelve a degradar y se espera 15 min. Resultado: un rechazo rutinario reserva la terminal y sólo B la libera. (b) handleCancelDispositionFromSocket ignora un ACCEPTED si la fila no está en SLOT_HELD (2123), así que una fila TIMED_OUT, CANCELLED sin disposición o FAILED/TPV_ERROR con un ACCEPTED legítimo sigue UNRESOLVED. (c) La evidencia de TPV_CONFIRMED_NO_CHARGE sólo existe dentro de resultJson, que es el payload crudo de la terminal (1040-1068 lo pasa tal cual y 1133-1137 lo guarda). El camino «Socket.IO no inicializado» (681-688) escribe el mismo código con evidencia del SERVIDOR, así que evidenceClass saldría TERMINAL. (d) Lista de escritores del árbol para la enumeración que exige C.1: create PENDING (599); UNKNOWN ACK_TIMEOUT/ACK_REJECTED (798-803); UNKNOWN SOCKET_NOT_FOUND/DELIVERY_NOT_RECORDED (934-945); SENT (907, 922, 1000-1010); closeRow → FAILED TPV_CONFIRMED_NO_CHARGE, CANCELLED+ACCEPTED o UNKNOWN con código null (1133-1160); COMPLETED (con o sin CONTRACT_MISMATCH) en 1113, 1304, 1454, 1650, 1727, 1801; UNKNOWN TIMED_OUT (1505); CANCEL_REQUESTED (2086); disposición (2130-2135); FAILED TPV_NEVER_RECEIVED (2368-2375). Fuera del servicio, scripts/temp-qa-slot.ts:38 escribe FAILED QA_MANUAL_RESOLVE_NO_MONEY (base local de QA; con la lista blanca vuelve a bloquear las terminales de QA). En producción (HEAD) existen además TPV_ERROR, CANCELLED/'CANCELLED', AUTO_RELEASED y MANUAL_RELEASE, todos UNRESOLVED.
- **Evidencia:** terminal-payment.service.ts:1098-1102, 1133-1137, 2123, 2246-2305. PaymentViewModel.kt (sandbox 6836/6876, production 6048/6088). SocketManager.kt:2014 reenvía PROCESSOR_DECLINED también en cancelled.
- **Arreglo propuesto:** closeRow debe aceptar cancelled + PROCESSOR_DECLINED como NOT_CHARGED (FAILED TPV_CONFIRMED_NO_CHARGE). La disposición ACCEPTED debe aplicarse a cualquier fila SIN_DESENLACE_ACREDITADO. Agregar columnas `outcomeEvidence` y `evidenceClass` que escribe el servidor en cada uno de los escritores listados, con una migración que las deduzca para las filas existentes. desenlaceCanonico debe leer sólo esas columnas, nunca resultJson. Clasificar QA_MANUAL_RESOLVE_NO_MONEY de forma explícita o limpiar esas filas locales.
- **Escéptico:** no aplica (P3 sin verificar)

#### 8. [P2] DEVICE_DECOMMISSIONED se apoya en un acuse que la TPV manda ANTES de borrar nada

- **Sección:** B.1 — base DEVICE_DECOMMISSIONED
- **Escenario:** executeFactoryReset manda «Factory reset completed» antes de clearAll (CommandExecutor.kt:1055) y el servidor pone el comando en COMPLETED (tpv-health.service.ts:723-731). Si clearAll lanza una excepción, el catch devuelve failed sin matar el proceso (1093-1095): la app sigue viva, con su bandeja y con el cobro remoto que tenía en el SDK. El acuse FAILED posterior puede no llegar (sin red) o llegar después de que el operador ya ejecutó B con la base «verificada». Además, los fallos de deleteDatabase se ignoran con un comentario falso («will be cleared on app restart», 1070-1075): nada los borra al reiniciar, así que la base de Avoqado puede sobrevivir con una aprobación en la libreta que la recuperación registrará después, cuando el POS ya recibió NOT_CHARGED. Aparte, las APK 2.8.7 y 2.9.2 nunca acusan FACTORY_RESET (CommandExecutor.kt:421-426: 65 comandos en SENT), así que esta base no existe para las filas históricas y hay que declararlo.
- **Evidencia:** CommandExecutor.kt:1055, 1059, 1070-1075, 1093-1095. tpv-health.service.ts:715-731. Diseño, líneas 201-202.
- **Arreglo propuesto:** Verificar la base contra el primer handshake POSTERIOR al comando que traiga una identidad de bandeja nueva (A.3 «M sin S ⇒ Rotar» y A.5 SUPERSEDED por esa rotación) más un reporte explícito de borrado terminado, no contra el status de tpvCommandQueue. En la TPV, separar el acuse en dos: RECEIVED antes de borrar y WIPED después de borrar y verificar que la base ya no existe.
- **Escéptico:** no aplica (P3 sin verificar)

### N3-apps

Revisé C.5 (N3 en la TPV) y C.4 (cancelación durable en Android e iOS) contra el código del árbol de trabajo. El diseño supone dos cosas que el código no cumple: que la TPV sólo dice «no se cobró» cuando ya no puede cobrar esa solicitud, y que el servidor recuerda cada «no». Encontré cuatro P1. (1) AngelPay reporta «rechazado» (failed+PROCESSOR_DECLINED, o cancelled+PRE_AUTHORIZATION por el reloj de abandono) y aun así deja «Reintentar» sobre el MISMO requestId. La cerca de C.5 sólo mira lápida o cancel aceptado. Con C.4, la tablet ya borró la orden y cobró en efectivo, y el cliente reintenta en la Nexgo: cobro doble. (2) En la PAX, la evidencia es una variable de la pantalla, no del intento. Un PROCESSOR_DECLINED de un intento anterior se manda como prueba aunque el último intento contactless quedó incierto: el servidor certifica «no se cobró» (NOT_CHARGED) sobre dinero que pudo moverse. (3) Si la PAX rechaza la tarjeta y el cajero de la TPV sale, se emite cancelled+PROCESSOR_DECLINED. El servidor sólo acepta esa evidencia con failed, así que lo degrada a UNKNOWN: la terminal y la tablet quedan bloqueadas para siempre (sólo B manual). Es el flujo diario «declinó, págame en efectivo». (4) «No se creó» no queda escrito en ningún lado: el cancel que llega antes que la fila (G7) y el 404 de C.3 los desmiente un POST tardío o duplicado del mismo requestId (reintento de OkHttp). El registro de la terminal se consulta antes del candado. Tres P2: con un usuario sin acceso a la sucursal original, la llave y la intención quedan irresolubles y la tablet no puede volver a cobrar con tarjeta; cancelar mientras se crea la orden todavía manda el cobro, y si se pierde la respuesta nace otra orden huérfana; el texto sin red «la cancelación se enviará sola» miente cuando la terminal tiene LTE. Un P3: N3 acepta el cancel con la tarjeta chip dentro y el PIN en pantalla.

En corto: el diseño va bien encaminado, pero antes de programar faltan tres reglas: (a) una solicitud ya reportada no admite otro intento, (b) la evidencia se calcula por solicitud desde la libreta y no desde la pantalla, y (c) cada «no» del servidor se guarda como una fila. No necesito nada de ti ahora; revertir G7 (poner una lápida en el servidor) es decisión tuya cuando revises el diseño.

#### 1. [P1] AngelPay reporta «no se cobró» y deja reintentar el MISMO cobro remoto en la terminal

- **Sección:** C.5 (cerca durable) + C.1/C.4
- **Escenario:** La tablet manda el cobro R de $300 a la Nexgo. El banco rechaza (G500/E605 o código vacío): AngelPayPaymentViewModel pone Error(canRetry=true) y además emite `failed`+PROCESSOR_DECLINED; la bandeja queda RESOLVED(failed) y el servidor cierra FAILED/TPV_CONFIRMED_NO_CHARGE, que C.1 declara NOT_CHARGED. La tablet muestra «no se cobró»: con C.4, «Cancelar la venta» borra la orden, o el cajero cobra en efectivo. La Nexgo sigue en la pantalla de rechazo con «Reintentar»; el cliente reintenta con otra tarjeta. retryAfterError limpia currentPaymentAttemptId pero conserva _socketRequestId, y openAttempt pasa (la cerca de C.5 sólo mira lápida o cancel aceptado). La tarjeta se aprueba y el Payment se registra con terminalPaymentRequestId=R. El servidor reconcilia FAILED→COMPLETED con 🚨 sobre una orden ya cancelada o pagada en efectivo: cobro doble. Mismo camino con el reloj de abandono de los avisos E6xx: emite `cancelled`+PRE_AUTHORIZATION (el servidor lo guarda como CANCELLED+ACCEPTED) sin quitar el botón Reintentar.
- **Evidencia:** avoqado-tpv AngelPayPaymentViewModel.kt:2135 (evidencia), 2170-2194 (Error canRetry=true + emit failed), 1926-1939 (igual en app-to-app), 3307-3323 (retryAfterError sólo bloquea sin negativa confirmada y conserva _socketRequestId), 3337-3344 (el propio comentario: «decline emits failed → cashier retries ON THE TERMINAL → card APPROVED»), 2372-2392 (el abandono emite cancelled); RemotePaymentInbox.kt:174-187 (un success pisa failed/cancelled); SocketManager.kt:2033-2039; avoqado-server terminal-payment.service.ts:1136-1137 (cancelled+evidencia ⇒ ACCEPTED), 1339-1350 (reconcilia a COMPLETED «despite cancel/close»); diseño líneas 260 y 320.
- **Arreglo propuesto:** (1) En la TPV, una solicitud cuya fila de bandeja está RESOLVED con cualquier negativa no admite otro intento: la cerca de reserveTerminal (y markAuthorizing en el camino alreadyOpened de AngelPay) debe incluir RESOLVED, no sólo lápida/cancel aceptado. (2) AngelPay debe portarse como Blumon: retener la negativa mientras la pantalla ofrezca Reintentar y emitirla sólo al salir (resetPayment/onCleared). Una vez emitida, Reintentar desaparece para ese requestId, y el reloj de abandono deshabilita el reintento al emitir. (3) En el servidor, NOT_CHARGED de C.1 exige que la TPV declare la solicitud cerrada (disposición v2 con `requestClosed:true`), y la vigilancia tardía de 72 h debe cubrir TPV_CONFIRMED_NO_CHARGE y CANCELLED+ACCEPTED. Prueba: rechazo → Reintentar sobre el mismo requestId ⇒ openAttempt rechazado.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No lo pude refutar: el código confirma cada paso. En AngelPay, un rechazo del banco pone la pantalla en Error con «Reintentar» y, en el mismo momento, le avisa al servidor «failed» con PROCESSOR_DECLINED. El servidor lo guarda como FAILED/TPV_CONFIRMED_NO_CHARGE, que es justo lo que C.1 llama NOT_CHARGED. La tablet ya lo lee hoy como «No se cobró la tarjeta», suelta la llave y deja cobrar de otra forma. Pero en la terminal, «Reintentar» sigue funcionando sobre la MISMA solicitud R: se permite porque la negativa ya consta, conserva el requestId, abre un intento nuevo en la libreta (reserveTerminal no mira la bandeja, y la cerca de C.5 sólo cubre lápida o cancel aceptado) y registra el Payment ligado a R. El servidor lo pasa de FAILED a COMPLETED y lanza 🚨: eso detecta el problema, no lo evita. Si mientras tanto la tablet cobró en efectivo o canceló la orden (C.4), el cliente paga dos veces.

El reloj de abandono de los avisos E6xx (sólo existe en el árbol de trabajo, no en HEAD) tiene el mismo hueco: a los 120 s manda «cancelled» + PRE_AUTHORIZATION, el servidor lo guarda como CANCELLED/ACCEPTED = NOT_CHARGED, y la pantalla sigue en Error con Reintentar activo.

Blumon no tiene este problema: mientras la pantalla ofrece reintentar, retiene el resultado («Retryable error reached, keeping Android request pending»).

Dos precisiones al revisor:
- El camino del rechazo no lo crea el diseño: ya está en HEAD y en producción (HEAD:2047-2048), y el propio comentario de retryAfterError lo describe como intencional. El diseño lo hereda. El problema es que lo vuelve decisivo, porque C.1 declara ese NOT_CHARGED como definitivo y C.4 cancela la orden a partir de él.
- La parte (3) de su arreglo es en parte redundante: closeRowFromPaymentTx ya lanza 🚨 cuando llega un Payment ligado a una fila FAILED, CANCELLED o CANCEL_REQUESTED. Lo que falta es PREVENIRLO, no detectarlo.

Se queda en P1 porque es un cobro doble. La acción humana que hace falta es tocar «Reintentar» en la terminal, que es la experiencia prevista, así que el escenario es realista.
  - Evidencia: TPV, AngelPayPaymentViewModel.kt (árbol de trabajo):
- :2148-2149 — confirmedNegativeOutcome=true; la evidencia es PROCESSOR_DECLINED con G500/G504/E605/E606 o con código vacío.
- :2170-2173 — Error(canRetry=true).
- :2195-2198 — emite «failed» + la evidencia.
- :1925-1941 — lo mismo en app-to-app.
- :3321-3343 — retryAfterError sólo bloquea si NO hay negativa confirmada; pone currentPaymentAttemptId=null y no toca _socketRequestId ni _socketResultEmitted.
- :3353-3359 — el comentario lo documenta: «decline emits failed → cashier retries ON THE TERMINAL → card APPROVED».
- :705-736 — openLedgerAttemptAndMarkAuthorizing arma el contexto con terminalPaymentRequestId=_socketRequestId.
- :2387-2407 — el reloj de abandono (MS_ABANDONO_AVISO_EMV=120000, :3589) emite «cancelled» con confirmedNegativeEvidence (PRE_AUTHORIZATION para los E6xx de :2427) y no cambia el Error ni canRetry.

TPV, libreta y bandeja:
- PaymentAttemptDao.kt:70-92 — reserveTerminal sólo mira payment_attempts; no mira remote_payment_requests ni el requestId.
- RemotePaymentInbox.persistResult (:175-190) — persiste la negativa.
- SocketManager.kt:2033-2039 — persiste antes de emitir.

Blumon, sandbox PaymentViewModel.kt:1463-1467 — con canRetry retiene el resultado y no emite «failed».

Servidor, terminal-payment.service.ts:
- :1097-1101 y :1136-1141 — failed+PROCESSOR_DECLINED ⇒ FAILED/TPV_CONFIRMED_NO_CHARGE; cancelled+PRE_AUTHORIZATION ⇒ CANCELLED + cancelDisposition ACCEPTED.
- :1204-1348 — closeRowFromPaymentTx pasa cualquier fila no COMPLETED a COMPLETED y lanza 🚨 si venía FAILED o CANCELLED.
- payment.tpv.service.ts:3325-3331 — el dinero se registra sobre la orden de la solicitud aunque se haya cancelado.

Android POS, CardChargeOutcome.kt:260-261 — FAILED y CANCELLED+ACCEPTED ⇒ NotCharged («No se cobró la tarjeta»).

Diseño: C.1 (FAILED de la lista blanca o CANCELLED+ACCEPTED ⇒ NOT_CHARGED); C.4 (NOT_CHARGED ⇒ cancelar la orden); C.5 (la cerca sólo cubre lápida o cancel aceptado). Ningún apartado trata «Reintentar» sobre el mismo requestId.

HEAD: el «failed» del rechazo ya existía (HEAD:2047-2048), junto con retryAfterError (:2962). programarCierreDeCobroAbandonado no existe en HEAD.
  - Arreglo corregido: 1) TPV (el arreglo que importa), para AngelPay, igual que en Blumon. En un cobro que viene del POS por socket, mientras la pantalla ofrezca «Reintentar», NO se emite la negativa. Se emite al salir (resetPayment/onCleared → emitCancelledIfAbandoned con la evidencia) o cuando el reloj de abandono vence. En cuanto se emite cualquier negativa, ese requestId deja de aceptar reintentos: canRetry=false, o un estado terminal «El cobro se cerró en el POS; que lo reenvíe la tablet», y retryAfterError se niega si _socketResultEmitted es true. El reloj de abandono hace eso mismo en el mismo paso.

2) Cerca durable a nivel de solicitud, que es lo que protege de verdad. En openLedgerAttemptAndMarkAuthorizing, con _socketRequestId presente, se lee la fila de la bandeja y se rechaza el intento si está RESOLVED (con cualquier resultado), si tiene lápida o si tiene cancel_accepted_at. Así se cubren también la muerte del proceso y la VM recreada, que la bandera en RAM no cubre. Si C.5 quiere meterla en reserveTerminal, necesita el requestId en la fila de la libreta o un join con remote_payment_requests; hoy la sentencia no lo tiene.

3) Servidor, opcional como defensa en profundidad: C.1 sólo da NOT_CHARGED si la TPV declaró la solicitud cerrada para nuevos intentos (resultado v2 con requestClosed:true). Sin esa marca, FAILED o CANCELLED de un APK que no la manda ⇒ UNRESOLVED. OJO: sin transición, esto afectaría a las apps POS publicadas, que hoy ya leen FAILED como «no se cobró». La vigilancia de 72 h no hace falta para los pagos ligados a R, porque closeRowFromPaymentTx ya lanza 🚨.

Pruebas:
- Rechazo G500 en un cobro por socket ⇒ no se emite nada mientras la pantalla está en Error; «Reintentar» abre un intento nuevo sobre R. Al salir se emite «failed» o «cancelled», y después un intento sobre R se rechaza.
- Reloj E6xx vencido ⇒ se emite «cancelled» y retryAfterError ya no abre intento.
- VM recreada con la bandeja RESOLVED(failed) para R ⇒ el intento se rechaza.
- Sabotaje en una copia aislada: quitar la cerca hace fallar las tres pruebas.

#### 2. [P1] En la PAX la evidencia de negativa es de la pantalla, no del intento: un rechazo viejo certifica un intento incierto

- **Sección:** C.1 (lista blanca) + C.5
- **Escenario:** Cobro remoto R en la PAX. Intento 1 con chip: el banco declina (51), así que negativeOutcomeEvidence=PROCESSOR_DECLINED, la fila A1 queda DESCARTADA y el error es reintentable (no se emite). Reintentar lanza el intento 2 contactless: markKernelEntered (KERNEL_ACTIVO), y el kernel devuelve un fallo no clasificado o «Resultado desconocido». A2 queda INDETERMINADO o KERNEL_ACTIVO y retiene la terminal, pero negativeOutcomeEvidence no se toca; el error sigue siendo reintentable. Reintentar de nuevo: openAttempt(A3) se rechaza por la retención y sale Error canRetry=false. observeSocketPaymentResult emite entonces `failed` con outcomeEvidence=PROCESSOR_DECLINED, que es de A1. El servidor lo guarda como FAILED/TPV_CONFIRMED_NO_CHARGE, que C.1 declara NOT_CHARGED. La tablet suelta la llave, C.4 borra la orden y el cajero vuelve a cobrar, aunque A2 pudo aprobar offline (para eso existe KERNEL_ACTIVO). La fila ya no entra a la sonda porque no está en SIN_DESENLACE_ACREDITADO, y Blumon no tiene recuperación de INDETERMINADO: nadie lo detecta.
- **Evidencia:** sandbox PaymentViewModel.kt:5031 y 5130 (se fija), 4723 (sólo se limpia al autorizar online), 5540-5590 (contactless: markIndeterminate sin limpiar la evidencia; Error con canRetry por default), 5692-5698 (resultado desconocido: la fila queda KERNEL_ACTIVO), 7105-7190 (retryPayment no la limpia), 3351-3370 (openAttempt falla ⇒ canRetry=false), 1463-1479 (emite failed con negativeOutcomeEvidence); production idéntico (4246, 4345, 4801; resetPayment 6075 igual al de sandbox); PaymentAttemptDao.kt:71-87 (retención de la terminal); avoqado-server terminal-payment.service.ts:1097-1101 y 1136.
- **Arreglo propuesto:** La evidencia se calcula por SOLICITUD desde la libreta en el único punto de salida, SocketManager.emitTerminalPaymentResult. PRE_AUTHORIZATION/PROCESSOR_DECLINED sólo se adjuntan si TODOS los intentos correlacionados por terminalPaymentRequestId están DESCARTADA con negativa explícita (host_approved=0, rechazo de kernel o descarte pre-SDK) y ninguno está en KERNEL_ACTIVO..REGISTRO_FALLIDO/INDETERMINADO. Si no, el resultado sale sin evidencia (UNRESOLVED). Además, limpiar negativeOutcomeEvidence en startPayment y retryPayment (las dos variantes, mismos hunks) y guardar la evidencia de AngelPay por intento. Prueba: rechazo + contactless incierto + reintento bloqueado ⇒ el failed sale sin evidencia y la fila queda UNRESOLVED.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No lo pude refutar: la cadena completa existe en el árbol de trabajo actual, en las dos variantes de la PAX, y el diseño (C.1) toma esa evidencia como prueba de que no se cobró sin comprobar a qué intento pertenece.

1) Primer intento con chip y rechazo 51: se fija negativeOutcomeEvidence="PROCESSOR_DECLINED" y el intento pasa a DESCARTADA. El error sale con canRetry=true (valor por defecto de PaymentState.Error), así que el observador no emite nada.

2) Segundo intento: retryPayment borra el paymentAttemptId, pero no borra negativeOutcomeEvidence; startPayment tampoco. Por contactless, markKernelEntered deja la fila en KERNEL_ACTIVO. Si el kernel devuelve TIMEOUT u OTHER (que a propósito no están en KERNEL_REFUSALS_WITHOUT_CHARGE, porque «pueden esconder una transacción que sí avanzó»), la fila pasa a INDETERMINADO. Si devuelve «Resultado desconocido» o transResult nulo, se queda en KERNEL_ACTIVO. En los dos casos: no se toca la evidencia, authorizationUnresolved sigue en false (lo puso así el rechazo del primer intento) y el error vuelve a ser reintentable. La evidencia sólo se limpia al entrar a performOnlineAuthorization, en el éxito offline, en resetPayment y en efectivo/cripto; este camino no pasa por ninguno.

3) Tercer intento: reserveTerminal rechaza la reserva porque el segundo intento sigue reteniendo la terminal. Sale un Error con canRetry=false, y el observador emite `failed` con el PROCESSOR_DECLINED del primer intento. Ni emitTerminalPaymentResult ni RemotePaymentInbox.persistResult revisan la libreta.

4) El servidor acepta failed+PROCESSOR_DECLINED y lo guarda como FAILED/TPV_CONFIRMED_NO_CHARGE. C.1 lo convierte en NOT_CHARGED y C.4 suelta la llave y borra la orden. La recuperación de INDETERMINADO (LedgerUnknownRecovery) sólo cubre AngelPay, así que el segundo intento de Blumon no lo concilia nadie.

Hay dos matices que no bajan la severidad:
- El defecto ya existe en el árbol de la TPV y en closeRow; el diseño no lo crea. Pero lo vuelve contrato canónico con clase TERMINAL y le agrega el borrado de la orden, así que un error de evidencia pasa a ser un cobro doble.
- El cargo real exige que el segundo intento haya avanzado (aprobación offline o transacción en curso), lo cual es poco probable. Aun así, es justo el caso que KERNEL_ACTIVO/INDETERMINADO existe para proteger, y viola la condición de dinero de la regla: la evidencia se vuelve «no se cobró» sin ser de ese intento.
- El escenario además es realista: tras un rechazo, el cajero reintenta y el cliente no acerca la tarjeta a tiempo; eso produce TIMEOUT y se retiene.

Al arreglo propuesto le hago un ajuste. La libreta no tiene columna de requestId; la correlación sólo existe dentro de payment_context_json (terminalPaymentRequestId). Y la terminal es una sola, así que es más simple y más fuerte negar la evidencia si existe cualquier fila bloqueante en la terminal.
  - Evidencia: TPV, variante sandbox (/Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/sandbox/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt):
- 5031 y 5130: se fija PROCESSOR_DECLINED.
- 4723: sólo se limpia al entrar a la autorización online.
- 5540-5560: kernel contactless, TIMEOUT/OTHER ⇒ markIndeterminate; PaymentState.Error sin canRetry, es decir true.
- 5580-5598 y 5692-5698: transResult nulo o desconocido ⇒ la fila se queda en KERNEL_ACTIVO y el error es reintentable.
- 7105-7190: retryPayment limpia paymentAttemptIdClear pero no la evidencia.
- 3117-3175: startPayment no la limpia.
- 3342-3368: openAttempt=false ⇒ Error canRetry=false.
- 1463-1479: `failed` con outcomeEvidence = negativeOutcomeEvidence; la única salida anticipada es authorizationUnresolved, que ya está en false.

TPV, variante production (/Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/production/java/com/jaac/avoqado_tpv/features/payment/presentation/PaymentViewModel.kt): idéntica (4246, 4345, 3957, 4798, 6317, 1468).

Clasificación del kernel: /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/ContactlessKernelResult.kt:35-42 deja fuera TIMEOUT y OTHER.

Libreta:
- PaymentAttemptDao.kt, reserveTerminal: bloquea con PREPARANDO..REGISTRO_FALLIDO, incluidos KERNEL_ACTIVO e INDETERMINADO.
- PaymentAttemptLedger.kt:32: isEnabled()=true siempre.
- LedgerUnknownRecovery.kt:24: sólo PROCESSOR_ANGELPAY.

Salida del resultado:
- SocketManager.kt:1999-2045: emite sin consultar la libreta.
- RemotePaymentInbox.kt:174-188: persistResult tampoco la consulta.

Servidor (/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts):
- 1097-1101: acepta failed+PROCESSOR_DECLINED.
- 1136: failureCode='TPV_CONFIRMED_NO_CHARGE'.

Diseño (diseno-A-B-seccion8-2026-09-11.md):
- C.1: FAILED con código y evidencia de la lista blanca ⇒ NOT_CHARGED.
- C.4: con NOT_CHARGED se borra la orden.
- D dice «Nada en PaymentViewModel»; ninguna sección trata la evidencia por intento.
  - Arreglo corregido: Corrección en la TPV, con los mismos hunks en sandbox y production. Va antes de desplegar el servidor que aplica C.1.

1) Candado en el único punto de salida. En PaymentViewModel, antes de emitir `failed` o `cancelled` en observeSocketPaymentResult (y, como segunda defensa, en SocketManager.emitTerminalPaymentResult a través de un helper de la libreta), sólo se adjunta PRE_AUTHORIZATION o PROCESSOR_DECLINED si se cumplen las dos condiciones:
- (a) dao.findUnresolvedCharge() devuelve null, es decir, ninguna fila de la terminal está en KERNEL_ACTIVO..REGISTRO_FALLIDO/INDETERMINADO;
- (b) no hay filas PREPARANDO de otra solicitud.

Si hay alguna, el resultado sale sin evidencia: el servidor lo degrada a timeout y queda UNRESOLVED. La consulta es a nivel de terminal y no por requestId, porque la libreta no tiene columna de correlación (terminalPaymentRequestId sólo vive dentro de payment_context_json) y la terminal es una sola.

2) Evidencia por intento. Se pone negativeOutcomeEvidence=null en startPayment, justo después de ensurePaymentAttemptId, y en retryPayment. Así cada intento arranca sin evidencia heredada.

3) El rechazo de openAttempt por retención de esta misma venta no debe emitir `failed`. Se pone authorizationUnresolved=true y se llama showUnresolvedAuthorization(), igual que cuando la fila del intento anterior es incierta, para que la tablet siga en «sin confirmar» y la sonda pueda resolverla después.

4) Guardar la evidencia de AngelPay por intento, con el mismo candado.

5) Aparte, abrir la brecha pendiente: no existe recuperación de INDETERMINADO para Blumon.

Pruebas:
- Chip con rechazo 51, luego contactless con TIMEOUT (fila INDETERMINADO), luego reintento bloqueado: se emite `failed` sin outcomeEvidence (o no se emite y se muestra «confirmando») y el servidor deja la fila UNRESOLVED.
- La misma prueba con «Resultado desconocido» (fila en KERNEL_ACTIVO).
- Control: un rechazo 51 limpio sin intentos posteriores sigue emitiendo PROCESSOR_DECLINED.
- Sabotaje: si se quita la limpieza en retryPayment o el candado de findUnresolvedCharge, la primera prueba falla.

#### 3. [P1] «No se creó» no queda escrito: un POST tardío o duplicado desmiente el cancel antes de la fila (G7) y el 404 de C.3

- **Sección:** C.3 + C.4 + G7
- **Escenario:** (a) G7: el POST de cobro va lento (WiFi malo) y el cajero cancela a los 2 s. El cancel llega primero: cancelPayment no encuentra la fila y devuelve false sin dejar rastro. Un segundo después llega el POST, crea la fila y la entrega: la PAX o la Nexgo muestra «Acerca la tarjeta» con el monto. El coordinador de C.4, con GET 404 = pendiente, sólo reenvía el cancel en su siguiente ciclo, sin cadencia garantizada. El cliente paga antes; mientras tanto el cajero, que vio «Cancelación pendiente», le cobró en efectivo: cobro doble. (b) C.3: OkHttp reintenta el mismo POST tras un reset (retryOnConnectionFailure viene activado por default y avoqado-android no lo apaga) mientras el primer POST sigue en validateStaffVenue, antes de su transacción. El segundo no ve fila, el registro ya dice «desconectada» (Doze), y responde 404 TERMINAL_NOT_CONNECTED, que según C.3 «prueba no se creó»: la tablet suelta la llave. El primero crea la fila y la entrega, o se reentrega al reconectar: se cobra con la llave ya suelta.
- **Evidencia:** avoqado-server terminal-payment.service.ts:2067-2085 (cancel sin fila ⇒ return false, sin registro); 497-503 (el registro se consulta ANTES del candado) frente a 522-529 (pg_advisory_xact_lock y búsqueda de la fila dentro de la transacción); 525 (la réplica existe sólo si hay fila); terminal-payment.mobile.controller.ts:96-135; avoqado-android TerminalPaymentService.kt:35-37 y 222-300 (POST con el cliente base, reintentable), 535-570 (cancel fire-and-forget); diseño líneas 285-286 y 426 (G7: «el reenvío cubre la carrera»).
- **Arreglo propuesto:** Toda decisión negativa sobre un requestId debe ser una FILA. (1) Un cancel sin fila inserta una lápida TerminalPaymentRequest (venueId, requestId, terminalId normalizado del cuerpo, CANCELLED, cancelDisposition ACCEPTED, evidencia NEVER_DELIVERED, deliveryProvenance []). (2) El 404 de C.3 inserta la misma lápida con NOT_CREATED. Las dos van bajo pg_advisory_xact_lock del terminalId normalizado del cuerpo (no del registro), en la misma transacción que busca la fila, y reserve() la encuentra en su rama `existing` y replica NOT_CHARGED en vez de crear: un POST tardío nunca llega a la terminal. Revertir G7 y añadir NEVER_DELIVERED a la lista blanca de C.1. Pruebas con Postgres real: cancel antes que el POST, y dos POST concurrentes del mismo requestId con la terminal desconectándose entre ellos.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No lo pude refutar. El diseño hace dos afirmaciones de seguridad y el código no las sostiene.

(1) C.3 dice que el 404 TERMINAL_NOT_CONNECTED «ahora sí prueba no se creó». Pero sólo mira UNA petición, en UN instante y fuera de toda serialización. Otra copia del mismo requestId puede crear la fila después. Esa copia puede venir del reintento silencioso de OkHttp, que está activo por default y que el POS no apaga, o de un POST que va más lento.

La regla aprobada lo prohíbe con todas sus letras (pendiente #1): «nunca se envió» tiene que cubrir «reintentos, redirecciones y ejecuciones anteriores del mismo requestId; no basta observar el último intento». Además C.3 empeora las cosas respecto de hoy. Hoy el POS se queda con la llave ante un 404: es seguro, aunque se atasque (P1-3). Con C.3 la suelta porque cree tener una prueba, y la prueba es falsa. Es la misma familia de error que el cobro doble del 2026-08-10: una respuesta negativa leída como «no se cobró».

(2) G7 dice que «el reenvío del cancel cubre la carrera». No la cubre de forma garantizada, por tres razones:
- Un cancel sin fila no deja rastro.
- El coordinador de C.4 no tiene una cadencia definida («con temporizador», sin número).
- En la TPV, el cancel de C.5 sólo gana antes del kernel (PREPARANDO). Si el cliente ya acercó la tarjeta, contesta ACTIVE.

Así, un cobro que el cajero ya canceló puede llegar a la terminal y ejecutarse.

Sobre la severidad: la sostengo en P1 por la parte (b). Es una prueba de ausencia falsa en el camino del dinero y, además, nueva. Aun así dejo dicho dónde es débil el hallazgo:
- La ventana de (b) es angosta. Hacen falta dos cosas a la vez: que el servidor reciba el primer POST y la conexión muera antes de que se grabe la fila, y que el registro de la terminal cambie justo entre las dos comprobaciones. Lo segundo puede pasar: con Doze la PAX se conecta y desconecta seguido (medido), y el registro la da de baja o de alta en esos momentos.
- El «cobro doble» de (a) necesita además que el cajero cobre en efectivo mientras el POS dice «Cancelación pendiente». Por sí sola, (a) sería P2: el cobro tardío sí se registra y el coordinador lo aplica como «se cobró».
  - Evidencia: Servidor (árbol de trabajo):
- src/services/terminal-payment.service.ts:2067-2085 — cancelPayment: si el updateMany sobre IN_FLIGHT afecta 0 filas, `return false`. No escribe nada.
- :497-507 — el registro se consulta ANTES del candado; si la terminal no está, lanza «no está conectada».
- :520 — lockKey sale de la entrada del registro.
- :530-531 — pg_advisory_xact_lock y la búsqueda de la fila, las dos DENTRO de la transacción.
- :630 — rama P2002: busca `mine` y aplica validateReplayContract.

Controlador (src/controllers/mobile/terminal-payment.mobile.controller.ts):
- :97 — validateStaffVenue se espera ANTES de entrar al servicio. Mientras tanto, otra copia del POST puede adelantarse.
- :164 — «no está conectada» ⇒ 404 sin code.

Schema (prisma/schema.prisma, TerminalPaymentRequest):
- requestId es @unique global y amountCents es Int obligatorio. Esto importa para el arreglo.

Cobro en efectivo:
- src/services/mobile/order.mobile.service.ts:2250 — payCashOrder: no encontré ninguna comprobación de cobro de terminal vivo.
- assertNoLiveTerminalCharge sólo se usa en rutas de cancelar o anular (order.mobile:1931, order.tpv:2828).
- Conclusión: el servidor no impide cobrar en efectivo una orden que tiene un cobro de terminal vivo.

Android (avoqado-android):
- TerminalPaymentService.kt:35-37 — el POST usa baseClient.newBuilder() y sólo cambia readTimeout.
- NetworkModule.kt:60-72 — nunca llama a retryOnConnectionFailure(false). El default de OkHttp es true, y OkHttp reintenta un POST no one-shot ante un IOException recuperable aunque ya se haya enviado la petición.
- TerminalPaymentService.kt:535-570 — el cancel es fire-and-forget, en un hilo aparte y por otra conexión, así que puede llegar antes que el POST.

Diseño (diseno-A-B-seccion8-2026-09-11.md):
- :285-286 — «404 … que ahora sí prueba no se creó».
- :296 — en C.4, un 404 cuenta como pendiente, lo que contradice a C.3.
- :300 — el reenvío va «con temporizador», sin cadencia definida.
- :309 — el POS lee TERMINAL_NOT_CONNECTED correlacionado y suelta la llave.
- :426 — G7.

Regla (cobro-remoto-pos-a-tpv.md, pendiente 1): exige cubrir reintentos y ejecuciones anteriores del mismo requestId.
  - Arreglo corregido: Principio: toda decisión negativa sobre un requestId queda escrita como FILA, y el POST sólo decide dentro del mismo candado. El arreglo del hallazgo va bien encaminado; le hacen falta estos ajustes:

(1) Lápida por cancel sin fila.
- En cancelPayment, cuando el updateMany da 0 y no existe fila con ese requestId, se inserta dentro de una transacción una TerminalPaymentRequest con estos datos: status CANCELLED, cancelDisposition ACCEPTED, failureCode/evidencia NEVER_DELIVERED, deliveryProvenance {deliveries: []}, expiresAt = now, y terminalId = normalizeTerminalId(cuerpo).
- Como el cancel no trae monto y amountCents es obligatorio, se guarda 0 con una marca explícita de lápida.
- La transacción toma pg_advisory_xact_lock(normalizeTerminalId(terminalId del cuerpo)). Hay que comprobar antes que la terminal pertenece al venue, contra la base.
- requestId es @unique global: un P2002 contra la fila de otro venue se atrapa y no se filtra.

(2) Lápida por el 404 de C.3.
- La búsqueda de la fila, la consulta del registro y la inserción de la lápida van en la MISMA transacción, bajo el mismo candado. Datos de la lápida: FAILED, evidencia NOT_CREATED, el contrato de la petición.
- El candado del POST pasa a derivarse de normalizeTerminalId(cuerpo) y deja de depender de la entrada del registro.

(3) reserve() y la rama P2002 (línea 630) reconocen la lápida ANTES de validateReplayContract. Si no, la lápida del cancel, con monto 0, daría un 400 «ya pertenece a otro cobro». Al encontrarla, replican NOT_CHARGED y nunca crean ni emiten.

(4) En C.1, NEVER_DELIVERED y NOT_CREATED entran a la lista blanca. Una prueba de tabla verifica que UNRESOLVED_FINANCIAL_OUTCOME nunca cuenta una lápida como bloqueadora, y que la lápida no ocupa la ranura del índice parcial.

(5) Se revierte G7. En C.4, el 404 correlacionado deja de soltar la llave por sí mismo: la suelta sólo cuando el GET devuelve outcome NOT_CHARGED respaldado por la lápida.

(6) Endurecimiento complementario, sin confiar en él: el cliente del POST de cobro en Android usa retryOnConnectionFailure(false). En iOS hay que revisar los reintentos de URLSession.

(7) Pruebas contra Postgres real, rompiendo el arreglo a propósito:
- cancel antes que el POST ⇒ el POST replica NOT_CHARGED y no emite nada;
- dos POST concurrentes con el mismo requestId, uno detenido antes de validateStaffVenue, y el registro cambiando entre los dos ⇒ una sola fila y un desenlace coherente;
- lápida de cancel frente a un POST con monto ⇒ no da 400.

#### 4. [P1] Tarjeta declinada en la PAX + salida del cajero de la TPV = terminal y tablet bloqueadas sin salida automática

- **Sección:** C.1 + C.5
- **Escenario:** Cobro remoto R en la PAX; el banco declina (05/51). Queda negativeOutcomeEvidence=PROCESSOR_DECLINED y un error reintentable, sin emitir nada. La tablet pide cancelar: con C.5, tal como está escrito, la CAS PREPARANDO→DESCARTADA no aplica (A1 ya está DESCARTADA y hay fila), así que contesta ACTIVE. El cajero de la TPV sale (Cancelar → returnToSelectingMerchantFromError → atrás → resetPayment), y resetPayment emite `cancelled`+PROCESSOR_DECLINED. closeRow sólo acredita PROCESSOR_DECLINED junto con `failed`: lo degrada a `timeout`, que queda como UNKNOWN, y UNRESOLVED_FINANCIAL_OUTCOME retiene la terminal. La sonda recibe RESOLVED con el mismo JSON y lo vuelve a degradar (con backoff). La recuperación A no aplica (la bandeja sí tiene la fila). La tablet queda en «Cobro sin confirmar» con la llave armada. La única salida es B, manual, con el portal del procesador. Es el flujo diario «declinó, págame en efectivo».
- **Evidencia:** sandbox PaymentViewModel.kt:5025-5035 y 3775-3779 (rechazo ⇒ Error reintentable, no se emite); PaymentScreen.kt:916-921 y 310-322 (las salidas terminan en resetPayment); PaymentViewModel.kt:6863-6878 (emite cancelled con negativeOutcomeEvidence); SocketManager.kt:2014 (sí se transmite PROCESSOR_DECLINED); avoqado-server terminal-payment.service.ts:1097-1101 (cancelled+PROCESSOR_DECLINED ⇒ timeout), 370-381 (timeout ⇒ UNKNOWN), 217-223 (bloquea), 2232-2297 (la sonda lo re-degrada); diseño líneas 260 y 317-319.
- **Arreglo propuesto:** (1) Aceptar {failed, cancelled} × {PRE_AUTHORIZATION, PROCESSOR_DECLINED} en closeRow y en la lista blanca de C.1, pero SÓLO junto con la evidencia por solicitud del hallazgo anterior; si no, un PROCESSOR_DECLINED rancio certificaría un intento incierto. (2) En C.5, contestar ACCEPTED también cuando la bandeja sigue PROCESSING y todos los intentos correlacionados están DESCARTADA con negativa explícita, escribiendo cancel_accepted_at: «sólo desde PREPARANDO» deja ACTIVE justo el caso más frecuente. Prueba de integración: rechazo + cancel desde el POS + salida en la TPV ⇒ NOT_CHARGED y ranura libre.
- **Escéptico:** CONFIRMADO → severidad P1
  - Razón: No pude refutarlo: la cadena completa se sostiene en el árbol, y el diseño (C.1, C.5 y A) no la cierra. Hay que precisar dos cosas. (a) El cancel de la tablet no hace falta: basta con que el cajero salga de la pantalla de rechazo. Si sale por «Cancelar» y luego atrás, pasa por resetPayment. Si sale por «Cancelar» desde la selección de comercio, pasa por cancelPayment: el CAS PREPARANDO→DESCARTADA falla porque A1 ya está DESCARTADA, así que conserva PROCESSOR_DECLINED y emite Cancelled. Las dos salidas mandan `cancelled`+PROCESSOR_DECLINED. La combinación que el servidor sí acepta (`failed`+PROCESSOR_DECLINED) nunca la produce un rechazo remoto de Blumon, porque ese Error trae contexto y `canRetry=true` por defecto, y el observador no emite nada cuando se puede reintentar. Pasa igual en sandbox y production. (b) El resultado es de disponibilidad, no de dinero: la terminal queda reservada para cobros remotos (UNKNOWN está en SLOT_HELD), la orden no se puede cancelar (orderCancelGuard usa el mismo predicado) y la tablet se queda en «Cobro sin confirmar» con la llave armada. Nada lo libera: la sonda recibe RESOLVED con evidencia, la pasa por closeRow, la vuelve a degradar y entra en backoff. A no aplica porque la bandeja sí tiene la fila, y B es manual. Es un flujo diario («declinó, págame en efectivo»), de la misma clase que el P1-1 de la auditoría, y en ese mismo proyecto eso se calificó P1, así que mantengo P1. El reparo sobre el PROCESSOR_DECLINED rancio es real y más grave de lo que se dice. retryPayment borra paymentAttemptId pero no negativeOutcomeEvidence, que sólo se limpia en performOnlineAuthorization (:4723) o en resetPayment (:6901). Un reintento que entra al kernel y después sale emite `cancelled` con el PROCESSOR_DECLINED de A1 mientras A2 sigue sin desenlace. Por eso aceptar hoy `cancelled`+PROCESSOR_DECLINED en closeRow sin atarlo al intento sería un P1 de dinero.
  - Evidencia: TPV sandbox PaymentViewModel.kt: rechazo definitivo en :5025-5035 (negativeOutcomeEvidence="PROCESSOR_DECLINED" y markHostResponded(false), que según PaymentAttemptLedger.kt:172 lleva la libreta a DESCARTADA). :3775-3779 publica Error con contexto, y PaymentState.kt:455 pone canRetry=true por defecto. En :1455-1460, un Error con canRetry=true no emite nada. resetPayment (:6863-6878) emite `cancelled` con outcomeEvidence=negativeOutcomeEvidence. cancelPayment (:6833-6836): markDiscardedBeforeCharge sólo hace CAS desde PREPARANDO (Ledger :327-333), falla sobre DESCARTADA y conserva PROCESSOR_DECLINED. Luego Cancelled emite `cancelled` en :1477-1486. production tiene lo mismo en :1457, :4246, :6085-6088. PaymentScreen.kt: :916-921 (onCancel lleva a returnToSelectingMerchantFromError o a resetPayment) y :315-322 (atrás lleva a resetPayment). En :4674 y :7105-7195, negativeOutcomeEvidence no se limpia al reintentar (riesgo del valor rancio). SocketManager.kt:2014 transmite PROCESSOR_DECLINED, y :2034 lo guarda en la bandeja como RESOLVED antes de emitirlo. RemotePaymentInbox.kt:100-112: un cancel sobre PROCESSING contesta ACTIVE; :146 hace que la sonda conteste RESOLVED con ese JSON. Servidor terminal-payment.service.ts: :1097-1101 degrada `cancelled`+PROCESSOR_DECLINED a timeout; :370-381 timeout lleva a UNKNOWN; :175-180 UNKNOWN está en SLOT_HELD; :217-223 bloquea; :2237-2297 la sonda acepta la evidencia, llama closeRow, sale UNKNOWN otra vez y la marca en espera. Las pruebas de integración sólo cubren `failed`+PROCESSOR_DECLINED (terminalPaymentRecovery.integration.test.ts:392 y :900). Diseño: C.1 (líneas 260-261) sólo acredita FAILED+evidencia o CANCELLED+ACCEPTED; C.5 (línea 317) sólo gana desde PREPARANDO, si no contesta ACTIVE; la línea 81 mantiene closeRow como validador.
  - Arreglo corregido: Primero en la TPV (las dos variantes con los mismos hunks), antes de tocar el servidor: (1) Atar la evidencia al intento: guardar el attemptId junto con negativeOutcomeEvidence y limpiarlos en retryPayment y en el arranque de cada intento nuevo (no sólo en performOnlineAuthorization). Así ninguna salida posterior hereda el PROCESSOR_DECLINED de A1, y lo cubre una prueba con sabotaje: reintento que entra al kernel y después sale ⇒ nunca `cancelled`+PROCESSOR_DECLINED. (2) Cuando el pago es SOCKET y el intento vigente terminó en DESCARTADA con rechazo explícito del banco, cualquier salida del cajero (resetPayment, cancelPayment, returnToSelectingMerchantFromError y después atrás) emite `failed`+PROCESSOR_DECLINED de ese intento. Es la combinación que closeRow ya acredita, así que no cambia la regla del servidor ni la lista blanca de C.1. Si se prefiere aceptar `cancelled`+PROCESSOR_DECLINED en closeRow y en C.1, sólo con la evidencia por solicitud e intento; nunca aceptar la cadena sola. (3) En C.5, contestar ACCEPTED (escribiendo cancel_accepted_at en la misma transacción) también cuando la bandeja está PROCESSING y todos los intentos correlacionados de esa solicitud están DESCARTADA con negativa explícita (PROCESSOR_DECLINED o PRE_AUTHORIZATION), y ninguno está en KERNEL_ACTIVO en adelante. Esto depende de la cerca durable de reserveTerminal: el «Reintentar» que sigue en pantalla no puede abrir A2 sobre esa solicitud. Pruebas de integración contra Postgres: (i) rechazo, luego el cajero sale sin cancel del POS ⇒ FAILED/TPV_CONFIRMED_NO_CHARGE, NOT_CHARGED y ranura libre; (ii) rechazo, cancel desde el POS y salida en la TPV ⇒ NOT_CHARGED y ranura libre; (iii) sonda sobre una bandeja RESOLVED con ese resultado ⇒ se resuelve y no entra en backoff; (iv) rechazo, reintento con A2 en kernel y cancel ⇒ sigue UNRESOLVED (contraprueba del valor rancio).

#### 5. [P2] Tras cambiar de usuario o de sucursal, la llave y la intención quedan irresolubles y la tablet ya no puede cobrar con tarjeta

- **Sección:** C.4 + G6
- **Escenario:** Tablet compartida. La cajera de la sucursal A deja un «Cobro sin confirmar» (o una intención de C.4) y cierra sesión; entra un cajero que sólo tiene la sucursal B. getPaymentStatus usa el venue guardado (A) con el token nuevo; checkPermission responde 403 (sin acceso a A), que se trata como Unreachable, así que el cobro queda Undetermined sin fin. El coordinador reenvía cancel y DELETE y recibe 403. Mientras la llave siga armada, sendPaymentToTerminal rechaza TODO cobro con tarjeta, y chargeAgainDespiteUndetermined no hace nada: la tablet no cobra con tarjeta en B hasta que inicie sesión alguien con acceso a A. Además, cancelCurrentPayment usa el cliente sin FAIL_FAST/BACKGROUND: un 403 «overridable» abriría el teclado de PIN desde un coordinador en segundo plano, encima de otra pantalla (ya pasó el 2026-08-16).
- **Evidencia:** avoqado-android TerminalPaymentService.kt:222 (rechaza cualquier cobro nuevo), 399-440 (venue guardado; cualquier código que no sea 2xx ni 404 ⇒ Unreachable), 535-570 (cliente largo sin cabecera), 44-66 (statusClient sí pone FAIL_FAST); PaymentFlowViewModel.kt:1850 (no-op); SecureStorage.kt:101-110 (la llave sobrevive a clearSession); avoqado-server checkPermission.middleware.ts:273-327 (acceso por venue), mobile.routes.ts:1627 y 1679; diseño línea 306.
- **Arreglo propuesto:** La intención y la llave guardan venueId y staffId. Los 401/403 se clasifican aparte, nunca como «sin red», y la pantalla dice «Este pendiente es de <A>: necesita un usuario con acceso a <A>». El bloqueo de sendPaymentToTerminal se limita al MISMO venue de la llave (otra sucursal es otra venta, así que no hay riesgo de doble cobro de la misma). El coordinador usa el cliente corto con BACKGROUND_HEADER/FAIL_FAST para cancel, GET y DELETE. Igual en iOS (TerminalPaymentService.swift:316 y 480-487). Prueba: logout con intención pendiente → login de un usuario sin acceso a A.
- **Escéptico:** CONFIRMADO → severidad P3
  - Razón: No lo pude refutar: el bloqueo existe, pero se sobreestimaron su causa y su gravedad, y el arreglo propuesto no funciona tal como está escrito.

**Qué se confirma en el código:**
- La llave del cobro pendiente vive en disco y NO se borra al cerrar sesión (`SecureStorage.kt:92-110`, `clearSession`, líneas 465-497).
- `getPaymentStatus` usa el venue guardado (A) junto con el token del usuario nuevo (`TerminalPaymentService.kt:390-395`).
- El servidor, cuando el usuario no tiene acceso a A, responde 403 «No access to this venue» (`checkPermission.middleware.ts:325-353`). Android cataloga ese 403 como `Unreachable` (líneas 423-427) y el cobro se queda en `Undetermined` sin fin.
- `sendPaymentToTerminal` rechaza cualquier cobro mientras la llave esté armada (línea 222) y `chargeAgainDespiteUndetermined` no hace nada (`PaymentFlowViewModel.kt:1850`).
- iOS es espejo exacto (`TerminalPaymentService.swift:316` y `resolveOutcome`, que usa el venue guardado).
- El diseño hereda ese mismo comportamiento para la intención de cancelar sin resolver el caso de otra sucursal: C.4 dice «sobrevive a ambos, como la llave del cobro» y G6 lo repite.

**Por qué bajo la severidad a P3:**
1. El defecto de la llave ya existe hoy; el diseño sólo lo extiende a la intención.
2. Falla cerrado: no hay riesgo de dinero, sólo de disponibilidad.
3. Se destraba sin código: basta que inicie sesión cualquier usuario con acceso a A (el dueño normalmente lo tiene, y `checkPermission` busca la membresía por `userId` + venue destino, no por el venue del token).
4. El escenario pide una combinación rara: una tablet usada por personal de sucursales distintas, sin acceso cruzado, con un cobro sin confirmar vivo.

**Correcciones al hallazgo:**
- **(a) El bloqueo es MAYOR de lo que dice el hallazgo.** No es sólo la tarjeta: `startFlow` (líneas 784-793) manda todo el flujo de cobro a `Undetermined` («Cobro anterior sin confirmar»), que sólo ofrece «Volver a consultar» y «Cancelar».
- **(b) El teclado de PIN NO se abriría en este escenario.** El 403 por falta de membresía no lleva `overridable` (el mismo middleware lo dice en las líneas 492-494). Lo que sí aparece es el modal global «no tienes permisos» (`ForbiddenInterceptor.kt:207-220`, `errorNotifier.notify`). Y aparece incluso con `statusClient`, porque `FAIL_FAST` sólo suprime la rama del PIN (línea 182); lo único que evita el modal es `BACKGROUND_HEADER` (líneas 94-96). Ése fue el incidente del 2026-08-16.
- **(c) «Limitar el bloqueo al mismo venue» no basta.** `persistPendingCardCharge` es de un solo espacio: devuelve `false` si ya existe CUALQUIER llave (`SecureStorage.kt:255-259`). El cobro en B no podría guardar su propia llave y respondería «No se pudo guardar el intento» o «heredado». Además, el coordinador de C.4 todavía no existe: `cancelCurrentPayment` hoy sólo actúa sobre la solicitud en memoria.
  - Evidencia: **avoqado-android**
- `SecureStorage.kt:92-110`: el KDoc dice «NO se limpia en clearSession»; `clearSession` (465-497) no borra `KEY_PENDING_CARD_CHARGE` ni `pendingCardChargeContext`.
- `SecureStorage.kt:255-259`: `persistPendingCardCharge` devuelve `false` si `pendingCardChargeRequestId != null` (un solo espacio).
- `TerminalPaymentService.kt:222`: `unresolvedRequestId?.let { return Undetermined(..., inherited = true) }`.
- `TerminalPaymentService.kt:390-395`: `storedVenue` sale de `pendingCardChargeContext` y se usa con `secureStorage.accessToken`.
- `TerminalPaymentService.kt:423-427`: todo código que no sea 2xx ni 404 se vuelve `Unreachable`.
- `TerminalPaymentService.kt:44-66`: `statusClient` pone sólo `FAIL_FAST`, no `BACKGROUND`.
- `TerminalPaymentService.kt:537-570`: `cancelCurrentPayment` usa `client` (310 s) sin cabeceras y sólo sobre `currentRequestId`, que está en memoria.
- `PaymentFlowViewModel.kt:784-793`: `startFlow` bloquea TODO el flujo con la llave armada.
- `PaymentFlowViewModel.kt:1850`: `chargeAgainDespiteUndetermined` es no-op.
- `PaymentFlowScreen.kt:322-330`: la pantalla sólo ofrece Recheck y Cancel.
- `ForbiddenInterceptor.kt:94-106`: `BACKGROUND` manda el 403 a cuarentena, sin diálogo.
- `ForbiddenInterceptor.kt:174-182`: `FAIL_FAST` sólo afecta la rama `overridable`.
- `ForbiddenInterceptor.kt:207-220`: `errorNotifier.notify` (modal global).

**avoqado-server**
- `checkPermission.middleware.ts:325-353`: sin rol en el venue destino ⇒ 403 `{error:'Forbidden', message:'No access to this venue'}`, sin `overridable`.
- `checkPermission.middleware.ts:492-503`: `overridable` sólo existe en el 403 por permiso faltante.
- `mobile.routes.ts:1626-1630` (cancel, `payments:create`) y `1679-1683` (GET estado, `payments:read`).

**avoqado-ios**
- `TerminalPaymentService.swift:316-318`: mismo rechazo global.
- `resolveOutcome` (~l. 492): usa el venue original guardado.

**Diseño**
- Línea 306 (C.4): «sobrevive a ambos, como la llave del cobro».
- G6 (línea 425).
  - Arreglo corregido: 1. **Guardar dueño en la llave y en la intención.** Las dos guardan `venueId` y `staffId` (la llave ya guarda `venueId` en el contexto). El 403 por falta de membresía se clasifica aparte, nunca como «sin red». Lo ideal es que el servidor agregue en ese 403 un `code` estable (p. ej. `NO_VENUE_ACCESS`), aditivo, para no depender del texto de `message`. La pantalla dice: «Este cobro pendiente es de <venue A>: necesita que inicie sesión alguien con acceso a <A>». El 401 sigue su camino de refresco.

2. **Llaves por venue.** Permitir cobrar en B con un pendiente de A exige que el almacenamiento sea un mapa `venueId → {requestId, contexto}` en vez de un solo espacio. Así, `persistPendingCardCharge`, `startFlow` y `sendPaymentToTerminal` bloquean sólo el venue actual. Hacerlo sin eso deja a B sin poder guardar su propia llave. Es seguro para el dinero porque otra sucursal es otra venta, pero se debe mostrar el pendiente de A como aviso ámbar (no como bloqueo) mientras se opera en B.

3. **Cabeceras del coordinador.** El coordinador de C.4 hace sus tres llamadas (cancel, GET y DELETE) con un cliente corto que ponga `BACKGROUND_HEADER` (no sólo `FAIL_FAST`). Sin eso, el 403 de membresía abre el modal global «no tienes permisos» encima de otra pantalla. `FAIL_FAST` sólo evita el teclado de PIN, que en este caso ni siquiera aplica. El coordinador tampoco se dispara para intenciones de un venue al que el usuario actual no tiene acceso: queda en espera hasta que alguien con acceso a ese venue inicie sesión.

4. **Paridad en iOS** (`sendPayment:316`, `getPaymentStatus`/`resolveOutcome`, y el almacenamiento de la llave y de la intención GRDB).

5. **Pruebas** (en las dos apps):
   - logout con llave o intención de A pendiente → login de un usuario sólo de B: B puede cobrar, la pantalla nombra a A, no aparece ningún modal de permisos, y la llave de A sigue intacta;
   - después, login de un usuario de A: se resuelve.

#### 6. [P2] Cancelar mientras se crea la orden todavía manda el cobro, y si se pierde la respuesta la intención no sabe qué orden borrar

- **Sección:** C.4 (carrera de «Procesando pago…»)
- **Escenario:** confirmPayment lanza createOrder por red lenta y el cajero toca Cancelar. cancel() sube paymentGeneration, pero createdOrderId sigue en null: no se registra ninguna cancelación. createOrder vuelve y processPaymentMethod captura la generación YA incrementada, así que manda el cobro a la terminal después del cancel y la terminal le pide la tarjeta a un cliente cuya venta se canceló. Si en cambio se pierde la respuesta de createOrder (la orden sí se creó en el servidor), la intención de C.4 no tiene orderId y nace otra orden huérfana, de la clase de las 21+3.
- **Evidencia:** avoqado-android PaymentFlowViewModel.kt:991-1040 (confirmPayment; createOrder con externalId = sessionIdempotencyKey en 1011-1017), 1124-1127 (la generación se captura después), 1855-1883 (cancel sólo actúa si ya hay createdOrderId); diseño líneas 310-311.
- **Arreglo propuesto:** Capturar un token de flujo (o la generación) en confirmPayment y comprobarlo después de createOrder, antes de sendPaymentToTerminal. La intención de C.4 guarda el externalId de la orden (sessionIdempotencyKey), y el servidor acepta cancelar por (venueId, externalId) con el helper protegido de C.6, que resuelve también el caso de la respuesta perdida. Espejo en iOS.
- **Escéptico:** CONFIRMADO → severidad P3
  - Razón: El hallazgo es cierto a medias.

Lo que describe del código actual de Android es real. Pero la mitad más grave, «todavía se manda el cobro», no es un defecto del diseño: el diseño ya dice lo contrario. La línea 310-311 de C.4 fija que «si se cancela mientras se crea la orden, no se envía el cobro».

Lo que el diseño deja abierto:
- **No dice cómo se cumple.** La guarda de hoy no alcanza: la generación se captura demasiado tarde.
- **La respuesta perdida de createOrder no está cubierta.** «Esa orden» presupone que hay orderId, y en ese caso no lo hay.

Ese hueco sí existe, pero su impacto es menor al que se afirma:
- Queda una orden abierta, sin pago y sin solicitud a terminal. No se mueve dinero.
- No es «de la clase de las 21+3»: esas órdenes sí tienen un TerminalPaymentRequest CANCELLED/FAILED/TIMED_OUT (409-cancelar-orden §2.3).
- Además no depende de la carrera. Pasa igual con una respuesta perdida seguida de «Cancelar» en la pantalla de error: `cancelAndExit` con orderId nulo no cancela nada.

Por eso baja de P2 a P3: como defecto de diseño, lo que queda es especificar el mecanismo y guardar el externalId.

El «espejo en iOS» tampoco aplica tal cual. iOS crea la orden en `submitCartForPayment` y después pasa a elegir el método de pago; el envío a la terminal pide otro toque. No existe la carrera de enviar después de cancelar, sólo la de la orden huérfana.
  - Evidencia: **Android (árbol), `PaymentFlowViewModel.kt`:**
- **Cancelar sigue disponible mientras se crea la orden.** `confirmPayment` (993-1017) pone `Processing` y llama a `createOrder` con `externalId = sessionIdempotencyKey()`. `PaymentFlowScreen.kt:211-217` muestra `PaymentProcessingView` con Cancelar en `Processing` → `viewModel.cancel()` + `onCancel()`.
- **El ViewModel sobrevive a la cancelación.** `onCancel` sólo hace `showPaymentFlow=false` (`CheckoutScreen.kt:1662`). El ViewModel es la misma instancia a nivel de Checkout (`CheckoutScreen.kt:176`), así que la corrutina sigue viva.
- **`cancel()` no deja rastro.** `cancel()` (1855-1883) sube `paymentGeneration`, pone `paymentIdempotencyKey=null` y llama a `cancelCurrentPayment()`, que retorna sin hacer nada cuando no hay `currentRequestId` (`TerminalPaymentService.kt:539`). Como `createdOrderId` es nulo, tampoco cancela la orden.
- **La generación se lee tarde.** Al volver `createOrder`, `onSuccess` fija `createdOrderId` y llama a `processPaymentMethod`. Ahí `val generation = paymentGeneration` se lee ya incrementada (1125) y `sendPaymentToTerminal` sale (1126).
- **Nada comprueba si se canceló mientras se creaba la orden.** La comprobación de 1142 sólo cubre el resultado que llega tarde, no el envío. Confirmado.

**Respuesta perdida:**
- `onFailure` con error de red no cancela nada. Además `cancel()` ya borró la llave de la sesión, y el servidor sí creó la orden (idempotencia por `venueId+externalId`, `order.mobile.service.ts:746-758`).
- Resultado: orden abierta sin pago y sin fila de terminal. Confirmado.

**Diseño:**
- C.4 línea 310-311 ya exige no enviar el cobro, pero no nombra el mecanismo.
- La intención y el borrado se basan en «la orden si la creó el flujo» (líneas 297, 301 y G1). En ningún lugar guardan el externalId, así que el caso de respuesta perdida no queda cubierto.

**iOS:**
- `submitCartForPayment` (1553) crea la orden (1663) y termina en `enterPaymentMethodSelection` (≈1758).
- El envío es `sendPaymentViaServer`, que se dispara por separado. No hay envío automático después de crear la orden.

**Las 21+3:** `409-cancelar-orden-2026-09-11.md` §2.3 las define como órdenes con solicitud a terminal. Son otra clase.
  - Arreglo corregido: **1. Precisar C.4 en Android.** Poner en el diseño el mecanismo que exige la línea 310:
- Capturar un token del flujo (la generación o un id propio) en `confirmPayment` **antes** de `createOrder`, y compararlo **después** de que vuelva y **antes** de `processPaymentMethod`/`sendPaymentToTerminal`.
- Si cambió, no enviar el cobro. Pasar la orden recién creada a la intención durable de cancelación, en su camino de «nunca hubo cobro»: no hay requestId, así que se borra directo con el helper protegido de C.6.
- Prueba en rojo: cancelar con `createOrder` suspendido; después de reanudar, `sendPaymentToTerminal` debe llamarse 0 veces.

**2. Guardar el externalId en la intención.** Que la intención guarde el `externalId` de la orden (`sessionIdempotencyKey`) **antes** de lanzar `createOrder`, o al menos al cancelar mientras se crea. Hoy `cancel()` borra esa llave, así que hay que capturarla antes.

**3. Resolver la respuesta perdida.** Dos opciones:
- **(a) Sin servidor nuevo:** reenviar `createOrder` con el mismo externalId. El servidor, idempotente, devuelve la orden existente (o crea una vacía), y después se cancela con el helper de C.6.
- **(b) Endpoint nuevo:** un endpoint o variante que resuelva por `(venueId, externalId)` y cancele bajo el mismo candado.

**4. Cubrir también «respuesta perdida → Cancelar desde Error».** Pasa por `cancelAndExit` con orderId nulo, así que no es exclusivo de la carrera.

**5. iOS.** No copiar la guarda del token: no hay envío automático. Aplicar sólo lo del externalId en la intención, porque `submitCartForPayment` también puede perder la respuesta de `createOrder` y el cancel de iOS no borra órdenes.

#### 7. [P2] «Sin conexión: la cancelación se enviará sola» miente cuando la terminal tiene LTE

- **Sección:** C.4 (sin red)
- **Escenario:** Se cae el internet del local; la PAX sigue en línea por su SIM mostrando «Acerca o inserta la tarjeta» con el monto (el escenario del founder). El cajero toca «Cancelar la venta»: la intención se guarda pero el cancel no sale, y la pantalla asegura que se enviará sola. El cajero cobra en efectivo; el cliente, que ya tenía la PAX enfrente, acerca la tarjeta; la PAX cobra y registra por LTE: cobro doble. Al volver la red, el coordinador sólo descubre CHARGED.
- **Evidencia:** diseño líneas 312-313; avoqado-android TerminalPaymentService.kt:535-570 (el cancel sólo sale si hay red, y sin estado durable); avoqado-server terminal-payment.service.ts:2067-2110 (sólo el POST de cancel marca CANCEL_REQUESTED y avisa a la terminal); regla cobro-remoto-pos-a-tpv.md, «Escenario del founder» (terminal con SIM).
- **Arreglo propuesto:** Si hay un cobro vivo y no hay red, la pantalla dice en ámbar: «La terminal todavía puede cobrar. Pide al cliente que NO pase la tarjeta y cancela también en la terminal.» «Cancelar la venta» no se presenta como si ya hubiera cancelado. Mientras la llave de ese cobro siga armada, cobrar esa misma venta en efectivo exige una confirmación explícita que nombre el riesgo de doble cobro. Mismos textos, palabra por palabra, en Android e iOS.
- **Escéptico:** CONFIRMADO → severidad P3
  - Razón: El hueco de texto existe, pero el camino de cobro doble dentro de la app, no. Primero lo que sí se sostiene. Sin red, el cancel no sale de la tablet. Hoy es un hilo fire-and-forget que se traga el error (`TerminalPaymentService.kt:535-570`). Y el servidor sólo marca CANCEL_REQUESTED y avisa a la terminal cuando le llega ese POST (`terminal-payment.service.ts:2067-2110`). Si la PAX sigue en línea por su SIM, se queda en «Acerca o inserta» hasta que vence el tiempo de su SDK (existe `StartEmvTransFailure.TimeoutFailure`) y puede cobrar en ese rato. El texto que propone el diseño (C.4, «Sin conexión: la cancelación se enviará sola») es literalmente cierto, pero calla ese riesgo, justo en el escenario que el founder pidió cubrir. Choca con la prioridad 4 de la regla (pantalla honesta).

Lo que se refuta es «el cajero cobra en efectivo» dentro del POS. En las dos apps, mientras la llave durable siga armada, no se puede empezar ninguna venta, tampoco en efectivo. En Android, `startPaymentFlow` pone `undeterminedRequestId = null` (línea 690). Si `unresolvedRequestId` no es nulo, entra en `Undetermined(fromPreviousSale=true)` y regresa sin llegar a `enterInitialState` (líneas 784-793). Esa pantalla sólo ofrece «Volver a consultar» y «Salir con el cobro pendiente» (`PaymentResultScreen.kt:700-715`); `chargeAgainDespiteUndetermined` no hace nada. iOS hace lo mismo con `blockedByPendingCardCharge` (`PaymentFlowViewModel.swift:235-245`). El diseño deja la llave armada hasta que conste NOT_CHARGED («sobrevive … como la llave del cobro»).

Así que el cobro doble sólo pasa si el cajero recibe el efectivo fuera del sistema y además el cliente acerca la tarjeta dentro de la ventana del SDK. La pantalla anterior ya dice «No vuelvas a pasar la tarjeta.» (`CardChargeOutcome.kt:103`). Es plausible, porque la caja bloqueada empuja a cobrar por fuera, y sería dinero del cliente, pero se detecta como sobrante y se corrige con un reembolso. Por eso P3 y no P2.

El arreglo propuesto tiene una parte peligrosa: pedir «una confirmación explícita para cobrar esa misma venta en efectivo» abriría un camino que hoy no existe. Debilitaría el portero de la llave, que es justo lo que se puso tras el cobro doble del 2026-08-10.
  - Evidencia: Diseño `diseno-A-B-seccion8-2026-09-11.md:312-313` (C.4, sin red) y :303-305 (la intención sobrevive «como la llave del cobro»).

Android `TerminalPaymentService.kt:535-570`: `cancelCurrentPayment` manda el POST en un hilo aparte, se traga la excepción y sólo hace `clearCurrent`. La llave de disco `unresolvedRequestId` (:122-124) queda armada desde `persistPendingCardCharge`, antes del POST (:231-236).

Android `PaymentFlowViewModel.kt:690`: `undeterminedRequestId = null`. En :784-793, con llave pendiente pasa a `Undetermined(fromPreviousSale)` y regresa. En :1857 `chargeAgainDespiteUndetermined` está vacío.

Android `PaymentResultScreen.kt:700-715`: sólo «Volver a consultar» y «Salir con el cobro pendiente».

iOS `PaymentFlowViewModel.swift:235-250`: `blockedByPendingCardCharge` corta antes de `.selectingPaymentMethod`.

Servidor `terminal-payment.service.ts:2067-2110`: sólo `cancelPayment`, que se llama desde el POST, escribe CANCEL_REQUESTED y emite a la terminal.

TPV `sandbox/.../PaymentViewModel.kt:3622`: el SDK de Blumon tiene tiempo de espera de lectura, así que la ventana es acotada pero real.

`CardChargeOutcome.kt:103`: «Estamos confirmando el cobro. No vuelvas a pasar la tarjeta.»
  - Arreglo corregido: 1. En Android e iOS, con las mismas palabras: si hay una intención de cancelar sin enviar y no hay red, no se dice «la cancelación se enviará sola» como si ya estuviera resuelta. Se muestra en ámbar: «Sin conexión: la terminal todavía puede cobrar. Cancela también en la terminal y pide al cliente que no pase la tarjeta. La cancelación se enviará sola al volver la conexión.»

2. Se conserva sin cambios el portero de la llave durable (`startPaymentFlow` en Android, `blockedByPendingCardCharge` en iOS). NO se agrega ningún camino, ni siquiera con confirmación, para cobrar esa venta en efectivo mientras la llave siga armada: eso debilitaría la protección contra el cobro doble del 2026-08-10.

3. Cuando el coordinador descubra CHARGED al volver la red, lo dice en alto: «Esta venta sí se cobró con tarjeta aunque la cancelaste; si además recibiste efectivo, devuélvelo.» Así el cobro doble por fuera del sistema se detecta en ese momento y no hasta el corte.

4. En QA, ejercitar la celda 17 de la matriz: internet del local caído, PAX y Nexgo con SIM, cancelar desde la tablet y verificar qué dice cada pantalla.

#### 8. [P3] N3 acepta el cancel con la tarjeta chip dentro y el PIN en pantalla (StartEmvTrans corre en PREPARANDO)

- **Sección:** C.5 (Blumon chip)
- **Escenario:** Cobro remoto R: el cliente insertó el chip y está tecleando el PIN dentro de StartEmvTrans. La fila sigue en PREPARANDO porque el camino chip sólo marca AUTORIZANDO justo antes de SaleIcc. El POS cancela y la CAS de C.5 gana: ACCEPTED, «No se cobró». El dinero está a salvo (markAuthorizing fallará), pero «detener la lectura» no está definido para EMV: el SDK espera las respuestas de PIN/ContinueConfirmCard y se bloquea si nadie contesta, lo que puede dejar la PAX sin poder cobrar hasta reiniciar. O el flujo sigue y termina en «No se pudo guardar el intento» en lugar del aviso del POS. Además, la duda del TC offline queda abierta.
- **Evidencia:** sandbox PaymentViewModel.kt:3595-3610 (StartEmvTrans sin markKernelEntered), 4726 (la única barrera, antes de SaleIcc), 5540 (contactless sí compromete KERNEL_ACTIVO antes del kernel), 1351-1360 («Without this response, StartEmvTransUseCase blocks indefinitely»); diseño líneas 318 y 328.
- **Arreglo propuesto:** Comprometer KERNEL_ACTIVO (markKernelEntered) antes de StartEmvTrans en el chip, en las dos variantes con los mismos hunks, sin esperar la verificación del TC offline. Los fallos explícitos previos al host (CardDeclineByEmv, tarjeta retirada, EmvIncomplete) liberan con markKernelRefused. Así, un cancel con la tarjeta dentro contesta ACTIVE y la PAX muestra «El POS pidió cancelar; retira la tarjeta» sin tocar el SDK, y DESCARTADA sólo ocurre desde un PREPARANDO real, antes de leer la tarjeta.
- **Escéptico:** no aplica (P3 sin verificar)
