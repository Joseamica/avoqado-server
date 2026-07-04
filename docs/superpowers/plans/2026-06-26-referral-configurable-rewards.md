# Programa de Referidos — Premios Configurables por Nivel · Plan de Implementación (avoqado-server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer configurable el tipo de premio por nivel del programa de referidos (cupón %, % permanente, producto gratis), con emisión
idempotente y refund por grants, sin romper el sistema vivo en producción.

**Architecture:** Se separa CONFIG (`ReferralTierReward`) de EMISIÓN (`ReferralRewardGrant`) + un guard de desbloqueo de por vida
(`ReferralTierUnlock`). La emisión corre en una transacción con claim atómico por orden. El dashboard y el MCP son fachadas finas sobre el
mismo `referralProgram.service`. Spec fuente: `docs/superpowers/specs/2026-06-26-referral-configurable-rewards-design.md` (v5, 4 rondas de
auditoría Codex).

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, Jest (unit con `prismaMock`), MCP (`src/mcp/`).

## Global Constraints

- **Sistema VIVO en producción.** Migración `20260529012230_add_referral_program` ya aplicada; venue `Mindform`
  (`cmisvi38o001fhr2828ygmxi2`) con 1,941 clientes. Nada debe alterar el comportamiento actual de venues que solo usan `PERCENT_COUPON`.
- **Migraciones:** SIEMPRE `npx prisma migrate dev --name <desc>`. NUNCA `npx prisma db push`.
- **Dinero/porcentaje = `Prisma.Decimal`**, nunca float. Money ops dentro de `prisma.$transaction()`.
- **Tenant isolation:** toda query filtra por `venueId`. `authContext` (NO `req.user`): `{ userId, orgId, venueId, role }`.
- **Zod en español, shape-only.** Reglas de negocio en el servicio, no en el schema.
- **ActivityLog** en toda mutación audit-worthy (`action`, `entity`, `entityId`, `staffId` desde authContext, `venueId`, `data`).
- **Schema map obligatorio** al agregar modelos: actualizar `scripts/generate-schema-map.ts` (`MODEL_TO_DOMAIN`) + `npm run schema:map`, en
  el mismo commit.
- **prismaMock es registro manual** (`tests/__helpers__/setup.ts`): cada `prisma.<model>` nuevo debe registrarse ahí o los tests lanzan
  `Cannot read undefined`.
- **Test dates:** relativas (`Date.now() + N días`), nunca hardcoded. Correr date-sensitive con `TZ=UTC`.
- **Tras editar:** `npm run format && npm run lint:fix`. Antes de push: `npm run pre-deploy`.
- **NO commits sin permiso explícito del usuario.** Los pasos "Commit" se ejecutan solo si el usuario lo autorizó.

---

### Task 1: Schema — enums, 3 tablas, relaciones, partial-unique

**Files:**

- Modify: `prisma/schema.prisma` (modelos `ReferralProgramConfig`, `Referral`, `Customer`, `Venue`, `Discount`, `Product`; + 3 modelos y 3
  enums nuevos)
- Modify: `scripts/generate-schema-map.ts` (`MODEL_TO_DOMAIN`)
- Create: `prisma/migrations/<timestamp>_referral_configurable_rewards/migration.sql` (generado)

**Interfaces:**

- Produces: modelos `ReferralTierReward`, `ReferralRewardGrant`, `ReferralTierUnlock`; enums `ReferralRewardType`,
  `ReferralRewardRecurrence`, `ReferralGrantStatus`. Estos los consumen las Tasks 2–9.

- [ ] **Step 1: Añadir enums y modelos al schema**

Copiar los enums (§4.1), `ReferralTierReward` (§4.2), `ReferralRewardGrant` (§4.3) y `ReferralTierUnlock` (§4.3b) del spec **verbatim** en
`prisma/schema.prisma`. Añadir las back-relations a modelos existentes:

```prisma
// en model Customer:
referralGrants       ReferralRewardGrant[]
referralTierUnlocks  ReferralTierUnlock[]
// en model Referral:
referralGrants  ReferralRewardGrant[]
// en model Venue:
referralGrants  ReferralRewardGrant[]
// en model Discount:
referralGrants  ReferralRewardGrant[]
// en model Product:
referralRewardConfigs ReferralTierReward[] @relation("ReferralRewardProduct")
// en model ReferralProgramConfig:
tierRewards ReferralTierReward[]
```

- [ ] **Step 2: Añadir el partial-unique de `Referral`**

Prisma no expresa índices parciales con `@@unique`; se hace en SQL crudo en la migración. En el modelo `Referral` deja solo el índice
existente; el partial-unique se crea en Step 5.

- [ ] **Step 3: Registrar los 3 modelos en el schema map**

En `scripts/generate-schema-map.ts`, añadir a `MODEL_TO_DOMAIN` (mismo dominio que `Referral` / `ReferralProgramConfig` — buscar dónde están
y copiar su placement):

```typescript
ReferralTierReward: '<mismo dominio que Referral>',
ReferralRewardGrant: '<mismo dominio que Referral>',
ReferralTierUnlock: '<mismo dominio que Referral>',
```

- [ ] **Step 4: Generar la migración**

Run: `npx prisma migrate dev --name referral_configurable_rewards` Expected: crea `prisma/migrations/<ts>_referral_configurable_rewards/` y
aplica en dev sin error. Prisma Client regenerado.

- [ ] **Step 5: Añadir el partial-unique + preflight a mano en el SQL de la migración**

Editar el `migration.sql` recién generado y añadir AL INICIO (antes del `CREATE UNIQUE INDEX`) el preflight de dedupe, y luego el índice
parcial (§4.5.b):

```sql
-- PREFLIGHT: void de referrals duplicados por orden (conservar el más antiguo).
-- Desempate por (createdAt, id): con timestamps IGUALES, el par (createdAt,id) sigue
-- siendo un orden total → sobrevive exactamente uno (Codex r5: sin el tie-breaker,
-- empates de createdAt dejaban varios activos y el índice único abortaba igual).
UPDATE "Referral" r SET "status" = 'VOID', "voidedAt" = now(),
  "voidReason" = 'dedupe_for_partial_unique_migration'
WHERE r."qualifyingOrderId" IS NOT NULL
  AND r."status" IN ('PENDING','QUALIFIED')
  AND EXISTS (
    SELECT 1 FROM "Referral" r2
    WHERE r2."qualifyingOrderId" = r."qualifyingOrderId"
      AND r2."status" IN ('PENDING','QUALIFIED')
      AND (r2."createdAt", r2."id") < (r."createdAt", r."id")
  );

CREATE UNIQUE INDEX "Referral_qualifyingOrderId_active_key"
  ON "Referral" ("qualifyingOrderId")
  WHERE "status" IN ('PENDING','QUALIFIED') AND "qualifyingOrderId" IS NOT NULL;
```

- [ ] **Step 6: Regenerar el schema map y verificar build**

Run: `npm run schema:map && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20` Expected: `docs/SCHEMA_MAP.md` actualizado con los 3 modelos;
typecheck sin errores nuevos en archivos de schema.

- [ ] **Step 7: Registrar los modelos nuevos en `prismaMock`**

En `tests/__helpers__/setup.ts`, añadir al registro manual (copiar el patrón de un modelo existente, con defaults seguros):

```typescript
referralTierReward: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
referralRewardGrant: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
referralTierUnlock: { createMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations docs/SCHEMA_MAP.md scripts/generate-schema-map.ts tests/__helpers__/setup.ts
git commit -m "feat(referrals): schema for configurable tier rewards (grant + unlock tables)"
```

---

### Task 2: Migración de datos — backfill ReferralTierReward + ReferralTierUnlock

**Files:**

- Create: `prisma/migrations/<ts>_referral_backfill/migration.sql` (data-only, generada con `--create-only`)
- Test: `tests/integration/referrals/migration-backfill.integration.test.ts`

**Interfaces:**

- Consumes: tablas de Task 1.
- Produces: cada `ReferralProgramConfig` tiene 3 `ReferralTierReward` (`PERCENT_COUPON`); cada `Customer` con `referralTier ≥ TIER_1` tiene
  filas `ReferralTierUnlock` para TODOS los niveles ganados.

- [ ] **Step 1: Escribir el test de integración (red)**

```typescript
// Usa la DB de integración (real). Setup: 1 config con tier{1,2,3}RewardPercent = 15/20/25,
// y 1 customer con referralTier = 'TIER_2'.
it('backfills 3 tier rewards per config from flat fields', async () => {
  await runBackfillSql() // helper que ejecuta el migration.sql data step
  const rewards = await prisma.referralTierReward.findMany({ where: { configId } })
  expect(rewards).toHaveLength(3)
  expect(rewards.find(r => r.tierLevel === 1)).toMatchObject({ rewardType: 'PERCENT_COUPON', rewardPercent: expect.anything() })
})
it('backfills tier-unlock rows for ALL earned levels, not just current', async () => {
  await runBackfillSql()
  const unlocks = await prisma.referralTierUnlock.findMany({ where: { customerId: tier2CustomerId } })
  expect(unlocks.map(u => u.tierLevel).sort()).toEqual([1, 2]) // TIER_2 => niveles 1 y 2
})
```

- [ ] **Step 2: Correr el test (verificar que falla)**

Run: `npm run test:api -- migration-backfill` Expected: FAIL (el SQL de backfill aún no existe).

- [ ] **Step 3: Escribir el SQL de backfill**

`npx prisma migrate dev --create-only --name referral_backfill`, luego en el `migration.sql`:

```sql
-- IDs en formato cuid-compatible (25 chars, prefijo 'c') per regla del repo
-- (CLAUDE.md "Production Data Inserts: IDs MUST be cuid format"). En SQL puro no
-- hay cuid v1 real; 'c' + 24 hex de md5(uuid) respeta el formato del catálogo.
-- a. 3 ReferralTierReward por config desde los campos planos
INSERT INTO "ReferralTierReward" ("id","configId","tierLevel","rewardType","recurrence","rewardPercent","rewardQuantity","active","createdAt","updatedAt")
SELECT 'c' || substr(md5(gen_random_uuid()::text), 1, 24), c."id", lvl.n, 'PERCENT_COUPON', 'ONE_TIME',
       CASE lvl.n WHEN 1 THEN c."tier1RewardPercent" WHEN 2 THEN c."tier2RewardPercent" ELSE c."tier3RewardPercent" END,
       1, true, now(), now()
FROM "ReferralProgramConfig" c CROSS JOIN (VALUES (1),(2),(3)) AS lvl(n);

-- c. ReferralTierUnlock para TODOS los niveles ya alcanzados (TIER_3 => 1,2,3)
INSERT INTO "ReferralTierUnlock" ("id","customerId","tierLevel","unlockedAt")
SELECT 'c' || substr(md5(gen_random_uuid()::text), 1, 24), cu."id", lvl.n, now()
FROM "Customer" cu CROSS JOIN (VALUES (1),(2),(3)) AS lvl(n)
WHERE cu."referralTier" IS NOT NULL
  AND lvl.n <= CASE cu."referralTier" WHEN 'TIER_1' THEN 1 WHEN 'TIER_2' THEN 2 WHEN 'TIER_3' THEN 3 ELSE 0 END;
```

- [ ] **Step 4: Aplicar y correr el test (verde)**

Run: `npx prisma migrate dev && npm run test:api -- migration-backfill` Expected: PASS ambos tests.

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations tests/integration/referrals/migration-backfill.integration.test.ts
git commit -m "feat(referrals): data migration backfill for tier rewards + lifetime unlocks"
```

---

### Task 3: Config service — premios por nivel (activate/update + validación)

**Files:**

- Modify: `src/services/referrals/referralProgram.service.ts`
- Modify: `src/schemas/dashboard/referrals.schemas.ts`
- Test: `tests/unit/services/referrals/referralProgram.service.test.ts`

**Interfaces:**

- Produces: `updateReferralConfig(input: { venueId, tiers: TierRewardInput[] })` y `activateReferralProgram` que escriben
  `ReferralTierReward` (no los campos planos).
  `TierRewardInput = { tierLevel, rewardType, recurrence?, rewardPercent?, rewardProductId?, rewardQuantity? }`.

- [ ] **Step 1: Escribir el test (red)**

```typescript
it('rejects FREE_PRODUCT whose product belongs to another venue', async () => {
  prismaMock.product.findFirst.mockResolvedValue(null) // no existe en este venue
  await expect(
    updateReferralConfig({
      venueId: 'v1',
      tiers: [{ tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardProductId: 'p-other-venue', rewardQuantity: 1 }],
    }),
  ).rejects.toThrow('PRODUCTO_NO_PERTENECE_AL_VENUE')
})
it('persists a percent reward as a ReferralTierReward row', async () => {
  prismaMock.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg1', venueId: 'v1' } as any)
  await updateReferralConfig({ venueId: 'v1', tiers: [{ tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 }] })
  expect(prismaMock.referralTierReward.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ tierLevel: 1, rewardType: 'PERCENT_COUPON' }),
    }),
  )
})
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm run test:unit -- referralProgram.service` Expected: FAIL (`updateReferralConfig` no acepta `tiers`).

- [ ] **Step 3: Implementar la validación + persistencia**

En `referralProgram.service.ts`, ampliar `updateReferralConfig`. Validación de negocio en el servicio (no en Zod):

```typescript
for (const t of input.tiers) {
  if (t.rewardType === 'FREE_PRODUCT') {
    const product = await prisma.product.findFirst({ where: { id: t.rewardProductId, venueId: input.venueId }, select: { id: true } })
    if (!product) throw new Error('PRODUCTO_NO_PERTENECE_AL_VENUE')
  }
  if (
    (t.rewardType === 'PERCENT_COUPON' || t.rewardType === 'PERMANENT_DISCOUNT') &&
    (t.rewardPercent == null || Number(t.rewardPercent) < 0)
  )
    throw new Error('PORCENTAJE_INVALIDO')
}
// Versionado: desactivar filas viejas con grants, recrear (ver spec §4.2)
```

Actualizar `referrals.schemas.ts` para aceptar `tiers` (Zod shape-only, mensajes en español). NO escribir más los campos planos.

- [ ] **Step 4: Correr el test (verde)**

Run: `npm run test:unit -- referralProgram.service` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals/referralProgram.service.ts src/schemas/dashboard/referrals.schemas.ts tests/unit/services/referrals/referralProgram.service.test.ts
git commit -m "feat(referrals): config service accepts per-tier reward types with same-venue validation"
```

---

### Task 4: Emisión idempotente de premios (`emitTierReward` por grant)

**Files:**

- Modify: `src/services/referrals/referralQualification.service.ts`
- Test: `tests/unit/services/referrals/referralQualification.service.test.ts`

**Interfaces:**

- Consumes: `ReferralTierReward` (Task 3), grant/unlock tables (Task 1).
- Produces: `emitTierRewards(tx, { venueId, customer, tierLevel })` que itera los `ReferralTierReward` ACTIVOS del nivel y crea un
  `ReferralRewardGrant` por cada uno (idempotente vía unique), emitiendo el artefacto según `rewardType`. `computeTier` se mantiene sin
  cambios.

- [ ] **Step 1: Escribir tests (red) — uno por rewardType + idempotencia**

```typescript
it('PERCENT_COUPON emits Discount+CustomerDiscount+CouponCode and an ISSUED grant', async () => {
  /* mock tierReward PERCENT_COUPON; assert grant.create con status ISSUED + discount.create */
})
it('PERMANENT_DISCOUNT emits an isAutomatic Discount with no validUntil/maxUses', async () => {
  /* assert discount.create con isAutomatic:true, validUntil:null, maxUses:null */
})
it('FREE_PRODUCT emits NO discount, only a MANUAL_PENDING grant', async () => {
  // assert: discount.create NO llamado; grant.create con status 'MANUAL_PENDING', discountId null
})
it('skips emission when the grant already exists (createMany count 0)', async () => {
  // ⚠️ NO capturar P2002 dentro de la tx: un constraint error ABORTA la tx de
  // Postgres entera (Codex r5). Idempotencia = createMany skipDuplicates + count.
  prismaMock.referralRewardGrant.createMany.mockResolvedValueOnce({ count: 0 }) // ya existía
  await emitTierRewards(txMock, { venueId, customer, tierLevel: 1 })
  expect(prismaMock.discount.create).not.toHaveBeenCalled() // no doble-minteo
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- referralQualification.service` Expected: FAIL (`emitTierRewards` no existe).

- [ ] **Step 3: Implementar `emitTierRewards`**

Reescribir el `emitTierReward` actual (hoy emite un solo cupón, líneas ~52–125) como `emitTierRewards` que itera los `ReferralTierReward`
activos del nivel. Para cada uno, `createMany({ data: [grant], skipDuplicates: true })` y si `count === 0` → skip idempotente (⚠️ NUNCA
capturar P2002 dentro de la tx: el constraint error aborta la tx de Postgres — Codex r5); si `count === 1` → emitir según tipo (tabla §5) y
`update` del grant con los ids del artefacto. El `Discount` de `PERCENT_COUPON` conserva la forma actual; el `PERMANENT_DISCOUNT` usa
`isAutomatic:true`, sin `validUntil`/`maxUses`; `FREE_PRODUCT` no emite artefacto (`status:'MANUAL_PENDING'`).

- [ ] **Step 4: Correr (verde)**

Run: `npm run test:unit -- referralQualification.service` Expected: PASS los 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals/referralQualification.service.ts tests/unit/services/referrals/referralQualification.service.test.ts
git commit -m "feat(referrals): emit N rewards per tier as grants, idempotent by unique constraint"
```

---

### Task 5: `onOrderPaid` — claim atómico por orden + unlock guard

**Files:**

- Modify: `src/services/referrals/referralQualification.service.ts`
- Test: `tests/unit/services/referrals/onOrderPaid.test.ts`

**Interfaces:**

- Consumes: `emitTierRewards` (Task 4).
- Produces: `onOrderPaid({ orderId, venueId })` transaccional, idempotente por orden y por desbloqueo.

- [ ] **Step 1: Escribir tests (red)**

```typescript
it('claims the referral by qualifyingOrderId; second run is a no-op', async () => {
  prismaMock.referral.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
  await onOrderPaid({ orderId: 'o1', venueId: 'v1' }) // count 1 → procesa
  await onOrderPaid({ orderId: 'o1', venueId: 'v1' }) // count 0 → aborta
  expect(prismaMock.customer.update).toHaveBeenCalledTimes(1) // un solo incremento
})
it('aborts emission if the tier unlock already exists (createMany count 0)', async () => {
  prismaMock.referralTierUnlock.createMany.mockResolvedValueOnce({ count: 0 }) // ya desbloqueado
  await onOrderPaid({ orderId: 'o2', venueId: 'v1' })
  expect(prismaMock.referralRewardGrant.createMany).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- onOrderPaid` Expected: FAIL.

- [ ] **Step 3: Implementar el flujo §5**

Reescribir `onOrderPaid` siguiendo los 7 pasos del §5: CAS
`referral.updateMany({ where: { qualifyingOrderId: orderId, status: 'PENDING' }, data: { status: 'QUALIFIED', qualifiedAt } })` → si
`count === 0` return; incrementar count; recomputar tier; `referralTierUnlock.createMany({ data: [...], skipDuplicates: true })` y si
`count === 0` → return (⚠️ NO capturar P2002: aborta la tx); `emitTierRewards`; actualizar `referralTier`; `ActivityLog`. Todo en
`prisma.$transaction`. Email tier-up se mantiene fire-and-forget FUERA de la tx.

- [ ] **Step 4: Correr (verde)**

Run: `npm run test:unit -- onOrderPaid` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals/referralQualification.service.ts tests/unit/services/referrals/onOrderPaid.test.ts
git commit -m "feat(referrals): atomic per-order claim + lifetime unlock guard in onOrderPaid"
```

---

### Task 6: Refund — revocación por grants

**Files:**

- Modify: `src/services/referrals/referralRefund.service.ts`
- Test: `tests/unit/services/referrals/referralRefund.service.test.ts`

**Interfaces:**

- Consumes: grants (Task 1).
- Produces: `onOrderRefunded({ orderId, venueId })` que revoca todos los grants del tier desbloqueado por la orden, por tipo (§6).

- [ ] **Step 1: Escribir tests (red)**

```typescript
it('revokes an unredeemed PERCENT_COUPON grant', async () => {
  /* grant ISSUED PERCENT_COUPON → discount/couponCode deactivated, grant REVOKED */
})
it('does NOT revoke a REDEEMED coupon grant', async () => {
  /* grant REDEEMED → sin cambios */
})
it('marks an already-applied PERMANENT_DISCOUNT grant REVOKED (no clawback)', async () => {
  prismaMock.orderDiscount.findFirst.mockResolvedValue({ id: 'od1' } as any) // ya aplicado
  await onOrderRefunded({ orderId, venueId })
  expect(prismaMock.referralRewardGrant.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'REVOKED', revokeReason: expect.stringContaining('permanente') }),
    }),
  )
})
it('does not delete the ReferralTierUnlock on refund', async () => {
  /* assert referralTierUnlock.delete NO llamado */
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- referralRefund.service` Expected: FAIL.

- [ ] **Step 3: Implementar §6**

Reescribir `onOrderRefunded`: buscar los `ReferralRewardGrant` del referral/tier de la orden; por cada uno, ramificar por `rewardType` y
`status` según la tabla §6. Para `PERMANENT_DISCOUNT`, consultar `OrderDiscount` (no `CouponRedemption`) para decidir. NO borrar
`ReferralTierUnlock`.

- [ ] **Step 4: Correr (verde)**

Run: `npm run test:unit -- referralRefund.service` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals/referralRefund.service.ts tests/unit/services/referrals/referralRefund.service.test.ts
git commit -m "feat(referrals): refund revokes all tier grants by type via grant table"
```

---

### Task 7: Mover lectores de campos planos a grants/rewards

**Files:**

- Modify: `src/services/referrals/referralReads.service.ts:19`
- Modify: `src/controllers/dashboard/referrals/referrals.controller.ts:14` (getConfig)
- Test: `tests/unit/services/referrals/referralReads.service.test.ts`

**Interfaces:**

- Consumes: grants (Task 1), `ReferralTierReward` (Task 3).
- Produces: reads que proyectan los `ReferralRewardGrant` (varios) por referral, y config que devuelve `tierRewards`.

- [ ] **Step 1: Escribir el test (red)**

```typescript
it('projects multiple reward grants per referral (not a single rewardDiscount)', async () => {
  prismaMock.referralRewardGrant.findMany.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }] as any)
  const res = await listCustomerReferrals({ venueId, customerId })
  expect(res[0].rewards).toHaveLength(2)
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- referralReads.service` Expected: FAIL.

- [ ] **Step 3: Implementar**

En `referralReads.service.ts`, reemplazar la proyección de `rewardDiscount` (uno) por `referralGrants` (varios). En
`referrals.controller.ts` `getConfig`, devolver `tierRewards` además de los umbrales. Ningún lector debe leer `tier{N}RewardPercent`.

- [ ] **Step 4: Correr (verde) + grep de seguridad**

Run: `npm run test:unit -- referralReads.service && grep -rn "tier1RewardPercent\|tier2RewardPercent\|tier3RewardPercent" src/` Expected:
tests PASS; el grep NO devuelve lecturas en `src/` (solo, a lo sumo, la migración de Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals/referralReads.service.ts src/controllers/dashboard/referrals/referrals.controller.ts tests/unit/services/referrals/referralReads.service.test.ts
git commit -m "feat(referrals): reads project reward grants; config returns tierRewards (retire flat fields)"
```

---

### Task 8: FREE_PRODUCT manual — fulfill endpoint

**Files:**

- Modify: `src/services/referrals/referralReads.service.ts` (o nuevo `referralGrant.service.ts`)
- Modify: `src/routes/dashboard/referrals.routes.ts`
- Modify: `src/controllers/dashboard/referrals/referrals.controller.ts`
- Modify: `src/lib/permissions.ts` (perm `referral:fulfill-courtesy`)
- Test: `tests/unit/services/referrals/fulfillGrant.test.ts`

**Interfaces:**

- Produces: `POST /referrals/grants/:grantId/fulfill` → marca un grant `MANUAL_PENDING` como `MANUAL_FULFILLED` con
  `fulfilledByStaffVenueId` + `ActivityLog`.

- [ ] **Step 1: Escribir el test (red)**

```typescript
it('marks a MANUAL_PENDING grant as MANUAL_FULFILLED', async () => {
  prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'MANUAL_PENDING', venueId } as any)
  await fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })
  expect(prismaMock.referralRewardGrant.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'MANUAL_FULFILLED', fulfilledByStaffVenueId: 'sv1' }),
    }),
  )
})
it('rejects fulfilling a non-pending grant', async () => {
  /* status ISSUED → throw 'GRANT_NO_PENDIENTE' */
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- fulfillGrant` Expected: FAIL.

- [ ] **Step 3: Implementar servicio + ruta + permiso**

`fulfillGrant` valida `status === 'MANUAL_PENDING'` (si no, throw), actualiza a `MANUAL_FULFILLED`, escribe `ActivityLog`
(`action:'REFERRAL_COURTESY_FULFILLED'`). Añadir permiso `referral:fulfill-courtesy` a `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` +
`DEFAULT_PERMISSIONS` (MANAGER+) en `permissions.ts`. Ruta con `checkPermission('referral:fulfill-courtesy')`. Correr
`npm run audit:permissions` (exit 0).

- [ ] **Step 4: Correr (verde)**

Run: `npm run test:unit -- fulfillGrant && npm run audit:permissions` Expected: tests PASS; audit exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/services/referrals src/routes/dashboard/referrals.routes.ts src/controllers/dashboard/referrals/referrals.controller.ts src/lib/permissions.ts tests/unit/services/referrals/fulfillGrant.test.ts
git commit -m "feat(referrals): manual courtesy fulfill endpoint for FREE_PRODUCT grants"
```

---

### Task 9: MCP — `configure_referral` + `referral_status` + plan-gate

**Files:**

- Create: `src/mcp/tools/referrals.ts`
- Modify: `src/mcp/server.ts` (registrar)
- Modify: `src/mcp/planGate.ts` (aceptar `REFERRAL_PROGRAM` si falta)
- Test: `tests/unit/mcp/tools/referrals.test.ts`

**Interfaces:**

- Consumes: `referralProgram.service` (Task 3).
- Produces: tools MCP `configure_referral` (write) y `referral_status` (read), calcados de `configure_loyalty`
  (`src/mcp/tools/loyalty.ts:128`).

- [ ] **Step 1: Escribir el test (red)**

```typescript
it('configure_referral requires referral:configure and the REFERRAL_PROGRAM plan gate', async () => {
  // mock guard.requirePermission throw si falta el permiso; planGateMessage devuelve string si no hay plan
  // assert: sin permiso → ScopeError; sin plan → text({ ok:false, planRequired:true })
})
it('configure_referral calls updateReferralConfig and audits the write', async () => {
  // assert updateReferralConfig llamado + auditMcpWrite con action 'REFERRAL_CONFIG_UPDATED'
})
```

- [ ] **Step 2: Correr (falla)**

Run: `npm run test:unit -- mcp/tools/referrals` Expected: FAIL.

- [ ] **Step 3: Implementar las tools**

Copiar la estructura de `registerLoyaltyTools` (`loyalty.ts:128`): `guard.venueFilter` +
`guard.requirePermission('referral:configure', venueId)` + `planGateMessage(venueId, 'REFERRAL_PROGRAM', 'El programa de referidos')` +
llamar `updateReferralConfig`/lectura + `auditMcpWrite({ action:'REFERRAL_CONFIG_UPDATED', entity:'ReferralProgramConfig', ... })` +
`return text({ ok:true, ... })`. Registrar `registerReferralTools(server, scope)` en `src/mcp/server.ts`. Asegurar que `REFERRAL_PROGRAM`
esté en el catálogo de `planGate.ts`.

- [ ] **Step 4: Correr (verde)**

Run: `npm run test:unit -- mcp/tools/referrals` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/referrals.ts src/mcp/server.ts src/mcp/planGate.ts tests/unit/mcp/tools/referrals.test.ts
git commit -m "feat(mcp): configure_referral + referral_status tools (gated by REFERRAL_PROGRAM)"
```

---

### Task 10: Regresión, verificación TPV y suite completa

**Files:**

- Test: `tests/unit/services/referrals/regression.test.ts`
- Doc: `docs/superpowers/specs/2026-06-26-referral-configurable-rewards-design.md` (§16 — resolver la pregunta abierta)

**Interfaces:**

- Consumes: todo lo anterior.

- [ ] **Step 1: Test golden de regresión (red→green)**

```typescript
it('a PERCENT_COUPON-only venue behaves identically to before', async () => {
  // config con 3 tiers PERCENT_COUPON; cruzar tier 1 emite exactamente 1 cupón %,
  // mismo shape que el comportamiento legacy. Sin permanentes, sin productos.
})
```

Run: `npm run test:unit -- regression` → PASS.

- [ ] **Step 2: Verificar la dependencia del `/discounts/auto` en TPV (§8)**

Run: `grep -rn "discounts/auto\|applyAutomaticDiscounts" ../avoqado-tpv/app/src 2>/dev/null | head` Si el TPV NO invoca el endpoint en el
cobro: anotar en §16 del spec que `PERMANENT_DISCOUNT` requiere un cambio en TPV (fuera de este plan) y NO marcar el feature como entregado
para ese tipo. Si SÍ lo invoca: resolver §16 como "verificado".

- [ ] **Step 3: Suite completa + pre-deploy**

Run: `npm run test:unit && npm run pre-deploy` Expected: toda la suite verde; pre-deploy exit 0.

- [ ] **Step 4: Format + lint**

Run: `npm run format && npm run lint:fix`

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/referrals/regression.test.ts docs/superpowers/specs/2026-06-26-referral-configurable-rewards-design.md
git commit -m "test(referrals): golden regression + resolve TPV auto-apply verification"
```

---

## Fuera de alcance de este plan (planes complementarios)

- **Dashboard UI** (`avoqado-web-dashboard`): ampliar `ReferralsSettings.tsx` con el dropdown de tipo de premio + revelación progresiva, y
  mostrar "cortesía pendiente" en `ReferralCard.tsx`. Repo distinto → plan separado.
- **Presentación de ventas** (`Avoqado-HQ/.../platform-presentation/`): actualizar deck + one-pager + PDFs por el Nivel 3 con producto
  gratis (capacidad customer-visible).
- **v2** (spec §9): `FREE_PRODUCT` automático (arreglar canje de cupón item-scope), `MONTHLY` con cron, WhatsApp automático, captura manual
  en dashboard.

## Self-Review (hecho)

- **Cobertura del spec:** §4 (Tasks 1–2) · §5 emisión (Tasks 4–5) · §6 refund (Task 6) · §4.5 lectores (Task 7) · FREE_PRODUCT manual
  (Task 8) · §7 MCP (Task 9) · §8 verificación TPV (Task 10) · §12 pruebas (cada task) · §10 gating (Task 9). Dashboard (§7) → plan
  complementario, declarado arriba.
- **Sin placeholders:** cada task tiene tests y código clave concretos; los detalles extensos referencian la sección exacta del spec ya
  verificado.
- **Consistencia de tipos:** `emitTierRewards`, `onOrderPaid`, `onOrderRefunded`, `updateReferralConfig`, `fulfillGrant` usados con las
  mismas firmas entre tasks.
