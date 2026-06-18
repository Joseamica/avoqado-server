import { NextFunction, Request, Response } from 'express'

import { getAccountsPayableAging } from '../../services/fiscal/accountsPayable.service'

/**
 * Controller — Cuentas por pagar (antigüedad de saldos a proveedores, Capa B). Thin, read-only.
 * Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/accounts-payable?asOf=YYYY-MM-DD — antigüedad de saldos de proveedores (default: hoy). */
export async function getAccountsPayableController(
  req: Request<{ venueId: string }, {}, {}, { asOf?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.status(200).json(await getAccountsPayableAging(req.params.venueId, req.query.asOf))
  } catch (error) {
    next(error)
  }
}
