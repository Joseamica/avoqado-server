/**
 * Sales Goal Service
 *
 * Manages sales goals for venues/staff using VenueModule config storage.
 * Goals are stored in VenueModule.config.salesGoals array.
 *
 * This approach:
 * - Works without schema changes
 * - Supports multiple goals per venue
 * - Supports both venue-wide and per-staff goals
 * - Integrates with existing module system
 */

import prisma from '../../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import { MODULE_CODES } from '../../modules/module.service'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'

// ==========================================
// TYPES
// ==========================================

export type SalesGoalPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY'
export type SalesGoalType = 'AMOUNT' | 'QUANTITY'

export interface SalesGoal {
  id: string
  venueId: string
  staffId: string | null // null = venue-wide goal
  goal: number
  goalType: SalesGoalType // 'AMOUNT' = currency target, 'QUANTITY' = unit count target
  period: SalesGoalPeriod
  currentSales: number // Calculated dynamically (amount or count depending on goalType)
  active: boolean
  createdAt: string
  updatedAt: string
  staff?: {
    id: string
    firstName: string
    lastName: string
  } | null
}

export interface CreateSalesGoalInput {
  staffId?: string | null
  goal: number
  goalType?: SalesGoalType // Defaults to 'AMOUNT' for backward compatibility
  period: SalesGoalPeriod
}

export interface UpdateSalesGoalInput {
  goal?: number
  goalType?: SalesGoalType
  period?: SalesGoalPeriod
  active?: boolean
}

// Storage format in VenueModule.config.salesGoals
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
// HELPER FUNCTIONS
// ==========================================

/**
 * Get or create VenueModule for SERIALIZED_INVENTORY
 */
async function getOrCreateVenueModule(venueId: string) {
  // Find the SERIALIZED_INVENTORY module
  const module = await prisma.module.findUnique({
    where: { code: MODULE_CODES.SERIALIZED_INVENTORY },
  })

  if (!module) {
    throw new BadRequestError('SERIALIZED_INVENTORY module not found')
  }

  // Find or create VenueModule
  let venueModule = await prisma.venueModule.findUnique({
    where: {
      venueId_moduleId: {
        venueId,
        moduleId: module.id,
      },
    },
  })

  if (!venueModule) {
    // Check if module is enabled at org level
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) {
      throw new NotFoundError('Venue not found')
    }

    const orgModule = await prisma.organizationModule.findFirst({
      where: {
        organizationId: venue.organizationId,
        moduleId: module.id,
        enabled: true,
      },
    })

    if (!orgModule) {
      throw new BadRequestError('SERIALIZED_INVENTORY module is not enabled for this venue')
    }

    // Create VenueModule to store venue-specific config (like goals)
    venueModule = await prisma.venueModule.create({
      data: {
        venueId,
        moduleId: module.id,
        enabled: true,
        config: { salesGoals: [] },
        enabledBy: 'system',
      },
    })
  }

  return venueModule
}

/**
 * Get sales goals array from VenueModule config
 */
function getSalesGoalsFromConfig(config: Prisma.JsonValue): StoredSalesGoal[] {
  if (!config || typeof config !== 'object') return []
  const configObj = config as Record<string, unknown>
  if (!Array.isArray(configObj.salesGoals)) return []
  return configObj.salesGoals as StoredSalesGoal[]
}

/**
 * Calculate current sales for a goal based on period and goal type
 * - AMOUNT: sums Payment.amount (currency total)
 * - QUANTITY: counts order items (units/products sold)
 */
async function calculateCurrentSales(
  venueId: string,
  staffId: string | null,
  period: SalesGoalPeriod,
  goalType: SalesGoalType = 'AMOUNT',
): Promise<number> {
  const now = new Date()
  let startDate: Date

  switch (period) {
    case 'DAILY':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
      break
    case 'WEEKLY':
      // Start of week (Sunday)
      const dayOfWeek = now.getDay()
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek, 0, 0, 0)
      break
    case 'MONTHLY':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
      break
  }

  // Query payments
  const whereClause: Prisma.PaymentWhereInput = {
    venueId,
    status: 'COMPLETED',
    createdAt: {
      gte: startDate,
    },
  }

  // If staffId is provided, filter by the staff who processed the payment
  if (staffId) {
    whereClause.processedById = staffId
  }

  if (goalType === 'QUANTITY') {
    // Count order items (units sold) from completed orders in this venue/period
    const count = await prisma.orderItem.count({
      where: {
        order: {
          venueId,
          status: 'COMPLETED',
          createdAt: { gte: startDate },
          ...(staffId ? { payments: { some: { processedById: staffId } } } : {}),
        },
      },
    })
    return count
  }

  // AMOUNT: sum of payment amounts
  const result = await prisma.payment.aggregate({
    where: whereClause,
    _sum: {
      amount: true,
    },
  })

  return result._sum.amount?.toNumber() || 0
}

/**
 * Enrich stored goal with staff info and calculated currentSales
 */
async function enrichGoal(venueId: string, storedGoal: StoredSalesGoal): Promise<SalesGoal> {
  let staff = null
  if (storedGoal.staffId) {
    const staffRecord = await prisma.staff.findUnique({
      where: { id: storedGoal.staffId },
      select: { id: true, firstName: true, lastName: true },
    })
    staff = staffRecord
  }

  const goalType = storedGoal.goalType || 'AMOUNT' // Backward compat: old goals default to AMOUNT
  const currentSales = await calculateCurrentSales(venueId, storedGoal.staffId, storedGoal.period, goalType)

  return {
    ...storedGoal,
    goalType,
    venueId,
    currentSales,
    staff,
  }
}

// ==========================================
// SERVICE FUNCTIONS
// ==========================================

/**
 * Get all sales goals for a venue
 */
export async function getSalesGoals(venueId: string, options?: { includeInactive?: boolean }): Promise<SalesGoal[]> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Filter inactive if needed
  const filteredGoals = options?.includeInactive ? storedGoals : storedGoals.filter(g => g.active)

  // Enrich with staff info and calculated sales
  const enrichedGoals = await Promise.all(filteredGoals.map(goal => enrichGoal(venueId, goal)))

  return enrichedGoals
}

/**
 * Get a single sales goal by ID
 */
export async function getSalesGoal(venueId: string, goalId: string): Promise<SalesGoal> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const storedGoal = storedGoals.find(g => g.id === goalId)
  if (!storedGoal) {
    throw new NotFoundError('Sales goal not found')
  }

  return enrichGoal(venueId, storedGoal)
}

/**
 * Create a new sales goal
 */
export async function createSalesGoal(venueId: string, input: CreateSalesGoalInput): Promise<SalesGoal> {
  // Validate staff exists if provided
  if (input.staffId) {
    const staff = await prisma.staff.findUnique({
      where: { id: input.staffId },
    })
    if (!staff) {
      throw new NotFoundError('Staff not found')
    }
  }

  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Check for duplicate (same staffId + period)
  const duplicate = storedGoals.find(g => g.staffId === (input.staffId || null) && g.period === input.period && g.active)
  if (duplicate) {
    throw new BadRequestError('A goal with this staff and period already exists')
  }

  const now = new Date().toISOString()
  const newGoal: StoredSalesGoal = {
    id: `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    staffId: input.staffId || null,
    goal: input.goal,
    goalType: input.goalType || 'AMOUNT',
    period: input.period,
    active: true,
    createdAt: now,
    updatedAt: now,
  }

  // Update config with new goal
  const updatedGoals = [...storedGoals, newGoal]
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  return enrichGoal(venueId, newGoal)
}

/**
 * Update a sales goal
 */
export async function updateSalesGoal(venueId: string, goalId: string, input: UpdateSalesGoalInput): Promise<SalesGoal> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const goalIndex = storedGoals.findIndex(g => g.id === goalId)
  if (goalIndex === -1) {
    throw new NotFoundError('Sales goal not found')
  }

  const now = new Date().toISOString()
  const updatedGoal: StoredSalesGoal = {
    ...storedGoals[goalIndex],
    goalType: storedGoals[goalIndex].goalType || 'AMOUNT', // Ensure backward compat
    ...(input.goal !== undefined && { goal: input.goal }),
    ...(input.goalType !== undefined && { goalType: input.goalType }),
    ...(input.period !== undefined && { period: input.period }),
    ...(input.active !== undefined && { active: input.active }),
    updatedAt: now,
  }

  // Update config
  const updatedGoals = [...storedGoals]
  updatedGoals[goalIndex] = updatedGoal
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  return enrichGoal(venueId, updatedGoal)
}

/**
 * Delete a sales goal
 */
export async function deleteSalesGoal(venueId: string, goalId: string): Promise<void> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const goalIndex = storedGoals.findIndex(g => g.id === goalId)
  if (goalIndex === -1) {
    throw new NotFoundError('Sales goal not found')
  }

  // Remove goal
  const updatedGoals = storedGoals.filter(g => g.id !== goalId)
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })
}

/**
 * Get the primary sales goal for a venue (for TPV display)
 * Returns the venue-wide goal if exists, otherwise null
 */
export async function getPrimarySalesGoal(venueId: string): Promise<SalesGoal | null> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Find active venue-wide goal (staffId = null)
  const venueGoal = storedGoals.find(g => g.staffId === null && g.active)
  if (!venueGoal) return null

  return enrichGoal(venueId, venueGoal)
}

/**
 * Get sales goal for a specific staff member
 */
export async function getStaffSalesGoal(venueId: string, staffId: string): Promise<SalesGoal | null> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Find active goal for this staff
  const staffGoal = storedGoals.find(g => g.staffId === staffId && g.active)
  if (!staffGoal) return null

  return enrichGoal(venueId, staffGoal)
}
