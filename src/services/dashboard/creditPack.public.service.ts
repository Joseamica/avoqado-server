/**
 * Credit Pack Public Service
 *
 * Handles public-facing credit pack operations:
 * - Listing available packs
 * - Customer credit lookups
 * - Stripe Checkout session creation
 * - Purchase fulfillment (webhook)
 * - Credit redemption for reservations
 */

import Stripe from 'stripe'
import { Prisma, CreditPurchaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { withSerializableRetry } from './reservation.dashboard.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Get active credit packs for a venue (public)
 */
export async function getAvailablePacks(venueId: string, productId?: string) {
  const packs = await prisma.creditPack.findMany({
    where: { venueId, active: true },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              price: true,
              imageUrl: true,
              duration: true,
            },
          },
        },
      },
    },
    orderBy: { displayOrder: 'asc' },
  })

  // If productId filter, only return packs that include that product
  if (productId) {
    return packs.filter(pack => pack.items.some(item => item.productId === productId))
  }

  return packs
}

/**
 * Lookup customer credits by email or phone.
 *
 * Optional `opts.seats`: annotates each itemBalance with `sufficient: remainingQuantity >= seats`
 *   so the widget can disable balances that can't cover the booking.
 * Optional `opts.productId`: filters balances to only those that match the productId.
 */
export async function lookupCustomerCredits(
  venueId: string,
  email?: string,
  phone?: string,
  opts?: { seats?: number; productId?: string },
) {
  if (!email && !phone) {
    throw new BadRequestError('Se requiere email o telefono para consultar creditos')
  }

  const seats = opts?.seats
  const productId = opts?.productId

  // Find customer
  const customer = await prisma.customer.findFirst({
    where: {
      venueId,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    },
  })

  if (!customer) {
    return { customer: null, purchases: [], requestedSeats: seats ?? null }
  }

  // Get active purchases with balances
  const purchases = await prisma.creditPackPurchase.findMany({
    where: {
      venueId,
      customerId: customer.id,
      status: CreditPurchaseStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: {
      creditPack: { select: { name: true } },
      itemBalances: {
        where: {
          remainingQuantity: { gt: 0 },
          product: { allowCreditRedemption: true },
          ...(productId ? { productId } : {}),
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              imageUrl: true,
            },
          },
        },
      },
    },
    orderBy: { expiresAt: 'asc' },
  })

  // Annotate each balance with `sufficient` flag when seats was requested.
  // Drop empty purchases (no matching balances) when productId filter was applied.
  const annotated = purchases
    .map(p => ({
      ...p,
      itemBalances: p.itemBalances.map(b => ({
        ...b,
        sufficient: seats != null ? b.remainingQuantity >= seats : true,
      })),
    }))
    .filter(p => (productId ? p.itemBalances.length > 0 : true))

  return {
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
    purchases: annotated,
    requestedSeats: seats ?? null,
  }
}

/**
 * Create a Stripe Checkout Session for purchasing a credit pack
 */
export async function createCheckoutSession(
  venueId: string,
  packId: string,
  email: string | undefined,
  phone: string,
  successUrl: string,
  cancelUrl: string,
) {
  const pack = await prisma.creditPack.findFirst({
    where: { id: packId, venueId, active: true },
  })

  if (!pack) {
    throw new NotFoundError('Paquete no encontrado o no disponible')
  }

  // Check maxPerCustomer if applicable
  if (pack.maxPerCustomer && (email || phone)) {
    const customer = await prisma.customer.findFirst({
      where: {
        venueId,
        ...(email ? { email } : { phone }),
      },
    })

    if (customer) {
      const purchaseCount = await prisma.creditPackPurchase.count({
        where: {
          customerId: customer.id,
          creditPackId: packId,
          status: { notIn: [CreditPurchaseStatus.REFUNDED] },
        },
      })

      if (purchaseCount >= pack.maxPerCustomer) {
        throw new BadRequestError(`Has alcanzado el limite de ${pack.maxPerCustomer} compras para este paquete`)
      }
    }
  }

  // Ensure Stripe product/price exist
  let stripePriceId = pack.stripePriceId

  if (!stripePriceId) {
    // Create Stripe product and price
    const product = await stripe.products.create({
      name: pack.name,
      metadata: {
        type: 'credit_pack',
        venueId,
        packId: pack.id,
      },
    })

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(Number(pack.price) * 100),
      currency: pack.currency.toLowerCase(),
      metadata: {
        type: 'credit_pack',
        venueId,
        packId: pack.id,
      },
    })

    await prisma.creditPack.update({
      where: { id: pack.id },
      data: {
        stripeProductId: product.id,
        stripePriceId: price.id,
      },
    })

    stripePriceId = price.id
  }

  // Create Checkout Session
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: stripePriceId, quantity: 1 }],
    metadata: {
      type: 'credit_pack_purchase',
      venueId,
      packId: pack.id,
      customerPhone: phone,
      ...(email && { customerEmail: email }),
    },
    ...(email && { customer_email: email }),
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  logger.info('✅ [CREDIT PACK] Checkout session created', {
    sessionId: session.id,
    venueId,
    packId: pack.id,
    amount: pack.price.toString(),
  })

  return { checkoutUrl: session.url }
}

/**
 * Fulfill a credit pack purchase after successful payment (called from webhook)
 */
export async function fulfillPurchase(checkoutSessionId: string) {
  // Retrieve session from Stripe
  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId)
  const metadata = session.metadata!

  if (metadata.type !== 'credit_pack_purchase') {
    return // Not a credit pack purchase
  }

  const { venueId, packId, customerPhone, customerEmail } = metadata
  const email = customerEmail || session.customer_email || undefined
  const phone = customerPhone

  // Idempotency: check if already processed
  const existing = await prisma.creditPackPurchase.findUnique({
    where: { stripeCheckoutSessionId: checkoutSessionId },
  })

  if (existing) {
    logger.info('⏭️ [CREDIT PACK] Purchase already fulfilled', { checkoutSessionId })
    return existing
  }

  // Find credit pack with items
  const pack = await prisma.creditPack.findUnique({
    where: { id: packId },
    include: { items: true },
  })

  if (!pack) {
    logger.error('❌ [CREDIT PACK] Pack not found during fulfillment', { packId })
    throw new Error(`CreditPack ${packId} not found`)
  }

  // Find or create customer
  const customer = await findOrCreateCustomer(venueId, email, phone)

  // Calculate expiration
  const expiresAt = pack.validityDays ? new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000) : null

  const amountPaid = new Prisma.Decimal((session.amount_total || 0) / 100)

  // Create everything in a transaction
  const purchase = await prisma.$transaction(async tx => {
    // Create purchase
    const newPurchase = await tx.creditPackPurchase.create({
      data: {
        venueId,
        customerId: customer.id,
        creditPackId: pack.id,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: session.payment_intent as string,
        amountPaid,
        expiresAt,
        status: CreditPurchaseStatus.ACTIVE,
      },
    })

    // Create item balances and transactions
    for (const item of pack.items) {
      const balance = await tx.creditItemBalance.create({
        data: {
          creditPackPurchaseId: newPurchase.id,
          creditPackItemId: item.id,
          productId: item.productId,
          originalQuantity: item.quantity,
          remainingQuantity: item.quantity,
        },
      })

      await tx.creditTransaction.create({
        data: {
          venueId,
          customerId: customer.id,
          creditPackPurchaseId: newPurchase.id,
          creditItemBalanceId: balance.id,
          type: 'PURCHASE',
          quantity: item.quantity,
        },
      })
    }

    // Update customer totalSpent
    await tx.customer.update({
      where: { id: customer.id },
      data: {
        totalSpent: { increment: amountPaid },
      },
    })

    return newPurchase
  })

  logger.info('✅ [CREDIT PACK] Purchase fulfilled', {
    purchaseId: purchase.id,
    customerId: customer.id,
    venueId,
    packId: pack.id,
    items: pack.items.length,
  })

  return purchase
}

/**
 * Check if a customer has available credits for a specific product
 * Returns the best balance to use (FIFO by expiration)
 */
export async function checkRedemptionEligibility(venueId: string, customerId: string, productId: string) {
  const balance = await prisma.creditItemBalance.findFirst({
    where: {
      productId,
      remainingQuantity: { gt: 0 },
      product: { allowCreditRedemption: true },
      creditPackPurchase: {
        venueId,
        customerId,
        status: CreditPurchaseStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    },
    include: {
      creditPackPurchase: {
        select: { id: true, expiresAt: true, creditPack: { select: { name: true } } },
      },
    },
    orderBy: {
      creditPackPurchase: { expiresAt: 'asc' },
    },
  })

  return balance
}

/**
 * Redeem 1 credit for a reservation (called within serializable transaction)
 */
export async function redeemForReservation(venueId: string, customerId: string, balanceId: string, reservationId: string) {
  return withSerializableRetry(async tx => {
    // Lock the balance row
    const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
      SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
      FROM "CreditItemBalance"
      WHERE id = ${balanceId}
      FOR UPDATE
    `

    if (balances.length === 0) {
      throw new NotFoundError('Balance de credito no encontrado')
    }

    const balance = balances[0]

    if (balance.remainingQuantity <= 0) {
      throw new BadRequestError('No hay creditos disponibles en este balance')
    }

    // Verify the purchase is still active and not expired
    const purchase = await tx.creditPackPurchase.findUnique({
      where: { id: balance.creditPackPurchaseId },
      select: { status: true, expiresAt: true, venueId: true, customerId: true },
    })

    if (!purchase || purchase.venueId !== venueId || purchase.customerId !== customerId) {
      throw new BadRequestError('Balance de credito no valido para este cliente')
    }

    if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
      throw new BadRequestError('La compra de creditos ya no esta activa')
    }

    if (purchase.expiresAt && purchase.expiresAt < new Date()) {
      throw new BadRequestError('Los creditos han expirado')
    }

    // Decrement balance
    await tx.creditItemBalance.update({
      where: { id: balanceId },
      data: { remainingQuantity: { decrement: 1 } },
    })

    // Create transaction
    await tx.creditTransaction.create({
      data: {
        venueId,
        customerId,
        creditPackPurchaseId: balance.creditPackPurchaseId,
        creditItemBalanceId: balanceId,
        type: 'REDEEM',
        quantity: -1,
        reservationId,
      },
    })

    // Check if all balances in the purchase are exhausted
    const remainingBalances = await tx.creditItemBalance.findMany({
      where: {
        creditPackPurchaseId: balance.creditPackPurchaseId,
        remainingQuantity: { gt: 0 },
      },
    })

    if (remainingBalances.length === 0) {
      await tx.creditPackPurchase.update({
        where: { id: balance.creditPackPurchaseId },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    }

    logger.info('✅ [CREDIT PACK] Credit redeemed for reservation', {
      balanceId,
      reservationId,
      customerId,
      venueId,
    })

    return { redeemed: true }
  })
}

// ==========================================
// HELPERS
// ==========================================

async function findOrCreateCustomer(venueId: string, email?: string, phone?: string) {
  if (!email && !phone) {
    throw new BadRequestError('Se requiere email o telefono del cliente')
  }

  // Try to find by email first, then phone
  let customer = null

  if (email) {
    customer = await prisma.customer.findUnique({
      where: { venueId_email: { venueId, email } },
    })
  }

  if (!customer && phone) {
    customer = await prisma.customer.findUnique({
      where: { venueId_phone: { venueId, phone } },
    })
  }

  if (customer) {
    // Update missing fields
    if ((email && !customer.email) || (phone && !customer.phone)) {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          ...(email && !customer.email ? { email } : {}),
          ...(phone && !customer.phone ? { phone } : {}),
        },
      })
    }
    return customer
  }

  // Create new customer
  return prisma.customer.create({
    data: {
      venueId,
      email: email || null,
      phone: phone || null,
    },
  })
}
