import { NextFunction, Request, Response } from 'express'
import * as printMobileService from '../../services/mobile/print.mobile.service'

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
