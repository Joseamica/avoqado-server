import { NextFunction, Request, Response } from 'express'

import * as periodLockService from '../../services/fiscal/accountingPeriodLock.service'

/**
 * Controller — Candado de periodo contable (Capa B). Thin. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read` (ver) / `accounting:manage` (cerrar/reabrir).
 */

interface PeriodBody {
  period: string
  reason?: string
}

/** GET /accounting/period-locks — candados de periodo del contribuyente. */
export async function getPeriodLocks(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await periodLockService.listPeriodLocks(req.params.venueId))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/period-locks/close — cierra un periodo (no admite pólizas nuevas dentro). */
export async function closePeriodController(
  req: Request<{ venueId: string }, {}, PeriodBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const { period, reason } = req.body
    res.status(200).json(await periodLockService.closePeriod(req.params.venueId, period, { staffId }, reason))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/period-locks/reopen — reabre un periodo cerrado (permite correcciones). */
export async function reopenPeriodController(
  req: Request<{ venueId: string }, {}, PeriodBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const { period, reason } = req.body
    res.status(200).json(await periodLockService.reopenPeriod(req.params.venueId, period, { staffId }, reason))
  } catch (error) {
    next(error)
  }
}
