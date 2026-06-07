# Auditoría adversaria — Módulo de Contabilidad (2026-06-06)

Generado por workflow multi-agente (gstack) — 5 revisores independientes + verificación adversaria por hallazgo. 31 agentes · 327 tool-uses
· contexto fresco. Verificados contra el plan + `prisma/schema.prisma` + servicios reales. Compañero de:
`2026-06-05-accounting-module-design.md`

**Resultado: 23 hallazgos confirmados — 5 P0, 7 P1, 9 P2, 2 P3.** El plan tenía `VERDICT: CLEARED` → **revocado**: hay 5 P0 que rompen
correctness antes de construir.

---

## P0 — Rompen correctness. Arreglar ANTES de construir Fase 1.

**P0-1 / P0-3 / (refuerzo P1-8, P1-12) — El mecanismo de refunds del plan está AL REVÉS.** El plan dice 4 veces "refunds (REFUNDED) restan".
Pero en este codebase **un refund NO es `status=REFUNDED`**: es un Payment NUEVO con `type=REFUND`, `status=COMPLETED`, `amount` NEGATIVO
(verificado en `refund.tpv.service.ts:256-309`, `refund.dashboard.service.ts:5`, `generalStats.dashboard.service.ts:405`). `Payment.status`
usa `TransactionStatus`, no `PaymentStatus` (ese enum es de `Order.paymentStatus`). → Si se implementa literal, **filtraría 0 filas → los
refunds nunca se restan → ingreso inflado**, y el test "CRÍTICO" pasaría en falso. **FIX:** ingreso neto = Σ `amount` de
`type∈{REGULAR,FAST}` `status=COMPLETED` − Σ abs(`amount`) de `type=REFUND`. Reusar el patrón ya probado en
`generalStats`/`cashCloseout`/`sales-summary.dashboard.service.ts:791-808`. Nota: TPV separa refund en `amount` (venta) y `tipAmount`
(propina) desde 2026-04-19 → restar solo la venta.

**P0-2 / P0-5 / (P2-20) — Base de reconocimiento de ingreso sin definir (Payment vs Order) → doble-conteo o pérdida.** El plan dice "ingreso
= subtotal de Order" pero el emisor se resuelve POR PAGO. Una Order con pagos parciales (`paymentStatus=PARTIAL`) o split (`SplitType`) → si
se agrupa por Payment se cuenta varias veces; si se reconoce el subtotal completo en PARTIAL se cuenta ingreso no cobrado (contradice IVA en
flujo de efectivo de la research). **FIX:** reconocer por **Payment cobrado (base flujo)**, NO por Order.subtotal. Derivar el subtotal
proporcional: `subtotal_pago = Payment.amount × (Order.subtotal / Order.total)`. Sumar por Order una sola vez, atribuido al emisor del pago.
`loadOrderForCfdiFromDb` NO se puede reusar tal cual (hace `take:1`; el read-model necesita todos los pagos del periodo).

**P0-4 — Pagos en EFECTIVO (y legacy) no tienen merchant → el ingreso real cae a 0 en el P&L por emisor.** El scope por emisor se resuelve
vía `Payment.merchantAccountId/ecommerceMerchantId`; CASH no lleva merchant. **FIX:** regla de atribución explícita: si el venue tiene 1
emisor (caso común) → todo pago sin merchant va a ese emisor por defecto; si multi-emisor → emisor por defecto configurable o avisar. Sin
esto, los venues de efectivo ven $0.

## P1 — Foundational. Migración dolorosa si se descubre tarde.

**P1-6 — El scope correcto es el CONTRIBUYENTE (RFC), no `fiscalEmisorId`.** `FiscalEmisor` es `@@unique([venueId, rfc])` → el MISMO RFC
operando en 2 venues = 2 filas FiscalEmisor = 2 libros separados, cuando legalmente es **un solo contribuyente, un solo juego de libros**. →
Refina la corrección D2: scopear por **taxpayer (RFC)**, no por la fila emisor. Opciones: (a) nueva entidad `FiscalTaxpayer` (RFC+régimen) a
la que apuntan N FiscalEmisor; (b) scopear por `(organizationId, rfc)` agregando emisores. **[Decisión del founder]**

**P1-7 — Falta consolidación a nivel Organization.** Un dueño con varios RFCs querrá ver todo junto (#1 gerencial) vs por RFC (legal/SAT
#4). **FIX:** `organizationId` denormalizado + índice en JournalEntry/Expense/read-model; definir jerarquía de reportes (RFC vs
Organization).

**P1-9 — El scope por emisor NO es realizable para Comisiones ni Gastos en multi-emisor.** `CommissionPayout` y `Supplier` son venue-scoped,
sin FK a merchant/emisor. La Open Question de prorrateo (que yo limité a COGS) **debe cubrir también comisiones y gastos**.

**P1-10 — La comisión del procesador (`Payment.feeAmount`) nunca entra al P&L.** Gasto operativo real omitido, y está disponible sin captura
extra (es el moat "nace con la data"). **FIX:** línea de gasto "Comisiones de procesamiento" = Σ `feeAmount`. Revisar `TransactionCost` por
si ya consolida.

**P1-11 — Sin plan para saldos iniciales (SaldoIni) de venues que ya operan.** La balanza XML (Fase 3) los exige. **FIX:** mecanismo de
saldos de apertura (captura manual por cuenta → asiento de apertura fechado), pre-requisito de Fase 3.

**P1-8 — Refunds parciales y atribución de periodo.** El refund revierte ingreso+IVA en el periodo DEL REEMBOLSO, no del cargo; soportar
montos parciales. Netear por monto reembolsado, no excluir la orden.

**P1-12 — "REFUNDED" ambiguo entre dos enums.** Determinar empíricamente cómo se registra hoy ANTES de escribir la query (ver P0-1).

## P2 — Deberían resolverse.

- **P2-13** Seed del catálogo `c_CuentasSAT` nunca aterrizado: necesita tabla de referencia (~600 códigos del Anexo 24) + catálogo base de
  cuentas por BusinessCategory con `satGroupingCode` mapeado (incl. cuentas-puente de IVA).
- **P2-14** DIOT no generable: `Supplier.taxId` nullable y sin validar; falta "tipo de tercero" (04/05/15). Requerir+validar RFC en Fase 2.
- **P2-15** Balanza: SaldoIni/SaldoFin son saldos acumulados que dependen de cierres previos. Modelar `AccountPeriodBalance` (snapshot al
  cierre) para que SaldoIni(N)=SaldoFin(N-1) sin recomputar histórico + soportar TipoEnvio=C.
- **P2-16** El backfill "desde eventos inmutables" es premisa falsa: refunds, rate-corrections y ajustes de inventario mutan. Enumerar
  eventos no-inmutables y su semántica (reversa+re-post o póliza de ajuste).
- **P2-17** Cierre de periodo sin política de eventos tardíos (POS-sync/settlements llegan días después) ni reapertura. Mapear TipoEnvio
  N/C.
- **P2-18** Cancelación de CFDI ya posteado sin reversa contable (afecta ingreso, IVA cobrado, nodo CompNal). Agregar `Cfdi.CANCELLED` como
  evento → póliza de storno idempotente.
- **P2-19** El índice `[venueId,status,createdAt]` NO cubre groupBy por emisor (emisor no es columna de Payment). Agregar por
  `merchantAccountId` (sí indexado, schema:2768) y mapear merchant→emisor en query aparte.
- **P2-21** Riesgo de doble-conteo del gasto de comisiones: fee de cobro = `Payment.feeAmount`; comisión a vendedor se devenga vía
  `CommissionCalculation`, no `CommissionPayout` (que es el desembolso/flujo).

## P3 — Nice-to-have / decisión explícita.

- **P3-22** Modelos sin `currency`: declarar invariante "contabilidad solo MXN" + validar/rechazar no-MXN al postear, o agregar
  `currency`+`tipoCambio` desde el día 0 (migración dolorosa si se decide tarde).
- **P3-23** CFDI cancelado sin refund de pago deja ingreso/IVA inflado en el read-model → definir tratamiento (base Payment vs CFDI
  vigente).

---

## Meta-lección

La falla de "merchants" no fue aislada: el plan tenía **5 P0** porque se escribió sin leer a fondo cómo Avoqado registra pagos/refunds
realmente (type=REFUND negativo, cash sin merchant, parciales, fees). La causa raíz: asumir semántica en vez de leer los servicios
existentes (`refund.*.service.ts`, `generalStats`, `cashCloseout`, `sales-summary`). **Antes de implementar Fase 1, leer esos servicios y
reusar sus patrones de agregación — no reinventar.**

---

## SEGUNDO PASE (sobre el plan v2 reescrito) — 21 hallazgos: 2 P0, 8 P1, 11 P2

Converge (1ª ronda 5 P0 → 2ª 2 P0). Todos folded al plan v2 §3/§4/§8.

**P0 (2) — mismo origen: descomponer dinero desde campos en vez de leer la realidad del POS:**

- IVA desde `Order.taxAmount` (≡0 forzado en el POS) → IVA salía 0, neto inflado ~13.8%. FIX: derivar del precio IVA-incluido
  (`net=monto/(1+taxRate)`), reusar `cfdiPayloadBuilder`.
- `subtotal_pago = amount × (subtotal/total)`: `amount` ex-propina ÷ `total` con-propina → subdeclara en toda orden con tip. FIX:
  descomponer `Payment.amount` directo (ya ex-propina).

**P1 (8):** COGS real en `RawMaterialMovement.costImpact` (no `InventoryMovement`); `MerchantAccount` sin venueId/orgId y compartido entre
venues (merchant→emisor NO 1:1); `facturado` no es per-pago (CFDI liga orderId; global no liga); timezone canónico por (org,RFC);
`AccountPeriodBalance` necesita unique+FK; resolver pago→(org,RFC) de 1ª clase.

**P2 (11):** fee del venue = `TransactionCost.venueChargeAmount` (no `Payment.feeAmount`); excluir `type=TEST`; verificar con SQL cómo se
graban refunds (type=REFUND "// Future" vs status=REFUNDED coexisten); tip POSITIVO en refunds pre-2026-04-19; catálogo XML necesita
Nivel/SubCtaDe; MXN inaplicable (no hay campo currency) → "asumir MXN".

**Trend:** 5 P0 → 2 P0, mismo patrón (leer la realidad del POS, no los nombres de campo). **Diminishing returns en auditar prosa** — el
siguiente dólar de correctness se gana leyendo los servicios reales al implementar Fase 1 (tests al centavo), no en una 3ª auditoría del
documento.
