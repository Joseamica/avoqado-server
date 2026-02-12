/**
 * Goal Resolution Service
 *
 * Resolves the effective sales goals for a venue using the inheritance pattern:
 * 1. If venue has its own goals (VenueModule.config.salesGoals) → use those
 * 2. If venue has NO goals → fall back to OrganizationSalesGoalConfig
 *
 * Same pattern as getEffectivePaymentConfig() in organization-payment-config.service.ts
 */

import prisma from '../../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import { MODULE_CODES } from '../../modules/module.service'
import { NotFoundError, BadRequestError } from '../../../errors/AppError'
import type { SalesGoal, SalesGoalPeriod, SalesGoalType } from './sales-goal.service'

// ==========================================
// TYPES
// ==========================================

export type GoalSource = 'venue' | 'organization'

export interface ResolvedGoal extends SalesGoal {
  source: GoalSource
}

export interface OrgGoalInput {
  goal: number
  goalType?: SalesGoalType
  period?: SalesGoalPeriod
}

export interface OrgGoalUpdateInput {
  goal?: number
  goalType?: SalesGoalType
  period?: SalesGoalPeriod
  active?: boolean
}

// Storage format in VenueModule.config.salesGoals (duplicated from sales-goal.service to avoid circular deps)
interface StoredSalesGoal {
  id: string
  staffId: string | null
  goal: number
  goalType: SalesGoalType
  period: SalesGoalPeriod
  active: boolean
  createdAt: string
  updatedAt: string
}

// ==========================================
// HELPERS
// ==========================================

function getSalesGoalsFromConfig(config: Prisma.JsonValue): StoredSalesGoal[] {
  if (!config || typeof config !== 'object') return []
  const configObj = config as Record<string, unknown>
  if (!Array.isArray(configObj.salesGoals)) return []
  return configObj.salesGoals as StoredSalesGoal[]
}

/**
 * Calculate current sales for a goal based on period and goal type
 */
async function calculateCurrentSales(venueId: string, period: SalesGoalPeriod, goalType: SalesGoalType = 'AMOUNT'): Promise<number> {
  const now = new Date()
  let startDate: Date

  switch (period) {
    case 'DAILY':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
      break
    case 'WEEKLY': {
      const dayOfWeek = now.getDay()
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek, 0, 0, 0)
      break
    }
    case 'MONTHLY':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
      break
  }

  if (goalType === 'QUANTITY') {
    const count = await prisma.orderItem.count({
      where: {
        order: {
          venueId,
          status: 'COMPLETED',
          createdAt: { gte: startDate },
        },
      },
    })
    return count
  }

  // AMOUNT: sum of payment amounts
  const result = await prisma.payment.aggregate({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: { gte: startDate },
    },
    _sum: { amount: true },
  })

  return result._sum.amount?.toNumber() || 0
}

/**
 * Get organizationId from venueId
 */
async function getOrgIdFromVenue(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })
  if (!venue) throw new NotFoundError('Venue not found')
  return venue.organizationId
}

// ==========================================
// RESOLUTION
// ==========================================

/**
 * Get effective goals for a venue.
 * Returns venue goals if any exist, otherwise falls back to org-level goals.
 */
export async function getEffectiveGoals(venueId: string): Promise<ResolvedGoal[]> {
  // 1. Check venue-level goals
  const module = await prisma.module.findUnique({
    where: { code: MODULE_CODES.SERIALIZED_INVENTORY },
  })

  if (module) {
    const venueModule = await prisma.venueModule.findUnique({
      where: {
        venueId_moduleId: {
          venueId,
          moduleId: module.id,
        },
      },
    })

    if (venueModule) {
      const venueGoals = getSalesGoalsFromConfig(venueModule.config).filter(g => g.active)
      if (venueGoals.length > 0) {
        // Venue has its own goals — use those (venue wins)
        const enriched = await Promise.all(
          venueGoals.map(async (g): Promise<ResolvedGoal> => {
            const currentSales = await calculateCurrentSales(venueId, g.period, g.goalType || 'AMOUNT')
            return {
              id: g.id,
              venueId,
              staffId: g.staffId,
              goal: g.goal,
              goalType: g.goalType || 'AMOUNT',
              period: g.period,
              currentSales,
              active: g.active,
              createdAt: g.createdAt,
              updatedAt: g.updatedAt,
              source: 'venue',
            }
          }),
        )
        return enriched
      }
    }
  }

  // 2. Fallback: org-level goals
  const organizationId = await getOrgIdFromVenue(venueId)

  const orgGoals = await prisma.organizationSalesGoalConfig.findMany({
    where: {
      organizationId,
      active: true,
    },
  })

  if (orgGoals.length === 0) return []

  const enriched = await Promise.all(
    orgGoals.map(async (g): Promise<ResolvedGoal> => {
      const currentSales = await calculateCurrentSales(venueId, g.period as SalesGoalPeriod, g.goalType as SalesGoalType)
      return {
        id: g.id,
        venueId,
        staffId: null, // Org goals are always venue-wide
        goal: g.goal.toNumber(),
        goalType: g.goalType as SalesGoalType,
        period: g.period as SalesGoalPeriod,
        currentSales,
        active: g.active,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        source: 'organization',
      }
    }),
  )

  return enriched
}

// ==========================================
// ORG-LEVEL GOAL CRUD
// ==========================================

/**
 * Get all org-level goals for the organization that owns this venue
 */
export async function getOrgGoals(venueId: string): Promise<ResolvedGoal[]> {
  const organizationId = await getOrgIdFromVenue(venueId)

  const orgGoals = await prisma.organizationSalesGoalConfig.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  })

  return Promise.all(
    orgGoals.map(async (g): Promise<ResolvedGoal> => {
      const currentSales = await calculateCurrentSales(venueId, g.period as SalesGoalPeriod, g.goalType as SalesGoalType)
      return {
        id: g.id,
        venueId,
        staffId: null,
        goal: g.goal.toNumber(),
        goalType: g.goalType as SalesGoalType,
        period: g.period as SalesGoalPeriod,
        currentSales,
        active: g.active,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        source: 'organization',
      }
    }),
  )
}

/**
 * Create an org-level sales goal
 */
export async function createOrgGoal(venueId: string, input: OrgGoalInput): Promise<ResolvedGoal> {
  const organizationId = await getOrgIdFromVenue(venueId)

  const goalType = input.goalType || 'AMOUNT'
  const period = input.period || 'MONTHLY'

  // Check for duplicate (same period + goalType)
  const existing = await prisma.organizationSalesGoalConfig.findUnique({
    where: {
      organizationId_period_goalType: {
        organizationId,
        period,
        goalType,
      },
    },
  })

  if (existing) {
    throw new BadRequestError('An org goal with this period and type already exists')
  }

  const created = await prisma.organizationSalesGoalConfig.create({
    data: {
      organizationId,
      goal: input.goal,
      goalType,
      period,
    },
  })

  const currentSales = await calculateCurrentSales(venueId, period as SalesGoalPeriod, goalType as SalesGoalType)

  return {
    id: created.id,
    venueId,
    staffId: null,
    goal: created.goal.toNumber(),
    goalType: created.goalType as SalesGoalType,
    period: created.period as SalesGoalPeriod,
    currentSales,
    active: created.active,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
    source: 'organization',
  }
}

/**
 * Update an org-level sales goal
 */
export async function updateOrgGoal(venueId: string, goalId: string, input: OrgGoalUpdateInput): Promise<ResolvedGoal> {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Verify goal belongs to this org
  const existing = await prisma.organizationSalesGoalConfig.findFirst({
    where: { id: goalId, organizationId },
  })
  if (!existing) {
    throw new NotFoundError('Org goal not found')
  }

  const updated = await prisma.organizationSalesGoalConfig.update({
    where: { id: goalId },
    data: {
      ...(input.goal !== undefined && { goal: input.goal }),
      ...(input.goalType !== undefined && { goalType: input.goalType }),
      ...(input.period !== undefined && { period: input.period }),
      ...(input.active !== undefined && { active: input.active }),
    },
  })

  const currentSales = await calculateCurrentSales(venueId, updated.period as SalesGoalPeriod, updated.goalType as SalesGoalType)

  return {
    id: updated.id,
    venueId,
    staffId: null,
    goal: updated.goal.toNumber(),
    goalType: updated.goalType as SalesGoalType,
    period: updated.period as SalesGoalPeriod,
    currentSales,
    active: updated.active,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    source: 'organization',
  }
}

/**
 * Delete an org-level sales goal
 */
export async function deleteOrgGoal(venueId: string, goalId: string): Promise<void> {
  const organizationId = await getOrgIdFromVenue(venueId)

  const existing = await prisma.organizationSalesGoalConfig.findFirst({
    where: { id: goalId, organizationId },
  })
  if (!existing) {
    throw new NotFoundError('Org goal not found')
  }

  await prisma.organizationSalesGoalConfig.delete({
    where: { id: goalId },
  })
}
