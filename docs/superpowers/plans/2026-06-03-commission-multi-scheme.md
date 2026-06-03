# Multi-Scheme Commissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one venue run multiple commission schemes at once (each scoped to its own product categories, all paying correctly), and let a tiered scheme use each employee's sales goal as a tier boundary.

**Architecture:** The payment-completion engine changes from resolving ONE config (`findActiveCommissionConfig`, a `findFirst`) to evaluating ALL active configs per payment — each category-scoped config bills its own categories, an optional catch-all config bills the leftover. A new `STAFF_GOAL` tier-threshold type lets a tier boundary resolve to the staff member's goal at calculation time. Idempotency moves from per-payment to per-(payment, config, staff).

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, Jest (unit, mocked Prisma via `tests/__helpers__/setup.ts`). Frontend: React + Vite (`avoqado-web-dashboard`).

**Spec:** [docs/superpowers/specs/2026-06-03-commission-multi-scheme-design.md](../specs/2026-06-03-commission-multi-scheme-design.md)

---

## Phase ordering & deploy discipline

- **Phase 1 (backend, this repo)** is independently shippable and must deploy + stabilize first (per repo cross-repo rule).
- **Phase 2 (dashboard UI)** depends on Phase 1 being deployed.
- **Phase 3 (Mindform data cleanup + MCP sync)** is ops/coordination after Phase 1.

## File Structure (Phase 1 backend)

| File | Responsibility | Change |
|---|---|---|
| `prisma/schema.prisma` | `CommissionTier` model + `ThresholdType` enum | Modify |
| `src/services/dashboard/commission/commission-utils.ts` | config lookups, base-amount helpers, types | Modify (add `findActiveCommissionConfigs`, `calculateLeftoverAmount`; extend `CommissionTierData`) |
| `src/services/dashboard/commission/commission-tier.service.ts` | tier resolution | Modify (`getStaffTierProgress` resolves `STAFF_GOAL` boundaries) |
| `src/services/dashboard/commission/commission-calculation.service.ts` | per-payment calc | Modify (multi-config loop + `createCalcForConfig` helper; refund mirrors all calcs) |
| `tests/unit/services/dashboard/commission-multi-scheme.test.ts` | engine tests | Rename from `commission-multi-config-limitation.test.ts` + expand |

---

## Task 1: Schema — `STAFF_GOAL` tier threshold type

**Files:**
- Modify: `prisma/schema.prisma` (enum block near `TierType`/`TierPeriod`; model `CommissionTier` ~line 7873)
- Migration: `prisma/migrations/<generated>/`

- [ ] **Step 1: Add the enum**

Add near the other commission enums (search for `enum TierType`):

```prisma
enum ThresholdType {
  FIXED
  STAFF_GOAL
}
```

- [ ] **Step 2: Add two columns to `CommissionTier`**

In `model CommissionTier`, after the `maxThreshold` field, add:

```prisma
  // A tier boundary can be a fixed amount (default) or resolve to the staff
  // member's active sales goal at calculation time (STAFF_GOAL).
  minThresholdType ThresholdType @default(FIXED)
  maxThresholdType ThresholdType @default(FIXED)
```

- [ ] **Step 3: Create the migration**

Run: `npx prisma migrate dev --name commission_tier_goal_threshold`
Expected: a new migration folder is created; `ThresholdType` enum + two columns added with `DEFAULT 'FIXED'`. All existing tiers keep `FIXED` (non-breaking).

> NOTE: No new Prisma *model* is added, so `scripts/generate-schema-map.ts` / `npm run schema:map` do NOT need updating (that rule applies to new models only).

- [ ] **Step 4: Regenerate client & typecheck**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: no errors (the new enum + fields are available on `Prisma.CommissionTier`).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(commissions): add STAFF_GOAL tier threshold type"
```

---

## Task 2: `findActiveCommissionConfigs` (plural) + `calculateLeftoverAmount`

**Files:**
- Modify: `src/services/dashboard/commission/commission-utils.ts`
- Test: `tests/unit/services/dashboard/commission-utils.test.ts`

- [ ] **Step 1: Extend the `CommissionTierData` interface**

At the top of `commission-utils.ts`, add `ThresholdType` to the prisma import:

```typescript
import { CommissionRecipient, StaffRole, CommissionCalcType, TierType, TierPeriod, ThresholdType } from '@prisma/client'
```

Add the two fields to `interface CommissionTierData`:

```typescript
  minThresholdType: ThresholdType
  maxThresholdType: ThresholdType
```

- [ ] **Step 2: Write the failing test for `calculateLeftoverAmount`**

Add to `commission-utils.test.ts`:

```typescript
import { calculateLeftoverAmount } from '../../../../src/services/dashboard/commission/commission-utils'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

describe('calculateLeftoverAmount', () => {
  it('sums only items whose category is NOT in the claimed set (incl. uncategorized)', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { quantity: 2, unitPrice: new Decimal(100), taxAmount: new Decimal(0), discountAmount: new Decimal(0) },
      { quantity: 1, unitPrice: new Decimal(50), taxAmount: new Decimal(0), discountAmount: new Decimal(0) },
    ])
    const total = await calculateLeftoverAmount('order-1', ['cat-claimed'], { includeTax: false, includeDiscount: false })
    expect(total).toBe(250)
    const where = prismaMock.orderItem.findMany.mock.calls[0][0].where
    expect(JSON.stringify(where)).toContain('notIn')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest tests/unit/services/dashboard/commission-utils.test.ts -t calculateLeftoverAmount`
Expected: FAIL — `calculateLeftoverAmount is not a function`.

- [ ] **Step 4: Implement `calculateLeftoverAmount`**

Add to `commission-utils.ts` (next to `calculateCategoryFilteredAmount`):

```typescript
/**
 * Sum order items whose product category is NOT in `claimedCategoryIds`
 * (plus uncategorized items). Used by a catch-all commission config so it
 * only bills the part of the order no category-scoped config already claims.
 */
export async function calculateLeftoverAmount(
  orderId: string,
  claimedCategoryIds: string[],
  config: { includeTax: boolean; includeDiscount: boolean },
): Promise<number> {
  const orderItems = await prisma.orderItem.findMany({
    where: {
      orderId,
      OR: [{ product: { categoryId: { notIn: claimedCategoryIds } } }, { product: { categoryId: null } }],
    },
    select: { quantity: true, unitPrice: true, taxAmount: true, discountAmount: true },
  })

  if (orderItems.length === 0) return 0

  let total = 0
  for (const item of orderItems) {
    let itemAmount = decimalToNumber(item.unitPrice) * item.quantity
    if (config.includeTax) itemAmount += decimalToNumber(item.taxAmount)
    if (config.includeDiscount) itemAmount += decimalToNumber(item.discountAmount)
    total += itemAmount
  }
  return total
}
```

- [ ] **Step 5: Add `findActiveCommissionConfigs` (plural)**

Add to `commission-utils.ts` directly below `findActiveCommissionConfig` (keep the singular — `createManualCommission` and the split path still use it):

```typescript
/**
 * Find ALL active commission configs for a venue at a given date.
 * Venue-level configs take precedence: if any exist, org-level configs are
 * ignored (mirrors findActiveCommissionConfig's venue-over-org fallback).
 * Returned highest-priority first.
 */
export async function findActiveCommissionConfigs(
  venueId: string,
  effectiveDate: Date = new Date(),
): Promise<CommissionConfigWithRelations[]> {
  const includeTiers = { tiers: { where: { active: true }, orderBy: { tierLevel: 'asc' as const } } }
  const dateFilter = {
    active: true,
    deletedAt: null,
    effectiveFrom: { lte: effectiveDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
  }

  const venueConfigs = await prisma.commissionConfig.findMany({
    where: { venueId, ...dateFilter },
    include: includeTiers,
    orderBy: { priority: 'desc' },
  })
  if (venueConfigs.length > 0) {
    return venueConfigs.map(c => ({ ...c, roleRates: c.roleRates as RoleRates | null, tiers: c.tiers as CommissionTierData[] }))
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue?.organizationId) return []

  const orgConfigs = await prisma.commissionConfig.findMany({
    where: { orgId: venue.organizationId, venueId: null, ...dateFilter },
    include: includeTiers,
    orderBy: { priority: 'desc' },
  })
  return orgConfigs.map(c => ({ ...c, roleRates: c.roleRates as RoleRates | null, tiers: c.tiers as CommissionTierData[] }))
}
```

- [ ] **Step 6: Write the failing test for `findActiveCommissionConfigs`**

Add to `commission-utils.test.ts`:

```typescript
import { findActiveCommissionConfigs } from '../../../../src/services/dashboard/commission/commission-utils'

describe('findActiveCommissionConfigs', () => {
  it('returns all venue configs (priority desc) without hitting org fallback', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      { id: 'a', priority: 100, roleRates: null, tiers: [] },
      { id: 'b', priority: 50, roleRates: null, tiers: [] },
    ])
    const configs = await findActiveCommissionConfigs('venue-1')
    expect(configs.map(c => c.id)).toEqual(['a', 'b'])
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })

  it('falls back to org configs when no venue configs exist', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'org-1', priority: 0, roleRates: null, tiers: [] }])
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org' })
    const configs = await findActiveCommissionConfigs('venue-1')
    expect(configs.map(c => c.id)).toEqual(['org-1'])
  })
})
```

- [ ] **Step 7: Run all `commission-utils` tests**

Run: `npx jest tests/unit/services/dashboard/commission-utils.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 8: Commit**

```bash
git add src/services/dashboard/commission/commission-utils.ts tests/unit/services/dashboard/commission-utils.test.ts
git commit -m "feat(commissions): findActiveCommissionConfigs + calculateLeftoverAmount"
```

---

## Task 3: Resolve `STAFF_GOAL` tier boundaries in tier progress

**Files:**
- Modify: `src/services/dashboard/commission/commission-tier.service.ts`
- Test: `tests/unit/services/dashboard/commission-goal-tier.test.ts` (existing file — extend it)

- [ ] **Step 1: Import `ThresholdType`**

Top of `commission-tier.service.ts`, add to the prisma import:

```typescript
import { Prisma, TierType, TierPeriod, CommissionCalcType, ThresholdType } from '@prisma/client'
```

- [ ] **Step 2: Write the failing test (hybrid bands resolve per-staff goal)**

Add to `commission-goal-tier.test.ts`:

```typescript
import { getStaffTierProgress } from '../../../src/services/dashboard/commission/commission-tier.service'
import * as salesGoal from '../../../src/services/dashboard/commission/sales-goal.service'
import { prismaMock } from '../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

describe('getStaffTierProgress — STAFF_GOAL boundaries', () => {
  const tiers = [
    { tierLevel: 1, tierName: 'Base', tierType: 'BY_AMOUNT', tierPeriod: 'MONTHLY', minThreshold: new Decimal(0), maxThreshold: new Decimal(30000), minThresholdType: 'FIXED', maxThresholdType: 'FIXED', rate: new Decimal(0.04) },
    { tierLevel: 2, tierName: 'Meta', tierType: 'BY_AMOUNT', tierPeriod: 'MONTHLY', minThreshold: new Decimal(30000), maxThreshold: new Decimal(0), minThresholdType: 'FIXED', maxThresholdType: 'STAFF_GOAL', rate: new Decimal(0.06) },
    { tierLevel: 3, tierName: 'Super', tierType: 'BY_AMOUNT', tierPeriod: 'MONTHLY', minThreshold: new Decimal(0), maxThreshold: null, minThresholdType: 'STAFF_GOAL', maxThresholdType: 'FIXED', rate: new Decimal(0.08) },
  ]

  beforeEach(() => {
    prismaMock.commissionConfig.findFirst.mockResolvedValue({ id: 'cfg', venueId: 'v', deletedAt: null, tiers })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  })

  it('puts a staff at 8% when current sales exceed their goal (40k goal, 45k sales)', async () => {
    jest.spyOn(salesGoal, 'getStaffSalesGoal').mockResolvedValue({ goal: 40000 } as any)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(45000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(3)
  })

  it('puts a staff at 6% when between 30k and their goal (40k goal, 35k sales)', async () => {
    jest.spyOn(salesGoal, 'getStaffSalesGoal').mockResolvedValue({ goal: 40000 } as any)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(35000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(2)
  })

  it('no goal → stays in 6% band, 8% unreachable (45k sales, no goal)', async () => {
    jest.spyOn(salesGoal, 'getStaffSalesGoal').mockResolvedValue(null)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(45000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(2)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest tests/unit/services/dashboard/commission-goal-tier.test.ts -t STAFF_GOAL`
Expected: FAIL — currently `maxThreshold` of 0 is treated literally, so tier 2/3 selection is wrong.

- [ ] **Step 4: Add the boundary resolver and use it in `getStaffTierProgress`**

In `getStaffTierProgress`, after loading `config` and computing `currentValue`, resolve the staff goal once and replace the raw `decimalToNumber(tier.minThreshold)` / `maxThreshold` reads:

```typescript
// Resolve STAFF_GOAL boundaries to the staff member's active goal (matching period).
const staffGoal = await getStaffSalesGoal(venueId, staffId)
const goalValue = staffGoal?.goal ?? null

const resolveBoundary = (threshold: Prisma.Decimal | null, type: ThresholdType, nullFallback: number): number => {
  if (type === ThresholdType.STAFF_GOAL) return goalValue ?? Infinity // no goal → boundary at infinity
  return threshold === null ? nullFallback : decimalToNumber(threshold)
}
```

Then in the tier-selection loop, replace:

```typescript
for (const tier of config.tiers) {
  const min = resolveBoundary(tier.minThreshold, tier.minThresholdType, 0)
  const max = resolveBoundary(tier.maxThreshold, tier.maxThresholdType, Infinity)
  if (currentValue >= min && currentValue < max) {
    currentTier = tier.tierLevel
    const nextTierData = config.tiers.find(t => t.tierLevel > tier.tierLevel)
    nextTier = nextTierData?.tierLevel ?? null
    break
  }
}
```

And in the returned `tiers.map(...)`, replace the `minThreshold` / `achieved` computation to use the resolver:

```typescript
tiers: config.tiers.map(tier => {
  const min = resolveBoundary(tier.minThreshold, tier.minThresholdType, 0)
  return {
    level: tier.tierLevel,
    name: tier.tierName,
    minThreshold: min === Infinity ? decimalToNumber(tier.minThreshold) : min,
    rate: decimalToNumber(tier.rate),
    achieved: currentValue >= min,
  }
}),
```

> The `progressToNext` block already uses `config.tiers.find(...).minThreshold`; wrap those two reads in `resolveBoundary(...)` the same way so the progress bar reflects the resolved goal.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest tests/unit/services/dashboard/commission-goal-tier.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/commission/commission-tier.service.ts tests/unit/services/dashboard/commission-goal-tier.test.ts
git commit -m "feat(commissions): resolve STAFF_GOAL tier boundaries per staff"
```

---

## Task 4: Multi-config evaluation in `createCommissionForPayment`

**Files:**
- Modify: `src/services/dashboard/commission/commission-calculation.service.ts`
- Test: covered in Task 6 (`commission-multi-scheme.test.ts`)

- [ ] **Step 1: Update imports**

In `commission-calculation.service.ts`, change the `commission-utils` import to add the new helpers:

```typescript
import {
  findActiveCommissionConfig,
  findActiveCommissionConfigs,
  findActiveOverride,
  getRecipientStaffId,
  calculateFinalRate,
  applyCommissionBounds,
  calculateBaseAmount,
  calculateCategoryFilteredAmount,
  calculateLeftoverAmount,
  validateStaffForCommission,
  decimalToNumber,
  getVenueTimezone,
  CommissionConfigWithRelations,
} from './commission-utils'
```

(`commissionExistsForPayment` is no longer used by this function — leave the import only if other functions use it; otherwise remove it.)

- [ ] **Step 2: Add the per-config helper**

Add this private helper above `createCommissionForPayment`. It is the existing steps 4–9 scoped to a single config, with per-(payment, config, staff) idempotency:

```typescript
type LoadedPayment = {
  id: string
  venueId: string
  orderId: string | null
  processedById: string | null
  tipAmount: Prisma.Decimal
  createdAt: Date
  order: { createdById: string | null; servedById: string | null } | null
  shift: { id: string } | null
}

async function createCalcForConfig(
  payment: LoadedPayment,
  config: CommissionConfigWithRelations,
  amounts: { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number },
): Promise<CommissionCalculationResult | null> {
  const recipientStaffId = getRecipientStaffId({ processedById: payment.processedById }, payment.order, config.recipient)
  if (!recipientStaffId) {
    logger.warn('Could not determine commission recipient', { paymentId: payment.id, configId: config.id })
    return null
  }

  const staffInfo = await validateStaffForCommission(recipientStaffId, payment.venueId)
  if (!staffInfo) return null

  // Idempotency: one calc per (payment, config, staff). Lets webhook retries
  // run safely and lets multiple configs coexist on the same payment.
  const existing = await prisma.commissionCalculation.findFirst({
    where: { paymentId: payment.id, configId: config.id, staffId: recipientStaffId, status: { not: CommissionCalcStatus.VOIDED } },
    select: { id: true },
  })
  if (existing) {
    logger.info('Commission already exists for (payment, config, staff)', { paymentId: payment.id, configId: config.id, staffId: recipientStaffId })
    return null
  }

  const override = await findActiveOverride(config.id, recipientStaffId, payment.createdAt)
  if (override?.excludeFromCommissions) return null

  let tierLevel: number | undefined
  let tierName: string | undefined
  let tierRate: number | null = null

  if (config.useGoalAsTier && config.goalBonusRate) {
    const timezone = await getVenueTimezone(payment.venueId)
    const monthStart = fromZonedTime(startOfMonth(toZonedTime(new Date(), timezone)), timezone)
    const monthlyStats = await prisma.commissionCalculation.aggregate({
      where: { staffId: recipientStaffId, venueId: payment.venueId, status: { not: 'VOIDED' }, calculatedAt: { gte: monthStart } },
      _sum: { baseAmount: true },
    })
    const goalTierInfo = await resolveGoalBasedTier(recipientStaffId, payment.venueId, config, decimalToNumber(monthlyStats._sum.baseAmount))
    if (goalTierInfo) { tierLevel = goalTierInfo.tierLevel; tierName = goalTierInfo.tierName; tierRate = goalTierInfo.rate }
  } else if (config.calcType === CommissionCalcType.TIERED) {
    const tierInfo = await getApplicableTierRate(config.id, recipientStaffId, payment.venueId)
    if (tierInfo) { tierLevel = tierInfo.tierLevel; tierName = tierInfo.tierName; tierRate = tierInfo.rate }
  }

  const effectiveRate = calculateFinalRate(config, override, staffInfo.role, tierRate)

  let grossCommission =
    config.calcType === CommissionCalcType.FIXED ? decimalToNumber(config.defaultRate) : amounts.baseAmount * effectiveRate

  let netCommission = applyCommissionBounds(grossCommission, config)
  grossCommission = Math.round(grossCommission * 100) / 100
  netCommission = Math.round(netCommission * 100) / 100

  const calculation = await prisma.commissionCalculation.create({
    data: {
      venueId: payment.venueId,
      staffId: recipientStaffId,
      paymentId: payment.id,
      orderId: payment.orderId,
      shiftId: payment.shift?.id,
      configId: config.id,
      baseAmount: amounts.baseAmount,
      tipAmount: amounts.tipAmount,
      discountAmount: amounts.discountAmount,
      taxAmount: amounts.taxAmount,
      effectiveRate,
      grossCommission,
      netCommission,
      calcType: config.calcType,
      tier: tierLevel,
      tierName,
      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: new Date(),
    },
  })

  return { calculationId: calculation.id, paymentId: payment.id, staffId: recipientStaffId, baseAmount: amounts.baseAmount, effectiveRate, grossCommission, netCommission, tierLevel, tierName }
}
```

- [ ] **Step 3: Rewrite `createCommissionForPayment` to loop over configs**

Change the signature to return an array, keep the eligibility checks (Steps 1–2), then replace Steps 3–9 with the partition loop:

```typescript
export async function createCommissionForPayment(paymentId: string): Promise<CommissionCalculationResult[]> {
  logger.info('Creating commission for payment', { paymentId })

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: { id: true, createdById: true, servedById: true, subtotal: true, discountAmount: true, taxAmount: true } },
      shift: { select: { id: true } },
      venue: { select: { id: true, timezone: true } },
    },
  })
  if (!payment) throw new NotFoundError(`Payment ${paymentId} not found`)
  if (payment.type === PaymentType.TEST) { logger.info('Skipping commission: TEST payment', { paymentId }); return [] }
  if (payment.status !== 'COMPLETED') { logger.info('Skipping commission: not COMPLETED', { paymentId, status: payment.status }); return [] }

  const configs = await findActiveCommissionConfigs(payment.venueId, payment.createdAt)
  if (configs.length === 0) { logger.info('No active commission config', { paymentId, venueId: payment.venueId }); return [] }

  const categoryScoped = configs.filter(c => c.filterByCategories && c.categoryIds.length > 0)
  const catchAll = configs.filter(c => !(c.filterByCategories && c.categoryIds.length > 0))
  const claimed = [...new Set(categoryScoped.flatMap(c => c.categoryIds))]

  const results: CommissionCalculationResult[] = []

  // 1) Category-scoped configs — each bills its own categories.
  for (const config of categoryScoped) {
    if (!payment.orderId) continue
    let base = await calculateCategoryFilteredAmount(payment.orderId, config.categoryIds, { includeTax: config.includeTax, includeDiscount: config.includeDiscount })
    const tip = config.includeTips ? decimalToNumber(payment.tipAmount) : 0
    if (config.includeTips) base += tip
    if (base <= 0) continue
    const r = await createCalcForConfig(payment, config, { baseAmount: base, tipAmount: tip, discountAmount: 0, taxAmount: 0 })
    if (r) results.push(r)
  }

  // 2) Catch-all config (highest priority) — bills the leftover. If there are
  //    no category-scoped configs, claimed is empty → whole payment (today's behavior).
  const generalConfig = catchAll[0]
  if (generalConfig) {
    let amounts: { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number } | null = null
    if (claimed.length === 0) {
      const r = calculateBaseAmount(
        { amount: payment.amount, tipAmount: payment.tipAmount, taxAmount: payment.order?.taxAmount, discountAmount: payment.order?.discountAmount },
        generalConfig,
      )
      amounts = r
    } else if (payment.orderId) {
      let base = await calculateLeftoverAmount(payment.orderId, claimed, { includeTax: generalConfig.includeTax, includeDiscount: generalConfig.includeDiscount })
      const tip = generalConfig.includeTips ? decimalToNumber(payment.tipAmount) : 0
      if (generalConfig.includeTips) base += tip
      amounts = { baseAmount: base, tipAmount: tip, discountAmount: 0, taxAmount: 0 }
    }
    if (amounts && amounts.baseAmount > 0) {
      const r = await createCalcForConfig(payment, generalConfig, amounts)
      if (r) results.push(r)
    }
  }

  logger.info('Commission(s) created for payment', { paymentId, count: results.length })
  return results
}
```

- [ ] **Step 4: Verify callers still compile (all are fire-and-forget)**

Run: `grep -rn "createCommissionForPayment(" src/ | grep -v commission-calculation.service.ts`
Confirm each call is `createCommissionForPayment(id).catch(...)` (does not read the return value): `payment.tpv.service.ts:1841,2551`, `paymentLink.service.ts:1568,2320`. No changes needed.
Run: `npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/commission/commission-calculation.service.ts
git commit -m "feat(commissions): evaluate all category-scoped configs per payment"
```

---

## Task 5: Refund mirrors ALL original calcs

**Files:**
- Modify: `src/services/dashboard/commission/commission-calculation.service.ts` (`createRefundCommission`)
- Test: Task 6 file

- [ ] **Step 1: Change `createRefundCommission` to loop**

Replace the single `findFirst` with `findMany`, then create one proportional negative calc per original, with per-(refundPayment, config, staff) idempotency. Return an array:

```typescript
export async function createRefundCommission(refundPaymentId: string, originalPaymentId: string): Promise<CommissionCalculationResult[]> {
  logger.info('Creating refund commission', { refundPaymentId, originalPaymentId })

  const originalCalcs = await prisma.commissionCalculation.findMany({
    where: { paymentId: originalPaymentId, status: { not: CommissionCalcStatus.VOIDED } },
  })
  if (originalCalcs.length === 0) {
    logger.info('No commission for original payment, skipping refund commission', { refundPaymentId, originalPaymentId })
    return []
  }

  const refundPayment = await prisma.payment.findUnique({ where: { id: refundPaymentId } })
  if (!refundPayment) throw new NotFoundError(`Refund payment ${refundPaymentId} not found`)

  const refundAmount = Math.abs(decimalToNumber(refundPayment.amount)) + Math.abs(decimalToNumber(refundPayment.tipAmount ?? 0))
  const results: CommissionCalculationResult[] = []

  for (const originalCalc of originalCalcs) {
    const existing = await prisma.commissionCalculation.findFirst({
      where: { paymentId: refundPaymentId, configId: originalCalc.configId, staffId: originalCalc.staffId, status: { not: CommissionCalcStatus.VOIDED } },
      select: { id: true },
    })
    if (existing) continue

    const originalBaseAmount = decimalToNumber(originalCalc.baseAmount)
    const refundRatio = originalBaseAmount > 0 ? refundAmount / originalBaseAmount : 1

    const calculation = await prisma.commissionCalculation.create({
      data: {
        venueId: originalCalc.venueId,
        staffId: originalCalc.staffId,
        paymentId: refundPaymentId,
        orderId: originalCalc.orderId,
        shiftId: originalCalc.shiftId,
        configId: originalCalc.configId,
        baseAmount: -refundAmount,
        tipAmount: -decimalToNumber(originalCalc.tipAmount) * refundRatio,
        discountAmount: -decimalToNumber(originalCalc.discountAmount) * refundRatio,
        taxAmount: -decimalToNumber(originalCalc.taxAmount) * refundRatio,
        effectiveRate: originalCalc.effectiveRate,
        grossCommission: -decimalToNumber(originalCalc.grossCommission) * refundRatio,
        netCommission: -decimalToNumber(originalCalc.netCommission) * refundRatio,
        calcType: originalCalc.calcType,
        tier: originalCalc.tier,
        tierName: originalCalc.tierName,
        status: CommissionCalcStatus.CALCULATED,
        calculatedAt: new Date(),
      },
    })
    results.push({
      calculationId: calculation.id,
      paymentId: refundPaymentId,
      staffId: originalCalc.staffId,
      baseAmount: -refundAmount,
      effectiveRate: decimalToNumber(originalCalc.effectiveRate),
      grossCommission: decimalToNumber(calculation.grossCommission),
      netCommission: decimalToNumber(calculation.netCommission),
    })
  }
  return results
}
```

- [ ] **Step 2: Verify refund callers (fire-and-forget)**

Run: `grep -rn "createRefundCommission(" src/ | grep -v commission-calculation.service.ts`
Confirm `refund.tpv.service.ts:468` and `refund.dashboard.service.ts:486` use `.catch(...)`. No changes needed. Run `npx tsc --noEmit`.

- [ ] **Step 3: Commit**

```bash
git add src/services/dashboard/commission/commission-calculation.service.ts
git commit -m "feat(commissions): refund mirrors all original calcs across schemes"
```

---

## Task 6: Engine tests (multi-scheme, regression, refund)

**Files:**
- Rename: `tests/unit/services/dashboard/commission-multi-config-limitation.test.ts` → `commission-multi-scheme.test.ts`
- Modify: replace the old "limitation" assertions with the new behavior.

- [ ] **Step 1: Rename the file**

```bash
git mv tests/unit/services/dashboard/commission-multi-config-limitation.test.ts tests/unit/services/dashboard/commission-multi-scheme.test.ts
```

- [ ] **Step 2: Replace its contents**

```typescript
import { Decimal } from '@prisma/client/runtime/library'
import { createCommissionForPayment } from '../../../../src/services/dashboard/commission/commission-calculation.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-mindform'
const STAFF_ID = 'staff-1'

function payment(amount = 500, orderId: string | null = 'order-1') {
  return {
    id: 'pay-1', type: 'CARD', status: 'COMPLETED', venueId: VENUE_ID, orderId,
    processedById: STAFF_ID, createdAt: new Date('2026-06-03T18:00:00Z'),
    amount: new Decimal(amount), tipAmount: new Decimal(0),
    order: { id: orderId, createdById: STAFF_ID, servedById: STAFF_ID, subtotal: new Decimal(amount), discountAmount: new Decimal(0), taxAmount: new Decimal(0) },
    shift: { id: 'shift-1' }, venue: { id: VENUE_ID, timezone: 'America/Mexico_City' },
  }
}

const baseCfg = {
  venueId: VENUE_ID, orgId: null, recipient: 'SERVER', trigger: 'PER_PAYMENT',
  minAmount: null, maxAmount: null, includeTips: false, includeDiscount: false, includeTax: false,
  roleRates: null, useGoalAsTier: false, goalBonusRate: null,
  effectiveFrom: new Date('2026-01-01'), effectiveTo: null, tiers: [],
}
const HIDROGENO = { ...baseCfg, id: 'cfg-hid', name: 'Hidrógeno', priority: 100, calcType: 'PERCENTAGE', defaultRate: new Decimal(0.04), filterByCategories: true, categoryIds: ['cat-hid', 'cat-iyashi'] }
const LAGREE = { ...baseCfg, id: 'cfg-lag', name: 'Lagree', priority: 50, calcType: 'PERCENTAGE', defaultRate: new Decimal(0.03), filterByCategories: true, categoryIds: ['cat-lagree'] }
const GENERAL = { ...baseCfg, id: 'cfg-gen', name: 'General', priority: 1, calcType: 'PERCENTAGE', defaultRate: new Decimal(0.02), filterByCategories: false, categoryIds: [] as string[] }

const ACTIVE_STAFF = { staffId: STAFF_ID, role: 'WAITER', staff: { id: STAFF_ID, active: true } }

// orderItem.findMany is called once per category-scoped config (and once for leftover).
// Branch on the where clause to return the right items per category set.
function mockOrderItemsByCategory(map: Record<string, Array<{ unitPrice: number }>>) {
  prismaMock.orderItem.findMany.mockImplementation(async (args: any) => {
    const inList: string[] | undefined = args?.where?.product?.categoryId?.in
    const key = inList ? inList.join(',') : 'leftover'
    const items = map[key] ?? []
    return items.map(i => ({ quantity: 1, unitPrice: new Decimal(i.unitPrice), taxAmount: new Decimal(0), discountAmount: new Decimal(0) }))
  })
}

beforeEach(() => {
  prismaMock.commissionCalculation.findFirst.mockResolvedValue(null) // idempotency: none yet
  prismaMock.staffVenue.findFirst.mockResolvedValue(ACTIVE_STAFF)
  prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
  prismaMock.commissionCalculation.create.mockImplementation(async (args: any) => ({ id: 'calc', ...args.data }))
})

describe('multi-scheme commission engine', () => {
  it('pays BOTH schemes on a mixed ticket (Hidrógeno 4% + Lagree 3%)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [{ unitPrice: 1000 }], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    const hid = results.find(r => r.netCommission === 40) // 4% of 1000
    const lag = results.find(r => r.netCommission === 15) // 3% of 500
    expect(hid).toBeTruthy()
    expect(lag).toBeTruthy()
  })

  it('pays Lagree 3% on a Lagree-only ticket even though Hidrógeno has higher priority', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15)
    expect(results[0].effectiveRate).toBe(0.03)
  })

  it('REGRESSION: single catch-all config bills the whole payment (today’s behavior)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([GENERAL])

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(10) // 2% of 500
    // orderItem.findMany NOT used for a catch-all-only venue
    expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('catch-all bills only the leftover when a category-scoped config also exists', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE, GENERAL])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 300 }], leftover: [{ unitPrice: 200 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    expect(results.find(r => r.netCommission === 9)).toBeTruthy()  // Lagree 3% of 300
    expect(results.find(r => r.netCommission === 4)).toBeTruthy()  // General 2% of 200 (leftover)
  })

  it('idempotency: a config that already has a calc for this payment+staff is skipped', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })
    prismaMock.commissionCalculation.findFirst.mockResolvedValue({ id: 'already' })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(0)
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the file**

Run: `npx jest tests/unit/services/dashboard/commission-multi-scheme.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Run the full commission suite + pre-deploy gate**

Run: `npm run test:unit` then `npm run pre-deploy`
Expected: PASS. Fix any regression before continuing.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/dashboard/commission-multi-scheme.test.ts
git commit -m "test(commissions): multi-scheme engine + regression coverage"
```

---

## Task 7: Format, lint, and Phase-1 wrap-up

- [ ] **Step 1:** Run `npm run format && npm run lint:fix`
- [ ] **Step 2:** Run `npm run pre-deploy` — Expected: PASS.
- [ ] **Step 3:** Commit any formatting: `git add -A && git commit -m "chore(commissions): format & lint"`

> **Known limitation (documented, deferred — YAGNI):** `createSplitCommissionForPayment` (payment-link multi-staff) still uses a single config. Multi-scheme + payment-link splits is an edge-of-edge case (Mindform uses TPV card payments, not payment-link splits, for these services). Updating it mirrors Task 4's partition; defer until a venue needs it. Note this in the PR description.

---

## Phase 2 — Dashboard UI (avoqado-web-dashboard) — minimal

> Do AFTER Phase 1 is deployed. Read each file before editing and match its existing style/components.

## Task 8: Tier boundary "fixed vs employee goal" toggle

**Files (avoqado-web-dashboard):**
- Modify: `src/types/commission.ts` (tier type — add `minThresholdType`/`maxThresholdType: 'FIXED' | 'STAFF_GOAL'`)
- Modify: `src/pages/Commissions/components/setup-panel/cards/TiersCard.tsx`
- Modify: `src/pages/Commissions/components/CreateTierDialog.tsx` (if it also edits thresholds)
- Verify: `src/services/commission.service.ts` and `src/hooks/useCommissions.ts` forward the new fields in create/update payloads.

- [ ] **Step 1:** Add `minThresholdType` / `maxThresholdType` (`'FIXED' | 'STAFF_GOAL'`, default `'FIXED'`) to the tier type in `src/types/commission.ts` and to the create/update tier input types.
- [ ] **Step 2:** In `TiersCard.tsx`, next to each tier's **max** amount input, add a small toggle/segmented control: "Monto fijo" / "La meta del empleado". When "meta" is selected, disable the numeric input, show a "Meta del empleado" chip, and set `maxThresholdType: 'STAFF_GOAL'` for that tier (and `minThresholdType: 'STAFF_GOAL'` on the next tier whose min equals this boundary, since min auto-syncs from the previous max). All Spanish copy.
- [ ] **Step 3:** Ensure the payload sent by `commission.service.ts` (`createTier` / `createTiersBatch` / `updateTier`) includes the two new fields. The backend already accepts them after Phase 1.
- [ ] **Step 4:** Manual check: create a 3-tier scheme with the 2nd tier's max = "meta" and the 3rd tier's min = "meta"; confirm it saves and re-renders correctly.
- [ ] **Step 5:** Commit in the dashboard repo: `feat(commissions): employee-goal tier boundary toggle`.

## Task 9: "Aplica a: [categorías]" label + soft overlap warning

**Files (avoqado-web-dashboard):**
- Modify: `src/pages/Commissions/components/CommissionConfigCard.tsx` (show categories the scheme covers)
- Modify: `src/pages/Commissions/components/CommissionConfigList.tsx` (detect & warn on category overlap across active schemes)

- [ ] **Step 1:** In `CommissionConfigCard.tsx`, when `filterByCategories`, render an "Aplica a: " line listing the category names (map `categoryIds` → names via the categories already loaded in the page; if not loaded, fetch via the existing categories hook).
- [ ] **Step 2:** In `CommissionConfigList.tsx`, compute the intersection of `categoryIds` across active configs; if any category appears in 2+ active schemes, render a non-blocking warning banner: "Esta categoría está en más de un esquema; se pagará una sola vez, con el de mayor prioridad."
- [ ] **Step 3:** Manual check + commit: `feat(commissions): show scheme categories + overlap warning`.

---

## Phase 3 — Coordination (ops + MCP)

## Task 10: MCP commission tools (coordinated)

> `scripts/mcp/` does NOT exist on `develop` yet — the MCP servers live in worktrees (`.worktrees/admin-mcp`, `.worktrees/customer-mcp`) under active parallel development. Per CLAUDE.md the MCP must expose new capabilities. Coordinate with the MCP worktree owner.

- [ ] **Step 1:** When the MCP lands on `develop`, audit it for commission/goal tools.
- [ ] **Step 2:** Add/update tools to expose, wrapping the existing services:
  - list commission schemes for a venue (`findActiveCommissionConfigs`)
  - create a scheme (flat / tiered / category-scoped)
  - add tiers including a `STAFF_GOAL` boundary (Task 1 fields)
  - manage per-staff sales goals (`sales-goal.service.ts`)
- [ ] **Step 3:** Verify each tool end-to-end against a test venue.

## Task 11: Mindform data cleanup (one-time, after Phase 1 deploy)

> Do via the dashboard UI (preferred) or a one-off `scripts/temp-*.ts` script (cuid v1 IDs per repo rule). Confirm the category decisions with the client (Sumi) first.

- [ ] **Step 1:** Confirm with Sumi: which services pay commission and the **Merch** decision. Confirm each employee's monthly goal is set and is **> $30,000** (so the 8% band is reachable given the fixed first cut).
- [ ] **Step 2:** Re-scope "Comisión Grace" (`cmp1o1k2g00b0m2281jpdpy9h`): remove `Lagree` (`cmm1e9b6f001qlq28qv1dxs2v`) from its `categoryIds`; keep/adjust `Merch` per Sumi.
- [ ] **Step 3:** Create **Lagree — 3% fijo** (PERCENTAGE, category `cmm1e9b6f001qlq28qv1dxs2v`, recipient SERVER).
- [ ] **Step 4:** Create **Hidrógeno + Iyashi — escalonado** (TIERED, categories `cmnqsrfbo0070ot29uibd7vqi` [Hidógeno Molecular] + `cmmkvt01w00039kjxuyl0mu3n` [Iyashi y Cryo]; tiers: 4% FIXED 0–30,000 · 6% FIXED 30,000 → STAFF_GOAL · 8% STAFF_GOAL → ∞).
- [ ] **Step 5:** Verify against a real ticket per category that the right scheme fires at the right rate.

---

## Self-Review notes

- **Spec coverage:** R1→Task 4; R2→Tasks 1,3; R3→Task 4 (claimed-set partition) + Task 9 warning; R4→Task 3. N1→Phase 2 (no new routes). N2→Tasks 4,6 (idempotency + tests). N3→Task 6 regression test. N4→no new tables.
- **Return-type change** (`createCommissionForPayment`, `createRefundCommission` → arrays) verified safe: all callers are fire-and-forget (`.catch`).
- **Naming consistency:** `findActiveCommissionConfigs` (plural, new) vs `findActiveCommissionConfig` (singular, kept); `calculateLeftoverAmount`; `createCalcForConfig`; `ThresholdType.{FIXED,STAFF_GOAL}`; `minThresholdType`/`maxThresholdType` used identically in schema, types, resolver, and tests.
- **Deferred (YAGNI):** split-commission multi-config (Task 7 note); per-service goals (out of scope per spec).
```
