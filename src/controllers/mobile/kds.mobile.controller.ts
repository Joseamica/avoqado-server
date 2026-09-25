/**
 * Mobile KDS Controller
 *
 * Kitchen Display System endpoints for mobile apps (iOS, Android).
 * Manages KDS orders that kitchen staff uses to track food preparation.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as kdsMobileService from '../../services/mobile/kds.mobile.service'
import { reportOutOfStock, retryOutOfStock, type ResultadoRetiro } from '../../services/mobile/kdsOutOfStock.mobile.service'
import { OPERACION_EN_CURSO } from './deliveryOrder.mobile.controller'

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

    const [orders, total] = await Promise.all([
      kdsMobileService.listKdsOrders(venueId, status as string | undefined),
      kdsMobileService.countKdsOrders(venueId, status as string | undefined),
    ])

    // El total va en un encabezado y no en el cuerpo: las apps de la calle leen `data` como
    // arreglo y no deben cambiar. Si el tope recortó, queda dicho en el log (por negocio).
    res.setHeader('X-Total-Count', String(total))
    if (total > orders.length) {
      logger.warn('KDS: el tablero tiene más comandas activas que el tope; se devuelven las más recientes', {
        venueId,
        total,
        devueltas: orders.length,
      })
    }

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

    // Sin pantalla de cocina no se guarda comanda (etapa 1). 200 y no 204: Android sólo mira el 2xx,
    // iOS descarta el cuerpo y la caja de Windows lo llama dentro de runCatching.
    if (order === null) {
      return res.status(200).json({ success: true, data: null, created: false })
    }

    res.status(201).json({
      success: true,
      data: order,
      created: true,
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

/**
 * GET /mobile/venues/:venueId/kds/orders/:kdsOrderId/courier — "¿quién trae esto?", a botón.
 */
export const fetchKdsCourier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, kdsOrderId } = req.params
    const data = await kdsMobileService.fetchKdsCourier(venueId, kdsOrderId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    logger.error('Error in fetchKdsCourier controller:', error)
    next(error)
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

// ── «No tengo este artículo» (spec KDS Uber §3.3 / §3.5) ────────────────────────────
// 200 retirado (o ya lo estaba) · 202 esperando al proveedor · 409 precondición · 502 el proveedor
// lo rechazó · 503 no se le pudo hablar (nada salió; se puede volver a pedir).
// Las apps muestran `error` tal cual: el texto lo escribe el servidor.

function responderRetiro(res: Response, r: ResultadoRetiro) {
  switch (r.kind) {
    case 'HECHO':
      return res.status(200).json({ success: true, data: r.comanda })
    case 'EN_CURSO':
      return res
        .status(202)
        .json({ success: true, data: { state: r.state, attempts: r.attempts, since: r.since, canRetryAt: r.canRetryAt } })
    case 'CONFLICTO': {
      const que = r.ocupadaPor && OPERACION_EN_CURSO[r.ocupadaPor]
      return res.status(409).json({ success: false, code: r.code, error: que ? `Espera: ${que}. Intenta en un momento.` : r.error })
    }
    case 'RECHAZADO':
      return res.status(502).json({ success: false, code: 'PROVIDER_REJECTED', ...(r.reason ? { reason: r.reason } : {}), error: r.error })
    case 'NO_ENVIADO':
      return res.status(503).json({ success: false, code: 'PROVIDER_NOT_CONTACTED', error: r.error })
  }
}

/** POST /mobile/venues/:venueId/kds/orders/:kdsOrderId/items/:itemId/out-of-stock */
export const reportKdsItemOutOfStock = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, kdsOrderId, itemId } = req.params
    const { userId } = (req as any).authContext
    return responderRetiro(res, await reportOutOfStock(venueId, kdsOrderId, itemId, userId))
  } catch (e) {
    return next(e)
  }
}

/** POST …/out-of-stock/retry `{ expectedAttempt }` — una persona vuelve a pedirlo, 15 min después. */
export const retryKdsItemOutOfStock = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, kdsOrderId, itemId } = req.params
    const { userId } = (req as any).authContext
    const expectedAttempt = (req.body ?? {}).expectedAttempt
    if (!Number.isInteger(expectedAttempt) || expectedAttempt < 1) {
      return res.status(400).json({ success: false, error: 'Falta el número de intento (expectedAttempt) que se quiere reintentar.' })
    }
    return responderRetiro(res, await retryOutOfStock(venueId, kdsOrderId, itemId, userId, expectedAttempt))
  } catch (e) {
    return next(e)
  }
}
