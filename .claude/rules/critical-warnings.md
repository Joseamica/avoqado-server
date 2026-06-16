# Critical Warnings - Always Apply

These patterns prevent the most common bugs. Violating any of these causes production issues.

## authContext (NOT req.user)

```typescript
// CORRECT
const { venueId, userId } = (req as any).authContext
const { venueId, userId: staffId } = (req as any).authContext // rename ok

// WRONG - these don't exist
const { staffId } = (req as any).authContext // undefined!
const user = (req as any).user // undefined!
```

Fields: `{ userId: string, orgId: string, venueId: string, role: StaffRole }` Source: `src/middlewares/authenticateToken.middleware.ts`

## Tenant Isolation

EVERY database query MUST filter by `venueId` or `orgId`. No exceptions.

## Money = Decimal, Never Float

```typescript
amount: new Prisma.Decimal(100.5) // CORRECT
amount: 100.5 // WRONG - precision loss
```

Always use `prisma.$transaction()` for money operations.

## Webhook Mounting Order

Stripe webhooks MUST mount BEFORE `express.json()` in `src/app.ts`. Raw body required for signature verification.

## Firebase Storage Paths

Always use `buildStoragePath()` from `src/services/storage.service.ts`. Always use `venue.slug` (not `venueId`).

```typescript
const path = buildStoragePath(`venues/${venue.slug}/kyc/${doc}.pdf`)
// "prod/venues/my-venue/kyc/INE.pdf" or "dev/venues/..."
```

## Timezone: Prisma = UTC, Raw SQL = Mexico Local

PostgreSQL has `timezone = 'America/Mexico_City'` + `timestamp without time zone` columns.

- **Prisma stores REAL UTC** — `new Date()` in JS → UTC in DB (verified: 1:10 PM Mexico → `19:10` in DB)
- **Raw SQL `NOW()`** → stores Mexico local time (PG applies timezone)
- For Prisma date range queries, use `fromZonedTime()` to convert venue-local → UTC:

```typescript
import { fromZonedTime } from 'date-fns-tz'
// Pass a STRING (not new Date(...)) so it is read in the VENUE tz, NOT the Node host tz:
// "Feb 6 Mexico midnight" → 2026-02-06T06:00:00Z (real UTC)
const dayStart = fromZonedTime(`${dateStr}T00:00:00.000`, venueTz)
const dayEnd = fromZonedTime(`${dateStr}T23:59:59.999`, venueTz) // INCLUSIVE end-of-day
```

### 🔴 A bare `YYYY-MM-DD` is a RUNTIME-TZ trap (real LIVE prod money bug, 2026-06-15)

`parseISO('2026-06-02')`, `new Date('2026-06-02')`, **and even** `fromZonedTime(new Date('2026-06-02T00:00:00'), tz)` all resolve to **midnight in the Node HOST timezone**, not the venue's. **Prod sets no `TZ` (check Dockerfile/render.yaml — none) → Node runs UTC**, so `parseISO('2026-06-02')` = jun-2 00:00Z = jun-1 18:00 Mexico → a venue-local day range shifts a WHOLE DAY earlier (income statements / sales reports wrong). It hides in dev because dev hosts often run `TZ=America/Mexico_City`. This bit `parseDbDateRange` (income statement — dashboard **and** MCP) and `parseDateRange` (MCP analytics). Fixes: `c41b03d6`, `a8aa70a0`.

**For a venue-local day range, NEVER let the runtime parse a bare date. Use ONE of:**

- `fromZonedTime(\`${date}T00:00:00.000\`, venueTz)` / `…T23:59:59.999` — pass a **STRING** (host-tz-independent). ✅
- `venueStartOfDay(tz, new Date(\`${date}T12:00:00\`))` / `venueEndOfDay(tz, …)` — the **noon anchor** keeps the calendar day under any host tz. ✅
- `parseDbDateRange(from, to, venueTz)` (now host-tz-safe) for direct queries; `getVenueChartData()` (`src/mcp/chartData.ts`) for the `getChartData` path.

**Verify under prod's tz**, not just yours: run date tests with `TZ=UTC npx jest …`. For money, `scripts/mcp-money-reconcile.ts` proves MCP totals == DB to the cent. (Setting `TZ=America/Mexico_City` in the deploy is belt-and-suspenders, but the CODE must be host-tz-independent regardless — never rely on the env.)

- Frontend: dates arrive as UTC → `useVenueDateTime()` or browser locale converts for display
- **NEVER add `timeZone: 'UTC'` to frontend formatting** — displays raw UTC instead of local
- See `memory/datetime-fixes.md` for full reference

## Database Migrations

```bash
# NEVER
npx prisma db push

# ALWAYS
npx prisma migrate dev --name {description}
```

## Schema Map — MANDATORY when adding new Prisma models

**Whenever you add a new `model Foo {}` to `prisma/schema.prisma`, you MUST also:**

1. Open `scripts/generate-schema-map.ts` and add the new model name to the `MODEL_TO_DOMAIN` map (pick one of the 20 domains — group it with
   siblings).
2. Run `npm run schema:map` to regenerate `docs/SCHEMA_MAP.md`.
3. Stage BOTH `scripts/generate-schema-map.ts` AND `docs/SCHEMA_MAP.md` along with the schema change in the SAME commit.

The script fails fast on unclassified models — leaving a new model unmapped breaks `npm run schema:map` for the next person.

**Heuristic for picking the domain**: look at where the model's `@relation` fields point. If it's tightly coupled to `Terminal` /
`TpvCommand` / `AppUpdate` → `Terminals / TPV Fleet`. If it's about `Order` / `Payment` / `MerchantAccount` → `Orders, KDS & Cash` or
`Payments & Fees`. When in doubt, `grep` an existing sibling in `MODEL_TO_DOMAIN` and copy its placement.

This rule applies to **renames** too — if you rename `Foo` → `Bar` in the schema, update the same key in `MODEL_TO_DOMAIN`.

## Industry Config: Never Hardcode Client Names

```typescript
if (venue.slug === 'playtelecom') { ... }  // WRONG
// Use configuration-driven patterns instead
```

## Module Validation is Dynamic

The superadmin controller validates modules against the database, NOT a hardcoded list. New modules can be created without code changes.

## Zod Schemas: Spanish Only, No Business Logic

**ALL Zod error messages MUST be in Spanish.** The validation middleware (`src/middlewares/validation.ts`) shows Zod messages directly to
users. English messages appear raw in the UI.

**Zod = shape/format only. Service layer = business rules.** Never validate context-dependent logic in schemas (e.g., password strength that
only applies to new users, not existing users verifying via bcrypt).

```typescript
// ❌ WRONG - English, business logic in schema
password: z.string().min(8, 'Password must be at least 8 characters')

// ✅ CORRECT - Spanish, shape-only in schema
password: z.string().min(1, 'La contraseña es requerida').optional()
// Validate strength in service layer only for new accounts
```

## 🔴 CRITICAL — Two MCPs: keep the CUSTOMER MCP in sync (do NOT confuse them)

Avoqado has **two separate MCP servers**. Confusing them causes branch chaos:

- **Customer MCP** = `src/mcp/` — the customer-facing **product** (Streamable HTTP + OAuth, scoped by `getUserAccess()`), on **`develop`**.
  **New feature tools go HERE**, in `src/mcp/tools/`, registered in `src/mcp/server.ts`.
- **Admin MCP** = `scripts/mcp/` — an **internal** founder-ops tool (stdio), separate, only on `feat/admin-mcp` (unmerged).

**This rule targets the CUSTOMER MCP (`src/mcp/`).** Whenever you add or change a feature, model, service, endpoint, permission, or any
capability an operator should be able to read (later: act on), add/update the matching tool in `src/mcp/tools/` as part of the SAME change.
A capability not reachable through the customer MCP is unfinished. **Do NOT** add product tools to the admin MCP, and **do NOT** merge
`feat/admin-mcp` into develop just to add a tool.

## 🔴 CRITICAL — Audit every meaningful mutation with ActivityLog

Every **audit-worthy state change MUST write an `ActivityLog` row in the SAME change** — never "later". `ActivityLog` is the platform's
audit trail (who did what, when) and the `/full-testing` flow verifies backend actions against it.

**MUST log (mutations that matter):** create / update / delete of domain entities (Venue, Order, Payment, Staff, VenueFeature, Terminal,
MerchantAccount…), money ops (payments, refunds, settlements, payouts), access / permission changes, **superadmin overrides** (plan
activate/deactivate, grant-trial, adjust-end-date, feature enable/disable), and status changes (KYC, subscription, suspension).

**Do NOT log:** reads / list queries, internal computations, no-ops, or high-frequency events (TPV heartbeats, barcode scans, webhook
retries, request logging) — that bloats the table and adds noise. Audit-worthy mutations only.

```typescript
await prisma.activityLog.create({
  data: {
    action: 'SUPERADMIN_PLAN_DEACTIVATED', // SCREAMING_SNAKE verb describing the action
    entity: 'VenueFeature', // the model touched
    entityId: venueFeature.id,
    staffId: (req as any).authContext.userId, // WHO did it (authContext, NOT req.user)
    venueId, // tenant scope
    data: { featureCode, reason }, // jsonb: relevant context/params
  },
})
```

A mutating endpoint without an `ActivityLog` write is **unfinished** — treat it like permissions and the MCP: kept in lockstep, never an
afterthought. (Backend-only: client repos call the API; `avoqado-server` is what audits.)
