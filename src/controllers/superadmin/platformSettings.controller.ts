/**
 * PlatformSettings controller (SUPERADMIN).
 *
 * Exposes GET/PATCH for the singleton platform config. Mounted at
 * /api/v1/dashboard/superadmin/platform-settings — parent router guards
 * the whole tree with `checkPermission('system:manage')`.
 *
 * @module controllers/superadmin/platformSettings
 */

import { Request, Response } from 'express'
import * as platformSettingsService from '@/services/superadmin/platformSettings.service'
import logger from '@/config/logger'

export async function getPlatformSettings(_req: Request, res: Response) {
  try {
    const settings = await platformSettingsService.getPlatformSettings()
    res.json({ success: true, data: settings })
  } catch (error: any) {
    logger.error('Error fetching platform settings:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch platform settings',
    })
  }
}

export async function updatePlatformSettings(req: Request, res: Response) {
  try {
    const { ecommercePlatformFeeBpsDefault, vatRateBps } = req.body as {
      ecommercePlatformFeeBpsDefault?: unknown
      vatRateBps?: unknown
    }

    const input: { ecommercePlatformFeeBpsDefault?: number; vatRateBps?: number } = {}

    if (ecommercePlatformFeeBpsDefault !== undefined) {
      // Mirror the per-merchant fee validation: must be an integer 0–3000 bps.
      // Anything above 30% is almost certainly a unit mistake (e.g. someone
      // typed 5 thinking "5%" rather than 500 bps).
      if (typeof ecommercePlatformFeeBpsDefault !== 'number' || !Number.isInteger(ecommercePlatformFeeBpsDefault)) {
        return res.status(400).json({
          success: false,
          error: 'ecommercePlatformFeeBpsDefault debe ser un entero (puntos base, ej. 100 = 1%)',
        })
      }
      if (ecommercePlatformFeeBpsDefault < 0 || ecommercePlatformFeeBpsDefault > 3000) {
        return res.status(400).json({
          success: false,
          error: 'ecommercePlatformFeeBpsDefault debe estar entre 0 y 3000 (0% a 30%)',
        })
      }
      input.ecommercePlatformFeeBpsDefault = ecommercePlatformFeeBpsDefault
    }

    if (vatRateBps !== undefined) {
      // 0–5000 bps (0%–50%) — anything higher is almost certainly a unit
      // mistake. MX uses 1600 (16%), the rest of the world fits in 0–2700.
      if (typeof vatRateBps !== 'number' || !Number.isInteger(vatRateBps)) {
        return res.status(400).json({
          success: false,
          error: 'vatRateBps debe ser un entero (puntos base, ej. 1600 = 16%)',
        })
      }
      if (vatRateBps < 0 || vatRateBps > 5000) {
        return res.status(400).json({
          success: false,
          error: 'vatRateBps debe estar entre 0 y 5000 (0% a 50%)',
        })
      }
      input.vatRateBps = vatRateBps
    }

    const updatedById = (req as any).authContext?.staffId
    const updated = await platformSettingsService.updatePlatformSettings(input, updatedById)
    res.json({ success: true, data: updated })
  } catch (error: any) {
    logger.error('Error updating platform settings:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to update platform settings',
    })
  }
}
