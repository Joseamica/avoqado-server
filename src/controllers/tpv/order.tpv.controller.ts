import { NextFunction, Request, Response } from 'express'

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
  req: Request<{ venueId: string }, any, { tableId?: string; covers?: number; waiterId?: string; orderType?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const { tableId, covers, waiterId, orderType } = req.body

    const order = await orderTpvService.createOrder(venueId, {
      tableId,
      covers,
      waiterId,
      orderType: orderType as 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP',
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

export async function addCustomerToOrder(
  req: Request<{ venueId: string; orderId: string }, any, { customerId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId
    const { customerId } = req.body

    const orderCustomers = await orderTpvService.addCustomerToOrder(venueId, orderId, customerId)

    res.status(201).json({
      success: true,
      data: orderCustomers,
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

    const orderCustomers = await orderTpvService.removeCustomerFromOrder(venueId, orderId, customerId)

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

    const orderCustomers = await orderTpvService.createAndAddCustomerToOrder(venueId, orderId, {
      firstName,
      phone,
      email,
    })

    res.status(201).json({
      success: true,
      data: orderCustomers,
      message: 'Customer created and added to order successfully',
    })
  } catch (error) {
    next(error)
  }
}
