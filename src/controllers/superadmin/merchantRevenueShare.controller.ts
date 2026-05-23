import { Request, Response, NextFunction } from 'express'
import * as service from '../../services/superadmin/merchantRevenueShare.service'
import { computeRevenueReport } from '../../services/payments/revenueShareReport.service'
import { createMerchantRevenueShareSchema, updateMerchantRevenueShareSchema } from '../../schemas/dashboard/merchant-revenue-share.schema'
import { BadRequestError } from '../../errors/AppError'

/** GET /merchant-revenue-shares?active= */
export async function getMerchantRevenueShares(req: Request, res: Response, next: NextFunction) {
  try {
    const { active } = req.query
    const filters: { active?: boolean } = {}
    if (active !== undefined) filters.active = active === 'true'
    const rows = await service.listMerchantRevenueShares(filters)
    res.json({ success: true, data: rows, meta: { count: rows.length } })
  } catch (error) {
    next(error)
  }
}

/** GET /merchant-revenue-shares/by-merchant?merchantAccountId= */
export async function getMerchantRevenueShareByMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId } = req.query
    if (typeof merchantAccountId !== 'string' || !merchantAccountId) {
      throw new BadRequestError('merchantAccountId es requerido')
    }
    const row = await service.getMerchantRevenueShareByMerchant(merchantAccountId)
    res.json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

/** GET /merchant-revenue-shares/:id */
export async function getMerchantRevenueShareById(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await service.getMerchantRevenueShareById(req.params.id)
    res.json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

/** POST /merchant-revenue-shares */
export async function createMerchantRevenueShare(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createMerchantRevenueShareSchema.safeParse(req.body)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Datos inválidos')
    const row = await service.createMerchantRevenueShare(parsed.data)
    res.status(201).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

/** PUT /merchant-revenue-shares/:id */
export async function updateMerchantRevenueShare(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateMerchantRevenueShareSchema.safeParse(req.body)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Datos inválidos')
    const row = await service.updateMerchantRevenueShare(req.params.id, parsed.data)
    res.json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

/** DELETE /merchant-revenue-shares/:id */
export async function deleteMerchantRevenueShare(req: Request, res: Response, next: NextFunction) {
  try {
    await service.deleteMerchantRevenueShare(req.params.id)
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /merchant-revenue-shares/report?from=ISO&to=ISO&venueId=...
 * Reporte de revenue-share por merchant en el periodo dado.
 */
export async function getRevenueShareReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { from, to, venueId } = req.query
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new BadRequestError('from y to son requeridos (ISO date strings)')
    }
    const fromDate = new Date(from)
    const toDate = new Date(to)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestError('from / to deben ser fechas ISO válidas')
    }
    if (fromDate > toDate) {
      throw new BadRequestError('from no puede ser posterior a to')
    }
    const rows = await computeRevenueReport({
      from: fromDate,
      to: toDate,
      venueId: typeof venueId === 'string' && venueId ? venueId : undefined,
    })
    const totals = rows.reduce(
      (acc, r) => ({
        txCount: acc.txCount + r.txCount,
        volume: acc.volume + r.volume,
        providerNet: acc.providerNet + r.providerNet,
        avoqadoNet: acc.avoqadoNet + r.avoqadoNet,
        aggregatorNet: acc.aggregatorNet + r.aggregatorNet,
      }),
      { txCount: 0, volume: 0, providerNet: 0, avoqadoNet: 0, aggregatorNet: 0 },
    )
    res.json({ success: true, data: rows, meta: { count: rows.length, totals } })
  } catch (error) {
    next(error)
  }
}
