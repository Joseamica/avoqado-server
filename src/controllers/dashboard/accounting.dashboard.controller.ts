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

/**
 * GET /api/v1/dashboard/venues/:venueId/accounting/business-summary?from=&to=
 * Resumen del negocio (Capa A) — portada de Contabilidad. @permission accounting:read
 */
export async function getBusinessSummary(
  req: Request<{ venueId: string }, {}, {}, { from: string; to: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query
    const summary = await accountingService.getBusinessSummary(venueId, { from, to })
    res.status(200).json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/accounting/banks?from=&to=
 * Bancos y cajas (Capa A) — cuentas de dinero del local. @permission accounting:read
 */
export async function getBankAndCashSummary(
  req: Request<{ venueId: string }, {}, {}, { from: string; to: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query
    const summary = await accountingService.getBankAndCashSummary(venueId, { from, to })
    res.status(200).json(summary)
  } catch (error) {
    next(error)
  }
}
