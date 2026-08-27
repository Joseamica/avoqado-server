import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { env } from '../../config/env'
import emailService from '../email.service'

/**
 * Le manda al cliente la liga de su tarjeta cuando gana su PRIMER sello.
 *
 * 🔴 Por que en el primer SELLO y no al darse de alta: es lo que hace Square
 * ("after each transaction ... will only be sent if you provided an email address
 * for a digital receipt"), y ademas resuelve dos problemas nuestros. Uno, hay OCHO
 * lugares distintos que crean un `Customer` —incluida la semilla de demo— y
 * enganchar el correo en cada uno garantiza que el noveno lo olvide. Dos, una
 * tarjeta en 0 de 7 no le dice nada a quien todavia no ha comprado.
 *
 * Nunca lanza. Corre dentro del camino del dinero: si propagara, un Resend caido
 * haria ver como fallido un cobro que ya entro.
 */

/**
 * La ruta publica del `.pkpass`, o null si no hay una URL alcanzable desde fuera.
 *
 * 🔴 Mismo criterio que `passWebServiceURL`: contra `localhost` devuelve null en vez
 * de armar la liga. El telefono del cliente no es esta maquina, asi que ese correo
 * llegaria con un boton que no abre nada — peor que no mandarlo.
 */
export function passPublicUrl(venueSlug: string, customerId: string): string | null {
  const base = env.BASE_URL
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null
  return `${base.replace(/\/$/, '')}/api/v1/public/venues/${encodeURIComponent(venueSlug)}/wallet/apple/${encodeURIComponent(customerId)}`
}

export async function sendFirstStampEmailIfDue(venueId: string, customerId: string, stampCardId: string): Promise<void> {
  try {
    const card = await prisma.stampCard.findUnique({
      where: { id: stampCardId },
      select: { stampsEarned: true, stampsRequired: true },
    })
    // Solo el primer sello. En el segundo ya tiene la tarjeta (o decidio no bajarla).
    if (!card || card.stampsEarned !== 1) return

    // 🔴 Y solo si es su PRIMERA cartilla. La segunda tambien arranca en 1 de 7: sin
    // este conteo, el cliente mas fiel del negocio recibiria el mismo correo cada vez
    // que completa una cartilla.
    const cartillas = await prisma.stampCard.count({ where: { venueId, customerId } })
    if (cartillas > 1) return

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, venueId },
      select: { email: true, firstName: true },
    })
    if (!customer?.email) return

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, slug: true } })
    if (!venue?.slug) return

    const url = passPublicUrl(venue.slug, customerId)
    if (!url) return

    const config = await prisma.loyaltyConfig.findUnique({
      where: { venueId },
      select: { stampRewardLabel: true },
    })

    await emailService.sendWalletPassEmail(customer.email, {
      venueName: venue.name,
      customerName: customer.firstName ?? '',
      passUrl: url,
      stampsEarned: card.stampsEarned,
      stampsRequired: card.stampsRequired,
      rewardLabel: config?.stampRewardLabel ?? '',
    })
  } catch (error) {
    logger.warn('No se pudo mandar el correo de la tarjeta del primer sello', { venueId, customerId, error })
  }
}
