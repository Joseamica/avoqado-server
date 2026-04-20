// services/dashboard/order.dashboard.service.ts

import { NotFoundError } from '../../errors/AppError'
import { PaginatedOrdersResponse } from '../../schemas/dashboard/order.schema'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { Order, OrderStatus, PaymentType, Prisma } from '@prisma/client'
import { deductInventoryForProduct } from './productInventoryIntegration.service'
import { OrderModifierForInventory } from './rawMaterial.service'
import { logAction } from './activity-log.service'

/**
 * Flatten order modifiers from nested structure to flat array
 * Converts: { modifier: { id, name, price } } → { id, name, price }
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
          })) || [],
      })) || [],
  }
}

export interface OrderFilters {
  statuses?: string[]
  types?: string[]
  tableIds?: string[]
  staffIds?: string[]
  search?: string
  startDate?: string
  endDate?: string
}

export async function getOrders(venueId: string, page: number, pageSize: number, filters?: OrderFilters): Promise<PaginatedOrdersResponse> {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  // Exclude PENDING, CANCELLED, DELETED orders - they shouldn't appear in order list
  const whereClause: any = {
    venueId,
    status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
  }

  if (filters) {
    // Status filter (overrides the default "not in [PENDING, CANCELLED, DELETED]" exclusion)
    if (filters.statuses && filters.statuses.length > 0) {
      whereClause.status = { in: filters.statuses }
    }

    if (filters.types && filters.types.length > 0) {
      whereClause.type = { in: filters.types }
    }

    if (filters.tableIds && filters.tableIds.length > 0) {
      whereClause.tableId = { in: filters.tableIds }
    }

    // staffIds maps to servedById (who attended the order)
    if (filters.staffIds && filters.staffIds.length > 0) {
      whereClause.servedById = { in: filters.staffIds }
    }

    if (filters.startDate || filters.endDate) {
      whereClause.createdAt = {}
      if (filters.startDate) whereClause.createdAt.gte = new Date(filters.startDate)
      if (filters.endDate) whereClause.createdAt.lte = new Date(filters.endDate)
    }

    if (filters.search) {
      const searchTerm = filters.search.trim()
      const searchNumber = parseFloat(searchTerm)
      whereClause.OR = [
        // Order number (string or numeric)
        { orderNumber: { contains: searchTerm, mode: 'insensitive' } },
        // Total amount match (coarse match: amount in [n, n+1))
        ...(isNaN(searchNumber) ? [] : [{ total: { gte: searchNumber, lt: searchNumber + 1 } }]),
        // Customer name on OrderCustomer relation
        {
          orderCustomers: {
            some: {
              customer: {
                OR: [
                  { firstName: { contains: searchTerm, mode: 'insensitive' } },
                  { lastName: { contains: searchTerm, mode: 'insensitive' } },
                  { phone: { contains: searchTerm, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ]
    }
  }

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where: whereClause,
      // Incluimos relaciones para obtener datos como el nombre del mesero y la mesa
      include: {
        createdBy: true, // Quien creó la orden (equivale al mesero)
        servedBy: true, // Quien atendió la orden
        table: true, // Para obtener el número de la mesa
        orderCustomers: {
          // Para identificar órdenes pay-later
          include: {
            customer: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({
      where: whereClause,
    }),
  ])

  return {
    data: orders,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}
/**
 * Hoists refund metadata from `processorData` to top-level fields and attaches
 * a `refunds[]` array to each original payment that has been (partially or fully)
 * refunded. Pure read-side transform — no DB side effects.
 *
 * Refund Payments are linked to their original via
 * `processorData.originalPaymentId` (no FK column). See
 * `src/services/dashboard/refund.dashboard.service.ts` for where this is set.
 *
 * Refund-of-refund is not supported by `issueRefund()` (it rejects refunds whose
 * original `type === REFUND`), so we mirror that invariant here: a refund whose
 * `originalPaymentId` points at another refund will be silently skipped from the
 * target's `refunds[]` rather than corrupting the chain.
 */
type MappablePayment = {
  id: string
  type: PaymentType | null
  processorData: any
  amount: Prisma.Decimal | number
  createdAt: Date
}

export function mapOrderPaymentsWithRefunds<T extends MappablePayment>(
  payments: T[],
): Array<
  T & {
    originalPaymentId: string | null
    refundReason: string | null
    refunds: Array<{
      id: string
      amount: Prisma.Decimal | number
      createdAt: Date
      refundReason: string | null
    }>
  }
> {
  // Pass 1: enrich each payment with hoisted refund fields
  const enriched = payments.map(p => {
    const data = (p.processorData ?? {}) as Record<string, any>
    const isRefund = p.type === PaymentType.REFUND
    return {
      ...p,
      originalPaymentId: isRefund ? (data.originalPaymentId ?? null) : null,
      refundReason: isRefund ? (data.refundReason ?? null) : null,
      refunds: [] as Array<{
        id: string
        amount: Prisma.Decimal | number
        createdAt: Date
        refundReason: string | null
      }>,
    }
  })

  // Pass 2: for every original payment, collect refunds that point to it
  const byId = new Map(enriched.map(p => [p.id, p]))
  for (const p of enriched) {
    if (!p.originalPaymentId) continue
    const target = byId.get(p.originalPaymentId)
    // Skip orphan and refund-of-refund — see JSDoc above.
    if (!target || target.type === PaymentType.REFUND) continue
    target.refunds.push({
      id: p.id,
      amount: p.amount,
      createdAt: p.createdAt,
      refundReason: p.refundReason,
    })
  }

  return enriched
}

/**
 * Obtener una orden por su ID con todos sus detalles.
 */
export async function getOrderById(venueId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      createdBy: true,
      servedBy: true,
      table: true,
      terminal: true,
      actions: {
        include: {
          performedBy: {
            select: { id: true, firstName: true, lastName: true, photoUrl: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
        // Incluimos los pagos asociados
        include: {
          processedBy: true, // Y quién procesó cada pago
          saleVerification: true, // 📸 PRE-payment verification photos
          receipts: {
            // Drawer only needs metadata, not the full dataSnapshot JSON
            select: {
              id: true,
              accessKey: true,
              status: true,
              recipientEmail: true,
              recipientPhone: true,
              sentAt: true,
              viewedAt: true,
              createdAt: true,
            },
          },
        },
      },
      items: {
        // Incluimos los productos de la orden
        include: {
          product: true,
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
      orderCustomers: {
        include: {
          customer: {
            include: {
              customerGroup: true,
            },
          },
        },
        orderBy: {
          isPrimary: 'desc', // Primary customer first
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError(`Order with ID ${orderId} not found in this venue`)
  }
  const flattened = flattenOrderModifiers(order)
  return {
    ...flattened,
    payments: mapOrderPaymentsWithRefunds(flattened.payments ?? []),
  }
}

/**
 * Actualizar una orden.
 * SUPERADMIN puede actualizar más campos que usuarios normales.
 */
export async function updateOrder(venueId: string, orderId: string, data: Partial<Order>) {
  // Extract allowed fields for SUPERADMIN editing
  const { status, customerId, customerName, tableId, servedById, tipAmount, total, subtotal, createdAt, orderNumber, type } = data as any

  // Get the current order to check previous status
  const currentOrder = await prisma.order.findFirst({
    where: {
      id: orderId,
      venueId,
    },
    select: { status: true, venueId: true },
  })

  if (!currentOrder) {
    throw new NotFoundError(`Order with ID ${orderId} not found in this venue`)
  }

  if (customerId) {
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        venueId,
      },
      select: { id: true },
    })

    if (!customer) {
      throw new NotFoundError(`Customer with ID ${customerId} not found in this venue`)
    }
  }

  if (tableId) {
    const table = await prisma.table.findFirst({
      where: {
        id: tableId,
        venueId,
      },
      select: { id: true },
    })

    if (!table) {
      throw new NotFoundError(`Table with ID ${tableId} not found in this venue`)
    }
  }

  if (servedById) {
    const staffVenue = await prisma.staffVenue.findFirst({
      where: {
        staffId: servedById,
        venueId,
      },
      select: { id: true },
    })

    if (!staffVenue) {
      throw new NotFoundError(`Staff with ID ${servedById} not found in this venue`)
    }
  }

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(status !== undefined && { status }),
      ...(customerId !== undefined && { customerId: customerId || null }),
      ...(customerName !== undefined && { customerName }),
      ...(tableId !== undefined && { tableId: tableId || null }),
      ...(servedById !== undefined && { servedById: servedById || null }),
      ...(tipAmount !== undefined && { tipAmount: Number(tipAmount) }),
      ...(total !== undefined && { total: Number(total) }),
      ...(subtotal !== undefined && { subtotal: Number(subtotal) }),
      ...(createdAt !== undefined && { createdAt: new Date(createdAt) }),
      ...(orderNumber !== undefined && { orderNumber }),
      ...(type !== undefined && { type }),
      ...(status === 'COMPLETED' && { completedAt: new Date() }),
    },
    include: {
      items: {
        include: {
          product: true,
          // ✅ FIX: Include modifiers so we can deduct their inventory
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      },
    },
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  const isNewlyCompleted = currentOrder.status !== 'COMPLETED' && status === 'COMPLETED'

  if (isNewlyCompleted) {
    try {
      logger.info('🎯 Starting inventory deduction for completed order (dashboard)', {
        orderId,
        venueId: updatedOrder.venueId,
        itemCount: updatedOrder.items.length,
        previousStatus: currentOrder.status,
        newStatus: status,
      })

      // Deduct stock for each product in the order
      for (const item of updatedOrder.items) {
        // Skip items where product was deleted (Toast/Square pattern)
        if (!item.productId) {
          logger.info('⏭️ Skipping stock deduction for deleted product', {
            orderId,
            productName: item.productName, // Use denormalized name
          })
          continue
        }

        try {
          // ✅ FIX: Map modifiers to inventory format (same as TPV)
          const orderModifiers: OrderModifierForInventory[] =
            item.modifiers
              ?.filter(m => m.modifier)
              .map(m => ({
                quantity: m.quantity,
                modifier: {
                  id: m.modifier!.id,
                  name: m.modifier!.name,
                  groupId: m.modifier!.groupId,
                  rawMaterialId: m.modifier!.rawMaterialId,
                  quantityPerUnit: m.modifier!.quantityPerUnit,
                  unit: m.modifier!.unit,
                  inventoryMode: m.modifier!.inventoryMode,
                },
              })) || []

          // ✅ FIX: Use deductInventoryForProduct to handle BOTH Quantity and Recipe + Modifiers
          await deductInventoryForProduct(
            updatedOrder.venueId,
            item.productId,
            item.quantity,
            orderId,
            updatedOrder.servedById || undefined,
            orderModifiers,
          )

          logger.info('✅ Stock deducted successfully for product (dashboard)', {
            orderId,
            productId: item.productId,
            productName: item.product?.name || item.productName,
            quantity: item.quantity,
            modifiersCount: orderModifiers.length,
          })
        } catch (deductionError: any) {
          const errorReason = deductionError.message.includes('does not have a recipe')
            ? 'NO_RECIPE'
            : deductionError.message.includes('Insufficient stock')
              ? 'INSUFFICIENT_STOCK'
              : 'UNKNOWN'

          // Log individual product deduction errors but continue with other products
          logger.warn('⚠️ Failed to deduct stock for product - continuing with order (dashboard)', {
            orderId,
            productId: item.productId,
            productName: item.product?.name || item.productName,
            quantity: item.quantity,
            error: deductionError.message,
            reason: errorReason,
          })

          if (errorReason !== 'NO_RECIPE') {
            logAction({
              staffId: updatedOrder.servedById || undefined,
              venueId: updatedOrder.venueId,
              action: 'INVENTORY_DEDUCTION_FAILED',
              entity: 'Order',
              entityId: orderId,
              data: {
                source: 'DASHBOARD',
                productId: item.productId,
                productName: item.product?.name || item.productName || 'Unknown',
                quantity: item.quantity,
                reason: errorReason,
                error: deductionError.message,
              },
            })
          }
        }
      }
      logger.info('🎯 Inventory deduction completed for order (dashboard)', {
        orderId,
        totalItems: updatedOrder.items.length,
      })
    } catch (inventoryError) {
      // Log overall inventory deduction errors but don't fail the order update
      logger.error('❌ Failed to complete inventory deduction for order (dashboard)', {
        orderId,
        error: inventoryError,
      })
      // Order update is still successful - inventory deduction failure is logged but not critical
    }
  }

  logAction({
    venueId: updatedOrder.venueId,
    action: 'ORDER_UPDATED',
    entity: 'Order',
    entityId: updatedOrder.id,
    data: { status: updatedOrder.status },
  })

  return updatedOrder
}

/**
 * Eliminar una orden.
 */
export async function deleteOrder(venueId: string, orderId: string) {
  const existingOrder = await prisma.order.findFirst({
    where: {
      id: orderId,
      venueId,
    },
    select: { id: true },
  })

  if (!existingOrder) {
    throw new NotFoundError(`Order with ID ${orderId} not found in this venue`)
  }

  // Podrías añadir lógica aquí para asegurar que solo se borren órdenes canceladas, etc.
  const cancelledOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
    },
  })

  logAction({
    venueId: cancelledOrder.venueId,
    action: 'ORDER_CANCELLED',
    entity: 'Order',
    entityId: cancelledOrder.id,
    data: { status: cancelledOrder.status },
  })

  return cancelledOrder
}

/**
 * Settle a single order's pending balance (mark pay-later order as paid)
 * Used for cash/deposit payments received outside the system
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param orderId - Order ID to settle
 * @param notes - Optional notes about the settlement (e.g., "Paid in cash", "Bank transfer received")
 * @returns Settlement result with amount settled
 */
export async function settleOrder(
  venueId: string,
  orderId: string,
  notes?: string,
): Promise<{
  orderId: string
  orderNumber: string
  settledAmount: number
  message: string
}> {
  // Verify order exists and belongs to this venue
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
    select: {
      id: true,
      orderNumber: true,
      total: true,
      remainingBalance: true,
      paymentStatus: true,
    },
  })

  if (!order) {
    throw new NotFoundError(`Order with ID ${orderId} not found`)
  }

  const remainingBalance = Number(order.remainingBalance)

  // Check if order has pending balance
  if (remainingBalance <= 0 || order.paymentStatus === 'PAID') {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      settledAmount: 0,
      message: 'Order has no pending balance to settle',
    }
  }

  // Update order and create payment record in a transaction
  await prisma.$transaction(async tx => {
    // Update order payment status
    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: 'PAID',
        paidAmount: order.total,
        remainingBalance: 0,
      },
    })

    // Create a payment record to track the settlement
    await tx.payment.create({
      data: {
        venueId,
        orderId,
        amount: remainingBalance,
        tipAmount: 0,
        method: 'CASH', // Default to cash for manual settlements
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: remainingBalance,
        source: 'OTHER',
        processorData: notes ? { settlementNote: notes, settledViaDashboard: true } : { settledViaDashboard: true },
      },
    })
  })

  logger.info(`Order settled: ${orderId}`, {
    venueId,
    orderId,
    orderNumber: order.orderNumber,
    settledAmount: remainingBalance,
    notes,
  })

  logAction({
    venueId,
    action: 'ORDER_SETTLED',
    entity: 'Order',
    entityId: order.id,
    data: { settledAmount: remainingBalance, orderNumber: order.orderNumber },
  })

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    settledAmount: remainingBalance,
    message: `Successfully settled order ${order.orderNumber} for ${remainingBalance}`,
  }
}
