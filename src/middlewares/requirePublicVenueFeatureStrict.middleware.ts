/**
 * Candado de plan para rutas públicas que ABREN pedidos nuevos. A diferencia de `checkPublicVenueFeature`, que falla ABIERTO
 * (deja pasar si la verificación truena, para no tumbar las reservas), éste falla CERRADO: un pedido en línea toca cocina y
 * caja, y «no pude verificar» significa «intenta de nuevo», no «adelante».
 * Requiere que `resolve*VenueBySlug` ya haya puesto `req.publicVenue`. Responde en el sobre de la API pública
 * (`{ success: false, code, error }`), como el resto de los pedidos en línea.
 */
import type { NextFunction, Request, Response } from 'express'
import logger from '../config/logger'
import { venueHasFeatureAccess } from '../services/access/basePlan.service'

export function requirePublicVenueFeatureStrict(featureCode: string, customerMessage?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const venue = (req as any).publicVenue as { id: string; slug: string } | undefined
    if (!venue) {
      res.status(500).json({ success: false, code: 'PUBLIC_VENUE_NOT_RESOLVED', error: 'No se pudo identificar el negocio.' })
      return
    }
    try {
      const allowed = await venueHasFeatureAccess(venue.id, featureCode)
      if (!allowed) {
        res.status(403).json({
          success: false,
          code: 'PLAN_REQUIRED',
          error: customerMessage ?? 'Este negocio no tiene esta función disponible en línea por el momento.',
        })
        return
      }
      next()
    } catch (error) {
      logger.error('❌ Public feature access check error — failing CLOSED', {
        featureCode,
        venueSlug: venue.slug,
        error: error instanceof Error ? error.message : String(error),
      })
      res.status(503).json({
        success: false,
        code: 'FEATURE_CHECK_UNAVAILABLE',
        error: 'No pudimos verificar la disponibilidad. Intenta de nuevo.',
      })
    }
  }
}
