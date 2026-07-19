/**
 * Cobros por servicio ("Cobros por servicio" en el panel del cheque).
 *
 * 🔴 MONEY — por qué esto NO es un descuento ni una propina:
 * - Un DESCUENTO resta del total.
 * - La PROPINA suma pero pasa al MESERO y no causa IVA.
 * - Un COBRO POR SERVICIO suma y es INGRESO GRAVABLE DEL NEGOCIO: entra al
 *   subtotal facturable, al corte y al CFDI.
 * Meterlo como "importe personalizado" cuadraría el total pero lo contaría como
 * venta de producto; meterlo como propina lo sacaría del IVA. De ahí el modelo
 * propio (ServiceCharge / OrderServiceCharge) y el campo Order.serviceChargeAmount.
 *
 * El cálculo vive en recalculateOrderTotals (misma maquinaria que descuentos y
 * cortesía): base = subtotal − descuentos, y los % se re-calculan solos cuando
 * la cuenta cambia.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

/** Resuelve StaffVenue.id: appliedById NO acepta un Staff.id (P2003). */
async function resolveStaffVenueId(venueId: string, staffId?: string): Promise<string | undefined> {
  if (!staffId) return undefined
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
    select: { id: true },
  })
  return sv?.id
}

/** Catálogo de cobros por servicio del venue (los activos). */
export async function listServiceCharges(venueId: string) {
  const rows = await prisma.serviceCharge.findMany({
    where: { venueId, active: true },
    orderBy: [{ autoApplyMinCovers: 'asc' }, { name: 'asc' }],
  })
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    value: Number(r.value),
    taxable: r.taxable,
    autoApplyMinCovers: r.autoApplyMinCovers,
  }))
}

/** Los cobros YA aplicados a una cuenta. */
export async function listOrderServiceCharges(venueId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { id: true } })
  if (!order) throw new NotFoundError('Orden no encontrada')
  const rows = await prisma.orderServiceCharge.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  return rows.map(r => ({
    id: r.id,
    serviceChargeId: r.serviceChargeId,
    name: r.name,
    type: r.type,
    value: Number(r.value),
    amount: Number(r.amount),
    isAutomatic: r.isAutomatic,
  }))
}

/** Guard compartido: solo se toca una cuenta abierta. */
async function requireOpenOrder(venueId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, subtotal: true, discountAmount: true, paymentStatus: true, paidAmount: true, covers: true },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }
  return order
}

/** Monto de un cargo sobre la base (subtotal − descuentos) de la cuenta. */
function computeAmount(type: 'PERCENTAGE' | 'FIXED_AMOUNT', value: number, base: number): number {
  const raw = type === 'PERCENTAGE' ? (base * value) / 100 : value
  return Math.round(raw * 100) / 100
}

/** Aplica un cobro del catálogo a la cuenta abierta. */
export async function applyServiceCharge(venueId: string, orderId: string, serviceChargeId: string, staffId?: string) {
  const order = await requireOpenOrder(venueId, orderId)

  const charge = await prisma.serviceCharge.findFirst({ where: { id: serviceChargeId, venueId, active: true } })
  if (!charge) throw new NotFoundError('Cobro por servicio no encontrado')

  const already = await prisma.orderServiceCharge.findFirst({ where: { orderId, serviceChargeId } })
  if (already) throw new BadRequestError('Ese cobro ya está aplicado a la cuenta')

  const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount))
  const amount = computeAmount(charge.type, Number(charge.value), base)

  await prisma.orderServiceCharge.create({
    data: {
      orderId,
      serviceChargeId: charge.id,
      name: charge.name,
      type: charge.type,
      value: charge.value,
      amount: new Prisma.Decimal(amount),
      taxable: charge.taxable,
      isAutomatic: false,
      appliedById: await resolveStaffVenueId(venueId, staffId),
    },
  })

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0))

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SERVICE_CHARGE_APPLIED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { serviceChargeId, name: charge.name, amount },
  })

  return totals
}

/** Quita un cobro aplicado de la cuenta. */
export async function removeServiceCharge(venueId: string, orderId: string, orderServiceChargeId: string, staffId?: string) {
  const order = await requireOpenOrder(venueId, orderId)

  const row = await prisma.orderServiceCharge.findFirst({ where: { id: orderServiceChargeId, orderId } })
  if (!row) throw new NotFoundError('Cobro no aplicado a esta orden')

  await prisma.orderServiceCharge.delete({ where: { id: row.id } })

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0))

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SERVICE_CHARGE_REMOVED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { orderServiceChargeId, name: row.name },
  })

  return totals
}

/**
 * Auto-aplica los cobros cuya regla de comensales ya se cumple ("Servicio 13%
 * para grupos de 8+"). Idempotente: nunca duplica uno ya aplicado, y quita el
 * automático si los comensales BAJARON por debajo del mínimo (corregir el
 * conteo no debe dejar cobrando de más).
 * Se llama al abrir la mesa y al cambiar el conteo de comensales.
 */
export async function syncAutomaticServiceCharges(venueId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, subtotal: true, discountAmount: true, paymentStatus: true, paidAmount: true, covers: true },
  })
  if (!order) return null
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') return null

  const covers = order.covers ?? 0
  const rules = await prisma.serviceCharge.findMany({
    where: { venueId, active: true, autoApplyMinCovers: { not: null } },
  })
  const applied = await prisma.orderServiceCharge.findMany({ where: { orderId } })
  const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount))

  let changed = false

  for (const rule of rules) {
    const min = rule.autoApplyMinCovers as number
    const existing = applied.find(a => a.serviceChargeId === rule.id)
    const qualifies = covers >= min

    if (qualifies && !existing) {
      await prisma.orderServiceCharge.create({
        data: {
          orderId,
          serviceChargeId: rule.id,
          name: rule.name,
          type: rule.type,
          value: rule.value,
          amount: new Prisma.Decimal(computeAmount(rule.type, Number(rule.value), base)),
          taxable: rule.taxable,
          isAutomatic: true,
        },
      })
      changed = true
    } else if (!qualifies && existing?.isAutomatic) {
      // Bajaron los comensales: el cargo automático deja de corresponder.
      await prisma.orderServiceCharge.delete({ where: { id: existing.id } })
      changed = true
    }
  }

  if (!changed) return null

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  return recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0))
}
