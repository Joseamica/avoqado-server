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

/**
 * POST /mobile/venues/:venueId/tables/:tableId/open
 * TABLE_SERVICE (PRO) — open a table: reuses the table's active order if one
 * exists, otherwise creates an empty DINE_IN order and marks the table
 * OCCUPIED (same service the TPV terminal uses, so Socket.IO
 * TABLE_STATUS_CHANGE broadcasts stay consistent across clients).
 * Body: { covers?: number }
 */
export async function openTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params
    const staffId = (req as any).authContext?.userId
    if (!staffId) {
      res.status(401).json({ success: false, message: 'No autenticado' })
      return
    }
    const covers = Number(req.body?.covers) > 0 ? Number(req.body.covers) : 1

    const result = await tableService.assignTable(venueId, tableId, staffId, covers, null)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[TABLE MOBILE CONTROLLER] Error opening table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /mobile/venues/:venueId/tables/:tableId/clear
 * TABLE_SERVICE (PRO) — release a table after its order is PAID (the service
 * rejects clearing a table with an unpaid order). Marks it AVAILABLE and
 * broadcasts the change.
 */
export async function clearTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params

    await tableService.clearTable(venueId, tableId)

    res.status(200).json({ success: true, message: 'Mesa liberada' })
  } catch (error: any) {
    logger.error(`[TABLE MOBILE CONTROLLER] Error clearing table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/move
 * TABLE_SERVICE (PRO) — move an OPEN check to another table (Square's
 * "Mover"). Body: { targetTableId: string }
 */
export async function moveOrder(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { targetTableId } = req.body || {}

    if (!targetTableId || typeof targetTableId !== 'string') {
      res.status(400).json({ success: false, message: 'targetTableId is required' })
      return
    }

    logger.info(`[TABLE MOBILE CONTROLLER] POST /mobile/venues/${venueId}/orders/${orderId}/move -> ${targetTableId}`)
    await tableService.moveOrderToTable(venueId, orderId, targetTableId)

    res.status(200).json({ success: true })
  } catch (error: any) {
    logger.error(`[TABLE MOBILE CONTROLLER] Error moving order: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/assign
 * TABLE_SERVICE (PRO) — reassign an OPEN check to another waiter (Square's
 * "Asignar"). Body: { staffId: string }
 */
export async function assignOrder(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { staffId } = req.body || {}

    if (!staffId || typeof staffId !== 'string') {
      res.status(400).json({ success: false, message: 'staffId is required' })
      return
    }

    logger.info(`[TABLE MOBILE CONTROLLER] POST /mobile/venues/${venueId}/orders/${orderId}/assign -> ${staffId}`)
    const result = await tableService.assignOrderWaiter(venueId, orderId, staffId)

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[TABLE MOBILE CONTROLLER] Error assigning order: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
