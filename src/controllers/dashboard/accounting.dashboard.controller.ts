import { NextFunction, Request, Response } from 'express'

import * as accountingService from '../../services/dashboard/accounting.dashboard.service'

/**
 * Controller — Accounting Capa A (gerencial).
 * Ruta: GET /api/v1/dashboard/venues/:venueId/accounting/income-statement
 *
 * Thin: extrae params/query, delega al servicio, responde. Gateado por
 * `checkPermission('accounting:read')` en la ruta (sin feature/paywall).
 */
export async function getIncomeStatement(
  req: Request<{ venueId: string }, {}, {}, { from: string; to: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query

    const incomeStatement = await accountingService.getIncomeStatement(venueId, { from, to })

    res.status(200).json(incomeStatement)
  } catch (error) {
    next(error)
  }
}
