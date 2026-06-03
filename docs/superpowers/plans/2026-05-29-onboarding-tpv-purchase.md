# Onboarding TPV Purchase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Step 9 to the V2 setup wizard that lets a new merchant buy a TPV terminal, reusing the existing
`TerminalPurchaseWizard` modal verbatim. State survives Stripe Checkout round-trip and tab close. The step never blocks onboarding
completion regardless of order state.

**Architecture:** Extend `createCheckoutSession` to accept `from: 'tpv' | 'setup'` so Stripe's `success_url` can route back to
`/setup#step-8` instead of `/tpv/orders/:id`. The setup step (`BuyTpvStep.tsx`) hydrates from URL params → step9 data → most-recent-order
fallback → empty. The existing `TerminalPurchaseWizard` gains two new props (`from`, `onComplete`) — no internal changes. All new behavior
gated on `ENABLE_ONBOARDING_TPV_PURCHASE` env flag.

**Tech Stack:**

- Backend: Express + TypeScript, Prisma, existing Stripe Checkout service, existing TPV order pipeline
- Frontend: React 18 + Vite, react-i18next, existing `tpvOrderService`, existing `TerminalPurchaseWizard`
- Tests: Jest (`runInBand` to avoid OOM in this repo) for backend, Playwright for E2E
- Spec: `docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md`

---

## File map

**Backend (`avoqado-server`)**

| File                                                                             | Action | Responsibility                                                                 |
| -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `src/services/dashboard/terminalOrder/createCheckoutSession.ts`                  | Modify | Accept optional `from: 'tpv' \| 'setup'`. Branch `success_url` / `cancel_url`. |
| `src/services/dashboard/terminalOrder/createOrder.service.ts`                    | Modify | Forward `from` to `createCheckoutSession`.                                     |
| `src/controllers/dashboard/terminalOrder.dashboard.controller.ts`                | Modify | Accept `from` in `POST /tpv-orders` request body.                              |
| `src/schemas/dashboard/terminalOrder.schema.ts`                                  | Modify | Add `from: z.enum(['tpv', 'setup']).optional()` to create-order Zod schema.    |
| `src/services/onboarding/onboardingProgress.service.ts`                          | Modify | Add `V2Step9Data` typing + reading helper.                                     |
| `src/controllers/onboarding.controller.ts`                                       | Modify | Extend `getV2SetupDataForCompletion` to surface `tpvOrderId` + order state.    |
| `src/config/featureFlags.ts` (or inline)                                         | Modify | Expose `ENABLE_ONBOARDING_TPV_PURCHASE`.                                       |
| `tests/unit/services/dashboard/terminalOrder/createCheckoutSession.from.test.ts` | Create | `from` branches `success_url`.                                                 |
| `tests/unit/services/onboarding/v2Step9.test.ts`                                 | Create | `step9_tpvPurchase` round-trips through progress service.                      |
| `tests/unit/controllers/onboarding.tpvOrderId.test.ts`                           | Create | `getV2SetupDataForCompletion` returns latest TPV order ID.                     |

**Frontend (`avoqado-web-dashboard`)**

| File                                                                          | Action         | Responsibility                                                                                                                                             |
| ----------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/Setup/types.ts`                                                    | Modify         | Add `tpvPurchase: { tpvOrderId, skipped, lastUpdatedAt }` to `SetupData`.                                                                                  |
| `src/pages/Setup/SetupWizard.tsx`                                             | Modify         | Conditionally add `BuyTpvStep` to `SETUP_STEPS`. URL-param hydration for `tpv_status`. Pass `venueId` to BuyTpvStep like PaymentProvidersStep.             |
| `src/pages/Setup/steps/BuyTpvStep.tsx`                                        | Create         | Views A + B. Embeds `TerminalPurchaseWizard` modal. Hydrates from most-recent-order query.                                                                 |
| `src/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard.tsx`         | Modify (small) | Accept `from?: 'tpv' \| 'setup'` and `onComplete?: (result) => void` props. Forward `from` to `createOrder`. Fire `onComplete` from Step4 on SPEI success. |
| `src/pages/Tpv/components/purchase-wizard/wizard-steps/Step4Confirmation.tsx` | Modify         | Receive `onComplete` callback, fire it on SPEI flow completion.                                                                                            |
| `src/services/tpvOrder.service.ts`                                            | Modify         | `createOrder` payload accepts `from`.                                                                                                                      |
| `src/locales/es/setup.json`, `src/locales/en/setup.json`                      | Modify         | New `step9.*` i18n keys.                                                                                                                                   |
| `e2e/tests/onboarding/buy-tpv-step.spec.ts`                                   | Create         | Playwright E2E: skip, SPEI happy path, "Terminar onboarding →" works in every order state.                                                                 |

---

## Pre-flight

- [ ] **Step 0.1: Read the spec end-to-end**

Path: `docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md`

This plan assumes you've internalized the three views (A/B/C), the failure matrix (11 scenarios), the hydration rules table, and especially
the **central invariant**: Step 9 NEVER blocks completion. Re-read the spec before starting Task 1 if any of these are unclear.

- [ ] **Step 0.2: Read the payment-providers spec for the round-trip pattern**

Path: `docs/superpowers/specs/2026-05-27-onboarding-payment-providers-design.md`

We reuse the URL-param hydration mechanism from Step 8 (`?mp_status=success`) for Step 9 (`?tpv_status=success`). The implementation pattern
in `SetupWizard.tsx` (the `if (mpStatus === 'success')` branch) is the template for our `tpv_status` branch.

- [ ] **Step 0.3: Create a feature branch**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
git checkout -b feature/onboarding-tpv-purchase
git status
```

Expected: clean working tree, on the new branch. The frontend repo also gets the same branch name when you switch over.

- [ ] **Step 0.4: Verify the env flag is unset locally**

```bash
grep -i ENABLE_ONBOARDING_TPV_PURCHASE .env || echo "(unset — good)"
```

Expected: `(unset — good)`. All new behavior stays invisible until the flag is flipped at the end of the plan.

---

## Phase A — Backend: checkout session round-trip (3 tasks)

### Task 1: Extend `createCheckoutSession` with `from` parameter

**Files:**

- Modify: `src/services/dashboard/terminalOrder/createCheckoutSession.ts`
- Create: `tests/unit/services/dashboard/terminalOrder/createCheckoutSession.from.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create the test file with two assertions:

```typescript
import { createCheckoutSession } from '../../../../../src/services/dashboard/terminalOrder/createCheckoutSession'

const mockStripeCreate = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockStripeCreate } },
  }))
})

describe('createCheckoutSession — `from` parameter', () => {
  beforeEach(() => {
    mockStripeCreate.mockReset()
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
    process.env.FRONTEND_URL = 'https://dashboard.test'
  })

  it('defaults success_url to /tpv/orders/:id when `from` is omitted', async () => {
    mockStripeCreate.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test' })

    await createCheckoutSession({
      orderId: 'order-1',
      venueId: 'venue-1',
      amount: 4640,
      currency: 'mxn',
      customerEmail: 'a@b.com',
      orderItems: [{ name: 'PAX A910S', quantity: 1, unitPrice: 4000 }],
    })

    expect(mockStripeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://dashboard.test/tpv/orders/order-1?status=success',
        cancel_url: 'https://dashboard.test/tpv/orders/order-1?status=canceled',
      }),
    )
  })

  it('routes success_url to /setup#step-8 when `from === setup`', async () => {
    mockStripeCreate.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test' })

    await createCheckoutSession({
      orderId: 'order-1',
      venueId: 'venue-1',
      amount: 4640,
      currency: 'mxn',
      customerEmail: 'a@b.com',
      orderItems: [{ name: 'PAX A910S', quantity: 1, unitPrice: 4000 }],
      from: 'setup',
    })

    expect(mockStripeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://dashboard.test/setup?tpv_status=success&orderId=order-1#step-8',
        cancel_url: 'https://dashboard.test/setup?tpv_status=cancel&orderId=order-1#step-8',
      }),
    )
  })
})
```

Run: `npm test -- createCheckoutSession.from.test.ts --runInBand`. Expected: failing because the parameter doesn't exist yet.

- [ ] **Step 1.2: Implement the minimal change**

In `src/services/dashboard/terminalOrder/createCheckoutSession.ts`:

1. Add `from?: 'tpv' | 'setup'` to the params interface.
2. Branch URL construction:

```typescript
const frontend = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
const baseUrls =
  from === 'setup'
    ? {
        success_url: `${frontend}/setup?tpv_status=success&orderId=${orderId}#step-8`,
        cancel_url: `${frontend}/setup?tpv_status=cancel&orderId=${orderId}#step-8`,
      }
    : {
        success_url: `${frontend}/tpv/orders/${orderId}?status=success`,
        cancel_url: `${frontend}/tpv/orders/${orderId}?status=canceled`,
      }
```

Run: `npm test -- createCheckoutSession.from.test.ts --runInBand`. Expected: green.

- [ ] **Step 1.3: Verify no other test broke**

```bash
npm test -- createCheckoutSession --runInBand
```

Expected: all `createCheckoutSession.*` tests pass (the default-behavior test guards the `from='tpv'` path).

### Task 2: Forward `from` from `createOrder.service`

**Files:**

- Modify: `src/services/dashboard/terminalOrder/createOrder.service.ts`
- Modify: existing `createOrder.service.test.ts` (add 1 case)

- [ ] **Step 2.1: Extend the existing test**

In the existing test file, add inside the `describe('createOrder')` block:

```typescript
it('forwards `from` to createCheckoutSession when provided', async () => {
  const checkoutSpy = jest.spyOn(createCheckoutSessionModule, 'createCheckoutSession')
  checkoutSpy.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test' })

  await createOrder({
    venueId: 'venue-1',
    paymentMethod: 'CARD',
    items: [{ modelCode: 'PAX_A910S', quantity: 1 }],
    contact: { name: 'Test', email: 't@t.com', phone: '5555555555' },
    shipping: { address: 'A', city: 'C', state: 'S', postalCode: '00000', country: 'MX' },
    from: 'setup',
  })

  expect(checkoutSpy).toHaveBeenCalledWith(expect.objectContaining({ from: 'setup' }))
})
```

Run: fails — `from` not in params yet.

- [ ] **Step 2.2: Add `from` to params + forward**

In `createOrder.service.ts`:

- Add `from?: 'tpv' | 'setup'` to `CreateOrderParams`.
- When calling `createCheckoutSession`, pass `from`.

Run: green.

### Task 3: Accept `from` in the controller + Zod schema

**Files:**

- Modify: `src/schemas/dashboard/terminalOrder.schema.ts`
- Modify: `src/controllers/dashboard/terminalOrder.dashboard.controller.ts`
- Modify: existing `terminalOrder.dashboard.controller.test.ts` (add 1 case)

- [ ] **Step 3.1: Add `from` to the Zod schema**

In `terminalOrder.schema.ts`, find the `createTerminalOrderSchema` body and add:

```typescript
from: z.enum(['tpv', 'setup']).optional(),
```

⚠️ **Remember**: Zod error messages reach the user. Keep the field optional — no custom message needed since invalid values produce a
generic 400.

- [ ] **Step 3.2: Add a controller test**

```typescript
it('forwards `from` to createOrder when present in body', async () => {
  const createOrderSpy = jest.spyOn(createOrderModule, 'createOrder')
  createOrderSpy.mockResolvedValue(fakeOrder)
  const res = await request(app)
    .post('/api/v1/dashboard/venues/venue-1/tpv-orders')
    .set('Cookie', validAuthCookie)
    .send({
      paymentMethod: 'CARD',
      items: [{ modelCode: 'PAX_A910S', quantity: 1 }],
      contact: { name: 'A', email: 'a@a.com', phone: '5555555555' },
      shipping: { address: 'A', city: 'C', state: 'S', postalCode: '00000', country: 'MX' },
      from: 'setup',
    })
  expect(res.status).toBe(201)
  expect(createOrderSpy).toHaveBeenCalledWith(expect.objectContaining({ from: 'setup' }))
})
```

Run: fails (controller doesn't forward it yet).

- [ ] **Step 3.3: Forward `from` in the controller**

In `terminalOrder.dashboard.controller.ts`, find the `createTerminalOrder` handler and add `from: req.body.from` to the `createOrder()`
call.

Run: green. Run the full controller test file too — no regressions.

---

## Phase B — Backend: onboarding state + step9 data (3 tasks)

### Task 4: Add `V2Step9Data` typing + reader

**Files:**

- Modify: `src/services/onboarding/onboardingProgress.service.ts`
- Create: `tests/unit/services/onboarding/v2Step9.test.ts`

- [ ] **Step 4.1: Write the failing round-trip test**

```typescript
import { saveV2StepData, getV2SetupData } from '../../../../src/services/onboarding/onboardingProgress.service'
import { prisma } from '../../../helpers/prisma'

describe('V2Step9 data — round-trip', () => {
  let orgId: string
  beforeEach(async () => {
    orgId = (await prisma.organization.create({ data: { name: 't', slug: 'tst-' + Date.now() } })).id
  })
  afterEach(async () => {
    await prisma.organization.delete({ where: { id: orgId } })
  })

  it('persists step9_tpvPurchase fields and reads them back', async () => {
    await saveV2StepData(orgId, 9, { tpvOrderId: 'order-abc', skipped: false })
    const data = await getV2SetupData(orgId)
    expect(data?.step9_tpvPurchase).toEqual(
      expect.objectContaining({
        tpvOrderId: 'order-abc',
        skipped: false,
        lastUpdatedAt: expect.any(String),
      }),
    )
  })
})
```

Run: fails — `step9_tpvPurchase` isn't typed/keyed yet.

- [ ] **Step 4.2: Add typing + step-9 key handling**

In `onboardingProgress.service.ts`:

1. Add to `V2StepData` union: `step9_tpvPurchase?: V2Step9Data` (or whatever the existing typing pattern is — match
   `step8_paymentProviders`).
2. Add `V2Step9Data` interface: `{ tpvOrderId: string | null; skipped: boolean; lastUpdatedAt: string }`.
3. Verify `saveV2StepData(orgId, 9, ...)` writes under `step9_tpvPurchase` (the existing code probably maps step number → JSON key; mirror
   the step-8 pattern).

Run: green.

### Task 5: Surface `tpvOrderId` from `getV2SetupDataForCompletion`

**Files:**

- Modify: `src/controllers/onboarding.controller.ts`
- Create: `tests/unit/controllers/onboarding.tpvOrderId.test.ts`

- [ ] **Step 5.1: Write the failing test**

Three scenarios in one describe block:

```typescript
describe('getV2SetupDataForCompletion — tpvOrderId hydration', () => {
  it('returns null when no order exists', async () => {
    /* assert response.body.tpvOrderId === null */
  })
  it('returns the order id from step9_tpvPurchase when set', async () => {
    /* assert it matches */
  })
  it('falls back to the most recent TerminalOrder when step9 is empty', async () => {
    /* assert it matches the latest */
  })
})
```

Run: fails.

- [ ] **Step 5.2: Implement hydration**

In `onboarding.controller.ts`, find `getV2SetupDataForCompletion` and add:

```typescript
const step9 = v2SetupData?.step9_tpvPurchase
let tpvOrderId: string | null = step9?.tpvOrderId ?? null
let tpvOrderState: string | null = null
if (tpvOrderId) {
  const order = await prisma.terminalOrder.findUnique({ where: { id: tpvOrderId }, select: { state: true } })
  tpvOrderState = order?.state ?? null
} else {
  // Fallback: most recent order for this venue
  const venue = await resolveVenueIdFromOrg(orgId)
  if (venue) {
    const recent = await prisma.terminalOrder.findFirst({
      where: { venueId: venue },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true },
    })
    if (recent) {
      tpvOrderId = recent.id
      tpvOrderState = recent.state
    }
  }
}
// Add to response payload:
return res.json({ /* existing fields */, tpvOrderId, tpvOrderState })
```

Run: green.

### Task 6: Wire `ENABLE_ONBOARDING_TPV_PURCHASE` env flag

**Files:**

- Modify: `src/controllers/onboarding.controller.ts` (or `featureFlags.ts` if it exists)
- Modify: `.env.example`

- [ ] **Step 6.1: Add the flag**

Mirror the existing `ENABLE_ONBOARDING_PAYMENT_PROVIDERS` pattern exactly.

```typescript
const TPV_PURCHASE_ENABLED = process.env.ENABLE_ONBOARDING_TPV_PURCHASE === 'true'
```

When `false`, `getV2SetupDataForCompletion` does **not** include `tpvOrderId` / `tpvOrderState` in the response (return as if Step 9 doesn't
exist).

- [ ] **Step 6.2: Document in `.env.example`**

Add:

```
# Enable optional TPV purchase step in V2 onboarding wizard (Step 9).
# When false, backend behaves as if the step doesn't exist.
ENABLE_ONBOARDING_TPV_PURCHASE=false
```

- [ ] **Step 6.3: Run the full onboarding controller test suite**

```bash
npm test -- onboarding --runInBand
```

Expected: all green.

---

## Phase C — Frontend: types + setup wizard plumbing (3 tasks)

### Task 7: Extend `SetupData` typing

**Files:**

- Modify: `src/pages/Setup/types.ts`

- [ ] **Step 7.1: Add the field**

```typescript
export interface SetupData {
  // ... existing fields
  paymentProviders?: { mpMerchantId?: string; stripeMerchantId?: string; skipped?: boolean }
  tpvPurchase?: {
    tpvOrderId?: string | null
    skipped?: boolean
    lastUpdatedAt?: string
  }
}
```

No test for typing alone; the next tasks exercise it.

### Task 8: Add `BuyTpvStep` to `SETUP_STEPS` array (flag-gated)

**Files:**

- Modify: `src/pages/Setup/SetupWizard.tsx`

- [ ] **Step 8.1: Import + conditional step**

Mirror the `PAYMENT_PROVIDERS_ENABLED` pattern:

```typescript
import { BuyTpvStep } from './steps/BuyTpvStep'

const TPV_PURCHASE_ENABLED = true // controlled by backend flag; UI always opts in

const SETUP_STEPS = (() => {
  let steps = [...BASE_SETUP_STEPS]
  if (PAYMENT_PROVIDERS_ENABLED) {
    steps = [...steps, { id: 'paymentProviders', component: PaymentProvidersStep }]
  }
  if (TPV_PURCHASE_ENABLED) {
    steps = [...steps, { id: 'buyTpv', component: BuyTpvStep }]
  }
  return steps as ReadonlyArray<{ id: string; component: any }>
})()
```

Note: `BuyTpvStep` doesn't exist yet — this compile error is expected until Task 11. To unblock the build for now, add a placeholder file:

```bash
mkdir -p src/pages/Setup/steps
cat > src/pages/Setup/steps/BuyTpvStep.tsx <<'EOF'
import type { StepProps } from '../types'
export function BuyTpvStep(_: StepProps) {
  return <div>BuyTpvStep placeholder</div>
}
EOF
```

We replace this with the real component in Task 11.

- [ ] **Step 8.2: Verify build still compiles**

```bash
npm run build
```

Expected: green build. The placeholder renders but isn't tested yet.

### Task 9: URL-param hydration for `?tpv_status=...`

**Files:**

- Modify: `src/pages/Setup/SetupWizard.tsx`

- [ ] **Step 9.1: Mirror the MP/Stripe hydration block**

Inside the `useEffect` that runs once on init (search for `mpStatus`), add a parallel branch:

```typescript
const tpvStatus = url.searchParams.get('tpv_status')
const tpvOrderId = url.searchParams.get('orderId')

if (TPV_PURCHASE_ENABLED && (tpvStatus === 'success' || tpvStatus === 'cancel')) {
  const buyTpvIndex = SETUP_STEPS.findIndex(s => s.id === 'buyTpv')
  if (buyTpvIndex >= 0) {
    maxAllowedStepRef.current = Math.max(maxAllowedStepRef.current, buyTpvIndex)
    setCurrentStep(buyTpvIndex)
    setData(prev => {
      const next = {
        ...prev,
        tpvPurchase: {
          ...(prev.tpvPurchase ?? {}),
          ...(tpvStatus === 'success' && tpvOrderId ? { tpvOrderId } : {}),
          ...(tpvStatus === 'cancel' ? { tpvOrderId: null } : {}),
          skipped: false,
        },
      }
      dataRef.current = next
      return next
    })
    // Clean URL
    url.searchParams.delete('tpv_status')
    url.searchParams.delete('orderId')
    window.history.replaceState(null, '', `${url.pathname}${url.search}#step-${buyTpvIndex + 1}`)
  }
}
```

- [ ] **Step 9.2: Hydrate `tpvPurchase` from progress payload**

Below the existing `persistedProviders` block, add:

```typescript
const persistedTpvOrderId = (progressData as any)?.tpvOrderId ?? null
if (persistedTpvOrderId) {
  setData(prev => ({ ...prev, tpvPurchase: { tpvOrderId: persistedTpvOrderId, skipped: false } }))
  dataRef.current = { ...dataRef.current, tpvPurchase: { tpvOrderId: persistedTpvOrderId, skipped: false } }
}
```

- [ ] **Step 9.3: Pass props to BuyTpvStep**

Update the step-component render at the bottom to spread props for the new step:

```typescript
{...(stepId === 'buyTpv'
  ? {
      venueId: (data as any).venueId,
      organizationId: orgId,
      tpvOrderId: data.tpvPurchase?.tpvOrderId,
    }
  : {})}
```

Run `npm run build`. Expected: green.

---

## Phase D — Frontend: `BuyTpvStep` component (2 tasks)

### Task 10: Add `from` + `onComplete` props to `TerminalPurchaseWizard`

**Files:**

- Modify: `src/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard.tsx`
- Modify: `src/pages/Tpv/components/purchase-wizard/wizard-steps/Step4Confirmation.tsx`
- Modify: `src/services/tpvOrder.service.ts`

- [ ] **Step 10.1: Service forwards `from`**

In `tpvOrder.service.ts`, find `createOrder` and add `from` to the payload type:

```typescript
async createOrder(venueId: string, body: {
  // existing fields
  from?: 'tpv' | 'setup'
}) { /* ... */ }
```

- [ ] **Step 10.2: Wizard accepts + forwards props**

In `TerminalPurchaseWizard.tsx`:

- Add `from?: 'tpv' | 'setup'` and `onComplete?: (result: { orderId: string; paymentMethod: 'CARD' | 'SPEI' }) => void` to props.
- Default `from` to `'tpv'`.
- Pass `from` into the `createOrder` mutation payload.
- Forward `onComplete` to `Step4Confirmation`.

In `Step4Confirmation.tsx`:

- Accept `onComplete`.
- After the SPEI order is successfully created (locally — no Stripe redirect), fire `onComplete({ orderId, paymentMethod: 'SPEI' })`.
- For Card flow, do NOT fire `onComplete` here — Stripe redirect takes over.

- [ ] **Step 10.3: Run existing wizard tests**

```bash
npm run build
npm run test:e2e -- tpv-purchase
```

Expected: no regressions. The new props are additive and optional.

### Task 11: Build the real `BuyTpvStep`

**Files:**

- Modify: `src/pages/Setup/steps/BuyTpvStep.tsx` (replace placeholder)

This is the largest single task. Build it incrementally inside one file, then add a snapshot test.

- [ ] **Step 11.1: Component skeleton — View A**

Replace the placeholder with:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { tpvOrderService } from '@/services/tpvOrder.service'
import { TerminalPurchaseWizard } from '@/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard'
import type { StepProps } from '../types'

interface BuyTpvStepProps extends StepProps {
  venueId: string
  organizationId: string
  tpvOrderId?: string | null
}

const CATALOG = [
  { code: 'PAX_A910S', name: 'PAX A910S', price: 4000 },
  { code: 'NEXGO_N62', name: 'NexGo N62', price: 1800 },
  { code: 'NEXGO_N86', name: 'NexGo N86', price: 3000 },
]

export function BuyTpvStep({ data, onNext, venueId, tpvOrderId }: BuyTpvStepProps) {
  const { t } = useTranslation('setup')
  const [wizardOpen, setWizardOpen] = useState(false)

  // Hydrate: prefer prop (URL or step9), else fetch most-recent order for venue
  const { data: order } = useQuery({
    queryKey: ['tpv-order-onboarding', venueId, tpvOrderId],
    queryFn: async () => {
      if (tpvOrderId) return tpvOrderService.getOrder(venueId, tpvOrderId)
      const list = await tpvOrderService.listForVenue(venueId, { limit: 1 })
      return list[0] ?? null
    },
    enabled: Boolean(venueId),
  })

  const handleSkip = () => onNext({ tpvPurchase: { tpvOrderId: null, skipped: true, lastUpdatedAt: new Date().toISOString() } })

  const handleFinish = () =>
    onNext({
      tpvPurchase: {
        tpvOrderId: order?.id ?? null,
        skipped: false,
        lastUpdatedAt: new Date().toISOString(),
      },
    })

  const handleWizardComplete = (result: { orderId: string; paymentMethod: 'CARD' | 'SPEI' }) => {
    setWizardOpen(false)
    // Refetch is automatic via TanStack Query invalidation triggered inside the wizard.
    // Persist immediately so refresh shows the order.
    onNext({
      tpvPurchase: {
        tpvOrderId: result.orderId,
        skipped: false,
        lastUpdatedAt: new Date().toISOString(),
      },
    })
  }

  // ... render View A or View B based on `order`
}
```

- [ ] **Step 11.2: Render View A (no order)**

Inside the component return, when `!order`:

```tsx
return (
  <div className="flex flex-col gap-8 max-w-2xl mx-auto">
    <header>
      <h1 className="text-2xl font-semibold sm:text-3xl">{t('step9.title', { defaultValue: 'Compra tu terminal de pago (opcional)' })}</h1>
      <p className="text-sm text-muted-foreground mt-2">
        {t('step9.subtitle', { defaultValue: 'Cobra presencial con una terminal física. SIM con internet 4G incluida.' })}
      </p>
    </header>
    <Card className="p-6 flex flex-col gap-4">
      <p className="font-medium text-sm">{t('step9.catalogHeading', { defaultValue: 'Modelos disponibles' })}</p>
      <ul className="text-sm space-y-1">
        {CATALOG.map(m => (
          <li key={m.code}>
            • {m.name} — ${m.price.toLocaleString('es-MX')} + IVA
          </li>
        ))}
      </ul>
      <Button onClick={() => setWizardOpen(true)} className="rounded-full">
        {t('step9.openWizard', { defaultValue: 'Ver catálogo y comprar →' })}
      </Button>
    </Card>
    <div className="pt-4 border-t">
      <button onClick={handleSkip} className="text-sm text-muted-foreground hover:underline">
        {t('step9.skip', { defaultValue: 'Saltar por ahora →' })}
      </button>
    </div>
    <TerminalPurchaseWizard
      open={wizardOpen}
      onOpenChange={setWizardOpen}
      venueId={venueId}
      from="setup"
      onComplete={handleWizardComplete}
    />
  </div>
)
```

- [ ] **Step 11.3: Render View B (order exists)**

Inside the same return, when `order`:

```tsx
const STATE_MESSAGES: Record<string, { label: string; help: string }> = {
  AWAITING_SPEI: {
    label: t('step9.state.awaitingSpei', { defaultValue: 'Esperando comprobante SPEI' }),
    help: t('step9.help.awaitingSpei', { defaultValue: 'Sube tu comprobante en TPV → Pedidos cuando estés listo.' }),
  },
  SPEI_RECEIVED: {
    label: t('step9.state.speiReceived', { defaultValue: 'Comprobante recibido — revisando' }),
    help: t('step9.help.speiReceived', { defaultValue: 'Te notificaremos por correo cuando lo aprobemos.' }),
  },
  PAID: {
    label: t('step9.state.paid', { defaultValue: 'Pago confirmado' }),
    help: t('step9.help.paid', { defaultValue: 'Asignaremos tu terminal en las próximas horas.' }),
  },
  AWAITING_SERIALS: {
    label: t('step9.state.paid', { defaultValue: 'Pago confirmado' }),
    help: t('step9.help.paid', { defaultValue: 'Asignaremos tu terminal en las próximas horas.' }),
  },
  SERIALS_ASSIGNED: {
    label: t('step9.state.shipped', { defaultValue: 'Tu terminal está en camino' }),
    help: t('step9.help.shipped', { defaultValue: 'Te enviamos los detalles de envío al correo.' }),
  },
  SHIPPED: {
    label: t('step9.state.shipped', { defaultValue: 'Tu terminal está en camino' }),
    help: t('step9.help.shipped', { defaultValue: 'Te enviamos los detalles de envío al correo.' }),
  },
  DELIVERED: {
    label: t('step9.state.delivered', { defaultValue: 'Entregada' }),
    help: t('step9.help.delivered', { defaultValue: 'Empieza a cobrar desde TPV → Equipos.' }),
  },
  REJECTED: {
    label: t('step9.state.rejected', { defaultValue: 'Pedido cancelado' }),
    help: t('step9.help.rejected', { defaultValue: 'Puedes intentar de nuevo o saltar este paso.' }),
  },
  EXPIRED: {
    label: t('step9.state.rejected', { defaultValue: 'Pedido cancelado' }),
    help: t('step9.help.rejected', { defaultValue: 'Puedes intentar de nuevo o saltar este paso.' }),
  },
  CANCELED: {
    label: t('step9.state.rejected', { defaultValue: 'Pedido cancelado' }),
    help: t('step9.help.rejected', { defaultValue: 'Puedes intentar de nuevo o saltar este paso.' }),
  },
}
const stateMsg = STATE_MESSAGES[order.state] ?? STATE_MESSAGES.AWAITING_SPEI
const isTerminal = ['REJECTED', 'EXPIRED', 'CANCELED'].includes(order.state)

return (
  <div className="flex flex-col gap-8 max-w-2xl mx-auto">
    <header>
      <h1 className="text-2xl font-semibold sm:text-3xl">
        ✓ {t('step9.orderCreated', { defaultValue: 'Pedido' })} {order.orderNumber}
      </h1>
    </header>
    <Card className="p-6 flex flex-col gap-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">{t('step9.product', { defaultValue: 'Producto:' })}</span>
        <span>{order.items.map(i => `${i.quantity}× ${i.modelName}`).join(', ')}</span>
        <span className="text-muted-foreground">{t('step9.total', { defaultValue: 'Total:' })}</span>
        <span>${order.totalAmount.toLocaleString('es-MX')} MXN</span>
        <span className="text-muted-foreground">{t('step9.state.label', { defaultValue: 'Estado:' })}</span>
        <span>{stateMsg.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">{stateMsg.help}</p>
    </Card>
    <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t">
      {isTerminal && (
        <Button variant="outline" onClick={() => setWizardOpen(true)} className="rounded-full">
          {t('step9.retry', { defaultValue: 'Intentar de nuevo' })}
        </Button>
      )}
      <Button onClick={handleFinish} className="rounded-full sm:ml-auto">
        {t('step9.finish', { defaultValue: 'Terminar onboarding →' })}
      </Button>
    </div>
    <TerminalPurchaseWizard
      open={wizardOpen}
      onOpenChange={setWizardOpen}
      venueId={venueId}
      from="setup"
      onComplete={handleWizardComplete}
    />
  </div>
)
```

- [ ] **Step 11.4: Snapshot test**

Create `src/pages/Setup/steps/__tests__/BuyTpvStep.test.tsx`:

```tsx
import { render } from '@testing-library/react'
import { BuyTpvStep } from '../BuyTpvStep'
// Mock useQuery → no order
// Render → expect "Saltar por ahora" + "Ver catálogo y comprar" visible
// Mock useQuery → order with state AWAITING_SPEI
// Render → expect "Pedido AVO-..." + "Terminar onboarding" visible
// Mock useQuery → order with state REJECTED
// Render → expect "Intentar de nuevo" + "Terminar onboarding" both visible
```

Run via the existing component test runner. Three assertions, three states.

---

## Phase E — i18n (1 task)

### Task 12: Add `step9.*` keys

**Files:**

- Modify: `src/locales/es/setup.json`
- Modify: `src/locales/en/setup.json`

- [ ] **Step 12.1: Add keys to both files**

Mirror the existing `step8.*` block. Required keys (use the strings already chosen in Task 11 as `defaultValue`):

```
step9.title, step9.subtitle, step9.catalogHeading, step9.openWizard,
step9.skip, step9.orderCreated, step9.product, step9.total,
step9.state.label, step9.state.{awaitingSpei,speiReceived,paid,shipped,delivered,rejected},
step9.help.{awaitingSpei,speiReceived,paid,shipped,delivered,rejected},
step9.retry, step9.finish
```

- [ ] **Step 12.2: Verify ESLint i18n rule passes**

```bash
npm run lint
```

Expected: no `no-missing-translation-keys` errors for `step9.*`.

---

## Phase F — E2E tests (1 task)

### Task 13: Playwright E2E

**File:** Create `e2e/tests/onboarding/buy-tpv-step.spec.ts`

- [ ] **Step 13.1: Three scenarios**

```typescript
import { test, expect } from '@playwright/test'
import { setupApiMocks } from '../../fixtures/api-mocks'

test.describe('Onboarding · Step 9 — Buy TPV', () => {
  test('Skip path completes onboarding', async ({ page }) => {
    await setupApiMocks(page, { userRole: 'OWNER', onboardingStep: 9 })
    await page.goto('/setup#step-8')
    await page.getByText('Saltar por ahora').click()
    await expect(page).toHaveURL(/\/(home|venues)/)
  })

  test('SPEI happy path → View B → Terminar onboarding', async ({ page }) => {
    await setupApiMocks(page, { userRole: 'OWNER', onboardingStep: 9 })
    await page.goto('/setup#step-8')
    await page.getByText('Ver catálogo y comprar').click()
    // Mock the TerminalPurchaseWizard's API calls — see existing TPV e2e for the pattern
    // Click through to Step4 + select SPEI + confirm
    // Modal closes, View B appears
    await expect(page.getByText(/Pedido AVO-/)).toBeVisible()
    await page.getByText('Terminar onboarding').click()
    await expect(page).toHaveURL(/\/(home|venues)/)
  })

  test('Terminar onboarding works regardless of order state', async ({ page }) => {
    // For each state in [AWAITING_SPEI, PAID, SHIPPED, REJECTED], mock that state
    // and assert the "Terminar onboarding" button is enabled and completes flow
    for (const state of ['AWAITING_SPEI', 'PAID', 'SHIPPED', 'REJECTED']) {
      await setupApiMocks(page, { userRole: 'OWNER', onboardingStep: 9, tpvOrderState: state })
      await page.goto('/setup#step-8')
      const finishBtn = page.getByText('Terminar onboarding')
      await expect(finishBtn).toBeEnabled()
    }
  })
})
```

Run: `npm run test:e2e -- buy-tpv-step`. Expected: all three pass.

---

## Phase G — Pre-deploy verification (1 task)

### Task 14: Build, lint, test, manual sanity

- [ ] **Step 14.1: Backend pre-deploy**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npm run build && npm run lint && npm test -- --runInBand
```

Expected: all green.

- [ ] **Step 14.2: Frontend pre-deploy**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run build && npm run lint && npm run test:e2e
```

Expected: all green.

- [ ] **Step 14.3: Manual smoke (with flag on)**

In a local `.env`:

```bash
echo "ENABLE_ONBOARDING_TPV_PURCHASE=true" >> /Users/amieva/Documents/Programming/Avoqado/avoqado-server/.env
```

Restart backend. Then:

1. Sign up a new merchant.
2. Click through to Step 9.
3. Verify View A renders + skip works.
4. Restart, click "Ver catálogo y comprar".
5. Verify the existing wizard opens on top of the setup wizard.
6. Pick a model, fill shipping (test the Google Maps + manual mode added today), pick SPEI, confirm.
7. Verify modal closes, View B shows "Pedido AVO-... · Esperando comprobante SPEI".
8. Click "Terminar onboarding →". Verify you land at `/home` and the order is visible in `/tpv?tab=pedidos`.
9. Sign up a different merchant, repeat with Card. Verify the Stripe redirect lands back at `/setup#step-8` and View B renders.

- [ ] **Step 14.4: Manual smoke (with flag off)**

```bash
sed -i '' 's/ENABLE_ONBOARDING_TPV_PURCHASE=true/ENABLE_ONBOARDING_TPV_PURCHASE=false/' /Users/amieva/Documents/Programming/Avoqado/avoqado-server/.env
```

Restart. Sign up a new merchant. Verify the wizard ends at Step 8 (payment providers) as before — no Step 9 visible.

---

## Rollout

1. Land all backend changes (Tasks 1–6) behind the flag, deploy to staging.
2. Land all frontend changes (Tasks 7–13) behind the same flag, deploy to staging.
3. Manual QA on staging (Step 14.3 + 14.4).
4. Flip `ENABLE_ONBOARDING_TPV_PURCHASE=true` in staging env vars.
5. Repeat manual QA on staging with flag on.
6. Open PR to merge to `main`. Production starts with flag off.
7. After merge, flip flag in production env (Render `avoqado-server`).
8. Monitor for 48h. Rollback = flip flag off (no code rollback needed).

---

## Definition of Done

- [ ] All 14 tasks checked off
- [ ] Both repos: build + lint + tests green
- [ ] E2E spec covers skip, SPEI happy path, and "Terminar onboarding works in every order state"
- [ ] Manual QA passed with flag on AND with flag off
- [ ] Spec linked in PR description
- [ ] No regressions in existing onboarding (PaymentProvidersStep still works)
- [ ] PR reviewed and merged by Jose (per project policy)
- [ ] Feature flag flipped on in production
