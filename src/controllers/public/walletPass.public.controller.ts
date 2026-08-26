import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { issueApplePass } from '../../services/wallet/walletPass.service'
import { buildStoreCardPass } from '../../services/wallet/applePassBuilder.service'
import { signPass } from '../../services/wallet/applePassSigner.service'
import { getCardDesign } from '../../services/wallet/cardDesign.service'
import { getStampCardStatus } from '../../services/wallet/stampLedger.service'
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

    // Los tres en paralelo: ninguno depende del otro y la emisión es interactiva.
    const [pass, design, stamps] = await Promise.all([
      issueApplePass(venue.id, customer.id),
      getCardDesign(venue.id),
      // 🔴 El avance REAL del cliente, no un número de muestra. Es lo que hace que
      // la tarjeta sirva: el cajero cobra, el sello sube, y el cliente lo ve.
      getStampCardStatus(venue.id, customer.id),
    ])

    const passJson = buildStoreCardPass({
      brand: {
        name: venue.name,
        logo: venue.logo,
        primaryColor: venue.primaryColor,
        secondaryColor: venue.secondaryColor,
      },
      colors: {
        background: design.backgroundColor,
        text: design.textColor,
        label: design.labelColor,
      },
      content: {
        stampsEarned: stamps.stampsEarned,
        stampsRequired: stamps.stampsRequired,
        rewardLabel: stamps.rewardLabel,
      },
      serialNumber: pass.serialNumber,
      authToken: pass.authToken,
      qrToken: pass.qrToken,
      passTypeIdentifier: env.APPLE_PASS_TYPE_ID as string,
      teamIdentifier: env.APPLE_TEAM_ID as string,
    })

    const buffer = await signPass(passJson, {
      brandColor: design.stampFilledColor,
      stamps: { earned: stamps.stampsEarned, required: stamps.stampsRequired },
      design,
    })

    // Auditoría: emitir una credencial es una mutación que identifica a un cliente.
    // Fire-and-forget y FUERA de cualquier transacción — un fallo de auditoría no
    // puede impedir que alguien reciba su tarjeta. Sin staffId: no hay humano
    // detrás, y logAction normaliza ese caso a null.
    void logAction({
      action: 'WALLET_PASS_ISSUED',
      entity: 'WalletPass',
      entityId: pass.id,
      venueId: venue.id,
      data: { customerId: customer.id, platform: 'APPLE', stampsEarned: stamps.stampsEarned, stampsRequired: stamps.stampsRequired },
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
