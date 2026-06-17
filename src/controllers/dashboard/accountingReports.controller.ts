import { NextFunction, Request, Response } from 'express'

import { getAccountingReports } from '../../services/fiscal/accountingReports.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Reportes contables (Capa B). Thin, read-only. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/reports?period=YYYY-MM — estado de resultados + balance general. */
export async function getAccountingReportsController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getAccountingReports(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}
