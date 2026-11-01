import prisma from '../../utils/prismaClient'
import { env } from '../../config/env'
import { buildStoreCardPass } from './applePassBuilder.service'
import { signPass } from './applePassSigner.service'
import { getCardDesign } from './cardDesign.service'
import { getStampCardStatus } from './stampLedger.service'
import { issueApplePass } from './walletPass.service'
import { ForbiddenError } from '../../errors/AppError'
import { omitirPorDemo } from '../demo/candadoDemo'

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

/** La identidad de UN pase ya emitido: lo que Apple compara al actualizarlo. */
export type PaseEmitido = { serialNumber: string; authToken: string; qrToken: string }

/**
 * El archivo del pase, o null si el negocio no existe o falta el cliente.
 *
 * 🔴 `pase`: la actualización que pide Apple manda el serial que quiere y DEBE recibir ese mismo serial; si recibe otro,
 * el iPhone la rechaza y la tarjeta se congela. Sin `pase` (descarga inicial) se usa «el pase del cliente». Con dos pases
 * activos del mismo cliente —p. ej. tras juntar un duplicado (17-oct-2026)— «el del cliente» puede ser el otro.
 */
export async function buildAndSignPassForCustomer(venueId: string, customerId: string, pase?: PaseEmitido): Promise<Buffer | null> {
  // Candado de negocios demo (capa 2; Codex r6, 4): igual que Google Wallet, un demo no emite tarjetas firmadas por Avoqado.
  const motivo = await omitirPorDemo('tarjeta de Apple Wallet', null, venueId)
  if (motivo === 'sin confirmar') throw new Error('No se pudo confirmar el negocio: la tarjeta no se emitió')
  if (motivo)
    throw new ForbiddenError(
      'En el negocio de demostración no se crean tarjetas de Apple Wallet. En tu cuenta de Avoqado sí funciona.',
      'NEGOCIO_DEMO',
    )
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, active: true },
    select: { id: true, name: true, logo: true, primaryColor: true, secondaryColor: true },
  })
  if (!venue) return null

  const customer = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } })
  if (!customer) return null

  const [pass, design, stamps] = await Promise.all([
    pase ?? issueApplePass(venue.id, customer.id),
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
