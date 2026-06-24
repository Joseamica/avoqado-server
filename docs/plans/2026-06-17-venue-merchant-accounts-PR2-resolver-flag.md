# PR-2 — Resolver + Flag per-venue + Gate · Plan de implementación (TDD)

**Branch:** `feat/venue-merchant-accounts` · **Spec:** `docs/specs/2026-06-17-venue-merchant-accounts-design.md` (§4, §5, §6, §7)
**Construye sobre PR-1** (roster/terminal/pricing-cols ya existen + backfill).
**Garantía central:** el resolver nuevo va **detrás de un flag per-venue, default OFF**. Mergear PR-2 **no cambia el comportamiento de ningún venue**; cada venue se migra prendiendo su flag, **solo después** de que la compuerta recompute-diff salga limpia para ese venue. Reversible: apagar el flag = vuelve al comportamiento actual.

---

## Por qué un flag y no un big-bang
El bug de amaena vivió en este path (cost resolution). Con el flag default-OFF:
- Flag OFF (todos al mergear) → `createTransactionCost` se comporta **byte-por-byte como hoy** (resuelve por los 3 slots). Cero riesgo.
- Flag ON (un venue a la vez, tras el gate) → resuelve por el roster (unión), pricing per-account, etc.
- Apagar el flag revierte al instante. El peor caso siempre es 1 venue.

## Tareas (cada una: **test rojo → implementación → verde**)

### T0 — Schema/migración #2 (aditivo + nullable)
- `VenuePaymentConfig.rosterRolloutEnabled Boolean @default(false)` (+ `OrganizationPaymentConfig` equivalente) — **el flag per-venue, default OFF** → cero cambio de comportamiento al desplegar.
- `accountType` → **nullable** en `VenuePricingStructure` / `OrganizationPricingStructure` (diferido de PR-1; ahora sí, porque el resolver nuevo crea filas per-account con accountType=null).
- **CHECK exactly-one(accountType, merchantAccountId)** en ambas pricing structures (SQL crudo).
- ⚠️ Hacer `accountType` nullable cambia el tipo TS a `AccountType | null` → **arreglar los consumidores** (los que asumen non-null) para que el build no se rompa. Es la parte que diferimos de PR-1 justamente por esto.
- **Test:** migración up/down limpia; el CHECK rechaza (ambos set / ambos null); `tsc` verde tras arreglar consumidores.

### T1 — `getEffectivePricing({ venueId, accountType?, merchantAccountId?, effectiveAt? })`
- Agregar `merchantAccountId` (resuelve per-account) y `effectiveAt` (hoy hardcodea `new Date()` en `organization-payment-config.service.ts:73`). Defaults backward-compatible.
- Orden: venue per-account → **org per-account** → legacy por accountType (venue→org) → null.
- **Test:** per-account gana sobre accountType; effectiveAt resuelve la tarifa vigente en esa fecha (no la de hoy); unifica venue/org en un solo camino parametrizado (DRY — §5.7).

### T2 — Resolver gateado en `createTransactionCost` (el corazón)
- Branch por `rosterRolloutEnabled` del venue (resuelto vía getEffectivePaymentConfig):
  - **OFF** → comportamiento ACTUAL (3 slots). **No tocar este path.**
  - **ON** → resolver la cuenta real contra el **roster** (`VenueMerchantAccount`, que ya incluye org materializadas) por `payment.merchantAccountId`; precio venue per-account → org per-account → legacy (por `legacySlotType`) → fallback PRIMARY (con `effectiveAt`=fecha del pago); costo de proveedor por cuenta con fallback a PRIMARY; registrar `pricingStructureSource` + `organizationPricingStructureId` + `providerCostFallbackUsed` + `venuePricingFallbackUsed` + la cuenta REAL.
- **Test A (OFF, REGRESIÓN — crítico):** los tests actuales de `transactionCost.service` siguen verdes → cero regresión.
- **Test B (ON):** pago en cuenta SECONDARY del roster → pricing SECONDARY; pago en cuenta priority-3 → atribuido a ESA cuenta (no PRIMARY); fallback marca el flag correcto.

### T3 — Validación en `recordPayment` (ingestión, §4.3)
- Cuando el venue tiene flag ON: validar que `payment.merchantAccountId` ∈ roster (y terminal); si no → marcar `merchantResolutionStatus`/`Reason`/`originalMerchantAccountId` en vez de costear mal.
- **Test:** cuenta válida → RESOLVED; cuenta stale/fuera de roster → UNRESOLVED + no cobra mal (el cobro NO se cae).

### T4 — `getPaymentRouting` (2do endpoint TPV, §5.6)
- Resolver la cuenta seleccionada contra el roster (no solo los 3 slots) cuando flag ON.
- **Test:** routing de una cuenta priority-3 resuelve OK (hoy tiraría).

### T5 — Compuerta recompute-diff (§5.4 / §7) — gate ANTES de prender el flag
- Script read-only: recomputa TODOS los pagos del venue con el resolver nuevo (effectiveAt=fecha del pago), compara Decimal con tolerancia vs lo guardado; STOP ante cuenta sin precio / no-slot / merchant null inesperado / delta inexplicado. NO muta.
- **Test:** dataset que cuadra → pasa; cuenta sin pricing → STOP; delta inexplicado → STOP.

### T6 — Único choke-point + grep-gate (§4 capa 2)
- UNA API `assignMerchantToTerminal` (upsert roster+pricing → luego TerminalMerchantAccount). Migrar TODOS los escritores de `assignedMerchantIds` (lista en spec §4). **Gate de CI (grep/lint) que FALLA** si queda una escritura cruda.
- **Test:** la API mantiene el invariante; el grep-gate detecta una escritura cruda.

## Rollout (§7)
1. Ensayo en CLON de prod (migración #2 + recompute-diff de TODOS los venues).
2. Prender flag de **amaena** → correr gate (limpio) → canario multi-terminal (cobro real + APK viejo) → observar.
3. Expandir venue por venue.
4. (PR-5 diferido) contract: drop columnas legacy + assignedMerchantIds.

## Orden sugerido de PRs/commits
T0 → T1 → T2 (con su regresión) → T3/T4 → T5 → T6. Cada uno con tests verdes. El flag default-OFF permite mergear incrementalmente sin afectar prod.
