/**
 * Commission Config Service
 *
 * CRUD operations for commission configurations.
 * Only ADMIN/OWNER can create/update/delete configs.
 *
 * Key Business Rules:
 * - Configs have effectiveFrom/effectiveTo date bounds
 * - Only one config with highest priority is active at any time
 * - Soft delete with audit trail (deletedAt, deletedBy)
 * - Cannot delete config with active calculations
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma, CommissionRecipient, CommissionTrigger, CommissionCalcType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { validateRate, RoleRates } from './commission-utils'

// ============================================
// Type Definitions
// ============================================

export interface CreateCommissionConfigInput {
  name: string
  description?: string
  priority?: number
  recipient?: CommissionRecipient
  trigger?: CommissionTrigger
  calcType?: CommissionCalcType
  defaultRate: number // As decimal, e.g., 0.03 for 3%
  minAmount?: number
  maxAmount?: number
  includeTips?: boolean
  includeDiscount?: boolean
  includeTax?: boolean
  roleRates?: RoleRates
  effectiveFrom?: Date
  effectiveTo?: Date | null
  orgId?: string
}

export interface UpdateCommissionConfigInput {
  name?: string
  description?: string | null
  priority?: number
  recipient?: CommissionRecipient
  trigger?: CommissionTrigger
  calcType?: CommissionCalcType
  defaultRate?: number
  minAmount?: number | null
  maxAmount?: number | null
  includeTips?: boolean
  includeDiscount?: boolean
  includeTax?: boolean
  roleRates?: RoleRates | null
  effectiveFrom?: Date
  effectiveTo?: Date | null
  active?: boolean
}

export interface CommissionConfigFilters {
  active?: boolean
  includeDeleted?: boolean
  effectiveAt?: Date
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all commission configs for a venue
 */
export async function getCommissionConfigs(venueId: string, filters: CommissionConfigFilters = {}): Promise<any[]> {
  const where: Prisma.CommissionConfigWhereInput = {
    venueId,
  }

  // Filter by active status
  if (filters.active !== undefined) {
    where.active = filters.active
  }

  // Exclude deleted unless requested
  if (!filters.includeDeleted) {
    where.deletedAt = null
  }

  // Filter by effective date
  if (filters.effectiveAt) {
    where.effectiveFrom = { lte: filters.effectiveAt }
    where.OR = [{ effectiveTo: null }, { effectiveTo: { gte: filters.effectiveAt } }]
  }

  const configs = await prisma.commissionConfig.findMany({
    where,
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      overrides: {
        where: { active: true },
        select: {
          id: true,
          staffId: true,
          customRate: true,
          excludeFromCommissions: true,
        },
      },
      tiers: {
        where: { active: true },
        orderBy: { tierLevel: 'asc' },
      },
      milestones: {
        where: { active: true },
      },
      _count: {
        select: {
          calculations: true,
        },
      },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  })

  return configs
}

/**
 * Get a single commission config by ID
 */
export async function getCommissionConfigById(configId: string, venueId: string): Promise<any> {
  const config = await prisma.commissionConfig.findFirst({
    where: {
      id: configId,
      venueId,
      deletedAt: null,
    },
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      overrides: {
        where: { active: true },
        include: {
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      tiers: {
        where: { active: true },
        orderBy: { tierLevel: 'asc' },
      },
      milestones: {
        where: { active: true },
      },
      _count: {
        select: {
          calculations: true,
        },
      },
    },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  return config
}

// ============================================
// Create Operations
// ============================================

/**
 * Create a new commission config
 */
export async function createCommissionConfig(venueId: string, data: CreateCommissionConfigInput, createdById: string): Promise<any> {
  // Validate rate
  validateRate(data.defaultRate)

  // Validate role rates if provided
  if (data.roleRates) {
    for (const [_role, rate] of Object.entries(data.roleRates)) {
      validateRate(rate)
    }
  }

  // Validate date range
  if (data.effectiveTo && data.effectiveFrom) {
    if (new Date(data.effectiveTo) <= new Date(data.effectiveFrom)) {
      throw new BadRequestError('effectiveTo must be after effectiveFrom')
    }
  }

  // Validate min/max
  if (data.minAmount !== undefined && data.maxAmount !== undefined) {
    if (data.minAmount > data.maxAmount) {
      throw new BadRequestError('minAmount cannot be greater than maxAmount')
    }
  }

  const config = await prisma.commissionConfig.create({
    data: {
      venueId,
      orgId: data.orgId,
      name: data.name,
      description: data.description,
      priority: data.priority ?? 0,
      recipient: data.recipient ?? CommissionRecipient.SERVER,
      trigger: data.trigger ?? CommissionTrigger.PER_PAYMENT,
      calcType: data.calcType ?? CommissionCalcType.PERCENTAGE,
      defaultRate: data.defaultRate,
      minAmount: data.minAmount,
      maxAmount: data.maxAmount,
      includeTips: data.includeTips ?? false, // Tips NOT included by default
      includeDiscount: data.includeDiscount ?? false,
      includeTax: data.includeTax ?? false,
      roleRates: data.roleRates ?? Prisma.JsonNull,
      effectiveFrom: data.effectiveFrom ?? new Date(),
      effectiveTo: data.effectiveTo,
      createdById,
    },
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info('Commission config created', {
    configId: config.id,
    venueId,
    name: config.name,
    defaultRate: config.defaultRate,
    createdById,
  })

  return config
}

// ============================================
// Update Operations
// ============================================

/**
 * Update a commission config
 *
 * Note: Some fields cannot be changed if calculations exist
 */
export async function updateCommissionConfig(configId: string, venueId: string, data: UpdateCommissionConfigInput): Promise<any> {
  // Verify config exists and belongs to venue
  const existing = await prisma.commissionConfig.findFirst({
    where: {
      id: configId,
      venueId,
      deletedAt: null,
    },
    include: {
      _count: {
        select: { calculations: true },
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  // If calculations exist, some fields are immutable
  const hasCalculations = existing._count.calculations > 0
  const immutableFields = ['defaultRate', 'calcType', 'recipient', 'trigger']

  if (hasCalculations) {
    for (const field of immutableFields) {
      if (data[field as keyof UpdateCommissionConfigInput] !== undefined) {
        throw new BadRequestError(
          `Cannot modify ${field} because this config has ${existing._count.calculations} existing calculations. ` +
            'Create a new config instead.',
        )
      }
    }
  }

  // Validate new rate if provided
  if (data.defaultRate !== undefined) {
    validateRate(data.defaultRate)
  }

  // Validate role rates if provided
  if (data.roleRates) {
    for (const [_role, rate] of Object.entries(data.roleRates)) {
      validateRate(rate)
    }
  }

  // Validate date range
  const effectiveFrom = data.effectiveFrom ?? existing.effectiveFrom
  const effectiveTo = data.effectiveTo === undefined ? existing.effectiveTo : data.effectiveTo

  if (effectiveTo && effectiveFrom) {
    if (new Date(effectiveTo) <= new Date(effectiveFrom)) {
      throw new BadRequestError('effectiveTo must be after effectiveFrom')
    }
  }

  // Build update data
  const updateData: Prisma.CommissionConfigUpdateInput = {}

  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.priority !== undefined) updateData.priority = data.priority
  if (data.recipient !== undefined) updateData.recipient = data.recipient
  if (data.trigger !== undefined) updateData.trigger = data.trigger
  if (data.calcType !== undefined) updateData.calcType = data.calcType
  if (data.defaultRate !== undefined) updateData.defaultRate = data.defaultRate
  if (data.minAmount !== undefined) updateData.minAmount = data.minAmount
  if (data.maxAmount !== undefined) updateData.maxAmount = data.maxAmount
  if (data.includeTips !== undefined) updateData.includeTips = data.includeTips
  if (data.includeDiscount !== undefined) updateData.includeDiscount = data.includeDiscount
  if (data.includeTax !== undefined) updateData.includeTax = data.includeTax
  if (data.roleRates !== undefined) updateData.roleRates = data.roleRates ?? Prisma.JsonNull
  if (data.effectiveFrom !== undefined) updateData.effectiveFrom = data.effectiveFrom
  if (data.effectiveTo !== undefined) updateData.effectiveTo = data.effectiveTo
  if (data.active !== undefined) updateData.active = data.active

  const config = await prisma.commissionConfig.update({
    where: { id: configId },
    data: updateData,
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info('Commission config updated', {
    configId,
    venueId,
    changes: Object.keys(data),
  })

  return config
}

// ============================================
// Delete Operations
// ============================================

/**
 * Soft delete a commission config
 *
 * Sets deletedAt and deactivates the config
 */
export async function softDeleteCommissionConfig(configId: string, venueId: string, deletedById: string): Promise<void> {
  // Verify config exists and belongs to venue
  const existing = await prisma.commissionConfig.findFirst({
    where: {
      id: configId,
      venueId,
      deletedAt: null,
    },
    include: {
      _count: {
        select: {
          calculations: {
            where: {
              status: 'CALCULATED', // Only non-aggregated calculations
            },
          },
        },
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  // Warn if there are pending calculations
  if (existing._count.calculations > 0) {
    logger.warn('Soft deleting config with pending calculations', {
      configId,
      pendingCalculations: existing._count.calculations,
    })
  }

  await prisma.commissionConfig.update({
    where: { id: configId },
    data: {
      active: false,
      deletedAt: new Date(),
      deletedBy: deletedById,
    },
  })

  logger.info('Commission config soft deleted', {
    configId,
    venueId,
    deletedById,
  })
}

// ============================================
// Bulk Operations
// ============================================

/**
 * Copy a commission config from one venue to another (org-level inheritance)
 */
export async function copyCommissionConfig(
  sourceConfigId: string,
  targetVenueId: string,
  createdById: string,
  overrides?: Partial<CreateCommissionConfigInput>,
): Promise<any> {
  const source = await prisma.commissionConfig.findUnique({
    where: { id: sourceConfigId },
    include: {
      tiers: { where: { active: true } },
    },
  })

  if (!source) {
    throw new NotFoundError(`Source config ${sourceConfigId} not found`)
  }

  // Create the new config
  const newConfig = await prisma.$transaction(async tx => {
    const config = await tx.commissionConfig.create({
      data: {
        venueId: targetVenueId,
        orgId: source.orgId,
        name: overrides?.name ?? `${source.name} (Copy)`,
        description: overrides?.description ?? source.description,
        priority: overrides?.priority ?? source.priority,
        recipient: overrides?.recipient ?? source.recipient,
        trigger: overrides?.trigger ?? source.trigger,
        calcType: overrides?.calcType ?? source.calcType,
        defaultRate: overrides?.defaultRate ?? source.defaultRate,
        minAmount: source.minAmount,
        maxAmount: source.maxAmount,
        includeTips: overrides?.includeTips ?? source.includeTips,
        includeDiscount: overrides?.includeDiscount ?? source.includeDiscount,
        includeTax: overrides?.includeTax ?? source.includeTax,
        roleRates: source.roleRates ?? Prisma.JsonNull,
        effectiveFrom: overrides?.effectiveFrom ?? new Date(),
        effectiveTo: overrides?.effectiveTo ?? null,
        createdById,
      },
    })

    // Copy tiers if they exist
    if (source.tiers.length > 0) {
      await tx.commissionTier.createMany({
        data: source.tiers.map(tier => ({
          configId: config.id,
          tierLevel: tier.tierLevel,
          tierName: tier.tierName,
          tierType: tier.tierType,
          minThreshold: tier.minThreshold,
          maxThreshold: tier.maxThreshold,
          rate: tier.rate,
          tierPeriod: tier.tierPeriod,
        })),
      })
    }

    return config
  })

  logger.info('Commission config copied', {
    sourceConfigId,
    newConfigId: newConfig.id,
    targetVenueId,
    createdById,
  })

  return newConfig
}

/**
 * Deactivate all configs for a venue (used when resetting)
 */
export async function deactivateAllConfigs(venueId: string, deactivatedById: string): Promise<number> {
  const result = await prisma.commissionConfig.updateMany({
    where: {
      venueId,
      active: true,
      deletedAt: null,
    },
    data: {
      active: false,
    },
  })

  logger.info('All commission configs deactivated', {
    venueId,
    count: result.count,
    deactivatedById,
  })

  return result.count
}
