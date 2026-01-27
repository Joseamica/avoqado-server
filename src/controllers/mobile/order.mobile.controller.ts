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
    const { items, staffId, orderType, source, tableId, customerName, customerPhone, specialRequests } = req.body

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere al menos un item',
      })
    }

    // Validate each item has required fields
    for (const item of items) {
      if (!item.productId) {
        return res.status(400).json({
          success: false,
          message: 'Cada item requiere productId',
        })
      }
      if (!item.quantity || item.quantity < 1) {
        return res.status(400).json({
          success: false,
          message: 'Cada item requiere quantity >= 1',
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
      customerName,
      customerPhone,
      specialRequests,
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

    await orderMobileService.cancelOrder(venueId, orderId, reason)

    res.status(200).json({
      success: true,
      message: 'Orden cancelada exitosamente',
    })
  } catch (error) {
    logger.error('Error in cancelOrder controller:', error)
    next(error)
  }
}
