/**
 * E-commerce Merchant Service
 *
 * Manages e-commerce merchant accounts for card-not-present payments.
 * Venues can have multiple e-commerce channels (Web, App, Marketplace).
 *
 * **Architecture Decision (2025-01-13)**:
 * - EcommerceMerchant belongs to Venue (same business, different sales channel)
 * - Separate from MerchantAccount (physical terminals vs online channels)
 * - Follows industry standard: Square, Toast, Stripe, Clover
 *
 * @module services/dashboard/ecommerceMerchant
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import logger from '@/config/logger'
import { generateAPIKeys } from '@/middlewares/sdk-auth.middleware'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateEcommerceMerchantData {
  venueId: string
  channelName: string
  businessName: string
  rfc?: string
  contactEmail: string
  contactPhone?: string
  website?: string
  providerId: string
  providerCredentials: Record<string, any>
  costStructureId?: string
  pricingStructureId?: string
  webhookUrl?: string
  webhookEvents?: string[]
  dashboardUserId?: string
  active?: boolean
  sandboxMode?: boolean
}

export interface UpdateEcommerceMerchantData {
  channelName?: string
  businessName?: string
  rfc?: string
  contactEmail?: string
  contactPhone?: string
  website?: string
  providerId?: string
  providerCredentials?: Record<string, any>
  costStructureId?: string
  pricingStructureId?: string
  webhookUrl?: string
  webhookEvents?: string[]
  dashboardUserId?: string
  active?: boolean
  sandboxMode?: boolean
}

export interface ListEcommerceMerchantsFilters {
  venueId?: string
  active?: boolean
  sandboxMode?: boolean
  providerId?: string
  limit?: number
  offset?: number
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new e-commerce merchant account
 *
 * @param data - Merchant account creation data
 * @returns Created merchant with API keys (show secret key only once!)
 */
export async function createEcommerceMerchant(data: CreateEcommerceMerchantData) {
  // 1. Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
    select: { id: true, name: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${data.venueId} not found`)
  }

  // 2. Check if channel name already exists for this venue
  const existingChannel = await prisma.ecommerceMerchant.findFirst({
    where: {
      venueId: data.venueId,
      channelName: data.channelName,
    },
  })

  if (existingChannel) {
    throw new BadRequestError(`Channel "${data.channelName}" already exists for this venue. Use a different channel name.`)
  }

  // 3. Validate provider exists
  const provider = await prisma.paymentProvider.findUnique({
    where: { id: data.providerId },
    select: { id: true, code: true, name: true },
  })

  if (!provider) {
    throw new NotFoundError(`Provider with ID ${data.providerId} not found`)
  }

  // 4. Generate API keys (pk_live_xxx / sk_live_xxx or pk_test_xxx / sk_test_xxx)
  const sandboxMode = data.sandboxMode ?? true
  const { publicKey, secretKey, secretKeyHash } = generateAPIKeys(sandboxMode)

  // 5. Create merchant
  const merchant = await prisma.ecommerceMerchant.create({
    data: {
      venueId: data.venueId,
      channelName: data.channelName,
      businessName: data.businessName,
      rfc: data.rfc,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      website: data.website,
      publicKey,
      secretKeyHash,
      providerId: data.providerId,
      providerCredentials: data.providerCredentials as Prisma.InputJsonValue,
      costStructureId: data.costStructureId,
      pricingStructureId: data.pricingStructureId,
      webhookUrl: data.webhookUrl,
      webhookEvents: data.webhookEvents || ['payment.completed', 'payment.failed'],
      dashboardUserId: data.dashboardUserId,
      active: data.active ?? true,
      sandboxMode,
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      provider: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      costStructure: {
        select: {
          id: true,
          debitRate: true,
          creditRate: true,
        },
      },
      pricingStructure: {
        select: {
          id: true,
        },
      },
    },
  })

  logger.info('E-commerce merchant created', {
    merchantId: merchant.id,
    venueId: data.venueId,
    channelName: data.channelName,
    sandboxMode,
  })

  // ⚠️ SECURITY: Return plaintext secret key ONLY on creation
  // This is the ONLY time the client can see it
  return {
    ...merchant,
    secretKey, // ⚡ Show secret key only once
    secretKeyHash: undefined, // Don't expose hash
  }
}

/**
 * Lists e-commerce merchants with filtering
 *
 * @param filters - Optional filters for querying
 * @returns List of merchants (WITHOUT secret keys)
 */
export async function listEcommerceMerchants(filters: ListEcommerceMerchantsFilters = {}) {
  const { venueId, active, sandboxMode, providerId, limit = 20, offset = 0 } = filters

  const where: Prisma.EcommerceMerchantWhereInput = {}

  if (venueId) where.venueId = venueId
  if (active !== undefined) where.active = active
  if (sandboxMode !== undefined) where.sandboxMode = sandboxMode
  if (providerId) where.providerId = providerId

  const [merchants, total] = await Promise.all([
    prisma.ecommerceMerchant.findMany({
      where,
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        provider: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        costStructure: {
          select: {
            id: true,
            debitRate: true,
            creditRate: true,
          },
        },
        pricingStructure: {
          select: {
            id: true,
            debitRate: true,
            creditRate: true,
          },
        },
        _count: {
          select: {
            checkoutSessions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.ecommerceMerchant.count({ where }),
  ])

  // ⚠️ SECURITY: Never expose secret key hashes
  const safeMerchants = merchants.map(m => ({
    ...m,
    secretKeyHash: undefined,
  }))

  return {
    merchants: safeMerchants,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  }
}

/**
 * Gets a single e-commerce merchant by ID
 *
 * @param merchantId - E-commerce merchant ID
 * @param venueId - Optional venue ID for authorization check
 * @returns Merchant details (WITHOUT secret key)
 */
export async function getEcommerceMerchantById(merchantId: string, venueId?: string) {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      provider: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
        },
      },
      costStructure: {
        select: {
          id: true,
          debitRate: true,
          creditRate: true,
        },
      },
      pricingStructure: {
        select: {
          id: true,
          debitRate: true,
          creditRate: true,
        },
      },
      _count: {
        select: {
          checkoutSessions: true,
        },
      },
    },
  })

  if (!merchant) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  // Authorization check: if venueId provided, verify it matches
  if (venueId && merchant.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // ⚠️ SECURITY: Never expose secret key hash
  return {
    ...merchant,
    secretKeyHash: undefined,
  }
}

/**
 * Updates an e-commerce merchant
 *
 * @param merchantId - E-commerce merchant ID
 * @param data - Update data
 * @param venueId - Optional venue ID for authorization check
 * @returns Updated merchant
 */
export async function updateEcommerceMerchant(merchantId: string, data: UpdateEcommerceMerchantData, venueId?: string) {
  // 1. Verify merchant exists
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: { id: true, venueId: true, channelName: true },
  })

  if (!existing) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  // 2. Authorization check
  if (venueId && existing.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // 3. If changing channelName, check uniqueness
  if (data.channelName && data.channelName !== existing.channelName) {
    const duplicate = await prisma.ecommerceMerchant.findFirst({
      where: {
        venueId: existing.venueId,
        channelName: data.channelName,
        id: { not: merchantId }, // Exclude current merchant
      },
    })

    if (duplicate) {
      throw new BadRequestError(`Channel "${data.channelName}" already exists for this venue`)
    }
  }

  // 4. Build update data
  const updateData: Prisma.EcommerceMerchantUpdateInput = {}

  if (data.channelName !== undefined) updateData.channelName = data.channelName
  if (data.businessName !== undefined) updateData.businessName = data.businessName
  if (data.rfc !== undefined) updateData.rfc = data.rfc
  if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail
  if (data.contactPhone !== undefined) updateData.contactPhone = data.contactPhone
  if (data.website !== undefined) updateData.website = data.website
  if (data.providerId !== undefined) {
    updateData.provider = { connect: { id: data.providerId } }
  }
  if (data.providerCredentials !== undefined) {
    updateData.providerCredentials = data.providerCredentials as Prisma.InputJsonValue
  }
  if (data.costStructureId !== undefined) {
    updateData.costStructure = data.costStructureId ? { connect: { id: data.costStructureId } } : { disconnect: true }
  }
  if (data.pricingStructureId !== undefined) {
    updateData.pricingStructure = data.pricingStructureId ? { connect: { id: data.pricingStructureId } } : { disconnect: true }
  }
  if (data.webhookUrl !== undefined) updateData.webhookUrl = data.webhookUrl
  if (data.webhookEvents !== undefined) updateData.webhookEvents = data.webhookEvents
  if (data.dashboardUserId !== undefined) {
    updateData.dashboardUser = data.dashboardUserId ? { connect: { id: data.dashboardUserId } } : { disconnect: true }
  }
  if (data.active !== undefined) updateData.active = data.active
  if (data.sandboxMode !== undefined) updateData.sandboxMode = data.sandboxMode

  // 5. Update merchant
  const updated = await prisma.ecommerceMerchant.update({
    where: { id: merchantId },
    data: updateData,
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      provider: { select: { id: true, code: true, name: true } },
      costStructure: { select: { id: true, debitRate: true, creditRate: true } },
      pricingStructure: { select: { id: true } },
    },
  })

  logger.info('E-commerce merchant updated', {
    merchantId,
    venueId: existing.venueId,
  })

  return {
    ...updated,
    secretKeyHash: undefined,
  }
}

/**
 * Toggles e-commerce merchant active status
 *
 * @param merchantId - E-commerce merchant ID
 * @param active - New active status
 * @param venueId - Optional venue ID for authorization check
 * @returns Updated merchant
 */
export async function toggleEcommerceMerchantStatus(merchantId: string, active: boolean, venueId?: string) {
  // Verify merchant exists and authorize
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: { id: true, venueId: true, active: true },
  })

  if (!existing) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  if (venueId && existing.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  const updated = await prisma.ecommerceMerchant.update({
    where: { id: merchantId },
    data: { active },
    select: {
      id: true,
      active: true,
      channelName: true,
    },
  })

  logger.info('E-commerce merchant status toggled', {
    merchantId,
    active,
  })

  return updated
}

/**
 * Regenerates API keys for an e-commerce merchant
 * ⚠️ WARNING: This invalidates old keys - all clients must update!
 *
 * @param merchantId - E-commerce merchant ID
 * @param venueId - Optional venue ID for authorization check
 * @returns New keys (show secret key only once!)
 */
export async function regenerateAPIKeys(merchantId: string, venueId?: string) {
  // 1. Verify merchant exists and authorize
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: { id: true, venueId: true, sandboxMode: true },
  })

  if (!existing) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  if (venueId && existing.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // 2. Generate new keys
  const { publicKey, secretKey, secretKeyHash } = generateAPIKeys(existing.sandboxMode)

  // 3. Update merchant
  const updated = await prisma.ecommerceMerchant.update({
    where: { id: merchantId },
    data: {
      publicKey,
      secretKeyHash,
    },
    select: {
      id: true,
      publicKey: true,
      channelName: true,
      sandboxMode: true,
    },
  })

  logger.warn('⚠️ API keys regenerated - old keys are now INVALID', {
    merchantId,
    venueId: existing.venueId,
  })

  // ⚠️ SECURITY: Return plaintext secret key ONLY once
  return {
    ...updated,
    secretKey, // ⚡ Show new secret key only once
  }
}

/**
 * Deletes an e-commerce merchant
 * ⚠️ CASCADE: Also deletes all checkout sessions
 *
 * @param merchantId - E-commerce merchant ID
 * @param venueId - Optional venue ID for authorization check
 */
export async function deleteEcommerceMerchant(merchantId: string, venueId?: string) {
  // 1. Verify merchant exists and authorize
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: { id: true, venueId: true, channelName: true },
  })

  if (!existing) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  if (venueId && existing.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // 2. Check if there are active checkout sessions
  const activeSessions = await prisma.checkoutSession.count({
    where: {
      ecommerceMerchantId: merchantId,
      status: {
        in: ['PENDING', 'PROCESSING'],
      },
    },
  })

  if (activeSessions > 0) {
    throw new BadRequestError(`Cannot delete merchant with ${activeSessions} active checkout sessions. Cancel them first.`)
  }

  // 3. Delete merchant (cascade will delete checkout sessions)
  await prisma.ecommerceMerchant.delete({
    where: { id: merchantId },
  })

  logger.warn('E-commerce merchant deleted', {
    merchantId,
    venueId: existing.venueId,
    channelName: existing.channelName,
  })

  return { success: true, merchantId }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets API keys for an e-commerce merchant (publicKey only, secret is masked)
 *
 * @param merchantId - E-commerce merchant ID
 * @param venueId - Optional venue ID for authorization check
 * @returns Public key and masked secret key
 */
export async function getAPIKeys(merchantId: string, venueId?: string) {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      venueId: true,
      publicKey: true,
      sandboxMode: true,
      channelName: true,
    },
  })

  if (!merchant) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  if (venueId && merchant.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // ⚠️ SECURITY: Never return actual secret key after creation
  const maskedSecretKey = merchant.sandboxMode ? 'sk_test_••••••••••••••••' : 'sk_live_••••••••••••••••'

  return {
    publicKey: merchant.publicKey,
    secretKey: maskedSecretKey,
    sandboxMode: merchant.sandboxMode,
    channelName: merchant.channelName,
  }
}
