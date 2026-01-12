/**
 * Commission Milestone Service
 *
 * CRUD operations for commission milestones and tracking achievements.
 * Milestones are bonus targets that award extra commission when reached.
 *
 * Key Business Rules:
 * - Milestones have target types (ORDER_QUANTITY, SALES_AMOUNT, etc.)
 * - Bonus can be FIXED_AMOUNT, PERCENTAGE_OF_SALES, or PERCENTAGE_OF_TARGET
 * - Achievements are tracked per staff per period
 * - Once achieved, bonus is added to next commission summary
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, MilestoneTargetType, BonusType, TierPeriod } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { decimalToNumber, getPeriodDateRange } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface CreateMilestoneInput {
  name: string
  description?: string
  targetType: MilestoneTargetType
  targetValue: number
  bonusType: BonusType
  bonusValue: number
  period: TierPeriod
  productId?: string
  categoryId?: string
  effectiveFrom?: Date
  effectiveTo?: Date | null
}

export interface UpdateMilestoneInput {
  name?: string
  description?: string | null
  targetType?: MilestoneTargetType
  targetValue?: number
  bonusType?: BonusType
  bonusValue?: number
  period?: TierPeriod
  productId?: string | null
  categoryId?: string | null
  effectiveFrom?: Date
  effectiveTo?: Date | null
  active?: boolean
}

export interface MilestoneProgress {
  milestoneId: string
  milestoneName: string
  targetType: MilestoneTargetType
  targetValue: number
  currentValue: number
  progressPercentage: number
  achieved: boolean
  achievedAt?: Date
  bonusAmount?: number
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all milestones for a commission config
 */
export async function getMilestonesForConfig(configId: string, venueId: string, includeInactive: boolean = false): Promise<any[]> {
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  const where: Prisma.CommissionMilestoneWhereInput = { configId }
  if (!includeInactive) {
    where.active = true
  }

  return prisma.commissionMilestone.findMany({
    where,
    include: {
      product: {
        select: { id: true, name: true },
      },
      category: {
        select: { id: true, name: true },
      },
      achievements: {
        where: { achievedAt: { not: null } },
        take: 5,
        orderBy: { achievedAt: 'desc' },
      },
    },
    orderBy: { targetValue: 'asc' },
  })
}

/**
 * Get a single milestone by ID
 */
export async function getMilestoneById(milestoneId: string, venueId: string): Promise<any> {
  const milestone = await prisma.commissionMilestone.findFirst({
    where: {
      id: milestoneId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
    include: {
      config: {
        select: { id: true, name: true },
      },
      product: {
        select: { id: true, name: true },
      },
      category: {
        select: { id: true, name: true },
      },
    },
  })

  if (!milestone) {
    throw new NotFoundError(`Milestone ${milestoneId} not found`)
  }

  return milestone
}

// ============================================
// Create Operations
// ============================================

/**
 * Create a new commission milestone
 */
export async function createMilestone(configId: string, venueId: string, data: CreateMilestoneInput): Promise<any> {
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  // Validate product/category requirements
  if (
    (data.targetType === MilestoneTargetType.PRODUCT_QUANTITY ||
      data.targetType === MilestoneTargetType.CATEGORY_QUANTITY ||
      data.targetType === MilestoneTargetType.CATEGORY_AMOUNT) &&
    !data.productId &&
    !data.categoryId
  ) {
    throw new BadRequestError('Product or category ID required for product/category-based milestones')
  }

  // Calculate period dates
  const { start: periodStart, end: periodEnd } = getPeriodDateRange(data.period)

  const milestone = await prisma.commissionMilestone.create({
    data: {
      configId,
      name: data.name,
      description: data.description,
      targetType: data.targetType,
      targetValue: data.targetValue,
      bonusType: data.bonusType,
      bonusValue: data.bonusValue,
      period: data.period,
      periodStart,
      periodEnd,
      productId: data.productId,
      categoryId: data.categoryId,
      effectiveFrom: data.effectiveFrom ?? new Date(),
      effectiveTo: data.effectiveTo,
    },
  })

  logger.info('Commission milestone created', {
    milestoneId: milestone.id,
    configId,
    name: data.name,
    targetType: data.targetType,
  })

  return milestone
}

// ============================================
// Update Operations
// ============================================

/**
 * Update a commission milestone
 */
export async function updateMilestone(milestoneId: string, venueId: string, data: UpdateMilestoneInput): Promise<any> {
  const existing = await prisma.commissionMilestone.findFirst({
    where: {
      id: milestoneId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Milestone ${milestoneId} not found`)
  }

  const updateData: Prisma.CommissionMilestoneUpdateInput = {}

  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.targetType !== undefined) updateData.targetType = data.targetType
  if (data.targetValue !== undefined) updateData.targetValue = data.targetValue
  if (data.bonusType !== undefined) updateData.bonusType = data.bonusType
  if (data.bonusValue !== undefined) updateData.bonusValue = data.bonusValue
  if (data.period !== undefined) updateData.period = data.period
  if (data.productId !== undefined) updateData.product = data.productId ? { connect: { id: data.productId } } : { disconnect: true }
  if (data.categoryId !== undefined) updateData.category = data.categoryId ? { connect: { id: data.categoryId } } : { disconnect: true }
  if (data.effectiveFrom !== undefined) updateData.effectiveFrom = data.effectiveFrom
  if (data.effectiveTo !== undefined) updateData.effectiveTo = data.effectiveTo
  if (data.active !== undefined) updateData.active = data.active

  const milestone = await prisma.commissionMilestone.update({
    where: { id: milestoneId },
    data: updateData,
  })

  logger.info('Commission milestone updated', {
    milestoneId,
    changes: Object.keys(data),
  })

  return milestone
}

// ============================================
// Delete Operations
// ============================================

/**
 * Deactivate a milestone
 */
export async function deactivateMilestone(milestoneId: string, venueId: string): Promise<void> {
  const existing = await prisma.commissionMilestone.findFirst({
    where: {
      id: milestoneId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Milestone ${milestoneId} not found`)
  }

  await prisma.commissionMilestone.update({
    where: { id: milestoneId },
    data: { active: false },
  })

  logger.info('Commission milestone deactivated', { milestoneId, venueId })
}

// ============================================
// Progress Tracking
// ============================================

/**
 * Get milestone progress for a staff member
 */
export async function getStaffMilestoneProgress(staffId: string, venueId: string, configId?: string): Promise<MilestoneProgress[]> {
  // Get active milestones
  const where: Prisma.CommissionMilestoneWhereInput = {
    active: true,
    config: {
      venueId,
      deletedAt: null,
      active: true,
    },
  }

  if (configId) {
    where.configId = configId
  }

  const milestones = await prisma.commissionMilestone.findMany({
    where,
    include: {
      achievements: {
        where: { staffId },
        orderBy: { periodStart: 'desc' },
        take: 1,
      },
    },
  })

  const progressList: MilestoneProgress[] = []

  for (const milestone of milestones) {
    const { start, end } = getPeriodDateRange(milestone.period)

    // Calculate current progress
    const currentValue = await calculateMilestoneProgress(
      staffId,
      venueId,
      milestone.targetType,
      start,
      end,
      milestone.productId,
      milestone.categoryId,
    )

    const targetValue = decimalToNumber(milestone.targetValue)
    const progressPercentage = targetValue > 0 ? Math.min(1, currentValue / targetValue) : 0

    // Check if already achieved this period
    const achievement = milestone.achievements[0]
    const achieved = achievement?.achievedAt !== null && achievement?.periodStart >= start && achievement?.periodEnd <= end

    progressList.push({
      milestoneId: milestone.id,
      milestoneName: milestone.name,
      targetType: milestone.targetType,
      targetValue,
      currentValue,
      progressPercentage,
      achieved,
      achievedAt: achieved ? (achievement?.achievedAt ?? undefined) : undefined,
      bonusAmount: achieved ? decimalToNumber(achievement?.bonusAmount) : undefined,
    })
  }

  return progressList
}

/**
 * Calculate current milestone progress value
 */
async function calculateMilestoneProgress(
  staffId: string,
  venueId: string,
  targetType: MilestoneTargetType,
  startDate: Date,
  endDate: Date,
  productId?: string | null,
  categoryId?: string | null,
): Promise<number> {
  switch (targetType) {
    case MilestoneTargetType.ORDER_QUANTITY: {
      // Count orders created/served by staff
      const count = await prisma.order.count({
        where: {
          venueId,
          OR: [{ createdById: staffId }, { servedById: staffId }],
          createdAt: { gte: startDate, lte: endDate },
          status: { not: 'CANCELLED' },
        },
      })
      return count
    }

    case MilestoneTargetType.SALES_AMOUNT: {
      // Sum of commission base amounts for staff
      const sum = await prisma.commissionCalculation.aggregate({
        where: {
          staffId,
          venueId,
          status: { not: 'VOIDED' },
          calculatedAt: { gte: startDate, lte: endDate },
        },
        _sum: {
          baseAmount: true,
        },
      })
      return decimalToNumber(sum._sum.baseAmount)
    }

    case MilestoneTargetType.PRODUCT_QUANTITY: {
      if (!productId) return 0
      // Count specific product sold by staff
      const items = await prisma.orderItem.aggregate({
        where: {
          productId,
          order: {
            venueId,
            OR: [{ createdById: staffId }, { servedById: staffId }],
            createdAt: { gte: startDate, lte: endDate },
            status: { not: 'CANCELLED' },
          },
        },
        _sum: {
          quantity: true,
        },
      })
      return items._sum.quantity ?? 0
    }

    case MilestoneTargetType.CATEGORY_QUANTITY: {
      if (!categoryId) return 0
      // Count items in category sold by staff
      const items = await prisma.orderItem.aggregate({
        where: {
          product: {
            categoryId,
          },
          order: {
            venueId,
            OR: [{ createdById: staffId }, { servedById: staffId }],
            createdAt: { gte: startDate, lte: endDate },
            status: { not: 'CANCELLED' },
          },
        },
        _sum: {
          quantity: true,
        },
      })
      return items._sum?.quantity ?? 0
    }

    case MilestoneTargetType.CATEGORY_AMOUNT: {
      if (!categoryId) return 0
      // Sum of items in category sold by staff
      const items = await prisma.orderItem.aggregate({
        where: {
          product: {
            categoryId,
          },
          order: {
            venueId,
            OR: [{ createdById: staffId }, { servedById: staffId }],
            createdAt: { gte: startDate, lte: endDate },
            status: { not: 'CANCELLED' },
          },
        },
        _sum: {
          total: true,
        },
      })
      return decimalToNumber(items._sum?.total)
    }

    default:
      return 0
  }
}

/**
 * Check and award milestone if achieved
 * Called after each commission calculation
 */
export async function checkAndAwardMilestones(staffId: string, venueId: string): Promise<void> {
  const progressList = await getStaffMilestoneProgress(staffId, venueId)

  for (const progress of progressList) {
    if (progress.progressPercentage >= 1 && !progress.achieved) {
      // Milestone achieved! Create achievement record
      const milestone = await prisma.commissionMilestone.findUnique({
        where: { id: progress.milestoneId },
      })

      if (!milestone) continue

      const { start, end } = getPeriodDateRange(milestone.period)

      // Calculate bonus amount based on bonus type
      let bonusAmount: number
      const bonusValue = decimalToNumber(milestone.bonusValue)

      switch (milestone.bonusType) {
        case BonusType.FIXED_AMOUNT:
          bonusAmount = bonusValue
          break

        case BonusType.PERCENTAGE_OF_SALES:
          bonusAmount = progress.currentValue * (bonusValue / 100)
          break

        case BonusType.PERCENTAGE_OF_TARGET:
          bonusAmount = progress.targetValue * (bonusValue / 100)
          break

        default:
          bonusAmount = bonusValue
      }

      // Check if achievement already exists for this period
      const existingAchievement = await prisma.milestoneAchievement.findFirst({
        where: {
          milestoneId: milestone.id,
          staffId,
          periodStart: start,
          periodEnd: end,
        },
      })

      if (existingAchievement) {
        // Update existing achievement
        if (!existingAchievement.achievedAt) {
          await prisma.milestoneAchievement.update({
            where: { id: existingAchievement.id },
            data: {
              achievedAt: new Date(),
              achievedValue: progress.currentValue,
              bonusAmount,
            },
          })

          logger.info('Milestone achieved (updated)', {
            milestoneId: milestone.id,
            staffId,
            bonusAmount,
          })
        }
      } else {
        // Create new achievement
        await prisma.milestoneAchievement.create({
          data: {
            milestoneId: milestone.id,
            staffId,
            venueId,
            periodStart: start,
            periodEnd: end,
            currentValue: progress.currentValue,
            achievedValue: progress.currentValue,
            achieved: true,
            achievedAt: new Date(),
            bonusAmount,
          },
        })

        logger.info('Milestone achieved (created)', {
          milestoneId: milestone.id,
          staffId,
          bonusAmount,
        })
      }
    }
  }
}

/**
 * Get staff achievements for a period
 */
export async function getStaffAchievements(staffId: string, venueId: string, startDate?: Date, endDate?: Date): Promise<any[]> {
  const where: Prisma.MilestoneAchievementWhereInput = {
    staffId,
    venueId,
    achievedAt: { not: null },
  }

  if (startDate || endDate) {
    where.achievedAt = {}
    if (startDate) where.achievedAt.gte = startDate
    if (endDate) where.achievedAt.lte = endDate
  }

  return prisma.milestoneAchievement.findMany({
    where,
    include: {
      milestone: {
        select: {
          id: true,
          name: true,
          targetType: true,
          bonusType: true,
        },
      },
    },
    orderBy: { achievedAt: 'desc' },
  })
}
