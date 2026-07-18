/**
 * Mobile Order Controller
 *
 * Order management endpoints for mobile apps (iOS, Android).
 * Supports the dual-mode payment flow where iOS creates an order
 * with items, then sends orderId to TPV for payment processing.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as orderMobileService from '../../services/mobile/order.mobile.service'
import * as orderTpvService from '../../services/tpv/order.tpv.service'

/**
 * List orders for a venue (paginated)
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route GET /api/v1/mobile/venues/:venueId/orders
 */
export const listOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { page = '1', pageSize = '20', search, status, paymentStatus } = req.query

    const result = await orderMobileService.listOrders(venueId, {
      page: Number(page),
      pageSize: Number(pageSize),
      search: search as string | undefined,
      status: status as string | undefined,
      paymentStatus: paymentStatus as string | undefined,
    })

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  } catch (error) {
    logger.error('Error in listOrders controller:', error)
    next(error)
  }
}

/**
 * Create order with items
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * Creates an order with products/items. Returns the orderId which
 * should be sent to the TPV via BLE for payment processing.
 *
 * @route POST /api/v1/mobile/venues/:venueId/orders
 */
export const createOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const {
      items,
      staffId,
      orderType,
      source,
      tableId,
      customerId,
      customerName,
      customerPhone,
      specialRequests,
      discount,
      tip,
      note,
      splitType,
      reservationId,
      externalId,
    } = req.body

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere al menos un item',
      })
    }

    // Validate each item has required fields.
    // Accepts either a product item (with productId) or a custom line item
    // (no productId, but must have name + unitPrice — e.g. "Otro importe").
    for (const item of items) {
      if (!item.quantity || item.quantity < 1) {
        return res.status(400).json({
          success: false,
          message: 'Cada item requiere quantity >= 1',
        })
      }
      const hasProductId = typeof item.productId === 'string' && item.productId.length > 0
      const hasCustomFields = typeof item.name === 'string' && item.name.length > 0 && typeof item.unitPrice === 'number'
      if (!hasProductId && !hasCustomFields) {
        return res.status(400).json({
          success: false,
          message: 'Cada item requiere productId o (name + unitPrice)',
        })
      }
      if (item.discountId != null && typeof item.discountId !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'discountId debe ser un string',
        })
      }
    }

    // Use authenticated user's ID if staffId not provided
    const effectiveStaffId = staffId || req.authContext?.userId

    if (!effectiveStaffId) {
      return res.status(400).json({
        success: false,
        message: 'staffId es requerido',
      })
    }

    const order = await orderMobileService.createOrderWithItems(venueId, {
      items,
      staffId: effectiveStaffId,
      orderType: orderType || 'TAKEOUT',
      source: source || 'AVOQADO_IOS',
      tableId,
      customerId,
      customerName,
      customerPhone,
      specialRequests,
      discount: typeof discount === 'number' ? discount : 0,
      tip: typeof tip === 'number' ? tip : 0,
      note,
      splitType,
      reservationId: typeof reservationId === 'string' ? reservationId : null,
      externalId: typeof externalId === 'string' ? externalId : null,
    })

    res.status(201).json({
      success: true,
      order,
    })
  } catch (error) {
    logger.error('Error in createOrder controller:', error)
    next(error)
  }
}

/**
 * Get order details
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route GET /api/v1/mobile/venues/:venueId/orders/:orderId
 */
export const getOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params

    const order = await orderMobileService.getOrder(venueId, orderId)

    res.status(200).json({
      success: true,
      order,
    })
  } catch (error) {
    logger.error('Error in getOrder controller:', error)
    next(error)
  }
}

/**
 * Pay order with cash
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * Records a cash payment for an order. No TPV terminal involved.
 * Payment goes directly to backend.
 *
 * @route POST /api/v1/mobile/venues/:venueId/orders/:orderId/pay
 */
export const payCash = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { amount, tip, staffId } = req.body

    // Validate required fields
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount es requerido y debe ser mayor a 0 (en centavos)',
      })
    }

    // Use authenticated user's staff ID if not provided
    const effectiveStaffId = staffId || req.authContext?.userId

    const result = await orderMobileService.payCashOrder(venueId, orderId, {
      amount,
      tip: tip || 0,
      staffId: effectiveStaffId,
    })

    res.status(200).json({
      success: true,
      payment: result,
    })
  } catch (error) {
    logger.error('Error in payCash controller:', error)
    next(error)
  }
}

/**
 * Cancel an unpaid order
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route DELETE /api/v1/mobile/venues/:venueId/orders/:orderId
 */
export const cancelOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { reason } = req.body
    const performedBy = (req as any).authContext?.userId as string | undefined

    await orderMobileService.cancelOrder(venueId, orderId, reason, performedBy)

    res.status(200).json({
      success: true,
      message: 'Orden cancelada exitosamente',
    })
  } catch (error) {
    logger.error('Error in cancelOrder controller:', error)
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/items
 * TABLE_SERVICE (PRO) — add a round of items to an OPEN order (table service).
 * Delegates to the same upsert-with-optimistic-concurrency service the TPV
 * uses: body carries { items: AddOrderItemInput[], version: number } and a
 * stale `version` answers 409 so the client refetches before retrying.
 */
export const addItemsToOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { items, version } = req.body ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items es requerido y no puede estar vacío' })
    }
    if (typeof version !== 'number') {
      return res.status(400).json({ success: false, message: 'version (número) es requerida para concurrencia optimista' })
    }

    const updatedOrder = await orderTpvService.addItemsToOrder(venueId, orderId, items, version)

    return res.status(200).json({
      success: true,
      data: updatedOrder,
      message: `Added ${items.length} item(s) to order`,
    })
  } catch (error) {
    logger.error('Error in addItemsToOrder controller:', error)
    next(error)
  }
}

/**
 * Comp an order item ("Dar de cortesía") with a mandatory reason.
 * @route POST /api/v1/mobile/venues/:venueId/orders/:orderId/items/:itemId/comp
 */
export const compOrderItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, itemId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId as string | undefined

    const { compOrderItem: compItem } = await import('../../services/mobile/comp-item.mobile.service')
    const result = await compItem({ venueId, orderId, itemId, reason, staffId })

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
