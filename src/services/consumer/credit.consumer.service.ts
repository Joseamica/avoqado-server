import prisma from '@/utils/prismaClient'
import { VenueStatus } from '@prisma/client'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { createCheckoutSession, fulfillPurchase } from '@/services/dashboard/creditPack.public.service'

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

  return createCheckoutSession(
    venue.id,
    packId,
    consumer.email ?? undefined,
    consumer.phone ?? undefined,
    buildCreditPackPaymentReturnUrl('success', venue.slug),
    buildCreditPackPaymentReturnUrl('cancelled', venue.slug),
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
    await prisma.customer.update({
      where: { id: hydrated.customer.id },
      data: {
        consumerId,
        ...(consumer.email && !hydrated.customer.email ? { email: consumer.email } : {}),
        ...(consumer.phone && !hydrated.customer.phone ? { phone: consumer.phone } : {}),
      },
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
