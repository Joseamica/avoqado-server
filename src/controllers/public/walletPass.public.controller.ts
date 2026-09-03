import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { issueApplePass } from '../../services/wallet/walletPass.service'
import { buildAndSignPassForCustomer } from '../../services/wallet/issuePass.service'
import { getPublicCardInfo } from '../../services/wallet/publicCardInfo.service'
import { buildSaveJwt } from '../../services/wallet/googleWalletPass.service'
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

    // 🔴 UN solo lugar arma y firma el pase: `issuePass.service`. Lo usan esta
    // descarga y la actualización que pide Apple cuando el saldo cambia. Si cada
    // camino lo armara por su cuenta, un día divergirían y la versión actualizada
    // mostraría algo distinto de la que el cliente descargó, sin que nada falle.
    const pass = await issueApplePass(venue.id, customer.id)
    const buffer = await buildAndSignPassForCustomer(venue.id, customer.id)
    if (!buffer) throw new NotFoundError('No se pudo generar la credencial')

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

/**
 * GET /api/v1/public/venues/:venueSlug/wallet/google/:customerId
 *
 * Manda al cliente a la pantalla de «Guardar en Google Wallet». Espejo de
 * `downloadApplePass`, con el MISMO aislamiento: el cliente tiene que pertenecer a ese
 * venue.
 *
 * 🔴 Responde 302 y no un archivo. Google no entrega un `.pkpass`: entrega una URL
 * firmada que abre su propia pantalla de confirmación.
 */
export async function downloadGooglePass(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, customerId } = req.params

    const venue = await prisma.venue.findFirst({
      where: { slug: venueSlug, active: true },
      select: { id: true },
    })
    if (!venue) throw new NotFoundError('Negocio no encontrado')

    // 🔴 Filtrado por venueId, no sólo por id — misma razón que en Apple: el slug es
    // público y sin esto se filtraría la existencia de un cliente ajeno.
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, venueId: venue.id },
      select: { id: true },
    })
    if (!customer) throw new NotFoundError('Cliente no encontrado')

    const emitido = await buildSaveJwt(venue.id, customer.id)
    if (!emitido) throw new NotFoundError('No se pudo generar la credencial')

    void logAction({
      action: 'WALLET_PASS_ISSUED',
      entity: 'WalletPass',
      // 🔴 El id del PASE, no el del cliente: el registro dice `entity: 'WalletPass'`, así
      // que quien audite va a buscar ese id en esa tabla. Apple ya lo hace así.
      entityId: emitido.passId,
      venueId: venue.id,
      data: { customerId: customer.id, platform: 'GOOGLE' },
    })

    res.redirect(302, `https://pay.google.com/gp/v/save/${emitido.jwt}`)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/public/venues/:venueSlug/stamp-card
 *
 * La marca del negocio y si tiene sellos — lo que la pagina publica de la tarjeta
 * necesita para dibujarse ANTES de que el cliente se identifique.
 *
 * 🔴 Deliberadamente NO pasa por el camino de reservaciones. Ese tiene un candado que
 * cierra el widget entero cuando el negocio no acepta citas, y una tarjeta de sellos
 * no depende de eso: un café con sellos y sin reservas debe poder repartir tarjetas.
 */
export async function getStampCardInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const info = await getPublicCardInfo(venueSlug)
    if (!info) throw new NotFoundError('Negocio no encontrado')
    res.json(info)
  } catch (error) {
    next(error)
  }
}
