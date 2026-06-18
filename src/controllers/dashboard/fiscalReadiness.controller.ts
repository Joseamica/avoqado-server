import { NextFunction, Request, Response } from 'express'

import { getFiscalReadiness } from '../../services/fiscal/fiscalReadiness.service'

/**
 * Controller — Diagnóstico de preparación fiscal (onboarding, Capa B). Thin, read-only.
 * Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/readiness — checklist de preparación fiscal del local + capacidades desbloqueadas. */
export async function getFiscalReadinessController(
  req: Request<{ venueId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.status(200).json(await getFiscalReadiness(req.params.venueId))
  } catch (error) {
    next(error)
  }
}
