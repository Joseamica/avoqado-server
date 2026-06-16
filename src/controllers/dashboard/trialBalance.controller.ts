import { NextFunction, Request, Response } from 'express'

import { currentPeriod, getTrialBalance } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Balanza de comprobación (Capa B). Thin, read-only. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/trial-balance?period=YYYY-MM — balanza del periodo (default: mes actual). */
export async function getTrialBalanceController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getTrialBalance(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}
