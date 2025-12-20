import { NextFunction, Request, Response } from 'express'
import * as settlementIncidentService from '../../services/dashboard/settlementIncident.service'
import logger from '../../config/logger'

/**
 * Settlement Incident Controller
 *
 * Handlers for settlement incident management endpoints
 */

/**
 * GET /dashboard/venues/:venueId/settlement-incidents
 * Get all incidents for a venue (optionally filter by status)
 */
export async function getVenueIncidents(
  req: Request<{ venueId: string }, {}, {}, { status?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { status } = req.query

    let incidents
    if (status === 'pending') {
      incidents = await settlementIncidentService.getPendingIncidents(venueId)
    } else {
      incidents = await settlementIncidentService.getActiveIncidents(venueId)
    }

    res.status(200).json({ success: true, data: incidents })
  } catch (error) {
    logger.error('Error fetching venue incidents', { error })
    next(error)
  }
}

/**
 * GET /dashboard/superadmin/settlement-incidents
 * Get all incidents across all venues (SuperAdmin only)
 */
export async function getAllIncidents(req: Request<{}, {}, {}, { status?: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status } = req.query

    let incidents
    if (status === 'pending') {
      incidents = await settlementIncidentService.getPendingIncidents()
    } else {
      incidents = await settlementIncidentService.getActiveIncidents()
    }

    res.status(200).json({ success: true, data: incidents })
  } catch (error) {
    logger.error('Error fetching all incidents', { error })
    next(error)
  }
}

/**
 * POST /dashboard/venues/:venueId/settlement-incidents/:incidentId/confirm
 * Confirm whether a settlement arrived or not
 */
export async function confirmIncident(
  req: Request<
    { venueId: string; incidentId: string },
    {},
    {
      settlementArrived: boolean
      actualDate?: string
      notes?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { incidentId } = req.params
    const { settlementArrived, actualDate, notes } = req.body
    const userId = (req as any).user?.id || 'unknown'

    const result = await settlementIncidentService.confirmSettlementIncident(
      incidentId,
      userId,
      settlementArrived,
      actualDate ? new Date(actualDate) : undefined,
      notes,
    )

    res.status(200).json({
      success: true,
      data: result,
      message: settlementArrived ? 'Settlement confirmed as arrived' : 'Delay confirmed',
    })
  } catch (error) {
    logger.error('Error confirming incident', { error })
    next(error)
  }
}

/**
 * POST /dashboard/venues/:venueId/settlement-incidents/bulk-confirm
 * Bulk confirm multiple settlement incidents
 */
export async function bulkConfirmIncidents(
  req: Request<
    { venueId: string },
    {},
    {
      incidentIds: string[]
      settlementArrived: boolean
      actualDate?: string
      notes?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { incidentIds, settlementArrived, actualDate, notes } = req.body
    const userId = (req as any).user?.id || 'unknown'

    const result = await settlementIncidentService.bulkConfirmSettlementIncidents(
      venueId,
      incidentIds,
      userId,
      settlementArrived,
      actualDate ? new Date(actualDate) : undefined,
      notes,
    )

    res.status(200).json({
      success: true,
      data: result,
      message: `${result.confirmed} incidents confirmed${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
    })
  } catch (error) {
    logger.error('Error bulk confirming incidents', { error })
    next(error)
  }
}

/**
 * POST /dashboard/superadmin/settlement-incidents/:incidentId/escalate
 * Escalate an incident to SuperAdmin (SuperAdmin only)
 */
export async function escalateIncident(
  req: Request<
    { incidentId: string },
    {},
    {
      notes?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { incidentId } = req.params
    const { notes } = req.body

    const incident = await settlementIncidentService.escalateIncident(incidentId, notes)

    res.status(200).json({
      success: true,
      data: incident,
      message: 'Incident escalated to SuperAdmin',
    })
  } catch (error) {
    logger.error('Error escalating incident', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/settlement-incidents/stats
 * Get incident statistics for a venue
 */
export async function getVenueIncidentStats(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const stats = await settlementIncidentService.getIncidentStats(venueId)

    res.status(200).json({ success: true, data: stats })
  } catch (error) {
    logger.error('Error fetching venue incident stats', { error })
    next(error)
  }
}

/**
 * GET /dashboard/superadmin/settlement-incidents/stats
 * Get global incident statistics (SuperAdmin only)
 */
export async function getGlobalIncidentStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const stats = await settlementIncidentService.getIncidentStats()

    res.status(200).json({ success: true, data: stats })
  } catch (error) {
    logger.error('Error fetching global incident stats', { error })
    next(error)
  }
}
