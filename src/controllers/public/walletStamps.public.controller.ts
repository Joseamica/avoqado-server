import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { getCardDesign } from '../../services/wallet/cardDesign.service'
import { getStampCardStatus } from '../../services/wallet/stampLedger.service'
import { stampStripPng } from '../../services/wallet/stampStripPng'
import { fetchDecodedPng } from '../../services/wallet/remotePng'

/**
 * GET /api/v1/public/wallet/stamps/:serialNumber/:revision.png
 *
 * La franja de sellos que Google pinta en la tarjeta del cliente (`heroImage`).
 *
 * 🔴 Pública porque la descargan los SERVIDORES de Google, que no tienen sesión. Es
 * seguro: la imagen no lleva ningún dato del cliente —sólo sellos dibujados— y la
 * llave es el `serialNumber`, un uuid aleatorio que no sirve para sellar a nadie. El
 * `qrToken` jamás viaja por aquí.
 *
 * 🔴 La `revision` de la URL NO se valida contra la del pase a propósito: existe para
 * que la dirección CAMBIE en cada sello y Google no pueda servir una copia vieja.
 * Rechazar una revisión vieja dejaría una tarjeta sin imagen mientras Google se pone
 * al día; siempre se sirve el estado ACTUAL.
 */
export async function getStampStrip(req: Request, res: Response, next: NextFunction) {
  try {
    const { serialNumber } = req.params

    const pass = await prisma.walletPass.findFirst({
      where: { serialNumber, active: true },
      select: { venueId: true, customerId: true },
    })
    if (!pass) throw new NotFoundError('Tarjeta no encontrada')

    const [design, stamps] = await Promise.all([getCardDesign(pass.venueId), getStampCardStatus(pass.venueId, pass.customerId)])
    const selloPropio = await fetchDecodedPng(design.stampImageUrl)

    // Mismas medidas que la banda @2x del pase de Apple: Google escala hacia abajo sin
    // problema, y así las dos tarjetas se dibujan con el mismo motor y el mismo aspecto.
    const png = stampStripPng({
      width: 750,
      height: 246,
      earned: stamps.stampsEarned,
      required: stamps.stampsRequired,
      bgHex: design.stripColor,
      filledHex: design.stampFilledColor,
      emptyHex: design.stampEmptyColor,
      shape: design.stampShape,
      stampImage: selloPropio,
    })

    res.setHeader('Content-Type', 'image/png')
    // 🔴 Cacheable a lo bestia y sin riesgo: esta URL es inmutable por diseño — cuando
    // el contenido cambia, cambia la revisión y por tanto la dirección.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(png)
  } catch (error) {
    next(error)
  }
}
