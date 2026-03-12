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
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CustomFieldDefinition {
  id: string
  type: 'TEXT' | 'SELECT'
  label: string
  required: boolean
  options?: string[]
}

export interface TippingConfig {
  presets: number[]
  allowCustom: boolean
}

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
  purpose?: 'PAYMENT' | 'ITEM' | 'DONATION'
  productId?: string
  customFields?: CustomFieldDefinition[] | null
  tippingConfig?: TippingConfig | null
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
  productId?: string | null
  customFields?: CustomFieldDefinition[] | null
  tippingConfig?: TippingConfig | null
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

  // 2. If purpose is ITEM, validate productId belongs to venue
  if (data.purpose === 'ITEM') {
    if (!data.productId) {
      throw new BadRequestError('El producto es requerido para ligas de pago de artículo')
    }
    const product = await prisma.product.findFirst({
      where: { id: data.productId, venueId },
      select: { id: true },
    })
    if (!product) {
      throw new BadRequestError('El producto no existe o no pertenece a este venue')
    }
  }

  // 3. Generate unique short code
  const shortCode = nanoid(8)

  // 4. Create payment link
  const paymentLink = await prisma.paymentLink.create({
    data: {
      shortCode,
      venueId,
      ecommerceMerchantId: ecommerceMerchant.id,
      createdById: staffId,
      purpose: data.purpose || 'PAYMENT',
      productId: data.purpose === 'ITEM' ? data.productId : undefined,
      title: data.title,
      description: data.description,
      imageUrl: data.imageUrl,
      amountType: data.amountType,
      amount: data.amount !== undefined && data.amount !== null ? new Prisma.Decimal(data.amount) : undefined,
      currency: data.currency || 'MXN',
      isReusable: data.isReusable ?? false,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      redirectUrl: data.redirectUrl,
      customFields: data.customFields ? (data.customFields as unknown as Prisma.InputJsonValue) : undefined,
      tippingConfig: data.tippingConfig ? (data.tippingConfig as unknown as Prisma.InputJsonValue) : undefined,
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
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
        },
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
  if (data.productId !== undefined) {
    if (data.productId) {
      // Validate the product belongs to this venue
      const product = await prisma.product.findFirst({
        where: { id: data.productId, venueId, deletedAt: null },
        select: { id: true },
      })
      if (!product) {
        throw new BadRequestError('Producto no encontrado en este venue')
      }
      updateData.product = { connect: { id: data.productId } }
    } else {
      updateData.product = { disconnect: true }
    }
  }
  if (data.customFields !== undefined) {
    updateData.customFields = data.customFields === null ? Prisma.JsonNull : (data.customFields as unknown as Prisma.InputJsonValue)
  }
  if (data.tippingConfig !== undefined) {
    updateData.tippingConfig = data.tippingConfig === null ? Prisma.JsonNull : (data.tippingConfig as unknown as Prisma.InputJsonValue)
  }

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
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
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
    purpose: paymentLink.purpose,
    title: paymentLink.title,
    description: paymentLink.description,
    imageUrl: paymentLink.imageUrl,
    amountType: paymentLink.amountType,
    amount: paymentLink.amount,
    currency: paymentLink.currency,
    venue: paymentLink.venue,
    product: paymentLink.product,
    customFields: paymentLink.customFields,
    tippingConfig: paymentLink.tippingConfig,
    redirectUrl: paymentLink.redirectUrl,
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
    quantity?: number
    tipAmount?: number
    customFieldResponses?: Record<string, string>
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
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          taxRate: true,
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
  const quantity = cardData.quantity || 1
  let chargeAmount: number

  if (paymentLink.purpose === 'ITEM' && paymentLink.product) {
    // For ITEM links, calculate amount from product price * quantity
    chargeAmount = Number(paymentLink.product.price) * quantity
  } else if (paymentLink.amountType === 'FIXED') {
    chargeAmount = Number(paymentLink.amount)
  } else {
    if (!cardData.amount || cardData.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    chargeAmount = cardData.amount
  }

  // 2b. Validate custom field responses if link has custom fields
  const customFields = paymentLink.customFields as CustomFieldDefinition[] | null
  if (customFields && customFields.length > 0) {
    for (const field of customFields) {
      if (field.required) {
        const response = cardData.customFieldResponses?.[field.id]
        if (!response || response.trim() === '') {
          throw new BadRequestError(`El campo "${field.label}" es requerido`)
        }
      }
      // Validate SELECT field options
      if (field.type === 'SELECT' && field.options && cardData.customFieldResponses?.[field.id]) {
        if (!field.options.includes(cardData.customFieldResponses[field.id])) {
          throw new BadRequestError(`Opción inválida para el campo "${field.label}"`)
        }
      }
    }
  }

  // 2c. Calculate tip amount
  const tipAmount = cardData.tipAmount && cardData.tipAmount > 0 ? cardData.tipAmount : 0
  const tippingConfig = paymentLink.tippingConfig as TippingConfig | null
  if (tipAmount > 0 && !tippingConfig) {
    throw new BadRequestError('Esta liga de pago no acepta propinas')
  }

  // Add tip to total charge amount
  chargeAmount = chargeAmount + tipAmount

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
        // Tip tracking
        ...(tipAmount > 0 && { tipAmount }),
        // Custom field responses
        ...(cardData.customFieldResponses && { customFieldResponses: cardData.customFieldResponses }),
        // ITEM link metadata for order creation
        ...(paymentLink.purpose === 'ITEM' &&
          paymentLink.product && {
            purpose: 'ITEM',
            productId: paymentLink.product.id,
            productName: paymentLink.product.name,
            productPrice: Number(paymentLink.product.price),
            quantity,
          }),
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
        select: { id: true, shortCode: true, venueId: true, purpose: true, productId: true, createdById: true },
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

  // 4. Update session and payment link + create Order for ITEM links
  const isItemLink = session.paymentLink!.purpose === 'ITEM' && metadata.productId
  const venueId = session.paymentLink!.venueId

  await prisma.$transaction(async tx => {
    // Update checkout session
    await tx.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        blumonCheckoutId: chargeResult.transactionId,
        metadata: {
          maskedPan: metadata.maskedPan,
          cardBrand: metadata.cardBrand,
          authorizationCode: chargeResult.authorizationCode,
          transactionId: chargeResult.transactionId,
          // Preserve tip and custom field data
          ...(metadata.tipAmount && { tipAmount: metadata.tipAmount }),
          ...(metadata.customFieldResponses && { customFieldResponses: metadata.customFieldResponses }),
          // Preserve product info for reference
          ...(isItemLink && {
            productId: metadata.productId,
            productName: metadata.productName,
            quantity: metadata.quantity,
          }),
        } as Prisma.InputJsonValue,
      },
    })

    // Update payment link counters
    await tx.paymentLink.update({
      where: { id: session.paymentLink!.id },
      data: {
        totalCollected: { increment: session.amount },
        paymentCount: { increment: 1 },
      },
    })

    // For ITEM links: create Order + OrderItems (like TPV flow)
    if (isItemLink) {
      const quantity = metadata.quantity || 1
      const unitPrice = new Prisma.Decimal(metadata.productPrice)
      const subtotal = unitPrice.mul(quantity)
      const taxAmount = new Prisma.Decimal(0) // Tax included in price for payment links
      const orderTipAmount = new Prisma.Decimal(metadata.tipAmount || 0)
      const total = subtotal.add(orderTipAmount)

      const orderNumber = `PL-${Date.now()}`

      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          type: 'TAKEOUT',
          source: 'PAYMENT_LINK',
          createdById: session.paymentLink!.createdById,
          customerName: session.customerName,
          customerEmail: session.customerEmail,
          subtotal,
          discountAmount: 0,
          taxAmount,
          tipAmount: orderTipAmount,
          total,
          paidAmount: total,
          remainingBalance: 0,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          completedAt: new Date(),
          items: {
            create: {
              productId: metadata.productId,
              productName: metadata.productName,
              quantity,
              unitPrice,
              discountAmount: 0,
              taxAmount,
              total,
            },
          },
        },
      })

      logger.info('Order created for ITEM payment link', {
        orderId: order.id,
        orderNumber,
        paymentLinkId: session.paymentLink!.id,
        productId: metadata.productId,
        quantity,
      })
    }
  })

  // 5. Deduct inventory AFTER transaction (non-blocking, same pattern as TPV)
  if (isItemLink) {
    const quantity = metadata.quantity || 1
    try {
      await deductInventoryForProduct(
        venueId,
        metadata.productId,
        quantity,
        session.sessionId, // Use sessionId as orderId reference for tracking
      )
      logger.info('Inventory deducted for payment link item', {
        paymentLinkId: session.paymentLink!.id,
        productId: metadata.productId,
        quantity,
      })
    } catch (deductionError: any) {
      // Log but don't fail the payment — inventory deduction is best-effort
      // (consistent with TPV behavior for NO_RECIPE products)
      logger.error('Failed to deduct inventory for payment link item', {
        paymentLinkId: session.paymentLink!.id,
        productId: metadata.productId,
        quantity,
        error: deductionError.message,
      })
    }
  }

  logger.info('Payment link charge completed', {
    sessionId,
    paymentLinkId: session.paymentLink!.id,
    amount: Number(session.amount),
    transactionId: chargeResult.transactionId,
    isItemLink,
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
