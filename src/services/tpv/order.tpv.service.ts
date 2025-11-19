import prisma from '../../utils/prismaClient'
import { Order, Prisma } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'

/**
 * Helper function to flatten OrderItemModifier structure for Android compatibility
 *
 * Backend Prisma returns nested structure:
 * { modifiers: [{ id: "oim_123", modifier: { id, name, price } }] }
 *
 * Android DTOs expect flat structure:
 * { modifiers: [{ id, name, price }] }
 *
 * @param order Order with nested modifiers structure
 * @returns Order with flattened modifiers
 */
function flattenOrderModifiers(order: any): any {
  if (!order) return order

  return {
    ...order,
    items:
      order.items?.map((item: any) => ({
        ...item,
        modifiers:
          item.modifiers?.map((om: any) => ({
            id: om.modifier?.id || om.id,
            name: om.modifier?.name || om.name,
            price: om.modifier?.price || om.price,
            type: om.modifier?.type || om.type,
            required: om.modifier?.required || om.required,
            displayOrder: om.modifier?.displayOrder || om.displayOrder,
          })) || [],
      })) || [],
  }
}

/**
 * Get all open orders (orders) for a venue
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @returns Array of orders with payment status PENDING or PARTIAL
 */
export async function getOrders(venueId: string, _orgId?: string): Promise<(Order & { tableName: string | null })[]> {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      paymentStatus: {
        in: ['PENDING', 'PARTIAL'], // Equivalent to legacy 'OPEN' status
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Add computed tableName for Android app + flatten modifiers
  return orders.map(order => ({
    ...flattenOrderModifiers(order),
    tableName: order.table ? `Mesa ${order.table.number}` : null,
  }))
}

/**
 * Get a specific order (order) by ID
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param orderId Order ID (Order ID)
 * @returns Order with detailed payment information
 *
 * NOTE: Does NOT filter by paymentStatus (unlike getOrders list).
 * This allows fetching paid orders for receipt display after payment.
 */
export async function getOrder(
  venueId: string,
  orderId: string,
  _orgId?: string,
): Promise<Order & { amount_left: number; tableName: string | null }> {
  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
      // ✅ NO paymentStatus filter - allow fetching paid orders for receipt display
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
          paymentAllocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      payments: {
        include: {
          allocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Calculate amount left to pay
  const orderTotal = Number(order.total || 0)
  const totalPayments = order.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const amount_left = orderTotal - totalPayments

  // Construct table name for display in Android app
  const tableName = order.table ? `Mesa ${order.table.number}` : null

  return {
    ...flattenOrderModifiers(order),
    amount_left,
    tableName, // 🆕 Add computed tableName for Android MenuScreen title
  }
}

interface CreateOrderInput {
  tableId?: string | null
  covers?: number
  waiterId?: string
  orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
}

/**
 * Create a new order (for quick orders, counter service, delivery, etc.)
 * Generates CUID orderId and sequential orderNumber.
 * @param venueId Venue ID (tenant isolation)
 * @param input Order creation parameters
 * @returns Newly created order
 */
export async function createOrder(venueId: string, input: CreateOrderInput): Promise<Order & { tableName: string | null }> {
  logger.info(
    `🆕 [ORDER SERVICE] Creating new order | venue=${venueId} | type=${input.orderType || 'DINE_IN'} | table=${input.tableId || 'none'}`,
  )

  // Validate staff if provided
  if (input.waiterId) {
    const staff = await prisma.staff.findUnique({
      where: { id: input.waiterId },
    })
    if (!staff) {
      throw new NotFoundError('Staff member not found')
    }
  }

  // Generate order number (sequential timestamp-based)
  const orderNumber = `ORD-${Date.now()}`

  // Create order
  const order = await prisma.order.create({
    data: {
      venueId,
      tableId: input.tableId || null,
      covers: input.covers || 1,
      orderNumber,
      servedById: input.waiterId || null,
      createdById: input.waiterId || null,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      type: input.orderType || 'DINE_IN',
      source: 'TPV',
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      version: 1,
    },
    include: {
      items: true,
      payments: true,
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(`✅ [ORDER SERVICE] Order created | id=${order.id} | number=${order.orderNumber} | type=${order.type}`)

  // Emit Socket.IO event for real-time order creation notification
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.type,
      tableId: order.tableId,
      covers: order.covers,
    })
  }

  // Construct table name for display in Android app
  const tableName = order.table ? `Mesa ${order.table.number}` : null

  return {
    ...flattenOrderModifiers(order),
    tableName,
  }
}

interface AddOrderItemInput {
  productId: string
  quantity: number
  notes?: string | null
  modifierIds?: string[] // Array of modifier IDs to add to the order item
}

/**
 * Add items to an existing order with optimistic concurrency control
 * Uses version field to prevent concurrent updates (lost update problem)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param items Array of items to add
 * @param expectedVersion Expected version number for optimistic locking
 * @returns Updated order with new items
 */
export async function addItemsToOrder(
  venueId: string,
  orderId: string,
  items: AddOrderItemInput[],
  expectedVersion: number,
): Promise<Order & { tableName: string | null }> {
  logger.info(`📝 [ORDER SERVICE] Adding ${items.length} items to order ${orderId} (expected version: ${expectedVersion})`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new BadRequestError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot add items to a paid order')
  }

  // Fetch products and validate
  const productIds = items.map(item => item.productId)
  const products = await prisma.product.findMany({
    where: {
      id: { in: productIds },
      venueId,
    },
  })

  if (products.length !== productIds.length) {
    const foundIds = products.map(p => p.id)
    const missingIds = productIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Products not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  // Fetch all modifiers if any items have modifiers
  const allModifierIds = items.flatMap(item => item.modifierIds || [])
  logger.info(`🔍 [ADD ITEMS] Modifier IDs requested: ${JSON.stringify(allModifierIds)}`)

  const modifiers =
    allModifierIds.length > 0
      ? await prisma.modifier.findMany({
          where: {
            id: { in: allModifierIds },
          },
        })
      : []

  logger.info(`✅ [ADD ITEMS] Modifiers fetched from DB: ${modifiers.length} modifiers`)
  modifiers.forEach(m => logger.info(`  - ${m.name} (${m.id}): $${m.price}`))

  // Create new order items with modifiers
  const newOrderItems = await Promise.all(
    items.map(async item => {
      const product = products.find(p => p.id === item.productId)!

      // Calculate modifier total
      const itemModifiers = item.modifierIds || []
      const modifierTotal = itemModifiers.reduce((sum, modifierId) => {
        const modifier = modifiers.find(m => m.id === modifierId)
        return sum + (modifier ? Number(modifier.price) : 0)
      }, 0)

      logger.info(
        `💰 [ADD ITEMS] Product: ${product.name} | Base: $${product.price} | Modifiers: $${modifierTotal} | Total per unit: $${Number(product.price) + modifierTotal}`,
      )

      // Calculate item total: (product price + modifiers) * quantity
      const itemTotal = new Prisma.Decimal((Number(product.price) + modifierTotal) * item.quantity)

      // Create order item with modifiers
      const createdItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: product.price,
          discountAmount: 0,
          taxAmount: 0,
          total: itemTotal,
          notes: item.notes,
          modifiers: {
            create: itemModifiers.map(modifierId => {
              const modifier = modifiers.find(m => m.id === modifierId)!
              logger.info(`  📎 [ADD ITEMS] Creating OrderItemModifier: ${modifier.name} ($${modifier.price})`)
              return {
                modifierId,
                quantity: 1,
                price: modifier.price,
              }
            }),
          },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      })

      logger.info(`✅ [ADD ITEMS] Created OrderItem: ${product.name} with ${createdItem.modifiers.length} modifiers`)
      return createdItem
    }),
  )

  // Calculate new totals
  const allItems = [...order.items, ...newOrderItems]
  const newSubtotal = allItems.reduce((sum, item) => sum + Number(item.total), 0)
  const newTotal = newSubtotal // Can add tax/discount logic here

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      total: newTotal,
      version: {
        increment: 1,
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Added ${newOrderItems.length} items to order ${order.orderNumber}. New total: $${newTotal} (version: ${order.version} → ${updatedOrder.version})`,
  )

  // Log modifier counts in final response
  updatedOrder.items.forEach(item => {
    const modifierCount = item.modifiers?.length || 0
    if (modifierCount > 0) {
      logger.info(`  📦 [RESPONSE] OrderItem ${item.product.name} has ${modifierCount} modifiers in response`)
      item.modifiers?.forEach(om => {
        logger.info(`     - ${om.modifier.name}: $${om.price}`)
      })
    }
  })

  // Emit Socket.IO event for real-time order updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      newItems: newOrderItems.map(item => ({
        id: item.id,
        productId: item.productId,
        productName: item.product.name,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
      })),
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  // Construct table name for display in Android app
  const tableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName,
  }
}

interface UpdateGuestInfoInput {
  covers?: number
  customerName?: string | null
  customerPhone?: string | null
  specialRequests?: string | null
}

/**
 * Update guest information for an order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param guestInfo Guest information to update
 * @returns Updated order
 */
export async function updateGuestInfo(
  venueId: string,
  orderId: string,
  guestInfo: UpdateGuestInfoInput,
): Promise<Order & { tableName: string | null }> {
  logger.info(`👥 [ORDER SERVICE] Updating guest info for order ${orderId}`)

  // Fetch order
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Validate covers if provided
  if (guestInfo.covers !== undefined && guestInfo.covers < 1) {
    throw new BadRequestError('Covers must be at least 1')
  }

  // Update order with new guest info
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(guestInfo.covers !== undefined && { covers: guestInfo.covers }),
      ...(guestInfo.customerName !== undefined && { customerName: guestInfo.customerName }),
      ...(guestInfo.customerPhone !== undefined && { customerPhone: guestInfo.customerPhone }),
      ...(guestInfo.specialRequests !== undefined && { specialRequests: guestInfo.specialRequests }),
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Updated guest info for order ${order.orderNumber} | covers=${updatedOrder.covers} | customer=${updatedOrder.customerName || 'N/A'}`,
  )

  // Emit Socket.IO event for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      covers: updatedOrder.covers,
      customerName: updatedOrder.customerName,
      guestInfoUpdated: true,
    })
  }

  const updatedTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: updatedTableName,
  }
}

/**
 * Remove an item from an existing order with optimistic concurrency control
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param orderItemId Item ID to remove
 * @param expectedVersion Expected version number for optimistic locking
 * @returns Updated order without the removed item
 */
export async function removeOrderItem(
  venueId: string,
  orderId: string,
  orderItemId: string,
  expectedVersion: number,
): Promise<Order & { tableName: string | null }> {
  logger.info(`🗑️ [ORDER SERVICE] Removing item ${orderItemId} from order ${orderId} (expected version: ${expectedVersion})`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new BadRequestError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot remove items from a paid order')
  }

  // Verify item exists in order
  const itemToRemove = order.items.find(item => item.id === orderItemId)
  if (!itemToRemove) {
    throw new NotFoundError('Order item not found in this order')
  }

  // Delete the order item (Prisma will cascade delete modifiers)
  await prisma.orderItem.delete({
    where: { id: orderItemId },
  })

  logger.info(`✅ [ORDER SERVICE] Deleted item: ${itemToRemove.product.name} (${itemToRemove.id})`)

  // Calculate new totals
  const remainingItems = order.items.filter(item => item.id !== orderItemId)
  const newSubtotal = remainingItems.reduce((sum, item) => sum + Number(item.total), 0)
  const newTotal = newSubtotal // Can add tax/discount logic here

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      total: newTotal,
      version: {
        increment: 1,
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Removed item from order ${order.orderNumber}. New total: $${newTotal} (version: ${order.version} → ${updatedOrder.version})`,
  )

  // Emit Socket.IO event for real-time order updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      removedItemId: orderItemId,
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  // Construct table name for display in Android app
  const tableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName,
  }
}

// ==========================================
// ORDER ACTIONS (Comp, Void, Discount)
// ==========================================

interface CompItemsInput {
  itemIds: string[] // Items to comp (empty array = comp entire order)
  reason: string // Required: "Food quality issue", "Long wait time", etc.
  staffId: string // Staff member performing the action
  notes?: string
}

/**
 * Comp (complimentary) items or entire order
 * Removes cost from delivered items (for service recovery)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Comp details
 * @returns Updated order with comped items
 */
export async function compItems(venueId: string, orderId: string, input: CompItemsInput): Promise<Order & { tableName: string | null }> {
  logger.info(`🚫 [ORDER SERVICE] Comping items for order ${orderId} | reason: ${input.reason}`)

  // Fetch order
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Validate order is not already paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot comp items from a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Determine which items to comp
  const itemsToComp =
    input.itemIds.length === 0
      ? order.items // Comp entire order
      : order.items.filter(item => input.itemIds.includes(item.id))

  if (itemsToComp.length === 0) {
    throw new BadRequestError('No items found to comp')
  }

  // Calculate discount amount (total of comped items)
  const compAmount = itemsToComp.reduce((sum, item) => sum + Number(item.total), 0)

  logger.info(`  💰 Comping ${itemsToComp.length} items | total discount: $${compAmount}`)

  // Update order: increase discountAmount, decrease total
  const newDiscountAmount = Number(order.discountAmount) + compAmount
  const newTotal = Number(order.subtotal) - newDiscountAmount

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      version: {
        increment: 1,
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'COMP',
      performedById: input.staffId,
      reason: input.reason,
      metadata: {
        itemIds: input.itemIds,
        compAmount,
        itemCount: itemsToComp.length,
        notes: input.notes,
      },
    },
  })

  logger.info(`✅ [ORDER SERVICE] Comped ${itemsToComp.length} items | discount: $${compAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'COMP',
      compAmount,
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  const compTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: compTableName,
  }
}

interface VoidItemsInput {
  itemIds: string[] // Items to void
  reason: string // Required: "Wrong item entered", "Customer changed mind", etc.
  staffId: string // Staff member performing the action
  expectedVersion: number // Optimistic locking
}

/**
 * Void (cancel) items from an order
 * Completely removes items that were entered by mistake (before kitchen preparation)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Void details
 * @returns Updated order without voided items
 */
export async function voidItems(venueId: string, orderId: string, input: VoidItemsInput): Promise<Order & { tableName: string | null }> {
  logger.info(`❌ [ORDER SERVICE] Voiding ${input.itemIds.length} items from order ${orderId} | reason: ${input.reason}`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  if (order.version !== input.expectedVersion) {
    logger.warn(`⚠️ [ORDER SERVICE] Version mismatch! Expected: ${input.expectedVersion}, Got: ${order.version}`)
    throw new BadRequestError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${input.expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot void items from a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Find items to void
  const itemsToVoid = order.items.filter(item => input.itemIds.includes(item.id))

  if (itemsToVoid.length === 0) {
    throw new BadRequestError('No items found to void')
  }

  if (itemsToVoid.length !== input.itemIds.length) {
    throw new BadRequestError('Some item IDs were not found in this order')
  }

  // Check if any items already sent to kitchen (optional warning, but still allow void)
  const sentToKitchen = itemsToVoid.filter(item => item.sentToKitchenAt !== null)
  if (sentToKitchen.length > 0) {
    logger.warn(`⚠️ [ORDER SERVICE] Voiding ${sentToKitchen.length} items already sent to kitchen. Kitchen may need notification.`)
  }

  // Calculate void amount (for audit trail)
  const voidAmount = itemsToVoid.reduce((sum, item) => sum + Number(item.total), 0)

  logger.info(`  💰 Voiding ${itemsToVoid.length} items | total voided: $${voidAmount}`)

  // Delete the items (Prisma cascades to OrderItemModifier)
  await prisma.orderItem.deleteMany({
    where: {
      id: {
        in: input.itemIds,
      },
    },
  })

  // Calculate new totals
  const remainingItems = order.items.filter(item => !input.itemIds.includes(item.id))
  const newSubtotal = remainingItems.reduce((sum, item) => sum + Number(item.total), 0)
  const newTotal = newSubtotal - Number(order.discountAmount)

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      total: newTotal,
      version: {
        increment: 1,
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'VOID',
      performedById: input.staffId,
      reason: input.reason,
      metadata: {
        itemIds: input.itemIds,
        voidAmount,
        itemCount: itemsToVoid.length,
        itemNames: itemsToVoid.map(item => item.product.name),
        sentToKitchen: sentToKitchen.length > 0,
      },
    },
  })

  logger.info(`✅ [ORDER SERVICE] Voided ${itemsToVoid.length} items | voided amount: $${voidAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'VOID',
      voidedItemIds: input.itemIds,
      voidAmount,
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  const voidTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: voidTableName,
  }
}

interface ApplyDiscountInput {
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number // Percentage (0-100) or fixed amount
  reason?: string // Optional for promotional discounts
  staffId: string // Staff member performing the action
  itemIds?: string[] // Optional: apply to specific items (null = order-level)
  expectedVersion: number // Optimistic locking
}

/**
 * Apply discount to order or specific items
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Discount details
 * @returns Updated order with discount applied
 */
export async function applyDiscount(
  venueId: string,
  orderId: string,
  input: ApplyDiscountInput,
): Promise<Order & { tableName: string | null }> {
  logger.info(`💰 [ORDER SERVICE] Applying ${input.type} discount to order ${orderId} | value: ${input.value}`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  if (order.version !== input.expectedVersion) {
    logger.warn(`⚠️ [ORDER SERVICE] Version mismatch! Expected: ${input.expectedVersion}, Got: ${order.version}`)
    throw new BadRequestError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${input.expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot apply discount to a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Validate discount value
  if (input.type === 'PERCENTAGE') {
    if (input.value < 0 || input.value > 100) {
      throw new BadRequestError('Percentage discount must be between 0 and 100')
    }
  } else {
    if (input.value < 0) {
      throw new BadRequestError('Fixed discount amount cannot be negative')
    }
  }

  // Calculate discount amount
  let discountAmount: number

  if (input.itemIds && input.itemIds.length > 0) {
    // Item-level discount
    const itemsToDiscount = order.items.filter(item => input.itemIds!.includes(item.id))
    if (itemsToDiscount.length === 0) {
      throw new BadRequestError('No items found to apply discount')
    }

    const itemsSubtotal = itemsToDiscount.reduce((sum, item) => sum + Number(item.total), 0)

    if (input.type === 'PERCENTAGE') {
      discountAmount = (itemsSubtotal * input.value) / 100
    } else {
      discountAmount = Math.min(input.value, itemsSubtotal) // Can't discount more than item total
    }
  } else {
    // Order-level discount
    const orderSubtotal = Number(order.subtotal)

    if (input.type === 'PERCENTAGE') {
      discountAmount = (orderSubtotal * input.value) / 100
    } else {
      discountAmount = Math.min(input.value, orderSubtotal) // Can't discount more than order total
    }
  }

  // Round to 2 decimal places
  discountAmount = Math.round(discountAmount * 100) / 100

  logger.info(`  💰 Calculated discount: $${discountAmount}`)

  // Update order: add to existing discount
  const newDiscountAmount = Number(order.discountAmount) + discountAmount
  const newTotal = Number(order.subtotal) - newDiscountAmount

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      version: {
        increment: 1,
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'DISCOUNT',
      performedById: input.staffId,
      reason: input.reason || 'Discount applied',
      metadata: {
        discountType: input.type,
        discountValue: input.value,
        discountAmount,
        itemIds: input.itemIds || [],
        itemLevel: !!input.itemIds,
      },
    },
  })

  logger.info(`✅ [ORDER SERVICE] Applied discount | amount: $${discountAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'DISCOUNT',
      discountAmount,
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  const discountTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: discountTableName,
  }
}
