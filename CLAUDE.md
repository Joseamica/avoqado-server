# CLAUDE.md - Avoqado Backend Server

This file provides guidance to Claude Code (claude.ai/code) when working with the backend server codebase.

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

**Example workflow (Test Scripts → Jest Migration):**

Test scripts in `scripts/` are TEMPORARY for rapid development testing. They MUST be migrated to Jest tests before committing.

```bash
# 1. Implement feature in src/services/
vim src/services/dashboard/venue.dashboard.service.ts

# 2. Create TEMPORARY test script for rapid validation
touch scripts/test-venue-update.ts
# Write tests using direct database calls
npx ts-node -r tsconfig-paths/register scripts/test-venue-update.ts
# ✅ All tests pass

# 3. Migrate to PERMANENT Jest test
vim tests/unit/services/dashboard/venue.dashboard.service.test.ts
# Use mocks, follow existing test patterns (Arrange-Act-Assert)
npm test -- tests/unit/services/dashboard/venue.dashboard.service.test.ts
# ✅ All tests pass

# 4. Delete the temporary script
rm scripts/test-venue-update.ts

# 5. Commit ONLY the code + Jest test (NOT the script)
git add src/services/dashboard/venue.dashboard.service.ts
git add tests/unit/services/dashboard/venue.dashboard.service.test.ts
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
- `npm run format` - Format code with Prettier

**⚡ AUTO-FORMAT POLICY (Claude):**

After editing or creating TypeScript/JavaScript files, Claude will **automatically** execute:

```bash
npm run format && npm run lint:fix
```

This ensures:

- ✅ Zero prettier/eslint warnings in commits
- ✅ Consistent code style across all files
- ✅ No manual formatting needed (like Cmd+S in VSCode)

**When it runs:**

- After using `Write` or `Edit` tools on `.ts`, `.tsx`, `.js`, `.jsx` files
- Before committing code changes
- Runs on entire project to catch any inconsistencies

**What it does:**

1. `npm run format` - Formats all files with Prettier
2. `npm run lint:fix` - Auto-fixes ESLint issues

**Expected output:**

```
✓ Files formatted
✓ Lint issues fixed
⚠ Minor warnings OK (unused vars, config options)
```

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

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

- **Routes** (`/src/routes/`) - HTTP endpoint definitions with middleware chains
- **Controllers** (`/src/controllers/`) - HTTP request orchestration (thin layer)
- **Services** (`/src/services/`) - Business logic implementation (core layer)
- **Middlewares** (`/src/middlewares/`) - Cross-cutting concerns (auth, validation, logging)
- **Schemas** (`/src/schemas/`) - Zod validation schemas and TypeScript types
- **Prisma** - Database access layer

### Multi-Tenant Architecture

All operations are scoped to:

- **Organization** - Top-level tenant
- **Venue** - Individual business location

**Critical**: All database queries MUST filter by `venueId` or `orgId`.

### User Role Hierarchy

The system implements a hierarchical role-based access control (RBAC) system with the following roles in descending order of permissions:

#### 1. **SUPERADMIN** (Highest Level)

- **Scope**: Full system access across all organizations and venues
- **Permissions**: Complete administrative control, can access any venue/organization
- **Use Case**: System administrators, platform maintainers
- **Restrictions**: Cannot be invited through normal team invitation flow
- **Special Access**: Maintains SUPERADMIN privileges when switching between venues

#### 2. **OWNER**

- **Scope**: Full access to all venues within their organization
- **Permissions**: Organization-wide management, can create/manage venues, full staff management
- **Use Case**: Restaurant chain owners, franchise owners
- **Special Access**: Can access any venue within their organization, maintains OWNER privileges across venues
- **Hierarchy**: Can manage all roles except SUPERADMIN

#### 3. **ADMIN**

- **Scope**: Full venue access within assigned venues
- **Permissions**: Complete venue management, staff management, financial reports, system configuration
- **Use Case**: General managers, venue administrators
- **Limitations**: Limited to assigned venues only

#### 4. **MANAGER**

- **Scope**: Operations access within assigned venues
- **Permissions**: Shift management, staff scheduling, operations reports, inventory management
- **Use Case**: Shift managers, assistant managers
- **Focus**: Day-to-day operations and staff coordination

#### 5. **CASHIER**

- **Scope**: Payment access within assigned venues
- **Permissions**: Payment processing, basic order management, POS operations
- **Use Case**: Cashiers, front desk staff
- **Focus**: Payment processing and customer checkout

#### 6. **WAITER**

- **Scope**: Service access within assigned venues
- **Permissions**: Order management, table service, basic customer interaction
- **Use Case**: Waitstaff, servers
- **Focus**: Customer service and order processing

#### 7. **KITCHEN**

- **Scope**: Kitchen display access within assigned venues
- **Permissions**: Kitchen display system, order preparation tracking
- **Use Case**: Kitchen staff, cooks
- **Focus**: Food preparation and kitchen operations

#### 8. **HOST**

- **Scope**: Reservations and seating access within assigned venues
- **Permissions**: Reservation management, seating arrangements, customer greeting
- **Use Case**: Host/hostess, reception staff
- **Focus**: Customer reception and table management

#### 9. **VIEWER** (Lowest Level)

- **Scope**: Read-only access within assigned venues
- **Permissions**: View-only access to reports and data
- **Use Case**: Observers, trainees, external auditors
- **Limitations**: Cannot modify any data or perform operations

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

## 🍔 Order → Payment → Inventory Flow (CRITICAL BUSINESS LOGIC)

### Overview

This is the **most critical business flow** in the platform. When an order is fully paid, the system automatically deducts inventory using
FIFO (First-In-First-Out) batch tracking.

### Complete Flow Diagram

```
1. ORDER CREATION [TPV or Dashboard]
   ├─ POST /api/v1/tpv/venues/{venueId}/orders
   ├─ Controller: order.tpv.controller.ts → createOrder()
   ├─ Service: order.tpv.service.ts → createOrder()
   └─ Result: Order with status="CONFIRMED", paymentStatus="PENDING"
   ⚠️ NO INVENTORY DEDUCTION YET

2. PAYMENT PROCESSING
   ├─ POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payments
   ├─ Controller: payment.tpv.controller.ts → recordPayment()
   ├─ Service: payment.tpv.service.ts → recordOrderPayment()
   │   ├─ Create Payment record
   │   ├─ Create VenueTransaction (revenue tracking)
   │   ├─ Create TransactionCost (profit tracking)
   │   └─ Check if order is fully paid:
   │       ├─ totalPaid < order.total → paymentStatus="PARTIAL"
   │       └─ totalPaid >= order.total → paymentStatus="PAID", status="COMPLETED"
   │           └─ 🎯 TRIGGER AUTOMATIC INVENTORY DEDUCTION

3. INVENTORY DEDUCTION [payment.tpv.service.ts:98-147]
   For each OrderItem:
   ├─ Call deductStockForRecipe(venueId, productId, quantity, orderId)
   ├─ Product has NO recipe? → Skip (log warning, not error)
   ├─ Insufficient stock? → Skip (log warning, payment still succeeds)
   └─ Success: Deduct inventory via FIFO

4. FIFO BATCH DEDUCTION [rawMaterial.service.ts:468-537]
   For each ingredient in recipe:
   ├─ Skip if ingredient.isOptional = true
   ├─ Calculate needed: ingredient.quantity × portions sold
   ├─ Call deductStockFIFO() → [rawMaterial.service.ts:395-466]
   │   ├─ Query: SELECT * FROM StockBatch WHERE rawMaterialId=? AND status=ACTIVE ORDER BY receivedDate ASC
   │   ├─ Batch 1 (oldest): Deduct up to remainingQuantity
   │   ├─ Batch depleted? → Update status=DEPLETED, move to Batch 2
   │   └─ Repeat until full quantity deducted
   ├─ Create RawMaterialMovement record (audit trail)
   ├─ Update RawMaterial.currentStock (-quantity)
   └─ Check if currentStock <= reorderPoint:
       └─ Create LowStockAlert + emit Socket.IO notification

5. PROFIT TRACKING
   ├─ Recipe Cost = SUM(ingredient.quantity × ingredient.costPerUnit)
   ├─ Sale Price = Product.price
   ├─ Gross Profit = Sale Price - Recipe Cost
   └─ Records:
       ├─ VenueTransaction (revenue)
       ├─ TransactionCost (detailed costs)
       └─ MonthlyVenueProfit (aggregated)
```

### Key Files and Line Numbers

| File                                                            | Function                    | Lines   | Purpose                                               |
| --------------------------------------------------------------- | --------------------------- | ------- | ----------------------------------------------------- |
| `src/services/tpv/payment.tpv.service.ts`                       | `recordOrderPayment()`      | 98-147  | Triggers inventory deduction when order is fully paid |
| `src/services/dashboard/rawMaterial.service.ts`                 | `deductStockForRecipe()`    | 468-537 | Orchestrates recipe-based deduction                   |
| `src/services/dashboard/rawMaterial.service.ts`                 | `deductStockFIFO()`         | 395-466 | Implements FIFO batch consumption                     |
| `src/services/dashboard/productInventoryIntegration.service.ts` | `getProductInventoryType()` | 14-38   | Determines inventory strategy                         |

### Critical Business Rules

1. ✅ **Stock deduction ONLY when fully paid**: `totalPaid >= order.total`
2. ✅ **Non-blocking failures**: Payment succeeds even if deduction fails
3. ✅ **FIFO batch consumption**: Oldest batches first (`receivedDate ASC`)
4. ✅ **Recipe-based deduction**: Each product links to recipe with ingredients
5. ✅ **Optional ingredients**: Skipped if unavailable (`isOptional: true`)
6. ✅ **Low stock alerts**: Auto-generated when `currentStock <= reorderPoint`
7. ✅ **Partial payments**: Do NOT trigger deduction

### Real-World Example: 3 Hamburgers

**Recipe (1 burger)**:

- 1 bun @ $0.50 = $0.50
- 1 beef patty @ $2.00 = $2.00
- 2 cheese slices @ $0.30 each = $0.60
- 50g lettuce @ $0.50/100g = $0.25
- **Total Cost: $3.35 | Sale Price: $12.99 | Profit: $9.64 (74.2% margin)**

**Order Flow**:

1. Waiter creates order: 3 burgers = $38.97 (total with tax)
2. Customer pays: $38.97 + $5.00 tip = $43.97
3. **Payment triggers inventory deduction** (totalPaid >= order.total ✓)
4. **Stock deducted (FIFO)**:
   - 3 buns → Batch 1 (Oct 1, oldest)
   - 3 beef patties → Batch 1 (Oct 1)
   - 6 cheese slices → Batch 2 (Oct 3, after Batch 1 depleted)
   - 150g lettuce → Batch 1 (Oct 2)
5. **Revenue tracked**:
   - VenueTransaction: $43.97 gross
   - TransactionCost: $10.05 cost (3 × $3.35)
   - Profit: $33.92 (77.2% margin including tip)
6. **Low stock alert**: If any ingredient <= reorderPoint

### FIFO Batch Example

```typescript
// Buns inventory before order:
Batch 1: 50 units, received Oct 4, expires Oct 9  (OLDEST)
Batch 2: 100 units, received Oct 9, expires Oct 14
Batch 3: 150 units, received Oct 14, expires Oct 19 (NEWEST)

// Order requires 60 buns:
Step 1: Deduct 50 from Batch 1 → Batch 1 DEPLETED
Step 2: Deduct 10 from Batch 2 → Batch 2 has 90 remaining
Step 3: Batch 3 untouched (still 150)

// Result: Oldest stock used first, reducing waste!
```

### Edge Cases & Error Handling

| Scenario                        | Behavior                    | Code Location                    |
| ------------------------------- | --------------------------- | -------------------------------- |
| No recipe for product           | Skip deduction, log warning | `payment.tpv.service.ts:126-132` |
| Insufficient stock              | Skip deduction, log warning | `rawMaterial.service.ts:442-448` |
| Partial payment                 | No deduction                | `payment.tpv.service.ts:95-97`   |
| Optional ingredient unavailable | Skip ingredient, continue   | `rawMaterial.service.ts:483`     |
| Batch expired                   | Skip batch, use next        | `rawMaterial.service.ts:419-424` |
| Order cancelled                 | No deduction                | Only COMPLETED orders trigger    |

### API Endpoints

**Create Order**:

```bash
POST /api/v1/tpv/venues/{venueId}/orders
Authorization: Bearer {token}
Content-Type: application/json

{
  "items": [
    {
      "productId": "prod_123",
      "quantity": 3,
      "notes": "No onions"
    }
  ],
  "tableId": "table_5",
  "customerName": "John Doe"
}
```

**Record Payment** (triggers inventory deduction):

```bash
POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payments
Authorization: Bearer {token}
Content-Type: application/json

{
  "amount": 38.97,
  "method": "CASH",
  "reference": "CASH-001"
}
```

**View Stock Movements**:

```bash
GET /api/v1/dashboard/venues/{venueId}/raw-materials/{materialId}/movements
Authorization: Bearer {token}
```

### Testing the Flow

**Automated Tests**:

```bash
npm run test:workflows  # Includes inventory deduction tests
npm run test:tpv        # TPV-specific tests
```

**Manual Testing**:

```bash
# 1. Create test data
npm run migrate
npm run seed

# 2. Start dev server with logs
npm run dev

# 3. Create order
curl -X POST "http://localhost:12344/api/v1/tpv/venues/{venueId}/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"productId": "prod_123", "quantity": 3}],
    "tableId": "table-1"
  }'

# 4. Record payment (triggers deduction)
curl -X POST "http://localhost:12344/api/v1/tpv/venues/{venueId}/orders/{orderId}/payments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 38.97,
    "method": "CASH"
  }'

# 5. Verify in logs
tail -f logs/app.log | grep "🎯\|✅\|⚠️"

# Expected logs:
# 🎯 Starting inventory deduction for completed order
# ✅ Stock deducted successfully for product
# ⚠️ Failed to deduct stock (if issues)

# 6. Verify in database
npm run studio
# Check: RawMaterial.currentStock, StockBatch.remainingQuantity, RawMaterialMovement
```

### Debugging Common Issues

**Problem: Stock not deducting**

```typescript
// Check 1: Is order fully paid?
const order = await prisma.order.findUnique({ where: { id: orderId } })
console.log('Total:', order.total, 'Paid:', order.totalPaid)
// Must be: totalPaid >= total

// Check 2: Does product have recipe?
const recipe = await prisma.recipe.findUnique({ where: { productId } })
console.log('Recipe found:', !!recipe)

// Check 3: Are ingredients available?
const rawMaterial = await prisma.rawMaterial.findUnique({ where: { id } })
console.log('Current stock:', rawMaterial.currentStock)
```

**Problem: Wrong FIFO order**

```sql
-- Verify batch ordering
SELECT id, receivedDate, remainingQuantity, status
FROM "StockBatch"
WHERE "rawMaterialId" = 'rm_123'
ORDER BY "receivedDate" ASC;
-- Should show oldest first with status='ACTIVE'
```

**Problem: Low stock alert not generated**

```typescript
// Check reorder point configuration
const rawMaterial = await prisma.rawMaterial.findUnique({ where: { id } })
console.log('Current:', rawMaterial.currentStock, 'Reorder:', rawMaterial.reorderPoint)
// Alert triggers when: currentStock <= reorderPoint
```

### Socket.IO Events

The system emits real-time events for inventory changes:

```typescript
// Low stock alert
socket.to(`venue_${venueId}`).emit('inventory.lowStock', {
  rawMaterialId: 'rm_123',
  name: 'Ground Beef',
  currentStock: 2.5,
  reorderPoint: 5.0,
  unit: 'KILOGRAM',
})

// Stock movement
socket.to(`venue_${venueId}`).emit('inventory.stockMoved', {
  rawMaterialId: 'rm_123',
  type: 'USAGE',
  quantity: -3.0,
  reference: 'order_456',
})
```

### Database Models

**Key relationships**:

```
Order → OrderItem → Product → Recipe → RecipeLine → RawMaterial → StockBatch
                                                                  → RawMaterialMovement
                                                                  → LowStockAlert
```

**Critical fields**:

- `Order.totalPaid` vs `Order.total` - Determines if deduction triggers
- `StockBatch.receivedDate` - Used for FIFO ordering
- `StockBatch.status` - ACTIVE or DEPLETED
- `RawMaterial.currentStock` - Auto-calculated from batches
- `RawMaterial.reorderPoint` - Threshold for low stock alerts
- `RecipeLine.isOptional` - Skip if ingredient unavailable

### Best Practices

1. **Always use transactions** for stock deduction to ensure atomicity
2. **Log extensively** during inventory operations (use emojis: 🎯 ✅ ⚠️)
3. **Never block payments** due to inventory issues
4. **Always validate** `totalPaid >= total` before deduction
5. **Test FIFO order** by creating multiple batches with different dates
6. **Monitor logs** for `⚠️` warnings about missing recipes or low stock

### Related Documentation

- **Root CLAUDE.md**: Full flow diagram with examples
- **Dashboard CLAUDE.md**: UI components and frontend integration
- **AGENTS.md** (this project): Agent-specific guidelines
- **DATABASE_SCHEMA.md**: Complete schema documentation

---

## Other Important Topics

### Authentication & Authorization

- JWT-based authentication with refresh tokens
- Permission-based access control (ABAC) - Granular permission system
- Session management with Redis
- Middleware: `authenticateToken`, `checkPermission`

**⚠️ CRITICAL: Request Context Pattern**

The `authenticateTokenMiddleware` attaches user information to `req.authContext`, NOT `req.user`:

```typescript
// ✅ CORRECT - Use authContext
const authContext = (req as any).authContext
if (!authContext || !authContext.role) {
  return res.status(401).json({ error: 'Unauthorized' })
}
const userRole = authContext.role // StaffRole
const userId = authContext.userId
const venueId = authContext.venueId
const orgId = authContext.orgId

// ❌ WRONG - req.user does NOT exist
const user = (req as any).user // undefined!
```

**AuthContext Structure** (from `src/security.ts`):

```typescript
interface AuthContext {
  userId: string
  orgId: string
  venueId: string
  role: StaffRole
}
```

**Common Mistake**: Creating new middleware that reads `req.user` instead of `req.authContext`, causing "No user found in request" errors
even though authentication succeeded.

**Where to find this**:

- Middleware: `src/middlewares/authenticateToken.middleware.ts:37` - Sets `req.authContext`
- Middleware: `src/middlewares/checkPermission.middleware.ts:25` - Reads `req.authContext` (current standard)
- Middleware: `src/middlewares/authorizeRole.middleware.ts:14,23` - Reads `req.authContext` (deprecated - use checkPermission instead)

### Granular Permission System (Action-Based Permissions)

The platform uses a **granular permission system** based on action-based permissions (inspired by Fortune 500 companies like Stripe, AWS,
GitHub).

**Permission Format**: `"resource:action"` (e.g., `"tpv:create"`, `"menu:update"`, `"analytics:export"`)

**Two-Layer Permission System**:

1. **Default Role-Based Permissions** - Defined in `src/lib/permissions.ts`
2. **Custom Permissions** - Stored in `StaffVenue.permissions` JSON field (Prisma schema)

**Key Files**:

- `src/lib/permissions.ts` - Permission constants and validation logic
- `src/middlewares/checkPermission.middleware.ts` - Route-level permission middleware
- Prisma Schema: `StaffVenue.permissions` field - JSON array for custom permissions

#### Permission Middleware

**Basic usage** (single permission):

```typescript
import { checkPermission } from '../middlewares/checkPermission.middleware'

router.get(
  '/venues/:venueId/tpvs',
  authenticateTokenMiddleware,
  checkPermission('tpv:read'), // Requires read permission
  tpvController.getTerminals,
)

router.post(
  '/venues/:venueId/tpvs',
  authenticateTokenMiddleware,
  checkPermission('tpv:create'), // Requires create permission
  tpvController.createTpv,
)
```

**Multiple permissions** (requires ANY):

```typescript
import { checkAnyPermission } from '../middlewares/checkPermission.middleware'

router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  checkAnyPermission(['analytics:read', 'analytics:export']), // Requires at least one
  analyticsController.getData,
)
```

**Multiple permissions** (requires ALL):

```typescript
import { checkAllPermissions } from '../middlewares/checkPermission.middleware'

router.post(
  '/venues/:venueId/admin/dangerous-action',
  authenticateTokenMiddleware,
  checkAllPermissions(['admin:write', 'admin:delete']), // Requires both
  adminController.dangerousAction,
)
```

#### Wildcard Permissions

- `"*:*"` - All permissions (ADMIN, OWNER, SUPERADMIN roles)
- `"tpv:*"` - All TPV actions (create, read, update, delete, command)
- `"*:read"` - Read access to all resources

#### Default Permissions by Role

From `src/lib/permissions.ts`:

```typescript
// VIEWER - Read-only access
'home:read', 'analytics:read', 'menu:read', 'orders:read', 'payments:read', 'shifts:read', 'reviews:read', 'teams:read'

// WAITER - Can manage orders and tables
'menu:read',
  'menu:create',
  'menu:update',
  'orders:read',
  'orders:create',
  'orders:update',
  'payments:read',
  'payments:create',
  'shifts:read',
  'tables:read',
  'tables:update',
  'reviews:read',
  'teams:read',
  'tpv:read'

// MANAGER - Operations access
'analytics:read',
  'analytics:export',
  'menu:*',
  'orders:*',
  'payments:read',
  'payments:create',
  'payments:refund',
  'shifts:*',
  'tpv:read',
  'tpv:create',
  'tpv:update',
  'tpv:command',
  'reviews:respond',
  'teams:update'

// ADMIN, OWNER, SUPERADMIN - Full access
;('*:*')
```

#### Custom Permissions (Future Feature)

The system supports custom permissions via `StaffVenue.permissions` JSON field:

**Database schema** (`prisma/schema.prisma`):

```prisma
model StaffVenue {
  id          String   @id @default(cuid())
  staffId     String
  venueId     String
  role        StaffRole
  permissions Json?    // Custom permissions array: ["feature:action", ...]
  // ...
}
```

**Usage** (currently TODO - not in JWT):

```typescript
// Custom permissions can override/extend default role permissions
// Example: WAITER with custom "inventory:read" permission
{
  staffId: "user_123",
  venueId: "venue_456",
  role: "WAITER",
  permissions: ["inventory:read", "reports:export"]  // Extra permissions
}
```

**⚠️ Current Limitation**: Custom permissions are NOT included in JWT tokens yet. They need to be:

1. Added to JWT payload during token generation (`src/security.ts`)
2. OR fetched from database during permission checks

#### Permission Best Practices

1. **Use granular permissions** instead of role checks when possible

   ```typescript
   // ✅ GOOD - Permission-based
   router.post('/tpvs', authenticateTokenMiddleware, checkPermission('tpv:create'), ...)

   // ❌ BAD - Role-based (too rigid)
   router.post('/tpvs', authenticateTokenMiddleware, authorizeRole(['MANAGER', 'ADMIN']), ...)
   ```

2. **Keep frontend and backend permissions in sync**

   - Frontend: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
   - Backend: `avoqado-server/src/lib/permissions.ts`
   - ⚠️ **CRITICAL**: Both files must have identical permission arrays for each role

3. **Always document new permissions** when adding features

   - Add permission to `DEFAULT_PERMISSIONS` constant
   - Update this documentation with new permission strings
   - Update frontend permission configuration

4. **Permission naming convention**:
   - Resource should be singular: `tpv`, `menu`, `order`, `payment`
   - Action should be standard CRUD + custom: `read`, `create`, `update`, `delete`, `command`, `export`, `respond`
   - Format: `resource:action`

#### `authorizeRole` vs `checkPermission` - Understanding the Paradigm Shift

The system has fully migrated from role-based authorization (`authorizeRole`) to permission-based authorization (`checkPermission`). **These
are fundamentally different approaches**, not just extensions. All routes now use `checkPermission` exclusively.

##### `authorizeRole` - Legacy Role-Based Approach (RBAC)

```typescript
authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.OWNER])
```

**How it works:**

- **Question**: "Is your role in this list?"
- **Static check** - Cannot be customized per venue
- **All or nothing** - If you're a WAITER, you're blocked. Period.

**Limitations:**

- ❌ Very rigid - Cannot grant extra permissions to lower roles
- ❌ Cannot remove permissions from higher roles (OWNER always has full access)
- ❌ Same permissions for all venues (no per-venue customization)
- ❌ No granularity - You either have full role access or none

**Example problem:**

```typescript
// Analytics route
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  analyticsController.getData,
)

// ❌ WAITER blocked - No way to grant analytics access to a specific WAITER
// ❌ OWNER has access - No way to restrict analytics from a specific OWNER
```

##### `checkPermission` - Modern Permission-Based Approach (ABAC)

```typescript
checkPermission('menu:read')
```

**How it works:**

- **Question**: "Do you have this specific permission?"
- **Dynamic check** - Queries `VenueRolePermission` table on each request
- **Granular control** - Permissions calculated using override/merge logic

**Advantages:**

1. **Override Mode** (for wildcard roles: ADMIN, OWNER, SUPERADMIN)

   ```typescript
   // Example: OWNER in a specific venue
   Default permissions: ['*:*']  // All permissions
   Custom permissions:  ['orders:read', 'payments:read']  // Only these 2

   // Result: Uses ONLY custom (complete override)
   // ✅ OWNER can access orders and payments
   // ❌ OWNER CANNOT access menu (menu:read not in custom list)
   ```

2. **Merge Mode** (for non-wildcard roles: WAITER, CASHIER, etc.)

   ```typescript
   // Example: WAITER in a specific venue
   Default permissions: ['menu:read', 'orders:create', 'tpv:read']
   Custom permissions:  ['inventory:read', 'analytics:export']

   // Result: Default + Custom (additive merge)
   // ✅ WAITER has ALL default permissions PLUS the 2 custom ones
   Final: ['menu:read', 'orders:create', 'tpv:read', 'inventory:read', 'analytics:export']
   ```

3. **Per-Venue Customization**

   ```typescript
   // Venue A: WAITER has default permissions only
   VenueRolePermission: null

   // Venue B: WAITER has extra permissions
   VenueRolePermission: {
     venueId: 'venue_B',
     role: 'WAITER',
     permissions: ['inventory:read', 'shifts:close']
   }

   // ✅ Same user, different permissions based on venue context
   ```

##### Real-World Comparison

**Scenario:** An OWNER wants to give analytics access to a WAITER, but NOT menu editing.

**❌ With `authorizeRole` (impossible):**

```typescript
// Analytics route
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  // WAITER blocked - No way to grant access
)

// Menu route
router.post(
  '/venues/:venueId/menu/products',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  // WAITER blocked - Correct, but not granular
)
```

**✅ With `checkPermission` (flexible):**

```typescript
// Analytics route
router.get('/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  checkPermission('analytics:read'),
  // ✅ WAITER can access if custom permission granted
)

// Menu route
router.post('/venues/:venueId/menu/products',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  // ✅ WAITER blocked - Doesn't have this permission
)

// In database:
VenueRolePermission {
  venueId: 'venue_123',
  role: 'WAITER',
  permissions: ['analytics:read', 'analytics:export']  // Extra permissions granted
}
```

##### Key Differences Summary

| Aspect                      | `authorizeRole`             | `checkPermission`                          |
| --------------------------- | --------------------------- | ------------------------------------------ |
| **Type**                    | Role-based (RBAC)           | Permission-based (ABAC)                    |
| **Flexibility**             | Static, same for all venues | Dynamic, customizable per venue            |
| **Granularity**             | Full role (all or nothing)  | Specific permission (resource:action)      |
| **Customization**           | ❌ Impossible               | ✅ Via `VenueRolePermission` table         |
| **Remove perms from OWNER** | ❌ Impossible               | ✅ Override mode                           |
| **Add perms to WAITER**     | ❌ Impossible               | ✅ Merge mode                              |
| **Database queries**        | None                        | Queries `VenueRolePermission` each request |

##### Migration Example

**Before (role-based):**

```typescript
router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.OWNER]), // ❌ Rigid
  menuController.listMenuCategoriesHandler,
)
```

**After (permission-based):**

```typescript
router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  checkPermission('menu:read'), // ✅ Flexible + customizable
  menuController.listMenuCategoriesHandler,
)
```

**Result:** The system now respects custom permissions configured in the `VenueRolePermission` table, enabling use cases like "OWNER without
menu access" or "WAITER with analytics access".

##### When to Use Each

**Use `checkPermission`** (REQUIRED for all new routes):

- ✅ **ALL features** - Business-critical and administrative features
- ✅ Granular control over permissions
- ✅ Per-venue permission customization
- ✅ Flexible permission assignment to any role

**Do NOT use `authorizeRole`** (deprecated):

- ❌ **Deprecated** - Do not use in new code
- ❌ Exists only for reference and understanding migration
- ❌ All existing routes have been migrated to `checkPermission`
- ❌ Use `checkPermission` with appropriate permission strings instead (e.g., `system:manage` for SUPERADMIN-only features)

##### Migration Status

**🎉 100% MIGRATION COMPLETE - PURE SINGLE PARADIGM ACHIEVED**

All 74 routes in the codebase now use `checkPermission` middleware. Zero exceptions. No hybrid approach.

**Completed migrations:**

- ✅ Menu routes - 38 routes (menucategories, menus, products, modifiers, modifier-groups)
- ✅ Orders routes - 4 routes (read, update, delete)
- ✅ Payments routes - 2 routes (read receipts)
- ✅ Reviews routes - 1 route (read)
- ✅ Analytics routes - 4 routes (general stats, metrics, charts)
- ✅ Venues routes - 5 routes (create, read, update, delete, enhanced)
- ✅ Teams routes - 8 routes (list, invite, update, delete, resend)
- ✅ Notifications routes - 3 routes (send, bulk send)
- ✅ System routes - 4 routes (payment config, testing endpoints)
- ✅ Permission Management routes - 5 routes (role permissions CRUD, hierarchy)

**Total: 74 routes using `checkPermission` ✅**

**New Permission Strings (System & Settings):**

These permissions are covered by the `*:*` wildcard for SUPERADMIN, OWNER, and ADMIN:

```typescript
'system:config' // SUPERADMIN - Payment provider configuration
'system:test' // SUPERADMIN - Testing payment endpoints
'settings:manage' // OWNER/ADMIN - Role permission management
```

**Why 100% migration matters:**

- ✅ **Pure single paradigm** - Follows Stripe/AWS/GitHub patterns exactly
- ✅ **Zero confusion** - Developers always use `checkPermission`, no exceptions
- ✅ **Maximum flexibility** - Even system routes can be customized via VenueRolePermission
- ✅ **Future-proof** - Can grant `system:test` to non-SUPERADMINs if needed
- ✅ **Self-documenting** - Permission strings clearly describe what each route does

**Verification:**

```bash
# Count total checkPermission uses (should be 74 + 1 import = 75)
grep -c "checkPermission" src/routes/dashboard.routes.ts
# Result: 75

# Count authorizeRole uses (should be ONLY the import = 1)
grep "authorizeRole" src/routes/dashboard.routes.ts | wc -l
# Result: 1 (just the import statement)
```

#### Implementing Admin Permission Management UI (Future)

Since `StaffVenue.permissions` exists in the schema, you can build an admin UI to:

1. **View staff permissions** per venue
2. **Assign custom permissions** to individual staff members
3. **Override default role permissions** with granular control

**Example implementation approach**:

```typescript
// Backend endpoint to update staff permissions
router.put(
  '/venues/:venueId/staff/:staffId/permissions',
  authenticateTokenMiddleware,
  checkPermission('staff:manage'),
  async (req, res) => {
    const { permissions } = req.body // Array of permission strings

    await prisma.staffVenue.update({
      where: {
        staffId_venueId: {
          staffId: req.params.staffId,
          venueId: req.params.venueId,
        },
      },
      data: { permissions },
    })

    res.json({ success: true })
  },
)
```

**Frontend UI requirements**:

- Checkbox grid: Rows = resources, Columns = actions
- Separate section for custom permissions
- Visual indicator showing role defaults vs custom overrides
- Permission inheritance display (role → custom)

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

### Testing Strategy

- **Unit tests**: Service logic isolation
- **API tests**: Endpoint integration
- **Workflow tests**: End-to-end business flows
- Coverage thresholds: 70% global, 80% for critical services

---

When working on this codebase, always consider the full impact of changes. Database schema changes affect all layers. Inventory logic
changes require updating tests, documentation, and Socket.IO events.
