# CLAUDE.md - Avoqado Backend Server

This file is the **index** for Claude Code. It provides quick context and points to detailed documentation in `docs/`.

---

## 1. CRITICAL: Blumon Has TWO Separate Integrations

**BEFORE working on anything Blumon**, identify which integration:

|                        | **TPV (Android SDK)**                  | **E-commerce (Web Payments)**          |
| ---------------------- | -------------------------------------- | -------------------------------------- |
| **What is it?**        | Physical PAX terminals                 | Web SDK for online payments            |
| **Where does it run?** | APK connects DIRECTLY to Blumon        | BACKEND calls Blumon API               |
| **Environment config** | **APK build variant** (sandbox/prod)   | **`USE_BLUMON_MOCK`** env var          |
| **Database model**     | `MerchantAccount` + `Terminal`         | `EcommerceMerchant` + `CheckoutSession`|
| **Service file**       | `src/services/tpv/blumon-tpv.service.ts` | `src/services/sdk/blumon-ecommerce.service.ts` |

**Full docs**: `docs/BLUMON_TWO_INTEGRATIONS.md`

**Rule**: Always say "Blumon TPV" or "Blumon E-commerce". Just "Blumon" is ambiguous.

---

## 2. Role & Identity

Always assume the role of a world-class, battle-tested full-stack engineer with experience at Toast and Square. You have elite mastery of POS terminals, payments, reconciliation, compliance (PCI/KYC), security, reliability, and merchant experience end-to-end.

---

## 3. Documentation Map

### Architecture & Core

| Document | Description |
|----------|-------------|
| `docs/ARCHITECTURE_OVERVIEW.md` | Layered architecture, multi-tenant, control/application plane |
| `docs/PERMISSIONS_SYSTEM.md` | Permission system, RBAC, override vs merge modes |
| `docs/DATABASE_SCHEMA.md` | Complete database schema reference |

### Payments

| Document | Description |
|----------|-------------|
| `docs/BLUMON_TWO_INTEGRATIONS.md` | **READ FIRST**: TPV vs E-commerce distinction |
| `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md` | Developer reference for TPV coding |
| `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md` | Multi-merchant deep dive |
| `docs/blumon-ecommerce/REFACTORING_COMPLETE.md` | E-commerce direct charge implementation |
| `docs/PAYMENT_ARCHITECTURE.md` | Money flow, merchant accounts, profit calculation |
| `docs/STRIPE_INTEGRATION.md` | Stripe subscriptions, feature gating, webhooks |

### Inventory

| Document | Description |
|----------|-------------|
| `docs/INVENTORY_REFERENCE.md` | FIFO batch system, stock deduction, recipes |
| `docs/INVENTORY_TESTING.md` | Integration tests, critical bugs fixed |

### AI Chatbot

| Document | Description |
|----------|-------------|
| `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` | 5-layer security, consensus voting, testing |

### Terminal & TPV

| Document | Description |
|----------|-------------|
| `docs/TERMINAL_IDENTIFICATION.md` | Serial numbers, activation, heartbeat |
| `docs/TPV_COMMAND_SYSTEM.md` | Remote commands, polling, ACK flow |

### Development & Operations

| Document | Description |
|----------|-------------|
| `docs/DATETIME_SYNC.md` | Timezone handling between frontend/backend |
| `docs/CI_CD_SETUP.md` | GitHub Actions, deployment |
| `docs/ENVIRONMENT_SETUP_GUIDE.md` | Local development setup |
| `docs/PRODUCTION_READINESS_CHECKLIST.md` | Pre-deployment checklist |
| `docs/UNUSED_CODE_DETECTION.md` | Dead code detection tools |

### Implementation Plans (In Progress)

| Document | Description |
|----------|-------------|
| `docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md` | Customer + Discounts (Phase 1: 85%) |

---

## 4. Development Commands

### Essential Commands

```bash
npm run dev          # Start dev server with hot reload
npm run build        # Compile TypeScript
npm run pre-deploy   # CI/CD simulation (MUST pass before push)
npm test             # Run all tests
npm run test:unit    # Unit tests only
npm run lint:fix     # Auto-fix ESLint issues
npm run format       # Format with Prettier
npm run studio       # Launch Prisma Studio
```

### Database Rules

- **NEVER** use `npx prisma db push` - bypasses migration history
- **ALWAYS** use `npx prisma migrate dev --name {description}`
- If drift occurs: `npx prisma migrate reset --force`

### Seed Data Policy

When implementing NEW features, update:
- `prisma/seed.ts` - Global seed data (features, payment providers)
- `src/services/onboarding/demoSeed.service.ts` - Demo venue data

### Testing Policy

After major changes:
1. Create test script in `scripts/` for validation
2. Migrate to Jest tests before committing
3. Delete temporary scripts
4. Run `npm run pre-deploy` before push

---

## 5. Architecture Quick Reference

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

| Layer | Responsibility |
|-------|----------------|
| **Routes** | HTTP endpoint definitions |
| **Controllers** | Extract req data, call services, send responses (thin) |
| **Services** | Business logic, validations, database operations |
| **Middlewares** | Auth, validation, logging, permissions |

**Full details**: `docs/ARCHITECTURE_OVERVIEW.md`

---

## 6. Role Hierarchy

| Role | Scope | Key Permissions |
|------|-------|-----------------|
| **SUPERADMIN** | Full system | Complete administrative control |
| **OWNER** | Organization-wide | Can manage all venues in org |
| **ADMIN** | Venue-specific | Complete venue management |
| **MANAGER** | Venue-specific | Shift, staff, inventory management |
| **CASHIER** | Venue-specific | Payment processing, POS |
| **WAITER** | Venue-specific | Order management, table service |
| **KITCHEN** | Venue-specific | Kitchen display, order prep |
| **HOST** | Venue-specific | Reservations, seating |
| **VIEWER** | Venue-specific | Read-only access |

---

## 7. Critical Patterns (MUST Follow)

### Authentication

```typescript
// CORRECT - Use authContext
const { userId, venueId, orgId, role } = (req as any).authContext

// WRONG - req.user does NOT exist
const user = (req as any).user // undefined!
```

### Tenant Isolation

```typescript
// EVERY database query MUST filter by venueId or orgId
const orders = await prisma.order.findMany({
  where: { venueId } // ALWAYS include this
})
```

### Money Handling

```typescript
// CORRECT - Use Decimal
amount: new Prisma.Decimal(100.50)

// WRONG - Never use float for money
amount: 100.50 // precision loss!
```

### Payment Transactions

```typescript
// ALWAYS use transaction for money operations
await prisma.$transaction(async (tx) => {
  await tx.payment.create(...)
  await tx.order.update(...)
})
```

### Webhook Mounting

```typescript
// Stripe webhooks MUST be mounted BEFORE express.json()
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), handler)
app.use(express.json()) // After webhooks
```

---

## 8. Documentation Policy

### What goes in CLAUDE.md (this file)

- Critical warnings (Blumon distinction)
- Documentation map (pointers to docs/)
- Development commands
- Quick architecture reference
- Critical patterns

### What goes in docs/*.md

- Detailed implementation guides
- Complete architecture explanations
- Troubleshooting guides
- Testing references

### Golden Rules

1. Document **WHY**, not **HOW** (code explains HOW)
2. Tests are living documentation
3. If code + tests explain it clearly → don't document
4. ALL new docs go in `docs/` directory, never in root

---

## 9. Pending TODOs

### Chatbot Token Pricing (Requested 2025-01-25)

Currently hardcoded in:
- `src/services/dashboard/token-budget.service.ts`
- `src/controllers/dashboard/token-budget.dashboard.controller.ts`

TODO: Create superadmin-configurable pricing system.

---

## Quick Links

| Need to... | Go to... |
|------------|----------|
| Understand architecture | `docs/ARCHITECTURE_OVERVIEW.md` |
| Work on Blumon TPV | `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md` |
| Work on Blumon E-commerce | `docs/blumon-ecommerce/REFACTORING_COMPLETE.md` |
| Work on inventory | `docs/INVENTORY_REFERENCE.md` |
| Work on chatbot | `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` |
| Work on Stripe | `docs/STRIPE_INTEGRATION.md` |
| Work on permissions | `docs/PERMISSIONS_SYSTEM.md` |
| Work on terminals | `docs/TERMINAL_IDENTIFICATION.md` |
| Deploy to production | `docs/PRODUCTION_READINESS_CHECKLIST.md` |
