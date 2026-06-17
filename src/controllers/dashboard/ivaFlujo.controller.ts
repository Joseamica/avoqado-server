import { NextFunction, Request, Response } from 'express'

import { getIvaCashflow } from '../../services/fiscal/ivaFlujo.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — IVA en flujo de efectivo (Capa B). Thin, read-only. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/vat-flow?period=YYYY-MM — resumen de IVA trasladado cobrado del contribuyente. */
export async function getIvaCashflowController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getIvaCashflow(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}
