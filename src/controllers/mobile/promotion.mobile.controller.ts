import { Request, Response } from 'express'
import { listPromotionsForPos } from '../../services/promotions/promotionCatalog.service'
import logger from '../../config/logger'

/** GET /api/v1/mobile/venues/:venueId/promotions */
export async function getPromotions(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const data = await listPromotionsForPos(venueId)
    return res.status(200).json({ success: true, data })
  } catch (error) {
    logger.error('Error in getPromotions', { error: error instanceof Error ? error.message : 'desconocido', venueId: req.params.venueId })
    return res.status(500).json({ success: false, message: 'Error interno del servidor' })
  }
}
