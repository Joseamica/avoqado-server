# Changelog

All notable changes to Avoqado Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Backend Option B closure**: new `POST /api/v1/superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve` endpoint + `approveDiscoveredAngelPayMerchant` service. Atomically flips `MerchantAccount.active=true` AND assigns it to a `VenuePaymentConfig` slot (default: PRIMARY; optional body `{slot:'SECONDARY'|'TERTIARY'}`) inside a single `prisma.$transaction`. Mirrors Blumon's auto-attach-on-discovery pattern (Blumon attaches to Terminals via `assignedMerchantIds`; AngelPay is intent-routed and terminal-agnostic, so the equivalent home is `VenuePaymentConfig.{primary,secondary,tertiary}AccountId`). Returns 409 ConflictError if the chosen slot is already occupied by a different merchant (operator must pick another slot or unassign the incumbent first). When no VenuePaymentConfig exists for the venue yet, only PRIMARY-slot approval succeeds (schema requires `primaryAccountId` non-null) — SECONDARY/TERTIARY first-approval returns 400 with a clear hint to seed PRIMARY first. Closes Option B workaround so the admin no longer has to manually wire approved AngelPay merchants into a slot in a second screen.
- **Backend Option B workaround**: new `POST /api/v1/tpv/angelpay/report-discovered-merchants` endpoint + `upsertDiscoveredAngelPayMerchants` service. TPV reports merchants from `AngelPaySDK.getUserMerchants()` after auth; backend idempotently upserts `MerchantAccount` rows (existing rows: refresh display fields only, never flip `active` to respect admin decisions; new rows: `active=false` PENDING_REVIEW with placeholder credentials). Bypasses Task 10's ACTIVE-account gate (by the time TPV calls, the SDK already authenticated). MerchantAccount has no direct `venueId` column — auto-discovered rows enter the global pool and become routable only after admin both approves them and wires them into a `VenuePaymentConfig` slot. Workaround while AngelPay confirms server-to-server merchant listing endpoint availability.

### Changed

- **Backend approve endpoint per-terminal scoping**: `POST /superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve` body now accepts optional `terminalIds: string[]`. When provided non-empty, pushes the merchant ID onto each `Terminal.assignedMerchantIds` (idempotent — skips duplicates) inside the same `prisma.$transaction` that flips `active=true` + writes the VenuePaymentConfig slot. Each terminalId is validated to belong to the same venue (security: prevents cross-venue assignment) and passes through `assertMerchantTerminalCompatible` (Task 11) so e.g. PAX terminal + ANGELPAY merchant rejects with HTTP 409. Empty array or omitted = no per-terminal restriction (merchant available on every brand-compatible terminal in the venue via VenuePaymentConfig inheritance). The terminal config endpoint already honored `assignedMerchantIds` on the READ path (Task 13): non-empty array means "restrict to these IDs", empty means "use venue inheritance". Closes the multi-TPV per-venue scoping gap (e.g. Madre Café with rooftop + cafecito + main floor wants different AngelPay merchants per terminal). Controller dedupes incoming IDs and coerces empty arrays to undefined before forwarding to the service.
- **Backend controller**: `merchantAccount.controller.create` now forwards `req.body.venueId` to `createMerchantAccount()` — unblocks the AngelPay validation gate added in Task 10 (which is a no-op without `venueId`). Existing Blumon callers that don't pass `venueId` keep their exact prior behavior. Wire-through is purely additive: the request body destructure adds `venueId`, the service call passes it through, and 2 unit tests in `tests/unit/controllers/superadmin/merchantAccount.controller.test.ts` cover both the AngelPay (venueId present → forwarded) and Blumon (venueId absent → falsy at the service boundary) paths. Closes Task 17 backend half — paired with dashboard `<AngelPayFields>` + `<DeviceCompatibilityBanner>`.

### Fixed

- **B4Bit currency field name**: `createPaymentOrder` was sending `fiat_currency` + `output_currency` (both undocumented), causing B4Bit to ignore the currency and fall back to its default — orders charged in $25 MXN were rendered as $25 USD on the QR. Per https://docs.b4bit.com/pay/api/endpoints/orders-create/, the documented field is `fiat`. Now sends `fiat: "MXN"` only.

### Changed

- **Backend data migration**: normalized `Terminal.brand` values to canonical set `PAX | NEXGO | INGENICO | VERIFONE`. Migration `20260518011942_normalize_terminal_brand` uppercases and standardizes pre-existing free-text variants (e.g., `pax`, `pax a910s`, `n86` → `PAX`/`NEXGO`). This is the data prerequisite for the upcoming device-provider compatibility validation (Task 10+) which gates AngelPay merchants to NEXGO terminals and Blumon merchants to PAX terminals. Dev DB had 0 Terminal rows at write time — migration is a forward-fix for sandbox/production datasets that may have free-text values.
- **B4Bit crypto auth simplified — fully login-less**: Removed the B4Bit username/password login flow entirely. Per B4Bit docs (https://docs.b4bit.com/pay/api/autenticacion/), the only required header is `X-Device-Id: <api-key-uuid4>` — no `Authorization` header, no signIn endpoint. Changes across three layers:
  - `b4bit.service.ts` (payment path): removed `getAuthToken()`, `cachedAuthToken`, `loginUrl` config, and `Authorization: Token` from `createPaymentOrder`/`getPaymentStatus`
  - `cryptoConfig.dashboard.service.ts` (setup wizard): removed `getAuthData()`, `cachedAuth`, `listB4BitDevices()`, `loginUrl`, `username`/`password` from config, and `Authorization: Token` from `completeCryptoSetup` validation
  - `dashboard.routes.ts` + `cryptoConfig.dashboard.controller.ts`: removed `GET /dashboard/crypto/devices` route + `listDevices` controller
  - Web dashboard (`CryptoConfigSection.tsx`): replaced the "Select device" dropdown (which depended on `signIn`) with a manual Device ID text input where the admin pastes the UUID directly from the B4Bit dashboard. Removed `listDevices()` from `crypto-config.service.ts`
  - **Env vars `B4BIT_USERNAME` and `B4BIT_PASSWORD` are no longer used** — safe to remove from all environments. `secretKey` still used ONLY for webhook HMAC validation

### Added

- **Backend schema**: `AngelPayUserAccount` model + `AngelPayAccountStatus` enum (`PENDING_PIN | ACTIVE | PIN_ROTATION_REQUIRED | SUSPENDED | DELETED`) for per-venue AngelPay credential storage. Design choices: `pinEncrypted` is nullable (null = no PIN provisioned yet, matches `PENDING_PIN` status); FK to `Venue` uses `onDelete: Restrict` (cascade would silently drop the AngelPay credential trail; operator must explicitly transition status to `DELETED` first); no `@@index([venueId])` (redundant with `@unique` constraint). First schema change for the AngelPay SDK 1.0.5 multi-merchant migration (D3 lifecycle). Migration: `20260518010202_add_angelpay_user_account`.
- **Backend schema**: optional display fields on `MerchantAccount` — `angelpayAffiliation` (the affiliation number from AngelPay's `MerchantOption.afiliationNumber`) and `angelpayMerchantName` (display name from `MerchantOption.name`). Both nullable, populated only for AngelPay merchant accounts. The actual AngelPay merchant ID is stored in the existing `externalMerchantId` column (per spec §3.2 — no new typed column required since `externalMerchantId` is already unique per provider).
- **Backend seed**: `PaymentProvider` row for AngelPay (`code: 'ANGELPAY'`, name "Angel Pay", PAYMENT_PROCESSOR, MX). `configSchema` has no required fields — AngelPay merchant IDs ride on the existing `MerchantAccount.externalMerchantId` (which is already required + unique-per-provider); the schema only documents the optional display fields (`angelpayAffiliation`, `angelpayMerchantName`).
- **Backend lib**: `src/lib/providerDeviceCompatibility.ts` — defines the `PROVIDER_DEVICE_COMPATIBILITY` catalog (`BLUMON: ['PAX']`, `ANGELPAY: ['NEXGO']`), the cheap `isProviderCompatibleWithBrand()` predicate (permissive on unknown providers / null brand), and the DB-aware `assertVenueHasCompatibleTerminal()` guard that counts ACTIVE terminals via Prisma. Throws `IncompatibleDeviceError` (new — HTTP 409, code `INCOMPATIBLE_DEVICE`, appended to `src/errors/AppError.ts`) when an AngelPay merchant is being created for a venue that has zero ACTIVE NEXGO terminals (or vice versa for Blumon/PAX). Accepts an optional `Prisma.TransactionClient` so callers can run it inside `prisma.$transaction()`. TDD-driven: 15 unit tests in `tests/unit/lib/providerDeviceCompatibility.test.ts` (mocked-prisma pattern matching the rest of `tests/unit/`). Wired into `createMerchantAccount` in Task 10 and into terminal assignment + brand change in Tasks 11–13.
- **Backend service**: provider↔device compatibility guard wired into `assignMerchantToTerminal` (Task 11, validation point #2 of 4). When code mutates `Terminal.assignedMerchantIds`, the merchant's provider must be compatible with the terminal's brand (e.g., ANGELPAY merchants → NEXGO terminals only). Rejects with `IncompatibleDeviceError` (HTTP 409). Bulk-assign paths emit a single error listing all incompatible merchants for the operator UI. Two helpers added to `src/lib/providerDeviceCompatibility.ts`: `assertMerchantTerminalCompatible(terminalId, merchantId, tx?)` for single-merchant push paths and `assertMerchantsTerminalCompatible(terminalId, merchantIds[], tx?)` for set/replace flows. Wired into the canonical service path (`terminals.superadmin.service.updateTerminal` + `createTerminal`) and 6 bypass paths in the superadmin controllers: `terminal.controller.assignMerchantsToTerminal`, four push sites in `merchantAccount.controller` (Blumon auto-fetch single, Blumon batch auto-fetch, batch assign terminals, Full Setup auto-attach + additional), and `onboarding.controller` terminal create. Auto-attach paths log + skip incompatible terminals (matching serial number from a different brand era should not fail the whole flow); operator-explicit paths fail hard with the error surfaced to the UI. TDD-driven: 5 unit tests in `tests/unit/services/dashboard/terminals.superadmin.deviceCompatibility.test.ts`.
- **Backend service**: `createMerchantAccount` now enforces provider↔device compatibility via `assertVenueHasCompatibleTerminal` (Task 8) — ANGELPAY merchants require a NEXGO terminal in the venue, BLUMON merchants require PAX. Adds AngelPay-specific branch: requires ACTIVE `AngelPayUserAccount`, validates `externalMerchantId` as numeric string (AngelPay merchant IDs are integers), and stores placeholder `encryptCredentials({})` blob in `credentialsEncrypted` (real auth lives on `AngelPayUserAccount`). The compat gate runs only when the new optional `venueId` is supplied on `CreateMerchantAccountData` (existing Blumon callers that omit it keep legacy behavior; callers that include it get the gate for free). Blumon path otherwise unchanged. TDD-driven: 5 unit tests in `tests/unit/services/superadmin/merchantAccount.deviceCompatibility.test.ts` (mocked Prisma + mocked compat helper). Spec §3.1, §4.4.
- **Backend service**: `src/services/superadmin/angelpayUserAccount.service.ts` — 8-function lifecycle CRUD for `AngelPayUserAccount` (D3): `createAngelPayUserAccount` (validates email + optional 6-digit PIN, returns `PENDING_PIN` or `ACTIVE` depending on whether PIN was provided, rejects duplicate venue accounts with `ConflictError`), `setAngelPayUserAccountPin` (encrypts + transitions to `ACTIVE`, clears prior `lastValidationErr` / `statusReason`), `markAngelPayUserAccountRotationRequired` / `suspendAngelPayUserAccount` / `softDeleteAngelPayUserAccount` (status transitions with audit fields), `markAngelPayUserAccountValidated` / `recordAngelPayUserAccountError` (TPV-side validation reporting — status unchanged), `getAngelPayUserAccountForTerminal` (terminal → venue → account join). PIN encryption reuses `encryptCredentials` from `merchantAccount.service.ts` (now exported) for a single canonical credentials-at-rest format. Standalone-exported-function style matches the rest of `services/superadmin/`. TDD-driven: 14 unit tests in `tests/unit/services/superadmin/angelpayUserAccount.service.test.ts` (mocked Prisma + mocked encryption helper).
- **B4Bit minimum amount validation**: `initiateCryptoPayment` now rejects orders below $20 MXN (2000 centavos) with a clear error `El monto mínimo para pagar con cripto es $20 MXN`. Prevents confusing validation errors from B4Bit's API when merchants try to charge small amounts
- **Backend endpoint**: `/api/v1/tpv/terminals/:serialNumber/config` now (a) filters returned `merchants[]` to only providers compatible with `terminal.brand` (validation point #4 of 4 — runtime gate / defense in depth), and (b) includes a new optional `angelpayAuth` payload `{ accountId, email, pin, environment }` when the terminal is NEXGO and the venue has an ACTIVE `AngelPayUserAccount`. PIN is decrypted server-side and transported over TLS; never logged or persisted on the TPV (see spec §4.5b PIN handling rules). Merchant DTO extended additively with `externalMerchantId`, `isActive`, `angelpayAffiliation`, `angelpayMerchantName` per spec §6.4. `decryptCredentials` in `src/services/superadmin/merchantAccount.service.ts` was exported (it already existed but was internal). TDD-driven: 4 unit tests in `tests/unit/controllers/tpv/terminal.tpv.angelpay.test.ts` (mocked Prisma + mocked compat/decrypt/account helpers). Spec §3.1 (point 2d), §4.4, §4.5, §4.5b, §6.4.
- **Backend endpoints (superadmin)**: 6 new endpoints exposing `AngelPayUserAccountService` to the dashboard for Phase 2 UI (Task 15): `GET /superadmin/venues/:venueId/angelpay-account`, `POST .../angelpay-account` (create), `PATCH /superadmin/angelpay-accounts/:id/pin` (rotate PIN, transitions to ACTIVE), `PATCH .../:id/status` (single endpoint dispatched by body.status to `markAngelPayUserAccountRotationRequired` or `suspendAngelPayUserAccount` — keeps dashboard symmetric), `DELETE .../:id` (soft delete). All gated by the existing superadmin auth + role middleware (no new middleware needed); response payloads strip `pinEncrypted` so ciphertext never crosses the wire. Two new service helpers (`getAngelPayUserAccountByVenueId`, `getAngelPayUserAccountById`) added to support 404-before-mutation. New controller `src/controllers/superadmin/angelpayUserAccount.controller.ts` + routes `src/routes/superadmin/angelpayUserAccount.routes.ts` mounted at the superadmin router root so both venue-scoped (`/venues/:venueId/angelpay-account`) and id-scoped (`/angelpay-accounts/:id/...`) paths live in one file. TDD-driven: 10 unit tests in `tests/unit/controllers/superadmin/angelpayUserAccount.controller.test.ts` covering happy paths + 404 + 400 dispatch failures.
- **Backend endpoints**: two new TPV report endpoints (Task 14, closes backend Phase 1). `POST /api/v1/tpv/angelpay/report-validation` accepts `{ accountId, state, ... }` and updates the corresponding `AngelPayUserAccount` (`markAngelPayUserAccountValidated` on AUTHENTICATED with `externalUserId`, `recordAngelPayUserAccountError` on AUTH_ERROR or CONFIG_MISMATCH with structured `missingInAvoqado` / `missingInSdk` diff). `POST /api/v1/tpv/angelpay/report-merchant-switch` accepts `{ fromMerchantId, toMerchantId, durationMs }` and emits a structured audit log line (no DB writes — switch events live in logs/observability tooling for now per spec §8.2). Both routes require terminal-auth via `authenticateTokenMiddleware` (JWT carries `terminalSerialNumber` in `req.authContext`) and return 204 on success; bad state / missing required fields surface as `BadRequestError` (HTTP 400) through the standard error handler. TDD-driven: 9 unit tests in `tests/unit/controllers/tpv/angelpayValidation.tpv.controller.test.ts` (mocked service). Spec §4.6, §8.2.

### Fixed

- **Recent customers endpoint**: Removed `lastVisitAt: { not: null }` filter from `getRecentCustomers` — new customers with no visits were
  excluded. Now returns all active customers, ordered by most recent visit first (nulls last), then by creation date
- **Command Center timezone bugs**: All date boundary calculations in `commandCenter.service.ts` now use venue timezone instead of UTC.
  Affected methods: `getSummary()`, `getInsights()`, `getTopSellers()`, `getCategoryBreakdown()`, `getStockVsSales()`. "Today", "this week",
  and "this month" now correctly correspond to the venue's local midnight rather than UTC midnight. Raw SQL date grouping in sales trend
  also uses venue timezone so late-night sales are attributed to the correct local day
- **Commission system timezone bugs**: `getPeriodDateRange()` in `commission-utils.ts` now uses venue timezone instead of UTC for all period
  boundaries (DAILY, WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY). The `_timezone` parameter was unused (defaulting to UTC) — now renamed
  to `timezone` with `DEFAULT_TIMEZONE` default. All callers updated: `commission-aggregation.service.ts`, `commission-tier.service.ts`,
  `commission-milestone.service.ts`. Staff commission stats in `commission-calculation.service.ts` also fixed (thisMonthStart/lastMonth
  boundaries)
- **Sales goal timezone bugs**: `calculateCurrentSales()` in `sales-goal.service.ts` and `goal-resolution.service.ts` now uses venue
  timezone for date boundaries. Previously used `new Date()` (UTC midnight = 6pm Mexico), causing daily goals to reset mid-afternoon

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
