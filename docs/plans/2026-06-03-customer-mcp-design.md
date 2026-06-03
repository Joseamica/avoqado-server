# Customer-Facing Avoqado MCP — Design Spec

- **Date:** 2026-06-03
- **Status:** Design approved (spine) — ready to detail Spec 1 into an implementation plan
- **Owner:** Jose (founder)
- **Repo:** `avoqado-server` (the MCP lives here; reuses Prisma, services, permissions)
- **Related:** internal admin MCP (`scripts/mcp/`, branch `feat/admin-mcp`) — the read-tool logic is reusable; this is a separate, multi-tenant, authenticated product.

---

## 1. Vision & Thesis

Venue operators increasingly live in AI agents (Claude / ChatGPT / Gemini), not dashboards.
The bet: expose Avoqado's data and actions to those agents so an operator can ask their
venue/org questions in natural language and get answers (and, later, take actions) — with the
agent formatting results and the MCP shipping the output rules.

This is **hybrid, not "SaaS dies"**: the dashboard stays. The MCP is a new surface for the
**management tier** (owners / admins / managers) doing analysis and admin — never the floor
staff (waiters/cashiers) who live in the POS.

**The moat is not the MCP protocol** (that's commodity). It's that every tool is scoped and
gated by Avoqado's existing permission model over a 200+ model business schema. A generic
"MCP over a database" can't do per-role, per-tenant business-aware access. Avoqado can.

**Distribution (two doors):** the self-install MCP (for the operator who pulls hardest) and,
later, the same tool layer behind the dashboard chatbot + WhatsApp (so adoption isn't bet
entirely on self-install). Spec 1 builds the self-install MCP; the second door is Spec 4.

**Demand caveat (from product review):** demand is currently founder-vision-driven, not yet
customer-pull-proven. The cheapest validation is to put a scoped read-only build in front of
one real operator (a PlayTelecom org operator, or a trusting owner) and watch them use it.
Recommended to run in parallel with the build, not after.

---

## 2. Decomposition (5 specs, build in order)

The full product is too big for one spec. It decomposes into:

1. **🔴 Spine — auth + remote transport + identity→scope (THIS SPEC).** A remote MCP that a
   real Staff authenticates to via OAuth, scoped to exactly what their role allows, with a
   central enforcement guard and a couple of proof read tools.
2. **Read tool catalog (scoped).** The full set of read tools (sales, orders, payments,
   inventory, reservations, menu, terminals, staff, reports), each filtered by scope and
   gated by its own per-tool read policy (may be broader than the dashboard — see §5).
3. **Tier-1 writes.** Reversible, non-financial writes (menu, reservations, inventory
   adjustments) with `checkPermission` + preview/confirm + manipulation defense.
4. **Second door.** Same tool layer exposed to the dashboard chatbot + WhatsApp.
5. **Output rules + Tier-2 governance.** MCP server instructions/prompts that shape how the
   agent formats answers; Tier-2 (money movement, balances, payouts, KYC, deletes) excluded
   from the agent or behind heavy human-in-loop gates.

Everything hangs off Spec 1. The rest are separate spec → plan → build cycles.

---

## 3. Spec 1 — The Spine

### 3.1 Goal

A real Staff member connects their Claude/ChatGPT/Gemini to Avoqado over OAuth, and can run a
few read tools that return **only** the data their role+scope allows — proving the whole
authenticated, scoped, remote loop end to end.

### 3.2 Architecture

```
Claude / ChatGPT / Gemini  (MCP client, does the OAuth dance)
        │  Streamable HTTP + Bearer token
        ▼
avoqado-server (Express)
  ├── mcpAuthRouter         → OAuth 2.1 AS: discovery, dynamic client registration,
  │                            /authorize (reuse dashboard login + consent), /token
  │                            (issues a JWT via jwt.service.ts)
  ├── /.well-known/...       → OAuth discovery documents
  └── POST /mcp              → requireBearerAuth → McpServer over
                               NodeStreamableHTTPServerTransport
                                   │
                                   ▼
                          per-request: token → Staff + active org
                                   │
                                   ▼  getUserAccess()  (src/services/access/access.service.ts)
                          UserAccess { allowed venue set, role, corePermissions }
                                   │
                                   ▼  withScope(access)  ← central guard
                          tool runs: query filtered to allowed venues + permission checked
```

### 3.3 Decisions (locked)

- **Authorization Server = Avoqado itself** (not an external IdP). Use the SDK's
  `mcpAuthRouter` (server auth module) for discovery + dynamic client registration +
  `/authorize` + `/token`. `/authorize` reuses the existing dashboard login (Firebase →
  Avoqado session); `/token` issues an Avoqado JWT via `jwt.service.ts`
  (`generateAccessToken`). Rationale: Avoqado already owns identity (Firebase + its own JWTs)
  and permissions; an external IdP adds a vendor + cost and still needs identity→Staff mapping.
- **Transport = Streamable HTTP** mounted as `POST /mcp` in the existing Express app
  (`NodeStreamableHTTPServerTransport`). Stateless per-request to start (simplest, scales);
  revisit stateful sessions only if a tool needs them. Lives in `avoqado-server` so it reuses
  Prisma, services, and permissions directly.
- **Token scope = one active org per connection.** A Staff may belong to multiple orgs
  (`StaffOrganization`, `OrgRole`, with `isPrimary`). The token is scoped to one active org;
  default = the Staff's `isPrimary` org. Switching orgs = reconnect, or a `switch_active_org`
  tool (deferred to Spec 2). Keeps blast radius to one org and mirrors how the dashboard
  context works.
- **Authorization derives entirely from `getUserAccess()`** — the same resolver the dashboard
  and API use. No new permission system.

### 3.4 Identity → Scope resolution (per request)

On each `/mcp` call:
1. `requireBearerAuth` validates the JWT → Staff id + active org.
2. `getUserAccess(...)` resolves `UserAccess`: the user's role, `corePermissions[]` (merged
   role defaults + `VenueRolePermission` overrides), and the data scope.
3. Resolve the **allowed venue set**:
   - Org-level **OWNER** (`OrgRole.OWNER` on the active org) → **all venues in that org**
     (access.service already grants OWNER role in every venue of the org).
   - **ADMIN / MANAGER / below** → **only their assigned venues** (`StaffVenue`), i.e.
     `dataScope: 'user-venues'`.
4. This allowed venue set + the permission list are attached to the request context for the
   guard.

### 3.5 The central guard (security crux)

**Tenant scope is enforced in ONE place, not hand-rolled per tool.** On a payments platform a
single forgotten `where: { venueId }` leaks cross-tenant data.

- A `withScope(access)` helper (or a Prisma client extension) injects the allowed-venue filter
  into every query a tool runs, and exposes a `requirePermission(perm)` gate.
- **Defense-in-depth:** a post-query assertion that every returned row's `venueId`/`orgId` is
  within the allowed set; throw (and log) if not. A leak becomes a loud error, not silent
  exposure.
- Every tool MUST go through the guard. A tool that touches Prisma directly without the guard
  is a bug the review must catch.

### 3.6 Permission policy: scope inviolable, reads relaxable, writes strict

- **Tenant scope (which venues/orgs):** NEVER relaxed. Always from `getUserAccess()`. A
  manager only ever sees their own venues' data.
- **Read capability gate:** MCP-tunable. Each read tool declares its own `requires`
  predicate. Default = mirror the dashboard permission, but a tool MAY relax to a lower bar
  (e.g. "any role with access to this venue") for reads the founder wants broader than the
  dashboard. The MCP is a **read-only superset** of the dashboard, with tenant isolation
  identical. *Which exact reads get broadened is decided per-tool in Spec 2.*
- **Write capability gate:** NEVER relaxed. Writes (Spec 3+) require the full dashboard
  permission (`hasPermission`) AND the 3-tier model (Tier-2 money/balances/payouts/KYC/deletes
  excluded from the agent).

The spine only needs to **support** per-tool permission policy (each tool carries its own
`requires`); it does not decide the relaxations.

### 3.7 Components / files (proposed)

```
src/mcp/                          # the customer-facing MCP (distinct from scripts/mcp internal)
  http.ts                         # mounts mcpAuthRouter + POST /mcp on the Express app
  auth/
    oauthProvider.ts              # AS glue: /authorize → dashboard login, /token → jwt.service
    bearer.ts                     # requireBearerAuth config; token → Staff + active org
  context.ts                      # per-request: resolve UserAccess + allowed venue set
  guard.ts                        # withScope(access): scoped Prisma + requirePermission + tenant assertion
  server.ts                       # builds McpServer, registers tools, wires transport
  tools/
    venues.ts                     # list_my_venues  (scope proof)
    sales.ts                      # daily_sales     (scope proof)
    terminals.ts                  # audit_terminals (scope proof)
```
Each file has one job, stays under ~200 lines, and is testable in isolation.

### 3.8 v1 tool set (spine proof only)

Just enough to prove the loop — full catalog is Spec 2:
- `list_my_venues` — the venues this token can see (the scope, made visible).
- `daily_sales` — sales for a venue in scope (rejects venues out of scope).
- `audit_terminals` — terminal config for a venue/org in scope.

### 3.9 Security considerations

- Tenant isolation via the central guard + post-query assertion (§3.5).
- `mcpAuthRouter` applies rate limiting to auth endpoints by default; add rate limiting to
  `/mcp` too.
- Every tool call is audit-logged: `{ staffId, activeOrg, tool, args, scope size, ts }`.
- Tokens are short-lived access + refresh (reuse `jwt.service.ts` lifetimes); revocation via
  the AS.
- No writes in Spec 1 — zero mutation blast radius.

### 3.10 Testing

- **Unit:** scope resolution (OWNER → org venues; ADMIN → assigned venues only); the guard
  (injects filter; rejects out-of-scope rows; enforces `requires`). Pure where possible.
- **Integration:** the OAuth flow (discovery → register → authorize → token → authenticated
  `/mcp` call) against a test DB; a token for an ADMIN cannot read a venue outside their set.
- **Real-agent:** connect a real Claude/ChatGPT to a staging deployment as a real Staff, run
  the 3 tools, confirm the agent picks them correctly and only in-scope data returns.

### 3.11 Out of scope for Spec 1

Writes (Spec 3), the full read catalog (Spec 2), the dashboard/WhatsApp door (Spec 4), output
rules / Tier-2 governance (Spec 5), `switch_active_org`, billing/metering of MCP usage.

---

## 4. Reference: the 3-tier write model (for Specs 3 & 5)

- **Tier 0 — read:** everything, gated only by scope + per-tool read policy.
- **Tier 1 — safe writes (reversible, non-financial):** menu, reservations, inventory
  adjustments. `checkPermission` + preview/confirm + manipulation defense.
- **Tier 2 — value-moving or irreversible:** create payments, **balances**, payouts, KYC
  approval, deletes. Excluded from the agent, or heavy human-in-loop only — never a loose
  prompt. (Note: editing a balance moves value — same risk class as creating a payment.)

---

## 5. Open questions (resolve in the implementation plan)

1. `/authorize` UX: exact reuse of the dashboard login + what the consent screen shows
   (scopes/org selection).
2. Active-org selection at connect when a Staff has multiple orgs (consent-screen picker vs
   `isPrimary` default + later switch).
3. Guard implementation: Prisma client extension vs an explicit `scopedPrisma(access)` wrapper
   — pick the one that's hardest to bypass.
4. Hosting/exposure: `/mcp` on `api.avoqado.io` directly, or a dedicated subdomain
   (`mcp.avoqado.io`); TLS/CORS for browser-based OAuth redirects.
5. Exact MCP SDK package layout/version for the auth + Streamable HTTP modules (pin during the
   plan; the internal MCP uses `@modelcontextprotocol/sdk@1.29.0`).

---

## 6. Eng-Review Addendum (plan-eng-review, 2026-06-03)

### Decisions locked
- **D1 — v0 scope:** build the full security spine (auth / guard / context separated) but prove
  the loop with ONE tool (`list_my_venues`) and fold `http.ts` into `server.ts`. The other read
  tools move to Spec 2.
- **D2 — scope model:** the connection is **org-scoped**, permissions evaluated **per venue**.
  New resolver `resolveScope(staffId, activeOrg)` → `{ allowedVenueIds, perVenueAccess:
  Map<venueId, UserAccess> }` (org OWNER → all org venues; admin/below → their `StaffVenue`).
  The guard checks `requirePermission(perm, venueId)` **per venue**. Tools accept an optional
  `venueId` drill-down (validated ∈ `allowedVenueIds`; default = all allowed venues) so a user
  can query org-wide OR per-venue. (Founder: "que sea org, pero que también pueda ver venues.")
- **D3 — auth seam:** `/authorize` serves a **self-contained login+consent page inside
  avoqado-server** (Firebase web login + consent + org picker), issues the authorization code;
  `/token` exchanges it for an Avoqado JWT via `jwt.service.ts`. The AS does not depend on the
  dashboard SPA.

### P2 findings folded with recommendations (applied unless objected)
- **Perf:** resolving access per request × per venue is DB-heavy → use `createAccessCache()`
  with a short TTL (~30–60s) keyed by `{token, activeOrg}`; re-resolve on miss. Balances
  latency vs revocation lag.
- **DCR:** keep dynamic client registration (MCP clients require it to connect) + the SDK's
  default rate limiting + a strong consent screen + audit. Revisit an allowlist only if abused.
- **SDK module:** `mcpAuthRouter` lives in the SDK's `server-legacy` module — pin the exact
  package/version and verify the API against the installed SDK before building.

### Hard invariant (P1)
- **Scope injection is non-bypassable.** Tools never touch Prisma directly; every query goes
  through the guard, which injects the `venueId ∈ allowedVenueIds` filter and asserts no
  out-of-scope rows in the result. A tool bypassing the guard is a P1 review failure.

### Tests (required in the implementation plan)
- **CRITICAL (tenant isolation):** an ADMIN token scoped to venues {A,B} attempting to read
  venue C (same or different org) returns an error, not data. The leak test — highest priority.
- **Unit:** `resolveScope` (OWNER → all org venues; admin → only assigned; per-venue role
  heterogeneity); guard (injects filter, enforces `requires` per venue, rejects out-of-scope
  rows).
- **Integration:** full OAuth flow (discovery → DCR → authorize+login+consent → token →
  authenticated `/mcp` call).
- **Real-agent:** connect a real Claude as a real Staff against staging; only in-scope data
  returns.

### NOT in scope (Spec 1)
Writes (Spec 3), the full read catalog beyond `list_my_venues` (Spec 2), the dashboard/WhatsApp
door (Spec 4), output rules / Tier-2 governance (Spec 5), `switch_active_org`, MCP-usage billing.

### What already exists (reuse, don't rebuild)
- `getUserAccess` / `hasPermission` / `getFeatureDataScope` / `createAccessCache`
  (`src/services/access/access.service.ts`).
- `jwt.service.ts` (token issue/verify), `authenticateToken.middleware.ts` (Firebase verify).
- Internal MCP read-tool query patterns (`scripts/mcp/`, branch `feat/admin-mcp`).

## 7. Outside-Voice Corrections (independent review, 2026-06-03 — ALL verified against code)

These correct/override the design above and are must-fix in the implementation plan:

1. **Login is bcrypt email/password, NOT Firebase** (`src/services/dashboard/auth.service.ts:212`,
   master-TOTP branch `:156`). D3's login+consent page is a **new bcrypt form** (+ TOTP master
   branch + multi-venue selection), not a Firebase reuse. (The workspace CLAUDE.md "Firebase
   Auth" label is stale for staff login.)
2. **P0 — MCP tokens MUST be audience-bound.** Today's JWTs omit `aud` (`src/jwt.service.ts:66`)
   → an MCP token is valid against all of `/api/v1` **including writes**. Add an `aud`/`resource`
   claim to MCP-issued tokens and **reject MCP tokens outside `/mcp`** in
   `authenticateToken.middleware.ts`. Without this the "reads relaxed / writes strict" policy is
   unenforceable. Applies whether the AS is self-hosted or external.
3. **The AS is stateful** even with a stateless transport: authorization codes, issued tokens,
   refresh tokens, and DCR clients must persist in Postgres/Redis (multi-instance Fly), not
   memory. (Largely moot if the spike picks an external IdP.)
4. **Token lifetimes:** MCP access tokens must be short (minutes–1h) + refresh + shared
   revocation — NOT the existing 24h/30d (`src/jwt.service.ts:81`).
5. **Caching:** `createAccessCache()` is **request-level only** — needs a cross-request TTL cache
   keyed by `{token, activeOrg}` (use **Redis**, already in stack). `getUserAccess` is
   venue-singular (~7 queries/call) and **throws** on no-access; `resolveScope` must handle the
   fan-out + exceptions.
6. **Read redaction (PCI/egress):** read tools touching `Payment` ship `maskedPan`/`cardBrand`/
   `authNumber` to the LLM vendor (Anthropic/OpenAI/Google). Add a **field-level redaction layer**
   in the guard for sensitive payment fields. (Caution was on writes; reads of payment data is
   also a control to decide.)
7. **Role model:** `OrgRole = {OWNER, ADMIN, MEMBER, VIEWER}` — **no MANAGER** at org level. Only
   `OrgRole.OWNER` auto-grants all org venues (`access.service.ts:299-332`). Specify the
   allowed-venue derivation against the two-enum model, incl. the org-ADMIN-with-no-`StaffVenue`
   → zero-venues case.
8. **Guard blind spot:** the post-query "every row's venueId ∈ allowedSet" assertion **cannot
   inspect aggregate results** (`groupBy`/`_sum` with no venueId column) — exactly where a missing
   `where` leaks a cross-tenant total. The guard must enforce scope **at the query level** (inject
   the filter); aggregates need explicit scoping, not row inspection.
9. **SDK:** `mcpAuthRouter` is at `@modelcontextprotocol/sdk/server/auth/router.js` (not
   "server-legacy"). The SDK + internal MCP exist **only on `feat/admin-mcp` (unmerged)** → Spec 1
   has a sequencing dependency: merge that branch first, or vendor the SDK.
10. **Smaller:** `/.well-known` collision with `apple-app-site-association` (`app.ts:129`);
    AI-vendor redirect origins not in the CORS allowlist; redact PII from audit logs; stateless
    transport = no SSE push (future reporting tools will need stateful sessions).

## 8. D5 — DECIDED: Option 3, self-hosted AS in avoqado-server (no spike, no vendor)

**Decision (2026-06-03):** Avoqado IS the AS via the SDK's `mcpAuthRouter` (`server/auth/router.js`),
all inside `avoqado-server`. Rejected: external managed IdP (signup + monthly, against the
solo-founder constraint) and self-hosted Ory Hydra (headless = still build the login UI, plus a
new service to operate). Rationale: the SDK already carries the volatile MCP-spec surface (DCR,
discovery metadata, PKCE, rate limiting); what we write is the stable OAuth 2.1 provider hooks
(code/token storage, exchange, refresh, revoke) in a codebase we already run. **No separate spike**
— the standalone risk ("does a real Claude complete the flow against `mcpAuthRouter`?") is answered
by building the v0 and connecting a real Claude. Fallback if it proves painful: Ory Hydra, then a
managed IdP.

### Cost-first phasing (founder constraint: "que no me cueste mucho al principio")
The expensive OAuth machinery does NOT go first. Build the cheap, high-value slice first; layer
OAuth on top.

- **Phase 0 — the working scoped loop (cheap, early win + demand-test vehicle):**
  Streamable HTTP `POST /mcp` + `requireBearerAuth` validating a **simple Staff bearer token**
  (a dev/personal token issued from your existing `jwt.service`, audience-bound per §7.2) +
  `resolveScope` (§D2) + the central guard (§3.5, query-level + redaction §7.6) + ONE read tool
  `list_my_venues`. A real Claude connects with a pasted token and reads only its venues. This is
  the moat (scope+guard) proven end-to-end, and the version you put in front of one real operator
  to test demand.
- **Phase 1 — the full OAuth (heavier, only after Phase 0 works / demand looks real):**
  `mcpAuthRouter` + the bcrypt login+consent+org-picker page (§7.1) + DCR + provider hooks +
  token persistence (§7.3) + short-token refresh/revocation (§7.4) + the cross-request Redis
  cache (§7.5). Turns the pasted token into the real "Connect to Avoqado" OAuth flow.

§7 corrections map to phases: P0 audience (§7.2), guard/redaction (§7.6/§7.8), role model (§7.7)
→ Phase 0. AS-statefulness (§7.3), lifetimes (§7.4), caching (§7.5), login UI (§7.1), SDK path/
merge dependency (§7.9) → Phase 1 (except the merge prerequisite, which gates Phase 0).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | partial (via office-hours) | wedge + demand framing validated |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | D1/D2/D3 decided; 3 P2 folded; non-bypassable-guard invariant; tenant-isolation test = CRITICAL |
| Outside Voice | `/codex review` → Claude subagent (codex model unavailable) | Independent challenge | 1 | issues_found | 1 P0 (token audience), 4 P1, P2/P3 — all verified vs code; reopened AS decision |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | only the consent page has UI — optional |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | n/a (backend) |

- **CROSS-MODEL:** outside voice challenged the locked "Avoqado is the AS" decision → after
  weighing it, **D5 DECIDED = Option 3 (self-hosted AS via `mcpAuthRouter`, §8)** — the SDK carries
  the volatile surface; no vendor/no new service fits the solo-founder constraint. Other
  outside-voice findings verified and folded (§7).
- **UNRESOLVED:** none — AS decided (§8); §7 corrections mapped to phases.
- **VERDICT:** ENG REVIEW CLEARED — design sound and corrected, auth path decided (Option 3),
  cost-first phasing locked (Phase 0 cheap scoped loop → Phase 1 full OAuth). Ready to write the
  **Phase 0 v0 implementation plan.**
