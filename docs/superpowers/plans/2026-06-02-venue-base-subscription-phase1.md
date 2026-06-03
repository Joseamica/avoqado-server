# Phase 1 — Pro-Tier Trial Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new venue starts a mandatory 30-day Pro trial (or pays now at a discount) with a card on file; Stripe auto-charges $999+IVA
(monthly) or $9,990+IVA (annual); paying unlocks all premium features; non-payment drops the venue to the basic feature set without touching
TPV/charging.

**Architecture:** The Pro plan is a `Feature` row (`PLAN_PRO`) reusing the existing `VenueFeature`/Stripe/webhook machinery. A new wizard
step (LAST, no skip) captures the card via a Stripe SetupIntent; the subscription is created at `completeSetup`. Access is binary:
`checkFeatureAccess` gets a blanket grant — an active `PLAN_PRO` (or trial) unlocks all premium features; when its `VenueFeature` goes
inactive (payment failure past grace), premium locks automatically. No new venue flag, no write-lock middleware. Commission is informational
only.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Stripe (subscriptions, prices, coupons, Tax, SetupIntents), React 18 + Vite +
Stripe Elements, Jest (`--runInBand`), react-i18next.

**Spec:** `docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md`

---

## ⚠️ EXECUTION CONSTRAINTS (read before every task)

1. **NO GIT COMMITS.** Other LLMs commit to `develop` in parallel. Every task leaves its changes **uncommitted in the working tree**. NEVER
   run `git add`, `git commit`, `git rebase`, `git reset`, `git stash`, `git checkout <branch>`, `git push`. Read-only
   `git status`/`git diff` is fine. The "commit" step of standard TDD is **replaced** by "run the verification command; leave changes in the
   working tree."
2. **Tests run with `--runInBand`** — the full Jest suite OOMs otherwise. Always: `npx jest <path> --runInBand`.
3. **Do NOT touch `prisma/schema.prisma` edits made by other LLMs.** Only ADD the `planTier` enum + field (Task 1). If `git status` shows
   unrelated schema changes, leave them.
4. **Two repos:** backend `=/Users/amieva/Documents/Programming/Avoqado/avoqado-server`, frontend
   `=/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`.
5. **Env flag default OFF.** `ENABLE_VENUE_BASE_SUBSCRIPTION` (backend) and the frontend always-true constant (mirrors the payment-providers
   pattern) gate all new behavior. Do not flip prod on until the ops prereqs (Stripe Tax + seed) are done.

---

## File map

**Backend (`avoqado-server`)**

| File                                                    | Action                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                  | Add `PlanTier` enum + `Venue.planTier` (nullable)                                                             |
| `scripts/seed-plan-pro.ts`                              | NEW — seed `PLAN_PRO` feature + 2 Stripe prices + `INTRO_PRO_3M` coupon                                       |
| `src/services/stripe.service.ts`                        | Add `createPlanSubscription()` + `createPlanSetupIntent(venueId)`                                             |
| `src/services/onboarding/onboardingProgress.service.ts` | Add `V2PlanData` type + `parseV2Plan()` helper                                                                |
| `src/controllers/onboarding.controller.ts`              | New `planSetupIntent` handler; hard-gate + `PLAN_PRO` sub creation + `planTier=PRO` in `completeV2Onboarding` |
| `src/routes/onboarding.routes.ts`                       | Register `POST /venues/:venueId/plan-setup-intent` (env-gated)                                                |
| `src/services/access/basePlan.service.ts`               | NEW — `venueHasActiveBasePlan(venueId)`                                                                       |
| `src/middlewares/checkFeatureAccess.middleware.ts`      | Blanket grant in `checkFeatureAccess` + `hasFeatureAccess`                                                    |
| `src/services/stripe.webhook.service.ts`                | (Verify) terminal failure deactivates the `PLAN_PRO` VenueFeature → drop to basic                             |
| `.env.example`                                          | Document `ENABLE_VENUE_BASE_SUBSCRIPTION`                                                                     |
| `tests/unit/...`                                        | New unit tests per task                                                                                       |

**Frontend (`avoqado-web-dashboard`)**

| File                                         | Action                                         |
| -------------------------------------------- | ---------------------------------------------- |
| `src/services/setup.service.ts`              | Add `planSetupIntent(venueId)`                 |
| `src/pages/Setup/types.ts`                   | Add `plan` to `SetupData`                      |
| `src/pages/Setup/steps/PlanStep.tsx`         | NEW — toggle + 2 CTAs + Stripe Elements        |
| `src/pages/Setup/SetupWizard.tsx`            | Append `plan` LAST; "Finish later" modal guard |
| `src/locales/es/setup.json`, `en/setup.json` | Plan-step strings                              |

---

## Pre-flight

- [ ] **Step 0.1: Read the spec.** `docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md`. Internalize the access model
      (binary: paid plan or trial → all premium; else basic) and the "Cobrar/Órdenes never blocked" rule.

- [ ] **Step 0.2: Confirm clean-ish working tree.**

Run (backend): `git status --short` Expected: possibly unrelated changes from other LLMs. Note them; you must not stage or revert them.
Confirm you are on branch `develop` (`git branch --show-current`). Do NOT create a branch.

---

## Phase A — Stripe + data foundation (backend)

### Task 1: `Venue.planTier` enum + field

**Files:**

- Modify: `prisma/schema.prisma`

- [ ] **Step 1.1: Add the enum + field**

Find the `VenueStatus` enum block (search `enum VenueStatus`). Immediately AFTER its closing `}`, add:

```prisma
enum PlanTier {
  GRATIS
  PRO
  PREMIUM
  ENTERPRISE
}
```

In `model Venue { ... }`, add this field near the other status/stripe fields (e.g. right after `stripePaymentMethodId String?`):

```prisma
  // Subscription plan tier. Null = legacy/untiered (existing venues, behaves as
  // today). New venues completing onboarding get PRO. See
  // docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md
  planTier PlanTier?
```

- [ ] **Step 1.2: Create the migration**

Run: `npx prisma migrate dev --name add_venue_plan_tier` Expected: a new migration under `prisma/migrations/`, Prisma client regenerated, no
errors. (Per `.claude/rules`, NEVER `prisma db push`.)

- [ ] **Step 1.3: Verify the type compiles**

Run: `npx tsc --noEmit 2>&1 | grep -i "planTier\|PlanTier" || echo "clean"` Expected: `clean`.

- [ ] **Step 1.4: Leave uncommitted.** Per execution constraints, do NOT commit. `git status --short` should show `prisma/schema.prisma` +
      the new migration dir as modified/untracked.

---

### Task 2: Seed `PLAN_PRO` feature + Stripe prices + coupon

**Files:**

- Create: `scripts/seed-plan-pro.ts`

- [ ] **Step 2.1: Write the seed script**

Create `scripts/seed-plan-pro.ts`:

```typescript
/**
 * Seeds the PLAN_PRO base-subscription feature and its Stripe objects:
 *   - Stripe Product "Plan Avoqado Pro"
 *   - Price price_pro_monthly  ($999/mo MXN)
 *   - Price price_pro_annual   ($9,990/yr MXN, 2 months free)
 *   - Coupon INTRO_PRO_3M      ($400 off, repeating, 3 months)
 *   - Feature row PLAN_PRO (monthlyPrice 999) linked to the monthly price
 *
 * Idempotent: re-running reuses objects matched by metadata/lookup_key.
 * Run: npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts
 */
import Stripe from 'stripe'
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' as any })

async function main() {
  // 1. Product (idempotent by metadata.code)
  const products = await stripe.products.search({ query: "metadata['code']:'PLAN_PRO'" })
  const product =
    products.data[0] ??
    (await stripe.products.create({
      name: 'Plan Avoqado Pro',
      metadata: { code: 'PLAN_PRO' },
    }))

  // 2. Monthly price (idempotent by lookup_key)
  const monthly =
    (await stripe.prices.list({ lookup_keys: ['plan_pro_monthly'], limit: 1 })).data[0] ??
    (await stripe.prices.create({
      product: product.id,
      currency: 'mxn',
      unit_amount: 99900, // $999.00
      recurring: { interval: 'month' },
      lookup_key: 'plan_pro_monthly',
      tax_behavior: 'exclusive', // IVA added on top by Stripe Tax
    }))

  // 3. Annual price ($9,990 = 10 months, 2 free)
  const annual =
    (await stripe.prices.list({ lookup_keys: ['plan_pro_annual'], limit: 1 })).data[0] ??
    (await stripe.prices.create({
      product: product.id,
      currency: 'mxn',
      unit_amount: 999000, // $9,990.00
      recurring: { interval: 'year' },
      lookup_key: 'plan_pro_annual',
      tax_behavior: 'exclusive',
    }))

  // 4. Intro coupon: $400 off for 3 months (turns $999 → $599)
  let coupon: Stripe.Coupon
  try {
    coupon = await stripe.coupons.retrieve('INTRO_PRO_3M')
  } catch {
    coupon = await stripe.coupons.create({
      id: 'INTRO_PRO_3M',
      amount_off: 40000, // $400.00
      currency: 'mxn',
      duration: 'repeating',
      duration_in_months: 3,
      name: 'Avoqado Pro — 3 meses a $599',
    })
  }

  // 5. Feature row (links to the monthly price as the canonical stripePriceId)
  await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: { stripeProductId: product.id, stripePriceId: monthly.id, active: true, monthlyPrice: 999 },
    create: {
      code: 'PLAN_PRO',
      name: 'Plan Avoqado Pro',
      description: 'Suscripción base de la plataforma',
      category: 'OPERATIONS',
      monthlyPrice: 999,
      stripeProductId: product.id,
      stripePriceId: monthly.id,
      active: true,
    },
  })

  logger.info(`✅ Seeded PLAN_PRO: product=${product.id} monthly=${monthly.id} annual=${annual.id} coupon=${coupon.id}`)
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-plan-pro failed:', err)
  process.exit(1)
})
```

- [ ] **Step 2.2: Run the seed against Stripe test mode + local DB**

Run: `npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts` Expected:
`✅ Seeded PLAN_PRO: product=prod_... monthly=price_... annual=price_... coupon=INTRO_PRO_3M`.

- [ ] **Step 2.3: Verify in DB**

Run:
`PGPASSWORD=exitosoy777 psql -h localhost -U postgres -d av-db-25 -c "SELECT code, \"monthlyPrice\", \"stripePriceId\" IS NOT NULL AS has_price FROM \"Feature\" WHERE code='PLAN_PRO';"`
Expected: one row, `monthlyPrice=999.00`, `has_price=t`.

- [ ] **Step 2.4: Leave uncommitted.** This is a one-time ops script; it stays in the tree.

---

### Task 3: `createPlanSubscription()` in stripe.service

**Files:**

- Modify: `src/services/stripe.service.ts`
- Test: `tests/unit/services/stripe.createPlanSubscription.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `tests/unit/services/stripe.createPlanSubscription.test.ts`:

```typescript
const mockSubCreate = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: jest.fn() },
    prices: { list: mockPriceList },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findUnique: jest.fn().mockResolvedValue(null) },
    feature: { findFirst: jest.fn().mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', stripePriceId: 'price_monthly' }) },
  },
}))

import { createPlanSubscription } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  mockSubCreate.mockResolvedValue({ id: 'sub_1', status: 'trialing' })
})

describe('createPlanSubscription', () => {
  it('trial path: 30-day trial, no coupon, automatic_tax on', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(30)
    expect(arg.discounts).toBeUndefined()
    expect(arg.automatic_tax).toEqual({ enabled: true })
  })

  it('pay-now monthly: no trial + INTRO_PRO_3M coupon', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      coupon: 'INTRO_PRO_3M',
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(0)
    expect(arg.discounts).toEqual([{ coupon: 'INTRO_PRO_3M' }])
  })

  it('annual: uses the annual price lookup_key, no coupon', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_annual' }] })
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'annual',
      trialPeriodDays: 0,
    })
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_annual'] }))
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.items[0].price).toBe('price_annual')
  })
})
```

- [ ] **Step 3.2: Run test, verify failure**

Run: `npx jest tests/unit/services/stripe.createPlanSubscription.test.ts --runInBand` Expected: FAIL — `createPlanSubscription` is not
exported.

- [ ] **Step 3.3: Implement**

In `src/services/stripe.service.ts`, add (near `createTrialSubscriptions`):

```typescript
export interface CreatePlanSubscriptionInput {
  venueId: string
  customerId: string
  paymentMethodId: string
  tierCode: 'PLAN_PRO'
  interval: 'monthly' | 'annual'
  trialPeriodDays: number // 0 = pay-now (no trial), 30 = trial
  coupon?: string // e.g. 'INTRO_PRO_3M' (monthly pay-now only)
  venueName?: string
  venueSlug?: string
}

/**
 * Creates the venue's base-plan subscription (PLAN_PRO). Sibling of
 * createTrialSubscriptions but supports interval (monthly/annual price),
 * pay-now (trialPeriodDays:0), an intro coupon, and Stripe Tax (16% IVA).
 * Idempotent: reuses an existing PLAN_PRO subscription if one already exists.
 */
export async function createPlanSubscription(input: CreatePlanSubscriptionInput): Promise<string> {
  const feature = await prisma.feature.findFirst({ where: { code: input.tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${input.tierCode} not found or inactive`)

  // Idempotency: reuse existing subscription for this venue+feature.
  const existing = await prisma.venueFeature.findUnique({
    where: { venueId_featureId: { venueId: input.venueId, featureId: feature.id } },
    select: { stripeSubscriptionId: true },
  })
  if (existing?.stripeSubscriptionId) {
    logger.info(`createPlanSubscription: reusing existing sub ${existing.stripeSubscriptionId} for venue ${input.venueId}`)
    return existing.stripeSubscriptionId
  }

  const lookupKey = input.interval === 'annual' ? 'plan_pro_annual' : 'plan_pro_monthly'
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const price = prices.data[0]
  if (!price) throw new Error(`Stripe price not found for lookup_key ${lookupKey} — run scripts/seed-plan-pro.ts`)

  const subscription = await retry(
    () =>
      stripe.subscriptions.create({
        customer: input.customerId,
        items: [{ price: price.id }],
        trial_period_days: input.trialPeriodDays,
        default_payment_method: input.paymentMethodId,
        automatic_tax: { enabled: true },
        ...(input.coupon ? { discounts: [{ coupon: input.coupon }] } : {}),
        description: input.venueName ? `Plan Avoqado Pro - ${input.venueName}` : 'Plan Avoqado Pro',
        metadata: {
          venueId: input.venueId,
          featureId: feature.id,
          featureCode: feature.code,
          interval: input.interval,
          ...(input.venueName ? { venueName: input.venueName } : {}),
          ...(input.venueSlug ? { venueSlug: input.venueSlug } : {}),
        },
        collection_method: 'charge_automatically',
        payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
      }),
    { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.createPlanSubscription' },
  )

  // Persist VenueFeature (trial vs paid: endDate = trial end when trialing)
  const now = new Date()
  const trialEnd = input.trialPeriodDays > 0 ? new Date(now.getTime() + input.trialPeriodDays * 86400000) : null
  await prisma.venueFeature.upsert({
    where: { venueId_featureId: { venueId: input.venueId, featureId: feature.id } },
    update: {
      active: true,
      stripeSubscriptionId: subscription.id,
      stripePriceId: price.id,
      monthlyPrice: feature.monthlyPrice,
      endDate: trialEnd,
      trialEndDate: trialEnd,
      suspendedAt: null,
      paymentFailureCount: 0,
    },
    create: {
      venueId: input.venueId,
      featureId: feature.id,
      active: true,
      monthlyPrice: feature.monthlyPrice,
      stripeSubscriptionId: subscription.id,
      stripePriceId: price.id,
      endDate: trialEnd,
      trialEndDate: trialEnd,
    },
  })

  logger.info(
    `✅ createPlanSubscription: ${subscription.id} (${input.interval}, trial=${input.trialPeriodDays}d) for venue ${input.venueId}`,
  )
  return subscription.id
}
```

Also add `createPlanSubscription` to the `export default { ... }` object at the bottom of the file.

- [ ] **Step 3.4: Run test, verify pass**

Run: `npx jest tests/unit/services/stripe.createPlanSubscription.test.ts --runInBand` Expected: PASS (3 tests).

- [ ] **Step 3.5: Leave uncommitted.**

---

### Task 4: `createPlanSetupIntent(venueId)` (customer-scoped)

**Files:**

- Modify: `src/services/stripe.service.ts`
- Test: `tests/unit/services/stripe.createPlanSetupIntent.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `tests/unit/services/stripe.createPlanSetupIntent.test.ts`:

```typescript
const mockSetupIntentCreate = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ setupIntents: { create: mockSetupIntentCreate } })))
jest.mock('../../../src/services/stripe.service.helpers', () => ({}), { virtual: true })

// getOrCreateStripeCustomer is in the same module; mock prisma + venue lookup it uses.
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', email: 'a@b.com', name: 'V', slug: 'v', stripeCustomerId: 'cus_1' }) },
  },
}))

import { createPlanSetupIntent } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockSetupIntentCreate.mockResolvedValue({ id: 'seti_1', client_secret: 'seti_1_secret' })
})

it('creates a customer-scoped SetupIntent and returns its client_secret', async () => {
  const secret = await createPlanSetupIntent('v1')
  expect(secret).toBe('seti_1_secret')
  const arg = mockSetupIntentCreate.mock.calls[0][0]
  expect(arg.customer).toBe('cus_1')
  expect(arg.payment_method_types).toEqual(['card'])
  expect(arg.usage).toBe('off_session')
})
```

- [ ] **Step 4.2: Run test, verify failure**

Run: `npx jest tests/unit/services/stripe.createPlanSetupIntent.test.ts --runInBand` Expected: FAIL — `createPlanSetupIntent` not exported.

- [ ] **Step 4.3: Implement**

In `src/services/stripe.service.ts`, add near `createOnboardingSetupIntent`:

```typescript
/**
 * Customer-scoped SetupIntent for the onboarding plan step. Unlike
 * createOnboardingSetupIntent (no customer), this attaches the resulting
 * payment method to the venue's Stripe customer so the plan subscription can
 * charge it. Returns the client_secret for Stripe Elements.
 */
export async function createPlanSetupIntent(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, email: true, name: true, slug: true, stripeCustomerId: true },
  })
  if (!venue) throw new Error(`Venue ${venueId} not found`)

  const customerId = await getOrCreateStripeCustomer(
    venue.id,
    venue.email || `venue-${venue.slug}@avoqado.io`,
    venue.name,
    venue.name,
    venue.slug,
  )

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { venueId, purpose: 'plan_pro_onboarding' },
  })

  logger.info(`✅ Created plan SetupIntent ${setupIntent.id} for venue ${venueId} (customer ${customerId})`)
  return setupIntent.client_secret!
}
```

Add `createPlanSetupIntent` to the `export default { ... }` object.

- [ ] **Step 4.4: Run test, verify pass**

Run: `npx jest tests/unit/services/stripe.createPlanSetupIntent.test.ts --runInBand` Expected: PASS.

- [ ] **Step 4.5: Leave uncommitted.**

---

## Phase B — Onboarding wiring (backend)

### Task 5: `V2PlanData` type + `parseV2Plan()` helper

**Files:**

- Modify: `src/services/onboarding/onboardingProgress.service.ts`
- Test: `tests/unit/services/onboarding/v2Plan.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `tests/unit/services/onboarding/v2Plan.test.ts`:

```typescript
import { parseV2Plan } from '../../../../src/services/onboarding/onboardingProgress.service'

describe('parseV2Plan', () => {
  it('returns null when no plan saved', () => {
    expect(parseV2Plan(null)).toBeNull()
    expect(parseV2Plan({ step2: {} })).toBeNull()
  })
  it('parses a complete plan', () => {
    expect(
      parseV2Plan({ plan: { paymentMethodId: 'pm_1', interval: 'annual', payNow: true, acceptedAt: '2026-06-02T00:00:00Z' } }),
    ).toEqual({ paymentMethodId: 'pm_1', interval: 'annual', payNow: true, acceptedAt: '2026-06-02T00:00:00Z' })
  })
  it('defaults interval to monthly and payNow to false when partial', () => {
    expect(parseV2Plan({ plan: { paymentMethodId: 'pm_1' } })).toEqual({
      paymentMethodId: 'pm_1',
      interval: 'monthly',
      payNow: false,
      acceptedAt: null,
    })
  })
})
```

- [ ] **Step 5.2: Run test, verify failure**

Run: `npx jest tests/unit/services/onboarding/v2Plan.test.ts --runInBand` Expected: FAIL — `parseV2Plan` not exported.

- [ ] **Step 5.3: Implement**

In `src/services/onboarding/onboardingProgress.service.ts`, add near the other exports (e.g. next to `parseV2Step8` if present):

```typescript
export interface V2PlanData {
  paymentMethodId: string | null
  interval: 'monthly' | 'annual'
  payNow: boolean
  acceptedAt: string | null
}

/**
 * Reads the stable semantic `plan` key from v2SetupData (NOT a positional
 * stepN key — see the spec). Returns null when the plan step hasn't been saved.
 */
export function parseV2Plan(v2SetupData: unknown): V2PlanData | null {
  if (!v2SetupData || typeof v2SetupData !== 'object') return null
  const plan = (v2SetupData as Record<string, any>).plan
  if (!plan || typeof plan !== 'object') return null
  return {
    paymentMethodId: typeof plan.paymentMethodId === 'string' ? plan.paymentMethodId : null,
    interval: plan.interval === 'annual' ? 'annual' : 'monthly',
    payNow: plan.payNow === true,
    acceptedAt: typeof plan.acceptedAt === 'string' ? plan.acceptedAt : null,
  }
}
```

- [ ] **Step 5.4: Run test, verify pass**

Run: `npx jest tests/unit/services/onboarding/v2Plan.test.ts --runInBand` Expected: PASS (3 tests).

- [ ] **Step 5.5: Leave uncommitted.**

---

### Task 6: `POST /onboarding/venues/:venueId/plan-setup-intent`

**Files:**

- Modify: `src/controllers/onboarding.controller.ts`
- Modify: `src/routes/onboarding.routes.ts`

- [ ] **Step 6.1: Add the controller handler**

In `src/controllers/onboarding.controller.ts`, extend the EXISTING stripe import line (currently
`import { createOnboardingSetupIntent } from '../services/stripe.service'`) to add `createPlanSetupIntent`:

```typescript
import { createOnboardingSetupIntent, createPlanSetupIntent } from '../services/stripe.service'
```

(Task 7 will extend this same line further with `createPlanSubscription` + `getOrCreateStripeCustomer`.)

Append a handler:

```typescript
/**
 * POST /api/v1/onboarding/venues/:venueId/plan-setup-intent
 * Returns a customer-scoped Stripe SetupIntent client_secret so the wizard's
 * plan step can collect the card via Stripe Elements. Env-gated at the route.
 */
export async function planSetupIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    if (!authContext?.userId) throw new BadRequestError('No autenticado')
    const clientSecret = await createPlanSetupIntent(venueId)
    res.status(200).json({ success: true, clientSecret })
  } catch (error) {
    next(error)
  }
}
```

- [ ] **Step 6.2: Register the route (env-gated)**

In `src/routes/onboarding.routes.ts`, near the other venue-scoped onboarding routes, add:

```typescript
if (process.env.ENABLE_VENUE_BASE_SUBSCRIPTION === 'true') {
  router.post('/venues/:venueId/plan-setup-intent', authenticateTokenMiddleware, onboardingController.planSetupIntent)
}
```

(Match the existing controller-import style in this file — it uses `onboardingController.<fn>` namespace per the payment-providers task.
Reuse the same `authenticateTokenMiddleware` already imported there.)

- [ ] **Step 6.3: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -iE "onboarding.(controller|routes)" || echo "clean"` Expected: `clean`.

- [ ] **Step 6.4: Leave uncommitted.**

---

### Task 7: Hard-gate + plan subscription in `completeV2Onboarding`

**Files:**

- Modify: `src/controllers/onboarding.controller.ts`
- Test: `tests/unit/controllers/completeV2.planGate.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `tests/unit/controllers/completeV2.planGate.test.ts`:

```typescript
import { parseV2Plan } from '../../../src/services/onboarding/onboardingProgress.service'

// This test pins the gate's decision logic (pure function over v2SetupData).
describe('plan hard-gate decision', () => {
  const enabled = true
  function gateRejects(v2SetupData: unknown): boolean {
    if (!enabled) return false
    const plan = parseV2Plan(v2SetupData)
    return !plan?.paymentMethodId
  }
  it('rejects when no plan/paymentMethodId', () => {
    expect(gateRejects({ step2: {} })).toBe(true)
    expect(gateRejects({ plan: { interval: 'monthly' } })).toBe(true)
  })
  it('allows when paymentMethodId present', () => {
    expect(gateRejects({ plan: { paymentMethodId: 'pm_1', interval: 'monthly', payNow: false } })).toBe(false)
  })
})
```

(The full controller is heavily integration-bound; this test pins the gate logic that Step 7.2 implements. The 4-variant subscription
creation is covered by Task 3's unit tests + the Task 18 E2E.)

- [ ] **Step 7.2: Run test, verify pass-as-spec** (it tests the helper from Task 5)

Run: `npx jest tests/unit/controllers/completeV2.planGate.test.ts --runInBand` Expected: PASS — it documents the gate contract using the
already-implemented `parseV2Plan`.

- [ ] **Step 7.3a: Add named Stripe imports**

The controller already has `import { createOnboardingSetupIntent } from '../services/stripe.service'` (line ~15). Stripe is imported as
**named functions**, NOT a namespace. Extend that import:

```typescript
import {
  createOnboardingSetupIntent,
  createPlanSetupIntent,
  createPlanSubscription,
  getOrCreateStripeCustomer,
} from '../services/stripe.service'
```

(`createPlanSetupIntent` was already added for Task 6 — make this the single consolidated import line.)

- [ ] **Step 7.3b: Pull `progress` into the destructure**

`completeV2Onboarding` currently does (line ~929):

```typescript
const { businessInfo, bankInfo, identityInfo, entityInfo } = await onboardingProgressService.getV2SetupDataForCompletion(organizationId)
```

`getV2SetupDataForCompletion` already returns `progress` (verified). Add it:

```typescript
const { progress, businessInfo, bankInfo, identityInfo, entityInfo } =
  await onboardingProgressService.getV2SetupDataForCompletion(organizationId)
```

- [ ] **Step 7.3c: Add the hard-gate** (right after the destructure above, BEFORE the optimistic lock / venue creation):

```typescript
const planEnabled = process.env.ENABLE_VENUE_BASE_SUBSCRIPTION === 'true'
const planData = onboardingProgressService.parseV2Plan(progress.v2SetupData)
if (planEnabled && !planData?.paymentMethodId) {
  throw new BadRequestError('Falta el método de pago del plan. Completa el paso de plan para terminar.')
}
```

- [ ] **Step 7.3d: Create the subscription** (AFTER the venue exists + status transitioned + the `venueUpdateData` block, BEFORE
      `prisma.organization.update({ ... onboardingCompletedAt })`). Uses the NAMED stripe functions (no `stripeService.` namespace):

```typescript
if (planEnabled && planData?.paymentMethodId) {
  try {
    const venueRecord = await prisma.venue.findUnique({
      where: { id: result.venue.id },
      select: { id: true, name: true, slug: true, email: true },
    })
    const customerId = await getOrCreateStripeCustomer(
      result.venue.id,
      venueRecord?.email || `venue-${result.venue.slug}@avoqado.io`,
      venueRecord?.name || result.venue.name,
      venueRecord?.name || result.venue.name,
      result.venue.slug,
    )
    await createPlanSubscription({
      venueId: result.venue.id,
      customerId,
      paymentMethodId: planData.paymentMethodId,
      tierCode: 'PLAN_PRO',
      interval: planData.interval,
      trialPeriodDays: planData.payNow ? 0 : 30,
      coupon: planData.payNow && planData.interval === 'monthly' ? 'INTRO_PRO_3M' : undefined,
      venueName: result.venue.name,
      venueSlug: result.venue.slug,
    })
    await prisma.venue.update({ where: { id: result.venue.id }, data: { planTier: 'PRO' } })
  } catch (planErr) {
    // Non-fatal: the venue is created. Log loudly; ops can retry the sub.
    logger.error(`⚠️ PLAN_PRO subscription creation failed for venue ${result.venue.id}`, planErr)
  }
}
```

- [ ] **Step 7.4: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -iE "onboarding.controller" || echo "clean"` Expected: `clean`.

- [ ] **Step 7.5: Leave uncommitted.**

---

## Phase C — Access enforcement (backend)

### Task 8: `venueHasActiveBasePlan` + `checkFeatureAccess` blanket grant

**Files:**

- Create: `src/services/access/basePlan.service.ts`
- Modify: `src/middlewares/checkFeatureAccess.middleware.ts`
- Test: `tests/unit/services/access/basePlan.test.ts`

- [ ] **Step 8.1: Write the failing test**

Create `tests/unit/services/access/basePlan.test.ts`:

```typescript
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findFirst: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import { venueHasActiveBasePlan } from '../../../../src/services/access/basePlan.service'

const mock = (prisma as any).venueFeature.findFirst
beforeEach(() => jest.clearAllMocks())

describe('venueHasActiveBasePlan', () => {
  it('true when PLAN_PRO active, not suspended, trial in future', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: new Date(Date.now() + 86400000) })
    expect(await venueHasActiveBasePlan('v1')).toBe(true)
  })
  it('true when PLAN_PRO active paid (endDate null)', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: null })
    expect(await venueHasActiveBasePlan('v1')).toBe(true)
  })
  it('false when no PLAN_PRO row', async () => {
    mock.mockResolvedValue(null)
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
  it('false when suspended (payment failed)', async () => {
    mock.mockResolvedValue({ active: false, suspendedAt: new Date(), endDate: null })
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
  it('false when trial expired', async () => {
    mock.mockResolvedValue({ active: true, suspendedAt: null, endDate: new Date(Date.now() - 86400000) })
    expect(await venueHasActiveBasePlan('v1')).toBe(false)
  })
})
```

- [ ] **Step 8.2: Run test, verify failure**

Run: `npx jest tests/unit/services/access/basePlan.test.ts --runInBand` Expected: FAIL — module not found.

- [ ] **Step 8.3: Implement the service**

Create `src/services/access/basePlan.service.ts`:

```typescript
import prisma from '@/utils/prismaClient'

/** Paid plan tier codes that grant a blanket premium unlock. Phase 1: PLAN_PRO. */
export const PAID_PLAN_TIER_CODES = ['PLAN_PRO'] as const

/**
 * True when the venue currently has an entitled base plan: an active, non-
 * suspended PLAN_PRO VenueFeature whose trial (endDate) is null or in the
 * future. This is the binary "paid or trialing" gate that unlocks all premium
 * features (the blanket grant). When false, premium locks and the venue falls
 * back to the basic set.
 */
export async function venueHasActiveBasePlan(venueId: string): Promise<boolean> {
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: { active: true, suspendedAt: true, endDate: true },
  })
  if (!vf || !vf.active || vf.suspendedAt) return false
  if (vf.endDate && vf.endDate < new Date()) return false // trial expired unpaid
  return true
}
```

- [ ] **Step 8.4: Run test, verify pass**

Run: `npx jest tests/unit/services/access/basePlan.test.ts --runInBand` Expected: PASS (5 tests).

- [ ] **Step 8.5: Wire the blanket grant into checkFeatureAccess**

In `src/middlewares/checkFeatureAccess.middleware.ts`:

Add import at top:

```typescript
import { venueHasActiveBasePlan, PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
```

In `checkFeatureAccess(featureCode)`, replace the "Feature not found or not active" denial block (the
`if (!venueFeature || !venueFeature.active) { ... res.status(403) ... return }`) so that, before denying, it consults the base plan:

```typescript
if (!venueFeature || !venueFeature.active) {
  // Blanket grant: an active base plan (or trial) unlocks all premium features,
  // except the plan tiers themselves. Phase 1 has no ALWAYS_ADDON features.
  if (!PAID_PLAN_TIER_CODES.includes(featureCode as any) && (await venueHasActiveBasePlan(venueId))) {
    ;(req as any).venueFeature = { featureCode, grantedBy: 'BASE_PLAN' }
    return next()
  }
  logger.warn('⚠️ Feature access denied: Feature not active', {
    venueId,
    userId,
    featureCode,
    hasFeature: !!venueFeature,
    isActive: venueFeature?.active || false,
  })
  res.status(403).json({
    error: 'Feature not available',
    message: `This venue does not have access to the ${featureCode} feature. Please subscribe to enable this feature.`,
    featureCode,
    subscriptionRequired: true,
  })
  return
}
```

Apply the SAME blanket-grant pattern in `hasFeatureAccess(venueId, featureCode)`: before the
`if (!venueFeature || !venueFeature.active) return { hasAccess: false, ... }`, add:

```typescript
if (!venueFeature || !venueFeature.active) {
  if (!PAID_PLAN_TIER_CODES.includes(featureCode as any) && (await venueHasActiveBasePlan(venueId))) {
    return { hasAccess: true, isTrialing: false, trialEndsAt: null }
  }
  return { hasAccess: false, isTrialing: false, trialEndsAt: null, reason: 'Feature not active' }
}
```

- [ ] **Step 8.6: Verify the middleware still compiles + its existing tests pass**

Run: `npx tsc --noEmit 2>&1 | grep -i checkFeatureAccess || echo "clean"` → expect `clean`. Run (if a test file exists):
`npx jest tests/unit/middlewares/checkFeatureAccess --runInBand 2>&1 | tail -5` (skip if none).

- [ ] **Step 8.7: Leave uncommitted.**

---

### Task 9: Verify webhook drops PLAN_PRO to basic on terminal failure

**Files:**

- Read/verify: `src/services/stripe.webhook.service.ts`
- Test: `tests/unit/services/stripe.webhook.planPro.test.ts`

- [ ] **Step 9.1: Inspect the existing failure handler**

Run:
`grep -n "past_due\|unpaid\|suspendedAt\|active: false\|gracePeriod\|venueFeature.update" src/services/stripe.webhook.service.ts | head -30`
Goal: confirm the subscription-status handler maps a Stripe subscription → its `VenueFeature` (via `stripeSubscriptionId`) and, on terminal
failure after grace, sets `active: false` / `suspendedAt`. Because `PLAN_PRO` is just another `VenueFeature`, this already drops the venue
to basic (the blanket grant in Task 8 reads exactly these fields).

- [ ] **Step 9.2: Write a regression test asserting it**

Create `tests/unit/services/stripe.webhook.planPro.test.ts` that drives the existing status-change handler with a `PLAN_PRO` subscription
going `past_due` past grace, and asserts `prisma.venueFeature.update` is called with `active:false`/`suspendedAt`. Mock prisma + map the
subscription to a PLAN_PRO VenueFeature. (Mirror the mocking style of the existing webhook tests under `tests/unit/services/` — reuse their
prisma mock shape.)

```typescript
// Skeleton — adapt mocks to match the existing webhook test setup in this repo.
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'vf1',
        venueId: 'v1',
        active: true,
        paymentFailureCount: 3,
        gracePeriodEndsAt: new Date(Date.now() - 86400000), // grace already passed
        feature: { code: 'PLAN_PRO' },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    venue: { update: jest.fn() },
  },
}))
// import the exported status handler (or handleWebhookEvent) and invoke with a
// past_due customer.subscription.updated event whose metadata.featureCode = PLAN_PRO.
// assert venueFeature.update called with data including active:false OR suspendedAt set.
```

- [ ] **Step 9.3: Run the test**

Run: `npx jest tests/unit/services/stripe.webhook.planPro.test.ts --runInBand` Expected: PASS if the existing handler already deactivates.
**If it FAILS** (the handler doesn't deactivate PLAN_PRO), add a minimal branch in the status handler: when the mapped VenueFeature exists
and grace has passed, `await prisma.venueFeature.update({ where:{id}, data:{ active:false, suspendedAt: new Date() } })`. Re-run until
green. Do NOT add any venue-level flag — deactivating the VenueFeature is sufficient (Task 8's grant reads it).

- [ ] **Step 9.4: Leave uncommitted.**

---

### Task 10: Apply blanket grant to the `/me/access` payload

**Files:**

- Modify: `src/services/access/access.service.ts` (the resolver feeding `/me/access`)

- [ ] **Step 10.1: Locate the feature-access resolution**

Run: `grep -n "venueFeature\|featureCode\|enabledFeatures\|FeatureAccess\|active" src/services/access/access.service.ts | head -30` Goal:
find where the per-venue enabled-feature list is built for the dashboard's `useAccess`.

- [ ] **Step 10.2: Apply the grant**

Where the service computes which premium feature codes are enabled for the venue, add: if `await venueHasActiveBasePlan(venueId)` is true,
treat ALL known premium feature codes as enabled (except `PAID_PLAN_TIER_CODES`). Import from `@/services/access/basePlan.service`. This
makes the dashboard hide/show correctly and matches the middleware's runtime behavior. Keep the existing à-la-carte resolution as a union
(base-plan grant OR individual VenueFeature).

```typescript
import { venueHasActiveBasePlan, PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
// ... after building the per-feature enabled set from VenueFeature rows:
if (await venueHasActiveBasePlan(venueId)) {
  for (const code of ALL_PREMIUM_FEATURE_CODES) {
    if (!PAID_PLAN_TIER_CODES.includes(code as any)) enabledFeatureCodes.add(code)
  }
}
```

(If the service already has a canonical list of premium feature codes, reuse it for `ALL_PREMIUM_FEATURE_CODES`; otherwise derive it from
`prisma.feature.findMany({ where: { active: true, code: { notIn: [...PAID_PLAN_TIER_CODES] } }, select: { code: true } })`.)

- [ ] **Step 10.3: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -i access.service || echo "clean"` Expected: `clean`.

- [ ] **Step 10.4: Leave uncommitted.**

---

## Phase D — Feature flag (backend)

### Task 11: Document the env flag

**Files:**

- Modify: `.env.example`

- [ ] **Step 11.1: Append to `.env.example`**

Add (near the `ENABLE_ONBOARDING_PAYMENT_PROVIDERS` entry if it exists):

```bash
# When 'true', adds the mandatory Pro-plan step at the end of the V2 setup
# wizard (30-day trial / pay-now), creates the PLAN_PRO subscription on
# completion, and enables the base-plan blanket feature grant.
# Ops prereqs before prod: enable Stripe Tax + run scripts/seed-plan-pro.ts.
# Spec: docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md
ENABLE_VENUE_BASE_SUBSCRIPTION=false
```

- [ ] **Step 11.2: Set it locally for testing**

Append `ENABLE_VENUE_BASE_SUBSCRIPTION=true` to the backend `.env` (NOT `.env.example`) so local QA works. `tsx watch` reloads on save.

- [ ] **Step 11.3: Leave uncommitted.**

---

## Phase E — Frontend (`avoqado-web-dashboard`)

### Task 12: `setup.service.planSetupIntent` + `SetupData.plan`

**Files:**

- Modify: `src/services/setup.service.ts`
- Modify: `src/pages/Setup/types.ts`

- [ ] **Step 12.1: Add the API method**

In `src/services/setup.service.ts`, inside the `setupService` object:

```typescript
  /** Get a customer-scoped Stripe SetupIntent client_secret for the plan step. */
  planSetupIntent: (venueId: string) =>
    api.post(`/api/v1/onboarding/venues/${venueId}/plan-setup-intent`),
```

- [ ] **Step 12.2: Extend `SetupData`**

In `src/pages/Setup/types.ts`, inside `interface SetupData`:

```typescript
  // Step: Plan (base subscription)
  plan?: {
    paymentMethodId?: string
    interval?: 'monthly' | 'annual'
    payNow?: boolean
    acceptedAt?: string
  }
```

- [ ] **Step 12.3: TypeScript check**

Run (frontend dir): `npx tsc --noEmit 2>&1 | tail -5` Expected: clean.

- [ ] **Step 12.4: Leave uncommitted.**

---

### Task 13: `PlanStep.tsx`

**Files:**

- Create: `src/pages/Setup/steps/PlanStep.tsx`

- [ ] **Step 13.1: Confirm Stripe Elements deps**

Run (frontend dir): `grep -E '@stripe/(react-stripe-js|stripe-js)' package.json || echo "MISSING"` If `MISSING`, report BLOCKED (the repo
should already have Stripe Elements from checkout; do not install without confirmation). Also
`grep -rn "loadStripe\|VITE_STRIPE" src | head -5` to find the existing publishable-key env var and reuse it.

- [ ] **Step 13.2: Create the component**

Create `src/pages/Setup/steps/PlanStep.tsx`:

```typescript
/**
 * PlanStep — V2 wizard final step (mandatory, no skip).
 *
 * Billing toggle (Mensual/Anual) + two CTAs:
 *   - "Empezar 30 días gratis" → trial (payNow:false)
 *   - "Pagar hoy y ahorrar"    → no trial (payNow:true); monthly gets $599×3
 * Card captured via Stripe Elements against a customer-scoped SetupIntent.
 * On confirm, persists v2SetupData.plan = { paymentMethodId, interval, payNow }.
 * Spec: docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { Button } from '@/components/ui/button'
import { setupService } from '@/services/setup.service'
import { useToast } from '@/hooks/use-toast'
import type { StepProps } from '../types'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string)

interface PlanStepProps extends StepProps {
  venueId: string
  organizationId: string
}

const PRICES = {
  monthly: { full: '$999', promo: '$599', label: 'mes' },
  annual: { full: '$9,990', promo: '$9,990', label: 'año' },
}

export function PlanStep({ onNext, venueId, organizationId, data }: PlanStepProps) {
  const { t } = useTranslation('setup')
  const [interval, setInterval] = useState<'monthly' | 'annual'>(data.plan?.interval ?? 'monthly')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    let active = true
    setupService
      .planSetupIntent(venueId)
      .then(res => { if (active) setClientSecret(res.data.clientSecret) })
      .catch(() => toast({ title: 'No pudimos preparar el pago', variant: 'destructive' }))
    return () => { active = false }
  }, [venueId, toast])

  const options = useMemo(() => (clientSecret ? { clientSecret } : undefined), [clientSecret])

  return (
    <div className="flex flex-col gap-8 max-w-xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold sm:text-3xl">
          {t('plan.title', { defaultValue: 'Tu plan Avoqado' })}
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          {t('plan.subtitle', { defaultValue: 'Activa tu plan para usar todas las funciones de Avoqado.' })}
        </p>
      </div>

      {/* Interval toggle */}
      <div className="inline-flex rounded-full border p-1 self-start">
        {(['monthly', 'annual'] as const).map(i => (
          <button
            key={i}
            onClick={() => setInterval(i)}
            className={`px-4 py-2 rounded-full text-sm ${interval === i ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
          >
            {i === 'monthly'
              ? t('plan.monthly', { defaultValue: 'Mensual' })
              : t('plan.annual', { defaultValue: 'Anual (2 meses gratis)' })}
          </button>
        ))}
      </div>

      <div className="rounded-lg border p-4 text-sm">
        <p>{t('plan.priceLine', { defaultValue: `${PRICES[interval].full} + IVA / ${PRICES[interval].label}` })}</p>
        {interval === 'monthly' && (
          <p className="text-muted-foreground mt-1">
            {t('plan.promoLine', { defaultValue: 'Paga hoy: 3 meses a $599 + IVA, luego $999.' })}
          </p>
        )}
      </div>

      {options ? (
        <Elements stripe={stripePromise} options={options}>
          <PlanCardForm
            interval={interval}
            onConfirmed={(paymentMethodId, payNow) =>
              onNext({ plan: { paymentMethodId, interval, payNow, acceptedAt: new Date().toISOString() } })
            }
          />
        </Elements>
      ) : (
        <p className="text-sm text-muted-foreground">{t('plan.loading', { defaultValue: 'Cargando…' })}</p>
      )}
    </div>
  )
}

function PlanCardForm({
  interval,
  onConfirmed,
}: {
  interval: 'monthly' | 'annual'
  onConfirmed: (paymentMethodId: string, payNow: boolean) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const { t } = useTranslation('setup')
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)

  const confirm = async (payNow: boolean) => {
    if (!stripe || !elements) return
    setSubmitting(true)
    try {
      const { error, setupIntent } = await stripe.confirmSetup({ elements, redirect: 'if_required' })
      if (error || !setupIntent?.payment_method) {
        toast({ title: error?.message || 'No se pudo guardar la tarjeta', variant: 'destructive' })
        return
      }
      onConfirmed(String(setupIntent.payment_method), payNow)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PaymentElement />
      <div className="flex flex-col gap-3">
        <Button disabled={submitting} onClick={() => confirm(false)} className="rounded-full">
          {t('plan.startTrial', { defaultValue: 'Empezar 30 días gratis' })}
        </Button>
        <Button disabled={submitting} variant="outline" onClick={() => confirm(true)} className="rounded-full">
          {interval === 'monthly'
            ? t('plan.payNowMonthly', { defaultValue: 'Pagar hoy y ahorrar (3 meses a $599)' })
            : t('plan.payNowAnnual', { defaultValue: 'Pagar hoy (anual)' })}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 13.3: TypeScript check**

Run (frontend dir): `npx tsc --noEmit 2>&1 | grep -i PlanStep || echo "clean"` Expected: `clean`.

- [ ] **Step 13.4: Leave uncommitted.**

---

### Task 14: Append `plan` step LAST + "Finish later" modal guard

**Files:**

- Modify: `src/pages/Setup/SetupWizard.tsx`

- [ ] **Step 14.1: Import + append the step LAST**

In `SetupWizard.tsx`, add `import { PlanStep } from './steps/PlanStep'`. In the step-array builder (the function that pushes
`paymentProviders`/`buyTpv`), append the plan step LAST, unconditionally (mirrors `PAYMENT_PROVIDERS_ENABLED = true` pattern — the backend
env flag is the real gate; the frontend always shows it):

```typescript
steps.push({ id: 'plan', component: PlanStep })
```

(Plan MUST be the final entry so it's the only path to completion — `handleNext` on the last step calls `handleComplete`.)

- [ ] **Step 14.2: Pass venue/org props to the plan step**

Where the active step component is rendered (the `{...(stepId === 'buyTpv' ? {...} : {})}` block), add a sibling spread:

```typescript
{...(stepId === 'plan' ? { venueId: (data as any).venueId, organizationId: orgId } : {})}
```

Ensure the venue is ensured for the plan step the same way it is for `paymentProviders`/`buyTpv` (the
`newStepId === 'paymentProviders' || newStepId === 'buyTpv'` ensureVenue block — add `|| newStepId === 'plan'`).

- [ ] **Step 14.3: "Finish later" modal guard**

Locate `handleFinishLater`. Wrap it so that, when the plan step has not been completed (`!data.plan?.paymentMethodId`), it shows a confirm
modal before logging out:

```typescript
const handleFinishLater = useCallback(async () => {
  if (!data.plan?.paymentMethodId) {
    const proceed = window.confirm(
      t('plan.finishLaterWarning', {
        defaultValue: 'Tu cuenta no se activará hasta que completes tu plan. ¿Pausar de todos modos?',
      }),
    )
    if (!proceed) return
  }
  toast({ title: t('wizard.progressSaved'), description: t('wizard.progressSavedDesc') })
  await logout('/login')
}, [data.plan, logout, toast, t])
```

(A `window.confirm` is acceptable for Phase 1; a styled modal can replace it later. The backend hard-gate is the real guarantee.)

- [ ] **Step 14.4: TypeScript check**

Run (frontend dir): `npx tsc --noEmit 2>&1 | tail -5` Expected: clean.

- [ ] **Step 14.5: Leave uncommitted.**

---

### Task 15: i18n keys (es + en)

**Files:**

- Modify: `src/locales/es/setup.json`, `src/locales/en/setup.json`

- [ ] **Step 15.1: Add the `plan` block (ES)**

In `src/locales/es/setup.json`, add a top-level `plan` object:

```json
"plan": {
  "title": "Tu plan Avoqado",
  "subtitle": "Activa tu plan para usar todas las funciones de Avoqado.",
  "monthly": "Mensual",
  "annual": "Anual (2 meses gratis)",
  "priceLine": "$999 + IVA / mes",
  "promoLine": "Paga hoy: 3 meses a $599 + IVA, luego $999.",
  "startTrial": "Empezar 30 días gratis",
  "payNowMonthly": "Pagar hoy y ahorrar (3 meses a $599)",
  "payNowAnnual": "Pagar hoy (anual)",
  "loading": "Cargando…",
  "finishLaterWarning": "Tu cuenta no se activará hasta que completes tu plan. ¿Pausar de todos modos?"
}
```

- [ ] **Step 15.2: Add the `plan` block (EN)**

In `src/locales/en/setup.json`:

```json
"plan": {
  "title": "Your Avoqado plan",
  "subtitle": "Activate your plan to use all of Avoqado's features.",
  "monthly": "Monthly",
  "annual": "Annual (2 months free)",
  "priceLine": "$999 + tax / month",
  "promoLine": "Pay today: 3 months at $599 + tax, then $999.",
  "startTrial": "Start 30-day free trial",
  "payNowMonthly": "Pay today and save (3 months at $599)",
  "payNowAnnual": "Pay today (annual)",
  "loading": "Loading…",
  "finishLaterWarning": "Your account won't activate until you complete your plan. Pause anyway?"
}
```

- [ ] **Step 15.3: Validate JSON**

Run (frontend dir):
`node -e "JSON.parse(require('fs').readFileSync('src/locales/es/setup.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/en/setup.json','utf8')); console.log('JSON valid')"`
Expected: `JSON valid`.

- [ ] **Step 15.4: Leave uncommitted.**

---

## Phase F — Verify

### Task 16: Full type + targeted test pass (both repos)

- [ ] **Step 16.1: Backend tests**

Run (backend dir):

```bash
npx jest tests/unit/services/stripe.createPlanSubscription.test.ts \
         tests/unit/services/stripe.createPlanSetupIntent.test.ts \
         tests/unit/services/onboarding/v2Plan.test.ts \
         tests/unit/controllers/completeV2.planGate.test.ts \
         tests/unit/services/access/basePlan.test.ts \
         tests/unit/services/stripe.webhook.planPro.test.ts --runInBand
```

Expected: all PASS.

- [ ] **Step 16.2: Backend TS**

Run (backend dir): `npx tsc --noEmit 2>&1 | tail -5` → expect clean.

- [ ] **Step 16.3: Frontend TS**

Run (frontend dir): `npx tsc --noEmit 2>&1 | tail -5` → expect clean.

- [ ] **Step 16.4: Format the touched files**

Run (backend dir):
`npx prettier --write src/services/stripe.service.ts src/services/access/basePlan.service.ts src/middlewares/checkFeatureAccess.middleware.ts src/controllers/onboarding.controller.ts src/services/onboarding/onboardingProgress.service.ts`
(Do NOT run the whole-repo format; only touched files.)

---

### Task 17: E2E via API + manual Stripe QA

- [ ] **Step 17.1: Ensure flags + seed are in place locally**

Backend `.env` has `ENABLE_VENUE_BASE_SUBSCRIPTION=true`; `scripts/seed-plan-pro.ts` has run (Task 2). Both dev servers restarted.

- [ ] **Step 17.2: E2E — four variants via the in-browser fetch pattern**

Use the proven payment-providers approach (a `page.evaluate` that fetches `/onboarding/signup` → verify-email `000000` → save mandatory
steps → `planSetupIntent` → confirm a test card → `saveStep` `plan` → `complete`). Run the four combinations {monthly, annual} × {trial,
payNow}. After each, assert in DB:

```bash
PGPASSWORD=exitosoy777 psql -h localhost -U postgres -d av-db-25 -c \
"SELECT v.\"planTier\", vf.active, vf.\"endDate\", vf.\"stripeSubscriptionId\" IS NOT NULL AS has_sub \
 FROM \"Venue\" v JOIN \"VenueFeature\" vf ON vf.\"venueId\"=v.id \
 JOIN \"Feature\" f ON f.id=vf.\"featureId\" \
 WHERE f.code='PLAN_PRO' ORDER BY v.\"createdAt\" DESC LIMIT 1;"
```

Expected: `planTier=PRO`, `active=t`, `has_sub=t`; trial variants → `endDate ≈ now+30d`; payNow variants → `endDate` null.

- [ ] **Step 17.3: Hard-gate check**

Complete a wizard WITHOUT saving `plan` → assert `/v2/complete` returns 400 and no venue is finalized.

- [ ] **Step 17.4: Drop-to-basic check**

For a completed PLAN_PRO venue, simulate payment failure past grace (set `VenueFeature.suspendedAt` + `active=false` via psql, OR Stripe
CLI). Then assert: a premium endpoint returns 403, a basic endpoint (orders) still works, a TPV charge still works, and the dashboard
`/me/access` no longer lists premium codes.

- [ ] **Step 17.5: Manual Stripe dashboard QA**

Confirm in Stripe test mode: trial sub shows `trialing` + the tax line; monthly pay-now shows the `INTRO_PRO_3M` discount ($599 effective)
with "3 months remaining"; annual shows $9,990.

- [ ] **Step 17.6: Document results.** Note any deviation as a follow-up; do NOT commit. Report completion to the user.

---

## Out of scope (later phases — do NOT build here)

- Gratis tier, downgrade/upgrade, tier→feature granular bundling, `Feature.bundlingMode`/ALWAYS_ADDON field, Premium/Enterprise tiers,
  add-on billing, existing-venue migration, commission-by-tier. All documented in the spec's "Phasing & Roadmap".

---

## Self-review notes (for the executor)

- The blanket grant lives in TWO backend spots (`checkFeatureAccess` middleware runtime + `access.service` payload for the UI) — both must
  read `venueHasActiveBasePlan`, or the UI and the API will disagree.
- "Cobrar"/"Órdenes" are NOT feature-gated today, so they're never blocked — do not add gating to them.
- Subscription creation is non-fatal in `completeV2Onboarding` (logged, not thrown) so a Stripe hiccup never strands a created venue; the
  hard-gate (paymentMethodId present) runs BEFORE venue finalization and IS fatal.
- Every task ends uncommitted. The executor reports the final working-tree state to the user, who decides what to commit.
