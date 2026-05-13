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
import { logAction } from './activity-log.service'
import { getEcommercePlatformFeeBpsDefault } from '@/services/superadmin/platformSettings.service'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateEcommerceMerchantData {
  venueId: string
  channelName: string
  /**
   * Legal business name. Optional from the client: for Stripe Connect, Stripe
   * collects it during hosted onboarding, so the wizard only asks for
   * channelName. The service defaults this to channelName when missing.
   */
  businessName?: string
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

  // 4. Resolve sandbox mode.
  //
  // For Stripe Connect, the client never picks test vs live — Stripe routes
  // requests based on which API key the platform is using. Derive from the
  // STRIPE_SECRET_KEY prefix so the UI badge matches the actual environment
  // (sk_test_* → sandbox, sk_live_* → live).
  //
  // Other providers (Blumon, etc.) honor whatever the client passed.
  const isStripeConnect = provider.code === 'STRIPE_CONNECT'
  const sandboxMode = isStripeConnect ? !(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_') : (data.sandboxMode ?? true)

  // 5. Generate API keys (pk_live_xxx / sk_live_xxx or pk_test_xxx / sk_test_xxx)
  const { publicKey, secretKey, secretKeyHash } = generateAPIKeys(sandboxMode)

  // 6. Resolve the platform fee default from PlatformSettings (singleton).
  //    The DB column still has a hardcoded @default(100) at the Prisma layer
  //    as a safety net, but this overrides it so Avoqado can adjust the
  //    default fee for new merchants without touching code.
  const platformFeeBpsDefault = await getEcommercePlatformFeeBpsDefault()

  // 5. Create merchant
  const merchant = await prisma.ecommerceMerchant.create({
    data: {
      venueId: data.venueId,
      channelName: data.channelName,
      businessName: data.businessName?.trim() || data.channelName,
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
      platformFeeBps: platformFeeBpsDefault,
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

  logAction({
    venueId: data.venueId,
    action: 'ECOMMERCE_MERCHANT_CREATED',
    entity: 'EcommerceMerchant',
    entityId: merchant.id,
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

  logAction({
    venueId: existing.venueId,
    action: 'ECOMMERCE_MERCHANT_UPDATED',
    entity: 'EcommerceMerchant',
    entityId: merchantId,
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
 * Updates the platform fee (Avoqado's margin) on an e-commerce merchant.
 *
 * Range validation is in the controller — this only does ownership/existence
 * checks and the update. Caller is responsible for SUPERADMIN authorization
 * (route middleware enforces it).
 *
 * @param merchantId - E-commerce merchant ID
 * @param venueId - Venue ID for authorization scope (must match merchant)
 * @param platformFeeBps - New fee in basis points (integer, 0-3000)
 */
export async function updatePlatformFeeBps(merchantId: string, venueId: string, platformFeeBps: number) {
  const existing = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    select: { id: true, venueId: true, channelName: true, platformFeeBps: true },
  })

  if (!existing) throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  if (existing.venueId !== venueId) throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')

  const updated = await prisma.ecommerceMerchant.update({
    where: { id: merchantId },
    data: { platformFeeBps },
    select: { id: true, channelName: true, platformFeeBps: true },
  })

  logger.info('Platform fee updated for e-commerce merchant', {
    merchantId,
    venueId,
    oldFeeBps: existing.platformFeeBps,
    newFeeBps: platformFeeBps,
  })

  logAction({
    venueId,
    action: 'ECOMMERCE_MERCHANT_PLATFORM_FEE_UPDATED',
    entity: 'EcommerceMerchant',
    entityId: merchantId,
    data: { oldFeeBps: existing.platformFeeBps, newFeeBps: platformFeeBps } as Prisma.InputJsonValue,
  })

  return updated
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
    select: {
      id: true,
      venueId: true,
      channelName: true,
      chargesEnabled: true,
      onboardingStatus: true,
      provider: { select: { code: true } },
    },
  })

  if (!existing) {
    throw new NotFoundError(`E-commerce merchant with ID ${merchantId} not found`)
  }

  if (venueId && existing.venueId !== venueId) {
    throw new UnauthorizedError('Unauthorized access to this e-commerce merchant')
  }

  // 2. Soft-delete gate for Stripe Connect.
  //
  // If a Stripe Connect account is fully onboarded (charges enabled) we refuse
  // hard delete: there's a live `acct_*` in Stripe that can still receive
  // disputes, chargebacks and payouts. Hard-deleting our row would orphan it.
  //
  // The OWNER should use the "Desactivar" flow (toggle endpoint sets
  // active=false) which pauses operations but preserves the Stripe account
  // and audit trail. Permanent removal requires SUPERADMIN offboarding via
  // /superadmin/stripe-connect/offboard (which also surfaces disputes /
  // refunds / paid deposits that need attention first).
  if (existing.provider?.code === 'STRIPE_CONNECT' && existing.chargesEnabled) {
    throw new BadRequestError(
      'Esta cuenta de Stripe ya está activa y procesando pagos. No se puede eliminar directamente. Usa "Desactivar" para pausar el canal — para eliminarla permanentemente contacta a soporte (requiere offboarding de Stripe).',
    )
  }

  // 3. Check for blockers (FK constraints). Active checkout sessions are
  // payments in progress — blocking is obvious. Payment links also reference
  // the merchant and the Prisma relation is Restrict by default, so they too
  // need to be cleaned up first.
  const [activeSessions, linkedPaymentLinks] = await Promise.all([
    prisma.checkoutSession.count({
      where: {
        ecommerceMerchantId: merchantId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
    prisma.paymentLink.count({ where: { ecommerceMerchantId: merchantId } }),
  ])

  if (activeSessions > 0) {
    throw new BadRequestError(
      `No se puede eliminar este canal: tiene ${activeSessions} sesi${activeSessions === 1 ? 'ón' : 'ones'} de pago activa${
        activeSessions === 1 ? '' : 's'
      }. Cancela esas sesiones e inténtalo de nuevo.`,
    )
  }

  if (linkedPaymentLinks > 0) {
    throw new BadRequestError(
      `No se puede eliminar este canal: tiene ${linkedPaymentLinks} liga${linkedPaymentLinks === 1 ? '' : 's'} de pago asociada${
        linkedPaymentLinks === 1 ? '' : 's'
      }. Archívalas o elimínalas desde "Ligas de pago" primero.`,
    )
  }

  // 3. Delete merchant (cascade will delete remaining non-active checkout sessions)
  await prisma.ecommerceMerchant.delete({
    where: { id: merchantId },
  })

  logger.warn('E-commerce merchant deleted', {
    merchantId,
    venueId: existing.venueId,
    channelName: existing.channelName,
  })

  logAction({
    venueId: existing.venueId,
    action: 'ECOMMERCE_MERCHANT_DELETED',
    entity: 'EcommerceMerchant',
    entityId: merchantId,
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
