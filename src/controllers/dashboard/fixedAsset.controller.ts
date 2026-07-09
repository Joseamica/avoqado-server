import { NextFunction, Request, Response } from 'express'

import {
  disposeFixedAsset,
  listAssetTypes,
  listFixedAssets,
  registerFixedAsset,
  updateFixedAsset,
  type RegisterFixedAssetInput,
} from '../../services/fiscal/fixedAsset.service'
import { generateDepreciationForVenue } from '../../services/fiscal/fixedAssetDepreciation.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Activos fijos (Capa B, PREMIUM). Registro opt-in de inversiones + corrida de depreciación.
 * Gated en la ruta por `checkFeatureAccess('CFDI')` + permiso. Money en CENTAVOS (el dashboard convierte).
 */

/** GET /accounting/asset-types — catálogo de tipos con su tasa oficial default (para el selector). */
export function listAssetTypesController(_req: Request, res: Response, next: NextFunction): void {
  try {
    res.status(200).json({ assetTypes: listAssetTypes() })
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/fixed-assets — activos fijos registrados del contribuyente del local. */
export async function listFixedAssetsController(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await listFixedAssets(req.params.venueId))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/fixed-assets — registra (confirma) una compra como activo fijo. */
export async function registerFixedAssetController(
  req: Request<{ venueId: string }, {}, RegisterFixedAssetInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authContext = (req as any).authContext ?? {}
    const a = await registerFixedAsset(req.params.venueId, req.body, authContext.userId ?? null)
    res.status(201).json(a)
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/fixed-assets/depreciate — corre la depreciación del periodo (idempotente). */
export async function generateDepreciationController(
  req: Request<{ venueId: string }, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authContext = (req as any).authContext ?? {}
    const period = req.body?.period || currentPeriod()
    res.status(200).json(await generateDepreciationForVenue(req.params.venueId, period, authContext.userId ?? null))
  } catch (error) {
    next(error)
  }
}

/** PATCH /accounting/fixed-assets/:assetId — edita un activo (mientras siga activo). */
export async function updateFixedAssetController(
  req: Request<{ venueId: string; assetId: string }, {}, Partial<RegisterFixedAssetInput>>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authContext = (req as any).authContext ?? {}
    res.status(200).json(await updateFixedAsset(req.params.venueId, req.params.assetId, req.body, authContext.userId ?? null))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/fixed-assets/:assetId/dispose — da de baja un activo (venta u obsolescencia). */
export async function disposeFixedAssetController(
  req: Request<{ venueId: string; assetId: string }, {}, { disposalDate: string; proceedsCents?: number | null }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authContext = (req as any).authContext ?? {}
    const { disposalDate, proceedsCents } = req.body
    res.status(200).json(await disposeFixedAsset(req.params.venueId, req.params.assetId, { disposalDate, proceedsCents }, authContext.userId ?? null))
  } catch (error) {
    next(error)
  }
}
