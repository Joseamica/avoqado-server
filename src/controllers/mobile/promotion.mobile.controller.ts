import { Request, Response } from 'express'
import { listPromotionsForPos } from '../../services/promotions/promotionCatalog.service'
import { carouselForDevice } from '../../services/customer-display/promotionCarousel.service'
import logger from '../../config/logger'
import { requestDeviceUid } from '../../utils/requestDeviceUid'

/** GET /api/v1/mobile/venues/:venueId/promotions */
export async function getPromotions(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const [catalogo, carrusel] = await Promise.all([
      listPromotionsForPos(venueId),
      // 🔴 El carrusel nunca tumba la ruta: el catálogo de siempre es lo que usa el POS para cobrar.
      carouselForDevice(venueId, requestDeviceUid(req)).catch(error => {
        logger.warn('[pantalla-del-cliente] carrusel no disponible', {
          venueId,
          error: error instanceof Error ? error.message : 'desconocido',
        })
        return null
      }),
    ])
    return res.status(200).json({
      success: true,
      // El carrusel va DESPUÉS: con carrusel, su `timezone` (la de su huella) reemplaza la del catálogo (Codex r1 #6). El
      // catálogo de siempre no se toca: el carrusel no trae `active` ni `upcoming`.
      data: { ...catalogo, fetchedAt: new Date().toISOString(), ...(carrusel ?? {}) },
    })
  } catch (error) {
    logger.error('Error in getPromotions', { error: error instanceof Error ? error.message : 'desconocido', venueId: req.params.venueId })
    return res.status(500).json({ success: false, message: 'Error interno del servidor' })
  }
}
