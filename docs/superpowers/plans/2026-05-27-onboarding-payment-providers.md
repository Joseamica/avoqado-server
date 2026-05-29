# Onboarding Payment Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Step 8 to the V2 setup wizard that lets a new merchant connect Mercado Pago and/or Stripe Connect, with state preserved across OAuth round-trips and an optional test payment link delivered via WhatsApp.

**Architecture:** Extends the existing MP OAuth state JWT with a `returnTo` field so the callback can route back to the wizard instead of the legacy integrations page. Stripe Connect already accepts a dynamic `returnPath` — we wire it through from the wizard. V2 wizard state survives because `OnboardingProgress.v2SetupData.step8` is persisted before redirect. All new behavior gated on `ENABLE_ONBOARDING_PAYMENT_PROVIDERS` env flag.

**Tech Stack:**
- Backend: Express + TypeScript, Prisma, existing MP/Stripe providers, `whatsapp.service.ts`, `qrcode` (already installed)
- Frontend: React 18 + Vite, react-i18next, existing `setup.service.ts` API client
- Tests: Jest (`runInBand` to avoid OOM in this repo)
- Spec: `docs/superpowers/specs/2026-05-27-onboarding-payment-providers-design.md`

---

## File map

**Backend (`avoqado-server`)**

| File | Action | Responsibility |
|---|---|---|
| `src/services/mercado-pago/oauth.service.ts` | Modify | Add optional `returnTo` field to state schema |
| `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` | Modify | Accept `?from=wizard`, branch redirect on `state.returnTo` |
| `src/services/dashboard/stripeConnect.service.ts` | Modify (small) | Expose `returnPath` to callers (already accepts internally) |
| `src/services/onboarding/onboardingProgress.service.ts` | Modify | Add `V2Step8Data` typing + read helper for step8 |
| `src/controllers/onboarding.controller.ts` | Modify | Surface `paymentProviders` in `getV2SetupDataForCompletion` response |
| `src/services/onboarding/testPaymentLink.service.ts` | Create | Provider-agnostic facade: amount → checkout URL + QR + WhatsApp |
| `src/routes/onboarding.routes.ts` | Modify | `POST /onboarding/venues/:venueId/test-payment-link` |
| `src/config/featureFlags.ts` (or inline) | Modify | Expose `ENABLE_ONBOARDING_PAYMENT_PROVIDERS` |
| `tests/unit/services/mercado-pago/oauth.returnTo.test.ts` | Create | OAuth state round-trip with returnTo |
| `tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts` | Create | Callback branches on returnTo |
| `tests/unit/services/onboarding/testPaymentLink.service.test.ts` | Create | Service unit tests |

**Frontend (`avoqado-web-dashboard`)**

| File | Action | Responsibility |
|---|---|---|
| `src/pages/Setup/types.ts` | Modify | Add `paymentProviders` field to `SetupData` |
| `src/pages/Setup/SetupWizard.tsx` | Modify | Conditionally add PaymentProvidersStep, URL-param hydration |
| `src/pages/Setup/steps/PaymentProvidersStep.tsx` | Create | Views A / C / D + skip + OAuth initiation |
| `src/services/setup.service.ts` | Modify | Add `testPaymentLink` method |
| `src/locales/es/setup.json`, `src/locales/en/setup.json` | Modify | New i18n keys for step 8 |

---

## Pre-flight

- [ ] **Step 0.1: Read the spec end-to-end**

Path: `docs/superpowers/specs/2026-05-27-onboarding-payment-providers-design.md`

This plan assumes you've internalized the failure matrix, the OAuth state JWT mechanism, and the four-view state machine. If any of those are unclear, re-read the spec before starting Task 1.

- [ ] **Step 0.2: Create a feature branch**

```bash
git checkout -b feature/onboarding-payment-providers
git status
```

Expected: clean working tree, on the new branch.

- [ ] **Step 0.3: Verify the env flag is unset locally**

```bash
grep -i ENABLE_ONBOARDING_PAYMENT_PROVIDERS .env || echo "(unset — good)"
```

Expected: `(unset — good)`. We want all changes invisible until we explicitly flip the flag at the end.

---

## Phase A — MP OAuth state plumbing (4 tasks)

### Task 1: Add `returnTo` field to MP OAuth state schema

**Files:**
- Modify: `src/services/mercado-pago/oauth.service.ts`
- Modify: `src/services/mercado-pago/types.ts`
- Create: `tests/unit/services/mercado-pago/oauth.returnTo.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/services/mercado-pago/oauth.returnTo.test.ts`:

```typescript
import { signState, verifyState } from '../../../../src/services/mercado-pago/oauth.service'

describe('MP OAuth state — returnTo field', () => {
  beforeAll(() => {
    process.env.MP_OAUTH_STATE_SECRET = 'test-secret-min-32-chars-please-1234567890'
  })

  it('round-trips returnTo when set to "wizard"', () => {
    const token = signState({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
      returnTo: 'wizard',
    })
    const verified = verifyState(token)
    expect(verified.returnTo).toBe('wizard')
  })

  it('omits returnTo when not provided (back-compat)', () => {
    const token = signState({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
    })
    const verified = verifyState(token)
    expect(verified.returnTo).toBeUndefined()
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
npx jest tests/unit/services/mercado-pago/oauth.returnTo.test.ts --runInBand
```

Expected: FAIL with TypeScript error "Property 'returnTo' does not exist on type 'MercadoPagoOAuthState'".

- [ ] **Step 1.3: Add `returnTo` to the type**

Edit `src/services/mercado-pago/types.ts` — find `MercadoPagoOAuthState` interface and add:

```typescript
export interface MercadoPagoOAuthState {
  intent: 'connect_merchant'
  venueId: string
  ecommerceMerchantId: string
  staffId: string
  /**
   * When set to 'wizard', the OAuth callback redirects back to the V2 setup
   * wizard (#step-7) instead of the legacy /integrations/mercadopago page.
   * Optional — absence means legacy redirect behavior.
   */
  returnTo?: 'wizard'
}
```

(If the interface lives elsewhere — search via `grep -rn "MercadoPagoOAuthState" src/` — apply the same edit there. `signState` and `verifyState` should pick up the new field automatically since they cast to/from the same interface.)

- [ ] **Step 1.4: Run test to verify it passes**

```bash
npx jest tests/unit/services/mercado-pago/oauth.returnTo.test.ts --runInBand
```

Expected: PASS (2 tests).

- [ ] **Step 1.5: Commit**

```bash
git add src/services/mercado-pago/types.ts \
        tests/unit/services/mercado-pago/oauth.returnTo.test.ts
git commit -m "feat(mp-oauth): add optional returnTo field to state JWT"
```

---

### Task 2: Accept `?from=wizard` on `/oauth/connect` and propagate to state

**Files:**
- Modify: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` (the `initiate` function around line 30-60)
- Create: `tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts`:

```typescript
import type { Request, Response } from 'express'
import { initiate } from '../../../src/controllers/dashboard/mercadoPagoOAuth.controller'

jest.mock('../../../src/services/mercado-pago/oauth.service', () => ({
  __esModule: true,
  signState: jest.fn(() => 'fake-state-token'),
  buildAuthUrl: jest.fn(() => 'https://auth.mercadopago.com.mx/authorization?state=fake-state-token'),
}))
jest.mock('../../../src/services/mercado-pago/merchant-guard.service', () => ({
  __esModule: true,
  getMercadoPagoMerchant: jest.fn().mockResolvedValue({}),
}))
jest.mock('../../../src/lib/userVenueAccess', () => ({
  __esModule: true,
  userHasVenueAccess: jest.fn().mockResolvedValue(true),
}))

import * as oauthService from '../../../src/services/mercado-pago/oauth.service'

const mockReq = (overrides: Partial<Request> = {}): any => ({
  params: { venueId: 'venue-1', ecommerceMerchantId: 'merch-1' },
  query: {},
  authContext: { userId: 'staff-1' },
  ...overrides,
})
const mockRes = (): any => ({ redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() })

describe('MP OAuth initiate — from=wizard', () => {
  beforeEach(() => jest.clearAllMocks())

  it('passes returnTo:"wizard" to signState when ?from=wizard is present', async () => {
    await initiate(mockReq({ query: { from: 'wizard' } }), mockRes())
    expect(oauthService.signState).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: 'wizard' })
    )
  })

  it('omits returnTo when from query param is absent', async () => {
    await initiate(mockReq(), mockRes())
    const arg = (oauthService.signState as jest.Mock).mock.calls[0][0]
    expect(arg.returnTo).toBeUndefined()
  })
})
```

- [ ] **Step 2.2: Run test, verify failure**

```bash
npx jest tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts --runInBand
```

Expected: FAIL (`signState` is not called with `returnTo`).

- [ ] **Step 2.3: Implement in the controller**

In `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` — find the `signState` call inside `initiate` (around line 57). Change:

```typescript
// BEFORE
const state = oauthService.signState({
  intent: 'connect_merchant',
  ecommerceMerchantId,
  venueId,
  staffId,
})
```

to:

```typescript
// AFTER
const fromWizard = (req.query.from as string | undefined) === 'wizard'
const state = oauthService.signState({
  intent: 'connect_merchant',
  ecommerceMerchantId,
  venueId,
  staffId,
  ...(fromWizard ? { returnTo: 'wizard' as const } : {}),
})
```

- [ ] **Step 2.4: Run test, verify pass**

```bash
npx jest tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts --runInBand
```

Expected: PASS (2 tests).

- [ ] **Step 2.5: Commit**

```bash
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts \
        tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts
git commit -m "feat(mp-oauth): accept ?from=wizard on /connect and propagate to state"
```

---

### Task 3: Branch MP callback redirect on `state.returnTo === 'wizard'`

**Files:**
- Modify: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` (the `callback` function)
- Create: `tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts`:

```typescript
import { callback } from '../../../src/controllers/dashboard/mercadoPagoOAuth.controller'

jest.mock('../../../src/services/mercado-pago/oauth.service', () => ({
  __esModule: true,
  verifyState: jest.fn(),
  exchangeCodeForTokens: jest.fn().mockResolvedValue({ access_token: 't', refresh_token: 'r', expires_in: 3600, user_id: 1 }),
}))
jest.mock('../../../src/services/mercado-pago/connection.service', () => ({
  __esModule: true,
  persistTokens: jest.fn().mockResolvedValue({}),
}))
jest.mock('../../../src/services/mercado-pago/merchant-guard.service', () => ({
  __esModule: true,
  getMercadoPagoMerchant: jest.fn().mockResolvedValue({}),
}))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'foo' }) } },
}))

import * as oauthService from '../../../src/services/mercado-pago/oauth.service'

const mockRes = (): any => ({ redirect: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() })

describe('MP OAuth callback — returnTo routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.PUBLIC_DASHBOARD_URL = 'https://app.example.com'
  })

  it('redirects to /setup#step-7 when state.returnTo === "wizard"', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
      returnTo: 'wizard',
    })
    const res = mockRes()
    await callback({ query: { code: 'abc', state: 'xyz' } } as any, res)
    const redirected = (res.redirect as jest.Mock).mock.calls[0][0]
    expect(redirected).toContain('/setup#step-7')
    expect(redirected).toContain('mp_status=success')
    expect(redirected).toContain('merchantId=merch-1')
  })

  it('redirects to legacy /integrations/mercadopago when returnTo is absent', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
    })
    const res = mockRes()
    await callback({ query: { code: 'abc', state: 'xyz' } } as any, res)
    const redirected = (res.redirect as jest.Mock).mock.calls[0][0]
    expect(redirected).toContain('/integrations/mercadopago')
    expect(redirected).not.toContain('/setup')
  })
})
```

- [ ] **Step 3.2: Run test, verify failure**

```bash
npx jest tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts --runInBand
```

Expected: FAIL — both cases redirect to `/integrations/mercadopago`.

- [ ] **Step 3.3: Implement the branch**

In `src/controllers/dashboard/mercadoPagoOAuth.controller.ts:callback`, locate **every** `res.redirect(`${dashboardUrl}/integrations/mercadopago?...`)` call after `verifyState` succeeds (success path AND error paths that occur AFTER state was successfully verified). Replace them with a helper:

Add this helper near the top of the file (after imports):

```typescript
/**
 * Build the post-callback redirect URL. If the OAuth initiation was triggered
 * from the V2 setup wizard, return to the wizard at step 8 (hash #step-7,
 * since the hash is 1-indexed). Otherwise use the legacy integrations page.
 */
function buildCallbackRedirect(
  dashboardUrl: string,
  state: { returnTo?: 'wizard'; ecommerceMerchantId: string },
  params: Record<string, string>,
): string {
  const search = new URLSearchParams(params).toString()
  if (state.returnTo === 'wizard') {
    return `${dashboardUrl}/setup?${search}#step-7`
  }
  return `${dashboardUrl}/integrations/mercadopago?${search}`
}
```

Then replace the success redirect (find the line that does `res.redirect(`${dashboardUrl}/integrations/mercadopago?...`)` AFTER tokens are persisted):

```typescript
// BEFORE (success path, after persistTokens)
return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=success&merchantId=${merchantId}`)

// AFTER
return res.redirect(
  buildCallbackRedirect(dashboardUrl, statePayload, {
    mp_status: 'success',
    merchantId,
  }),
)
```

And the error-after-state-verified paths similarly — pass `statePayload` and use the helper. For error paths BEFORE state verification (e.g. invalid state JWT itself), leave the legacy redirect — there's no `state.returnTo` to read.

- [ ] **Step 3.4: Run test, verify pass**

```bash
npx jest tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts --runInBand
```

Expected: PASS (2 tests).

- [ ] **Step 3.5: Commit**

```bash
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts \
        tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts
git commit -m "feat(mp-oauth): route callback back to wizard when returnTo=wizard"
```

---

### Task 4: Expose `returnPath` flow-through for Stripe Connect

**Files:**
- Modify: `src/services/dashboard/stripeConnect.service.ts` (no real changes — already accepts `returnPath`)
- Verify only

- [ ] **Step 4.1: Verify `createStripeOnboardingLink` already accepts `returnPath`**

```bash
grep -n "returnPath" src/services/dashboard/stripeConnect.service.ts
```

Expected output (already in code, no change needed):

```
38:  returnPath?: string,
60:  return provider.createOnboardingLink(merchantWithBusinessType, returnPath)
```

- [ ] **Step 4.2: Sanity-check the provider honors `returnPath`**

```bash
grep -n "returnPath\|return_url\|refresh_url" src/services/payments/providers/stripe-connect.provider.ts
```

Expected: at least one reference to `returnPath` and one to `accountLinks.create` with `return_url`. If absent, add a minimal edit:

```typescript
// In the provider's createOnboardingLink method, when calling stripe.accountLinks.create:
return_url: returnPath ? `${baseUrl}${returnPath}` : `${baseUrl}/ecommerce-merchants?status=success&merchantId=${merchant.id}`,
refresh_url: returnPath ? `${baseUrl}${returnPath}` : `${baseUrl}/ecommerce-merchants?status=refresh&merchantId=${merchant.id}`,
```

(If the file's structure differs, follow the existing pattern. The point is: the caller MUST be able to pass `/setup?stripe_status=success&merchantId=X#step-7` as a returnPath.)

- [ ] **Step 4.3: No commit needed if nothing changed; otherwise commit**

```bash
git status
# if changes: git add ... && git commit -m "feat(stripe-connect): pipe returnPath through to accountLinks.create"
```

---

## Phase B — V2 step 8 schema (2 tasks)

### Task 5: Add `V2Step8Data` typing helper

**Files:**
- Modify: `src/services/onboarding/onboardingProgress.service.ts`
- Create: `tests/unit/services/onboarding/v2Step8.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `tests/unit/services/onboarding/v2Step8.test.ts`:

```typescript
import { parseV2Step8 } from '../../../../src/services/onboarding/onboardingProgress.service'

describe('V2 step 8 (payment providers)', () => {
  it('returns null when v2SetupData has no step8', () => {
    expect(parseV2Step8(null)).toBeNull()
    expect(parseV2Step8({ step2: { businessName: 'X' } })).toBeNull()
  })

  it('returns a typed object when step8 is present', () => {
    const result = parseV2Step8({
      step8: {
        mpMerchantId: 'mp-1',
        stripeMerchantId: null,
        skipped: false,
        lastUpdatedAt: '2026-05-27T12:00:00Z',
      },
    })
    expect(result).toEqual({
      mpMerchantId: 'mp-1',
      stripeMerchantId: null,
      skipped: false,
      lastUpdatedAt: '2026-05-27T12:00:00Z',
    })
  })

  it('defaults missing fields when step8 is partial', () => {
    const result = parseV2Step8({ step8: { mpMerchantId: 'mp-1' } })
    expect(result).toEqual({
      mpMerchantId: 'mp-1',
      stripeMerchantId: null,
      skipped: false,
      lastUpdatedAt: null,
    })
  })
})
```

- [ ] **Step 5.2: Run test, verify failure**

```bash
npx jest tests/unit/services/onboarding/v2Step8.test.ts --runInBand
```

Expected: FAIL — `parseV2Step8` is not exported.

- [ ] **Step 5.3: Add the type + helper**

In `src/services/onboarding/onboardingProgress.service.ts`, near the top after existing interfaces, add:

```typescript
export interface V2Step8Data {
  mpMerchantId: string | null
  stripeMerchantId: string | null
  skipped: boolean
  lastUpdatedAt: string | null
}

/**
 * Read the V2 wizard's step 8 (payment providers) sub-tree. Returns null
 * when step 8 has never been saved, so callers can short-circuit.
 */
export function parseV2Step8(v2SetupData: unknown): V2Step8Data | null {
  if (!v2SetupData || typeof v2SetupData !== 'object') return null
  const step8 = (v2SetupData as Record<string, any>).step8
  if (!step8 || typeof step8 !== 'object') return null
  return {
    mpMerchantId: typeof step8.mpMerchantId === 'string' ? step8.mpMerchantId : null,
    stripeMerchantId: typeof step8.stripeMerchantId === 'string' ? step8.stripeMerchantId : null,
    skipped: step8.skipped === true,
    lastUpdatedAt: typeof step8.lastUpdatedAt === 'string' ? step8.lastUpdatedAt : null,
  }
}
```

- [ ] **Step 5.4: Run test, verify pass**

```bash
npx jest tests/unit/services/onboarding/v2Step8.test.ts --runInBand
```

Expected: PASS (3 tests).

- [ ] **Step 5.5: Commit**

```bash
git add src/services/onboarding/onboardingProgress.service.ts \
        tests/unit/services/onboarding/v2Step8.test.ts
git commit -m "feat(onboarding): add V2Step8Data type and parseV2Step8 helper"
```

---

### Task 6: Surface `paymentProviders` in `/onboarding/status` response

**Files:**
- Modify: `src/controllers/onboarding.controller.ts` (the route that returns onboarding status)

- [ ] **Step 6.1: Find the status endpoint**

```bash
grep -n "v2SetupData\|onboarding/status\|getOnboardingStatus" src/controllers/onboarding.controller.ts | head -10
```

Identify the controller method that returns the wizard's progress. It already returns `v2SetupData` per Task 0 (line 215 surfaced this earlier).

- [ ] **Step 6.2: Add `paymentProviders` to the response**

In the response body of the status endpoint (where `v2SetupData` is currently emitted), add a sibling field `paymentProviders`:

```typescript
import { parseV2Step8 } from '../services/onboarding/onboardingProgress.service'

// inside the handler, after fetching progress:
const paymentProviders = parseV2Step8(progress.v2SetupData)

// in the response payload:
res.json({
  // ...existing fields...
  v2SetupData: progress.v2SetupData,
  paymentProviders, // V2Step8Data | null
})
```

- [ ] **Step 6.3: Manual sanity check**

Start the dev server, hit the endpoint, confirm `paymentProviders` is `null` for a fresh org:

```bash
# In one terminal:
npm run dev

# In another:
curl -s http://localhost:3000/api/v1/onboarding/status \
     -H "Authorization: Bearer $TOKEN" | jq .paymentProviders
```

Expected: `null` (no step 8 saved yet for a fresh org).

- [ ] **Step 6.4: Commit**

```bash
git add src/controllers/onboarding.controller.ts
git commit -m "feat(onboarding): expose paymentProviders in /onboarding/status"
```

---

## Phase C — Test payment link service & route (3 tasks)

### Task 7: Create `testPaymentLink.service.ts` (happy path, no WhatsApp yet)

**Files:**
- Create: `src/services/onboarding/testPaymentLink.service.ts`
- Create: `tests/unit/services/onboarding/testPaymentLink.service.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `tests/unit/services/onboarding/testPaymentLink.service.test.ts`:

```typescript
import * as service from '../../../../src/services/onboarding/testPaymentLink.service'

jest.mock('../../../../src/services/dashboard/paymentLink.service', () => ({
  __esModule: true,
  createPaymentLink: jest.fn().mockResolvedValue({
    id: 'link-1',
    url: 'https://book.example.com/pay/abc',
    shortUrl: 'https://av.io/abc',
  }),
}))

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'merch-1',
        provider: { code: 'MERCADO_PAGO' },
        onboardingStatus: 'COMPLETED',
      }),
    },
    venue: {
      findUnique: jest.fn().mockResolvedValue({ id: 'venue-1', phone: '+526648442154' }),
    },
  },
}))

describe('testPaymentLink.service — happy path', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns url and qrCodeUrl for a 50 MXN MP test link', async () => {
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 50,
      staffId: 'staff-1',
    })
    expect(result.url).toBe('https://book.example.com/pay/abc')
    expect(result.qrCodeUrl).toMatch(/^data:image\/(svg\+xml|png);base64,/)
  })

  it('rejects amounts outside 1-10000 MXN range', async () => {
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 0, staffId: 'staff-1' }),
    ).rejects.toThrow(/monto/i)
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 99999, staffId: 'staff-1' }),
    ).rejects.toThrow(/monto/i)
  })

  it('rejects when the venue has no merchant for the provider', async () => {
    const prisma = require('../../../../src/utils/prismaClient').default
    prisma.ecommerceMerchant.findFirst.mockResolvedValueOnce(null)
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 50, staffId: 'staff-1' }),
    ).rejects.toThrow(/no.*conectado|not.*connected/i)
  })
})
```

- [ ] **Step 7.2: Run test, verify failure**

```bash
npx jest tests/unit/services/onboarding/testPaymentLink.service.test.ts --runInBand
```

Expected: FAIL — module does not exist.

- [ ] **Step 7.3: Implement the service**

Create `src/services/onboarding/testPaymentLink.service.ts`:

```typescript
/**
 * Test Payment Link Service (onboarding step 8 sub-flow).
 *
 * Generates a real payment link via the merchant's connected provider so the
 * brand-new operator can immediately try a charge in their own device.
 *
 * Failure to deliver the WhatsApp notification is non-fatal — callers still
 * receive the URL and can show it on-screen.
 */
import QRCode from 'qrcode'
import prisma from '@/utils/prismaClient'
import { createPaymentLink as createPaymentLinkInDashboard } from '@/services/dashboard/paymentLink.service'
import logger from '@/config/logger'

export interface CreateTestPaymentLinkInput {
  venueId: string
  staffId: string
  providerCode: 'MERCADO_PAGO' | 'STRIPE'
  amount: number // MXN
}

export interface TestPaymentLinkResult {
  url: string
  shortUrl?: string
  qrCodeUrl: string // data: URL
}

const MIN_AMOUNT = 1
const MAX_AMOUNT = 10_000

export async function createTestPaymentLink(input: CreateTestPaymentLinkInput): Promise<TestPaymentLinkResult> {
  if (!Number.isInteger(input.amount) || input.amount < MIN_AMOUNT || input.amount > MAX_AMOUNT) {
    throw new Error(`Monto inválido: debe ser un entero entre ${MIN_AMOUNT} y ${MAX_AMOUNT} MXN`)
  }

  const merchant = await prisma.ecommerceMerchant.findFirst({
    where: {
      venueId: input.venueId,
      provider: { code: input.providerCode },
      onboardingStatus: 'COMPLETED',
    },
    include: { provider: { select: { code: true } } },
  })
  if (!merchant) {
    throw new Error(`No hay un canal ${input.providerCode} conectado para este venue`)
  }

  const link = await createPaymentLinkInDashboard(
    input.venueId,
    {
      name: 'Liga de prueba — onboarding',
      amountType: 'FIXED',
      amount: input.amount,
      currency: 'MXN',
      // The dashboard payment-link service will route to the right merchant
      // automatically based on venue + provider availability.
    } as any,
    input.staffId,
  )

  const qrCodeUrl = await QRCode.toDataURL(link.url, { type: 'image/png', errorCorrectionLevel: 'M', margin: 1, width: 256 })
  logger.info(`[onboarding-test-link] created for venue ${input.venueId} (${input.providerCode}, ${input.amount} MXN)`)
  return { url: link.url, shortUrl: (link as any).shortUrl, qrCodeUrl }
}
```

- [ ] **Step 7.4: Run test, verify pass**

```bash
npx jest tests/unit/services/onboarding/testPaymentLink.service.test.ts --runInBand
```

Expected: PASS (3 tests).

- [ ] **Step 7.5: Commit**

```bash
git add src/services/onboarding/testPaymentLink.service.ts \
        tests/unit/services/onboarding/testPaymentLink.service.test.ts
git commit -m "feat(onboarding): add testPaymentLink service (happy path + validation)"
```

---

### Task 8: Add WhatsApp delivery to the service

**Files:**
- Modify: `src/services/onboarding/testPaymentLink.service.ts`
- Modify: `tests/unit/services/onboarding/testPaymentLink.service.test.ts`

- [ ] **Step 8.1: Confirm WhatsApp service signature**

```bash
grep -n "export" src/services/whatsapp.service.ts | head -10
```

Note the exact function name (e.g. `sendWhatsAppMessage`, `sendMessage`, etc.). The test below uses `sendWhatsAppMessage` — adjust both implementation and test to match the actual name.

- [ ] **Step 8.2: Append new tests**

Add to `tests/unit/services/onboarding/testPaymentLink.service.test.ts`:

```typescript
jest.mock('../../../../src/services/whatsapp.service', () => ({
  __esModule: true,
  sendWhatsAppMessage: jest.fn().mockResolvedValue(true),
}))
import * as whatsappService from '../../../../src/services/whatsapp.service'

describe('testPaymentLink.service — WhatsApp delivery', () => {
  beforeEach(() => jest.clearAllMocks())

  it('sends a WhatsApp message to the venue phone and reports success', async () => {
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(true)
    expect(whatsappService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+526648442154' }),
    )
  })

  it('returns whatsappSent=false when the service rejects, without throwing', async () => {
    ;(whatsappService.sendWhatsAppMessage as jest.Mock).mockRejectedValueOnce(new Error('WA down'))
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(false)
    expect(result.url).toBeTruthy() // URL still delivered to caller
  })

  it('returns whatsappSent=false silently when venue has no phone on file', async () => {
    const prisma = require('../../../../src/utils/prismaClient').default
    prisma.venue.findUnique.mockResolvedValueOnce({ id: 'venue-1', phone: null })
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(false)
    expect(whatsappService.sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 8.3: Run test, verify failure**

```bash
npx jest tests/unit/services/onboarding/testPaymentLink.service.test.ts --runInBand
```

Expected: FAIL — `whatsappSent` doesn't exist on the result.

- [ ] **Step 8.4: Update the service**

Modify `src/services/onboarding/testPaymentLink.service.ts`:

```typescript
// Add import:
import { sendWhatsAppMessage } from '@/services/whatsapp.service'

// Extend interface:
export interface TestPaymentLinkResult {
  url: string
  shortUrl?: string
  qrCodeUrl: string
  whatsappSent: boolean
}

// At the end of createTestPaymentLink, before the return:
let whatsappSent = false
const venue = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { phone: true } })
if (venue?.phone) {
  try {
    await sendWhatsAppMessage({
      to: venue.phone,
      body: `Probando tu nueva cuenta de cobros en Avoqado. Liga de prueba: ${link.url}`,
    })
    whatsappSent = true
  } catch (err) {
    logger.warn(`[onboarding-test-link] WhatsApp delivery failed for venue ${input.venueId}: ${(err as Error).message}`)
  }
}

return { url: link.url, shortUrl: (link as any).shortUrl, qrCodeUrl, whatsappSent }
```

- [ ] **Step 8.5: Run test, verify pass**

```bash
npx jest tests/unit/services/onboarding/testPaymentLink.service.test.ts --runInBand
```

Expected: PASS (6 tests total — 3 from Task 7 + 3 new).

- [ ] **Step 8.6: Commit**

```bash
git add src/services/onboarding/testPaymentLink.service.ts \
        tests/unit/services/onboarding/testPaymentLink.service.test.ts
git commit -m "feat(onboarding): deliver test payment link via WhatsApp (non-blocking)"
```

---

### Task 9: Expose the route

**Files:**
- Modify: `src/routes/onboarding.routes.ts`
- Modify: `src/controllers/onboarding.controller.ts` (add the handler)

- [ ] **Step 9.1: Add the controller handler**

In `src/controllers/onboarding.controller.ts`, append:

```typescript
import * as testPaymentLinkService from '@/services/onboarding/testPaymentLink.service'

/**
 * POST /api/v1/onboarding/venues/:venueId/test-payment-link
 *
 * Generates a real payment link via the venue's connected MP or Stripe Connect
 * merchant so the owner can immediately try a charge from their phone.
 * Wizard-only — gated by `ENABLE_ONBOARDING_PAYMENT_PROVIDERS` at the route layer.
 */
export async function testPaymentLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    if (!authContext?.userId) throw new BadRequestError('No autenticado')

    const { amount, providerCode } = req.body
    if (!['MERCADO_PAGO', 'STRIPE'].includes(providerCode)) {
      throw new BadRequestError('providerCode debe ser MERCADO_PAGO o STRIPE')
    }

    const result = await testPaymentLinkService.createTestPaymentLink({
      venueId,
      staffId: authContext.userId,
      amount: Number(amount),
      providerCode,
    })
    res.status(200).json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}
```

- [ ] **Step 9.2: Wire the route**

In `src/routes/onboarding.routes.ts`, find the existing onboarding routes and add:

```typescript
import { testPaymentLink as testPaymentLinkController } from '@/controllers/onboarding.controller'

// Gate the route on the env flag at registration time. If the flag is off,
// the endpoint simply doesn't exist (404).
if (process.env.ENABLE_ONBOARDING_PAYMENT_PROVIDERS === 'true') {
  router.post(
    '/venues/:venueId/test-payment-link',
    authenticateTokenMiddleware,
    testPaymentLinkController,
  )
}
```

(Use the existing auth middleware name from the file — if it's `requireAuth` or `authenticate`, swap.)

- [ ] **Step 9.3: Smoke-test the wiring**

```bash
ENABLE_ONBOARDING_PAYMENT_PROVIDERS=true npm run dev
# In another terminal:
curl -X POST http://localhost:3000/api/v1/onboarding/venues/foo/test-payment-link \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"amount": 50, "providerCode": "MERCADO_PAGO"}' | jq .
```

Expected (if no MP merchant connected): `{ "success": false, "error": "No hay un canal MERCADO_PAGO conectado..." }`. If the flag is off, expect `404`.

- [ ] **Step 9.4: Commit**

```bash
git add src/controllers/onboarding.controller.ts src/routes/onboarding.routes.ts
git commit -m "feat(onboarding): expose POST /test-payment-link (env-gated)"
```

---

## Phase D — Feature flag plumbing (1 task)

### Task 10: Document the env flag

**Files:**
- Modify: `.env.example` (or equivalent)
- Modify: `docs/guides/PRODUCTION_READINESS_CHECKLIST.md` (optional, find the env section)

- [ ] **Step 10.1: Add to `.env.example`**

```bash
echo "" >> .env.example
echo "# When 'true', exposes the optional MP/Stripe Connect step at the end of" >> .env.example
echo "# the V2 setup wizard. Spec: docs/superpowers/specs/2026-05-27-onboarding-payment-providers-design.md" >> .env.example
echo "ENABLE_ONBOARDING_PAYMENT_PROVIDERS=false" >> .env.example
```

- [ ] **Step 10.2: Commit**

```bash
git add .env.example
git commit -m "chore: document ENABLE_ONBOARDING_PAYMENT_PROVIDERS flag"
```

---

## Phase E — Frontend types & service (2 tasks)

### Task 11: Extend `SetupData` type

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/pages/Setup/types.ts`

- [ ] **Step 11.1: Add the field**

In `src/pages/Setup/types.ts`, inside the `SetupData` interface (after the existing Step 7 bank fields), add:

```typescript
  // Step 8: Payment Providers (optional)
  paymentProviders?: {
    mpMerchantId?: string | null
    stripeMerchantId?: string | null
    skipped?: boolean
  }
```

- [ ] **Step 11.2: Verify it compiles**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 11.3: Commit**

```bash
git add src/pages/Setup/types.ts
git commit -m "feat(wizard): add paymentProviders field to SetupData"
```

---

### Task 12: Add `testPaymentLink` to the API client

**Files:**
- Modify: `src/services/setup.service.ts`

- [ ] **Step 12.1: Add the method**

In `src/services/setup.service.ts`, inside the `setupService` object:

```typescript
  /**
   * Generate a real test payment link via the venue's connected MP/Stripe merchant.
   * Wizard-only — backend route returns 404 when the env flag is off.
   */
  testPaymentLink: (venueId: string, body: { amount: number; providerCode: 'MERCADO_PAGO' | 'STRIPE' }) =>
    api.post(`/api/v1/onboarding/venues/${venueId}/test-payment-link`, body),
```

- [ ] **Step 12.2: TS check + commit**

```bash
npx tsc --noEmit && git add src/services/setup.service.ts && \
  git commit -m "feat(wizard): add testPaymentLink to setup.service client"
```

---

## Phase F — Frontend `PaymentProvidersStep` (4 tasks)

### Task 13: Scaffold the step component with View A

**Files:**
- Create: `src/pages/Setup/steps/PaymentProvidersStep.tsx`

- [ ] **Step 13.1: Create the component**

```typescript
/**
 * PaymentProvidersStep — V2 wizard Step 8 (optional).
 *
 * View A: empty (two tiles + skip link)
 * View C: at least one provider connected (rendered when paymentProviders has IDs)
 * View D: test payment link sub-flow (triggered from View C)
 *
 * State preservation across OAuth round-trip relies on:
 *   1. Pre-redirect saveStep(8, {mpConnecting: true}) so currentStep persists.
 *   2. SetupWizard hydrates this component from URL params on return.
 *
 * Spec: docs/superpowers/specs/2026-05-27-onboarding-payment-providers-design.md
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { setupService } from '@/services/setup.service'
import { ecommerceMerchantAPI } from '@/services/ecommerceMerchant.service'
import { useToast } from '@/hooks/use-toast'
import type { StepProps } from '../types'

const MP_INITIATE_PATH = '/api/v1/integrations/mercadopago/oauth/connect'

interface PaymentProvidersStepProps extends StepProps {
  venueId: string
  /** Pre-existing merchants resolved from the backend. */
  mpMerchantId?: string | null
  stripeMerchantId?: string | null
}

export function PaymentProvidersStep({ data, onNext, venueId, mpMerchantId, stripeMerchantId }: PaymentProvidersStepProps) {
  const { t } = useTranslation('setup')
  const { toast } = useToast()

  const mpConnected = Boolean(mpMerchantId ?? data.paymentProviders?.mpMerchantId)
  const stripeConnected = Boolean(stripeMerchantId ?? data.paymentProviders?.stripeMerchantId)
  const anyConnected = mpConnected || stripeConnected

  const handleConnectMP = async () => {
    // 1. Mark step 8 as in-progress BEFORE leaving so a tab close still resumes here.
    // 2. Reuse an existing MP merchant if there is one (paused mid-OAuth from a
    //    previous attempt). Otherwise create a new one in NOT_STARTED state.
    try {
      await setupService.saveStep((data as any).organizationId, 8, { mpConnecting: true })
      let merchantId = mpMerchantId
      if (!merchantId) {
        const created = await ecommerceMerchantAPI.create(venueId, {
          providerCode: 'MERCADO_PAGO',
          channelName: 'Web Principal',
          businessName: (data as any).businessName ?? '',
          contactEmail: (data as any).email ?? '',
          businessType: 'company',
          sandboxMode: false,
        } as any)
        merchantId = created.id
      }
      window.location.assign(
        `${MP_INITIATE_PATH}?venueId=${venueId}&ecommerceMerchantId=${merchantId}&from=wizard`,
      )
    } catch (err) {
      toast({ title: 'No pudimos preparar la conexión', description: String(err), variant: 'destructive' })
    }
  }

  const handleConnectStripe = async () => {
    // Stripe is two API calls: create merchant + create onboarding link.
    // The link includes return_url back to /setup#step-7 so the wizard resumes.
    try {
      await setupService.saveStep((data as any).organizationId, 8, { stripeConnecting: true })
      let merchantId = stripeMerchantId
      if (!merchantId) {
        const created = await ecommerceMerchantAPI.create(venueId, {
          providerCode: 'STRIPE_CONNECT',
          channelName: 'Stripe',
          businessName: (data as any).businessName ?? '',
          contactEmail: (data as any).email ?? '',
          businessType: 'company',
          sandboxMode: false,
        } as any)
        merchantId = created.id
      }
      const returnPath = `/setup?stripe_status=success&merchantId=${merchantId}#step-7`
      const { url } = await ecommerceMerchantAPI.createStripeOnboardingLink(venueId, merchantId, 'company', returnPath)
      window.location.assign(url)
    } catch (err) {
      toast({ title: 'No pudimos preparar la conexión', description: String(err), variant: 'destructive' })
    }
  }

  const handleSkip = () => onNext({ paymentProviders: { skipped: true } })
  const handleFinish = () => onNext({ paymentProviders: { mpMerchantId, stripeMerchantId, skipped: false } })

  return (
    <div className="flex flex-col gap-8 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold sm:text-3xl">
          {anyConnected
            ? t('step8.titleConnected', { defaultValue: '¡Una cuenta lista!' })
            : t('step8.title', { defaultValue: 'Activa cobros online (opcional)' })}
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          {t('step8.subtitle', { defaultValue: 'Conecta Mercado Pago o Stripe para recibir pagos por checkout y ligas de pago.' })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ProviderTile
          name="Mercado Pago"
          connected={mpConnected}
          onConnect={handleConnectMP}
          tConnected={t('step8.connected', { defaultValue: 'Conectado' })}
          tConnect={t('step8.connect', { defaultValue: 'Conectar' })}
        />
        <ProviderTile
          name="Stripe"
          connected={stripeConnected}
          onConnect={handleConnectStripe}
          tConnected={t('step8.connected', { defaultValue: 'Conectado' })}
          tConnect={t('step8.connect', { defaultValue: 'Conectar' })}
        />
      </div>

      {anyConnected ? (
        <div className="flex flex-col gap-3 pt-4 border-t">
          <p className="text-sm">
            {t('step8.tryItPrompt', { defaultValue: '¿Quieres probarlo con una liga de pago real?' })}
          </p>
          <div className="flex gap-3">
            <TestLinkLauncher venueId={venueId} provider={mpConnected ? 'MERCADO_PAGO' : 'STRIPE'} />
            <Button onClick={handleFinish} className="rounded-full">
              {t('step8.finish', { defaultValue: 'Terminar onboarding →' })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="pt-4 border-t">
          <button onClick={handleSkip} className="text-sm text-muted-foreground hover:underline">
            {t('step8.skip', { defaultValue: 'Saltar por ahora →' })}
          </button>
        </div>
      )}
    </div>
  )
}

function ProviderTile({
  name,
  connected,
  onConnect,
  tConnected,
  tConnect,
}: {
  name: string
  connected: boolean
  onConnect: () => void
  tConnected: string
  tConnect: string
}) {
  return (
    <Card className="p-6 flex flex-col gap-4">
      <h3 className="font-semibold text-lg">{name}</h3>
      {connected ? (
        <p className="text-sm text-emerald-600 font-medium">✓ {tConnected}</p>
      ) : (
        <Button onClick={onConnect} className="w-full rounded-full">
          {tConnect}
        </Button>
      )}
    </Card>
  )
}

// TestLinkLauncher implemented in Task 15 — for now, a button stub.
function TestLinkLauncher({ venueId: _vid, provider: _p }: { venueId: string; provider: 'MERCADO_PAGO' | 'STRIPE' }) {
  const { t } = useTranslation('setup')
  return (
    <Button variant="outline" className="rounded-full" disabled>
      {t('step8.generateTestLink', { defaultValue: 'Generar liga de prueba' })}
    </Button>
  )
}
```

- [ ] **Step 13.2: TS check**

```bash
npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 13.3: Commit**

```bash
git add src/pages/Setup/steps/PaymentProvidersStep.tsx
git commit -m "feat(wizard): scaffold PaymentProvidersStep with Views A and C"
```

---

### Task 14: Hook PaymentProvidersStep into `SETUP_STEPS` (env-gated)

**Files:**
- Modify: `src/pages/Setup/SetupWizard.tsx`

- [ ] **Step 14.1: Add the import and env flag check**

Near the top of `SetupWizard.tsx`:

```typescript
import { PaymentProvidersStep } from './steps/PaymentProvidersStep'

const PAYMENT_PROVIDERS_ENABLED = import.meta.env.VITE_ENABLE_ONBOARDING_PAYMENT_PROVIDERS === 'true'

const BASE_SETUP_STEPS = [
  { id: 'businessInfo', component: BusinessInfoStep },
  { id: 'businessType', component: BusinessTypeStep },
  { id: 'entityType', component: EntityTypeStep },
  { id: 'identity', component: IdentityStep },
  { id: 'terms', component: TermsStep },
  { id: 'bankAccount', component: BankAccountStep },
] as const

const SETUP_STEPS = PAYMENT_PROVIDERS_ENABLED
  ? ([...BASE_SETUP_STEPS, { id: 'paymentProviders', component: PaymentProvidersStep }] as const)
  : BASE_SETUP_STEPS
```

- [ ] **Step 14.2: Pass venue + merchant props to the step**

Find where `SETUP_STEPS[currentStep].component` is rendered. It's a generic component render — we need to special-case `paymentProviders` to pass extra props. Around the JSX where the step component is mounted:

```typescript
const StepComponent = SETUP_STEPS[currentStep].component as any
const stepId = SETUP_STEPS[currentStep].id

// ...

<StepComponent
  data={data}
  onNext={handleNext}
  onBack={handleBack}
  {...(stepId === 'paymentProviders' ? {
    venueId: (data as any).venueId,
    mpMerchantId: data.paymentProviders?.mpMerchantId,
    stripeMerchantId: data.paymentProviders?.stripeMerchantId,
  } : {})}
/>
```

(If there's no `venueId` in `data` yet because the wizard hasn't completed venue creation, the `paymentProviders` step is unreachable — it only renders post-bank-step, by which point the venue exists. Verify in Task 16 with manual QA.)

- [ ] **Step 14.3: TS check + commit**

```bash
npx tsc --noEmit
git add src/pages/Setup/SetupWizard.tsx
git commit -m "feat(wizard): conditionally mount PaymentProvidersStep behind env flag"
```

---

### Task 15: Build the test payment link sub-flow (View D)

**Files:**
- Modify: `src/pages/Setup/steps/PaymentProvidersStep.tsx`

- [ ] **Step 15.1: Replace the `TestLinkLauncher` stub**

Replace the stub `TestLinkLauncher` at the bottom of the file with:

```typescript
function TestLinkLauncher({ venueId, provider }: { venueId: string; provider: 'MERCADO_PAGO' | 'STRIPE' }) {
  const { t } = useTranslation('setup')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('100')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ url: string; qrCodeUrl: string; whatsappSent: boolean } | null>(null)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const { data } = await setupService.testPaymentLink(venueId, {
        amount: Number(amount),
        providerCode: provider,
      })
      setResult({ url: data.url, qrCodeUrl: data.qrCodeUrl, whatsappSent: data.whatsappSent })
      if (!data.whatsappSent) {
        toast({
          title: t('step8.waFailed', { defaultValue: 'No pudimos enviar por WhatsApp.' }),
          description: t('step8.waFallback', { defaultValue: 'La liga sigue disponible aquí.' }),
        })
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err?.response?.data?.error || String(err), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button variant="outline" className="rounded-full" onClick={() => setOpen(true)}>
        {t('step8.generateTestLink', { defaultValue: 'Generar liga de prueba' })}
      </Button>
    )
  }

  if (result) {
    return (
      <Card className="p-4 flex flex-col gap-3 w-full">
        {result.whatsappSent && (
          <p className="text-sm text-emerald-600">
            ✓ {t('step8.waSent', { defaultValue: 'Liga enviada por WhatsApp' })}
          </p>
        )}
        <p className="text-xs text-muted-foreground break-all">{result.url}</p>
        <img src={result.qrCodeUrl} alt="QR" className="w-32 h-32" />
        <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(result.url)}>
          {t('step8.copy', { defaultValue: 'Copiar liga' })}
        </Button>
      </Card>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm">{t('step8.amountLabel', { defaultValue: '$' })}</span>
      <input
        type="number"
        min={1}
        max={10000}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-24 px-3 py-2 rounded-md border text-sm"
      />
      <span className="text-sm">MXN</span>
      <Button size="sm" onClick={handleSubmit} disabled={submitting} className="rounded-full">
        {submitting
          ? t('step8.sending', { defaultValue: 'Generando…' })
          : t('step8.send', { defaultValue: 'Enviar' })}
      </Button>
    </div>
  )
}
```

- [ ] **Step 15.2: TS check + commit**

```bash
npx tsc --noEmit
git add src/pages/Setup/steps/PaymentProvidersStep.tsx
git commit -m "feat(wizard): implement test payment link sub-flow (View D)"
```

---

### Task 16: Hydrate Step 8 from URL params + DB on wizard return

**Files:**
- Modify: `src/pages/Setup/SetupWizard.tsx`

- [ ] **Step 16.1: Add URL param parsing on mount**

In the `useEffect` that runs on initial mount (where progressData is loaded), add at the end:

```typescript
// OAuth round-trip hydration. The MP callback sends users back to
// /setup?mp_status=success&merchantId=X#step-7, and Stripe Connect uses the
// same pattern with stripe_status. We jump straight to step 8 and seed the
// merchant ID into the wizard state so the right tile renders green.
const url = new URL(window.location.href)
const mpStatus = url.searchParams.get('mp_status')
const mpMerchantId = url.searchParams.get('merchantId')
const stripeStatus = url.searchParams.get('stripe_status')

if (PAYMENT_PROVIDERS_ENABLED && (mpStatus === 'success' || stripeStatus === 'success')) {
  // Force step 8 (last visible step).
  const step8Index = SETUP_STEPS.length - 1
  setCurrentStep(step8Index)
  setData((prev) => ({
    ...prev,
    paymentProviders: {
      ...(prev.paymentProviders ?? {}),
      ...(mpStatus === 'success' && mpMerchantId ? { mpMerchantId } : {}),
      ...(stripeStatus === 'success' && mpMerchantId ? { stripeMerchantId: mpMerchantId } : {}),
    },
  }))
  // Clean the URL so a refresh doesn't loop.
  url.search = ''
  window.history.replaceState(null, '', `${url.pathname}#step-${step8Index + 1}`)
}
```

- [ ] **Step 16.2: Also hydrate from `paymentProviders` if backend already has it**

In the same `useEffect`, right after `setData((prev) => ({ ...prev, ...restored }))`:

```typescript
const persistedProviders = progressData?.paymentProviders ?? null
if (persistedProviders) {
  setData((prev) => ({ ...prev, paymentProviders: persistedProviders }))
}
```

- [ ] **Step 16.3: TS check + commit**

```bash
npx tsc --noEmit
git add src/pages/Setup/SetupWizard.tsx
git commit -m "feat(wizard): hydrate Step 8 from URL params and persisted state"
```

---

## Phase G — i18n & final verification (3 tasks)

### Task 17: Add i18n keys (es + en)

**Files:**
- Modify: `src/locales/es/setup.json`
- Modify: `src/locales/en/setup.json`

- [ ] **Step 17.1: Add ES keys**

Inside the top-level object in `src/locales/es/setup.json`, add a `step8` block (mirror the existing pattern of step2…step7):

```json
"step8": {
  "title": "Activa cobros online (opcional)",
  "titleConnected": "¡Una cuenta lista!",
  "subtitle": "Conecta Mercado Pago o Stripe para recibir pagos por checkout y ligas de pago.",
  "connect": "Conectar",
  "connected": "Conectado",
  "skip": "Saltar por ahora →",
  "finish": "Terminar onboarding →",
  "tryItPrompt": "¿Quieres probarlo con una liga de pago real?",
  "generateTestLink": "Generar liga de prueba",
  "amountLabel": "$",
  "send": "Enviar",
  "sending": "Generando…",
  "copy": "Copiar liga",
  "waSent": "Liga enviada por WhatsApp",
  "waFailed": "No pudimos enviar por WhatsApp.",
  "waFallback": "La liga sigue disponible aquí.",
  "stripe": { "todo": "Conexión Stripe en breve" }
}
```

- [ ] **Step 17.2: Add EN keys**

Mirror the same structure in `src/locales/en/setup.json`:

```json
"step8": {
  "title": "Activate online payments (optional)",
  "titleConnected": "One account ready!",
  "subtitle": "Connect Mercado Pago or Stripe to accept checkout and payment-link payments.",
  "connect": "Connect",
  "connected": "Connected",
  "skip": "Skip for now →",
  "finish": "Finish onboarding →",
  "tryItPrompt": "Want to try a real payment link?",
  "generateTestLink": "Generate test link",
  "amountLabel": "$",
  "send": "Send",
  "sending": "Generating…",
  "copy": "Copy link",
  "waSent": "Link sent via WhatsApp",
  "waFailed": "Couldn't send via WhatsApp.",
  "waFallback": "The link is still available here.",
  "stripe": { "todo": "Stripe connection coming soon" }
}
```

- [ ] **Step 17.3: Validate JSON + commit**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/locales/es/setup.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/en/setup.json','utf8')); console.log('JSON valid')"
git add src/locales/es/setup.json src/locales/en/setup.json
git commit -m "feat(wizard): add step 8 i18n keys (es + en)"
```

---

### Task 18: Verify the full suite passes

**Files:** none

- [ ] **Step 18.1: Backend tests**

From `avoqado-server`:

```bash
npx jest tests/unit/services/mercado-pago/oauth.returnTo.test.ts \
         tests/unit/controllers/mercadoPagoOAuth.initiate.fromWizard.test.ts \
         tests/unit/controllers/mercadoPagoOAuth.callback.returnTo.test.ts \
         tests/unit/services/onboarding/v2Step8.test.ts \
         tests/unit/services/onboarding/testPaymentLink.service.test.ts \
         --runInBand
```

Expected: all PASS.

- [ ] **Step 18.2: Frontend TS check**

From `avoqado-web-dashboard`:

```bash
npx tsc --noEmit
```

Expected: clean (no output).

- [ ] **Step 18.3: Lint both repos**

```bash
# avoqado-server:
npx prettier --write src/services/mercado-pago/oauth.service.ts \
                     src/services/mercado-pago/types.ts \
                     src/controllers/dashboard/mercadoPagoOAuth.controller.ts \
                     src/services/onboarding/onboardingProgress.service.ts \
                     src/services/onboarding/testPaymentLink.service.ts \
                     src/controllers/onboarding.controller.ts \
                     src/routes/onboarding.routes.ts
npx eslint src/services/onboarding/testPaymentLink.service.ts

# avoqado-web-dashboard:
cd ../avoqado-web-dashboard
npx prettier --write src/pages/Setup/SetupWizard.tsx \
                     src/pages/Setup/steps/PaymentProvidersStep.tsx \
                     src/pages/Setup/types.ts \
                     src/services/setup.service.ts \
                     src/locales/es/setup.json \
                     src/locales/en/setup.json
```

Expected: no errors.

---

### Task 19: Manual QA against local dev

**Files:** none — manual verification

- [ ] **Step 19.1: Enable the flag locally**

```bash
# avoqado-server/.env
echo "ENABLE_ONBOARDING_PAYMENT_PROVIDERS=true" >> /Users/amieva/Documents/Programming/Avoqado/avoqado-server/.env
# avoqado-web-dashboard/.env.local
echo "VITE_ENABLE_ONBOARDING_PAYMENT_PROVIDERS=true" >> /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/.env.local
```

Restart both dev servers (tsx watch + vite pick up env on restart).

- [ ] **Step 19.2: Walk a brand-new signup through Step 8**

1. New email + password at `/signup`.
2. Complete steps 2–7 of the wizard (use placeholder data, no-physical-address checkbox at step 2).
3. At Step 7 → "Complete setup" → wizard now shows Step 8 of 8 instead of redirecting to /home.
4. Click "Conectar" on the Mercado Pago tile. Verify the browser navigates to `/api/v1/integrations/mercadopago/oauth/connect?...&from=wizard`.
5. Approve at MP (or use a sandbox account). Verify the redirect lands on `/setup?mp_status=success&merchantId=...#step-7`.
6. Confirm the MP tile is green and View C is shown.
7. Click "Generar liga de prueba", enter 50 MXN, click Enviar. Confirm a payment link + QR appear and WhatsApp arrives on the venue phone.
8. Click "Terminar onboarding →". Verify redirect to `/venues/{slug}/home`.

- [ ] **Step 19.3: Test the skip path**

1. New signup. At Step 8, click "Saltar por ahora →".
2. Verify the wizard exits to `/home` without creating any merchant rows.

- [ ] **Step 19.4: Test the tab-close recovery**

1. New signup, reach Step 8.
2. Click Connect MP, get to the MP authorize page.
3. **Close the browser tab.**
4. Open a new tab, navigate to `/setup`. Verify it resumes at Step 8 (or View C if you already completed OAuth in step 2).

- [ ] **Step 19.5: Document any deviations**

If anything didn't behave as the spec describes, write the deviation as a follow-up issue (don't fix inline — that's another PR). Otherwise: ✅ ready to enable in production.

---

### Task 20: Final commit & PR-ready

**Files:** none

- [ ] **Step 20.1: Verify the branch is clean**

```bash
git status
git log --oneline feature/onboarding-payment-providers ^main | head -25
```

Expected: clean working tree, ~15-18 commits on the branch.

- [ ] **Step 20.2: Push the branch**

```bash
git push -u origin feature/onboarding-payment-providers
```

- [ ] **Step 20.3: Hand off**

Open a PR with the spec linked in the description. Verify CI green. Tag whoever reviews the onboarding flow.

---

## Out-of-scope follow-ups (do not include in this PR)

These are tracked in the spec but explicitly deferred:

1. Persistent `/home` banner for users who skipped Step 8.
2. Provider auto-suggest based on business type.
3. Auto-refund of the 1 MXN test charge.
4. Multi-channel Stripe Connect (multiple merchants per venue).

---

## Implementation tips

- **Run jest with `--runInBand`** in this repo — the full suite OOMs otherwise (documented in project memory `p1001-cron-stampede.md` and elsewhere).
- **Don't commit the env flag flipped to `true`** until manual QA passes in Task 19. The plan's intermediate commits should leave the flag `false`.
- **OAuth state JWT TTL is 10 minutes.** If you spend longer than that testing manually, expect `reason=expired` and re-initiate.
- The MP marketplace **sandbox is known broken** (project memory `mercadopago-marketplace-status.md`). Manual QA uses a real or pre-approved test seller account.
