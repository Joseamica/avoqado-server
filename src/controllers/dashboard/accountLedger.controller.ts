import { NextFunction, Request, Response } from 'express'

import { getAccountLedger } from '../../services/fiscal/accountLedger.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Auxiliar de cuenta (libro mayor por cuenta, Capa B). Thin, read-only.
 * Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/account-ledger?accountCode=&period=YYYY-MM — auxiliar (movimientos + saldo corrido) de una cuenta. */
export async function getAccountLedgerController(
  req: Request<{ venueId: string }, {}, {}, { accountCode?: string; period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getAccountLedger(req.params.venueId, req.query.accountCode ?? '', period))
  } catch (error) {
    next(error)
  }
}
