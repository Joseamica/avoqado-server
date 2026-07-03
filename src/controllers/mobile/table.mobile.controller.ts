/**
 * Mobile Table Controller
 *
 * Thin wrapper around the same table service the TPV endpoint uses
 * (`table.tpv.service.ts`), mounted on `/mobile/*` so iOS/Android POS apps
 * don't have to depend on the `/tpv/*` namespace (which is reserved for the
 * PAX terminal app and carries its own version-gating semantics).
 *
 * Response shape is identical to `GET /tpv/venues/:venueId/tables` —
 * `{ success: true, data: Table[] }` — so clients need no model changes.
 */

import { Request, Response } from 'express'
import * as tableService from '../../services/tpv/table.tpv.service'
import logger from '../../config/logger'

/**
 * GET /mobile/venues/:venueId/tables
 * Get all tables with their current status for the reservation/floor-plan
 * table picker.
 */
export async function getTables(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info(`[TABLE MOBILE CONTROLLER] GET /mobile/venues/${venueId}/tables`)

    const tables = await tableService.getTablesWithStatus(venueId)

    res.status(200).json({
      success: true,
      data: tables,
    })
  } catch (error: any) {
    logger.error(`[TABLE MOBILE CONTROLLER] Error getting tables: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
