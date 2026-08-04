import { Request, Response } from 'express'
import * as tableService from '../../services/tpv/table.tpv.service'
import logger from '../../config/logger'
import { logAction } from '../../services/dashboard/activity-log.service'

/**
 * POST /tpv/venues/:venueId/tables/:tableId/open
 * TABLE_SERVICE — abre una mesa: reusa la cuenta activa si ya existe, o crea una
 * orden DINE_IN vacía y marca la mesa OCCUPIED (mismo servicio que `assignTable`
 * de arriba: `tableService.assignTable`, para que el broadcast de Socket.IO
 * TABLE_STATUS_CHANGE quede consistente entre clientes). Body: { covers?: number }
 *
 * Re-export del controller de `/mobile` (Plan B Task 4, 2026-07-27) — mismo
 * patrón que `sync.tpv.controller.ts` con el reducer de sync (Task 3). Verificado
 * que `openTable` (`src/controllers/mobile/table.mobile.controller.ts`) SOLO lee
 * `req.params`, `authContext.userId` y `req.body.covers`, y llama a
 * `tableService.assignTable` (el servicio `/tpv`, no uno de `/mobile`) más
 * `syncAutomaticServiceCharges` — cero lógica acoplada al namespace `/mobile` que
 * copiar. Reexportar evita una segunda implementación que pueda divergir en
 * silencio; `/mobile` queda byte-idéntico.
 */
export { openTable } from '../mobile/table.mobile.controller'

/**
 * GET /tpv/venues/:venueId/tables
 * Get all tables with their current status for floor plan display
 *
 * Re-export del controller de `/mobile` (gap fix, 2026-07-29) — mismo patrón que
 * `openTable` arriba y `sync.tpv.controller.ts`. `table.mobile.controller.ts::getTables`
 * llama al MISMO `tableService.getTablesWithStatus` (`/tpv`'s own service) y solo agrega
 * los campos de propiedad de mesa (`settings.enforceTableOwnership`, `viewer.staffId`/
 * `viewer.canManageAllTables`) al SOBRE de la respuesta — el array `data` no cambia de
 * forma. Sin esto, dos terminales podían abrir la misma mesa sin que ninguna se enterara
 * hasta que los intents colisionaran al reconectar (ver
 * .claude/rules/offline-first-y-hub-lan.md). Reexportar evita una segunda copia que
 * pueda divergir en silencio; `/mobile` queda byte-idéntico.
 */
export { getTables } from '../mobile/table.mobile.controller'

/**
 * POST /tpv/venues/:venueId/tables/assign
 * Assign a table to create a new order or return existing order
 */
export async function assignTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { tableId, covers, terminalId } = req.body
    // Actor MUST come from the authenticated token, never the body — otherwise
    // a caller could attribute the table assignment to any staffId it sends
    // (same pattern as `openTable` in mobile/table.mobile.controller.ts).
    const staffId = (req as any).authContext?.userId
    if (!staffId) {
      res.status(401).json({ success: false, message: 'No autenticado' })
      return
    }

    logger.info(
      `[TABLE CONTROLLER] POST /tpv/venues/${venueId}/tables/assign - Table: ${tableId}, Staff: ${staffId}, Covers: ${covers}, Terminal: ${terminalId || 'none'}`,
    )

    const result = await tableService.assignTable(venueId, tableId, staffId, covers, terminalId)

    res.status(result.isNewOrder ? 201 : 200).json({
      success: true,
      data: {
        order: result.order,
        isNewOrder: result.isNewOrder,
        message: result.isNewOrder ? `New order created for table` : `Table already has an active order`,
      },
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error assigning table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /tpv/venues/:venueId/tables/:tableId/clear
 * Clear table after payment is completed
 */
export async function clearTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params

    logger.info(`[TABLE CONTROLLER] POST /tpv/venues/${venueId}/tables/${tableId}/clear`)

    await tableService.clearTable(venueId, tableId, (req as any).authContext?.userId)

    res.status(200).json({
      success: true,
      message: 'Table cleared successfully',
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error clearing table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /tpv/venues/:venueId/tables
 * Create a new table
 */
export async function createTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { number, capacity, shape, rotation, positionX, positionY, areaId } = req.body

    logger.info(`[TABLE CONTROLLER] POST /tpv/venues/${venueId}/tables - Number: ${number}`)

    const newTable = await tableService.createTable(venueId, {
      number,
      capacity,
      shape,
      rotation,
      positionX,
      positionY,
      areaId,
    })

    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      venueId,
      action: 'TABLE_CREATED',
      entity: 'Table',
      entityId: newTable.id,
      data: { number, capacity, shape, areaId },
    })

    res.status(201).json({
      success: true,
      data: newTable,
      message: 'Table created successfully',
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error creating table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * PUT /tpv/venues/:venueId/tables/:tableId/position
 * Update table position on floor plan
 */
export async function updateTablePosition(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params
    const { positionX, positionY } = req.body

    logger.info(`[TABLE CONTROLLER] PUT /tpv/venues/${venueId}/tables/${tableId}/position - X: ${positionX}, Y: ${positionY}`)

    const updatedTable = await tableService.updateTablePosition(venueId, tableId, positionX, positionY)

    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      venueId,
      action: 'TABLE_POSITION_UPDATED',
      entity: 'Table',
      entityId: tableId,
      data: { positionX, positionY },
    })

    res.status(200).json({
      success: true,
      data: updatedTable,
      message: 'Table position updated successfully',
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error updating table position: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * PUT /tpv/venues/:venueId/tables/:tableId
 * Update table properties (number, capacity, shape, rotation, areaId)
 */
export async function updateTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params
    const { number, capacity, shape, rotation, areaId } = req.body

    logger.info(`[TABLE CONTROLLER] PUT /tpv/venues/${venueId}/tables/${tableId} - Updates: ${JSON.stringify(req.body)}`)

    const updatedTable = await tableService.updateTable(venueId, tableId, {
      number,
      capacity,
      shape,
      rotation,
      areaId,
    })

    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      venueId,
      action: 'TABLE_UPDATED',
      entity: 'Table',
      entityId: tableId,
      data: { number, capacity, shape, rotation, areaId },
    })

    res.status(200).json({
      success: true,
      data: updatedTable,
      message: 'Table updated successfully',
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error updating table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * DELETE /tpv/venues/:venueId/tables/:tableId
 * Delete a table (soft delete)
 */
export async function deleteTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, tableId } = req.params

    logger.info(`[TABLE CONTROLLER] DELETE /tpv/venues/${venueId}/tables/${tableId}`)

    await tableService.deleteTable(venueId, tableId)

    void logAction({
      staffId: (req as any).authContext?.userId ?? null,
      venueId,
      action: 'TABLE_DELETED',
      entity: 'Table',
      entityId: tableId,
    })

    res.status(200).json({
      success: true,
      message: 'Table deleted successfully',
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error deleting table: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
