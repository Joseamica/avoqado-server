import { Request, Response } from 'express'
import * as floorElementService from '../../services/tpv/floor-element.tpv.service'
import logger from '../../config/logger'

/**
 * GET /tpv/venues/:venueId/floor-elements
 * Get all floor elements for a venue
 */
export async function getFloorElements(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info(`[FLOOR ELEMENT CONTROLLER] GET /tpv/venues/${venueId}/floor-elements`)

    const elements = await floorElementService.getFloorElements(venueId)

    res.status(200).json({
      success: true,
      data: elements,
    })
  } catch (error: any) {
    logger.error(`[FLOOR ELEMENT CONTROLLER] Error getting floor elements: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * POST /tpv/venues/:venueId/floor-elements
 * Create a new floor element
 */
export async function createFloorElement(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { type, positionX, positionY, width, height, rotation, endX, endY, label, color, areaId } = req.body

    logger.info(`[FLOOR ELEMENT CONTROLLER] POST /tpv/venues/${venueId}/floor-elements - Type: ${type}`)

    const element = await floorElementService.createFloorElement(venueId, {
      type,
      positionX,
      positionY,
      width,
      height,
      rotation,
      endX,
      endY,
      label,
      color,
      areaId,
    })

    res.status(201).json({
      success: true,
      data: element,
      message: 'Floor element created successfully',
    })
  } catch (error: any) {
    logger.error(`[FLOOR ELEMENT CONTROLLER] Error creating floor element: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * PUT /tpv/venues/:venueId/floor-elements/:elementId
 * Update a floor element
 */
export async function updateFloorElement(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, elementId } = req.params
    const { positionX, positionY, width, height, rotation, endX, endY, label, color, areaId, active } = req.body

    logger.info(`[FLOOR ELEMENT CONTROLLER] PUT /tpv/venues/${venueId}/floor-elements/${elementId}`)

    const element = await floorElementService.updateFloorElement(venueId, elementId, {
      positionX,
      positionY,
      width,
      height,
      rotation,
      endX,
      endY,
      label,
      color,
      areaId,
      active,
    })

    res.status(200).json({
      success: true,
      data: element,
      message: 'Floor element updated successfully',
    })
  } catch (error: any) {
    logger.error(`[FLOOR ELEMENT CONTROLLER] Error updating floor element: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * DELETE /tpv/venues/:venueId/floor-elements/:elementId
 * Delete a floor element (soft delete)
 */
export async function deleteFloorElement(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, elementId } = req.params

    logger.info(`[FLOOR ELEMENT CONTROLLER] DELETE /tpv/venues/${venueId}/floor-elements/${elementId}`)

    await floorElementService.deleteFloorElement(venueId, elementId)

    res.status(200).json({
      success: true,
      message: 'Floor element deleted successfully',
    })
  } catch (error: any) {
    logger.error(`[FLOOR ELEMENT CONTROLLER] Error deleting floor element: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
