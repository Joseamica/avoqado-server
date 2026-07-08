import { NextFunction, Request, Response } from 'express'

import { getSalesRetention, setSalesRetention } from '../../services/fiscal/salesRetention.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Retención en ventas (Capa B). Captura manual por periodo de lo que los clientes morales
 * retuvieron al contribuyente (ISR/IVA), para que el IVA en flujo y el ISR provisional no queden inflados.
 * Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + permiso.
 */

/** GET /accounting/sales-retention?period=YYYY-MM — retención capturada del periodo (o ceros). */
export async function getSalesRetentionController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getSalesRetention(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}

/** PUT /accounting/sales-retention — alta/actualización de la retención del periodo (montos en centavos). */
export async function setSalesRetentionController(
  req: Request<{ venueId: string }, {}, { period: string; isrRetenidoCents?: number; ivaRetenidoCents?: number; note?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { period, isrRetenidoCents, ivaRetenidoCents, note } = req.body
    const authContext = (req as any).authContext ?? {}
    const r = await setSalesRetention(req.params.venueId, period, { isrRetenidoCents, ivaRetenidoCents, note }, authContext.userId ?? null)
    res.status(200).json(r)
  } catch (error) {
    next(error)
  }
}
