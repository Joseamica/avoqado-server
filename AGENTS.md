# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Development

- `npm run build` - Compile TypeScript to `dist/` directory using tsc and tsc-alias
- `npm run dev` - Start development server with hot reload using nodemon and pino-pretty logging
- `npm start` - Start production server from compiled JavaScript in dist/

### Database Operations

- `npm run migrate` - Run Prisma database migrations (`prisma migrate dev`)
- `npm run studio` - Launch Prisma Studio for database exploration

### Testing

- `npm test` - Run all tests with Jest
- `npm run test:unit` - Run only unit tests (`tests/unit`)
- `npm run test:api` - Run only API integration tests (`tests/api-tests`)
- `npm run test:workflows` - Run workflow tests (`tests/workflows`)
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage reports
- `npm run test:ci` - Run tests in CI mode (no watch, with coverage)

### Module-Specific Testing

- `npm run test:dashboard` - Test dashboard functionality
- `npm run test:pos-sync` - Test POS synchronization features
- `npm run test:tpv` - Test TPV (Terminal Portátil de Ventas) functionality
- `npm run test:orders` - Test order management
- `npm run test:auth` - Test authentication workflows
- `npm run test:communication` - Test socket and RabbitMQ communication

### Code Quality

- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier

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

#### 5. **WAITER**

- **Scope**: Service access within assigned venues
- **Permissions**: Order management, table service, basic customer interaction
- **Use Case**: Waitstaff, servers
- **Focus**: Customer service and order processing

#### 6. **CASHIER**

- **Scope**: Payment access within assigned venues
- **Permissions**: Payment processing, basic order management, POS operations
- **Use Case**: Cashiers, front desk staff
- **Focus**: Payment processing and customer checkout

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

### Layered Architecture

The codebase follows a clean layered architecture:

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

- **Routes** (`/src/routes/`) - HTTP endpoint definitions with middleware chains
- **Controllers** (`/src/controllers/`) - HTTP request orchestration (thin layer)
- **Services** (`/src/services/`) - Business logic implementation (core layer)
- **Middlewares** (`/src/middlewares/`) - Cross-cutting concerns (auth, validation, logging)
- **Schemas** (`/src/schemas/`) - Zod validation schemas and TypeScript types

### Key Service Areas

- **Dashboard Services** (`/src/services/dashboard/`) - Admin interface logic
- **TPV Services** (`/src/services/tpv/`) - Point-of-sale terminal operations
- **POS Sync Services** (`/src/services/pos-sync/`) - External POS system integration
- **Communication** (`/src/communication/`) - Socket.IO and RabbitMQ handlers

### Database Schema

Multi-tenant PostgreSQL schema managed by Prisma:

- Organization → Venue hierarchy
- Staff with venue-specific roles
- Product catalog with categories
- Order management with items and payments
- POS synchronization tracking

### Real-time Features

- Socket.IO server for live updates (`/src/communication/sockets/`)
- Room-based broadcasting for venue-specific events
- Business event controllers for order/payment notifications

### Message Processing

- RabbitMQ integration for POS command queuing
- Command listener for database-triggered events
- Retry service for failed command processing
- Event consumer for external POS system events

## Docker Environment

The project includes comprehensive Docker setup:

- Development: `docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
- Production: `docker-compose up -d`
- Database migrations in container: `docker exec avoqado-server-dev npx prisma migrate deploy`

Services:

- **avoqado-server-dev** (port 12344) - Main application
- **avoqado-postgres** (port 5434) - PostgreSQL database
- **avoqado-redis** (port 6379) - Session storage
- **avoqado-rabbitmq** (ports 5672, 15672) - Message broker

## Testing Strategy

Comprehensive test suite organized by type:

- **Unit Tests** (`tests/unit/`) - Service and utility function testing
- **API Tests** (`tests/api-tests/`) - HTTP endpoint integration testing
- **Workflow Tests** (`tests/workflows/`) - End-to-end business process testing

Test configuration includes coverage thresholds (70% global, 80% for critical services) and project-based Jest setup for parallel execution.

## UI Design Guidelines

### Color System (shadcn/ui)

When working with the dashboard/web interface, always use **shadcn/ui semantic color tokens** instead of hardcoded colors. This ensures
proper theming support and consistency across the application.

#### Semantic Color Usage:

**Backgrounds:**

- `bg-background` - Main background color
- `bg-muted` - Subtle background for secondary elements
- `bg-card` - Card/surface background
- `bg-accent` - Accent background for hover states
- `bg-primary` - Primary brand color background
- `bg-secondary` - Secondary background
- `bg-destructive` - Error/danger states

**Text Colors:**

- `text-foreground` - Primary text color
- `text-muted-foreground` - Secondary/subtle text
- `text-primary` - Primary brand color text
- `text-secondary` - Secondary text color
- `text-destructive` - Error/danger text

**Borders:**

- `border-border` - Default border color
- `border-input` - Form input borders
- `border-primary` - Primary brand color borders
- `border-destructive` - Error state borders

#### Status-Specific Colors:

**Success/Online States:**

- `bg-green-500/10 text-green-700 dark:text-green-400` for success backgrounds
- `text-green-600` for success text

**Warning/Maintenance States:**

- `bg-orange-500/10 text-orange-700 dark:text-orange-400` for warning backgrounds
- `text-orange-600` for warning text
- `bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400` for maintenance mode

**Error/Offline States:**

- `bg-destructive/10 text-destructive` for error backgrounds
- Use `text-destructive` for error text

#### Important Rules:

1. **Never use hardcoded colors** like `bg-gray-50`, `text-blue-500`, etc.
2. **Always use semantic tokens** that respect dark/light theme modes
3. **Use opacity modifiers** (e.g., `/10`, `/20`) for subtle background effects
4. **Provide dark mode alternatives** when using custom colors
5. **Maintain consistency** across all UI components

Reference: https://ui.shadcn.com/colors

## Database Schema Documentation

The complete database schema is documented in `/docs/DATABASE_SCHEMA.md`. This file contains:

- **Comprehensive model explanations** with purpose and use cases
- **Relationship documentation** showing how models connect
- **Business logic examples** for each entity
- **Schema evolution guidelines** for future changes

### Schema Maintenance Rules:

**CRITICAL**: When modifying `prisma/schema.prisma`, you MUST also update:

1. `/docs/DATABASE_SCHEMA.md` - Add/update model documentation
2. `CLAUDE.md` - Document the changes made
3. Seed data in `prisma/seed.ts` if new models added
4. Related API documentation

The schema documentation serves as context for AI assistants and team members, so accuracy is essential.

## Development Notes

- The server includes graceful shutdown handling for all services (HTTP, Socket.IO, RabbitMQ, database connections)
- Development mode provides JWT token generation endpoint: `POST /api/dev/generate-token`
- Swagger documentation available at `/api-docs`
- Winston logging with correlation IDs for request tracing
- Multi-environment configuration via environment variables

### Testing and Debugging Best Practices

**CRITICAL DEVELOPMENT WORKFLOW**: When implementing or debugging features, follow this iterative approach:

#### 1. **Add Temporary Debug Logs**

Always add comprehensive logging when working on complex features:

```typescript
// ✅ GOOD: Temporary debug logs for development
logger.info(`🔧 [DEBUG] Starting payment process for amount: ${amount}`)
logger.info(`🔧 [DEBUG] Terminal ID: ${terminalId}, Merchant: ${merchantId}`)
logger.info(`🔧 [DEBUG] Payment request payload:`, { amount, currency, terminalId })

try {
  const result = await processPayment(paymentData)
  logger.info(`🔧 [DEBUG] Payment result:`, result)
} catch (error) {
  logger.error(`🔧 [DEBUG] Payment failed:`, { error: error.message, stack: error.stack })
}
```

#### 2. **Provide Testing Steps**

After implementing changes, always provide clear testing instructions:

```bash
# Test the new feature
curl -X POST "http://localhost:12344/api/v1/payments" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "terminalId": "abc123"}'

# Expected response: 200 OK with payment confirmation
```

#### 3. **Monitor Logs During Testing**

Use these commands to monitor logs in real-time:

```bash
# Monitor all logs
tail -f /path/to/logs/app.log

# Filter specific debug logs
tail -f /path/to/logs/app.log | grep "🔧 \[DEBUG\]"

# Monitor server logs in development
npm run dev | grep -E "(error|🔧|payment|terminal)"
```

#### 4. **Share Logs When Issues Occur**

If testing reveals issues, share relevant logs using:

```bash
# Get recent logs with context
tail -50 /path/to/logs/app.log

# Get specific error logs
grep -A5 -B5 "error\|ERROR\|failed" /path/to/logs/app.log | tail -20
```

#### 5. **Clean Up Debug Logs**

**IMPORTANT**: Once feature is working, remove all temporary debug logs:

```typescript
// ❌ REMOVE: Clean up all debug logs before committing
// logger.info(`🔧 [DEBUG] Starting payment process...`)
// logger.info(`🔧 [DEBUG] Payment request payload:`, paymentData)

// ✅ KEEP: Only essential production logs
logger.info(`Payment processed successfully for terminal: ${terminalId}`)
```

#### Debug Log Conventions:

- Use `🔧 [DEBUG]` prefix for temporary debugging logs
- Include context: function name, key variables, request/response data
- Add timestamps and correlation IDs for tracing
- Use structured logging with objects for complex data
- Always add both success and error logging paths

#### Testing Feedback Loop:

1. **Implement** → Add debug logs
2. **Test** → Provide testing steps to user
3. **Debug** → Share logs if issues occur
4. **Iterate** → Fix based on log analysis
5. **Clean** → Remove debug logs once working
6. **Commit** → Only production-ready code

## 🍔 Order → Payment → Inventory Flow (Critical Business Logic)

### Overview

When a customer completes a payment, the system automatically deducts inventory using **FIFO (First-In-First-Out) batch tracking**. This is one of the most critical business flows in the platform.

### Flow Diagram

```
1. Waiter creates Order → Order status: PENDING
2. Payment received → Order status: PAID
3. ✅ Payment fully covers total → Trigger automatic inventory deduction
4. For each OrderItem → Find Recipe → Deduct ingredients using FIFO
5. Create VenueTransaction + TransactionCosts → Track profit
```

### Key Files

- **Payment trigger**: `src/services/tpv/payment.tpv.service.ts:98-147`
- **FIFO deduction**: `src/services/dashboard/rawMaterial.service.ts:468-537`
- **Batch tracking**: `src/services/dashboard/rawMaterial.service.ts:395-466` (`deductStockFIFO`)

### Critical Business Rules

1. **Stock deduction ONLY happens when order is fully paid** (`totalPaid >= order.total`)
2. **FIFO batch consumption**: Oldest batches (`receivedDate` ASC) are consumed first
3. **Recipe-based deduction**: Each product links to a recipe with multiple ingredients
4. **Non-blocking failures**: Payment succeeds even if stock deduction fails (logged as warning)
5. **Low stock alerts**: Auto-generated when `currentStock <= reorderPoint`
6. **Optional ingredients**: Skipped if unavailable (marked `isOptional: true` in recipe)
7. **Profit tracking**: Revenue + costs recorded in `VenueTransaction` + `TransactionCost`

### Real-World Example

**Product**: Hamburger (sells for $5.00)
**Recipe**:
- 150g ground beef ($0.80/100g) = $1.20
- 1 bun ($0.30 each) = $0.30
- 20g cheese ($0.50/100g) = $0.10
**Total Cost**: $1.60 per burger

**Order**: 3 hamburgers
1. Revenue: 3 × $5.00 = $15.00
2. Cost: 3 × $1.60 = $4.80
3. Profit: $15.00 - $4.80 = $10.20

**Inventory Deduction** (FIFO):
- Batch #1 (2024-01-01, 300g beef) → Deduct 450g → Consumes all 300g, needs 150g more
- Batch #2 (2024-01-05, 500g beef) → Deduct 150g → 350g remaining
- Buns (oldest batch first) → Deduct 3 units
- Cheese (oldest batch first) → Deduct 60g

### Testing the Flow

```bash
# 1. Create test data
npm run migrate
npm run seed  # Creates test venue, products, recipes, stock batches

# 2. Create order
curl -X POST "http://localhost:12344/api/v1/tpv/venues/{venueId}/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "items": [{"productId": "hamburger-id", "quantity": 3}],
    "tableId": "table-1"
  }'

# 3. Add payment (triggers inventory deduction)
curl -X POST "http://localhost:12344/api/v1/tpv/venues/{venueId}/orders/{orderId}/payments" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "amount": 15.00,
    "method": "CASH"
  }'

# 4. Verify stock deduction
npm run studio  # Check RawMaterial.currentStock and RawMaterialMovement records

# 5. Check logs for FIFO deduction
tail -f logs/app.log | grep "🎯\|✅\|⚠️"
```

### Debugging Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Stock not deducted | Order not fully paid | Check `totalPaid >= order.total` |
| FIFO order wrong | Invalid `receivedDate` | Verify batch `receivedDate` timestamps |
| Insufficient stock warning | Low inventory | Check `currentStock` vs recipe requirements |
| Missing recipe | Product has no recipe | Create recipe or skip inventory tracking |
| Optional ingredient skipped | `isOptional: true` | Expected behavior, check logs |

### Agent Guidelines for Inventory Features

When working on inventory-related features:

1. **Always test payment → deduction flow** using the steps above
2. **Verify FIFO ordering** by checking `RawMaterialMovement.createdAt` timestamps
3. **Monitor logs** for `🎯 Starting inventory deduction` and `✅ Stock deducted successfully`
4. **Check edge cases**: insufficient stock, missing recipes, optional ingredients
5. **Update tests** in `tests/workflows/` when modifying deduction logic
6. **Document changes** in both `AGENTS.md` and `CLAUDE.md`

### Related Documentation

- Full implementation details: `CLAUDE.md` (root) → "Order → Payment → Inventory Flow"
- Database schema: `docs/DATABASE_SCHEMA.md` → RawMaterial, StockBatch, Recipe models
- Frontend UI: `avoqado-web-dashboard/CLAUDE.md` → "Inventory Management System"

## Known Limitations

- **Organization ID (orgId) authorization**: Currently not fully implemented in service methods. Most TPV service methods accept `orgId`
  parameter but don't enforce organization-level access control. Future implementation needed for proper multi-tenant isolation.

- You can query directly postgres using psql with this env variables:
  DATABASE_URL="postgresql://postgres:exitosoy777@localhost:5432/av-db-25"
