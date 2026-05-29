# Avoqado Admin MCP — Design Spec

- **Date:** 2026-05-29
- **Status:** Approved design — ready for implementation plan
- **Owner:** Jose (founder)
- **Repo:** `avoqado-server`
- **Scope:** Internal, single-user (founder) operational control plane exposed to Claude as an MCP server.

---

## 1. Context & Goal

Avoqado is run by a solo founder who handles ops, support, sales and code. Many recurring
operational tasks are currently delegated to Claude ad-hoc ("reset this verification",
"create this merchant", "move this terminal", "what were today's sales for venue X").

The goal is to turn those repeated requests into **reusable, safe MCP tools** so the founder
can drive Avoqado operations from any Claude session with a stable, predictable interface —
instead of hand-written queries and one-off scripts each time.

This is **not** a customer-facing product. It is a personal admin console. That single fact
removes the hardest parts of the original problem (multi-tenant auth, hosting, token
lifecycle) and lets us use the simplest viable architecture.

### Non-goals (YAGNI)
- No remote transport (HTTP/SSE), no hosting, no public exposure.
- No multi-tenant auth, no API keys, no token rotation.
- No exposure to external agents or customers (that would be a separate "Option B" project).
- No UI. The interface is the MCP tool surface inside Claude.

---

## 2. Architecture

A small MCP server living **inside `avoqado-server`** at `scripts/mcp/`, run locally over
**stdio**, registered in the founder's Claude config. It reuses the repo's Prisma client,
TypeScript types, and existing services.

```
Claude (Code / Desktop)
        │  stdio (MCP protocol)
        ▼
scripts/mcp/server.ts            ← MCP server, registers tools
        │
        ├── reads  → import prisma from '@/utils/prismaClient'   (direct Prisma)
        └── writes → import existing services                    (superadmin/*, dashboard/*)
                            │
                            ▼
                     PostgreSQL (target chosen by loaded .env)
```

### Why direct Prisma (decided)
The repo already contains ~40 `scripts/*.ts` that import `@/utils/prismaClient` and query the
DB directly (e.g. `list-active-merchants.ts`, `check-analytics.ts`, `recalculate-shift-totals.ts`).
The MCP server is the same pattern, wrapped in the MCP protocol. No new auth surface, no token
expiry, full type safety, and it reuses everything that already exists.

The rejected alternative — an HTTP wrapper over `/api/v1` with a `PartnerAPIKey` — only makes
sense if/when we expose this to external agents. It adds auth, token and URL handling for zero
benefit in a single-user local tool.

### Stack
- **MCP TS SDK** (`@modelcontextprotocol/sdk`) — the only new dependency.
- **zod** (already `^3.25.51`) — tool parameter schemas.
- **Runner:** `tsx` (already `^4.20.6`); `tsconfig-paths` for the `@/` alias.
- **Env:** `dotenv` (already present). The DB target (prod vs staging vs local) is whatever
  `DATABASE_URL` the loaded `.env` points to. **This is powerful and dangerous** — see §3.

### File layout
```
scripts/mcp/
  server.ts            # entrypoint: create McpServer, register tools, connect StdioServerTransport
  context.ts           # shared: prisma client, env loading, audit logger, confirm-guard helper
  tools/
    venues.ts          # list_venues, list_orgs
    sales.ts           # daily_sales
    terminals.ts       # audit_terminals, move_terminal
    orders.ts          # find_order, find_payment
    verifications.ts   # sale_verifications (+ reopen)
    users.ts           # update_user
    create.ts          # create_venue, create_merchant   (Phase 2)
  README.md            # how to register + run
```
Each tool file exports a `register(server)` function. `server.ts` calls each. Keeps every file
focused and under ~200 lines.

---

## 3. Safety Model (the important part)

Tools touch **production data** (the founder already operates on prod, e.g. the 2026-05-27
verification reset). The safety model is therefore mandatory, not optional.

1. **Read vs write separation.** Read tools never mutate. Write tools are clearly named and
   grouped.
2. **Writes wrap existing services, never raw Prisma writes** for anything that touches
   business rules (merchant/venue/KYC/commissions). The 213-model relational graph has
   invariants that the services already enforce; bypassing them risks corruption.
   - Exception: trivial single-field updates with no downstream effects (to be validated
     per-tool) may use Prisma directly — but still go through the confirm gate.
3. **Preview + confirm for high-impact writes.** Tools that create/approve/move call with
   `confirm: false` by default and **return a preview** of exactly what they will create or
   change. Nothing executes until the caller re-invokes with `confirm: true`. This prevents a
   fuzzy natural-language request from silently creating a live merchant or approving KYC.
4. **Environment guard.** On startup the server detects whether `DATABASE_URL` points at prod
   vs staging/local and surfaces it. Write tools include the target environment in their
   preview so the founder always knows what they're about to mutate.
5. **Audit trail.** Every write tool logs `{ tool, args, target env, timestamp, result }` to a
   local append-only file (`logs/mcp-admin-audit.log`) so there's a record of mutations made
   through the MCP.

---

## 4. Tool Catalog

Risk legend: 🟢 read · 🟡 light write (confirm) · 🔴 high-impact write (preview + confirm).
"Wraps" = the existing code the tool reuses; **(confirm in plan)** = exact source to be pinned
during the implementation plan.

### Phase 1 — reads + light writes (the "afternoon")

| # | Tool | Risk | Purpose | Wraps |
|---|------|------|---------|-------|
| 1 | `list_venues` / `list_orgs` | 🟢 | Base tool. Resolve a venue/org by name → id, so every other tool gets a correct `venueId`. Filter by org, status. | Prisma read (`Venue`, `Organization`) |
| 2 | `daily_sales` | 🟢 | Today's (or a date range's) sales for a venue: totals by payment method, order count, gross/net. | Prisma read (`Order`, `Payment`); **must use** `venueStartOfDay`/`venueEndOfDay` from `src/utils/datetime.ts` for Mexico_City timezone correctness |
| 3 | `audit_terminals` | 🟢 | List a venue's/org's terminals and their config (`showCheckout`/Cobrar, `showQuickPayment`, `enableShifts`). Surfaces config gaps like the PlayTelecom Cobrar-on/Pago-rápido-off case. | Prisma read (`Terminal`). Note: the terminal controller applies venue-level overrides to served `tpvSettings`; tool reports the **stored** config and flags known server-side overrides (confirm in plan) |
| 4 | `find_order` / `find_payment` | 🟢 | Support lookup by serial / `orderId` / `paymentId`: status, amount, items, venue, timestamps. | Prisma read (`Order`, `Payment`, `SerializedItem`) |
| 5 | `sale_verifications` | 🟢→🟡 | Search `SaleVerification` by serial/venue + show status (PENDING/COMPLETED). Includes **reset to PENDING** (reopen) with confirm. | Read: Prisma. Reopen: **wrap the existing `sale-verifications:reopen` service** (committed 2026-05-28, `2be7a02`) so it preserves invariants (SerializedItem stays SOLD; Payment/Order/Commission/Receipt untouched; socket broadcast) — do **not** raw-write the status |
| 6 | `move_terminal` | 🟡 | Reassign a terminal to a different venue. | Prisma update `Terminal.venueId` + handle activation-state caveats (confirm in plan — check `terminal-activation.service.ts`) |
| 7 | `update_user` | 🟡 | Update a user/staff member's role or core fields. | **Wrap existing staff/user update service** (confirm exact service in plan) |

### Phase 2 — high-impact creates (wrap `superadmin/*`, all preview + confirm)

| # | Tool | Risk | Purpose | Wraps |
|---|------|------|---------|-------|
| 8 | `create_venue` | 🔴 | Create a venue **with KYC pre-approved** in one step. | `superadmin/bulkVenueCreation.service.ts` + `superadmin/kycReview.service.ts` (set `kycStatus`, `kycCompletedAt`, `kycVerifiedBy`) |
| 9 | `create_merchant` | 🔴 | Create a full merchant: account + provider connection + API keys. | `superadmin/merchantAccount.service.ts` + `onboard-external-merchant.ts` logic + `generateAPIKeys` from `sdk-auth.middleware.ts`. Returns secret key **once** (mirror existing script behavior) |

### Phase 3 — candidate "etc." tools (founder to confirm priority)
These came up as likely-recurring; included for completeness, pulled into a phase as prioritized:
- `review_kyc` — approve/reject KYC standalone (`superadmin/kycReview.service.ts`) 🔴
- `assign_staff` — assign staff to venue/store 🟡
- `toggle_module` — enable/disable a module for a venue (e.g. `RESERVATIONS`, `SERIALIZED_INVENTORY`) 🟡
- `terminal_activation` — regenerate/resend a terminal activation code (`terminal-activation.service.ts`) 🟡
- `set_commission` — adjust venue/merchant commissions (`superadmin/venueCommission.service.ts`, `merchantRevenueShare.service.ts`) 🔴

---

## 5. Configuration & Registration

Run:
```bash
tsx scripts/mcp/server.ts
# (tsx resolves the @/ alias via tsconfig; dotenv loads the chosen .env)
```

Register in the founder's MCP config (e.g. `.mcp.json` or Claude config), pointing at the
chosen environment file:
```json
{
  "mcpServers": {
    "avoqado-admin": {
      "command": "tsx",
      "args": ["scripts/mcp/server.ts"],
      "cwd": "/Users/amieva/Documents/Programming/Avoqado/avoqado-server",
      "env": { "DOTENV_CONFIG_PATH": ".env" }
    }
  }
}
```
(Exact registration mechanics — global vs project, staging vs prod env file — pinned in plan.)

---

## 6. Dependencies & Build

- **Add:** `@modelcontextprotocol/sdk` (only new dep).
- **Reuse:** `zod`, `tsx`, `ts-node`, `tsconfig-paths`, `@prisma/client`, `dotenv` (all present).
- No build step needed for local use (run via `tsx`). Optionally add an `npm run mcp` script.

---

## 7. Testing

- **Per-tool unit tests** for read tools: assert query shape and output formatting against a
  test DB / fixtures (follow existing repo test patterns under `tests/`).
- **Write tools:** test the preview path (confirm:false returns preview, mutates nothing) and
  the confirm path against a staging/test DB only — never prod.
- **Manual agent-loop test:** connect the server to Claude and verify each tool is picked
  correctly from its name/description and returns usable output (per MCP best practice, tool
  naming/descriptions are half the battle).

---

## 8. Open Questions (resolve during the plan)

1. Exact staff/user update service for `update_user`.
2. Whether `move_terminal` has activation-state side effects that need a service vs a raw update.
3. Which env file the MCP defaults to — recommend defaulting to **staging** and requiring an
   explicit flag/env switch to point at prod, as an extra guardrail.
4. Final Phase 3 tool priority (founder to pick).
5. Whether the audit log should also write to an `AuditLog` DB model if one exists.

---

## 9. Risks

- **Prod mutation via fuzzy request** — mitigated by preview+confirm and env-in-preview (§3).
- **Bypassing business rules** — mitigated by wrapping services for all non-trivial writes (§3).
- **Schema drift** — tools depend on Prisma models; if a model changes, the tool's types break
  at compile time (good — caught early), but query semantics must be re-checked.
