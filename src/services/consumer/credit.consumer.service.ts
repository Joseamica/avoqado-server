import prisma from '@/utils/prismaClient'
import { VenueStatus } from '@prisma/client'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { createCheckoutSession, fulfillPurchase } from '@/services/dashboard/creditPack.public.service'
import { ensureVenueCustomerActivated } from '@/services/consumer/reservation.consumer.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'

function buildCreditPackPaymentReturnUrl(path: 'success' | 'cancelled', venueSlug: string) {
  const baseUrl = (process.env.CONSUMER_APP_RETURN_URL || 'avoqado://payment-result').replace(/\/$/, '')
  const params = new URLSearchParams({
    flow: 'credit-pack',
    payment: path,
    venueSlug,
  })
  const checkoutSessionParam = path === 'success' ? '&session_id={CHECKOUT_SESSION_ID}' : ''
  return `${baseUrl}?${params.toString()}${checkoutSessionParam}`
}

export async function createCreditCheckoutForConsumer(consumerId: string, venueSlug: string, packId: string) {
  const [consumer, venue] = await Promise.all([
    prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { id: true, email: true, phone: true, active: true },
    }),
    prisma.venue.findFirst({
      where: {
        slug: venueSlug,
        active: true,
        status: { notIn: [VenueStatus.SUSPENDED, VenueStatus.ADMIN_SUSPENDED, VenueStatus.CLOSED] },
      },
      select: { id: true, slug: true },
    }),
  ])

  if (!consumer || !consumer.active) {
    throw new BadRequestError('Cuenta de consumidor no disponible')
  }

  if (!venue) {
    throw new BadRequestError('Negocio no encontrado')
  }

  if (!consumer.email && !consumer.phone) {
    throw new BadRequestError('Agrega correo o telefono a tu perfil para comprar creditos')
  }

  // Fase 1: la compra desde la app tenía identidad de Consumer pero NUNCA resolvía el
  // Customer del venue — así que el límite por cliente se contaba por email y el gate de
  // aprobación no tenía a quién mirar. Se liga (y se activa la cuenta) aquí, con el mismo
  // protocolo que la reserva, y el customerId viaja al checkout.
  const { customer } = await ensureVenueCustomerActivated(venue.id, consumerId)

  return createCheckoutSession(
    venue.id,
    packId,
    consumer.email ?? undefined,
    consumer.phone ?? undefined,
    buildCreditPackPaymentReturnUrl('success', venue.slug),
    buildCreditPackPaymentReturnUrl('cancelled', venue.slug),
    { customerId: customer.id },
  )
}

export async function finalizeCreditCheckout(consumerId: string, sessionId: string) {
  const purchase = await fulfillPurchase(sessionId)
  if (!purchase) {
    throw new BadRequestError('No se pudo confirmar la compra')
  }

  const [consumer, hydrated] = await Promise.all([
    prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { id: true, email: true, phone: true },
    }),
    prisma.creditPackPurchase.findUnique({
      where: { id: purchase.id },
      include: {
        customer: {
          select: { id: true, consumerId: true, email: true, phone: true },
        },
        creditPack: {
          select: { id: true, name: true },
        },
      },
    }),
  ])

  if (!consumer || !hydrated?.customer) {
    throw new BadRequestError('No se pudo confirmar la compra')
  }

  const linkedConsumer = hydrated.customer.consumerId
  if (linkedConsumer && linkedConsumer !== consumerId) {
    throw new ForbiddenError('La compra no corresponde a este usuario')
  }

  // If this purchase customer is not linked yet, bind it to the authenticated
  // consumer and enrich missing contact fields for future lookups.
  if (!linkedConsumer) {
    // 🔴 Fase 1: este vínculo se hacía FUERA del protocolo de activación, así que creaba
    // cuentas de app que nunca pedían aprobación (auditoría §4bis). Ahora liga y activa en
    // la MISMA transacción, con el mismo origen que la reserva. Idempotente: si la cuenta
    // ya estaba activa, `activateCustomerAccount` no recalcula nada.
    await prisma.$transaction(async tx => {
      await tx.customer.update({
        where: { id: hydrated.customer.id },
        data: {
          consumerId,
          ...(consumer.email && !hydrated.customer.email ? { email: consumer.email } : {}),
          ...(consumer.phone && !hydrated.customer.phone ? { phone: consumer.phone } : {}),
        },
      })
      await activateCustomerAccount(tx, { customerId: hydrated.customer.id, venueId: hydrated.venueId, origin: 'CONSUMER' })
    })
  }

  return {
    purchaseId: hydrated.id,
    venueId: hydrated.venueId,
    creditPackId: hydrated.creditPackId,
    creditPackName: hydrated.creditPack.name,
    status: hydrated.status,
    customerId: hydrated.customer.id,
  }
}

export async function getConsumerCredits(consumerId: string) {
  const now = new Date()
  const purchases = await prisma.creditPackPurchase.findMany({
    where: {
      status: 'ACTIVE',
      customer: { consumerId },
      OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      itemBalances: { some: { remainingQuantity: { gt: 0 } } },
    },
    select: {
      id: true,
      purchasedAt: true,
      expiresAt: true,
      status: true,
      amountPaid: true,
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          timezone: true,
        },
      },
      creditPack: {
        select: {
          id: true,
          name: true,
        },
      },
      itemBalances: {
        where: { remainingQuantity: { gt: 0 } },
        select: {
          id: true,
          originalQuantity: true,
          remainingQuantity: true,
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              duration: true,
            },
          },
        },
        orderBy: { remainingQuantity: 'desc' },
      },
    },
    orderBy: [{ expiresAt: 'asc' }, { purchasedAt: 'desc' }],
    take: 100,
  })

  const totalRemaining = purchases.reduce(
    (sum, purchase) => sum + purchase.itemBalances.reduce((itemSum, item) => itemSum + item.remainingQuantity, 0),
    0,
  )

  return {
    totalRemaining,
    purchases: purchases.map(purchase => ({
      ...purchase,
      amountPaid: Number(purchase.amountPaid),
    })),
  }
}
