import { NextFunction, Request, Response } from 'express'

import { getIsrProvisional, type IsrRegime } from '../../services/fiscal/isr.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — ISR pago provisional (Capa B). Thin, read-only. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/isr?period=YYYY-MM&regime=RESICO|GENERAL — estimación del pago provisional de ISR. */
export async function getIsrProvisionalController(
  req: Request<{ venueId: string }, {}, {}, { period?: string; regime?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    const regime: IsrRegime = req.query.regime === 'GENERAL' ? 'GENERAL' : 'RESICO'
    res.status(200).json(await getIsrProvisional(req.params.venueId, period, regime))
  } catch (error) {
    next(error)
  }
}
