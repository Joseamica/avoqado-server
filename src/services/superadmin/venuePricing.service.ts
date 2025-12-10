import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { AccountType } from '@prisma/client'

/**
 * VenuePricing Service
 *
 * Manages venue payment configuration and pricing structures.
 * This service handles two related models:
 *
 * 1. VenuePaymentConfig - Maps venues to their merchant accounts
 *    - PRIMARY/SECONDARY/TERTIARY account hierarchy
 *    - Routing rules for smart payment routing
 *    - Preferred processor selection
 *
 * 2. VenuePricingStructure - Timeline of rates Avoqado charges venues
 *    - Similar to ProviderCostStructure but with Avoqado's margin
 *    - Supports account-specific pricing (PRIMARY/SECONDARY/TERTIARY)
 *    - Monthly service fees and volume minimums
 *    - Contract references and notes
 *
 * Use Cases:
 * 1. Configure payment accounts during venue onboarding
 * 2. Update pricing when negotiating new venue contracts
 * 3. Track pricing history for each venue and account type
 * 4. Set up routing rules for advanced payment routing
 */

/**
 * ========================================
 * VENUE PAYMENT CONFIG MANAGEMENT
 * ========================================
 */

interface CreateVenuePaymentConfigData {
  venueId: string
  primaryAccountId: string
  secondaryAccountId?: string
  tertiaryAccountId?: string
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
}

interface UpdateVenuePaymentConfigData {
  primaryAccountId?: string
  secondaryAccountId?: string
  tertiaryAccountId?: string
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
}

/**
 * Get venue payment configuration
 * @param venueId Venue ID
 * @returns Venue payment config with merchant account details
 */
export async function getVenuePaymentConfig(venueId: string) {
  const config = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      primaryAccount: {
        include: {
          provider: true,
        },
      },
      secondaryAccount: {
        include: {
          provider: true,
        },
      },
      tertiaryAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  if (!config) {
    logger.warn('No payment config found for venue', { venueId })
    return null
  }

  logger.info('Retrieved venue payment config', {
    venueId,
    hasPrimary: !!config.primaryAccount,
    hasSecondary: !!config.secondaryAccount,
    hasTertiary: !!config.tertiaryAccount,
  })

  return config
}

/**
 * Create venue payment configuration
 * @param data Payment config creation data
 * @returns Created payment config
 */
export async function createVenuePaymentConfig(data: CreateVenuePaymentConfigData) {
  // Validate venue exists and has no config yet
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
    include: {
      paymentConfig: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${data.venueId} not found`)
  }

  if (venue.paymentConfig) {
    throw new BadRequestError(`Venue ${data.venueId} already has a payment configuration`)
  }

  // Validate primary account exists
  const primaryAccount = await prisma.merchantAccount.findUnique({
    where: { id: data.primaryAccountId },
  })

  if (!primaryAccount) {
    throw new NotFoundError(`Primary merchant account ${data.primaryAccountId} not found`)
  }

  // Validate secondary account if provided
  if (data.secondaryAccountId) {
    const secondaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })

    if (!secondaryAccount) {
      throw new NotFoundError(`Secondary merchant account ${data.secondaryAccountId} not found`)
    }
  }

  // Validate tertiary account if provided
  if (data.tertiaryAccountId) {
    const tertiaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })

    if (!tertiaryAccount) {
      throw new NotFoundError(`Tertiary merchant account ${data.tertiaryAccountId} not found`)
    }
  }

  // Create payment config
  const config = await prisma.venuePaymentConfig.create({
    data: {
      venueId: data.venueId,
      primaryAccountId: data.primaryAccountId,
      secondaryAccountId: data.secondaryAccountId,
      tertiaryAccountId: data.tertiaryAccountId,
      routingRules: data.routingRules || null,
      preferredProcessor: data.preferredProcessor || 'AUTO',
    },
    include: {
      venue: true,
      primaryAccount: {
        include: {
          provider: true,
        },
      },
      secondaryAccount: {
        include: {
          provider: true,
        },
      },
      tertiaryAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Venue payment config created', {
    configId: config.id,
    venueId: data.venueId,
    venueName: venue.name,
  })

  return config
}

/**
 * Get all venue payment configs that reference a specific merchant account
 * This is useful for dependency checking before deleting a merchant account
 *
 * @param merchantAccountId Merchant account ID
 * @returns List of venue payment configs with the account type (PRIMARY, SECONDARY, or TERTIARY)
 */
export async function getVenueConfigsByMerchantAccount(merchantAccountId: string) {
  // Find all configs where this merchant account is used as primary, secondary, or tertiary
  const configs = await prisma.venuePaymentConfig.findMany({
    where: {
      OR: [{ primaryAccountId: merchantAccountId }, { secondaryAccountId: merchantAccountId }, { tertiaryAccountId: merchantAccountId }],
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      primaryAccount: {
        include: { provider: true },
      },
      secondaryAccount: {
        include: { provider: true },
      },
      tertiaryAccount: {
        include: { provider: true },
      },
    },
  })

  // Add accountType field to indicate which slot this merchant account occupies
  const result = configs.map(config => {
    let accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = 'PRIMARY'

    if (config.primaryAccountId === merchantAccountId) {
      accountType = 'PRIMARY'
    } else if (config.secondaryAccountId === merchantAccountId) {
      accountType = 'SECONDARY'
    } else if (config.tertiaryAccountId === merchantAccountId) {
      accountType = 'TERTIARY'
    }

    return {
      ...config,
      accountType,
    }
  })

  logger.info('Retrieved venue configs by merchant account', {
    merchantAccountId,
    count: result.length,
  })

  return result
}

/**
 * Delete venue payment configuration
 * @param venueId Venue ID
 */
export async function deleteVenuePaymentConfig(venueId: string) {
  // Check if config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
  })

  if (!existingConfig) {
    throw new NotFoundError(`Venue ${venueId} has no payment configuration`)
  }

  await prisma.venuePaymentConfig.delete({
    where: { venueId },
  })

  logger.info('Venue payment config deleted', {
    venueId,
    configId: existingConfig.id,
  })
}

/**
 * Update venue payment configuration
 *
 * IMPORTANT: When assigning an account to a slot, this function automatically
 * removes the account from any other slot it currently occupies in the same venue.
 * This prevents the same account from appearing in multiple slots simultaneously.
 *
 * @param venueId Venue ID
 * @param data Update data
 * @returns Updated payment config
 */
export async function updateVenuePaymentConfig(venueId: string, data: UpdateVenuePaymentConfigData) {
  // Check if config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
  })

  if (!existingConfig) {
    throw new NotFoundError(`Venue ${venueId} has no payment configuration`)
  }

  // Validate accounts if provided
  if (data.primaryAccountId) {
    const account = await prisma.merchantAccount.findUnique({
      where: { id: data.primaryAccountId },
    })
    if (!account) {
      throw new NotFoundError(`Primary merchant account ${data.primaryAccountId} not found`)
    }
  }

  if (data.secondaryAccountId) {
    const account = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })
    if (!account) {
      throw new NotFoundError(`Secondary merchant account ${data.secondaryAccountId} not found`)
    }
  }

  if (data.tertiaryAccountId) {
    const account = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })
    if (!account) {
      throw new NotFoundError(`Tertiary merchant account ${data.tertiaryAccountId} not found`)
    }
  }

  // Build update data, ensuring account is only in ONE slot at a time
  const updateData: any = {}

  // Determine which account is being assigned (if any)
  const accountBeingAssigned = data.primaryAccountId || data.secondaryAccountId || data.tertiaryAccountId

  if (accountBeingAssigned) {
    // Check if this account currently exists in any other slot and clear it
    // This prevents the same account from appearing in multiple slots
    //
    // IMPORTANT: PRIMARY is a REQUIRED field - cannot be set to null!
    // If account is being moved FROM PRIMARY, we need special handling.

    // If assigning to PRIMARY, clear from SECONDARY and TERTIARY if present
    if (data.primaryAccountId) {
      if (existingConfig.secondaryAccountId === data.primaryAccountId) {
        updateData.secondaryAccountId = null
        logger.info('Auto-clearing account from SECONDARY slot (moving to PRIMARY)', {
          accountId: data.primaryAccountId,
          venueId,
        })
      }
      if (existingConfig.tertiaryAccountId === data.primaryAccountId) {
        updateData.tertiaryAccountId = null
        logger.info('Auto-clearing account from TERTIARY slot (moving to PRIMARY)', {
          accountId: data.primaryAccountId,
          venueId,
        })
      }
    }

    // If assigning to SECONDARY, check if moving from PRIMARY (not allowed without replacement)
    if (data.secondaryAccountId) {
      if (existingConfig.primaryAccountId === data.secondaryAccountId) {
        // Cannot leave PRIMARY empty - it's a required field
        // Check if a new PRIMARY is being set in this same request
        if (!data.primaryAccountId) {
          throw new BadRequestError(
            'No puedes mover la cuenta primaria a otro slot sin asignar una nueva cuenta primaria. ' +
              'La cuenta primaria es obligatoria.',
          )
        }
      }
      if (existingConfig.tertiaryAccountId === data.secondaryAccountId) {
        updateData.tertiaryAccountId = null
        logger.info('Auto-clearing account from TERTIARY slot (moving to SECONDARY)', {
          accountId: data.secondaryAccountId,
          venueId,
        })
      }
    }

    // If assigning to TERTIARY, check if moving from PRIMARY (not allowed without replacement)
    if (data.tertiaryAccountId) {
      if (existingConfig.primaryAccountId === data.tertiaryAccountId) {
        // Cannot leave PRIMARY empty - it's a required field
        // Check if a new PRIMARY is being set in this same request
        if (!data.primaryAccountId) {
          throw new BadRequestError(
            'No puedes mover la cuenta primaria a otro slot sin asignar una nueva cuenta primaria. ' +
              'La cuenta primaria es obligatoria.',
          )
        }
      }
      if (existingConfig.secondaryAccountId === data.tertiaryAccountId) {
        updateData.secondaryAccountId = null
        logger.info('Auto-clearing account from SECONDARY slot (moving to TERTIARY)', {
          accountId: data.tertiaryAccountId,
          venueId,
        })
      }
    }
  }

  // Apply the requested slot changes
  // Note: primaryAccountId can only be set to a value, never to null (required field)
  if (data.primaryAccountId) {
    updateData.primaryAccountId = data.primaryAccountId
  }
  if (data.secondaryAccountId !== undefined) {
    updateData.secondaryAccountId = data.secondaryAccountId
  }
  if (data.tertiaryAccountId !== undefined) {
    updateData.tertiaryAccountId = data.tertiaryAccountId
  }
  if (data.routingRules !== undefined) {
    updateData.routingRules = data.routingRules
  }
  if (data.preferredProcessor) {
    updateData.preferredProcessor = data.preferredProcessor
  }

  const config = await prisma.venuePaymentConfig.update({
    where: { venueId },
    data: updateData,
    include: {
      venue: true,
      primaryAccount: {
        include: {
          provider: true,
        },
      },
      secondaryAccount: {
        include: {
          provider: true,
        },
      },
      tertiaryAccount: {
        include: {
          provider: true,
        },
      },
    },
  })

  logger.info('Venue payment config updated', {
    venueId,
    updates: Object.keys(data),
    autoCleared: Object.keys(updateData).filter(k => updateData[k] === null),
  })

  return config
}

/**
 * ========================================
 * VENUE PRICING STRUCTURE MANAGEMENT
 * ========================================
 */

interface CreateVenuePricingStructureData {
  venueId: string
  accountType: AccountType
  effectiveFrom: Date
  debitRate: number
  creditRate: number
  amexRate: number
  internationalRate: number
  fixedFeePerTransaction?: number
  monthlyServiceFee?: number
  minimumMonthlyVolume?: number
  volumePenalty?: number
  contractReference?: string
  notes?: string
}

interface UpdateVenuePricingStructureData {
  effectiveFrom?: Date
  effectiveTo?: Date
  debitRate?: number
  creditRate?: number
  amexRate?: number
  internationalRate?: number
  fixedFeePerTransaction?: number
  monthlyServiceFee?: number
  minimumMonthlyVolume?: number
  volumePenalty?: number
  contractReference?: string
  notes?: string
  active?: boolean
}

/**
 * Get all pricing structures for a venue
 * @param venueId Venue ID
 * @param accountType Optional account type filter
 * @param includeInactive Include inactive pricing structures (default: false)
 * @returns List of pricing structures
 */
export async function getVenuePricingStructures(venueId?: string, accountType?: AccountType, includeInactive: boolean = false) {
  const where: any = {}

  if (venueId) {
    where.venueId = venueId
  }

  if (accountType) {
    where.accountType = accountType
  }

  if (!includeInactive) {
    where.active = true
  }

  const pricingStructures = await prisma.venuePricingStructure.findMany({
    where,
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: {
      effectiveFrom: 'desc',
    },
  })

  logger.info('Retrieved venue pricing structures', {
    count: pricingStructures.length,
    venueId,
    accountType,
    includeInactive,
  })

  return pricingStructures
}

/**
 * Get a single pricing structure by ID
 * @param id Pricing structure ID
 * @returns Pricing structure with venue details
 */
export async function getVenuePricingStructure(id: string) {
  const pricingStructure = await prisma.venuePricingStructure.findUnique({
    where: { id },
    include: {
      venue: true,
    },
  })

  if (!pricingStructure) {
    throw new NotFoundError(`Venue pricing structure ${id} not found`)
  }

  logger.info('Retrieved venue pricing structure', {
    pricingStructureId: id,
    venueId: pricingStructure.venueId,
    accountType: pricingStructure.accountType,
  })

  return pricingStructure
}

/**
 * Get the currently active pricing structure for a venue and account type
 * @param venueId Venue ID
 * @param accountType Account type (PRIMARY, SECONDARY, TERTIARY)
 * @returns Active pricing structure or null
 */
export async function getActivePricingStructure(venueId: string, accountType: AccountType) {
  const now = new Date()

  const pricingStructure = await prisma.venuePricingStructure.findFirst({
    where: {
      venueId,
      accountType,
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

  if (pricingStructure) {
    logger.info('Retrieved active venue pricing structure', {
      pricingStructureId: pricingStructure.id,
      venueId,
      accountType,
    })
  } else {
    logger.warn('No active venue pricing structure found', { venueId, accountType })
  }

  return pricingStructure
}

/**
 * Create a new venue pricing structure
 * Automatically ends the previous pricing structure for the same account type if it exists
 *
 * @param data Pricing structure creation data
 * @returns Created pricing structure
 */
export async function createVenuePricingStructure(data: CreateVenuePricingStructureData) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${data.venueId} not found`)
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

  // Validate effectiveFrom is not in the past
  // Compare dates only (ignore time), using Mexico City timezone
  // The frontend sends dates in local timezone, so we compare date strings
  const nowMexico = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) // YYYY-MM-DD format
  const effectiveFromStr = data.effectiveFrom.toISOString().split('T')[0] // YYYY-MM-DD format
  if (effectiveFromStr < nowMexico) {
    throw new BadRequestError('effectiveFrom cannot be in the past')
  }

  // Log incoming data for debugging
  logger.info('Creating venue pricing structure', {
    venueId: data.venueId,
    accountType: data.accountType,
    debitRate: data.debitRate,
    creditRate: data.creditRate,
    effectiveFrom: data.effectiveFrom,
  })

  // Wrap in transaction to prevent race conditions when creating multiple pricing structures simultaneously
  const pricingStructure = await prisma.$transaction(async tx => {
    // Check if there's an existing structure with the EXACT same effectiveFrom date
    // This would violate the unique constraint (venueId, accountType, effectiveFrom)
    const existingWithSameDate = await tx.venuePricingStructure.findFirst({
      where: {
        venueId: data.venueId,
        accountType: data.accountType,
        effectiveFrom: data.effectiveFrom,
      },
    })

    if (existingWithSameDate) {
      // Update the existing structure instead of creating a new one
      logger.info('Updating existing venue pricing structure with same effectiveFrom date', {
        existingId: existingWithSameDate.id,
        effectiveFrom: data.effectiveFrom,
      })

      return await tx.venuePricingStructure.update({
        where: { id: existingWithSameDate.id },
        data: {
          debitRate: data.debitRate,
          creditRate: data.creditRate,
          amexRate: data.amexRate,
          internationalRate: data.internationalRate,
          fixedFeePerTransaction: data.fixedFeePerTransaction || null,
          monthlyServiceFee: data.monthlyServiceFee || null,
          minimumMonthlyVolume: data.minimumMonthlyVolume || null,
          volumePenalty: data.volumePenalty || null,
          contractReference: data.contractReference || null,
          notes: data.notes || null,
          active: true,
          effectiveTo: null, // Reset end date
        },
        include: {
          venue: true,
        },
      })
    }

    // End any existing active pricing structure for this venue and account type
    const existingActivePricingStructure = await tx.venuePricingStructure.findFirst({
      where: {
        venueId: data.venueId,
        accountType: data.accountType,
        active: true,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: data.effectiveFrom } }],
      },
    })

    if (existingActivePricingStructure) {
      // Set effectiveTo to one day before the new pricing structure's effectiveFrom
      const previousEndDate = new Date(data.effectiveFrom)
      previousEndDate.setDate(previousEndDate.getDate() - 1)

      await tx.venuePricingStructure.update({
        where: { id: existingActivePricingStructure.id },
        data: {
          effectiveTo: previousEndDate,
        },
      })

      logger.info('Ended previous venue pricing structure', {
        previousPricingStructureId: existingActivePricingStructure.id,
        endedOn: previousEndDate,
      })
    }

    // Create new pricing structure
    return await tx.venuePricingStructure.create({
      data: {
        venueId: data.venueId,
        accountType: data.accountType,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: null, // New pricing structure has no end date
        debitRate: data.debitRate,
        creditRate: data.creditRate,
        amexRate: data.amexRate,
        internationalRate: data.internationalRate,
        fixedFeePerTransaction: data.fixedFeePerTransaction || null,
        monthlyServiceFee: data.monthlyServiceFee || null,
        minimumMonthlyVolume: data.minimumMonthlyVolume || null,
        volumePenalty: data.volumePenalty || null,
        contractReference: data.contractReference || null,
        notes: data.notes || null,
        active: true,
      },
      include: {
        venue: true,
      },
    })
  })

  logger.info('Venue pricing structure created', {
    pricingStructureId: pricingStructure.id,
    venueId: data.venueId,
    venueName: venue.name,
    accountType: data.accountType,
    effectiveFrom: data.effectiveFrom,
  })

  return pricingStructure
}

/**
 * Update a venue pricing structure
 *
 * @param id Pricing structure ID
 * @param data Update data
 * @returns Updated pricing structure
 */
export async function updateVenuePricingStructure(id: string, data: UpdateVenuePricingStructureData) {
  // Check if pricing structure exists
  const existingPricingStructure = await prisma.venuePricingStructure.findUnique({
    where: { id },
    include: { venue: true },
  })

  if (!existingPricingStructure) {
    throw new NotFoundError(`Venue pricing structure ${id} not found`)
  }

  // Log incoming update data for debugging
  logger.info('Updating venue pricing structure', {
    pricingStructureId: id,
    currentAccountType: existingPricingStructure.accountType,
    venueId: existingPricingStructure.venueId,
    venueName: existingPricingStructure.venue.name,
    incomingData: {
      debitRate: data.debitRate,
      creditRate: data.creditRate,
      amexRate: data.amexRate,
      internationalRate: data.internationalRate,
    },
  })

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

  const pricingStructure = await prisma.venuePricingStructure.update({
    where: { id },
    data: {
      ...(data.effectiveFrom && { effectiveFrom: data.effectiveFrom }),
      ...(data.effectiveTo !== undefined && { effectiveTo: data.effectiveTo }),
      ...(data.debitRate !== undefined && { debitRate: data.debitRate }),
      ...(data.creditRate !== undefined && { creditRate: data.creditRate }),
      ...(data.amexRate !== undefined && { amexRate: data.amexRate }),
      ...(data.internationalRate !== undefined && { internationalRate: data.internationalRate }),
      ...(data.fixedFeePerTransaction !== undefined && { fixedFeePerTransaction: data.fixedFeePerTransaction }),
      ...(data.monthlyServiceFee !== undefined && { monthlyServiceFee: data.monthlyServiceFee }),
      ...(data.minimumMonthlyVolume !== undefined && { minimumMonthlyVolume: data.minimumMonthlyVolume }),
      ...(data.volumePenalty !== undefined && { volumePenalty: data.volumePenalty }),
      ...(data.contractReference !== undefined && { contractReference: data.contractReference }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.active !== undefined && { active: data.active }),
    },
    include: {
      venue: true,
    },
  })

  logger.info('Venue pricing structure updated', {
    pricingStructureId: id,
    updates: Object.keys(data),
  })

  return pricingStructure
}

/**
 * Deactivate a pricing structure
 * Sets effectiveTo to today and active to false
 *
 * @param id Pricing structure ID
 * @returns Updated pricing structure
 */
export async function deactivatePricingStructure(id: string) {
  const pricingStructure = await prisma.venuePricingStructure.findUnique({
    where: { id },
  })

  if (!pricingStructure) {
    throw new NotFoundError(`Venue pricing structure ${id} not found`)
  }

  if (!pricingStructure.active) {
    throw new BadRequestError('Pricing structure is already inactive')
  }

  const updated = await prisma.venuePricingStructure.update({
    where: { id },
    data: {
      effectiveTo: new Date(),
      active: false,
    },
    include: {
      venue: true,
    },
  })

  logger.info('Venue pricing structure deactivated', {
    pricingStructureId: id,
    effectiveTo: updated.effectiveTo,
  })

  return updated
}

/**
 * Delete a venue pricing structure
 * Only allowed if no transaction costs reference it
 *
 * @param id Pricing structure ID
 */
export async function deleteVenuePricingStructure(id: string) {
  const pricingStructure = await prisma.venuePricingStructure.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          transactionCosts: true,
        },
      },
    },
  })

  if (!pricingStructure) {
    throw new NotFoundError(`Venue pricing structure ${id} not found`)
  }

  // Prevent deletion if transaction costs reference this pricing structure
  if (pricingStructure._count.transactionCosts > 0) {
    throw new BadRequestError(
      `Cannot delete pricing structure because it's referenced by ${pricingStructure._count.transactionCosts} transaction cost(s). Deactivate instead.`,
    )
  }

  await prisma.venuePricingStructure.delete({
    where: { id },
  })

  logger.warn('Venue pricing structure deleted', {
    pricingStructureId: id,
    venueId: pricingStructure.venueId,
  })
}

/**
 * Helper: Create flat-rate venue pricing structure
 * Uses the same rate for all card types
 *
 * @param venueId Venue ID
 * @param accountType Account type
 * @param effectiveFrom Effective date
 * @param flatRate Rate to apply to all card types
 * @param monthlyServiceFee Optional monthly fee
 * @param notes Optional notes
 * @returns Created pricing structure
 */
export async function createFlatRatePricingStructure(
  venueId: string,
  accountType: AccountType,
  effectiveFrom: Date,
  flatRate: number,
  monthlyServiceFee?: number,
  notes?: string,
) {
  logger.info('Creating flat-rate venue pricing structure', {
    venueId,
    accountType,
    flatRate,
  })

  return createVenuePricingStructure({
    venueId,
    accountType,
    effectiveFrom,
    debitRate: flatRate,
    creditRate: flatRate,
    amexRate: flatRate,
    internationalRate: flatRate,
    monthlyServiceFee,
    notes: notes || 'Flat-rate pricing (same rate for all card types)',
  })
}
