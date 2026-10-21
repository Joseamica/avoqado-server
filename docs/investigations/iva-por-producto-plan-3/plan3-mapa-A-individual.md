# Mapa A — ciclo de vida del CFDI individual (hoy), para diseñar el "sellado" de plan 3

Repo leído: `avoqado-server/.claude/worktrees/iva-por-producto` (rama `iva-por-producto`, contiene `develop` al 25-sep). Sólo lectura, sin
modificar nada. Todas las rutas de archivo son relativas a la raíz de ese worktree salvo que se diga lo contrario.

---

## 1. Puntos de entrada que emiten un CFDI individual (no global)

| # | Entrada | Ruta HTTP / disparador | Controlador | Servicio que llama | Gate |
|---|---|---|---|---|---|
| A | **Dashboard — Flow B** (staff factura una cuenta cerrada) | `POST /api/v1/dashboard/venues/:venueId/orders/:orderId/cfdi` (`src/routes/dashboard.routes.ts:3627-3634`) | `issueCfdiForOrderController` (`src/controllers/dashboard/cfdi.dashboard.controller.ts:36-169`) | `issueCfdiForOrder({..., flow:'STAFF_B', expectedVenueId})` (`src/services/fiscal/cfdi.service.ts:259`) | `validateRequest(issueCfdiSchema)` → `checkFeatureAccess('CFDI')` → `checkPermission('cfdi:issue')` |
| B | **Autofactura del cliente — Flow A** (portal público desde el recibo digital) | `POST /api/v1/public/receipt/:accessKey/cfdi` (`src/routes/public.routes.ts:128`) | `autofacturaController` (`src/controllers/public/cfdi.public.controller.ts:47-181`) | `issueCfdiForOrder({..., flow:'AUTOFACTURA_A', expectedVenueId: order.venueId})` (mismo servicio, línea 103 del controlador) | Sin auth (público); dos rate-limits (`cfdiLimit` 5/min por IP, `cfdiPerKeyLimit` 3/min por `accessKey`); dentro del servicio: `facturacionEnabled` **y** `autofacturaEnabled` del comercio que cobró |
| C | **Reintento tras carrera / STAMPING atorado (dentro del mismo `issueCfdiForOrder`)** | No es una ruta nueva: pasa por A o B otra vez con la misma llave | `reconciliarIntentoPrevio` (`cfdi.service.ts:482-518`), disparado en la rama de `P2002` de la reserva (líneas 351-391) | Le pregunta al PAC (`provider.findByExternalId`) antes de re-timbrar | — |
| D | **MCP — nota de crédito de un reembolso** (documento EGRESO, no un ingreso nuevo, pero pasa por las mismas barreras de timbrado) | tool `emit_refund_credit_note` (`src/mcp/tools/cfdi.ts:120-227`) | — (el tool llama directo al servicio) | `emitRefundCreditNote(...)` (`src/services/fiscal/cfdiCreditNote.service.ts:217`) | `guard.venueFilter` + `guard.requirePermission('cfdi:issue')` + `venuesWithFeatureAccess([...],'CFDI')`; confirm-gated en dos pasos |
| E | **Dashboard — nota de crédito de un reembolso** (mismo servicio que D) | `POST /api/v1/dashboard/venues/:venueId/refunds/:refundId/credit-note` (`dashboard.routes.ts:3691-3697`) | `emitRefundCreditNoteController` (`cfdi.dashboard.controller.ts:427-494`) | `emitRefundCreditNote(...)` | `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:issue')` |
| F | **Dashboard — sustituir una factura equivocada** (emite una nueva relacionada 04 + intenta cancelar la vieja) | `POST /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/replace` (`dashboard.routes.ts:3672-3678`) | `replaceCfdiController` (`cfdi.dashboard.controller.ts:335-413`) | `replaceCfdi(...)` (`src/services/fiscal/cfdiReplacement.service.ts:81`), que internamente reusa `assembleSaleInput`/`buildCreateInvoiceParams`/`validateBeforeStamp` de `cfdi.service.ts` | `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:configure')` (OWNER/ADMIN) |
| — | (Fuera de alcance de este mapa, es la factura GLOBAL, no individual) `issueGlobalForEmisor` (`src/services/fiscal/cfdiGlobal.service.ts`), disparada por el job `CfdiGlobalJob` (`src/jobs/cfdiGlobal.job.ts`) y por `triggerGlobalCfdiController` (`dashboard.routes.ts:3767-3773`) | — | — | — | — |

No hay ningún job que emita CFDI **individuales** de forma proactiva (no encontré ningún cron que llame a `issueCfdiForOrder`). El único job
relacionado con emisión individual es `cfdiReconcileJob` (§4), que sólo **completa o resetea** intentos atorados — nunca inicia uno nuevo.

---

## 2. La reserva: cómo nace/reclama una fila `Cfdi`, estados, llave, candados

### 2.1 Estados (`CfdiStatus`, enum Prisma — confirmado en `prisma/schema.prisma:17270-17278` vía grep de contexto)
`DRAFT` (default, casi no se usa en el camino real) → `STAMPING` (reservado, aún no llamó al PAC o está llamando) → `STAMPED` (timbrado) /
`VALIDATION_FAILED` (nunca llegó al PAC — reglas propias lo bloquearon) / `STAMP_FAILED` (el PAC lo rechazó) → `CANCEL_REQUESTED` (usado sólo
en algún path legado; el path real usa `status='CANCELLED'` + `cancelStatus`) → `CANCELLED`.

`CfdiCancelStatus` (aparte, campo `cancelStatus`): `REQUESTED` (pedida, el SAT no ha resuelto) → `ACCEPTED` / `CANCELLED` (quedó cancelada)
/ `REJECTED` (el SAT/receptor la rechazó, o el PAC contestó `none`/`expired` — ver `mapProviderCancelStatus`, `cfdi.service.ts:1286-1302`).

### 2.2 Idempotency key / "-nN" / "-rN" (`cfdi.service.ts:233-253`, `cfdiReplacement.service.ts:69-79`)
- Primera emisión de una venta: `cfdi-order-<orderId>` (`llaveDeEmision`, `cfdi.service.ts:240`).
- Si la última factura de VENTA (INGRESO, no global) de esa orden quedó `CANCELLED`, la venta "estrena generación": `-n2`, `-n3`… La
  función recorre TODAS las facturas previas de la orden (`findOrderInvoices`, tope 50, `cfdi.service.ts:553-559`) con una regex sobre el
  patrón `cfdi-order-<id>(-nN)?` y toma la generación más alta.
- Sustituciones van en otro carril: `siguienteLlaveDeSustitucion` (`cfdiReplacement.service.ts:74-79`) deriva `…-r1`, `…-r2`… de la llave de
  la que sustituye — es determinista, así que dos peticiones para la MISMA corrección chocan en el índice único en vez de producir dos
  documentos.
- Nota de crédito: `cfdi-refund-<refundPaymentId>` (`cfdiCreditNote.service.ts:106-108`).
- `Cfdi.idempotencyKey` es `@unique` (`schema.prisma:16459`).

### 2.3 Reserva atómica ANTES del PAC (`cfdi.service.ts:307-391`)
1. `findExistingCfdi(idempotencyKey)` — si ya está `STAMPED`, se devuelve tal cual (idempotencia, con guard de tenant en línea 312).
2. Se carga la orden (`loadOrderForCfdi`), se validan gates de comercio (`facturacionEnabled`, `autofacturaEnabled`).
3. `assembleSaleInput` + `buildCreateInvoiceParams` (puros, sin tocar el PAC).
4. `reserveCfdi(...)` = un **INSERT puro** (`prisma.cfdi.create`) con `status:'STAMPING'` — el índice único sobre `idempotencyKey` es el
   candado real. Si otra petición ganó la carrera, el INSERT truena `P2002`.
5. Rama `P2002` (línea 353): se relee la fila existente.
   - `STAMPED` → éxito idempotente.
   - `STAMPING` fresca (< `STAMPING_TTL_MS` = 3 min, línea 257) → 409 "CFDI en proceso para esta orden".
   - `STAMPING` vieja (crash / rolling deploy a medio timbrado) → se reclama.
   - Reclamo atómico (`claimCfdi`, línea 601-603): `UPDATE ... WHERE id=X AND status IN (...) AND attempts = <versión leída>` — CAS real
     sobre `attempts` (no sólo sobre `status`), para que dos reclamos que leyeron la MISMA fila no puedan ganar los dos aunque `status`
     siga siendo válido para ambos (era un P1 real de Codex, comentado en línea 204-206).
   - Antes de re-timbrar el reclamo, `reconciliarIntentoPrevio` le pregunta al PAC por `external_id=idempotencyKey`
     (`provider.findByExternalId`) — si el PAC YA tiene el documento (un timeout después de que el PAC contestó, antes de persistir), se
     completa la fila SIN volver a timbrar (`cfdi.service.ts:478-518`).

### 2.4 Qué está DENTRO de una transacción de base de datos y qué no
**No hay ningún `prisma.$transaction` en `issueCfdiForOrder`.** El "todo o nada" no lo da una transacción SQL sino:
- El INSERT de la reserva (paso atómico único).
- Los `updateMany` con predicado CAS (`claimCfdi`, `persistArtifacts`) — cada uno es una sola sentencia atómica, pero no hay una
  transacción que envuelva "reservar + llamar al PAC + persistir".
- Consecuencia deliberada y documentada: el timbre (identidad `uuid/serie/folio/stampedAt`) se persiste **inmediatamente después** de la
  respuesta del PAC (paso 6, línea 438-449) y **antes** de tocar Storage — comentario explícito: "el documento ya existe ante el SAT: si la
  descarga o la subida fallan, la fila tiene que conservar uuid/serie/folio". Los archivos (XML/PDF) son *best-effort*: un fallo ahí NO
  invalida el timbre (línea 451-473); el job de conciliación NO repone archivos faltantes (sólo mira filas `STAMPING`, según el comentario
  de la línea 468-469) — es un hueco declarado.
- `confirmarContratoIvaIncluido` (plan 2, no toca CFDI) SÍ usa `prisma.$transaction` (`confirmarContratoDePrecio.service.ts:108-162`), con
  CAS sobre `Order.version` — es el único ejemplo de transacción real en el área, pero no participa en el timbrado.

### 2.5 Candados / advisory locks
No encontré advisory locks de Postgres (`pg_advisory_lock`) en el camino de CFDI individual. La exclusión mutua es 100% vía el índice
único de `idempotencyKey` + el CAS por `attempts`. (Los advisory locks del repo que sí existen —`recipe-cost-graph-lock.ts`,
reconciliación de referidos— son de otros dominios, no de facturación.)

---

## 3. Cómo se construye el payload (conceptos) hoy

### 3.1 Carga de la orden y resolución del emisor — `loadOrderForCfdiFromDb` (`cfdi.service.ts:942-1193`)
- `prisma.order.findUnique` trae: `subtotal`, `taxAmount`, `total`, `tipAmount`, `discountAmount`, `serviceChargeAmount`,
  `promotions` (sólo para saber si hay ≥1), `venue.{slug,type}`, `payments` (filtrados a `status:'COMPLETED'` y tipo elegible —ver §3.2—),
  `items.{productName, quantity, unitPrice, discountAmount, total, weightQuantity, modifiers.{name,price,quantity},
  product.{name, satProductKey, satUnitKey, objetoImp, taxRate, category.{defaultSatProductKey, defaultSatUnitKey}}}` (líneas 952-1002).
  **No lee `Product.ivaTratamiento` ni `Order.contratoDePrecio`** — sólo los campos legado `taxRate`/`objetoImp` (derivados por trigger de
  `ivaTratamiento`, según el comentario en `schema.prisma:1793-1795`, pero el código de facturación no los consulta directamente).
- Emisor: se resuelve por el `merchantAccountId`/`ecommerceMerchantId` del pago elegible más reciente con comercio; si NINGÚN pago trae
  comercio (efectivo/transferencia/tarjeta-en-otra-terminal), cae al camino "venta sin comercio" (líneas 1042-1063): sólo si el venue tiene
  **exactamente UN** `FiscalEmisor`, y siempre que el llamador pase `permitirEfectivo:true` (línea 1092) — la autofactura del cliente (Flow
  A / QR) siempre pasa `false` por default, así que un ticket pagado en efectivo NO puede autofacturarse salvo que el emisor tenga
  `invoiceCashSales:true`.
- Guard de aislamiento: `cfg.fiscalEmisor.venueId !== order.venueId` → `return null` (línea 1097-1102), nunca se timbra bajo el RFC de otro
  venue aunque el `MerchantAccount` esté compartido.
- Cuenta MIXTA (varios comercios): TODOS los pagos con comercio deben resolver al mismo `fiscalEmisor.id`; si no, se agrega un motivo
  bloqueante (`motivosComercios`, líneas 1071-1085) y la autofactura sólo se ofrece si TODOS los comercios de la cuenta la tienen
  encendida.

### 3.2 Selección de pagos elegibles (`esCobroElegible`, `cfdi.service.ts:646-648`)
`type == null` (legado) o `'REGULAR'` o `'FAST'`. Explícitamente EXCLUYE `TEST`, `ADJUSTMENT` y `REFUND` (un reembolso resta vía su propia
nota de crédito, nunca restando aquí). `paidCents = Σ pays.amount` (línea 1108) — **`Payment.amount` nunca trae propina** (va en
`tipAmount`), así que `paidCents` ya es "lo cobrado sin propina", que es exactamente la base facturable.

### 3.3 Reconstrucción de conceptos por renglón — el "sobre seguro" (`reconstruirConceptos` / `conceptosDesdeRenglon`, líneas 663-919)
Motivación (comentario 692-703): `OrderItem.total` no significa lo mismo en todos los escritores (TPV/mobile guardan bruto antes del
descuento de renglón; promociones lo guardan neto; reservas guardan sólo el producto base). En vez de asumir una semántica, el motor
**reconstruye** cada renglón validando invariantes; si alguna no se cumple, **bloquea con un motivo en español** en vez de adivinar.

Casos que bloquean (cada uno agrega un string a `motivos`, nunca lanza excepción — el llamador decide qué hacer con la lista):
- Cantidad ≤ 0 (línea 725).
- `total cobrado < precio×cantidad` (recálculo/promoción sin rastro, línea 732-739).
- `objetoImp` fuera de `{01,02}` (línea 744-746).
- `objetoImp='01'` con `taxRate≠0` — catálogo inconsistente (línea 747-749).
- **`taxRate=0` con `objetoImp='02'`** — tasa 0 vs exento AMBIGUOS, y el constructor los convertiría en exento sin distinguirlos (línea
  750-755). *Este es exactamente el hueco que "IVA por producto" (plan 1, ya construido) cierra con `Product.ivaTratamiento` explícito
  (`IVA_0` vs `EXENTO`), pero la facturación (este archivo) NO se actualizó todavía para leer ese campo — sigue infiriendo de
  `taxRate`+`objetoImp` legado.*
- Venta por peso: precio×kilos no cae en centavos exactos (línea 756-767), o el producto no tiene `satUnitKey='KGM'` (línea 768-770).
- Los extras con precio no explican EXACTAMENTE la diferencia `total − base` (línea 772-783).
- Descuento de renglón > importe del renglón (línea 784-791).
- A nivel ORDEN (`motivosDeOrden`, líneas 881-890): la cuenta lleva **promoción** (bloquea) o **cargo por servicio** (bloquea) — ambos
  "llega en la siguiente versión" según el propio texto.
- Descuento GENERAL de la orden repartido entre >1 tasa de IVA (línea 829-853) o repartido entre >1 renglón/concepto reconstruido cuando
  el alcance no se puede demostrar por los datos (línea 907-911) — bloquea.
- `validarConceptos` (línea 856-867): última red — ningún concepto con importe negativo ni descuento mayor que su importe.

Si `order.items.length === 0` (venta de importe libre, sin renglones): se sintetiza UN concepto genérico `"Venta"` con
`satProductKey:'01010101'`/`satUnitKey:'ACT'`/`objetoImp:'02'`/`taxRate:0.16` por `paidCents` (líneas 1116-1131) — aquí SÍ se asume 16% fijo,
sin mirar ningún dato del producto (no hay producto).

### 3.4 La barrera de dinero — "documento = cobrado" (dos sitios, misma fórmula)
- `totalDelDocumentoCents(order)` (`cfdi.service.ts:633-643`): recalcula lo que el PAC va a sumar para los conceptos EXACTOS que se
  mandarían — `Σ(unitario×cantidad − descuento)`, sumando IVA encima si `!pricesIncludeIva` (así compara lo que el PAC construiría, no los
  agregados de la orden).
- **Dentro de `loadOrderForCfdiFromDb`** (línea 1167-1174): si `unsupportedReasons` está vacío, se compara `documentoCents` contra
  `paidCents`; si difieren, se agrega un motivo bloqueante ahí mismo — así el ticket/recibo (que consulta este bundle) tampoco ofrece
  autofactura si de todos modos fallaría.
- **Dentro de `issueCfdiForOrder`** (línea 405-418, la comprobación real antes de timbrar): la MISMA fórmula, comparada otra vez contra
  `bundle.paidCents`, con el mismo criterio de "si ya hay razones del sobre, no se agrega el desajuste de importe" (evita un mensaje
  contradictorio).
- Origen del defecto que motivó esto: Testarudo 21-sep-2026, 5 facturas por debajo de lo cobrado (mencionado en el propio comentario,
  línea 405-407).
- `esCobroElegible` (§3.2) es el único filtro que decide qué pagos entran a `paidCents`; no hay una fase separada "documento=cobrado" con
  su propio archivo — vive repartida entre `cfdi.service.ts` (dos veces, arriba) y `cfdiReplacement.service.ts:199-206` (mismo patrón, para
  la sustituta).

### 3.5 IVA incluido vs neto — quién decide y cómo se divide
- `pricesIncludeIva = peso(order.taxAmount) === 0 || sinRenglones` (`cfdi.service.ts:1140`) — **no lee `Order.contratoDePrecio`
  todavía**; usa la heurística legado "si `taxAmount` es 0, el precio ya trae IVA" (comentario 1135-1139: TPV es la fuente típica de
  `taxAmount=0`; reservas/pos-sync traen `taxAmount>0` = precio neto separado).
- Con precio IVA-incluido: por cada concepto se llama `splitIvaIncluded(grossCents, rate)` (`ivaMath.ts:21-25`) — el residuo de redondeo lo
  absorbe el impuesto, así `netCents+taxCents === grossCents` exacto. Se van sumando `subtotalCents`/`taxCents`/`totalCents` renglón por
  renglón (líneas 1145-1158).
- Con precio neto: se usan directamente `order.subtotal`/`order.taxAmount`/`order.total` (línea 1159-1163) — no se re-derivan de los
  renglones.
- `assembleSaleInput` (`assembleSaleInput.ts:46-77`) es PURA: Prisma Decimal pesos → `AvoqadoSaleItemInput` en centavos, pasando
  `taxIncluded: pricesIncludeIva` (un solo booleano para TODA la orden, no por renglón) y `taxExempt: taxRate===0` (nota: esto NO repite la
  validación de ambigüedad de §3.3 — para cuando llega aquí, los renglones ya pasaron el sobre seguro o la venta ya fue bloqueada antes).
- `buildCreateInvoiceParams`/`resolveItem` (`cfdiPayloadBuilder.ts:52-81`) arma el `CfdiItemInput` final para el PAC: `objetoImp = producto
  ?? (exento?'01':'02')`, `taxes = exento ? [] : [{type:'IVA', factor:'Tasa', rate, withholding:false}]`.

### 3.6 Dónde se lee `taxRate`/`objetoImp` del Product
Sólo en tres sitios del camino individual: `loadOrderForCfdiFromDb` (select de Prisma, línea 990-996), `conceptosDesdeRenglon` (línea
742-743, para la validación del sobre seguro) y `assembleSaleInput` (línea 49-63, para construir el ítem). **`Product.ivaTratamiento` no se
lee en ningún archivo de facturación** (confirmado por grep: sólo aparece en `product.dashboard.service.ts`, `product.mobile.controller.ts`,
`normalizarIvaDeProducto.ts`, `ivaTratamiento.ts`, el schema y varios sitios de captura de venta — no en `cfdi*.ts`).

---

## 4. Llamada al PAC (Facturapi), finalización, timeout/incertidumbre, recuperación

### 4.1 Cliente / adaptador
`src/services/fiscal/providers/facturapi.provider.ts` implementa `FiscalProvider` (interfaz en
`src/services/fiscal/providers/fiscal-provider.interface.ts`). Resuelto vía `resolveFiscalProvider` (`fiscalProvider.factory.ts`) según
`FiscalEmisor.provider` (`FACTURAPI` es el único hoy). Métodos relevantes al ciclo individual: `createInvoice(params)`,
`downloadXml(id)`, `downloadPdf(id)`, `getInvoice(id)`, `findByExternalId(externalId)`, `cancelInvoice(...)`,
`getCancellationStatus(facturapiId)`, `searchInvoices({since,until,q})`.

### 4.2 Cómo se "finaliza" un timbre
`provider.createInvoice(invoiceParams)` devuelve un `StampedInvoice` (`fiscal-provider.interface.ts:176-184`):
`{ providerInvoiceId, uuid, serie, folio, totalCents, stampedAt, status }`. **No trae el desglose por concepto ni un XML embebido** — sólo
identificadores + totales. Lo que Avoqado persiste como "documento" (`baseCfdiData` + `identidad`, `cfdi.service.ts:442-449, 520-547`) es:
receptor (snapshot), `formaPago`/`metodoPago`, `subtotalCents`/`taxCents`/`totalCents` **calculados por NOSOTROS antes de llamar al PAC**
(no lo que el PAC reportó línea por línea), y luego `facturapiId/uuid/serie/folio/stampedAt`. **`Cfdi.taxBreakdown` (json, schema.prisma
line 16442) existe en el modelo pero NUNCA se escribe en este flujo** (confirmado por grep: sólo lo usa `expense.service.ts`, que es
gastos/egresos operativos, no CFDI de venta; hay un comentario explícito en `ivaFlujo.service.ts:21` diciendo que la fuente de verdad es
`Payments`, no `Cfdi.taxBreakdown`, "que está [vacío/sin usar]").
- Orden de persistencia: **primero** identidad del timbre (`persistCfdi(...,'STAMPED', identidad)`, línea 449) — **después** se intentan
  descargar+subir XML/PDF (`Promise.all([downloadXml, downloadPdf])`, líneas 452-465) y sólo entonces se guardan las URLs con
  `persistArtifacts` (un `updateMany` que exige `status:'STAMPED'`, para no pisar un estado que cambió mientras tanto — línea 587-592).
  Si la descarga/subida falla, el timbre queda válido pero SIN `xmlUrl`/`pdfUrl`; el comentario dice explícitamente "NADIE los repone solo"
  (línea 468-469) — es un hueco declarado, no un bug.

### 4.3 Timeout / desenlace incierto — el intento durable
Si `provider.createInvoice` lanza (línea 429-436), se persiste `STAMP_FAILED` con `lastError`. **Pero un timeout puede ocurrir DESPUÉS de
que el PAC ya timbró** (la petición nunca vuelve, aunque el documento exista). Dos mecanismos cubren esto, en momentos distintos:
1. **Al reintentar la MISMA orden** (mismo `idempotencyKey`, dentro de `issueCfdiForOrder`): `reconciliarIntentoPrevio` (§2.3) pregunta
   `findByExternalId(idempotencyKey)` antes de re-timbrar.
2. **Si nadie vuelve a pedir esa orden** (la fila queda `STAMPING` para siempre): el job de conciliación (§4.4) la recoge por reloj.

`externalId = idempotencyKey` se manda al PAC en cada `createInvoice`/`createCreditNote` (`cfdi.service.ts:345`, y `relation`/`externalId`
en `cfdiPayloadBuilder.ts:151` para notas de crédito) — es lo que hace determinista la búsqueda posterior (`findByExternalId`), en vez de
depender sólo de coincidencia de atributos (RFC+total+fecha).

### 4.4 Recuperación: `cfdiReconcileJob` + `reconcileStuckCfdi` (`src/jobs/cfdiReconcile.job.ts`, `src/services/fiscal/cfdiReconcile.service.ts`)
- Cron cada 5 min, offset `:02` (`'2-59/5 * * * *'`). Busca `Cfdi` con `status='STAMPING'` y `updatedAt < ahora−10min`
  (`STUCK_THRESHOLD_MS`), tope 200 por corrida.
- Por fila, `reconcileStuckCfdi` intenta, en orden de confiabilidad: (0) `findByExternalId(idempotencyKey)` si existe — hit determinista;
  (a) `getInvoice(facturapiId)` si ya se guardó un id (raro en `STAMPING`); (b) `searchInvoices` por RFC+total+fecha±1 día si no hay ningún
  identificador (`lookupByReference`, con matching estricto por `totalCents`+`isGlobal`+RFC, `matchesRow`, línea 264-271).
- Desenlaces: `COMPLETED` (documento válido encontrado → se completa con `completeFromPac`, que descarga XML/PDF y persiste STAMPED),
  `RESET` (el PAC definitivamente no tiene nada → `STAMP_FAILED`, reintentable), `INCONCLUSIVE` (ambiguo/cancelado/PAC inalcanzable → se
  deja `STAMPING` para el siguiente tick — **nunca se resetea ante la duda**, comentario explícito: "a wrong reset is what causes a
  double-stamp"), `SKIPPED` (la fila ya no está `STAMPING` o el emisor no existe).
- El mismo job también corre, cada hora (no cada 5 min): el barrido de cancelaciones en trámite (§5) y el alta de webhooks faltantes (§5).

---

## 5. Cancelación: directa, en trámite, webhook, y detección "externa"

### 5.1 Cancelación directa — `cancelCfdi` (`cfdi.service.ts:1224-1309`)
`POST /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/cancel` → `cancelCfdiController` → `cancelCfdi({cfdiId, motivo, substituteUuid,
sandbox, expectedVenueId})`. Guardas: sólo `status==='STAMPED'`; motivo `'01'` (sustitución) exige `substituteUuid`. Llama
`provider.cancelInvoice(...)`; el resultado se mapea con `mapProviderCancelStatus` (línea 1286-1302):
`canceled→CANCELLED`, `accepted→ACCEPTED`, `none|expired|rejected→REJECTED` (con un `lastError` propio explicando que sigue VIGENTE — no
sólo "rechazada"), cualquier otro (`pending`/`verifying`) → `REQUESTED`. `Cfdi.status` sólo pasa a `'CANCELLED'` cuando `cancelStatus` es
`CANCELLED` o `ACCEPTED`, y **nunca se baja de `CANCELLED`** una vez llegado ahí (línea 1280).

### 5.2 Cancelaciones "en trámite" — barrido + `refreshPendingCancellation` (§4.4, `cfdi.service.ts:1311-1389`)
Motivación en el comentario: Testarudo 21→24-sep-2026, una cancelación quedó `REQUESTED` y nadie volvió a preguntar aunque el SAT ya la
había resuelto minutos después. `refreshPendingCancellation(cfdi, {sandbox})` sólo actúa si `cfdi.cancelStatus==='REQUESTED'`; llama
`provider.getCancellationStatus(facturapiId)`; si sigue `REQUESTED` no escribe nada; si se resolvió, `applyCancelOutcome` es un `updateMany`
CAS (`WHERE id AND cancelStatus='REQUESTED'`) para que dos resoluciones concurrentes no escriban la bitácora dos veces (línea 1383-1387).
Escribe `ActivityLog` con `CFDI_CANCEL_CONFIRMED`/`CFDI_CANCEL_NOT_APPLIED`.
- Cadencia: **red de seguridad**, 1×hora (`CANCEL_RECHECK_AFTER_MS`/`CANCEL_SYNC_EVERY_MS = 60*60_000`, decisión del founder del
  24-sep-2026 — antes era cada 5 min, se bajó porque el webhook (§5.3) ya es la vía principal). `tocaRevisarCancelaciones` decide si toca
  otra pasada (primera pasada del proceso siempre toca). Tope 50 filas por pasada (`CANCEL_SYNC_MAX_PER_TICK`).

### 5.3 Webhook de Facturapi — vía PRINCIPAL (commit `1a85e940`, construido pero **sin desplegar** según la memoria del workspace)
- Ruta: `POST /api/v1/webhooks/facturapi/:emisorId`, montada con `express.raw({type:'*/*', limit:'1mb'})` **antes** de cualquier
  `express.json()` (`app.ts:136`), porque la firma (`Facturapi-Signature`) es HMAC-SHA256 sobre el cuerpo crudo (`firmaValida`,
  `facturapiWebhook.service.ts:203-208`, comparación en tiempo constante con `timingSafeEqual`).
- Controlador (`facturapi.webhook.controller.ts`) delega en `procesarAvisoDeFacturapi` (`facturapiWebhook.service.ts:214-256`). Flujo:
  emisor conocido → secreto configurado → firma válida → evento parseable → `organization` coincide (si el emisor tiene `providerOrgId`) →
  el tipo de evento está en `EVENTOS_DEL_WEBHOOK = ['invoice.cancellation_status_updated','invoice.status_updated']` → se busca la fila
  `Cfdi` por `facturapiId`+`fiscalEmisorId` → **no se le cree al cuerpo del aviso**: si `cancelStatus==='REQUESTED'` llama
  `refreshPendingCancellation` (la MISMA función del barrido); si está `STAMPED` sin cancelación en trámite, llama
  `sincronizarCancelacionExterna` (§5.4). Cualquier error al consultar el PAC sube y el controlador responde 503 para que Facturapi
  reintente (el barrido horario también la recoge).
- Alta del webhook por emisor: `asegurarWebhookDelEmisor` (mismo archivo, líneas 75-141) — idempotente, compara contra los webhooks
  existentes en Facturapi que apunten a NUESTRA url, crea uno nuevo con secreto **antes** de borrar los viejos (nunca deja al emisor sin
  webhook válido a medio camino). Se ejecuta al aprovisionar un emisor nuevo y, para los que ya existían, en la pasada horaria del job
  (`webhooksFaltantes`, `cfdiReconcile.job.ts:198-216`, tope 10 por pasada, `WEBHOOKS_FALTANTES_POR_PASADA`).
- Nota medida en el propio comentario del servicio (24-sep-2026, sandbox de Facturapi): el secreto SÓLO viene en la respuesta de crear
  (list/retrieve no lo devuelven), y crear el mismo webhook dos veces lo **duplica** (contradice la documentación de Facturapi).

### 5.4 Detección de cancelación "externa" (hecha fuera de Avoqado, p. ej. portal de Facturapi) — `sincronizarCancelacionExterna`
(`cfdi.service.ts:1391-1450`). Sólo actúa sobre `status==='STAMPED'` sin cancelación en trámite. Pregunta
`provider.getCancellationStatus(facturapiId)`; sólo escribe si el resultado es `CANCELLED`/`ACCEPTED` (un `updateMany` CAS:
`WHERE status='STAMPED' AND (cancelStatus IS NULL OR cancelStatus<>'REQUESTED')`); registra `ActivityLog` con `origen:'EXTERNA'`.

### 5.5 Campos del modelo usados (`schema.prisma:16408-16483`)
`status: CfdiStatus`, `cancelMotivo` (01-04), `cancelSubstituteUuid`, `cancelStatus: CfdiCancelStatus?`, `cancelRequestedAt`,
`cancelledAt`. No hay tabla separada de "eventos de cancelación" — todo vive en la misma fila `Cfdi`.

---

## 6. Sustitución / "refacturar tras cancelar"

- **Sustitución** (`cfdiReplacement.service.ts`, ruta §1.F): dos documentos en dos llamadas al PAC — timbrar la corregida relacionada
  (TipoRelacion `04`) y pedir cancelar la original con motivo `01` apuntando al UUID nuevo. El vínculo `Cfdi.replacesCfdiId` (schema
  16468-16475) se escribe **al reservar la fila**, antes de tocar el PAC — es el "intento durable": si el proceso muere entre timbrar la
  sustituta y cancelar la original, volver a pedir la sustitución reanuda desde donde se quedó (no vuelve a timbrar; sólo reintenta la
  cancelación — ver `replaceCfdi` líneas 121-137). La respuesta **nunca afirma** que la original quedó cancelada:
  `cancelPendiente=true` hasta que el PAC confirme `CANCELLED`/`ACCEPTED` (`cancelarOriginal`, líneas 315-355).
  - Guardas de negocio: no se sustituye una global (`isGlobal||!orderId`), ni una nota de crédito (`type!=='INGRESO'`), ni sin
    `uuid`/`facturapiId` en la original. El receptor de la sustituta se **conserva de la original** (una sustitución corrige importe, no
    a quién se factura). Mismas barreras que una emisión nueva: sobre seguro, `validateBeforeStamp`, y la barrera de dinero
    (`totalDelDocumentoCents` vs `paidCents`).
  - Guard adicional específico: si el emisor de la orden cambió desde que se emitió la original (`bundle.emisor.id !==
    original.fiscalEmisorId`), se rechaza — relacionar dos documentos de emisores distintos declararía algo falso ante el SAT.
- **"Refacturar tras cancelar"**: no es una función separada — es el mecanismo de `llaveDeEmision` (§2.2): al cancelar (confirmado por el
  PAC) la factura vigente de una orden, la próxima llamada a `issueCfdiForOrder` sobre la MISMA orden detecta que la última factura de
  venta quedó `CANCELLED` y genera una llave `-n2` en vez de reintentar la `-n1` ya muerta — permite refacturar a otra razón social o
  corregir algo que la sustitución no cubre. El controlador `issueCfdiForOrderController` distingue explícitamente "ya facturada
  vigente" (409 `CFDI_ALREADY_ISSUED`, con el texto sugiriendo "Corregir importe" para el caso de sólo-importe) de "cancelación en
  trámite" (409 `CFDI_CANCEL_PENDING`, líneas 152-157 y 79-97).
- Hay archivo de test `tests/unit/services/fiscal/cfdiRefacturar.service.test.ts` — no lo abrí en detalle, pero por nombre corresponde a
  este camino de "-nN"; no encontré un `cfdiRefacturar.service.ts` como archivo de producción separado, así que el test probablemente
  cubre `llaveDeEmision`/el flujo dentro de `cfdi.service.ts` (no lo verifiqué línea por línea — declarado, no adivinado).

---

## 7. Campos existentes que ya guardan un "snapshot" de lo facturado

Del modelo `Cfdi` (`prisma/schema.prisma:16408-16483`), lo que SÍ persiste como snapshot al momento de emitir:

| Campo | Tipo | ¿Se escribe hoy en la emisión individual? |
|---|---|---|
| `receptorRfc/receptorNombre/receptorRegimen/receptorCp/usoCfdi` | String | Sí — snapshot del receptor tal como se timbró (`baseCfdiData`, línea 528-539) |
| `formaPago`/`metodoPago` | String | Sí — lo que `buildCreateInvoiceParams` calculó |
| `subtotalCents`/`discountCents`/`taxCents`/`totalCents` | Int | Sí, subtotal/tax/total (discountCents **nunca se pasa** en el camino normal — sólo existe como columna con default 0; no encontré ningún sitio que lo escriba con un valor real en la emisión individual) |
| `taxBreakdown` | Json? | **NO se escribe** en ningún punto de la emisión individual, sustitución, ni nota de crédito (confirmado por grep global — sólo lo usa `expense.service.ts`, un dominio distinto). Es un campo del modelo sin escritor real en este flujo. |
| `facturapiId/uuid/serie/folio/stampedAt` | — | Sí, tras el timbre |
| `xmlUrl/pdfUrl/acuseUrl` | — | `xmlUrl`/`pdfUrl` sí (best-effort); `acuseUrl` no lo vi escrito en ningún archivo de este mapa |
| `lastError`/`attempts`/`idempotencyKey` | — | Sí |
| `replacesCfdiId` | — | Sí, sólo en sustitución |

**No existe ningún campo que guarde los CONCEPTOS/renglones (líneas) tal como se le mandaron al PAC.** `reconstruirConceptos` /
`conceptosDesdeRenglon` corren en memoria en cada intento y se descartan; si la venta o el catálogo cambian después (p. ej. el nombre del
producto, según el comentario de `cfdiPayloadBuilder`/`digitalReceipt.tpv.service.ts` mencionado en la tabla de fases del workspace), un
re-timbrado o una consulta posterior podrían reconstruir algo distinto de lo que efectivamente se envió la primera vez — no hay snapshot
que lo impida. `DigitalReceipt.dataSnapshot` (`schema.prisma:4609`, Json) existe pero es del **recibo digital** (ticket al cliente), no del
CFDI — un dominio separado, no reusado por la facturación.

---

## 8. Dónde se decide "no facturable" (los bloqueos "sobre seguro") — motivos y funciones

Todas las razones son strings en español que terminan visibles al staff (dashboard) o al cliente (portal autofactura), nunca códigos.
Fuentes, con su función:

| Motivo (resumen) | Función | Archivo:línea |
|---|---|---|
| Cantidad inválida, importe menor a lista, tasa/exento ambiguos, extras no cuadran, descuento>importe, venta por peso sin KGM o sin centavos exactos | `conceptosDesdeRenglon` | `cfdi.service.ts:713-821` |
| Promoción en la cuenta / cargo por servicio | `motivosDeOrden` | `cfdi.service.ts:881-890` |
| Descuento general repartido entre tasas mixtas / entre >1 concepto sin rastro de alcance | `repartirDescuentoDeOrden` / `reconstruirConceptos` | `cfdi.service.ts:829-853, 892-919` |
| Concepto con importe negativo o descuento>importe (última red) | `validarConceptos` | `cfdi.service.ts:856-867` |
| El total del documento no coincide con lo cobrado ("no se timbró; revisa la cuenta o repórtala a soporte") | inline en `loadOrderForCfdiFromDb` y en `issueCfdiForOrder` | `cfdi.service.ts:1167-1174` y `405-418` (mismo patrón en `cfdiReplacement.service.ts:199-206`) |
| Cuenta cobrada con comercios de RFC distinto / comercio sin config / comercio con facturación apagada | inline en `loadOrderForCfdiFromDb` | `cfdi.service.ts:1071-1085` |
| CSD inactivo, RFC/CP/regimen inválidos, forma de pago sin definir, sin conceptos, ObjetoImp inconsistente con impuestos, importes que no cuadran al centavo | `validateBeforeStamp` (`SIN_CONCEPTOS` es la constante exportada) | `cfdiValidation.ts:22-61` |
| Reembolso no elegible para nota de crédito (no es REFUND, no completado, sin CFDI original, original cancelada, sólo propina, excede saldo) | `checkCreditNoteEligibility` | `cfdiCreditNote.service.ts:136-185` |
| Venta ya tiene contrato de precio definido / separó impuesto al cobrar / ajuste de descuento viejo / cancelada / vino de pos-sync / de una cotización (plan 2, "contrato de precio" — **no bloquea CFDI directamente, bloquea la CONFIRMACIÓN del contrato** que la facturación plan 3 leerá) | `motivoNoConfirmable` | `confirmarContratoDePrecio.service.ts:31-45` |
| `motivosParaMostrar` combina las de arriba: si el "sobre" ya explicó por qué se quitaron renglones, omite el genérico "sin conceptos" para que la primera línea sea la causa raíz | `motivosParaMostrar` | `cfdi.service.ts:610-613` |

`unsupportedReasons` es el nombre del campo que transporta estos motivos desde `loadOrderForCfdiFromDb`/`reconstruirConceptos` hasta el
controlador; con `unsupportedReasons.length>0` el resultado es `VALIDATION_FAILED` (nunca se llama al PAC) — ver `issueCfdiForOrder` líneas
393-424 y `replaceCfdi` líneas 187-209.

---

## 9. Tests que cubren esto

**Unit:**
- `tests/unit/services/fiscal/cfdi.service.test.ts` — el motor central (reserva, sobre seguro, barrera de dinero, `llaveDeEmision`).
- `tests/unit/services/fiscal/cfdiValidation.test.ts` — `validateBeforeStamp`.
- `tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts` — `buildCreateInvoiceParams`/`buildCreditNoteParams`/`buildGlobalInvoiceParams`.
- `tests/unit/services/fiscal/assembleSaleInput.test.ts` — el mapeo Decimal→centavos.
- `tests/unit/services/fiscal/ivaMath.test.ts` — `splitIvaIncluded`/`allocateByWeights`/`splitIvaByRate`.
- `tests/unit/services/fiscal/loadOrderForCfdi.test.ts` — resolución de emisor/comercio/aislamiento de tenant.
- `tests/unit/services/fiscal/cfdiCancel.service.test.ts` — `cancelCfdi`.
- `tests/unit/services/fiscal/cfdiReplacement.service.test.ts` — sustitución.
- `tests/unit/services/fiscal/cfdiCreditNote.service.test.ts` — nota de crédito.
- `tests/unit/services/fiscal/cfdiReconcile.service.test.ts` — el job de conciliación (COMPLETED/RESET/INCONCLUSIVE/SKIPPED).
- `tests/unit/services/fiscal/cfdiGlobal.service.test.ts` — global (fuera de alcance de este mapa, pero comparte builder/validación).
- `tests/unit/services/fiscal/cfdiRefacturar.service.test.ts` — presumiblemente el "-nN" (no inspeccionado línea por línea).
- `tests/unit/services/fiscal/facturapiWebhook.service.test.ts` — firma HMAC, alta de webhook, `procesarAvisoDeFacturapi`.
- `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` y `tests/unit/controllers/public/cfdi.public.controller.test.ts`.
- `tests/unit/schemas/cfdiList.schema.test.ts`.
- `tests/unit/architecture/orderContratoDePrecioWriters.test.ts` — prueba de arquitectura: todo escritor de `Order` debe declarar
  `contratoDePrecio` (plan 2, relevante para lo que plan 3 leerá).
- `tests/unit/services/fiscal/contratoDePrecio.test.ts`, `tests/unit/services/mobile/estimate.contratoDePrecio.test.ts`.

**Integración:**
- `tests/integration/fiscal/confirmarContratoDePrecio.test.ts`, `orderContratoDePrecio.posSync.test.ts`,
  `orderContratoDePrecio.schema.test.ts`, `orderContratoDePrecio.transformaciones.test.ts` — todas de plan 2, no de emisión de CFDI en sí.

No encontré un test de integración end-to-end que golpee `POST /orders/:orderId/cfdi` contra una base real con Facturapi mockeado a nivel
HTTP (los tests de `cfdi.service.test.ts` inyectan `deps` en memoria, no hacen supertest contra rutas reales) — declarado, no confirmé
exhaustivamente cada archivo de `tests/integration/`.

---

## Resumen de lo más relevante para diseñar el "sellado" (plan 3)

1. **Hoy no hay ningún snapshot persistido de "qué se le pidió al PAC"** — ni los conceptos reconstruidos, ni el booleano
   `pricesIncludeIva`, ni el `taxRate`/`objetoImp` de cada renglón en el momento de facturar. Todo se recalcula desde `Order`/`OrderItem`/
   `Product` en cada intento. `Cfdi.taxBreakdown` es el único campo con forma para esto y **está sin usar**.
2. **`Order.contratoDePrecio` (plan 2, ya construido) todavía no lo lee ningún archivo de facturación** — la heurística vigente
   (`peso(order.taxAmount)===0`) sigue siendo la única fuente de "¿el precio ya traía IVA?" en el camino de emisión.
3. La reserva (`STAMPING` + índice único + CAS por `attempts`) es el único mecanismo de "captura durable en el momento de la reserva"
   que existe hoy; ahí sería el punto natural para escribir también un snapshot congelado de conceptos/IVA si el plan 3 decide sellar en
   ese instante.
4. El "sobre seguro" (§3.3/§8) ya es, en efecto, una función de reglas puras que decide bloquear con motivo en español — es reusable/
   extensible para las nuevas reglas de `ivaTratamiento` sin rehacer la arquitectura.
