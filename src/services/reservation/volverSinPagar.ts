/**
 * D681 · «Si no paga, no obtiene la clase».
 *
 * La clienta reserva con pago por adelantado, va a Stripe y regresa por la liga «atrás» (`cancel_url`) sin pagar. Antes su lugar
 * quedaba apartado hasta que Stripe mandaba, a los 30 min, su aviso de liga vencida. Ahora el widget lo avisa al volver y aquí se
 * cierra la liga en Stripe y se aplica el MISMO camino de ese aviso (`processStripeConnectWebhookEvent`): no nace un escritor
 * nuevo de la reserva. Si Stripe dice que ya se pagó, se aplica el camino del aviso de pago. Si Stripe no contesta, no se toca
 * nada: la liga vence sola a su hora y su aviso suelta el lugar como siempre.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getProvider } from '@/services/payments/provider-registry'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { getReservationByCancelSecret } from '@/services/dashboard/reservation.dashboard.service'

/**
 * La cuenta conectada de Stripe que creó la liga de la reserva: la fijada en la reserva, o (filas viejas sin cuenta fijada) la más
 * nueva activa del negocio. Refunds and status polls MUST hit the same connected account that minted the session.
 */
export async function cuentaStripeDeLaReserva(venueId: string, pinnedMerchantId: string | null) {
  if (pinnedMerchantId) {
    const pinned = await prisma.ecommerceMerchant.findFirst({
      where: { id: pinnedMerchantId, venueId, provider: { code: 'STRIPE_CONNECT' } },
      include: { provider: true },
    })
    if (pinned) return pinned
    logger.warn(
      `⚠️ [RESERVATION DEPOSIT] Pinned merchant ${pinnedMerchantId} not found; falling back to latest active for venue ${venueId}`,
    )
  }
  return prisma.ecommerceMerchant.findFirst({
    where: { venueId, active: true, provider: { code: 'STRIPE_CONNECT', active: true } },
    include: { provider: true },
    orderBy: { createdAt: 'desc' },
  })
}

/** `cancelSecret` es la liga de gestión de la reserva: quien no la tiene, recibe 404 (lo lanza `getReservationByCancelSecret`). */
export async function soltarApartadoAlVolverSinPagar(venueSlug: string, cancelSecret: string) {
  const r = await getReservationByCancelSecret(venueSlug, cancelSecret)

  const contestar = async (cerroLiga: boolean) => {
    const f = await prisma.reservation.findFirstOrThrow({
      where: { id: r.id, venueId: r.venueId },
      select: { confirmationCode: true, status: true, depositStatus: true, depositExpiresAt: true },
    })
    return { released: cerroLiga && f.status === 'CANCELLED', ...f }
  }

  // Sólo una reserva que sigue esperando ESE pago; repetir la vuelta (recargar la página) no hace nada.
  if (r.depositStatus !== 'PENDING' || !r.checkoutSessionId) return contestar(false)
  const sesion = r.checkoutSessionId
  const merchant = await cuentaStripeDeLaReserva(r.venueId, r.ecommerceMerchantId)
  if (!merchant) return contestar(false)
  const provider = getProvider(merchant)
  const aviso = (type: 'checkout.session.expired' | 'checkout.session.completed', data: Record<string, unknown>, sufijo: string) =>
    processStripeConnectWebhookEvent({
      id: `return:${sesion}:${sufijo}`,
      type,
      account: merchant.providerMerchantId ?? undefined,
      livemode: false,
      data,
    })

  try {
    await provider.expireAuthorizationCheckout(merchant, sesion)
  } catch (error) {
    // Stripe no deja cerrar una liga ya vencida o ya pagada: se pregunta cuál de las dos.
    let estado
    try {
      estado = await provider.getPaymentStatus(merchant, sesion)
    } catch {
      logger.warn(`⚠️ [RESERVATION DEPOSIT] ${r.confirmationCode}: Stripe no contestó al volver sin pagar; la liga vence sola`, error)
      return contestar(false)
    }
    if (estado.status === 'PAID') {
      await aviso('checkout.session.completed', { id: sesion, payment_status: 'paid', payment_intent: estado.paymentIntentId }, 'paid')
      return contestar(false)
    }
    if (estado.status !== 'EXPIRED') return contestar(false)
  }
  await aviso('checkout.session.expired', { id: sesion }, 'expired')
  return contestar(true)
}
