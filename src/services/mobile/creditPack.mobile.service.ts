/**
 * Credit Pack Mobile Service (iOS/Android POS — staff-facing)
 *
 * The public/consumer flow (creditPack.public.service.ts) sells packs online via
 * Stripe Checkout. In the POS the staff sells a pack IN PERSON — the customer pays
 * through the normal POS (cash/terminal) and this grants the credits directly, with
 * no Stripe session. Listing, balance and redemption reuse the existing services;
 * only the in-person grant is new here.
 */

import { Prisma, CreditPurchaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

/**
 * Grant a credit pack to a customer after an in-person sale. Mirrors
 * fulfillPurchase's creation (purchase + per-item balances + PURCHASE ledger
 * entries + customer.totalSpent) but records the POS payment instead of a Stripe
 * session. `amountPaid` defaults to the pack's list price.
 */
export async function sellPackInPerson(
  venueId: string,
  packId: string,
  customerId: string,
  staffId: string,
  opts?: { amountPaid?: number; note?: string },
) {
  const pack = await prisma.creditPack.findUnique({
    where: { id: packId },
    include: { items: true },
  })
  if (!pack || pack.venueId !== venueId) throw new NotFoundError('Paquete no encontrado')
  if (!pack.active) throw new BadRequestError('El paquete no está activo')
  if (pack.items.length === 0) throw new BadRequestError('El paquete no incluye artículos')

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  // Enforce per-customer purchase cap (non-refunded purchases count against it).
  if (pack.maxPerCustomer != null) {
    const priorCount = await prisma.creditPackPurchase.count({
      where: {
        venueId,
        customerId,
        creditPackId: pack.id,
        status: { not: CreditPurchaseStatus.REFUNDED },
      },
    })
    if (priorCount >= pack.maxPerCustomer) {
      throw new BadRequestError(`El cliente alcanzó el máximo de ${pack.maxPerCustomer} compra(s) de este paquete`)
    }
  }

  const amountPaid = new Prisma.Decimal(opts?.amountPaid ?? Number(pack.price))
  const expiresAt = pack.validityDays ? new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000) : null

  const purchase = await prisma.$transaction(async tx => {
    const newPurchase = await tx.creditPackPurchase.create({
      data: {
        venueId,
        customerId,
        creditPackId: pack.id,
        amountPaid,
        expiresAt,
        status: CreditPurchaseStatus.ACTIVE,
      },
    })

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
          customerId,
          creditPackPurchaseId: newPurchase.id,
          creditItemBalanceId: balance.id,
          type: 'PURCHASE',
          quantity: item.quantity,
          reason: opts?.note,
          createdById: staffId,
        },
      })
    }

    await tx.customer.update({
      where: { id: customerId },
      data: { totalSpent: { increment: amountPaid } },
    })

    return newPurchase
  })

  logger.info('✅ [CREDIT PACK] In-person sale', { purchaseId: purchase.id, venueId, packId, customerId, staffId })

  return prisma.creditPackPurchase.findUnique({
    where: { id: purchase.id },
    include: {
      creditPack: { select: { name: true } },
      itemBalances: {
        include: { product: { select: { id: true, name: true, imageUrl: true } } },
      },
    },
  })
}

/**
 * A customer's ACTIVE, non-expired credit balances, by customerId (the POS already
 * knows the customer). Shape mirrors the public lookupCustomerCredits so the client
 * can reuse the same decoding.
 */
export async function getCustomerCreditsById(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const purchases = await prisma.creditPackPurchase.findMany({
    where: {
      venueId,
      customerId,
      status: CreditPurchaseStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: {
      creditPack: { select: { name: true } },
      itemBalances: {
        where: { remainingQuantity: { gt: 0 } },
        include: { product: { select: { id: true, name: true, type: true, imageUrl: true } } },
      },
    },
    orderBy: { expiresAt: 'asc' },
  })

  return {
    customer,
    purchases: purchases.filter(p => p.itemBalances.length > 0),
  }
}
