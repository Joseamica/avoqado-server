import { NextFunction, Request, Response } from 'express'

import * as mappingService from '../../services/fiscal/accountMapping.service'

/**
 * Controller — Configuración contable (AccountMapping, Capa B). Thin: extrae
 * params/body/authContext, delega al servicio, responde. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read` (ver) / `accounting:manage` (editar).
 */

/** GET /accounting/account-mapping — los 16 movimientos con su cuenta asignada. */
export async function getAccountMapping(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await mappingService.getMappings(req.params.venueId))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/account-mapping/seed — siembra los defaults por giro (idempotente). */
export async function seedAccountMapping(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    res.status(200).json(await mappingService.seedDefaultMappings(req.params.venueId, { staffId }))
  } catch (error) {
    next(error)
  }
}

/** PATCH /accounting/account-mapping/:movementType — reasigna un movimiento a una cuenta. */
export async function setAccountMapping(
  req: Request<{ venueId: string; movementType: string }, {}, { ledgerAccountId?: string | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const row = await mappingService.setMapping(req.params.venueId, req.params.movementType, req.body.ledgerAccountId ?? null, { staffId })
    res.status(200).json(row)
  } catch (error) {
    next(error)
  }
}
