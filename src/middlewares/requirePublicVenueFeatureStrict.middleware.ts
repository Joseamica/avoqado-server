/**
 * Candado de plan para rutas públicas que ABREN pedidos nuevos. A diferencia de `checkPublicVenueFeature`, que falla ABIERTO
 * (deja pasar si la verificación truena, para no tumbar las reservas), éste falla CERRADO: un pedido en línea toca cocina y
 * caja, y «no pude verificar» significa «intenta de nuevo», no «adelante».
 * Requiere que `resolve*VenueBySlug` ya haya puesto `req.publicVenue`. Responde en el sobre de la API pública
 * (`{ success: false, code, error }`), como el resto de los pedidos en línea.
 */
import type { NextFunction, Request, Response } from 'express'
import logger from '../config/logger'
import { ForbiddenError, ServiceUnavailableError } from '../errors/AppError'
import { venueHasFeatureAccess } from '../services/access/basePlan.service'

export const ORDERING_UNAVAILABLE_MESSAGE = 'Este negocio no recibe pedidos en línea por el momento.'

/** Lanza 403 `PLAN_REQUIRED` si el plan no incluye la función, o 503 `FEATURE_CHECK_UNAVAILABLE` si no se pudo verificar. */
export async function assertPublicVenueFeatureStrict(venueId: string, featureCode: string, customerMessage?: string): Promise<void> {
  let allowed: boolean
  try {
    allowed = await venueHasFeatureAccess(venueId, featureCode)
  } catch (error) {
    logger.error('❌ Public feature access check error — failing CLOSED', {
      featureCode,
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ServiceUnavailableError('No pudimos verificar la disponibilidad. Intenta de nuevo.', 'FEATURE_CHECK_UNAVAILABLE')
  }
  if (!allowed) {
    throw new ForbiddenError(customerMessage ?? 'Este negocio no tiene esta función disponible en línea por el momento.', 'PLAN_REQUIRED')
  }
}

/** P1-06: el plan de un pedido NUEVO. Crear pedido lo pide DESPUÉS de buscar la repetición (un reintento recibe su pedido). */
export const assertOrderingPlan = (venueId: string) =>
  assertPublicVenueFeatureStrict(venueId, 'ONLINE_ORDERING', ORDERING_UNAVAILABLE_MESSAGE)

export function requirePublicVenueFeatureStrict(featureCode: string, customerMessage?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const venue = (req as any).publicVenue as { id: string; slug: string } | undefined
    if (!venue) {
      res.status(500).json({ success: false, code: 'PUBLIC_VENUE_NOT_RESOLVED', error: 'No se pudo identificar el negocio.' })
      return
    }
    try {
      await assertPublicVenueFeatureStrict(venue.id, featureCode, customerMessage)
    } catch (error: any) {
      res.status(error.statusCode).json({ success: false, code: error.code, error: error.message })
      return
    }
    next()
  }
}
