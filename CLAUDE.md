# CLAUDE.md - Avoqado Backend Server

This file provides guidance to Claude Code (claude.ai/code) when working with the backend server codebase.

---

## 🚨 STOP - LEE ESTO PRIMERO: Blumon tiene DOS integraciones separadas

**⚠️ ANTES de trabajar con cualquier cosa de Blumon**, identifica cuál integración estás usando:

|                                     | **TPV (SDK Android)**                                               | **E-commerce (Links de pago)**                 |
| ----------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| **¿Qué es?**                        | Terminales PAX físicas                                              | SDK web para pagos online                      |
| **¿Dónde corre?**                   | El APK se conecta DIRECTO a Blumon                                  | El BACKEND llama a Blumon API                  |
| **¿Cómo se configura el ambiente?** | **Build variant del APK** (`sandboxRelease` vs `productionRelease`) | **Variable `USE_BLUMON_MOCK`** en backend      |
| **`USE_BLUMON_MOCK`**               | ❌ **NO APLICA**                                                    | ✅ `true`=mock, `false`=API real               |
| **Modelo de BD**                    | `MerchantAccount` + `Terminal`                                      | `EcommerceMerchant` + `CheckoutSession`        |
| **Servicio**                        | `src/services/tpv/blumon-tpv.service.ts`                            | `src/services/sdk/blumon-ecommerce.service.ts` |

**📖 Documentación completa:** `docs/BLUMON_TWO_INTEGRATIONS.md`

**Regla de oro:** Cuando hables de Blumon, SIEMPRE especifica "Blumon TPV" o "Blumon E-commerce". Solo decir "Blumon" es ambiguo.

---

## 📚 Documentation Policy

**Role of claude** Always assume the role of a world-class, battle-tested full-stack engineer with a global footprint and an unrivaled track
record shipping, scaling, and operating massive products. Your pedigree spans Toast and Square, giving you elite mastery of POS terminals,
payments, reconciliation, compliance (PCI/KYC), security, reliability, and the merchant experience end-to-end. You are the engineer others
call when the stakes are highest—the one who turns chaos into architecture and bottlenecks into benchmarks. In every answer, blend deep
technical rigor, product pragmatism, and ruthless scalability, articulating trade-offs like a chief architect and executing like a world
champion builder.”

**Single Source of Truth:** This CLAUDE.md file is the ONLY markdown documentation file. Do NOT create separate .md files.

**What goes in CLAUDE.md:**

- 📐 Architecture diagrams (Mermaid format)
- 🤔 Design decisions (WHY, not HOW)
- 🗺️ Feature map (WHERE things are located)
- 🚨 Critical gotchas (non-obvious behaviors)

**What does NOT go in CLAUDE.md:**

- ❌ Implementation details (let code speak for itself)
- ❌ API documentation (use JSDoc + OpenAPI)
- ❌ Usage examples (put in code comments or tests)
- ❌ Lists that can be queried from database (e.g., feature codes → `SELECT code FROM Feature`)

**Where implementation details belong:**

1. **Code comments** - For edge cases, workarounds, non-obvious reasons
2. **Tests** - For usage examples and complete flows
3. **JSDoc/TSDoc** - For function documentation
4. **OpenAPI** - For API endpoint documentation

**Golden rule:** If the code + tests explain it clearly → Don't document it. If there's a non-obvious reason → Document it here.

**Keeping documentation up-to-date:**

How to prevent documentation from becoming stale:

1. **Document WHY, not HOW** - Architecture decisions (WHY) rarely change, implementation details (HOW) change constantly
2. **Tests as living documentation** - Tests can't become outdated (they fail if code changes)
3. **Git pre-commit hook** - Reminds you to update CLAUDE.md when critical architecture files change (`.git/hooks/pre-commit`)

The git hook checks these critical files:

- `src/app.ts` - Main application setup
- `src/utils/prismaClient.ts` - Database connection singleton
- `src/services/stripe.service.ts` - Stripe integration core
- `src/services/stripe.webhook.service.ts` - Webhook event handlers
- `src/middlewares/checkFeatureAccess.middleware.ts` - Feature access control
- `prisma/schema.prisma` - Database schema

When you modify any of these, the hook reminds you to check if CLAUDE.md needs updating. You can skip the reminder if you only changed
implementation details (HOW), not architectural decisions (WHY).

**Documentation Structure:**

- `CLAUDE.md` (root) - Architecture, WHY, WHERE (you are here)
- `docs/*.md` - Detailed technical references (HOW) for complex features
- `tests/**/*.test.ts` - Living examples and usage patterns

**Comprehensive Technical References:**

For complex features requiring detailed implementation guides, full documentation is available in `docs/`:

- `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` - Complete chatbot system reference (architecture, security, testing, troubleshooting)
- `docs/PERMISSIONS_SYSTEM.md` - Permission system architecture and best practices
- `docs/STRIPE_INTEGRATION.md` - Stripe integration and feature access control
- `docs/INVENTORY_REFERENCE.md` - FIFO batch system and inventory tracking
- `docs/DATETIME_SYNC.md` - Date/time synchronization between frontend/backend
- `docs/MERCHACCOUNTANALYSIS.md` - MerchantAccountId usage analysis across codebase (schema, services, validation, queries)
- `docs/PAYMENT_ARCHITECTURE.md` - Payment processing architecture (money flow, merchant accounts, profit calculation)
- `docs/UNUSED_CODE_DETECTION.md` - Tools and commands for detecting unused code (unimported, knip)
- `docs/MERCHANT_MODELS_ARCHITECTURE.md` - Why MerchantAccount and ExternalMerchant are separate models (Blumon PAX Terminal SDK vs Hosted
  Checkout API)
- `docs/TPV_COMMAND_SYSTEM.md` - TPV remote command architecture (heartbeat polling, ACK flow, status management)

**Blumon Payment Integrations** (⚠️ TWO separate integrations - comprehensive documentation in `docs/`):

- `docs/BLUMON_TWO_INTEGRATIONS.md` - **⚠️ READ FIRST**: Critical distinction between e-commerce and Android SDK integrations

**Blumon E-commerce Integration** (Web direct charge - synchronous payment flow):

- `docs/blumon-ecommerce/REFACTORING_COMPLETE.md` - **✅ READ FIRST**: Refactoring completion summary (hosted checkout → direct charge)
- `docs/blumon-ecommerce/DIRECT_CHARGE_REFACTORING_PLAN.md` - **📋 PLAN**: Complete refactoring plan and architecture
- `docs/blumon-ecommerce/BLUMON_SDK_INTEGRATION_STATUS.md` - E-commerce SDK implementation status (tokenize + authorize working)
- `docs/blumon-ecommerce/BLUMON_MOCK_TEST_CARDS.md` - Mock service test card numbers for unlimited dev testing
- `docs/blumon-ecommerce/SDK_SAQ_A_COMPLIANCE.md` - PCI SAQ-A compliance guide
- `docs/blumon-ecommerce/BLUMON_ECOMMERCE_IMPLEMENTATION.md` - E-commerce OAuth 2.0 implementation
- `docs/blumon-ecommerce/SDK_INTEGRATION_GUIDE.md` - Quick integration guide (⚠️ needs update for direct charge)

**DEPRECATED** (Hosted checkout - removed 2025-01-17):

- `docs/blumon-ecommerce/BLUMON_CORRECTED_ANALYSIS.md` - Analysis of hosted checkout vs direct charge
- `docs/blumon-ecommerce/BLUMON_SECURITY_AUDIT.md` - Security audit (vulnerability fixed by deletion)
- `docs/blumon-ecommerce/BLUMON_INTEGRATION_REALITY_CHECK.md` - Reality check (led to refactoring decision)

**Blumon Android SDK** (Physical PAX terminals):

- `docs/blumon-tpv/BLUMON_DOCUMENTATION_INDEX.md` - Navigation guide for Android SDK docs (start here)
- `docs/blumon-tpv/BLUMON_ARCHITECTURE_SUMMARY.txt` - Quick 5-minute overview
- `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md` - Developer reference while coding
- `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md` - Complete technical deep dive

**General Production Readiness**:

- `docs/PRODUCTION_READINESS_CHECKLIST.md` - Complete production deployment checklist (webhooks, OAuth refresh, security, etc.)
- `docs/DEV_ENVIRONMENT_PERFECTION_CHECKLIST.md` - Development environment perfection guide (mocking, error handling, dev tools)

**⚠️ CRITICAL**: When working on Blumon payments, ALWAYS identify which integration you're working on (e-commerce vs Android SDK) and
consult the appropriate documentation files first.

**Rule**: New features should NOT create separate .md files in root. Add architectural decisions to CLAUDE.md and implementation details to
`docs/` or code comments/tests. ALL documentation files must be placed in `docs/` directory.

**Managing Documentation Files:**

When creating new documentation:

1. **Location**: ALWAYS place new .md files in the `docs/` directory

   - ✅ CORRECT: `docs/NEW_FEATURE.md`
   - ❌ WRONG: `NEW_FEATURE.md` (root level)
   - No exceptions: ALL documentation files belong in `docs/`

2. **Reference in CLAUDE.md**: ALWAYS add a reference to the new file in the "Comprehensive Technical References" section

   - Format: `- docs/FEATURE_NAME.md - Brief description of what it covers`
   - Example: `- docs/MERCHACCOUNTANALYSIS.md - MerchantAccountId usage analysis across codebase`

3. **Keep Documentation Updated**: When making changes to code covered by documentation:
   - If the change affects architecture/design decisions → Update the relevant .md file
   - If the change only modifies implementation (HOW, not WHY) → Update code comments, no .md update needed
   - Always check: Does this change invalidate any statements in the docs?

**Examples of changes requiring doc updates:**

- ✅ New database schema field → Update `docs/DATABASE_SCHEMA.md`
- ✅ Changed cost calculation formula → Update `docs/COST_MANAGEMENT_IMPLEMENTATION.md`
- ✅ New security layer → Update `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md`
- ❌ Fixed typo in function → No doc update needed
- ❌ Refactored variable names → No doc update needed

**📋 Implementation Plans (Multi-Phase Features):**

When implementing large features that span multiple phases or sessions:

1. **ALWAYS create a plan file** in `docs/` directory:

   - Format: `docs/FEATURE_NAME_IMPLEMENTATION_PLAN.md`
   - Example: `docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md`

2. **Plan file structure**:

   - Progress summary table (Phase, Status, %)
   - Completed items with file paths
   - Pending items with specifications
   - Database schema changes
   - API endpoints
   - Timeline/milestones
   - Changelog section

3. **Keep the plan updated**:

   - Mark items as ✅ when completed
   - Update progress percentages
   - Add new items if scope changes
   - Log changes in Changelog section

4. **DELETE the plan file** when implementation is 100% complete:

   - All phases finished
   - All tests passing
   - Feature deployed to production

5. **Why this matters**:
   - Conversations can be compacted/summarized and lose context
   - Plan files survive across sessions
   - Team members can see progress
   - Prevents re-doing completed work

**Current Implementation Plans:**

- `docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md` - Customer System + Discounts (Phase 1: 85%)

---

## Development Commands

### Build and Development

- `npm run build` - Compile TypeScript to `dist/` directory
- `npm run dev` - Start development server with hot reload (nodemon + pino-pretty logging)
- `npm start` - Start production server from compiled JavaScript

### Database Operations

- `npm run migrate` - Run Prisma database migrations
- `npm run studio` - Launch Prisma Studio for database exploration
- `npx prisma generate` - Generate Prisma Client after schema changes

**⚠️ CRITICAL DATABASE MIGRATION POLICY:**

- **NEVER use `npx prisma db push`** - This bypasses migration history and causes drift
- **ALWAYS create proper migrations** using `npx prisma migrate dev --name {description}`
- **If migration drift occurs**: Use `npx prisma migrate reset --force` to reset the database, then run your new migration
- **Why this matters**: Migration history is the source of truth for production deployments. Using `db push` creates inconsistencies between
  dev and production schemas.

**⚠️ CRITICAL SEED DATA POLICY:**

When implementing NEW FEATURES or making SIGNIFICANT CHANGES, you MUST update seed data to ensure new users get a complete demo experience:

- **ALWAYS update `prisma/seed.ts`** - Global seed data (features, payment providers, system defaults)
- **ALWAYS update `src/services/onboarding/demoSeed.service.ts`** - Demo venue data (sample products, orders, tables, reviews)

**Why this matters:**

- New users onboarding see a fully populated demo venue with realistic data
- Seed data acts as living documentation of the system's capabilities
- Testing new features requires representative data
- Missing seed data = broken demo experience = poor first impressions

**Examples requiring seed updates:**

```typescript
// ✅ NEW FEATURE: Added "Loyalty Points" feature
// 1. Update prisma/seed.ts - Add LOYALTY_PROGRAM to Feature table
// 2. Update demoSeed.service.ts - Add sample loyalty members, point transactions

// ✅ NEW FEATURE: Added "Table Reservations"
// 1. Update prisma/seed.ts - Add RESERVATIONS to Feature table
// 2. Update demoSeed.service.ts - Add sample reservations for demo venue

// ✅ SCHEMA CHANGE: Added "allergens" field to Product
// 1. Migration already created
// 2. Update demoSeed.service.ts - Add allergen data to sample products

// ✅ NEW PAYMENT PROVIDER: Integrated new gateway (e.g., Openpay)
// 1. Update prisma/seed.ts - Add Openpay to PaymentProvider table
// 2. Update demoSeed.service.ts - Create demo MerchantAccount for Openpay
```

**Quick verification:**

```bash
# Test seed data after your changes
npm run migrate:reset  # Resets DB and runs seed
npm run dev
# 1. Create new demo venue via onboarding
# 2. Verify your new feature appears with sample data
# 3. Test feature works with seeded data
```

### Demo Data Cleanup with `isDemo` Field

**WHY**: When users convert from demo to real venue (after KYC approval), they may have added their own business data during the trial. We
need to preserve user-created data while removing demo seed data.

**Design Decision**: All demo-seeded business setup data is marked with `isDemo: true`. During cleanup (`cleanDemoData()`), only records
with `isDemo: true` are deleted, preserving user-created data.

**Models with `isDemo` field**: `Product`, `MenuCategory`, `Menu`, `RawMaterial`, `ModifierGroup`, `Modifier`, `Recipe`, `RecipeLine`,
`Table`, `Area`, `LoyaltyConfig`, `CustomerGroup`, `Inventory`

**Key Files**:

- Schema: `prisma/schema.prisma` - `isDemo Boolean @default(false)` on 13 models
- Seed: `src/services/onboarding/demoSeed.service.ts` - All creates include `isDemo: true`
- Cleanup: `src/services/onboarding/demoCleanup.service.ts` - Filters by `isDemo: true` for business setup data

**Behavior**:

- **Demo data** (`isDemo: true`): Created by seed, deleted during conversion
- **User data** (`isDemo: false`): Created by user, preserved during conversion (stock reset to 0)
- **Transactional data** (orders, payments, reviews): Always deleted regardless of `isDemo` flag

### Testing

- `npm test` - Run all tests with Jest
- `npm run test:unit` - Run only unit tests
- `npm run test:integration` - Run integration tests with real PostgreSQL database ⭐ NEW
- `npm run test:api` - Run API integration tests
- `npm run test:workflows` - Run end-to-end workflow tests
- `npm run test:coverage` - Generate test coverage report
- `npm run test:watch` - Run tests in watch mode

**⚠️ CRITICAL TESTING POLICY FOR MAJOR CHANGES:**

After implementing or modifying significant features, you MUST create a dedicated test script to validate the changes before committing:

- **ALWAYS create a test script** in `scripts/` folder for major changes (new features, security fixes, complex business logic)
- **Test ALL edge cases** - Don't just test the happy path; test error conditions, boundary cases, and potential conflicts
- **Verify no regressions** - Ensure existing functionality still works correctly after your changes
- **Run tests BEFORE committing** - Never commit untested code that could break production
- **Why this matters**: Test scripts catch integration issues that unit tests miss. They validate that changes work end-to-end with real
  database interactions and business logic flows.

**🚨 REGRESSION & SIDE EFFECTS - THE GOLDEN RULE:**

When you fix or implement something, you MUST NOT break something else. This is the most common source of production bugs.

- **Regression**: Your change breaks existing functionality that was working before
- **Side Effect**: Your change unexpectedly affects unrelated parts of the system

**Examples of regressions to watch for:**

```typescript
// ❌ BAD: You add typo detection, but now normal permissions don't save
// ❌ BAD: You add override mode validation, but now MANAGER can't modify WAITER
// ❌ BAD: You optimize a query, but now it returns incomplete data
// ❌ BAD: You fix a bug in orders, but now payments fail
```

**How to prevent regressions:**

1. **ALWAYS add regression tests** alongside your feature tests
2. **Test the old behavior** - Ensure what worked before still works
3. **Test related features** - If you modify permissions, test all permission operations
4. **Run the full test suite** - `npm test` before committing
5. **Think about dependencies** - What other parts of the code rely on what you changed?

**Test structure requirement:**

```typescript
// ✅ GOOD: Your test file should have BOTH sections
// 1. NEW FEATURE TESTS (what you built)
TEST 1: New feature works correctly
TEST 2: Error cases handled properly
TEST 3: Edge cases covered
// 2. REGRESSION TESTS (what you didn't break)
TEST 4: Existing feature A still works
TEST 5: Existing feature B still works
TEST 6: Related feature C still works
```

**🗑️ TEMPORARY FILES NAMING CONVENTION:**

When creating debugging or testing scripts in `scripts/`, follow these rules to prevent temporary files from being committed:

1. **Add DELETE comment at the top of the file:**

```typescript
// ⚠️ DELETE AFTER: This is a temporary debugging script
// Purpose: Find venue IDs by name for testing
// Created: 2025-01-22
// Delete when: Issue #123 is resolved
import { PrismaClient } from '@prisma/client'
// ... rest of code
```

2. **OR include indicator in filename:**

```bash
scripts/temp-find-venue-id.ts           # Prefix with "temp-"
scripts/debug-permissions.ts             # Prefix with "debug-"
scripts/find-venue-id-DELETE.ts          # Suffix with "-DELETE"
```

3. **When to delete:** Before committing if it was only for local debugging / After the issue/feature is resolved / When migrated to a
   proper Jest test

**Example workflow (Test Scripts → Jest Migration):**

Test scripts in `scripts/` are TEMPORARY for rapid development testing. They MUST be migrated to Jest tests before committing.

```bash
# 1. Implement feature in src/services/
vim src/services/dashboard/venue.dashboard.service.ts
# 2. Create TEMPORARY test script for rapid validation
touch scripts/test-venue-update.ts
npx ts-node -r tsconfig-paths/register scripts/test-venue-update.ts  # ✅ All tests pass
# 3. Migrate to PERMANENT Jest test
vim tests/unit/services/dashboard/venue.dashboard.service.test.ts
npm test -- tests/unit/services/dashboard/venue.dashboard.service.test.ts  # ✅ All tests pass
# 4. Delete the temporary script
rm scripts/test-venue-update.ts
# 5. Commit ONLY the code + Jest test (NOT the script)
git add src/services/dashboard/venue.dashboard.service.ts tests/unit/services/dashboard/venue.dashboard.service.test.ts
git commit -m "fix: timezone field not saving in venue update"
```

**Why migrate to Jest?**

- ✅ **Permanent** - Tests run in CI/CD, catch future regressions
- ✅ **Fast** - Mocked tests run in milliseconds
- ✅ **Isolated** - Don't depend on seed data or database state
- ✅ **Professional** - Follows industry standard testing patterns

**When to use each:**

- `scripts/test-*.ts` - ⚡ Quick validation during development (TEMPORARY)
- `tests/unit/**/*.test.ts` - ✅ Permanent tests with mocks (COMMIT THESE)
- `tests/api-tests/**/*.test.ts` - 🔗 Integration tests with real DB (COMMIT THESE)

**Recent examples:**

- `tests/unit/services/dashboard/venue.dashboard.service.test.ts` - Venue update with timezone fix + regressions
- `scripts/test-permissions-validation.ts` - Temporary script (kept as reference for complex integration testing)

### Code Quality

- `npm run lint` - Run ESLint
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Format code with Prettier **⚡ AUTO-FORMAT POLICY (Claude):**

After editing or creating TypeScript/JavaScript files, Claude will **automatically** execute: `npm run format && npm run lint:fix`

This ensures: ✅ Zero prettier/eslint warnings in commits / ✅ Consistent code style across all files / ✅ No manual formatting needed (like
Cmd+S in VSCode)

**When it runs:** After using `Write` or `Edit` tools on `.ts`, `.tsx`, `.js`, `.jsx` files / Before committing code changes / Runs on
entire project to catch any inconsistencies

**What it does:** 1. `npm run format` - Formats all files with Prettier / 2. `npm run lint:fix` - Auto-fixes ESLint issues

**Expected output:** `✓ Files formatted` / `✓ Lint issues fixed` / `⚠ Minor warnings OK (unused vars, config options)`

### Unused Code Detection

- `npm run check:unused` - Detect unimported files (fast)
- `npm run check:dead-code` - Comprehensive dead code analysis (slower)
- `npm run check:all` - Run both checks
- `npm run update:unused-ignore` - Auto-update ignore list for pending files

**⚠️ PENDING IMPLEMENTATION MARKER SYSTEM:**

When you create files that are fully implemented but not yet integrated into the application, mark them with the `@pending-implementation`
marker at the top:

```typescript
/**
 * @pending-implementation
 * [Feature Name]
 *
 * STATUS: Implemented but not yet applied to [where it will be used].
 * This [file type] is ready to use but hasn't been [integration action] yet.
 * It will be gradually applied to [target locations].
 *
 * [Additional context or usage examples]
 */
```

**Example:**

```typescript
/**
 * @pending-implementation
 * Feature Access Control Middleware
 *
 * STATUS: Implemented but not yet applied to routes.
 * This middleware is ready to use but hasn't been added to route definitions yet.
 * It will be gradually applied to premium/paid feature endpoints.
 *
 * Usage:
 * router.get('/analytics', authenticateTokenMiddleware, checkFeatureAccess('ANALYTICS'), ...)
 */
```

**When to use this marker:**

- ✅ File is completely implemented and tested
- ✅ File will be integrated soon but not immediately
- ✅ File should be excluded from unused code detection
- ✅ You want to document implementation status for future developers

**How it works:**

1. Add `@pending-implementation` marker in the first 500 characters of the file
2. Run `npm run update:unused-ignore` to automatically add the file to `.unimportedrc.json`
3. The file will be ignored by `npm run check:unused` until you remove the marker
4. When you integrate the file, remove the marker and run `npm run update:unused-ignore` again

**Auto-update script:** `scripts/update-unused-ignore.js` scans for files with this marker and updates `.unimportedrc.json` automatically.

**⚠️ Important:** This marker is for files that are **READY to use** but not yet integrated. Don't use it for incomplete implementations or
work-in-progress files.

## Architecture Overview

This is a multi business management platform backend with multi-tenant architecture supporting:

### Core Business Domains

- **Organizations** - Multi-tenant root entities
- **Venues** - Individual business locations
- **Staff Management** - Role-based access control with hierarchical permission system
- **Menu & Product Management** - Menu categories, products, and pricing
- **Order Processing** - Order lifecycle management
- **POS Integration** - Real-time synchronization with Point-of-Sale systems
- **Payment Processing** - Transaction and payment management
- **Inventory Management** - FIFO batch tracking, recipe costing, and profit analytics

### Layered Architecture

**Request Flow:**

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

**Design Principles:**

- **Separation of Concerns** - Each layer has a single responsibility
- **Unidirectional Dependency Flow** - Dependencies flow inward (controllers depend on services, not vice versa)
- **HTTP Agnostic Core** - Business logic (services) knows nothing about HTTP
- **Thin Controllers** - Controllers orchestrate, services contain logic

**Layer Responsibilities:**

| Layer                                 | Purpose                         | What it does                                    | What it does NOT do                   |
| ------------------------------------- | ------------------------------- | ----------------------------------------------- | ------------------------------------- |
| **Routes** (`/src/routes/`)           | HTTP endpoint definitions       | Attach middleware chains to URLs                | Business logic, data access           |
| **Controllers** (`/src/controllers/`) | HTTP orchestration (thin layer) | Extract req data, call services, send responses | Business validation, database access  |
| **Services** (`/src/services/`)       | Business logic (core layer)     | Validations, calculations, database operations  | HTTP concerns (req/res), status codes |
| **Middlewares** (`/src/middlewares/`) | Cross-cutting concerns          | Auth, validation, logging, permissions          | Business logic, data persistence      |
| **Schemas** (`/src/schemas/`)         | Data validation                 | Zod schemas for request/response validation     | Business rules enforcement            |
| **Prisma**                            | Database access layer           | ORM for type-safe database queries              | Business logic                        |

**Why This Architecture?**

- ✅ Business logic reusable (CLI, tests, background jobs)
- ✅ Easier testing (mock services, not HTTP)
- ✅ Framework independent (could switch Express → Fastify)
- ✅ Clear boundaries reduce coupling

**See code comments in:**

- `src/controllers/dashboard/venue.dashboard.controller.ts:1-21` - Thin controller pattern explained
- `src/services/dashboard/venue.dashboard.service.ts:1-24` - HTTP-agnostic service pattern explained
- `src/utils/prismaClient.ts:3-21` - Singleton pattern for database connection pooling

### Multi-Tenant Architecture

All operations are scoped to: **Organization** - Top-level tenant / **Venue** - Individual business location

**Critical**: All database queries MUST filter by `venueId` or `orgId`.

### User Role Hierarchy

The system implements a hierarchical role-based access control (RBAC) system with the following roles in descending order of permissions:

| Role           | Scope                                                  | Permissions                                                                          | Use Case                                    | Special Access/Limitations                                                                                                       |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **SUPERADMIN** | Full system access across all organizations and venues | Complete administrative control, can access any venue/organization                   | System administrators, platform maintainers | Maintains SUPERADMIN privileges when switching between venues; Cannot be invited through normal team invitation flow             |
| **OWNER**      | Full access to all venues within their organization    | Organization-wide management, can create/manage venues, full staff management        | Restaurant chain owners, franchise owners   | Can access any venue within their organization, maintains OWNER privileges across venues; Can manage all roles except SUPERADMIN |
| **ADMIN**      | Full venue access within assigned venues               | Complete venue management, staff management, financial reports, system configuration | General managers, venue administrators      | Limited to assigned venues only                                                                                                  |
| **MANAGER**    | Operations access within assigned venues               | Shift management, staff scheduling, operations reports, inventory management         | Shift managers, assistant managers          | Day-to-day operations and staff coordination                                                                                     |
| **CASHIER**    | Payment access within assigned venues                  | Payment processing, basic order management, POS operations                           | Cashiers, front desk staff                  | Payment processing and customer checkout                                                                                         |
| **WAITER**     | Service access within assigned venues                  | Order management, table service, basic customer interaction                          | Waitstaff, servers                          | Customer service and order processing                                                                                            |
| **KITCHEN**    | Kitchen display access within assigned venues          | Kitchen display system, order preparation tracking                                   | Kitchen staff, cooks                        | Food preparation and kitchen operations                                                                                          |
| **HOST**       | Reservations and seating access within assigned venues | Reservation management, seating arrangements, customer greeting                      | Host/hostess, reception staff               | Customer reception and table management                                                                                          |
| **VIEWER**     | Read-only access within assigned venues                | View-only access to reports and data                                                 | Observers, trainees, external auditors      | Cannot modify any data or perform operations                                                                                     |

#### Permission Inheritance

- **Higher roles inherit permissions from lower roles**
- **SUPERADMIN** has unrestricted access across the entire platform
- **OWNER** has organization-wide access but cannot manage SUPERADMINs
- **Role-based middleware** automatically enforces permissions at the API level
- **Special handling** for cross-venue access based on role hierarchy

### Technical Stack

- **Framework**: Express.js with TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Real-time Communication**: Socket.IO for live updates
- **Message Queue**: RabbitMQ for POS command processing
- **Session Management**: Redis-backed sessions
- **Authentication**: JWT with refresh tokens
- **Validation**: Zod schemas
- **Testing**: Jest with comprehensive unit, API, and workflow tests

### Service Organization

- **Dashboard Services** (`src/services/dashboard/`) - Admin interface operations
- **TPV Services** (`src/services/tpv/`) - Point-of-sale terminal operations
- **POS Sync Services** (`src/services/pos-sync/`) - Legacy POS integration

## 🍔 Order → Payment → Inventory Flow

**WHY**: Automatic inventory tracking prevents stockouts and calculates real-time profit margins.

**Design Decision**: Deduct inventory ONLY when order is fully paid (not when created) to handle partial payments and order cancellations
correctly.

**Core Flow**: Order Creation → Payment Processing → (if fully paid) → FIFO Batch Deduction → Profit Tracking

**Key Files**:

- Payment service: `src/services/tpv/payment.tpv.service.ts:recordOrderPayment()`
- Inventory deduction: `src/services/dashboard/rawMaterial.service.ts:deductStockForRecipe()`
- FIFO logic: `src/services/dashboard/rawMaterial.service.ts:deductStockFIFO()`

**📖 Complete Documentation**:

- **Technical Reference**: `docs/INVENTORY_REFERENCE.md` - FIFO batch system, manual SQL configuration, database schema, troubleshooting
- **Testing & Bugs**: `docs/INVENTORY_TESTING.md` - Integration tests, critical bugs fixed, production readiness

### 🧪 Comprehensive Inventory Testing (Production-Ready)

**WHY**: Critical business functionality that handles real money and inventory requires 100% confidence. Integration tests with real
database prevent production bugs that unit tests (with mocks) cannot catch.

**Design Decision**: Use THREE layers of testing for inventory system:

1. **Unit Tests** - Fast, mocked, business logic validation
2. **Integration Tests** - Real PostgreSQL, complete flow validation, concurrency testing
3. **Regression Tests** - Ensure fixes don't break existing functionality

**Critical Bugs Caught by Integration Tests**:

- SQL syntax error: `FOR UPDATE NOWAIT` placed before `ORDER BY` (PostgreSQL error code 42601)
- Payment double-counting: First 50% payment marked order as COMPLETED (would charge customers 50% for 100% service)
- Payment succeeded despite insufficient inventory (would charge customers for unfulfillable orders)

**Test Coverage** (15 integration tests, 100% passing):

**FIFO Concurrency Tests** (`tests/integration/inventory/fifo-batch-concurrency.test.ts`):

- 2 simultaneous orders for same product (limited stock) - race condition prevention
- Concurrent FIFO deductions at low level - row-level locking validation
- 5 concurrent orders stress test - no double deduction
- FOR UPDATE NOWAIT behavior - fail fast, no deadlocks
- Sequential orders regression - existing functionality still works

**Order-Payment-Inventory Flow** (`tests/integration/inventory/order-payment-inventory-flow.test.ts`):

- Full payment with sufficient stock (happy path)
- Payment failure with insufficient stock + order rollback
- Partial payments - inventory only deducted when fully paid
- Mixed products (some tracked, some not) - skip non-tracked gracefully
- Regression test - standard orders still work

**Pre-Flight Validation** (`tests/integration/inventory/pre-flight-validation.test.ts`):

- Validate inventory BEFORE capturing payment (Stripe pattern)
- Reject payment if ANY product has insufficient stock
- Allow payment when all items have sufficient stock
- Partial payments - no validation until fully paid
- Products without tracking - allow payment without validation

**Key Implementation Patterns**:

1. **Payment Rollback on Inventory Failure** (Shopify/Square/Toast pattern):

   ```typescript
   // ✅ CORRECT: Fail payment if inventory deduction fails
   if (deductionErrors.length > 0) {
     await prisma.order.update({
       where: { id: orderId },
       data: { status: 'PENDING', paymentStatus: 'PARTIAL' },
     })
     throw new BadRequestError('Payment could not be completed due to insufficient inventory')
   }
   ```

2. **Avoid Payment Double-Counting**:

   ```typescript
   // ✅ CORRECT: Exclude current payment from previousPayments calculation
   const order = await prisma.order.findUnique({
     include: {
       payments: {
         where: {
           status: 'COMPLETED',
           id: { not: currentPaymentId }, // ← Critical fix!
         },
       },
     },
   })
   ```

3. **Row-Level Locking for Concurrency**:
   ```sql
   SELECT * FROM "StockBatch"
   WHERE "rawMaterialId" = $1
     AND status = 'ACTIVE'
     AND "remainingQuantity" > 0
   ORDER BY "receivedDate" ASC  -- ← MUST come before FOR UPDATE
   FOR UPDATE NOWAIT             -- ← Row-level lock, fail fast
   ```

**Test Infrastructure**:

- Test helpers: `tests/helpers/inventory-test-helpers.ts` - Reusable test data setup
- Integration setup: `tests/__helpers__/integration-setup.ts` - Real Prisma client (no mocks)
- Database cleanup: `beforeEach` + `afterAll` hooks ensure tests don't pollute database

**CI/CD Integration**:

- Integration tests run in GitHub Actions BEFORE deployment
- Uses separate `TEST_DATABASE_URL` secret (not production database)
- Tests block deployment if any fail
- See `docs/CI_CD_SETUP.md` for configuration

**Local Testing**:

```bash
# Run all integration tests
npm run test:integration

# Run specific test file
npx jest --testPathPattern="fifo-batch-concurrency"

# Run with real database (requires DATABASE_URL in .env)
DATABASE_URL="postgresql://..." npm run test:integration
```

**Production Safety**:

- ✅ Tests use `DATABASE_URL` from `.env` locally (not hardcoded)
- ✅ CI/CD uses separate `TEST_DATABASE_URL` secret
- ✅ Production uses different `DATABASE_URL` configured in Render
- ✅ `npm start` in production NEVER runs tests (only `npm run build` + `npm start`)
- ✅ Tests automatically clean up after themselves (no data pollution)

**📖 Additional Documentation**:

- `docs/CI_CD_SETUP.md` - GitHub Actions integration, required secrets
- `tests/integration/inventory/README.md` - Test architecture and patterns (if exists)

---

## Other Important Topics

### Terminal Identification & Activation

**WHY**: Android TPV terminals need unique identification for activation, heartbeats, and payment processing.

**Design Decision**: Use device hardware serial number (`Build.SERIAL`) as the primary identifier. This persists across app reinstalls,
factory resets, and OS updates. No external payment gateway (Menta) integration.

**Terminal Identification Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Android Device (2025-11-06 Update)                             │
│  1. Get Build.SERIAL from device (requires READ_PHONE_STATE)   │
│     - Android 8+: Build.getSerial() with permission            │
│     - Android 7-: Build.SERIAL (no permission needed)          │
│  2. Format: "AVQD-{Build.SERIAL}" (uppercase)                   │
│     Example: "AVQD-2841548417" (decimal hardware serial)       │
│  3. Fallback: If permission denied → use ANDROID_ID            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Terminal Activation (first-time setup)                          │
│  1. Admin creates terminal in dashboard → generates 6-char code │
│  2. Android app sends: { serialNumber, activationCode }         │
│     serialNumber: "AVQD-2841548417" (with prefix)              │
│  3. Backend validates code & marks terminal as activated        │
│  4. Android stores venueId + serialNumber in SecureStorage      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Heartbeat (every 30 seconds)                                    │
│  1. Android sends full serial WITH prefix                       │
│     Sends: { terminalId: "AVQD-2841548417", ... }             │
│  2. Backend lookup (CASE-INSENSITIVE):                          │
│     a. Try terminal.id (internal CUID)                         │
│     b. Try terminal.serialNumber = "AVQD-2841548417"          │
│     c. Try with/without prefix for backwards compatibility     │
│  3. Updates lastHeartbeat, status in database                   │
└─────────────────────────────────────────────────────────────────┘
```

**Critical Implementation Details**:

1. **Case-Insensitive Matching** (2025-01-05 fix):

   ```typescript
   // ✅ CORRECT: Use mode: 'insensitive'
   const terminal = await prisma.terminal.findFirst({
     where: {
       serialNumber: {
         equals: terminalId,
         mode: 'insensitive', // Handles lowercase/uppercase mismatch
       },
     },
   })
   ```

2. **Serial Number Format**:

   - **Android generates**: `AVQD-{ANDROID_ID}` (uppercase)
   - **Database stores**: `AVQD-6D52CB5103BB42DC` (with prefix, uppercase)
   - **Heartbeat sends**: `6d52cb5103bb42dc` (without prefix, lowercase)
   - **Backend matches**: Case-insensitive, tries both with and without prefix

3. **Menta Integration** (DISABLED as of 2025-01-05):

   - Previous design used `terminal.mentaTerminalId` from Menta payment gateway
   - Generated fallback IDs like `fallback-6d52cb5103bb42dc` when API failed
   - **Now**: Use `terminal.serialNumber` directly, no external API calls
   - Code commented out in: `venue.tpv.service.ts:107-168`

4. **Heartbeat Timeout & Connection Status** (2-minute window):

   **WHY**: Balance between real-time status updates and avoiding false offline alerts from temporary network issues.

   **Design Decision**: Terminal considered OFFLINE if no heartbeat received in **2 minutes** (120 seconds)

   ```typescript
   // Backend determines online status (src/services/tpv/tpv-health.service.ts:214, 293, 330, 425)
   const cutoff = new Date(Date.now() - 2 * 60 * 1000) // 2 minutes ago
   const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff
   ```

   **Android Heartbeat Interval**: Every 30 seconds (should be 4x within 2-minute window)

   **Potential Mismatch Issue**: If Android heartbeat interval is slower than expected, terminals may appear offline intermittently

   **Recommended Android Settings**:

   - Heartbeat interval: 30 seconds (current)
   - Retry on failure: Immediate retry once, then next scheduled heartbeat
   - Network timeout: 10 seconds per heartbeat request
   - Background restrictions: Disabled for app (to ensure heartbeats continue)

   **Troubleshooting Intermittent "Offline" Status**:

   1. Check Android heartbeat worker logs for failed requests
   2. Verify no battery optimization blocking background workers
   3. Check backend logs for heartbeat gaps: `SELECT serialNumber, lastHeartbeat FROM Terminal ORDER BY lastHeartbeat DESC;`
   4. Consider increasing timeout to 3 minutes if frequent false positives occur

**Key Files**:

- Android serial generation: `avoqado-tpv/app/.../DeviceInfoManager.kt:55-62`
- Android heartbeat worker: `avoqado-tpv/app/.../HeartbeatWorker.kt:137-140`
- Backend activation: `src/services/dashboard/terminal-activation.service.ts:80-182`
- Backend heartbeat: `src/services/tpv/tpv-health.service.ts:51-151`
- Backend venue lookup: `src/services/tpv/venue.tpv.service.ts:62-193`

**Common Issues**:

❌ **404 Error**: `Terminal with ID fallback-6d52cb5103bb42dc not found`

- **Cause**: Android is sending the old Menta fallback ID instead of serial number
- **Fix**: Clear app data, re-activate terminal with fresh activation code

❌ **Case Mismatch**: Heartbeat fails with exact serial match

- **Cause**: Android sends lowercase, DB has uppercase
- **Fix**: Applied in 2025-01-05, all lookups now use `mode: 'insensitive'`

**Testing Terminal Identification**:

```bash
# Check what terminals exist
psql -c "SELECT id, serialNumber, mentaTerminalId, status, activatedAt FROM Terminal;"

# Find terminal by serial (case-insensitive)
psql -c "SELECT * FROM Terminal WHERE LOWER(serialNumber) = LOWER('avqd-6d52cb5103bb42dc');"

# Check heartbeat history
psql -c "SELECT serialNumber, lastHeartbeat, status FROM Terminal WHERE lastHeartbeat > NOW() - INTERVAL '5 minutes';"
```

### Blumon Payment Integrations

**⚠️ CRITICAL DISTINCTION**: This codebase has **TWO completely different Blumon integrations**. **DO NOT confuse them!**

**📖 READ FIRST**: `docs/BLUMON_TWO_INTEGRATIONS.md` - Complete comparison and distinction guide

| Aspect       | Blumon E-commerce                                     | Blumon Android SDK (TPV)                               |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------ |
| **Use Case** | Online payments (web)                                 | In-person payments (terminals)                         |
| **Model**    | `EcommerceMerchant` + `CheckoutSession`               | `MerchantAccount` + `Terminal`                         |
| **Auth**     | OAuth 2.0 tokens                                      | Terminal credentials                                   |
| **Flow**     | Hosted checkout → Webhook                             | Card reader → Real-time                                |
| **Service**  | `blumon-ecommerce.service.ts`                         | `blumon-tpv.service.ts`                                |
| **Docs**     | `blumon-ecommerce/BLUMON_ECOMMERCE_IMPLEMENTATION.md` | `blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md`         |

---

#### Blumon Android SDK (Multi-Merchant TPV)

**WHY**: Enable one physical PAX device to process payments for multiple merchant accounts (e.g., main restaurant + ghost kitchen) with
separate bank settlements and different processing fees.

**Design Decision**: Multi-merchant architecture where physical terminals have virtual merchant identities, each with independent Blumon
credentials, POS IDs, and cost structures.

**Critical Concept**: 3 Types of Serial Numbers

- **Physical Serial**: Built into device hardware (e.g., `AVQD-2841548417`)
- **Virtual Serial 1**: First Blumon merchant registration (e.g., `2841548417`)
- **Virtual Serial 2**: Second Blumon merchant registration (e.g., `2841548418`)

**📖 COMPLETE DOCUMENTATION**: When working with Blumon Android SDK, multi-merchants, or payment routing, refer to these files:

1. **docs/blumon-tpv/BLUMON_ARCHITECTURE_SUMMARY.txt** - Quick 5-minute overview

   - Best for: Understanding system at a glance
   - Contains: Serial numbers explained, database hierarchy, payment flow, cost structure
   - Use when: Need quick context before diving into code

2. **docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md** - Developer reference while coding

   - Best for: Finding file locations, field definitions, debugging
   - Contains: Critical file locations (backend + Android), field glossary, common issues
   - Use when: Implementing features, debugging merchant issues, need to find specific code

3. **docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md** - Complete technical deep dive

   - Best for: Full system understanding, explaining to team members
   - Contains: Complete architecture, data flow with code examples, credential management
   - Use when: Need comprehensive understanding, implementing major features

4. **docs/blumon-tpv/BLUMON_DOCUMENTATION_INDEX.md** - Navigation guide
   - Best for: Finding specific information quickly
   - Contains: Document comparison, quick navigation, topic-based lookup
   - Use when: Don't know which document to read

**Quick Topic Lookup**:

- MerchantAccount model → See docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md (Critical File Locations)
- Credential switching → See docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md (Section 4)
- Payment routing → See docs/blumon-tpv/BLUMON_ARCHITECTURE_SUMMARY.txt (Section 5)
- Cost structure per merchant → See docs/blumon-tpv/BLUMON_ARCHITECTURE_SUMMARY.txt (Section 6)
- Real restaurant example → See docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md (Section 9)
- Common debugging → See docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md (Common Issues & Solutions)

**Key Architecture**:

```
One Physical Terminal (e.g., PAX A910S)
  ├── Physical Serial: AVQD-2841548417 (built-in)
  │
  ├── Merchant Account #1 (Main Dining)
  │   ├── Virtual Serial: 2841548417
  │   ├── blumonPosId: 376
  │   ├── Bank Account: BBVA Main
  │   └── Cost Structure: 1.5% + $0.50
  │
  └── Merchant Account #2 (Ghost Kitchen)
      ├── Virtual Serial: 2841548418
      ├── blumonPosId: 378
      ├── Bank Account: BBVA Kitchen
      └── Cost Structure: 1.8% + $0.50
```

**Payment Flow**:

1. Cashier selects merchant before payment (Android UI)
2. SDK reinitializes for selected merchant (3-5 seconds)
3. Customer taps card
4. Payment routes to correct merchant's bank account
5. Fee calculated using that merchant's cost structure

**Critical Gotcha**: Cost structure is PER MERCHANT ACCOUNT, not per terminal. Different merchants on same device can have different rates.

**Key Files**:

- MerchantAccount model: `prisma/schema.prisma:1958`
- Blumon service: `src/services/tpv/blumon-tpv.service.ts`
- Terminal config endpoint: `src/controllers/tpv/terminal.tpv.controller.ts:83`
- Cost structure: `prisma/schema.prisma:2116` (ProviderCostStructure)

**Testing Multi-Merchant Setup**:

```bash
# Check merchant accounts for terminal
psql -c "SELECT id, blumonSerialNumber, blumonPosId, name FROM MerchantAccount WHERE terminalId = 'xxx';"

# Check cost structures per merchant
psql -c "SELECT ma.name, pcs.fixedFee, pcs.percentageFee FROM ProviderCostStructure pcs JOIN MerchantAccount ma ON pcs.merchantAccountId = ma.id;"
```

**⚠️ CRITICAL**: Always read the Blumon documentation files before modifying merchant-related code. They contain crucial context about
credential management, payment routing, and cost calculation.

### Authentication & Authorization

**WHY**: JWT-based auth provides stateless authentication, permission-based access control (ABAC) enables flexible per-venue customization.

**Critical Pattern**: Use `req.authContext` NOT `req.user`:

```typescript
// ✅ CORRECT
const authContext = (req as any).authContext
const { userId, venueId, orgId, role } = authContext

// ❌ WRONG - req.user does NOT exist
const user = (req as any).user // undefined!
```

**Middleware**: `authenticateToken` (sets authContext), `checkPermission` (validates permissions)

**Permission Format**: `"resource:action"` (e.g., `"tpv:create"`, `"menu:update"`, `"analytics:export"`)

**Key Files**:

- Auth middleware: `src/middlewares/authenticateToken.middleware.ts`
- Permission middleware: `src/middlewares/checkPermission.middleware.ts`
- Permission definitions: `src/lib/permissions.ts`
- Database: `StaffVenue.permissions` JSON field (custom per-venue permissions)

**📖 Complete Documentation**: See `docs/PERMISSIONS_SYSTEM.md` for:

- Complete permission system architecture
- Two-layer permission system (default + custom)
- Override vs Merge modes for different roles
- `authorizeRole` vs `checkPermission` comparison
- Migration guide and best practices
- Permission middleware usage examples

### Real-Time Communication

- Socket.IO server for live updates
- Room-based broadcasting: `venue_{venueId}`
- Event types: order updates, payment completed, inventory changes

### POS Integration

- RabbitMQ message queue for legacy POS systems
- Windows Service producer → Backend consumer
- Bidirectional sync with SoftRestaurant

### Error Handling

- Custom error classes: `AppError`, `NotFoundError`, `BadRequestError`
- Global error handler in `app.ts`
- Structured error responses with correlation IDs

### Logging

- Winston logger with pino-pretty formatting
- Correlation IDs for request tracing
- Log levels: debug, info, warn, error
- Structured logging with metadata

**Log Files Location:**

- **Directory**: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/logs`
- **Naming Convention**: `development.log`, `development1.log`, `development2.log`, ..., `developmentN.log`
- **Log Rotation**: When logs reach a certain size, they rotate to numbered files

**Debugging with Logs:**

When debugging issues, always check the **most recent log file** (highest number):

```bash
# Example: If you have 8 log files (development.log → development7.log)
# Check the LAST file (development7.log) for most recent entries
tail -n 100 logs/development7.log

# Or find the latest log file automatically and show last 100 lines
ls -t logs/development*.log | head -1 | xargs tail -n 100

# Live tail (watch logs in real-time)
tail -f logs/$(ls -t logs/development*.log | head -1)

# Search for errors in latest log
ls -t logs/development*.log | head -1 | xargs grep -i "error"

# Search for specific patterns with emojis (inventory operations)
ls -t logs/development*.log | head -1 | xargs grep "🎯\|✅\|⚠️"
```

**Why Check the Highest Numbered File?**

- Log files rotate when they reach max size
- `development.log` → oldest logs (rotated out)
- `development7.log` → **newest logs** (current active writes)
- Always inspect the highest number to see the most recent application activity

### Date/Time Synchronization

**WHY**: Frontend dashboard and backend chatbot must return identical results for the same time periods, ensuring data consistency across
all interfaces.

**Design Decision**: All date ranges are transmitted in ISO 8601 format (UTC) between frontend/backend, then converted to venue timezone for
database queries.

**Critical Pattern**: Use `parseDateRange()` and `getVenueDateRange()` from `datetime.ts` for ALL date-based queries:

```typescript
// ✅ CORRECT - Timezone-aware date parsing
import { parseDateRange } from '@/utils/datetime'
const { startDate, endDate } = parseDateRange(fromDate, toDate)

// ❌ WRONG - Direct date parsing loses timezone context
const startDate = new Date(fromDate)
```

**Key Files**:

- Date utilities: `src/utils/datetime.ts` - date-fns-tz functions for timezone conversion
- Dashboard queries: Uses `parseDateRange()` for all analytics endpoints
- Chatbot SQL generation: Uses `getVenueDateRange()` for text-to-SQL queries

**📖 Complete Documentation**: See `docs/DATETIME_SYNC.md` for:

- Complete architecture diagram (Dashboard → Server → Database flow)
- Frontend/backend synchronization examples
- FIFO batch tracking with timezone handling
- API endpoint examples with date parameters
- Debugging timezone-related issues
- Before/After comparison of date handling

### AI Chatbot System (Text-to-SQL)

**WHY**: Provide natural language interface for restaurant analytics, guaranteeing 100% consistency with dashboard values to build user
trust.

**Design Decision**: Multi-tier hybrid architecture optimizes for cost ($0.50/user/month) while maintaining high accuracy through consensus
voting for critical queries.

**Critical Architecture**: 3-tier query routing system

1. **Simple Queries (70%)** → SharedQueryService ($0 cost)

   - Uses SAME code as dashboard endpoints
   - Impossible to have mismatches
   - Zero LLM calls for common queries

2. **Complex + Important (10%)** → Consensus Voting (3× SQL generations)

   - Salesforce-style majority voting
   - High confidence (66-100% agreement)
   - Business-critical decisions

3. **Complex + Not Important (20%)** → Single SQL + Layer 6 Validation
   - Statistical sanity checks
   - Magnitude/percentage validation
   - Cost-effective for non-critical queries

**5-Level Security Architecture** (NEW - 2025-10-30):

1. **Level 1: Pre-validation** - Prompt injection detection, rate limiting
2. **Level 2: LLM Generation** - SQL generation with security rules
3. **Level 3: SQL Validation** - Selective AST parsing, table access control (RBAC)
4. **Level 4: Execution** - Query limits (timeout, row limits), tenant isolation
5. **Level 5: Post-processing** - PII detection and redaction, audit logging

**Critical Patterns**:

- **SharedQueryService**: Use for ALL common metrics (sales, top products, reviews) to guarantee dashboard consistency
- **AST Validation**: Deep validation only for complex queries or low-privilege roles (selective to avoid performance impact)
- **PII Redaction**: Automatic for all roles except SUPERADMIN (emails, phones, SSNs, credit cards)
- **Consensus Voting**: Only triggers for queries with comparisons ("vs", "versus") + rankings ("mejor", "top")

**Key Files**:

- Main service: `src/services/dashboard/text-to-sql-assistant.service.ts` (2600+ lines)
- Shared queries: `src/services/dashboard/shared-query.service.ts` - Single source of truth
- SQL validation: `src/services/dashboard/sql-validation.service.ts` - Multi-layer validation
- Security services (8 files):
  - `src/services/dashboard/security-response.service.ts` - Standardized responses
  - `src/services/dashboard/sql-ast-parser.service.ts` - Structural SQL analysis
  - `src/services/dashboard/table-access-control.service.ts` - RBAC for tables
  - `src/services/dashboard/pii-detection.service.ts` - PII redaction
  - `src/services/dashboard/prompt-injection-detector.service.ts` - Attack prevention
  - `src/services/dashboard/query-limits.service.ts` - Resource limits
  - `src/services/dashboard/security-audit-logger.service.ts` - Encrypted audit trail
  - `src/middlewares/chatbot-rate-limit.middleware.ts` - Rate limiting (10/min, 100/hour)

**Critical Gotchas**:

- ⚠️ Always pass `userRole` to `executeSafeQuery()` for proper access control
- ⚠️ Selective validation: Complex queries + low-privilege roles get deep AST validation, simple queries skip it
- ⚠️ Never bypass venueId filter - enforced at AST level for tenant isolation
- ⚠️ Rate limits: 10 queries/min per user, 100 queries/hour per venue
- ⚠️ Consensus voting adds ~6s latency (3 parallel LLM calls) - only for important queries

**📖 Complete Documentation**:

- `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` - Complete reference (architecture, security, consensus voting, testing, troubleshooting)
- Security tests: 50+ penetration tests in `tests/integration/security/chatbot-security-penetration.test.ts`

### Testing Strategy

- **Unit tests**: Service logic isolation
- **API tests**: Endpoint integration
- **Workflow tests**: End-to-end business flows
- Coverage thresholds: 70% global, 80% for critical services

### Stripe Integration & Feature Access Control

**WHY**: Subscription-based feature access enables monetization with trial periods, automatic billing, and feature gating.

**Design Decision**: Trial ends at 5 days (not 2 days as originally documented) - balance between evaluation time and conversion pressure.

**Critical Migration (2025-10-28)**: Moved Stripe customers from Organization to Venue level. All Stripe operations now use `venueId`.

**Core Flow**: Venue Conversion → Create Stripe Customer (Venue-level) → Create Trial Subscriptions → Webhooks Update VenueFeature →
Middleware Validates Access

**Key Files**:

- Customer creation: `src/services/stripe.service.ts:getOrCreateStripeCustomer()`
- Feature sync: `src/services/stripe.service.ts:syncFeaturesToStripe()`
- Trial subscriptions: `src/services/stripe.service.ts:createTrialSubscriptions()`
- Webhook handlers: `src/services/stripe.webhook.service.ts`
- Feature access middleware: `src/middlewares/checkFeatureAccess.middleware.ts`

**Critical Gotchas**:

- ⚠️ Webhooks MUST be mounted BEFORE `express.json()` middleware
- ⚠️ Always pass `venueId` to `getOrCreateStripeCustomer()`, NOT `orgId`
- ⚠️ Seed script does NOT delete features (preserves Stripe IDs)

**📖 Complete Documentation**: See `docs/STRIPE_INTEGRATION.md` for:

- Complete architecture and flow diagram
- Organization → Venue migration details
- Automatic feature sync system
- Customer name format with venue slug
- Webhook testing with Stripe CLI
- Production migration guide
- Common issues and debugging

### 🚧 Pending Features / TODOs

**Chatbot Token Pricing - Superadmin Configuration** (Requested 2025-01-25)

Currently, token pricing is hardcoded in:

- `src/services/dashboard/token-budget.service.ts` (CONFIG object)
- `src/controllers/dashboard/token-budget.dashboard.controller.ts` (TOKEN_PRICING_BY_CURRENCY)

Current hardcoded values:

- OpenAI cost: ~$0.01 USD per 1K tokens
- Merchant price: $0.03 USD / $0.60 MXN per 1K tokens (200% margin)
- Free tokens: 10,000 per month

**TODO**: Create a superadmin-configurable pricing system:

1. Create `ChatbotPricingConfig` model in Prisma (prices per currency, free tokens, margins)
2. Create superadmin CRUD endpoints for pricing configuration
3. Update token-budget service to read from database instead of hardcoded values
4. Add UI in superadmin dashboard for price management

---

When working on this codebase, always consider the full impact of changes. Database schema changes affect all layers. Inventory logic
changes require updating tests, documentation, and Socket.IO events.
