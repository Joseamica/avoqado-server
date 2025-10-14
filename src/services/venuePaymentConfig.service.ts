import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface VenuePaymentConfigCreateInput {
  venueId: string
  primaryAccountId: string
  secondaryAccountId?: string
  tertiaryAccountId?: string
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
}

interface VenuePaymentConfigUpdateInput {
  primaryAccountId?: string
  secondaryAccountId?: string
  tertiaryAccountId?: string
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
}

/**
 * Get payment config for a venue
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
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
      secondaryAccount: {
        include: {
          provider: true,
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
      tertiaryAccount: {
        include: {
          provider: true,
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
    },
  })

  return config
}

/**
 * Create payment config for a venue
 */
export async function createVenuePaymentConfig(data: VenuePaymentConfigCreateInput) {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new Error('Venue not found')
  }

  // Check if config already exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId: data.venueId },
  })

  if (existingConfig) {
    throw new Error('Payment config already exists for this venue')
  }

  // Verify merchant accounts exist and are active
  const primaryAccount = await prisma.merchantAccount.findUnique({
    where: { id: data.primaryAccountId },
  })

  if (!primaryAccount || !primaryAccount.active) {
    throw new Error('Primary account not found or inactive')
  }

  if (data.secondaryAccountId) {
    const secondaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })

    if (!secondaryAccount || !secondaryAccount.active) {
      throw new Error('Secondary account not found or inactive')
    }
  }

  if (data.tertiaryAccountId) {
    const tertiaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })

    if (!tertiaryAccount || !tertiaryAccount.active) {
      throw new Error('Tertiary account not found or inactive')
    }
  }

  // Create payment config
  const config = await prisma.venuePaymentConfig.create({
    data: {
      venueId: data.venueId,
      primaryAccountId: data.primaryAccountId,
      secondaryAccountId: data.secondaryAccountId,
      tertiaryAccountId: data.tertiaryAccountId,
      routingRules: data.routingRules || {},
      preferredProcessor: data.preferredProcessor || 'AUTO',
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

  return config
}

/**
 * Update payment config for a venue
 */
export async function updateVenuePaymentConfig(configId: string, data: VenuePaymentConfigUpdateInput) {
  // Verify config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { id: configId },
  })

  if (!existingConfig) {
    throw new Error('Payment config not found')
  }

  // Verify merchant accounts if provided
  if (data.primaryAccountId) {
    const primaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.primaryAccountId },
    })

    if (!primaryAccount || !primaryAccount.active) {
      throw new Error('Primary account not found or inactive')
    }
  }

  if (data.secondaryAccountId) {
    const secondaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })

    if (!secondaryAccount || !secondaryAccount.active) {
      throw new Error('Secondary account not found or inactive')
    }
  }

  if (data.tertiaryAccountId) {
    const tertiaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })

    if (!tertiaryAccount || !tertiaryAccount.active) {
      throw new Error('Tertiary account not found or inactive')
    }
  }

  // Update payment config
  const config = await prisma.venuePaymentConfig.update({
    where: { id: configId },
    data: {
      primaryAccountId: data.primaryAccountId,
      secondaryAccountId: data.secondaryAccountId,
      tertiaryAccountId: data.tertiaryAccountId,
      routingRules: data.routingRules,
      preferredProcessor: data.preferredProcessor,
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

  return config
}

/**
 * Delete payment config for a venue
 */
export async function deleteVenuePaymentConfig(configId: string) {
  // Verify config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { id: configId },
  })

  if (!existingConfig) {
    throw new Error('Payment config not found')
  }

  // Delete payment config
  await prisma.venuePaymentConfig.delete({
    where: { id: configId },
  })

  return { success: true }
}

/**
 * Get merchant accounts for a venue (based on payment config)
 */
export async function getVenueMerchantAccounts(venueId: string) {
  const config = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
    include: {
      primaryAccount: {
        include: {
          provider: true,
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              transactionCosts: true,
            },
          },
        },
      },
      secondaryAccount: {
        include: {
          provider: true,
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              transactionCosts: true,
            },
          },
        },
      },
      tertiaryAccount: {
        include: {
          provider: true,
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              transactionCosts: true,
            },
          },
        },
      },
    },
  })

  if (!config) {
    return []
  }

  const accounts = []

  if (config.primaryAccount) {
    accounts.push({
      ...config.primaryAccount,
      accountType: 'PRIMARY',
    })
  }

  if (config.secondaryAccount) {
    accounts.push({
      ...config.secondaryAccount,
      accountType: 'SECONDARY',
    })
  }

  if (config.tertiaryAccount) {
    accounts.push({
      ...config.tertiaryAccount,
      accountType: 'TERTIARY',
    })
  }

  return accounts
}

/**
 * Get venue pricing structures for a venue
 */
export async function getVenuePricingByVenue(venueId: string) {
  const pricingStructures = await prisma.venuePricingStructure.findMany({
    where: {
      venueId,
      active: true,
    },
    orderBy: [{ accountType: 'asc' }, { effectiveFrom: 'desc' }],
  })

  return pricingStructures
}

/**
 * Get active cost structures for venue's merchant accounts
 */
export async function getVenueCostStructures(venueId: string) {
  const accounts = await getVenueMerchantAccounts(venueId)

  const costStructures = []

  for (const account of accounts) {
    if (account.costStructures && account.costStructures.length > 0) {
      costStructures.push({
        ...account.costStructures[0],
        accountType: account.accountType,
        merchantAccount: {
          id: account.id,
          displayName: account.displayName,
          alias: account.alias,
        },
      })
    }
  }

  return costStructures
}
