// services/dashboard/order.dashboard.service.ts

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { PaginatedOrdersResponse } from '../../schemas/dashboard/order.schema'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { Order, OrderStatus, PaymentType, Prisma } from '@prisma/client'
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
        _count: {
          select: { items: true }, // Cheap count for "N productos" cell in /orders list
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
 * Build the same `where` clause used by `getOrders` — extracted so the export endpoint
 * can apply the same filters without duplicating logic.
 */
function buildOrdersWhereClause(venueId: string, filters?: OrderFilters): any {
  const whereClause: any = {
    venueId,
    status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
  }
  if (!filters) return whereClause

  if (filters.statuses && filters.statuses.length > 0) whereClause.status = { in: filters.statuses }
  if (filters.types && filters.types.length > 0) whereClause.type = { in: filters.types }
  if (filters.tableIds && filters.tableIds.length > 0) whereClause.tableId = { in: filters.tableIds }
  if (filters.staffIds && filters.staffIds.length > 0) whereClause.servedById = { in: filters.staffIds }
  if (filters.startDate || filters.endDate) {
    whereClause.createdAt = {}
    if (filters.startDate) whereClause.createdAt.gte = new Date(filters.startDate)
    if (filters.endDate) whereClause.createdAt.lte = new Date(filters.endDate)
  }
  if (filters.search) {
    const searchTerm = filters.search.trim()
    const searchNumber = parseFloat(searchTerm)
    whereClause.OR = [
      { orderNumber: { contains: searchTerm, mode: 'insensitive' } },
      ...(isNaN(searchNumber) ? [] : [{ total: { gte: searchNumber, lt: searchNumber + 1 } }]),
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
  return whereClause
}

/**
 * Count rows matching the export filters — pre-flight before pulling into memory.
 */
export async function countOrdersForExport(venueId: string, filters?: OrderFilters): Promise<number> {
  return prisma.order.count({ where: buildOrdersWhereClause(venueId, filters) })
}

/**
 * Fetch all matching orders for export (caller caps the result with `limit`).
 */
export async function fetchOrdersForExport(venueId: string, filters: OrderFilters | undefined, limit: number) {
  return prisma.order.findMany({
    where: buildOrdersWhereClause(venueId, filters),
    include: {
      createdBy: { select: { firstName: true, lastName: true } },
      servedBy: { select: { firstName: true, lastName: true } },
      table: { select: { number: true } },
      _count: { select: { items: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
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
  // 🔴 La deducción por CAMBIO DE STATUS se retiró (audit Codex xhigh 2026-08-14).
  // `Order.status` es estado OPERATIVO, no evidencia de pago: deducir aquí
  // contradecía la regla del repo ("el stock se descuenta sólo cuando la orden
  // queda pagada", .claude/rules/payments.md) y lo hacía SIN posting — con
  // movimientos `postingLineId: null` que el UNIQUE del vale no puede ver. Una
  // orden marcada COMPLETED a mano y luego liquidada con `settleOrder` se
  // deducía DOS VECES. La deducción vive donde debe: en los caminos de cobro,
  // vía posting durable.

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
    select: { id: true, paymentStatus: true },
  })

  if (!existingOrder) {
    throw new NotFoundError(`Order with ID ${orderId} not found in this venue`)
  }

  // 🔴 Una orden con dinero adentro NO se cancela por aquí (auditoría 2026-08-12):
  // cancelarla la volvía invisible para reportes con el cobro registrado y el
  // stock ya deducido — sin reembolso ni reposición. El camino correcto es
  // reembolsar primero. Se revisan paymentStatus Y los Payments reales porque
  // hay estados inconsistentes históricos (PENDING con pagos COMPLETED).
  if (existingOrder.paymentStatus === 'PAID' || existingOrder.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('Esta orden tiene pagos registrados. Reembolsa primero; una orden pagada no se puede eliminar.')
  }
  const completedPayments = await prisma.payment.count({
    where: { orderId, venueId, status: 'COMPLETED', type: 'REGULAR' },
  })
  if (completedPayments > 0) {
    throw new BadRequestError('Esta orden tiene pagos registrados. Reembolsa primero; una orden pagada no se puede eliminar.')
  }

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

  // 🔴 Transición CONDICIONAL (auditoría 2026-08-12): el guard de arriba lee
  // fuera de la transacción, así que dos settles concurrentes lo pasaban los
  // dos y creaban DOS pagos CASH por el mismo saldo. Solo quien gana el CAS
  // (PENDING/PARTIAL → PAID) crea el Payment; el perdedor sale sin efecto.
  //
  // 🔴 Y el MONTO se relee DENTRO de la tx amarrado a `version` (auditoría
  // 2026-08-13): el snapshot de arriba podía quedar viejo — un pago parcial
  // concurrente (TPV) dejaba la orden PARTIAL, el CAS de estados seguía
  // pasando, y el Payment se creaba por el saldo VIEJO: $160 de pagos contra
  // una orden de $100, con paidAmount pisado. Con el CAS sobre `version`, un
  // cambio entre la relectura y la transición hace count=0 y no se cobra nada.
  const settledAmount = await prisma.$transaction(async tx => {
    const fresh = await tx.order.findFirst({
      where: { id: orderId, venueId },
      select: { total: true, remainingBalance: true, tipAmount: true, paymentStatus: true, version: true },
    })
    if (!fresh) return null
    const freshRemaining = Number(fresh.remainingBalance)
    if (freshRemaining <= 0 || fresh.paymentStatus === 'PAID') return null

    // 🔴 La FUENTE DE VERDAD del saldo son los Payments, no el denormalizado
    // de la orden (audit ronda 3): el escritor legacy del TPV
    // (updateOrderTotalsForStandalonePayment, payment.tpv.service.ts:810)
    // commitea el Payment PRIMERO y escribe los totales de la orden DESPUÉS,
    // a ciegas — un settle en esa ventana veía remainingBalance intacto y
    // cobraba el saldo completo encima del pago recién commiteado. El monto a
    // liquidar es el MÍNIMO entre el saldo denormalizado y (total − Σ pagos
    // COMPLETED): nunca puede exceder lo que los pagos reales dejan pendiente,
    // aunque el escritor legacy no participe de ningún candado.
    const paidAgg = await tx.payment.aggregate({
      where: { orderId, venueId, status: 'COMPLETED' },
      _sum: { amount: true, tipAmount: true },
    })
    const paidSum = Number(paidAgg._sum.amount ?? 0)
    // `Order.total` incluye propinas acumuladas (así lo escribe el TPV); se
    // comparan peras con peras restando la propina de ambos lados.
    const orderTotalSansTips = Number(fresh.total) - Number(fresh.tipAmount ?? 0)
    const remainingByPayments = Math.max(0, Number((orderTotalSansTips - paidSum).toFixed(2)))
    const toSettle = Math.min(freshRemaining, remainingByPayments)
    if (toSettle <= 0) return null

    // El CAS va amarrado a `version` Y a `remainingBalance`: cerca a los
    // escritores que sí incrementan version y a cualquier update ya visible.
    const transition = await tx.order.updateMany({
      where: {
        id: orderId,
        venueId,
        paymentStatus: { in: ['PENDING', 'PARTIAL'] },
        version: fresh.version,
        remainingBalance: fresh.remainingBalance as any,
      },
      data: {
        paymentStatus: 'PAID',
        paidAmount: fresh.total,
        remainingBalance: 0,
        version: { increment: 1 },
      },
    })
    if (transition.count === 0) {
      return null
    }

    // Create a payment record to track the settlement
    await tx.payment.create({
      data: {
        venueId,
        orderId,
        amount: toSettle,
        tipAmount: 0,
        method: 'CASH', // Default to cash for manual settlements
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: toSettle,
        source: 'OTHER',
        processorData: notes ? { settlementNote: notes, settledViaDashboard: true } : { settledViaDashboard: true },
      },
    })
    return toSettle
  })

  if (settledAmount === null) {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      settledAmount: 0,
      message: 'Order has no pending balance to settle',
    }
  }

  // REFERRAL HOOK: trigger referral qualification if this order had a pending referral
  try {
    const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
    await onOrderPaid({ orderId, venueId })
  } catch (err) {
    console.error('[referral hook] onOrderPaid failed for order', orderId, err)
  }

  logger.info(`Order settled: ${orderId}`, {
    venueId,
    orderId,
    orderNumber: order.orderNumber,
    settledAmount,
    notes,
  })

  logAction({
    venueId,
    action: 'ORDER_SETTLED',
    entity: 'Order',
    entityId: order.id,
    data: { settledAmount, orderNumber: order.orderNumber },
  })

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    settledAmount,
    message: `Successfully settled order ${order.orderNumber} for ${settledAmount}`,
  }
}
