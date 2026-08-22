/**
 * Mobile KDS Controller
 *
 * Kitchen Display System endpoints for mobile apps (iOS, Android).
 * Manages KDS orders that kitchen staff uses to track food preparation.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as kdsMobileService from '../../services/mobile/kds.mobile.service'

/**
 * List active KDS orders for a venue
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route GET /api/v1/mobile/venues/:venueId/kds/orders
 * @query status - Comma-separated status filter (default: NEW,PREPARING,READY)
 */
export const listKdsOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { status } = req.query

    const orders = await kdsMobileService.listKdsOrders(venueId, status as string | undefined)

    res.status(200).json({
      success: true,
      data: orders,
    })
  } catch (error) {
    logger.error('Error in listKdsOrders controller:', error)
    next(error)
  }
}

/**
 * Create a new KDS order (called after payment succeeds)
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route POST /api/v1/mobile/venues/:venueId/kds/orders
 * @body orderNumber - Order number for display
 * @body orderType - DINE_IN, TAKEOUT, DELIVERY (default: DINE_IN)
 * @body orderId - Optional linked order ID
 * @body items - Array of { productName, quantity, modifiers?, notes? }
 */
export const createKdsOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { orderNumber, orderType, orderId, items } = req.body

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere orderNumber',
      })
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere al menos un item',
      })
    }

    const order = await kdsMobileService.createKdsOrder(venueId, {
      orderNumber,
      orderType,
      orderId,
      items,
    })

    res.status(201).json({
      success: true,
      data: order,
    })
  } catch (error) {
    logger.error('Error in createKdsOrder controller:', error)
    next(error)
  }
}

/**
 * Update a KDS order's status
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route PUT /api/v1/mobile/venues/:venueId/kds/orders/:id/status
 * @body status - NEW, PREPARING, READY, or COMPLETED
 */
export const updateKdsOrderStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params
    const { status } = req.body

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere status',
      })
    }

    const order = await kdsMobileService.updateKdsOrderStatus(venueId, id, status)

    res.status(200).json({
      success: true,
      data: order,
    })
  } catch (error) {
    logger.error('Error in updateKdsOrderStatus controller:', error)
    next(error)
  }
}

/**
 * Bump a KDS order to COMPLETED instantly
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route POST /api/v1/mobile/venues/:venueId/kds/orders/:id/bump
 */
export const bumpKdsOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params

    const order = await kdsMobileService.bumpKdsOrder(venueId, id)

    res.status(200).json({
      success: true,
      data: order,
    })
  } catch (error) {
    logger.error('Error in bumpKdsOrder controller:', error)
    next(error)
  }
}

// ── Quién imprime una comanda que llegó SOLA ───────────────────────────────────────
// Un pedido de marketplace aparece a la vez en TODAS las pantallas de cocina; sin árbitro,
// las tres tablets de un local sacan el mismo papel tres veces.

/** POST /mobile/venues/:venueId/kds/orders/:id/claim-print — "yo la imprimo". */
export const claimKdsPrint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params
    const deviceId = String((req.body ?? {}).deviceId ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Falta identificar el aparato (deviceId).' })

    const r = await kdsMobileService.claimKdsPrint(venueId, id, deviceId)
    // 200 con `claimed:false` a propósito, NO un 409: perder la carrera es el resultado
    // NORMAL para todas las tablets menos una. Un error haría que el POS pinte una falla
    // cada vez que otra fue más rápida.
    return res.json({ ok: true, ...r })
  } catch (e) {
    return next(e)
  }
}

/** POST .../confirm-print — "ya salió el papel". */
export const confirmKdsPrinted = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params
    const deviceId = String((req.body ?? {}).deviceId ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Falta identificar el aparato (deviceId).' })
    const r = await kdsMobileService.confirmKdsPrinted(venueId, id, deviceId)
    return res.json({ ok: r.ok })
  } catch (e) {
    return next(e)
  }
}

/** POST .../release-print — "no pude"; la suelta YA para que otro aparato lo intente. */
export const releaseKdsPrint = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params
    const deviceId = String((req.body ?? {}).deviceId ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Falta identificar el aparato (deviceId).' })
    const r = await kdsMobileService.releaseKdsPrint(venueId, id, deviceId)
    return res.json({ ok: r.ok })
  } catch (e) {
    return next(e)
  }
}
