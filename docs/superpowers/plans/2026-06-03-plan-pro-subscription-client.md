# Client PLAN_PRO Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a venue self-manage its PLAN_PRO base subscription from `avoqado-web-dashboard` — see a real "Tu plan" card (true Stripe state, renewal date, IVA price), cancel/reactivate at end-of-period, open the Stripe portal — and stop the dangerous immediate-cancel of the base plan via the à-la-carte delete.

**Architecture:** Add a backend foundation in `avoqado-server` — a pure `derivePlanState()` helper (7 states) in `src/services/access/basePlan.service.ts`, a new `planState.service.ts` that reads the PLAN_PRO `VenueFeature` + (when present) the Stripe subscription, three new venue-scoped endpoints (`GET /plan`, `POST /plan/cancel`, `POST /plan/reactivate`) wired through `venue.dashboard.controller.ts`, and a guard on `DELETE /features/:featureId`. Cancel/reactivate flip Stripe `cancel_at_period_end` (never immediate). Standardize the client billing endpoints on `billing:*` permissions (already in the catalog and frontend route guards, but currently SUPERADMIN-only at the role level). Then add a "Tu plan" card to `Settings/Billing/Subscriptions.tsx` fed by a new `getVenuePlan` / `cancelVenuePlan` / `reactivateVenuePlan` service, and remove PLAN_PRO from the generic à-la-carte list.

**Tech Stack:** Express + TypeScript, Prisma (PostgreSQL), Stripe SDK v19 (`stripe` `^19.1.0`), Zod (Spanish messages), Jest (`--runInBand`), React 18 + TanStack Query + Radix UI, i18next.

---

## Background facts (verified against the codebase — do not re-discover)

- **PLAN_PRO is a real `Feature` row** with `code = 'PLAN_PRO'`; `PAID_PLAN_TIER_CODES = ['PLAN_PRO']` lives in `src/services/access/basePlan.service.ts:3`. `venueHasActiveBasePlan()` (same file, `:13`) stays the canonical "entitled" boolean — **do not change it**.
- **`VenueFeature` fields** (`prisma/schema.prisma:2950`): `active`, `monthlyPrice` (Decimal), `endDate` (null = paid, not-null = trial end), `stripeSubscriptionId`, `stripePriceId`, `trialEndDate`, `suspendedAt`, `gracePeriodEndsAt`, `paymentFailureCount`. `Feature` has `code`, `name`, `monthlyPrice` (Decimal), `stripePriceId`.
- **Stripe SDK v19 types omit `current_period_*` and `cancel_at_period_end` on `Stripe.Subscription`** — the API returns them. The codebase casts: `(sub as any).current_period_end * 1000` → ms (see `src/services/stripe.webhook.service.ts:32`, `src/jobs/plan-renewal-reminder.job.ts:102`). Interval: `sub.items.data[0]?.price.recurring?.interval === 'year' ? 'year' : 'month'` (job `:118`). Gross price (cents): `sub.items.data[0]?.price.unit_amount ?? 0` (job `:119`).
- **IVA is baked into the Stripe price** (`tax_behavior 'inclusive'`, comment at `src/services/stripe.service.ts:614`). So `unit_amount` IS the **gross** (IVA-inclusive) amount. `base` (ex-IVA) = `gross / 1.16`. `VenueFeature.monthlyPrice` / `Feature.monthlyPrice` are the **base ex-IVA** MXN amount (whole pesos, e.g. `999.00`).
- **Stripe client** is `const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')` with **no pinned `apiVersion`** (`src/services/stripe.service.ts:21` — "Using default API version from SDK"). Match this; do not add `apiVersion`.
- **`cancelSubscription()` (`src/services/stripe.service.ts:697`) cancels IMMEDIATELY** (`stripe.subscriptions.cancel`) and sets `active:false`. The à-la-carte `DELETE /features/:featureId` → `removeFeatureFromVenue` (`src/services/dashboard/venueFeature.dashboard.service.ts:193`) calls it. This is the dangerous path the guard kills for PLAN_PRO.
- **Permissions reality (CRITICAL):** `billing:read`, `billing:subscriptions:read|manage`, `billing:history:read`, `billing:payment-methods:read|manage` already exist in `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` (`src/lib/permissions.ts:1226-1235`) AND the frontend route guards already use them (`avoqado-web-dashboard/src/routes/venueRoutes.tsx:479-503`). BUT they are **NOT** in `DEFAULT_PERMISSIONS` and **NOT** in `PERMISSION_DEPENDENCIES` — today only SUPERADMIN satisfies them (verified: `hasPermission(OWNER, null, 'billing:subscriptions:read') === false`). Backend billing routes currently check `venues:manage` / `venues:read` / `features:update`. The audit passes today only because dashboard gates are satisfiable by SUPERADMIN's `*:*`. **The moment a backend route checks `checkPermission('billing:...')`, it becomes a PHANTOM (audit ERROR) unless `billing:*` is added to `DEFAULT_PERMISSIONS` for OWNER/ADMIN.** Task 8 does exactly this.
- **prismaMock** (`tests/__helpers__/setup.ts`) already registers `venue` (`:71`) and `venueFeature` (`:95`). No new model is accessed by this plan → **no setup.ts change needed.**
- **Test command:** always `npm test -- <path> --runInBand` (OOM otherwise). Jest mocks `@/utils/prismaClient`, `@/config/logger`, and `@/services/dashboard/activity-log.service` globally; `STRIPE_SECRET_KEY` is set in setup.ts.
- **MCP / Superadmin out of scope here.** The `subscription_overview` MCP tool and `/api/v1/superadmin/*` namespace belong to **Plan 2** (depends on `derivePlanState` from this plan). Do not build them here.

---

## File Structure

### Backend (`avoqado-server`)

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/services/access/basePlan.service.ts` | Modify | Add the pure `derivePlanState(input)` helper + exported `PlanStateValue` type + `IVA_RATE` const. Keeps `PAID_PLAN_TIER_CODES` / `venueHasActiveBasePlan` untouched. |
| `src/services/stripe.service.ts` | Modify | Add `setSubscriptionCancelAtPeriodEnd(subscriptionId, cancel)` (flips `cancel_at_period_end`, no DB write) and `retrievePlanSubscription(subscriptionId)` (typed read of the fields the plan needs). |
| `src/services/dashboard/planState.service.ts` | Create | `getPlanState(venueId)`, `cancelPlan(venueId)`, `reactivatePlan(venueId)` — read PLAN_PRO `VenueFeature` + Stripe sub, assemble the `PlanState` shape, call `derivePlanState`. |
| `src/services/dashboard/venueFeature.dashboard.service.ts` | Modify | In `removeFeatureFromVenue`, throw `BadRequestError` (with `useEndpoint`) when the feature code is in `PAID_PLAN_TIER_CODES`. |
| `src/controllers/dashboard/venue.dashboard.controller.ts` | Modify | Add `getVenuePlan`, `cancelVenuePlan`, `reactivateVenuePlan` controllers (thin: extract `venueId`, call service, respond). |
| `src/schemas/dashboard/venue.schema.ts` | Modify | Add `planParamsSchema` (validate `venueId` path param, Spanish messages). |
| `src/routes/dashboard.routes.ts` | Modify | Add `GET/POST/POST /venues/:venueId/plan*` routes (gated `billing:subscriptions:read` / `billing:subscriptions:manage`). Re-gate existing billing/feature routes onto `billing:*`. |
| `src/lib/permissions.ts` | Modify | Add `billing:*` to OWNER & ADMIN `DEFAULT_PERMISSIONS`; add `billing:*` + bidirectional aliases (`billing:subscriptions:manage ↔ venues:manage`, `billing:payment-methods:manage ↔ venues:manage`, `billing:subscriptions:read ↔ venues:read`) to `PERMISSION_DEPENDENCIES`. |
| `tests/unit/services/access/derivePlanState.test.ts` | Create | 7-state truth table + edge cases for the pure helper. |
| `tests/unit/services/dashboard/planState.service.test.ts` | Create | `getPlanState` shape (trial/active/canceling/suspended/none), `cancelPlan`/`reactivatePlan` flip Stripe flag (not immediate), no-Stripe-sub errors. |
| `tests/unit/services/dashboard/basePlan-delete-guard.test.ts` | Create | `removeFeatureFromVenue` rejects PLAN_PRO (400 + useEndpoint), still removes à-la-carte CHATBOT. |

### Frontend (`avoqado-web-dashboard`)

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/services/features.service.ts` | Modify | Add `PlanState` type + `getVenuePlan`, `cancelVenuePlan`, `reactivateVenuePlan` API calls. |
| `src/pages/Settings/Billing/components/CurrentPlanCard.tsx` | Create | The "Tu plan" card: query `getVenuePlan`, render state badge + IVA price + interval + renewal/trial date + payment method; cancel / reactivate / portal actions. |
| `src/pages/Settings/Billing/Subscriptions.tsx` | Modify | Render `<CurrentPlanCard>` at the top; filter PLAN_PRO out of the à-la-carte `activeFeatures` loop; fix the à-la-carte cancel-dialog copy. |
| `src/locales/es/billing.json` | Modify | Add `currentPlan.*` keys (Spanish). |
| `src/locales/en/billing.json` | Modify | Add `currentPlan.*` keys (English). |
| `src/locales/fr/billing.json` | Modify | Add `currentPlan.*` keys (French). |

---

## Data shapes (authoritative — use verbatim)

```ts
// PlanState — response body of GET /dashboard/venues/:venueId/plan (under { success, data })
type PlanState = {
  hasPlan: boolean
  state: 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
  planTier: 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
  planName: string | null          // "Plan Avoqado Pro"
  interval: 'month' | 'year' | null
  price: { base: number; gross: number; currency: 'MXN' } | null // base ex-IVA, gross incl. 16% IVA
  trialEndsAt: string | null        // ISO
  currentPeriodEnd: string | null   // ISO, real renewal/next-charge (Stripe)
  cancelAtPeriodEnd: boolean
  suspendedAt: string | null
  gracePeriodEndsAt: string | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  stripeSubscriptionId: string | null
}
```

### `derivePlanState` logic (7 states, in this exact order)

Inputs: the PLAN_PRO `VenueFeature` (`active`, `endDate`, `suspendedAt`, `gracePeriodEndsAt`) or `null`, plus an optional Stripe sub summary (`status`, `cancelAtPeriodEnd`).

1. No PLAN_PRO `VenueFeature` row → `none`.
2. `suspendedAt != null` → `suspended`.
3. `!active` → `canceled`.
4. `(gracePeriodEndsAt != null && now < gracePeriodEndsAt) || stripeStatus === 'past_due'` → `past_due`.
5. `endDate != null && endDate > now` → `trial`.
6. `cancelAtPeriodEnd === true` → `canceling`.
7. otherwise → `active`.

---

## Task 1: `derivePlanState` pure helper + tests

**Files:**
- Modify: `src/services/access/basePlan.service.ts`
- Test: `tests/unit/services/access/derivePlanState.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/access/derivePlanState.test.ts`:

```typescript
import { derivePlanState } from '@/services/access/basePlan.service'

const future = new Date(Date.now() + 5 * 86400000) // +5d
const past = new Date(Date.now() - 5 * 86400000) // -5d

describe('derivePlanState (7-state pure helper)', () => {
  // 1. NEW FEATURE TESTS
  it('returns "none" when there is no PLAN_PRO VenueFeature', () => {
    expect(derivePlanState(null, null).state).toBe('none')
    expect(derivePlanState(null, null).hasPlan).toBe(false)
  })

  it('returns "suspended" when suspendedAt is set (precedence over everything)', () => {
    const vf = { active: true, endDate: future, suspendedAt: past, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('suspended')
  })

  it('returns "canceled" when the feature is inactive (and not suspended)', () => {
    const vf = { active: false, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, null).state).toBe('canceled')
  })

  it('returns "past_due" when grace period is in the future', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, null).state).toBe('past_due')
  })

  it('returns "past_due" when Stripe status is past_due (no grace set)', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'past_due', cancelAtPeriodEnd: false }).state).toBe('past_due')
  })

  it('returns "trial" when endDate is in the future', () => {
    const vf = { active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'trialing', cancelAtPeriodEnd: false }).state).toBe('trial')
  })

  it('returns "canceling" when cancelAtPeriodEnd is true on the Stripe sub', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: true }).state).toBe('canceling')
  })

  it('returns "active" for a healthy paid subscription', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('active')
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).hasPlan).toBe(true)
  })

  // 2. EDGE / REGRESSION TESTS
  it('treats an expired trial (endDate in the past, no grace) as active when active=true', () => {
    // endDate past but active=true and not suspended → paid (trial converted) → active
    const vf = { active: true, endDate: past, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('active')
  })

  it('derives state from the VenueFeature alone when there is no Stripe sub (DB-only trial)', () => {
    const vf = { active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, null).state).toBe('trial')
  })

  it('past_due beats canceling when both grace and cancelAtPeriodEnd are set', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: true }).state).toBe('past_due')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/services/access/derivePlanState.test.ts --runInBand`
Expected: FAIL — `derivePlanState is not a function` (not exported yet).

- [ ] **Step 3: Implement the helper**

Append to `src/services/access/basePlan.service.ts` (keep the existing `PAID_PLAN_TIER_CODES` and `venueHasActiveBasePlan` exactly as-is):

```typescript
/** IVA rate baked into the inclusive Stripe price. base = gross / (1 + IVA_RATE). */
export const IVA_RATE = 0.16

export type PlanStateValue = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'

/** The minimal VenueFeature fields derivePlanState needs. */
export interface DerivePlanFeatureInput {
  active: boolean
  endDate: Date | null
  suspendedAt: Date | null
  gracePeriodEndsAt: Date | null
}

/** The minimal Stripe subscription fields derivePlanState needs. */
export interface DerivePlanStripeInput {
  status: string
  cancelAtPeriodEnd: boolean
}

/**
 * Pure, side-effect-free derivation of the venue's base-plan lifecycle state.
 * Shared by the client plan endpoint (this plan) and the superadmin overview (Plan 2).
 * Order of checks is significant — see plan doc "derivePlanState logic".
 *
 * @param vf   PLAN_PRO VenueFeature row, or null if the venue never had it.
 * @param sub  Stripe subscription summary, or null (DB-only/comped trial, or no Stripe sub).
 */
export function derivePlanState(
  vf: DerivePlanFeatureInput | null,
  sub: DerivePlanStripeInput | null,
): { state: PlanStateValue; hasPlan: boolean } {
  if (!vf) return { state: 'none', hasPlan: false }

  const now = new Date()
  let state: PlanStateValue

  if (vf.suspendedAt) {
    state = 'suspended'
  } else if (!vf.active) {
    state = 'canceled'
  } else if ((vf.gracePeriodEndsAt && now < vf.gracePeriodEndsAt) || sub?.status === 'past_due') {
    state = 'past_due'
  } else if (vf.endDate && vf.endDate > now) {
    state = 'trial'
  } else if (sub?.cancelAtPeriodEnd === true) {
    state = 'canceling'
  } else {
    state = 'active'
  }

  return { state, hasPlan: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/services/access/derivePlanState.test.ts --runInBand`
Expected: PASS (11 passing).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors. Leave changes uncommitted in the working tree.

---

## Task 2: Stripe service helpers (`setSubscriptionCancelAtPeriodEnd`, `retrievePlanSubscription`)

**Files:**
- Modify: `src/services/stripe.service.ts` (add after `cancelSubscription`, around `:711`)
- Test: covered indirectly by Task 3 (these are thin Stripe wrappers; the planState service tests mock them).

- [ ] **Step 1: Add the two helpers**

In `src/services/stripe.service.ts`, immediately after the `cancelSubscription` function (ends at `:711`), insert:

```typescript
/**
 * Flip cancel_at_period_end on a subscription WITHOUT canceling immediately.
 * This is the ONLY supported way to cancel/reactivate the PLAN_PRO base plan:
 * `cancel=true` schedules cancellation at period end (venue stays entitled until
 * current_period_end); `cancel=false` undoes a scheduled cancellation.
 * Unlike cancelSubscription(), this does NOT touch the VenueFeature row.
 *
 * @param subscriptionId - Stripe subscription ID
 * @param cancel - true to schedule cancel at period end, false to reactivate
 * @returns the updated Stripe subscription
 */
export async function setSubscriptionCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<Stripe.Subscription> {
  const updated = await retry(() => stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: cancel }), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.setSubscriptionCancelAtPeriodEnd',
  })
  logger.info(`✅ Set cancel_at_period_end=${cancel} on subscription ${subscriptionId}`)
  return updated
}

/**
 * Retrieve a subscription and return the typed summary the plan endpoint needs.
 * Stripe SDK v19 omits current_period_end / cancel_at_period_end on the Subscription
 * type even though the API returns them — cast like the rest of the codebase
 * (see stripe.webhook.service.ts:32, plan-renewal-reminder.job.ts:102).
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function retrievePlanSubscription(subscriptionId: string): Promise<{
  status: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
  interval: 'month' | 'year' | null
  grossAmountCents: number | null
}> {
  const sub = await retry(() => stripe.subscriptions.retrieve(subscriptionId), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.retrievePlanSubscription',
  })
  const periodEndRaw = (sub as any).current_period_end as number | undefined
  const rawInterval = sub.items.data[0]?.price.recurring?.interval
  return {
    status: sub.status,
    cancelAtPeriodEnd: Boolean((sub as any).cancel_at_period_end),
    currentPeriodEnd: periodEndRaw ? new Date(periodEndRaw * 1000) : null,
    interval: rawInterval === 'year' ? 'year' : rawInterval === 'month' ? 'month' : null,
    grossAmountCents: sub.items.data[0]?.price.unit_amount ?? null,
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors (`retry`, `shouldRetryStripeError`, `stripe`, `logger`, `Stripe` are already imported at the top of the file). Leave changes uncommitted in the working tree.

---

## Task 3: `planState.service.ts` — getPlanState / cancelPlan / reactivatePlan + tests

**Files:**
- Create: `src/services/dashboard/planState.service.ts`
- Test: `tests/unit/services/dashboard/planState.service.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/dashboard/planState.service.test.ts`:

```typescript
import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { BadRequestError } from '@/errors/AppError'
import { getPlanState, cancelPlan, reactivatePlan } from '@/services/dashboard/planState.service'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

const future = new Date(Date.now() + 30 * 86400000)

function planProFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vf_1',
    venueId: 'venue_1',
    active: true,
    endDate: null,
    suspendedAt: null,
    gracePeriodEndsAt: null,
    monthlyPrice: { toNumber: () => 999 }, // Prisma.Decimal-like
    stripeSubscriptionId: 'sub_123',
    feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
    ...overrides,
  }
}

describe('planState.service', () => {
  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue_1', stripeCustomerId: 'cus_1', stripePaymentMethodId: null })
  })

  // 1. getPlanState
  describe('getPlanState', () => {
    it('returns state "none" with hasPlan=false when there is no PLAN_PRO VenueFeature', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(null)
      const result = await getPlanState('venue_1')
      expect(result.hasPlan).toBe(false)
      expect(result.state).toBe('none')
      expect(result.stripeSubscriptionId).toBeNull()
    })

    it('returns "active" with real currentPeriodEnd + IVA gross/base price from Stripe', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: future,
        interval: 'month',
        grossAmountCents: 115884, // $1,158.84 gross
      })
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('active')
      expect(result.planTier).toBe('PRO')
      expect(result.planName).toBe('Plan Avoqado Pro')
      expect(result.interval).toBe('month')
      expect(result.currentPeriodEnd).toBe(future.toISOString())
      expect(result.price).toEqual({ base: 999, gross: 1158.84, currency: 'MXN' })
      expect(result.stripeSubscriptionId).toBe('sub_123')
    })

    it('returns "canceling" when Stripe sub has cancelAtPeriodEnd=true', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: future,
        interval: 'month',
        grossAmountCents: 115884,
      })
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('canceling')
      expect(result.cancelAtPeriodEnd).toBe(true)
    })

    it('returns "trial" with trialEndsAt and no Stripe call failing the response (DB-only trial)', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(
        planProFeature({ endDate: future, stripeSubscriptionId: null }),
      )
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('trial')
      expect(result.trialEndsAt).toBe(future.toISOString())
      expect(result.currentPeriodEnd).toBeNull()
      expect(mockStripe.retrievePlanSubscription).not.toHaveBeenCalled()
    })

    it('returns "suspended" and tolerates a Stripe retrieve error (nulls, never throws)', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(
        planProFeature({ suspendedAt: new Date(Date.now() - 86400000) }),
      )
      mockStripe.retrievePlanSubscription.mockRejectedValue(new Error('stripe down'))
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('suspended')
      expect(result.currentPeriodEnd).toBeNull()
      expect(result.price).toBeNull()
    })
  })

  // 2. cancelPlan / reactivatePlan
  describe('cancelPlan / reactivatePlan', () => {
    it('cancelPlan flips cancel_at_period_end=true (NOT immediate cancel) and returns updated state', async () => {
      prismaMock.venueFeature.findFirst
        .mockResolvedValueOnce(planProFeature()) // initial fetch for the sub id
        .mockResolvedValueOnce(planProFeature()) // re-fetch inside getPlanState
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: future,
        interval: 'month',
        grossAmountCents: 115884,
      })
      const result = await cancelPlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
      expect(mockStripe.cancelSubscription).not.toHaveBeenCalled()
      expect(result.state).toBe('canceling')
    })

    it('reactivatePlan flips cancel_at_period_end=false', async () => {
      prismaMock.venueFeature.findFirst
        .mockResolvedValueOnce(planProFeature())
        .mockResolvedValueOnce(planProFeature())
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: future,
        interval: 'month',
        grossAmountCents: 115884,
      })
      const result = await reactivatePlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', false)
      expect(result.state).toBe('active')
    })

    it('cancelPlan throws BadRequestError when there is no Stripe subscription', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature({ stripeSubscriptionId: null }))
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
      await expect(cancelPlan('venue_1')).rejects.toThrow('no hay suscripción de Stripe que cancelar')
    })

    it('cancelPlan throws BadRequestError when there is no PLAN_PRO plan at all', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(null)
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/services/dashboard/planState.service.test.ts --runInBand`
Expected: FAIL — cannot find module `@/services/dashboard/planState.service`.

- [ ] **Step 3: Implement the service**

Create `src/services/dashboard/planState.service.ts`:

```typescript
/**
 * Plan State Service
 *
 * Reads the venue's PLAN_PRO base-plan lifecycle for the client "Tu plan" card and
 * performs end-of-period cancel / reactivate (cancel_at_period_end), the ONLY
 * supported way to cancel the base plan. Side-effect-free state derivation lives in
 * derivePlanState (access/basePlan.service.ts) and is shared with the superadmin overview.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { derivePlanState, PAID_PLAN_TIER_CODES, IVA_RATE, type PlanStateValue } from '@/services/access/basePlan.service'
import { retrievePlanSubscription, setSubscriptionCancelAtPeriodEnd } from '../stripe.service'
import { logAction } from './activity-log.service'

export interface PlanState {
  hasPlan: boolean
  state: PlanStateValue
  planTier: 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
  planName: string | null
  interval: 'month' | 'year' | null
  price: { base: number; gross: number; currency: 'MXN' } | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  suspendedAt: string | null
  gracePeriodEndsAt: string | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  stripeSubscriptionId: string | null
}

/** Round to 2 decimals (peso cents). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Fetch the PLAN_PRO VenueFeature (active or not) for a venue. */
async function findPlanProFeature(venueId: string) {
  return prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: {
      id: true,
      active: true,
      endDate: true,
      suspendedAt: true,
      gracePeriodEndsAt: true,
      monthlyPrice: true,
      stripeSubscriptionId: true,
      feature: { select: { code: true, name: true } },
    },
  })
}

/**
 * Assemble the full PlanState for a venue. Tolerant: a Stripe outage degrades to
 * nulls for the Stripe-derived fields but never throws (the card still renders).
 */
export async function getPlanState(venueId: string): Promise<PlanState> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, stripeCustomerId: true },
  })
  if (!venue) throw new NotFoundError(`Venue ${venueId} no encontrado`)

  const vf = await findPlanProFeature(venueId)

  // No PLAN_PRO row → "none" shell.
  if (!vf) {
    return {
      hasPlan: false,
      state: 'none',
      planTier: null,
      planName: null,
      interval: null,
      price: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      suspendedAt: null,
      gracePeriodEndsAt: null,
      paymentMethod: null,
      stripeSubscriptionId: null,
    }
  }

  // Read Stripe only when a subscription exists; tolerate failures.
  let stripeSub: Awaited<ReturnType<typeof retrievePlanSubscription>> | null = null
  if (vf.stripeSubscriptionId) {
    try {
      stripeSub = await retrievePlanSubscription(vf.stripeSubscriptionId)
    } catch (error) {
      logger.warn('getPlanState: failed to retrieve Stripe subscription; degrading to nulls', {
        venueId,
        subscriptionId: vf.stripeSubscriptionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const { state, hasPlan } = derivePlanState(
    { active: vf.active, endDate: vf.endDate, suspendedAt: vf.suspendedAt, gracePeriodEndsAt: vf.gracePeriodEndsAt },
    stripeSub ? { status: stripeSub.status, cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd } : null,
  )

  // Price: prefer Stripe gross (IVA-inclusive); fall back to VenueFeature.monthlyPrice (base ex-IVA).
  let price: PlanState['price'] = null
  if (stripeSub?.grossAmountCents != null) {
    const gross = round2(stripeSub.grossAmountCents / 100)
    price = { base: round2(gross / (1 + IVA_RATE)), gross, currency: 'MXN' }
  } else if (vf.monthlyPrice != null) {
    const base = round2(vf.monthlyPrice.toNumber())
    price = { base, gross: round2(base * (1 + IVA_RATE)), currency: 'MXN' }
  }

  return {
    hasPlan,
    state,
    planTier: 'PRO', // PLAN_PRO. Multi-tier mapping is a future concern (Plan 2 / YAGNI).
    planName: vf.feature.name,
    interval: stripeSub?.interval ?? null,
    price,
    trialEndsAt: vf.endDate ? vf.endDate.toISOString() : null,
    currentPeriodEnd: stripeSub?.currentPeriodEnd ? stripeSub.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: stripeSub?.cancelAtPeriodEnd ?? false,
    suspendedAt: vf.suspendedAt ? vf.suspendedAt.toISOString() : null,
    gracePeriodEndsAt: vf.gracePeriodEndsAt ? vf.gracePeriodEndsAt.toISOString() : null,
    paymentMethod: null, // payment-method summary handled by the existing /payment-methods endpoint (out of scope here)
    stripeSubscriptionId: vf.stripeSubscriptionId,
  }
}

/** Shared cancel/reactivate core: validate plan + Stripe sub, flip the flag, return fresh state. */
async function setCancelIntent(venueId: string, cancel: boolean): Promise<PlanState> {
  const vf = await findPlanProFeature(venueId)
  if (!vf) throw new BadRequestError('Este venue no tiene un plan base activo.')
  if (!vf.stripeSubscriptionId) {
    throw new BadRequestError('No hay suscripción de Stripe que cancelar. Contacta a soporte.')
  }

  await setSubscriptionCancelAtPeriodEnd(vf.stripeSubscriptionId, cancel)

  logAction({
    venueId,
    action: cancel ? 'PLAN_CANCEL_SCHEDULED' : 'PLAN_REACTIVATED',
    entity: 'VenueFeature',
    entityId: vf.id,
    data: { subscriptionId: vf.stripeSubscriptionId, cancelAtPeriodEnd: cancel },
  })

  return getPlanState(venueId)
}

/** Schedule cancellation at period end (venue stays entitled until currentPeriodEnd). */
export async function cancelPlan(venueId: string): Promise<PlanState> {
  return setCancelIntent(venueId, true)
}

/** Undo a scheduled cancellation. */
export async function reactivatePlan(venueId: string): Promise<PlanState> {
  return setCancelIntent(venueId, false)
}

export default { getPlanState, cancelPlan, reactivatePlan }
```

> Note on the error-message test: `BadRequestError('No hay suscripción de Stripe que cancelar...')` matches the test's `toThrow('no hay suscripción de Stripe que cancelar')` because Jest's string matcher is a substring check, but it is **case-sensitive**. Keep the test assertion lowercase-aligned OR change the test to match the capitalized sentence. To avoid ambiguity, update the test assertion in Step 1 to `.rejects.toThrow('suscripción de Stripe que cancelar')` (a stable substring present in the real message). Apply that edit before running.

- [ ] **Step 4: Fix the substring assertion, then run test to verify it passes**

Edit the two assertions in the test that read `'no hay suscripción de Stripe que cancelar'` → `'suscripción de Stripe que cancelar'`.

Run: `npm test -- tests/unit/services/dashboard/planState.service.test.ts --runInBand`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors. Leave changes uncommitted in the working tree.

---

## Task 4: Guard the à-la-carte delete for PLAN_PRO + tests

**Files:**
- Modify: `src/services/dashboard/venueFeature.dashboard.service.ts:193-211` (top of `removeFeatureFromVenue`)
- Test: `tests/unit/services/dashboard/basePlan-delete-guard.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/dashboard/basePlan-delete-guard.test.ts`:

```typescript
import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { BadRequestError } from '@/errors/AppError'
import { removeFeatureFromVenue } from '@/services/dashboard/venueFeature.dashboard.service'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

describe('removeFeatureFromVenue — PLAN_PRO guard', () => {
  it('rejects deleting the PLAN_PRO base plan with a BadRequestError pointing to /plan/cancel', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_pro',
      venueId: 'venue_1',
      featureId: 'feat_pro',
      active: true,
      stripeSubscriptionId: 'sub_123',
      feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
    })

    await expect(removeFeatureFromVenue('venue_1', 'feat_pro')).rejects.toThrow(BadRequestError)
    await expect(removeFeatureFromVenue('venue_1', 'feat_pro')).rejects.toThrow('flujo de plan')
    // The dangerous immediate-cancel must NOT run, and the row must NOT be deactivated.
    expect(mockStripe.cancelSubscription).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })

  // REGRESSION: à-la-carte features still cancel normally.
  it('still cancels and deactivates an à-la-carte feature (CHATBOT)', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_chat',
      venueId: 'venue_1',
      featureId: 'feat_chat',
      active: true,
      stripeSubscriptionId: 'sub_chat',
      feature: { code: 'CHATBOT', name: 'Chatbot' },
    })
    prismaMock.venueFeature.update.mockResolvedValue({ id: 'vf_chat', active: false })
    mockStripe.cancelSubscription.mockResolvedValue(undefined as any)

    await removeFeatureFromVenue('venue_1', 'feat_chat')

    expect(mockStripe.cancelSubscription).toHaveBeenCalledWith('sub_chat')
    expect(prismaMock.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf_chat' },
      data: { active: false },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/services/dashboard/basePlan-delete-guard.test.ts --runInBand`
Expected: FAIL — the PLAN_PRO case currently calls `cancelSubscription` / `update` instead of throwing.

- [ ] **Step 3: Add the guard**

In `src/services/dashboard/venueFeature.dashboard.service.ts`, inside `removeFeatureFromVenue`, right after the `if (!venueFeature) { throw new NotFoundError(...) }` block (currently ends at `:210`) and BEFORE the `// Cancel Stripe subscription if exists` block, insert:

```typescript
  // Guard: the PLAN_PRO base plan must NEVER be canceled via this à-la-carte delete
  // (cancelSubscription cancels Stripe immediately). The base plan can only be canceled
  // through POST /plan/cancel, which schedules cancel_at_period_end. See planState.service.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(venueFeature.feature.code)) {
    throw new BadRequestError(
      'Usa el flujo de plan (cancelar suscripción) para el plan base. Endpoint: /plan/cancel',
    )
  }
```

`PAID_PLAN_TIER_CODES` and `BadRequestError` are already imported at the top of this file (`:11` and `:9`). The test asserts the message contains `flujo de plan`.

> Note: to expose `useEndpoint` in the HTTP body, the controller's error handler relays the message; the structured `{ useEndpoint: '/plan/cancel' }` field is conveyed via the message string here (matching how `BadRequestError` surfaces in this codebase). The frontend never auto-calls it — it shows the message — so the literal string is sufficient.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/services/dashboard/basePlan-delete-guard.test.ts --runInBand`
Expected: PASS (2 passing).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors. Leave changes uncommitted in the working tree.

---

## Task 5: Zod param schema for the plan endpoints

**Files:**
- Modify: `src/schemas/dashboard/venue.schema.ts` (append after `createBillingPortalSessionSchema`, `:198`)

- [ ] **Step 1: Add the schema**

Append to `src/schemas/dashboard/venue.schema.ts`:

```typescript
// Schema for base-plan endpoints (GET/POST /venues/:venueId/plan*). Path-param only.
export const planParamsSchema = z.object({
  params: z.object({
    venueId: z.string({ required_error: 'El ID del venue es requerido' }).min(1, { message: 'El ID del venue es requerido' }),
  }),
})

export type PlanParamsDto = z.infer<typeof planParamsSchema.shape.params>
```

(All Zod messages in Spanish, shape-only — per `.claude/rules/critical-warnings.md`.)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors (`z` is already imported at the top of the schema file). Leave changes uncommitted in the working tree.

---

## Task 6: Plan controllers (getVenuePlan / cancelVenuePlan / reactivateVenuePlan)

**Files:**
- Modify: `src/controllers/dashboard/venue.dashboard.controller.ts` (add after `detachVenuePaymentMethod`, around `:495`)

- [ ] **Step 1: Add an import for the plan service**

At the top of `src/controllers/dashboard/venue.dashboard.controller.ts`, near the existing `import * as venueDashboardService from '../../services/dashboard/venue.dashboard.service'` (`:25`), add:

```typescript
import * as planStateService from '../../services/dashboard/planState.service'
```

- [ ] **Step 2: Add the three controllers**

Append (after `detachVenuePaymentMethod`):

```typescript
/**
 * Get the venue's base-plan (PLAN_PRO) lifecycle state.
 * GET /api/v1/dashboard/venues/:venueId/plan
 */
export async function getVenuePlan(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const planState = await planStateService.getPlanState(venueId)
    res.status(200).json({ success: true, data: planState })
  } catch (error) {
    logger.error('Error getting venue plan state', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Schedule cancellation of the base plan at period end (cancel_at_period_end=true).
 * POST /api/v1/dashboard/venues/:venueId/plan/cancel
 */
export async function cancelVenuePlan(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const planState = await planStateService.cancelPlan(venueId)
    res.status(200).json({ success: true, data: planState })
  } catch (error) {
    logger.error('Error canceling venue plan', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Undo a scheduled base-plan cancellation (cancel_at_period_end=false).
 * POST /api/v1/dashboard/venues/:venueId/plan/reactivate
 */
export async function reactivateVenuePlan(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const planState = await planStateService.reactivatePlan(venueId)
    res.status(200).json({ success: true, data: planState })
  } catch (error) {
    logger.error('Error reactivating venue plan', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params?.venueId,
    })
    next(error)
  }
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors (`Request`, `Response`, `NextFunction`, `logger` already imported). Leave changes uncommitted in the working tree.

---

## Task 7: Wire the plan routes + re-gate billing/feature routes onto `billing:*`

**Files:**
- Modify: `src/routes/dashboard.routes.ts`

> **IMPORTANT ORDERING:** This task introduces backend `checkPermission('billing:...')` calls. Those are PHANTOM until Task 8 adds them to `DEFAULT_PERMISSIONS`. When using subagent-driven-development, run Task 8's audit (`npm run audit:permissions`) only AFTER both Task 7 and Task 8 are applied. The two tasks together must land before the audit is meaningful.

- [ ] **Step 1: Import the validation schema**

In `src/routes/dashboard.routes.ts`, near the other venue-schema imports (`createBillingPortalSessionSchema` is imported at `:201`), add `planParamsSchema` to that same import statement (it comes from `../schemas/dashboard/venue.schema` — confirm the exact specifier used for `createBillingPortalSessionSchema` and append `planParamsSchema` to it).

- [ ] **Step 2: Add the three plan routes**

Insert immediately after the billing-portal route block (which ends at `:1991`):

```typescript
/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/plan:
 *   get:
 *     tags: [Venues]
 *     summary: Get the venue's base-plan (PLAN_PRO) subscription state
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: PlanState }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/plan',
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:read'),
  validateRequest(planParamsSchema) as RequestHandler,
  venueController.getVenuePlan,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/plan/cancel:
 *   post:
 *     tags: [Venues]
 *     summary: Schedule cancellation of the base plan at period end
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated PlanState }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 */
router.post(
  '/venues/:venueId/plan/cancel',
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:manage'),
  validateRequest(planParamsSchema) as RequestHandler,
  venueController.cancelVenuePlan,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/plan/reactivate:
 *   post:
 *     tags: [Venues]
 *     summary: Undo a scheduled base-plan cancellation
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated PlanState }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 */
router.post(
  '/venues/:venueId/plan/reactivate',
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:manage'),
  validateRequest(planParamsSchema) as RequestHandler,
  venueController.reactivateVenuePlan,
)
```

- [ ] **Step 3: Re-gate the existing client billing endpoints onto `billing:*`**

Apply these exact `checkPermission` swaps (line numbers from the current file — match on the route literal, not the number, in case of drift):

| Route literal | Method | Old gate | New gate |
|---|---|---|---|
| `/venues/:venueId/billing-portal` (`:1986`) | POST | `checkPermission('venues:manage')` | `checkPermission('billing:subscriptions:manage')` |
| `/venues/:venueId/payment-methods` (`:2030`) | GET | `checkPermission('venues:manage')` | `checkPermission('billing:payment-methods:read')` |
| `/venues/:venueId/payment-methods/:paymentMethodId` (`:2062`) | DELETE | `checkPermission('venues:manage')` | `checkPermission('billing:payment-methods:manage')` |
| `/venues/:venueId/payment-methods/set-default` (`:2104`) | PUT | `checkPermission('venues:manage')` | `checkPermission('billing:payment-methods:manage')` |
| `/venues/:venueId/features` (`:2235`, the `venueFeatureController.getVenueFeatures` one) | GET | `checkPermission('venues:read')` | `checkPermission('billing:subscriptions:read')` |
| `/venues/:venueId/features` (`:2275`, `addVenueFeatures`) | POST | `checkPermission('venues:manage')` | `checkPermission('billing:subscriptions:manage')` |
| `/venues/:venueId/features/:featureId` (`:2300`, `removeVenueFeature`) | DELETE | `checkPermission('venues:manage')` | `checkPermission('billing:subscriptions:manage')` |
| `/venues/:venueId/invoices` (`:2708`) | GET | (current gate) | `checkPermission('billing:history:read')` |
| `/venues/:venueId/invoices/:invoiceId/download` (`:2736`) | GET | (current gate) | `checkPermission('billing:history:read')` |
| `/venues/:venueId/invoices/:invoiceId/retry` (`:2773`) | POST | (current gate) | `checkPermission('billing:history:read')` |

Leave the **proration-preview** (`:2605`) and **subscription** (`:2648`) routes and the duplicate `featureController.getVenueFeatures` GET at `:2485` (which checks `features:read`) untouched — those are not part of the client billing surface in scope; changing them risks unrelated drift. (The bidirectional aliases added in Task 8 keep `venues:manage`/`features:update` working for any stored overrides regardless.)

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors. Do NOT run the permissions audit yet (Task 8 first). Leave changes uncommitted in the working tree.

---

## Task 8: Permissions — make `billing:*` assignable to OWNER/ADMIN + aliases + audit

**Files:**
- Modify: `src/lib/permissions.ts`

This is the permission-policy-mandated task. Without it, every `billing:*` gate added in Task 7 is a PHANTOM (audit ERROR exit 1). `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` already lists the `billing` resource (`:1226`) — do NOT duplicate it.

- [ ] **Step 1: Add `billing:*` to ADMIN defaults**

In `src/lib/permissions.ts`, in the `[StaffRole.ADMIN]` array, immediately after the `'venues:*'` line (`:727`), add:

```typescript
    'billing:read', // Client billing surface (subscriptions / history / payment methods)
    'billing:subscriptions:read',
    'billing:subscriptions:manage', // Cancel/reactivate base plan, add/remove features, open portal
    'billing:history:read',
    'billing:payment-methods:read',
    'billing:payment-methods:manage',
```

- [ ] **Step 2: Add the same `billing:*` block to OWNER defaults**

In the `[StaffRole.OWNER]` array, immediately after its `'venues:*'` line (`:803`), add the identical six lines:

```typescript
    'billing:read',
    'billing:subscriptions:read',
    'billing:subscriptions:manage',
    'billing:history:read',
    'billing:payment-methods:read',
    'billing:payment-methods:manage',
```

(Token purchase perms `billing:tokens:*` are out of scope for this plan — Tokens already works under its own gate. Leave them as catalog-only.)

- [ ] **Step 3: Add dependencies + bidirectional aliases**

In `PERMISSION_DEPENDENCIES`, add a BILLING block (place it near the FEATURES alias block around `:188`):

```typescript
  // ===========================
  // BILLING — base-plan + à-la-carte client billing surface.
  // Bidirectional aliases preserve any stored VenueRolePermission overrides that
  // used the legacy venues:* / features:* names before this surface moved to billing:*.
  // ===========================
  'billing:read': ['billing:read'],
  'billing:subscriptions:read': ['billing:subscriptions:read', 'billing:read', 'venues:read', 'features:read'],
  'billing:subscriptions:manage': [
    'billing:subscriptions:manage',
    'billing:subscriptions:read',
    'billing:read',
    'venues:manage',
    'venues:read',
    'features:update',
  ],
  'billing:history:read': ['billing:history:read', 'billing:read'],
  'billing:payment-methods:read': ['billing:payment-methods:read', 'billing:read', 'venues:read'],
  'billing:payment-methods:manage': [
    'billing:payment-methods:manage',
    'billing:payment-methods:read',
    'billing:read',
    'venues:manage',
    'venues:read',
  ],
  // Reverse direction: a stored override granting the legacy name still implies the new billing name.
  'venues:manage': ['venues:manage', 'venues:read', 'billing:subscriptions:manage', 'billing:payment-methods:manage'],
```

> `venues:read` and `venues:update`/`features:*` aliases already exist in the file (`:225`, `:188-190`). Do NOT re-declare `venues:read`/`features:write`/`features:update`. The reverse `venues:manage` key is NOT currently in `PERMISSION_DEPENDENCIES` (only `venues:read`/`venues:update` are) — adding it is safe; `venues:*` in OWNER/ADMIN defaults already covers `venues:manage` for those roles, and this alias only matters for custom-role overrides that literally stored `venues:manage`. If `venues:manage` already appears as a key after a parallel edit, MERGE the billing entries into the existing array instead of redeclaring.

- [ ] **Step 4: Run the permissions audit (now that Task 7 + Task 8 are both applied)**

Run: `npm run audit:permissions`
Expected: **exit 0**, no new ERRORs. The pre-existing 4 `CATALOG_GAP` WARNs for `referral:*` are unrelated and acceptable (non-strict mode passes on WARN). Confirm there is **no** `PHANTOM` for any `billing:*` string and no new WARN for `billing:*`.

- [ ] **Step 5: Verify role expansion locally (optional sanity)**

Run:
```bash
npx tsx -r tsconfig-paths/register -e "import('@/lib/permissions').then(m=>{for(const p of ['billing:subscriptions:read','billing:subscriptions:manage','billing:payment-methods:read','billing:payment-methods:manage','billing:history:read']){console.log(p, ['OWNER','ADMIN'].filter(r=>m.hasPermission(r,null,p)).join(',')||'NONE')}})"
```
Expected: each line prints `... OWNER,ADMIN`.

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no new errors. Leave changes uncommitted in the working tree.

---

## Task 9: Frontend service — `getVenuePlan` / `cancelVenuePlan` / `reactivateVenuePlan`

**Files:**
- Modify: `avoqado-web-dashboard/src/services/features.service.ts`

- [ ] **Step 1: Add the `PlanState` type + three API calls**

Append to `avoqado-web-dashboard/src/services/features.service.ts`:

```typescript
/**
 * Base-plan (PLAN_PRO) lifecycle state — GET /dashboard/venues/:venueId/plan.
 * Mirrors the backend PlanState shape exactly (planState.service.ts).
 */
export interface PlanState {
  hasPlan: boolean
  state: 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
  planTier: 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
  planName: string | null
  interval: 'month' | 'year' | null
  price: { base: number; gross: number; currency: 'MXN' } | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  suspendedAt: string | null
  gracePeriodEndsAt: string | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  stripeSubscriptionId: string | null
}

/** Get the venue's base-plan state. */
export const getVenuePlan = async (venueId: string): Promise<PlanState> => {
  const response = await api.get(`/api/v1/dashboard/venues/${venueId}/plan`)
  return response.data.data
}

/** Schedule cancellation of the base plan at period end. Returns the updated state. */
export const cancelVenuePlan = async (venueId: string): Promise<PlanState> => {
  const response = await api.post(`/api/v1/dashboard/venues/${venueId}/plan/cancel`)
  return response.data.data
}

/** Undo a scheduled base-plan cancellation. Returns the updated state. */
export const reactivateVenuePlan = async (venueId: string): Promise<PlanState> => {
  const response = await api.post(`/api/v1/dashboard/venues/${venueId}/plan/reactivate`)
  return response.data.data
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (in `avoqado-web-dashboard`).
Expected: no new errors (`api` is already imported at the top of the file). Leave changes uncommitted in the working tree.

---

## Task 10: i18n keys — `currentPlan.*` in es / en / fr

**Files:**
- Modify: `avoqado-web-dashboard/src/locales/es/billing.json`
- Modify: `avoqado-web-dashboard/src/locales/en/billing.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/billing.json`

- [ ] **Step 1: Add the `currentPlan` block to `es/billing.json`**

Add a top-level `"currentPlan"` key (sibling of `"activeSubscriptions"`). JSON object:

```json
"currentPlan": {
  "title": "Tu plan",
  "noPlan": "Aún no tienes un plan base. Contacta a tu administrador para suscribirte.",
  "perMonth": "/mes",
  "perYear": "/año",
  "ivaIncluded": "IVA incluido",
  "renewsOn": "Se renueva el {{date}}",
  "trialEndsOn": "Tu prueba termina el {{date}}",
  "endsOn": "Tu acceso termina el {{date}}",
  "paymentMethod": "{{brand}} •••• {{last4}}",
  "noPaymentMethod": "Sin método de pago",
  "status": {
    "active": "Activo",
    "trial": "Prueba",
    "canceling": "Cancelando",
    "past_due": "Pago pendiente",
    "suspended": "Suspendido",
    "canceled": "Cancelado",
    "none": "Sin plan"
  },
  "actions": {
    "cancel": "Cancelar plan",
    "reactivate": "Reactivar",
    "updatePayment": "Actualizar método de pago"
  },
  "cancelDialog": {
    "title": "¿Cancelar tu plan?",
    "description": "Tu plan seguirá activo y tendrás acceso completo hasta el {{date}}. No se te cobrará de nuevo. Puedes reactivarlo antes de esa fecha.",
    "descriptionNoDate": "Tu plan seguirá activo hasta el final del periodo actual. No se te cobrará de nuevo.",
    "confirm": "Sí, cancelar al final del periodo",
    "cancel": "Mantener mi plan"
  },
  "toast": {
    "cancelSuccess": "Tu plan se cancelará al final del periodo",
    "reactivateSuccess": "Tu plan fue reactivado",
    "error": "No se pudo actualizar tu plan"
  }
}
```

- [ ] **Step 2: Add the `currentPlan` block to `en/billing.json`**

```json
"currentPlan": {
  "title": "Your plan",
  "noPlan": "You don't have a base plan yet. Contact your administrator to subscribe.",
  "perMonth": "/mo",
  "perYear": "/yr",
  "ivaIncluded": "VAT included",
  "renewsOn": "Renews on {{date}}",
  "trialEndsOn": "Your trial ends on {{date}}",
  "endsOn": "Your access ends on {{date}}",
  "paymentMethod": "{{brand}} •••• {{last4}}",
  "noPaymentMethod": "No payment method",
  "status": {
    "active": "Active",
    "trial": "Trial",
    "canceling": "Canceling",
    "past_due": "Past due",
    "suspended": "Suspended",
    "canceled": "Canceled",
    "none": "No plan"
  },
  "actions": {
    "cancel": "Cancel plan",
    "reactivate": "Reactivate",
    "updatePayment": "Update payment method"
  },
  "cancelDialog": {
    "title": "Cancel your plan?",
    "description": "Your plan stays active with full access until {{date}}. You won't be charged again. You can reactivate before then.",
    "descriptionNoDate": "Your plan stays active until the end of the current period. You won't be charged again.",
    "confirm": "Yes, cancel at period end",
    "cancel": "Keep my plan"
  },
  "toast": {
    "cancelSuccess": "Your plan will cancel at the end of the period",
    "reactivateSuccess": "Your plan was reactivated",
    "error": "Couldn't update your plan"
  }
}
```

- [ ] **Step 3: Add the `currentPlan` block to `fr/billing.json`**

```json
"currentPlan": {
  "title": "Votre forfait",
  "noPlan": "Vous n'avez pas encore de forfait de base. Contactez votre administrateur pour vous abonner.",
  "perMonth": "/mois",
  "perYear": "/an",
  "ivaIncluded": "TVA incluse",
  "renewsOn": "Renouvellement le {{date}}",
  "trialEndsOn": "Votre essai se termine le {{date}}",
  "endsOn": "Votre accès se termine le {{date}}",
  "paymentMethod": "{{brand}} •••• {{last4}}",
  "noPaymentMethod": "Aucun moyen de paiement",
  "status": {
    "active": "Actif",
    "trial": "Essai",
    "canceling": "Annulation",
    "past_due": "Paiement en retard",
    "suspended": "Suspendu",
    "canceled": "Annulé",
    "none": "Aucun forfait"
  },
  "actions": {
    "cancel": "Annuler le forfait",
    "reactivate": "Réactiver",
    "updatePayment": "Mettre à jour le moyen de paiement"
  },
  "cancelDialog": {
    "title": "Annuler votre forfait ?",
    "description": "Votre forfait reste actif avec un accès complet jusqu'au {{date}}. Vous ne serez plus facturé. Vous pouvez le réactiver avant cette date.",
    "descriptionNoDate": "Votre forfait reste actif jusqu'à la fin de la période en cours. Vous ne serez plus facturé.",
    "confirm": "Oui, annuler à la fin de la période",
    "cancel": "Conserver mon forfait"
  },
  "toast": {
    "cancelSuccess": "Votre forfait sera annulé à la fin de la période",
    "reactivateSuccess": "Votre forfait a été réactivé",
    "error": "Impossible de mettre à jour votre forfait"
  }
}
```

- [ ] **Step 4: Verify all three files are valid JSON**

Run:
```bash
node -e "['es','en','fr'].forEach(l=>{const j=require('./src/locales/'+l+'/billing.json'); if(!j.currentPlan?.cancelDialog?.confirm) throw new Error('missing currentPlan in '+l); console.log(l,'OK')})"
```
(from `avoqado-web-dashboard`)
Expected: `es OK` / `en OK` / `fr OK`. Leave changes uncommitted in the working tree.

---

## Task 11: `CurrentPlanCard` component ("Tu plan")

**Files:**
- Create: `avoqado-web-dashboard/src/pages/Settings/Billing/components/CurrentPlanCard.tsx`

This card owns its own query + mutations (self-contained, so `Subscriptions.tsx` only renders `<CurrentPlanCard />`).

- [ ] **Step 1: Write the component**

Create `avoqado-web-dashboard/src/pages/Settings/Billing/components/CurrentPlanCard.tsx`:

```tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Calendar, CreditCard, AlertCircle, RefreshCw } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { useVenueDateTime } from '@/utils/datetime'
import {
  getVenuePlan,
  cancelVenuePlan,
  reactivateVenuePlan,
  getBillingPortalUrl,
  type PlanState,
} from '@/services/features.service'

const BADGE_VARIANT: Record<PlanState['state'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  trial: 'secondary',
  canceling: 'outline',
  past_due: 'destructive',
  suspended: 'destructive',
  canceled: 'destructive',
  none: 'outline',
}

export function CurrentPlanCard({ venueId }: { venueId: string }) {
  const { t, i18n } = useTranslation('billing')
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { formatDate } = useVenueDateTime()
  const [showCancelDialog, setShowCancelDialog] = useState(false)

  const { data: plan, isLoading } = useQuery<PlanState>({
    queryKey: ['venuePlan', venueId],
    queryFn: () => getVenuePlan(venueId),
    enabled: !!venueId,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['venuePlan', venueId] })
    queryClient.invalidateQueries({ queryKey: ['venueFeatures', venueId] })
  }

  const cancelMutation = useMutation({
    mutationFn: () => cancelVenuePlan(venueId),
    onSuccess: () => {
      invalidate()
      toast({ title: t('currentPlan.toast.cancelSuccess'), variant: 'default' })
      setShowCancelDialog(false)
    },
    onError: () => toast({ title: t('currentPlan.toast.error'), variant: 'destructive' }),
  })

  const reactivateMutation = useMutation({
    mutationFn: () => reactivateVenuePlan(venueId),
    onSuccess: () => {
      invalidate()
      toast({ title: t('currentPlan.toast.reactivateSuccess'), variant: 'default' })
    },
    onError: () => toast({ title: t('currentPlan.toast.error'), variant: 'destructive' }),
  })

  const portalMutation = useMutation({
    mutationFn: () => getBillingPortalUrl(venueId),
    onSuccess: ({ url }) => {
      if (url) window.location.href = url
    },
    onError: () => toast({ title: t('currentPlan.toast.error'), variant: 'destructive' }),
  })

  if (isLoading) return null
  if (!plan || plan.state === 'none' || !plan.hasPlan) return null

  const formatMoney = (amount: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: plan.price?.currency || 'MXN' }).format(amount)

  const intervalSuffix = plan.interval === 'year' ? t('currentPlan.perYear') : t('currentPlan.perMonth')

  // Date line per state.
  const dateLine = (() => {
    if (plan.state === 'trial' && plan.trialEndsAt) {
      return { icon: <Calendar className="h-3.5 w-3.5" />, text: t('currentPlan.trialEndsOn', { date: formatDate(plan.trialEndsAt) }) }
    }
    if (plan.state === 'canceling' && plan.currentPeriodEnd) {
      return { icon: <AlertCircle className="h-3.5 w-3.5" />, text: t('currentPlan.endsOn', { date: formatDate(plan.currentPeriodEnd) }) }
    }
    if (plan.currentPeriodEnd) {
      return { icon: <Calendar className="h-3.5 w-3.5" />, text: t('currentPlan.renewsOn', { date: formatDate(plan.currentPeriodEnd) }) }
    }
    return null
  })()

  return (
    <>
      <Card className="border-2 border-primary/30">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">{t('currentPlan.title')}</CardTitle>
              <CardDescription>{plan.planName}</CardDescription>
            </div>
            <Badge variant={BADGE_VARIANT[plan.state]}>{t(`currentPlan.status.${plan.state}`)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Price (gross, IVA-inclusive) */}
          {plan.price && (
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{formatMoney(plan.price.gross)}</span>
              <span className="text-sm text-muted-foreground">{intervalSuffix}</span>
              <span className="text-xs text-muted-foreground">· {t('currentPlan.ivaIncluded')}</span>
            </div>
          )}

          {/* Date line */}
          {dateLine && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {dateLine.icon}
              {dateLine.text}
            </div>
          )}

          {/* Payment method summary */}
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CreditCard className="h-3.5 w-3.5" />
            {plan.paymentMethod
              ? t('currentPlan.paymentMethod', { brand: plan.paymentMethod.brand, last4: plan.paymentMethod.last4 })
              : t('currentPlan.noPaymentMethod')}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            {plan.cancelAtPeriodEnd ? (
              <Button size="sm" onClick={() => reactivateMutation.mutate()} disabled={reactivateMutation.isPending}>
                <RefreshCw className="h-4 w-4 mr-1.5" />
                {t('currentPlan.actions.reactivate')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCancelDialog(true)}
                disabled={cancelMutation.isPending || plan.state === 'canceled'}
              >
                {t('currentPlan.actions.cancel')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => portalMutation.mutate()} disabled={portalMutation.isPending}>
              <CreditCard className="h-4 w-4 mr-1.5" />
              {t('currentPlan.actions.updatePayment')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cancel confirmation — copy reflects real currentPeriodEnd (end of period, NOT immediate) */}
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('currentPlan.cancelDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {plan.currentPeriodEnd
                ? t('currentPlan.cancelDialog.description', { date: formatDate(plan.currentPeriodEnd) })
                : t('currentPlan.cancelDialog.descriptionNoDate')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('currentPlan.cancelDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cancelMutation.mutate()}
            >
              {t('currentPlan.cancelDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default CurrentPlanCard
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (in `avoqado-web-dashboard`).
Expected: no new errors (all imported UI components exist; `getBillingPortalUrl` is already exported from `features.service.ts`). Leave changes uncommitted in the working tree.

---

## Task 12: Mount `CurrentPlanCard` in Subscriptions.tsx + remove PLAN_PRO from à-la-carte list + fix cancel-dialog copy

**Files:**
- Modify: `avoqado-web-dashboard/src/pages/Settings/Billing/Subscriptions.tsx`

- [ ] **Step 1: Import the card**

Add near the existing component imports (after `import { PaymentMethodsSection } from '../components/PaymentMethodsSection'`, `:36`):

```typescript
import { CurrentPlanCard } from './components/CurrentPlanCard'
```

- [ ] **Step 2: Filter PLAN_PRO out of the à-la-carte active list**

Right after the `featuresStatus` query (`:69-73`), add a memo that strips the PLAN_PRO row (it is now managed only by `CurrentPlanCard`). Add this just below the `getBillingInfoCompact` helper or near the other `useMemo`s (it needs `featuresStatus`):

```typescript
  // PLAN_PRO is the base plan — managed by the "Tu plan" card, NOT the à-la-carte grid.
  // Filter it (and any future plan-tier code) out of the active-feature rows shown below.
  const PLAN_TIER_CODES = ['PLAN_PRO']
  const alaCarteActiveFeatures = useMemo(
    () => (featuresStatus?.activeFeatures ?? []).filter(f => !PLAN_TIER_CODES.includes(f.feature.code)),
    [featuresStatus?.activeFeatures],
  )
```

- [ ] **Step 3: Render the card at the top of the page body**

In the returned JSX, inside `<div className="p-8 space-y-6">` (`:417`), as the FIRST child (before the superadmin panel block at `:419`), add:

```tsx
        {/* Base-plan "Tu plan" card (PLAN_PRO) — real Stripe state, cancel/reactivate, portal */}
        {venueId && <CurrentPlanCard venueId={venueId} />}
```

- [ ] **Step 4: Use the filtered list in the active-subscriptions loop**

Change the à-la-carte active loop (`:568`) from:

```tsx
          {featuresStatus?.activeFeatures.map(feature => (
```

to:

```tsx
          {alaCarteActiveFeatures.map(feature => (
```

(Leave the superadmin panel's own `featuresStatus.activeFeatures.map` at `:510` untouched — superadmin control of the raw rows is intentional.)

- [ ] **Step 5: Fix the à-la-carte cancel-dialog copy (behaviour/copy match)**

The existing à-la-carte cancel still uses `removeVenueFeature` (immediate Stripe cancel). The current dialog copy (`confirmCancel.description`, `:776`) implies "end of billing period", but à-la-carte delete is immediate. Switch this dialog to a copy that does not promise end-of-period. In es/en/fr `billing.json` (`confirmCancel` block), change `description` to immediate-cancel wording — for `es`:

```json
"confirmCancel": {
  "title": "¿Cancelar Suscripción?",
  "description": "¿Estás seguro de que deseas cancelar {{feature}}? El acceso se desactivará de inmediato.",
  "confirm": "Sí, Cancelar Suscripción",
  "cancel": "Mantener Suscripción"
}
```

(and the equivalent immediate-cancel phrasing for `en` "...access will be turned off immediately." and `fr` "...l'accès sera désactivé immédiatement."). Then simplify the dialog's interpolation in `Subscriptions.tsx` (`:774-783`) to drop the now-misleading `date` argument:

```tsx
            <AlertDialogDescription>
              {cancelingFeatureId &&
                t('confirmCancel.description', {
                  feature: featuresStatus?.activeFeatures.find(f => f.featureId === cancelingFeatureId)?.feature.name,
                })}
            </AlertDialogDescription>
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` (in `avoqado-web-dashboard`).
Expected: no new errors. Then re-run the JSON sanity check from Task 10 Step 4 (the `confirmCancel.description` edit must keep valid JSON). Leave changes uncommitted in the working tree.

---

## Task 13: Full backend test + type pass (regression gate)

**Files:** none (verification only).

- [ ] **Step 1: Run the new backend unit tests together**

Run:
```bash
npm test -- tests/unit/services/access/derivePlanState.test.ts tests/unit/services/dashboard/planState.service.test.ts tests/unit/services/dashboard/basePlan-delete-guard.test.ts --runInBand
```
(from `avoqado-server`)
Expected: all 3 suites PASS.

- [ ] **Step 2: Type-check the whole backend**

Run: `npx tsc --noEmit` (in `avoqado-server`).
Expected: no errors.

- [ ] **Step 3: Re-confirm the permissions audit is green**

Run: `npm run audit:permissions` (from `avoqado-server`).
Expected: exit 0, no `PHANTOM`/`DASHBOARD_PHANTOM` for any `billing:*` string (the 4 pre-existing `referral:*` `CATALOG_GAP` WARNs are acceptable).

- [ ] **Step 4: Type-check the whole dashboard**

Run: `npx tsc --noEmit` (in `avoqado-web-dashboard`).
Expected: no errors. Leave all changes uncommitted in the working tree.

---

## Self-review (spec coverage map)

**Part A — Shared backend foundation**

| Spec requirement | Task |
|---|---|
| A1. `GET /dashboard/venues/:venueId/plan` → `planState.service.ts`, reads VenueFeature + Stripe sub, returns `PlanState`, state via shared `derivePlanState` | Tasks 1, 3, 6, 7 |
| A1. `derivePlanState(venueFeature, stripeSub?)` pure helper, lives in access/ (alongside `PAID_PLAN_TIER_CODES`/`venueHasActiveBasePlan`) | Task 1 |
| A2. `POST /plan/cancel` → `cancel_at_period_end = true` (end of period, not immediate), VenueFeature stays active, returns updated PlanState | Tasks 2, 3, 6, 7 |
| A2. `POST /plan/reactivate` → `cancel_at_period_end = false`, returns PlanState | Tasks 2, 3, 6, 7 |
| A2. These are the ONLY way to cancel the base plan | Tasks 4 (guard) + 7 (routes) |
| A3. `DELETE /features/:featureId` returns 400 + redirect-to-`/plan/cancel` message for PLAN_PRO | Task 4 |
| A4. Standardize plan/billing endpoints on `billing:*`; register in `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` (already present) + `DEFAULT_PERMISSIONS` (OWNER/ADMIN) + `PERMISSION_DEPENDENCIES`; update routes + frontend gates (frontend already on `billing:*`); pass `npm run audit:permissions`; keep `venues:*`/`features:*` reachable via bidirectional alias | Tasks 7, 8 |
| 7-state `derivePlanState` order + `venueHasActiveBasePlan` unchanged | Task 1 |
| Edge: no Stripe sub (DB-only/comped trial) → derive from VenueFeature only, `currentPeriodEnd` null, cancel/reactivate clear error | Tasks 1 (test), 3 (test + impl) |
| Edge: no payment method → `paymentMethod: null`, portal button still works | Tasks 3, 11 |
| Edge: cancel→reactivate before period end toggles flag, access uninterrupted | Tasks 2, 3 |
| Edge: suspended venue shows `suspended` + portal CTA | Tasks 1, 3, 11 |
| Edge: null fields tolerated, never throw (Stripe outage) | Task 3 (test: suspended + Stripe error) |
| Money = `Prisma.Decimal` server-side; gross IVA-inclusive | Task 3 (`monthlyPrice.toNumber()`, IVA via `IVA_RATE`) |
| Backend Zod messages in Spanish | Task 5 |
| Cross-repo: do NOT remove API response fields — ADD a plan object (new endpoint; existing `/features` response untouched) | Tasks 6, 7 (new endpoint; à-la-carte response shape unchanged) |

**Part B — Client Hybrid UI**

| Spec requirement | Task |
|---|---|
| "Tu plan" card at top of Subscriptions: plan name, price with IVA, interval, status badge (all 7 states), trial end OR real renewal date (from `currentPeriodEnd`), payment-method summary | Tasks 11, 12 |
| Action "Cancelar plan" → `/plan/cancel`, confirmation explains access continues until `currentPeriodEnd` (correct copy) | Task 11 |
| Action "Reactivar" shown only when `cancelAtPeriodEnd` → `/plan/reactivate` | Task 11 |
| Action "Actualizar método de pago" → Stripe Customer Portal (existing `/billing-portal`) | Task 11 (`getBillingPortalUrl`) |
| PLAN_PRO removed from generic à-la-carte list (managed only from card) | Task 12 |
| À-la-carte rows keep existing cancel behaviour; fix the cancel-dialog copy | Task 12 (Step 5) |
| New i18n keys in `locales/{es,en,fr}/billing.json` | Task 10 |

**Testing notes from spec**

| Spec test | Task |
|---|---|
| `derivePlanState` for all 7 states | Task 1 |
| `GET /plan` shape (trial/active/canceling/suspended/none) | Task 3 |
| cancel sets `cancel_at_period_end` (not immediate); reactivate clears it | Task 3 |
| guard returns 400 for PLAN_PRO on `DELETE /features/:id` | Task 4 |
| Regression: à-la-carte feature delete still works; à-la-carte status unchanged | Task 4 (CHATBOT regression test) + Task 12 (filter only PLAN_PRO) |
| `--runInBand` everywhere | Tasks 1, 3, 4, 13 |

**Out of scope (correctly excluded):** Part C / superadmin namespace, the `subscription_overview` MCP tool (both Plan 2), annual↔monthly plan-change UI, persisting `current_period_end` via webhook, CFDI, in-app subscribe entry point for legacy venues. No DB migration (all fields already exist on `VenueFeature`/`Feature`).

**Constraint compliance:** No `git commit` steps — every task ends with a `Verify` step (`npx tsc --noEmit` and/or `npm test -- <path> --runInBand`) and "leave changes uncommitted in the working tree", because other LLMs commit on `develop` in parallel.
