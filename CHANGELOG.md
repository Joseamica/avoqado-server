# Changelog

All notable changes to Avoqado Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
