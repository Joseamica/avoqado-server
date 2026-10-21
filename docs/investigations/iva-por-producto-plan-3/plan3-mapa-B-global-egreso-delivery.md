# Mapa B — Global CFDI, Egreso (nota de crédito), Delivery, Agregados de IVA, Contabilidad, modelo `Cfdi`, tests

Repo leído (read-only): `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto`
(rama `iva-por-producto`, contiene `develop` al 25-sep). Todas las rutas son relativas a esa raíz salvo que se diga otra cosa.

---

## 1. GLOBAL CFDI (factura global al público en general — Flow C)

### 1.1 Entry points

| Punto de entrada | Archivo:línea | Qué hace |
|---|---|---|
| **Job (cron diario 04:00 CDMX)** | `src/jobs/cfdiGlobal.job.ts:31-46` | `CfdiGlobalJob` programa `scheduleJob('cfdi-global', '0 4 * * *', …)`. `run()` (líneas 58-116) lee todos los `FiscalEmisor` con `csdStatus:'ACTIVE'` (líneas 72-84, envuelto en `retry(..., shouldRetryDbConnectionError)` — regla `cron-jobs.md`) y llama `issueGlobalForEmisor` por cada uno, con try/catch por emisor (líneas 92-107) para que el fallo de uno no aborte el resto. |
| **Dashboard (disparo manual)** | `src/controllers/dashboard/cfdi.dashboard.controller.ts:929-1010` (`triggerGlobalCfdiController`) + ruta `POST /venues/:venueId/fiscal/emisores/:emisorId/global` en `src/routes/dashboard.routes.ts:3766-3773`. Gateado por `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:configure')`. Verifica tenencia del emisor (`prisma.fiscalEmisor.findFirst({ id: emisorId, venueId })`, líneas 945-952) antes de llamar a `issueGlobalForEmisor`. Escribe `ActivityLog` `CFDI_GLOBAL_ISSUED` sólo en el caso `STAMPED` (líneas 974-987). |
| **MCP** | **No existe.** `src/mcp/tools/cfdi.ts` sólo registra `cfdi_status` (lectura agregada, incluye `Cfdi` con `isGlobal` mezclado en el conteo por status), `emit_refund_credit_note` y `confirm_order_price_contract`. No hay ninguna tool que dispare o consulte específicamente una factura global (ni `issue_global_cfdi` ni similar). `grep -rn "issueGlobalForEmisor\|CfdiGlobal" src/mcp` no da resultados fuera de lo ya listado. |

### 1.2 Criterio de selección de órdenes (candidatos) — `src/services/fiscal/cfdiGlobal.service.ts`

Función `loadGlobalCandidates` (líneas 328-423, dentro de `defaultDeps`). Una orden entra si **todas** estas condiciones se cumplen:

1. `venueId` = el del emisor (línea 344) — nunca cruza sucursales.
2. `paymentStatus: 'PAID'` (línea 345).
3. `updatedAt` dentro de `[periodStart, periodEnd)` del periodo cerrado (línea 346) — el eje temporal es `Order.updatedAt`, **no** `Cfdi.stampedAt` ni `Order.createdAt`.
4. Tiene **al menos un** `Payment` `COMPLETED`, de tipo elegible (`REGULAR`/`FAST`/`null` — `esCobroElegible`, `src/services/fiscal/cfdi.service.ts:646-648`), cobrado por un `MerchantAccount` **o** `EcommerceMerchant` cuyo `MerchantFiscalConfig` apunte a `fiscalEmisorId: emisorId`, `includeInGlobal: true`, `facturacionEnabled: true` (líneas 350-373).
5. Pasa `filtrosDeExclusion(emisorId, invoiceCashSales)` (líneas 378, definida 455-483): excluye la orden si tiene **cualquier** cobro elegible bajo un comercio "incompatible" (sin `MerchantFiscalConfig`, de OTRO emisor, con `facturacionEnabled:false` o `includeInGlobal:false`) — así una cuenta cobrada por dos comercios de RFC distinto no entra completa bajo ninguno de los dos; y, salvo que `FiscalEmisor.invoiceCashSales===true`, excluye toda orden con **algún** pago `CASH` completado (también descarta mixtos efectivo+tarjeta).
6. **No tiene** un `Cfdi` `STAMPED` con `isGlobal:false` (línea 380-382: `cfdis: { none: { status: 'STAMPED', isGlobal: false } } }`) — así se excluye la orden que ya tiene factura individual.

`GlobalEmisor.invoiceCashSales` (por defecto `false`) y `MerchantFiscalConfig.includeInGlobal` (por defecto `false`, opt-in) son los dos toggles — `prisma/schema.prisma:16357` e `:16395`.

**Campos leídos por orden** (líneas 384-419): `subtotal, taxAmount, total, discountAmount, serviceChargeAmount, promotions(take 1)`, todos sus `payments` COMPLETED elegibles (`method, tenderSatFormaPago, amount, type`) y todos sus `items` con `product.taxRate, product.objetoImp, product.satProductKey, product.satUnitKey` — **la tasa se lee EN VIVO del catálogo (`product.taxRate`/`objetoImp`), no de un valor congelado en el `OrderItem`** (el `OrderItem` sólo guarda `taxAmount` como monto — `prisma/schema.prisma:4043` — nunca una tasa ni un `objetoImp` propios).

### 1.3 Cómo se arman los conceptos: **por LÍNEA, no por orden**

`globalLinesFromOrder` (`cfdiGlobal.service.ts:518-576`) llama a `reconstruirConceptos` (`src/services/fiscal/cfdi.service.ts:892-919`) — **la MISMA función que usa la factura individual** (ver §del comentario en la línea 32: *"MISMA verdad de dinero que la factura individual"*). Cada renglón se descompone en conceptos (producto + extras con precio, líneas 713-821 de `cfdi.service.ts`), y luego `groupOrderIntoGlobalLines` (`src/services/fiscal/cfdiPayloadBuilder.ts:197-222`) los agrupa **por (tasa, objetoImp)** en 1..N líneas por orden — una orden con productos al 16% y exentos produce dos líneas globales, no una al 16% plano. Si `reconstruirConceptos` devuelve motivos (el "sobre seguro" — descuentos generales sobre variostenta, promociones, venta por peso que no cuadra, etc.), la orden entera se **excluye** de la global con un `logger.warn` (líneas 535-538), nunca se declara mal.

Barrera de dinero: `totalDelDocumentoCents` (documento reconstruido) debe ser **exactamente** igual a lo cobrado (`paidCents`, suma de pagos elegibles) — si no coincide, la orden se excluye (líneas 539-545). Fallback para órdenes sin renglones (venta de importe libre): una sola línea al 16% sobre lo PAGADO (nunca `order.total`, que puede traer propina) — líneas 557-576.

`buildGlobalInvoiceParams` (`cfdiPayloadBuilder.ts:239-286`) arma el payload final: `ClaveProdServ` genérico `01010101` / `ClaveUnidad` `ACT` para TODAS las líneas globales (el detalle por tasa va en `objetoImp`+`taxes`, no en la clave de producto), `payment_form` unánime o `'99'` si mezcla formas de pago, y el bloque `global:{periodicity, months, year}`.

### 1.4 Reserva / idempotencia / candados de concurrencia

- **No hay tabla-manifiesto** de "qué órdenes entraron a este global". La `Cfdi` global (`isGlobal:true`) guarda sólo `globalPeriod: Json` con `{periodicidad, meses, anio}` (`prisma/schema.prisma:16421`, `baseGlobalCfdiData` en `cfdiGlobal.service.ts:281`) — **ninguna lista de `orderId`s**. La asociación orden↔global sólo puede **re-derivarse** volviendo a correr la MISMA consulta de `loadGlobalCandidates` sobre ese periodo; si `Order.updatedAt` cambia después (p. ej. un reembolso posterior actualiza la orden) o el emisor cambia `invoiceCashSales`/`includeInGlobal`, la re-derivación puede no coincidir exactamente con lo que se timbró en su momento. No se encontró ninguna tabla de unión (`CfdiGlobalOrder` o similar) en `prisma/schema.prisma`.
- **Unicidad**: `idempotencyKey = cfdi-global-${emisorId}-${anio}-${meses}-${satPeriodicidad}` (línea 120), único a nivel `Cfdi.idempotencyKey` (`prisma/schema.prisma:16459`, `@unique`). Un `findExistingGlobal` (línea 324, `prisma.cfdi.findUnique({ idempotencyKey })`) corta temprano si ya está `STAMPED` (líneas 121-125).
- **Reserva antes del PAC**: `deps.reserveCfdi` hace `prisma.cfdi.create({ status:'STAMPING', … })` (línea 326) **antes** de llamar al proveedor (líneas 184-211). Si choca con `P2002` (ya existe): si está `STAMPED` devuelve ese; si está `STAMPING` y tiene **menos de `GLOBAL_STAMPING_TTL_MS = 3*60_000` ms** (línea 98) de antigüedad, lanza `Error('Global en proceso…')` (409 aguas arriba); si es más viejo, se reclama como huérfano (log de advertencia, línea 203-205) y sigue.
- **Estados** (`enum CfdiStatus`, `prisma/schema.prisma:16293-16302`): `DRAFT, VALIDATING, VALIDATION_FAILED, STAMPING, STAMP_FAILED, CANCEL_REQUESTED, CANCELLED` — para el global se usan `STAMPING → STAMPED | VALIDATION_FAILED | STAMP_FAILED` (no usa `DRAFT`/`VALIDATING`).
- `persistCfdi` es un `upsert` sobre `idempotencyKey` (líneas 428-438): en `update` refresca `status`, `lastError`, `attempts:{increment:1}` y sólo los campos de "ya timbrado" (`facturapiId, uuid, serie, folio, stampedAt, xmlUrl, pdfUrl`) — **no** vuelve a escribir `subtotalCents/taxCents/totalCents` en el update (`stampedGlobalFields`, líneas 298-303), a diferencia del camino individual (ver §1.5 abajo, que sí los refresca).

### 1.5 Exclusión mutua individual↔global — **es de UN SOLO SENTIDO**

- **Global excluye órdenes ya facturadas individualmente**: confirmado arriba (`cfdis: { none: { status:'STAMPED', isGlobal:false } }`, `cfdiGlobal.service.ts:380-382`).
- **La factura individual (`issueCfdiForOrder`, `src/services/fiscal/cfdi.service.ts:259-475`) NO comprueba si la orden ya está en una global.** `findOrderInvoices` (línea 267, deps por defecto en línea 553-559) filtra `where: { orderId, isGlobal: false, type: 'INGRESO' }` — sólo mira facturas individuales previas de esa orden para decidir "ya emitida" / "en curso" / "cancelación en trámite". No hay ninguna consulta a `Cfdi` con `isGlobal:true` en todo `issueCfdiForOrder`, ni en el controlador (`src/controllers/dashboard/cfdi.dashboard.controller.ts:36+`, que sólo hace pass-through). `grep -n "isGlobal" src/services/fiscal/cfdi.service.ts` confirma que las únicas apariciones son las citadas arriba y la línea 402 (`isGlobal:false` en `validateBeforeStamp`, que sólo bloquea el RFC genérico `XAXX010101000` en la vía individual, no consulta si YA hubo una global).
- **Consecuencia observada en el código (hecho, no una hipótesis):** una orden que ya fue barrida a una factura global `STAMPED` puede, después, recibir también una factura individual `STAMPED` — nada en el camino individual lo impide ni lo advierte.

---

## 2. EGRESO / NOTA DE CRÉDITO por reembolso

### 2.1 Entry points

| Punto de entrada | Archivo:línea |
|---|---|
| **MCP** `emit_refund_credit_note` | `src/mcp/tools/cfdi.ts:120-227`. Confirm-gated en dos pasos (`confirm:boolean`, líneas 126, 162-188): sin `confirm` devuelve `requiresConfirmation:true` + vista previa legible; con `confirm:true` llama `emitRefundCreditNote`. Gateado por `guard.requirePermission('cfdi:issue', venueId)` (línea 131) + `venuesWithFeatureAccess([venueId], 'CFDI')` (líneas 133-141). Auditoría `auditMcpWrite(... action:'CFDI_CREDIT_NOTE_ISSUED' ...)` (líneas 206-212). |
| **MCP** `cfdi_status` (lectura, contexto) | Igual archivo, líneas 18-113 — no específico de nota de crédito pero agrega `Cfdi` por status (incluye `EGRESO`). |
| **Dashboard** `getRefundCreditNoteController` | `GET /venues/:venueId/refunds/:refundId/credit-note` — ruta `src/routes/dashboard.routes.ts:3684-3689`, gate `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:view')`. Controlador `src/controllers/dashboard/cfdi.dashboard.controller.ts:504-…` llama `getRefundCreditNoteStatus`. |
| **Dashboard** `emitRefundCreditNoteController` | `POST /venues/:venueId/refunds/:refundId/credit-note` — ruta `dashboard.routes.ts:3691-3696`, gate `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:issue')`. Controlador `cfdi.dashboard.controller.ts:427-…` llama `emitRefundCreditNote` (líneas 440-457) y devuelve `{ creditNote: {...} }`. |

### 2.2 Cómo se calcula el importe (por reembolso, no por venta)

Servicio: `src/services/fiscal/cfdiCreditNote.service.ts`.

- `loadRefundForCreditNoteFromDb` (líneas 477-588) toma UN `Payment` (`refundPaymentId`) tipo `REFUND`. `salesRefundCents = |payment.amount|`, `tipRefundCents = |payment.tipAmount|` (líneas 560-561) — **la propina se separa SIEMPRE y NUNCA entra al CFDI** (`assembleSaleInput` la excluye — comentario línea 65-68; `checkCreditNoteEligibility` rechaza con `TIP_ONLY` si `salesRefundCents<=0`, líneas 167-173).
- `grossByRate` (para repartir el IVA del egreso) se calcula desde `order.items` con `product.taxRate` **EN VIVO** (líneas 563-569: `it.product?.taxRate != null ? Number(...) : 0.16`) — **no** desde el `Cfdi.taxBreakdown` de la factura original (que nunca se escribe, ver §4) ni desde ningún valor congelado por línea del `OrderItem`. Es decir: si el `taxRate` del producto cambió DESPUÉS de emitida la factura original, la nota de crédito reparte el IVA con la tasa ACTUAL, no con la tasa vigente cuando se timbró el ingreso.
- `buildCreditNoteLines` (líneas 201-213) reparte `salesRefundCents` PROPORCIONALMENTE entre esas tasas reales (vía `allocateByWeights`, `src/services/fiscal/ivaMath.ts:33-46`) — nunca por renglón concreto ("no se sabe qué mitad de hamburguesa se devolvió"). Sin desglose (venta de importe libre) cae a una sola partida a `fallbackRate` = `original.taxCents===0 ? 0 : 0.16` (línea 249) — la tasa IMPLÍCITA del ingreso original (si el ingreso no llevó IVA, el egreso tampoco).
- Los conceptos (`buildCreditNoteParams`, `src/services/fiscal/cfdiPayloadBuilder.ts:128-155`) son **una partida por TASA** ("Devolución sobre factura X"), `taxIncluded:true`, `TipoRelacion 01`, `UsoCfdi G02` (constantes líneas 86-88).

### 2.3 Lectura de los impuestos del original — **del `Order`, NO del XML**

`OriginalCfdiForCreditNote` (interfaz, `cfdiCreditNote.service.ts:35-53`) trae `subtotalCents, taxCents, totalCents, formaPago, metodoPago, receptorRfc/Nombre/Regimen/Cp` — un snapshot AGREGADO de la factura de ingreso (`Cfdi.subtotalCents/taxCents/totalCents`, líneas 510-538). Estos agregados sólo se usan para:
- decidir `fallbackRate` (línea 249, cuando la orden no tiene renglones desglosables),
- calcular `alreadyCreditedCents`/`remainingCents` (ver §2.4).

**El desglose por línea (`grossByRate`) NO viene del XML/`Cfdi` original — viene de `order.items` con `product.taxRate` en vivo** (línea 495-509, 563-569). `Cfdi.taxBreakdown` (el campo JSON pensado para esto, `prisma/schema.prisma:16447`) **nunca se lee aquí** ni en ningún otro lugar del repo salvo el comentario que documenta que nunca se escribe (§4).

### 2.4 Chequeo de saldo remanente por UUID

`checkCreditNoteEligibility` (líneas 136-185), reglas en orden:
1. `refund.type !== 'REFUND'` → `NOT_A_REFUND`.
2. `refund.status !== 'COMPLETED'` → `REFUND_NOT_COMPLETED`.
3. `!original` (sin CFDI de ingreso STAMPED, `isGlobal:false`, para esa orden) → `NO_ORIGINAL_CFDI`.
4. `original.cancelStatus in ('CANCELLED','ACCEPTED') || original.status==='CANCELLED'` → `ORIGINAL_CANCELLED`.
5. `refund.salesRefundCents <= 0` (sólo propina) → `TIP_ONLY`.
6. `remainingCents = original.totalCents - alreadyCreditedCents`; si `refund.salesRefundCents > remainingCents` → `EXCEEDS_REMAINING` (líneas 174-183).

`alreadyCreditedCents` = `Σ Cfdi.totalCents` de **todas** las notas de crédito `STAMPED` (`type:'EGRESO'`) de esa `orderId` (agregado en `loadRefundForCreditNoteFromDb`, líneas 539-542) — es decir, el saldo se controla **por orden**, sumando TODOS los egresos ya emitidos contra ella, no por comparación directa contra un solo UUID.

### 2.5 Qué bloquea la emisión

`CreditNoteBlockReason` (líneas 112-118): `NOT_A_REFUND | REFUND_NOT_COMPLETED | NO_ORIGINAL_CFDI | ORIGINAL_CANCELLED | TIP_ONLY | EXCEEDS_REMAINING` — **la MISMA función `checkCreditNoteEligibility`** decide si el botón del dashboard se ve Y si el timbrado procede (comentario líneas 130-135), evitando que la UI y el servicio diverjan.

- Idempotencia: `creditNoteIdempotencyKey(refundPaymentId) = cfdi-refund-${refundPaymentId}` (líneas 106-108), único en `Cfdi.idempotencyKey`. Reserva con `create` antes del PAC (líneas 298-313), mismo patrón TTL de 3 min (`STAMPING_TTL_MS`, importado de `cfdi.service.ts:257`) que el global.
- El proveedor debe soportar `createCreditNote` (líneas 242-244) o lanza antes de reservar.

---

## 3. DELIVERY (Uber Eats / Rappi / DiDi) — reconciliación fiscal de retiros de renglón

### 3.1 Función que calcula `fiscalByRateCents`

Archivo `src/services/fiscal/deliveryFiscalDelta.ts`:

- `fiscalByRateCents` (líneas 22-34) y su variante ya agrupada `fiscalByRateCentsPorTasa` (líneas 43-57): PURA. Recibe la composición COBRADA y la SUPERVIVIENTE (después del retiro) ya agrupadas por tasa (`{rate, grossCents}[]`), las pasa por `splitPaymentIvaByOrderRates` (`ivaMath.ts:86-98`) y devuelve el **DELTA** de IVA por tasa (`antes[tasa] - despues[tasa]`), omitiendo tasas sin diferencia.
- `ivaDeDevolucion` (líneas 71-96): la regla ÚNICA compartida por la póliza (`autoPosting.service.ts`) y el estado de resultados (`accounting.dashboard.service.ts`) para el IVA de CUALQUIER devolución. Si `processorData.provenance === 'PROVIDER_ADJUSTMENT'` (el caso de delivery) y `processorData.fiscalByRateCents` es un objeto válido de enteros cuya suma cae en `[0, salesCents]`, usa ESE reparto tal cual; si no, o si el total no cuadra, grita `logger.error('🚨 …')` (líneas 82, 89-91) y cae a repartir por la mezcla normal de la orden.
- `ivaEnLibrosPorTasa` (líneas 105-119): el IVA que HOY está en libros para una orden — suma cada cobro (con `splitPaymentIvaByOrderRates`) y resta cada devolución (`ivaDeDevolucion`), sea manual o del proveedor. Es lo que un retiro nuevo usa como "antes" para calcular su propio delta.

### 3.2 Dónde y en qué transacción corre

`src/services/delivery-channels/core/deliveryReconciliation.service.ts`. Corre **dentro de una transacción** (`tx`, parámetro implícito por el patrón `await tx.deliveryLineAction.updateMany(...)` visto en todo el archivo — líneas 262 y siguientes). Secuencia relevante:

1. Lee `cobros` = `Payment` `COMPLETED` de `source: DELIVERY_PLATFORM` de esa orden (líneas 253-256).
2. Separa `delProveedor` (cobro original + ajustes previos del proveedor) de `independientes` (reembolsos manuales / chargebacks — que **NO** entran al delta, líneas 250-251, decisión N-6).
3. Calcula `dVenta`/`dPropina` = lo pagado por el proveedor menos lo que la foto fresca (`externallyPaidSale/Tip`) ya reporta (líneas 267-268). Si son negativos (el proveedor SUBIÓ el monto) → bloquea (`BLOCKED_INCREASE`, líneas 269-282).
4. **Lee el mix fiscal desde `filas`** (los `OrderItem` de la orden — la fuente exacta no está en el fragmento leído pero `grossByRateForOrder(filas)`/`grossByRateForOrder(superviviente)` en las líneas 294 y 298 confirman que usa `Product.taxRate` **EN VIVO**, vía la misma función que usa la póliza (`autoPosting.service.ts:96-104`, que a su vez llama a `grossByRateFromItems` de `ivaMath.ts`).
5. `enLibros = ivaEnLibrosPorTasa(cobros.map(...), grossByRateForOrder(filas))` (líneas 289-292) — el saldo actual.
6. `ivaSuperviviente = splitPaymentIvaByOrderRates(quedaEnLibros, grossByRateForOrder(superviviente))` (línea 298) — lo que debería quedar tras el retiro.
7. `fiscal = enLibros − ivaSuperviviente` por tasa (líneas 299-303) — este es el `fiscalByRateCents` que se persiste.
8. Absorbe deriva de redondeo de ±1¢ sólo en los casos seguros (líneas 305-313); más de 1¢ va a `FISCAL_PENDING` (líneas 314-337, función `aFiscalPendiente`).
9. Verifica que la compensación no exceda `cobro.remainingBeforeCents` bajo `bloquearCobroParaReembolso` (líneas 366-390) — si excede, bloquea con `EXCEEDS_REFUNDABLE` y escribe `ActivityLog` `DELIVERY_REFUND_POSSIBLE_DUPLICATE` (líneas 372-390).
10. Escribe el `Payment` REFUND vía `writeRefundInTx` (líneas 393-410) pasando `fiscalByRateCents: fiscal` (línea 410) y `provenance: 'PROVIDER_ADJUSTMENT'` (línea 409) — ese `fiscalByRateCents` se guarda en `processorData` del nuevo `Payment` REFUND, y es lo que `ivaDeDevolucion` (§3.1) leerá después.

### 3.3 Dónde se almacena

En `Payment.processorData` (JSON, sin columna dedicada en `prisma/schema.prisma` — es un campo `Json?` genérico de `Payment`) con la forma `{ provenance:'PROVIDER_ADJUSTMENT', fiscalByRateCents: {...}, generation:number, ... }`. No hay tabla ni columna propia para `fiscalByRateCents`; vive exclusivamente dentro de ese JSON del `Payment` de tipo REFUND que representa el ajuste.

---

## 4. AGREGADOS FISCALES que suman IVA o base gravable

| Nombre | Archivo:línea | Qué lee | ¿Cambiaría si cambia el IVA de un producto? |
|---|---|---|---|
| `IncomeStatement.revenue.taxableBaseCents` / `.ivaCents` / `.taxByRate` | `src/services/dashboard/accounting.dashboard.service.ts:59,61,63` (interfaz) y cálculo en líneas 150-217 (`getIncomeStatement`) | `Payment` (`COMPLETED`, en rango de fecha) + `order.items.product.taxRate` **EN VIVO** (línea 135, `select: { ..., product: { select: { taxRate: true } } }`; usado en línea 169: `taxRate: it.product?.taxRate != null ? Number(...) : null`) | **Sí.** Es un read-model que recalcula desde cero en cada consulta, uniendo `Product.taxRate` actual — no lee ningún valor congelado por venta. Un cambio de tasa en el catálogo altera retroactivamente el desglose fiscal de TODAS las ventas históricas de ese producto la próxima vez que se pida el reporte. |
| `IncomeStatement.fiscalRevenue.taxableBaseCents` / `.taxByRate` | mismo archivo, líneas 71-78 (interfaz), 199-204 y 228-235 (cálculo) | El mismo cálculo de arriba, filtrado por `paymentInFiscalScope` (merchant `includeInAccounting`, efectivo `includeCashInAccounting`) | Igual que arriba: recalcula en vivo. |
| `IvaCashflowResult.baseGravableCents` / `.ivaTrasladadoCobradoCents` / `.ivaTrasladadoPorTasaCents` | `src/services/fiscal/ivaFlujo.service.ts:54-58` (interfaz), cálculo líneas 151-162 (`getIvaCashflow`) | Llama a `getIncomeStatement` por cada venue del RFC y **suma** `fiscalRevenue.taxableBaseCents` / `.ivaCents` / `.taxByRate` (líneas 153-162) | Sí, hereda la misma dependencia en vivo de `getIncomeStatement`. El propio comentario del archivo (líneas 21-23) documenta que **`Cfdi.taxBreakdown` nunca se escribe**, así que el desglose por tasa NUNCA sale de los CFDIs — siempre de los `Payment`+`Order.items`. |
| `IvaCashflowResult.ivaAmparadoPorCfdiCents` | `ivaFlujo.service.ts:60,167-171,193` | `prisma.cfdi.aggregate({ where:{ venueId:{in}, status:'STAMPED', stampedAt:{gte,lte} }, _sum:{ taxCents:true } })` | **No** — usa `Cfdi.taxCents`, que SÍ queda congelado al timbrar (el `Cfdi` no se re-escribe salvo `upsert` de re-intento). El propio comentario del servicio (línea 23) lo llama explícitamente **"línea de CONTRASTE, no la base"** — es informativo, no entra a `ivaAPagarPreliminarCents`. |
| `getAcreditablePagado` (IVA acreditable, lado gastos) | referenciado en `ivaFlujo.service.ts:8,174-176`; definido en `src/services/fiscal/expense.service.ts` (no explorado en detalle en esta pasada — declarado en el import) | Gastos pagados, deducibles, acreditables del periodo (Buzón de CFDIs, Fase 2). No toca `Product.taxRate` de ventas — es lado proveedores. | No aplica directamente (es IVA de compras, no de ventas). |
| Fallback `0.16` en el recibo digital público | `src/controllers/public/receipt.public.controller.ts:106-107` | `dataSnapshot.order.taxAmount / dataSnapshot.order.subtotal` si ambos existen y son distintos de cero; si no, `0.16` fijo | **No** — `dataSnapshot` es un **snapshot JSON congelado** en el `DigitalReceipt` al momento de generarse (ver comentario líneas 11-21: esta rama HTML es LEGACY, sólo sirve tickets ya impresos antes de agosto-2026; la app viva usa la página del dashboard). Es puramente presentacional y ya está "sellado" por construcción — no se recalcula contra el catálogo. |

**Conclusión clave del §4:** el estado de resultados (`getIncomeStatement`) y `ivaFlujo` (declaración de IVA) recomputan el IVA por tasa **en vivo, uniendo `Product.taxRate` actual** en cada consulta — NO existe hoy ningún snapshot por línea/venta que "selle" la tasa vigente al momento de la venta (el `OrderItem` sólo guarda `taxAmount`, un monto, nunca una tasa — `prisma/schema.prisma:4043`). Esto es lo opuesto de la contabilidad ya posteada (§5): una vez que un `Payment` se postea a `JournalLine` (cents fijos), ese asiento no cambia aunque el catálogo cambie después; pero los DOS read-models fiscales (income statement, IVA de flujo) sí cambiarían retroactivamente si se edita `Product.taxRate` de un producto vendido en el pasado.

---

## 5. Contabilidad — dónde se leen los montos de impuesto (sólo listado, plan 4 dueño del fix)

| Función | Archivo:línea | Lee tax de |
|---|---|---|
| `grossByRateForOrder` | `src/services/fiscal/autoPosting.service.ts:96-104` | `OrderItemRow.product.taxRate` (**en vivo**, vía join `select: { product: { select: { taxRate: true } } }` implícito en `OrderItemRow`, línea 68) — delega en `grossByRateFromItems` de `ivaMath.ts:108-120`. |
| `buildSaleLines` (póliza de venta) | `autoPosting.service.ts:107-124` | `splitPaymentIvaByOrderRates(G, grossByRateForOrder(p.order?.items))` (línea 118) — usa la tasa real por producto, no 16% plano. Las líneas resultantes (`netCents`→`SALES_REVENUE`, `taxCents`→`IVA_OUTPUT`) se persisten como `debitCents/creditCents` **fijos** en `JournalLine` (ver abajo). |
| `buildRefundLines` (póliza de devolución) | `autoPosting.service.ts:135-152` | `ivaDeDevolucion(p.id, rG, processorData, grossByRateForOrder(p.order?.items))` (línea 147) — la MISMA regla del §3.1, incluida la rama `PROVIDER_ADJUSTMENT` de delivery. |
| `postJournalEntry` | `src/services/fiscal/journalEntry.service.ts:155` | **No lee tasas de impuesto por sí mismo** — recibe las líneas (debe/haber) ya calculadas por `autoPosting.service.ts` y sólo valida/persiste el asiento balanceado. Es agnóstico al origen del monto. |
| `isPeriodLocked` / cierre de periodo | `src/services/fiscal/accountingPeriodLock.service.ts:20-30` | No lee impuestos — sólo bloquea que se posteen **pólizas nuevas** dentro de un periodo ya cerrado (`AccountingPeriodLock`, `prisma/schema.prisma:16745-16763`, único por `(organizationId, rfc, period)`). No afecta a los read-models de §4, que no pasan por este candado (no son pólizas, son consultas directas sobre `Payment`). |
| Modelo del asiento | `prisma/schema.prisma:16699-16744` (`JournalEntry`, `JournalLine`) | `JournalLine.debitCents/creditCents` son enteros **fijos** una vez posteados — el motor es idempotente por `pay:${id}:v1`/`refund:${id}:v1` (comentario `autoPosting.service.ts:19`), así que un asiento ya posteado NO se recalcula si `Product.taxRate` cambia después. Esto contrasta con §4: la contabilidad YA posteada queda sellada; los read-models fiscales (income statement, IVA de flujo) NO. |

---

## 6. El modelo `Cfdi` y modelos relacionados (`prisma/schema.prisma`)

### 6.1 Enums

| Enum | Línea | Valores |
|---|---|---|
| `CfdiType` | 16287-16291 | `INGRESO, EGRESO, PAGO` |
| `CfdiStatus` | 16293-16302 | `DRAFT, VALIDATING, VALIDATION_FAILED, STAMPING, STAMP_FAILED, CANCEL_REQUESTED, CANCELLED` |
| `CfdiFlow` | 16304-16308 | `STAFF_B, AUTOFACTURA_A, GLOBAL_C` |
| `CfdiCancelStatus` | 16310-16315 | `REQUESTED, ACCEPTED, REJECTED, CANCELLED` |
| `FiscalValidationStatus` | 16316-16319 (aprox., inmediatamente antes de `FiscalEmisor`) | `UNVALIDATED, VALID, INVALID` |
| `GlobalPeriodicity` | 16273-16279 | `DIARIO, SEMANAL, QUINCENAL, MENSUAL, BIMESTRAL` |
| `ContratoDePrecio` | 9239-9243 | `IVA_INCLUIDO, IVA_APARTE, DESCONOCIDO` (usado por `Order.contratoDePrecio`, línea 3759 — pieza de "plan 2", ya en schema; ver Nota §7) |

### 6.2 Modelos

| Modelo | Línea | Notas relevantes |
|---|---|---|
| `FiscalEmisor` | 16324-16377 | `globalPeriodicity` (16353, default `MENSUAL`), `invoiceCashSales` (16357, default `false`), `includeCashInAccounting` (16362, default `false`), `isnRate` (16366), relación `cfdis Cfdi[]` (16368). |
| `MerchantFiscalConfig` | 16379-16403 | XOR de `merchantAccountId`/`ecommerceMerchantId` (comentario 16378), `facturacionEnabled/autofacturaEnabled/includeInGlobal(16395)/includeInAccounting(16399)`. |
| `Cfdi` | 16408-16482 | Campos clave: `type/status/flow` (16416-16418), `orderId` nullable + `isGlobal Boolean @default(false)` + `globalPeriod Json?` (16422-16425), snapshot del receptor (16428-16431), `formaPago/metodoPago` SAT (16434-16435), dinero en **centavos enteros** `subtotalCents/discountCents/taxCents/totalCents` + `taxBreakdown Json?` (16438-16443, **nunca escrito** — ver §4), identificadores del PAC (`facturapiId, uuid @unique, serie, folio, stampedAt`, 16446-16450), artefactos (`xmlUrl/pdfUrl/acuseUrl`, 16453-16455), `lastError/attempts/idempotencyKey @unique` (16458-16460), cancelación 4.0 (`cancelMotivo/cancelSubstituteUuid/cancelStatus/cancelRequestedAt/cancelledAt`, 16463-16467), **sustitución** (`replacesCfdiId` self-relation `CfdiSustitucion`, 16468-16475 — el "intento durable" para refacturar, comentario 16468-16472). Índices: `[venueId,status]`, `[fiscalEmisorId,isGlobal,createdAt]`, `[replacesCfdiId]` (16478-16482). |
| `CustomerTaxProfile` | 16484-16505 (aprox.) | Perfil fiscal reusable del cliente; snapshot en `Cfdi` es independiente de éste. |
| `AccountingPeriodLock` | 16745-16763 | Candado por `(organizationId, rfc, period)`, `status: AccountingPeriodStatus`, bitácora de cierre/reapertura. |
| `JournalEntry` / `JournalLine` | 16699-16716 / 16727-16739 | Ver §5. `JournalEntry.idempotencyKey` (nullable, único junto con `organizationId,rfc`) y `folio` consecutivo único por `(organizationId, rfc)`. |
| `PlatformCfdi` (nota) | 17370+ | **NO es el mismo dominio** — es Avoqado facturándole a SUS clientes (billing de la plataforma), espejo de `Cfdi` pero a nivel `PlatformCfdiType`/`PlatformCfdiStatus` propios. No interviene en el flujo de facturación de un venue a SU cliente. |

No existe ninguna tabla de "manifiesto de global" ni de "líneas de nota de crédito" como modelos propios — la nota de crédito reutiliza el mismo modelo `Cfdi` (`type:'EGRESO'`) y sus "líneas" (`CreditNoteLine[]`) son un tipo TypeScript puro (`cfdiPayloadBuilder.ts:94-97`), no persistido más allá del payload que se manda al PAC.

---

## 7. Nota fuera de alcance estricto, pero relevante para planear (observación factual)

Al leer `src/mcp/tools/cfdi.ts` apareció una tercera tool, `confirm_order_price_contract` (líneas 234-326), que usa `src/services/fiscal/confirmarContratoDePrecio.service.ts` y el campo `Order.contratoDePrecio` (`prisma/schema.prisma:3759`, enum `ContratoDePrecio` en 9239-9243) y los módulos puros `src/services/fiscal/contratoDePrecio.ts` (`combinarContratos`, `contratoDePagoManual`) e `ivaTratamiento.ts` (`IvaTratamiento`, `tratamientoDesdeTupla`, `trasladoSatDe`). Esto corresponde a piezas de lo que la memoria del workspace llama "plan 2/3" de IVA-por-producto — **ya presente en este worktree**, no sólo planeado. No se investigó a fondo (fuera del alcance de este encargo), pero se deja anotado porque cualquier plan nuevo de "sellado por documento" debería revisar primero si `confirmarContratoDePrecio.service.ts` ya resuelve parte de la pregunta de qué ventas viejas se pueden facturar con el IVA por producto.

---

## 8. Tests que cubren 1-4

| Área | Archivos |
|---|---|
| Global (1) | `tests/unit/services/fiscal/cfdiGlobal.service.test.ts`, `tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts` (cubre `groupOrderIntoGlobalLines`/`buildGlobalInvoiceParams`/`reconcileGlobalLines`) |
| Egreso / nota de crédito (2) | `tests/unit/services/fiscal/cfdiCreditNote.service.test.ts`, `tests/unit/services/fiscal/facturapi.provider.creditNote.test.ts` |
| Delivery (3) | `tests/unit/services/fiscal/deliveryFiscalDelta.test.ts`, `tests/integration/delivery-channels/lineActionReconciler.test.ts`, `tests/integration/delivery-channels/reconciliacionDinero.test.ts`, `tests/unit/jobs/delivery-webhook-reconciliation.job.test.ts` |
| Agregados de IVA (4) | `tests/unit/services/ivaFlujo.service.test.ts`, `tests/unit/services/dashboard/accounting.dashboard.service.test.ts`, `tests/unit/services/fiscal/ivaMath.test.ts` |
| Emisión individual (contexto compartido con 1 y 2) | `tests/unit/services/fiscal/cfdi.service.test.ts`, `tests/unit/services/fiscal/cfdiValidation.test.ts`, `tests/unit/services/fiscal/loadOrderForCfdi.test.ts`, `tests/unit/services/fiscal/cfdiCancel.service.test.ts`, `tests/unit/services/fiscal/cfdiReplacement.service.test.ts`, `tests/unit/services/fiscal/cfdiRefacturar.service.test.ts`, `tests/unit/services/fiscal/cfdiReconcile.service.test.ts`, `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts`, `tests/unit/controllers/public/cfdi.public.controller.test.ts`, `tests/unit/schemas/cfdiList.schema.test.ts` |
| Auto-posting (5, contexto) | `tests/unit/services/autoPosting.service.test.ts`, `tests/integration/dashboard/autoPostingRetiro.integration.test.ts` |
| **No encontrado** | Ninguna prueba dedicada a las tools MCP de `src/mcp/tools/cfdi.ts` (`cfdi_status`, `emit_refund_credit_note`, `confirm_order_price_contract`) — `find tests -ipath "*mcp*" -iname "*cfdi*"` no devuelve nada. |

---

## Resumen de hallazgos que más importan para planear el sellado por documento

1. **Global y factura individual comparten el mismo constructor de conceptos** (`reconstruirConceptos`/`conceptosDesdeRenglon` en `cfdi.service.ts`), que lee `Product.taxRate`/`objetoImp` **en vivo** — ninguno de los dos documentos "congela" la tasa en el `OrderItem`; el sello real es el `Cfdi.subtotalCents/taxCents/totalCents` ya timbrado, que no se vuelve a tocar salvo re-intento.
2. **No hay manifiesto persistido de qué órdenes entraron a una factura global** — sólo re-derivable corriendo la misma consulta sobre el periodo.
3. **La exclusión individual↔global es de un solo sentido**: global excluye lo ya facturado individual; **lo individual NO excluye lo ya facturado global** (confirmado en código, `cfdi.service.ts:267-268,553-559`).
4. **La nota de crédito no lee el XML original para el reparto de IVA** — recalcula desde `order.items.product.taxRate` en vivo, con el agregado del `Cfdi` original sólo como techo de saldo y `fallbackRate`.
5. **`Cfdi.taxBreakdown` está declarado y nunca se escribe** (confirmado por grep + comentario explícito en `ivaFlujo.service.ts:21-23`).
6. **Los dos read-models fiscales de mayor peso (income statement, IVA de flujo) recomputan `Product.taxRate` en vivo en cada consulta** — un cambio de tasa en el catálogo altera retroactivamente cifras históricas la próxima vez que se piden esos reportes, mientras que la contabilidad YA posteada (`JournalLine`) queda fija por ser idempotente y no releerse.
7. **El delivery fiscal delta es la única pieza que ya persiste un desglose por tasa fuera del catálogo** (`Payment.processorData.fiscalByRateCents`, JSON libre, sin columna dedicada), y sólo para el caso de ajustes de proveedor.
