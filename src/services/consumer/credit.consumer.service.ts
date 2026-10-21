import prisma from '@/utils/prismaClient'
import { VenueStatus } from '@prisma/client'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { createCheckoutSession, fulfillPurchase } from '@/services/dashboard/creditPack.public.service'
import { ensureVenueCustomerActivated } from '@/services/consumer/reservation.consumer.service'

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
      select: { id: true },
    }),
    prisma.creditPackPurchase.findUnique({
      where: { id: purchase.id },
      include: {
        customer: {
          select: { id: true, consumerId: true },
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

  // 🔴 Toma de cuentas (auditoría de seguridad 2026-10-01): aquí se le ligaba al Consumer que llama la ficha de CUALQUIER compra
  // sin cuenta —p. ej. una de invitado hecha con el teléfono o el correo de otra persona— y se le copiaban su correo y teléfono.
  // La compra legítima desde la app nace con la ficha ya ligada y activada (`createCreditCheckoutForConsumer` →
  // `ensureVenueCustomerActivated`), así que sólo se confirma lo que ya es de quien llama.
  if (hydrated.customer.consumerId !== consumerId) {
    throw new ForbiddenError('La compra no corresponde a este usuario')
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
