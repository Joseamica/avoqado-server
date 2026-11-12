import { Request, Response, NextFunction } from 'express'
import { reporteDePosiciones, type ReportePosicionesQuery } from '../../services/superadmin/reportePosiciones.service'

/**
 * GET /api/v1/superadmin/payment-positions — reporte de posiciones de cobro (tarifa al comercio, paso 2). SÓLO LECTURA.
 * Query ya validada y acotada por `reportePosicionesQuerySchema` (pageSize ≤ 100).
 */
export async function getReportePosiciones(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await reporteDePosiciones(req.query as unknown as ReportePosicionesQuery))
  } catch (error) {
    next(error)
  }
}
