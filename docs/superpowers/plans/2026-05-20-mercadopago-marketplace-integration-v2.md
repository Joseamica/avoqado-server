# Mercado Pago Marketplace (Split Payments) Integration Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes:** `docs/superpowers/plans/2026-05-19-mercadopago-marketplace-integration.md` (v1)

**Goal:** Add Mercado Pago as a third e-commerce payment provider alongside Stripe Connect and Blumon, using MP marketplace OAuth so payments settle directly in the merchant's MP account (preserving their negotiated rates) while Avoqado collects a configurable `marketplace_fee`. Dashboard exposes Mercado Pago as a new option alongside the existing providers.

**Architecture:** Mirror the existing `IEcommerceProvider` abstraction (`src/services/payments/providers/`). Each connected merchant is an `EcommerceMerchant` row with `providerId → PaymentProvider(code='MERCADO_PAGO')`. Seller OAuth `access_token`/`refresh_token` are AES-256-GCM encrypted (using a generalized `src/lib/token-encryption.ts` helper) and stored as base64 inside `EcommerceMerchant.providerCredentials` JSON. OAuth state is a JWT-signed envelope (reuse `OAUTH_STATE_SECRET`). Checkout Pro is the primary flow (MP-hosted page). Platform fee is set via `marketplace_fee` on `/checkout/preferences`. `paymentLink.service.ts` is generalized to support both `STRIPE_CONNECT` and `MERCADO_PAGO` so the existing public checkout flow handles MP.

**Tech Stack:**
- Backend: Node.js 20+, Express 4.x, TypeScript, Prisma 5.x, PostgreSQL
- New dep: `mercadopago@^2.x` (official SDK) for preferences/payments/refunds. Raw axios for OAuth.
- Crypto: `node:crypto` (AES-256-GCM), `jsonwebtoken` (HS256 state)
- Test: Jest 29 + `nock` for HTTP mocking
- Region: `MLM` (Mexico), currency `MXN`

---

## Changelog vs v1

These fixes came from `/codex` review of v1 + manual verification of every claim against the actual code. Each fix is annotated with the file/line evidence.

| # | v1 Bug | v2 Fix |
|---|---|---|
| 1 | **Money units bug** — v1 passed `params.amount` directly to MP API; callers pass Stripe centavos via `toStripeAmount` (`reservation.consumer.service.ts:113`, `paymentLink.service.ts:1766`), so MP would have been charged 100x. | Provider interface keeps centavos convention. MP provider divides `amount/100` and `marketplaceFee/100` at the MP API boundary (see Task 15). JSDoc on `CreateCheckoutParams.amount` explicitly documents "minor units". |
| 2 | **`getPaymentStatus` used preference ID where MP API wants payment ID** — v1 returned `preference.id` as the session ID and passed it to `GET /v1/payments/:id`. MP payment IDs only arrive via IPN. | `CheckoutSession` schema gains `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` columns. `getPaymentStatus` reads from DB; only hits MP API when `mpPaymentId` is set (Task 13, Task 20). |
| 3 | **Webhook handler was a stub** — v1 Task 19 left a `TODO Task-20: persist + dispatch` comment; Task 20 only mounted the route. | New `payment-flow.service.ts` (Task 17) fully implements the IPN handler: verify → dedupe → fetch payment → find session by `external_reference` → update DB. Webhook controller (Task 27) calls into it. |
| 4 | **Tenant isolation gap** — v1 `initiate`/`callback`/`disconnect` did not verify that `ecommerceMerchantId` belongs to the authenticated venue. Stripe DOES check (`stripeConnect.service.ts:16-37`). | New `merchant-guard.service.ts` (Task 9) provides `getMercadoPagoMerchant(venueId, merchantId)` mirror of Stripe's helper. All MP HTTP entry points use it. |
| 5 | **Token refresh race** — v1 `refreshIfExpiring` had no concurrency control. MP rotates refresh tokens; two concurrent refreshes can persist a stale token. | Per-venue PostgreSQL advisory lock (`pg_advisory_xact_lock`) around refresh (Task 12). |
| 6 | **Webhook signature on `body.data.id`** — MP signs against the `data.id` from the query param (lowercased if alphanumeric), not the JSON body. | Webhook controller (Task 19) reads `data.id` from query param first, falls back to body if absent. Lowercases alphanumeric IDs before HMAC. |
| 7 | **paymentLink.service.ts hardcoded `STRIPE_CONNECT`** — v1 added MP to the provider registry but lines 967, 1717 in `paymentLink.service.ts` throw `'Esta liga de pago no está configurada para Stripe Connect'` when provider is anything else. v1 never noticed. | Task 26 generalizes the provider check to accept `STRIPE_CONNECT` OR `MERCADO_PAGO`. Adds a `kind` switch in the hosted-vs-inline decision (line 874) to recognize `MERCADO_PAGO` as `STRIPE_HOSTED`-family (redirect-based). |
| 8 | **csrfNonce dead code** — v1 generated `csrfNonce` but never stored or verified it. | Removed. JWT signing of OAuth state already provides CSRF protection because `OAUTH_STATE_SECRET` is server-only. |
| 9 | **`providerCredentials` overwrite** — v1 `persistTokens` replaced the entire JSON, dropping any existing fields. Stripe merges (`stripe-connect.provider.ts:481`). | `persistTokens` merges (Task 10). |
| 10 | **Encryption helper duplicated** — v1 duplicated Google Calendar's `encryption.service.ts` with a new key env var. DRY violation. | Generalize into `src/lib/token-encryption.ts` parametrized by env var name (Task 2). Google Calendar refactored to use it (Task 3). Adds `keyVersion` field in credentials envelope for future rotation. |
| 11 | **No webhook deduplication** — v1 had no replay protection or duplicate-delivery handling. | New `MercadoPagoWebhookEvent` table with unique `(applicationId, dataId, requestId)` constraint (Task 14). Payment flow service checks dedupe before processing (Task 17). |
| 12 | **Routes under `/dashboard/integrations/mercadopago/oauth`** (global) — inconsistent with existing `/api/v1/dashboard/venues/:venueId/ecommerce-merchants` pattern. | Routes mounted under `/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth/...` (Task 29). |
| 13 | **`mercadopago` SDK never installed** — v1 used raw axios for everything despite stating the SDK was the standard approach. | Task 4 installs `mercadopago@^2.x`. Checkout, payment lookup, refund all use the SDK. OAuth still uses axios (SDK has no OAuth helpers). |
| 14 | **No `keyVersion` for encryption rotation** | Credentials envelope gains `keyVersion: 1`. Rotation runbook documented (out of v1 scope; documented decision deferred to follow-up). |
| 15 | **Reservation deposits ambiguous** — v1 didn't address whether MP supports `reservation.consumer.service.ts` deposits, which hardcode `STRIPE_CONNECT` (lines 44, 50, 108, 291, 457, 460). | Explicitly OUT OF SCOPE in v2. Reservation deposits stay Stripe-only. Generalizing reservations is a separate plan. |

---

## Pre-Plan Architectural Decisions (locked-in v2)

These were settled during planning + codex review. The implementing agent must NOT re-litigate:

| Decision | Choice | Rationale |
|---|---|---|
| Provider interface money unit | **Centavos** (existing convention, unchanged) | All current callers (`paymentLink.service.ts:1766`, `reservation.consumer.service.ts:113`) convert via `toStripeAmount` BEFORE invoking the provider. Changing the interface = touching 4+ callers + StripeConnectProvider. MP provider divides by 100 at its API boundary instead. |
| Token storage shape | `EcommerceMerchant.providerCredentials` JSON with base64-encoded encrypted bytes | Matches Blumon + Stripe Connect pattern. Zero new tables for the credential itself. |
| New columns on `CheckoutSession` | `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` (all nullable) | Needed because MP preference ID ≠ payment ID. v1 conflated them. |
| Dedupe table | New `MercadoPagoWebhookEvent` with unique `(applicationId, dataId, requestId)` | MP sends duplicate IPNs by design. Without dedupe we double-process payments. |
| Encryption | Generalized `src/lib/token-encryption.ts(envKeyName)` with `keyVersion: 1` in payload | DRY with Google Calendar. Future rotation path. |
| OAuth state | JWT (HS256) using `OAUTH_STATE_SECRET`. No separate csrfNonce. | Reuses existing pattern (Google Calendar). Stateless, 10-min TTL, CSRF baked in via server-only secret. |
| Webhook signature manifest | `id:<lowercased data.id>;request-id:<requestId>;ts:<ts>;`, HMAC SHA-256 with `MP_WEBHOOK_SECRET` | Per MP docs. `data.id` read from query param first, body fallback. Lowercased if alphanumeric. |
| Webhook replay window | Reject if `now - ts` > 5 minutes (300s) | MP docs recommend timestamp tolerance. Wide enough for clock skew, narrow enough to block replay. |
| Token refresh concurrency | PostgreSQL advisory lock keyed by `hashtextextended(venueId)` | Cron + on-demand can run concurrently; lock prevents stale refresh persistence. |
| Tenant guard | `getMercadoPagoMerchant(venueId, merchantId)` mirror of `getStripeConnectMerchant` | Same pattern, copy/paste with the code constant changed. |
| `paymentLink.service.ts` generalization | Add `MERCADO_PAGO` to the allowed provider list in lines 967, 1717. Add MP branch in the `STRIPE_HOSTED` vs `INLINE_CARD` decision (line 874). | MP is hosted-redirect (same family as Stripe Checkout). The "kind" enum doesn't need a new value, just MP added to the redirect family. |
| Route shape | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth/{connect,callback,disconnect}` | Matches existing venue-scoped pattern (`ecommerceMerchant.routes.ts`). |
| MP SDK | `mercadopago@^2.x` for `/checkout/preferences`, `/v1/payments/:id`, `/v1/payments/:id/refunds`. Raw axios for `/oauth/token`. | SDK handles MP-specific quirks (idempotency, error shapes, money types). OAuth not covered by SDK. |
| Sandbox vs prod | `EcommerceMerchant.sandboxMode` boolean (existing) | Mirrors Blumon. |
| Frontend dashboard UI | OUT OF SCOPE for this plan | Separate frontend plan. Backend ships first, dashboard wires up after smoke test passes. |
| Reservation deposits via MP | OUT OF SCOPE for v2 | `reservation.consumer.service.ts` stays `STRIPE_CONNECT`-only. Generalizing reservations is a follow-up plan. |
| 1:N split (multi-payee) | OUT OF SCOPE for v2 | Requires MP commercial team approval. v2 implements 1:1 (one seller, one marketplace fee). |
| KYC nivel 6 enforcement | Documented gate in smoke test + onboarding-status string `KYC_INSUFFICIENT` | Backend doesn't gate automatically (MP returns API errors); UX surfaces it via `onboardingStatus`. |

---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/lib/token-encryption.ts` | Generalized AES-256-GCM helper, parameterized by env var name. Returns `{ encrypt, decrypt, encryptToBase64, decryptFromBase64 }`. |
| `src/services/mercado-pago/oauth.service.ts` | Pure helpers: `signState`, `verifyState`, `buildAuthUrl`, `exchangeCodeForTokens`, `refreshAccessToken` (raw axios). |
| `src/services/mercado-pago/connection.service.ts` | `persistTokens` (MERGE), `loadCredentials`, `clearCredentials`, `refreshIfExpiring` (with advisory lock). |
| `src/services/mercado-pago/checkout.service.ts` | Wraps MP SDK's `createPreference` (with `marketplace_fee`), `getPayment`, `refundPayment`. Money adapter (centavos→MXN) at this boundary. |
| `src/services/mercado-pago/webhook.service.ts` | HMAC signature verification (query-param `data.id`, lowercased, timestamp tolerance). |
| `src/services/mercado-pago/payment-flow.service.ts` | IPN handler: dedupe via `MercadoPagoWebhookEvent` → fetch payment from MP → find `CheckoutSession` by `external_reference` → update `mpPaymentId`, `status`, link to `Payment`. |
| `src/services/mercado-pago/merchant-guard.service.ts` | `getMercadoPagoMerchant(venueId, merchantId)` — tenant + provider-code guard. |
| `src/services/mercado-pago/types.ts` | `MercadoPagoCredentials` envelope (with `keyVersion`), `MercadoPagoOAuthState`, `MercadoPagoTokenResponse`, `MercadoPagoWebhookPayload`. |
| `src/services/payments/providers/mercado-pago.provider.ts` | Implements `IEcommerceProvider`. Uses `merchant-guard` (via service callers), `connection.service`, `checkout.service`, `payment-flow.service`. |
| `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` | `initiate`, `callback`, `disconnect` — each goes through tenant guard. |
| `src/controllers/webhook/mercadoPago.webhook.controller.ts` | Verify signature → call `payment-flow.service.handleIpn`. |
| `src/routes/dashboard/mercadoPagoOAuth.routes.ts` | Express router. Mounted under `/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth/...`. |
| `src/schemas/dashboard/mercadoPagoOAuth.schema.ts` | Zod schemas (Spanish messages). |
| `src/jobs/mercadopago-token-refresh.job.ts` | Daily cron (3 AM Mexico City). Iterates MP merchants, calls `refreshIfExpiring` (which acquires advisory lock). |
| `prisma/migrations/<ts>_seed_mercado_pago_provider/migration.sql` | INSERT `PaymentProvider(code='MERCADO_PAGO')` for MX. |
| `prisma/migrations/<ts>_add_mp_fields_to_checkout_session/migration.sql` | ALTER `CheckoutSession` ADD `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId`. Indexes on `mpPaymentId` (unique) and `mpPreferenceId`. |
| `prisma/migrations/<ts>_add_mercadopago_webhook_event/migration.sql` | CREATE `MercadoPagoWebhookEvent` with unique `(applicationId, dataId, requestId)`. |
| All test files mirror the above (16 test files total). | |

### Files to modify

| Path | Change |
|---|---|
| `prisma/schema.prisma` | Add `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` fields to `CheckoutSession`. Add `MercadoPagoWebhookEvent` model. |
| `src/services/google-calendar/encryption.service.ts` | Re-export `createTokenCipher('GOOGLE_CALENDAR_TOKEN_KEY')` from the new generalized helper. Existing tests continue to pass. |
| `src/services/payments/provider-registry.ts` | Add `case 'MERCADO_PAGO': return new MercadoPagoProvider()`. |
| `src/services/payments/providers/provider.interface.ts` | Add JSDoc to `CreateCheckoutParams.amount` and `applicationFeeAmount`: "amount in minor units (centavos for MXN). Provider converts at API boundary if needed." |
| `src/services/dashboard/paymentLink.service.ts` | Lines 874, 967, 1717: change `=== 'STRIPE_CONNECT'` to `in ['STRIPE_CONNECT', 'MERCADO_PAGO']`. Update `payment.provider` literal at lines 1102, 1839 to use merchant.provider.code. |
| `src/routes/webhook.routes.ts` OR new mount in `src/app.ts` | Mount `/api/v1/webhooks/mercadopago` with `express.raw()` BEFORE `express.json()`. |
| Central dashboard router (search for `ecommerceMerchant.routes`) | Mount `mercadoPagoOAuth.routes` under venue-scoped path. |
| `src/config/env.ts` (or wherever Zod env validation lives) | Add `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `MP_WEBHOOK_SECRET`, `MERCADO_PAGO_TOKEN_KEY`, `MP_API_BASE_URL`, `MP_AUTH_BASE_URL`. |
| `tests/__helpers__/setup.ts` | Set the MP env vars + token key for tests. |
| `.env.example` | Document new MP variables. |
| `package.json` | Add `mercadopago@^2.x`. |

### Files explicitly NOT modified (out of scope for v2)

- `src/services/consumer/reservation.consumer.service.ts` — reservation deposits stay Stripe-only
- `src/services/dashboard/reservation.dashboard.service.ts` — refund path same
- `src/services/sdk/checkout-session.service.ts` — this is Blumon inline-card flow, not MP territory
- Any frontend dashboard file in `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`

---

## Phase 0 — Foundation: env, deps, generalized encryption

---

### Task 1: Add env vars and validation

**Files:**
- Modify: `src/config/env.ts` (locate via `grep -rln "STRIPE_SECRET_KEY" src/config/`)
- Modify: `.env.example`
- Modify: `tests/__helpers__/setup.ts`

- [ ] **Step 1: Locate env validation file**

Run: `grep -rln "STRIPE_SECRET_KEY" src/config/ src/ | head -3`
Use whichever single file emerges. Call it `<env-file>`.

- [ ] **Step 2: Add MP env var schema**

In `<env-file>`, add to the Zod schema:

```typescript
MP_CLIENT_ID: z.string().min(1, 'MP_CLIENT_ID es requerido').optional(),
MP_CLIENT_SECRET: z.string().min(1, 'MP_CLIENT_SECRET es requerido').optional(),
MP_REDIRECT_URI: z.string().url('MP_REDIRECT_URI debe ser una URL válida').optional(),
MP_WEBHOOK_SECRET: z.string().min(1, 'MP_WEBHOOK_SECRET es requerido').optional(),
MERCADO_PAGO_TOKEN_KEY: z.string().length(64, 'MERCADO_PAGO_TOKEN_KEY debe ser hex de 32 bytes (64 chars)').optional(),
MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
MP_AUTH_BASE_URL: z.string().url().default('https://auth.mercadopago.com.mx'),
```

Mark `.optional()` so dev environments without MP creds don't crash. Make required once GA.

- [ ] **Step 3: Update `.env.example`**

Append:

```bash
# Mercado Pago — Marketplace (Split Payments)
MP_CLIENT_ID=
MP_CLIENT_SECRET=
MP_REDIRECT_URI=http://localhost:3000/api/v1/dashboard/venues/<venueId>/ecommerce-merchants/<merchantId>/mercadopago/oauth/callback
MP_WEBHOOK_SECRET=
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MERCADO_PAGO_TOKEN_KEY=
# Optional overrides (defaults shown)
# MP_API_BASE_URL=https://api.mercadopago.com
# MP_AUTH_BASE_URL=https://auth.mercadopago.com.mx
```

- [ ] **Step 4: Update test setup**

In `tests/__helpers__/setup.ts`, add:

```typescript
process.env.MP_CLIENT_ID = 'test-mp-client-id'
process.env.MP_CLIENT_SECRET = 'test-mp-client-secret'
process.env.MP_REDIRECT_URI = 'http://localhost:3000/api/v1/dashboard/venues/v1/ecommerce-merchants/m1/mercadopago/oauth/callback'
process.env.MP_WEBHOOK_SECRET = 'test-mp-webhook-secret'
process.env.MERCADO_PAGO_TOKEN_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.MP_API_BASE_URL = 'https://api.mercadopago.com'
process.env.MP_AUTH_BASE_URL = 'https://auth.mercadopago.com.mx'
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret'
```

Memory `feedback_singleton_env_tests.md` — must set env vars HERE, not in test files.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example tests/__helpers__/setup.ts
git commit -m "feat(mercado-pago): add env vars for MP marketplace integration"
```

---

### Task 2: Generalized token encryption helper

**Files:**
- Create: `src/lib/token-encryption.ts`
- Create: `tests/unit/lib/token-encryption.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lib/token-encryption.test.ts`:

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
    const plaintext = 'same input'
    const a = cipher.encrypt(plaintext)
    const b = cipher.encrypt(plaintext)
    expect(a.equals(b)).toBe(false)
    expect(cipher.decrypt(a)).toBe(plaintext)
    expect(cipher.decrypt(b)).toBe(plaintext)
  })

  it('throws when authTag is tampered', () => {
    const blob = cipher.encrypt('secret')
    blob[15] = blob[15] ^ 0x01
    expect(() => cipher.decrypt(blob)).toThrow()
  })

  it('throws when the configured env key is wrong length', () => {
    const broken = createTokenCipher('NONEXISTENT_KEY')
    expect(() => broken.encrypt('x')).toThrow(/NONEXISTENT_KEY/)
  })

  it('base64 helpers roundtrip', () => {
    const plaintext = 'token-value'
    const b64 = cipher.encryptToBase64(plaintext)
    expect(typeof b64).toBe('string')
    expect(cipher.decryptFromBase64(b64)).toBe(plaintext)
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

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- tests/unit/lib/token-encryption.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/lib/token-encryption.ts`:

```typescript
/**
 * AES-256-GCM token encryption helper, parametrized by env var name.
 *
 * Stored layout (Buffer):
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Each consumer (Google Calendar, Mercado Pago, future OAuth integrations)
 * has its OWN key env var so leaks isolate per integration. Rotate keys
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

  return {
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
      return this.encrypt(plaintext).toString('base64')
    },
    decryptFromBase64(b64) {
      return this.decrypt(Buffer.from(b64, 'base64'))
    },
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/unit/lib/token-encryption.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/token-encryption.ts tests/unit/lib/token-encryption.test.ts
git commit -m "feat(lib): generalized AES-256-GCM token encryption helper"
```

---

### Task 3: Refactor Google Calendar to use generalized helper

**Files:**
- Modify: `src/services/google-calendar/encryption.service.ts`
- Run: existing Google Calendar tests

- [ ] **Step 1: Replace contents with thin re-export**

Replace `src/services/google-calendar/encryption.service.ts` entirely:

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

- [ ] **Step 2: Run Google Calendar tests to confirm no regression**

Run: `npm test -- tests/unit/services/google-calendar/`
Expected: all PASS (same suite that already exists).

- [ ] **Step 3: Run full test suite (defense in depth)**

Run: `npm test`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/google-calendar/encryption.service.ts
git commit -m "refactor(google-calendar): use generalized token encryption helper"
```

---

### Task 4: Install Mercado Pago SDK

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install**

Run: `npm install mercadopago@^2`

- [ ] **Step 2: Verify**

Run: `node -e "const mp = require('mercadopago'); console.log(typeof mp.MercadoPagoConfig, typeof mp.Preference, typeof mp.Payment)"`
Expected: `function function function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(mercado-pago): install mercadopago SDK v2"
```

---

### Task 5: Type definitions

**Files:**
- Create: `src/services/mercado-pago/types.ts`

- [ ] **Step 1: Create types**

Create `src/services/mercado-pago/types.ts`:

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
  /** MP user_id of the seller. Also mirrored to EcommerceMerchant.providerMerchantId. */
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

- [ ] **Step 2: Commit**

```bash
git add src/services/mercado-pago/types.ts
git commit -m "feat(mercado-pago): credentials envelope and API types"
```

---

## Phase 1 — OAuth core

---

### Task 6: OAuth state helpers (JWT signed)

**Files:**
- Create: `src/services/mercado-pago/oauth.service.ts` (state helpers only in this task)
- Create: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/services/mercado-pago/oauth.service.test.ts`:

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
    const t = signState(payload)
    const d = verifyState(t)
    expect(d.ecommerceMerchantId).toBe('em_abc')
    expect(d.venueId).toBe('v_1')
    expect(d.staffId).toBe('s_1')
    expect(d.intent).toBe('connect_merchant')
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

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 3: Implement state helpers**

Create `src/services/mercado-pago/oauth.service.ts`:

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

- [ ] **Step 4: Run, expect pass**

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): JWT-signed OAuth state helpers"
```

---

### Task 7: OAuth URL builder + code exchange + refresh

**Files:**
- Modify: `src/services/mercado-pago/oauth.service.ts`
- Modify: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1: Failing tests for URL, exchange, refresh**

Append to the existing test file:

```typescript
import nock from 'nock'
import { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from '@/services/mercado-pago/oauth.service'

describe('MP OAuth - buildAuthUrl', () => {
  it('uses configured auth host and required params', () => {
    const url = buildAuthUrl('state-jwt')
    const u = new URL(url)
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
      .post('/oauth/token', body =>
        body.client_id === 'test-mp-client-id' &&
        body.client_secret === 'test-mp-client-secret' &&
        body.grant_type === 'authorization_code' &&
        body.code === 'auth-code-123' &&
        body.redirect_uri === process.env.MP_REDIRECT_URI,
      )
      .reply(200, {
        access_token: 'APP_USR-access', token_type: 'bearer', expires_in: 15552000,
        scope: 'offline_access read write', user_id: 12345678, refresh_token: 'TG-refresh',
        public_key: 'pk', live_mode: false,
      })

    const t = await exchangeCodeForTokens('auth-code-123')
    expect(t.access_token).toBe('APP_USR-access')
    expect(t.user_id).toBe(12345678)
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
        access_token: 'NEW-access', token_type: 'bearer', expires_in: 15552000,
        scope: 's', user_id: 1, refresh_token: 'NEW-refresh', public_key: 'pk', live_mode: false,
      })
    const t = await refreshAccessToken('old')
    expect(t.access_token).toBe('NEW-access')
    expect(t.refresh_token).toBe('NEW-refresh')
  })
})
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement**

Append to `src/services/mercado-pago/oauth.service.ts`:

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

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): OAuth authorize URL + code exchange + token refresh"
```

---

### Task 8: Seed MERCADO_PAGO PaymentProvider row

**Files:**
- Create: `prisma/migrations/<ts>_seed_mercado_pago_provider/migration.sql`

- [ ] **Step 1: Create the migration**

Run: `npx prisma migrate dev --create-only --name seed_mercado_pago_provider`

- [ ] **Step 2: Fill SQL**

Edit the generated SQL:

```sql
INSERT INTO "PaymentProvider" (
  "id", "code", "name", "type", "countryCode", "active", "configSchema", "createdAt", "updatedAt"
) VALUES (
  'cmp_mercadopago_v2_seed',
  'MERCADO_PAGO',
  'Mercado Pago',
  'PAYMENT_PROCESSOR',
  ARRAY['MX'],
  true,
  '{
    "type": "object",
    "required": ["schemaVersion","keyVersion","mpUserId","accessTokenCiphertext","refreshTokenCiphertext","expiresAt"],
    "properties": {
      "schemaVersion": { "type": "integer", "const": 1 },
      "keyVersion":    { "type": "integer", "const": 1 },
      "mpUserId":      { "type": "string" },
      "accessTokenCiphertext":  { "type": "string" },
      "refreshTokenCiphertext": { "type": "string" },
      "expiresAt":      { "type": "string", "format": "date-time" },
      "scope":          { "type": "string" },
      "liveMode":       { "type": "boolean" },
      "lastRefreshedAt":{ "type": "string", "format": "date-time" }
    }
  }'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("code") DO NOTHING;
```

- [ ] **Step 3: Apply**

Run: `npx prisma migrate dev`

- [ ] **Step 4: Verify**

```bash
psql $DATABASE_URL -c "SELECT id, code, name, active FROM \"PaymentProvider\" WHERE code = 'MERCADO_PAGO';"
```
Expected: 1 row.

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(mercado-pago): seed MERCADO_PAGO PaymentProvider for MX"
```

---

## Phase 2 — Tenant guard + connection service

---

### Task 9: Tenant guard helper

**Files:**
- Create: `src/services/mercado-pago/merchant-guard.service.ts`
- Create: `tests/unit/services/mercado-pago/merchant-guard.service.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/services/mercado-pago/merchant-guard.service.test.ts`:

```typescript
import { getMercadoPagoMerchant } from '@/services/mercado-pago/merchant-guard.service'
import { NotFoundError, UnauthorizedError, BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { ecommerceMerchant: { findUnique: jest.fn() } },
}))
const mockPrisma = prisma as unknown as { ecommerceMerchant: { findUnique: jest.Mock } }

describe('getMercadoPagoMerchant', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns merchant when venue + provider match', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'v_1', provider: { code: 'MERCADO_PAGO' },
    })
    const m = await getMercadoPagoMerchant('v_1', 'em_1')
    expect(m.id).toBe('em_1')
  })

  it('throws NotFoundError when no merchant', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    await expect(getMercadoPagoMerchant('v_1', 'em_nope')).rejects.toThrow(NotFoundError)
  })

  it('throws UnauthorizedError when venue mismatches', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'OTHER_VENUE', provider: { code: 'MERCADO_PAGO' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(UnauthorizedError)
  })

  it('throws BadRequestError when provider is not MERCADO_PAGO', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'v_1', provider: { code: 'STRIPE_CONNECT' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(BadRequestError)
  })
})
```

- [ ] **Step 2: Implement**

Create `src/services/mercado-pago/merchant-guard.service.ts`:

```typescript
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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/merchant-guard.service.test.ts
git add src/services/mercado-pago/merchant-guard.service.ts tests/unit/services/mercado-pago/merchant-guard.service.test.ts
git commit -m "feat(mercado-pago): tenant guard helper mirrors Stripe Connect pattern"
```

---

### Task 10: Connection service — persistTokens (MERGE) + loadCredentials

**Files:**
- Create: `src/services/mercado-pago/connection.service.ts`
- Create: `tests/unit/services/mercado-pago/connection.service.test.ts`

- [ ] **Step 1: Failing tests**

Create `tests/unit/services/mercado-pago/connection.service.test.ts`:

```typescript
import { persistTokens, loadCredentials, clearCredentials } from '@/services/mercado-pago/connection.service'
import { createTokenCipher } from '@/lib/token-encryption'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: { findUnique: jest.fn(), update: jest.fn() },
  },
}))
const mockPrisma = prisma as unknown as { ecommerceMerchant: { findUnique: jest.Mock; update: jest.Mock } }
const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

const tokens = {
  access_token: 'APP_USR-access', refresh_token: 'TG-refresh',
  expires_in: 15552000, scope: 'offline_access read write',
  user_id: 12345678, token_type: 'bearer' as const, public_key: 'pk', live_mode: false,
}

describe('persistTokens', () => {
  beforeEach(() => jest.clearAllMocks())

  it('MERGES with existing providerCredentials (does not overwrite other keys)', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: { unrelatedField: 'keep-me', oldMpUserId: 'should-be-overwritten' },
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await persistTokens('em_1', tokens)

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const creds = updateArgs.data.providerCredentials
    expect(creds.unrelatedField).toBe('keep-me')        // preserved
    expect(creds.mpUserId).toBe('12345678')             // updated
    expect(creds.schemaVersion).toBe(1)
    expect(creds.keyVersion).toBe(1)
    expect(updateArgs.data.providerMerchantId).toBe('12345678')
    expect(cipher.decryptFromBase64(creds.accessTokenCiphertext)).toBe('APP_USR-access')
    expect(cipher.decryptFromBase64(creds.refreshTokenCiphertext)).toBe('TG-refresh')
  })
})

describe('loadCredentials', () => {
  it('returns null when credentials absent', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', providerCredentials: {} })
    expect(await loadCredentials('em_1')).toBeNull()
  })

  it('decrypts and returns credentials', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        schemaVersion: 1, keyVersion: 1,
        mpUserId: '12345678',
        accessTokenCiphertext: cipher.encryptToBase64('APP_USR-access'),
        refreshTokenCiphertext: cipher.encryptToBase64('TG-refresh'),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        scope: 'offline_access read write',
        liveMode: false,
      },
    })

    const r = await loadCredentials('em_1')
    expect(r).not.toBeNull()
    expect(r!.accessToken).toBe('APP_USR-access')
    expect(r!.refreshToken).toBe('TG-refresh')
  })
})

describe('clearCredentials', () => {
  it('clears MP fields, keeps unrelated', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: { unrelatedField: 'keep-me', mpUserId: '1', accessTokenCiphertext: 'x' },
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({})

    await clearCredentials('em_1')

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    expect(updateArgs.data.providerCredentials.unrelatedField).toBe('keep-me')
    expect(updateArgs.data.providerCredentials.mpUserId).toBeUndefined()
    expect(updateArgs.data.providerCredentials.accessTokenCiphertext).toBeUndefined()
    expect(updateArgs.data.providerMerchantId).toBeNull()
  })
})
```

- [ ] **Step 2: Implement**

Create `src/services/mercado-pago/connection.service.ts`:

```typescript
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
}

const MP_KEYS = [
  'schemaVersion', 'keyVersion', 'mpUserId',
  'accessTokenCiphertext', 'refreshTokenCiphertext',
  'expiresAt', 'scope', 'liveMode', 'lastRefreshedAt',
]

function readJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/connection.service.test.ts
git add src/services/mercado-pago/connection.service.ts tests/unit/services/mercado-pago/connection.service.test.ts
git commit -m "feat(mercado-pago): connection service with MERGE persistence + clear"
```

---

### Task 11: Connection service — refreshIfExpiring with advisory lock

**Files:**
- Modify: `src/services/mercado-pago/connection.service.ts`
- Modify: `tests/unit/services/mercado-pago/connection.service.test.ts`

- [ ] **Step 1: Failing tests**

Append:

```typescript
import { refreshIfExpiring } from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'

jest.mock('@/services/mercado-pago/oauth.service')

describe('refreshIfExpiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // jest.mock the advisory-lock helper
    ;(prisma as any).$queryRaw = jest.fn().mockResolvedValue([])
    ;(prisma as any).$executeRaw = jest.fn().mockResolvedValue(1)
  })

  it('refreshes when expiry is within threshold', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'v_1',
      providerCredentials: {
        schemaVersion: 1, keyVersion: 1, mpUserId: '1',
        accessTokenCiphertext: cipher.encryptToBase64('OLD'),
        refreshTokenCiphertext: cipher.encryptToBase64('OLD-r'),
        expiresAt: new Date(Date.now() + 10 * 86400_000).toISOString(),
        scope: 's', liveMode: false,
      },
    })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'NEW', refresh_token: 'NEW-r', user_id: 1,
      expires_in: 15552000, scope: 's', token_type: 'bearer', public_key: 'pk', live_mode: false,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({})

    const r = await refreshIfExpiring('em_1', 30)
    expect(r).toBe('refreshed')
    expect(oauthService.refreshAccessToken).toHaveBeenCalledWith('OLD-r')
  })

  it('skips when token has plenty of life', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'v_1',
      providerCredentials: {
        schemaVersion: 1, keyVersion: 1, mpUserId: '1',
        accessTokenCiphertext: cipher.encryptToBase64('a'),
        refreshTokenCiphertext: cipher.encryptToBase64('r'),
        expiresAt: new Date(Date.now() + 100 * 86400_000).toISOString(),
        scope: 's', liveMode: false,
      },
    })
    expect(await refreshIfExpiring('em_1', 30)).toBe('not_needed')
    expect(oauthService.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns no_credentials when merchant has none', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', venueId: 'v_1', providerCredentials: {} })
    expect(await refreshIfExpiring('em_1', 30)).toBe('no_credentials')
  })

  it('acquires per-venue advisory lock during refresh', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1', venueId: 'v_1',
      providerCredentials: {
        schemaVersion: 1, keyVersion: 1, mpUserId: '1',
        accessTokenCiphertext: cipher.encryptToBase64('a'),
        refreshTokenCiphertext: cipher.encryptToBase64('r'),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        scope: 's', liveMode: false,
      },
    })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'N', refresh_token: 'NR', user_id: 1,
      expires_in: 15552000, scope: 's', token_type: 'bearer', public_key: 'pk', live_mode: false,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({})

    await refreshIfExpiring('em_1', 30)
    expect((prisma as any).$transaction).toBeDefined()
  })
})
```

- [ ] **Step 2: Implement (advisory lock)**

Append to `src/services/mercado-pago/connection.service.ts`:

```typescript
import { refreshAccessToken } from './oauth.service'

export type RefreshResult = 'refreshed' | 'not_needed' | 'no_credentials' | 'merchant_not_found'

export async function refreshIfExpiring(ecommerceMerchantId: string, thresholdDays = 30): Promise<RefreshResult> {
  // Use a single transaction with an advisory lock keyed by venueId so that
  // (a) the cron and on-demand refresh don't race, and (b) the lock is
  // automatically released when the transaction commits or rolls back.
  return prisma.$transaction(async tx => {
    const merchant = await tx.ecommerceMerchant.findUnique({
      where: { id: ecommerceMerchantId },
      select: { id: true, venueId: true, providerCredentials: true },
    })
    if (!merchant) return 'merchant_not_found' as const

    // pg_advisory_xact_lock takes a bigint. Hash the venueId into 8 bytes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${merchant.venueId}, 0))`

    const credentials = merchant.providerCredentials as unknown as MercadoPagoCredentials | null
    if (!credentials?.refreshTokenCiphertext) return 'no_credentials' as const

    const expiresAt = new Date(credentials.expiresAt)
    const thresholdMs = thresholdDays * 86400_000
    if (expiresAt.getTime() - Date.now() > thresholdMs) return 'not_needed' as const

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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/connection.service.test.ts
git add src/services/mercado-pago/connection.service.ts tests/unit/services/mercado-pago/connection.service.test.ts
git commit -m "feat(mercado-pago): refresh with per-venue advisory lock"
```

---

## Phase 3 — Schema changes (CheckoutSession + webhook dedupe)

---

### Task 12: Add MP fields to CheckoutSession

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_mp_fields_to_checkout_session/migration.sql`

- [ ] **Step 1: Edit `prisma/schema.prisma`**

In `model CheckoutSession`, add the new columns after `applicationFeeCents`:

```prisma
  // Mercado Pago fields (only set when provider = MERCADO_PAGO)
  /// MP preference.id from POST /checkout/preferences. Set at session creation.
  mpPreferenceId       String? @unique
  /// MP payment.id received via IPN. Set when buyer completes payment.
  mpPaymentId          String? @unique
  /// MP merchant_order.id. Useful for reconciling preference → payments.
  mpMerchantOrderId    String?
```

And inside `@@index([paymentLinkId])` block (top-level indices), add:

```prisma
  @@index([mpPreferenceId])
  @@index([mpPaymentId])
  @@index([mpMerchantOrderId])
```

- [ ] **Step 2: Generate migration**

Run: `npx prisma migrate dev --name add_mp_fields_to_checkout_session`

- [ ] **Step 3: Inspect SQL, confirm ADD COLUMN + indexes**

Verify SQL has 3 `ADD COLUMN` and 3 `CREATE INDEX`.

- [ ] **Step 4: Apply + commit**

```bash
npx prisma generate
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(mercado-pago): add MP fields to CheckoutSession"
```

---

### Task 13: Add MercadoPagoWebhookEvent dedupe table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_mercadopago_webhook_event/migration.sql`

- [ ] **Step 1: Add model to schema**

Append to `prisma/schema.prisma`:

```prisma
/// Dedupe table for Mercado Pago IPN webhooks. MP sends duplicate deliveries
/// for the same event; unique constraint on (mpUserId, dataId, requestId)
/// guarantees we only process each event once.
model MercadoPagoWebhookEvent {
  id          String   @id @default(cuid())
  /// MP seller user_id who owns the resource that triggered the event.
  mpUserId    String
  /// data.id from the IPN payload (payment id, merchant_order id, etc.)
  dataId      String
  /// x-request-id header from MP.
  requestId   String
  /// IPN payload `type` (typically "payment").
  eventType   String
  /// IPN `action` (e.g. "payment.created", "payment.updated").
  action      String
  /// Full raw payload, kept for forensics.
  payload     Json
  /// Outcome of our processing: "processed", "ignored", "error".
  processingStatus String
  /// Optional error message if processing failed.
  errorMessage String?
  createdAt   DateTime @default(now())

  @@unique([mpUserId, dataId, requestId])
  @@index([dataId])
  @@index([createdAt])
}
```

- [ ] **Step 2: Generate migration**

Run: `npx prisma migrate dev --name add_mercadopago_webhook_event`

- [ ] **Step 3: Verify**

```bash
psql $DATABASE_URL -c "\d \"MercadoPagoWebhookEvent\""
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(mercado-pago): webhook event dedupe table"
```

---

## Phase 4 — Checkout, payment lookup, refund (using MP SDK)

---

### Task 14: Checkout service — createPreference with money adapter

**Files:**
- Create: `src/services/mercado-pago/checkout.service.ts`
- Create: `tests/unit/services/mercado-pago/checkout.service.test.ts`

- [ ] **Step 1: Failing tests (with money adapter assertion)**

Create `tests/unit/services/mercado-pago/checkout.service.test.ts`:

```typescript
import nock from 'nock'
import { createPreference } from '@/services/mercado-pago/checkout.service'

describe('createPreference — money adapter (centavos→MXN)', () => {
  beforeEach(() => nock.cleanAll())

  it('divides amount and marketplaceFee by 100 at the MP boundary', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER' } })
      .post('/checkout/preferences', body => {
        // 100000 cents = 1000.00 MXN
        expect(body.items[0].unit_price).toBe(1000)
        // 5000 cents = 50.00 MXN
        expect(body.marketplace_fee).toBe(50)
        expect(body.items[0].currency_id).toBe('MXN')
        expect(body.external_reference).toBe('order_123')
        expect(body.notification_url).toBe('https://api.example.com/api/v1/webhooks/mercadopago')
        return true
      })
      .reply(200, {
        id: 'pref_abc',
        init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc',
        sandbox_init_point: 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc',
      })

    const out = await createPreference({
      accessToken: 'SELLER', sandboxMode: false,
      orderId: 'order_123', amountCents: 100000, marketplaceFeeCents: 5000,
      currency: 'MXN', description: 'Sesión yoga', payerEmail: 'b@x.com',
      successUrl: 'https://a/s', failureUrl: 'https://a/f', pendingUrl: 'https://a/p',
      notificationUrl: 'https://api.example.com/api/v1/webhooks/mercadopago',
    })
    expect(out.id).toBe('pref_abc')
    expect(out.url).toBe('https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc')
  })

  it('uses sandbox_init_point when sandboxMode=true', async () => {
    nock('https://api.mercadopago.com').post('/checkout/preferences').reply(200, {
      id: 'p', init_point: 'https://prod/p', sandbox_init_point: 'https://sand/p',
    })
    const out = await createPreference({
      accessToken: 'S', sandboxMode: true, orderId: 'o', amountCents: 1000, marketplaceFeeCents: 0,
      currency: 'MXN', description: 'd', successUrl: 'a', failureUrl: 'b', pendingUrl: 'c', notificationUrl: 'd',
    })
    expect(out.url).toBe('https://sand/p')
  })
})
```

- [ ] **Step 2: Implement (with SDK)**

Create `src/services/mercado-pago/checkout.service.ts`:

```typescript
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago'

const API_BASE = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'

function buildClient(accessToken: string): MercadoPagoConfig {
  return new MercadoPagoConfig({ accessToken, options: { timeout: 15000 } })
}

export interface CreatePreferenceParams {
  accessToken: string
  sandboxMode: boolean
  orderId: string
  /** Amount in minor units (centavos for MXN). Adapter divides by 100 here. */
  amountCents: number
  /** Marketplace fee in minor units (centavos for MXN). */
  marketplaceFeeCents: number
  currency: string
  description: string
  payerEmail?: string
  successUrl: string
  failureUrl: string
  pendingUrl: string
  notificationUrl: string
}

export interface PreferenceResult {
  id: string
  initPoint: string
  sandboxInitPoint: string
  url: string
}

export async function createPreference(p: CreatePreferenceParams): Promise<PreferenceResult> {
  const client = buildClient(p.accessToken)
  const pref = new Preference(client)
  const amountMxn = p.amountCents / 100
  const feeMxn = p.marketplaceFeeCents / 100

  const result = await pref.create({
    body: {
      items: [{
        id: p.orderId,
        title: p.description,
        quantity: 1,
        unit_price: amountMxn,
        currency_id: p.currency,
      }],
      external_reference: p.orderId,
      marketplace_fee: feeMxn,
      payer: p.payerEmail ? { email: p.payerEmail } : undefined,
      back_urls: { success: p.successUrl, failure: p.failureUrl, pending: p.pendingUrl },
      auto_return: 'approved',
      notification_url: p.notificationUrl,
    },
  })

  return {
    id: result.id!,
    initPoint: result.init_point!,
    sandboxInitPoint: result.sandbox_init_point!,
    url: p.sandboxMode ? result.sandbox_init_point! : result.init_point!,
  }
}
```

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts
git add src/services/mercado-pago/checkout.service.ts tests/unit/services/mercado-pago/checkout.service.test.ts
git commit -m "feat(mercado-pago): createPreference using SDK with money adapter (cents→MXN)"
```

---

### Task 15: Checkout service — getPayment + refundPayment

**Files:**
- Modify: `src/services/mercado-pago/checkout.service.ts`
- Modify: `tests/unit/services/mercado-pago/checkout.service.test.ts`

- [ ] **Step 1: Failing tests**

Append:

```typescript
import { getPayment, refundPayment } from '@/services/mercado-pago/checkout.service'

describe('getPayment', () => {
  beforeEach(() => nock.cleanAll())
  it('fetches /v1/payments/:id', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER' } })
      .get('/v1/payments/9999')
      .reply(200, {
        id: 9999, status: 'approved', status_detail: 'accredited',
        external_reference: 'order_123', transaction_amount: 1000,
        currency_id: 'MXN', date_approved: '2026-05-20T10:00:00Z',
        date_created: '2026-05-20T09:55:00Z',
        fee_details: [], marketplace_fee: 50,
        order: { id: 7777 },
      })
    const p = await getPayment('SELLER', '9999')
    expect(p.id).toBe(9999)
    expect(p.status).toBe('approved')
    expect(p.external_reference).toBe('order_123')
  })
})

describe('refundPayment', () => {
  beforeEach(() => nock.cleanAll())
  it('partial refund with amount + idempotency key', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER' } })
      .post('/v1/payments/9999/refunds', body => body.amount === 250)
      .matchHeader('x-idempotency-key', 'idem-1')
      .reply(201, { id: 1, payment_id: 9999, amount: 250, status: 'approved' })
    const r = await refundPayment({ accessToken: 'SELLER', paymentId: '9999', amount: 250, idempotencyKey: 'idem-1' })
    expect(r.amount).toBe(250)
    expect(r.status).toBe('approved')
  })

  it('full refund without amount', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments/9999/refunds', body => !body || Object.keys(body).length === 0)
      .matchHeader('x-idempotency-key', 'idem-2')
      .reply(201, { id: 2, payment_id: 9999, amount: 1000, status: 'approved' })
    const r = await refundPayment({ accessToken: 'SELLER', paymentId: '9999', idempotencyKey: 'idem-2' })
    expect(r.amount).toBe(1000)
  })
})
```

- [ ] **Step 2: Implement**

Append to `src/services/mercado-pago/checkout.service.ts`:

```typescript
import axios, { AxiosError } from 'axios'

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
  marketplace_fee?: number
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
  /** Omit for full refund. Provide in MXN (decimal) for partial. */
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
        'x-idempotency-key': p.idempotencyKey,
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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts
git add src/services/mercado-pago/checkout.service.ts tests/unit/services/mercado-pago/checkout.service.test.ts
git commit -m "feat(mercado-pago): getPayment + refundPayment (idempotent, bearer auth)"
```

---

## Phase 5 — Webhook verification + payment flow

---

### Task 16: Webhook signature verification (query data.id, lowercased, timestamp tolerance)

**Files:**
- Create: `src/services/mercado-pago/webhook.service.ts`
- Create: `tests/unit/services/mercado-pago/webhook.service.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/services/mercado-pago/webhook.service.test.ts`:

```typescript
import crypto from 'crypto'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'

const SECRET = process.env.MP_WEBHOOK_SECRET!

function buildSig(ts: string, requestId: string, dataId: string): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
  return `ts=${ts},v1=${v1}`
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature using query data.id', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = buildSig(ts, 'req-1', 'pay_abc')
    expect(() =>
      verifyWebhookSignature({ signature: sig, requestId: 'req-1', queryDataId: 'pay_abc', bodyDataId: null }),
    ).not.toThrow()
  })

  it('lowercases alphanumeric data.id before HMAC', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = buildSig(ts, 'req-1', 'PAY_ABC')   // upper in MP query? still lowercased here
    // Note buildSig already lowercases; pass uppercase as queryDataId
    expect(() =>
      verifyWebhookSignature({ signature: sig, requestId: 'req-1', queryDataId: 'PAY_ABC', bodyDataId: null }),
    ).not.toThrow()
  })

  it('falls back to body data.id when query absent', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = buildSig(ts, 'req-1', 'pay_xyz')
    expect(() =>
      verifyWebhookSignature({ signature: sig, requestId: 'req-1', queryDataId: null, bodyDataId: 'pay_xyz' }),
    ).not.toThrow()
  })

  it('rejects when timestamp is stale beyond tolerance (>300s)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 400)
    const sig = buildSig(stale, 'req-1', 'pay_x')
    expect(() =>
      verifyWebhookSignature({ signature: sig, requestId: 'req-1', queryDataId: 'pay_x', bodyDataId: null }),
    ).toThrow(/stale|tolerance|replay/i)
  })

  it('rejects invalid signature', () => {
    expect(() =>
      verifyWebhookSignature({ signature: 'ts=1700000000,v1=deadbeef', requestId: 'r', queryDataId: 'x', bodyDataId: null }),
    ).toThrow(/invalid/i)
  })

  it('rejects malformed header', () => {
    expect(() =>
      verifyWebhookSignature({ signature: 'garbage', requestId: 'r', queryDataId: 'x', bodyDataId: null }),
    ).toThrow(/malformed/i)
  })
})
```

- [ ] **Step 2: Implement**

Create `src/services/mercado-pago/webhook.service.ts`:

```typescript
import crypto from 'crypto'

const TOLERANCE_SECONDS = 300

export interface VerifyWebhookSignatureParams {
  /** Value of x-signature header */
  signature: string
  /** Value of x-request-id header */
  requestId: string
  /** data.id from query param (preferred per MP docs) */
  queryDataId: string | null
  /** data.id from JSON body (fallback) */
  bodyDataId: string | null
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

  // Lowercase the data.id (MP signs against lowercase form for alphanumeric IDs)
  const dataId = rawDataId.toLowerCase()
  const manifest = `id:${dataId};request-id:${p.requestId};ts:${ts};`
  const expected = crypto.createHmac('sha256', requireSecret()).update(manifest).digest('hex')

  if (!crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('invalid MP webhook signature')
  }
}
```

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/webhook.service.test.ts
git add src/services/mercado-pago/webhook.service.ts tests/unit/services/mercado-pago/webhook.service.test.ts
git commit -m "feat(mercado-pago): webhook signature verification (query data.id, replay window)"
```

---

### Task 17: Payment-flow service (dedupe → fetch → update DB)

**Files:**
- Create: `src/services/mercado-pago/payment-flow.service.ts`
- Create: `tests/unit/services/mercado-pago/payment-flow.service.test.ts`

- [ ] **Step 1: Failing test (skeleton — happy path + dedupe)**

Create `tests/unit/services/mercado-pago/payment-flow.service.test.ts`:

```typescript
import { handleIpn } from '@/services/mercado-pago/payment-flow.service'
import prisma from '@/utils/prismaClient'
import * as checkoutService from '@/services/mercado-pago/checkout.service'
import * as connectionService from '@/services/mercado-pago/connection.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    mercadoPagoWebhookEvent: { create: jest.fn(), findUnique: jest.fn() },
    ecommerceMerchant: { findFirst: jest.fn() },
    checkoutSession: { findFirst: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  },
}))
jest.mock('@/services/mercado-pago/checkout.service')
jest.mock('@/services/mercado-pago/connection.service')

const m = prisma as unknown as any

describe('handleIpn — happy path payment.updated', () => {
  beforeEach(() => jest.clearAllMocks())

  it('dedupes, fetches, finds session, updates', async () => {
    m.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    m.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', sandboxMode: false })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'SELLER' })
    ;(checkoutService.getPayment as jest.Mock).mockResolvedValue({
      id: 9999, status: 'approved', external_reference: 'order_123',
      transaction_amount: 1000, currency_id: 'MXN', date_approved: new Date().toISOString(),
      order: { id: 7777 }, marketplace_fee: 50, fee_details: [],
    })
    m.checkoutSession.findFirst.mockResolvedValue({ id: 'cs_1', mpPaymentId: null, status: 'PENDING' })
    m.checkoutSession.update.mockResolvedValue({ id: 'cs_1' })

    await handleIpn({
      payload: { type: 'payment', action: 'payment.updated', data: { id: '9999' }, user_id: 12345678, id: 1, live_mode: false, date_created: 't', api_version: 'v1' },
      requestId: 'req-1',
    })

    expect(m.mercadoPagoWebhookEvent.create).toHaveBeenCalled()
    expect(checkoutService.getPayment).toHaveBeenCalledWith('SELLER', '9999')
    expect(m.checkoutSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'cs_1' },
      data: expect.objectContaining({ mpPaymentId: '9999', mpMerchantOrderId: '7777', status: 'COMPLETED' }),
    }))
  })

  it('returns ignored on duplicate (P key violation handled)', async () => {
    const dupErr: any = new Error('Unique constraint failed')
    dupErr.code = 'P2002'
    m.mercadoPagoWebhookEvent.create.mockRejectedValue(dupErr)
    await expect(handleIpn({
      payload: { type: 'payment', action: 'payment.updated', data: { id: '9999' }, user_id: 1, id: 1, live_mode: false, date_created: 't', api_version: 'v1' },
      requestId: 'req-1',
    })).resolves.toEqual({ status: 'duplicate' })
  })
})
```

- [ ] **Step 2: Implement**

Create `src/services/mercado-pago/payment-flow.service.ts`:

```typescript
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { getPayment } from './checkout.service'
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

function mpToCheckoutStatus(mpStatus: string): 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  switch (mpStatus) {
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

  // 1. Dedupe insert (uses unique constraint as the atomic check)
  try {
    await prisma.mercadoPagoWebhookEvent.create({
      data: {
        mpUserId, dataId, requestId: p.requestId,
        eventType, action, payload: p.payload as unknown as any,
        processingStatus: 'pending',
      },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') return { status: 'duplicate' }
    throw err
  }

  if (eventType !== 'payment') {
    await markEventStatus(mpUserId, dataId, p.requestId, 'ignored', `unsupported event type ${eventType}`)
    return { status: 'ignored', reason: `unsupported event type ${eventType}` }
  }

  // 2. Resolve the seller's merchant + access token
  const merchant = await prisma.ecommerceMerchant.findFirst({
    where: { providerMerchantId: mpUserId, provider: { code: 'MERCADO_PAGO' } },
  })
  if (!merchant) {
    await markEventStatus(mpUserId, dataId, p.requestId, 'error', `no merchant matches mpUserId ${mpUserId}`)
    return { status: 'error', reason: 'merchant_not_found' }
  }

  const creds = await loadCredentials(merchant.id)
  if (!creds) {
    await markEventStatus(mpUserId, dataId, p.requestId, 'error', 'merchant credentials missing')
    return { status: 'error', reason: 'credentials_missing' }
  }

  // 3. Fetch payment from MP
  let payment
  try {
    payment = await getPayment(creds.accessToken, dataId)
  } catch (err: any) {
    await markEventStatus(mpUserId, dataId, p.requestId, 'error', err.message)
    return { status: 'error', reason: 'fetch_failed' }
  }

  // 4. Find CheckoutSession by external_reference (orderId)
  const externalRef = payment.external_reference
  if (!externalRef) {
    await markEventStatus(mpUserId, dataId, p.requestId, 'ignored', 'no external_reference')
    return { status: 'ignored', reason: 'no_external_reference' }
  }

  const session = await prisma.checkoutSession.findFirst({
    where: { externalOrderId: externalRef, ecommerceMerchantId: merchant.id },
  })
  if (!session) {
    await markEventStatus(mpUserId, dataId, p.requestId, 'ignored', `no session for orderId ${externalRef}`)
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

  await markEventStatus(mpUserId, dataId, p.requestId, 'processed', null)
  logger.info({ checkoutSessionId: session.id, paymentId: payment.id, status: payment.status }, '[MP] IPN processed')

  return { status: 'processed', checkoutSessionId: session.id, paymentId: String(payment.id) }
}

async function markEventStatus(
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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/services/mercado-pago/payment-flow.service.test.ts
git add src/services/mercado-pago/payment-flow.service.ts tests/unit/services/mercado-pago/payment-flow.service.test.ts
git commit -m "feat(mercado-pago): IPN payment-flow service (dedupe → fetch → update DB)"
```

---

## Phase 6 — Provider implementation + registry

---

### Task 18: MercadoPagoProvider class + registry wiring

**Files:**
- Create: `src/services/payments/providers/mercado-pago.provider.ts`
- Modify: `src/services/payments/provider-registry.ts`
- Create: `tests/unit/services/payments/providers/mercado-pago.provider.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { getProvider } from '@/services/payments/provider-registry'
import { MercadoPagoProvider } from '@/services/payments/providers/mercado-pago.provider'

describe('provider registry', () => {
  it('returns MercadoPagoProvider for MERCADO_PAGO', () => {
    const merchant = {
      id: 'em_1', providerCredentials: {}, sandboxMode: true,
      provider: { code: 'MERCADO_PAGO' },
    } as any
    expect(getProvider(merchant)).toBeInstanceOf(MercadoPagoProvider)
  })
})
```

- [ ] **Step 2: Implement provider**

Create `src/services/payments/providers/mercado-pago.provider.ts`:

```typescript
import { BadRequestError } from '@/errors/AppError'
import { ProviderCapabilityError } from './not-implemented.error'
import * as connectionService from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as checkoutService from '@/services/mercado-pago/checkout.service'
import prisma from '@/utils/prismaClient'
import type {
  AuthorizeCardPaymentParams, AuthorizeCardPaymentResult,
  CheckoutSession, CreateCheckoutParams, EcommerceMerchantWithProvider,
  IEcommerceProvider, OnboardingLink, OnboardingStatus, PaymentStatus,
  RefundParams, RefundResult, TokenizeCardParams, TokenizeCardResult,
  VerifiedWebhookEvent,
} from './provider.interface'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

const PROVIDER_CODE = 'MERCADO_PAGO'

export class MercadoPagoProvider implements IEcommerceProvider {
  async createOnboardingLink(merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink> {
    if (!merchant.venueId) throw new BadRequestError('venueId es requerido para conectar Mercado Pago')
    const state = oauthService.signState({
      intent: 'connect_merchant',
      ecommerceMerchantId: merchant.id,
      venueId: merchant.venueId,
      // staffId is set by the controller via merchant-guard; provider gets a placeholder
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
      chargesEnabled: !expired, payoutsEnabled: !expired,
      requirementsDue: expired ? ['token_expired'] : [],
      disabledReason: expired ? 'token_expired' : null,
    }
  }

  async createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')

    if (params.amount <= 0) throw new BadRequestError('El monto de pago debe ser mayor a cero')
    if (params.applicationFeeAmount < 0 || params.applicationFeeAmount > params.amount) {
      throw new BadRequestError('La comisión de plataforma no puede exceder el monto de pago')
    }

    const orderId = params.metadata.orderId || params.idempotencyKey
    const preference = await checkoutService.createPreference({
      accessToken: creds.accessToken,
      sandboxMode: merchant.sandboxMode,
      orderId,
      amountCents: params.amount,
      marketplaceFeeCents: params.applicationFeeAmount,
      currency: params.currency.toUpperCase(),
      description: params.description,
      payerEmail: params.customerEmail,
      successUrl: params.successUrl,
      failureUrl: params.cancelUrl,
      pendingUrl: params.cancelUrl,
      notificationUrl: process.env.MP_WEBHOOK_NOTIFICATION_URL || `${process.env.PUBLIC_API_URL}/api/v1/webhooks/mercadopago`,
    })

    // Persist mpPreferenceId on the CheckoutSession (the caller has already created it
    // with our generated `id` matching params.idempotencyKey; if not, the caller updates).
    return { id: preference.id, url: preference.url, expiresAt: params.expiresAt }
  }

  async getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus> {
    // sessionId here is our internal CheckoutSession.id (NOT preference.id).
    // Read mpPaymentId from DB; only hit MP API if we have one.
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      select: { mpPaymentId: true, status: true, completedAt: true, amount: true },
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

    const payment = await checkoutService.getPayment(creds.accessToken, session.mpPaymentId)
    return {
      status: mapMpStatus(payment.status),
      paidAt: payment.date_approved ? new Date(payment.date_approved) : undefined,
      paymentIntentId: String(payment.id),
      amountPaid: payment.transaction_amount,
      applicationFeeAmount: payment.marketplace_fee ?? payment.application_fee,
    }
  }

  async refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Credenciales de Mercado Pago no disponibles')

    // params.paymentIntentId carries the MP payment ID for MP merchants
    const refund = await checkoutService.refundPayment({
      accessToken: creds.accessToken,
      paymentId: params.paymentIntentId,
      // MP API takes MXN decimal; the params.amount is centavos
      amount: params.amount !== undefined ? params.amount / 100 : undefined,
      idempotencyKey: params.idempotencyKey,
    })

    return {
      refundId: String(refund.id),
      amount: refund.amount * 100, // convert back to cents for the contract
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
    case 'approved': case 'authorized': return 'PAID'
    case 'pending': case 'in_process': case 'in_mediation': return 'PENDING'
    case 'refunded': return 'REFUNDED'
    case 'charged_back': return 'DISPUTED'
    default: return 'FAILED'
  }
}
```

- [ ] **Step 3: Wire registry**

Modify `src/services/payments/provider-registry.ts`:

```typescript
import { BadRequestError } from '@/errors/AppError'
import { BlumonProvider } from './providers/blumon.provider'
import { MercadoPagoProvider } from './providers/mercado-pago.provider'
import { StripeConnectProvider } from './providers/stripe-connect.provider'
import { EcommerceMerchantWithProvider, IEcommerceProvider } from './providers/provider.interface'

export function getProvider(merchant: EcommerceMerchantWithProvider): IEcommerceProvider {
  switch (merchant.provider?.code) {
    case 'BLUMON': return new BlumonProvider()
    case 'STRIPE_CONNECT': return new StripeConnectProvider()
    case 'MERCADO_PAGO': return new MercadoPagoProvider()
    default: throw new BadRequestError(`Proveedor de pagos no soportado: ${merchant.provider?.code || 'desconocido'}`)
  }
}
```

- [ ] **Step 4: Pass + commit**

```bash
npm test -- tests/unit/services/payments/providers/mercado-pago.provider.test.ts
git add src/services/payments/providers/mercado-pago.provider.ts src/services/payments/provider-registry.ts tests/unit/services/payments/providers/mercado-pago.provider.test.ts
git commit -m "feat(mercado-pago): IEcommerceProvider implementation + registry"
```

---

## Phase 7 — HTTP layer (OAuth controller, routes, webhook handler)

---

### Task 19: Zod schemas

**Files:**
- Create: `src/schemas/dashboard/mercadoPagoOAuth.schema.ts`

```typescript
import { z } from 'zod'

export const venueScopedParamsSchema = z.object({
  venueId: z.string().min(1, 'venueId es requerido'),
  merchantId: z.string().min(1, 'merchantId es requerido'),
})

export const callbackQuerySchema = z.object({
  code: z.string().min(1, 'El código de autorización es requerido').optional(),
  state: z.string().min(1, 'El estado OAuth es requerido'),
  error: z.string().optional(),
  error_description: z.string().optional(),
})
```

Commit and move on.

---

### Task 20: OAuth controller (initiate / callback / disconnect) WITH TENANT GUARD

**Files:**
- Create: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`
- Create: `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { initiate, callback, disconnect } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { UnauthorizedError } from '@/errors/AppError'

jest.mock('@/services/mercado-pago/merchant-guard.service')
jest.mock('@/services/mercado-pago/oauth.service')
jest.mock('@/services/mercado-pago/connection.service')

function buildRes() {
  const res: any = {}
  res.redirect = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe('initiate', () => {
  beforeEach(() => jest.clearAllMocks())

  it('calls tenant guard before building OAuth URL', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1', venueId: 'v_1' })
    ;(oauthService.signState as jest.Mock).mockReturnValue('state-jwt')
    ;(oauthService.buildAuthUrl as jest.Mock).mockReturnValue('https://auth.mercadopago.com.mx/authorization?state=state-jwt')

    const req = {
      params: { venueId: 'v_1', merchantId: 'em_1' },
      authContext: { userId: 's_1', venueId: 'v_1', orgId: 'o_1', role: 'OWNER' },
    } as any
    const res = buildRes()
    await initiate(req, res)

    expect(guardService.getMercadoPagoMerchant).toHaveBeenCalledWith('v_1', 'em_1')
    expect(oauthService.signState).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_1', venueId: 'v_1', staffId: 's_1',
    }))
    expect(res.redirect).toHaveBeenCalled()
  })

  it('rejects when tenant guard throws (wrong venue)', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockRejectedValue(new UnauthorizedError('No tienes acceso'))

    const req = {
      params: { venueId: 'v_1', merchantId: 'em_other_venue' },
      authContext: { userId: 's_1', venueId: 'v_1', orgId: 'o_1', role: 'OWNER' },
    } as any
    const res = buildRes()
    await initiate(req, res)

    expect(res.status).toHaveBeenCalledWith(401)
  })
})

describe('callback', () => {
  beforeEach(() => jest.clearAllMocks())

  it('verifies state, guards venue, exchanges code, persists, redirects success', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant', ecommerceMerchantId: 'em_1', venueId: 'v_1', staffId: 's_1',
    })
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1', venueId: 'v_1' })
    ;(oauthService.exchangeCodeForTokens as jest.Mock).mockResolvedValue({ access_token: 'a', refresh_token: 'r', user_id: 1, expires_in: 1, scope: 's', token_type: 'bearer', public_key: 'pk', live_mode: false })
    ;(connectionService.persistTokens as jest.Mock).mockResolvedValue(undefined)
    process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'

    const req = { params: { venueId: 'v_1', merchantId: 'em_1' }, query: { code: 'c', state: 's' } } as any
    const res = buildRes()
    await callback(req, res)

    expect(guardService.getMercadoPagoMerchant).toHaveBeenCalledWith('v_1', 'em_1')
    expect(connectionService.persistTokens).toHaveBeenCalledWith('em_1', expect.objectContaining({ access_token: 'a' }))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=connected'))
  })

  it('rejects when state venue mismatches URL venue', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant', ecommerceMerchantId: 'em_1', venueId: 'v_DIFFERENT', staffId: 's_1',
    })
    process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'

    const req = { params: { venueId: 'v_1', merchantId: 'em_1' }, query: { code: 'c', state: 's' } } as any
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=error'))
  })
})

describe('disconnect', () => {
  it('calls tenant guard then clears credentials', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(connectionService.clearCredentials as jest.Mock).mockResolvedValue(undefined)
    const req = {
      params: { venueId: 'v_1', merchantId: 'em_1' },
      authContext: { userId: 's_1', venueId: 'v_1', orgId: 'o_1', role: 'OWNER' },
    } as any
    const res = buildRes()
    await disconnect(req, res)
    expect(guardService.getMercadoPagoMerchant).toHaveBeenCalledWith('v_1', 'em_1')
    expect(connectionService.clearCredentials).toHaveBeenCalledWith('em_1')
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })
})
```

- [ ] **Step 2: Implement controller**

Create `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`:

```typescript
import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { venueScopedParamsSchema, callbackQuerySchema } from '@/schemas/dashboard/mercadoPagoOAuth.schema'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

export async function initiate(req: Request, res: Response) {
  const parsed = venueScopedParamsSchema.safeParse(req.params)
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.errors[0].message })

  const { venueId, merchantId } = parsed.data
  const { userId: staffId } = (req as any).authContext ?? {}
  if (!staffId) return res.status(401).json({ success: false, error: 'No autenticado' })

  try {
    await guardService.getMercadoPagoMerchant(venueId, merchantId)
  } catch (err: any) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message })
  }

  const state = oauthService.signState({ intent: 'connect_merchant', ecommerceMerchantId: merchantId, venueId, staffId })
  const url = oauthService.buildAuthUrl(state)
  logger.info({ venueId, merchantId, staffId }, '[MP OAuth] initiate')
  return res.redirect(url)
}

export async function callback(req: Request, res: Response) {
  const params = venueScopedParamsSchema.safeParse(req.params)
  const query = callbackQuerySchema.safeParse(req.query)
  if (!params.success || !query.success) return res.status(400).send('Parámetros OAuth inválidos')

  const { venueId, merchantId } = params.data
  const dashboardUrl = process.env.PUBLIC_DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:5173'
  const successPath = `${dashboardUrl}/venues/${venueId}/ecommerce-merchants/${merchantId}/integrations/mercadopago`

  if (query.data.error) {
    logger.warn({ err: query.data.error }, '[MP OAuth] callback returned error')
    return res.redirect(`${successPath}?mp_status=error&reason=${query.data.error}`)
  }
  if (!query.data.code) {
    return res.redirect(`${successPath}?mp_status=error&reason=missing_code`)
  }

  let statePayload: MercadoPagoOAuthState
  try {
    statePayload = oauthService.verifyState(query.data.state)
  } catch (err) {
    logger.warn({ err }, '[MP OAuth] invalid state')
    return res.redirect(`${successPath}?mp_status=error&reason=invalid_state`)
  }

  // Defense in depth: verify state matches URL params
  if (statePayload.venueId !== venueId || statePayload.ecommerceMerchantId !== merchantId) {
    logger.warn({ statePayload, venueId, merchantId }, '[MP OAuth] state/URL mismatch')
    return res.redirect(`${successPath}?mp_status=error&reason=state_mismatch`)
  }

  // Tenant guard again (the URL might have been tampered with after state was signed)
  try {
    await guardService.getMercadoPagoMerchant(venueId, merchantId)
  } catch (err) {
    return res.redirect(`${successPath}?mp_status=error&reason=tenant_check_failed`)
  }

  try {
    const tokens = await oauthService.exchangeCodeForTokens(query.data.code)
    await connectionService.persistTokens(merchantId, tokens)
    logger.info({ venueId, merchantId, mpUserId: tokens.user_id }, '[MP OAuth] connected')
    return res.redirect(`${successPath}?mp_status=connected`)
  } catch (err: any) {
    logger.error({ err: err.message, venueId, merchantId }, '[MP OAuth] token exchange failed')
    return res.redirect(`${successPath}?mp_status=error&reason=token_exchange_failed`)
  }
}

export async function disconnect(req: Request, res: Response) {
  const parsed = venueScopedParamsSchema.safeParse(req.params)
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

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts src/schemas/dashboard/mercadoPagoOAuth.schema.ts tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts
git commit -m "feat(mercado-pago): OAuth controller with venue-scoped tenant guard"
```

---

### Task 21: Mount OAuth routes under venue-scoped path

**Files:**
- Create: `src/routes/dashboard/mercadoPagoOAuth.routes.ts`
- Modify: central dashboard router

- [ ] **Step 1: Create router**

```typescript
import { Router } from 'express'
import * as controller from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import authenticateToken from '@/middlewares/authenticateToken.middleware'

const router = Router({ mergeParams: true })

router.get('/connect', authenticateToken, controller.initiate)
router.get('/callback', controller.callback)
router.delete('/', authenticateToken, controller.disconnect)

export default router
```

- [ ] **Step 2: Mount in dashboard router**

Search: `grep -rln "ecommerceMerchant.routes" src/routes/ | head -3`

In that file (probably `src/routes/dashboard.routes.ts`), add:

```typescript
import mercadoPagoOAuthRoutes from './dashboard/mercadoPagoOAuth.routes'
// ...
router.use('/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth', mercadoPagoOAuthRoutes)
```

Final endpoints:
- `GET    /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth/connect`
- `GET    /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth/callback`
- `DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:merchantId/mercadopago/oauth`

Set `MP_REDIRECT_URI` to match the callback path with concrete IDs replaced at OAuth time. Tip for sandbox: use ngrok to expose localhost; place a single fixed `MP_REDIRECT_URI` per environment.

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/routes/dashboard/mercadoPagoOAuth.routes.ts src/routes/dashboard.routes.ts
git commit -m "feat(mercado-pago): mount OAuth routes under venue-scoped path"
```

---

### Task 22: Webhook controller — verify + dispatch

**Files:**
- Create: `src/controllers/webhook/mercadoPago.webhook.controller.ts`
- Create: `tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import crypto from 'crypto'
import { handleMercadoPagoWebhook } from '@/controllers/webhook/mercadoPago.webhook.controller'
import * as paymentFlowService from '@/services/mercado-pago/payment-flow.service'

jest.mock('@/services/mercado-pago/payment-flow.service')

const SECRET = process.env.MP_WEBHOOK_SECRET!

function buildReq({ overrides = {} }: { overrides?: any } = {}) {
  const ts = String(Math.floor(Date.now() / 1000))
  const requestId = 'req-1'
  const dataId = '9999'
  const body = Buffer.from(JSON.stringify({ id: 1, live_mode: false, type: 'payment', action: 'payment.updated', data: { id: dataId }, user_id: 12345678, date_created: 't', api_version: 'v1' }))
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
  const headers: Record<string, string> = {
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': requestId,
  }
  return {
    body, headers, query: { 'data.id': dataId },
    get: (k: string) => headers[k.toLowerCase()],
    ...overrides,
  } as any
}

function buildRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res
}

describe('handleMercadoPagoWebhook', () => {
  beforeEach(() => jest.clearAllMocks())

  it('200 on valid signature → calls payment-flow', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockResolvedValue({ status: 'processed', checkoutSessionId: 'cs_1', paymentId: '9999' })
    const req = buildReq()
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(paymentFlowService.handleIpn).toHaveBeenCalled()
  })

  it('401 on invalid signature', async () => {
    const req = buildReq({ overrides: { headers: { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r' }, get: (k: string) => ({ 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r' }[k.toLowerCase()]) } })
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('returns 200 on duplicate (idempotent)', async () => {
    ;(paymentFlowService.handleIpn as jest.Mock).mockResolvedValue({ status: 'duplicate' })
    const req = buildReq()
    const res = buildRes()
    await handleMercadoPagoWebhook(req, res)
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
```

- [ ] **Step 2: Implement**

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

  // MP signs against the data.id from the query param (?data.id=xxx). Body fallback only.
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
    // Still return 200 so MP doesn't retry endlessly; we have our own dedupe row to recover from.
    return res.status(200).json({ received: true, error: 'dispatch_failed' })
  }
}
```

- [ ] **Step 3: Pass + commit**

```bash
npm test -- tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts
git add src/controllers/webhook/mercadoPago.webhook.controller.ts tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts
git commit -m "feat(mercado-pago): webhook controller (verify + dispatch + idempotent)"
```

---

### Task 23: Mount webhook route BEFORE express.json()

**Files:**
- Modify: `src/app.ts`

Locate the Google Calendar webhook mount (around line 85). Add MP webhook mount immediately after:

```typescript
import { handleMercadoPagoWebhook } from './controllers/webhook/mercadoPago.webhook.controller'

// MP webhook MUST mount BEFORE express.json() so we can read req.body as Buffer.
app.post('/api/v1/webhooks/mercadopago', express.raw({ type: '*/*', limit: '64kb' }), handleMercadoPagoWebhook)
```

Run: `npm run build`
Commit:

```bash
git add src/app.ts
git commit -m "feat(mercado-pago): mount /api/v1/webhooks/mercadopago with express.raw()"
```

---

## Phase 8 — paymentLink generalization (enable MP in existing checkout flow)

---

### Task 24: Generalize paymentLink.service.ts to support MERCADO_PAGO

**Files:**
- Modify: `src/services/dashboard/paymentLink.service.ts`
- Modify: existing payment-link tests (or add new)

- [ ] **Step 1: Identify hardcoded Stripe checks**

Run: `grep -n "STRIPE_CONNECT\|provider.code" src/services/dashboard/paymentLink.service.ts | head -20`

Note the exact lines: 874, 967, 1102, 1717, 1839.

- [ ] **Step 2: Replace each check**

In `paymentLink.service.ts`:

- Line 874 (current):
  `paymentLink.ecommerceMerchant.provider?.code === 'STRIPE_CONNECT' ? 'STRIPE_HOSTED' : 'INLINE_CARD'`

  Replace with helper at top of file:

  ```typescript
  const HOSTED_PROVIDER_CODES = ['STRIPE_CONNECT', 'MERCADO_PAGO'] as const
  function resolvePaymentLinkKind(providerCode: string | undefined): 'STRIPE_HOSTED' | 'INLINE_CARD' {
    return HOSTED_PROVIDER_CODES.includes(providerCode as any) ? 'STRIPE_HOSTED' : 'INLINE_CARD'
  }
  ```

  Then: `resolvePaymentLinkKind(paymentLink.ecommerceMerchant.provider?.code)`

- Lines 967, 1717 (the guard `if (... !== 'STRIPE_CONNECT')`):

  Replace with:

  ```typescript
  if (!HOSTED_PROVIDER_CODES.includes(paymentLink.ecommerceMerchant.provider?.code as any)) {
    throw new BadRequestError('Esta liga de pago no está configurada para checkout hosted (Stripe/Mercado Pago)')
  }
  ```

- Lines 1102, 1839 (`provider: 'STRIPE_CONNECT'`): replace string literal with `paymentLink.ecommerceMerchant.provider?.code`.

- [ ] **Step 3: Add unit test for MERCADO_PAGO branch**

In `tests/unit/services/dashboard/paymentLink.service.test.ts` (create or extend), add:

```typescript
it('accepts MERCADO_PAGO provider for hosted checkout', async () => {
  // Mock paymentLink with provider.code = MERCADO_PAGO, mp creds present, charges enabled.
  // Assert createStripeCheckoutForPaymentLink (or renamed) doesn't throw and returns a redirect URL.
})
```

(Full test is implementation-specific to your existing payment-link test infra; copy the pattern from existing Stripe tests.)

- [ ] **Step 4: Run full test suite + commit**

```bash
npm test -- tests/unit/services/dashboard/paymentLink.service.test.ts
npm run build
git add src/services/dashboard/paymentLink.service.ts tests/unit/services/dashboard/paymentLink.service.test.ts
git commit -m "feat(mercado-pago): generalize paymentLink hosted checkout to accept MP"
```

> Note: function names like `createStripeCheckoutForPaymentLink` (line 1680) can stay as-is to minimize blast radius. Rename in a follow-up if desired.

---

## Phase 9 — Token refresh cron

---

### Task 25: Token refresh job

**Files:**
- Create: `src/jobs/mercadopago-token-refresh.job.ts`
- Create: `tests/unit/jobs/mercadopago-token-refresh.job.test.ts`
- Modify: cron scheduler bootstrap

- [ ] **Step 1: Failing test**

```typescript
import { refreshMercadoPagoTokens } from '@/jobs/mercadopago-token-refresh.job'
import prisma from '@/utils/prismaClient'
import * as connectionService from '@/services/mercado-pago/connection.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    paymentProvider: { findUnique: jest.fn() },
    ecommerceMerchant: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/mercado-pago/connection.service')

const m = prisma as unknown as any

describe('refreshMercadoPagoTokens', () => {
  beforeEach(() => jest.clearAllMocks())

  it('iterates MP merchants and counts outcomes', async () => {
    m.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1', code: 'MERCADO_PAGO' })
    m.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockResolvedValueOnce('refreshed')
      .mockResolvedValueOnce('not_needed')
      .mockResolvedValueOnce('refreshed')

    const r = await refreshMercadoPagoTokens()
    expect(r.refreshed).toBe(2)
    expect(r.notNeeded).toBe(1)
    expect(r.errors).toBe(0)
  })

  it('catches errors per merchant', async () => {
    m.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1' })
    m.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockRejectedValueOnce(new Error('MP API down'))
      .mockResolvedValueOnce('refreshed')

    const r = await refreshMercadoPagoTokens()
    expect(r.errors).toBe(1)
    expect(r.refreshed).toBe(1)
  })
})
```

- [ ] **Step 2: Implement**

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
      const result = await refreshIfExpiring(merchant.id, 30)
      if (result === 'refreshed') summary.refreshed++
      else if (result === 'not_needed') summary.notNeeded++
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

- [ ] **Step 3: Register cron**

Search: `grep -rln "gcal-channel-renewal\|cron.schedule" src/ | head -5`

Add in that scheduler file:

```typescript
import { refreshMercadoPagoTokens } from '@/jobs/mercadopago-token-refresh.job'

cron.schedule('0 3 * * *', async () => {
  try { await refreshMercadoPagoTokens() }
  catch (err) { logger.error({ err }, '[MP refresh] uncaught') }
}, { timezone: 'America/Mexico_City' })
```

- [ ] **Step 4: Commit**

```bash
npm test -- tests/unit/jobs/mercadopago-token-refresh.job.test.ts
git add src/jobs/mercadopago-token-refresh.job.ts tests/unit/jobs/mercadopago-token-refresh.job.test.ts src/<scheduler-file>.ts
git commit -m "feat(mercado-pago): daily token refresh cron (3 AM Mexico City)"
```

---

## Phase 10 — Sandbox smoke test (manual, gated on MP account verification)

---

### Task 26: End-to-end sandbox verification

This task can only run after the user's MP business account is verified AND a sandbox application has been created.

- [ ] **Step 1: Confirm prereqs**

  - [ ] MP business account verified (KYC complete — required to create app)
  - [ ] Sandbox application created in DevPanel: product = Checkout Pro, model = Marketplace
  - [ ] `client_id`, `client_secret` filled into `.env`
  - [ ] `MERCADO_PAGO_TOKEN_KEY` generated and set: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - [ ] Three test users created via MP MCP (`create_test_user`): integrator, seller, buyer (all MLM)
  - [ ] Saldo ficticio loaded on buyer via `add_money_test_user`

- [ ] **Step 2: Tunnel localhost + register webhook**

```bash
ngrok http 3000 &
```
Copy the HTTPS URL. Update `MP_REDIRECT_URI` and `MP_WEBHOOK_NOTIFICATION_URL` to use that domain. Restart dev server.

Then via MP MCP:
```
mcp__mercadopago__save_webhook
  application_id: <sandbox app id>
  callback_sandbox: https://<ngrok>.ngrok.app/api/v1/webhooks/mercadopago
  topics: ["payment", "mp-connect"]
```

- [ ] **Step 3: Trigger OAuth from API client (logged in as a venue owner)**

Open in browser (preserves cookie):
```
http://localhost:3000/api/v1/dashboard/venues/<venueId>/ecommerce-merchants/<merchantId>/mercadopago/oauth/connect
```

Login at MP as the **seller** test account. Authorize. Should land on dashboard with `mp_status=connected`.

- [ ] **Step 4: Verify DB**

```bash
psql $DATABASE_URL -c "SELECT id, \"providerMerchantId\", \"providerCredentials\"->>'mpUserId' AS mp_user, \"providerCredentials\"->>'expiresAt' AS expires FROM \"EcommerceMerchant\" WHERE id = '<merchantId>';"
```
Expected: `providerMerchantId` = seller's MP user_id, `expires` ≈ 180 days out.

- [ ] **Step 5: Generate a PaymentLink for the MP-connected venue and pay it**

Use existing dashboard flow to create a PaymentLink against this venue. Open the shortCode in incognito. Should redirect to MP Checkout Pro (sandbox).

Login as **buyer** test user. Pay with card `APRO` (Visa 4509 9535 6623 3704, any CVV, future expiry).

- [ ] **Step 6: Verify webhook + DB**

Tail server logs:
```
[MP webhook] dispatched { result: { status: 'processed', checkoutSessionId: 'cs_xxx', paymentId: 'xxx' } }
```

Check DB:
```bash
psql $DATABASE_URL -c "SELECT id, status, \"mpPreferenceId\", \"mpPaymentId\", \"mpMerchantOrderId\" FROM \"CheckoutSession\" WHERE id = 'cs_xxx';"
```
Expected: status `COMPLETED`, mpPaymentId set.

```bash
psql $DATABASE_URL -c "SELECT \"mpUserId\", \"dataId\", action, \"processingStatus\" FROM \"MercadoPagoWebhookEvent\" ORDER BY \"createdAt\" DESC LIMIT 5;"
```
Expected: rows with `processed`.

- [ ] **Step 7: Verify seller balance reflects amount minus marketplace_fee**

Login as **seller** test user on `mercadopago.com.mx`. Open balance. Verify the deposited amount = transaction amount − MP commission − marketplaceFee.

- [ ] **Step 8: Verify MP MCP quality checklist**

```
mcp__mercadopago__quality_checklist
  application_id: <sandbox app id>
```
Address any items it flags as missing.

- [ ] **Step 9: Verify dedupe protects against replay**

Resend the same IPN with the same x-request-id (use the MP DevPanel "test notification" feature, or replay from server logs). Expect:
```
[MP webhook] dispatched { result: { status: 'duplicate' } }
```
DB should NOT have a second row in MercadoPagoWebhookEvent.

- [ ] **Step 10: Document numbers**

Append to this plan a `Smoke test results — 2026-05-XX` subsection with:
- amount paid (MXN)
- marketplace_fee charged (MXN)
- MP commission deducted (verify via seller dashboard)
- net amount in seller balance
- payment ID
- preference ID
- IPN payload (sanitized)

These numbers are what you'll send to the MP commercial executive to prove rates are preserved.

---

## Self-Review Checklist (run before declaring v2 complete)

- [ ] All 26 tasks committed with passing tests
- [ ] `npm test -- mercado-pago` passes
- [ ] `npm test -- lib/token-encryption` passes
- [ ] `npm test -- google-calendar` STILL passes (regression check after Task 3)
- [ ] `npm test -- paymentLink` passes including MP branch
- [ ] `npm run build` clean
- [ ] `npm run lint:fix && npm run format` clean
- [ ] `npm run pre-deploy` passes
- [ ] No new files in repo root
- [ ] `.env.example` documents MP variables (no secrets)
- [ ] Webhook route mounted with `express.raw()` BEFORE `express.json()` in `app.ts`
- [ ] All Zod messages in Spanish
- [ ] No hardcoded venue names, slugs, or test user IDs in source
- [ ] OAuth state JWT validates AND state-vs-URL match check is present
- [ ] All 3 OAuth endpoints (initiate/callback/disconnect) go through `getMercadoPagoMerchant`
- [ ] Money adapter `/100` divide + `*100` multiply documented at each MP API call
- [ ] CheckoutSession has `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` columns + indexes
- [ ] `MercadoPagoWebhookEvent` table exists with unique constraint
- [ ] Token refresh uses advisory lock keyed by venueId
- [ ] csrfNonce code is gone (no dead code)

---

## Out of Scope (v2 explicitly defers these)

1. **Frontend dashboard UI** — Connect button, status badge, disconnect flow. Lives in `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`. Separate plan.
2. **Reservation deposits via MP** — `reservation.consumer.service.ts:44,50,108,291,457,460` stay `STRIPE_CONNECT`-only. Generalizing reservations is a follow-up plan.
3. **Checkout API (in-house card collection)** — v2 uses Checkout Pro (MP-hosted). Checkout API requires PCI scope.
4. **Split Payments 1:N** — multi-payee per transaction. Requires MP commercial team approval.
5. **Encryption key rotation runbook** — `keyVersion: 1` field is reserved; rotation is a follow-up.
6. **Production cutover** — requires MP commercial OK on rate preservation + production app credentials + KYC nivel 6 on all merchants. Separate runbook.
7. **MP card subscriptions / `/preapproval`** — out of marketplace flow.
8. **Per-product fee schedule** — v2 uses a single `marketplace_fee` per checkout.
9. **Refactoring `provider.interface.ts` to canonical Decimal** — decision deferred. Centavos convention preserved for v2.

---

## Risks tracked

| Risk | Mitigation |
|---|---|
| MP commercial team blocks Split Payments approval | Plan ships sandbox-only until OK; production env vars stay empty in prod until cleared |
| MP webhook signature format differs from our implementation | Smoke test step 9 (replay) verifies. If smoke fails, isolate `webhook.service.ts` and adjust manifest. |
| MP changes manifest format | All signature logic in one service; one place to update |
| Token refresh fails silently | Job logs `errors` count; add BetterStack alerting on `summary.errors > 0` |
| Multi-tab race during OAuth | State JWT TTL = 10 min. Last-write-wins on `providerCredentials` (mitigated by tenant guard preventing cross-venue overwrite) |
| Sandbox MP user lacks KYC nivel 6 | Smoke test should use the seller's MP DevPanel sandbox seller (auto KYC 6); document for prod gate |
| `paymentLink.service.ts` rename creates merge conflicts | Function names preserved as-is in Task 24; rename in follow-up |
| Encryption key compromise | `keyVersion: 1` field reserved; rotation runbook documented as follow-up |
| `mercadopago` SDK version mismatch with docs | Pin to `^2.x` (current major). Verify in smoke test. |

---

## Execution Handoff

Two options after this plan is approved:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

The first tasks (Phase 0: env + encryption + types) have no MP dependency and can run today regardless of MP account status. Phases 5+ (smoke test) gate on MP account verification.
