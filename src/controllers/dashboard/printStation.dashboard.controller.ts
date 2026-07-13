import { NextFunction, Request, Response } from 'express'
import * as printStationService from '../../services/dashboard/printStation.dashboard.service'

const actor = (req: Request): string | undefined => (req as any).authContext?.userId

// ── Printers ──
export async function listPrinters(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.listPrinters(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function createPrinter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.createPrinter(req.params.venueId, req.body, actor(req))
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function updatePrinter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.updatePrinter(req.params.venueId, req.params.printerId, req.body, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function deletePrinter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.deletePrinter(req.params.venueId, req.params.printerId, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

// ── Stations ──
export async function listStations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.listStations(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function createStation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.createStation(req.params.venueId, req.body, actor(req))
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function updateStation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.updateStation(req.params.venueId, req.params.stationId, req.body, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function deleteStation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.deleteStation(req.params.venueId, req.params.stationId, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

// ── Gateway ──
export async function getGateway(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.getGateway(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function upsertGateway(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.upsertGateway(req.params.venueId, req.body, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

// ── Routing ──
export async function getRouting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.getRouting(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function assignRouting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.assignRouting(req.params.venueId, req.body, actor(req))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function previewRouting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await printStationService.previewRouting(req.params.venueId, req.body)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
