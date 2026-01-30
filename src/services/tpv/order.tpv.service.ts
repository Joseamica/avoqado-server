import prisma from '../../utils/prismaClient'
import { Order, Prisma } from '@prisma/client'
import { NotFoundError, BadRequestError, ConflictError } from '../../errors/AppError'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'
import { moduleService, MODULE_CODES } from '../modules/module.service'

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
 * @param options Optional filtering options for pay-later orders
 * @returns Array of orders with payment status PENDING or PARTIAL
 */
export async function getOrders(
  venueId: string,
  _orgId?: string,
  options?: {
    includePayLater?: boolean // If true, include pay-later orders
    onlyPayLater?: boolean // If true, ONLY return pay-later orders
    includeKiosk?: boolean // If true, include KIOSK orders (default: exclude)
  },
): Promise<(Order & { tableName: string | null })[]> {
  const where: any = {
    venueId,
    paymentStatus: {
      in: ['PENDING', 'PARTIAL'], // Equivalent to legacy 'OPEN' status
    },
  }

  // 🥝 KIOSK filtering: Exclude abandoned KIOSK orders from regular TPV order list
  // KIOSK orders are self-service and if abandoned, should NOT clutter the TPV order list.
  // The kiosk mode retrieves its own order by ID (getOrder), not from this list.
  if (!options?.includeKiosk) {
    where.source = { not: 'KIOSK' }
  }

  // Pay-later filtering logic
  // Pay-later orders = orders with customer linkage (OrderCustomer relationship)
  if (options?.onlyPayLater) {
    // Only return pay-later orders (has OrderCustomer)
    where.orderCustomers = { some: {} }
  } else if (!options?.includePayLater) {
    // Default behavior: EXCLUDE pay-later orders (no OrderCustomer)
    where.orderCustomers = { none: {} }
  }
  // If includePayLater is true, no filter is added (returns all)

  const orders = await prisma.order.findMany({
    where,
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
      orderCustomers: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
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
): Promise<Order & { amount_left: number; tableName: string | null; lastSplitType: string | null }> {
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

  // 🐛 DEBUG: Log raw Prisma response to see if modifiers are included
  logger.info(`🔍 [GET ORDER] Order ${orderId} - Items count: ${order.items.length}`)
  order.items.forEach((item, idx) => {
    logger.info(`   Item ${idx + 1}: ${item.product?.name || item.productName || 'DELETED'}`)
    logger.info(`      Modifiers count: ${item.modifiers?.length || 0}`)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((om: any) => {
        logger.info(`         - OrderItemModifier ID: ${om.id}`)
        logger.info(`         - Modifier: ${om.modifier?.name || om.name || 'NULL'} (${om.modifier?.price || om.price || 'NULL'})`)
      })
    }
  })

  // Calculate amount left to pay
  const orderTotal = Number(order.total || 0)
  const totalPayments = order.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const amount_left = orderTotal - totalPayments

  // Construct table name for display in Android app
  const tableName = order.table ? `Mesa ${order.table.number}` : null

  const flattenedOrder = flattenOrderModifiers(order)

  // 🐛 DEBUG: Log flattened response to verify flattening worked
  logger.info(`🔍 [GET ORDER] After flattening - Items count: ${flattenedOrder.items.length}`)
  flattenedOrder.items.forEach((item: any, idx: number) => {
    logger.info(`   Item ${idx + 1}: ${item.product?.name || item.productName || 'DELETED'}`)
    logger.info(`      Flattened modifiers count: ${item.modifiers?.length || 0}`)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((mod: any) => {
        logger.info(`         - ${mod.name} (${mod.price})`)
      })
    }
  })

  // Compute lastSplitType from most recent payment or order's splitType
  // Used by Android to restrict incompatible split options (prevents EQUALPARTS → PERPRODUCT)
  const lastSplitType = order.payments?.[0]?.splitType || order.splitType || null

  // ✅ Compute paidItemIds - items that have at least one payment allocation
  // Used by Android SplitByProductScreen to show paid items as disabled
  const paidItemIds = order.items
    .filter((item: any) => item.paymentAllocations && item.paymentAllocations.length > 0)
    .map((item: any) => item.id)

  logger.info(`🔍 [GET ORDER] paidItemIds: ${paidItemIds.length > 0 ? paidItemIds.join(', ') : 'none'}`)

  return {
    ...flattenedOrder,
    amount_left,
    tableName, // 🆕 Add computed tableName for Android MenuScreen title
    lastSplitType, // 🆕 For split type restriction in Android UI
    paidItemIds, // 🆕 For SplitByProduct screen to show paid items as disabled
  }
}

interface CreateOrderInput {
  tableId?: string | null
  covers?: number
  waiterId?: string
  orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
  terminalId?: string | null // Terminal that created this order (for sales attribution)
  source?: 'TPV' | 'KIOSK' | 'QR' | 'WEB' | 'APP' | 'PHONE' | 'POS' // Order source - KIOSK orders are excluded from pay-later lists
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
    `🆕 [ORDER SERVICE] Creating new order | venue=${venueId} | type=${input.orderType || 'DINE_IN'} | table=${input.tableId || 'none'} | source=${input.source || 'TPV'}`,
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
      terminalId: input.terminalId || null, // Track which terminal created this order
      status: 'PENDING',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      type: input.orderType || 'DINE_IN',
      source: input.source || 'TPV', // KIOSK orders are excluded from pay-later/open orders lists
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
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  // This allows the Android client to detect conflicts and refresh automatically
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new ConflictError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot add items to a paid order')
  }

  // Fetch products and validate
  // ✅ FIX: Use Set to deduplicate productIds (same product can be added multiple times)
  const uniqueProductIds = [...new Set(items.map(item => item.productId))]
  const products = await prisma.product.findMany({
    where: {
      id: { in: uniqueProductIds },
      venueId,
    },
    include: {
      category: {
        select: { name: true },
      },
    },
  })

  if (products.length !== uniqueProductIds.length) {
    const foundIds = products.map(p => p.id)
    const missingIds = uniqueProductIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Products not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  // Fetch all modifiers if any items have modifiers
  const allModifierIds = items.flatMap(item => item.modifierIds || [])
  logger.info(`🔍 [ADD ITEMS] Modifier IDs requested: ${JSON.stringify(allModifierIds)}`)

  // ✅ P1 FIX: Add venueId filter through group relation to prevent cross-tenant access (security)
  // Modifier doesn't have direct venueId; it's accessed via ModifierGroup
  const modifiers =
    allModifierIds.length > 0
      ? await prisma.modifier.findMany({
          where: {
            id: { in: allModifierIds },
            group: {
              venueId, // Security: Only fetch modifiers that belong to this venue's groups
            },
          },
        })
      : []

  logger.info(`✅ [ADD ITEMS] Modifiers fetched from DB: ${modifiers.length} modifiers`)
  modifiers.forEach(m => logger.info(`  - ${m.name} (${m.id}): $${m.price}`))

  // ⭐ P0 FIX: UPSERT items - update existing items or create new ones
  // This fixes the bug where quantity updates created duplicate items
  // Previously, when TPV synced a quantity change, it called addItemsToOrder
  // which always created NEW items. Now we check for existing items first.
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

      // ⭐ P0 FIX: Check if item with same productId AND same modifiers already exists
      // Sort modifier IDs for consistent comparison
      const sortedNewModifiers = [...itemModifiers].sort()

      // More precise check: query existing item with its modifiers
      const existingItemWithModifiers = await prisma.orderItem.findFirst({
        where: {
          orderId: order.id,
          productId: item.productId,
        },
        include: {
          modifiers: true,
        },
      })

      // Check if modifiers match
      let shouldUpdate = false
      if (existingItemWithModifiers) {
        const existingModifierIds = existingItemWithModifiers.modifiers.map(m => m.modifierId).sort()
        shouldUpdate = JSON.stringify(existingModifierIds) === JSON.stringify(sortedNewModifiers)
      }

      if (shouldUpdate && existingItemWithModifiers) {
        // ⭐ UPDATE existing item instead of creating new one
        logger.info(
          `🔄 [ADD ITEMS] UPDATING existing item: ${product.name} | old qty=${existingItemWithModifiers.quantity} → new qty=${item.quantity}`,
        )

        const updatedItem = await prisma.orderItem.update({
          where: { id: existingItemWithModifiers.id },
          data: {
            quantity: item.quantity,
            total: itemTotal,
            notes: item.notes ?? existingItemWithModifiers.notes,
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

        logger.info(`✅ [ADD ITEMS] UPDATED OrderItem: ${product.name} | qty=${updatedItem.quantity}`)
        return updatedItem
      }

      // Create NEW order item with modifiers (original behavior)
      // ✅ Toast/Square pattern: Denormalize product data for order history preservation
      const createdItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          // Denormalized fields - preserved even if product is later deleted
          productName: product.name,
          productSku: product.sku,
          categoryName: product.category?.name || null,
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
                // Denormalized modifier name - preserved even if modifier is later deleted
                name: modifier.name,
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

      logger.info(`✅ [ADD ITEMS] Created NEW OrderItem: ${product.name} with ${createdItem.modifiers.length} modifiers`)
      return createdItem
    }),
  )

  // ⭐ P0 FIX: Re-fetch all items from DB to avoid double-counting updated items
  // Previously we did [...order.items, ...newOrderItems] but this would duplicate
  // items that were UPDATED (old version + new version)
  const allItemsFromDb = await prisma.orderItem.findMany({
    where: { orderId: order.id },
  })
  const newSubtotal = allItemsFromDb.reduce((sum, item) => sum + Number(item.total), 0)

  // 🔄 Recalculate percentage-based discounts when items are added
  // Fetch any applied OrderDiscounts and recalculate PERCENTAGE discounts
  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: { discount: true },
  })

  let newDiscountAmount = 0
  for (const orderDiscount of orderDiscounts) {
    // Check if this is a percentage discount (from discount relation or type field)
    const discountType = orderDiscount.discount?.type || orderDiscount.type
    const discountValue = Number(orderDiscount.discount?.value || orderDiscount.value || 0)

    if (discountType === 'PERCENTAGE' && discountValue > 0) {
      // Recalculate percentage based on NEW subtotal
      const recalculatedAmount = (newSubtotal * discountValue) / 100
      const roundedAmount = Math.round(recalculatedAmount * 100) / 100

      logger.info(`  🔄 Recalculating PERCENTAGE discount: ${discountValue}% of $${newSubtotal} = $${roundedAmount}`)

      // Update individual OrderDiscount record
      await prisma.orderDiscount.update({
        where: { id: orderDiscount.id },
        data: { amount: roundedAmount },
      })

      newDiscountAmount += roundedAmount
    } else {
      // FIXED_AMOUNT or COUPON - keep original amount
      newDiscountAmount += Number(orderDiscount.amount)
    }
  }

  // If no OrderDiscounts but order has discountAmount, preserve it (from comp/manual discount)
  if (orderDiscounts.length === 0 && Number(order.discountAmount) > 0) {
    newDiscountAmount = Number(order.discountAmount)
  }

  const newTotal = newSubtotal - newDiscountAmount

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  logger.info(`  📊 New totals: subtotal=$${newSubtotal}, discount=$${newDiscountAmount}, total=$${newTotal}`)

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
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
      logger.info(`  📦 [RESPONSE] OrderItem ${item.product?.name || item.productName} has ${modifierCount} modifiers in response`)
      item.modifiers?.forEach(om => {
        logger.info(`     - ${om.modifier?.name || om.name}: $${om.price}`)
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
        productName: item.product?.name || item.productName || '',
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
  customerId?: string | null
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
      ...(guestInfo.customerId !== undefined && { customerId: guestInfo.customerId }),
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
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new ConflictError(
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

  logger.info(`✅ [ORDER SERVICE] Deleted item: ${itemToRemove.product?.name || itemToRemove.productName} (${itemToRemove.id})`)

  // Calculate new totals
  const remainingItems = order.items.filter(item => item.id !== orderItemId)
  const newSubtotal = remainingItems.reduce((sum, item) => sum + Number(item.total), 0)

  // 🔄 Recalculate percentage-based discounts when items are removed
  // Fetch any applied OrderDiscounts and recalculate PERCENTAGE discounts
  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: { discount: true },
  })

  let newDiscountAmount = 0
  for (const orderDiscount of orderDiscounts) {
    // Check if this is a percentage discount (from discount relation or type field)
    const discountType = orderDiscount.discount?.type || orderDiscount.type
    const discountValue = Number(orderDiscount.discount?.value || orderDiscount.value || 0)

    if (discountType === 'PERCENTAGE' && discountValue > 0) {
      // Recalculate percentage based on NEW subtotal
      const recalculatedAmount = (newSubtotal * discountValue) / 100
      const roundedAmount = Math.round(recalculatedAmount * 100) / 100

      logger.info(`  🔄 Recalculating PERCENTAGE discount: ${discountValue}% of $${newSubtotal} = $${roundedAmount}`)

      // Update individual OrderDiscount record
      await prisma.orderDiscount.update({
        where: { id: orderDiscount.id },
        data: { amount: roundedAmount },
      })

      newDiscountAmount += roundedAmount
    } else {
      // FIXED_AMOUNT or COUPON - keep original amount
      newDiscountAmount += Number(orderDiscount.amount)
    }
  }

  // If no OrderDiscounts but order has discountAmount, preserve it (from comp/manual discount)
  if (orderDiscounts.length === 0 && Number(order.discountAmount) > 0) {
    newDiscountAmount = Number(order.discountAmount)
  }

  const newTotal = newSubtotal - newDiscountAmount

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  logger.info(`  📊 New totals: subtotal=$${newSubtotal}, discount=$${newDiscountAmount}, total=$${newTotal}`)

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
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

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
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
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  if (order.version !== input.expectedVersion) {
    logger.warn(`⚠️ [ORDER SERVICE] Version mismatch! Expected: ${input.expectedVersion}, Got: ${order.version}`)
    throw new ConflictError(
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

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  // ⭐ FIX: Auto-close order if voiding all items (Toast/Square pattern)
  // When 0 items remain, order should be cancelled and removed from active list
  const isVoidingAllItems = remainingItems.length === 0

  if (isVoidingAllItems) {
    logger.info(`🚫 [ORDER SERVICE] Voiding ALL items - auto-closing order ${orderId}`)
  }

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      // ⭐ If voiding all items, auto-close order (Toast/Square pattern)
      ...(isVoidingAllItems && {
        status: 'CANCELLED',
        paymentStatus: 'PENDING', // Keep PENDING (order was never paid)
      }),
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

  // ⭐ If voided all items, remove customer linkages (pay-later orders)
  // No point keeping "cuenta por cobrar" for $0.00 order with 0 items (Toast/Square pattern)
  if (isVoidingAllItems) {
    const deletedCustomers = await prisma.orderCustomer.deleteMany({
      where: { orderId },
    })

    if (deletedCustomers.count > 0) {
      logger.info(`  👥 Removed ${deletedCustomers.count} customer linkage(s) from voided order`)
    }
  }

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
        itemNames: itemsToVoid.map(item => item.product?.name || item.productName),
        sentToKitchen: sentToKitchen.length > 0,
        voidedAllItems: isVoidingAllItems, // ⭐ Track if order was auto-closed
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
      // ⭐ If voided all items, notify clients that order was auto-closed
      ...(isVoidingAllItems && {
        voidedAllItems: true,
        status: updatedOrder.status, // CANCELLED
        paymentStatus: updatedOrder.paymentStatus, // PENDING
      }),
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

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
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

// ============================================================================
// Order-Customer Relationship Functions (Multi-Customer Support)
// ============================================================================

/**
 * Get all customers associated with an order
 */
export async function getOrderCustomers(venueId: string, orderId: string) {
  logger.info(`👥 [ORDER SERVICE] Getting customers for order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  const orderCustomers = await prisma.orderCustomer.findMany({
    where: { orderId },
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          loyaltyPoints: true,
          totalVisits: true,
          totalSpent: true,
          customerGroupId: true,
          customerGroup: {
            select: {
              id: true,
              name: true,
              color: true,
            },
          },
          tags: true,
        },
      },
    },
    orderBy: { addedAt: 'asc' },
  })

  logger.info(`✅ [ORDER SERVICE] Found ${orderCustomers.length} customers for order ${orderId}`)

  return orderCustomers
}

/**
 * Add a customer to an order (multi-customer support)
 * First customer added becomes primary (receives loyalty points)
 */
export async function addCustomerToOrder(venueId: string, orderId: string, customerId: string) {
  logger.info(`👤 [ORDER SERVICE] Adding customer ${customerId} to order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Verify customer exists and belongs to venue
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, venueId: true, firstName: true, lastName: true },
  })

  if (!customer || customer.venueId !== venueId) {
    throw new NotFoundError('Customer not found')
  }

  // Check if customer already added to order
  const existingAssociation = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
  })

  if (existingAssociation) {
    throw new BadRequestError('Customer already added to this order')
  }

  // 🔒 RACE CONDITION FIX: Use Serializable isolation to prevent multiple primaries
  // Combined with partial unique index on (orderId) WHERE isPrimary=true as defense-in-depth
  // Retry up to 5 times on serialization conflicts with exponential backoff
  const MAX_RETRIES = 5

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await prisma.$transaction(
        async tx => {
          // Check if this will be the first customer (primary) - inside transaction for consistency
          const existingCustomersCount = await tx.orderCustomer.count({
            where: { orderId },
          })
          const isPrimary = existingCustomersCount === 0

          // Add customer to order
          await tx.orderCustomer.create({
            data: {
              orderId,
              customerId,
              isPrimary,
            },
          })

          return { isPrimary }
        },
        {
          isolationLevel: 'Serializable', // Prevents race conditions
          timeout: 10000, // 10 second timeout
        },
      )

      logger.info(
        `✅ [ORDER SERVICE] Added customer ${customer.firstName || 'N/A'} ${customer.lastName || ''} to order ${order.orderNumber} | isPrimary=${result.isPrimary}`,
      )
      // Success - exit the retry loop
      break
    } catch (error: any) {
      // Handle unique constraint violation (partial unique index on isPrimary)
      if (error.code === 'P2002') {
        logger.warn(`⚠️ [ORDER SERVICE] Race condition detected - another customer was set as primary simultaneously`)
        // The customer was likely added with isPrimary=false due to timing, which is correct behavior
        // Re-check and add with isPrimary=false
        const existingAfterRace = await prisma.orderCustomer.findUnique({
          where: { orderId_customerId: { orderId, customerId } },
        })
        if (!existingAfterRace) {
          await prisma.orderCustomer.create({
            data: { orderId, customerId, isPrimary: false },
          })
          logger.info(`✅ [ORDER SERVICE] Added customer as non-primary after race condition resolution`)
        }
        break // Successfully handled
      } else if (error.code === 'P2034') {
        // Serialization failure - another transaction was modifying the same data
        logger.warn(`⚠️ [ORDER SERVICE] Serialization conflict, retrying... (attempt ${attempt}/${MAX_RETRIES})`)
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)))
          continue // Retry
        }
        // Max retries reached
        throw new BadRequestError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      } else {
        throw error
      }
    }
  }

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

/**
 * Remove a customer from an order
 * If removing primary customer, the next oldest customer becomes primary
 */
export async function removeCustomerFromOrder(venueId: string, orderId: string, customerId: string) {
  logger.info(`🗑️ [ORDER SERVICE] Removing customer ${customerId} from order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Find the association to remove
  const association = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
  })

  if (!association) {
    throw new NotFoundError('Customer not associated with this order')
  }

  const wasPrimary = association.isPrimary

  // Remove the association
  await prisma.orderCustomer.delete({
    where: { orderId_customerId: { orderId, customerId } },
  })

  // If removed customer was primary, promote the next oldest customer
  if (wasPrimary) {
    const nextCustomer = await prisma.orderCustomer.findFirst({
      where: { orderId },
      orderBy: { addedAt: 'asc' },
    })

    if (nextCustomer) {
      await prisma.orderCustomer.update({
        where: { id: nextCustomer.id },
        data: { isPrimary: true },
      })
      logger.info(`👑 [ORDER SERVICE] Promoted customer ${nextCustomer.customerId} to primary for order ${orderId}`)
    }
  }

  logger.info(`✅ [ORDER SERVICE] Removed customer from order ${order.orderNumber}`)

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

/**
 * Create a new customer and immediately add them to an order
 * Allows creating customer with minimal info (firstName OR phone OR email)
 */
export async function createAndAddCustomerToOrder(
  venueId: string,
  orderId: string,
  customerData: { firstName?: string; phone?: string; email?: string },
) {
  logger.info(`🆕 [ORDER SERVICE] Creating customer and adding to order ${orderId}`)

  // Normalize email to lowercase for consistent lookups
  const normalizedEmail = customerData.email?.toLowerCase()

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Check for duplicate email/phone in venue (if provided)
  if (normalizedEmail) {
    const existingByEmail = await prisma.customer.findUnique({
      where: { venueId_email: { venueId, email: normalizedEmail } },
    })
    if (existingByEmail) {
      throw new BadRequestError('Ya existe un cliente con ese email en este venue')
    }
  }

  if (customerData.phone) {
    const existingByPhone = await prisma.customer.findUnique({
      where: { venueId_phone: { venueId, phone: customerData.phone } },
    })
    if (existingByPhone) {
      throw new BadRequestError('Ya existe un cliente con ese teléfono en este venue')
    }
  }

  // 🔒 RACE CONDITION FIX: Create customer and add to order in Serializable transaction
  // Combined with partial unique index on (orderId) WHERE isPrimary=true as defense-in-depth
  // Retry up to 5 times on serialization conflicts with exponential backoff
  const MAX_RETRIES = 5

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$transaction(
        async tx => {
          // Check if this will be the first customer (primary) - INSIDE transaction for consistency
          const existingCustomersCount = await tx.orderCustomer.count({
            where: { orderId },
          })
          const isPrimary = existingCustomersCount === 0

          // Create the customer
          const newCustomer = await tx.customer.create({
            data: {
              venueId,
              firstName: customerData.firstName || null,
              phone: customerData.phone || null,
              email: normalizedEmail || null,
              firstVisitAt: new Date(),
            },
          })

          // Add to order
          await tx.orderCustomer.create({
            data: {
              orderId,
              customerId: newCustomer.id,
              isPrimary,
            },
          })

          logger.info(
            `✅ [ORDER SERVICE] Created customer ${newCustomer.id} and added to order ${order.orderNumber} | isPrimary=${isPrimary}`,
          )
        },
        {
          isolationLevel: 'Serializable', // Prevents race conditions
          timeout: 10000, // 10 second timeout
        },
      )
      // Success - exit the retry loop
      break
    } catch (error: any) {
      // Handle unique constraint violation (partial unique index on isPrimary)
      if (error.code === 'P2002') {
        // Could be duplicate email/phone OR isPrimary constraint
        if (error.meta?.target?.includes('email')) {
          throw new BadRequestError('Ya existe un cliente con ese email en este venue')
        }
        if (error.meta?.target?.includes('phone')) {
          throw new BadRequestError('Ya existe un cliente con ese teléfono en este venue')
        }
        // isPrimary constraint - this shouldn't happen in normal flow due to count check
        logger.warn(`⚠️ [ORDER SERVICE] Race condition on isPrimary detected during createAndAdd`)
        throw new BadRequestError('Conflicto de concurrencia, por favor intente de nuevo')
      } else if (error.code === 'P2034') {
        // Serialization failure - retry with exponential backoff
        logger.warn(`⚠️ [ORDER SERVICE] Serialization conflict in createAndAddCustomerToOrder (attempt ${attempt}/${MAX_RETRIES})`)
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)))
          continue // Retry
        }
        // Max retries reached
        throw new BadRequestError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      } else {
        throw error
      }
    }
  }

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

// ==========================================
// SERIALIZED INVENTORY - Mixed Cart Support
// For items with unique barcodes (SIMs, jewelry, electronics)
// ==========================================

interface AddSerializedItemInput {
  serialNumber: string
  categoryId?: string // Required if item not registered
  price: number // Cashier-entered price (SerializedItem has no price field)
  notes?: string | null
}

/**
 * Add a serialized item to an existing order (mixed cart support).
 * Handles both registered and unregistered items.
 *
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Serialized item details
 * @param expectedVersion Expected order version for optimistic locking
 * @param staffId Staff ID performing the action
 */
export async function addSerializedItemToOrder(
  venueId: string,
  orderId: string,
  input: AddSerializedItemInput,
  expectedVersion: number,
  staffId: string,
): Promise<Order & { tableName: string | null }> {
  logger.info(`📦 [ORDER SERVICE] Adding serialized item ${input.serialNumber} to order ${orderId}`)

  // Verify module is enabled for this venue
  const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!isEnabled) {
    throw new BadRequestError('Serialized inventory module is not enabled for this venue')
  }

  // Scan to check item status
  const scanResult = await serializedInventoryService.scan(venueId, input.serialNumber)

  if (scanResult.status === 'already_sold') {
    throw new BadRequestError(`Item ${input.serialNumber} ya fue vendido`)
  }

  if (scanResult.status === 'module_disabled') {
    throw new BadRequestError('Módulo de inventario serializado no habilitado')
  }

  // Get the order with optimistic locking check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      version: true,
      subtotal: true,
      total: true,
      discountAmount: true,
      paymentStatus: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.version !== expectedVersion) {
    throw new ConflictError('Order was modified by another user. Please refresh and try again.')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot add items to a paid order')
  }

  // Use transaction to ensure atomicity
  const result = await prisma.$transaction(async tx => {
    let serializedItemWithCategory: Awaited<ReturnType<typeof serializedInventoryService.getItemBySerialNumber>>

    if (scanResult.found && scanResult.item) {
      // Item exists - use it
      serializedItemWithCategory = scanResult.item
    } else {
      // Item doesn't exist - register it
      if (!input.categoryId) {
        throw new BadRequestError('categoryId is required for unregistered items')
      }

      serializedItemWithCategory = await serializedInventoryService.register({
        venueId,
        categoryId: input.categoryId,
        serialNumber: input.serialNumber,
        createdBy: staffId,
      })
    }

    // Build OrderItem data with proper snapshot fields
    const orderItemData = serializedInventoryService.buildOrderItemData(serializedItemWithCategory!, input.price)

    // Create OrderItem
    const orderItem = await tx.orderItem.create({
      data: {
        orderId,
        ...orderItemData, // Includes: productName, productSku, unitPrice, quantity, total, taxAmount, productId
        notes: input.notes,
      },
    })

    // Mark serialized item as sold (must use tx to reference the OrderItem created in this transaction)
    await serializedInventoryService.markAsSold(venueId, input.serialNumber, orderItem.id, tx)

    // Calculate new totals
    const newSubtotal = Number(order.subtotal) + input.price
    const newTotal = newSubtotal - Number(order.discountAmount)

    // Update order totals and increment version
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: newSubtotal,
        total: newTotal,
        remainingBalance: newTotal,
        version: { increment: 1 },
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, price: true } },
            modifiers: { include: { modifier: true } },
          },
        },
        payments: { include: { allocations: true } },
        table: { select: { id: true, number: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    return updatedOrder
  })

  logger.info(`✅ [ORDER SERVICE] Added serialized item ${input.serialNumber} to order ${order.orderNumber}. New total: $${result.total}`)

  // Emit Socket.IO event for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: result.id,
      orderNumber: result.orderNumber,
      tableId: result.tableId,
      subtotal: Number(result.subtotal),
      total: Number(result.total),
      version: result.version,
    })
  }

  const tableName = result.table ? `Mesa ${result.table.number}` : null
  return { ...flattenOrderModifiers(result), tableName }
}

interface SellSerializedItemInput {
  serialNumber: string
  categoryId?: string // Required if item not registered
  price: number // Cashier-entered price
  paymentMethodId?: string // Optional: if paying immediately
  notes?: string | null
  terminalId?: string | null // Terminal that created this order (for sales attribution)
  isPortabilidad?: boolean // Portabilidad sale (number porting) — stored as order tag
}

/**
 * Quick sell a single serialized item (creates new order + item in one shot).
 * For fast checkout of serialized items without an existing order.
 *
 * @param venueId Venue ID
 * @param input Serialized item and payment details
 * @param staffId Staff ID performing the sale
 */
export async function sellSerializedItem(
  venueId: string,
  input: SellSerializedItemInput,
  staffId: string,
): Promise<Order & { tableName: string | null }> {
  logger.info(`💵 [ORDER SERVICE] Quick sell serialized item ${input.serialNumber}`)

  // Verify module is enabled for this venue
  const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!isEnabled) {
    throw new BadRequestError('Serialized inventory module is not enabled for this venue')
  }

  // Scan to check item status
  const scanResult = await serializedInventoryService.scan(venueId, input.serialNumber)

  if (scanResult.status === 'already_sold') {
    throw new BadRequestError(`Item ${input.serialNumber} ya fue vendido`)
  }

  if (scanResult.status === 'module_disabled') {
    throw new BadRequestError('Módulo de inventario serializado no habilitado')
  }

  // Generate order number
  const orderCount = await prisma.order.count({ where: { venueId } })
  const orderNumber = `SN${String(orderCount + 1).padStart(5, '0')}`

  // Use transaction for atomicity
  const result = await prisma.$transaction(async tx => {
    let serializedItemWithCategory: Awaited<ReturnType<typeof serializedInventoryService.getItemBySerialNumber>>

    if (scanResult.found && scanResult.item) {
      serializedItemWithCategory = scanResult.item
    } else {
      if (!input.categoryId) {
        throw new BadRequestError('categoryId is required for unregistered items')
      }

      serializedItemWithCategory = await serializedInventoryService.register({
        venueId,
        categoryId: input.categoryId,
        serialNumber: input.serialNumber,
        createdBy: staffId,
      })
    }

    // Build OrderItem data with proper snapshot fields
    const orderItemData = serializedInventoryService.buildOrderItemData(serializedItemWithCategory!, input.price)

    // Build tags from sale context
    const tags: string[] = []
    if (input.isPortabilidad) tags.push('portabilidad')

    // Create order (PENDING until payment)
    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber,
        status: 'PENDING', // Will be COMPLETED when payment succeeds
        paymentStatus: 'PENDING',
        subtotal: input.price,
        taxAmount: 0, // No tax by default for serialized items
        total: input.price,
        remainingBalance: input.price,
        createdById: staffId,
        servedById: staffId,
        type: 'DINE_IN', // Default, could be parameterized
        // ⭐ Terminal that created this order (for sales attribution by device)
        terminalId: input.terminalId || null,
        // Tags for flexible categorization (e.g., portabilidad)
        tags,
        items: {
          create: {
            ...orderItemData, // Includes: productName, productSku, unitPrice, quantity, total, taxAmount, productId
            notes: input.notes,
          },
        },
      },
      include: {
        items: true,
      },
    })

    // ⚠️ DO NOT mark as SOLD here - only mark as SOLD when payment completes
    // Item will be marked as SOLD in processPayment() when payment succeeds
    // This prevents marking items as sold when payment is cancelled/fails
    // Note: order.items[0].id available for future use when marking as sold

    // Fetch full order with all includes
    const fullOrder = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, price: true } },
            modifiers: { include: { modifier: true } },
          },
        },
        payments: { include: { allocations: true } },
        table: { select: { id: true, number: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    return fullOrder
  })

  logger.info(`✅ [ORDER SERVICE] Created order ${orderNumber} for serialized item ${input.serialNumber}. Total: $${input.price}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: result.id,
      orderNumber: result.orderNumber,
      subtotal: Number(result.subtotal),
      total: Number(result.total),
      version: result.version,
    })
  }

  const tableName = result.table ? `Mesa ${result.table.number}` : null
  return { ...flattenOrderModifiers(result), tableName }
}
