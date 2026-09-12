# Revisión de lo NO commiteado en `avoqado-ios` (11-sep-2026)

Sólo lectura. `git diff HEAD` + lectura completa de los `??`. Árbol: `/Users/amieva/Documents/Programming/Avoqado/avoqado-ios`, rama `main`.
Regla leída primero: `/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/.claude/rules/cobro-remoto-pos-a-tpv.md` (36 líneas, también sin commitear).

---

## 0. El titular, antes del inventario

🔴 **La mitad «cancelación» del circuito (C.4 · C.6 · H.5) está DECLARADA pero NO IMPLEMENTADA: son cuerpos vacíos que devuelven una constante.** No es una opinión de estilo — son 3 archivos nuevos enteros (`OrderCancelDecision.swift`, `PendingOrderCancelCoordinator.swift`, `PendingOrderCancelStore.swift`), 3 métodos de `TerminalPaymentService`, 4 métodos de `PaymentFlowViewModel`, 10 constantes de texto en `""` y `CardChargeDecision.admissionRejectionMessage` devolviendo `nil`. Además **no existe la migración GRDB** de la tabla `pendingOrderCancel`.

Consecuencia inmediata: **los tests `OrderCancelDecisionTests` (281 líneas), `OrderCancelFlowTests` (727) y `PendingOrderCancelStoreTests` (185) no pueden estar en verde** — compilan (las firmas existen) y fallan en ejecución. Cualquier reporte que diga «iOS al día con Android» sobre este árbol es falso. Encaja con lo que el propio `CLAUDE.md` del workspace anota para el 11-sep: *«Lápida de admisión (H.5/H.6) hecha y probada, parche pendiente de aplicar (el clasificador bloqueó `git apply` a la sesión)»* y *«En curso: … la cancelación durable de Android e iOS»*.

La OTRA mitad —el cobro, la llave durable, el 409 correlacionado, la reconciliación— **sí está implementada y con pruebas reales**. El riesgo no es que falte: es que lo que sí se aplicó CAMBIÓ la política de `mustReconcile` contando con una lápida de servidor que no está desplegada (P1-1).

---

## 1. Inventario de lo leído

### A. Circuito de cobro remoto (prioridad)

| Archivo | Qué hace en este árbol |
|---|---|
| `Services/TerminalPaymentService.swift` (816 l., 1447 cambiadas) | POST del cobro con llave durable ANTES de la red, watchdog de 330 s, `resolveOutcome` con single-flight (`RecoveryFlight`), 409 correlacionado. 🔴 `cancelPayment`, `cancelIdentity`, `acknowledgeCancelVerdict` = **stubs** |
| `Payment/CardChargeOutcome.swift` (365 l.) | Decisión pura del dinero. Añade `CreationRejection`, `refusedForAnotherRequest`, `busyMessage`, `unresolvedKeyAfterStaleResult`, códigos de lápida. 🔴 `admissionRejectionMessage` = stub; 4 textos en `""` |
| `Payment/OrderCancelDecision.swift` (86 l., **nuevo**) | Veredicto estricto de cancelar + respuesta al DELETE. 🔴 **todo stub** |
| `Payment/PendingOrderCancelCoordinator.swift` (62 l., **nuevo**) | Conductor de la intención durable. 🔴 **todo stub** |
| `Services/Database/PendingOrderCancelStore.swift` (115 l., **nuevo**) | Almacén GRDB de la intención. 🔴 **todo stub + sin migración** |
| `Payment/PaymentFlowViewModel.swift` | `chargeAgainDespiteUndetermined` → siempre `false`; `undeterminedRequestId` sólo se adopta si el desenlace NO es heredado; single-flight de recuperación (`recoveryRequestId`); `currentPaymentId = paymentId ?? transactionId`; **cambio de efectivo = recibido − cobrado**; `cancelChargeAndOrder`/`recheckPendingCancel`/`leavePendingCancel` casi vacíos |
| `Payment/PaymentModels.swift` | Estados nuevos `.cancelling` / `.cancelPending` + su `==` |
| `Payment/PaymentFlowView.swift` | Los dos estados nuevos renderizan **`EmptyView()`** |
| `Payment/PaymentResultViews.swift` | **Se retira el botón «Cobrar de nuevo»** y su alerta de la pantalla «Cobro sin confirmar» |
| `Services/SecureStorage.swift` | La llave pasa de `String` a un CONTEXTO JSON (`venueId`, `terminalId`, importes) con escritura Keychain comprobada (`writePaymentValue`) y `persistPendingCardCharge` que se niega a pisar una llave viva |
| `Services/APIClient.swift` | `APIBusinessErrorDetails` (+`requestId`) y `APITerminalBlockingRequest`; `parse` lee `blockingRequest` en raíz o bajo `details` |
| `Services/OrderRepository.swift` | `cancelOrder(orderId:venueId:reason:background:)` con venue EXPLÍCITO, `preserveBusinessErrorPayload` y timeout de 15 s |
| `Protocols/Repositories.swift` | `protocol OrderCanceling` (seam de pruebas del DELETE) |
| `avoqado_iosApp.swift` | `@MainActor` en `AppState`; arranque/parada del coordinador de INVENTARIO (no del de cancelaciones) |
| Tests | `CardChargeDecisionTests` (+~90 l.), `PaymentFlowUndeterminedTests` (+~390), `TerminalBusyRejectionTests`, `OrderCancelDecisionTests`, `OrderCancelFlowTests`, `PendingOrderCancelStoreTests`, `PoliticaDeReintentoTests`, `RespuestaHttpTests` |

### B. Otras sesiones

| Archivo | Qué hace |
|---|---|
| `CashDrawer/Services/CashDrawerRepository.swift` | `esMiPropiaCaja` decide ANTES de mudar nada; `colaTrasAdoptarLaCaja` (pura) con ventana `openedAt` para caja ajena y marcado de huérfanos; `esLaPropia` propagado por `ResultadoDeLaApertura`/`DesenlaceDelPaso` |
| `CashDrawer/Services/ConteoSospechoso.swift` (**nuevo**) | Pregunta —no bloqueo— cuando el conteo coincide con la suma de los últimos retiros o con el efectivo cobrado |
| `CashDrawer/Views/CloseDrawerSheet.swift` | Instrucción de qué contar + lista de «lo que ya sacaste hoy» |
| `Models/Money.swift` (**nuevo**) | `formatMoney` con locale FIJO `es_MX` y separador de miles |
| `Inventory/*` (7 archivos) + `ConteoEnCurso*.swift`, `InventoryCountSyncCoordinator.swift` (**nuevos**, 1591 l.) | Borrador durable del conteo escrito antes de la red, decodificación tolerante a llaves faltantes, revisión optimista, coordinador de replay con vida de sesión |
| `Printing/Services/ReceiptLogoCache.swift` | Arregla el `replaceItemAt` sobre destino inexistente (la 1ª descarga de cada venue) + inyección para tests |
| `Printing/Models/PrinterModels.swift`, `PrinterConfigSheet.swift` | El rol «Bar» deja de ofrecerse (rol muerto en el ruteo) |
| `Transactions/…/RefundRepository.swift`, `IssueRefundSheet.swift` | Se retira el selector «efectivo / terminal» que nunca viajaba al servidor; se explica qué falta para poder reembolsar |
| `Services/CashPaymentRepository.swift` | Lee `amount`/`tipAmount`/`changeCents` del server (`centavosNoNegativos`) |
| `POS/Views/MainTabView.swift` | Arranca el coordinador de inventario con el ciclo de vida autenticado |

---

## 2. Hallazgos

### P1

---

#### P1-1 · Un 404/422/400 del POST arma una llave durable IRRESOLUBLE y deja el iPad sin poder cobrar NADA (ni efectivo)

`avoqado-ios/Payment/CardChargeOutcome.swift:165-172`

```swift
    static func mustReconcile(_ ending: ChargeWaitEnding, cancelRequested: Bool) -> Bool {
        if cancelRequested { return true }
        switch ending {
        case .http(let code): return isTransportFailure(code) || [400, 404, 409, 422].contains(code)
        case .networkError: return true
        case .ceilingExceeded: return true
        }
    }
```

La versión de `HEAD` era `case .http(let code): return isTransportFailure(code)` — o sea, **el 404/422/400 es nuevo**. El cambio sólo es seguro si el servidor escribe la **lápida de admisión (H.5)**: una fila `FAILED/REJECTED_*` para ese `requestId`. Esa lápida **no está aplicada** (el propio `CLAUDE.md` del workspace: *«Lápida de admisión (H.5/H.6) hecha y probada, parche pendiente de aplicar»*), y el POS tampoco la sabe leer (P1-2).

Escenario, que es el diario y está medido en hardware: la PAX está dormida (DOZE) ⇒ el server contesta **404 `TERMINAL_NOT_CONNECTED`** al crear.

1. `sendPayment` ya escribió la llave durable en Keychain (`TerminalPaymentService.swift:368`).
2. El 409 correlacionado no aplica (es un 404) ⇒ `mustReconcile(.http(404))` = **true** ⇒ `resolveOutcome`.
3. El `GET` devuelve **404 tres veces** (no hay fila) ⇒ `CardChargeDecision.decide` → `.undetermined` (`CardChargeOutcome.swift:274-277`).
4. `TerminalPaymentService.swift:625` **arma la llave**: `if unresolvedRequestId == nil || unresolvedRequestId == requestId { unresolvedRequestId = requestId }`.
5. A partir de ahí **no hay salida**:
   - `TerminalPaymentService.swift:203` → `func forgetUnresolvedCharge() { /* Financial uncertainty cannot be dismissed. */ }` — **no-op**.
   - `PaymentFlowViewModel.swift:2453-2455` → `chargeAgainDespiteUndetermined()` devuelve `false` siempre.
   - `PaymentResultViews.swift` — el botón «Cobrar de nuevo» y su alerta **se borraron** en este mismo diff.
   - «Volver a consultar» vuelve a pedir el GET, que sigue en 404.
6. Y el portero está ANTES de elegir método de pago (`PaymentFlowViewModel.swift:248-251`):

```swift
    private func enterPaymentMethodSelection(amount: Int) {
        guard !blockedByPendingCardCharge(amount: amount) else { return }
        state = .selectingPaymentMethod(amount: amount)
    }
```

⇒ **el cajero tampoco puede cobrar en EFECTIVO.** El iPad queda inservible para vender. En iOS el Keychain sobrevive incluso a borrar y reinstalar la app (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `SecureStorage.swift:206-213`), así que el `pm clear` que se usó en la Sunmi no tiene equivalente barato.

Lo mismo ocurre con **503 `TERMINAL_PAYMENT_ADMISSION_RETRY`**: la constante existe (`CardChargeOutcome.swift:231`) y `admissionRetryDelays` está declarada (`TerminalPaymentService.swift:217`) pero **nadie las lee** — `grep` sobre el árbol da 0 usos en producción. Un 503 de admisión cae por `isTransportFailure` al mismo callejón.

**Por qué ninguna prueba lo caza:** `TerminalBusyRejectionTests` sólo ejercita el 409; `CardChargeDecisionTests:241-247` prueba que `mustReconcile(404)` es `true` —la mitad del cambio— pero **no existe ninguna prueba de punta a punta «POST 404 → GET 404 ×3 → ¿puede el cajero volver a vender?»**. Toda la suite de `PaymentFlowUndeterminedTests` verifica que la llave se CONSERVE; ninguna verifica que se pueda SOLTAR sin servidor cooperante.

> Nota: el 404 sí aparece en `mustReconcile` en la regla del repo como decisión correcta («un 404 del estado durable no prueba ausencia de cargo»). El defecto no es reconciliar — es que **no hay ninguna salida cuando la reconciliación no puede resolver**, y ese estado hoy es alcanzable con un servidor de producción normal.

---

#### P1-2 · La correlación por `details.requestId` está rota en DOS puntos: `APIBusinessError.parse` nunca la rellena, y `CreationRejection` nunca la propaga

`avoqado-ios/Services/APIClient.swift:655-661`

```swift
            details: APIBusinessErrorDetails(
                venueId: details?["venueId"] as? String,
                countId: details?["countId"] as? String,
                expectedRevision: details?["expectedRevision"] as? Int,
                currentRevision: details?["currentRevision"] as? Int,
                status: details?["status"] as? String
            ),
```

El campo `requestId` de `APIBusinessErrorDetails` tiene default `= nil` (`APIClient.swift:589`), así que el inicializador por miembros compila **omitiéndolo en silencio**: `details.requestId` es SIEMPRE `nil` cuando el error viene del servidor.

Eso mata las dos correlaciones que el diseño §C.6/§H.5 declara como su garantía:

- el 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` no puede distinguir «me bloquea MI cobro» de «me bloquea el de OTRO» (`OrderCancelDecision.afterOrderDelete`);
- el rechazo de admisión no puede acreditar «no se creó» (`CardChargeDecision.admissionRejectionMessage`).

Segundo punto de corte, en la traducción del 409 del cobro — `Services/TerminalPaymentService.swift:328-336`:

```swift
    private static func rejection(from error: APIBusinessError) -> CreationRejection {
        CreationRejection(
            code: error.code,
            blockingRequestId: error.blockingRequest?.requestId,
            amountCents: error.blockingRequest?.amountCents,
            ageSeconds: error.blockingRequest?.ageSeconds,
            senderDevice: error.blockingRequest?.senderDevice
        )
    }
```

`detailsRequestId` no se pasa nunca ⇒ aunque se implementara `admissionRejectionMessage`, recibiría `nil` y devolvería `nil` («sin correlación no acredita nada»), o sea que el arreglo de P1-1 quedaría **inerte**.

**Prueba que lo demuestra y hoy falla:** `avoqado-iosTests/OrderCancelDecisionTests.swift:251-256` (`testElRequestIdDelDetalleSeLeeDelCuerpo`) — parsea `{"details":{"requestId":"req-7"}}` y espera `req-7`; obtiene `nil`.

---

#### P1-3 · `CANCELLED` sin `cancelDisposition` (el server del árbol proyecta `null` cuando el desenlace es final) deja la llave armada para siempre

`avoqado-ios/Payment/CardChargeOutcome.swift:351-364`

```swift
    private static func fromTerminalStatus(status: String, paymentId: String?, cancelDisposition: String?) -> CardChargeOutcome {
        switch status {
        case "COMPLETED":
            return .undetermined(message: undeterminedMessage)
        case "FAILED":
            return .notCharged(message: "El cobro fue rechazado. No se cobró la tarjeta.")
        case "CANCELLED" where cancelDisposition == "ACCEPTED":
            return .notCharged(message: "El cobro se canceló. No se cobró la tarjeta.")
        // TIMED_OUT, UNKNOWN — y cualquier estado que este cliente no conozca todavía.
        // Adivinar aquí es exactamente el bug: se dice que no se sabe.
        default:
            return .undetermined(message: undeterminedMessage)
        }
    }
```

Un `CANCELLED` con `cancelDisposition` nulo cae al `default` ⇒ `.undetermined` ⇒ llave armada ⇒ **mismo callejón sin salida de P1-1**. La decisión en sí es la correcta por la regla («un `CANCELLED` sin `ACCEPTED` no acredita nada»); lo que falta es la salida.

**Y es el gesto DIARIO:** el propio `CLAUDE.md` documenta que al cancelar desde la tablet contra un APK publicado *«La PAX obedece al instante pero no contesta la disposición del cancel»*. O sea: cada cancelación contra una terminal en la calle produce hoy un iPad bloqueado sin salida.

Ninguna prueba lo cubre porque `CardChargeDecisionTests:126-131` (`testLegacyCancellationDoesNotProveNoCharge`) verifica exactamente esto — y lo da por bueno, sin comprobar qué le queda al cajero después.

---

#### P1-4 · `getPaymentStatus` DESCARTA `outcome`, `outcomeEvidence`, `failureCode`, `orderId` y `reconciliationRequired`: el contrato C.1 llega al POS y se tira a la basura

`avoqado-ios/Services/TerminalPaymentService.swift:509-511`

```swift
            let dto = try JSONDecoder().decode(TerminalPaymentStatusDTO.self, from: data)
            print("💳 [Terminal] Estado \(requestId) → \(dto.status) (inProgress=\(dto.inProgress))")
            return .known(status: dto.status, inProgress: dto.inProgress, paymentId: dto.paymentId, cancelDisposition: dto.cancelDisposition)
```

El DTO SÍ los decodifica (`TerminalPaymentService.swift:76-81`: `orderId`, `failureCode`, `outcome`, `outcomeEvidence`, `evidenceClass`, `reconciliationRequired`) y `ChargeStatusProbe.known` SÍ los acepta (`CardChargeOutcome.swift:25-34`), pero el único constructor de producción los omite. Consecuencias medibles:

1. Con el servidor nuevo desplegado, `OrderCancelDecision.verdict` (cuyo doc dice literalmente que los lee) recibiría siempre `nil` ⇒ **todo sería `.pendiente`** y ninguna orden se cancelaría jamás.
2. La regla del brief («`FAILED`/"no se cobró" sólo con EVIDENCIA `PRE_AUTHORIZATION`/`PROCESSOR_DECLINED`») **no se puede cumplir**: `fromTerminalStatus` acepta cualquier `FAILED` pelado como «no se cobró» y suelta la llave, habilitando un segundo cobro. Hoy producción devuelve `FAILED/TPV_ERROR` crudo, que es exactamente «no consta nada».

La divergencia está *declarada* en `OrderCancelDecisionTests.swift:99-105` («la regla del reintento es menos estricta a propósito»), pero con el probe mutilado no hay forma de endurecerla aunque el servidor empiece a mandar la evidencia. Es una línea, y es la que separa las dos reglas.

---

#### P1-5 · C.4 (cancelación durable) no existe: `cancelChargeAndOrder` es fire-and-forget, sin persistir nada antes del POST

`avoqado-ios/Payment/PaymentFlowViewModel.swift:1923-1931`

```swift
    func cancelChargeAndOrder() async {
        Task { await TerminalPaymentService.shared.cancelCurrentPayment() }
        invalidateTerminalSend()
        goBack()
    }

    func recheckPendingCancel() async {}

    func leavePendingCancel() {}
```

y `avoqado-ios/Services/TerminalPaymentService.swift:738-754`

```swift
    @discardableResult
    func cancelPayment(
        requestId: String, venueId: String, terminalId: String,
        reason: String? = nil, timeout: TimeInterval = 15, background: Bool = false
    ) async -> TerminalCancelAck {
        .transportFailure(noNetwork: false)
    }

    func cancelIdentity(for requestId: String? = nil) -> TerminalCancelIdentity? {
        nil
    }

    func acknowledgeCancelVerdict(_ verdict: ChargeCancelVerdict, requestId: String) {}
```

Invariante #1 del brief violado: **no se escribe nada durable antes del POST de cancel**. Y el único camino real de la UI (`PaymentFlowView.swift:234-244`) ni siquiera pasa por aquí: llama directo a `cancelCurrentPayment()` dentro de un `Task {}` suelto y navega. Si el proceso muere, o no hay red, **la intención de cancelar se evapora**: no hay reproducción, no hay bandeja, no hay `attentionCount`.

El almacén completo es fachada — `Services/Database/PendingOrderCancelStore.swift:81-114`:

```swift
    func enqueueOrReuse(_ record: PendingOrderCancelRecord) throws -> PendingOrderCancelRecord {
        record
    }

    func find(requestId: String) throws -> PendingOrderCancelRecord? {
        nil
    }
    …
    func due(now: Date, limit: Int) throws -> [PendingOrderCancelRecord] { [] }
    func attentionCount() throws -> Int { 0 }
```

y **no hay migración** que cree la tabla: la última registrada es `v15_pendingPaymentCustomer` (`Services/Database/DatabaseManager.swift:366`); `grep pendingOrderCancel Services/Database/` sólo encuentra el `databaseTableName` del propio struct. `PendingOrderCancelStoreTests` corre el migrador REAL (`PendingOrderCancelStoreTests.swift:20-23`) ⇒ falla.

Igual el coordinador (`PendingOrderCancelCoordinator.swift:46-61`): `start` devuelve `Task {}`, `process` devuelve `.pending(noNetwork: false)`, `runDue` no hace nada — y **nadie lo arranca**: `avoqado_iosApp.swift` arranca `InventoryCountSyncCoordinator`, no éste.

---

#### P1-6 · Los textos del flujo de cancelar son `""` y `PendingOrderCancelPhase` degrada al estado equivocado

`avoqado-ios/Payment/OrderCancelDecision.swift:48-59`

```swift
    static let cancellingMessage = ""
    static let pendingTitle = ""
    static let pendingMessage = ""
    static let recheckLabel = ""
    static let leavePendingLabel = ""
    static let cancelSaleLabel = ""
    static let noNetworkMessage = ""
    static let saveFailedMessage = ""
    static let chargedMessage = ""
    static let blockedByChargeMessage = ""

    static func bannerText(count: Int) -> String { "" }
```

Idem `CardChargeOutcome.swift:234-237` (`terminalNotConnectedNotice`, `orderCancelledNotice`, `orderAlreadyPaidNotice`, `orderNotFoundNotice` = `""`).

Con la misma familia, `Services/Database/PendingOrderCancelStore.swift:20-25`:

```swift
    static func parse(_ raw: String) -> PendingOrderCancelPhase {
        PendingOrderCancelPhase(rawValue: raw) ?? .requestCancel
    }

    var isFinal: Bool { false }
    var isAutomatic: Bool { false }
```

Una fase guardada por una versión FUTURA se lee como `.requestCancel` ⇒ el aparato **volvería a mandar el cancel** de algo que otra versión ya resolvió. El test fija lo contrario (`OrderCancelDecisionTests.swift:260-264`: debe caer en `.needsReview`, que es el lado seguro). `isFinal`/`isAutomatic` devolviendo `false` para TODA fase significa además que `closed`/`charged` nunca se darían por terminadas.

---

### P2

#### P2-1 · Los estados `.cancelling` / `.cancelPending` pintan pantalla EN BLANCO y el botón atrás no sale de ahí

`avoqado-ios/Payment/PaymentFlowView.swift:401-406`

```swift
            case .cancelling:
                EmptyView()

            case .cancelPending:
                EmptyView()
```

combinado con `avoqado-ios/Payment/PaymentFlowViewModel.swift:1234-1237`:

```swift
        case .cancelling, .cancelPending:
            // 🔴 Navegar NO resuelve una cancelación: la intención vive en disco. La salida de
            // «Cancelación pendiente» es «Salir (queda pendiente)», que cierra el flujo sin borrar nada.
            break
```

Pantalla vacía + `goBack()` que no hace nada + la salida prometida (`leavePendingCancel`) vacía = trampa dura. Hoy es **inalcanzable** (nadie asigna esos estados en producción), por eso es P2 y no P1; pero el día que se conecte `cancelChargeAndOrder` sin la vista, el cajero se queda mirando un rectángulo blanco a media venta.

#### P2-2 · `StockCountType` no tolera un valor nuevo del servidor — el mismo hueco que ya se cerró en `StockCountStatus`

`avoqado-ios/Inventory/Models/InventoryModels.swift:68-70` y `94-106`

```swift
enum StockCountType: String, Codable {
    case CYCLE
    case FULL
```

contra su hermano, que sí lo cerró tras pagarlo:

```swift
enum StockCountStatus: String, Codable {
    …
    /// Un estado que esta versión no conoce. 🔴 Sin esto, UNA fila con un valor nuevo del
    /// servidor tumbaba el decode del ARRAY entero y la lista se quedaba vacía.
    case UNKNOWN
```

`StockCount.type` es no opcional (`InventoryModels.swift:127`) ⇒ un tercer tipo de conteo tumba el decode de `StockCountsResponse` entero (lista vacía). Peor: `BorradorDeConteo.type` también es `StockCountType` (`ConteoEnCurso.swift:65`) y el borrador se lee con `try?` ⇒ **el conteo capturado del cajero desaparecería en silencio**, que es literalmente el defecto de Mindform que este trabajo vino a cerrar.

#### P2-3 · `busyMessage` puede imprimir un monto mal firmado

`avoqado-ios/Payment/CardChargeOutcome.swift:252`

```swift
            let amount = String(format: "%d.%02d", amountCents / 100, abs(amountCents % 100))
```

Con `amountCents` negativo (no debería ocurrir, pero viene del cuerpo del servidor sin validar) sale `-1.25` para −125. Cosmético y de baja probabilidad, pero está en la frase que el cajero usa para decidir.

---

### P3

- `PaymentFlowViewModel.swift:2262` — `if case .charged(let result) = outcome, result.alreadyRecovered == true { return }` va ANTES del `guard generation == …`. Es correcto (el consumidor de la recuperación ya lo pintó), pero deja `isProcessingTerminalPayment` en `true` si alguna vez se alcanzara con la generación vigente. Merece un comentario o un `defer`.
- `TerminalPaymentService.swift:197-207` — el doc de `unresolvedRequestId` todavía dice *«o cuando el cajero asume el riesgo explícitamente»*, camino que este diff eliminó. Documentación que miente sobre la ruta del dinero.
- `OnlineTerminal` (`TerminalPaymentService.swift:13-30`) sigue descartando `busy`, como la propia regla anota como pendiente de fase 3.

---

## 3. Respuestas a los puntos pedidos

**(a) Llave durable.** Se escribe **ANTES del POST** ✔ — `TerminalPaymentService.swift:365-373`, y si el Keychain falla se aborta sin autorizar (`throw error // No authorization was sent if the durable journal failed`). Se suelta en `clearMatching` desde `result(from:)` con `.charged` o `.notCharged`, y en el 409 correlacionado.
- Con `FAILED`: **el POS NO exige evidencia**, le basta el status (`CardChargeOutcome.swift:355-356`) — ver P1-4.
- Con `COMPLETED`: sólo con `paymentId` no vacío; un `COMPLETED` pelado queda indeterminado ✔ (`CardChargeOutcome.swift:286-288`, `353-354`).
- Con `CANCELLED` + `ACCEPTED`: suelta ✔. **Con `cancelDisposition` nulo: NO suelta, y la tablet queda trabada para siempre** — ver P1-3 + P1-1.

**(b) 409 `TERMINAL_BUSY` correlacionado.** Correcto. Función: `CardChargeDecision.refusedForAnotherRequest` (`CardChargeOutcome.swift:210-215`) — exige `code == TERMINAL_BUSY` **y** un `blockingRequestId` no vacío **y** distinto del mío; se consume en `TerminalPaymentService.swift:446-452`. El código sale de `APIBusinessError.status`, nunca del texto. Tests: `TerminalBusyRejectionTests.swift:68-100` (las tres direcciones, y `XCTAssertEqual(calls, ["POST"])` garantiza que no se consulta) + `CardChargeDecisionTests.swift:428-447`.

**(c) Cancelación durable (C.4).** **No implementada** (P1-5). No se persiste nada antes del POST; no hay reproducción al volver la red; no hay `orderId`/`requestId` propios porque no hay registro. El 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` (C.6) tiene su constante (`OrderCancelDecision.swift:63`) y su rama en `afterOrderDelete`… que es un stub, y su correlación está rota (P1-2).
**Qué hace iOS con la ORDEN al cancelar el cobro: nada.** `cancelChargeAndOrder` sólo manda el cancel y navega; `adoptFreshlyCreatedOrder` / `currentOrderOwnedByThisFlow` (`PaymentFlowViewModel.swift:358`, `1916-1921`) **no los llama ningún código de producción** — sólo `OrderCancelFlowTests.swift:134`. Android sí cancela la orden en paralelo. **Divergen.**

**(d) Reintento automático de POSTs de dinero.** No hay nada equivalente a `retryOnConnectionFailure`. El único reenvío es el del refresh 401 (`APIClient.swift:217-238`), que reenvía el MISMO cuerpo y por tanto el MISMO `requestId` — seguro por la idempotencia del servidor, pero conviene saberlo. Un fallo de conexión **nunca** se lee como «nunca se envió»: `waitEnding` manda todo lo que no sea un código HTTP a `.networkError` (`TerminalPaymentService.swift:476-491`) y `mustReconcile` lo envía a consultar. ✔ alineado con el pendiente de la regla.

**(e) Código HTTP del error tipado.** ✔ en las dos familias: `waitEnding` hace pattern matching sobre `APIBusinessError`/`APIError` sin tocar texto; `RespuestaHttp.codigo(de:)` (`Inventory/Services/InventoryRepository.swift:434-442`) antepone explícitamente `APIBusinessError`. Tests: `RespuestaHttpTests.swift:15-36`. Cero `contains("404")` en el árbol tocado.

**(f) Decodificación tolerante.** ✔ en pagos: `TerminalPaymentStatusDTO` (`TerminalPaymentService.swift:71-85`) usa `String` para `status`, `cancelDisposition`, `failureCode`, `outcome`, `outcomeEvidence` y `evidenceClass` — ningún `enum` estricto; `TerminalPaymentResult.status` también es `String` (línea 34). El único `enum: String, Codable` de `PaymentModels.swift` es `PanelMode` (línea 42), que no viene de estas rutas. ✖ en inventario: `StockCountType` (P2-2).

**(g) Paridad con Android / con la regla.**

| Punto | Android (según la regla y el CLAUDE.md) | iOS en este árbol |
|---|---|---|
| Cancela la orden en paralelo al cancelar el cobro | sí | **no** — nunca toca la orden |
| Cancel fire-and-forget | sí, pero **con intención durable detrás** | fire-and-forget **sin** nada durable |
| Intención durable + bandeja «cancelaciones pendientes» | `CancelacionesPendientesStore` + coordinator | stubs, sin tabla, sin arranque |
| `CancelacionDeCobro.verdict` estricto | implementado | `return .pendiente` |
| Lápida de admisión (H.5) correlacionada | implementada | `return nil` |
| 409 `TERMINAL_BUSY` correlacionado | sí | **sí, paridad real** |
| `outcome`/`outcomeEvidence` leídos del estado durable | sí | **se descartan** (P1-4) |
| Salida del «cobro sin confirmar» | — | iOS la eliminó del todo (P1-1) |
| Textos espejo palabra por palabra | definidos | `""` |

**(h) Offline, por feature tocada.**
- *Cobro con terminal:* qué ve el usuario ⇒ pantalla honesta «Estamos confirmando el cobro. No vuelvas a pasar la tarjeta» ✔; qué se pierde si muere el proceso entre toque y POST ⇒ nada, la llave y el contexto (venue, terminal, importes) están en Keychain antes ✔; orden de replay ⇒ no aplica (no hay cola de cobros con terminal); qué pasa al volver la red ⇒ `resolveOutcome` con el venue ORIGINAL del contexto ✔. **Clasificación: «degrada y lo DICE» — salvo que hoy degrada sin salida (P1-1/P1-3).**
- *Cancelar un cobro:* sin red **se pierde entera** — no hay persistencia ni reintento. **Hoy es «online-only» de facto, y la UI no lo dice.** Es la brecha con `todo-funciona-sin-red.md`.
- *Cobro en efectivo:* ya tenía cola durable; este diff sólo cambia el cálculo del cambio (mejora real, ver §4).
- *Caja:* la mudanza de cola por ventana `openedAt` y el marcado de huérfanos (`colaTrasAdoptarLaCaja`) contestan explícitamente las cuatro preguntas ✔.
- *Conteo de inventario:* borrador en disco antes de la red, coordinador de replay con vida de sesión, revisión optimista ✔.

**(i) Tests.**
- **Que NO pueden pasar hoy** (implementación ausente): `OrderCancelDecisionTests` (los 20 casos salvo los de `CardChargeDecision` puro), `OrderCancelFlowTests` (727 l.), `PendingOrderCancelStoreTests` (sin tabla), y `OrderCancelDecisionTests:251-256` por P1-2.
- **Que pasa por el motivo equivocado:** `OrderCancelDecisionTests.swift:99-105` — el caso que fija la divergencia entre la regla del reintento y la de cancelar «pasa» con `verdict` siendo `return .pendiente` constante: la aserción `XCTAssertEqual(verdict(failed), .pendiente)` es cierta para TODA entrada, así que no guarda nada mientras el stub viva. Mismo problema en `testUn404YUnaConsultaFallidaNoPruebanNada` (línea 132) y en los 5 casos que esperan `.pendiente`: **12 de los 20 casos de veredicto pasarían con el stub**, y sólo los 8 que esperan `.noSeCobro`/`.seCobro` lo destapan. Si alguien «arregla» el rojo tocando sólo esos 8, la regla queda a medias sin que nada avise.
- **Que sí guardan lo que dicen** (verificado leyendo la implementación): `TerminalBusyRejectionTests:68-80` (la aserción `calls == ["POST"]` es la que impide reintroducir la consulta), `PaymentFlowUndeterminedTests:testSuccessWithoutPaymentIdRecoversStatusAndRetainsJournal` (cuenta las consultas), `testOldRecoveryDoesNotClearNewerIdentityAndUsesOriginalVenue` (comprueba el ENDPOINT, no sólo el resultado), `testDurableJournalRetainsMoneyContextAndRejectsReplacement`.

---

## 4. Lo que está BIEN y vale confirmar

1. **La llave durable se escribe antes de tocar la red, y si el Keychain falla no se autoriza nada** — `TerminalPaymentService.swift:365-373`. Es el invariante #1 del brief, cumplido de la forma estricta.
2. **`persistPendingCardCharge` se niega a pisar una llave viva** (`SecureStorage.swift:193-200`) y `writePaymentValue` comprueba el `OSStatus` en vez de tragárselo — un Keychain lleno ya no se lee como «guardado».
3. **La ranura durable es una y gana el cobro que todavía puede tener dinero encima** — `CardChargeDecision.unresolvedKeyAfterStaleResult` (`CardChargeOutcome.swift:330-341`) + su uso en `PaymentFlowViewModel.swift:2276-2283`. Es el caso «cancelé y llegó tarde», bien resuelto.
4. **Single-flight real de la recuperación**, con la distinción entre el consumidor del POST y el de la reconciliación (`RecoveryFlight`, `TerminalPaymentService.swift:150-158` y `538-567`), probada con continuaciones y no con sleeps (`PaymentFlowUndeterminedTests`, `testTwoRecoveryCallbacksUseOneCurrentCycle`).
5. **El cambio en efectivo ahora es `recibido − cobrado`** (`PaymentFlowViewModel.swift:952-971`): el `changeCents` del servidor significa otra cosa y valía 0 en el cobro normal, lo que le decía «cambio $0.00» al cajero con dinero del cliente en la mano. `cashTendered` está garantizado ≥ `currentAmount + currentTip` por el guard de la línea 985, así que la resta no puede quedar negativa por construcción.
6. **`currentPaymentId = result.paymentId ?? result.transactionId`** (`PaymentFlowViewModel.swift:2338`): antes se quedaba con el `transactionId` del procesador para el recibo.
7. **`colaTrasAdoptarLaCaja`** (`CashDrawer/Services/CashDrawerRepository.swift:1622-1659`): función pura, la identidad se decide ANTES de mudar nada, el CIERRE nunca viaja a una caja ajena y lo que se queda atrás se MARCA en vez de borrarse o reintentarse eternamente. Es el patrón correcto.
8. **`ReceiptLogoCache.replaceAtomically`** (`Printing/Services/ReceiptLogoCache.swift:79-95`): cierra el `replaceItemAt` sobre destino inexistente que dejaba a cada venue nuevo sin logo para siempre, y limpia el `.tmp` en el `catch`.

---

## 5. Lo que NO pude verificar

- **Nada se compiló ni se ejecutó** (el brief lo prohíbe): que los tests fallen es deducción por lectura de las implementaciones contra las aserciones, no una corrida. Los casos concretos están citados arriba para que se comprueben con una corrida.
- **`OrderCancelFlowTests.swift` (727 líneas)**: leí su uso de las API (`cancelChargeAndOrder`, `cancelCoordinator`, `adoptFreshlyCreatedOrder`, `.cancelPending`) para mapear la brecha, no caso por caso.
- **`InventoryViewModel.swift` (1737 líneas cambiadas) y `InventoryCountSyncCoordinator.swift` (729)**: revisión por muestreo del camino «guardar antes de la red», el borrador tolerante y el arranque/parada de sesión. **No es una auditoría completa** de la revisión optimista ni del replay concurrente; el `CLAUDE.md` los reporta ya revisados y con QA en CPad.
- **El lado servidor**: si `deliveryProvenance`, la lápida H.5 y `outcomeEvidence` están o no desplegados sólo lo leí del `CLAUDE.md` del workspace («parche pendiente de aplicar»), no del repo del server.
- **Hardware**: ninguna celda de la matriz «estado de la terminal × evento» se ejecutó en un iPad real; la regla exige declararlo.
