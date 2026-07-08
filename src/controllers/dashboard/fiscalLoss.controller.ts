import { NextFunction, Request, Response } from 'express'

import { getFiscalLoss, setFiscalLoss } from '../../services/fiscal/fiscalLoss.service'

/**
 * Controller — Pérdidas fiscales de ejercicios anteriores (Capa B). Captura manual del saldo pendiente de
 * amortizar por contribuyente; el ISR general lo resta a la utilidad (topado). Gated CFDI (PREMIUM) + permiso.
 */

/** GET /accounting/fiscal-loss — saldo de pérdidas pendiente del contribuyente (o ceros). */
export async function getFiscalLossController(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await getFiscalLoss(req.params.venueId))
  } catch (error) {
    next(error)
  }
}

/** PUT /accounting/fiscal-loss — alta/actualización del saldo (montos en centavos). */
export async function setFiscalLossController(
  req: Request<{ venueId: string }, {}, { pendingCents?: number; note?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { pendingCents, note } = req.body
    const authContext = (req as any).authContext ?? {}
    res.status(200).json(await setFiscalLoss(req.params.venueId, { pendingCents, note }, authContext.userId ?? null))
  } catch (error) {
    next(error)
  }
}
