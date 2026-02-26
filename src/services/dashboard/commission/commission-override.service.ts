/**
 * Commission Override Service
 *
 * CRUD operations for staff-specific commission overrides.
 * Overrides take priority over config defaults.
 *
 * Key Business Rules:
 * - Each staff can have ONE active override per config
 * - Overrides can exclude staff from commissions entirely
 * - Date bounds must not overlap for same staff/config
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { validateRate } from './commission-utils'
import { logAction } from '../activity-log.service'

// ============================================
// Type Definitions
// ============================================

export interface CreateCommissionOverrideInput {
  staffId: string
  customRate?: number // As decimal, e.g., 0.05 for 5%
  excludeFromCommissions?: boolean
  notes?: string
  effectiveFrom?: Date
  effectiveTo?: Date | null
}

export interface UpdateCommissionOverrideInput {
  customRate?: number | null
  excludeFromCommissions?: boolean
  notes?: string | null
  effectiveFrom?: Date
  effectiveTo?: Date | null
  active?: boolean
}

// ============================================
// Read Operations
// ============================================

/**
 * Get all overrides for a commission config
 */
export async function getOverridesForConfig(configId: string, venueId: string, includeInactive: boolean = false): Promise<any[]> {
  // Verify config belongs to venue
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  const where: Prisma.CommissionOverrideWhereInput = {
    configId,
  }

  if (!includeInactive) {
    where.active = true
  }

  return prisma.commissionOverride.findMany({
    where,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Get all overrides for a specific staff member across all configs
 */
export async function getOverridesForStaff(staffId: string, venueId: string): Promise<any[]> {
  return prisma.commissionOverride.findMany({
    where: {
      staffId,
      config: {
        venueId,
        deletedAt: null,
      },
      active: true,
    },
    include: {
      config: {
        select: {
          id: true,
          name: true,
          defaultRate: true,
        },
      },
    },
    orderBy: { effectiveFrom: 'desc' },
  })
}

/**
 * Get a single override by ID
 */
export async function getOverrideById(overrideId: string, venueId: string): Promise<any> {
  const override = await prisma.commissionOverride.findFirst({
    where: {
      id: overrideId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      config: {
        select: {
          id: true,
          name: true,
          defaultRate: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!override) {
    throw new NotFoundError(`Commission override ${overrideId} not found`)
  }

  return override
}

// ============================================
// Create Operations
// ============================================

/**
 * Create a new commission override for a staff member
 */
export async function createCommissionOverride(
  configId: string,
  venueId: string,
  data: CreateCommissionOverrideInput,
  createdById: string,
): Promise<any> {
  // Verify config belongs to venue
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  // Verify staff belongs to venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: data.staffId,
      venueId,
      active: true,
    },
  })

  if (!staffVenue) {
    throw new BadRequestError(`Staff ${data.staffId} is not active in venue ${venueId}`)
  }

  // Validate rate if provided
  if (data.customRate !== undefined && data.customRate !== null) {
    validateRate(data.customRate)
  }

  // Must have either customRate or excludeFromCommissions
  if (!data.customRate && !data.excludeFromCommissions) {
    throw new BadRequestError('Must provide either customRate or set excludeFromCommissions to true')
  }

  // Check for overlapping active overrides
  const effectiveFrom = data.effectiveFrom ?? new Date()
  const effectiveTo = data.effectiveTo ?? null

  const overlapping = await checkOverlapOverride(configId, data.staffId, effectiveFrom, effectiveTo)
  if (overlapping) {
    throw new BadRequestError(
      `Overlapping override exists for this staff member from ${overlapping.effectiveFrom} to ${overlapping.effectiveTo ?? 'ongoing'}`,
    )
  }

  // customRate is required - use 0 when excluding from commissions
  const customRate = data.customRate ?? 0

  const override = await prisma.commissionOverride.create({
    data: {
      configId,
      venueId,
      staffId: data.staffId,
      customRate,
      excludeFromCommissions: data.excludeFromCommissions ?? false,
      notes: data.notes,
      effectiveFrom,
      effectiveTo,
      createdById,
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info('Commission override created', {
    overrideId: override.id,
    configId,
    staffId: data.staffId,
    customRate: data.customRate,
    excludeFromCommissions: data.excludeFromCommissions,
    createdById,
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'COMMISSION_OVERRIDE_CREATED',
    entity: 'CommissionOverride',
    entityId: override.id,
    data: { targetStaffId: data.staffId, customRate: data.customRate, excludeFromCommissions: data.excludeFromCommissions },
  })

  return override
}

// ============================================
// Update Operations
// ============================================

/**
 * Update a commission override
 */
export async function updateCommissionOverride(overrideId: string, venueId: string, data: UpdateCommissionOverrideInput): Promise<any> {
  // Verify override exists and belongs to venue
  const existing = await prisma.commissionOverride.findFirst({
    where: {
      id: overrideId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission override ${overrideId} not found`)
  }

  // Validate rate if provided
  if (data.customRate !== undefined && data.customRate !== null) {
    validateRate(data.customRate)
  }

  // Check for date overlap if dates are changing
  if (data.effectiveFrom !== undefined || data.effectiveTo !== undefined) {
    const effectiveFrom = data.effectiveFrom ?? existing.effectiveFrom
    const effectiveTo = data.effectiveTo === undefined ? existing.effectiveTo : data.effectiveTo

    const overlapping = await checkOverlapOverride(
      existing.configId,
      existing.staffId,
      effectiveFrom,
      effectiveTo,
      overrideId, // Exclude self
    )

    if (overlapping) {
      throw new BadRequestError(`Overlapping override exists from ${overlapping.effectiveFrom} to ${overlapping.effectiveTo ?? 'ongoing'}`)
    }
  }

  const updateData: Prisma.CommissionOverrideUpdateInput = {}

  // customRate is required - only update if it's a number, not null
  if (data.customRate !== undefined && data.customRate !== null) {
    updateData.customRate = data.customRate
  }
  if (data.excludeFromCommissions !== undefined) updateData.excludeFromCommissions = data.excludeFromCommissions
  if (data.notes !== undefined) updateData.notes = data.notes
  if (data.effectiveFrom !== undefined) updateData.effectiveFrom = data.effectiveFrom
  if (data.effectiveTo !== undefined) updateData.effectiveTo = data.effectiveTo
  if (data.active !== undefined) updateData.active = data.active

  const override = await prisma.commissionOverride.update({
    where: { id: overrideId },
    data: updateData,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info('Commission override updated', {
    overrideId,
    changes: Object.keys(data),
  })

  logAction({
    venueId,
    action: 'COMMISSION_OVERRIDE_UPDATED',
    entity: 'CommissionOverride',
    entityId: overrideId,
    data: { changes: Object.keys(data) },
  })

  return override
}

// ============================================
// Delete Operations
// ============================================

/**
 * Deactivate a commission override
 */
export async function deactivateOverride(overrideId: string, venueId: string): Promise<void> {
  // Verify override exists and belongs to venue
  const existing = await prisma.commissionOverride.findFirst({
    where: {
      id: overrideId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission override ${overrideId} not found`)
  }

  await prisma.commissionOverride.update({
    where: { id: overrideId },
    data: { active: false },
  })

  logger.info('Commission override deactivated', {
    overrideId,
    venueId,
  })

  logAction({
    venueId,
    action: 'COMMISSION_OVERRIDE_DEACTIVATED',
    entity: 'CommissionOverride',
    entityId: overrideId,
  })
}

/**
 * Delete an override permanently (only if no calculations reference it)
 */
export async function deleteOverride(overrideId: string, venueId: string): Promise<void> {
  // Verify override exists and belongs to venue
  const existing = await prisma.commissionOverride.findFirst({
    where: {
      id: overrideId,
      config: {
        venueId,
        deletedAt: null,
      },
    },
  })

  if (!existing) {
    throw new NotFoundError(`Commission override ${overrideId} not found`)
  }

  await prisma.commissionOverride.delete({
    where: { id: overrideId },
  })

  logger.info('Commission override deleted', {
    overrideId,
    venueId,
  })

  logAction({
    venueId,
    action: 'COMMISSION_OVERRIDE_DELETED',
    entity: 'CommissionOverride',
    entityId: overrideId,
  })
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check for overlapping overrides for the same staff/config
 */
async function checkOverlapOverride(
  configId: string,
  staffId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  excludeId?: string,
): Promise<any | null> {
  const where: Prisma.CommissionOverrideWhereInput = {
    configId,
    staffId,
    active: true,
    // Date overlap logic
    OR: [
      // New range starts during existing range
      {
        effectiveFrom: { lte: effectiveFrom },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
      },
      // New range ends during existing range (if it has an end)
      ...(effectiveTo
        ? [
            {
              effectiveFrom: { lte: effectiveTo },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveTo } }],
            },
          ]
        : []),
      // Existing range is fully inside new range
      {
        effectiveFrom: { gte: effectiveFrom },
        ...(effectiveTo
          ? {
              OR: [{ effectiveTo: null }, { effectiveTo: { lte: effectiveTo } }],
            }
          : {}),
      },
    ],
  }

  if (excludeId) {
    where.id = { not: excludeId }
  }

  return prisma.commissionOverride.findFirst({ where })
}

// ============================================
// Bulk Operations
// ============================================

/**
 * Exclude multiple staff members from commissions
 */
export async function bulkExcludeStaff(
  configId: string,
  venueId: string,
  staffIds: string[],
  createdById: string,
  notes?: string,
): Promise<number> {
  // Verify config belongs to venue
  const config = await prisma.commissionConfig.findFirst({
    where: { id: configId, venueId, deletedAt: null },
  })

  if (!config) {
    throw new NotFoundError(`Commission config ${configId} not found`)
  }

  let created = 0

  for (const staffId of staffIds) {
    try {
      // Check if override already exists
      const existing = await prisma.commissionOverride.findFirst({
        where: {
          configId,
          staffId,
          active: true,
        },
      })

      if (existing) {
        // Update existing to exclude
        await prisma.commissionOverride.update({
          where: { id: existing.id },
          data: { excludeFromCommissions: true },
        })
      } else {
        // Create new exclusion override
        await prisma.commissionOverride.create({
          data: {
            configId,
            venueId,
            staffId,
            customRate: 0, // Required field - 0 when excluding from commissions
            excludeFromCommissions: true,
            notes: notes ?? 'Bulk exclusion',
            createdById,
          },
        })
      }
      created++
    } catch (error) {
      logger.warn('Failed to create exclusion override', {
        configId,
        staffId,
        error,
      })
    }
  }

  logger.info('Bulk staff exclusion completed', {
    configId,
    requested: staffIds.length,
    created,
    createdById,
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'COMMISSION_BULK_EXCLUSION',
    entity: 'CommissionOverride',
    data: { configId, requested: staffIds.length, created },
  })

  return created
}
