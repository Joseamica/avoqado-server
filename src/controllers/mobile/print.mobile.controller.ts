import { NextFunction, Request, Response } from 'express'
import * as printMobileService from '../../services/mobile/print.mobile.service'
import { setKitchenDisplay } from '../../services/dashboard/printStation.dashboard.service'

/** GET /mobile/venues/:venueId/print-config — config que el POS cachea (routing + impresoras + estaciones). */
export async function getPrintConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printMobileService.getPrintConfig(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** POST /mobile/venues/:venueId/print-jobs/sync — el gateway replica su outbox durable. */
export async function syncPrintJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printMobileService.syncPrintJobs(req.params.venueId, req.body)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** POST /mobile/venues/:venueId/print-gateway/heartbeat — latido del gateway + estado de impresoras. */
export async function gatewayHeartbeat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printMobileService.gatewayHeartbeat(req.params.venueId, req.body)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * La tablet encontró una impresora de red en otra dirección (DHCP) o aprendió su identidad, y lo avisa.
 * @route POST /api/v1/mobile/venues/:venueId/printers/:printerId/observed
 */
export async function reportarImpresoraObservada(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printMobileService.reportarImpresoraObservada(
      req.params.venueId,
      req.params.printerId,
      req.body,
      (req as any).authContext?.userId,
    )
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * La casilla «pantalla de cocina» desde la TABLET (etapa 3): el MISMO registro y las MISMAS reglas que el
 * dashboard — prender pasa por la puerta de lanzamiento y el plan; apagar siempre se puede.
 * @route PUT /api/v1/mobile/venues/:venueId/print-stations/:stationId/kitchen-display
 */
export async function setStationKitchenDisplay(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await setKitchenDisplay(req.params.venueId, req.params.stationId, req.body.enabled, (req as any).authContext?.userId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
