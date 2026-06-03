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
// "Feb 6 Mexico midnight" → 2026-02-06T06:00:00Z (real UTC)
const dayStart = fromZonedTime(new Date(`${dateStr}T00:00:00`), 'America/Mexico_City')
```

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

## 🔴 CRITICAL — Keep the Avoqado MCP in sync

The Avoqado MCP (`avoqado-server/scripts/mcp/`) is a **first-class interface**: it exposes
the platform's data and actions to AI agents (internal ops today, customer-facing tomorrow).
It must never fall behind the platform.

**Whenever you add or change a feature, Prisma model, service, endpoint, permission, or any
capability the MCP should expose, you MUST add or update the matching MCP tool in
`avoqado-server/scripts/mcp/` as part of the SAME change — never "later".** A capability that
exists but isn't reachable through the MCP is unfinished. Treat the MCP like permissions: kept
in lockstep, never an afterthought.
