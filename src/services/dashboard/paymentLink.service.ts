/**
 * Payment Link Service
 *
 * Manages payment link CRUD operations for the dashboard.
 * Payment links allow venues to generate shareable URLs for collecting payments.
 *
 * @module services/dashboard/paymentLink
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import logger from '@/config/logger'
import { nanoid } from 'nanoid'
import { logAction } from './activity-log.service'
import { getBlumonEcommerceService } from '@/services/sdk/blumon-ecommerce.service'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CreatePaymentLinkData {
  title: string
  description?: string
  imageUrl?: string
  amountType: 'FIXED' | 'OPEN'
  amount?: number
  currency?: string
  isReusable?: boolean
  expiresAt?: string
  redirectUrl?: string
}

export interface UpdatePaymentLinkData {
  title?: string
  description?: string | null
  imageUrl?: string | null
  amountType?: 'FIXED' | 'OPEN'
  amount?: number | null
  currency?: string
  isReusable?: boolean
  expiresAt?: string | null
  redirectUrl?: string | null
  status?: 'ACTIVE' | 'PAUSED'
}

export interface ListPaymentLinksFilters {
  status?: string
  search?: string
  limit?: number
  offset?: number
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new payment link for a venue
 */
export async function createPaymentLink(venueId: string, data: CreatePaymentLinkData, staffId: string) {
  // 1. Find the venue's active EcommerceMerchant (prefer Blumon with OAuth tokens)
  const ecommerceMerchant =
    (await prisma.ecommerceMerchant.findFirst({
      where: {
        venueId,
        active: true,
        provider: { code: 'BLUMON' },
      },
      select: { id: true },
    })) ||
    (await prisma.ecommerceMerchant.findFirst({
      where: { venueId, active: true },
      select: { id: true },
    }))

  if (!ecommerceMerchant) {
    throw new BadRequestError('Este venue no tiene una afiliación de e-commerce activa. Contacta a soporte para activarla.')
  }

  // 2. Generate unique short code
  const shortCode = nanoid(8)

  // 3. Create payment link
  const paymentLink = await prisma.paymentLink.create({
    data: {
      shortCode,
      venueId,
      ecommerceMerchantId: ecommerceMerchant.id,
      createdById: staffId,
      title: data.title,
      description: data.description,
      imageUrl: data.imageUrl,
      amountType: data.amountType,
      amount: data.amount !== undefined && data.amount !== null ? new Prisma.Decimal(data.amount) : undefined,
      currency: data.currency || 'MXN',
      isReusable: data.isReusable ?? false,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      redirectUrl: data.redirectUrl,
    },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      _count: {
        select: { checkoutSessions: true },
      },
    },
  })

  logger.info('Payment link created', {
    paymentLinkId: paymentLink.id,
    shortCode,
    venueId,
    amountType: data.amountType,
  })

  logAction({
    venueId,
    staffId,
    action: 'PAYMENT_LINK_CREATED',
    entity: 'PaymentLink',
    entityId: paymentLink.id,
  })

  return paymentLink
}

/**
 * Lists payment links for a venue with filtering
 */
export async function getPaymentLinks(venueId: string, filters: ListPaymentLinksFilters = {}) {
  const { status, search, limit = 20, offset = 0 } = filters

  const where: Prisma.PaymentLinkWhereInput = { venueId }

  if (status) {
    where.status = status as any
  }

  if (search) {
    where.title = { contains: search, mode: 'insensitive' }
  }

  const [paymentLinks, total] = await Promise.all([
    prisma.paymentLink.findMany({
      where,
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        _count: {
          select: { checkoutSessions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.paymentLink.count({ where }),
  ])

  return {
    paymentLinks,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  }
}

/**
 * Gets a single payment link by ID
 */
export async function getPaymentLinkById(venueId: string, linkId: string) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      checkoutSessions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          sessionId: true,
          amount: true,
          status: true,
          customerEmail: true,
          createdAt: true,
          completedAt: true,
        },
      },
      _count: {
        select: { checkoutSessions: true },
      },
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (paymentLink.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  return paymentLink
}

/**
 * Updates a payment link
 */
export async function updatePaymentLink(venueId: string, linkId: string, data: UpdatePaymentLinkData) {
  const existing = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    select: { id: true, venueId: true, status: true },
  })

  if (!existing) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (existing.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  if (existing.status === 'ARCHIVED') {
    throw new BadRequestError('No se puede editar una liga de pago archivada')
  }

  const updateData: Prisma.PaymentLinkUpdateInput = {}

  if (data.title !== undefined) updateData.title = data.title
  if (data.description !== undefined) updateData.description = data.description
  if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl
  if (data.amountType !== undefined) updateData.amountType = data.amountType
  if (data.amount !== undefined) {
    updateData.amount = data.amount !== null ? new Prisma.Decimal(data.amount) : null
  }
  if (data.currency !== undefined) updateData.currency = data.currency
  if (data.isReusable !== undefined) updateData.isReusable = data.isReusable
  if (data.expiresAt !== undefined) {
    updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
  }
  if (data.redirectUrl !== undefined) updateData.redirectUrl = data.redirectUrl
  if (data.status !== undefined) updateData.status = data.status

  const updated = await prisma.paymentLink.update({
    where: { id: linkId },
    data: updateData,
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      _count: {
        select: { checkoutSessions: true },
      },
    },
  })

  logger.info('Payment link updated', { paymentLinkId: linkId, venueId })

  logAction({
    venueId,
    action: 'PAYMENT_LINK_UPDATED',
    entity: 'PaymentLink',
    entityId: linkId,
  })

  return updated
}

/**
 * Archives a payment link (soft delete)
 */
export async function archivePaymentLink(venueId: string, linkId: string) {
  const existing = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    select: { id: true, venueId: true },
  })

  if (!existing) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (existing.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  await prisma.paymentLink.update({
    where: { id: linkId },
    data: { status: 'ARCHIVED' },
  })

  logger.info('Payment link archived', { paymentLinkId: linkId, venueId })

  logAction({
    venueId,
    action: 'PAYMENT_LINK_ARCHIVED',
    entity: 'PaymentLink',
    entityId: linkId,
  })

  return { success: true }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC (CHECKOUT FLOW)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves a payment link by short code (public, no auth)
 * Returns venue branding + link data for the checkout page
 */
export async function getPaymentLinkByShortCode(shortCode: string) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          primaryColor: true,
          secondaryColor: true,
        },
      },
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  // Check if link is active
  if (paymentLink.status !== 'ACTIVE') {
    throw new BadRequestError(paymentLink.status === 'EXPIRED' ? 'Esta liga de pago ha expirado' : 'Esta liga de pago no está disponible')
  }

  // Check if link has expired
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    // Auto-expire the link
    await prisma.paymentLink.update({
      where: { id: paymentLink.id },
      data: { status: 'EXPIRED' },
    })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }

  // Check if single-use link has already been paid
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }

  return {
    id: paymentLink.id,
    shortCode: paymentLink.shortCode,
    title: paymentLink.title,
    description: paymentLink.description,
    imageUrl: paymentLink.imageUrl,
    amountType: paymentLink.amountType,
    amount: paymentLink.amount,
    currency: paymentLink.currency,
    venue: paymentLink.venue,
  }
}

/**
 * Creates a checkout session and tokenizes the card
 */
export async function createCheckoutSession(
  shortCode: string,
  cardData: {
    pan: string
    cvv: string
    expMonth: string
    expYear: string
    holderName: string
    customerEmail?: string
    customerPhone?: string
    amount?: number
  },
) {
  // 1. Resolve payment link
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      ecommerceMerchant: {
        select: {
          id: true,
          sandboxMode: true,
          providerCredentials: true,
        },
      },
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (paymentLink.status !== 'ACTIVE') {
    throw new BadRequestError('Esta liga de pago no está disponible')
  }

  // Check expiration
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    await prisma.paymentLink.update({
      where: { id: paymentLink.id },
      data: { status: 'EXPIRED' },
    })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }

  // Check single-use
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }

  // 2. Determine amount
  let chargeAmount: number
  if (paymentLink.amountType === 'FIXED') {
    chargeAmount = Number(paymentLink.amount)
  } else {
    if (!cardData.amount || cardData.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    chargeAmount = cardData.amount
  }

  // 3. Get Blumon service
  const credentials = paymentLink.ecommerceMerchant.providerCredentials as Record<string, any>
  const accessToken = credentials.accessToken
  if (!accessToken) {
    throw new BadRequestError('Configuración de pago incompleta para este venue')
  }

  const blumonService = getBlumonEcommerceService(paymentLink.ecommerceMerchant.sandboxMode)

  // 4. Tokenize card
  const tokenResult = await blumonService.tokenizeCard({
    accessToken,
    pan: cardData.pan,
    cvv: cardData.cvv,
    expMonth: cardData.expMonth,
    expYear: cardData.expYear,
    holderName: cardData.holderName,
    customerEmail: cardData.customerEmail,
    customerPhone: cardData.customerPhone,
  })

  // 5. Create checkout session
  const sessionId = `cs_pl_${nanoid(16)}`
  const session = await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      paymentLinkId: paymentLink.id,
      amount: new Prisma.Decimal(chargeAmount),
      currency: paymentLink.currency,
      description: paymentLink.title,
      customerEmail: cardData.customerEmail,
      customerPhone: cardData.customerPhone,
      customerName: cardData.holderName,
      metadata: {
        cardToken: tokenResult.token,
        maskedPan: tokenResult.maskedPan,
        cardBrand: tokenResult.cardBrand,
        cvv: cardData.cvv, // Needed for charge step
      } as Prisma.InputJsonValue,
      status: 'PROCESSING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    },
  })

  logger.info('Checkout session created for payment link', {
    sessionId,
    paymentLinkId: paymentLink.id,
    shortCode,
    amount: chargeAmount,
  })

  // 6. TODO: 3DS registration would happen here when implemented
  // For now, proceed directly to charge-ready state
  return {
    sessionId: session.sessionId,
    amount: chargeAmount,
    currency: paymentLink.currency,
    maskedPan: tokenResult.maskedPan,
    cardBrand: tokenResult.cardBrand,
    // threeDSUrl: null, // Would contain 3DS challenge URL if needed
  }
}

/**
 * Completes the charge for a checkout session
 */
export async function completeCharge(shortCode: string, sessionId: string, threeDSTransactionId?: string) {
  // 1. Find session
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    include: {
      paymentLink: {
        select: { id: true, shortCode: true, venueId: true },
      },
      ecommerceMerchant: {
        select: {
          id: true,
          sandboxMode: true,
          providerCredentials: true,
        },
      },
    },
  })

  if (!session) {
    throw new NotFoundError('Sesión de pago no encontrada')
  }

  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }

  if (session.status !== 'PROCESSING') {
    throw new BadRequestError(
      session.status === 'COMPLETED' ? 'Este pago ya fue procesado' : `No se puede cobrar una sesión con estado ${session.status}`,
    )
  }

  // 2. Extract card token from metadata
  const metadata = session.metadata as Record<string, any>
  const cardToken = metadata?.cardToken
  const cvv = metadata?.cvv

  if (!cardToken) {
    throw new BadRequestError('Token de tarjeta no encontrado en la sesión')
  }

  // 3. Get Blumon service and charge
  const credentials = session.ecommerceMerchant.providerCredentials as Record<string, any>
  const accessToken = credentials.accessToken
  const blumonService = getBlumonEcommerceService(session.ecommerceMerchant.sandboxMode)

  const chargeResult = await blumonService.authorizePayment({
    accessToken,
    amount: Number(session.amount),
    currency: session.currency === 'MXN' ? '484' : session.currency,
    cardToken,
    cvv,
    orderId: session.sessionId,
  })

  // 4. Update session and payment link in transaction
  await prisma.$transaction([
    prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        blumonCheckoutId: chargeResult.transactionId,
        // Clear sensitive data from metadata
        metadata: {
          maskedPan: metadata.maskedPan,
          cardBrand: metadata.cardBrand,
          authorizationCode: chargeResult.authorizationCode,
          transactionId: chargeResult.transactionId,
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.paymentLink.update({
      where: { id: session.paymentLink!.id },
      data: {
        totalCollected: { increment: session.amount },
        paymentCount: { increment: 1 },
      },
    }),
  ])

  logger.info('Payment link charge completed', {
    sessionId,
    paymentLinkId: session.paymentLink!.id,
    amount: Number(session.amount),
    transactionId: chargeResult.transactionId,
  })

  return {
    status: 'COMPLETED',
    amount: Number(session.amount),
    currency: session.currency,
    transactionId: chargeResult.transactionId,
    authorizationCode: chargeResult.authorizationCode,
  }
}

/**
 * Gets the status of a checkout session (for polling after 3DS)
 */
export async function getSessionStatus(shortCode: string, sessionId: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      status: true,
      amount: true,
      currency: true,
      completedAt: true,
      errorMessage: true,
      paymentLink: {
        select: { shortCode: true, redirectUrl: true },
      },
    },
  })

  if (!session) {
    throw new NotFoundError('Sesión de pago no encontrada')
  }

  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }

  return {
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    completedAt: session.completedAt,
    errorMessage: session.errorMessage,
    redirectUrl: session.paymentLink?.redirectUrl,
  }
}
