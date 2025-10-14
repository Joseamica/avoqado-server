import { Request, Response, NextFunction } from 'express'
import { PurchaseOrderStatus } from '@prisma/client'
import * as purchaseOrderService from '../../../services/dashboard/purchaseOrder.service'
import AppError from '../../../errors/AppError'

/**
 * Get all purchase orders for a venue
 */
export async function getPurchaseOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, supplierId, startDate, endDate } = req.query

    const filters = {
      status: status as PurchaseOrderStatus | undefined,
      supplierId: supplierId as string | undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    }

    const purchaseOrders = await purchaseOrderService.getPurchaseOrders(venueId, filters)

    res.json({
      success: true,
      data: purchaseOrders,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get a single purchase order by ID
 */
export async function getPurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params

    const purchaseOrder = await purchaseOrderService.getPurchaseOrder(venueId, purchaseOrderId)

    if (!purchaseOrder) {
      throw new AppError('Purchase order not found', 404)
    }

    res.json({
      success: true,
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a new purchase order
 */
export async function createPurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body
    const staffId = req.authContext?.userId

    const purchaseOrder = await purchaseOrderService.createPurchaseOrder(venueId, data, staffId)

    res.status(201).json({
      success: true,
      message: 'Purchase order created successfully',
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update an existing purchase order
 */
export async function updatePurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const data = req.body
    const staffId = req.authContext?.userId

    const purchaseOrder = await purchaseOrderService.updatePurchaseOrder(venueId, purchaseOrderId, data, staffId)

    res.json({
      success: true,
      message: 'Purchase order updated successfully',
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Approve a purchase order
 */
export async function approvePurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const staffId = req.authContext?.userId

    const purchaseOrder = await purchaseOrderService.approvePurchaseOrder(venueId, purchaseOrderId, staffId)

    res.json({
      success: true,
      message: 'Purchase order approved successfully',
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Receive a purchase order
 */
export async function receivePurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const data = req.body
    const staffId = req.authContext?.userId

    const purchaseOrder = await purchaseOrderService.receivePurchaseOrder(venueId, purchaseOrderId, data, staffId)

    res.json({
      success: true,
      message: 'Purchase order received successfully',
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Cancel a purchase order
 */
export async function cancelPurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const { reason } = req.body
    const staffId = req.authContext?.userId

    const purchaseOrder = await purchaseOrderService.cancelPurchaseOrder(venueId, purchaseOrderId, reason, staffId)

    res.json({
      success: true,
      message: 'Purchase order cancelled successfully',
      data: purchaseOrder,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get purchase order statistics
 */
export async function getPurchaseOrderStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate } = req.query

    const stats = await purchaseOrderService.getPurchaseOrderStats(
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
