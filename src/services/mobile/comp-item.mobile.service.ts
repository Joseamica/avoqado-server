/**
 * Mobile Comp-Item Service ("Dar de cortesía")
 *
 * Square's item-level comp: a line stays visible on the check (so the kitchen
 * ticket and the audit trail keep it) but stops costing money — its `total`
 * goes to 0 and the order's subtotal/total are recomputed.
 *
 * Reuses the OrderItem.isCortesia / cortesiaReason columns that already exist
 * for the TPV "Cobrar" flow, so the dashboard and receipts can already explain
 * the comp without JSON inference.
 *
 * MONEY SAFETY: an item can only be comped while the order is still unpaid —
 * comping after payment would silently change what was already charged.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'

/** Square's comp reasons (`39_cortesia.png`). Kept as free text + validated here. */
export const COMP_REASONS = [
  'Error de entrada',
  'El cliente cambió de parecer',
  'Reclamo del cliente',
  'Amigos y familia',
  'Descuento de empleado',
  'Especial del administrador',
] as const

export async function compOrderItem(params: {
  venueId: string
  orderId: string
  itemId: string
  reason: string
  staffId?: string
}) {
  const { venueId, orderId, itemId, reason, staffId } = params

  if (!reason?.trim()) {
    throw new BadRequestError('reason es requerido para dar de cortesía')
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')

  // Never mutate the money of an order that was already paid (or partially).
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede dar cortesía en una orden ya pagada')
  }

  const item = await prisma.orderItem.findFirst({
    where: { id: itemId, orderId },
    select: { id: true, productName: true, isCortesia: true, total: true, quantity: true, unitPrice: true },
  })
  if (!item) throw new NotFoundError('Artículo no encontrado en la orden')
  if (item.isCortesia) throw new BadRequestError('El artículo ya está dado de cortesía')

  // The line stays on the check (kitchen + audit) but costs 0.
  await prisma.orderItem.update({
    where: { id: itemId },
    data: {
      isCortesia: true,
      cortesiaReason: reason.trim(),
      total: 0,
      discountAmount: item.total, // what the comp gave away
    },
  })

  const totals = await recalculateOrderTotals(orderId, Number(order.discountAmount || 0), Number(order.paidAmount || 0))

  void logAction({
    action: 'ORDER_ITEM_COMPED',
    entity: 'OrderItem',
    entityId: itemId,
    staffId,
    venueId,
    data: { orderId, reason: reason.trim(), productName: item.productName, amount: Number(item.total) },
  })

  return { itemId, reason: reason.trim(), ...totals }
}

/**
 * Square's "Cortesía en la cuenta": comps EVERY not-yet-comped line of the
 * open order with one reason, then recomputes totals once. Same money guards
 * as the per-item comp.
 */
export async function compWholeOrder(params: { venueId: string; orderId: string; reason: string; staffId?: string }) {
  const { venueId, orderId, reason, staffId } = params

  if (!reason?.trim()) {
    throw new BadRequestError('reason es requerido para dar de cortesía')
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true, orderNumber: true },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede dar cortesía en una orden ya pagada')
  }

  const items = await prisma.orderItem.findMany({
    where: { orderId, isCortesia: false },
    select: { id: true, total: true },
  })
  if (items.length === 0) throw new BadRequestError('La cuenta no tiene artículos por dar de cortesía')

  const compedAmount = items.reduce((sum, i) => sum + Number(i.total), 0)
  await prisma.$transaction(
    items.map(i =>
      prisma.orderItem.update({
        where: { id: i.id },
        data: { isCortesia: true, cortesiaReason: reason.trim(), total: 0, discountAmount: i.total },
      }),
    ),
  )

  const totals = await recalculateOrderTotals(orderId, Number(order.discountAmount || 0), Number(order.paidAmount || 0))

  void logAction({
    action: 'ORDER_COMPED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { reason: reason.trim(), items: items.length, amount: compedAmount, orderNumber: order.orderNumber },
  })

  return { itemsComped: items.length, compedAmount, reason: reason.trim(), ...totals }
}

/**
 * Recomputes subtotal/total from the CURRENT item rows (comped lines contribute
 * 0) and re-derives percentage discounts, mirroring addItemsToOrder's recalc so
 * both paths agree on the order's money.
 */
export async function recalculateOrderTotals(orderId: string, fallbackDiscount: number, paidAmount: number) {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { total: true } })
  const newSubtotal = items.reduce((sum, i) => sum + Number(i.total), 0)

  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: { discount: true },
  })

  let newDiscountAmount = 0
  for (const od of orderDiscounts) {
    const type = od.discount?.type || od.type
    const value = Number(od.discount?.value || od.value || 0)
    if (type === 'PERCENTAGE' && value > 0) {
      const amount = Math.round(((newSubtotal * value) / 100) * 100) / 100
      await prisma.orderDiscount.update({ where: { id: od.id }, data: { amount } })
      newDiscountAmount += amount
    } else {
      newDiscountAmount += Number(od.amount)
    }
  }
  if (orderDiscounts.length === 0 && fallbackDiscount > 0) {
    newDiscountAmount = fallbackDiscount
  }

  const newTotal = newSubtotal - newDiscountAmount
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: Math.max(0, newTotal - paidAmount),
      version: { increment: 1 },
    },
    select: { subtotal: true, discountAmount: true, total: true, version: true },
  })

  return {
    subtotal: Number(updated.subtotal),
    discountAmount: Number(updated.discountAmount),
    total: Number(updated.total),
    version: updated.version,
  }
}
