import { Request, Response, NextFunction } from 'express'
import * as productInventoryService from '../../services/dashboard/productInventory.service'
import logger from '../../config/logger'

/**
 * Adjust stock for a product with QUANTITY tracking
 */
export const adjustInventoryStockHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const data = req.body
    const correlationId = (req as any).correlationId
    const staffId = (req as any).authContext?.userId

    logger.info(`Adjusting inventory stock for product ${productId}`, {
      correlationId,
      venueId,
      productId,
      quantity: data.quantity,
      type: data.type,
    })

    const result = await productInventoryService.adjustInventoryStock(venueId, productId, data, staffId)

    res.status(200).json({
      message: `Inventory stock adjusted successfully`,
      data: result,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get stock movements for a product with QUANTITY tracking
 */
export const getInventoryMovementsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const correlationId = (req as any).correlationId

    logger.info(`Fetching inventory movements for product ${productId}`, {
      correlationId,
      venueId,
      productId,
    })

    const movements = await productInventoryService.getInventoryMovements(venueId, productId)

    res.status(200).json({
      message: `Inventory movements for product ${productId}`,
      data: movements,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get unified global inventory movements
 */
export const getGlobalMovementsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId } = req.params
    const query = req.query as any
    const correlationId = (req as any).correlationId

    logger.info(`Fetching global inventory movements for venue ${venueId}`, {
      correlationId,
      venueId,
      query,
    })

    const result = await productInventoryService.getGlobalMovements(venueId, {
      page: Number(query.page),
      limit: Number(query.limit),
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      type: query.type,
    })

    res.status(200).json({
      message: `Global inventory movements fetched successfully`,
      data: result.data,
      meta: result.meta,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}
