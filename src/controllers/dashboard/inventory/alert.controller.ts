import { Request, Response, NextFunction } from 'express'
import { AlertStatus, AlertType } from '@prisma/client'
import * as alertService from '../../../services/dashboard/alert.service'

/**
 * Get all alerts for a venue
 */
export async function getAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, alertType, rawMaterialId } = req.query

    const filters = {
      status: status as AlertStatus | undefined,
      alertType: alertType as AlertType | undefined,
      rawMaterialId: rawMaterialId as string | undefined,
    }

    const alerts = await alertService.getAlerts(venueId, filters)

    res.json({
      success: true,
      data: alerts,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get active alerts count
 */
export async function getActiveAlertsCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const count = await alertService.getActiveAlertsCount(venueId)

    res.json({
      success: true,
      data: { count },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get alerts by category
 */
export async function getAlertsByCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const breakdown = await alertService.getAlertsByCategory(venueId)

    res.json({
      success: true,
      data: breakdown,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Acknowledge an alert
 */
export async function acknowledgeAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, alertId } = req.params
    const staffId = req.authContext?.userId

    const alert = await alertService.acknowledgeAlert(venueId, alertId, staffId)

    res.json({
      success: true,
      message: 'Alert acknowledged',
      data: alert,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Resolve an alert
 */
export async function resolveAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, alertId } = req.params
    const staffId = req.authContext?.userId

    const alert = await alertService.resolveAlert(venueId, alertId, staffId)

    res.json({
      success: true,
      message: 'Alert resolved',
      data: alert,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Dismiss an alert
 */
export async function dismissAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, alertId } = req.params
    const { reason } = req.body
    const staffId = req.authContext?.userId

    const alert = await alertService.dismissAlert(venueId, alertId, reason, staffId)

    res.json({
      success: true,
      message: 'Alert dismissed',
      data: alert,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get alert history for a raw material
 */
export async function getAlertHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const history = await alertService.getAlertHistory(venueId, rawMaterialId)

    res.json({
      success: true,
      data: history,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get alert statistics
 */
export async function getAlertStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate } = req.query

    const stats = await alertService.getAlertStats(
      venueId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
    )

    res.json({
      success: true,
      data: stats,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create manual alert
 */
export async function createManualAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body
    const staffId = req.authContext?.userId

    const alert = await alertService.createManualAlert(venueId, data, staffId)

    res.status(201).json({
      success: true,
      message: 'Alert created successfully',
      data: alert,
    })
  } catch (error) {
    next(error)
  }
}
