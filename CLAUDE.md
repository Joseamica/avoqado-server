# CLAUDE.md - Avoqado Backend Server

This file provides guidance to Claude Code (claude.ai/code) when working with the backend server codebase.

## 📚 Documentation Policy

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

## Architecture Overview

This is a restaurant management platform backend with multi-tenant architecture supporting:

### Core Business Domains

- **Organizations** - Multi-tenant root entities
- **Venues** - Individual restaurant locations
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

**WHY**: Critical business functionality that handles real money and inventory requires 100% confidence. Integration tests with real database prevent production bugs that unit tests (with mocks) cannot catch.

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
       data: { status: 'PENDING', paymentStatus: 'PARTIAL' }
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
           id: { not: currentPaymentId } // ← Critical fix!
         }
       }
     }
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

---

When working on this codebase, always consider the full impact of changes. Database schema changes affect all layers. Inventory logic
changes require updating tests, documentation, and Socket.IO events.
