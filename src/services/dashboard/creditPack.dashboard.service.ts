/**
 * Credit Pack Dashboard Service
 *
 * Handles admin operations for credit packs:
 * - CRUD for credit packs
 * - Customer purchase and balance management
 * - Manual redemption and adjustments
 * - Transaction history
 */

import Stripe from 'stripe'
import { Prisma, CreditPurchaseStatus, CreditTransactionType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

// ==========================================
// CREDIT PACK CRUD
// ==========================================

export async function getCreditPacks(venueId: string) {
  return prisma.creditPack.findMany({
    where: { venueId },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true, type: true, price: true, imageUrl: true },
          },
        },
      },
      _count: { select: { purchases: true } },
    },
    orderBy: { displayOrder: 'asc' },
  })
}

export async function getCreditPackById(venueId: string, id: string) {
  const pack = await prisma.creditPack.findFirst({
    where: { id, venueId },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true, type: true, price: true, imageUrl: true },
          },
        },
      },
      _count: { select: { purchases: true } },
    },
  })

  if (!pack) throw new NotFoundError('Paquete de creditos no encontrado')
  return pack
}

export async function createCreditPack(
  venueId: string,
  data: {
    name: string
    description?: string
    price: number
    currency?: string
    validityDays?: number
    maxPerCustomer?: number
    displayOrder?: number
    items: { productId: string; quantity: number }[]
  },
) {
  // Validate all products exist and belong to the venue
  const productIds = data.items.map(i => i.productId)
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, venueId, active: true },
    select: { id: true },
  })

  if (products.length !== productIds.length) {
    throw new BadRequestError('Uno o mas productos no existen o no estan activos en este venue')
  }

  // Check for duplicate product IDs
  const uniqueIds = new Set(productIds)
  if (uniqueIds.size !== productIds.length) {
    throw new BadRequestError('No se puede incluir el mismo producto mas de una vez en un paquete')
  }

  // Create Stripe product and price
  let stripeProductId: string | undefined
  let stripePriceId: string | undefined

  try {
    const stripeProduct = await stripe.products.create({
      name: data.name,
      metadata: { type: 'credit_pack', venueId },
    })

    const stripePrice = await stripe.prices.create({
      product: stripeProduct.id,
      unit_amount: Math.round(data.price * 100),
      currency: (data.currency || 'MXN').toLowerCase(),
      metadata: { type: 'credit_pack', venueId },
    })

    stripeProductId = stripeProduct.id
    stripePriceId = stripePrice.id
  } catch (error) {
    logger.warn('⚠️ [CREDIT PACK] Failed to create Stripe product/price, continuing without', {
      error: error instanceof Error ? error.message : 'Unknown',
    })
  }

  const pack = await prisma.creditPack.create({
    data: {
      venueId,
      name: data.name,
      description: data.description,
      price: new Prisma.Decimal(data.price),
      currency: data.currency || 'MXN',
      validityDays: data.validityDays,
      maxPerCustomer: data.maxPerCustomer,
      displayOrder: data.displayOrder || 0,
      stripeProductId,
      stripePriceId,
      items: {
        create: data.items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true, type: true, price: true, imageUrl: true },
          },
        },
      },
    },
  })

  logger.info('✅ [CREDIT PACK] Created', { packId: pack.id, venueId, items: data.items.length })

  return pack
}

export async function updateCreditPack(
  venueId: string,
  id: string,
  data: {
    name?: string
    description?: string | null
    price?: number
    currency?: string
    validityDays?: number | null
    maxPerCustomer?: number | null
    displayOrder?: number
    items?: { productId: string; quantity: number }[]
  },
) {
  const existing = await prisma.creditPack.findFirst({
    where: { id, venueId },
    select: { id: true, stripeProductId: true, stripePriceId: true, price: true },
  })

  if (!existing) throw new NotFoundError('Paquete de creditos no encontrado')

  // If price changed, create new Stripe price
  let stripePriceId = existing.stripePriceId
  if (data.price !== undefined && Number(existing.price) !== data.price && existing.stripeProductId) {
    try {
      const newPrice = await stripe.prices.create({
        product: existing.stripeProductId,
        unit_amount: Math.round(data.price * 100),
        currency: (data.currency || 'MXN').toLowerCase(),
        metadata: { type: 'credit_pack', venueId },
      })
      stripePriceId = newPrice.id

      // Archive old price
      if (existing.stripePriceId) {
        await stripe.prices.update(existing.stripePriceId, { active: false })
      }
    } catch (error) {
      logger.warn('⚠️ [CREDIT PACK] Failed to update Stripe price', {
        error: error instanceof Error ? error.message : 'Unknown',
      })
    }
  }

  return prisma.$transaction(async tx => {
    // Update items if provided
    if (data.items) {
      const productIds = data.items.map(i => i.productId)
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, venueId, active: true },
        select: { id: true },
      })

      if (products.length !== productIds.length) {
        throw new BadRequestError('Uno o mas productos no existen o no estan activos en este venue')
      }

      // Delete existing items and recreate
      await tx.creditPackItem.deleteMany({ where: { creditPackId: id } })
      await Promise.all(
        data.items.map(item =>
          tx.creditPackItem.create({
            data: {
              creditPackId: id,
              productId: item.productId,
              quantity: item.quantity,
            },
          }),
        ),
      )
    }

    return tx.creditPack.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.price !== undefined && { price: new Prisma.Decimal(data.price) }),
        ...(data.currency !== undefined && { currency: data.currency }),
        ...(data.validityDays !== undefined && { validityDays: data.validityDays }),
        ...(data.maxPerCustomer !== undefined && { maxPerCustomer: data.maxPerCustomer }),
        ...(data.displayOrder !== undefined && { displayOrder: data.displayOrder }),
        ...(stripePriceId && { stripePriceId }),
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, type: true, price: true, imageUrl: true },
            },
          },
        },
      },
    })
  })
}

export async function deactivateCreditPack(venueId: string, id: string) {
  const pack = await prisma.creditPack.findFirst({
    where: { id, venueId },
  })

  if (!pack) throw new NotFoundError('Paquete de creditos no encontrado')

  return prisma.creditPack.update({
    where: { id },
    data: { active: false },
  })
}

// ==========================================
// PURCHASE & BALANCE MANAGEMENT
// ==========================================

export async function getCustomerPurchases(
  venueId: string,
  filters: {
    customerId?: string
    status?: CreditPurchaseStatus
    page?: number
    limit?: number
  },
) {
  const page = filters.page || 1
  const limit = filters.limit || 20
  const skip = (page - 1) * limit

  const where: Prisma.CreditPackPurchaseWhereInput = {
    venueId,
    ...(filters.customerId && { customerId: filters.customerId }),
    ...(filters.status && { status: filters.status }),
  }

  const [purchases, total] = await Promise.all([
    prisma.creditPackPurchase.findMany({
      where,
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        creditPack: { select: { name: true } },
        itemBalances: {
          include: {
            product: {
              select: { id: true, name: true, type: true },
            },
          },
        },
      },
      orderBy: { purchasedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.creditPackPurchase.count({ where }),
  ])

  return { purchases, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTransactionHistory(
  venueId: string,
  filters: {
    customerId?: string
    type?: CreditTransactionType
    page?: number
    limit?: number
  },
) {
  const page = filters.page || 1
  const limit = filters.limit || 20
  const skip = (page - 1) * limit

  const where: Prisma.CreditTransactionWhereInput = {
    venueId,
    ...(filters.customerId && { customerId: filters.customerId }),
    ...(filters.type && { type: filters.type }),
  }

  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where,
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        creditItemBalance: {
          include: {
            product: { select: { id: true, name: true } },
          },
        },
        creditPackPurchase: {
          select: { creditPack: { select: { name: true } } },
        },
        createdBy: {
          select: { staff: { select: { firstName: true, lastName: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.creditTransaction.count({ where }),
  ])

  return { transactions, total, page, limit, totalPages: Math.ceil(total / limit) }
}

// ==========================================
// MANUAL OPERATIONS
// ==========================================

/**
 * Staff manually redeems an item (for non-reservable products like drinks, shakes)
 */
export async function redeemItemManually(venueId: string, balanceId: string, staffId: string, reason?: string) {
  const balance = await prisma.creditItemBalance.findUnique({
    where: { id: balanceId },
    include: {
      creditPackPurchase: {
        select: { id: true, venueId: true, customerId: true, status: true, expiresAt: true },
      },
    },
  })

  if (!balance) throw new NotFoundError('Balance de credito no encontrado')
  if (balance.creditPackPurchase.venueId !== venueId) throw new NotFoundError('Balance de credito no encontrado')
  if (balance.creditPackPurchase.status !== CreditPurchaseStatus.ACTIVE) {
    throw new BadRequestError('La compra de creditos ya no esta activa')
  }
  if (balance.creditPackPurchase.expiresAt && balance.creditPackPurchase.expiresAt < new Date()) {
    throw new BadRequestError('Los creditos han expirado')
  }
  if (balance.remainingQuantity <= 0) {
    throw new BadRequestError('No hay creditos disponibles para canjear')
  }

  return prisma.$transaction(async tx => {
    await tx.creditItemBalance.update({
      where: { id: balanceId },
      data: { remainingQuantity: { decrement: 1 } },
    })

    const transaction = await tx.creditTransaction.create({
      data: {
        venueId,
        customerId: balance.creditPackPurchase.customerId,
        creditPackPurchaseId: balance.creditPackPurchase.id,
        creditItemBalanceId: balanceId,
        type: 'REDEEM',
        quantity: -1,
        reason,
        createdById: staffId,
      },
    })

    // Check if purchase is now exhausted
    const remaining = await tx.creditItemBalance.findMany({
      where: {
        creditPackPurchaseId: balance.creditPackPurchase.id,
        remainingQuantity: { gt: 0 },
      },
    })

    if (remaining.length === 0) {
      await tx.creditPackPurchase.update({
        where: { id: balance.creditPackPurchase.id },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    }

    return transaction
  })
}

/**
 * Adjust item balance (+ or -)
 */
export async function adjustItemBalance(venueId: string, balanceId: string, quantity: number, reason: string, staffId: string) {
  const balance = await prisma.creditItemBalance.findUnique({
    where: { id: balanceId },
    include: {
      creditPackPurchase: {
        select: { id: true, venueId: true, customerId: true, status: true },
      },
    },
  })

  if (!balance) throw new NotFoundError('Balance de credito no encontrado')
  if (balance.creditPackPurchase.venueId !== venueId) throw new NotFoundError('Balance de credito no encontrado')

  // Don't allow negative remaining
  if (balance.remainingQuantity + quantity < 0) {
    throw new BadRequestError(`El ajuste dejaria el balance en ${balance.remainingQuantity + quantity}, no se permite balance negativo`)
  }

  return prisma.$transaction(async tx => {
    await tx.creditItemBalance.update({
      where: { id: balanceId },
      data: { remainingQuantity: { increment: quantity } },
    })

    const transaction = await tx.creditTransaction.create({
      data: {
        venueId,
        customerId: balance.creditPackPurchase.customerId,
        creditPackPurchaseId: balance.creditPackPurchase.id,
        creditItemBalanceId: balanceId,
        type: 'ADJUST',
        quantity,
        reason,
        createdById: staffId,
      },
    })

    // Re-evaluate purchase status
    if (quantity > 0 && balance.creditPackPurchase.status === CreditPurchaseStatus.EXHAUSTED) {
      await tx.creditPackPurchase.update({
        where: { id: balance.creditPackPurchase.id },
        data: { status: CreditPurchaseStatus.ACTIVE },
      })
    }

    return transaction
  })
}

/**
 * Refund a purchase (marks as REFUNDED, does not issue Stripe refund)
 */
export async function refundPurchase(venueId: string, purchaseId: string, staffId: string, reason: string) {
  const purchase = await prisma.creditPackPurchase.findFirst({
    where: { id: purchaseId, venueId },
    include: { itemBalances: true },
  })

  if (!purchase) throw new NotFoundError('Compra no encontrada')
  if (purchase.status === CreditPurchaseStatus.REFUNDED) {
    throw new BadRequestError('Esta compra ya fue reembolsada')
  }

  return prisma.$transaction(async tx => {
    // Zero out all balances
    for (const balance of purchase.itemBalances) {
      if (balance.remainingQuantity > 0) {
        await tx.creditItemBalance.update({
          where: { id: balance.id },
          data: { remainingQuantity: 0 },
        })

        await tx.creditTransaction.create({
          data: {
            venueId,
            customerId: purchase.customerId,
            creditPackPurchaseId: purchase.id,
            creditItemBalanceId: balance.id,
            type: 'REFUND',
            quantity: -balance.remainingQuantity,
            reason,
            createdById: staffId,
          },
        })
      }
    }

    // Mark purchase as refunded
    await tx.creditPackPurchase.update({
      where: { id: purchase.id },
      data: { status: CreditPurchaseStatus.REFUNDED },
    })

    return { refunded: true, purchaseId }
  })
}
