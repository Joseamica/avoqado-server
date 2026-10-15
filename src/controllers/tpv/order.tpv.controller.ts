import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import { tienePermisoEnVenue } from '../../middlewares/permissionFlag.middleware'
import * as orderTpvService from '../../services/tpv/order.tpv.service'

export async function getOrders(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)
    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // Read query parameters for pay-later filtering
    const includePayLater = req.query.includePayLater === 'true'
    const onlyPayLater = req.query.onlyPayLater === 'true'

    // 4. Call service with clean data (Controller delegates)
    const orders = await orderTpvService.getOrders(venueId, orgId, {
      includePayLater,
      onlyPayLater,
    })

    // 5. Send HTTP response wrapped in standard format (Controller)
    res.status(200).json({
      success: true,
      data: orders,
    })
  } catch (error) {
    next(error) // 6. HTTP error handling (Controller)
  }
}

/**
 * Get pay-later orders (orders with customer linkage and pending payment)
 * Used by TPV to display "Pendientes de Pago" filter
 */
export async function getPayLaterOrders(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const venueId: string = req.params.venueId

    // Call service with onlyPayLater flag
    const orders = await orderTpvService.getOrders(venueId, orgId, { onlyPayLater: true })

    res.status(200).json({
      success: true,
      data: orders,
    })
  } catch (error) {
    next(error)
  }
}

export async function getOrder(req: Request<{ venueId: string; orderId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)
    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)
    const orderId: string = req.params.orderId // 4. Extract from req (Controller, already validated)

    // 5. Call service with clean data (Controller delegates)
    const order = await orderTpvService.getOrder(venueId, orderId, orgId)

    // 6. Send HTTP response wrapped in standard format (Controller)
    res.status(200).json({
      success: true,
      data: order,
    })
  } catch (error) {
    next(error) // 7. HTTP error handling (Controller)
  }
}

export async function createOrder(
  req: Request<
    { venueId: string },
    any,
    { tableId?: string; covers?: number; waiterId?: string; orderType?: string; terminalId?: string; source?: string; externalId?: string }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const { tableId, covers, waiterId, orderType, terminalId, source, externalId } = req.body

    const order = await orderTpvService.createOrder(venueId, {
      tableId,
      covers,
      waiterId,
      orderType: orderType as 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP',
      terminalId, // Track which terminal created this order
      deviceSerialNumber: req.authContext?.terminalSerialNumber, // Auto-resolve terminalId from JWT if terminalId not provided
      source: source as 'TPV' | 'KIOSK' | 'QR' | 'WEB' | 'APP' | 'PHONE' | 'POS', // KIOSK orders excluded from pay-later lists
      externalId,
    })

    res.status(201).json({
      success: true,
      data: order,
      message: 'Order created successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function createOrderWithItems(req: Request<{ venueId: string }, any, any>, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId = req.params.venueId

    const order = await orderTpvService.createOrderWithItems(venueId, {
      ...req.body,
      deviceSerialNumber: req.authContext?.terminalSerialNumber,
    })

    res.status(201).json({
      success: true,
      data: order,
      message: 'Order with items created successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function addItemsToOrder(
  req: Request<{ venueId: string; orderId: string }, any, { items: any[]; version: number }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { items, version } = req.body

    const updatedOrder = await orderTpvService.addItemsToOrder(venueId, orderId, items, version)

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: `Added ${items.length} item(s) to order`,
    })
  } catch (error) {
    next(error)
  }
}

export async function removeOrderItem(
  req: Request<{ venueId: string; orderId: string; itemId: string }, any, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const orderItemId: string = req.params.itemId
    const expectedVersion: number = parseInt(req.query.version as string, 10)

    const updatedOrder = await orderTpvService.removeOrderItem(venueId, orderId, orderItemId, expectedVersion)

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: 'Order item removed successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function updateGuestInfo(
  req: Request<{ venueId: string; orderId: string }, any, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { covers, customerName, customerPhone, specialRequests } = req.body

    const updatedOrder = await orderTpvService.updateGuestInfo(venueId, orderId, {
      covers,
      customerName,
      customerPhone,
      specialRequests,
    })

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: 'Guest information updated successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function compItems(
  req: Request<{ venueId: string; orderId: string }, any, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { itemIds, reason, staffId, notes } = req.body

    const updatedOrder = await orderTpvService.compItems(venueId, orderId, {
      itemIds: itemIds || [],
      reason,
      staffId,
      notes,
    })

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: itemIds && itemIds.length > 0 ? `Comped ${itemIds.length} item(s)` : 'Comped entire order',
    })
  } catch (error) {
    next(error)
  }
}

export async function voidItems(
  req: Request<{ venueId: string; orderId: string }, any, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { itemIds, reason, staffId, expectedVersion } = req.body

    const updatedOrder = await orderTpvService.voidItems(venueId, orderId, {
      itemIds,
      reason,
      staffId,
      expectedVersion,
    })

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: `Voided ${itemIds.length} item(s)`,
    })
  } catch (error) {
    next(error)
  }
}

export async function applyDiscount(
  req: Request<{ venueId: string; orderId: string }, any, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { type, value, reason, staffId, itemIds, expectedVersion } = req.body

    const updatedOrder = await orderTpvService.applyDiscount(venueId, orderId, {
      type,
      value,
      reason,
      staffId,
      itemIds,
      expectedVersion,
    })

    res.status(200).json({
      success: true,
      data: updatedOrder,
      message: 'Discount applied successfully',
    })
  } catch (error) {
    next(error)
  }
}

// ============================================================================
// Order-Customer Relationship Controllers (Multi-Customer Support)
// ============================================================================

export async function getOrderCustomers(
  req: Request<{ venueId: string; orderId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId

    const orderCustomers = await orderTpvService.getOrderCustomers(venueId, orderId)

    res.status(200).json({
      success: true,
      data: orderCustomers,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * 🔴 MEDIO-1 (full-testing, 15-oct-2026; decisión «A» del founder): el permiso que da el sello y los puntos al ligar un cliente
 * a una venta YA pagada. Es el MISMO que exige el «Agregar cliente» del POS (`POST /mobile/venues/:venueId/payments/:paymentId/
 * customer`) y la tool MCP `attach_customer_to_sale`. Las dos rutas de la TPV de abajo sólo exigen `orders:update` (lo tiene un
 * KITCHEN): con eso se liga, pero no se sella.
 */
const PERMISO_DE_LEALTAD_TARDIA = 'payments:create'

/**
 * ¿Quien liga puede otorgar la lealtad? Con el resolvedor EFECTIVO de siempre (`tienePermisoEnVenue`: el mismo de
 * `checkPermission`, con las personalizaciones del negocio y los conjuntos de permisos; `permissionEquivalence.test.ts` los
 * mantiene iguales). Falla CERRADO: si no se puede resolver, se liga sin sello (lo seguro) y queda en el log.
 */
async function puedeOtorgarLealtadTardia(req: Request<any, any, any>): Promise<boolean> {
  try {
    return await tienePermisoEnVenue(req as unknown as Request, PERMISO_DE_LEALTAD_TARDIA)
  } catch (error) {
    logger.warn('[TPV] No se pudo resolver payments:create para el sello tardío: se liga sin sello', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function addCustomerToOrder(
  req: Request<{ venueId: string; orderId: string }, any, { customerId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { customerId } = req.body

    // El actor del sello tardío es quien LIGA (el usuario autenticado), y sólo sella si tiene `payments:create` (MEDIO-1).
    const otorgarLealtad = await puedeOtorgarLealtadTardia(req)
    const { orderCustomers, loyalty } = await orderTpvService.addCustomerToOrder(venueId, orderId, customerId, req.authContext?.userId, {
      otorgarLealtad,
    })

    res.status(201).json({
      success: true,
      data: orderCustomers,
      // Hermano de `data` (no dentro): `data` es el arreglo que la TPV publicada parsea como lista. Campo nuevo y opcional.
      loyalty,
      message: 'Customer added to order successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function removeCustomerFromOrder(
  req: Request<{ venueId: string; orderId: string; customerId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const customerId: string = req.params.customerId

    // Ronda 2: en una venta cobrada, quitar al primario sólo promueve al siguiente si quien quita tiene `payments:create`.
    const otorgarLealtad = await puedeOtorgarLealtadTardia(req)
    const orderCustomers = await orderTpvService.removeCustomerFromOrder(venueId, orderId, customerId, { otorgarLealtad })

    res.status(200).json({
      success: true,
      data: orderCustomers,
      message: 'Customer removed from order successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function createAndAddCustomerToOrder(
  req: Request<{ venueId: string; orderId: string }, any, { firstName?: string; phone?: string; email?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { firstName, phone, email } = req.body

    // MEDIO-1: igual que `addCustomerToOrder`, el cliente NUEVO sólo sella si quien liga tiene `payments:create`.
    const otorgarLealtad = await puedeOtorgarLealtadTardia(req)
    const { orderCustomers, loyalty } = await orderTpvService.createAndAddCustomerToOrder(
      venueId,
      orderId,
      { firstName, phone, email },
      req.authContext?.userId,
      { otorgarLealtad },
    )

    res.status(201).json({
      success: true,
      data: orderCustomers,
      // Hermano de `data`, igual que en `addCustomerToOrder`.
      loyalty,
      message: 'Customer created and added to order successfully',
    })
  } catch (error) {
    next(error)
  }
}
