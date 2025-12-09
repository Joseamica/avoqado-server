/**
 * VenueStatus Constants
 *
 * Centralized constants for venue status checks across the application.
 * Single source of truth for venue lifecycle management.
 *
 * This ensures consistent behavior in:
 * - TPV auth (staffSignIn, refreshToken)
 * - Dashboard auth (loginStaff, switchVenue)
 * - SDK auth (e-commerce merchants)
 * - Socket auth (real-time connections)
 * - Stripe webhooks (feature activation)
 * - Demo cleanup (live demo sessions)
 *
 * Status Categories:
 * 1. DEMO_STATUSES: Ephemeral venues that CAN be deleted (fake data)
 * 2. PRODUCTION_STATUSES: Real venues that CANNOT be deleted (SAT compliance)
 * 3. OPERATIONAL_STATUSES: Venues that can accept logins and process payments
 * 4. NON_OPERATIONAL_STATUSES: Venues blocked from operations
 */

import { VenueStatus } from '@prisma/client'

// =============================================================================
// DEMO vs PRODUCTION Classification
// =============================================================================

/**
 * Demo venue statuses - ephemeral venues with fake data.
 * These venues CAN be hard deleted (no SAT retention requirement).
 *
 * - LIVE_DEMO: Public demo.dashboard.avoqado.io (anonymous, auto-cleanup)
 * - TRIAL: Private onboarding demo (30-day trial, user registered)
 */
export const DEMO_VENUE_STATUSES: VenueStatus[] = [VenueStatus.LIVE_DEMO, VenueStatus.TRIAL]

/**
 * Production venue statuses - real merchant venues.
 * These venues CANNOT be hard deleted (Mexican SAT requires data retention).
 * Use CLOSED status instead of deletion.
 */
export const PRODUCTION_VENUE_STATUSES: VenueStatus[] = [
  VenueStatus.ONBOARDING,
  VenueStatus.PENDING_ACTIVATION,
  VenueStatus.ACTIVE,
  VenueStatus.SUSPENDED,
  VenueStatus.ADMIN_SUSPENDED,
  VenueStatus.CLOSED,
]

// =============================================================================
// OPERATIONAL Classification
// =============================================================================

/**
 * Venue statuses that allow normal operations.
 * Venues with these statuses can:
 * - Accept TPV logins
 * - Accept Dashboard logins
 * - Process SDK payments
 * - Maintain socket connections
 * - Receive Stripe webhook updates
 *
 * NOTE: LIVE_DEMO is operational (anonymous access allowed)
 * NOTE: TRIAL is operational (registered user exploring)
 */
export const OPERATIONAL_VENUE_STATUSES: VenueStatus[] = [
  // Demo statuses (operational for exploration)
  VenueStatus.LIVE_DEMO,
  VenueStatus.TRIAL,
  // Production statuses (operational for business)
  VenueStatus.ONBOARDING,
  VenueStatus.PENDING_ACTIVATION,
  VenueStatus.ACTIVE,
]

/**
 * Venue statuses that block operations.
 * Venues with these statuses cannot:
 * - Accept new logins
 * - Process payments
 * - Maintain active connections
 */
export const NON_OPERATIONAL_VENUE_STATUSES: VenueStatus[] = [VenueStatus.SUSPENDED, VenueStatus.ADMIN_SUSPENDED, VenueStatus.CLOSED]

// =============================================================================
// ANALYTICS Classification
// =============================================================================

/**
 * Statuses that count for real business metrics.
 * Excludes all demo venues (LIVE_DEMO, TRIAL).
 * Used by superadmin dashboard to show accurate KPIs.
 */
export const ANALYTICS_VENUE_STATUSES: VenueStatus[] = [
  VenueStatus.PENDING_ACTIVATION,
  VenueStatus.ACTIVE,
  VenueStatus.SUSPENDED,
  VenueStatus.ADMIN_SUSPENDED,
  VenueStatus.CLOSED,
]

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a venue status allows operations (login, payments, etc.)
 */
export function isVenueOperational(status: VenueStatus): boolean {
  return OPERATIONAL_VENUE_STATUSES.includes(status)
}

/**
 * Check if a venue is a demo (can be deleted)
 */
export function isDemoVenue(status: VenueStatus): boolean {
  return DEMO_VENUE_STATUSES.includes(status)
}

/**
 * Check if a venue is a production venue (cannot be deleted, SAT retention)
 */
export function isProductionVenue(status: VenueStatus): boolean {
  return PRODUCTION_VENUE_STATUSES.includes(status)
}

/**
 * Check if a venue can be hard deleted.
 * Only DEMO venues can be deleted; production venues must use CLOSED status.
 */
export function canDeleteVenue(status: VenueStatus): boolean {
  return DEMO_VENUE_STATUSES.includes(status)
}

/**
 * Check if a venue is the public live demo (anonymous access)
 */
export function isLiveDemoVenue(status: VenueStatus): boolean {
  return status === VenueStatus.LIVE_DEMO
}

/**
 * Check if a venue is an onboarding trial demo
 */
export function isTrialVenue(status: VenueStatus): boolean {
  return status === VenueStatus.TRIAL
}

/**
 * Check if a venue requires KYC verification.
 * Demo venues (LIVE_DEMO, TRIAL) do NOT require KYC.
 */
export function requiresKYC(status: VenueStatus): boolean {
  return !DEMO_VENUE_STATUSES.includes(status)
}

/**
 * Check if a venue should be included in analytics/metrics.
 * Excludes demo venues to show accurate business KPIs.
 */
export function includeInAnalytics(status: VenueStatus): boolean {
  return ANALYTICS_VENUE_STATUSES.includes(status)
}
