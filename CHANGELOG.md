# Changelog

All notable changes to Avoqado Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Order Guest Information & Actions System** (2025-01-19)

  - `prisma/schema.prisma`: Added `specialRequests` field to Order model for dietary restrictions, allergies, special occasions
  - `prisma/schema.prisma`: Created `OrderAction` audit table with ActionType enum (COMP, VOID, DISCOUNT, SPLIT, MERGE, TRANSFER)
  - `order.tpv.service.ts:556-701`: Implemented `removeOrderItem()` with optimistic concurrency control
    - Delete specific items from orders with version checking
    - Automatic total recalculation and Socket.IO event broadcasting
    - Prevents removal from paid orders
  - `order.tpv.service.ts:703-815`: Implemented `updateGuestInfo()` for guest management
    - Update covers, customerName, customerPhone, specialRequests
    - Real-time Socket.IO event broadcasting
    - Supports DINE_IN guest tracking and TAKEOUT customer info
  - `order.tpv.service.ts` (appended): Implemented `compItems()` for service recovery
    - Comp specific items or entire order
    - Required reason field for audit trail
    - Creates OrderAction record with COMP type
    - Use cases: food quality issues, long wait times, service recovery
  - `order.tpv.service.ts` (appended): Implemented `voidItems()` for order corrections
    - Void specific items with optimistic locking
    - Required reason field for audit trail
    - Creates OrderAction record with VOID type
    - Use cases: incorrect entry, customer cancellation
  - `order.tpv.service.ts` (appended): Implemented `applyDiscount()` for flexible discounts
    - Supports PERCENTAGE (1-100%) and FIXED_AMOUNT discounts
    - Item-level or order-level discount application
    - Creates OrderAction record with DISCOUNT type
    - Optimistic concurrency control with version field
  - `order.tpv.controller.ts:90-111`: Added `removeOrderItem()` controller
  - `order.tpv.controller.ts:113-138`: Added `updateGuestInfo()` controller
  - `order.tpv.controller.ts:140-165`: Added `compItems()` controller
  - `order.tpv.controller.ts:167-192`: Added `voidItems()` controller
  - `order.tpv.controller.ts:194-221`: Added `applyDiscount()` controller
  - `tpv.schema.ts:258-270`: Added `removeOrderItemSchema` validation
  - `tpv.schema.ts:273-288`: Added `updateGuestInfoSchema` validation with phone regex
  - `tpv.schema.ts:291-305`: Added `compItemsSchema` validation (empty itemIds = comp entire order)
  - `tpv.schema.ts:307-320`: Added `voidItemsSchema` validation with required reason
  - `tpv.schema.ts:322-349`: Added `applyDiscountSchema` validation with percentage range check (1-100)
  - `tpv.routes.ts:2392-2398`: Added DELETE `/venues/:venueId/orders/:orderId/items/:itemId` route
  - `tpv.routes.ts:2449-2455`: Added PATCH `/venues/:venueId/orders/:orderId/guest` route
  - `tpv.routes.ts:2513-2519`: Added POST `/venues/:venueId/orders/:orderId/comp` route with `orders:comp` permission
  - `tpv.routes.ts:2577-2583`: Added POST `/venues/:venueId/orders/:orderId/void` route with `orders:void` permission
  - `tpv.routes.ts:2648-2654`: Added POST `/venues/:venueId/orders/:orderId/discount` route with `orders:discount` permission
  - **WHY**: Enables Square POS-style MenuScreen redesign with 4 tabs (Menu, Check, Actions, Guest)
  - **IMPACT**: Android app can now manage order lifecycle with full audit trail for compliance and reporting

- **abandoned-orders-cleanup.job.ts: Auto-cleanup for abandoned "Pedido rápido" orders** (abandoned-orders-cleanup.job.ts,
  server.ts:21,60,157)

  - **Problem**: When users click "Pedido rápido" then press Back, empty PENDING orders accumulate in the system
  - **Solution**: Cron job that auto-deletes abandoned orders every 15 minutes
  - **Deletion Criteria**:
    - ✅ Order has 0 items (never added anything)
    - ✅ Status = PENDING (not paid)
    - ✅ Created > 30 minutes ago
    - ✅ Type = TAKEOUT (don't delete table orders)
  - **Frequency**: Runs every 15 minutes
  - **Inspiration**: Toast POS uses similar auto-cleanup for "draft orders"
  - **Impact**: Prevents cluttering "Pedidos abiertos" list with abandoned orders
  - **Safety**: Only deletes empty TAKEOUT orders, never deletes table orders or orders with items
  - **Logging**: Logs each deleted order with age and order number
  - **Testing**: Call `abandonedOrdersCleanupJob.cleanupNow()` to manually trigger

- **order.tpv.service.ts: Modifiers support for order items** (order.tpv.service.ts:260-392)

  - Added `modifierIds?: string[]` to `AddOrderItemInput` interface
  - Backend now accepts modifier IDs when adding items to orders
  - Automatically calculates modifier pricing and adds to item total
  - Creates `OrderItemModifier` records linking modifiers to order items
  - Includes modifiers in order responses (`getOrder`, `getOrders`, `addItemsToOrder`)
  - Calculates item total as: `(product price + sum of modifier prices) * quantity`
  - **WHY**: Android app can now persist selected modifiers (BBQ, Chipotle Mayo, Ranch) to database
  - **IMPACT**: Selected modifiers now appear in order panel and receipts

- **Terminal Activation Validation on Login** (2025-01-03)
  - `src/schemas/tpv.schema.ts` (lines 17-22): Added `serialNumber` field to `pinLoginSchema`
  - `src/services/tpv/auth.tpv.service.ts` (lines 69-100): Validate terminal activation status on login
    - Check if terminal exists for the venue
    - Validate `activatedAt` is not null
    - Reject login if terminal status is RETIRED or INACTIVE
    - Return specific error code: `TERMINAL_NOT_ACTIVATED`
  - `src/controllers/tpv/auth.tpv.controller.ts` (lines 18-20): Extract `serialNumber` from request body
  - **WHY**: Prevents unauthorized device access after admin manually deactivates a terminal
  - **BREAKING CHANGE**: Android app MUST now send `serialNumber` in login request

### Fixed

- **product.dashboard.service.ts: CRITICAL - getProducts() not including nested modifiers in response**
  (product.dashboard.service.ts:95-106)

  - **Problem**: Android ProductSelectorBottomSheet showed ModifierGroup name ("Aderezos") but no individual modifiers (BBQ, Chipotle Mayo,
    Ranch) because backend was not including them in API response
  - **Root Cause**: `getProducts()` function had `group: true` instead of nested `group: { include: { modifiers: true } }`
  - **Inconsistency**: `getProduct()` (singular) correctly included modifiers, but `getProducts()` (plural - used by Android) did not
  - **Solution**: Updated Prisma query to match `getProduct()` pattern:
    ```typescript
    modifierGroups: {
      include: {
        group: {
          include: {
            modifiers: {
              orderBy: { displayOrder: 'asc' }
            }
          }
        }
      },
      orderBy: { displayOrder: 'asc' }
    }
    ```
  - **Impact**: Android now receives full modifier data, ProductSelectorBottomSheet displays checkboxes for BBQ, Chipotle Mayo, Ranch when
    clicking "Alitas Buffalo"
  - **Testing**:
    - Click "Alitas Buffalo" on Android → Modal shows "Aderezos" with 3 modifiers
    - API response now includes `modifiers: [{ id, name, priceAdjustment, displayOrder }]` inside each ModifierGroup

- shift.tpv.service.ts: Add real-time calculation of shift totals in getCurrentShift (shift.tpv.service.ts:66-173)

  - **CRITICAL FIX**: Shift totals now update in real-time when payments are recorded
  - Previous behavior: `totalSales`, `totalCardPayments`, etc., only updated when shift was closed
  - TPV was showing "$0" for active shifts even after successful payments
  - Now dynamically calculates totals from all `COMPLETED` payments associated with shift
  - Also calculates `totalOrders` and `totalProductsSold` in real-time
  - Payment method breakdown (cash/card/voucher/other) updated immediately
  - Fix ensures TPV shift screen always displays accurate current totals
  - Impact: Critical user-facing bug - staff could not see their sales during active shift

- payment.tpv.service.ts: Fix rating parsing for numeric strings from Android app (payment.tpv.service.ts:24-39)
  - Updated `mapTpvRatingToNumeric()` to parse numeric strings ("1"-"5") from Android app
  - Previous version only accepted categorical strings ("EXCELLENT", "GOOD", "POOR")
  - Backend was receiving `reviewRating="4"` but returning null, preventing Review record creation
  - Now correctly parses numeric strings and validates range 1-5
  - Backward compatible with legacy categorical format
  - Fix enables Review records to appear in dashboard after Android payment with rating

### Changed

- auth.tpv.service.ts: Switch to plain text PIN authentication (src/services/tpv/auth.tpv.service.ts:26-58)
  - Remove bcrypt comparison logic (removed loop with bcrypt.compare)
  - Use direct Prisma query with plain text PIN matching: `pin: pin`
  - Remove bcrypt import
  - Reduces authentication time (no bcrypt overhead)
  - User requirement: "its only 4 digits and its not critical"
  - Security trade-off: Plain text PINs for simplicity (4-6 digit codes only)

### Security

- ✅ **Terminal Activation Enforcement**: Devices cannot login after manual deactivation
  - Prevents reuse of deactivated terminals
  - Logs warning when login attempted on non-activated terminal
  - Forces re-activation flow through admin dashboard
- ⚠️ Plain text PIN storage: TPV PINs are now stored and compared as plain text (4-6 digits)
  - Generic error message prevents PIN enumeration: "Staff member not found or not authorized"
  - Rate limiting still enforced on backend (10 attempts per 15 min)
  - Decision: User explicitly requested plain text over bcrypt for 4-digit PINs

## [1.0.0] - 2025-01-30

### Added

- Initial release with complete restaurant management backend
- Multi-tenant architecture (Organization → Venue isolation)
- Terminal activation system (Square POS pattern)
- Staff authentication with JWT tokens
- Role-based access control (SUPERADMIN → VIEWER hierarchy)
- Inventory management with FIFO batch tracking
- Order and payment processing
- Real-time Socket.IO integration
- Stripe subscription management

[Unreleased]: https://github.com/yourusername/avoqado-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yourusername/avoqado-server/releases/tag/v1.0.0
