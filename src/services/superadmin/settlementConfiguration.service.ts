import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { TransactionCardType, SettlementDayType } from '@prisma/client'

/**
 * SettlementConfiguration Service (Superadmin)
 *
 * Manages settlement configurations that determine when funds are available to venues.
 * Each merchant account can have different settlement rules per card type.
 *
 * Timeline Management:
 * - Multiple configurations can exist per merchant account (one per card type)
 * - effectiveFrom: When this configuration becomes valid
 * - effectiveTo: When this configuration expires (null = current/ongoing)
 * - When creating a new config for same merchant+card type, previous one is ended
 *
 * Configuration Fields:
 * - settlementDays: Number of days until settlement (e.g., 1, 3, 7)
 * - settlementDayType: BUSINESS_DAYS or CALENDAR_DAYS
 * - cutoffTime: Daily cutoff time in HH:MM format (e.g., "23:00")
 * - cutoffTimezone: IANA timezone (e.g., "America/Mexico_City")
 *
 * Use Cases:
 * 1. Set initial settlement rules when onboarding merchant
 * 2. Update rules when processor changes settlement policy
 * 3. Different rules per card type (Debit: 1 day, Credit: 2 days, Amex: 3 days)
 * 4. Track historical configurations for audit purposes
 */

interface CreateSettlementConfigData {
  merchantAccountId: string
  cardType: TransactionCardType
  settlementDays: number
  settlementDayType: SettlementDayType
  cutoffTime: string // HH:MM format
  cutoffTimezone: string
  effectiveFrom: Date
  notes?: string
  createdBy?: string
}

interface UpdateSettlementConfigData {
  settlementDays?: number
  settlementDayType?: SettlementDayType
  cutoffTime?: string
  cutoffTimezone?: string
  effectiveFrom?: Date
  effectiveTo?: Date
  notes?: string
}

/**
 * Get all settlement configurations
 * @param filters Optional filters (merchantAccountId, cardType)
 * @param includeExpired Include expired configurations (default: false)
 * @returns List of settlement configurations
 */
export async function getSettlementConfigurations(
  filters?: {
    merchantAccountId?: string
    cardType?: TransactionCardType
  },
  includeExpired: boolean = false,
) {
  const where: any = {}

  if (filters?.merchantAccountId) {
    where.merchantAccountId = filters.merchantAccountId
  }

  if (filters?.cardType) {
    where.cardType = filters.cardType
  }

  if (!includeExpired) {
    where.OR = [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }]
  }

  const configurations = await prisma.settlementConfiguration.findMany({
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
    orderBy: [{ merchantAccountId: 'asc' }, { cardType: 'asc' }, { effectiveFrom: 'desc' }],
  })

  logger.info('Fetched settlement configurations', {
    count: configurations.length,
    filters,
    includeExpired,
  })

  return configurations
}

/**
 * Get a single settlement configuration by ID
 * @param id Configuration ID
 * @returns Settlement configuration
 */
export async function getSettlementConfigurationById(id: string) {
  const configuration = await prisma.settlementConfiguration.findUnique({
    where: { id },
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
  })

  if (!configuration) {
    throw new NotFoundError('Settlement configuration not found')
  }

  return configuration
}

/**
 * Create a new settlement configuration
 *
 * If a configuration already exists for the same merchant account + card type,
 * the previous one will be automatically ended (effectiveTo set to new effectiveFrom - 1 day)
 *
 * @param data Configuration data
 * @returns Created settlement configuration
 */
export async function createSettlementConfiguration(data: CreateSettlementConfigData) {
  logger.info('Creating settlement configuration', { data })

  // Validate cutoff time format
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/
  if (!timeRegex.test(data.cutoffTime)) {
    throw new BadRequestError('Cutoff time must be in HH:MM format (e.g., "23:00")')
  }

  // Validate settlement days
  if (data.settlementDays < 0 || data.settlementDays > 30) {
    throw new BadRequestError('Settlement days must be between 0 and 30')
  }

  // Check if merchant account exists
  const merchantAccount = await prisma.merchantAccount.findUnique({
    where: { id: data.merchantAccountId },
  })

  if (!merchantAccount) {
    throw new NotFoundError('Merchant account not found')
  }

  // Find existing active configuration for same merchant + card type
  const existingConfig = await prisma.settlementConfiguration.findFirst({
    where: {
      merchantAccountId: data.merchantAccountId,
      cardType: data.cardType,
      effectiveTo: null, // Only active configs
    },
  })

  // If exists, end it 1 day before new config starts
  if (existingConfig) {
    const endDate = new Date(data.effectiveFrom)
    endDate.setDate(endDate.getDate() - 1)

    await prisma.settlementConfiguration.update({
      where: { id: existingConfig.id },
      data: { effectiveTo: endDate },
    })

    logger.info('Ended previous settlement configuration', {
      configId: existingConfig.id,
      effectiveTo: endDate,
    })
  }

  // Create new configuration
  const configuration = await prisma.settlementConfiguration.create({
    data: {
      merchantAccountId: data.merchantAccountId,
      cardType: data.cardType,
      settlementDays: data.settlementDays,
      settlementDayType: data.settlementDayType,
      cutoffTime: data.cutoffTime,
      cutoffTimezone: data.cutoffTimezone,
      effectiveFrom: data.effectiveFrom,
      notes: data.notes,
      createdBy: data.createdBy,
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Settlement configuration created', { id: configuration.id })

  return configuration
}

/**
 * Update a settlement configuration
 * @param id Configuration ID
 * @param data Update data
 * @returns Updated settlement configuration
 */
export async function updateSettlementConfiguration(id: string, data: UpdateSettlementConfigData) {
  logger.info('Updating settlement configuration', { id, data })

  // Validate cutoff time format if provided
  if (data.cutoffTime) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/
    if (!timeRegex.test(data.cutoffTime)) {
      throw new BadRequestError('Cutoff time must be in HH:MM format (e.g., "23:00")')
    }
  }

  // Validate settlement days if provided
  if (data.settlementDays !== undefined) {
    if (data.settlementDays < 0 || data.settlementDays > 30) {
      throw new BadRequestError('Settlement days must be between 0 and 30')
    }
  }

  // Check if configuration exists
  const existing = await prisma.settlementConfiguration.findUnique({
    where: { id },
  })

  if (!existing) {
    throw new NotFoundError('Settlement configuration not found')
  }

  // Update configuration
  const configuration = await prisma.settlementConfiguration.update({
    where: { id },
    data,
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Settlement configuration updated', { id })

  return configuration
}

/**
 * Delete a settlement configuration
 * @param id Configuration ID
 */
export async function deleteSettlementConfiguration(id: string) {
  logger.info('Deleting settlement configuration', { id })

  // Check if configuration exists
  const existing = await prisma.settlementConfiguration.findUnique({
    where: { id },
  })

  if (!existing) {
    throw new NotFoundError('Settlement configuration not found')
  }

  await prisma.settlementConfiguration.delete({
    where: { id },
  })

  logger.info('Settlement configuration deleted', { id })
}

/**
 * Get active configuration for a merchant account and card type
 * @param merchantAccountId Merchant account ID
 * @param cardType Card type
 * @param effectiveDate Date to check (defaults to now)
 * @returns Active settlement configuration or null
 */
export async function getActiveConfiguration(merchantAccountId: string, cardType: TransactionCardType, effectiveDate: Date = new Date()) {
  const configuration = await prisma.settlementConfiguration.findFirst({
    where: {
      merchantAccountId,
      cardType,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
    include: {
      merchantAccount: {
        include: {
          provider: true,
        },
      },
    },
    orderBy: {
      effectiveFrom: 'desc', // Get most recent if multiple match
    },
  })

  return configuration
}

/**
 * Bulk create settlement configurations for a merchant account
 * Useful when onboarding a new merchant with different rules per card type
 *
 * @param merchantAccountId Merchant account ID
 * @param configs Array of configuration data (one per card type)
 * @returns Created settlement configurations
 */
export async function bulkCreateSettlementConfigurations(
  merchantAccountId: string,
  configs: Array<{
    cardType: TransactionCardType
    settlementDays: number
    settlementDayType: SettlementDayType
    cutoffTime: string
    cutoffTimezone: string
  }>,
  effectiveFrom: Date,
  createdBy?: string,
) {
  logger.info('Bulk creating settlement configurations', {
    merchantAccountId,
    count: configs.length,
  })

  const createdConfigs = []

  for (const config of configs) {
    const created = await createSettlementConfiguration({
      merchantAccountId,
      ...config,
      effectiveFrom,
      createdBy,
    })
    createdConfigs.push(created)
  }

  logger.info('Bulk settlement configurations created', { count: createdConfigs.length })

  return createdConfigs
}
