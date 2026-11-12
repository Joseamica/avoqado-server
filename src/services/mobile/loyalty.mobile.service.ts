import { bloquearCuentaParaEditar } from '../shared/cuentaCancelada'
/**
 * Loyalty for the mobile POS ("Recompensas" in the check panel).
 *
 * The loyalty ENGINE already lives in `dashboard/loyalty.dashboard.service.ts`
 * (config, earn, balance, expiry) and is reused here — this module only adds
 * what the POS needs and what the dashboard path never did:
 *
 * 🔴 MONEY: redeeming points MUST move money on the check in the SAME
 * transaction that burns the points. The dashboard's `redeemPoints` only
 * decrements the balance and returns an amount for someone else to apply, so a
 * caller that forgets leaves the customer with fewer points and no discount.
 * Here the REDEEM transaction and its OrderDiscount are created together and
 * linked (OrderDiscount.loyaltyTransactionId), so the reverse is symmetric:
 * removing that discount always refunds the points.
 */

import { LoyaltyTransactionType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { getOrCreateLoyaltyConfig } from '../dashboard/loyalty.dashboard.service'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import { assertCardOrderMoneyFrozenInTx } from '../online-ordering/card/guards'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { rechazarSiEsCuentaDeTarjetas } from '../giftCards/cuentaDeTarjetas'
import { comoJson, nuevoRepartoDeCuenta } from '../shared/repartoDescuento'
import { conservarDescuentoHistorico } from '../shared/repartoDescuentoTx'

/** Rounds to cents the way every other money path here does. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * La regla del canje de puntos (la usa `redeemPointsToOrderInTransaction`, y la cotización de la tienda para decir cuántos se
 * usarían de verdad): el valor de `puntos` topado a lo que queda por descontar (`base` = subtotal − descuentos); si se topó, sólo se
 * queman los que se usan (⌈monto / valor por punto⌉). `monto` 0 = el canje lo rechaza.
 */
export function puntosQueSeCanjean(puntos: number, valorPorPunto: number, base: number): { puntos: number; monto: number } {
  const rawValue = money(puntos * valorPorPunto)
  // 🔴 Tope contra la BASE (subtotal − descuentos), NO contra total: el total incluye cobros por servicio que el descuento no puede
  // compensar — topar contra total quemaría puntos sin bajar la cuenta (auditoría 2026-07-18).
  const monto = money(Math.min(rawValue, Math.max(0, base)))
  // If the value was capped, only burn the points actually used.
  return { puntos: monto < rawValue && valorPorPunto > 0 ? Math.ceil(monto / valorPorPunto) : puntos, monto }
}

/**
 * 🔴 `LoyaltyTransaction.createdById` and `OrderDiscount.appliedById` FK to
 * StaffVenue.id, but the mobile auth context carries a Staff.id. Writing the
 * Staff.id straight through raises P2003 and rolls the WHOLE redemption back —
 * points and discount silently never persist. Resolve the row first; if the
 * caller has no assignment to this venue we store null rather than fail: the
 * audit attribution is nice to have, the money movement is not optional.
 */
async function resolveStaffVenueId(
  db: Pick<Prisma.TransactionClient, 'staffVenue'>,
  venueId: string,
  staffId?: string,
): Promise<string | undefined> {
  if (!staffId) return undefined
  const sv = await db.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
    select: { id: true },
  })
  return sv?.id
}

/**
 * hz:ce654971:D18 (Codex r1): los puntos MÁS que se pueden ofrecer sin que el canje los tope: el mayor `p ≤ saldo` cuyo valor, redondeado
 * a centavos como lo redondea el canje (`money`), no pasa de `valor`. Un `floor(valor / tasa)` se queda corto con tasas como 0.0149
 * (101 × 0.0149 = 1.5049 → $1.50 sí cabe en $1.50) y, en flotante, con 0.3 / 0.1 = 2.9999999999999996.
 */
export function puntosQueCaben(valor: number, valorPorPunto: number, saldo: number): number {
  if (!(valorPorPunto > 0) || !(valor > 0) || saldo <= 0) return 0
  let p = Math.min(saldo, Math.max(0, Math.ceil((valor + 0.005) / valorPorPunto) - 1))
  while (p > 0 && money(p * valorPorPunto) > valor) p--
  while (p < saldo && money((p + 1) * valorPorPunto) <= valor) p++
  return p
}

/**
 * Lo que el canje haría con `puntos` sobre la cuenta que describe `vista` (la respuesta de `getCustomerLoyalty`), sin escribir: la
 * vista previa del MCP. Las mismas negativas que el canje (mínimo, saldo) y la misma regla (`puntosQueSeCanjean`) contra el tope de
 * la vista, que para `puntos ≤ saldo` es la base del canje.
 */
export function previaDelCanje(
  puntos: number,
  vista: { balance: number; redemptionRate: number; minPointsRedeem: number; maxRedeemableValue: number },
): { ok: true; puntos: number; monto: number } | { ok: false; error: string } {
  if (puntos < vista.minPointsRedeem) return { ok: false, error: `Se requieren al menos ${vista.minPointsRedeem} puntos para canjear` }
  if (puntos > vista.balance) return { ok: false, error: `Puntos insuficientes: el cliente tiene ${vista.balance}` }
  const r = puntosQueSeCanjean(puntos, vista.redemptionRate, vista.maxRedeemableValue)
  if (r.monto <= 0) return { ok: false, error: 'El canje no genera descuento sobre esta cuenta' }
  return { ok: true, ...r }
}

/**
 * Balance + program rules for the customer attached to a check, plus how much
 * the POS may redeem RIGHT NOW against this order.
 *
 * 🔴 hz:ce654971:D18: el tope usa la MISMA regla (`puntosQueSeCanjean`) y la MISMA base que el canje
 * (`redeemPointsToOrderInTransaction`): subtotal − descuentos, NUNCA `order.total` (que trae cargos por servicio y el IVA que va
 * aparte). Con el total, la caja ofrecía puntos que el canje no iba a usar.
 */
export async function getCustomerLoyalty(venueId: string, customerId: string, orderId?: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, firstName: true, lastName: true, loyaltyPoints: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const config = await getOrCreateLoyaltyConfig(venueId)
  const redemptionRate = Number(config.redemptionRate)
  const balance = customer.loyaltyPoints

  // Lo que el canje puede descontar en esta cuenta: la misma base que lee `redeemPointsToOrderInTransaction`.
  let redeemableBase: number | null = null
  if (orderId) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, venueId },
      select: { subtotal: true, discountAmount: true },
    })
    redeemableBase = order ? Math.max(0, Number(order.subtotal) - Number(order.discountAmount || 0)) : null
  }

  const balanceValue = money(balance * redemptionRate)
  const maxRedeemableValue = redeemableBase === null ? balanceValue : puntosQueSeCanjean(balance, redemptionRate, redeemableBase).monto
  // Points that produce that value — never more than the customer owns, and never more than the canje would use: with these points
  // the canje is not capped, so it discounts `money(points × rate)` and burns exactly them.
  const maxRedeemablePoints = puntosQueCaben(maxRedeemableValue, redemptionRate, balance)

  return {
    customerId: customer.id,
    customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || null,
    active: config.active,
    balance,
    pointsPerDollar: Number(config.pointsPerDollar),
    redemptionRate,
    minPointsRedeem: config.minPointsRedeem,
    balanceValue,
    maxRedeemablePoints,
    maxRedeemableValue,
    canRedeem: config.active && balance >= config.minPointsRedeem && maxRedeemablePoints >= config.minPointsRedeem,
  }
}

/**
 * Redeem points onto an OPEN check: burns the points and applies the matching
 * discount atomically, then recalculates the order the same way cortesía and
 * catalog discounts do.
 *
 * 🔴 Order lock FIRST (before the Customer burn), cap/base from the locked read, and
 * burn + discount + totals in ONE transaction: a failure after the burn gives the
 * points back with the rollback, and a concurrent writer can never interleave
 * between the discount and the totals.
 */
export async function redeemPointsToOrderInTransaction(
  tx: TxConReintento,
  venueId: string,
  orderId: string,
  customerId: string,
  points: number,
  staffId?: string,
  config?: Awaited<ReturnType<typeof getOrCreateLoyaltyConfig>>,
) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new BadRequestError('points debe ser un entero positivo')
  }
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  if (!(await bloquearCuentaParaEditar(tx, { venueId, orderId }))) throw new NotFoundError('Orden no encontrada')
  // Pedidos en línea fase 2: un pedido de tarjeta sin cobrar tiene un total fijo (el de la tarjeta apartada).
  await assertCardOrderMoneyFrozenInTx(tx, { venueId, orderId })
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      total: true,
      subtotal: true,
      discountAmount: true,
      paymentStatus: true,
      paidAmount: true,
      originSystem: true,
      status: true,
    },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  // 🔴 LEALTAD (hz:a8104ac8:D1, Codex r1 #2): una venta anulada ya devolvió sus puntos y es final; no recibe canjes nuevos.
  if (order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw new BadRequestError('Esta venta está cancelada: no se pueden canjear puntos.')
  }
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'canje de puntos')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }

  const effectiveConfig = config ?? (await getOrCreateLoyaltyConfig(venueId, tx))
  if (!effectiveConfig.active) throw new BadRequestError('El programa de lealtad no está activo en esta sucursal')
  if (points < effectiveConfig.minPointsRedeem) {
    throw new BadRequestError(`Se requieren al menos ${effectiveConfig.minPointsRedeem} puntos para canjear`)
  }

  const customer = await tx.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, loyaltyPoints: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')
  if (customer.loyaltyPoints < points) {
    throw new BadRequestError(`Puntos insuficientes: el cliente tiene ${customer.loyaltyPoints}`)
  }

  const redemptionRate = Number(effectiveConfig.redemptionRate)
  const redeemableBase = Math.max(0, Number(order.subtotal) - Number(order.discountAmount || 0))
  const { monto: discountAmount, puntos: pointsToBurn } = puntosQueSeCanjean(points, redemptionRate, redeemableBase)
  if (discountAmount <= 0) {
    throw new BadRequestError('El canje no genera descuento sobre esta cuenta')
  }

  const staffVenueId = await resolveStaffVenueId(tx, venueId, staffId)

  const transaction = await tx.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.REDEEM,
      points: -pointsToBurn,
      orderId,
      reason: `Canje de ${pointsToBurn} puntos por $${discountAmount.toFixed(2)} de descuento`,
      createdById: staffVenueId,
    },
  })

  // 🔴 Carrera de doble canje: el saldo leído arriba no reserva nada, así que el
  // decremento debe ser CONDICIONAL — dos canjes concurrentes (sobre órdenes
  // distintas) no pueden quemar los mismos puntos (auditoría 2026-07-18).
  const burned = await tx.customer.updateMany({
    where: { id: customerId, loyaltyPoints: { gte: pointsToBurn } },
    data: { loyaltyPoints: { decrement: pointsToBurn } },
  })
  if (burned.count === 0) {
    throw new BadRequestError('Puntos insuficientes (otro canje se procesó al mismo tiempo)')
  }

  const balance = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true } })
  const newBalance = balance.loyaltyPoints

  // Codex r1 P1: lo que la cabecera trae fuera de toda fila (orden anterior a B2…) queda en su fila antes de crear ésta.
  await conservarDescuentoHistorico(tx, orderId, order.discountAmount)
  const row = await tx.orderDiscount.create({
    data: {
      orderId,
      type: 'FIXED_AMOUNT',
      name: `Recompensas — ${pointsToBurn} puntos`,
      value: new Prisma.Decimal(discountAmount),
      amount: new Prisma.Decimal(discountAmount),
      isManual: true,
      appliedById: staffVenueId,
      loyaltyTransactionId: transaction.id,
      // B2: fijo topado a subtotal − descuentos (con promociones) ⇒ fila de CUENTA; el recálculo de abajo la reparte.
      reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: true })),
    },
  })

  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0), tx)
  return { pointsToBurn, discountAmount, newBalance, transaction, row, totals }
}

export async function redeemPointsToOrder(venueId: string, orderId: string, customerId: string, points: number, staffId?: string) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new BadRequestError('points debe ser un entero positivo')
  }

  // Venue configuration is not Order data: read before the lock; its checks keep their original order below.
  const config = await getOrCreateLoyaltyConfig(venueId)
  const { pointsToBurn, discountAmount, newBalance, totals } = await withDeadlockRetry(
    tx => redeemPointsToOrderInTransaction(tx, venueId, orderId, customerId, points, staffId, config),
    { etiqueta: 'redeemPointsToOrder', ...ORDER_LOCK_WAIT_BUDGET },
  )

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'LOYALTY_POINTS_REDEEMED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { customerId, points: pointsToBurn, discountAmount },
  })

  return {
    pointsRedeemed: pointsToBurn,
    discountAmount,
    newBalance,
    order: totals,
  }
}

/**
 * Refunds the points behind an OrderDiscount that came from a redemption.
 * Runs INSIDE the caller's transaction so the discount row and the points move
 * together. No-op for ordinary discounts.
 */
export async function refundLoyaltyForOrderDiscount(
  tx: TxConReintento,
  venueId: string,
  row: { id: string; loyaltyTransactionId: string | null },
  staffId?: string,
): Promise<{ pointsRefunded: number; customerId: string; transactionId: string } | null> {
  if (!row.loyaltyTransactionId) return null

  // Same FK caveat as the redeem path (see resolveStaffVenueId).
  const sv = staffId
    ? await tx.staffVenue.findUnique({
        where: { staffId_venueId: { staffId, venueId } },
        select: { id: true },
      })
    : null

  const original = await tx.loyaltyTransaction.findUnique({
    where: { id: row.loyaltyTransactionId },
    select: { id: true, customerId: true, points: true, orderId: true },
  })
  if (!original) return null

  const pointsRefunded = Math.abs(original.points)

  const adjustment = await tx.loyaltyTransaction.create({
    data: {
      customerId: original.customerId,
      type: LoyaltyTransactionType.ADJUST,
      points: pointsRefunded,
      orderId: original.orderId,
      reason: `Devolución de ${pointsRefunded} puntos (se quitó la recompensa de la cuenta)`,
      createdById: sv?.id,
    },
  })

  await tx.customer.update({
    where: { id: original.customerId },
    data: { loyaltyPoints: { increment: pointsRefunded } },
  })

  return { pointsRefunded, customerId: original.customerId, transactionId: adjustment.id }
}
