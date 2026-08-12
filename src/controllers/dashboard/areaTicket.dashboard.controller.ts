import { NextFunction, Request, Response } from 'express'
import * as service from '../../services/dashboard/areaTicket.dashboard.service'
import { ListExternalIncidentsQuery, ListExternalSettlementsQuery } from '../../schemas/dashboard/areaTicket.schema'

const actor = (req: Request): string | undefined => (req as any).authContext?.userId

export async function getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await service.getOverview(req.params.venueId) })
  } catch (error) {
    next(error)
  }
}

export async function updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await service.updateSettings(req.params.venueId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function createArea(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(201).json({ success: true, data: await service.createArea(req.params.venueId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function updateArea(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await service.updateArea(req.params.venueId, req.params.areaId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function updateAreaSettlementRoute(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      success: true,
      data: await service.updateAreaSettlementRoute(req.params.venueId, req.params.areaId, req.body, actor(req)),
    })
  } catch (error) {
    next(error)
  }
}

export async function updateTerminal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res
      .status(200)
      .json({ success: true, data: await service.updateTerminal(req.params.venueId, req.params.terminalId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function updateScaleSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await service.updateScaleSettings(req.params.venueId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function createScaleProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(201).json({ success: true, data: await service.createScaleProfile(req.params.venueId, req.body, actor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function updateScaleProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      success: true,
      data: await service.updateScaleProfile(req.params.venueId, req.params.profileId, req.body, actor(req)),
    })
  } catch (error) {
    next(error)
  }
}

export async function getOperations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await service.getOperations(req.params.venueId) })
  } catch (error) {
    next(error)
  }
}

export async function listExternalSettlements(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      success: true,
      data: await service.listExternalSettlements(req.params.venueId, req.query as unknown as ListExternalSettlementsQuery),
    })
  } catch (error) {
    next(error)
  }
}

export async function listExternalIncidents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      success: true,
      data: await service.listExternalIncidents(req.params.venueId, req.query as unknown as ListExternalIncidentsQuery),
    })
  } catch (error) {
    next(error)
  }
}
