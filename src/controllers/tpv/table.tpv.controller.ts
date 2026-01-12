import { Request, Response } from 'express'
import * as tableService from '../../services/tpv/table.tpv.service'
import logger from '../../config/logger'

/**
 * GET /tpv/venues/:venueId/tables
 * Get all tables with their current status for floor plan display
 */
export async function getTables(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info(`[TABLE CONTROLLER] GET /tpv/venues/${venueId}/tables`)

    const tables = await tableService.getTablesWithStatus(venueId)

    res.status(200).json({
      success: true,
      data: tables,
    })
  } catch (error: any) {
    logger.error(`[TABLE CONTROLLER] Error getting tables: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /tpv/venues/:venueId/tables/assign
 * Assign a table to create a new order or return existing order
 */
export async function assignTable(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { tableId, staffId, covers, terminalId } = req.body

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

    await tableService.clearTable(venueId, tableId)

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
