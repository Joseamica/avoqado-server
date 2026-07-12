import { NextFunction, Request, Response } from 'express'
import * as merchantRoutingService from '../../services/tpv/merchantRouting.service'

/**
 * POST /tpv/venues/:venueId/merchant-eligibility
 *
 * Evalúa las reglas MERCHANT_ROUTING_RULES (feature PREMIUM) para el cobro en
 * curso y devuelve qué merchants mostrar, si hay auto-selección y si aplicó el
 * fallback "todos + aviso". Venue sin el feature ⇒ todos elegibles (idéntico a hoy).
 */
export async function getMerchantEligibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const authContext = (req as any).authContext

    const result = await merchantRoutingService.getMerchantEligibility(venueId, req.body, {
      staffId: authContext?.userId,
      role: authContext?.role,
    })

    res.status(200).json({
      success: true,
      data: result,
      message: 'Merchant eligibility evaluated successfully',
    })
  } catch (error) {
    next(error)
  }
}
