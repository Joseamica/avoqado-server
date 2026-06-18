# PR-1 — Expand + Backfill · Plan de implementación (TDD)

**Branch:** `feat/venue-merchant-accounts` · **Spec:** `docs/specs/2026-06-17-venue-merchant-accounts-design.md`
**Alcance:** SOLO aditivo. Crea tablas/columnas/constraints + backfill. **NADA lee el modelo nuevo** (eso es PR-2 + flag). **No puede romper producción ni el cobro.** 100% reversible (revert + drop). **No merge a develop** — PR contra la branch para revisión de Jose.

---

## Pre-requisitos del worktree
- `.env` (symlink o copia desde el checkout principal) y `npm install` dentro del worktree (necesario para `prisma` + `jest`).
- Prisma: los **partial unique indexes** y los **CHECK** NO se modelan en el schema → se editan a mano en el `migration.sql` generado (SQL crudo). Verificar versión de Prisma para `previewFeatures=["partialIndexes"]` si se prefiere declarativo.

## Tareas (cada una: **test rojo → implementación → verde**)

### T1 — Schema nuevo (Prisma) + migración
**Implementación** (`prisma/schema.prisma`):
- Modelos nuevos: `VenueMerchantAccount`, `OrganizationMerchantAccount`, `TerminalMerchantAccount` (con la FK compuesta a `VenueMerchantAccount(venueId, merchantAccountId)`). Ver §3.1/§3.2 del spec.
- Columnas nuevas: `VenuePricingStructure.merchantAccountId`, `OrganizationPricingStructure.merchantAccountId`; `TransactionCost.{pricingStructureSource, organizationPricingStructureId, providerCostFallbackUsed, venuePricingFallbackUsed}`; `Payment.{merchantResolutionStatus, merchantResolutionReason, originalMerchantAccountId}`.
- `@@unique([venueId, merchantAccountId])` en `VenueMerchantAccount` (requerido por la FK compuesta).
- Migración: `prisma migrate dev --name expand_venue_merchant_accounts`. **Editar el `migration.sql`** para agregar en SQL crudo: (a) `CHECK` exactly-one `(accountType, merchantAccountId)` en ambas pricing structures; (b) `CHECK` de `pricingStructureSource` (VENUE⇒venue-id NOT NULL/org NULL; ORG⇒org-id NOT NULL/venue NULL; TEST exento); (c) partial uniques scoped por venue/org (§3.3); (d) partial unique "un default por terminal" `(terminalId) WHERE isDefault`.

**Test T1:** migración `up` aplica limpio y `down` revierte limpio; `prisma generate` sin errores de tipo. (Verificar con una BD de test efímera.)

### T2 — Los constraints rechazan datos malos (integridad)
**Test T2** (rojo→verde, los constraints de T1 los hacen pasar):
- Insertar `TerminalMerchantAccount` con una cuenta que NO está en el roster del venue → **rechazado por la FK compuesta**.
- `VenuePricingStructure` con `accountType` Y `merchantAccountId` ambos set → **rechazado por CHECK**.
- Dos filas `isDefault=true` en la misma terminal → **rechazado por unique parcial**.
- `TransactionCost` con `source=ORG` pero `venuePricingStructureId` set → **rechazado por CHECK**.

### T3 — Backfill desde la UNIÓN (idempotente)
**Implementación** (servicio/script `backfillVenueMerchantAccounts`):
- Por venue: roster = `slots ∪ Terminal.assignedMerchantIds ∪ Payment.merchantAccountId históricos`; priority 0/1/2 = slots con `legacySlotType` seteado; 3+ = resto (`legacySlotType=null`).
- Materializar cuentas org (`inheritedFromOrg=true`).
- `TerminalMerchantAccount` desde `assignedMerchantIds`.
- Pricing backfill **history-aware**: resolver el `merchantAccountId` de cada `VenuePricingStructure` por el historial real (`TransactionCost`), no por "slot de hoy"; ambiguo → **flag de remediación humana** (no crashea).
- **IDEMPOTENTE** (upsert por claves naturales; re-correr no duplica).
- Query pre-migración: `(unión assignedMerchantIds) − (slots)` no-vacío → reportar.

**Test T3:** dataset sembrado tipo amaena (3 slots + 1 cuenta solo-en-terminal + 1 cuenta org) → backfill produce el roster correcto (priority + legacySlotType), org materializada, `TerminalMerchantAccount` correcto, pricing mapeado por historial; **re-correr NO duplica** (idempotencia); la query pre-migración reporta la cuenta solo-en-terminal.

### T4 — Compuerta recompute-diff (read-only)
**Implementación** (script `recomputeDiffGate`): recalcula TODOS los pagos del venue por su `merchantAccountId` real, con `effectiveAt = fecha del pago`, comparación **Decimal con tolerancia** vs lo guardado; **STOP** ante cuenta sin precio / no-slot / merchant null inesperado / delta inexplicado. **NO muta nada.**

**Test T4:** dataset donde todo cuadra → pasa; introducir una cuenta sin pricing → STOP; un pago con delta inexplicado → STOP; un pago con merchant null intencional (manual/QR) → se ignora limpio.

## Verificación de PR-1
- [ ] `npm run build` + `jest` (T1-T4) en verde.
- [ ] **Ensayo en CLON de prod:** correr migración + backfill + compuerta; compuerta sale **limpia**.
- [ ] Reversibilidad probada: migración `down` + drop de las 3 tablas.
- [ ] PR contra `feat/venue-merchant-accounts` (NO develop) para revisión de Jose.

## Lo que PR-1 NO hace (queda para PR-2+)
- **Nada lee** el modelo nuevo: el resolver de costo y los endpoints siguen en los 3 slots.
- Flag per-venue, writes-a-la-API única + grep-gate, validación en `recordPayment`, fix de `getPaymentRouting`, fallbacks de costo/pricing → **PR-2**.
- Contratos REST + MCP → **PR-3**. Frontends (ambos portales) → **PR-4**. Contract (drop legacy) → **PR-5** (diferido).
