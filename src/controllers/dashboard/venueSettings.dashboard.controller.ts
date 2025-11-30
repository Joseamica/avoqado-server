// src/controllers/dashboard/venueSettings.dashboard.controller.ts

/**
 * VenueSettings Dashboard Controller
 *
 * Thin HTTP layer for venue settings management.
 * Delegates all business logic to venueSettings.dashboard.service.ts
 */

import { NextFunction, Request, Response } from 'express'
import * as venueSettingsService from '../../services/dashboard/venueSettings.dashboard.service'

/**
 * GET /venues/:venueId/settings
 * Get all venue settings
 */
export async function getVenueSettings(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const settings = await venueSettingsService.getVenueSettings(venueId)
    res.status(200).json(settings)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /venues/:venueId/settings
 * Update venue settings (full settings)
 */
export async function updateVenueSettings(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const updates = req.body
    const settings = await venueSettingsService.updateVenueSettings(venueId, updates)
    res.status(200).json(settings)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/settings/tpv
 * @deprecated TPV settings are now per-terminal. Use GET /dashboard/tpv/:tpvId/settings
 */
export async function getTpvSettings(req: Request<{ venueId: string }>, res: Response, _next: NextFunction): Promise<void> {
  res.status(410).json({
    error: 'Gone',
    message: 'TPV settings are now per-terminal. Use GET /api/v1/dashboard/tpv/:tpvId/settings instead.',
    migrationDate: '2025-11-29',
  })
}

/**
 * PUT /venues/:venueId/settings/tpv
 * @deprecated TPV settings are now per-terminal. Use PUT /dashboard/tpv/:tpvId/settings
 */
export async function updateTpvSettings(req: Request<{ venueId: string }>, res: Response, _next: NextFunction): Promise<void> {
  res.status(410).json({
    error: 'Gone',
    message: 'TPV settings are now per-terminal. Use PUT /api/v1/dashboard/tpv/:tpvId/settings instead.',
    migrationDate: '2025-11-29',
  })
}
