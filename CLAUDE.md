# CLAUDE.md - Avoqado Backend Server

This file is the **index** for Claude Code. It provides quick context and points to detailed documentation in `docs/`.

---

## 🔴 MANDATORY: Documentation Update Rule (READ FIRST)

**Be very careful on allucinations of the code.**

**When implementing or modifying ANY feature, you MUST:**

1. **Check if documentation exists** for the feature/area you're modifying
2. **Update the documentation** if your changes affect documented behavior
3. **Create new documentation** if implementing a new significant feature
4. **Update `docs/README.md`** index if creating new docs
5. **Update references in this CLAUDE.md** if you add new doc files

**This is NOT optional.** Documentation debt causes confusion and bugs.

```
✅ DO: Implement feature → Update docs → Commit both together
❌ DON'T: Implement feature → "I'll document it later" → Never document it
```

**Central hub:** `docs/README.md` is the master index for ALL cross-repo documentation.

---

## 1. CRITICAL: Blumon Has TWO Separate Integrations

**BEFORE working on anything Blumon**, identify which integration:

|                        | **TPV (Android SDK)**                    | **E-commerce (Web Payments)**                  |
| ---------------------- | ---------------------------------------- | ---------------------------------------------- |
| **What is it?**        | Physical PAX terminals                   | Web SDK for online payments                    |
| **Where does it run?** | APK connects DIRECTLY to Blumon          | BACKEND calls Blumon API                       |
| **Environment config** | **APK build variant** (sandbox/prod)     | **`USE_BLUMON_MOCK`** env var                  |
| **Database model**     | `MerchantAccount` + `Terminal`           | `EcommerceMerchant` + `CheckoutSession`        |
| **Service file**       | `src/services/tpv/blumon-tpv.service.ts` | `src/services/sdk/blumon-ecommerce.service.ts` |

**Full docs**: `docs/BLUMON_TWO_INTEGRATIONS.md`

**Rule**: Always say "Blumon TPV" or "Blumon E-commerce". Just "Blumon" is ambiguous.

---

## 2. Role & Identity

Always assume the role of a world-class, battle-tested full-stack engineer with experience at Toast and Square. You have elite mastery of
POS terminals, payments, reconciliation, compliance (PCI/KYC), security, reliability, and merchant experience end-to-end.

---

## 3. Documentation Map

### Architecture & Core

| Document                        | Description                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `docs/ARCHITECTURE_OVERVIEW.md` | Layered architecture, multi-tenant, control/application plane     |
| `docs/PERMISSIONS_SYSTEM.md`    | Permission system, RBAC, override vs merge modes                  |
| `docs/DATABASE_SCHEMA.md`       | Complete database schema reference (includes StaffOrganization)   |
| `docs/BUSINESS_TYPES.md`        | VenueType enum, BusinessCategory, MCC mapping, industry standards |
| `docs/features/TEAM_INVITATIONS.md` | Team invitations, multi-venue, multi-org (StaffOrganization)  |
| `docs/features/ORGANIZATION_PAYMENT_CONFIG.md` | Org-level payment config with venue inheritance |

### Payments

| Document                                            | Description                                       |
| --------------------------------------------------- | ------------------------------------------------- |
| `docs/BLUMON_TWO_INTEGRATIONS.md`                   | **READ FIRST**: TPV vs E-commerce distinction     |
| `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md`         | Developer reference for TPV coding                |
| `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md` | Multi-merchant deep dive                          |
| `docs/blumon-ecommerce/REFACTORING_COMPLETE.md`     | E-commerce direct charge implementation           |
| `docs/PAYMENT_ARCHITECTURE.md`                      | Money flow, merchant accounts, profit calculation |
| `docs/STRIPE_INTEGRATION.md`                        | Stripe subscriptions, feature gating, webhooks    |

### Blumon MCC & Provider Cost Rates

**What is MCC Anexo 53?** Blumon's official document (AN53.pdf) that maps 700+ business types to MCC codes and "Familias" (categories). Each
Familia has specific processing rates that Blumon charges.

**Rate Flow:**

```
VenueType (RESTAURANT) → MCC Lookup → Familia (Restaurantes) → Provider Rates
                                                              ↓
                                           { credito: 2.30%, debito: 1.68%, intl: 3.30%, amex: 3.00% }
```

**Data Files:** | File | Description | |------|-------------| | `src/data/blumon-pricing/familias-tasas.json` | 29 Familias with Blumon's
rates (from AN53) | | `src/data/blumon-pricing/business-synonyms.json` | 185+ business name → MCC/Familia mappings |

**Service:** | File | Function | |------|----------| | `src/services/pricing/blumon-mcc-lookup.service.ts` | `lookupRatesByBusinessName()` -
Fuzzy match business name to rates |

**Cost Structure Relationship:** | Model | What it represents | Example | |-------|-------------------|---------| | `ProviderCostStructure`
| What Blumon charges Avoqado | 2.30% credit (from MCC lookup) | | `VenuePricingStructure` | What Avoqado charges venue | 2.50% credit
(includes ~0.20% margin) |

**Usage Example:**

```typescript
import { lookupRatesByBusinessName } from '@/services/pricing/blumon-mcc-lookup.service'

const result = lookupRatesByBusinessName('Gimnasio')
// → { familia: 'Entretenimiento', mcc: '7941', confidence: 100,
//    rates: { credito: 1.70, debito: 1.63, internacional: 3.30, amex: 3.00 } }
```

**Test:** `npx ts-node scripts/test-mcc-lookup.ts`

### Inventory

| Document                                | Description                                             |
| --------------------------------------- | ------------------------------------------------------- |
| `docs/INVENTORY_REFERENCE.md`           | FIFO batch system, stock deduction, recipes             |
| `docs/INVENTORY_TESTING.md`             | Integration tests, critical bugs fixed                  |
| `docs/features/SERIALIZED_INVENTORY.md` | Unique barcode items (SIMs, jewelry, electronics, etc.) |

### Module System (Multi-Tenant Features)

**Concept:** Modules enable/disable behavior. Different from VenueFeature (billing).

**Two-Level Inheritance:**

- **OrganizationModule**: Enables module for ALL venues in an organization
- **VenueModule**: Enables module for a SPECIFIC venue (overrides org-level)

```
Organization (PlayTelecom)
    └── OrganizationModule: SERIALIZED_INVENTORY (config: { labels: { item: "SIM" } })
            ↓ inherited by all 38 venues
        ├── Venue 1: uses org config
        ├── Venue 2: uses org config
        └── Venue 3: VenueModule override (config: { labels: { item: "eSIM" } })
```

**Resolution Order:**

1. Check VenueModule first (explicit venue override wins)
2. If no VenueModule, fallback to OrganizationModule (inherited)

**Config Merge Order:**

1. Module.defaultConfig (base)
2. OrganizationModule.config (org customization)
3. VenueModule.config (venue override)

```typescript
// Check if module is enabled for venue (checks both levels)
const enabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)

// Get merged config (Module.default → Org.config → Venue.config)
const config = await moduleService.getModuleConfig(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
// config.labels.item = "SIM" (telecom) or "Pieza" (jewelry)

// Enable for entire organization (all venues get it)
await moduleService.enableModuleForOrganization(orgId, 'SERIALIZED_INVENTORY', staffId, config, 'telecom')

// Enable for specific venue (override org-level)
await moduleService.enableModule(venueId, 'SERIALIZED_INVENTORY', staffId, customConfig)
```

**Key Files:**

- `src/services/modules/module.service.ts` - Module enable/config/check (both levels)
- `src/controllers/dashboard/modules.superadmin.controller.ts` - CRUD de módulos
- `src/services/serialized-inventory/serializedInventory.service.ts` - Scan, register, sell
- `scripts/setup-modules.ts` - Create global modules
- `scripts/setup-playtelecom.ts` - Example venue setup

**Available Modules:**

| Code                    | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `SERIALIZED_INVENTORY`  | Inventario con items únicos (SIMs, joyas, electrónicos) |
| `ATTENDANCE_TRACKING`   | Control de asistencia de personal                       |
| `WHITE_LABEL_DASHBOARD` | Dashboards personalizados para clientes enterprise      |

**⚠️ IMPORTANTE: Validación Dinámica de Módulos**

El controller de superadmin valida módulos **contra la base de datos**, NO contra una lista hardcodeada. Esto permite crear nuevos módulos
sin modificar código:

```typescript
// ✅ CORRECTO - Validación dinámica en modules.superadmin.controller.ts
const moduleExists = await prisma.module.findUnique({
  where: { code: moduleCode },
  select: { id: true, active: true },
})

if (!moduleExists) {
  return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
}

// ❌ INCORRECTO - NO usar listas hardcodeadas para validar
if (!Object.values(MODULE_CODES).includes(moduleCode)) { ... }
```

**Full docs:**

- `docs/features/SERIALIZED_INVENTORY.md`
- `avoqado-web-dashboard/docs/features/WHITE_LABEL_DASHBOARD.md` (visual builder)

### AI Chatbot

| Document                                | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` | 5-layer security, consensus voting, testing |

### Terminal & TPV

| Document                          | Description                           |
| --------------------------------- | ------------------------------------- |
| `docs/TERMINAL_IDENTIFICATION.md` | Serial numbers, activation, heartbeat |
| `docs/TPV_COMMAND_SYSTEM.md`      | Remote commands, polling, ACK flow    |

### Development & Operations

| Document                                 | Description                                |
| ---------------------------------------- | ------------------------------------------ |
| `docs/DATETIME_SYNC.md`                  | Timezone handling between frontend/backend |
| `docs/CI_CD_SETUP.md`                    | GitHub Actions, deployment                 |
| `docs/ENVIRONMENT_SETUP_GUIDE.md`        | Local development setup                    |
| `docs/PRODUCTION_READINESS_CHECKLIST.md` | Pre-deployment checklist                   |
| `docs/UNUSED_CODE_DETECTION.md`          | Dead code detection tools                  |

### Implementation Plans (In Progress)

| Document                                                           | Description                               |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `docs/clients&promotions/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md` | Customer + Discounts (Phase 1: 85%)       |
| `docs/clients&promotions/CUSTOMER_LOYALTY_PROMOTIONS_REFERENCE.md` | Complete reference for customers & promos |

### Industry Configuration (Multi-Vertical Support)

| Document                                       | Description                                          |
| ---------------------------------------------- | ---------------------------------------------------- |
| `docs/industry-config/README.md`               | Overview and index for industry configuration system |
| `docs/industry-config/ARCHITECTURE.md`         | Configuration-driven architecture patterns           |
| `docs/industry-config/IMPLEMENTATION_PLAN.md`  | Phase-by-phase implementation plan                   |
| `docs/industry-config/BACKEND_SPEC.md`         | Backend technical specifications                     |
| `docs/industry-config/TPV_SPEC.md`             | TPV Android specifications                           |
| `docs/industry-config/REQUIREMENTS_TELECOM.md` | PlayTelecom client requirements                      |

**Key Concept:** Configuration-driven architecture allows serving multiple industries (Telecom, Retail, Restaurant) with a single codebase.
No client-specific code.

```typescript
// NEVER do this:
if (venue.slug === 'playtelecom') { ... }

// ALWAYS do this:
const config = getIndustryConfig(venue)
if (config.attendance.requirePhoto) { ... }
```

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

### Git Policy

**CRITICAL: NEVER commit, push, or make git changes without explicit user permission.**

- Before `git add` → Ask user first
- Before `git commit` → Ask user first
- Before `git push` → Ask user first
- Before `git merge` → Ask user first

This applies even if changes look complete. Always ask: "¿Quieres que haga commit de estos cambios?"

---

## 5. Architecture Quick Reference

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

| Layer           | Responsibility                                         |
| --------------- | ------------------------------------------------------ |
| **Routes**      | HTTP endpoint definitions                              |
| **Controllers** | Extract req data, call services, send responses (thin) |
| **Services**    | Business logic, validations, database operations       |
| **Middlewares** | Auth, validation, logging, permissions                 |

**Full details**: `docs/ARCHITECTURE_OVERVIEW.md`

---

## 6. Role Hierarchy

**Roles exist at TWO levels:**

### Organization-Level Roles (`OrgRole` on `StaffOrganization`)

| Role       | Description                                      |
| ---------- | ------------------------------------------------ |
| **OWNER**  | Organization owner, full org-level control       |
| **ADMIN**  | Organization admin, can manage org settings      |
| **MEMBER** | Regular member, default for invited staff        |
| **VIEWER** | Read-only organization access                    |

### Venue-Level Roles (`StaffRole` on `StaffVenue`)

| Role           | Scope             | Key Permissions                    |
| -------------- | ----------------- | ---------------------------------- |
| **SUPERADMIN** | Full system       | Complete administrative control    |
| **OWNER**      | Organization-wide | Can manage all venues in org       |
| **ADMIN**      | Venue-specific    | Complete venue management          |
| **MANAGER**    | Venue-specific    | Shift, staff, inventory management |
| **CASHIER**    | Venue-specific    | Payment processing, POS            |
| **WAITER**     | Venue-specific    | Order management, table service    |
| **KITCHEN**    | Venue-specific    | Kitchen display, order prep        |
| **HOST**       | Venue-specific    | Reservations, seating              |
| **VIEWER**     | Venue-specific    | Read-only access                   |

**Multi-org model:** Staff can belong to multiple organizations via `StaffOrganization` (junction table). Each membership has an `OrgRole` and an `isPrimary` flag. See `docs/features/TEAM_INVITATIONS.md` and `docs/DATABASE_SCHEMA.md` for details.

---

## 7. Critical Patterns (MUST Follow)

### Authentication & authContext

**⚠️ CRITICAL: `authContext` Structure**

The `authContext` object is set by `authenticateToken.middleware.ts` and contains ONLY these fields:

```typescript
interface AuthContext {
  userId: string // ← Staff member ID (from JWT sub claim)
  orgId: string // ← Organization ID (derived from venue.organizationId or StaffOrganization)
  venueId: string // ← Venue ID
  role: string // ← User role (ADMIN, MANAGER, CASHIER, etc.)
}
```

**Common Mistakes:**

```typescript
// ❌ WRONG - staffId does NOT exist in authContext!
const { venueId, staffId } = (req as any).authContext // staffId = undefined!

// ✅ CORRECT - userId IS the staff member ID
const { venueId, userId } = (req as any).authContext

// ✅ CORRECT - Rename for clarity if needed
const { venueId, userId: staffId } = (req as any).authContext

// ❌ WRONG - req.user does NOT exist
const user = (req as any).user // undefined!
```

**Why `userId` and not `staffId`?**

- The JWT token stores the staff ID in the `sub` (subject) claim
- The middleware names it `userId` because it's the authenticated user's ID
- In TPV context, `userId` === `staffId` (they're the same person)

**Source:** `src/middlewares/authenticateToken.middleware.ts`

### Tenant Isolation

```typescript
// EVERY database query MUST filter by venueId or orgId
const orders = await prisma.order.findMany({
  where: { venueId }, // ALWAYS include this
})
```

### Money Handling

```typescript
// CORRECT - Use Decimal
amount: new Prisma.Decimal(100.5)

// WRONG - Never use float for money
amount: 100.5 // precision loss!
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

### Firebase Storage Paths

**CRITICAL**: All Firebase Storage paths MUST include:

1. **Environment prefix** (`dev/` or `prod/`) - separates sandbox from production data
2. **Venue slug** (never venueId) - human-readable paths

**Path Structure:**

```
{env}/venues/{venueSlug}/{folder}/{date}/{filename}
```

**Examples:**

- `dev/venues/avoqado-full/verifications/2025-12-12/ORDER-12345.jpg`
- `prod/venues/avoqado-full/clockin/2025-12-12/staff123_1704067200000.jpg`
- `dev/venues/mi-restaurante/logos/cropped_1704067200000.jpg`

**Backend (avoqado-server)**: Always use `buildStoragePath()`:

```typescript
import { buildStoragePath } from '@/services/storage.service'

// CORRECT - Use buildStoragePath() with venue.slug
const path = buildStoragePath(`venues/${venue.slug}/kyc/${documentName}.pdf`)
// Result: "prod/venues/my-venue/kyc/INE.pdf" (production)
// Result: "dev/venues/my-venue/kyc/INE.pdf" (development)

// WRONG - Missing environment prefix or using venueId
const path = `venues/${venue.slug}/kyc/${documentName}.pdf` // NO prefix!
const path = `venues/${venueId}/kyc/${documentName}.pdf` // NO! Use slug!
```

**Frontend (avoqado-web-dashboard)**: Use `buildStoragePath()` from firebase.ts:

```typescript
import { storage, buildStoragePath } from '@/firebase'
import { ref } from 'firebase/storage'

// CORRECT - Use buildStoragePath() with venueSlug from hook
const { venueSlug } = useCurrentVenue()
const storageRef = ref(storage, buildStoragePath(`venues/${venueSlug}/logos/${fileName}`))
// Result: "prod/venues/my-venue/logos/cropped_123.jpg" (production)
// Result: "dev/venues/my-venue/logos/cropped_123.jpg" (development)

// WRONG - Missing buildStoragePath or using venue?.slug
const storageRef = ref(storage, `venues/${venueSlug}/logos/${fileName}`) // NO prefix!
```

**Android (avoqado-tpv)**: Use `buildStoragePath()` in VerificationUploadManager:

```kotlin
// CORRECT - Environment prefix is determined by build flavor
val storagePath = buildStoragePath("venues/$venueSlug/verifications/$dateStr/$fileName")
// Result: "prod/venues/..." (production flavor)
// Result: "dev/venues/..." (sandbox flavor)

// WRONG - Missing buildStoragePath
val storagePath = "venues/$venueSlug/verifications/$dateStr/$fileName" // NO prefix!
```

---

## 8. Email Template Design Standards

**ALL email templates MUST follow this unified design.** This ensures brand consistency across all communications.

### Design Specifications

| Element | Value |
|---------|-------|
| **Background** | White (`#ffffff`) |
| **Text color** | Black (`#000000`) |
| **Link color** | Blue (`#1a73e8`) |
| **Border color** | Light gray (`#e0e0e0`) |
| **Font family** | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` |
| **Logo URL** | `https://avoqado.io/isotipo.svg` |
| **Max width** | `600px` |
| **Border radius** | `8px` for content boxes, `4px` for buttons |

### Required Structure

```html
<!-- Header with Logo -->
<div style="padding-bottom: 32px;">
  <img src="https://avoqado.io/isotipo.svg" alt="Avoqado" width="32" height="32">
  <span style="font-size: 18px; font-weight: 700; color: #000;">Avoqado</span>
</div>

<!-- Title -->
<h1 style="font-size: 32px; font-weight: 400; color: #000;">Email Title</h1>

<!-- Content boxes -->
<div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px;">
  <!-- Content -->
</div>

<!-- CTA Button (black background) -->
<a href="#" style="background: #000; color: #fff; padding: 14px 32px; border-radius: 4px; font-weight: 600;">
  Button Text
</a>

<!-- Footer -->
<hr style="border-top: 1px solid #e0e0e0;">
<div>
  <img src="https://avoqado.io/isotipo.svg" width="24" height="24">
  <span>Avoqado</span>
  <p>Footer text</p>
  <a href="https://avoqado.io/privacy">Politica de Privacidad</a>
</div>
```

### Rules

1. **NO emojis** in subjects or content
2. **NO gradients** or colored backgrounds
3. **NO special characters** with accents (use `a` instead of `á`, etc.) for better email client compatibility
4. **Always include** the Avoqado logo in header and footer
5. **Always include** privacy policy link in footer
6. **Use inline styles only** - email clients don't support external CSS
7. **Warning boxes** use `background: #fef3c7` with `color: #92400e`

### Template File

All email templates are in: `src/services/email.service.ts`

### Testing

Test script to send all templates: `npx ts-node scripts/test-all-emails.ts`

---

## 9. Documentation Policy

### Central Documentation Hub

**This repo (`avoqado-server/docs/`) is the SINGLE SOURCE OF TRUTH for cross-repo documentation.**

**Master Index:** [`docs/README.md`](docs/README.md)

```
avoqado-server/docs/           ← CENTRAL HUB (this repo)
├── README.md                  ← Master index of ALL documentation
├── architecture/              ← Cross-repo architecture
├── features/                  ← Cross-repo features
├── blumon-tpv/               ← Blumon TPV integration
├── blumon-ecommerce/         ← Blumon E-commerce integration
└── ...

avoqado-web-dashboard/docs/    ← Frontend-specific ONLY
├── architecture/             ← React routing, overview
├── features/                 ← i18n, theme, inventory UI
└── guides/                   ← UI patterns, performance

avoqado-tpv/docs/              ← Android-specific ONLY
├── android/                  ← Kotlin/Compose patterns
└── devices/                  ← PAX hardware guides
```

### What goes where

| Type                                            | Location                      |
| ----------------------------------------------- | ----------------------------- |
| Cross-repo features (payments, inventory logic) | `docs/features/`              |
| Architecture, DB schema, API                    | `docs/`                       |
| React/UI patterns                               | `avoqado-web-dashboard/docs/` |
| Android/Kotlin patterns                         | `avoqado-tpv/docs/`           |

### What goes in CLAUDE.md (this file)

- Critical warnings (Blumon distinction)
- Documentation map (pointers to docs/)
- Development commands
- Quick architecture reference
- Critical patterns

### What goes in docs/\*.md

- Detailed implementation guides
- Complete architecture explanations
- Troubleshooting guides
- Testing references

### Golden Rules

1. Document **WHY**, not **HOW** (code explains HOW)
2. Tests are living documentation
3. If code + tests explain it clearly → don't document
4. ALL new docs go in `docs/` directory, never in root
5. **Cross-repo features** → Document in `docs/features/`

### Documentation Update Checklist

> **See "🔴 MANDATORY: Documentation Update Rule" at the top of this file.**

**Checklist before committing:**

- [ ] Does this change affect any existing documentation?
- [ ] Did I update line number references if file structure changed?
- [ ] Did I update progress percentages if completing phases?
- [ ] Did I add new documentation if this is a new feature?

**Avoid fragile line number references.** Instead of `"See file.ts lines 100-200"`, use:

- Function/class names: `"See createOrder() in order.service.ts"`
- Section headers: `"See ## Authentication section in AUTH.md"`
- Model names: `"See SettlementIncident model in schema.prisma"`

---

## 10. Pending TODOs

### Chatbot Token Pricing (Requested 2025-01-25)

Currently hardcoded in:

- `src/services/dashboard/token-budget.service.ts`
- `src/controllers/dashboard/token-budget.dashboard.controller.ts`

TODO: Create superadmin-configurable pricing system.

### TEMPORARY: Legacy Bill Generation Redirect (Added 2025-12-05)

**What:** Redirect in `src/app.ts` for `/v1/venues/:venueId/bill/generate`

**Why:** Physical QR codes are printed pointing to `api.avoqado.io/v1/venues/:venueId/bill/generate`. The old backend (avo-pwa) was migrated
to `api-deprecated.avoqado.io`, but QRs can't be changed.

**How it works:**

```
QR scan → api.avoqado.io/v1/venues/X/bill/generate
       → 301 redirect → api-deprecated.avoqado.io/v1/venues/X/bill/generate
       → Old backend serves the bill
```

**When to remove:** Once the bill generation functionality is migrated to this backend (avoqado-server), or when all physical QRs are
replaced.

**File:** `src/app.ts` (lines 50-53)

---

## Quick Links

| Need to...                | Go to...                                        |
| ------------------------- | ----------------------------------------------- |
| **Browse all docs**       | [`docs/README.md`](docs/README.md)              |
| Understand architecture   | `docs/ARCHITECTURE_OVERVIEW.md`                 |
| Add/modify VenueType      | `docs/BUSINESS_TYPES.md`                        |
| Work on Blumon TPV        | `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md`     |
| Work on Blumon E-commerce | `docs/blumon-ecommerce/REFACTORING_COMPLETE.md` |
| Work on inventory         | `docs/INVENTORY_REFERENCE.md`                   |
| Work on chatbot           | `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md`         |
| Work on Stripe            | `docs/STRIPE_INTEGRATION.md`                    |
| Work on permissions       | `docs/PERMISSIONS_SYSTEM.md`                    |
| Work on terminals         | `docs/TERMINAL_IDENTIFICATION.md`               |
| Work on settlement        | `docs/features/SETTLEMENT_INCIDENTS.md`         |
| Deploy to production      | `docs/PRODUCTION_READINESS_CHECKLIST.md`        |
