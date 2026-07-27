import { NextFunction, Request, Response } from 'express'
import * as presentationService from '../../../services/dashboard/rawMaterialPresentation.service'

/**
 * Presentaciones de compra/salida de un insumo (CEDIS): "compro en caja,
 * remisiono en cono o kilos". La conversión vive en el servicio; el controller
 * sólo extrae, delega y responde.
 */

export async function getPresentations(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const presentations = await presentationService.listPresentations(venueId, rawMaterialId)
    res.json({ success: true, data: presentations })
  } catch (error) {
    next(error)
  }
}

export async function setPresentations(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const { userId: staffId } = (req as any).authContext
    const presentations = await presentationService.setPresentations(venueId, rawMaterialId, req.body.presentations, staffId)
    res.json({ success: true, data: presentations })
  } catch (error) {
    next(error)
  }
}
