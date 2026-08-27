import prisma from '../../utils/prismaClient'
import { env } from '../../config/env'
import { buildStoreCardPass } from './applePassBuilder.service'
import { signPass } from './applePassSigner.service'
import { getCardDesign } from './cardDesign.service'
import { getStampCardStatus } from './stampLedger.service'
import { issueApplePass } from './walletPass.service'

/**
 * Arma y firma la tarjeta de un cliente, con su contenido AL DÍA.
 *
 * 🔴 Vive aquí y no en un controlador porque lo usan DOS caminos: la descarga inicial
 * y la actualización que pide Apple cuando el saldo cambió. Si cada uno armara el pase
 * por su cuenta, un día divergirían — y la versión actualizada mostraría algo distinto
 * de la que el cliente descargó, sin que nada falle.
 */

/**
 * A dónde puede venir Apple a preguntar por los cambios.
 *
 * 🔴 Devuelve null cuando no hay una URL pública configurada. Apuntar a `localhost`
 * deja al iPhone reintentando contra el vacío; omitirlo entrega una tarjeta que
 * simplemente no se auto-actualiza, que es el comportamiento honesto en desarrollo.
 */
export function passWebServiceURL(): string | null {
  const base = env.BASE_URL
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null
  return `${base.replace(/\/$/, '')}/api/v1/public/passkit`
}

/** El archivo del pase, o null si el negocio no existe o falta el cliente. */
export async function buildAndSignPassForCustomer(venueId: string, customerId: string): Promise<Buffer | null> {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, active: true },
    select: { id: true, name: true, logo: true, primaryColor: true, secondaryColor: true },
  })
  if (!venue) return null

  const customer = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } })
  if (!customer) return null

  const [pass, design, stamps] = await Promise.all([
    issueApplePass(venue.id, customer.id),
    getCardDesign(venue.id),
    // 🔴 El avance REAL. Es lo único que cambia entre la descarga original y esta.
    getStampCardStatus(venue.id, customer.id),
  ])

  const passJson = buildStoreCardPass({
    brand: { name: venue.name, logo: venue.logo, primaryColor: venue.primaryColor, secondaryColor: venue.secondaryColor },
    colors: { background: design.backgroundColor, text: design.textColor, label: design.labelColor },
    content: { stampsEarned: stamps.stampsEarned, stampsRequired: stamps.stampsRequired, rewardLabel: stamps.rewardLabel },
    serialNumber: pass.serialNumber,
    authToken: pass.authToken,
    qrToken: pass.qrToken,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID as string,
    teamIdentifier: env.APPLE_TEAM_ID as string,
    webServiceURL: passWebServiceURL(),
  })

  return signPass(passJson, {
    brandColor: design.stampFilledColor,
    stamps: { earned: stamps.stampsEarned, required: stamps.stampsRequired },
    design,
  })
}
