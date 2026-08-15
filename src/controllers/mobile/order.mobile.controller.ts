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
    // Accepts either a product item (with productId), a custom line item
    // (no productId, but must have name + unitPrice — e.g. "Otro importe"),
    // or a promotion line (promotionRef).
    for (const item of items) {
      // Una línea de promoción no trae productId ni precio: trae QUÉ promoción
      // tocó el cajero y QUÉ eligió la persona (el cliente NUNCA manda precios
      // de promoción — el server resuelve sus líneas), así que las reglas de
      // abajo —quantity, productId o (name + unitPrice)— no le aplican.
      //
      // 🔴 El criterio es el MISMO que el del servicio y el de la ruta: basta
      // que `promotionRef` venga. Y si viene, su FORMA se valida aquí, en la
      // frontera — un promotionRef a medias que pasara de largo entraría al
      // motor con ids undefined y reventaría como 500 DESPUÉS de crear la
      // orden, en vez de decirle al POS qué mandó mal.
      if (item?.promotionRef) {
        const ref = item.promotionRef
        const formaValida =
          typeof ref.promotionId === 'string' &&
          ref.promotionId.length > 0 &&
          typeof ref.promotionInstanceId === 'string' &&
          ref.promotionInstanceId.length > 0 &&
          Array.isArray(ref.selections)
        if (!formaValida) {
          return res.status(400).json({
            success: false,
            message: 'promotionRef requiere promotionId, promotionInstanceId y selections',
          })
        }
        // 🔴 Una línea es promoción O producto, nunca las dos. El servicio manda
        // al motor todo lo que traiga promotionRef, así que un item mixto
        // perdería su producto EN SILENCIO: se cobraría el combo y no la
        // hamburguesa que el cajero también capturó. Es subcobro, así que se
        // rechaza en vez de adivinar cuál de los dos quiso decir.
        const traeLineaNormal =
          (typeof item.productId === 'string' && item.productId.length > 0) ||
          (typeof item.name === 'string' && item.name.length > 0) ||
          typeof item.unitPrice === 'number'
        if (traeLineaNormal) {
          return res.status(400).json({
            success: false,
            message: 'Un item no puede ser producto y promoción a la vez: manda la promoción en su propia línea',
          })
        }
        // 🔴 El motor cobra UNA instancia por `promotionRef` y la cantidad se
        // ignora: 3 combos entraban al ticket como 1 — subcobro de 2/3 del
        // valor. El contrato es una instancia por combo. Se tolera `quantity: 1`
        // porque es lo que emite un carrito normal (su modelo de línea trae
        // quantity=1 por default) y no cambia un centavo.
        if (item.quantity != null && item.quantity !== 1) {
          return res.status(400).json({
            success: false,
            message: 'Una promoción no lleva cantidad: manda una línea por combo, cada una con su propio promotionInstanceId',
          })
        }
        continue
      }
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

    // 🔴 Propina NEGATIVA = descuento disfrazado. El servicio suma la propina al
    // total SIN clamp (`tipDecimal = tip/100`), así que un tip de -500 rebajaba
    // el total en silencio. El descuento sí se clampa (`max(0, discount)`); la
    // propina debe recibir el mismo trato en la frontera. La ruta /fast ya lo
    // valida por Zod (`tip: min(0)`, tpv.schema.ts) — estos dos endpoints eran
    // los únicos sin la regla. Medido en full-testingv2 2026-08-09: tip -500
    // aceptado con 200 dejó la orden inconciliable (paidAmount ≠ suma de pagos).
    if (tip !== undefined && (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0)) {
      return res.status(400).json({
        success: false,
        message: 'tip no puede ser negativo (en centavos)',
      })
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
    const { amount, tip, staffId, idempotencyKey, method, externalSource } = req.body

    // Métodos que el POS puede registrar a mano. NO incluye los que Avoqado
    // procesa de verdad (DIGITAL_WALLET, CRYPTOCURRENCY): esos los escribe el
    // flujo del procesador, y dejar que un cliente los declare aquí
    // inventaría ingresos procesados que nunca pasaron por nosotros.
    const MANUAL_METHODS = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'OTHER'] as const
    if (method !== undefined && !MANUAL_METHODS.includes(method)) {
      return res.status(400).json({
        success: false,
        message: `method inválido. Permitidos: ${MANUAL_METHODS.join(', ')}`,
      })
    }

    // Validate required fields
    //
    // 🔴 `amount === 0` SÍ es válido, y es el único caso nuevo: una cuenta
    // cortesiada al 100% (o con un descuento que se come el total) vale $0 y
    // tiene que poder CERRARSE. Antes se rechazaba junto con los negativos, y
    // esas cuentas se quedaban abiertas para siempre: `compWholeOrder` deja los
    // artículos en 0 pero nunca marca la orden como pagada, y este endpoint era
    // la única salida. Medido: ORD-1785877370147 llevaba 5 días abierta en $0.
    //
    // Quien decide si el 0 es legítimo es el SERVICIO, comparando contra el
    // saldo real de la orden — aquí sólo se deja pasar el tipo.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: 'amount es requerido y no puede ser negativo (en centavos)',
      })
    }

    // 🔴 Propina NEGATIVA = descuento disfrazado (y peor: inconciliable).
    // payCashOrder suma `previousTips + tip/100` al total sin clamp: un tip de
    // -500 con 200 dejó una orden PAID con total mutado 45→40 y
    // `paidAmount (40) ≠ suma de pagos (45)` — medido en full-testingv2
    // 2026-08-09, la consulta de integridad subió 947→948 con UNA orden.
    // /fast ya lo rechaza por Zod; este endpoint era el único agujero de pago.
    if (tip !== undefined && (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0)) {
      return res.status(400).json({
        success: false,
        message: 'tip no puede ser negativo (en centavos)',
      })
    }

    // Use authenticated user's staff ID if not provided
    const effectiveStaffId = staffId || req.authContext?.userId

    const result = await orderMobileService.payCashOrder(venueId, orderId, {
      amount,
      tip: tip || 0,
      staffId: effectiveStaffId,
      // 🛡️ Antes se descartaba: los clientes SIEMPRE la mandan y su cola offline
      // espera un 409-duplicado para marcar el pago como sincronizado.
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      // Opcionales y ADITIVOS: sin ellos el cobro sigue siendo efectivo, así
      // que las versiones viejas de la app no cambian de comportamiento.
      method,
      externalSource: typeof externalSource === 'string' ? externalSource : undefined,
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

    // Mesas mandan RONDAS (deltas): cada Enviar crea sus propias filas (modelo Square).
    const updatedOrder = await orderTpvService.addItemsToOrder(venueId, orderId, items, version, true)

    // Cobros automáticos por comensales: al crecer el subtotal la regla puede
    // empezar a aplicar (el recompute del TPV ya refresca los % existentes).
    try {
      const { syncAutomaticServiceCharges } = await import('../../services/mobile/service-charge.mobile.service')
      await syncAutomaticServiceCharges(venueId, orderId)
    } catch {
      // no-fatal: el cargo se aplicará en el siguiente recálculo
    }

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

/**
 * POST /mobile/venues/:venueId/orders/:orderId/comp
 * TABLE_SERVICE — "Cortesía en la cuenta": comps EVERY line of the open
 * order with one reason. Body: { reason: string }
 */
export const compWholeOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId as string | undefined

    const { compWholeOrder: compAll } = await import('../../services/mobile/comp-item.mobile.service')
    const result = await compAll({ venueId, orderId, reason, staffId })

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/details
 * TABLE_SERVICE — partial update of the check's metadata (never money):
 * Body: { name?, notes?, covers?, customerId? }
 */
export const updateOrderDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { name, notes, covers, customerId, orderType } = req.body || {}

    const result = await orderMobileService.updateOrderDetails(venueId, orderId, { name, notes, covers, customerId, orderType })

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/discounts
 * TABLE_SERVICE — applies an ORDER-scope catalog discount to the open check.
 * Body: { discountId: string }
 */
export const applyOrderDiscount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { discountId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    if (!discountId || typeof discountId !== 'string') {
      return res.status(400).json({ success: false, message: 'discountId is required' })
    }
    const result = await orderMobileService.applyOrderDiscount(venueId, orderId, discountId, staffId)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/merge
 * "Fusionar cuentas": vuelca los artículos de sourceOrderId en esta cuenta.
 */
export const mergeOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { sourceOrderId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    if (!sourceOrderId || typeof sourceOrderId !== 'string') {
      return res.status(400).json({ success: false, message: 'sourceOrderId is required' })
    }
    const result = await orderMobileService.mergeOrders(venueId, orderId, sourceOrderId, staffId)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/split-by-seat
 * "Dividir por puesto": un cheque por asiento, en una sola transacción.
 */
export const splitOrderBySeat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const result = await orderMobileService.splitOrderBySeat(venueId, orderId, staffId)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /mobile/venues/:venueId/orders/:orderId/discounts/:orderDiscountId
 * TABLE_SERVICE — removes one applied order discount.
 */
export const removeOrderDiscount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, orderDiscountId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const result = await orderMobileService.removeOrderDiscount(venueId, orderId, orderDiscountId, staffId)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/split
 * TABLE_SERVICE — separates selected items into a NEW check on the same
 * table (Square's separate checks). Body: { itemIds: string[] }
 */
export const splitOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { itemIds } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    const result = await orderMobileService.splitOrderItems(venueId, orderId, itemIds, staffId)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
