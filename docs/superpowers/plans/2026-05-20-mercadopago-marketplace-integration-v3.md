# Mercado Pago Marketplace (Split Payments via Bricks) Implementation Plan — v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes:**

- `docs/superpowers/plans/2026-05-19-mercadopago-marketplace-integration.md` (v1 — original, had Codex-flagged bugs)
- `docs/superpowers/plans/2026-05-20-mercadopago-marketplace-integration-v2.md` (v2 — Codex fixes applied, but still used Checkout Pro)

**Goal:** Add Mercado Pago as a third e-commerce payment provider alongside Stripe Connect and Blumon. Sellers (venues) authorize Avoqado
via OAuth and keep their negotiated rates. Avoqado collects a configurable `application_fee`. Use **Checkout Bricks** (not Checkout Pro) so
the customer stays on `pay.avoqado.io` throughout — matching the existing Stripe Elements pattern in `avoqado-checkout`.

**Architecture:** Mirror the existing `IEcommerceProvider` abstraction. Each connected merchant is an `EcommerceMerchant` row with
`providerId → PaymentProvider(code='MERCADO_PAGO')`. Seller OAuth tokens AES-256-GCM encrypted at rest (generalized
`src/lib/token-encryption.ts` helper, reusable across integrations). OAuth state is JWT-signed using existing `OAUTH_STATE_SECRET`. The MP
Bricks frontend (`@mercadopago/sdk-react`) renders inline payment fields; the backend creates payments via `/v1/payments` with
`application_fee`. Webhooks are signed and dedupe-persisted.

**Tech Stack:**

- Backend: Node.js 20+, Express 4.x, TypeScript, Prisma 5.x, PostgreSQL
- New backend dep: `mercadopago@^2.x` (official SDK) for `/v1/payments`, `/v1/payments/:id`, `/v1/payments/:id/refunds`. Raw axios for
  `/oauth/token` (SDK lacks OAuth helpers).
- New frontend dep (in `avoqado-checkout`): `@mercadopago/sdk-react@^1` for the Brick component
- Crypto: `node:crypto` (AES-256-GCM), `jsonwebtoken` (HS256 state)
- Test: Jest 29 + `nock` for HTTP mocking
- Region: `MLM` (Mexico), currency `MXN`

---

## Changes from v2 (Pro → Bricks pivot)

| Change                           | v2 (Pro)                            | v3 (Bricks)                                                                                         |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Customer redirected to MP page?  | Yes — `mercadopago.com.mx/checkout` | **No** — stays on `pay.avoqado.io`                                                                  |
| Backend endpoint MP API          | `POST /checkout/preferences`        | `POST /v1/payments`                                                                                 |
| Platform fee parameter           | `marketplace_fee`                   | `application_fee`                                                                                   |
| Customer payment UX              | MP-hosted page                      | Inline Brick iframe (like Stripe Elements)                                                          |
| Avoqado frontend touches         | None                                | New `MercadoPagoBrickForm.tsx`                                                                      |
| PCI scope                        | None (full hosted)                  | Same as existing Stripe Elements (SAQ-A) — cards stay in MP iframe, never touch our server          |
| OAuth callback URL               | Venue-scoped path                   | **Global** path (`/api/v1/integrations/mercadopago/oauth/callback`), extract venueId from JWT state |
| Mirrors existing Avoqado pattern | Stripe Connect Checkout (redirect)  | Stripe Elements (inline) ✅ matches `avoqado-checkout/StripeElementsForm.tsx`                       |

All Codex fixes from v2 are preserved (money adapter, tenant guard, webhook dedupe, advisory lock on token refresh, MERGE
providerCredentials, generalized encryption helper, removed dead csrfNonce, etc.).

---

## Pre-Plan Architectural Decisions (locked-in v3)

The implementing agent must NOT re-litigate these. They were resolved through plan-eng-review + /codex review + verification against actual
codebase.

| Decision                           | Choice                                                                                                      | Why                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer UX                        | **Bricks inline** (`@mercadopago/sdk-react` Brick on `pay.avoqado.io`)                                      | Matches existing Stripe Elements pattern in `avoqado-checkout`. Customer never leaves Avoqado domain.                                                                       |
| Backend API endpoint               | `POST /v1/payments` (NOT `/checkout/preferences`)                                                           | Bricks tokenizes on frontend, backend creates the payment with token.                                                                                                       |
| Platform fee field                 | `application_fee` in `/v1/payments` body                                                                    | Correct field for Bricks/Checkout-API flow per MP docs.                                                                                                                     |
| Money unit at provider boundary    | **Centavos** (Stripe convention, unchanged from v2) — MP provider divides by 100 internally                 | All existing callers (`paymentLink.service.ts:1766`, `reservation.consumer.service.ts:113`) convert via `toStripeAmount` before calling provider. Don't break the contract. |
| OAuth callback shape               | **Global path** `/api/v1/integrations/mercadopago/oauth/callback`                                           | MP doesn't accept dynamic placeholders. Extract `venueId`+`merchantId` from JWT state.                                                                                      |
| Token storage                      | `EcommerceMerchant.providerCredentials` JSON, base64-encoded encrypted bytes, MERGE not overwrite           | Matches Stripe Connect pattern (`stripe-connect.provider.ts:481`).                                                                                                          |
| New CheckoutSession columns        | `mpPreferenceId` (optional, unused in Bricks-direct flow), `mpPaymentId` (set via IPN), `mpMerchantOrderId` | Bricks flow doesn't need preferenceId in v1, but reserve column for future flexibility.                                                                                     |
| Webhook dedupe                     | New `MercadoPagoWebhookEvent` table with unique `(mpUserId, dataId, requestId)`                             | Prevents double-processing on retries.                                                                                                                                      |
| Encryption helper                  | Generalize Google Calendar's into `src/lib/token-encryption.ts(envKeyName)`                                 | Layer 1 reuse (per gstack ETHOS).                                                                                                                                           |
| MP_CLIENT_SECRET source            | **MP DevPanel → Credenciales de producción** (yes, "de producción" — applies to test+prod)                  | Documented quirk: MP doesn't show client_secret in test credentials; one secret per app spans both envs.                                                                    |
| Token refresh concurrency          | PostgreSQL `pg_advisory_xact_lock(hashtextextended(venueId))`                                               | Cron + on-demand refresh both acquire the lock.                                                                                                                             |
| Webhook signature manifest         | `id:<lowercased data.id from QUERY param>;request-id:<requestId>;ts:<ts>;`                                  | Per MP docs: data.id from URL query, not body.                                                                                                                              |
| Webhook replay tolerance           | 300 seconds (5 min)                                                                                         | MP-recommended window.                                                                                                                                                      |
| Bricks scope (v1)                  | Card brick only (payment_brick mode)                                                                        | Supports tarjeta + OXXO + SPEI + MP Wallet via single component.                                                                                                            |
| 3DS                                | Auto-handled by Bricks modal                                                                                | No custom flow needed; matches Stripe Elements behavior.                                                                                                                    |
| Frontend dashboard "Connect MP" UI | OUT OF SCOPE for v3 backend; covered in Phase 10 stub                                                       | Separate plan for the dashboard UI (icon, button, status badge).                                                                                                            |
| Reservation deposits               | **NOT** supported in v1 — stays Stripe-only                                                                 | `reservation.consumer.service.ts:44-60` hardcodes STRIPE_CONNECT. Generalizing is a follow-up.                                                                              |

---

## File Structure

### Backend files to create

| Path                                                                     | Responsibility                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `src/lib/token-encryption.ts`                                            | Generalized AES-256-GCM helper, parametrized by env key name. Returns `{encrypt, decrypt, encryptToBase64, decryptFromBase64}`. |
| `src/services/mercado-pago/types.ts`                                     | `MercadoPagoCredentials` envelope (with `keyVersion`), OAuth state, token response, webhook payload.                            |
| `src/services/mercado-pago/oauth.service.ts`                             | Pure helpers: `signState`, `verifyState`, `buildAuthUrl`, `exchangeCodeForTokens`, `refreshAccessToken` (raw axios).            |
| `src/services/mercado-pago/connection.service.ts`                        | `persistTokens` (MERGE), `loadCredentials`, `clearCredentials`, `refreshIfExpiring` (advisory lock).                            |
| `src/services/mercado-pago/payment.service.ts`                           | Wraps MP SDK's `Payment.create` with `application_fee`, `getPayment`, `refundPayment`. Money adapter (centavos→MXN).            |
| `src/services/mercado-pago/webhook.service.ts`                           | HMAC signature verification (query data.id lowercased, 5-min replay window).                                                    |
| `src/services/mercado-pago/payment-flow.service.ts`                      | IPN handler: dedupe via `MercadoPagoWebhookEvent` → fetch payment → find session by `external_reference` → update DB.           |
| `src/services/mercado-pago/merchant-guard.service.ts`                    | `getMercadoPagoMerchant(venueId, merchantId)` — tenant + provider-code guard.                                                   |
| `src/services/payments/providers/mercado-pago.provider.ts`               | Implements `IEcommerceProvider`.                                                                                                |
| `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`               | `initiate`, `callback`, `disconnect` — all through tenant guard.                                                                |
| `src/controllers/public/mercadoPagoPaymentIntent.controller.ts`          | Public endpoint `POST /payment-links/:shortCode/mp-payment-intent` — returns `{publicKey, preferenceId                          | null, mpUserId}` for frontend Brick. |
| `src/controllers/webhook/mercadoPago.webhook.controller.ts`              | Verify signature → call payment-flow service.                                                                                   |
| `src/routes/dashboard/mercadoPagoOAuth.routes.ts`                        | Express router for OAuth endpoints (global callback path).                                                                      |
| `src/routes/public/mercadoPagoPaymentIntent.routes.ts`                   | Public route for the brick initialization endpoint.                                                                             |
| `src/schemas/dashboard/mercadoPagoOAuth.schema.ts`                       | Zod schemas (Spanish messages).                                                                                                 |
| `src/schemas/public/mercadoPagoPaymentIntent.schema.ts`                  | Zod schema for frontend init request.                                                                                           |
| `src/jobs/mercadopago-token-refresh.job.ts`                              | Daily cron (3 AM Mexico City).                                                                                                  |
| `prisma/migrations/<ts>_seed_mercado_pago_provider/migration.sql`        | INSERT `PaymentProvider(code='MERCADO_PAGO')`.                                                                                  |
| `prisma/migrations/<ts>_add_mp_fields_to_checkout_session/migration.sql` | ALTER CheckoutSession ADD `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId`.                                                 |
| `prisma/migrations/<ts>_add_mercadopago_webhook_event/migration.sql`     | CREATE MercadoPagoWebhookEvent table.                                                                                           |
| All corresponding test files                                             | 18 test files total covering services, controllers, jobs, helpers.                                                              |

### Frontend files to create (in `avoqado-checkout`)

| Path                                      | Responsibility                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/components/MercadoPagoBrickForm.tsx` | Equivalent of `StripeElementsForm.tsx` but using `@mercadopago/sdk-react` Payment Brick. |
| `src/lib/api.ts`                          | Add `createMercadoPagoPaymentIntent(shortCode, args)` function.                          |

### Backend files to modify

| Path                                                    | Change                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                  | Add MP fields to `CheckoutSession`. Add `MercadoPagoWebhookEvent` model.                                                                          |
| `src/services/google-calendar/encryption.service.ts`    | Refactor to re-export from new generalized helper.                                                                                                |
| `src/services/payments/provider-registry.ts`            | Add `case 'MERCADO_PAGO': return new MercadoPagoProvider()`.                                                                                      |
| `src/services/payments/providers/provider.interface.ts` | JSDoc on `CreateCheckoutParams.amount` and `applicationFeeAmount`: "minor units (centavos for MXN). Provider converts at API boundary if needed." |
| `src/services/dashboard/paymentLink.service.ts`         | Lines 874, 967, 1717: change `=== 'STRIPE_CONNECT'` to `in HOSTED_PROVIDER_CODES`. Update payment provider literal at lines 1102, 1839.           |
| `src/app.ts`                                            | Mount `/api/v1/webhooks/mercadopago` with `express.raw()` BEFORE `express.json()`.                                                                |
| Central dashboard router                                | Mount OAuth routes at `/dashboard/integrations/mercadopago/oauth`.                                                                                |
| Public router                                           | Mount payment-intent endpoint.                                                                                                                    |
| `src/config/env.ts` (or equivalent)                     | Add MP env var validation.                                                                                                                        |
| `tests/__helpers__/setup.ts`                            | Set MP env vars + token key.                                                                                                                      |
| `.env.example`                                          | Document MP variables (already done manually).                                                                                                    |
| `package.json`                                          | Add `mercadopago@^2.x`.                                                                                                                           |

### Frontend files to modify (in `avoqado-checkout`)

| Path                              | Change                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                    | Add `@mercadopago/sdk-react@^1`.                                                                                                   |
| `src/components/CheckoutPage.tsx` | Router by `paymentLink.ecommerceMerchant.provider.code`: STRIPE_CONNECT → StripeElementsForm, MERCADO_PAGO → MercadoPagoBrickForm. |

### Files explicitly NOT modified (out of v3 scope)

- `src/services/consumer/reservation.consumer.service.ts` — reservation deposits stay Stripe-only
- `src/services/dashboard/reservation.dashboard.service.ts` — refund path same
- `src/services/sdk/checkout-session.service.ts` — Blumon inline-card flow, not MP territory
- Dashboard UI for "Connect Mercado Pago" button (separate plan)

---

## Operator's Quick-Start (manual prerequisites already complete)

Per the manual setup completed today:

- ✅ MP app `Avoqado Marketplace MX` created (ID `2551292920123796`)
- ✅ 3 test users created (Seller / Marketplace / Buyer)
- ✅ `.env` populated with all MP credentials including `MP_CLIENT_SECRET=ZbGZTzyA6WXwKgwZH1sQ1qkml3Fk8aGo`
- ✅ ngrok stable URL: `https://patchiest-noncommemorational-willia.ngrok-free.dev`
- ✅ OAuth redirect URL registered in MP DevPanel
- ✅ Webhook URL registered in MP DevPanel with secret `d02c2253...`

This plan picks up from a freshly-populated `.env` — Task 1 (env vars) only validates the schema, doesn't add new values.

---

## Phase 0 — Foundation

### Task 1: Validate env var Zod schema

**Files:** Modify the existing Zod env schema file (locate via `grep -rln "STRIPE_SECRET_KEY" src/config/`).

- [ ] **Step 1:** Locate the env validation file.

Run: `grep -rln "STRIPE_SECRET_KEY" src/config/ src/ | head -3` → call it `<env-file>`.

- [ ] **Step 2:** Add MP env var Zod fields.

Add to the Zod schema in `<env-file>`:

```typescript
MP_CLIENT_ID: z.string().min(1, 'MP_CLIENT_ID es requerido').optional(),
MP_CLIENT_SECRET: z.string().min(1, 'MP_CLIENT_SECRET es requerido').optional(),
MP_REDIRECT_URI: z.string().url('MP_REDIRECT_URI debe ser una URL válida').optional(),
MP_WEBHOOK_SECRET: z.string().min(1, 'MP_WEBHOOK_SECRET es requerido').optional(),
MP_PUBLIC_KEY_TEST: z.string().min(1).optional(),
MP_PUBLIC_KEY_PROD: z.string().min(1).optional(),
MP_ACCESS_TOKEN_TEST: z.string().min(1).optional(),
MERCADO_PAGO_TOKEN_KEY: z.string().length(64, 'MERCADO_PAGO_TOKEN_KEY debe ser hex de 32 bytes (64 chars)').optional(),
MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
MP_AUTH_BASE_URL: z.string().url().default('https://auth.mercadopago.com.mx'),
```

> All `.optional()` initially so dev envs without MP creds don't crash. Once Avoqado goes live with MP, change critical ones
> (`MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MERCADO_PAGO_TOKEN_KEY`) to required.

- [ ] **Step 3:** Add to test setup `tests/__helpers__/setup.ts`:

```typescript
process.env.MP_CLIENT_ID = 'test-mp-client-id'
process.env.MP_CLIENT_SECRET = 'test-mp-client-secret'
process.env.MP_REDIRECT_URI = 'http://localhost:3000/api/v1/integrations/mercadopago/oauth/callback'
process.env.MP_WEBHOOK_SECRET = 'test-mp-webhook-secret'
process.env.MP_PUBLIC_KEY_TEST = 'TEST-pk-test'
process.env.MP_ACCESS_TOKEN_TEST = 'TEST-at-test'
process.env.MERCADO_PAGO_TOKEN_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.MP_API_BASE_URL = 'https://api.mercadopago.com'
process.env.MP_AUTH_BASE_URL = 'https://auth.mercadopago.com.mx'
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret'
```

> Per memory `feedback_singleton_env_tests.md` — env vars consumed by services with module-level singletons MUST be set in setup.ts, not in
> test files.

- [ ] **Step 4:** Run typecheck:

```bash
npm run build
```

Expected: clean.

- [ ] **Step 5:** Commit.

```bash
git add src/config/env.ts tests/__helpers__/setup.ts
git commit -m "feat(mercado-pago): validate MP env vars in Zod schema + test setup"
```

---

### Task 2: Install Mercado Pago SDK

- [ ] **Step 1:** Install.

```bash
npm install mercadopago@^2
```

- [ ] **Step 2:** Verify exports.

```bash
node -e "const mp = require('mercadopago'); console.log(typeof mp.MercadoPagoConfig, typeof mp.Payment, typeof mp.Preference)"
```

Expected: `function function function`.

- [ ] **Step 3:** Commit.

```bash
git add package.json package-lock.json
git commit -m "feat(mercado-pago): install mercadopago SDK v2"
```

---

### Task 3: Generalized AES-256-GCM token encryption helper

**Files:**

- Create: `src/lib/token-encryption.ts`
- Create: `tests/unit/lib/token-encryption.test.ts`

- [ ] **Step 1:** Failing test — create `tests/unit/lib/token-encryption.test.ts`:

```typescript
import { createTokenCipher } from '@/lib/token-encryption'

describe('createTokenCipher', () => {
  const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

  it('roundtrips a token through encrypt → decrypt', () => {
    const plaintext = 'APP_USR-1234567890abcdef-mp-access-token'
    const blob = cipher.encrypt(plaintext)
    expect(blob).toBeInstanceOf(Buffer)
    expect(cipher.decrypt(blob)).toBe(plaintext)
  })

  it('produces different ciphertext on each call (random IV)', () => {
    const a = cipher.encrypt('same input')
    const b = cipher.encrypt('same input')
    expect(a.equals(b)).toBe(false)
    expect(cipher.decrypt(a)).toBe('same input')
    expect(cipher.decrypt(b)).toBe('same input')
  })

  it('throws when authTag is tampered', () => {
    const blob = cipher.encrypt('secret')
    blob[15] = blob[15] ^ 0x01
    expect(() => cipher.decrypt(blob)).toThrow()
  })

  it('throws when configured env key is missing or wrong length', () => {
    const broken = createTokenCipher('NONEXISTENT_KEY')
    expect(() => broken.encrypt('x')).toThrow(/NONEXISTENT_KEY/)
  })

  it('base64 helpers roundtrip', () => {
    const b64 = cipher.encryptToBase64('token-value')
    expect(typeof b64).toBe('string')
    expect(cipher.decryptFromBase64(b64)).toBe('token-value')
  })

  it('isolates keys per env var', () => {
    process.env.OTHER_KEY = '1111111111111111111111111111111111111111111111111111111111111111'
    const a = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')
    const b = createTokenCipher('OTHER_KEY')
    const blob = a.encrypt('hello')
    expect(() => b.decrypt(blob)).toThrow()
  })
})
```

- [ ] **Step 2:** Run, expect FAIL.

- [ ] **Step 3:** Implement — create `src/lib/token-encryption.ts`:

```typescript
/**
 * AES-256-GCM token encryption helper, parametrized by env var name.
 *
 * Stored layout (Buffer):
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Each consumer (Google Calendar, Mercado Pago, future OAuth integrations) has
 * its OWN key env var so leaks isolate per integration. Rotate keys
 * separately. Never reuse the same key across integrations.
 */
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export interface TokenCipher {
  encrypt(plaintext: string): Buffer
  decrypt(blob: Buffer): string
  encryptToBase64(plaintext: string): string
  decryptFromBase64(b64: string): string
}

export function createTokenCipher(envKeyName: string): TokenCipher {
  function getKey(): Buffer {
    const hex = process.env[envKeyName]
    if (!hex || hex.length !== 64) {
      throw new Error(`${envKeyName} missing or wrong length (expect 32-byte hex string)`)
    }
    return Buffer.from(hex, 'hex')
  }

  const api: TokenCipher = {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(IV_LEN)
      const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, ct])
    },
    decrypt(blob) {
      const iv = blob.subarray(0, IV_LEN)
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
      const ct = blob.subarray(IV_LEN + TAG_LEN)
      const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
    encryptToBase64(plaintext) {
      return api.encrypt(plaintext).toString('base64')
    },
    decryptFromBase64(b64) {
      return api.decrypt(Buffer.from(b64, 'base64'))
    },
  }
  return api
}
```

- [ ] **Step 4:** Run tests, expect PASS (6/6).

- [ ] **Step 5:** Commit.

```bash
git add src/lib/token-encryption.ts tests/unit/lib/token-encryption.test.ts
git commit -m "feat(lib): generalized AES-256-GCM token encryption helper"
```

---

### Task 4: Refactor Google Calendar encryption to use the generalized helper

**Files:**

- Modify: `src/services/google-calendar/encryption.service.ts`

- [ ] **Step 1:** Replace contents entirely:

```typescript
/**
 * Google Calendar token encryption (thin wrapper around the generalized helper).
 *
 * Key env var: GOOGLE_CALENDAR_TOKEN_KEY. ROTATE-SEPARATELY from JWT_SECRET,
 * MERCADO_PAGO_TOKEN_KEY, and any future OAuth integration keys.
 *
 * Backward-compat: `encryptToken` / `decryptToken` exports preserved for
 * existing callers. New code should `import { createTokenCipher }` directly.
 */
import { createTokenCipher } from '@/lib/token-encryption'

const cipher = createTokenCipher('GOOGLE_CALENDAR_TOKEN_KEY')

export const encryptToken = cipher.encrypt
export const decryptToken = cipher.decrypt
```

- [ ] **Step 2:** Regression check — run existing Google Calendar tests:

```bash
npm test -- tests/unit/services/google-calendar/
```

Expected: all PASS (same suite that already exists, no behavior change).

- [ ] **Step 3:** Run full unit suite for defense in depth.

```bash
npm test -- tests/unit/
```

- [ ] **Step 4:** Commit.

```bash
git add src/services/google-calendar/encryption.service.ts
git commit -m "refactor(google-calendar): use generalized token encryption helper"
```

---

### Task 5: TypeScript type definitions

**Files:**

- Create: `src/services/mercado-pago/types.ts`

```typescript
/**
 * Mercado Pago integration types.
 *
 * Tokens at rest are AES-256-GCM encrypted and base64-encoded inside the
 * EcommerceMerchant.providerCredentials JSON column.
 */

export interface MercadoPagoCredentials {
  /** Schema version of this envelope. Bump when shape changes. */
  schemaVersion: 1
  /** AES-GCM key version (for future rotation). v1 always = 1. */
  keyVersion: 1
  /** MP user_id of the seller. Mirrored to EcommerceMerchant.providerMerchantId. */
  mpUserId: string
  /** base64-encoded encrypted access_token (180-day TTL). */
  accessTokenCiphertext: string
  /** base64-encoded encrypted refresh_token. */
  refreshTokenCiphertext: string
  /** ISO timestamp when the access_token expires. */
  expiresAt: string
  /** OAuth scope string returned by MP. */
  scope: string
  /** true once a real payment has flowed. */
  liveMode: boolean
  /** ISO timestamp of the last successful refresh. */
  lastRefreshedAt?: string
  /** Seller's public_key returned in the OAuth response — used by Brick. */
  publicKey: string
}

export interface MercadoPagoOAuthState {
  intent: 'connect_merchant'
  ecommerceMerchantId: string
  venueId: string
  staffId: string
}

export interface MercadoPagoTokenResponse {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  scope: string
  user_id: number
  refresh_token: string
  public_key: string
  live_mode: boolean
}

export interface MercadoPagoWebhookPayload {
  id: number | string
  live_mode: boolean
  type: string
  date_created: string
  user_id: number | string
  api_version: string
  action: string
  data: { id: string }
}
```

Commit:

```bash
git add src/services/mercado-pago/types.ts
git commit -m "feat(mercado-pago): credentials envelope and API types"
```

---

## Phase 1 — OAuth core

### Task 6: OAuth state helpers (JWT signed)

**Files:**

- Create: `src/services/mercado-pago/oauth.service.ts` (state helpers only in this task)
- Create: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1:** Failing test:

```typescript
import jwt from 'jsonwebtoken'
import { signState, verifyState } from '@/services/mercado-pago/oauth.service'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

describe('MP OAuth state', () => {
  const payload: MercadoPagoOAuthState = {
    intent: 'connect_merchant',
    ecommerceMerchantId: 'em_abc',
    venueId: 'v_1',
    staffId: 's_1',
  }

  it('roundtrips state', () => {
    const decoded = verifyState(signState(payload))
    expect(decoded.ecommerceMerchantId).toBe('em_abc')
    expect(decoded.venueId).toBe('v_1')
    expect(decoded.staffId).toBe('s_1')
    expect(decoded.intent).toBe('connect_merchant')
  })

  it('rejects tampered token', () => {
    const t = signState(payload)
    const bad = t.slice(0, -2) + (t.endsWith('a') ? 'b' : 'a') + t.slice(-1)
    expect(() => verifyState(bad)).toThrow()
  })

  it('rejects expired state', () => {
    const expired = jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.OAUTH_STATE_SECRET!)
    expect(() => verifyState(expired)).toThrow(/expired/i)
  })
})
```

- [ ] **Step 2:** Implement — create `src/services/mercado-pago/oauth.service.ts`:

```typescript
import jwt, { SignOptions } from 'jsonwebtoken'
import type { MercadoPagoOAuthState } from './types'

const STATE_TTL_SECONDS = 600

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export function signState(payload: MercadoPagoOAuthState): string {
  const opts: SignOptions = { expiresIn: STATE_TTL_SECONDS }
  return jwt.sign(payload, requireEnv('OAUTH_STATE_SECRET'), opts)
}

export function verifyState(token: string): MercadoPagoOAuthState {
  return jwt.verify(token, requireEnv('OAUTH_STATE_SECRET')) as MercadoPagoOAuthState
}

// Remaining helpers added in Task 7
```

- [ ] **Step 3:** Run, expect PASS (3/3).

- [ ] **Step 4:** Commit.

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): JWT-signed OAuth state helpers"
```

---

### Task 7: OAuth authorize URL + code exchange + token refresh

**Files:**

- Modify: `src/services/mercado-pago/oauth.service.ts`
- Modify: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1:** Append failing tests:

```typescript
import nock from 'nock'
import { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from '@/services/mercado-pago/oauth.service'

describe('MP OAuth - buildAuthUrl', () => {
  it('uses configured auth host and required params', () => {
    const u = new URL(buildAuthUrl('state-jwt'))
    expect(u.origin).toBe('https://auth.mercadopago.com.mx')
    expect(u.pathname).toBe('/authorization')
    expect(u.searchParams.get('client_id')).toBe('test-mp-client-id')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('platform_id')).toBe('mp')
    expect(u.searchParams.get('state')).toBe('state-jwt')
    expect(u.searchParams.get('redirect_uri')).toBe(process.env.MP_REDIRECT_URI)
  })
})

describe('MP OAuth - exchangeCodeForTokens', () => {
  afterEach(() => nock.cleanAll())

  it('exchanges code via /oauth/token', async () => {
    nock('https://api.mercadopago.com')
      .post(
        '/oauth/token',
        body =>
          body.client_id === 'test-mp-client-id' &&
          body.client_secret === 'test-mp-client-secret' &&
          body.grant_type === 'authorization_code' &&
          body.code === 'auth-code-123' &&
          body.redirect_uri === process.env.MP_REDIRECT_URI,
      )
      .reply(200, {
        access_token: 'APP_USR-access',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 'offline_access read write',
        user_id: 12345678,
        refresh_token: 'TG-refresh',
        public_key: 'APP_USR-pk',
        live_mode: false,
      })

    const t = await exchangeCodeForTokens('auth-code-123')
    expect(t.access_token).toBe('APP_USR-access')
    expect(t.user_id).toBe(12345678)
    expect(t.public_key).toBe('APP_USR-pk')
  })

  it('throws on MP error response', async () => {
    nock('https://api.mercadopago.com').post('/oauth/token').reply(400, { error: 'invalid_grant', error_description: 'code expired' })
    await expect(exchangeCodeForTokens('bad')).rejects.toThrow(/invalid_grant|code expired/i)
  })
})

describe('MP OAuth - refreshAccessToken', () => {
  afterEach(() => nock.cleanAll())

  it('uses grant_type=refresh_token', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token', body => body.grant_type === 'refresh_token' && body.refresh_token === 'old')
      .reply(200, {
        access_token: 'NEW-access',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 's',
        user_id: 1,
        refresh_token: 'NEW-refresh',
        public_key: 'pk',
        live_mode: false,
      })
    const t = await refreshAccessToken('old')
    expect(t.access_token).toBe('NEW-access')
    expect(t.refresh_token).toBe('NEW-refresh')
  })
})
```

- [ ] **Step 2:** Run, expect FAIL.

- [ ] **Step 3:** Implement — append to `src/services/mercado-pago/oauth.service.ts`:

```typescript
import axios, { AxiosError } from 'axios'
import type { MercadoPagoTokenResponse } from './types'

export function buildAuthUrl(state: string): string {
  const base = process.env.MP_AUTH_BASE_URL || 'https://auth.mercadopago.com.mx'
  const params = new URLSearchParams({
    client_id: requireEnv('MP_CLIENT_ID'),
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: requireEnv('MP_REDIRECT_URI'),
    state,
  })
  return `${base}/authorization?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<MercadoPagoTokenResponse> {
  return await postOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('MP_REDIRECT_URI'),
  })
}

export async function refreshAccessToken(refreshToken: string): Promise<MercadoPagoTokenResponse> {
  return await postOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

async function postOAuthToken(body: Record<string, string>): Promise<MercadoPagoTokenResponse> {
  const apiBase = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
  try {
    const { data } = await axios.post<MercadoPagoTokenResponse>(`${apiBase}/oauth/token`, body, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      const { error, error_description } = err.response.data
      throw new Error(`MP OAuth ${body.grant_type} failed: ${error || err.message} — ${error_description || ''}`.trim())
    }
    throw err
  }
}
```

- [ ] **Step 4:** Run, expect PASS (6/6).

> **At first real OAuth call** (smoke test in Phase 10), verify MP accepts `MP_CLIENT_SECRET=ZbGZTzyA6WXwKgwZH1sQ1qkml3Fk8aGo` (the value
> from MP DevPanel → Credenciales de producción). If MP returns `invalid_client`, MP changed the credential format — investigate.

- [ ] **Step 5:** Commit.

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): OAuth authorize URL + code exchange + token refresh"
```

---

### Task 8: Seed MERCADO_PAGO PaymentProvider row

**Files:**

- Create migration file via `npx prisma migrate dev --create-only --name seed_mercado_pago_provider`
- Fill the generated SQL:

```sql
INSERT INTO "PaymentProvider" (
  "id", "code", "name", "type", "countryCode", "active", "configSchema", "createdAt", "updatedAt"
) VALUES (
  'cmp_mercadopago_v3_seed',
  'MERCADO_PAGO',
  'Mercado Pago',
  'PAYMENT_PROCESSOR',
  ARRAY['MX'],
  true,
  '{
    "type": "object",
    "required": ["schemaVersion","keyVersion","mpUserId","accessTokenCiphertext","refreshTokenCiphertext","expiresAt","publicKey"],
    "properties": {
      "schemaVersion": { "type": "integer", "const": 1 },
      "keyVersion":    { "type": "integer", "const": 1 },
      "mpUserId":      { "type": "string" },
      "accessTokenCiphertext":  { "type": "string" },
      "refreshTokenCiphertext": { "type": "string" },
      "expiresAt":      { "type": "string", "format": "date-time" },
      "scope":          { "type": "string" },
      "liveMode":       { "type": "boolean" },
      "lastRefreshedAt":{ "type": "string", "format": "date-time" },
      "publicKey":      { "type": "string" }
    }
  }'::jsonb,
  NOW(), NOW()
) ON CONFLICT ("code") DO NOTHING;
```

- [ ] Apply: `npx prisma migrate dev`
- [ ] Verify: `psql $DATABASE_URL -c "SELECT code FROM \"PaymentProvider\" WHERE code='MERCADO_PAGO';"` → 1 row
- [ ] Commit.

---

## Phase 2 — Connection service (tenant guard, persist/load/refresh)

### Task 9: Tenant guard

**Files:**

- Create: `src/services/mercado-pago/merchant-guard.service.ts`
- Create: `tests/unit/services/mercado-pago/merchant-guard.service.test.ts`

Tests (failing first, then implementation — mirror Stripe's `getStripeConnectMerchant` at `stripeConnect.service.ts:16-37`):

```typescript
// test file
import { getMercadoPagoMerchant } from '@/services/mercado-pago/merchant-guard.service'
import { NotFoundError, UnauthorizedError, BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { ecommerceMerchant: { findUnique: jest.fn() } },
}))
const m = prisma as unknown as { ecommerceMerchant: { findUnique: jest.Mock } }

describe('getMercadoPagoMerchant', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns merchant when venue + provider match', async () => {
    m.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', venueId: 'v_1', provider: { code: 'MERCADO_PAGO' } })
    expect((await getMercadoPagoMerchant('v_1', 'em_1')).id).toBe('em_1')
  })

  it('throws NotFoundError when missing', async () => {
    m.ecommerceMerchant.findUnique.mockResolvedValue(null)
    await expect(getMercadoPagoMerchant('v_1', 'em_x')).rejects.toThrow(NotFoundError)
  })

  it('throws UnauthorizedError on venue mismatch', async () => {
    m.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', venueId: 'OTHER', provider: { code: 'MERCADO_PAGO' } })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(UnauthorizedError)
  })

  it('throws BadRequestError when provider is not MP', async () => {
    m.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', venueId: 'v_1', provider: { code: 'STRIPE_CONNECT' } })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(BadRequestError)
  })
})
```

```typescript
// implementation
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export async function getMercadoPagoMerchant(venueId: string, merchantId: string) {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    include: { provider: { select: { code: true } } },
  })
  if (!merchant) throw new NotFoundError('Afiliación de e-commerce no encontrada')
  if (merchant.venueId !== venueId) throw new UnauthorizedError('No tienes acceso a esta afiliación')
  if (merchant.provider.code !== 'MERCADO_PAGO') throw new BadRequestError('Esta afiliación no usa Mercado Pago')
  return merchant
}
```

Pass + commit.

---

### Task 10: Connection service — persist, load, clear (MERGE pattern)

**Files:** `src/services/mercado-pago/connection.service.ts` + test.

Key behaviors:

- `persistTokens(merchantId, tokens)` — MERGES with existing `providerCredentials` JSON. Adds `publicKey` from token response.
- `loadCredentials(merchantId)` — returns decrypted credentials including `publicKey`, or `null`.
- `clearCredentials(merchantId)` — removes ONLY the MP-specific keys, preserves other JSON fields. Nulls `providerMerchantId`.

```typescript
// src/services/mercado-pago/connection.service.ts
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { createTokenCipher } from '@/lib/token-encryption'
import type { MercadoPagoCredentials, MercadoPagoTokenResponse } from './types'

const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

export interface DecryptedCredentials {
  mpUserId: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string
  liveMode: boolean
  lastRefreshedAt?: Date
  publicKey: string
}

const MP_KEYS = [
  'schemaVersion',
  'keyVersion',
  'mpUserId',
  'accessTokenCiphertext',
  'refreshTokenCiphertext',
  'expiresAt',
  'scope',
  'liveMode',
  'lastRefreshedAt',
  'publicKey',
]

function readJsonObject(v: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

export async function persistTokens(ecommerceMerchantId: string, tokens: MercadoPagoTokenResponse): Promise<void> {
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  const prior = readJsonObject(existing?.providerCredentials)
  const mpUserId = String(tokens.user_id)

  const mpFields: MercadoPagoCredentials = {
    schemaVersion: 1,
    keyVersion: 1,
    mpUserId,
    accessTokenCiphertext: cipher.encryptToBase64(tokens.access_token),
    refreshTokenCiphertext: cipher.encryptToBase64(tokens.refresh_token),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope,
    liveMode: tokens.live_mode,
    lastRefreshedAt: new Date().toISOString(),
    publicKey: tokens.public_key,
  }

  const merged = { ...prior, ...mpFields } as Prisma.InputJsonValue

  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: { providerCredentials: merged, providerMerchantId: mpUserId },
  })
}

export async function loadCredentials(ecommerceMerchantId: string): Promise<DecryptedCredentials | null> {
  const m = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  if (!m) return null
  const c = m.providerCredentials as unknown as MercadoPagoCredentials | null
  if (!c?.accessTokenCiphertext || !c?.refreshTokenCiphertext) return null

  return {
    mpUserId: c.mpUserId,
    accessToken: cipher.decryptFromBase64(c.accessTokenCiphertext),
    refreshToken: cipher.decryptFromBase64(c.refreshTokenCiphertext),
    expiresAt: new Date(c.expiresAt),
    scope: c.scope,
    liveMode: c.liveMode,
    lastRefreshedAt: c.lastRefreshedAt ? new Date(c.lastRefreshedAt) : undefined,
    publicKey: c.publicKey,
  }
}

export async function clearCredentials(ecommerceMerchantId: string): Promise<void> {
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  const prior = readJsonObject(existing?.providerCredentials)
  for (const k of MP_KEYS) delete prior[k]

  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: { providerCredentials: prior as Prisma.InputJsonValue, providerMerchantId: null },
  })
}
```

Tests cover MERGE behavior (preserves unrelated keys), load null when absent, and clear preserves unrelated keys.

Pass + commit:

```bash
git commit -m "feat(mercado-pago): connection service with MERGE persistence + clear"
```

---

### Task 11: refreshIfExpiring with PostgreSQL advisory lock

**Files:** Append to `src/services/mercado-pago/connection.service.ts`, append tests.

```typescript
import { refreshAccessToken } from './oauth.service'

export type RefreshResult = 'refreshed' | 'not_needed' | 'no_credentials' | 'merchant_not_found'

export async function refreshIfExpiring(ecommerceMerchantId: string, thresholdDays = 30): Promise<RefreshResult> {
  // Single transaction holds an advisory lock keyed by venueId so concurrent
  // cron + on-demand refresh don't race. Lock auto-releases on commit/rollback.
  return prisma.$transaction(async tx => {
    const merchant = await tx.ecommerceMerchant.findUnique({
      where: { id: ecommerceMerchantId },
      select: { id: true, venueId: true, providerCredentials: true },
    })
    if (!merchant) return 'merchant_not_found' as const

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${merchant.venueId}, 0))`

    const credentials = merchant.providerCredentials as unknown as MercadoPagoCredentials | null
    if (!credentials?.refreshTokenCiphertext) return 'no_credentials' as const

    const expiresAt = new Date(credentials.expiresAt)
    if (expiresAt.getTime() - Date.now() > thresholdDays * 86400_000) return 'not_needed' as const

    const refreshToken = cipher.decryptFromBase64(credentials.refreshTokenCiphertext)
    const fresh = await refreshAccessToken(refreshToken)

    const updated: MercadoPagoCredentials = {
      ...credentials,
      schemaVersion: 1,
      keyVersion: 1,
      accessTokenCiphertext: cipher.encryptToBase64(fresh.access_token),
      refreshTokenCiphertext: cipher.encryptToBase64(fresh.refresh_token),
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      scope: fresh.scope,
      liveMode: fresh.live_mode,
      lastRefreshedAt: new Date().toISOString(),
      publicKey: fresh.public_key,
    }
    const prior = readJsonObject(merchant.providerCredentials)
    const merged = { ...prior, ...updated } as Prisma.InputJsonValue

    await tx.ecommerceMerchant.update({
      where: { id: ecommerceMerchantId },
      data: { providerCredentials: merged, providerMerchantId: String(fresh.user_id) },
    })
    return 'refreshed' as const
  })
}
```

Tests cover refreshed/not-needed/no-credentials outcomes, mock `prisma.$transaction` and `prisma.$executeRaw`.

Commit:

```bash
git commit -m "feat(mercado-pago): refreshIfExpiring with per-venue advisory lock"
```

---

## Phase 3 — Schema changes

### Task 12: Add MP fields to CheckoutSession

In `prisma/schema.prisma` add to `model CheckoutSession` after `applicationFeeCents`:

```prisma
  // Mercado Pago fields (only set when provider = MERCADO_PAGO).
  /// MP preference.id (optional — Bricks flow may skip preferences and create
  /// payment directly from token). Reserved for future flexibility.
  mpPreferenceId       String? @unique
  /// MP payment.id received via IPN. Set when buyer completes payment.
  mpPaymentId          String? @unique
  /// MP merchant_order.id — reconciles preferences ↔ payments.
  mpMerchantOrderId    String?
```

Indexes:

```prisma
  @@index([mpPreferenceId])
  @@index([mpPaymentId])
  @@index([mpMerchantOrderId])
```

Generate migration: `npx prisma migrate dev --name add_mp_fields_to_checkout_session` Apply, verify, commit.

---

### Task 13: MercadoPagoWebhookEvent dedupe table

In `prisma/schema.prisma` append:

```prisma
/// Dedupe table for Mercado Pago IPN webhooks. MP sends duplicate deliveries
/// for the same event; unique constraint on (mpUserId, dataId, requestId)
/// guarantees we only process each event once.
model MercadoPagoWebhookEvent {
  id          String   @id @default(cuid())
  mpUserId    String
  dataId      String
  requestId   String
  eventType   String
  action      String
  payload     Json
  processingStatus String
  errorMessage String?
  createdAt   DateTime @default(now())

  @@unique([mpUserId, dataId, requestId])
  @@index([dataId])
  @@index([createdAt])
}
```

Generate migration, apply, verify schema (`psql $DATABASE_URL -c "\d \"MercadoPagoWebhookEvent\""`), commit.

---

## Phase 4 — Payment service (Bricks flow with /v1/payments + application_fee)

> **This is the v3 divergence from v2.** v2 used `/checkout/preferences` (Pro). v3 uses `/v1/payments` (Bricks).

### Task 14: Payment service — createPayment with token from Brick

**Files:**

- Create: `src/services/mercado-pago/payment.service.ts`
- Create: `tests/unit/services/mercado-pago/payment.service.test.ts`

The Brick (frontend) tokenizes the card and returns a `token` + `payment_method_id` + `issuer_id` + `installments` to your frontend. The
frontend POSTs these to your backend, which calls `MP /v1/payments`.

```typescript
// payment.service.ts
import axios, { AxiosError } from 'axios'
import { v4 as uuidv4 } from 'uuid'

const API_BASE = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'

export interface CreatePaymentParams {
  accessToken: string
  /** Card token from MP Brick tokenization (frontend). */
  token: string
  /** Payment method id from Brick (e.g. 'visa', 'master'). */
  paymentMethodId: string
  /** Installments selected by buyer in Brick. */
  installments: number
  /** Issuer id from Brick (optional, MP infers if absent). */
  issuerId?: string

  /** Internal CheckoutSession reference — used as MP external_reference. */
  orderId: string
  /** Amount in MAJOR units (decimal MXN). Caller already converted from cents. */
  amountMxn: number
  /** Platform fee in MAJOR units (decimal MXN). */
  applicationFeeMxn: number
  description: string

  /** Buyer's email — required by MP. */
  payerEmail: string
  payerFirstName?: string
  payerLastName?: string
  payerIdentificationType?: string
  payerIdentificationNumber?: string

  /** Idempotency key — pass session id or random uuid. */
  idempotencyKey: string

  /** Where MP posts IPN. Optional; MP uses panel-configured URL if omitted. */
  notificationUrl?: string
}

export interface PaymentResult {
  id: number
  status: 'pending' | 'approved' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'
  status_detail: string
  /** Present when 3DS challenge is required. */
  three_ds_redirect_url?: string
}

export async function createPayment(p: CreatePaymentParams): Promise<PaymentResult> {
  try {
    const { data } = await axios.post<PaymentResult>(
      `${API_BASE}/v1/payments`,
      {
        token: p.token,
        payment_method_id: p.paymentMethodId,
        installments: p.installments,
        issuer_id: p.issuerId,
        transaction_amount: p.amountMxn,
        application_fee: p.applicationFeeMxn,
        external_reference: p.orderId,
        description: p.description,
        payer: {
          email: p.payerEmail,
          first_name: p.payerFirstName,
          last_name: p.payerLastName,
          identification:
            p.payerIdentificationType && p.payerIdentificationNumber
              ? { type: p.payerIdentificationType, number: p.payerIdentificationNumber }
              : undefined,
        },
        notification_url: p.notificationUrl,
        binary_mode: false, // allow async approval (3DS, OXXO, etc.)
      },
      {
        headers: {
          Authorization: `Bearer ${p.accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': p.idempotencyKey,
        },
        timeout: 30000,
      },
    )
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      throw new Error(`MP createPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}
```

Tests with `nock` covering: happy path approval, validation of body fields including `application_fee` (centavos→MXN converted), idempotency
header, 3DS response shape.

Commit:

```bash
git commit -m "feat(mercado-pago): createPayment via /v1/payments with application_fee and 3DS support"
```

---

### Task 15: Payment service — getPayment + refundPayment

Append to `src/services/mercado-pago/payment.service.ts`:

```typescript
export interface MercadoPagoPayment {
  id: number
  status: string
  status_detail: string
  external_reference: string | null
  transaction_amount: number
  currency_id: string
  date_approved: string | null
  date_created: string
  fee_details: Array<{ type: string; amount: number; fee_payer: string }>
  application_fee?: number
  order?: { id: number | null } | null
}

export async function getPayment(accessToken: string, paymentId: string): Promise<MercadoPagoPayment> {
  try {
    const { data } = await axios.get<MercadoPagoPayment>(`${API_BASE}/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      throw new Error(`MP getPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}

export interface RefundParams {
  accessToken: string
  paymentId: string
  /** Omit for full refund. In MXN major units (NOT cents). */
  amount?: number
  idempotencyKey: string
}

export interface RefundResult {
  id: number
  payment_id: number
  amount: number
  status: string
}

export async function refundPayment(p: RefundParams): Promise<RefundResult> {
  try {
    const body = p.amount !== undefined ? { amount: p.amount } : {}
    const { data } = await axios.post<RefundResult>(`${API_BASE}/v1/payments/${p.paymentId}/refunds`, body, {
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': p.idempotencyKey,
      },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      throw new Error(`MP refundPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}
```

Tests cover happy path + partial vs full refund + idempotency header.

Commit:

```bash
git commit -m "feat(mercado-pago): getPayment + refundPayment with idempotency"
```

---

## Phase 5 — Webhook verification + payment flow

### Task 16: Webhook signature verification

**Files:**

- Create: `src/services/mercado-pago/webhook.service.ts`
- Create: `tests/unit/services/mercado-pago/webhook.service.test.ts`

```typescript
import crypto from 'crypto'

const TOLERANCE_SECONDS = 300

export interface VerifyWebhookSignatureParams {
  signature: string // x-signature header
  requestId: string // x-request-id header
  queryDataId: string | null // data.id from URL query (preferred)
  bodyDataId: string | null // data.id from JSON body (fallback)
}

function requireSecret(): string {
  const s = process.env.MP_WEBHOOK_SECRET
  if (!s) throw new Error('MP_WEBHOOK_SECRET is not set')
  return s
}

function parseHeader(header: string): { ts: string; v1: string } {
  const parts = header.split(',').map(p => p.trim())
  const obj: Record<string, string> = {}
  for (const part of parts) {
    const [k, v] = part.split('=')
    if (k && v) obj[k] = v
  }
  if (!obj.ts || !obj.v1) throw new Error('malformed x-signature header')
  return { ts: obj.ts, v1: obj.v1 }
}

export function verifyWebhookSignature(p: VerifyWebhookSignatureParams): void {
  const { ts, v1 } = parseHeader(p.signature)
  const tsNum = parseInt(ts, 10)
  if (Number.isNaN(tsNum)) throw new Error('malformed timestamp')
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNum) > TOLERANCE_SECONDS) {
    throw new Error(`MP webhook timestamp out of tolerance (replay protection): now=${now} ts=${tsNum}`)
  }

  const rawDataId = p.queryDataId ?? p.bodyDataId
  if (!rawDataId) throw new Error('no data.id available for signature verification')

  const dataId = rawDataId.toLowerCase()
  const manifest = `id:${dataId};request-id:${p.requestId};ts:${ts};`
  const expected = crypto.createHmac('sha256', requireSecret()).update(manifest).digest('hex')

  if (!crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('invalid MP webhook signature')
  }
}
```

Tests covering: valid signature with query data.id, fallback to body data.id, alphanumeric lowercase normalization, stale timestamp,
malformed header.

Commit:

```bash
git commit -m "feat(mercado-pago): webhook signature verification with replay protection"
```

---

### Task 17: Payment-flow service (dedupe → fetch → update DB)

**Files:**

- Create: `src/services/mercado-pago/payment-flow.service.ts`
- Create: `tests/unit/services/mercado-pago/payment-flow.service.test.ts`

```typescript
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { getPayment } from './payment.service'
import { loadCredentials } from './connection.service'
import type { MercadoPagoWebhookPayload } from './types'

export interface HandleIpnParams {
  payload: MercadoPagoWebhookPayload
  requestId: string
}

export type HandleIpnResult =
  | { status: 'processed'; checkoutSessionId: string; paymentId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }
  | { status: 'error'; reason: string }

function mpToCheckoutStatus(s: string): 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  switch (s) {
    case 'approved':
    case 'authorized':
      return 'COMPLETED'
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'PENDING'
    case 'rejected':
    case 'cancelled':
      return 'CANCELLED'
    case 'refunded':
    case 'charged_back':
      return 'FAILED'
    default:
      return 'PENDING'
  }
}

export async function handleIpn(p: HandleIpnParams): Promise<HandleIpnResult> {
  const mpUserId = String(p.payload.user_id)
  const dataId = String(p.payload.data.id)
  const eventType = p.payload.type
  const action = p.payload.action

  // 1. Dedupe insert (unique constraint = atomic check)
  try {
    await prisma.mercadoPagoWebhookEvent.create({
      data: { mpUserId, dataId, requestId: p.requestId, eventType, action, payload: p.payload as any, processingStatus: 'pending' },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') return { status: 'duplicate' }
    throw err
  }

  if (eventType !== 'payment') {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', `unsupported event type ${eventType}`)
    return { status: 'ignored', reason: `unsupported event type ${eventType}` }
  }

  // 2. Resolve seller + access token
  const merchant = await prisma.ecommerceMerchant.findFirst({
    where: { providerMerchantId: mpUserId, provider: { code: 'MERCADO_PAGO' } },
  })
  if (!merchant) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', `no merchant matches mpUserId ${mpUserId}`)
    return { status: 'error', reason: 'merchant_not_found' }
  }

  const creds = await loadCredentials(merchant.id)
  if (!creds) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', 'merchant credentials missing')
    return { status: 'error', reason: 'credentials_missing' }
  }

  // 3. Fetch payment from MP
  let payment
  try {
    payment = await getPayment(creds.accessToken, dataId)
  } catch (err: any) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', err.message)
    return { status: 'error', reason: 'fetch_failed' }
  }

  // 4. Find CheckoutSession by external_reference
  const externalRef = payment.external_reference
  if (!externalRef) {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', 'no external_reference')
    return { status: 'ignored', reason: 'no_external_reference' }
  }
  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: externalRef, ecommerceMerchantId: merchant.id },
  })
  if (!session) {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', `no session for ${externalRef}`)
    return { status: 'ignored', reason: 'session_not_found' }
  }

  // 5. Update CheckoutSession
  const checkoutStatus = mpToCheckoutStatus(payment.status)
  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      mpPaymentId: String(payment.id),
      mpMerchantOrderId: payment.order?.id ? String(payment.order.id) : null,
      status: checkoutStatus,
      completedAt: checkoutStatus === 'COMPLETED' ? new Date() : session.completedAt,
    },
  })

  await markStatus(mpUserId, dataId, p.requestId, 'processed', null)
  logger.info({ checkoutSessionId: session.id, paymentId: payment.id, status: payment.status }, '[MP] IPN processed')

  return { status: 'processed', checkoutSessionId: session.id, paymentId: String(payment.id) }
}

async function markStatus(
  mpUserId: string,
  dataId: string,
  requestId: string,
  status: 'processed' | 'ignored' | 'error',
  errorMessage: string | null,
) {
  await prisma.mercadoPagoWebhookEvent.updateMany({
    where: { mpUserId, dataId, requestId },
    data: { processingStatus: status, errorMessage },
  })
}
```

Tests cover: happy path, duplicate (P2002 → status: duplicate), unsupported event type (ignored), merchant not found (error).

Commit:

```bash
git commit -m "feat(mercado-pago): IPN payment-flow service with dedupe + DB updates"
```

---

## Phase 6 — Provider implementation + registry

### Task 18: MercadoPagoProvider + registry wiring

**Files:**

- Create: `src/services/payments/providers/mercado-pago.provider.ts`
- Modify: `src/services/payments/provider-registry.ts`
- Create: tests

```typescript
// mercado-pago.provider.ts
import { BadRequestError } from '@/errors/AppError'
import { ProviderCapabilityError } from './not-implemented.error'
import * as connectionService from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as paymentService from '@/services/mercado-pago/payment.service'
import prisma from '@/utils/prismaClient'
import type {
  AuthorizeCardPaymentParams,
  AuthorizeCardPaymentResult,
  CheckoutSession,
  CreateCheckoutParams,
  EcommerceMerchantWithProvider,
  IEcommerceProvider,
  OnboardingLink,
  OnboardingStatus,
  PaymentStatus,
  RefundParams,
  RefundResult,
  TokenizeCardParams,
  TokenizeCardResult,
  VerifiedWebhookEvent,
} from './provider.interface'

const PROVIDER_CODE = 'MERCADO_PAGO'

export class MercadoPagoProvider implements IEcommerceProvider {
  async createOnboardingLink(merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink> {
    if (!merchant.venueId) throw new BadRequestError('venueId es requerido para conectar Mercado Pago')
    // staffId set by controller wrapper before invoking this — provider just needs venue+merchant
    const state = oauthService.signState({
      intent: 'connect_merchant',
      ecommerceMerchantId: merchant.id,
      venueId: merchant.venueId,
      staffId: '',
    })
    return { url: oauthService.buildAuthUrl(state), expiresAt: new Date(Date.now() + 10 * 60 * 1000) }
  }

  async getOnboardingStatus(merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      return { status: 'NOT_STARTED', chargesEnabled: false, payoutsEnabled: false, requirementsDue: [], disabledReason: null }
    }
    const expired = creds.expiresAt.getTime() <= Date.now()
    return {
      status: expired ? 'RESTRICTED' : 'COMPLETED',
      chargesEnabled: !expired,
      payoutsEnabled: !expired,
      requirementsDue: expired ? ['token_expired'] : [],
      disabledReason: expired ? 'token_expired' : null,
    }
  }

  /**
   * For MP Bricks flow, this is NOT a "create checkout session" in the
   * preference sense. Instead, this is called from the public endpoint that
   * the frontend uses to bootstrap the Brick. It returns the data the Brick
   * needs (publicKey, mpUserId) plus a CheckoutSession.id that becomes the
   * MP external_reference once the payment is created.
   *
   * The actual MP /v1/payments call happens LATER when the Brick tokenizes
   * the card and the frontend submits the token to /payment-links/.../pay.
   */
  async createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')

    if (params.amount <= 0) throw new BadRequestError('El monto de pago debe ser mayor a cero')
    if (params.applicationFeeAmount < 0 || params.applicationFeeAmount > params.amount) {
      throw new BadRequestError('La comisión de plataforma no puede exceder el monto de pago')
    }

    // Returning a deterministic id we can use as external_reference. The
    // caller (paymentLink.service.ts or similar) persists this to
    // CheckoutSession.sessionId; later when the Brick fires its onSubmit, the
    // public payment endpoint creates the actual /v1/payments call.
    const sessionId = params.idempotencyKey

    return {
      id: sessionId,
      // For MP-Bricks the "url" the frontend should use is its own checkout
      // page (pay.avoqado.io/<shortCode>). Brick mounts there and uses the
      // mp-payment-intent endpoint to load publicKey. The provider contract
      // says we must return a url, so we return the merchant's checkout URL.
      url: `${params.successUrl.split('?')[0].replace(/\/success.*$/, '')}`,
      expiresAt: params.expiresAt,
    }
  }

  async getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus> {
    // sessionId is our internal CheckoutSession.id (NOT MP payment.id).
    // Read mpPaymentId from DB; only hit MP API if we have one.
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      select: { mpPaymentId: true, status: true, completedAt: true },
    })
    if (!session) throw new BadRequestError('CheckoutSession no encontrada')

    if (!session.mpPaymentId) {
      return {
        status: session.status === 'COMPLETED' ? 'PAID' : 'PENDING',
        paidAt: session.completedAt ?? undefined,
        amountPaid: undefined,
      }
    }

    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Credenciales de Mercado Pago no disponibles')

    const payment = await paymentService.getPayment(creds.accessToken, session.mpPaymentId)
    return {
      status: mapMpStatus(payment.status),
      paidAt: payment.date_approved ? new Date(payment.date_approved) : undefined,
      paymentIntentId: String(payment.id),
      amountPaid: payment.transaction_amount,
      applicationFeeAmount: payment.application_fee,
    }
  }

  async refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Credenciales de Mercado Pago no disponibles')

    const refund = await paymentService.refundPayment({
      accessToken: creds.accessToken,
      paymentId: params.paymentIntentId,
      // Interface uses centavos; MP /refunds wants major MXN.
      amount: params.amount !== undefined ? params.amount / 100 : undefined,
      idempotencyKey: params.idempotencyKey,
    })

    return {
      refundId: String(refund.id),
      amount: refund.amount * 100, // convert back to cents for contract
      status: refund.status === 'approved' ? 'SUCCEEDED' : refund.status === 'in_process' ? 'PENDING' : 'FAILED',
    }
  }

  async verifyWebhookSignature(): Promise<VerifiedWebhookEvent> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'verifyWebhookSignature: use webhook controller directly')
  }

  async tokenizeCard(): Promise<TokenizeCardResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'tokenizeCard')
  }

  async authorizeCardPayment(): Promise<AuthorizeCardPaymentResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'authorizeCardPayment')
  }
}

function mapMpStatus(s: string): PaymentStatus['status'] {
  switch (s) {
    case 'approved':
    case 'authorized':
      return 'PAID'
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'PENDING'
    case 'refunded':
      return 'REFUNDED'
    case 'charged_back':
      return 'DISPUTED'
    default:
      return 'FAILED'
  }
}
```

Modify `provider-registry.ts`:

```typescript
import { MercadoPagoProvider } from './providers/mercado-pago.provider'
// ... existing imports ...
switch (providerCode) {
  case 'BLUMON': return new BlumonProvider()
  case 'STRIPE_CONNECT': return new StripeConnectProvider()
  case 'MERCADO_PAGO': return new MercadoPagoProvider()
  default: throw new BadRequestError(...)
}
```

Tests for: registry returns MercadoPagoProvider for code 'MERCADO_PAGO'; getPaymentStatus reads from DB when no mpPaymentId; refund converts
cents↔MXN at boundary.

Commit:

```bash
git commit -m "feat(mercado-pago): IEcommerceProvider implementation + registry"
```

---

## Phase 7 — HTTP layer (OAuth dashboard + Brick init + webhook)

### Task 19: Zod schemas

**Files:**

- Create: `src/schemas/dashboard/mercadoPagoOAuth.schema.ts`
- Create: `src/schemas/public/mercadoPagoPaymentIntent.schema.ts`

```typescript
// dashboard/mercadoPagoOAuth.schema.ts
import { z } from 'zod'

export const initiateQuerySchema = z.object({
  venueId: z.string().min(1, 'venueId es requerido'),
  ecommerceMerchantId: z.string().min(1, 'merchantId es requerido'),
})

export const callbackQuerySchema = z.object({
  code: z.string().min(1, 'El código de autorización es requerido').optional(),
  state: z.string().min(1, 'El estado OAuth es requerido'),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export const disconnectParamsSchema = z.object({
  venueId: z.string().min(1, 'venueId es requerido'),
  merchantId: z.string().min(1, 'merchantId es requerido'),
})
```

```typescript
// public/mercadoPagoPaymentIntent.schema.ts
import { z } from 'zod'

export const initRequestSchema = z.object({
  amount: z.number().positive().optional(),
  tipAmount: z.number().nonnegative().optional(),
  customerEmail: z.string().email().optional(),
  customFieldResponses: z.record(z.string()).optional(),
})

export const payRequestSchema = z.object({
  token: z.string().min(1, 'token es requerido'),
  paymentMethodId: z.string().min(1, 'paymentMethodId es requerido'),
  installments: z.number().int().positive(),
  issuerId: z.string().optional(),
  payer: z.object({
    email: z.string().email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    identification: z
      .object({
        type: z.string(),
        number: z.string(),
      })
      .optional(),
  }),
})
```

Commit:

```bash
git commit -m "feat(mercado-pago): Zod schemas for OAuth and Brick init endpoints"
```

---

### Task 20: OAuth controller (initiate / callback / disconnect)

**Files:**

- Create: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`
- Create: tests

```typescript
import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { initiateQuerySchema, callbackQuerySchema, disconnectParamsSchema } from '@/schemas/dashboard/mercadoPagoOAuth.schema'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

/**
 * GET /api/v1/dashboard/integrations/mercadopago/oauth/connect?venueId=...&ecommerceMerchantId=...
 *
 * Initiates the OAuth flow. The venueId + merchantId come from query params
 * (the frontend "Connect MP" button knows them from the current venue context).
 * We validate tenant ownership, sign a JWT state, redirect to MP.
 */
export async function initiate(req: Request, res: Response) {
  const parsed = initiateQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.errors[0].message })

  const { venueId, ecommerceMerchantId } = parsed.data
  const { userId: staffId, venueId: authVenueId } = (req as any).authContext ?? {}
  if (!staffId) return res.status(401).json({ success: false, error: 'No autenticado' })
  if (authVenueId && authVenueId !== venueId) {
    return res.status(401).json({ success: false, error: 'No tienes acceso a este venue' })
  }

  try {
    await guardService.getMercadoPagoMerchant(venueId, ecommerceMerchantId)
  } catch (err: any) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message })
  }

  const state = oauthService.signState({ intent: 'connect_merchant', ecommerceMerchantId, venueId, staffId })
  logger.info({ venueId, ecommerceMerchantId, staffId }, '[MP OAuth] initiate')
  return res.redirect(oauthService.buildAuthUrl(state))
}

/**
 * GET /api/v1/integrations/mercadopago/oauth/callback?code=...&state=...
 *
 * GLOBAL callback (not venue-scoped) — MP doesn't accept dynamic path params.
 * Extracts venueId + merchantId from the JWT state. Defense-in-depth: re-verifies
 * tenant via getMercadoPagoMerchant after decoding state.
 */
export async function callback(req: Request, res: Response) {
  const parsed = callbackQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).send('Parámetros OAuth inválidos')

  const dashboardUrl = process.env.PUBLIC_DASHBOARD_URL || process.env.DASHBOARD_URL || 'http://localhost:5173'

  if (parsed.data.error) {
    logger.warn({ err: parsed.data.error }, '[MP OAuth] callback returned error')
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=${parsed.data.error}`)
  }
  if (!parsed.data.code) {
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=missing_code`)
  }

  let statePayload: MercadoPagoOAuthState
  try {
    statePayload = oauthService.verifyState(parsed.data.state)
  } catch (err) {
    logger.warn({ err }, '[MP OAuth] invalid state')
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=invalid_state`)
  }

  // Tenant re-check
  try {
    await guardService.getMercadoPagoMerchant(statePayload.venueId, statePayload.ecommerceMerchantId)
  } catch (err) {
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=tenant_check_failed`)
  }

  try {
    const tokens = await oauthService.exchangeCodeForTokens(parsed.data.code)
    await connectionService.persistTokens(statePayload.ecommerceMerchantId, tokens)
    logger.info({ ...statePayload, mpUserId: tokens.user_id }, '[MP OAuth] connected')
    const url = `${dashboardUrl}/venues/${statePayload.venueId}/ecommerce-merchants/${statePayload.ecommerceMerchantId}/integrations/mercadopago?mp_status=connected`
    return res.redirect(url)
  } catch (err: any) {
    logger.error({ err: err.message, ...statePayload }, '[MP OAuth] token exchange failed')
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=token_exchange_failed`)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth
 */
export async function disconnect(req: Request, res: Response) {
  const parsed = disconnectParamsSchema.safeParse(req.params)
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.errors[0].message })

  const { venueId, merchantId } = parsed.data
  try {
    await guardService.getMercadoPagoMerchant(venueId, merchantId)
  } catch (err: any) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message })
  }

  await connectionService.clearCredentials(merchantId)
  logger.info({ venueId, merchantId }, '[MP OAuth] disconnected')
  return res.json({ success: true })
}
```

Tests cover: initiate goes through guard, rejects on missing auth, callback validates state-vs-URL match, callback handles MP error params,
disconnect requires tenant guard.

Commit:

```bash
git commit -m "feat(mercado-pago): OAuth controller (initiate / callback / disconnect)"
```

---

### Task 21: Mount OAuth routes

**Files:**

- Create: `src/routes/dashboard/mercadoPagoOAuth.routes.ts`
- Modify: central dashboard router

```typescript
// src/routes/dashboard/mercadoPagoOAuth.routes.ts
import { Router } from 'express'
import * as ctrl from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import authenticateToken from '@/middlewares/authenticateToken.middleware'

const router = Router({ mergeParams: true })

// Authenticated dashboard endpoints (initiate + disconnect)
router.get('/connect', authenticateToken, ctrl.initiate)
router.delete('/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth', authenticateToken, ctrl.disconnect)

// Public global callback (no auth — MP redirects browser here with code+state)
// Mount this separately at the app level — NOT under /dashboard/.

export default router
```

For the callback, mount it differently because MP redirects the browser (with cookies from the staff session) to a path MP doesn't know
about. In central API router:

```typescript
import * as mpOAuthCtrl from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import mpOAuthRoutes from '@/routes/dashboard/mercadoPagoOAuth.routes'

// Global callback (no /dashboard/ prefix because MP doesn't know the prefix)
router.get('/integrations/mercadopago/oauth/callback', mpOAuthCtrl.callback)

// Dashboard endpoints (authenticated)
router.use('/dashboard/integrations/mercadopago/oauth', mpOAuthRoutes)
```

Endpoints final shape:

- `GET    /api/v1/dashboard/integrations/mercadopago/oauth/connect?venueId=...&ecommerceMerchantId=...`
- `GET    /api/v1/integrations/mercadopago/oauth/callback?code=...&state=...`
- `DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth`

> Compare to `MP_REDIRECT_URI` in env: must match `<host>/api/v1/integrations/mercadopago/oauth/callback`.

Build + commit:

```bash
npm run build
git commit -m "feat(mercado-pago): mount OAuth routes (global callback + venue-scoped disconnect)"
```

---

### Task 22: Public mp-payment-intent endpoint (frontend Brick init)

**Files:**

- Create: `src/controllers/public/mercadoPagoPaymentIntent.controller.ts`
- Create: `src/routes/public/mercadoPagoPaymentIntent.routes.ts`
- Create: tests

```typescript
// controller
import { Request, Response } from 'express'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { loadCredentials } from '@/services/mercado-pago/connection.service'
import { createPayment } from '@/services/mercado-pago/payment.service'
import { initRequestSchema, payRequestSchema } from '@/schemas/public/mercadoPagoPaymentIntent.schema'
import { toStripeAmount, calculateApplicationFeeWithVAT, getVatRateBps } from /* wherever calculateApplicationFee lives in your codebase */

const HOSTED_PROVIDER_CODES = ['STRIPE_CONNECT', 'MERCADO_PAGO']

/**
 * POST /api/v1/public/payment-links/:shortCode/mp-payment-intent
 *
 * Initializes the MP Brick on the frontend. Returns:
 *   - publicKey: seller's MP public_key (for frontend SDK init)
 *   - mpUserId: seller's MP user_id (used in some Brick configurations)
 *   - sessionId: our internal CheckoutSession.id (becomes external_reference)
 *   - amountMxn, applicationFeeMxn: amounts the frontend Brick should charge
 */
export async function createMercadoPagoPaymentIntent(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const parsed = initRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.errors[0].message)
    }

    const paymentLink = await prisma.paymentLink.findUnique({
      where: { shortCode },
      include: {
        ecommerceMerchant: { include: { provider: { select: { code: true } } } },
      },
    })
    if (!paymentLink) throw new NotFoundError('Liga de pago no encontrada')
    if (paymentLink.status !== 'ACTIVE') throw new BadRequestError('Esta liga de pago no está disponible')
    if (paymentLink.ecommerceMerchant.provider?.code !== 'MERCADO_PAGO') {
      throw new BadRequestError('Esta liga de pago no usa Mercado Pago')
    }

    const creds = await loadCredentials(paymentLink.ecommerceMerchant.id)
    if (!creds) throw new BadRequestError('La cuenta de Mercado Pago del comercio no está conectada')

    // Compute amounts — uses same helpers as Stripe flow
    const amount = parsed.data.amount ?? Number(paymentLink.amount)
    const tipAmount = parsed.data.tipAmount ?? 0
    const chargeAmount = amount + tipAmount

    const { Prisma } = await import('@prisma/client')
    const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
    const vatRateBps = await getVatRateBps()
    const applicationFeeCents = calculateApplicationFeeWithVAT(
      stripeAmount,
      paymentLink.ecommerceMerchant.platformFeeBps,
      vatRateBps,
    )

    // Create a CheckoutSession row to bind a stable sessionId for external_reference
    const session = await prisma.checkoutSession.create({
      data: {
        sessionId: `cs_mp_${Math.random().toString(36).slice(2, 18)}`,
        ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
        amount: chargeAmount,
        currency: 'MXN',
        description: paymentLink.description || 'Pago',
        customerEmail: parsed.data.customerEmail,
        externalOrderId: shortCode,
        applicationFeeCents,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        paymentLinkId: paymentLink.id,
      },
    })

    return res.json({
      success: true,
      data: {
        publicKey: creds.publicKey,
        mpUserId: creds.mpUserId,
        sessionId: session.sessionId,
        amountMxn: chargeAmount,
        applicationFeeMxn: applicationFeeCents / 100,
        currency: 'MXN',
        description: session.description,
      },
    })
  } catch (err: any) {
    logger.error({ err: err.message, shortCode: req.params.shortCode }, '[MP brick init] failed')
    return res.status(err.statusCode || 500).json({ success: false, error: err.message })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/mp-pay
 *
 * Called by the frontend Brick's onSubmit after tokenization. Creates the MP
 * payment with application_fee using the seller's access_token.
 */
export async function executeMercadoPagoPayment(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const parsed = payRequestSchema.safeParse(req.body)
    if (!parsed.success) throw new BadRequestError(parsed.error.errors[0].message)

    const session = await prisma.checkoutSession.findFirst({
      where: { externalOrderId: shortCode, status: 'PENDING' },
      include: { ecommerceMerchant: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!session) throw new NotFoundError('No hay una sesión pendiente para esta liga')

    const creds = await loadCredentials(session.ecommerceMerchantId)
    if (!creds) throw new BadRequestError('Credenciales MP no disponibles')

    const amountMxn = Number(session.amount)
    const applicationFeeMxn = (session.applicationFeeCents || 0) / 100

    const payment = await createPayment({
      accessToken: creds.accessToken,
      token: parsed.data.token,
      paymentMethodId: parsed.data.paymentMethodId,
      installments: parsed.data.installments,
      issuerId: parsed.data.issuerId,
      orderId: session.sessionId,
      amountMxn,
      applicationFeeMxn,
      description: session.description || 'Pago',
      payerEmail: parsed.data.payer.email,
      payerFirstName: parsed.data.payer.firstName,
      payerLastName: parsed.data.payer.lastName,
      payerIdentificationType: parsed.data.payer.identification?.type,
      payerIdentificationNumber: parsed.data.payer.identification?.number,
      idempotencyKey: session.sessionId,
    })

    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        mpPaymentId: String(payment.id),
        status: payment.status === 'approved' ? 'COMPLETED' : payment.status === 'pending' || payment.status === 'in_process' ? 'PENDING' : 'CANCELLED',
      },
    })

    return res.json({
      success: true,
      data: { paymentId: payment.id, status: payment.status, statusDetail: payment.status_detail, threeDsRedirectUrl: payment.three_ds_redirect_url },
    })
  } catch (err: any) {
    logger.error({ err: err.message, shortCode: req.params.shortCode }, '[MP brick pay] failed')
    return res.status(err.statusCode || 500).json({ success: false, error: err.message })
  }
}
```

Routes:

```typescript
import { Router } from 'express'
import * as ctrl from '@/controllers/public/mercadoPagoPaymentIntent.controller'

const router = Router()
router.post('/payment-links/:shortCode/mp-payment-intent', ctrl.createMercadoPagoPaymentIntent)
router.post('/payment-links/:shortCode/mp-pay', ctrl.executeMercadoPagoPayment)
export default router
```

Mount under `/api/v1/public/` in central router.

Tests cover: init returns publicKey + sessionId, rejects non-MP merchants, pay creates MP payment with correct application_fee, updates
CheckoutSession status.

Commit:

```bash
git commit -m "feat(mercado-pago): public mp-payment-intent + mp-pay endpoints for Brick"
```

---

### Task 23: Webhook controller

**Files:**

- Create: `src/controllers/webhook/mercadoPago.webhook.controller.ts`
- Create: tests

```typescript
import { Request, Response } from 'express'
import logger from '@/config/logger'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'
import { handleIpn } from '@/services/mercado-pago/payment-flow.service'
import type { MercadoPagoWebhookPayload } from '@/services/mercado-pago/types'

export async function handleMercadoPagoWebhook(req: Request, res: Response) {
  const signature = req.get('x-signature')
  const requestId = req.get('x-request-id')
  if (!signature || !requestId) return res.status(400).json({ error: 'missing x-signature or x-request-id' })

  let payload: MercadoPagoWebhookPayload
  try {
    payload = JSON.parse((req.body as Buffer).toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' })
  }

  const queryDataId = (req.query['data.id'] as string | undefined) ?? null
  const bodyDataId = payload?.data?.id ? String(payload.data.id) : null

  try {
    verifyWebhookSignature({ signature, requestId, queryDataId, bodyDataId })
  } catch (err: any) {
    logger.warn({ err: err.message, requestId }, '[MP webhook] verification failed')
    return res.status(401).json({ error: 'invalid signature' })
  }

  try {
    const result = await handleIpn({ payload, requestId })
    logger.info({ result, requestId }, '[MP webhook] dispatched')
    return res.status(200).json({ received: true, ...result })
  } catch (err: any) {
    logger.error({ err: err.message, requestId }, '[MP webhook] dispatch failed')
    // Return 200 so MP doesn't retry endlessly; dedupe row is our recovery handle.
    return res.status(200).json({ received: true, error: 'dispatch_failed' })
  }
}
```

Tests cover: 200 on valid sig, 401 on invalid sig, 200 on duplicate (idempotent), 400 on missing headers.

Commit:

```bash
git commit -m "feat(mercado-pago): webhook controller with HMAC + dispatch"
```

---

### Task 24: Mount webhook route BEFORE express.json()

Modify `src/app.ts`. Locate the existing Google Calendar / Stripe webhook mounts (around line 80-90) and add MP webhook immediately after:

```typescript
import { handleMercadoPagoWebhook } from './controllers/webhook/mercadoPago.webhook.controller'

// MP webhook MUST mount BEFORE express.json() so req.body is the raw Buffer
// for HMAC verification.
app.post('/api/v1/webhooks/mercadopago', express.raw({ type: '*/*', limit: '64kb' }), handleMercadoPagoWebhook)
```

Build + commit.

---

## Phase 8 — paymentLink generalization (enable MP in existing checkout flow)

### Task 25: Generalize paymentLink.service.ts to support MERCADO_PAGO

**Files:** `src/services/dashboard/paymentLink.service.ts`

Locate the hardcoded Stripe checks (lines 874, 967, 1102, 1717, 1839 per Codex audit).

At the top of the file add:

```typescript
const HOSTED_PROVIDER_CODES = ['STRIPE_CONNECT', 'MERCADO_PAGO'] as const
type HostedProviderCode = (typeof HOSTED_PROVIDER_CODES)[number]
function isHostedProvider(code: string | undefined): code is HostedProviderCode {
  return code !== undefined && (HOSTED_PROVIDER_CODES as readonly string[]).includes(code)
}
```

Replace line 874 (which selects "STRIPE_HOSTED" vs "INLINE_CARD" type):

```typescript
// OLD: paymentLink.ecommerceMerchant.provider?.code === 'STRIPE_CONNECT' ? 'STRIPE_HOSTED' : 'INLINE_CARD'
isHostedProvider(paymentLink.ecommerceMerchant.provider?.code) ? 'STRIPE_HOSTED' : 'INLINE_CARD'
```

> Note: keeping the enum value `STRIPE_HOSTED` to avoid a schema migration; semantically it now means "hosted-via-iframe (Stripe Elements or
> MP Bricks)". A follow-up could rename to `EMBED_HOSTED`.

Replace line 967 and 1717 (the `if (... !== 'STRIPE_CONNECT')` guards):

```typescript
if (!isHostedProvider(paymentLink.ecommerceMerchant.provider?.code)) {
  throw new BadRequestError('Esta liga de pago no está configurada para checkout hosted (Stripe o Mercado Pago)')
}
```

Replace literals at lines 1102 and 1839 (`provider: 'STRIPE_CONNECT'`):

```typescript
provider: paymentLink.ecommerceMerchant.provider?.code,
```

Add a test that verifies MP-coded merchant doesn't throw the "Stripe Connect" guard.

Commit:

```bash
git commit -m "feat(mercado-pago): generalize paymentLink hosted checkout to accept MP"
```

---

## Phase 9 — Token refresh cron

### Task 26: Daily token refresh job

**Files:**

- Create: `src/jobs/mercadopago-token-refresh.job.ts`
- Create: tests
- Modify: cron scheduler bootstrap (search for `gcal-channel-renewal.job`)

```typescript
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { refreshIfExpiring } from '@/services/mercado-pago/connection.service'

export interface RefreshSummary {
  total: number
  refreshed: number
  notNeeded: number
  noCredentials: number
  errors: number
}

export async function refreshMercadoPagoTokens(): Promise<RefreshSummary> {
  const provider = await prisma.paymentProvider.findUnique({ where: { code: 'MERCADO_PAGO' } })
  if (!provider) {
    logger.warn('[MP refresh] MERCADO_PAGO provider not seeded')
    return { total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 }
  }

  const merchants = await prisma.ecommerceMerchant.findMany({
    where: { providerId: provider.id, providerMerchantId: { not: null } },
    select: { id: true },
  })

  const summary: RefreshSummary = { total: merchants.length, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 }

  for (const merchant of merchants) {
    try {
      const r = await refreshIfExpiring(merchant.id, 30)
      if (r === 'refreshed') summary.refreshed++
      else if (r === 'not_needed') summary.notNeeded++
      else summary.noCredentials++
    } catch (err: any) {
      summary.errors++
      logger.error({ err: err.message, ecommerceMerchantId: merchant.id }, '[MP refresh] failed')
    }
  }

  logger.info({ summary }, '[MP refresh] completed')
  return summary
}
```

Register cron (find via `grep -rln "cron.schedule.*Mexico_City" src/`):

```typescript
import { refreshMercadoPagoTokens } from '@/jobs/mercadopago-token-refresh.job'

cron.schedule(
  '0 3 * * *',
  async () => {
    try {
      await refreshMercadoPagoTokens()
    } catch (err) {
      logger.error({ err }, '[MP refresh] uncaught')
    }
  },
  { timezone: 'America/Mexico_City' },
)
```

Tests + commit.

---

## Phase 10 — Frontend Brick component (in `avoqado-checkout`)

### Task 27: Install `@mercadopago/sdk-react`

In `/Users/amieva/Documents/Programming/Avoqado/avoqado-checkout`:

```bash
npm install @mercadopago/sdk-react@^1
```

Commit.

---

### Task 28: Add MP API client functions

In `avoqado-checkout/src/lib/api.ts`, add:

```typescript
export async function createMercadoPagoPaymentIntent(
  shortCode: string,
  args: {
    amount?: number
    tipAmount?: number
    customerEmail?: string
    customFieldResponses?: Record<string, string>
  },
) {
  const response = await fetch(`${API_BASE_URL}/api/v1/public/payment-links/${shortCode}/mp-payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!response.ok) throw new Error(`MP init failed: ${response.status}`)
  return response.json() as Promise<{
    success: true
    data: {
      publicKey: string
      mpUserId: string
      sessionId: string
      amountMxn: number
      applicationFeeMxn: number
      currency: 'MXN'
      description: string
    }
  }>
}

export async function executeMercadoPagoPayment(
  shortCode: string,
  body: {
    token: string
    paymentMethodId: string
    installments: number
    issuerId?: string
    payer: { email: string; firstName?: string; lastName?: string; identification?: { type: string; number: string } }
  },
) {
  const response = await fetch(`${API_BASE_URL}/api/v1/public/payment-links/${shortCode}/mp-pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`MP pay failed: ${response.status}`)
  return response.json() as Promise<{
    success: true
    data: { paymentId: number; status: string; statusDetail: string; threeDsRedirectUrl?: string }
  }>
}
```

Commit.

---

### Task 29: Create MercadoPagoBrickForm.tsx

Create `avoqado-checkout/src/components/MercadoPagoBrickForm.tsx`:

```typescript
/**
 * Mercado Pago Bricks inline payment form — equivalent of StripeElementsForm.
 *
 * Flow:
 *   1. On mount: POST /payment-links/:shortCode/mp-payment-intent →
 *      get publicKey + sessionId + amountMxn.
 *   2. Initialize MP SDK with publicKey.
 *   3. Render <Payment> brick — MP loads card iframes, OXXO, SPEI, MP Wallet
 *      (whatever the connected seller has activated).
 *   4. On submit: brick tokenizes → returns formData → we POST to /mp-pay
 *      with the token.
 *   5. Webhook payment.updated finalizes server-side. Frontend gets immediate
 *      `approved | in_process | rejected` from /mp-pay response.
 *
 * Card data never touches our backend — iframe POSTs directly to MP. PCI-SAQ-A.
 */
import { useEffect, useState } from 'react'
import { initMercadoPago, Payment } from '@mercadopago/sdk-react'
import { createMercadoPagoPaymentIntent, executeMercadoPagoPayment, type PaymentLinkData } from '@/lib/api'

interface Props {
  link: PaymentLinkData
  shortCode: string
  amount: number
  tipAmount: number
  customerEmail?: string
  customFieldResponses: Record<string, string>
  onSuccess: (paidAmount: number, paymentIntentId: string) => void
  onError: (message: string) => void
}

interface InitData {
  publicKey: string
  mpUserId: string
  sessionId: string
  amountMxn: number
  description: string
}

let mpInitialized = false

export function MercadoPagoBrickForm(props: Props) {
  const [initData, setInitData] = useState<InitData | null>(null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await createMercadoPagoPaymentIntent(props.shortCode, {
          ...(props.link.amountType === 'OPEN' ? { amount: props.amount - props.tipAmount } : {}),
          ...(props.tipAmount > 0 ? { tipAmount: props.tipAmount } : {}),
          ...(props.customerEmail ? { customerEmail: props.customerEmail } : {}),
          ...(Object.keys(props.customFieldResponses).length > 0 ? { customFieldResponses: props.customFieldResponses } : {}),
        })
        if (cancelled) return

        // Initialize MP SDK with seller's publicKey. Use stableScope:'all' so
        // we can re-init with a different publicKey for a different seller
        // (the SDK is module-level so we can only have one configuration per
        // tab — that's fine for this checkout page which loads one link).
        if (!mpInitialized) {
          initMercadoPago(res.data.publicKey, { locale: 'es-MX' })
          mpInitialized = true
        }

        setInitData({
          publicKey: res.data.publicKey,
          mpUserId: res.data.mpUserId,
          sessionId: res.data.sessionId,
          amountMxn: res.data.amountMxn,
          description: res.data.description,
        })
      } catch (err: any) {
        if (cancelled) return
        setInitError(err.message || 'No se pudo iniciar Mercado Pago')
      }
    })()
    return () => { cancelled = true }
  }, [props.shortCode, props.amount, props.tipAmount, props.customerEmail])

  if (initError) {
    return <div className="text-red-600">Error iniciando pago: {initError}</div>
  }
  if (!initData) {
    return <div>Cargando Mercado Pago…</div>
  }

  return (
    <Payment
      initialization={{
        amount: initData.amountMxn,
        payer: { email: props.customerEmail },
      }}
      customization={{
        paymentMethods: {
          creditCard: 'all',
          debitCard: 'all',
          mercadoPago: 'all',
          ticket: 'all', // OXXO
          bankTransfer: 'all', // SPEI
        },
        visual: { style: { theme: 'default' } },
      }}
      onSubmit={async ({ formData }) => {
        if (submitting) return
        setSubmitting(true)
        try {
          const result = await executeMercadoPagoPayment(props.shortCode, {
            token: formData.token,
            paymentMethodId: formData.payment_method_id,
            installments: formData.installments,
            issuerId: formData.issuer_id,
            payer: {
              email: formData.payer?.email ?? props.customerEmail ?? '',
              identification: formData.payer?.identification,
            },
          })
          if (result.data.threeDsRedirectUrl) {
            window.location.href = result.data.threeDsRedirectUrl
            return
          }
          if (result.data.status === 'approved') {
            props.onSuccess(initData.amountMxn, String(result.data.paymentId))
          } else if (result.data.status === 'in_process' || result.data.status === 'pending') {
            props.onSuccess(initData.amountMxn, String(result.data.paymentId))
          } else {
            props.onError(`Pago rechazado: ${result.data.statusDetail}`)
          }
        } catch (err: any) {
          props.onError(err.message || 'No se pudo procesar el pago')
        } finally {
          setSubmitting(false)
        }
      }}
      onError={(err) => {
        props.onError(typeof err === 'string' ? err : (err.message || 'Error en el brick MP'))
      }}
    />
  )
}
```

> **Note on `useState<InitData | null>(null>(null)`** typo above — TypeScript syntax should be `useState<InitData | null>(null)`. The agent
> should produce that correctly.

Commit.

---

### Task 30: Router in CheckoutPage.tsx

Modify `avoqado-checkout/src/components/CheckoutPage.tsx` to dispatch based on provider code:

```typescript
import { MercadoPagoBrickForm } from './MercadoPagoBrickForm'
import { StripeElementsForm } from './StripeElementsForm'

// Inside the render where StripeElementsForm is currently used:
const providerCode = link.ecommerceMerchant?.provider?.code
const FormComponent = providerCode === 'MERCADO_PAGO' ? MercadoPagoBrickForm : StripeElementsForm

return (
  <FormComponent
    link={link}
    shortCode={shortCode}
    amount={chargeAmount}
    tipAmount={tipAmount}
    customerEmail={customerEmail}
    customFieldResponses={customFieldResponses}
    onSuccess={handleSuccess}
    onError={handleError}
  />
)
```

> The `link` API response must include `ecommerceMerchant.provider.code`. If it doesn't, modify the backend's payment-link public endpoint
> to include this in the select (likely a small backend tweak).

Commit.

---

## Phase 11 — Sandbox smoke test

### Task 31: End-to-end manual smoke test

This is gated on Phases 0-10 being committed. Walks through the full flow with real ngrok + MP test users.

- [ ] **Step 1:** Confirm prereqs

  - All Phase 0-10 tasks committed and tests green
  - ngrok up: `https://patchiest-noncommemorational-willia.ngrok-free.dev`
  - `.env` populated (verify with `grep -c "^MP_" .env` → expects 24+ vars)
  - Backend running: `npm run dev`
  - avoqado-checkout running: `npm run dev` in that repo

- [ ] **Step 2:** Verify routes are mounted

  ```
  curl -sX GET https://patchiest-noncommemorational-willia.ngrok-free.dev/api/v1/integrations/mercadopago/oauth/callback
  ```

  Should return 400 with "Parámetros OAuth inválidos" (not 404).

- [ ] **Step 3:** Create a Venue and EcommerceMerchant with provider=MERCADO_PAGO Either via dashboard UI or psql. Note the `venueId` and
      `merchantId`.

- [ ] **Step 4:** Trigger OAuth from a browser logged in as a venue staff Open in incognito (where you're logged in as staff of that venue):

  ```
  https://patchiest-noncommemorational-willia.ngrok-free.dev/api/v1/dashboard/integrations/mercadopago/oauth/connect?venueId=<id>&ecommerceMerchantId=<id>
  ```

  Will redirect to MP. Log in as **MP_TEST_SELLER** (username from .env, password from .env). Authorize Avoqado.

- [ ] **Step 5:** Verify OAuth callback completed Browser should land on `/integrations/mercadopago?mp_status=connected`. Verify DB:

  ```bash
  psql $DATABASE_URL -c "SELECT \"providerMerchantId\", \"providerCredentials\"->>'mpUserId' AS mp_user, \"providerCredentials\"->>'expiresAt' AS expires, \"providerCredentials\"->>'publicKey' AS pk FROM \"EcommerceMerchant\" WHERE id='<merchantId>';"
  ```

  Expected: `providerMerchantId = 3414699907` (the test seller), `expires` ~180 days out, `publicKey` starts with `TEST-`.

  **If MP returned `invalid_client` on token exchange**: my hypothesis on `MP_CLIENT_SECRET` was wrong. Try alternatives:

  - The hex segment from inside the Access Token: `1e2a501e045734f8c99544185c5474e7`
  - Refresh the value from MP DevPanel → Credenciales de producción (may have been regenerated)

- [ ] **Step 6:** Generate a PaymentLink for the MP merchant Via dashboard, create a PaymentLink against this merchant. Open
      `pay.avoqado.io/<shortCode>` in incognito.

- [ ] **Step 7:** Pay with the Brick using a test card Frontend should render the MP Payment Brick (NOT redirect to MP). Use test card
      `APRO`: `5031 7557 3453 0604` (Mastercard), CVV `123`, expiry future, holder `APRO`.

- [ ] **Step 8:** Verify success Tail server logs:

  ```
  [MP brick pay] ... { paymentId: ..., status: 'approved' }
  [MP webhook] dispatched { result: { status: 'processed', ... } }
  ```

  DB:

  ```bash
  psql $DATABASE_URL -c "SELECT id, status, \"mpPaymentId\", \"mpMerchantOrderId\" FROM \"CheckoutSession\" WHERE id='cs_mp_xxx';"
  ```

  Expected: status `COMPLETED`, mpPaymentId set.

- [ ] **Step 9:** Verify webhook dedupe Resend the same IPN (use MP DevPanel "Simular notificación" with same x-request-id). Server logs
      should show: `{ status: 'duplicate' }`. DB: `SELECT COUNT(*) FROM "MercadoPagoWebhookEvent" WHERE "requestId" = '<id>';` → exactly 1.

- [ ] **Step 10:** Verify seller balance reflects amount minus fees Log in as MP_TEST_SELLER (`username` from .env) at mercadopago.com.mx.
      Open balance. Should show net = payment_amount − MP_commission − application_fee.

- [ ] **Step 11:** Document the smoke test outcome Append to this plan a `Smoke test results — <date>` section with screenshots and exact
      numbers (amount paid / MP commission / app fee / net to seller / payment ID).

---

## Self-Review Checklist

- [ ] All 31 tasks committed with passing tests
- [ ] `npm test -- mercado-pago` passes
- [ ] `npm test -- lib/token-encryption` passes
- [ ] `npm test -- google-calendar` STILL passes (regression check Task 4)
- [ ] `npm test -- paymentLink` passes including MP branch
- [ ] `npm run build` clean (both backend AND avoqado-checkout)
- [ ] `npm run lint:fix && npm run format` clean
- [ ] `npm run pre-deploy` passes
- [ ] No new files in repo root
- [ ] `.env.example` documents MP variables (no secrets)
- [ ] Webhook route mounted with `express.raw()` BEFORE `express.json()` in `app.ts`
- [ ] All Zod messages in Spanish
- [ ] No hardcoded venue names, slugs, or test user IDs in source
- [ ] OAuth state JWT validates AND state-vs-URL match check is present
- [ ] All OAuth endpoints (initiate / callback / disconnect) go through `getMercadoPagoMerchant`
- [ ] Money adapter `*100` / `/100` documented and applied at MP API call boundary
- [ ] CheckoutSession has `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` columns + indexes
- [ ] `MercadoPagoWebhookEvent` table exists with unique constraint
- [ ] Token refresh uses advisory lock keyed by venueId
- [ ] Bricks renders inline (no redirect to MP)
- [ ] `MercadoPagoBrickForm.tsx` exists in avoqado-checkout and CheckoutPage.tsx routes to it for MP-coded merchants

---

## Out of Scope (v3 explicitly defers these)

1. **Dashboard "Connect Mercado Pago" UI** — sidebar button, status badge, disconnect button. Lives in `avoqado-web-dashboard`. Separate
   plan.
2. **Reservation deposits via MP** — `reservation.consumer.service.ts` stays Stripe-only.
3. **Subscriptions / `/preapproval`** — recurring payments via MP not in v1.
4. **Split Payments 1:N** — multi-payee per transaction (requires MP commercial team approval).
5. **Encryption key rotation runbook** — `keyVersion: 1` field is reserved.
6. **Production cutover** — separate runbook gated on MP commercial OK + KYC nivel 6 on real merchants.
7. **Per-product fee schedule** — single `application_fee` per checkout in v3.
8. **MP Wallet token storage** — Bricks Wallet flow uses ephemeral tokens; no persistent customer cards in v3.

---

## Risks tracked

| Risk                                                                                | Mitigation                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MP_CLIENT_SECRET` hypothesis wrong (value taken from "Credenciales de producción") | Phase 11 Step 5 verifies. If `invalid_client`, fallback values documented (hex segment from Access Token).                     |
| MP webhook signature format changes                                                 | All signature logic isolated in `webhook.service.ts`. One place to update.                                                     |
| Token refresh fails silently                                                        | Job logs `errors` count; add BetterStack alerting on `summary.errors > 0`.                                                     |
| MP changes Bricks SDK shape                                                         | Pinned to `@mercadopago/sdk-react@^1`. Major version bumps require revisit.                                                    |
| OAuth callback can't extract venueId on production (CDN strips query?)              | JWT state is in query param `state` — standard OAuth pattern, well-tested infra.                                               |
| `paymentLink.service.ts` rename risk                                                | Function names preserved (`createStripeCheckoutForPaymentLink` stays — generalize as follow-up).                               |
| Multi-tab OAuth race                                                                | State JWT TTL = 10 min. Last-write-wins on `providerCredentials` (mitigated by tenant guard preventing cross-venue overwrite). |
| Sandbox MP user lacks KYC nivel 6                                                   | Test users are auto-KYC-6 in sandbox; document gating for prod merchants.                                                      |
| Frontend Brick `initMercadoPago` is module-level singleton                          | Documented: one publicKey per page load. Different sellers = different page = re-init. Acceptable for checkout flows.          |

---

## Execution Handoff

Two options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`.

**Phase 0-3 can run TODAY** (env validation, encryption helper, OAuth core, schema). All testable with mocks. Phase 11 (smoke test) is the
only thing gated on real MP/ngrok.

For implementing agents: read this entire file before starting Task 1. The architectural decisions are locked — do NOT propose alternatives
during execution. If a real blocker emerges, surface it explicitly with evidence rather than silently changing scope.
