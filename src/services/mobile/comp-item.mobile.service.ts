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

import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { impuestoQueSeCobraAparte } from '../shared/orderBalance'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { importesDeLasFilas } from '../shared/repartoDescuento'
import {
  RENGLON_PARA_REPARTO_SELECT,
  conservarDescuentoHistorico,
  recortarDescuentosDeRenglones,
  sincronizarRepartos,
} from '../shared/repartoDescuentoTx'

/** Square's comp reasons (`39_cortesia.png`). Kept as free text + validated here. */
export const COMP_REASONS = [
  'Error de entrada',
  'El cliente cambió de parecer',
  'Reclamo del cliente',
  'Amigos y familia',
  'Descuento de empleado',
  'Especial del administrador',
] as const

export async function compOrderItem(params: { venueId: string; orderId: string; itemId: string; reason: string; staffId?: string }) {
  const { venueId, orderId, itemId, reason, staffId } = params

  if (!reason?.trim()) {
    throw new BadRequestError('reason es requerido para dar de cortesía')
  }

  const { item, totals, recorte } = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Orden no encontrada')
    const order = await tx.order.findUnique({
      where: { id: orderId, venueId },
      select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true, originSystem: true },
    })
    if (!order) throw new NotFoundError('Orden no encontrada')
    // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
    // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
    rechazarSiEsImportada(order)

    // Never mutate the money of an order that was already paid (or partially).
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
      throw new BadRequestError('No se puede dar cortesía en una orden ya pagada')
    }

    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId },
      select: { id: true, productName: true, isCortesia: true, total: true, quantity: true, unitPrice: true },
    })
    if (!item) throw new NotFoundError('Artículo no encontrado en la orden')
    if (item.isCortesia) throw new BadRequestError('El artículo ya está dado de cortesía')

    // R7-1 (ruling de B2): el recálculo es Σ filas; el resto de cabecera sin fila se congela en la suya ANTES del recorte.
    await conservarDescuentoHistorico(tx, orderId, order.discountAmount)
    // P5 (founder, 1-oct): el descuento propio del renglón que se regala (y lo dirigido a él) se retira con sus beneficios
    // ANTES de regalarlo; si no, su fila espejo seguía restando sobre los demás renglones.
    const recorte = await recortarDescuentosDeRenglones(tx, orderId, { renglones: [itemId], venueId, staffId })

    // The line stays on the check (kitchen + audit) but costs 0.
    await tx.orderItem.update({
      where: { id: itemId },
      data: {
        isCortesia: true,
        cortesiaReason: reason.trim(),
        total: 0,
        discountAmount: item.total, // what the comp gave away
        appliedDiscountId: null, // su espejo lo acaba de retirar el recorte
      },
    })

    const totals = await recalculateOrderTotals(
      orderId,
      Math.max(0, Number(order.discountAmount || 0) - recorte.recortadoPesos),
      Number(order.paidAmount || 0),
      tx,
    )

    return { item, totals, recorte }
  }, ORDER_LOCK_WAIT_BUDGET)

  void logAction({
    action: 'ORDER_ITEM_COMPED',
    entity: 'OrderItem',
    entityId: itemId,
    staffId,
    venueId,
    data: {
      orderId,
      reason: reason.trim(),
      productName: item.productName,
      amount: Number(item.total),
      ...(recorte.retiradas.length > 0 ? { descuentosRetirados: recorte.retiradas } : {}),
    },
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

  const { order, items, compedAmount, totals, recorte } = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Orden no encontrada')
    const order = await tx.order.findUnique({
      where: { id: orderId, venueId },
      select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true, orderNumber: true, originSystem: true },
    })
    if (!order) throw new NotFoundError('Orden no encontrada')
    // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
    // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
    rechazarSiEsImportada(order)
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
      throw new BadRequestError('No se puede dar cortesía en una orden ya pagada')
    }

    const items = await tx.orderItem.findMany({
      where: { orderId, isCortesia: false },
      select: { id: true, total: true },
    })
    if (items.length === 0) throw new BadRequestError('La cuenta no tiene artículos por dar de cortesía')

    // R7-1 y P5, como en `compOrderItem`: conservar el resto de cabecera y retirar lo dirigido a los renglones ANTES de regalarlos.
    await conservarDescuentoHistorico(tx, orderId, order.discountAmount)
    const recorte = await recortarDescuentosDeRenglones(tx, orderId, { renglones: items.map(i => i.id), venueId, staffId })

    const compedAmount = items.reduce((sum, i) => sum + Number(i.total), 0)
    for (const item of items) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { isCortesia: true, cortesiaReason: reason.trim(), total: 0, discountAmount: item.total, appliedDiscountId: null },
      })
    }

    const totals = await recalculateOrderTotals(
      orderId,
      Math.max(0, Number(order.discountAmount || 0) - recorte.recortadoPesos),
      Number(order.paidAmount || 0),
      tx,
    )

    return { order, items, compedAmount, totals, recorte }
  }, ORDER_LOCK_WAIT_BUDGET)

  void logAction({
    action: 'ORDER_COMPED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: {
      reason: reason.trim(),
      items: items.length,
      amount: compedAmount,
      orderNumber: order.orderNumber,
      ...(recorte.retiradas.length > 0 ? { descuentosRetirados: recorte.retiradas } : {}),
    },
  })

  return { itemsComped: items.length, compedAmount, reason: reason.trim(), ...totals }
}

/**
 * Recomputes subtotal/total from the CURRENT item rows (comped lines contribute
 * 0) and re-derives percentage discounts, mirroring addItemsToOrder's recalc so
 * both paths agree on the order's money.
 *
 * `db` is the caller's transaction and is REQUIRED: the caller already holds this
 * Order's canonical lock in it (or created the Order privately in it) and passes
 * `paidAmount`/`fallbackDiscount` from that locked read. A standalone recalculation
 * could never make the caller's earlier child writes atomic with these totals.
 * Zero fallback deliberately drops an inline discount; comp and promotions pass the
 * inherited one.
 */
export async function recalculateOrderTotals(orderId: string, fallbackDiscount: number, paidAmount: number, db: Prisma.TransactionClient) {
  const items = await db.orderItem.findMany({ where: { orderId }, select: RENGLON_PARA_REPARTO_SELECT })
  const newSubtotal = items.reduce((sum, i) => sum + Number(i.total), 0)
  const orderDiscounts = await db.orderDiscount.findMany({ where: { orderId } })
  // 🔴 MONEY (auditoría): las filas con appliedToItemIds son POR ARTÍCULO y se respetan; el valor es el DENORMALIZADO de la
  // fila, y las líneas de promoción quedan FUERA de la base de un % de cuenta (el combo ya trae su precio: $20 → $39.80).
  // B2: UNA regla para los recalculadores (`importesDeLasFilas`): % de cuenta sobre los renglones sin promoción, como
  // hoy; % dirigido con ámbito dentro de su ámbito (P1, Codex r2 N1). Repartos sincronizados en esta misma tx.
  const { montosRederivados, descuento } = importesDeLasFilas(items, orderDiscounts)
  let newDiscountAmount = descuento
  await sincronizarRepartos(db, orderId, { renglones: items, filas: orderDiscounts, montosRederivados })
  if (orderDiscounts.length === 0 && fallbackDiscount > 0) {
    newDiscountAmount = fallbackDiscount
  }

  // Cobros por servicio: se calculan sobre la base YA descontada (lo que Square
  // hace) y SUMAN al total — es ingreso gravable del negocio, no propina.
  const base = Math.max(0, newSubtotal - newDiscountAmount)
  const serviceCharges = await db.orderServiceCharge.findMany({ where: { orderId } })
  let newServiceChargeAmount = 0
  for (const sc of serviceCharges) {
    const amount = sc.type === 'PERCENTAGE' ? Math.round(((base * Number(sc.value)) / 100) * 100) / 100 : Number(sc.amount)
    // Un % se re-calcula cuando cambia la cuenta; un monto fijo se respeta.
    if (sc.type === 'PERCENTAGE' && amount !== Number(sc.amount)) {
      await db.orderServiceCharge.update({ where: { id: sc.id }, data: { amount } })
    }
    newServiceChargeAmount += amount
  }
  newServiceChargeAmount = Math.round(newServiceChargeAmount * 100) / 100

  // A check can never owe a negative amount: a FIXED_AMOUNT discount bigger
  // than the subtotal (catalog discount or loyalty redemption on a shrinking
  // check) would otherwise store a negative total and corrupt the corte.
  //
  // P12: más el IVA que va aparte, con la regla compartida. Se lee DESPUÉS de sincronizar: la sincronización pudo mover el
  // impuesto en esta misma transacción (y quitar un descuento desde el móvil lo devuelve antes de llamar aquí).
  const orden = await db.order.findUnique({ where: { id: orderId }, select: { contratoDePrecio: true, taxAmount: true, status: true } })
  const impuestoAparte = impuestoQueSeCobraAparte({
    contratoDePrecio: orden?.contratoDePrecio,
    taxAmount: orden?.taxAmount,
    status: orden?.status,
  }).toNumber()
  const newTotal = Math.round((base + impuestoAparte + newServiceChargeAmount) * 100) / 100
  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      serviceChargeAmount: newServiceChargeAmount,
      total: newTotal,
      remainingBalance: Math.max(0, newTotal - paidAmount),
      version: { increment: 1 },
    },
    select: { subtotal: true, discountAmount: true, serviceChargeAmount: true, total: true, version: true },
  })

  return {
    subtotal: Number(updated.subtotal),
    discountAmount: Number(updated.discountAmount),
    serviceChargeAmount: Number(updated.serviceChargeAmount),
    total: Number(updated.total),
    version: updated.version,
  }
}
