/**
 * Commission Utils
 *
 * Helper functions shared across commission services.
 * Follows TransactionCost pattern for financial calculations.
 *
 * Key patterns:
 * - effectiveFrom/effectiveTo date range queries for active configs
 * - Rate cascade: Override > Tier > Role Rate > Default Rate
 * - All rates stored as decimals (0.03 = 3%)
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Decimal } from '@prisma/client/runtime/library'
import { CommissionRecipient, StaffRole, CommissionCalcType, TierType, TierPeriod } from '@prisma/client'

// ============================================
// Type Definitions
// ============================================

export interface RoleRates {
  [role: string]: number // e.g., { "WAITER": 0.03, "CASHIER": 0.02 }
}

export interface CommissionConfigWithRelations {
  id: string
  venueId: string | null
  name: string
  priority: number
  recipient: CommissionRecipient
  calcType: CommissionCalcType
  defaultRate: Decimal
  minAmount: Decimal | null
  maxAmount: Decimal | null
  includeTips: boolean
  includeDiscount: boolean
  includeTax: boolean
  roleRates: RoleRates | null
  effectiveFrom: Date
  effectiveTo: Date | null
  tiers?: CommissionTierData[]
}

export interface CommissionTierData {
  id: string
  tierLevel: number
  tierName: string
  tierType: TierType
  minThreshold: Decimal
  maxThreshold: Decimal | null
  rate: Decimal
  tierPeriod: TierPeriod
}

export interface CommissionOverrideData {
  id: string
  staffId: string
  customRate: Decimal | null
  excludeFromCommissions: boolean
  effectiveFrom: Date
  effectiveTo: Date | null
}

// ============================================
// Rate Validation
// ============================================

/**
 * Validate that a rate is within valid bounds (0-1 inclusive)
 * Commission rates should be between 0% and 100%
 *
 * @param rate - Rate to validate (as decimal, e.g., 0.03 for 3%)
 * @throws Error if rate is invalid
 */
export function validateRate(rate: number): void {
  if (typeof rate !== 'number' || isNaN(rate)) {
    throw new Error(`Invalid commission rate: must be a number, got ${typeof rate}`)
  }
  if (rate < 0 || rate > 1) {
    throw new Error(`Invalid commission rate: ${rate}. Must be between 0 and 1 (0% to 100%)`)
  }
}

/**
 * Parse Decimal to number safely
 */
export function decimalToNumber(value: Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0
  return parseFloat(value.toString())
}

// ============================================
// Active Configuration Lookups
// ============================================

/**
 * Find active commission config for a venue at a given date
 *
 * Rules:
 * - Must be active (not deleted)
 * - effectiveFrom <= date <= effectiveTo (or effectiveTo is null)
 * - If multiple configs match, return the one with highest priority
 *
 * @param venueId - Venue ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active CommissionConfig or null if none found
 */
export async function findActiveCommissionConfig(
  venueId: string,
  effectiveDate: Date = new Date(),
): Promise<CommissionConfigWithRelations | null> {
  // 1. Check venue-level configs first
  const config = await prisma.commissionConfig.findFirst({
    where: {
      venueId,
      active: true,
      deletedAt: null,
      effectiveFrom: { lte: effectiveDate },
      OR: [
        { effectiveTo: null }, // No end date (ongoing)
        { effectiveTo: { gte: effectiveDate } },
      ],
    },
    include: {
      tiers: {
        where: { active: true },
        orderBy: { tierLevel: 'asc' },
      },
    },
    orderBy: {
      priority: 'desc', // Highest priority first
    },
  })

  if (config) {
    const roleRates = config.roleRates as RoleRates | null
    return {
      ...config,
      roleRates,
      tiers: config.tiers as CommissionTierData[],
    }
  }

  // 2. Fallback: check org-level configs
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })

  if (venue?.organizationId) {
    const orgConfig = await prisma.commissionConfig.findFirst({
      where: {
        orgId: venue.organizationId,
        venueId: null, // Org-level configs have no venueId
        active: true,
        deletedAt: null,
        effectiveFrom: { lte: effectiveDate },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: effectiveDate } },
        ],
      },
      include: {
        tiers: {
          where: { active: true },
          orderBy: { tierLevel: 'asc' },
        },
      },
      orderBy: {
        priority: 'desc',
      },
    })

    if (orgConfig) {
      const roleRates = orgConfig.roleRates as RoleRates | null
      return {
        ...orgConfig,
        roleRates,
        tiers: orgConfig.tiers as CommissionTierData[],
      }
    }
  }

  logger.debug('No active commission config found (venue or org)', { venueId, effectiveDate })
  return null
}

/**
 * Find active commission override for a specific staff member
 *
 * @param configId - Commission config ID
 * @param staffId - Staff member ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active CommissionOverride or null
 */
export async function findActiveOverride(
  configId: string,
  staffId: string,
  effectiveDate: Date = new Date(),
): Promise<CommissionOverrideData | null> {
  const override = await prisma.commissionOverride.findFirst({
    where: {
      configId,
      staffId,
      active: true,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
    orderBy: {
      effectiveFrom: 'desc', // Most recent first
    },
  })

  if (!override) {
    return null
  }

  return override as CommissionOverrideData
}

// ============================================
// Staff Recipient Resolution
// ============================================

/**
 * Get the staff ID who should receive the commission based on recipient type
 *
 * Fallback chain for each type:
 * - CREATOR: createdById → processedById (for kiosk mode)
 * - SERVER: servedById → createdById → processedById (for kiosk mode)
 * - PROCESSOR: processedById
 *
 * The final fallback to processedById handles KIOSK MODE where:
 * - Orders have no createdById (created by kiosk itself)
 * - Orders have no servedById (no server in self-service)
 * - But payments DO have processedById (staff who processed the card payment)
 *
 * @param payment - Payment record with order relation
 * @param order - Order record (may be null for direct payments)
 * @param recipientType - Who receives commission (CREATOR, SERVER, PROCESSOR)
 * @returns Staff ID or null if not determinable
 */
export function getRecipientStaffId(
  payment: { processedById: string | null },
  order: { createdById: string | null; servedById: string | null } | null,
  recipientType: CommissionRecipient,
): string | null {
  switch (recipientType) {
    case CommissionRecipient.CREATOR:
      // Order creator (who entered the order)
      // Falls back to payment processor for kiosk mode
      return order?.createdById ?? payment.processedById ?? null

    case CommissionRecipient.SERVER:
      // Order server (who served the customer)
      // Falls back to creator, then to payment processor for kiosk mode
      return order?.servedById ?? order?.createdById ?? payment.processedById ?? null

    case CommissionRecipient.PROCESSOR:
      // Payment processor (who completed the payment)
      return payment.processedById ?? null

    default:
      logger.warn('Unknown commission recipient type', { recipientType })
      return null
  }
}

// ============================================
// Rate Calculation
// ============================================

/**
 * Determine the final commission rate to apply
 *
 * Rate cascade (highest priority first):
 * 1. Staff override (if exists and has customRate)
 * 2. Tier rate (based on current period performance)
 * 3. Role-based rate (from config.roleRates)
 * 4. Default rate (from config.defaultRate)
 *
 * @param config - Commission config
 * @param override - Staff override (may be null)
 * @param staffRole - Staff member's role
 * @param tierRate - Applicable tier rate (may be null)
 * @returns Final rate to apply (as decimal, e.g., 0.03 for 3%)
 */
export function calculateFinalRate(
  config: CommissionConfigWithRelations,
  override: CommissionOverrideData | null,
  staffRole: StaffRole | null,
  tierRate: number | null,
): number {
  // 1. Check override first (highest priority)
  if (override?.customRate) {
    const rate = decimalToNumber(override.customRate)
    logger.debug('Using override rate', { rate, overrideId: override.id })
    return rate
  }

  // 2. Check tier rate (for TIERED calc type)
  if (config.calcType === CommissionCalcType.TIERED && tierRate !== null) {
    logger.debug('Using tier rate', { rate: tierRate })
    return tierRate
  }

  // 3. Check role-based rate
  if (config.roleRates && staffRole && config.roleRates[staffRole]) {
    const rate = config.roleRates[staffRole]
    logger.debug('Using role-based rate', { role: staffRole, rate })
    return rate
  }

  // 4. Fall back to default rate
  const defaultRate = decimalToNumber(config.defaultRate)
  logger.debug('Using default rate', { rate: defaultRate })
  return defaultRate
}

/**
 * Apply min/max bounds to a commission amount
 *
 * @param amount - Calculated commission amount
 * @param config - Commission config with min/max bounds
 * @returns Bounded commission amount
 */
export function applyCommissionBounds(amount: number, config: { minAmount: Decimal | null; maxAmount: Decimal | null }): number {
  let bounded = amount

  const minAmount = decimalToNumber(config.minAmount)
  const maxAmount = decimalToNumber(config.maxAmount)

  if (minAmount > 0 && bounded < minAmount) {
    bounded = minAmount
    logger.debug('Commission clamped to minimum', { original: amount, min: minAmount })
  }

  if (maxAmount > 0 && bounded > maxAmount) {
    bounded = maxAmount
    logger.debug('Commission clamped to maximum', { original: amount, max: maxAmount })
  }

  return bounded
}

// ============================================
// Base Amount Calculation
// ============================================

/**
 * Calculate the base amount for commission calculation
 *
 * @param payment - Payment data
 * @param config - Commission config with inclusion settings
 * @returns Base amount for commission calculation
 */
export function calculateBaseAmount(
  payment: {
    amount: Decimal
    tipAmount?: Decimal | null
    taxAmount?: Decimal | null
    discountAmount?: Decimal | null
  },
  config: {
    includeTips: boolean
    includeDiscount: boolean
    includeTax: boolean
  },
): { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number } {
  // Start with payment amount (subtotal)
  let baseAmount = decimalToNumber(payment.amount)
  const tipAmount = decimalToNumber(payment.tipAmount)
  const taxAmount = decimalToNumber(payment.taxAmount)
  const discountAmount = decimalToNumber(payment.discountAmount)

  // Tips are NOT included by default (tips are already direct bonus for employees)
  if (config.includeTips) {
    baseAmount += tipAmount
  }

  // Tax inclusion
  if (config.includeTax) {
    baseAmount += taxAmount
  }

  // Discount: if includeDiscount is false, we calculate on post-discount amount (default)
  // If includeDiscount is true, we add back the discount to calculate on pre-discount amount
  if (config.includeDiscount) {
    baseAmount += discountAmount
  }

  return {
    baseAmount,
    tipAmount,
    discountAmount,
    taxAmount,
  }
}

// ============================================
// Period Helpers
// ============================================

/**
 * Get the start and end dates for a tier period
 *
 * @param period - TierPeriod enum
 * @param referenceDate - Reference date (defaults to now)
 * @param timezone - Venue timezone (defaults to UTC)
 * @returns { start: Date, end: Date }
 */
export function getPeriodDateRange(
  period: TierPeriod,
  referenceDate: Date = new Date(),
  _timezone: string = 'UTC',
): { start: Date; end: Date } {
  // For simplicity, using UTC. In production, use venue timezone
  const date = new Date(referenceDate)

  let start: Date
  let end: Date

  switch (period) {
    case TierPeriod.DAILY:
      start = new Date(date.setHours(0, 0, 0, 0))
      end = new Date(date.setHours(23, 59, 59, 999))
      break

    case TierPeriod.WEEKLY:
      // Start from Monday
      const dayOfWeek = date.getDay()
      const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)
      start = new Date(date.setDate(diff))
      start.setHours(0, 0, 0, 0)
      end = new Date(start)
      end.setDate(end.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      break

    case TierPeriod.BIWEEKLY:
      // Two weeks from start of year, week 1 starts Jan 1
      const startOfYear = new Date(date.getFullYear(), 0, 1)
      const weekNumber = Math.floor((date.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000))
      const biweekNumber = Math.floor(weekNumber / 2)
      start = new Date(startOfYear.getTime() + biweekNumber * 2 * 7 * 24 * 60 * 60 * 1000)
      start.setHours(0, 0, 0, 0)
      end = new Date(start.getTime() + 13 * 24 * 60 * 60 * 1000)
      end.setHours(23, 59, 59, 999)
      break

    case TierPeriod.MONTHLY:
      start = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0)
      end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
      break

    case TierPeriod.QUARTERLY:
      const quarter = Math.floor(date.getMonth() / 3)
      start = new Date(date.getFullYear(), quarter * 3, 1, 0, 0, 0, 0)
      end = new Date(date.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59, 999)
      break

    case TierPeriod.YEARLY:
      start = new Date(date.getFullYear(), 0, 1, 0, 0, 0, 0)
      end = new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999)
      break

    default:
      // Default to monthly
      start = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0)
      end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
  }

  return { start, end }
}

// ============================================
// Staff Validation
// ============================================

/**
 * Check if a staff member is active and can receive commissions
 *
 * @param staffId - Staff member ID
 * @param venueId - Venue ID
 * @returns Staff data if active, null otherwise
 */
export async function validateStaffForCommission(staffId: string, venueId: string): Promise<{ staffId: string; role: StaffRole } | null> {
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId,
      venueId,
      active: true,
    },
    include: {
      staff: {
        select: {
          id: true,
          active: true,
        },
      },
    },
  })

  if (!staffVenue || !staffVenue.staff.active) {
    logger.debug('Staff not eligible for commission', {
      staffId,
      venueId,
      reason: !staffVenue ? 'No active StaffVenue' : 'Staff not active',
    })
    return null
  }

  return {
    staffId: staffVenue.staffId,
    role: staffVenue.role,
  }
}

// ============================================
// Idempotency Check
// ============================================

/**
 * Check if a commission calculation already exists for a payment
 *
 * @param paymentId - Payment ID
 * @returns true if commission already exists
 */
export async function commissionExistsForPayment(paymentId: string): Promise<boolean> {
  const existing = await prisma.commissionCalculation.findFirst({
    where: {
      paymentId,
      status: { not: 'VOIDED' },
    },
  })

  return existing !== null
}

/**
 * Check if a commission calculation already exists for an order
 *
 * @param orderId - Order ID
 * @returns true if commission already exists
 */
export async function commissionExistsForOrder(orderId: string): Promise<boolean> {
  const existing = await prisma.commissionCalculation.findFirst({
    where: {
      orderId,
      status: { not: 'VOIDED' },
    },
  })

  return existing !== null
}
