# Customer MCP — Phase 1 (OAuth 2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a venue operator connect their own Claude/ChatGPT/Gemini to Avoqado over a standards-compliant OAuth 2.1 flow (DCR → authorize
→ bcrypt login → PKCE code → token → `/mcp`), so the pasted-token step from Phase 0 disappears and the existing scoped read tools work
behind a real login.

**Architecture:** Avoqado IS the OAuth 2.1 Authorization Server (decision D5, design §8). We mount the MCP SDK's `mcpAuthRouter` at the
Express app root — it provides Dynamic Client Registration, discovery metadata, `/authorize`, `/token`, and `/revoke`. We supply an
`OAuthServerProvider` whose **access token is the Phase-0 audience-bound JWT** (`issueMcpToken`/`verifyMcpToken`), so token verification
stays stateless. Only three things need persistence (Prisma): DCR clients, single-use authorization codes, and refresh tokens (hashed at
rest). The `/authorize` step renders a self-contained bcrypt login page in `avoqado-server` (decision D3) that mirrors `loginStaff`'s
security checks. After login the token is bound to one active org (`getPrimaryOrganizationId`), and `/mcp` is guarded by the SDK's
`requireBearerAuth`, which puts `{ staffId, activeOrg }` on `req.auth.extra` for `resolveScope`.

**Tech Stack:** `@modelcontextprotocol/sdk@1.29.x` (already installed, Phase 0 `fa7a23b`), Express + TypeScript, Prisma/PostgreSQL,
`jsonwebtoken`, `bcrypt`, Node `crypto`. Branch `feat/customer-mcp-phase0` (worktree `avoqado-server/.worktrees/customer-mcp`), off
`develop`, **not merged**.

---

## Context: what Phase 0 already gives us (do not rebuild)

Verified, committed, on this branch:

| Piece                 | File                     | Signature                                                                                                            |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Audience-bound token  | `src/mcp/mcpToken.ts`    | `issueMcpToken(staffId, activeOrg, ttl=3600)`, `verifyMcpToken(token) → {sub, org}`, `MCP_AUDIENCE='avoqado-mcp'`    |
| Dashboard-token guard | `src/jwt.service.ts:167` | rejects any token whose `aud === 'avoqado-mcp'` from `/api/v1`                                                       |
| Scope resolver        | `src/mcp/scope.ts`       | `resolveScope(staffId, activeOrg) → McpScope` (org OWNER → all venues; else `StaffVenue`)                            |
| Central guard         | `src/mcp/guard.ts`       | `createGuard(scope)` → `venueFilter`, `requirePermission`, `redact`                                                  |
| 7 read tools          | `src/mcp/tools/*`        | venues, sales, orders (recent + find), terminals, reservations, inventory                                            |
| Transport             | `src/mcp/server.ts`      | `handleMcpRequest(req,res)` — currently parses the bearer header **manually** in `buildServerForRequest(authHeader)` |

Phase 1 changes exactly one thing about the existing code path: **the token's _source_ at `/mcp`** moves from "manually parse
`Authorization` header" to "read `req.auth.extra` populated by `requireBearerAuth`". Everything downstream of `resolveScope` is untouched.

Reusable platform code (already exists, do not modify behavior):

| Need                                                         | Source                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| bcrypt login pattern (lockout, emailVerified, active checks) | `src/services/dashboard/auth.service.ts:151` `loginStaff` (bcrypt at `:229`)                                               |
| Pick active org                                              | `src/services/staffOrganization.service.ts:17` `getPrimaryOrganizationId(staffId): Promise<string>` (isPrimary + isActive) |

## The OAuth flow we are building

```
Claude (MCP client)                     Avoqado (AS + RS, avoqado-server)
  │  GET /.well-known/oauth-authorization-server   ── mcpAuthRouter (SDK)
  │  POST /register (DCR)  ───────────────────────► clientsStore.registerClient ─► McpOAuthClient
  │  GET /authorize?client_id&redirect_uri&code_challenge&state&resource
  │                        ──► authorizationHandler (SDK) validates, calls
  │                            provider.authorize() ─► renders bcrypt LOGIN PAGE (HTML)
  │  POST /mcp-oauth/approve {email,password,+oauth params}  (OUR route)
  │                            authenticateForMcp() → staffId
  │                            getPrimaryOrganizationId() → activeOrg
  │                            store auth code (hash, 60s, single-use) ─► McpAuthCode
  │  302 redirect_uri?code=…&state=…
  │  POST /token grant_type=authorization_code&code_verifier
  │                        ──► token handler (SDK) verifies PKCE via
  │                            provider.challengeForAuthorizationCode(), then
  │                            provider.exchangeAuthorizationCode():
  │                              consume code → issueMcpToken() access (1h)
  │                                           + refresh (hash, 30d) ─► McpRefreshToken
  │  ◄── {access_token, refresh_token, expires_in}
  │  POST /mcp  Authorization: Bearer <access>
  │                        ──► requireBearerAuth({verifier: provider})
  │                            provider.verifyAccessToken() → AuthInfo.extra={staffId,activeOrg}
  │                            handleMcpRequest reads req.auth.extra → resolveScope → tools
```

## File structure

**Create (`src/mcp/oauth/`):**

- `config.ts` — issuer/resource URLs + TTL constants (env-driven).
- `tokenStore.ts` — auth-code + refresh-token persistence (create/consume/revoke), sha256 hashing.
- `clientsStore.ts` — `PrismaClientsStore` implementing `OAuthRegisteredClientsStore` (DCR).
- `credentials.ts` — `authenticateForMcp(email, password) → staffId` (bcrypt + lockout, mirrors `loginStaff`).
- `loginPage.ts` — `renderLoginPage(params, opts?)` → HTML string (escaped hidden fields).
- `provider.ts` — `AvoqadoOAuthProvider` implementing `OAuthServerProvider`.
- `router.ts` — `mcpOAuthApproveRouter()` (the `POST /mcp-oauth/approve` route) + `mountCustomerMcpAuth(app)`.

**Modify:**

- `prisma/schema.prisma` — 3 models (`McpOAuthClient`, `McpAuthCode`, `McpRefreshToken`).
- `scripts/generate-schema-map.ts` — add the 3 models to `MODEL_TO_DOMAIN`.
- `src/mcp/mcpToken.ts` — carry `clientId` in the token (AuthInfo needs it) + add `verifyMcpTokenFull`.
- `src/mcp/server.ts` — `handleMcpRequest` reads `req.auth.extra` (fallback: existing header path for the dev server).
- `src/app.ts` — mount `mcpAuthRouter` at root, the approve route, and guard `/mcp` with `requireBearerAuth`.

**Tests (`tests/unit/mcp-customer/`):**

- `oauth-tokenStore.test.ts`, `oauth-credentials.test.ts`, `oauth-loginPage.test.ts`, `oauth-provider.test.ts`.

> **Machine-load discipline (this worktree):** never run `npm run format` (whole-repo prettier pollution) or the full `jest`/`tsc` suite (V8
> OOM). Run only the scoped test file for each task: `npx jest tests/unit/mcp-customer/<file> --runInBand`. Reap orphan MCP servers with
> `pkill -f "mcp-dev-server.ts"` / `pkill -f "scripts/mcp/server.ts"`.

---

### Task 1: Prisma models + migration + schema-map

**Files:**

- Modify: `prisma/schema.prisma` (append near other auth/identity models)
- Modify: `scripts/generate-schema-map.ts`
- Migration: `prisma/migrations/<ts>_customer_mcp_oauth/migration.sql` (generated)

- [ ] **Step 1: Add the three models to `prisma/schema.prisma`**

```prisma
/// Dynamically-registered OAuth client (RFC 7591 DCR) for the customer MCP.
model McpOAuthClient {
  clientId               String   @id
  clientSecretHash       String?  // sha256 of the issued secret; null for public clients
  clientName             String?
  redirectUris           String[]
  grantTypes             String[] @default([])
  scope                  String?
  tokenEndpointAuthMethod String? @default("none")
  clientIdIssuedAt       Int? // epoch seconds
  clientSecretExpiresAt  Int? // epoch seconds; 0 = never
  createdAt              DateTime @default(now())

  @@map("mcp_oauth_clients")
}

/// Single-use, short-lived authorization code (PKCE). Stored hashed.
model McpAuthCode {
  codeHash      String    @id // sha256(code)
  clientId      String
  staffId       String
  activeOrg     String
  codeChallenge String
  redirectUri   String
  scopes        String[]  @default([])
  resource      String?
  expiresAt     DateTime
  consumedAt    DateTime?
  createdAt     DateTime  @default(now())

  @@index([expiresAt])
  @@map("mcp_auth_codes")
}

/// Refresh token (hashed at rest). Access tokens are stateless JWTs, not stored.
model McpRefreshToken {
  tokenHash String    @id // sha256(token)
  clientId  String
  staffId   String
  activeOrg String
  scopes    String[]  @default([])
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([staffId])
  @@index([expiresAt])
  @@map("mcp_refresh_tokens")
}
```

- [ ] **Step 2: Map the new models for the schema-map generator**

Find the domain used for identity models and reuse it (or add a dedicated one):

Run: `grep -nE "StaffOrganization|'Staff'" scripts/generate-schema-map.ts` Then in `MODEL_TO_DOMAIN`, add the three keys with that same
domain string (or a new `'Customer MCP / OAuth'` domain grouped beside it):

```typescript
  McpOAuthClient: 'Customer MCP / OAuth',
  McpAuthCode: 'Customer MCP / OAuth',
  McpRefreshToken: 'Customer MCP / OAuth',
```

(If you introduce a new domain string, confirm the generator accepts free-form domains — it groups by the string value. If it enforces a
fixed domain list, reuse the identity domain instead.)

- [ ] **Step 3: Create the migration (dev DB only — NEVER `db push`)**

Run: `npx prisma migrate dev --name customer_mcp_oauth` Expected: a new folder under `prisma/migrations/` and `prisma generate` runs. **Do
not hand-edit the generated SQL.**

- [ ] **Step 4: Regenerate the schema map**

Run: `npm run schema:map` Expected: `docs/SCHEMA_MAP.md` updates with the 3 models; script exits 0 (fails fast if a model is unmapped).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations scripts/generate-schema-map.ts docs/SCHEMA_MAP.md
git commit -m "feat(customer-mcp): Prisma models for OAuth (clients, auth codes, refresh tokens)"
```

---

### Task 2: Token store (auth codes + refresh tokens)

**Files:**

- Create: `src/mcp/oauth/config.ts`
- Create: `src/mcp/oauth/tokenStore.ts`
- Test: `tests/unit/mcp-customer/oauth-tokenStore.test.ts`

- [ ] **Step 1: Write `config.ts`** (no test — constants)

```typescript
/** Customer-MCP OAuth config. Issuer/resource come from env; sane localhost defaults for dev. */
export const MCP_ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? 'http://localhost:12344')
export const MCP_RESOURCE_URL = new URL(process.env.MCP_RESOURCE_URL ?? `${MCP_ISSUER_URL.origin}/mcp`)

export const ACCESS_TTL_SECONDS = 3600 // 1h — short, per review §7
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30 // 30d
export const AUTH_CODE_TTL_SECONDS = 60 // single-use, 1 min

export const MCP_SCOPES_SUPPORTED = ['mcp:read'] // writes are a later phase
```

- [ ] **Step 2: Write the failing test** `oauth-tokenStore.test.ts`

```typescript
import { createHash } from 'crypto'

// Mock prisma BEFORE importing the store (store imports prismaClient at module load).
const db = {
  mcpAuthCode: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  mcpRefreshToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))

import {
  createAuthCode,
  consumeAuthCode,
  createRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
} from '../../../src/mcp/oauth/tokenStore'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => jest.clearAllMocks())

describe('auth codes', () => {
  it('stores the HASH of the code, never the plaintext', async () => {
    db.mcpAuthCode.create.mockResolvedValue({})
    const { code } = await createAuthCode({
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      codeChallenge: 'cc',
      redirectUri: 'http://x',
      scopes: [],
      resource: undefined,
    })
    const arg = db.mcpAuthCode.create.mock.calls[0][0].data
    expect(arg.codeHash).toBe(sha(code))
    expect(JSON.stringify(arg)).not.toContain(code)
  })

  it('consumes a valid, unexpired, unused code exactly once', async () => {
    const row = {
      codeHash: sha('abc'),
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      codeChallenge: 'cc',
      redirectUri: 'http://x',
      scopes: [],
      resource: null,
      expiresAt: new Date(Date.now() + 10000),
      consumedAt: null,
    }
    db.mcpAuthCode.findUnique.mockResolvedValue(row)
    db.mcpAuthCode.update.mockResolvedValue({})
    const res = await consumeAuthCode('abc')
    expect(res?.staffId).toBe('s1')
    expect(db.mcpAuthCode.update).toHaveBeenCalledWith(expect.objectContaining({ where: { codeHash: sha('abc') } }))
  })

  it('rejects an expired code', async () => {
    db.mcpAuthCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1), consumedAt: null })
    await expect(consumeAuthCode('abc')).resolves.toBeNull()
  })

  it('rejects an already-consumed code', async () => {
    db.mcpAuthCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 10000), consumedAt: new Date() })
    await expect(consumeAuthCode('abc')).resolves.toBeNull()
  })
})

describe('refresh tokens', () => {
  it('stores the hash and consumes a valid token', async () => {
    db.mcpRefreshToken.create.mockResolvedValue({})
    const { token } = await createRefreshToken({ clientId: 'c1', staffId: 's1', activeOrg: 'o1', scopes: [] })
    expect(db.mcpRefreshToken.create.mock.calls[0][0].data.tokenHash).toBe(sha(token))

    db.mcpRefreshToken.findUnique.mockResolvedValue({
      tokenHash: sha(token),
      clientId: 'c1',
      staffId: 's1',
      activeOrg: 'o1',
      scopes: [],
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    })
    const res = await consumeRefreshToken(token)
    expect(res?.staffId).toBe('s1')
  })

  it('rejects a revoked token', async () => {
    db.mcpRefreshToken.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 1000), revokedAt: new Date() })
    await expect(consumeRefreshToken('x')).resolves.toBeNull()
  })
})
```

Run: `npx jest tests/unit/mcp-customer/oauth-tokenStore.test.ts --runInBand` Expected: FAIL — module `tokenStore` not found.

- [ ] **Step 3: Implement `tokenStore.ts`**

```typescript
import { randomBytes, createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import { AUTH_CODE_TTL_SECONDS, REFRESH_TTL_SECONDS } from './config'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const randomToken = () => randomBytes(32).toString('hex')

export interface AuthCodeData {
  clientId: string
  staffId: string
  activeOrg: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource?: string
}

export async function createAuthCode(d: AuthCodeData): Promise<{ code: string }> {
  const code = randomToken()
  await prisma.mcpAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: d.clientId,
      staffId: d.staffId,
      activeOrg: d.activeOrg,
      codeChallenge: d.codeChallenge,
      redirectUri: d.redirectUri,
      scopes: d.scopes,
      resource: d.resource ?? null,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
    },
  })
  return { code }
}

/** Returns the code's bound data and marks it consumed; null if missing/expired/used. */
export async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  const row = await prisma.mcpAuthCode.findUnique({ where: { codeHash: sha256(code) } })
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null
  await prisma.mcpAuthCode.update({ where: { codeHash: row.codeHash }, data: { consumedAt: new Date() } })
  return {
    clientId: row.clientId,
    staffId: row.staffId,
    activeOrg: row.activeOrg,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
    resource: row.resource ?? undefined,
  }
}

/** Returns the bound challenge for a code WITHOUT consuming it (SDK calls this before exchange). */
export async function peekAuthCodeChallenge(code: string): Promise<string | null> {
  const row = await prisma.mcpAuthCode.findUnique({
    where: { codeHash: sha256(code) },
    select: { codeChallenge: true, consumedAt: true, expiresAt: true },
  })
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null
  return row.codeChallenge
}

export interface RefreshData {
  clientId: string
  staffId: string
  activeOrg: string
  scopes: string[]
}

export async function createRefreshToken(d: RefreshData): Promise<{ token: string }> {
  const token = randomToken()
  await prisma.mcpRefreshToken.create({
    data: {
      tokenHash: sha256(token),
      clientId: d.clientId,
      staffId: d.staffId,
      activeOrg: d.activeOrg,
      scopes: d.scopes,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  })
  return { token }
}

export async function consumeRefreshToken(token: string): Promise<RefreshData | null> {
  const row = await prisma.mcpRefreshToken.findUnique({ where: { tokenHash: sha256(token) } })
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null
  return { clientId: row.clientId, staffId: row.staffId, activeOrg: row.activeOrg, scopes: row.scopes }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.mcpRefreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } })
}
```

> Note: `peekAuthCodeChallenge` exists because the SDK calls `challengeForAuthorizationCode()` (read) and then `exchangeAuthorizationCode()`
> (consume) as two steps. Do not consume in the peek.

- [ ] **Step 4: Run the test**

Run: `npx jest tests/unit/mcp-customer/oauth-tokenStore.test.ts --runInBand` Expected: PASS (6 tests). The `revokeRefreshToken` test uses
`updateMany` — if you kept `update` in the test, align to `updateMany`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/oauth/config.ts src/mcp/oauth/tokenStore.ts tests/unit/mcp-customer/oauth-tokenStore.test.ts
git commit -m "feat(customer-mcp): OAuth token store (hashed auth codes + refresh tokens)"
```

---

### Task 3: Clients store (Dynamic Client Registration)

**Files:**

- Create: `src/mcp/oauth/clientsStore.ts`

- [ ] **Step 1: Implement `clientsStore.ts`** (thin Prisma adapter — covered by the provider/E2E test, no dedicated unit test)

```typescript
import { randomBytes, createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function toClientInfo(row: {
  clientId: string
  clientSecretHash: string | null
  clientName: string | null
  redirectUris: string[]
  grantTypes: string[]
  scope: string | null
  tokenEndpointAuthMethod: string | null
  clientIdIssuedAt: number | null
  clientSecretExpiresAt: number | null
}): OAuthClientInformationFull {
  return {
    client_id: row.clientId,
    // We never return the secret hash; presence is signalled by client_secret_expires_at.
    redirect_uris: row.redirectUris as [string, ...string[]],
    client_name: row.clientName ?? undefined,
    grant_types: row.grantTypes.length ? row.grantTypes : undefined,
    scope: row.scope ?? undefined,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod ?? undefined,
    client_id_issued_at: row.clientIdIssuedAt ?? undefined,
    client_secret_expires_at: row.clientSecretExpiresAt ?? undefined,
  }
}

export const prismaClientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await prisma.mcpOAuthClient.findUnique({ where: { clientId } })
    return row ? toClientInfo(row) : undefined
  },

  async registerClient(client): Promise<OAuthClientInformationFull> {
    const clientId = `mcp_${randomBytes(16).toString('hex')}`
    const issuedAt = Math.floor(Date.now() / 1000)
    // Public clients (Claude Desktop) use PKCE with no secret. Issue a secret only if the
    // client asked for a confidential auth method.
    const isConfidential = client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none'
    const secret = isConfidential ? randomBytes(32).toString('hex') : undefined
    await prisma.mcpOAuthClient.create({
      data: {
        clientId,
        clientSecretHash: secret ? sha256(secret) : null,
        clientName: client.client_name ?? null,
        redirectUris: client.redirect_uris,
        grantTypes: client.grant_types ?? [],
        scope: client.scope ?? null,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? 'none',
        clientIdIssuedAt: issuedAt,
        clientSecretExpiresAt: secret ? 0 : null, // 0 = never expires
      },
    })
    return {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/oauth/clientsStore.ts
git commit -m "feat(customer-mcp): Prisma-backed OAuth clients store (DCR)"
```

---

### Task 4: Credentials (bcrypt login for the consent page)

**Files:**

- Create: `src/mcp/oauth/credentials.ts`
- Test: `tests/unit/mcp-customer/oauth-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
const db = { staff: { findUnique: jest.fn(), update: jest.fn() } }
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
const bcrypt = { compare: jest.fn() }
jest.mock('bcrypt', () => bcrypt)

import { authenticateForMcp, McpLoginError } from '../../../src/mcp/oauth/credentials'

beforeEach(() => jest.clearAllMocks())

const baseStaff = { id: 's1', password: 'hash', active: true, emailVerified: true, lockedUntil: null, failedLoginAttempts: 0 }

it('returns staffId on a correct password', async () => {
  db.staff.findUnique.mockResolvedValue(baseStaff)
  bcrypt.compare.mockResolvedValue(true)
  expect(await authenticateForMcp('A@x.com', 'pw')).toBe('s1')
  expect(db.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'a@x.com' } }))
})

it('rejects a wrong password and counts the attempt', async () => {
  db.staff.findUnique.mockResolvedValue(baseStaff)
  bcrypt.compare.mockResolvedValue(false)
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toBeInstanceOf(McpLoginError)
  expect(db.staff.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedLoginAttempts: 1 }) }))
})

it('rejects an unknown email without leaking which part was wrong', async () => {
  db.staff.findUnique.mockResolvedValue(null)
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/incorrect/i)
})

it('rejects a locked account', async () => {
  db.staff.findUnique.mockResolvedValue({ ...baseStaff, lockedUntil: new Date(Date.now() + 60000) })
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/locked/i)
})

it('rejects an unverified or inactive account', async () => {
  db.staff.findUnique.mockResolvedValue({ ...baseStaff, emailVerified: false })
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/verify/i)
})
```

Run: `npx jest tests/unit/mcp-customer/oauth-credentials.test.ts --runInBand` Expected: FAIL — module not found.

- [ ] **Step 2: Implement `credentials.ts`** (mirrors `loginStaff` security checks; returns only the staffId)

```typescript
import bcrypt from 'bcrypt'
import prisma from '@/utils/prismaClient'

/** Thrown for any login failure shown on the consent page. Message is user-safe (Spanish-friendly English ok here — page is operator-facing). */
export class McpLoginError extends Error {}

const GENERIC = 'Email or password is incorrect.'
const LOCK_THRESHOLD = 5
const LOCK_MINUTES = 60

/**
 * Verify operator credentials for the MCP consent page. Mirrors loginStaff
 * (src/services/dashboard/auth.service.ts:151): active + lockout + bcrypt + emailVerified.
 * Returns the Staff id. Throws McpLoginError on any failure.
 */
export async function authenticateForMcp(emailRaw: string, password: string): Promise<string> {
  const email = emailRaw.trim().toLowerCase()
  const staff = await prisma.staff.findUnique({
    where: { email },
    select: { id: true, password: true, active: true, emailVerified: true, lockedUntil: true, failedLoginAttempts: true },
  })
  if (!staff || !staff.password) throw new McpLoginError(GENERIC)
  if (!staff.active) throw new McpLoginError('This account is deactivated.')
  if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
    throw new McpLoginError('Account temporarily locked due to too many failed attempts. Try again later.')
  }

  const ok = await bcrypt.compare(password, staff.password)
  if (!ok) {
    const attempts = staff.failedLoginAttempts + 1
    const data: { failedLoginAttempts: number; lockedUntil?: Date } = { failedLoginAttempts: attempts }
    if (attempts >= LOCK_THRESHOLD) data.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
    await prisma.staff.update({ where: { id: staff.id }, data })
    throw new McpLoginError(data.lockedUntil ? 'Account locked due to too many failed attempts. Try again in 60 minutes.' : GENERIC)
  }

  if (!staff.emailVerified) throw new McpLoginError('Please verify your email before connecting.')

  if (staff.failedLoginAttempts > 0) {
    await prisma.staff.update({ where: { id: staff.id }, data: { failedLoginAttempts: 0 } })
  }
  return staff.id
}
```

- [ ] **Step 3: Run the test**

Run: `npx jest tests/unit/mcp-customer/oauth-credentials.test.ts --runInBand` Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/oauth/credentials.ts tests/unit/mcp-customer/oauth-credentials.test.ts
git commit -m "feat(customer-mcp): bcrypt credential check for the MCP consent page"
```

---

### Task 5: Login / consent page (HTML)

**Files:**

- Create: `src/mcp/oauth/loginPage.ts`
- Test: `tests/unit/mcp-customer/oauth-loginPage.test.ts`

- [ ] **Step 1: Write the failing test** (the security-critical behaviour is HTML-escaping the client-supplied hidden fields)

```typescript
import { renderLoginPage, escapeHtml } from '../../../src/mcp/oauth/loginPage'

it('escapes every interpolated value to prevent XSS via oauth params', () => {
  expect(escapeHtml(`"><script>alert(1)</script>`)).not.toContain('<script>')
})

it('embeds the oauth params as hidden fields and posts to the approve route', () => {
  const html = renderLoginPage({
    clientId: 'c1',
    redirectUri: 'https://claude.ai/cb',
    codeChallenge: 'cc',
    state: 's"x',
    scope: 'mcp:read',
    resource: 'https://api.avoqado.io/mcp',
    clientName: 'Claude',
  })
  expect(html).toContain('action="/mcp-oauth/approve"')
  expect(html).toContain('name="client_id" value="c1"')
  expect(html).toContain('name="code_challenge" value="cc"')
  expect(html).toContain('s&quot;x') // state escaped
  expect(html).not.toContain('s"x')
})

it('shows an error banner when provided', () => {
  expect(renderLoginPage({ clientId: 'c1', redirectUri: 'x', codeChallenge: 'cc' }, { error: 'Bad password' })).toContain('Bad password')
})
```

Run: `npx jest tests/unit/mcp-customer/oauth-loginPage.test.ts --runInBand` Expected: FAIL — module not found.

- [ ] **Step 2: Implement `loginPage.ts`**

```typescript
export interface LoginPageParams {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scope?: string
  resource?: string
  clientName?: string
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const hidden = (name: string, value?: string) =>
  value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`

/** Self-contained consent page (decision D3). No external assets. */
export function renderLoginPage(p: LoginPageParams, opts: { error?: string } = {}): string {
  const app = p.clientName ? escapeHtml(p.clientName) : 'An application'
  const banner = opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Avoqado</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#1e293b;padding:2rem;border-radius:14px;width:min(92vw,380px);box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:1.15rem;margin:0 0 .25rem} p.sub{color:#94a3b8;font-size:.9rem;margin:0 0 1.25rem}
  label{display:block;font-size:.8rem;color:#cbd5e1;margin:.75rem 0 .25rem}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff}
  button{margin-top:1.25rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#10b981;color:#04231a;font-weight:600;cursor:pointer}
  .err{background:#7f1d1d;color:#fecaca;padding:.5rem .7rem;border-radius:8px;font-size:.85rem}
  .scope{margin-top:1rem;font-size:.78rem;color:#94a3b8}
</style></head>
<body><form class="card" method="post" action="/mcp-oauth/approve">
  <h1>Connect to Avoqado</h1>
  <p class="sub"><strong>${app}</strong> wants to read your venues' data on your behalf.</p>
  ${banner}
  <label>Email</label><input type="email" name="email" autocomplete="username" required autofocus>
  <label>Password</label><input type="password" name="password" autocomplete="current-password" required>
  ${hidden('client_id', p.clientId)}
  ${hidden('redirect_uri', p.redirectUri)}
  ${hidden('code_challenge', p.codeChallenge)}
  ${hidden('state', p.state)}
  ${hidden('scope', p.scope)}
  ${hidden('resource', p.resource)}
  <button type="submit">Authorize access</button>
  <p class="scope">Grants read-only access scoped to your role. You can disconnect anytime.</p>
</form></body></html>`
}
```

- [ ] **Step 3: Run the test**

Run: `npx jest tests/unit/mcp-customer/oauth-loginPage.test.ts --runInBand` Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/oauth/loginPage.ts tests/unit/mcp-customer/oauth-loginPage.test.ts
git commit -m "feat(customer-mcp): self-contained OAuth consent page (XSS-escaped)"
```

---

### Task 6: Extend the MCP token to carry clientId

**Files:**

- Modify: `src/mcp/mcpToken.ts`

`AuthInfo.clientId` is required by the SDK; the access token must carry it. Add it without breaking the Phase-0 callers (the dev server
calls `issueMcpToken(staffId, org)` 2-arg).

- [ ] **Step 1: Edit `mcpToken.ts`**

```typescript
import jwt from 'jsonwebtoken'

export const MCP_AUDIENCE = 'avoqado-mcp'

function getSecret(): jwt.Secret {
  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) throw new Error('ACCESS_TOKEN_SECRET is not set')
  return secret
}

export interface McpTokenPayload {
  sub: string // Staff.id
  org: string // active organization id
  cid?: string // OAuth client id (Phase 1); absent for dev-server tokens
}

/** Issue a short-lived, audience-bound MCP token. Distinct from dashboard /api/v1 tokens. */
export function issueMcpToken(staffId: string, activeOrg: string, ttlSeconds = 3600, clientId?: string): string {
  const payload: Record<string, unknown> = { sub: staffId, org: activeOrg }
  if (clientId) payload.cid = clientId
  return jwt.sign(payload, getSecret(), { audience: MCP_AUDIENCE, expiresIn: ttlSeconds })
}

/** Verify an MCP token. Rejects any token NOT minted for the MCP audience. */
export function verifyMcpToken(token: string): McpTokenPayload {
  const decoded = jwt.verify(token, getSecret(), { audience: MCP_AUDIENCE }) as jwt.JwtPayload
  const org = (decoded as Record<string, unknown>).org
  if (!decoded.sub || typeof org !== 'string') throw new Error('Invalid MCP token payload')
  const cid = (decoded as Record<string, unknown>).cid
  return { sub: decoded.sub, org, cid: typeof cid === 'string' ? cid : undefined }
}
```

- [ ] **Step 2: Run the existing token test** (must still pass)

Run: `npx jest tests/unit/mcp-customer/mcpToken.test.ts --runInBand` Expected: PASS — the 2-arg call still works; `cid` is additive.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/mcpToken.ts
git commit -m "feat(customer-mcp): carry OAuth client id in the MCP access token"
```

---

### Task 7: The OAuth provider

**Files:**

- Create: `src/mcp/oauth/provider.ts`
- Test: `tests/unit/mcp-customer/oauth-provider.test.ts`

- [ ] **Step 1: Write the failing test** (verifyAccessToken → AuthInfo shape; exchange paths with the store mocked)

```typescript
jest.mock('../../../src/mcp/oauth/tokenStore', () => ({
  consumeAuthCode: jest.fn(),
  peekAuthCodeChallenge: jest.fn(),
  createRefreshToken: jest.fn(),
  consumeRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
}))
jest.mock('../../../src/mcp/oauth/clientsStore', () => ({ prismaClientsStore: {} }))

import { provider } from '../../../src/mcp/oauth/provider'
import { issueMcpToken } from '../../../src/mcp/mcpToken'
import * as store from '../../../src/mcp/oauth/tokenStore'

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = 'test-secret'
})
beforeEach(() => jest.clearAllMocks())

it('verifyAccessToken returns AuthInfo with staffId/activeOrg in extra', async () => {
  const token = issueMcpToken('s1', 'o1', 3600, 'c1')
  const info = await provider.verifyAccessToken(token)
  expect(info.clientId).toBe('c1')
  expect(info.extra).toEqual({ staffId: 's1', activeOrg: 'o1' })
  expect(info.scopes).toContain('mcp:read')
})

it('verifyAccessToken throws on a non-MCP token', async () => {
  await expect(provider.verifyAccessToken('garbage')).rejects.toBeTruthy()
})

it('exchangeAuthorizationCode consumes the code and returns access+refresh', async () => {
  ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({
    clientId: 'c1',
    staffId: 's1',
    activeOrg: 'o1',
    codeChallenge: 'cc',
    redirectUri: 'http://cb',
    scopes: ['mcp:read'],
  })
  ;(store.createRefreshToken as jest.Mock).mockResolvedValue({ token: 'refresh123' })
  const tokens = await provider.exchangeAuthorizationCode({ client_id: 'c1', redirect_uris: ['http://cb'] } as any, 'thecode')
  expect(tokens.access_token).toBeTruthy()
  expect(tokens.refresh_token).toBe('refresh123')
  expect(tokens.token_type).toBe('Bearer')
  const verified = await provider.verifyAccessToken(tokens.access_token)
  expect(verified.extra).toEqual({ staffId: 's1', activeOrg: 'o1' })
})

it('exchangeAuthorizationCode rejects a code bound to a different client', async () => {
  ;(store.consumeAuthCode as jest.Mock).mockResolvedValue({
    clientId: 'OTHER',
    staffId: 's1',
    activeOrg: 'o1',
    codeChallenge: 'cc',
    redirectUri: 'http://cb',
    scopes: [],
  })
  await expect(provider.exchangeAuthorizationCode({ client_id: 'c1', redirect_uris: ['http://cb'] } as any, 'thecode')).rejects.toBeTruthy()
})
```

Run: `npx jest tests/unit/mcp-customer/oauth-provider.test.ts --runInBand` Expected: FAIL — module not found.

- [ ] **Step 2: Implement `provider.ts`**

```typescript
import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { issueMcpToken, verifyMcpToken } from '../mcpToken'
import { prismaClientsStore } from './clientsStore'
import { consumeAuthCode, peekAuthCodeChallenge, createRefreshToken, consumeRefreshToken, revokeRefreshToken } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { ACCESS_TTL_SECONDS, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'

class InvalidGrant extends Error {}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return prismaClientsStore
  },

  // Render the bcrypt consent page. The form POSTs to /mcp-oauth/approve (our route),
  // which is where the redirect-with-code actually happens.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(
      renderLoginPage({
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scope: (params.scopes ?? []).join(' ') || undefined,
        resource: params.resource?.href,
      }),
    )
  },

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const challenge = await peekAuthCodeChallenge(authorizationCode)
    if (!challenge) throw new InvalidGrant('invalid or expired authorization code')
    return challenge
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const data = await consumeAuthCode(authorizationCode)
    if (!data) throw new InvalidGrant('invalid or expired authorization code')
    if (data.clientId !== client.client_id) throw new InvalidGrant('code was issued to a different client')
    if (redirectUri !== undefined && redirectUri !== data.redirectUri) throw new InvalidGrant('redirect_uri mismatch')

    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id)
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: data.scopes,
    })
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: data.scopes.join(' ') || undefined, refresh_token }
  },

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const data = await consumeRefreshToken(refreshToken)
    if (!data) throw new InvalidGrant('invalid or expired refresh token')
    if (data.clientId !== client.client_id) throw new InvalidGrant('refresh token was issued to a different client')

    const grantedScopes = scopes && scopes.length ? scopes.filter(s => data.scopes.includes(s)) : data.scopes
    const access_token = issueMcpToken(data.staffId, data.activeOrg, ACCESS_TTL_SECONDS, client.client_id)
    // Rotate the refresh token (revoke old, issue new) — refresh-token rotation best practice.
    await revokeRefreshToken(refreshToken)
    const { token: refresh_token } = await createRefreshToken({
      clientId: client.client_id,
      staffId: data.staffId,
      activeOrg: data.activeOrg,
      scopes: grantedScopes,
    })
    return {
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope: grantedScopes.join(' ') || undefined,
      refresh_token,
    }
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { sub, org, cid } = verifyMcpToken(token) // throws on bad/expired/wrong-audience
    return {
      token,
      clientId: cid ?? sub, // dev-server tokens have no cid; fall back to the subject
      scopes: MCP_SCOPES_SUPPORTED,
      resource: MCP_RESOURCE_URL,
      extra: { staffId: sub, activeOrg: org },
    }
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Access tokens are stateless JWTs (expire in 1h); we revoke refresh tokens only.
    await revokeRefreshToken(request.token)
  },
}
```

- [ ] **Step 3: Run the test**

Run: `npx jest tests/unit/mcp-customer/oauth-provider.test.ts --runInBand` Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/oauth/provider.ts tests/unit/mcp-customer/oauth-provider.test.ts
git commit -m "feat(customer-mcp): OAuthServerProvider (Phase-0 JWT as access token)"
```

---

### Task 8: The approve route (login POST → authorization code)

**Files:**

- Create: `src/mcp/oauth/router.ts`

This route is **not** part of the SDK router. It receives the consent-form POST, authenticates, mints a code, and redirects back to the
client.

- [ ] **Step 1: Implement `router.ts`**

```typescript
import express, { type Request, type Response, type Express } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { authenticateForMcp, McpLoginError } from './credentials'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'
import { createAuthCode } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { provider } from './provider'
import { MCP_ISSUER_URL, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'

/** POST /mcp-oauth/approve — consent form target. Mirror of the /authorize params + email/password. */
function approveHandler() {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))
  router.post('/mcp-oauth/approve', async (req: Request, res: Response) => {
    const { email, password, client_id, redirect_uri, code_challenge, state, scope, resource } = req.body ?? {}
    const reRender = (error: string) =>
      res
        .status(401)
        .send(
          renderLoginPage(
            { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, state, scope, resource },
            { error },
          ),
        )

    if (!client_id || !redirect_uri || !code_challenge) return res.status(400).send('Missing OAuth parameters')

    let staffId: string
    try {
      staffId = await authenticateForMcp(String(email ?? ''), String(password ?? ''))
    } catch (e) {
      return reRender(e instanceof McpLoginError ? e.message : 'Login failed')
    }

    let activeOrg: string
    try {
      activeOrg = await getPrimaryOrganizationId(staffId)
    } catch {
      return reRender('Your account has no active organization.')
    }

    const scopes = scope ? String(scope).split(' ').filter(Boolean) : []
    const { code } = await createAuthCode({
      clientId: client_id,
      staffId,
      activeOrg,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      scopes,
      resource: resource || undefined,
    })

    const target = new URL(redirect_uri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', String(state))
    res.redirect(302, target.href)
  })
  return router
}

/** Mount the full customer-MCP OAuth surface at the app root. Call ONCE in app.ts. */
export function mountCustomerMcpAuth(app: Express): void {
  // SDK: /authorize, /token, /register (DCR), /revoke, and .well-known metadata.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: MCP_ISSUER_URL,
      scopesSupported: MCP_SCOPES_SUPPORTED,
      resourceName: 'Avoqado',
      resourceServerUrl: MCP_RESOURCE_URL,
    }),
  )
  // Our consent-form target.
  app.use(approveHandler())
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/oauth/router.ts
git commit -m "feat(customer-mcp): /authorize consent approve route + auth router mount"
```

---

### Task 9: Wire it into the app + switch /mcp to req.auth

**Files:**

- Modify: `src/mcp/server.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Switch `handleMcpRequest` to read `req.auth`** (populated by `requireBearerAuth`), keeping the header path as a fallback for
      the dev server.

In `src/mcp/server.ts`, change `buildServerForRequest` to accept a resolved `{ staffId, activeOrg }` and update `handleMcpRequest`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { verifyMcpToken } from './mcpToken'
import { resolveScope } from './scope'
import { registerVenueTools } from './tools/venues'
import { registerSalesTools } from './tools/sales'
import { registerOrderTools } from './tools/orders'
import { registerTerminalTools } from './tools/terminals'
import { registerReservationTools } from './tools/reservations'
import { registerInventoryTools } from './tools/inventory'

async function buildServerForIdentity(staffId: string, activeOrg: string): Promise<McpServer> {
  const scope = await resolveScope(staffId, activeOrg)
  const server = new McpServer({ name: 'avoqado-customer-mcp', version: '0.1.0' })
  registerVenueTools(server, scope)
  registerSalesTools(server, scope)
  registerOrderTools(server, scope)
  registerTerminalTools(server, scope)
  registerReservationTools(server, scope)
  registerInventoryTools(server, scope)
  return server
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    // Phase 1: requireBearerAuth populated req.auth.extra. Phase-0 dev server still passes a raw header.
    let staffId: string | undefined
    let activeOrg: string | undefined
    const extra = (req as { auth?: { extra?: Record<string, unknown> } }).auth?.extra
    if (extra && typeof extra.staffId === 'string' && typeof extra.activeOrg === 'string') {
      staffId = extra.staffId
      activeOrg = extra.activeOrg
    } else {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const payload = verifyMcpToken(token)
      staffId = payload.sub
      activeOrg = payload.org
    }
    const server = await buildServerForIdentity(staffId, activeOrg)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch {
    if (!res.headersSent) res.status(401).json({ error: 'unauthorized' })
  }
}
```

- [ ] **Step 2: Mount auth + guard `/mcp` in `src/app.ts`**

Find the existing Phase-0 line `app.post('/mcp', express.json(), handleMcpRequest)`. Replace the imports and that line:

```typescript
// near the other src/mcp imports (Phase 0 added handleMcpRequest):
import { handleMcpRequest } from './mcp/server'
import { mountCustomerMcpAuth } from './mcp/oauth/router'
import { provider as mcpOAuthProvider } from './mcp/oauth/provider'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { MCP_RESOURCE_URL } from './mcp/oauth/config'
```

```typescript
// AFTER express.json()/public routes are set up, but the AS router must be at the app root.
mountCustomerMcpAuth(app)

// Protect the MCP endpoint with the SDK bearer middleware (sets req.auth from provider.verifyAccessToken).
app.post(
  '/mcp',
  requireBearerAuth({
    verifier: mcpOAuthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_RESOURCE_URL),
  }),
  express.json(),
  handleMcpRequest,
)
```

> Mounting notes: `mcpAuthRouter` registers `.well-known/oauth-authorization-server`, `.well-known/oauth-protected-resource`, `/authorize`,
> `/token`, `/register`, `/revoke` — all at root, so it must NOT sit under `/api/v1`. It is unrelated to the
> Stripe-webhook-before-`express.json()` rule (that's a different route). The approve route uses its own `urlencoded` parser, so global
> `express.json()` order doesn't matter for it.

- [ ] **Step 3: Boot-check (light — no full tsc/jest)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "src/mcp/" | head` — expect no errors in `src/mcp/`. (Scope the grep; do not eyeball
the whole repo output.)

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts src/app.ts
git commit -m "feat(customer-mcp): mount OAuth AS + guard /mcp with requireBearerAuth"
```

---

### Task 10: End-to-end verification (full OAuth dance)

**Files:**

- Create (temp, DELETE after): `scripts/temp-oauth-e2e.ts`

Prove a real MCP client completes DCR → authorize → login → code → token → `/mcp`. The SDK client can drive the whole flow with an
`OAuthClientProvider`, but the login page is interactive. So verify in two halves:

- [ ] **Step 1: Metadata + DCR + protected-resource discovery**

Start the app (`npm run dev` in the worktree). Then:

```bash
curl -s localhost:12344/.well-known/oauth-authorization-server | jq '{issuer, authorization_endpoint, token_endpoint, registration_endpoint}'
curl -s localhost:12344/.well-known/oauth-protected-resource/mcp | jq '{resource, authorization_servers}'
# DCR:
curl -s -X POST localhost:12344/register -H 'content-type: application/json' \
  -d '{"client_name":"e2e","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"]}' | jq '{client_id, redirect_uris}'
```

Expected: metadata lists the endpoints; `/register` returns a `mcp_…` client_id persisted in `mcp_oauth_clients`.

- [ ] **Step 2: Authorize page renders + approve issues a code**

Open in a browser (real PKCE pair; generate a verifier/challenge with the snippet, paste the challenge):
`http://localhost:12344/authorize?response_type=code&client_id=<id>&redirect_uri=http://localhost:9999/cb&code_challenge=<challenge>&code_challenge_method=S256&scope=mcp:read&state=xyz`
Expected: the dark consent card renders. Submit a real OWNER's email/password → 302 to `http://localhost:9999/cb?code=…&state=xyz`. Copy the
`code`.

- [ ] **Step 3: Exchange code → token, then call /mcp**

```bash
# token exchange (code_verifier is the plaintext matching the challenge):
curl -s -X POST localhost:12344/token -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=<code>&redirect_uri=http://localhost:9999/cb&client_id=<id>&code_verifier=<verifier>" | jq '{access_token: (.access_token|length), token_type, expires_in, refresh: (.refresh_token|length)}'
# call /mcp (initialize) with the access token:
curl -s -X POST localhost:12344/mcp -H "authorization: Bearer <access_token>" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
# negative: no token → 401 with WWW-Authenticate
curl -s -i -X POST localhost:12344/mcp -H 'content-type: application/json' -d '{}' | head -3
```

Expected: token exchange returns a Bearer access token + refresh token; `/mcp` `tools/list` returns the 7 tool names; no-token → `401` with
a `WWW-Authenticate` header pointing at the protected-resource metadata.

- [ ] **Step 4: Clean up + commit nothing**

```bash
rm -f scripts/temp-oauth-e2e.ts
pkill -f "ts-node-dev" 2>/dev/null; pkill -f "mcp-dev-server.ts" 2>/dev/null
git status -s   # expect clean (no temp files staged)
```

---

### Task 11 (OPTIONAL — defer unless perf bites): Redis access cache

Review §7 flagged `getUserAccess` as ~7 queries/venue, request-level cache only. If `/mcp` latency is poor with large orgs, wrap
`resolveScope`'s per-venue calls in a short Redis TTL cache keyed `mcp:access:{staffId}:{venueId}` (TTL 60s) using the existing Redis
client. This is a pure optimization — do NOT block Phase 1 on it. Add only with a measured reason, and log cache hit/miss.

---

## Self-Review (run before handoff)

**Spec coverage** (design §8 + memory must-fix list):

- ✅ Avoqado as AS via `mcpAuthRouter` — Task 8/9.
- ✅ bcrypt login (NOT Firebase) — Task 4, mirrors `loginStaff`.
- ✅ P0 `aud` binding — inherited from Phase 0 (`MCP_AUDIENCE`); access token stays audience-bound; dashboard rejection already at
  `jwt.service.ts:167`.
- ✅ Stateful AS (persist codes/tokens/DCR clients) — Task 1/2/3, **hashed at rest**.
- ✅ Short token lifetimes — `ACCESS_TTL_SECONDS=3600`, refresh 30d with rotation (Task 2/7).
- ✅ Payment field redaction — already in Phase-0 `guard.redact`; unchanged.
- ✅ OrgRole has no MANAGER — handled by Phase-0 `resolveScope` (org ADMIN w/o `StaffVenue` → 0 venues); unchanged.
- ✅ RFC 8707 resource — `verifyAccessToken` sets `resource: MCP_RESOURCE_URL`; protected-resource metadata advertised by the SDK.
- ⚠️ Redis cross-request cache — deferred to Task 11 (optional), explicitly flagged not-blocking.

**Placeholder scan:** none — every step has full code or a concrete command.

**Type consistency:** `McpTokenPayload.cid` (Task 6) ↔ `provider.verifyAccessToken` reads `cid` (Task 7). `AuthCodeData`/`RefreshData`
(Task 2) ↔ consumed identically in `provider` (Task 7). `extra:{staffId,activeOrg}` set in Task 7 ↔ read in Task 9. `prismaClientsStore`
(Task 3) ↔ `provider.clientsStore` (Task 7). Consistent.

**Open decision to confirm with the founder before Task 1:** the schema-map domain name for the 3 models (`'Customer MCP / OAuth'` new
domain vs. reuse the identity domain). Non-blocking — pick reuse if the generator enforces a fixed domain set.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-03-customer-mcp-phase1-oauth-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Given this worktree's machine-load history,
   hard-constrain each subagent: edit only the task's listed files, run only the one scoped `jest` file, NEVER `npm run format` or the full
   suite, and `git add` exactly the listed paths.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Recommended order is exactly Task 1 → 11. Tasks 1–7 are independent of `app.ts` and safe to land incrementally; Task 9 is the only one that
changes request behaviour; Task 10 is the proof. **Do not merge `feat/customer-mcp-phase0` until the founder asks.**
