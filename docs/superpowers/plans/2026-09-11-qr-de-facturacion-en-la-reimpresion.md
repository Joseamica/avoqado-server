# Plan — El QR de facturación también sale al REIMPRIMIR el ticket

**Origen:** Asana «POS - Reimpresion de Ticket sin QR de facturacion» (Daniel Aguirre, 11-sep-2026):
*«Necesitamos que cuando se reimprima el ticket, salga tmb el QR para facturacion (no sale)»*.
**Alcance aprobado por el founder (11-sep):** servidor + avoqado-android + avoqado-ios + avoqado-tpv.
**Repos:** avoqado-server · avoqado-android · avoqado-ios · avoqado-tpv.

## 🟢 ESTADO — construido el 11-sep, SIN COMMITEAR (los 4 repos)

| Fase | Estado | Verificación |
|---|---|---|
| A · servidor | 🟢 hecha | 8 unitarias + **20 HTTP reales** (supertest, los 2 namespaces) · 158 pruebas en 19 suites vecinas en verde · typecheck **0 errores**, local y Alienware COINCIDEN · 2 sabotajes tumban sus 2 pruebas |
| B · android + iOS | 🟢 hecha | android 9 pruebas nuevas + compila; iOS 9 pruebas nuevas, `** TEST SUCCEEDED **` · sabotaje en android: caen exactamente las 2 que guardan la regla |
| C · TPV | 🟢 hecha (menos C2, declarada fuera) | 7 pruebas nuevas · `compileSandboxDebugKotlin` y `compileProductionDebugKotlin` en verde · sabotaje: caen sus 2 pruebas · CHANGELOG bajo `[Unreleased]` |
| D · QA en hardware | ⬜ **PENDIENTE — ningún modelo puede hacerlo** | hay que imprimir, reimprimir y escanear el QR en una Sunmi D3 / PAX / iPad |

**Sin red (regla `todo-funciona-sin-red.md`), respondido:** esto **degrada y lo DICE**. El ticket
nunca se bloquea; sin liga sale sin QR **y sin leyenda**, y el aviso distingue *no hay red* de *el
servidor falló*. No se escribe ni se encola nada (es una lectura con tope de 5 s), así que no hay
nada que perder si el proceso muere ni nada que reproducir al volver la red.

---

## 1. Qué pasa hoy (medido, no supuesto)

**No es una regresión: la reimpresión NUNCA llevó QR.** El ticket que sale al cobrar y el que sale al
reimprimir los arman funciones distintas, y sólo la primera tiene el bloque del QR.

| Repo | Ticket al COBRAR (sí lleva QR) | REIMPRESIÓN desde historial (no lleva) |
|---|---|---|
| avoqado-tpv | `core/printer/PrinterManager.kt:210` `printReceipt`, QR en `:418-440`; Nexgo `AngelPayTicketBuilder.kt:64`, QR en `:302-325` | `PrinterManager.kt:1345` `printPaymentHistoryReceipt` (cuerpo `:1349-1428`, sin QR en sus 11 commits de historia); Nexgo `AngelPayTicketBuilder.kt:404` `buildHistoryTicket` |
| avoqado-android | `printing/data/ESCPOSPrinter.kt:554` `generateReceipt`, QR en `:677-687` | `transactions/…/TransactionsViewModel.kt:316` `printTransactionReceipt` → `toReceiptData` `:481-515` (arma `ReceiptData` **sin** `receiptUrl`) |
| avoqado-ios | espejo de Android (`Printing/Services/ESCPOSPrinter.swift`) | `Transactions/Views/NewReceiptSheet.swift:96` `buildReceiptData` → `TransactionDetailView.swift:290` `printReceipt` |

**Y el dato tampoco viaja:** ninguna de las rutas de consulta devuelve la llave del recibo.

- TPV: `POST /tpv/venues/:venueId/payments` → `payment.tpv.service.ts:1513` `findMany` sin `receipts`.
- Android/iOS: `GET /mobile/venues/:venueId/transactions/:paymentId` →
  `transaction.mobile.service.ts:139` `getTransactionDetail`, cuyo `select` (`:145-190`) no trae
  `receipts` ni `orderId`.

Sólo las rutas que CREAN el cobro devuelven `digitalReceipt { accessKey, receiptUrl, autofacturaAvailable }`
(`payment.tpv.service.ts:93` `mapDigitalReceiptResponse`). La app lo guarda en memoria para ese cobro y
ahí muere.

**Git (confirmado commit por commit):** en Android el botón «Imprimir» del historial nació el 19-jul-2026
(`2e4e310`) y el QR se agregó el 22-jul (`6991424`) tocando sólo el flujo de cobro. En el TPV,
`printPaymentHistoryReceipt` nació el 25-nov-2025 (`23e9b57`) y el QR del ticket de venta es anterior
(`fe45915`, 10-nov-2025): se añadió sólo a `printReceipt`.

### Matiz que corrige el planteamiento original

**La facturación activa NO es lo que enciende el QR.** El QR se imprime siempre que exista la URL del
recibo. `autofacturaAvailable` (`payment.tpv.service.ts:159` `resolveAutofacturaAvailable` =
`facturacionEnabled && autofacturaEnabled`) sólo cambia la leyenda: «Escanea para tu recibo **y
factura**» vs. «recibo digital». El botón «Facturar» vive dentro de la página pública del recibo.

### Dos defectos hermanos, mismo síntoma (entran en este trabajo)

1. **TPV, ticket ORIGINAL sin QR pero CON la leyenda.** `PrinterManager.kt:420` condiciona con
   `receiptUrl != null`, pero cuando el server responde `digitalReceipt: null` el cliente guarda `""`
   (`FastPaymentRecorder.kt:143`, `OrderPaymentRecorder.kt:132`): entra al bloque, ZXing falla con
   cadena vacía (`generateQrBitmap` → `null`, `:775`) y sale la frase huérfana sin QR.
   `AngelPayTicketBuilder.kt:302` ya usa `isNullOrBlank()` — el arreglo es alinear el PAX.
2. **«Imprimir en TPV» desde Android/iOS no manda la URL.** `TerminalPaymentService.kt:731-774` manda
   items, totales, `paymentId` y `receiptAccessKey`, pero **no** `receiptUrl`; el TPV receptor lee
   justamente `receiptUrl` del payload (`HomeViewModel.kt:1205`) y tampoco recibe `autofacturaAvailable`.

---

## 2. Decisiones (tomadas, con su razón — no re-litigar sin dato nuevo)

**D1 — El dato se pide con UN endpoint dedicado por pago, no ensanchando las listas.**
`GET /{mobile|tpv}/venues/:venueId/payments/:paymentId/receipt` → `{ accessKey, receiptUrl, autofacturaAvailable }`.
Razones: (a) resolver autofactura en una lista de 50 pagos sería N+1 contra la regla
`bounded-queries-and-server-load.md`; (b) cubre los pagos VIEJOS que no tienen fila `DigitalReceipt`
(find-or-create, el patrón que ya usa `sendPaymentReceipt`, `payment.tpv.controller.ts:264-283`);
(c) no cambia la forma de ninguna respuesta existente ⇒ cero riesgo para los APK en la calle.
Costo: una llamada de red antes de imprimir (1-3 pagos, irrelevante frente a conectar la impresora).

**D2 — Es un GET aunque materialice el recibo si falta.** El cliente lo llama para LEER la liga; que
el servidor cree la fila es un detalle idempotente (mismo criterio que `ensureDigitalReceiptResponse`,
`payment.tpv.service.ts:128`). Permiso `payments:read`, el mismo de las rutas de historial que ya
existen. No mueve dinero.
⚠️ Corrección a una cita del borrador: `sendPaymentReceipt` (`payment.tpv.controller.ts:283`) NO usa
este generador — usa `generateAndStoreReceipt` (`receipt.dashboard.service.ts:48`), cuya búsqueda no
lleva ni el `FOR UPDATE` ni el `orderBy`. Son **dos generadores distintos** y con duplicados
históricos podrían elegir llaves distintas. Se declara como hallazgo aparte; no se toca aquí.

**D3 — El ticket nunca se bloquea, y el aviso NO miente.** Si no se puede obtener la liga, el ticket
sale **sin QR y sin la leyenda** y la app lo dice. 🔴 Pero un 403/404/500 **no es «sin conexión»**:
el aviso distingue *no hay red* de *el servidor rechazó/falló*, y la llamada lleva **timeout explícito
(5 s)** — sin él, un servidor lento bloquea una impresión que debería salir igual. El aviso se muestra
**después** de imprimir, para no retrasar el papel.

**D4 — Tier: core, gratis, sin interruptor.** No es capacidad nueva: es que el ticket ya existente
salga completo. Un QR que lleva al recibo del cliente no se cobra ni se apaga.

**D5 — El ticket reimpreso NO se marca «COPIA» en este trabajo.** Es una decisión de producto aparte
(y de las que piden comparar con el mercado); meterla aquí es ensanchar el alcance que el founder
aprobó. Queda declarada como pregunta abierta.

**D6 — MCP: no aplica.** No hay capacidad de negocio nueva. (Exponer «dame la liga del recibo de este
pago» como tool sería útil pero es trabajo aparte; se declara, no se cuela.)

---

## 3. Tareas

### Fase A — Servidor (va primero; se despliega en minutos)

- **A1.** Módulo **NUEVO** `src/services/shared/receiptForPayment.service.ts` con
  `getReceiptForPayment(venueId, paymentId)`: verifica pertenencia al venue (404 si no) y **delega
  siempre** en `generateDigitalReceipt(paymentId)` — que ya es find-or-create bajo `FOR UPDATE` y
  elige el recibo MÁS ANTIGUO (`digitalReceipt.tpv.service.ts:92-100`). 🔴 **Nada de búsqueda propia:**
  un `findFirst` sin ese `orderBy` puede devolver OTRA llave cuando hay duplicados históricos.
  Después resuelve `resolveAutofacturaAvailable(payment.orderId)`.
  🔴 **Módulo nuevo, no dentro de `digitalReceipt.tpv.service.ts`:** ese archivo es importado por
  `payment.tpv.service.ts:6`, así que importar desde él el mapper cerraría un **ciclo**. Además evita
  editar `payment.tpv.service.ts`, que otra sesión está tocando ahora mismo.
- **A1-bis.** 🔴 **La respuesta se arma campo por campo: `{ accessKey, receiptUrl, autofacturaAvailable }`.**
  `mapDigitalReceiptResponse` hace `...receipt` (`payment.tpv.service.ts:102`), así que pasarle la fila
  completa filtraría `dataSnapshot` (el ticket ENTERO en JSON) más `recipientEmail` y `recipientPhone`
  — datos personales del cliente, a una app que sólo necesita una URL.
- **A2.** Ruta mobile `GET /venues/:venueId/payments/:paymentId/receipt` (`mobile.routes.ts`, junto a
  `/transactions/:paymentId`), `authenticateTokenMiddleware` + `checkPermission('payments:read')`.
- **A3.** Ruta TPV equivalente en `tpv.routes.ts` (junto a `/payments/:paymentId/send-receipt`),
  mismo permiso.
- **A4.** Tests (TDD, primero en rojo): pago inexistente → 404; pago de OTRO venue → 404 y **la FORMA
  de la consulta lleva `venueId`** (un mock que devuelve `null` pasaría igual sin el filtro);
  se delega en `generateDigitalReceipt` y **no** se hace `findFirst` propio; el cuerpo trae
  exactamente las 3 llaves y **NO** `dataSnapshot`/`recipientEmail`/`recipientPhone`;
  autofactura apagada → `false`; si la generación falla → el error sube (la app degrada, ver D3).
  Supertest en los DOS namespaces: **401** sin token, **403** real de un rol sin `payments:read`,
  y **404** para un usuario cuyo token es de otro venue.

### Fase B — avoqado-android + avoqado-ios (juntos, regla dura de paridad)

- **B1.** Android: `Transaction`/`TransactionDetail` acepta `receiptUrl` + `autofacturaAvailable`;
  `TransactionsViewModel.printTransactionReceipt:316` pide el endpoint de A2 antes de imprimir y
  `toReceiptData:481` los pasa a `ReceiptData`.
- **B2.** Android: la leyenda del QR usa `autofacturaAvailable` (hoy siempre dice «y factura»,
  `ESCPOSPrinter.kt:680`) — así el ticket no promete facturar donde no se puede.
- **B3.** Android: «Imprimir en TPV» manda `receiptUrl` y `autofacturaAvailable`
  (`TerminalPaymentService.kt:742-774`).
- **B4.** iOS: espejo exacto de B1-B3 (`NewReceiptSheet.swift:96`, `TransactionDetailView.swift:290`,
  `TerminalPaymentService.swift`), con los MISMOS textos en español.
- **B5.** Aviso de D3 en las dos apps cuando no se pudo obtener la liga.
- **B6.** Tests en ambas: `toReceiptData`/`buildReceiptData` con URL → el `ReceiptData` la lleva; sin
  URL → no lleva ni URL ni leyenda; `autofacturaAvailable=false` → leyenda sin «y factura».

### Fase C — avoqado-tpv (al final: camino del dinero, firma de días)

- **C1.** `printPaymentHistoryReceipt` (`PrinterManager.kt:1345`) acepta `receiptUrl` y
  `autofacturaAvailable` y emite el bloque QR reusando `generateQrBitmap` + `centerBitmap`.
- ~~**C2.** `AngelPayTicketBuilder.buildHistoryTicket:404` igual, para Nexgo.~~ 🔴 **FUERA, con razón:**
  ese camino no es la reimpresión del historial sino «Reconciliación con el Procesador»
  (`AngelPaySdkPostOperationsAdapter.kt:173`), que imprime una `UnifiedTransaction` **del SDK** —
  puede no tener un `Payment` de Avoqado detrás, así que no hay de dónde sacar una liga sin
  inventarla. La reimpresión que reportó el cliente sale de `PaymentsViewModel` →
  `printPaymentHistoryReceipt`, que sí quedó cubierta.
- **C3.** `PaymentsViewModel.printSelectedPayments:468` pide el endpoint de A3 por cada pago
  seleccionado antes de imprimir; si falla, imprime sin QR y avisa (D3).
- **C4.** Arreglar el defecto 1. 🔴 Y el arreglo correcto NO es sólo `isNullOrBlank()`: **la leyenda se
  imprime únicamente si el bitmap del QR se generó**. `generateQrBitmap` puede devolver `null`
  (`PrinterManager.kt:775`) aun con una URL válida, así que validar la cadena no basta — hay que
  condicionar el texto al bitmap, y probar ese caso (URL presente + bitmap nulo ⇒ ni QR ni leyenda).
- **C5.** `HomeViewModel.kt:1204` (impresión remota) pasa `autofacturaAvailable` del payload.
- **C6.** Variantes `sandbox/` y `production/` sincronizadas; `CHANGELOG.md` bajo `[Unreleased]`.
- **C7.** Tests: la plantilla del historial con URL emite los bytes del QR; sin URL no emite ni QR ni
  leyenda; cadena vacía tampoco (el defecto 1, con su prueba).

### Fase D — Verificación

- Servidor: suite de las suites tocadas + `npx tsc -p tsconfig.typecheck.json` por `avq-verify`.
- Android: `./gradlew testDebugUnitTest` por `avq-verify`; iOS: **`xcodebuild test`**, no sólo `build`
  — compilar no ejecuta las pruebas de B6.
- TPV: `testSandboxDebugUnitTest` + `compileProductionDebugKotlin` + `lint`.
- **Cada arreglo se rompe a propósito una vez** para comprobar que la prueba que lo guarda falla.
- **Matriz de versiones** (los cuatro repos no se despliegan juntos), declarada y probada donde se pueda:

  | POS | TPV | Qué pasa |
  |---|---|---|
  | nuevo | viejo | el POS manda `receiptUrl`/`autofacturaAvailable`; el TPV viejo ignora el segundo ⇒ QR sí, leyenda siempre «y factura». Degradación aceptada |
  | viejo | nuevo | el TPV no recibe la URL en la impresión remota ⇒ ticket sin QR, como hoy. Sin regresión |
  | cualquiera | cualquiera | servidor nuevo: el endpoint sólo lo llama quien lo conoce; ninguna respuesta existente cambia |

- ⬜ QA en hardware (Sunmi D3 / PAX / iPad). 🔴 El criterio NO es «escanear hasta ver Facturar»:
  eso sólo aplica a un venue con autofactura y a un ticket aún NO facturado. Los tres casos a probar:
  (a) venue con autofactura, ticket sin facturar → QR + leyenda «y factura» + botón Facturar;
  (b) venue con autofactura, ticket YA facturado → el portal muestra la factura existente, no el botón;
  (c) venue SIN autofactura → QR + leyenda de recibo, sin promesa de factura.
  **Esto no lo puede hacer ningún modelo — queda declarado.**

---

## 4. Orden de despliegue

Servidor primero (minutos) → APK de android (Play, horas) → iOS (revisión de Apple) → TPV (firma
PAX, 3-5 días). Los clientes viejos no se rompen: nada se quita de ninguna respuesta, y el endpoint
nuevo sólo lo llama quien lo conoce.

## 5. Fuera de alcance (declarado)

- «COPIA/DUPLICADO» en el ticket reimpreso (D5).
- Tool del MCP para la liga del recibo (D6).
- 🔴 **El recibo creado HOY para un pago VIEJO puede mostrar el nombre ACTUAL del producto.**
  Verificado en `digitalReceipt.tpv.service.ts:225`: `productName: item.product?.name || item.productName`
  prefiere el catálogo vivo sobre el nombre congelado en la línea (y `:235` hace lo mismo con los
  modificadores). **El dinero NO se distorsiona** — `amount`, `subtotal`, `total`, `unitPrice` salen de
  las filas históricas de `Payment`/`Order`/`OrderItem` —, pero si el negocio renombró un producto, un
  recibo generado hoy dirá el nombre nuevo. Es preexistente (afecta igual a `ensureDigitalReceiptResponse`
  en el camino del cobro) y el orden correcto sería el inverso. Arreglo de una línea, riesgo en el
  camino del dinero: va en su propio trabajo.
- **Dos generadores de recibo conviven** (`generateDigitalReceipt` vs `generateAndStoreReceipt`) y con
  duplicados históricos pueden elegir llaves distintas. Este plan usa siempre el primero.

---

## 6. Auditoría de Codex (gpt-6-astra, 11-sep) — 11 hallazgos, adjudicados

| # | Hallazgo | Veredicto |
|---|---|---|
| 1 | A1 cerraba un ciclo de imports | ✅ aceptado → módulo nuevo en `shared/` (A1) |
| 2 | El mapper hace `...receipt` y filtraría `dataSnapshot` + datos personales | ✅ aceptado, y pesa más de lo que decía: **A1-bis** |
| 3 | Delegar en el generador que ya ordena por el más antiguo | ✅ aceptado, con prueba de que no hay búsqueda propia |
| 4 | `sendPaymentReceipt` NO usa ese generador (mi cita era falsa) | ✅ corregido en D2 + declarado como hallazgo aparte |
| 5 | D3 llamaba «sin conexión» a cualquier fallo; sin timeout | ✅ aceptado → D3 reescrito (timeout 5 s, aviso que distingue) |
| 6 | C4: la leyenda debe depender del BITMAP, no de la URL | ✅ aceptado, es mejor que lo que yo tenía |
| 7 | Compatibilidad entre versiones sin definir | ✅ aceptado → matriz en Fase D |
| 8 | El QA «hasta ver Facturar» no es universal | ✅ aceptado → tres casos (a/b/c) |
| 9 | Un recibo creado hoy usa datos de hoy | ✅ **verificado en el código**: el dinero NO cambia, el NOMBRE del producto sí. Declarado, no bloquea |
| 10 | Faltaban 401 y usuario de otro venue | ✅ aceptado → A4 |
| 11 | Certezas sobre los clientes por encima de la evidencia; iOS sólo compilaba | ✅ aceptado → `xcodebuild test` en Fase D |

Nada se rechazó. Los 11 entraron al plan.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex` (consult) | Independent 2nd opinion | 1 | ADDRESSED | 11 hallazgos, 11 incorporados (0 rechazados) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

- **CODEX:** ciclo de imports, fuga de `dataSnapshot`/datos personales, leyenda atada al bitmap, matriz
  de versiones, timeout del cliente y criterio real de QA — todo corregido en el plan antes de construir.
- **VERDICT:** alcance aprobado por el founder; plan corregido tras auditoría externa. Listo para ejecutar.

NO UNRESOLVED DECISIONS
- La carrera del PRIMER ticket: `printReceipt` captura el estado al inicio y si el recibo aún no llegó
  del backend, el ticket de cobro sale sin QR (`production/PaymentViewModel.kt:7565`). Es un tercer
  defecto real, de otro camino; se reporta aparte.
- «Reintentar» tras un error de impresión no imprime nada en el TPV (`PaymentScreen.kt:945` contra el
  guard de `PaymentViewModel.kt:7566`).
