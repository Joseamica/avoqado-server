/**
 * Commission Tier Service
 *
 * CRUD operations for commission tiers.
 * Tiers allow progressive commission rates based on performance.
 *
 * Key Business Rules:
 * - Tiers belong to a config and have levels (1, 2, 3...)
 * - Threshold type can be BY_QUANTITY or BY_AMOUNT
 * - Period defines when tiers reset (DAILY, WEEKLY, MONTHLY, etc.)
 * - Higher tier levels have higher rates
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, TierType, TierPeriod, CommissionCalcType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { validateRate, getPeriodDateRange, decimalToNumber } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface CreateCommissionTierInput {
  tierLevel: number
  name: string
  tierType?: TierType
  minThreshold: number
  maxThreshold?: number | null
  rate: number // As decimal, e.g., 0.05 for 5%
  period?: TierPeriod
}

export interface UpdateCommissionTierInput {
  name?: string
  tierType?: TierType
  minThreshold?: number
  maxThreshold?: number | null
  rate?: number
  period?: TierPeriod
  active?: boolean
}

export interface StaffTierProgress {
  staffId: string
  currentValue: number // Current period sales/quantity
  currentTier: number | null
  nextTier: number | null
  progressToNext: number // 0-1 percentage to next tier
  tiers: Array<{
    level: number
    name: string
    minThreshold: number
    rate: number
    achieved: boolean
  }>
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all tiers for a commission config
 */
export async function getTiersForConfig(configId: string, venueId: string, includeInactive: boolean = false): Promise<any[]> {
  // Verify config belongs to venue
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  const where: Prisma.CommissionTierWhereInput = { configId }
  if (!includeInactive) {
    where.active = true
  }

  return prisma.commissionTier.findMany({
    where,
    orderBy: { tierLevel: 'asc' },
  })
}

/**
 * Get a single tier by ID
 */
export async function getTierById(tierId: string, venueId: string): Promise<any> {
  const tier = await prisma.commissionTier.findFirst({
    where: {
      id: tierId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
    include: {
      config: {
        select: {
          id: true,
          name: true,
          calcType: true,
        },
      },
    },
  })

  if (!tier) {
    throw new NotFoundError(`Commission tier ${tierId} not found`)
  }

  return tier
}

// ============================================
// Create Operations
// ============================================

/**
 * Create a new commission tier
 */
export async function createCommissionTier(configId: string, venueId: string, data: CreateCommissionTierInput): Promise<any> {
  // Verify config belongs to venue and is TIERED type
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  if (config.calcType !== CommissionCalcType.TIERED) {
    throw new BadRequestError('Can only add tiers to configs with calcType TIERED')
  }

  // Validate rate
  validateRate(data.rate)

  // Validate thresholds
  if (data.maxThreshold !== undefined && data.maxThreshold !== null) {
    if (data.minThreshold >= data.maxThreshold) {
      throw new BadRequestError('minThreshold must be less than maxThreshold')
    }
  }

  // Check tier level doesn't already exist
  const existingTier = await prisma.commissionTier.findFirst({
    where: {
      configId,
      tierLevel: data.tierLevel,
      active: true,
    },
  })

  if (existingTier) {
    throw new BadRequestError(`Tier level ${data.tierLevel} already exists for this config`)
  }

  // Check for overlapping thresholds
  const overlapping = await checkTierOverlap(configId, data.minThreshold, data.maxThreshold ?? null)
  if (overlapping) {
    throw new BadRequestError(
      `Threshold range overlaps with tier "${overlapping.tierName}" (${overlapping.minThreshold}-${overlapping.maxThreshold ?? '∞'})`,
    )
  }

  const tier = await prisma.commissionTier.create({
    data: {
      configId,
      tierLevel: data.tierLevel,
      tierName: data.name,
      tierType: data.tierType ?? TierType.BY_AMOUNT,
      minThreshold: data.minThreshold,
      maxThreshold: data.maxThreshold,
      rate: data.rate,
      tierPeriod: data.period ?? TierPeriod.MONTHLY,
    },
  })

  logger.info('Commission tier created', {
    tierId: tier.id,
    configId,
    tierLevel: data.tierLevel,
    rate: data.rate,
  })

  return tier
}

/**
 * Create multiple tiers at once (batch)
 */
export async function createTiersBatch(configId: string, venueId: string, tiers: CreateCommissionTierInput[]): Promise<any[]> {
  // Verify config belongs to venue and is TIERED type
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  if (config.calcType !== CommissionCalcType.TIERED) {
    throw new BadRequestError('Can only add tiers to configs with calcType TIERED')
  }

  // Validate all tiers
  const tierLevels = new Set<number>()
  for (const tier of tiers) {
    validateRate(tier.rate)

    if (tierLevels.has(tier.tierLevel)) {
      throw new BadRequestError(`Duplicate tier level: ${tier.tierLevel}`)
    }
    tierLevels.add(tier.tierLevel)
  }

  // Sort by tier level for threshold validation
  const sortedTiers = [...tiers].sort((a, b) => a.tierLevel - b.tierLevel)

  // Validate thresholds don't overlap
  for (let i = 0; i < sortedTiers.length - 1; i++) {
    const current = sortedTiers[i]
    const next = sortedTiers[i + 1]

    const currentMax = current.maxThreshold ?? Infinity
    if (currentMax > next.minThreshold) {
      throw new BadRequestError(
        `Tier ${current.tierLevel} max threshold (${currentMax}) overlaps with tier ${next.tierLevel} min threshold (${next.minThreshold})`,
      )
    }
  }

  // Create all tiers in transaction
  const createdTiers = await prisma.$transaction(
    tiers.map(tier =>
      prisma.commissionTier.create({
        data: {
          configId,
          tierLevel: tier.tierLevel,
          tierName: tier.name,
          tierType: tier.tierType ?? TierType.BY_AMOUNT,
          minThreshold: tier.minThreshold,
          maxThreshold: tier.maxThreshold,
          rate: tier.rate,
          tierPeriod: tier.period ?? TierPeriod.MONTHLY,
        },
      }),
    ),
  )

  logger.info('Commission tiers batch created', {
    configId,
    count: createdTiers.length,
  })

  return createdTiers
}

// ============================================
// Update Operations
// ============================================

/**
 * Update a commission tier
 */
export async function updateCommissionTier(tierId: string, venueId: string, data: UpdateCommissionTierInput): Promise<any> {
  // Verify tier exists and belongs to venue
  const existing = await prisma.commissionTier.findFirst({
    where: {
      id: tierId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission tier ${tierId} not found`)
  }

  // Validate rate if provided
  if (data.rate !== undefined) {
    validateRate(data.rate)
  }

  // Validate thresholds
  const minThreshold = data.minThreshold ?? decimalToNumber(existing.minThreshold)
  const maxThreshold =
    data.maxThreshold === undefined ? (existing.maxThreshold ? decimalToNumber(existing.maxThreshold) : null) : data.maxThreshold

  if (maxThreshold !== null && minThreshold >= maxThreshold) {
    throw new BadRequestError('minThreshold must be less than maxThreshold')
  }

  // Check for overlapping thresholds (excluding self)
  if (data.minThreshold !== undefined || data.maxThreshold !== undefined) {
    const overlapping = await checkTierOverlap(existing.configId, minThreshold, maxThreshold, tierId)
    if (overlapping) {
      throw new BadRequestError(
        `Threshold range overlaps with tier "${overlapping.tierName}" (${overlapping.minThreshold}-${overlapping.maxThreshold ?? '∞'})`,
      )
    }
  }

  const updateData: Prisma.CommissionTierUpdateInput = {}

  if (data.name !== undefined) updateData.tierName = data.name
  if (data.tierType !== undefined) updateData.tierType = data.tierType
  if (data.minThreshold !== undefined) updateData.minThreshold = data.minThreshold
  if (data.maxThreshold !== undefined) updateData.maxThreshold = data.maxThreshold
  if (data.rate !== undefined) updateData.rate = data.rate
  if (data.period !== undefined) updateData.tierPeriod = data.period
  if (data.active !== undefined) updateData.active = data.active

  const tier = await prisma.commissionTier.update({
    where: { id: tierId },
    data: updateData,
  })

  logger.info('Commission tier updated', {
    tierId,
    changes: Object.keys(data),
  })

  return tier
}

// ============================================
// Delete Operations
// ============================================

/**
 * Deactivate a commission tier
 */
export async function deactivateTier(tierId: string, venueId: string): Promise<void> {
  const existing = await prisma.commissionTier.findFirst({
    where: {
      id: tierId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission tier ${tierId} not found`)
  }

  await prisma.commissionTier.update({
    where: { id: tierId },
    data: { active: false },
  })

  logger.info('Commission tier deactivated', { tierId, venueId })
}

/**
 * Delete a tier permanently
 */
export async function deleteTier(tierId: string, venueId: string): Promise<void> {
  const existing = await prisma.commissionTier.findFirst({
    where: {
      id: tierId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission tier ${tierId} not found`)
  }

  await prisma.commissionTier.delete({
    where: { id: tierId },
  })

  logger.info('Commission tier deleted', { tierId, venueId })
}

// ============================================
// Tier Progress Calculation
// ============================================

/**
 * Get staff's current tier progress for a config
 */
export async function getStaffTierProgress(configId: string, staffId: string, venueId: string): Promise<StaffTierProgress | null> {
  // Get config with tiers
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
    include: {
      tiers: {
        where: { active: true },
        orderBy: { tierLevel: 'asc' },
      },
    },
  })

  if (!config || config.tiers.length === 0) {
    return null
  }

  const firstTier = config.tiers[0]
  const { start, end } = getPeriodDateRange(firstTier.tierPeriod)

  // Calculate current period value
  let currentValue: number

  if (firstTier.tierType === TierType.BY_QUANTITY) {
    // Count orders/payments
    const count = await prisma.commissionCalculation.count({
      where: {
        staffId,
        venueId,
        configId,
        status: { not: 'VOIDED' },
        calculatedAt: { gte: start, lte: end },
      },
    })
    currentValue = count
  } else {
    // Sum amounts
    const sum = await prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        configId,
        status: { not: 'VOIDED' },
        calculatedAt: { gte: start, lte: end },
      },
      _sum: {
        baseAmount: true,
      },
    })
    currentValue = decimalToNumber(sum._sum.baseAmount)
  }

  // Determine current and next tier
  let currentTier: number | null = null
  let nextTier: number | null = null

  for (const tier of config.tiers) {
    const min = decimalToNumber(tier.minThreshold)
    const max = tier.maxThreshold ? decimalToNumber(tier.maxThreshold) : Infinity

    if (currentValue >= min && currentValue < max) {
      currentTier = tier.tierLevel
      // Find next tier
      const nextTierData = config.tiers.find(t => t.tierLevel > tier.tierLevel)
      nextTier = nextTierData?.tierLevel ?? null
      break
    }
  }

  // Calculate progress to next tier
  let progressToNext = 0
  if (nextTier !== null) {
    const nextTierData = config.tiers.find(t => t.tierLevel === nextTier)
    if (nextTierData) {
      const nextMin = decimalToNumber(nextTierData.minThreshold)
      const currentTierData = config.tiers.find(t => t.tierLevel === currentTier)
      const currentMin = currentTierData ? decimalToNumber(currentTierData.minThreshold) : 0
      const range = nextMin - currentMin
      progressToNext = range > 0 ? (currentValue - currentMin) / range : 0
    }
  }

  return {
    staffId,
    currentValue,
    currentTier,
    nextTier,
    progressToNext: Math.min(1, Math.max(0, progressToNext)),
    tiers: config.tiers.map(tier => ({
      level: tier.tierLevel,
      name: tier.tierName,
      minThreshold: decimalToNumber(tier.minThreshold),
      rate: decimalToNumber(tier.rate),
      achieved: currentValue >= decimalToNumber(tier.minThreshold),
    })),
  }
}

/**
 * Get the applicable tier rate for a staff member
 */
export async function getApplicableTierRate(
  configId: string,
  staffId: string,
  venueId: string,
): Promise<{ tierLevel: number; tierName: string; rate: number } | null> {
  const progress = await getStaffTierProgress(configId, staffId, venueId)

  if (!progress || progress.currentTier === null) {
    return null
  }

  const tier = progress.tiers.find(t => t.level === progress.currentTier)
  if (!tier) {
    return null
  }

  return {
    tierLevel: tier.level,
    tierName: tier.name,
    rate: tier.rate,
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check for overlapping tier thresholds
 */
async function checkTierOverlap(
  configId: string,
  minThreshold: number,
  maxThreshold: number | null,
  excludeId?: string,
): Promise<any | null> {
  const tiers = await prisma.commissionTier.findMany({
    where: {
      configId,
      active: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  })

  const newMax = maxThreshold ?? Infinity

  for (const tier of tiers) {
    const existingMin = decimalToNumber(tier.minThreshold)
    const existingMax = tier.maxThreshold ? decimalToNumber(tier.maxThreshold) : Infinity

    // Check for overlap
    if (
      (minThreshold >= existingMin && minThreshold < existingMax) ||
      (newMax > existingMin && newMax <= existingMax) ||
      (minThreshold <= existingMin && newMax >= existingMax)
    ) {
      return tier
    }
  }

  return null
}
