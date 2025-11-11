import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

/**
 * ProviderCostStructure Service
 *
 * Manages the timeline of costs that payment providers charge Avoqado.
 * Each merchant account can have multiple cost structures over time.
 *
 * Timeline Management:
 * - Only ONE cost structure can be active at a given point in time
 * - effectiveFrom: When this cost structure becomes valid
 * - effectiveTo: When this cost structure expires (null = current/ongoing)
 * - When creating a new cost structure, the previous one is automatically ended
 *
 * Cost Structure Fields:
 * - debitRate: % charged for debit cards (e.g., 0.025 = 2.5%)
 * - creditRate: % charged for credit cards
 * - amexRate: % charged for American Express cards (usually higher)
 * - internationalRate: % charged for international cards
 * - fixedCostPerTransaction: Fixed fee per transaction (e.g., $0.50 MXN)
 *
 * Use Cases:
 * 1. Record initial rates when onboarding a merchant
 * 2. Update rates when provider changes pricing
 * 3. Track historical rates for accurate profit calculation
 * 4. Support flat-rate providers (same rate for all card types)
 */

interface CreateProviderCostStructureData {
  merchantAccountId: string
  effectiveFrom: Date
  debitRate: number
  creditRate: number
  amexRate: number
  internationalRate: number
  fixedCostPerTransaction?: number
  monthlyFee?: number
  notes?: string
}

interface UpdateProviderCostStructureData {
  effectiveFrom?: Date
  effectiveTo?: Date
  debitRate?: number
  creditRate?: number
  amexRate?: number
  internationalRate?: number
  fixedCostPerTransaction?: number
  monthlyFee?: number
  notes?: string
  active?: boolean
}

/**
 * Get all cost structures for a merchant account
 * @param merchantAccountId Merchant account ID
 * @param includeInactive Include inactive cost structures (default: false)
 * @returns List of cost structures ordered by effectiveFrom DESC
 */
export async function getProviderCostStructures(merchantAccountId?: string, includeInactive: boolean = false) {
  const where: any = {}

  if (merchantAccountId) {
    where.merchantAccountId = merchantAccountId
  }

  if (!includeInactive) {
    where.active = true
  }

  const costStructures = await prisma.providerCostStructure.findMany({
    where,
    include: {
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: {
      effectiveFrom: 'desc',
    },
  })

  logger.info('Retrieved provider cost structures', {
    count: costStructures.length,
    merchantAccountId,
    includeInactive,
  })

  return costStructures
}

/**
 * Get a single cost structure by ID
 * @param id Cost structure ID
 * @returns Cost structure with merchant account and provider details
 */
export async function getProviderCostStructure(id: string) {
  const costStructure = await prisma.providerCostStructure.findUnique({
    where: { id },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  if (!costStructure) {
    throw new NotFoundError(`Provider cost structure ${id} not found`)
  }

  logger.info('Retrieved provider cost structure', {
    costStructureId: id,
    merchantAccountId: costStructure.merchantAccountId,
    effectiveFrom: costStructure.effectiveFrom,
  })

  return costStructure
}

/**
 * Get the currently active cost structure for a merchant account
 * @param merchantAccountId Merchant account ID
 * @returns Active cost structure or null
 */
export async function getActiveCostStructure(merchantAccountId: string) {
  const now = new Date()

  const costStructure = await prisma.providerCostStructure.findFirst({
    where: {
      merchantAccountId,
      active: true,
      effectiveFrom: { lte: now },
      OR: [
        { effectiveTo: null }, // No end date (current)
        { effectiveTo: { gte: now } },
      ],
    },
    orderBy: {
      effectiveFrom: 'desc',
    },
  })

  if (costStructure) {
    logger.info('Retrieved active cost structure', {
      costStructureId: costStructure.id,
      merchantAccountId,
    })
  } else {
    logger.warn('No active cost structure found', { merchantAccountId })
  }

  return costStructure
}

/**
 * Create a new provider cost structure
 * Automatically ends the previous cost structure if it exists
 *
 * @param data Cost structure creation data
 * @returns Created cost structure
 */
export async function createProviderCostStructure(data: CreateProviderCostStructureData) {
  // Validate merchant account exists
  const merchantAccount = await prisma.merchantAccount.findUnique({
    where: { id: data.merchantAccountId },
    include: {
      provider: true,
    },
  })

  if (!merchantAccount) {
    throw new NotFoundError(`Merchant account ${data.merchantAccountId} not found`)
  }

  // Validate rates are between 0 and 1 (0% to 100%)
  if (data.debitRate < 0 || data.debitRate > 1) {
    throw new BadRequestError('debitRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.creditRate < 0 || data.creditRate > 1) {
    throw new BadRequestError('creditRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.amexRate < 0 || data.amexRate > 1) {
    throw new BadRequestError('amexRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.internationalRate < 0 || data.internationalRate > 1) {
    throw new BadRequestError('internationalRate must be between 0 and 1 (0% to 100%)')
  }

  // Validate effectiveFrom is not in the past (allow same day)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (data.effectiveFrom < today) {
    throw new BadRequestError('effectiveFrom cannot be in the past')
  }

  // End any existing active cost structure
  const existingActiveCostStructure = await prisma.providerCostStructure.findFirst({
    where: {
      merchantAccountId: data.merchantAccountId,
      active: true,
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: data.effectiveFrom } }],
    },
  })

  if (existingActiveCostStructure) {
    // Set effectiveTo to one day before the new cost structure's effectiveFrom
    const previousEndDate = new Date(data.effectiveFrom)
    previousEndDate.setDate(previousEndDate.getDate() - 1)

    await prisma.providerCostStructure.update({
      where: { id: existingActiveCostStructure.id },
      data: {
        effectiveTo: previousEndDate,
      },
    })

    logger.info('Ended previous cost structure', {
      previousCostStructureId: existingActiveCostStructure.id,
      endedOn: previousEndDate,
    })
  }

  // Create new cost structure
  const costStructure = await prisma.providerCostStructure.create({
    data: {
      providerId: merchantAccount.providerId,
      merchantAccountId: data.merchantAccountId,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: null, // New cost structure has no end date
      debitRate: data.debitRate,
      creditRate: data.creditRate,
      amexRate: data.amexRate,
      internationalRate: data.internationalRate,
      fixedCostPerTransaction: data.fixedCostPerTransaction || null,
      monthlyFee: data.monthlyFee || null,
      notes: data.notes || null,
      active: true,
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Provider cost structure created', {
    costStructureId: costStructure.id,
    merchantAccountId: data.merchantAccountId,
    providerCode: merchantAccount.provider.code,
    effectiveFrom: data.effectiveFrom,
  })

  return costStructure
}

/**
 * Update a provider cost structure
 * NOTE: Updating rates on an active cost structure is allowed,
 * but changing effectiveFrom/effectiveTo requires careful consideration
 *
 * @param id Cost structure ID
 * @param data Update data
 * @returns Updated cost structure
 */
export async function updateProviderCostStructure(id: string, data: UpdateProviderCostStructureData) {
  // Check if cost structure exists
  const existingCostStructure = await prisma.providerCostStructure.findUnique({
    where: { id },
  })

  if (!existingCostStructure) {
    throw new NotFoundError(`Provider cost structure ${id} not found`)
  }

  // Validate rates if provided
  if (data.debitRate !== undefined && (data.debitRate < 0 || data.debitRate > 1)) {
    throw new BadRequestError('debitRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.creditRate !== undefined && (data.creditRate < 0 || data.creditRate > 1)) {
    throw new BadRequestError('creditRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.amexRate !== undefined && (data.amexRate < 0 || data.amexRate > 1)) {
    throw new BadRequestError('amexRate must be between 0 and 1 (0% to 100%)')
  }
  if (data.internationalRate !== undefined && (data.internationalRate < 0 || data.internationalRate > 1)) {
    throw new BadRequestError('internationalRate must be between 0 and 1 (0% to 100%)')
  }

  // Validate timeline consistency if dates are being changed
  if (data.effectiveFrom && data.effectiveTo) {
    if (data.effectiveFrom >= data.effectiveTo) {
      throw new BadRequestError('effectiveFrom must be before effectiveTo')
    }
  }

  const costStructure = await prisma.providerCostStructure.update({
    where: { id },
    data: {
      ...(data.effectiveFrom && { effectiveFrom: data.effectiveFrom }),
      ...(data.effectiveTo !== undefined && { effectiveTo: data.effectiveTo }),
      ...(data.debitRate !== undefined && { debitRate: data.debitRate }),
      ...(data.creditRate !== undefined && { creditRate: data.creditRate }),
      ...(data.amexRate !== undefined && { amexRate: data.amexRate }),
      ...(data.internationalRate !== undefined && { internationalRate: data.internationalRate }),
      ...(data.fixedCostPerTransaction !== undefined && { fixedCostPerTransaction: data.fixedCostPerTransaction }),
      ...(data.monthlyFee !== undefined && { monthlyFee: data.monthlyFee }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.active !== undefined && { active: data.active }),
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Provider cost structure updated', {
    costStructureId: id,
    updates: Object.keys(data),
  })

  return costStructure
}

/**
 * Deactivate a cost structure
 * Sets effectiveTo to today and active to false
 *
 * @param id Cost structure ID
 * @returns Updated cost structure
 */
export async function deactivateCostStructure(id: string) {
  const costStructure = await prisma.providerCostStructure.findUnique({
    where: { id },
  })

  if (!costStructure) {
    throw new NotFoundError(`Provider cost structure ${id} not found`)
  }

  if (!costStructure.active) {
    throw new BadRequestError('Cost structure is already inactive')
  }

  const updated = await prisma.providerCostStructure.update({
    where: { id },
    data: {
      effectiveTo: new Date(),
      active: false,
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Provider cost structure deactivated', {
    costStructureId: id,
    effectiveTo: updated.effectiveTo,
  })

  return updated
}

/**
 * Delete a provider cost structure
 * Only allowed if no transaction costs reference it
 *
 * @param id Cost structure ID
 */
export async function deleteProviderCostStructure(id: string) {
  const costStructure = await prisma.providerCostStructure.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          transactionCosts: true,
        },
      },
    },
  })

  if (!costStructure) {
    throw new NotFoundError(`Provider cost structure ${id} not found`)
  }

  // Prevent deletion if transaction costs reference this cost structure
  if (costStructure._count.transactionCosts > 0) {
    throw new BadRequestError(
      `Cannot delete cost structure because it's referenced by ${costStructure._count.transactionCosts} transaction cost(s). Deactivate instead.`,
    )
  }

  await prisma.providerCostStructure.delete({
    where: { id },
  })

  logger.warn('Provider cost structure deleted', {
    costStructureId: id,
    merchantAccountId: costStructure.merchantAccountId,
  })
}

/**
 * Helper: Create flat-rate cost structure
 * Uses the same rate for all card types (common for certain providers)
 *
 * @param merchantAccountId Merchant account ID
 * @param effectiveFrom Effective date
 * @param flatRate Rate to apply to all card types
 * @param fixedCostPerTransaction Optional fixed fee
 * @param notes Optional notes
 * @returns Created cost structure
 */
export async function createFlatRateCostStructure(
  merchantAccountId: string,
  effectiveFrom: Date,
  flatRate: number,
  fixedCostPerTransaction?: number,
  notes?: string,
) {
  logger.info('Creating flat-rate cost structure', {
    merchantAccountId,
    flatRate,
  })

  return createProviderCostStructure({
    merchantAccountId,
    effectiveFrom,
    debitRate: flatRate,
    creditRate: flatRate,
    amexRate: flatRate,
    internationalRate: flatRate,
    fixedCostPerTransaction,
    notes: notes || 'Flat-rate pricing (same rate for all card types)',
  })
}
