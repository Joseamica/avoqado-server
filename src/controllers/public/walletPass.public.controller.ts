import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { issueApplePass } from '../../services/wallet/walletPass.service'
import { buildStoreCardPass } from '../../services/wallet/applePassBuilder.service'
import { signPass } from '../../services/wallet/applePassSigner.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import { env } from '../../config/env'

// ==========================================
// CREDENCIAL DE CLIENTE — APPLE WALLET (público, sin sesión)
// El iPhone descarga el .pkpass directamente; no hay token de usuario que exigir.
// ==========================================

/**
 * GET /api/v1/public/venues/:venueSlug/wallet/apple/:customerId
 *
 * Entrega el archivo del pase. Público porque lo descarga el iPhone, pero acotado:
 * el cliente TIENE que pertenecer a ese venue, y la respuesta no revela ningún dato
 * suyo más allá de su avance de sellos.
 */
export async function downloadApplePass(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, customerId } = req.params

    const venue = await prisma.venue.findFirst({
      where: { slug: venueSlug, active: true },
      select: { id: true, name: true, logo: true, primaryColor: true, secondaryColor: true },
    })
    if (!venue) throw new NotFoundError('Negocio no encontrado')

    // 🔴 Filtrado por venueId, no sólo por id. El slug es público: sin esto, el
    // slug de un negocio más un customerId ajeno emitiría una tarjeta con la marca
    // equivocada y filtraría que ese cliente existe.
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, venueId: venue.id },
      select: { id: true },
    })
    if (!customer) throw new NotFoundError('Cliente no encontrado')

    const pass = await issueApplePass(venue.id, customer.id)

    const passJson = buildStoreCardPass({
      brand: {
        name: venue.name,
        logo: venue.logo,
        primaryColor: venue.primaryColor,
        secondaryColor: venue.secondaryColor,
      },
      // Plan A: el avance va fijo a propósito. El motor de sellos de verdad es el
      // Plan B — enseñar esto como producto terminado sería vender humo.
      content: { stampsEarned: 0, stampsRequired: 10, rewardLabel: 'Tu premio' },
      serialNumber: pass.serialNumber,
      authToken: pass.authToken,
      qrToken: pass.qrToken,
      passTypeIdentifier: env.APPLE_PASS_TYPE_ID as string,
      teamIdentifier: env.APPLE_TEAM_ID as string,
    })

    const buffer = await signPass(passJson)

    // Auditoría: emitir una credencial es una mutación que identifica a un cliente.
    // Fire-and-forget y FUERA de cualquier transacción — un fallo de auditoría no
    // puede impedir que alguien reciba su tarjeta. Sin staffId: no hay humano
    // detrás, y logAction normaliza ese caso a null.
    void logAction({
      action: 'WALLET_PASS_ISSUED',
      entity: 'WalletPass',
      entityId: pass.id,
      venueId: venue.id,
      data: { customerId: customer.id, platform: 'APPLE' },
    })

    // 🔴 Este Content-Type es lo que hace que el iPhone abra Wallet. Con
    // application/octet-stream, Safari lo baja como archivo suelto y el cliente se
    // queda viendo algo que no sabe abrir.
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass')
    res.setHeader('Content-Disposition', `attachment; filename="${venue.name}.pkpass"`)
    res.send(buffer)
  } catch (error) {
    next(error)
  }
}
