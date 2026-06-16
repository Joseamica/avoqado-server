import { NextFunction, Request, Response } from 'express'

import * as chartService from '../../services/fiscal/chartOfAccounts.service'

/**
 * Controller — Catálogo de cuentas (Capa B fiscal). Thin: extrae params/body/authContext,
 * delega al servicio, responde. Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM,
 * bundle con CFDI) + `accounting:read` (ver) / `accounting:manage` (editar).
 */

/** GET /accounting/chart-of-accounts — catálogo del local (o needsFiscalSetup). */
export async function getChartOfAccounts(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const catalog = await chartService.getCatalog(req.params.venueId)
    res.status(200).json(catalog)
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/chart-of-accounts/seed — siembra el catálogo base por giro (idempotente). */
export async function seedChartOfAccounts(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const catalog = await chartService.seedBaseChart(req.params.venueId, { staffId })
    res.status(200).json(catalog)
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/chart-of-accounts — crea una cuenta nueva. */
export async function createLedgerAccount(
  req: Request<{ venueId: string }, {}, chartService.CreateAccountInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const account = await chartService.createAccount(req.params.venueId, req.body, { staffId })
    res.status(201).json(account)
  } catch (error) {
    next(error)
  }
}

/** PATCH /accounting/chart-of-accounts/:accountId — edita una cuenta. */
export async function updateLedgerAccount(
  req: Request<{ venueId: string; accountId: string }, {}, chartService.UpdateAccountInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const account = await chartService.updateAccount(req.params.venueId, req.params.accountId, req.body, { staffId })
    res.status(200).json(account)
  } catch (error) {
    next(error)
  }
}
