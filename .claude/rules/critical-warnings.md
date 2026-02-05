# Critical Warnings - Always Apply

These patterns prevent the most common bugs. Violating any of these causes production issues.

## authContext (NOT req.user)

```typescript
// CORRECT
const { venueId, userId } = (req as any).authContext
const { venueId, userId: staffId } = (req as any).authContext  // rename ok

// WRONG - these don't exist
const { staffId } = (req as any).authContext  // undefined!
const user = (req as any).user               // undefined!
```

Fields: `{ userId: string, orgId: string, venueId: string, role: StaffRole }`
Source: `src/middlewares/authenticateToken.middleware.ts`

## Tenant Isolation

EVERY database query MUST filter by `venueId` or `orgId`. No exceptions.

## Money = Decimal, Never Float

```typescript
amount: new Prisma.Decimal(100.50)  // CORRECT
amount: 100.50                       // WRONG - precision loss
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

## Database Migrations

```bash
# NEVER
npx prisma db push

# ALWAYS
npx prisma migrate dev --name {description}
```

## Industry Config: Never Hardcode Client Names

```typescript
if (venue.slug === 'playtelecom') { ... }  // WRONG
// Use configuration-driven patterns instead
```

## Module Validation is Dynamic

The superadmin controller validates modules against the database, NOT a hardcoded list. New modules can be created without code changes.
