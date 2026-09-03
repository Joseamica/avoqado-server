import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { env } from '../../config/env'
import emailService from '../email.service'
import { googleWalletAvailable } from './googleWalletClient'

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

/** Las dos rutas publicas de la tarjeta: `null` cuando una cartera no aplica. */
export interface WalletPassUrls {
  /** La ruta publica del `.pkpass` (Apple Wallet). Siempre viene si el objeto no es null. */
  appleUrl: string
  /**
   * La ruta publica de la tarjeta de Google Wallet.
   *
   * 🔴 `null` cuando este servidor no tiene Google Wallet configurado (sin issuer o
   * sin credencial, ver `googleWalletAvailable()`): ofrecer un boton que apunta a una
   * liga que va a fallar es peor que no ofrecerlo.
   */
  googleUrl: string | null
}

/**
 * Las rutas publicas de la tarjeta, o null si no hay una URL alcanzable desde fuera.
 *
 * 🔴 Mismo criterio que `passWebServiceURL`: contra `localhost` devuelve null en vez
 * de armar las ligas. El telefono del cliente no es esta maquina, asi que ese correo
 * llegaria con botones que no abren nada — peor que no mandarlo.
 */
export function passPublicUrls(venueSlug: string, customerId: string): WalletPassUrls | null {
  const base = env.BASE_URL
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null
  const raiz = base.replace(/\/$/, '')
  const slug = encodeURIComponent(venueSlug)
  const cliente = encodeURIComponent(customerId)
  return {
    appleUrl: `${raiz}/api/v1/public/venues/${slug}/wallet/apple/${cliente}`,
    googleUrl: googleWalletAvailable() ? `${raiz}/api/v1/public/venues/${slug}/wallet/google/${cliente}` : null,
  }
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

    const urls = passPublicUrls(venue.slug, customerId)
    if (!urls) return

    const config = await prisma.loyaltyConfig.findUnique({
      where: { venueId },
      select: { stampRewardLabel: true },
    })

    await emailService.sendWalletPassEmail(customer.email, {
      venueName: venue.name,
      customerName: customer.firstName ?? '',
      applePassUrl: urls.appleUrl,
      googlePassUrl: urls.googleUrl,
      stampsEarned: card.stampsEarned,
      stampsRequired: card.stampsRequired,
      rewardLabel: config?.stampRewardLabel ?? '',
    })
  } catch (error) {
    logger.warn('No se pudo mandar el correo de la tarjeta del primer sello', { venueId, customerId, error })
  }
}
