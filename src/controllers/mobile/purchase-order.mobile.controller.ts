/**
 * Mobile Purchase Order Controller
 *
 * Handles purchase order management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as poService from '../../services/mobile/purchase-order.mobile.service'

/**
 * List purchase orders
 * @route GET /api/v1/mobile/venues/:venueId/purchase-orders
 */
export const listPurchaseOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const filters: poService.ListPOFilters = {}
    if (req.query.status) filters.status = req.query.status as string
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string
    if (req.query.dateTo) filters.dateTo = req.query.dateTo as string
    if (req.query.search) filters.search = req.query.search as string

    const result = await poService.listPurchaseOrders(venueId, page, pageSize, filters)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Create purchase order
 * @route POST /api/v1/mobile/venues/:venueId/purchase-orders
 */
export const createPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { supplierName, items, notes, expectedDate } = req.body

    if (!supplierName) {
      return res.status(400).json({ success: false, message: 'supplierName es requerido' })
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un producto (items)' })
    }

    const result = await poService.createPurchaseOrder({
      venueId,
      staffId,
      supplierName,
      items,
      notes,
      expectedDate,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Get purchase order detail
 * @route GET /api/v1/mobile/venues/:venueId/purchase-orders/:poId
 */
export const getPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params

    const result = await poService.getPurchaseOrder(poId, venueId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Update purchase order status
 * @route PUT /api/v1/mobile/venues/:venueId/purchase-orders/:poId/status
 */
export const updateStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params
    const staffId = req.authContext?.userId || ''
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ success: false, message: 'status es requerido' })
    }

    const result = await poService.updateStatus(poId, venueId, status, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Receive stock from purchase order
 * @route POST /api/v1/mobile/venues/:venueId/purchase-orders/:poId/receive
 */
export const receiveStock = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params
    const staffId = req.authContext?.userId || ''
    const { items } = req.body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un item (items)' })
    }

    const result = await poService.receiveStock(poId, venueId, items, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
