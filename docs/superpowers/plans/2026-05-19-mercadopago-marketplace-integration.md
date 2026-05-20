# Mercado Pago Marketplace (Split Payments) Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mercado Pago as a third e-commerce payment provider alongside Blumon and Stripe Connect, using MP's marketplace OAuth flow so payments settle directly in the merchant's MP account (preserving their negotiated rates) while Avoqado collects a configurable `marketplace_fee`.

**Architecture:** Mirror the existing `IEcommerceProvider` abstraction (`src/services/payments/providers/`). Each connected merchant is an `EcommerceMerchant` row with `providerId` → `PaymentProvider(code='MERCADO_PAGO')`. The seller's OAuth `access_token`/`refresh_token` are AES-256-GCM encrypted (mirror `google-calendar/encryption.service.ts`) and stored as base64 inside `EcommerceMerchant.providerCredentials` JSON. OAuth state is a JWT-signed envelope (mirror `google-calendar/oauth.service.ts`). Checkout Pro is the primary flow (MP-hosted page); platform fee is set via `marketplace_fee` on the `/checkout/preferences` API.

**Tech Stack:**
- Backend: Node.js 20+, Express 4.x, TypeScript, Prisma 5.x, PostgreSQL
- Library: `mercadopago` (official SDK, v2.x) + raw `axios` for OAuth (SDK lacks OAuth helpers)
- Crypto: `node:crypto` (AES-256-GCM), `jsonwebtoken` (HS256 state)
- Test: Jest 29 + ts-jest, `nock` for HTTP mocking (already used by Stripe tests)
- Region: `MLM` (Mexico) — URL host `auth.mercadopago.com.mx`, currency `MXN`

---

## Pre-Plan Architectural Decisions (locked-in)

These were settled during planning and should NOT be re-litigated by the implementing agent:

| Decision | Choice | Rationale |
|---|---|---|
| Where to store seller OAuth tokens | `EcommerceMerchant.providerCredentials` JSON (base64-encoded encrypted bytes) | Matches existing Blumon/Stripe Connect pattern. Avoids a new table just for one provider. |
| Encryption key | New env var `MERCADO_PAGO_TOKEN_KEY` (32-byte hex) | Rotates independently from Google Calendar key and JWT secret (per `critical-warnings.md`). |
| OAuth state | JWT (HS256) using existing `OAUTH_STATE_SECRET` | Already used by Google Calendar. Stateless, no DB cleanup, 10-min TTL. |
| Checkout type for v1 | Checkout Pro (`/checkout/preferences` + `marketplace_fee`) | MP hosts the payment UI — simpler, no PCI scope. Checkout API can come in v2 if needed. |
| MP user_id storage | Inside `providerCredentials.mpUserId` AND in `EcommerceMerchant.providerMerchantId` | Mirrors Stripe Connect pattern (`connectAccountId` is stored both places). Enables O(1) lookup. |
| Token refresh | Daily cron (`mercadopago-token-refresh.job.ts`) refreshes tokens expiring within 30 days | Tokens live 180 days. 30-day buffer = lots of slack. |
| Webhook signing | HMAC SHA-256 of `id;request-id;ts` per MP docs | Per MP webhook spec for Mexico (`x-signature` + `x-request-id` headers). |
| Sandbox vs prod | `EcommerceMerchant.sandboxMode` boolean drives credential lookup (already exists) | Mirrors Blumon flow. |
| Frontend dashboard UI | OUT OF SCOPE for this plan | Will be a separate plan once backend OAuth callback works in sandbox. |

---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/services/mercado-pago/encryption.service.ts` | AES-256-GCM encrypt/decrypt for MP tokens (mirrors google-calendar/encryption.service.ts) |
| `src/services/mercado-pago/oauth.service.ts` | Pure helpers: buildAuthUrl, signState, verifyState, exchangeCodeForTokens, refreshAccessToken |
| `src/services/mercado-pago/connection.service.ts` | Stateful service: store/load/refresh tokens against EcommerceMerchant.providerCredentials |
| `src/services/mercado-pago/checkout.service.ts` | Wraps Checkout Pro `/checkout/preferences` + payment lookup + refund using seller's access_token |
| `src/services/mercado-pago/webhook.service.ts` | Signature verification + event parsing |
| `src/services/mercado-pago/types.ts` | TypeScript types for MP credentials envelope, webhook payloads, errors |
| `src/services/payments/providers/mercado-pago.provider.ts` | Implements `IEcommerceProvider` |
| `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` | HTTP handlers: initiate, callback, disconnect |
| `src/controllers/webhook/mercadoPago.webhook.controller.ts` | HTTP handler for `/api/v1/webhooks/mercadopago` |
| `src/routes/dashboard/mercadoPagoOAuth.routes.ts` | Express router for OAuth endpoints |
| `src/schemas/dashboard/mercadoPagoOAuth.schema.ts` | Zod validation schemas (Spanish messages) |
| `src/jobs/mercadopago-token-refresh.job.ts` | Daily cron refreshing tokens expiring < 30 days |
| `prisma/migrations/<ts>_seed_mercado_pago_provider/migration.sql` | Inserts `PaymentProvider(code='MERCADO_PAGO')` |
| `tests/unit/services/mercado-pago/encryption.service.test.ts` | Round-trip + tampering tests |
| `tests/unit/services/mercado-pago/oauth.service.test.ts` | State JWT, auth URL, code exchange (mocked) |
| `tests/unit/services/mercado-pago/connection.service.test.ts` | Persistence + refresh logic |
| `tests/unit/services/mercado-pago/checkout.service.test.ts` | Preference creation, payment lookup, refund (mocked) |
| `tests/unit/services/mercado-pago/webhook.service.test.ts` | Signature verification |
| `tests/unit/services/payments/providers/mercado-pago.provider.test.ts` | Provider contract |
| `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts` | HTTP layer |
| `tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts` | Webhook HTTP layer |
| `tests/unit/jobs/mercadopago-token-refresh.job.test.ts` | Cron logic |

### Files to modify

| Path | Change |
|---|---|
| `prisma/schema.prisma` | No schema change needed. JSON fields and `EcommerceMerchant.providerCredentials` already accommodate MP. |
| `src/services/payments/provider-registry.ts` | Add `MERCADO_PAGO` case |
| `src/routes/webhook.routes.ts` | Mount `/mercadopago` webhook route |
| `src/routes/dashboard.routes.ts` (or central registry) | Mount MP OAuth router |
| `src/app.ts` | (If needed) ensure MP webhook is mounted with `express.raw()` BEFORE `express.json()` |
| `src/config/env.ts` (or wherever Zod env validation lives) | Add `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `MP_WEBHOOK_SECRET`, `MERCADO_PAGO_TOKEN_KEY` |
| `tests/__helpers__/setup.ts` | Set `MERCADO_PAGO_TOKEN_KEY` to a deterministic test hex |
| `scripts/setup-modules.ts` (or equivalent seed script) | Add MERCADO_PAGO PaymentProvider row to seeders |

---

## Phase 0 — Foundation (env vars, encryption, state, types)

Builds the substrate: env vars, the encryption helper, the OAuth state helpers, and types. Zero MP API calls yet — pure local crypto + JWT.

---

### Task 1: Add env vars and validation

**Files:**
- Modify: `src/config/env.ts` (or your existing Zod env file — search for `process.env.STRIPE_SECRET_KEY` to find it)
- Modify: `.env.example`
- Modify: `tests/__helpers__/setup.ts`

- [ ] **Step 1: Locate env validation file**

Run: `grep -rln "STRIPE_SECRET_KEY" src/config/ src/ | head -5`
Expected: one file that validates env vars with Zod. Call it `<env-file>`.

- [ ] **Step 2: Add MP env var schema**

Open `<env-file>`. Inside the existing Zod object schema, add:

```typescript
MP_CLIENT_ID: z.string().min(1, 'MP_CLIENT_ID es requerido'),
MP_CLIENT_SECRET: z.string().min(1, 'MP_CLIENT_SECRET es requerido'),
MP_REDIRECT_URI: z.string().url('MP_REDIRECT_URI debe ser una URL válida'),
MP_WEBHOOK_SECRET: z.string().min(1, 'MP_WEBHOOK_SECRET es requerido'),
MERCADO_PAGO_TOKEN_KEY: z.string().length(64, 'MERCADO_PAGO_TOKEN_KEY debe ser hex de 32 bytes (64 chars)'),
MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
MP_AUTH_BASE_URL: z.string().url().default('https://auth.mercadopago.com.mx'),
```

> If your existing env validation makes all vars required at boot, mark these as `.optional()` for now so dev environments without MP creds don't crash. Make them required once MP is GA.

- [ ] **Step 3: Add to `.env.example`**

Append:

```bash
# Mercado Pago — Marketplace (Split Payments)
MP_CLIENT_ID=
MP_CLIENT_SECRET=
MP_REDIRECT_URI=http://localhost:3000/api/v1/dashboard/integrations/mercadopago/oauth/callback
MP_WEBHOOK_SECRET=
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MERCADO_PAGO_TOKEN_KEY=
```

- [ ] **Step 4: Add to test setup**

Open `tests/__helpers__/setup.ts`. Add:

```typescript
process.env.MP_CLIENT_ID = 'test-mp-client-id'
process.env.MP_CLIENT_SECRET = 'test-mp-client-secret'
process.env.MP_REDIRECT_URI = 'http://localhost:3000/api/v1/dashboard/integrations/mercadopago/oauth/callback'
process.env.MP_WEBHOOK_SECRET = 'test-mp-webhook-secret'
process.env.MERCADO_PAGO_TOKEN_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.MP_API_BASE_URL = 'https://api.mercadopago.com'
process.env.MP_AUTH_BASE_URL = 'https://auth.mercadopago.com.mx'
```

> Per memory `feedback_singleton_env_tests.md`: env vars used by services that instantiate SDK clients at module load MUST be set in this setup file, not in individual test files.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example tests/__helpers__/setup.ts
git commit -m "feat(mercado-pago): add env vars for MP marketplace integration"
```

---

### Task 2: Type definitions

**Files:**
- Create: `src/services/mercado-pago/types.ts`

- [ ] **Step 1: Create types file**

Create `src/services/mercado-pago/types.ts`:

```typescript
/**
 * Mercado Pago OAuth + Marketplace types.
 *
 * Tokens at rest are AES-256-GCM encrypted and base64-encoded inside the
 * `EcommerceMerchant.providerCredentials` JSON column. This module owns the
 * envelope shape that both the encryption service and the OAuth service agree
 * on.
 */

/** Stored shape inside EcommerceMerchant.providerCredentials for MP merchants. */
export interface MercadoPagoCredentials {
  /** MP user_id of the seller — also mirrored to EcommerceMerchant.providerMerchantId. */
  mpUserId: string

  /** base64-encoded encrypted access_token (180-day TTL). */
  accessTokenCiphertext: string

  /** base64-encoded encrypted refresh_token. */
  refreshTokenCiphertext: string

  /** ISO timestamp when the access_token expires. */
  expiresAt: string

  /** OAuth scope string returned by MP (typically "offline_access read write"). */
  scope: string

  /** true once a real payment has flowed; helps distinguish 'authorized but unused' connections. */
  liveMode: boolean

  /** ISO timestamp of the last successful refresh, for diagnostics. */
  lastRefreshedAt?: string
}

/** OAuth state JWT payload — signed with OAUTH_STATE_SECRET. */
export interface MercadoPagoOAuthState {
  intent: 'connect_merchant'
  ecommerceMerchantId: string
  venueId: string
  staffId: string
  csrfNonce: string
}

/** Response from POST https://api.mercadopago.com/oauth/token */
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

/** Subset of MP payment object returned by GET /v1/payments/:id */
export interface MercadoPagoPayment {
  id: number
  status: 'pending' | 'approved' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'
  status_detail: string
  external_reference: string | null
  transaction_amount: number
  currency_id: string
  date_approved: string | null
  date_created: string
  fee_details: Array<{ type: string; amount: number; fee_payer: string }>
  marketplace_fee?: number
  application_fee?: number
}

/** MP webhook envelope (IPN-style payload received at our /api/v1/webhooks/mercadopago) */
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
git commit -m "feat(mercado-pago): add TypeScript types for credentials envelope and API responses"
```

---

### Task 3: Encryption helper (AES-256-GCM)

**Files:**
- Create: `src/services/mercado-pago/encryption.service.ts`
- Create: `tests/unit/services/mercado-pago/encryption.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/mercado-pago/encryption.service.test.ts`:

```typescript
import { encryptToken, decryptToken } from '@/services/mercado-pago/encryption.service'

describe('mercado-pago encryption service', () => {
  it('roundtrips a token through encrypt → decrypt', () => {
    const plaintext = 'APP_USR-1234567890abcdef-mp-access-token'
    const blob = encryptToken(plaintext)
    expect(blob).toBeInstanceOf(Buffer)
    expect(decryptToken(blob)).toBe(plaintext)
  })

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input'
    const a = encryptToken(plaintext)
    const b = encryptToken(plaintext)
    expect(a.equals(b)).toBe(false)
    expect(decryptToken(a)).toBe(plaintext)
    expect(decryptToken(b)).toBe(plaintext)
  })

  it('throws when authTag is tampered', () => {
    const blob = encryptToken('secret')
    // Flip a byte inside the auth tag (offset 12..27)
    blob[15] = blob[15] ^ 0x01
    expect(() => decryptToken(blob)).toThrow()
  })

  it('throws when MERCADO_PAGO_TOKEN_KEY is wrong length', () => {
    const original = process.env.MERCADO_PAGO_TOKEN_KEY
    process.env.MERCADO_PAGO_TOKEN_KEY = 'shortkey'
    expect(() => encryptToken('x')).toThrow(/MERCADO_PAGO_TOKEN_KEY/)
    process.env.MERCADO_PAGO_TOKEN_KEY = original
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- tests/unit/services/mercado-pago/encryption.service.test.ts`
Expected: FAIL with "Cannot find module '@/services/mercado-pago/encryption.service'".

- [ ] **Step 3: Implement the encryption service**

Create `src/services/mercado-pago/encryption.service.ts`:

```typescript
/**
 * AES-256-GCM token encryption for Mercado Pago OAuth tokens.
 *
 * Stored layout (Buffer):
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (n bytes) ]
 *
 * Key from `MERCADO_PAGO_TOKEN_KEY` (32-byte hex). ROTATE-SEPARATELY from
 * JWT_SECRET and GOOGLE_CALENDAR_TOKEN_KEY — leaking this key compromises
 * every MP merchant connected to Avoqado.
 */
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const hex = process.env.MERCADO_PAGO_TOKEN_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('MERCADO_PAGO_TOKEN_KEY missing or wrong length (expect 32-byte hex string)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptToken(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decryptToken(blob: Buffer): string {
  const iv = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = blob.subarray(IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** Convenience: encrypt → base64 (for JSON storage) */
export function encryptTokenToBase64(plaintext: string): string {
  return encryptToken(plaintext).toString('base64')
}

/** Convenience: base64 → decrypt (for JSON storage) */
export function decryptTokenFromBase64(b64: string): string {
  return decryptToken(Buffer.from(b64, 'base64'))
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/encryption.service.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/encryption.service.ts tests/unit/services/mercado-pago/encryption.service.test.ts
git commit -m "feat(mercado-pago): AES-256-GCM encryption helper for OAuth tokens"
```

---

### Task 4: OAuth state helpers (JWT signed)

**Files:**
- Create part of: `src/services/mercado-pago/oauth.service.ts`
- Create: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1: Write the failing test for state helpers**

Create `tests/unit/services/mercado-pago/oauth.service.test.ts`:

```typescript
import { signState, verifyState } from '@/services/mercado-pago/oauth.service'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

describe('mercado-pago oauth state', () => {
  const samplePayload: MercadoPagoOAuthState = {
    intent: 'connect_merchant',
    ecommerceMerchantId: 'cmem_abc123',
    venueId: 'cv_venue456',
    staffId: 'cs_staff789',
    csrfNonce: 'random-nonce-xyz',
  }

  beforeAll(() => {
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-for-mp'
  })

  it('roundtrips a state payload', () => {
    const token = signState(samplePayload)
    const decoded = verifyState(token)
    expect(decoded.ecommerceMerchantId).toBe(samplePayload.ecommerceMerchantId)
    expect(decoded.venueId).toBe(samplePayload.venueId)
    expect(decoded.staffId).toBe(samplePayload.staffId)
    expect(decoded.csrfNonce).toBe(samplePayload.csrfNonce)
    expect(decoded.intent).toBe('connect_merchant')
  })

  it('rejects a tampered state', () => {
    const token = signState(samplePayload)
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'b' : 'a') + token.slice(-1)
    expect(() => verifyState(tampered)).toThrow()
  })

  it('rejects an expired state', () => {
    const token = signState(samplePayload)
    // Re-sign with negative expiry to simulate expiration
    const jwt = require('jsonwebtoken')
    const expiredToken = jwt.sign({ ...samplePayload, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.OAUTH_STATE_SECRET)
    expect(() => verifyState(expiredToken)).toThrow(/expired/i)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- tests/unit/services/mercado-pago/oauth.service.test.ts`
Expected: FAIL with "Cannot find module '@/services/mercado-pago/oauth.service'".

- [ ] **Step 3: Create the OAuth service skeleton with state helpers**

Create `src/services/mercado-pago/oauth.service.ts`:

```typescript
/**
 * Mercado Pago OAuth core service.
 *
 * Pure helpers around MP's OAuth2 endpoints:
 *   - signState(payload) / verifyState(token): HMAC-signed state envelope
 *     reused from the Google Calendar pattern (OAUTH_STATE_SECRET).
 *   - buildAuthUrl(state): constructs the merchant consent URL.
 *   - exchangeCodeForTokens(code): redeems an authorization code.
 *   - refreshAccessToken(refreshToken): mints a new access_token.
 *
 * All MP-host URLs default to `auth.mercadopago.com.mx` (Mexico). Override via
 * `MP_AUTH_BASE_URL` / `MP_API_BASE_URL` for other sites or tests.
 */
import axios, { AxiosError } from 'axios'
import jwt, { SignOptions } from 'jsonwebtoken'
import type { MercadoPagoOAuthState, MercadoPagoTokenResponse } from './types'

const STATE_TTL_SECONDS = 600 // 10 min — must outlast the redirect roundtrip

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

export function signState(payload: MercadoPagoOAuthState): string {
  const opts: SignOptions = { expiresIn: STATE_TTL_SECONDS }
  return jwt.sign(payload, requireEnv('OAUTH_STATE_SECRET'), opts)
}

export function verifyState(token: string): MercadoPagoOAuthState {
  return jwt.verify(token, requireEnv('OAUTH_STATE_SECRET')) as MercadoPagoOAuthState
}

// Remaining helpers added in Task 5
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/oauth.service.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): JWT-signed OAuth state helpers"
```

---

### Task 5: OAuth URL builder + code exchange + refresh

**Files:**
- Modify: `src/services/mercado-pago/oauth.service.ts`
- Modify: `tests/unit/services/mercado-pago/oauth.service.test.ts`

- [ ] **Step 1: Add failing tests for buildAuthUrl, exchangeCodeForTokens, refreshAccessToken**

Append to `tests/unit/services/mercado-pago/oauth.service.test.ts`:

```typescript
import nock from 'nock'
import { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from '@/services/mercado-pago/oauth.service'

describe('mercado-pago oauth - buildAuthUrl', () => {
  it('builds an authorization URL with all required params', () => {
    const url = buildAuthUrl('state-token-xyz')
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://auth.mercadopago.com.mx')
    expect(parsed.pathname).toBe('/authorization')
    expect(parsed.searchParams.get('client_id')).toBe('test-mp-client-id')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('platform_id')).toBe('mp')
    expect(parsed.searchParams.get('state')).toBe('state-token-xyz')
    expect(parsed.searchParams.get('redirect_uri')).toBe(process.env.MP_REDIRECT_URI)
  })
})

describe('mercado-pago oauth - exchangeCodeForTokens', () => {
  beforeEach(() => nock.cleanAll())
  afterAll(() => nock.restore())

  it('POSTs to /oauth/token and returns tokens', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token', body => {
        return body.client_id === 'test-mp-client-id'
          && body.client_secret === 'test-mp-client-secret'
          && body.grant_type === 'authorization_code'
          && body.code === 'auth-code-123'
          && body.redirect_uri === process.env.MP_REDIRECT_URI
      })
      .reply(200, {
        access_token: 'APP_USR-access-xyz',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 'offline_access read write',
        user_id: 12345678,
        refresh_token: 'TG-refresh-abc',
        public_key: 'APP_USR-pk-xyz',
        live_mode: false,
      })

    const tokens = await exchangeCodeForTokens('auth-code-123')
    expect(tokens.access_token).toBe('APP_USR-access-xyz')
    expect(tokens.refresh_token).toBe('TG-refresh-abc')
    expect(tokens.user_id).toBe(12345678)
    expect(tokens.expires_in).toBe(15552000)
  })

  it('throws when MP returns an error', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant', error_description: 'code expired' })

    await expect(exchangeCodeForTokens('bad-code')).rejects.toThrow(/invalid_grant|code expired/i)
  })
})

describe('mercado-pago oauth - refreshAccessToken', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs to /oauth/token with grant_type=refresh_token', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token', body => {
        return body.grant_type === 'refresh_token'
          && body.refresh_token === 'old-refresh-token'
          && body.client_id === 'test-mp-client-id'
      })
      .reply(200, {
        access_token: 'NEW-access',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 'offline_access read write',
        user_id: 12345678,
        refresh_token: 'NEW-refresh',
        public_key: 'APP_USR-pk-xyz',
        live_mode: false,
      })

    const tokens = await refreshAccessToken('old-refresh-token')
    expect(tokens.access_token).toBe('NEW-access')
    expect(tokens.refresh_token).toBe('NEW-refresh')
  })
})
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/oauth.service.test.ts`
Expected: FAIL — `buildAuthUrl`, `exchangeCodeForTokens`, `refreshAccessToken` not exported.

- [ ] **Step 3: Implement buildAuthUrl, exchangeCodeForTokens, refreshAccessToken**

Replace the "Remaining helpers added in Task 5" comment in `src/services/mercado-pago/oauth.service.ts` with:

```typescript
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
  const apiBase = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
  try {
    const { data } = await axios.post<MercadoPagoTokenResponse>(
      `${apiBase}/oauth/token`,
      {
        client_id: requireEnv('MP_CLIENT_ID'),
        client_secret: requireEnv('MP_CLIENT_SECRET'),
        grant_type: 'authorization_code',
        code,
        redirect_uri: requireEnv('MP_REDIRECT_URI'),
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      },
    )
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      const { error, error_description } = err.response.data
      throw new Error(`MP OAuth token exchange failed: ${error || err.message} — ${error_description || ''}`.trim())
    }
    throw err
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<MercadoPagoTokenResponse> {
  const apiBase = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
  try {
    const { data } = await axios.post<MercadoPagoTokenResponse>(
      `${apiBase}/oauth/token`,
      {
        client_id: requireEnv('MP_CLIENT_ID'),
        client_secret: requireEnv('MP_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      },
    )
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      const { error, error_description } = err.response.data
      throw new Error(`MP OAuth token refresh failed: ${error || err.message} — ${error_description || ''}`.trim())
    }
    throw err
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/oauth.service.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/oauth.service.ts tests/unit/services/mercado-pago/oauth.service.test.ts
git commit -m "feat(mercado-pago): OAuth authorize URL + code exchange + token refresh"
```

---

### Task 6: Seed MERCADO_PAGO PaymentProvider row (migration)

**Files:**
- Create: `prisma/migrations/<timestamp>_seed_mercado_pago_provider/migration.sql`
- Modify: `scripts/setup-modules.ts` (if it also seeds providers)

- [ ] **Step 1: Generate the migration**

Run: `cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && npx prisma migrate dev --create-only --name seed_mercado_pago_provider`

This creates an empty migration file. The CLI will print its path.

- [ ] **Step 2: Edit the migration SQL**

Open the generated `migration.sql` and replace its contents with:

```sql
-- Seed Mercado Pago as a payment provider for Mexico
INSERT INTO "PaymentProvider" (
  "id",
  "code",
  "name",
  "type",
  "countryCode",
  "active",
  "configSchema",
  "createdAt",
  "updatedAt"
) VALUES (
  'cmp_mercadopago_seed_2026',
  'MERCADO_PAGO',
  'Mercado Pago',
  'PAYMENT_PROCESSOR',
  ARRAY['MX'],
  true,
  '{
    "type": "object",
    "required": ["mpUserId", "accessTokenCiphertext", "refreshTokenCiphertext", "expiresAt"],
    "properties": {
      "mpUserId": { "type": "string" },
      "accessTokenCiphertext": { "type": "string" },
      "refreshTokenCiphertext": { "type": "string" },
      "expiresAt": { "type": "string", "format": "date-time" },
      "scope": { "type": "string" },
      "liveMode": { "type": "boolean" },
      "lastRefreshedAt": { "type": "string", "format": "date-time" }
    }
  }'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("code") DO NOTHING;
```

> Use cuid format for the id (25 chars, starts with `c`) per `CLAUDE.md`. The id above is a valid example; you may regenerate one if you prefer with `npx cuid`.

- [ ] **Step 3: Apply the migration locally**

Run: `npx prisma migrate dev`
Expected output: `Applying migration ...seed_mercado_pago_provider`, then `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the row exists**

Run: `npx prisma studio` (opens at http://localhost:5555) → table `PaymentProvider` → confirm row with `code = MERCADO_PAGO`.

OR via psql:

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

## Phase 1 — Connection service (persistence layer)

The "stateful" half of OAuth: read/write the encrypted token envelope from `EcommerceMerchant.providerCredentials`.

---

### Task 7: Connection service — persistTokens

**Files:**
- Create: `src/services/mercado-pago/connection.service.ts`
- Create: `tests/unit/services/mercado-pago/connection.service.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/services/mercado-pago/connection.service.test.ts`:

```typescript
import { persistTokens, loadCredentials } from '@/services/mercado-pago/connection.service'
import { decryptTokenFromBase64 } from '@/services/mercado-pago/encryption.service'
import prisma from '@/utils/prismaClient'
import type { MercadoPagoTokenResponse } from '@/services/mercado-pago/types'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    paymentProvider: {
      findUnique: jest.fn(),
    },
  },
}))

const mockPrisma = prisma as unknown as {
  ecommerceMerchant: { findUnique: jest.Mock; update: jest.Mock }
  paymentProvider: { findUnique: jest.Mock }
}

describe('mercado-pago connection service - persistTokens', () => {
  beforeEach(() => jest.clearAllMocks())

  it('encrypts tokens and writes them to providerCredentials', async () => {
    const tokenResponse: MercadoPagoTokenResponse = {
      access_token: 'APP_USR-access-xyz',
      token_type: 'bearer',
      expires_in: 15552000,
      scope: 'offline_access read write',
      user_id: 12345678,
      refresh_token: 'TG-refresh-abc',
      public_key: 'APP_USR-pk-xyz',
      live_mode: false,
    }

    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await persistTokens('em_1', tokenResponse)

    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalledTimes(1)
    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'em_1' })
    expect(updateArgs.data.providerMerchantId).toBe('12345678')

    const creds = updateArgs.data.providerCredentials
    expect(creds.mpUserId).toBe('12345678')
    expect(creds.scope).toBe('offline_access read write')
    expect(creds.liveMode).toBe(false)
    expect(typeof creds.expiresAt).toBe('string')
    expect(new Date(creds.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // Tokens are encrypted (not equal to plaintext) but decrypt back
    expect(creds.accessTokenCiphertext).not.toBe('APP_USR-access-xyz')
    expect(decryptTokenFromBase64(creds.accessTokenCiphertext)).toBe('APP_USR-access-xyz')
    expect(decryptTokenFromBase64(creds.refreshTokenCiphertext)).toBe('TG-refresh-abc')
  })
})

describe('mercado-pago connection service - loadCredentials', () => {
  beforeEach(() => jest.clearAllMocks())

  it('decrypts and returns credentials when present', async () => {
    const { encryptTokenToBase64 } = require('@/services/mercado-pago/encryption.service')
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        mpUserId: '12345678',
        accessTokenCiphertext: encryptTokenToBase64('APP_USR-access-xyz'),
        refreshTokenCiphertext: encryptTokenToBase64('TG-refresh-abc'),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        scope: 'offline_access read write',
        liveMode: false,
      },
    })

    const result = await loadCredentials('em_1')
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe('APP_USR-access-xyz')
    expect(result!.refreshToken).toBe('TG-refresh-abc')
    expect(result!.mpUserId).toBe('12345678')
  })

  it('returns null when merchant has no credentials', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {},
    })

    const result = await loadCredentials('em_1')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/connection.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement connection service**

Create `src/services/mercado-pago/connection.service.ts`:

```typescript
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { encryptTokenToBase64, decryptTokenFromBase64 } from './encryption.service'
import type { MercadoPagoCredentials, MercadoPagoTokenResponse } from './types'

export interface DecryptedCredentials {
  mpUserId: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string
  liveMode: boolean
  lastRefreshedAt?: Date
}

/** Persist a fresh OAuth token response into EcommerceMerchant.providerCredentials. */
export async function persistTokens(ecommerceMerchantId: string, tokens: MercadoPagoTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const mpUserId = String(tokens.user_id)

  const credentials: MercadoPagoCredentials = {
    mpUserId,
    accessTokenCiphertext: encryptTokenToBase64(tokens.access_token),
    refreshTokenCiphertext: encryptTokenToBase64(tokens.refresh_token),
    expiresAt: expiresAt.toISOString(),
    scope: tokens.scope,
    liveMode: tokens.live_mode,
    lastRefreshedAt: new Date().toISOString(),
  }

  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: {
      providerCredentials: credentials as unknown as Prisma.InputJsonValue,
      providerMerchantId: mpUserId,
    },
  })
}

/** Load and decrypt credentials. Returns null if the merchant has no MP connection. */
export async function loadCredentials(ecommerceMerchantId: string): Promise<DecryptedCredentials | null> {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: ecommerceMerchantId },
    select: { providerCredentials: true },
  })
  if (!merchant) return null

  const creds = merchant.providerCredentials as unknown as MercadoPagoCredentials | null
  if (!creds?.accessTokenCiphertext || !creds?.refreshTokenCiphertext) return null

  return {
    mpUserId: creds.mpUserId,
    accessToken: decryptTokenFromBase64(creds.accessTokenCiphertext),
    refreshToken: decryptTokenFromBase64(creds.refreshTokenCiphertext),
    expiresAt: new Date(creds.expiresAt),
    scope: creds.scope,
    liveMode: creds.liveMode,
    lastRefreshedAt: creds.lastRefreshedAt ? new Date(creds.lastRefreshedAt) : undefined,
  }
}

/** Wipe MP credentials (disconnect). */
export async function clearCredentials(ecommerceMerchantId: string): Promise<void> {
  await prisma.ecommerceMerchant.update({
    where: { id: ecommerceMerchantId },
    data: {
      providerCredentials: {} as Prisma.InputJsonValue,
      providerMerchantId: null,
    },
  })
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/connection.service.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/connection.service.ts tests/unit/services/mercado-pago/connection.service.test.ts
git commit -m "feat(mercado-pago): connection service for token persist/load/clear"
```

---

### Task 8: Connection service — refreshIfExpiring

**Files:**
- Modify: `src/services/mercado-pago/connection.service.ts`
- Modify: `tests/unit/services/mercado-pago/connection.service.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/services/mercado-pago/connection.service.test.ts`:

```typescript
import { refreshIfExpiring } from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'

jest.mock('@/services/mercado-pago/oauth.service')

describe('mercado-pago connection service - refreshIfExpiring', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refreshes the token when expiry is within the threshold', async () => {
    const { encryptTokenToBase64 } = require('@/services/mercado-pago/encryption.service')
    const expiringSoon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) // 10 days

    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        mpUserId: '12345678',
        accessTokenCiphertext: encryptTokenToBase64('OLD-access'),
        refreshTokenCiphertext: encryptTokenToBase64('OLD-refresh'),
        expiresAt: expiringSoon.toISOString(),
        scope: 'offline_access read write',
        liveMode: false,
      },
    })

    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'NEW-access',
      refresh_token: 'NEW-refresh',
      user_id: 12345678,
      expires_in: 15552000,
      scope: 'offline_access read write',
      token_type: 'bearer',
      public_key: 'pk',
      live_mode: false,
    })

    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    const result = await refreshIfExpiring('em_1', 30) // 30-day threshold
    expect(result).toBe('refreshed')
    expect(oauthService.refreshAccessToken).toHaveBeenCalledWith('OLD-refresh')
    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalled()
  })

  it('skips refresh when token has plenty of life left', async () => {
    const { encryptTokenToBase64 } = require('@/services/mercado-pago/encryption.service')
    const farFuture = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000) // 100 days

    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        mpUserId: '12345678',
        accessTokenCiphertext: encryptTokenToBase64('access'),
        refreshTokenCiphertext: encryptTokenToBase64('refresh'),
        expiresAt: farFuture.toISOString(),
        scope: 'offline_access read write',
        liveMode: false,
      },
    })

    const result = await refreshIfExpiring('em_1', 30)
    expect(result).toBe('not_needed')
    expect(oauthService.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns "no_credentials" when merchant has none', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', providerCredentials: {} })
    const result = await refreshIfExpiring('em_1', 30)
    expect(result).toBe('no_credentials')
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/connection.service.test.ts`
Expected: 3 new tests FAIL — `refreshIfExpiring` not exported.

- [ ] **Step 3: Implement refreshIfExpiring**

Append to `src/services/mercado-pago/connection.service.ts`:

```typescript
import { refreshAccessToken } from './oauth.service'

export type RefreshResult = 'refreshed' | 'not_needed' | 'no_credentials'

/**
 * Refresh the access_token if it expires within `thresholdDays`. Idempotent —
 * safe to call repeatedly. Returns:
 *   - "refreshed":      a new token was minted and persisted
 *   - "not_needed":     token still has more than threshold life remaining
 *   - "no_credentials": merchant has not connected MP yet
 */
export async function refreshIfExpiring(ecommerceMerchantId: string, thresholdDays = 30): Promise<RefreshResult> {
  const creds = await loadCredentials(ecommerceMerchantId)
  if (!creds) return 'no_credentials'

  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000
  const remaining = creds.expiresAt.getTime() - Date.now()
  if (remaining > thresholdMs) return 'not_needed'

  const fresh = await refreshAccessToken(creds.refreshToken)
  await persistTokens(ecommerceMerchantId, fresh)
  return 'refreshed'
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/connection.service.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/connection.service.ts tests/unit/services/mercado-pago/connection.service.test.ts
git commit -m "feat(mercado-pago): refreshIfExpiring with 30-day threshold default"
```

---

## Phase 2 — Checkout, refund, payment lookup

Calls MP's REST API using the seller's `access_token`.

---

### Task 9: Checkout service — createPreference (Checkout Pro)

**Files:**
- Create: `src/services/mercado-pago/checkout.service.ts`
- Create: `tests/unit/services/mercado-pago/checkout.service.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/services/mercado-pago/checkout.service.test.ts`:

```typescript
import nock from 'nock'
import { createPreference } from '@/services/mercado-pago/checkout.service'

describe('mercado-pago checkout - createPreference', () => {
  beforeEach(() => nock.cleanAll())
  afterAll(() => nock.restore())

  it('POSTs to /checkout/preferences with marketplace_fee and Bearer token', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER-access' } })
      .post('/checkout/preferences', body => {
        return body.marketplace_fee === 50
          && body.items?.[0]?.unit_price === 1000
          && body.items?.[0]?.currency_id === 'MXN'
          && body.external_reference === 'order_123'
          && body.back_urls?.success === 'https://avoqado.io/success'
          && body.notification_url === 'https://api.avoqado.io/api/v1/webhooks/mercadopago'
      })
      .reply(200, {
        id: 'pref_abc123',
        init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc123',
        sandbox_init_point: 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc123',
        date_created: '2026-05-19T18:00:00.000Z',
      })

    const result = await createPreference({
      accessToken: 'SELLER-access',
      sandboxMode: false,
      orderId: 'order_123',
      amount: 1000,
      currency: 'MXN',
      description: 'Sesión yoga',
      marketplaceFee: 50,
      payerEmail: 'buyer@example.com',
      successUrl: 'https://avoqado.io/success',
      failureUrl: 'https://avoqado.io/fail',
      pendingUrl: 'https://avoqado.io/pending',
      notificationUrl: 'https://api.avoqado.io/api/v1/webhooks/mercadopago',
    })

    expect(result.id).toBe('pref_abc123')
    expect(result.initPoint).toBe('https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc123')
    expect(result.sandboxInitPoint).toBe('https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_abc123')
  })

  it('uses sandbox_init_point as primary URL when sandboxMode=true', async () => {
    nock('https://api.mercadopago.com')
      .post('/checkout/preferences')
      .reply(200, {
        id: 'pref_xyz',
        init_point: 'https://prod.example/p',
        sandbox_init_point: 'https://sandbox.example/p',
      })

    const result = await createPreference({
      accessToken: 'SELLER-access',
      sandboxMode: true,
      orderId: 'order_456',
      amount: 500,
      currency: 'MXN',
      description: 'Test',
      marketplaceFee: 0,
      successUrl: 'https://a',
      failureUrl: 'https://b',
      pendingUrl: 'https://c',
      notificationUrl: 'https://d',
    })

    expect(result.url).toBe('https://sandbox.example/p')
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement createPreference**

Create `src/services/mercado-pago/checkout.service.ts`:

```typescript
import axios, { AxiosError } from 'axios'

const API_BASE = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'

export interface CreatePreferenceParams {
  accessToken: string
  sandboxMode: boolean
  orderId: string
  amount: number
  currency: string
  description: string
  /** Platform fee in the same currency unit (MXN). Deducted AFTER MP's commission. */
  marketplaceFee: number
  payerEmail?: string
  successUrl: string
  failureUrl: string
  pendingUrl: string
  /** Where MP sends IPN notifications. Typically https://api.avoqado.io/api/v1/webhooks/mercadopago */
  notificationUrl: string
}

export interface PreferenceResult {
  id: string
  initPoint: string
  sandboxInitPoint: string
  /** Primary URL the frontend should redirect to — automatically chooses prod vs sandbox. */
  url: string
}

export async function createPreference(params: CreatePreferenceParams): Promise<PreferenceResult> {
  try {
    const { data } = await axios.post(
      `${API_BASE}/checkout/preferences`,
      {
        items: [
          {
            id: params.orderId,
            title: params.description,
            quantity: 1,
            unit_price: params.amount,
            currency_id: params.currency,
          },
        ],
        external_reference: params.orderId,
        marketplace_fee: params.marketplaceFee,
        payer: params.payerEmail ? { email: params.payerEmail } : undefined,
        back_urls: {
          success: params.successUrl,
          failure: params.failureUrl,
          pending: params.pendingUrl,
        },
        auto_return: 'approved',
        notification_url: params.notificationUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    )

    return {
      id: data.id,
      initPoint: data.init_point,
      sandboxInitPoint: data.sandbox_init_point,
      url: params.sandboxMode ? data.sandbox_init_point : data.init_point,
    }
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      throw new Error(`MP createPreference failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/checkout.service.ts tests/unit/services/mercado-pago/checkout.service.test.ts
git commit -m "feat(mercado-pago): createPreference for Checkout Pro with marketplace_fee"
```

---

### Task 10: Checkout service — getPayment

**Files:**
- Modify: `src/services/mercado-pago/checkout.service.ts`
- Modify: `tests/unit/services/mercado-pago/checkout.service.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/services/mercado-pago/checkout.service.test.ts`:

```typescript
import { getPayment } from '@/services/mercado-pago/checkout.service'

describe('mercado-pago checkout - getPayment', () => {
  beforeEach(() => nock.cleanAll())

  it('GETs /v1/payments/:id with Bearer token', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER-access' } })
      .get('/v1/payments/12345')
      .reply(200, {
        id: 12345,
        status: 'approved',
        status_detail: 'accredited',
        external_reference: 'order_123',
        transaction_amount: 1000,
        currency_id: 'MXN',
        date_approved: '2026-05-19T18:00:00.000Z',
        date_created: '2026-05-19T17:55:00.000Z',
        fee_details: [{ type: 'mercadopago_fee', amount: 29, fee_payer: 'collector' }],
        marketplace_fee: 50,
      })

    const result = await getPayment('SELLER-access', '12345')
    expect(result.status).toBe('approved')
    expect(result.id).toBe(12345)
    expect(result.transaction_amount).toBe(1000)
    expect(result.external_reference).toBe('order_123')
    expect(result.marketplace_fee).toBe(50)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: 1 new test FAIL — `getPayment` not exported.

- [ ] **Step 3: Implement getPayment**

Append to `src/services/mercado-pago/checkout.service.ts`:

```typescript
import type { MercadoPagoPayment } from './types'

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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/checkout.service.ts tests/unit/services/mercado-pago/checkout.service.test.ts
git commit -m "feat(mercado-pago): getPayment lookup by payment ID"
```

---

### Task 11: Checkout service — refundPayment

**Files:**
- Modify: `src/services/mercado-pago/checkout.service.ts`
- Modify: `tests/unit/services/mercado-pago/checkout.service.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/services/mercado-pago/checkout.service.test.ts`:

```typescript
import { refundPayment } from '@/services/mercado-pago/checkout.service'

describe('mercado-pago checkout - refundPayment', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs partial refund with amount', async () => {
    nock('https://api.mercadopago.com', { reqheaders: { authorization: 'Bearer SELLER-access' } })
      .post('/v1/payments/12345/refunds', { amount: 250 })
      .matchHeader('x-idempotency-key', 'idem-refund-1')
      .reply(201, {
        id: 99999,
        payment_id: 12345,
        amount: 250,
        status: 'approved',
      })

    const result = await refundPayment({
      accessToken: 'SELLER-access',
      paymentId: '12345',
      amount: 250,
      idempotencyKey: 'idem-refund-1',
    })

    expect(result.id).toBe(99999)
    expect(result.amount).toBe(250)
    expect(result.status).toBe('approved')
  })

  it('POSTs full refund when amount is omitted', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments/12345/refunds', body => body && Object.keys(body).length === 0)
      .matchHeader('x-idempotency-key', 'idem-refund-2')
      .reply(201, {
        id: 88888,
        payment_id: 12345,
        amount: 1000,
        status: 'approved',
      })

    const result = await refundPayment({
      accessToken: 'SELLER-access',
      paymentId: '12345',
      idempotencyKey: 'idem-refund-2',
    })

    expect(result.amount).toBe(1000)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement refundPayment**

Append to `src/services/mercado-pago/checkout.service.ts`:

```typescript
export interface RefundPaymentParams {
  accessToken: string
  paymentId: string
  /** Omit for full refund; provide a value smaller than transaction_amount for partial. */
  amount?: number
  idempotencyKey: string
}

export interface RefundPaymentResult {
  id: number
  payment_id: number
  amount: number
  status: 'approved' | 'rejected' | 'in_process'
}

export async function refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult> {
  try {
    const body = params.amount !== undefined ? { amount: params.amount } : {}
    const { data } = await axios.post<RefundPaymentResult>(
      `${API_BASE}/v1/payments/${params.paymentId}/refunds`,
      body,
      {
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
          'x-idempotency-key': params.idempotencyKey,
        },
        timeout: 15000,
      },
    )
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response?.data) {
      throw new Error(`MP refundPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/checkout.service.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/checkout.service.ts tests/unit/services/mercado-pago/checkout.service.test.ts
git commit -m "feat(mercado-pago): refundPayment with idempotency key"
```

---

## Phase 3 — Webhook verification

MP signs webhooks with HMAC SHA-256 over `id;request-id;ts` (or similar — verify against current MP docs). The handler must use `express.raw()` to receive the unparsed body, then verify signature.

---

### Task 12: Webhook signature verification service

**Files:**
- Create: `src/services/mercado-pago/webhook.service.ts`
- Create: `tests/unit/services/mercado-pago/webhook.service.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/services/mercado-pago/webhook.service.test.ts`:

```typescript
import crypto from 'crypto'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'

describe('mercado-pago webhook signature verification', () => {
  const SECRET = process.env.MP_WEBHOOK_SECRET!
  const sampleBody = JSON.stringify({
    id: 12345,
    live_mode: false,
    type: 'payment',
    action: 'payment.created',
    data: { id: 'pay_abc' },
  })

  function buildSignature(ts: string, requestId: string, dataId: string): string {
    // MP manifest format: id:<data.id>;request-id:<request-id>;ts:<ts>;
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
    const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
    return `ts=${ts},v1=${v1}`
  }

  it('accepts a valid signature', () => {
    const ts = '1700000000'
    const requestId = 'req-abc-123'
    const dataId = 'pay_abc'
    const sigHeader = buildSignature(ts, requestId, dataId)

    expect(() =>
      verifyWebhookSignature({
        body: Buffer.from(sampleBody),
        signature: sigHeader,
        requestId,
        dataId,
      }),
    ).not.toThrow()
  })

  it('rejects an invalid signature', () => {
    const sigHeader = 'ts=1700000000,v1=deadbeef0000'
    expect(() =>
      verifyWebhookSignature({
        body: Buffer.from(sampleBody),
        signature: sigHeader,
        requestId: 'req-x',
        dataId: 'pay_abc',
      }),
    ).toThrow(/invalid/i)
  })

  it('rejects when signature header is malformed', () => {
    expect(() =>
      verifyWebhookSignature({
        body: Buffer.from(sampleBody),
        signature: 'garbage',
        requestId: 'req-x',
        dataId: 'pay_abc',
      }),
    ).toThrow(/malformed|invalid/i)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/mercado-pago/webhook.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement webhook verification**

Create `src/services/mercado-pago/webhook.service.ts`:

```typescript
/**
 * Mercado Pago webhook signature verification.
 *
 * MP signs webhooks with HMAC SHA-256 over a manifest string of the form:
 *   id:<data.id>;request-id:<request-id>;ts:<ts>;
 *
 * The `x-signature` header has two comma-separated parts: `ts=<ts>,v1=<hex>`.
 * The `x-request-id` header provides the request-id.
 *
 * @see https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks
 */
import crypto from 'crypto'

export interface VerifyWebhookSignatureParams {
  body: Buffer
  /** Value of `x-signature` header */
  signature: string
  /** Value of `x-request-id` header */
  requestId: string
  /** `data.id` from the payload (the MP entity id, e.g. payment id) */
  dataId: string
}

function requireWebhookSecret(): string {
  const secret = process.env.MP_WEBHOOK_SECRET
  if (!secret) throw new Error('MP_WEBHOOK_SECRET is not set')
  return secret
}

function parseSignatureHeader(header: string): { ts: string; v1: string } {
  const parts = header.split(',').map(p => p.trim())
  const obj: Record<string, string> = {}
  for (const part of parts) {
    const [k, v] = part.split('=')
    if (k && v) obj[k] = v
  }
  if (!obj.ts || !obj.v1) {
    throw new Error('malformed x-signature header')
  }
  return { ts: obj.ts, v1: obj.v1 }
}

export function verifyWebhookSignature(params: VerifyWebhookSignatureParams): void {
  const { ts, v1 } = parseSignatureHeader(params.signature)
  const manifest = `id:${params.dataId};request-id:${params.requestId};ts:${ts};`
  const expected = crypto.createHmac('sha256', requireWebhookSecret()).update(manifest).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('invalid MP webhook signature')
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/services/mercado-pago/webhook.service.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/services/mercado-pago/webhook.service.ts tests/unit/services/mercado-pago/webhook.service.test.ts
git commit -m "feat(mercado-pago): HMAC SHA-256 webhook signature verification"
```

---

## Phase 4 — Provider implementation (IEcommerceProvider contract)

Now wire all the pieces into a class implementing `IEcommerceProvider` and register it in the provider registry.

---

### Task 13: MercadoPagoProvider class skeleton + registry

**Files:**
- Create: `src/services/payments/providers/mercado-pago.provider.ts`
- Modify: `src/services/payments/provider-registry.ts`
- Create: `tests/unit/services/payments/providers/mercado-pago.provider.test.ts`

- [ ] **Step 1: Write failing test for registry integration**

Create `tests/unit/services/payments/providers/mercado-pago.provider.test.ts`:

```typescript
import { getProvider } from '@/services/payments/provider-registry'
import { MercadoPagoProvider } from '@/services/payments/providers/mercado-pago.provider'

describe('provider registry includes MercadoPago', () => {
  it('returns a MercadoPagoProvider for MERCADO_PAGO code', () => {
    const merchant = {
      id: 'em_1',
      providerCredentials: {},
      sandboxMode: true,
      provider: { code: 'MERCADO_PAGO' },
    } as any

    const provider = getProvider(merchant)
    expect(provider).toBeInstanceOf(MercadoPagoProvider)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/services/payments/providers/mercado-pago.provider.test.ts`
Expected: FAIL — `MercadoPagoProvider` not exported and registry doesn't handle 'MERCADO_PAGO'.

- [ ] **Step 3: Create the provider skeleton**

Create `src/services/payments/providers/mercado-pago.provider.ts`:

```typescript
import { BadRequestError } from '@/errors/AppError'
import { ProviderCapabilityError } from './not-implemented.error'
import * as connectionService from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as checkoutService from '@/services/mercado-pago/checkout.service'
import * as webhookService from '@/services/mercado-pago/webhook.service'
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
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

const PROVIDER_CODE = 'MERCADO_PAGO'

export class MercadoPagoProvider implements IEcommerceProvider {
  async createOnboardingLink(merchant: EcommerceMerchantWithProvider, _returnPath?: string): Promise<OnboardingLink> {
    if (!merchant.venueId) {
      throw new BadRequestError('venueId es requerido para conectar Mercado Pago')
    }
    const statePayload: MercadoPagoOAuthState = {
      intent: 'connect_merchant',
      ecommerceMerchantId: merchant.id,
      venueId: merchant.venueId,
      staffId: '', // set by controller from authContext
      csrfNonce: Math.random().toString(36).slice(2),
    }
    const state = oauthService.signState(statePayload)
    const url = oauthService.buildAuthUrl(state)
    return { url, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }
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

  async createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')
    }
    if (params.amount <= 0) {
      throw new BadRequestError('El monto de pago debe ser mayor a cero')
    }
    if (params.applicationFeeAmount < 0 || params.applicationFeeAmount > params.amount) {
      throw new BadRequestError('La comisión de plataforma no puede exceder el monto de pago')
    }

    const preference = await checkoutService.createPreference({
      accessToken: creds.accessToken,
      sandboxMode: merchant.sandboxMode,
      orderId: params.metadata.orderId || params.idempotencyKey,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      marketplaceFee: params.applicationFeeAmount,
      payerEmail: params.customerEmail,
      successUrl: params.successUrl,
      failureUrl: params.cancelUrl,
      pendingUrl: params.cancelUrl,
      notificationUrl: process.env.MP_WEBHOOK_NOTIFICATION_URL || `${process.env.PUBLIC_API_URL}/api/v1/webhooks/mercadopago`,
    })

    return { id: preference.id, url: preference.url, expiresAt: params.expiresAt }
  }

  async getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')

    const payment = await checkoutService.getPayment(creds.accessToken, sessionId)
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
    if (!creds) throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')

    const refund = await checkoutService.refundPayment({
      accessToken: creds.accessToken,
      paymentId: params.paymentIntentId,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
    })

    return {
      refundId: String(refund.id),
      amount: refund.amount,
      status: refund.status === 'approved' ? 'SUCCEEDED' : refund.status === 'in_process' ? 'PENDING' : 'FAILED',
    }
  }

  async verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
    _endpoint: 'platform' | 'connect',
  ): Promise<VerifiedWebhookEvent> {
    // MP signs with x-signature header; we also need x-request-id and data.id
    // The provider interface doesn't pass those — the webhook controller will
    // call webhook.service.verifyWebhookSignature directly. This method exists
    // only to satisfy the interface and should not be used for MP.
    throw new ProviderCapabilityError(PROVIDER_CODE, 'verifyWebhookSignature: use mercadoPago.webhook.controller directly')
  }

  async tokenizeCard(_merchant: EcommerceMerchantWithProvider, _params: TokenizeCardParams): Promise<TokenizeCardResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'tokenizeCard')
  }

  async authorizeCardPayment(
    _merchant: EcommerceMerchantWithProvider,
    _params: AuthorizeCardPaymentParams,
  ): Promise<AuthorizeCardPaymentResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'authorizeCardPayment')
  }
}

function mapMpStatus(status: string): PaymentStatus['status'] {
  switch (status) {
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
    case 'rejected':
    case 'cancelled':
    default:
      return 'FAILED'
  }
}
```

- [ ] **Step 4: Wire into registry**

Edit `src/services/payments/provider-registry.ts`. Replace the `switch` block with:

```typescript
import { BadRequestError } from '@/errors/AppError'
import { BlumonProvider } from './providers/blumon.provider'
import { MercadoPagoProvider } from './providers/mercado-pago.provider'
import { EcommerceMerchantWithProvider, IEcommerceProvider } from './providers/provider.interface'
import { StripeConnectProvider } from './providers/stripe-connect.provider'

export function getProvider(merchant: EcommerceMerchantWithProvider): IEcommerceProvider {
  const providerCode = merchant.provider?.code

  switch (providerCode) {
    case 'BLUMON':
      return new BlumonProvider()
    case 'STRIPE_CONNECT':
      return new StripeConnectProvider()
    case 'MERCADO_PAGO':
      return new MercadoPagoProvider()
    default:
      throw new BadRequestError(`Proveedor de pagos no soportado: ${providerCode || 'desconocido'}`)
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- tests/unit/services/payments/providers/mercado-pago.provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/payments/providers/mercado-pago.provider.ts src/services/payments/provider-registry.ts tests/unit/services/payments/providers/mercado-pago.provider.test.ts
git commit -m "feat(mercado-pago): IEcommerceProvider implementation + registry wiring"
```

---

## Phase 5 — OAuth HTTP layer (dashboard endpoints)

Two endpoints: `GET /connect` initiates OAuth, `GET /callback` handles MP's redirect.

---

### Task 14: Zod schemas for OAuth endpoints

**Files:**
- Create: `src/schemas/dashboard/mercadoPagoOAuth.schema.ts`

- [ ] **Step 1: Create the schema file**

Create `src/schemas/dashboard/mercadoPagoOAuth.schema.ts`:

```typescript
import { z } from 'zod'

export const connectQuerySchema = z.object({
  ecommerceMerchantId: z.string().min(1, 'El ID del merchant es requerido'),
})

export const callbackQuerySchema = z.object({
  code: z.string().min(1, 'El código de autorización es requerido').optional(),
  state: z.string().min(1, 'El estado OAuth es requerido'),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export type ConnectQuery = z.infer<typeof connectQuerySchema>
export type CallbackQuery = z.infer<typeof callbackQuerySchema>
```

- [ ] **Step 2: Commit**

```bash
git add src/schemas/dashboard/mercadoPagoOAuth.schema.ts
git commit -m "feat(mercado-pago): Zod schemas for OAuth endpoints (Spanish messages)"
```

---

### Task 15: OAuth controller — initiate

**Files:**
- Create: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`
- Create: `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`:

```typescript
import { Request, Response } from 'express'
import { initiate } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as oauthService from '@/services/mercado-pago/oauth.service'

jest.mock('@/services/mercado-pago/oauth.service')

function buildRes() {
  const res: Partial<Response> = {}
  res.redirect = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response
}

describe('mercadoPagoOAuth.controller - initiate', () => {
  beforeEach(() => jest.clearAllMocks())

  it('redirects to the MP authorize URL with a signed state', async () => {
    ;(oauthService.signState as jest.Mock).mockReturnValue('signed-state-jwt')
    ;(oauthService.buildAuthUrl as jest.Mock).mockReturnValue('https://auth.mercadopago.com.mx/authorization?client_id=x&state=signed-state-jwt')

    const req = {
      query: { ecommerceMerchantId: 'em_abc' },
      authContext: { userId: 'staff_1', venueId: 'venue_1', orgId: 'org_1', role: 'OWNER' },
    } as any
    const res = buildRes()

    await initiate(req, res)

    expect(oauthService.signState).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_abc',
      venueId: 'venue_1',
      staffId: 'staff_1',
    }))
    expect(res.redirect).toHaveBeenCalledWith('https://auth.mercadopago.com.mx/authorization?client_id=x&state=signed-state-jwt')
  })

  it('returns 400 when ecommerceMerchantId is missing', async () => {
    const req = {
      query: {},
      authContext: { userId: 'staff_1', venueId: 'venue_1', orgId: 'org_1', role: 'OWNER' },
    } as any
    const res = buildRes()

    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement initiate**

Create `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`:

```typescript
import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { connectQuerySchema, callbackQuerySchema } from '@/schemas/dashboard/mercadoPagoOAuth.schema'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

export async function initiate(req: Request, res: Response) {
  const parsed = connectQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.errors[0].message })
  }

  const { userId: staffId, venueId } = (req as any).authContext ?? {}
  if (!staffId || !venueId) {
    return res.status(401).json({ success: false, error: 'No autenticado' })
  }

  const statePayload: MercadoPagoOAuthState = {
    intent: 'connect_merchant',
    ecommerceMerchantId: parsed.data.ecommerceMerchantId,
    venueId,
    staffId,
    csrfNonce: Math.random().toString(36).slice(2),
  }

  const state = oauthService.signState(statePayload)
  const url = oauthService.buildAuthUrl(state)
  logger.info({ ecommerceMerchantId: parsed.data.ecommerceMerchantId, venueId, staffId }, '[MP OAuth] initiating')
  return res.redirect(url)
}

// callback added in Task 16
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts
git commit -m "feat(mercado-pago): OAuth initiate controller"
```

---

### Task 16: OAuth controller — callback

**Files:**
- Modify: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`
- Modify: `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`:

```typescript
import { callback } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as connectionService from '@/services/mercado-pago/connection.service'

jest.mock('@/services/mercado-pago/connection.service')

describe('mercadoPagoOAuth.controller - callback', () => {
  beforeEach(() => jest.clearAllMocks())

  it('exchanges code, persists tokens, redirects to dashboard success', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_abc',
      venueId: 'venue_1',
      staffId: 'staff_1',
      csrfNonce: 'nonce',
    })
    ;(oauthService.exchangeCodeForTokens as jest.Mock).mockResolvedValue({
      access_token: 'APP_USR-access',
      refresh_token: 'TG-refresh',
      user_id: 12345678,
      expires_in: 15552000,
      scope: 'offline_access read write',
      token_type: 'bearer',
      public_key: 'pk',
      live_mode: false,
    })
    ;(connectionService.persistTokens as jest.Mock).mockResolvedValue(undefined)

    process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'

    const req = { query: { code: 'auth-code', state: 'signed-state' } } as any
    const res = buildRes()

    await callback(req, res)

    expect(oauthService.exchangeCodeForTokens).toHaveBeenCalledWith('auth-code')
    expect(connectionService.persistTokens).toHaveBeenCalledWith('em_abc', expect.objectContaining({ access_token: 'APP_USR-access' }))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=connected'))
  })

  it('redirects to dashboard error when state is invalid', async () => {
    ;(oauthService.verifyState as jest.Mock).mockImplementation(() => { throw new Error('bad state') })

    process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'

    const req = { query: { code: 'auth-code', state: 'bad' } } as any
    const res = buildRes()

    await callback(req, res)

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=error'))
  })

  it('redirects to dashboard error when MP returned an error param', async () => {
    process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'
    const req = { query: { state: 'signed-state', error: 'access_denied' } } as any
    const res = buildRes()

    await callback(req, res)

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=error'))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('access_denied'))
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`
Expected: 3 new tests FAIL.

- [ ] **Step 3: Implement callback**

Append to `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`:

```typescript
export async function callback(req: Request, res: Response) {
  const parsed = callbackQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).send('Parámetros OAuth inválidos')
  }

  const dashboardUrl = process.env.PUBLIC_DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:5173'

  // Error path: MP sent us back with error= param
  if (parsed.data.error) {
    logger.warn({ err: parsed.data.error, desc: parsed.data.error_description }, '[MP OAuth] callback returned error')
    const params = new URLSearchParams({ mp_status: 'error', reason: parsed.data.error, description: parsed.data.error_description || '' })
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?${params.toString()}`)
  }

  if (!parsed.data.code) {
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=missing_code`)
  }

  let statePayload: MercadoPagoOAuthState
  try {
    statePayload = oauthService.verifyState(parsed.data.state)
  } catch (err) {
    logger.warn({ err }, '[MP OAuth] state verification failed')
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=invalid_state`)
  }

  try {
    const tokens = await oauthService.exchangeCodeForTokens(parsed.data.code)
    await connectionService.persistTokens(statePayload.ecommerceMerchantId, tokens)
    logger.info({ ecommerceMerchantId: statePayload.ecommerceMerchantId, mpUserId: tokens.user_id }, '[MP OAuth] connected')

    const params = new URLSearchParams({
      mp_status: 'connected',
      ecommerceMerchantId: statePayload.ecommerceMerchantId,
    })
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?${params.toString()}`)
  } catch (err: any) {
    logger.error({ err: err.message }, '[MP OAuth] token exchange failed')
    return res.redirect(`${dashboardUrl}/integrations/mercadopago?mp_status=error&reason=token_exchange_failed`)
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts tests/unit/controllers/dashboard/mercadoPagoOAuth.controller.test.ts
git commit -m "feat(mercado-pago): OAuth callback handler with state verification"
```

---

### Task 17: OAuth controller — disconnect

**Files:**
- Modify: `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`

- [ ] **Step 1: Add the handler**

Append to `src/controllers/dashboard/mercadoPagoOAuth.controller.ts`:

```typescript
export async function disconnect(req: Request, res: Response) {
  const { ecommerceMerchantId } = req.params
  if (!ecommerceMerchantId) {
    return res.status(400).json({ success: false, error: 'ID del merchant requerido' })
  }
  await connectionService.clearCredentials(ecommerceMerchantId)
  logger.info({ ecommerceMerchantId }, '[MP OAuth] disconnected')
  return res.json({ success: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/controllers/dashboard/mercadoPagoOAuth.controller.ts
git commit -m "feat(mercado-pago): disconnect endpoint clears credentials"
```

---

### Task 18: Mount OAuth routes

**Files:**
- Create: `src/routes/dashboard/mercadoPagoOAuth.routes.ts`
- Modify: the central router file that mounts dashboard routes (search for `ecommerceMerchant.routes` import to find it)

- [ ] **Step 1: Create router file**

Create `src/routes/dashboard/mercadoPagoOAuth.routes.ts`:

```typescript
import { Router } from 'express'
import * as controller from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import authenticateToken from '@/middlewares/authenticateToken.middleware'

const router = Router()

// `initiate` MUST be authenticated — only the dashboard staff can connect a merchant
router.get('/connect', authenticateToken, controller.initiate)

// `callback` is hit by MP redirecting the browser; staff is still logged in via cookie
router.get('/callback', controller.callback)

// `disconnect` — authenticated dashboard action
router.delete('/:ecommerceMerchantId', authenticateToken, controller.disconnect)

export default router
```

> Verify the actual auth middleware path. Search: `grep -r "authenticateToken" src/middlewares/ | head -3`. Adjust the import if the file name differs.

- [ ] **Step 2: Mount in central router**

Find the router file that mounts dashboard routes (likely `src/routes/dashboard.routes.ts` or similar):

```bash
grep -rln "ecommerceMerchant" src/routes/*.ts | head -3
```

Edit that file. Add:

```typescript
import mercadoPagoOAuthRoutes from './dashboard/mercadoPagoOAuth.routes'

// ... existing mounts ...
router.use('/integrations/mercadopago/oauth', mercadoPagoOAuthRoutes)
```

The final endpoint paths become:
- `GET  /api/v1/dashboard/integrations/mercadopago/oauth/connect?ecommerceMerchantId=<id>`
- `GET  /api/v1/dashboard/integrations/mercadopago/oauth/callback?code=<>&state=<>`
- `DELETE /api/v1/dashboard/integrations/mercadopago/oauth/:ecommerceMerchantId`

> Set `MP_REDIRECT_URI` in `.env` to match the callback path: `https://api.avoqado.io/api/v1/dashboard/integrations/mercadopago/oauth/callback`.

- [ ] **Step 3: Smoke test the build**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/dashboard/mercadoPagoOAuth.routes.ts src/routes/<central-router-file>.ts
git commit -m "feat(mercado-pago): mount OAuth routes under /dashboard/integrations/mercadopago/oauth"
```

---

## Phase 6 — Webhook HTTP handler

---

### Task 19: Webhook controller

**Files:**
- Create: `src/controllers/webhook/mercadoPago.webhook.controller.ts`
- Create: `tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts`:

```typescript
import crypto from 'crypto'
import { Request, Response } from 'express'
import { handleMercadoPagoWebhook } from '@/controllers/webhook/mercadoPago.webhook.controller'

function buildRes() {
  const res: Partial<Response> = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res as Response
}

describe('mercadoPago.webhook.controller', () => {
  const SECRET = process.env.MP_WEBHOOK_SECRET!

  function signedRequest(payload: object, dataId: string, requestId: string) {
    const body = Buffer.from(JSON.stringify(payload))
    const ts = String(Math.floor(Date.now() / 1000))
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
    const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
    return {
      body,
      headers: {
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': requestId,
      },
    }
  }

  it('returns 200 for a valid signature', async () => {
    const { body, headers } = signedRequest(
      { id: 1, live_mode: false, type: 'payment', action: 'payment.created', data: { id: 'pay_123' } },
      'pay_123',
      'req-1',
    )
    const req = { body, headers, get: (k: string) => headers[k.toLowerCase() as keyof typeof headers] } as any
    const res = buildRes()

    await handleMercadoPagoWebhook(req, res)
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('returns 401 for an invalid signature', async () => {
    const body = Buffer.from(JSON.stringify({ data: { id: 'pay_x' } }))
    const headers = { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r1' }
    const req = { body, headers, get: (k: string) => headers[k.toLowerCase() as keyof typeof headers] } as any
    const res = buildRes()

    await handleMercadoPagoWebhook(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the controller**

Create `src/controllers/webhook/mercadoPago.webhook.controller.ts`:

```typescript
import { Request, Response } from 'express'
import logger from '@/config/logger'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'
import type { MercadoPagoWebhookPayload } from '@/services/mercado-pago/types'

export async function handleMercadoPagoWebhook(req: Request, res: Response) {
  const sigHeader = req.get('x-signature')
  const requestId = req.get('x-request-id')

  if (!sigHeader || !requestId) {
    return res.status(400).json({ error: 'missing x-signature or x-request-id' })
  }

  // `req.body` is a Buffer because the route is mounted with express.raw()
  let payload: MercadoPagoWebhookPayload
  try {
    payload = JSON.parse((req.body as Buffer).toString('utf8'))
  } catch (err) {
    return res.status(400).json({ error: 'invalid JSON body' })
  }

  try {
    verifyWebhookSignature({
      body: req.body as Buffer,
      signature: sigHeader,
      requestId,
      dataId: payload.data?.id ?? '',
    })
  } catch (err: any) {
    logger.warn({ err: err.message, requestId }, '[MP webhook] signature verification failed')
    return res.status(401).json({ error: 'invalid signature' })
  }

  logger.info({ type: payload.type, action: payload.action, dataId: payload.data?.id, requestId }, '[MP webhook] received')

  // TODO Task-20: persist + dispatch to handler based on payload.type
  return res.status(200).json({ received: true })
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/webhook/mercadoPago.webhook.controller.ts tests/unit/controllers/webhook/mercadoPago.webhook.controller.test.ts
git commit -m "feat(mercado-pago): webhook controller with HMAC signature verification"
```

---

### Task 20: Mount webhook route BEFORE express.json()

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Locate the Stripe/Google Calendar webhook mount block**

Read lines 79-95 of `src/app.ts`. They look like:

```typescript
// Stripe webhooks require raw body (not JSON parsed) for signature verification.
// ⚠️ Google Calendar webhook MUST mount BEFORE the existing /api/v1/webhooks ...
app.post('/api/v1/webhooks/google-calendar', express.raw({ type: '*/*', limit: '64kb' }), handleGoogleCalendarWebhook)

app.use(
  '/api/v1/webhooks',
  express.raw({ type: 'application/json' }),
  webhookRoutes,
)
```

- [ ] **Step 2: Add MP webhook route mount**

Right after the Google Calendar line and before the `/api/v1/webhooks` mount, add:

```typescript
import { handleMercadoPagoWebhook } from './controllers/webhook/mercadoPago.webhook.controller'

// MP webhook MUST mount BEFORE express.json() and BEFORE the existing /api/v1/webhooks
// router so we can use express.raw() for HMAC signature verification.
app.post('/api/v1/webhooks/mercadopago', express.raw({ type: '*/*', limit: '64kb' }), handleMercadoPagoWebhook)
```

- [ ] **Step 3: Build to verify no compile errors**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts
git commit -m "feat(mercado-pago): mount /api/v1/webhooks/mercadopago with express.raw()"
```

---

## Phase 7 — Token refresh cron job

---

### Task 21: Token refresh job

**Files:**
- Create: `src/jobs/mercadopago-token-refresh.job.ts`
- Create: `tests/unit/jobs/mercadopago-token-refresh.job.test.ts`
- Modify: the job scheduler bootstrap (search for `gcal-channel-renewal.job` to find where jobs are registered)

- [ ] **Step 1: Write failing test**

Create `tests/unit/jobs/mercadopago-token-refresh.job.test.ts`:

```typescript
import { refreshMercadoPagoTokens } from '@/jobs/mercadopago-token-refresh.job'
import prisma from '@/utils/prismaClient'
import * as connectionService from '@/services/mercado-pago/connection.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: { findMany: jest.fn() },
    paymentProvider: { findUnique: jest.fn() },
  },
}))
jest.mock('@/services/mercado-pago/connection.service')

const mockPrisma = prisma as unknown as { ecommerceMerchant: { findMany: jest.Mock }; paymentProvider: { findUnique: jest.Mock } }

describe('mercadopago-token-refresh.job', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refreshes tokens for every MP-connected merchant', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1', code: 'MERCADO_PAGO' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([
      { id: 'em_1' },
      { id: 'em_2' },
      { id: 'em_3' },
    ])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockResolvedValueOnce('refreshed')
      .mockResolvedValueOnce('not_needed')
      .mockResolvedValueOnce('refreshed')

    const summary = await refreshMercadoPagoTokens()
    expect(summary.refreshed).toBe(2)
    expect(summary.notNeeded).toBe(1)
    expect(summary.errors).toBe(0)
    expect(connectionService.refreshIfExpiring).toHaveBeenCalledTimes(3)
  })

  it('counts errors when refresh throws but continues processing', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1', code: 'MERCADO_PAGO' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'em_1' }, { id: 'em_2' }])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockRejectedValueOnce(new Error('MP API down'))
      .mockResolvedValueOnce('refreshed')

    const summary = await refreshMercadoPagoTokens()
    expect(summary.errors).toBe(1)
    expect(summary.refreshed).toBe(1)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- tests/unit/jobs/mercadopago-token-refresh.job.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the job**

Create `src/jobs/mercadopago-token-refresh.job.ts`:

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
    logger.warn('[MP refresh job] MERCADO_PAGO PaymentProvider not seeded; skipping')
    return { total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 }
  }

  const merchants = await prisma.ecommerceMerchant.findMany({
    where: { providerId: provider.id, providerMerchantId: { not: null } },
    select: { id: true },
  })

  const summary: RefreshSummary = {
    total: merchants.length,
    refreshed: 0,
    notNeeded: 0,
    noCredentials: 0,
    errors: 0,
  }

  for (const merchant of merchants) {
    try {
      const result = await refreshIfExpiring(merchant.id, 30)
      if (result === 'refreshed') summary.refreshed++
      else if (result === 'not_needed') summary.notNeeded++
      else summary.noCredentials++
    } catch (err: any) {
      summary.errors++
      logger.error({ err: err.message, ecommerceMerchantId: merchant.id }, '[MP refresh job] failed for merchant')
    }
  }

  logger.info({ summary }, '[MP refresh job] completed')
  return summary
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/jobs/mercadopago-token-refresh.job.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Register the cron job**

Find where cron jobs are registered:

```bash
grep -rln "gcal-channel-renewal\|cron.schedule\|node-cron" src/ | head -5
```

Open that file. Add (using `node-cron` syntax):

```typescript
import { refreshMercadoPagoTokens } from '@/jobs/mercadopago-token-refresh.job'

// Run daily at 3:00 AM Mexico City time
cron.schedule('0 3 * * *', async () => {
  try {
    await refreshMercadoPagoTokens()
  } catch (err) {
    logger.error({ err }, '[MP refresh job] uncaught')
  }
}, { timezone: 'America/Mexico_City' })
```

- [ ] **Step 6: Commit**

```bash
git add src/jobs/mercadopago-token-refresh.job.ts tests/unit/jobs/mercadopago-token-refresh.job.test.ts src/<scheduler-file>.ts
git commit -m "feat(mercado-pago): daily token refresh cron at 3 AM Mexico City"
```

---

## Phase 8 — Verification & smoke test

---

### Task 22: Manual sandbox smoke test (no code; verification only)

This task is gated on the user's MP account being verified and an MP sandbox application being created.

- [ ] **Step 1: Confirm prereqs are ready**
  - [ ] MP business account verified (KYC complete)
  - [ ] Sandbox application created in DevPanel with model = Marketplace, product = Checkout Pro
  - [ ] `client_id`, `client_secret`, `redirect_uri` filled into `.env`
  - [ ] `MERCADO_PAGO_TOKEN_KEY` generated (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
  - [ ] Three test users created via MCP: integrator, seller, buyer (all `MLM`)

- [ ] **Step 2: Configure webhook URL in MP DevPanel**

Use the MP MCP:
```
mcp__mercadopago__save_webhook
  application_id: <your sandbox app id>
  callback_sandbox: https://<your-ngrok-id>.ngrok.app/api/v1/webhooks/mercadopago
  topics: ["payment", "mp-connect"]
```

- [ ] **Step 3: Start the dev server with ngrok tunneling the webhook**

```bash
ngrok http 3000 &
npm run dev
```

Copy the ngrok HTTPS URL into both `MP_REDIRECT_URI` and `MP_WEBHOOK_NOTIFICATION_URL`. Restart `npm run dev`.

- [ ] **Step 4: Trigger OAuth from API client**

Get a dashboard auth token (logged in as owner of a venue with an `EcommerceMerchant`).

Open in browser (browser preserves cookies):
```
http://localhost:3000/api/v1/dashboard/integrations/mercadopago/oauth/connect?ecommerceMerchantId=<em-id>
```

You will be redirected to `auth.mercadopago.com.mx`. Log in with the **seller** test account. Authorize.

You should land on:
```
http://localhost:5173/integrations/mercadopago?mp_status=connected&ecommerceMerchantId=<em-id>
```

- [ ] **Step 5: Verify in DB**

```bash
psql $DATABASE_URL -c "SELECT id, \"providerMerchantId\", \"providerCredentials\"->>'mpUserId' AS mp_user, \"providerCredentials\"->>'expiresAt' AS expires FROM \"EcommerceMerchant\" WHERE id = '<em-id>';"
```

Expected: `providerMerchantId` = the seller's MP user_id, `expires` ≈ 180 days from now.

- [ ] **Step 6: Create a Checkout Pro preference via API**

Use whichever endpoint your ecommerce checkout already exposes (it should route through `getProvider(merchant).createCheckoutSession(...)`). Pass a small amount (e.g. 100 MXN) and a non-zero `applicationFeeAmount` (e.g. 5).

- [ ] **Step 7: Pay with sandbox card**

Open the `init_point` URL. Log in with the **buyer** test account. Pay with sandbox card `APRO` (e.g. Visa 4509 9535 6623 3704, any CVV, future expiry).

- [ ] **Step 8: Verify webhook arrived and DB updated**

Tail the server logs:
```
[MP webhook] received { type: 'payment', action: 'payment.updated', ... }
```

Open MP MCP:
```
mcp__mercadopago__notifications_history
  application_id: <your sandbox app id>
```
Expected: at least one successful delivery to your ngrok URL.

- [ ] **Step 9: Verify seller account balance reflects amount minus marketplace_fee**

Log in as the **seller** test user at `mercadopago.com.mx`. Open balance — should show `(amount − MP commission − applicationFeeAmount)`.

- [ ] **Step 10: Document the smoke test outcome**

Append to this plan a "Smoke test results" section with screenshots and the exact numbers (amount paid vs balance received vs fees collected) — useful for the proposal you'll send Cristina/Red Bloom and to confirm with the MP commercial executive.

---

## Self-Review Checklist

The implementing agent should run this before declaring complete:

- [ ] All 22 tasks committed with passing tests
- [ ] `npm test -- mercado-pago` passes (all MP-related test files)
- [ ] `npm run build` succeeds
- [ ] `npm run lint:fix && npm run format` clean
- [ ] `npm run pre-deploy` passes
- [ ] No new files in repo root
- [ ] `.env.example` updated with MP variables (without secrets)
- [ ] `EcommerceMerchant.providerCredentials` is the ONLY place MP tokens live (no new tables created)
- [ ] All Zod messages are in Spanish
- [ ] Webhook route mounted with `express.raw()` BEFORE `express.json()` in `app.ts`
- [ ] No hardcoded venue names, slugs, or test user IDs in source

---

## Out of Scope (separate plans / follow-ups)

These intentionally NOT included here:

1. **Frontend dashboard UI** — "Connect Mercado Pago" button, status badge, disconnect flow. Separate plan once backend OAuth works in sandbox. Lives in `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`.
2. **Checkout API (in-house card collection)** — current plan uses Checkout Pro (MP-hosted). Adding Checkout API requires PCI scope; punt to v2.
3. **Split Payments 1:N** (multi-payee per transaction) — requires MP commercial team approval. Add once Red Bloom needs consignataria-level splits.
4. **Production cutover** — requires MP commercial OK on rate preservation + production app credentials + KYC nivel 6 on all merchants. Live deploy is a separate runbook.
5. **MP card subscription support** (if Red Bloom adds memberships) — would require `/preapproval` API, out of marketplace flow.
6. **Cart-level fee tiers** — current code uses a single `applicationFeeAmount` per checkout. Future enhancement: per-product fee schedule.

---

## Risks tracked

| Risk | Mitigation |
|---|---|
| MP commercial team blocks Split Payments approval | Plan ships as sandbox-only until approved; production env vars stay empty in prod until cleared |
| MP changes webhook signing format | `verifyWebhookSignature` is isolated in one service; one place to update |
| Token refresh job fails silently | Job logs `errors` count to logger; add alerting (BetterStack already wired in repo) on `summary.errors > 0` |
| 180-day token expiry surprises us | Daily cron + 30-day buffer = 30 grace days to fix any issues |
| Multiple staff connect different MP accounts to same merchant | OAuth state includes `ecommerceMerchantId`; last-write-wins on `providerCredentials`. Acceptable for v1; consider audit log in v2. |
| MP user revokes our app | Subsequent API calls return 401; UI shows RESTRICTED status; staff re-runs OAuth |
