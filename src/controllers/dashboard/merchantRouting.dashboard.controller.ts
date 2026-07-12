import { NextFunction, Request, Response } from 'express'
import * as merchantRoutingDashboardService from '../../services/dashboard/merchantRouting.dashboard.service'

/** GET /dashboard/venues/:venueId/merchant-routing-rules */
export async function listRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await merchantRoutingDashboardService.listVenueRoutingRules(req.params.venueId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/venues/:venueId/merchant-routing-rules — upsert por merchant */
export async function upsertRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authContext = (req as any).authContext
    const result = await merchantRoutingDashboardService.upsertVenueRoutingRule(req.params.venueId, req.body, authContext?.userId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** DELETE /dashboard/venues/:venueId/merchant-routing-rules/:merchantAccountId */
export async function deleteRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authContext = (req as any).authContext
    const result = await merchantRoutingDashboardService.deleteVenueRoutingRule(
      req.params.venueId,
      req.params.merchantAccountId,
      authContext?.userId,
    )
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** POST /dashboard/venues/:venueId/merchant-routing-rules/preview — simulador */
export async function previewEligibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authContext = (req as any).authContext
    const result = await merchantRoutingDashboardService.previewVenueEligibility(req.params.venueId, req.body, {
      staffId: authContext?.userId,
      role: authContext?.role,
    })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
