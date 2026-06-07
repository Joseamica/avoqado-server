# Diseño: Módulo de Contabilidad (Avoqado Accounting) — v2 (limpio)

Status: **DRAFT — diseño consolidado.** Repos: `avoqado-server` (hub) + `avoqado-web-dashboard`. Origen: /office-hours (2026-06-05) →
/deep-research SAT → /plan-eng-review → auditoría adversaria multi-agente → decisiones del founder → /deep-research Alegra. Esta v2 integra
todo y resuelve los huecos.

**Docs compañeros (evidencia / trail):**

- Reglas fiscales MX verificadas: `2026-06-05-mexican-accounting-research.md`
- Auditoría adversaria (23 hallazgos): `2026-06-06-accounting-audit-findings.md`
- Inteligencia competitiva Alegra: `Avoqado-HQ/intelligence/competitive/2026-06-06-alegra-mexico-deep-dive.md`

---

## 1. Qué es

De facturación CFDI (ya en producción) a **contabilidad**. El dueño pidió "contabilidad incluida"; muchos lo piden. El moat: **Avoqado ya es
el sistema de registro** (pagos Blumon/Stripe, órdenes, COGS por FIFO, comisiones, CFDI) — Alegra/Contpaqi tienen que _importar_ lo que
Avoqado _genera_.

**Principio rector:** son **dos contabilidades distintas**, no una. No mezclarlas es lo que hace correcto y vendible el módulo.

|                | **Capa A — Gerencial ("¿cómo voy?")**                                     | **Capa B — Fiscal ("lo que declaro")**  |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| Para quién     | El dueño                                                                  | El contador / SAT                       |
| Qué muestra    | TODAS las ventas (efectivo incluido), marcadas `facturado`/`no facturado` | Solo lo facturado/declarado             |
| Llave de scope | **venue → Organización** (consolidable)                                   | **(Organización, RFC)** = contribuyente |
| Default        | siempre on                                                                | **opt-in, OFF** por merchant            |
| Efectivo       | siempre cuenta                                                            | solo si `includeCashInSat`              |
| Tecnología     | **read-model** sobre datos existentes                                     | ledger de doble-partida                 |
| Fase           | **Fase 1**                                                                | Fases 2–4                               |

---

## 2. Decisiones (resueltas)

**Del founder (2026-06-06):**

1. **#1 muestra el número real, con efectivo.** Tablero privado del dueño.
2. **El SAT es opt-in, OFF por default.** La mayoría solo quiere el tablero.
3. **Dueño Y contador por igual.** El contador es usuario de primera clase (rol nuevo).
4. **Clientes mezcla single/multi-RFC.** La consolidación por Organización entra al diseño.

**Resueltas con criterio (research + audit + Alegra):** 5. **Encuadre `facturado` / `no facturado`, NO "real vs oculto"** (validado: Alegra
hace exactamente esta distinción con su "Gestión de efectivo"). El ingreso lleva un booleano `facturado`. El dueño ve todo; el toggle decide
qué fluye a la Capa B. **No hay "almacén oculto" separado** → se persiste cada venta normal con su flag; baja la carga legal (es "ventas sin
factura", concepto contable normal). 6. **Reconocimiento de ingreso por PAGO COBRADO (base flujo de efectivo)**, no por Order.subtotal — lo
exige el IVA en flujo (research) y evita doble-conteo en parciales/split. Subtotal proporcional:
`subtotal_pago = Payment.amount × (Order.subtotal / Order.total)`. 7. **Scope fiscal por `(organizationId, rfc)`, NO por `fiscalEmisorId`**
(audit P1-6: el mismo RFC en 2 venues = 2 filas FiscalEmisor pero **un solo contribuyente, un solo juego de libros**). Se agregan los
FiscalEmisor del mismo RFC dentro de la org. _Se evita introducir una entidad `FiscalTaxpayer` por ahora_ para no refactorizar el modelo
CFDI en producción; `FiscalTaxpayer` queda como refactor limpio opcional cuando se construya la Capa B (Fase 3), no antes. 8. **MXN-only**
(audit P3-22): invariante "contabilidad solo MXN"; rechazar/avisar pagos o gastos no-MXN al postear (con test). `currency`+`tipoCambio` se
añaden solo si aparece demanda real.

---

## 3. Capa A — Gerencial (Fase 1, read-model)

Servicio de reportes que **agrega los eventos fuente directo** (sin ledger). Scope: **venue**, consolidable a **Organización**.

### Fuentes (GROUNDED — leídas línea por línea del código, 2026-06-06)

| Fuente     | Modelo / servicio real (archivo:línea)                                                                                                                                                                                                                                    | Aporta                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Ingreso    | `Payment.amount` (`schema:2671`) — **ya ex-propina** desde el tip-split 2026-04-19; en V1 **sin IVA agregado**. Patrón canónico: `generalStats` revenue-por-día (`Payment.amount`, status=COMPLETED) / `mergedPayments.fetchPaymentsForAnalytics` (excluye `type=REFUND`) | Ingreso (flujo)                   |
| Propina    | `Payment.tipAmount` (`schema:2672`)                                                                                                                                                                                                                                       | Línea aparte (no es ingreso)      |
| Refunds    | Payment **`type=REFUND`, `status=COMPLETED`, `amount`+`tipAmount` NEGATIVOS** (`refund.tpv.service.ts:267-274`, `refund.dashboard.service.ts:350-359`). NO `status=REFUNDED` (eso es legacy/hack, handful)                                                                | Restan ingreso/propina            |
| IVA        | **IVA INCLUIDO** (founder): `neto = monto/(1+taxRate)`, `IVA = monto − neto` (16% → /1.16) vía `product.taxRate` (`schema:1320`). **NO** `Order.taxAmount` (=0). Coincide con JSDoc `cfdiPayloadBuilder` `total/1.16`                                                     | Neto + IVA trasladado             |
| COGS       | `RawMaterialMovement.costImpact` (`schema:1878`; `venueId`, `type=USAGE`, `reference=orderId`; FIFO desde `StockBatch.costPerUnit`, `fifoBatch.service.ts:403`)                                                                                                           | Costo de ventas (**solo RECIPE**) |
| Fee        | `TransactionCost.venueChargeAmount` (`schema:4424`, 1:1 por `paymentId`; refunds = mirror negativo) — NO `Payment.feeAmount` (en refunds es 0)                                                                                                                            | Lo que el venue paga a Avoqado    |
| Comisiones | `CommissionPayout`                                                                                                                                                                                                                                                        | Gasto de comisiones               |
| CFDI       | `Cfdi` (liga por `orderId`; global = sin orderId)                                                                                                                                                                                                                         | `facturado` a nivel ORDEN         |

### Reglas de cálculo Capa A (GROUNDED — corrigen TANTO el v2 como el fix del audit)

- **Ingreso = Σ `Payment.amount`** (`type∈{REGULAR,FAST}`, `status=COMPLETED`) **− Σ abs(`Payment.amount`)** (`type=REFUND`,
  `status=COMPLETED`). **Excluir `type=TEST`.** En V1 `amount` ya es net, ex-propina y **sin IVA agregado** → es directamente el ingreso.
  **NO prorratear sobre Order** (era innecesario: el audit y el v2 asumían precios IVA-incluido; el código real es precios NET con IVA
  encima). Reusar `fetchPaymentsForAnalytics` (`mergedPayments.service.ts:76`, ya excluye REFUND) o sumar firmado (como `cashCloseout`).
- **Propina** = Σ `Payment.tipAmount` (línea aparte). Refunds **pre-2026-04-19 traen tip POSITIVO** → normalizar con regla por fecha.
- **COGS** = Σ abs(`RawMaterialMovement.costImpact`) (`venueId`, `type=USAGE`, periodo). **Incompleto por diseño:** solo productos
  **RECIPE** (+modificadores) graban costo en la venta. **QUANTITY** (retail) NO graba costo al deducir (`InventoryMovement` type=SALE sin
  `unitCost`) → estimar `Product.cost × qty`. **Serializado** (SIMs/ PlayTelecom) **no tiene costo** → COGS 0. Marcar el margen como
  "estimado" donde aplique. (open question abajo.)
- **Fee de procesamiento** = Σ `TransactionCost.venueChargeAmount` (+`venueFixedFee`); ya neto de refunds (mirrors negativos).
- **`facturado`** = nivel ORDEN (`Cfdi.orderId`); CFDI global (sin orderId) = periodo/emisor → marca las ventas no-individuales (efectivo)
  que cubre.
- **Efectivo** (CASH): cuenta a nivel **venue** en Capa A (CASH no trae `merchantAccountId` → no resuelve emisor; eso solo afecta Capa B).
- **Periodo** en timezone del venue (`venueStartOfDay/EndOfDay`); consolidación org + periodo fiscal usan **tz canónico por (org,RFC)**.
- **Scope resolver:** `organizationId` = `Payment.venueId → Venue.organizationId` (`schema:110`, siempre disponible). emisor/RFC (Capa B) =
  merchant → `MerchantFiscalConfig` (`merchantAccountId` **@unique** → **UN** emisor, no varía por venue) → `FiscalEmisor.rfc` con guard
  `FiscalEmisor.venueId === Payment.venueId` (`cfdi.service.ts:417`). **CASH/sin-merchant → no resuelve emisor individual → factura global**
  (`includeInGlobal`), NO individual.

### Performance (audit P2-19)

El índice `[venueId, status, createdAt]` NO cubre agrupar por emisor. Agregar por `merchantAccountId/ecommerceMerchantId` (sí indexado,
`schema:2768`) en una query, y mapear merchant→emisor en una segunda query pequeña (catálogo de merchants, no de pagos). Una sola
agregación, nunca cargar pagos a memoria.

### Salidas Capa A

Estado de resultados (ingreso−COGS−gastos−comisiones−fees), márgenes, flujo, comparativos (vs mes anterior / meta). Dashboard sector-aware
(reusa terminología por BusinessCategory). **Consolidación por Organización** (dueño con varios venues/RFCs ve todo junto) — wedge real
(Alegra solo conmuta entre empresas, no consolida). **MCP:** tool de lectura del P&L en `src/mcp/tools/` (lockstep).

### Invariante

La Capa A **no postea al ledger**. Cuando llegue la Capa B (Fase 3), un **test de reconciliación** asegura `read-model == ledger` para el
mismo periodo/scope.

---

## 4. Capa B — Fiscal (Fases 2–4, ledger de doble-partida)

**Opt-in por merchant** (`satAccountingEnabled=false` default). Scope: **(org, RFC)**. Gateada por régimen: RESICO PF/PM, Arrendamiento,
Serv. Prof., RIF están **exentos del envío** de contabilidad electrónica (research) → el envío XML solo para régimen general; los demás usan
la Capa B solo para reportes internos si la prenden.

### Posting engine (event-driven, idempotente)

Reusa el patrón de idempotencia del módulo CFDI (slot reservation por `idempotencyKey`). Cada evento postea UNA póliza balanceada.
**Invariante duro: Σdebe == Σhaber por póliza.**

| Evento                           | Debe                                          | Haber                                 | Notas                                                   |
| -------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Pago cobrado                     | Banco/Clearing                                | Ingresos + IVA trasladado **cobrado** | IVA en FLUJO (al cobro, no al facturar)                 |
| COGS (FIFO)                      | Costo de ventas                               | Inventario                            |                                                         |
| Fee procesador                   | Gastos de comisión                            | Banco/Clearing                        | de `Payment.feeAmount`                                  |
| Gasto c/CFDI prov.               | Gasto/Inventario + IVA acreditable **pagado** | Banco o CxP                           | acreditable al pagar (+REP en PPD)                      |
| Comisión vendedor                | Sueldos/Comisiones                            | Banco o CxP                           |                                                         |
| **CFDI cancelado** (audit P2-18) | (reversa/storno)                              |                                       | póliza de reversa fechada en `cancelledAt`, idempotente |

**Cuentas puente de IVA en flujo** (research): `IVA trasladado cobrado` (208) vs `no cobrado`, `IVA acreditable pagado` (118.01) vs
`pendiente` (118).

### Contabilidad electrónica SAT (Anexo 24, XSD v1.3)

- **Catálogo de cuentas** por (org,RFC) con `satGroupingCode` (código agrupador, obligatorio). Seed: tabla de referencia del catálogo
  oficial c_CuentasSAT (~600 códigos) + catálogo base por BusinessCategory con el agrupador ya mapeado, incl. cuentas-puente de IVA (audit
  P2-13). El usuario puede ajustar.
- **Balanza** mensual XML (`NumCta, SaldoIni, Debe, Haber, SaldoFin` + header `RFC/Mes 01-13/Año/TipoEnvio N|C`). **Saldos** vía tabla
  `AccountPeriodBalance` (snapshot al cierre): `SaldoIni(N) = SaldoFin(N-1)` sin recomputar histórico; soporta TipoEnvio=C (audit P2-15).
- **Pólizas** XML = **on-demand** (auditoría/devolución/compensación), NO mensual.
- **DIOT** mensual: requiere RFC del proveedor validado + tipo de tercero (04/05/15) + IVA por tasa (audit P2-14). RESICO PF exento de DIOT.

### Modelos (Prisma) — scope por (org, RFC)

```
LedgerAccount   organizationId, rfc, code, satGroupingCode, name, type, nature, parentId, isPostable
                @@unique([organizationId, rfc, code])
JournalEntry    organizationId, rfc, venueId(info), date, period(YYYY-MM), folio, type, source,
                sourceId, idempotencyKey @unique, status,
                uuidCfdi?, rfcTercero?, montoCfdiConIvaCents?   // nodo CompNal de la póliza XML
JournalLine     journalEntryId, ledgerAccountId, debitCents, creditCents, description  // Σdebe==Σhaber
Expense         organizationId, rfc, venueId(info), supplierId(→Supplier), date, dueDate, category,
                subtotalCents, ivaCents, totalCents, receivedCfdiUuid, paymentStatus, ledgerJournalEntryId,
                rfcProveedor, tipoTercero(04|05|15), ivaTasa(16|8|0|EXENTO), repUuid?   // DIOT + PPD
FiscalPeriod    organizationId, rfc, period(YYYY-MM), status(OPEN|CLOSED), closedAt  @@unique([organizationId, rfc, period])
AccountPeriodBalance  ledgerAccountId, fiscalPeriodId(FK), period, saldoIniCents, debeCents, haberCents, saldoFinCents
                @@unique([ledgerAccountId, period])   // v2 audit P1-5; versionar/isCurrent para TipoEnvio=C
// Catálogo XML (Anexo 24) además requiere Nivel (derivado de parentId, máx 2) + SubCtaDe + header propio [v2 P2-13]
```

Reusa: `Supplier` (proveedores), `FiscalEmisor`/`MerchantFiscalConfig` (RFC, régimen, toggles).

### Onboarding / ciclo de vida (audit P1-11, P2-16, P2-17)

- **Saldos iniciales**: captura manual por cuenta (caja, bancos, inventario valuado, CxC/CxP, capital) → asiento de apertura fechado al
  inicio del primer periodo. Pre-requisito de Fase 3.
- **Eventos tardíos** (POS-sync/settlements llegan días después): postear al periodo abierto; si está cerrado → póliza al periodo abierto
  referenciando el original, o re-envío TipoEnvio=C.
- **Backfill del ledger** (cuando llegue Fase 3): los eventos NO son todos inmutables (refunds, rate-corrections, ajustes de inventario) →
  enumerar clases no-inmutables y definir su semántica (reversa+re-post o póliza de ajuste fechada). El test de reconciliación es el gate.

---

## 5. Config y permisos

`MerchantFiscalConfig` (extiende el patrón existente):

- `satAccountingEnabled` (default **false**) — lleva libros SAT en Avoqado.
- `includeCashInSat` (default **false**) — el efectivo entra a los libros SAT.

Feature de paga: **`ACCOUNTING`** (`VenueFeature`, Pro, con trial/suspended como CFDI).

- **Capa A (#1)** → incluida/teaser (gancho de retención; ataca el premium ~3.6x de Alegra por la contabilidad).
- **Capa B (#2–#4)** → Pro pagado.

Permisos nuevos (catalog + defaults + audit `npm run audit:permissions`):

- `accounting:view`, `accounting:manage`, `accounting:export`.
- **Rol "Contador"** (audit/decisión #3): ver + exportar lo fiscal, **sin** tocar la operación. Invitable sin costo (copiar a Alegra:
  asiento de contador que no cuenta contra el límite de usuarios). Calendario fiscal por RFC con recordatorios.

---

### Capa de mapeo de cuentas ("el sistema dicta") — validado en Alegra (Configuración contable)

Modelo nuevo `AccountMapping` por **(org, RFC)**: **tipo-de-movimiento → `LedgerAccount`**. Pre-sembrado con defaults por BusinessCategory
("cuentas recomendadas") y **editable por el Contador**. Cada posteo lee este mapa para elegir la cuenta → **asientos automáticos sin que un
humano escoja cuenta cada vez**. Es LA pieza que hace posible "el sistema dicta". Mapea: Ventas (ingreso) · Devoluciones · Inventario ·
Ajustes de inventario · CxC clientes · CxP proveedores · Patrimonio (utilidad/pérdida del ejercicio, ganancias acumuladas, ajustes de saldos
iniciales en banco/inventario) · diferencias cambiarias/decimales · IVA/retenciones (se configuran en Impuestos, aparte). Sin este mapa, "el
sistema dicta" no es realizable.

### Centro de costos = venue (multi-venue dentro de un RFC) — validado en Alegra

Un `venue` dentro de un RFC se mapea a un **centro de costos** del ledger. **Resuelve elegante el hallazgo del audit** (varios venues en un
mismo RFC): **un solo juego de libros por RFC, rebanado por venue** vía centro de costos — sin libros separados.
`JournalEntry`/`JournalLine` llevan `costCenterId (= venueId)`; los reportes (estado de resultados, libro diario, balanza) filtran por
centro de costos. Esto **reemplaza** la "open question de prorrateo multi-emisor" para el caso 1-RFC-varios-venues: ya no se prorratea, se
rebana por centro de costos.

## 6. Posición competitiva (vs Alegra)

- **Copiar:** contador gratis + calendario fiscal por RFC; factura global XAXX/616/S01 (ya: Flow C); "Gestión de efectivo" (ingreso sin CFDI
  contabilizado); Contabilizador Fiscal (ingesta de CFDI del SAT para gastos).
- **Ganar:** (1) **FIFO real** vs promedio-ponderado de Alegra; (2) **nace con la data** (genera CFDI, no los importa "a ciegas"); (3)
  **consolidación real** multi-RFC; (4) **bundle barato** vs su producto contable a 3.6x; (5) WhatsApp-nativo.
- **Evitar:** automatización ciega (posteo debe ser transparente, Σdebe=Σhaber), modelo dos-SKU confuso, marketing RESICO-only.

---

## 7. Secuencia de construcción (orden, no recorte — el alcance es TODO)

**Fase 0 — Cimiento mínimo (sin ledger).** Resolución pago→merchant→emisor (reusa cadena de `loadOrderForCfdiFromDb`, pero leyendo TODOS los
pagos del periodo, no `take:1`); helpers de periodo (ya existen); Feature `ACCOUNTING` + permisos + rol Contador; flag `facturado` derivado.

**Fase 1 — Capa A "¿Cuánto gané?" (read-model, primer envío).** Estado de resultados por venue + consolidado por org; reglas de §3; MCP. →
diferenciador inmediato; valida incluida-vs-pagada con uso real.

**Fase 2 — Gastos / proveedores / DIOT (Capa B empieza).** Captura de gastos + CFDI recibidos (Contabilizador Fiscal), CxP, IVA acreditable,
RFC+tipoTercero+tasa para DIOT. Opt-in. Pro.

**Fase 3 — Ledger + contabilidad electrónica SAT.** Posting engine + LedgerAccount + balanza/catálogo XML + AccountPeriodBalance + saldos
iniciales + cierre de periodo + reconciliación read-model==ledger. Gateada por régimen. Pro.

**Fase 4 — Nómina.** CFDI de nómina, IMSS, ISR, subsidio. **NO investigada aún** → deep-research dedicado antes de diseñar. Decisión
build-vs-integrar (facturapi nómina vs partner).

---

## 8. Invariantes y correctness (no negociables)

- Toda póliza cuadra: **Σdebe == Σhaber** (test + check al postear).
- Posteo **idempotente** (reintentos/webhooks duplicados no duplican).
- Reconciliación **read-model (A) == ledger (B)** por periodo/scope.
- Money en **centavos enteros** end-to-end. **Asumir MXN** (Payment/Order NO tienen campo `currency`; el sistema es MXN de facto — no se
  puede "rechazar no-MXN" sin agregar el campo; añadir `currency` solo si surge demanda). [v2 audit P2-15]
- Tenant isolation: Capa A por `venueId`/`organizationId`; Capa B por `(organizationId, rfc)`.
- **ActivityLog** en cada mutación (cierre de periodo, asiento manual, envío SAT, cancelación).

## 9. Open questions (genuinamente abiertas)

- **✅ Modelo de IVA — RESUELTO (founder, 2026-06-07): IVA INCLUIDO.** En México el precio al público ya trae el IVA adentro: si el menú
  dice $100, el cliente paga $100 y eso incluye el 16%. Regla: **`neto = monto / (1+taxRate)`**, **`IVA trasladado = monto − neto`** (16% →
  /1.16; 8% → /1.08; 0%/exento → /1.0), por línea según `product.taxRate`. Coincide con el JSDoc de `cfdiPayloadBuilder`
  (`net = total/1.16`). Capa A: ingreso neto = Σ(`Payment.amount`/(1+taxRate)), ex-propina; bruto como línea secundaria. Capa B: "IVA
  trasladado cobrado" (208) = la parte de IVA embebida. Tasas a soportar (validado en Alegra): **16/8/0/ exento** + IVA no acreditable +
  IEPS, flag **acreditable Sí/No**. **🔴 POSIBLE BUG VIVO de facturación (verificado en código 2026-06-07):** el CFDI trata
  `OrderItem.unitPrice` (= `product.price`, el precio del menú) como **NET** y le manda a facturapi `tax_included: false` → facturapi **SUMA
  16% encima** (`assembleSaleInput.ts:10,44` + `cfdiPayloadBuilder.ts:37,103`). Pero si el precio del menú **ya incluye IVA** (norma en
  México, confirmado por founder), el CFDI timbra un total **~16% MAYOR** que lo que el cliente pagó (sobre-factura base + IVA). No hay flag
  "precios con IVA incluido". **Confirmar contra una factura real de producción** (¿total del CFDI == ticket pagado, o ×1.16?). Si confirma,
  el módulo CFDI debe tratar el precio como GROSS (`net = price/1.16`, `tax_included:true` o derivar). Independiente del módulo de
  contabilidad — es del módulo de facturación en prod.
- **🟠 COGS de QUANTITY y serializado:** hoy NO se graba costo en la venta para retail (QUANTITY) ni serializado (SIMs/PlayTelecom).
  ¿Capturar snapshot del costo al deducir (cambio en el flujo de inventario), o estimar con `Product.cost`? Afecta directo el margen de tus
  sectores retail/PlayTelecom.
- **Persistencia del "real con efectivo":** resuelto a "se persiste como venta normal con flag `facturado`" — confirmar postura final con
  calma (¿algún cliente quiere poder _no_ persistir ciertas ventas?).
- **`FiscalTaxpayer` como entidad** (refactor limpio del scope fiscal) vs `(org,rfc)` agregado: decidir al construir Fase 3.
- **Consolidación con eliminaciones inter-compañía** (si un dueño se factura entre sus propios RFCs): ¿hace falta?
- **Nómina, saldos iniciales de Alegra, quejas reales de usuarios:** sub-verificados → research dedicado si pesan.

## 10. Qué NO entra (deferido)

- Ledger en Fase 1 (es read-model). Pólizas XML mensuales (son on-demand). Nómina/ISR/NIF (no investigados).
- Multi-moneda (MXN-only por ahora). `FiscalTaxpayer` (hasta Fase 3).
- **Conciliación bancaria (Fase 3+) — vía SUBIR estado de cuenta, NO integración bancaria.** Patrón validado en Alegra: el venue sube su
  estado de cuenta (PDF/CSV) y se concilia contra los Payment/Settlement con matching automático + anti-duplicados. **Evita construir 40+
  integraciones bancarias** (lo caro/riesgoso). Esa es la forma de enviar conciliación barato; la conexión directa a bancos queda para mucho
  después, si acaso.

## 11. The Assignment (gate real antes de codear)

Valida con **5 nombres**: en tus próximas conversaciones donde salga "contabilidad", pregunta _"¿quieres ver cuánto ganaste (tablero) o que
reemplace a tu contador (pólizas/nómina)?"_ + ¿incluida o pagarías? Con 5 respuestas sabes si la Capa A es el wedge y si la Capa B tiene
comprador real.
