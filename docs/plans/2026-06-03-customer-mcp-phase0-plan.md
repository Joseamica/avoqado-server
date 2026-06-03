# Customer MCP — Phase 0 (Scoped Read Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A real Staff connects a remote MCP over HTTP using a simple audience-bound bearer token and runs ONE read tool (`list_my_venues`) that returns ONLY the venues their role allows — proving auth→scope→guard→tool→transport end to end, cheaply, before any OAuth machinery.

**Architecture:** A new `src/mcp/` module in `avoqado-server`: an MCP server over Streamable HTTP at `POST /mcp`, gated by an MCP-audience bearer token (P0: distinct from dashboard `/api/v1` tokens), resolving the Staff's active-org scope via the existing `getUserAccess()` (org OWNER → all org venues; admin/below → assigned venues; permissions per venue), enforced by a central guard. Full OAuth (login page, DCR, token persistence, refresh) is **Phase 1, NOT this plan**.

**Tech Stack:** `@modelcontextprotocol/sdk` (Streamable HTTP transport + `requireBearerAuth`), `jsonwebtoken` (present), Express (present), Prisma (present), Jest/ts-jest (present, `tests/unit/**`).

**Source spec:** `docs/plans/2026-06-03-customer-mcp-design.md` (§8 Phase 0; §7 corrections folded).

**Cost-first rule:** the early tasks deliver the working connected loop. No Redis cache (request-level `createAccessCache` is enough for 1 low-volume tool — that's Phase 1). No OAuth. No login UI.

---

## Prerequisite (Task 0)

- [ ] **Branch + install the SDK** (the customer MCP is NEW code in `src/mcp/`, independent of the internal `scripts/mcp/` on `feat/admin-mcp` — no merge needed, only the SDK dep):

```bash
git checkout develop && git pull
git checkout -b feat/customer-mcp-phase0
npm install @modelcontextprotocol/sdk
```
Expected: SDK added to `dependencies`. Commit: `git add package.json package-lock.json && git commit -m "chore(mcp): add @modelcontextprotocol/sdk for customer MCP"`

---

## File Structure

```
src/mcp/
  mcpToken.ts          # issue/verify an MCP-audience JWT (P0 audience binding)
  scope.ts             # resolveScope(staffId, activeOrg) → allowed venues + per-venue access
  guard.ts             # createGuard(scope): venueFilter + requirePermission + redact
  tools/venues.ts      # list_my_venues
  server.ts            # build McpServer, register tools, mount Streamable HTTP + requireBearerAuth
tests/unit/mcp-customer/
  mcpToken.test.ts
  scope.test.ts        # (integration-ish: hits test DB)
  guard.test.ts
```

---

## Task 1: MCP-audience token (P0 — the security fix)

**Files:** Create `src/mcp/mcpToken.ts`; Test `tests/unit/mcp-customer/mcpToken.test.ts`; Modify `src/jwt.service.ts` (reject MCP tokens on the dashboard side).

- [ ] **Step 1: Write the failing test**

```typescript
import { issueMcpToken, verifyMcpToken, MCP_AUDIENCE } from '../../../src/mcp/mcpToken'
import jwt from 'jsonwebtoken'

describe('mcpToken', () => {
  beforeAll(() => { process.env.ACCESS_TOKEN_SECRET = 'test-secret' })

  it('issues a token bound to the MCP audience and round-trips it', () => {
    const t = issueMcpToken('staff-1', 'org-1', 3600)
    const payload = verifyMcpToken(t)
    expect(payload.sub).toBe('staff-1')
    expect(payload.org).toBe('org-1')
  })

  it('rejects a token that lacks the MCP audience (e.g. a dashboard token)', () => {
    const dashboardToken = jwt.sign({ sub: 'staff-1', orgId: 'org-1' }, 'test-secret', { expiresIn: 3600 })
    expect(() => verifyMcpToken(dashboardToken)).toThrow()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `npx jest --selectProjects unit tests/unit/mcp-customer/mcpToken.test.ts` → cannot find module.

- [ ] **Step 3: Implement `src/mcp/mcpToken.ts`**

```typescript
import jwt from 'jsonwebtoken'

const SECRET = process.env.ACCESS_TOKEN_SECRET!
export const MCP_AUDIENCE = 'avoqado-mcp'

export interface McpTokenPayload {
  sub: string // Staff.id
  org: string // active organization id
}

/** Issue a short-lived, audience-bound MCP token. Distinct from dashboard /api/v1 tokens. */
export function issueMcpToken(staffId: string, activeOrg: string, ttlSeconds = 3600): string {
  return jwt.sign({ sub: staffId, org: activeOrg }, SECRET, { audience: MCP_AUDIENCE, expiresIn: ttlSeconds })
}

/** Verify an MCP token. Rejects any token NOT minted for the MCP audience. */
export function verifyMcpToken(token: string): McpTokenPayload {
  const decoded = jwt.verify(token, SECRET, { audience: MCP_AUDIENCE }) as jwt.JwtPayload
  const org = (decoded as Record<string, unknown>).org
  if (!decoded.sub || typeof org !== 'string') throw new Error('Invalid MCP token payload')
  return { sub: decoded.sub, org }
}
```

- [ ] **Step 4: Run it, expect PASS.**

- [ ] **Step 5: Close the reverse leak — the dashboard must reject MCP-audience tokens.** In `src/jwt.service.ts`, inside `verifyAccessToken` (after `jwt.verify`), add:

```typescript
  // An MCP-audience token must never authenticate against the dashboard / /api/v1.
  if ((decoded as jwt.JwtPayload).aud === 'avoqado-mcp') {
    throw new jwt.JsonWebTokenError('MCP token not valid for the dashboard API')
  }
```
(Verify the exact variable name `decoded` in `verifyAccessToken` first; adapt if different.)

- [ ] **Step 6: Commit** — `git add src/mcp/mcpToken.ts tests/unit/mcp-customer/mcpToken.test.ts src/jwt.service.ts && git commit -m "feat(mcp): audience-bound MCP tokens, rejected on the dashboard (P0)"`

---

## Task 2: resolveScope — the heart of the moat

**Files:** Create `src/mcp/scope.ts`; Test `tests/unit/mcp-customer/scope.test.ts`.

This hits the DB (role → venues), so its test is integration-style against the test DB. Verify the test-DB seeding pattern in `tests/` before writing the test; if no seedable test DB, mark this test `[→INTEGRATION]` and cover the role-branching logic by extracting it (below) — but the org-OWNER-vs-assigned branch is the critical thing to test.

- [ ] **Step 1: Implement `src/mcp/scope.ts`**

```typescript
import prisma from '@/utils/prismaClient'
import { getUserAccess, createAccessCache } from '@/services/access/access.service'
import type { UserAccess } from '@/services/access/access.service'

export interface McpScope {
  staffId: string
  activeOrg: string
  allowedVenueIds: string[]
  perVenueAccess: Map<string, UserAccess> // role + permissions resolved PER venue
}

/**
 * What a connected Staff may touch in their active org.
 *   org-level OWNER (OrgRole.OWNER)  → ALL venues in the org
 *   ADMIN / MEMBER / VIEWER (OrgRole) → only their StaffVenue assignments in this org
 * NOTE: OrgRole has no MANAGER; per-venue StaffRole heterogeneity is handled by
 * resolving getUserAccess() per venue.
 */
export async function resolveScope(staffId: string, activeOrg: string): Promise<McpScope> {
  const membership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId: activeOrg } },
    select: { role: true, isActive: true },
  })
  const empty: McpScope = { staffId, activeOrg, allowedVenueIds: [], perVenueAccess: new Map() }
  if (!membership || !membership.isActive) return empty

  let venueIds: string[]
  if (membership.role === 'OWNER') {
    const venues = await prisma.venue.findMany({ where: { organizationId: activeOrg }, select: { id: true } })
    venueIds = venues.map(v => v.id)
  } else {
    const assignments = await prisma.staffVenue.findMany({
      where: { staffId, venue: { organizationId: activeOrg } },
      select: { venueId: true },
    })
    venueIds = assignments.map(a => a.venueId)
  }

  const cache = createAccessCache()
  const perVenueAccess = new Map<string, UserAccess>()
  for (const venueId of venueIds) {
    try {
      perVenueAccess.set(venueId, await getUserAccess(staffId, venueId, cache))
    } catch {
      // getUserAccess throws when the staff has no access to that venue — skip defensively.
    }
  }
  return { staffId, activeOrg, allowedVenueIds: [...perVenueAccess.keys()], perVenueAccess }
}
```

- [ ] **Step 2: Test (against the test DB)** — assert: an org OWNER resolves to ALL the org's venues; an ADMIN with two `StaffVenue` rows resolves to exactly those two; an `OrgRole.ADMIN` with NO `StaffVenue` resolves to **zero** venues (the §7.7 edge case). Run, iterate to green.

- [ ] **Step 3: Commit** — `git commit -m "feat(mcp): resolveScope (org OWNER → all venues; else assigned), per-venue access"`

---

## Task 3: The central guard

**Files:** Create `src/mcp/guard.ts`; Test `tests/unit/mcp-customer/guard.test.ts`. Pure functions — full unit coverage.

- [ ] **Step 1: Write the failing test**

```typescript
import { createGuard, ScopeError } from '../../../src/mcp/guard'
import type { McpScope } from '../../../src/mcp/scope'

const scope = (ids: string[]): McpScope => ({
  staffId: 's', activeOrg: 'o', allowedVenueIds: ids,
  perVenueAccess: new Map(ids.map(id => [id, { corePermissions: ['venue:read'] } as any])),
})

describe('guard', () => {
  it('venueFilter defaults to all allowed venues', () => {
    expect(createGuard(scope(['A', 'B'])).venueFilter()).toEqual({ venueId: { in: ['A', 'B'] } })
  })
  it('venueFilter for an in-scope venue narrows to it', () => {
    expect(createGuard(scope(['A', 'B'])).venueFilter('A')).toEqual({ venueId: { in: ['A'] } })
  })
  it('venueFilter THROWS for an out-of-scope venue (the leak test)', () => {
    expect(() => createGuard(scope(['A', 'B'])).venueFilter('C')).toThrow(ScopeError)
  })
  it('requirePermission throws when the venue lacks the permission', () => {
    const g = createGuard(scope(['A']))
    expect(() => g.requirePermission('payments:refund', 'A')).toThrow(ScopeError)
  })
  it('redact strips sensitive payment fields', () => {
    const out = createGuard(scope(['A'])).redact([{ amount: 10, maskedPan: '4111****1111' } as any])
    expect(out[0]).toEqual({ amount: 10 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `src/mcp/guard.ts`**

```typescript
import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from './scope'

const SENSITIVE_PAYMENT_FIELDS = ['maskedPan', 'referenceNumber', 'authorizationNumber'] as const

export class ScopeError extends Error {}

export function createGuard(scope: McpScope) {
  return {
    /** The venue filter EVERY query must spread into its `where`. Throws on out-of-scope. */
    venueFilter(requestedVenueId?: string): { venueId: { in: string[] } } {
      if (requestedVenueId) {
        if (!scope.allowedVenueIds.includes(requestedVenueId)) {
          throw new ScopeError(`Venue ${requestedVenueId} is not in your scope`)
        }
        return { venueId: { in: [requestedVenueId] } }
      }
      return { venueId: { in: scope.allowedVenueIds } }
    },
    /** Gate an action by permission, evaluated for a SPECIFIC venue (roles differ per venue). */
    requirePermission(permission: string, venueId: string): void {
      const access = scope.perVenueAccess.get(venueId)
      if (!access || !hasPermission(access, permission)) {
        throw new ScopeError(`Missing permission ${permission} for venue ${venueId}`)
      }
    },
    /** Strip sensitive payment fields before any result leaves for the LLM vendor (§7.6). */
    redact<T>(rows: T[]): T[] {
      return rows.map(row => {
        const copy = { ...(row as Record<string, unknown>) }
        for (const f of SENSITIVE_PAYMENT_FIELDS) delete copy[f]
        return copy as T
      })
    },
  }
}
```

- [ ] **Step 4: Run it, expect PASS (5 tests).**
- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): central scope guard (venueFilter + per-venue permission + redaction)"`

---

## Task 4: `list_my_venues` tool

**Files:** Create `src/mcp/tools/venues.ts`.

- [ ] **Step 1: Implement** (the simplest proof tool — it returns exactly the resolved scope):

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'

export function registerVenueTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_my_venues',
    'List the venues you can access in your active organization (id, name, slug, status, city).',
    {},
    async () => {
      const venues = await prisma.venue.findMany({
        where: { id: { in: scope.allowedVenueIds } },
        select: { id: true, name: true, slug: true, status: true, city: true },
        orderBy: { name: 'asc' },
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: venues.length, venues }, null, 2) }] }
    },
  )
}
```

- [ ] **Step 2: Commit** — `git commit -m "feat(mcp): list_my_venues scoped read tool"`

---

## Task 5: Transport + bearer auth wiring (VERIFY the SDK API first)

**Files:** Create `src/mcp/server.ts`; Modify `src/app.ts` (mount `/mcp`).

The exact `@modelcontextprotocol/sdk@1.29.0` API for Streamable HTTP + bearer auth must be confirmed from the installed package — do NOT assume (a prior review caught wrong SDK assumptions).

- [ ] **Step 1: Confirm the SDK surface**

```bash
ls node_modules/@modelcontextprotocol/sdk/dist/esm/server/ | grep -iE "stream|http|auth"
sed -n '1,40p' node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts 2>/dev/null
sed -n '1,40p' node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware/bearerAuth.d.ts 2>/dev/null
```
Note the real export names/signatures (e.g. `StreamableHTTPServerTransport`, `requireBearerAuth`, the `verifier`/`tokenVerifier` shape). Implement Step 2 against what you find; the structure below is the target shape.

- [ ] **Step 2: Implement `src/mcp/server.ts`** (adapt names to the confirmed API)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { verifyMcpToken } from './mcpToken'
import { resolveScope } from './scope'
import { registerVenueTools } from './tools/venues'

/** Build a per-request MCP server bound to the caller's resolved scope. */
async function buildServerForRequest(authHeader: string | undefined) {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '')
  const { sub, org } = verifyMcpToken(token) // throws → 401 below
  const scope = await resolveScope(sub, org)

  const server = new McpServer({ name: 'avoqado-customer-mcp', version: '0.1.0' })
  registerVenueTools(server, scope)
  return server
}

/** Express handler for POST /mcp (stateless per request). */
export async function handleMcpRequest(req: Request, res: Response) {
  try {
    const server = await buildServerForRequest(req.headers.authorization)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    if (!res.headersSent) res.status(401).json({ error: 'unauthorized' })
  }
}
```

- [ ] **Step 3: Mount in `src/app.ts`** — add near the other `app.use` route mounts:

```typescript
import { handleMcpRequest } from './mcp/server'
app.post('/mcp', express.json(), handleMcpRequest)
```
(Confirm `express` and `app` are in scope at that point in `app.ts`.)

- [ ] **Step 4: Smoke test the loop locally**

```bash
# issue a dev MCP token for a real test staff+org (use tsx + issueMcpToken from a scratch script or node REPL),
# then:
curl -s -X POST http://localhost:PORT/mcp \
  -H "Authorization: Bearer <DEV_MCP_TOKEN>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head
```
Expected: a JSON-RPC response listing `list_my_venues`. A request with no/invalid token → 401.

- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): Streamable HTTP /mcp endpoint with MCP-token bearer auth + per-request scope"`

---

## Task 6: CRITICAL tenant-isolation verification + real-agent connect

**Files:** Test `tests/unit/mcp-customer/scope.test.ts` (extend) or a new integration test.

- [ ] **Step 1: The leak test (CRITICAL).** With a real ADMIN staff scoped to venues {A,B} in an org that also has venue C: assert `resolveScope(admin, org).allowedVenueIds` does NOT include C, and `createGuard(scope).venueFilter('C')` throws. (This is the test the whole module exists to pass.)
- [ ] **Step 2: Real-agent connect.** Deploy to staging (or run locally), register the MCP in a real Claude/ChatGPT with a dev MCP token, ask "list my venues". Confirm it returns ONLY the scoped venues. This is also the Phase-0 answer to "does a real agent complete the loop against our server?" (the spike, folded in).
- [ ] **Step 3: Commit** — `git commit -m "test(mcp): critical tenant-isolation test for scoped venue access"`

---

## NOT in Phase 0 (Phase 1)

OAuth (`mcpAuthRouter` + DCR + discovery), the bcrypt login+consent+org-picker page, token persistence/refresh/revocation, the cross-request Redis cache, `switch_active_org`, every read tool beyond `list_my_venues`, all writes. Phase 0 uses a manually-issued dev MCP token; Phase 1 replaces it with the real "Connect to Avoqado" OAuth flow.

## Self-Review
- **Spec coverage:** §8 Phase 0 (transport + token + scope + guard + 1 tool) → Tasks 1-6 ✓. §7.2 audience → Task 1 ✓. §7.6 redaction → Task 3 ✓. §7.7 role model + zero-venue edge → Task 2 ✓. §3.5 query-level scope (venueFilter, not row-assertion) → Task 3 ✓. §7.9 SDK (install only, no merge needed) → Task 0 ✓; SDK API verified not assumed → Task 5 Step 1 ✓.
- **Placeholder scan:** Task 5 has a "confirm the SDK API" step — that is the work of integrating an external SDK whose exact 1.29.0 names must be read, not a hand-wave; the target code shape is provided. Task 2's test depends on the repo's test-DB pattern (flagged to verify). No TBD/TODO.
- **Type consistency:** `McpScope` (scope.ts) consumed by guard.ts + venues.ts + server.ts; `McpTokenPayload.{sub,org}` consistent token↔server; `MCP_AUDIENCE` shared token↔jwt.service rejection.
