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
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { getOrCreateLoyaltyConfig } from '../dashboard/loyalty.dashboard.service'

/** Rounds to cents the way every other money path here does. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 🔴 `LoyaltyTransaction.createdById` and `OrderDiscount.appliedById` FK to
 * StaffVenue.id, but the mobile auth context carries a Staff.id. Writing the
 * Staff.id straight through raises P2003 and rolls the WHOLE redemption back —
 * points and discount silently never persist. Resolve the row first; if the
 * caller has no assignment to this venue we store null rather than fail: the
 * audit attribution is nice to have, the money movement is not optional.
 */
async function resolveStaffVenueId(venueId: string, staffId?: string): Promise<string | undefined> {
  if (!staffId) return undefined
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
    select: { id: true },
  })
  return sv?.id
}

/**
 * Balance + program rules for the customer attached to a check, plus how much
 * the POS may redeem RIGHT NOW against this order (capped at its total).
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

  // What the balance is worth, capped by what is still owed on the check.
  let orderTotal: number | null = null
  if (orderId) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, venueId },
      select: { total: true },
    })
    orderTotal = order ? Number(order.total) : null
  }

  const balanceValue = money(balance * redemptionRate)
  const maxRedeemableValue = orderTotal === null ? balanceValue : money(Math.min(balanceValue, orderTotal))
  // Points that produce that value — never more than the customer owns.
  const maxRedeemablePoints =
    redemptionRate > 0 ? Math.min(balance, Math.floor(maxRedeemableValue / redemptionRate)) : 0

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
 */
export async function redeemPointsToOrder(
  venueId: string,
  orderId: string,
  customerId: string,
  points: number,
  staffId?: string,
) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new BadRequestError('points debe ser un entero positivo')
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, total: true, paymentStatus: true, paidAmount: true },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }

  const config = await getOrCreateLoyaltyConfig(venueId)
  if (!config.active) throw new BadRequestError('El programa de lealtad no está activo en esta sucursal')
  if (points < config.minPointsRedeem) {
    throw new BadRequestError(`Se requieren al menos ${config.minPointsRedeem} puntos para canjear`)
  }

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, loyaltyPoints: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')
  if (customer.loyaltyPoints < points) {
    throw new BadRequestError(`Puntos insuficientes: el cliente tiene ${customer.loyaltyPoints}`)
  }

  const redemptionRate = Number(config.redemptionRate)
  const rawValue = money(points * redemptionRate)
  // Never discount more than the check is worth — the surplus stays as points.
  const orderTotal = Number(order.total)
  const discountAmount = money(Math.min(rawValue, orderTotal))
  if (discountAmount <= 0) {
    throw new BadRequestError('El canje no genera descuento sobre esta cuenta')
  }
  // If the value was capped, only burn the points actually used.
  const pointsToBurn =
    discountAmount < rawValue && redemptionRate > 0 ? Math.ceil(discountAmount / redemptionRate) : points

  const staffVenueId = await resolveStaffVenueId(venueId, staffId)

  await prisma.$transaction(async tx => {
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

    await tx.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { decrement: pointsToBurn } },
    })

    await tx.orderDiscount.create({
      data: {
        orderId,
        type: 'FIXED_AMOUNT',
        name: `Recompensas — ${pointsToBurn} puntos`,
        value: new Prisma.Decimal(discountAmount),
        amount: new Prisma.Decimal(discountAmount),
        isManual: true,
        appliedById: staffVenueId,
        loyaltyTransactionId: transaction.id,
      },
    })
  })

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0))

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'LOYALTY_POINTS_REDEEMED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { customerId, points: pointsToBurn, discountAmount },
  })

  const balance = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  })

  return {
    pointsRedeemed: pointsToBurn,
    discountAmount,
    newBalance: balance?.loyaltyPoints ?? 0,
    order: totals,
  }
}

/**
 * Refunds the points behind an OrderDiscount that came from a redemption.
 * Runs INSIDE the caller's transaction so the discount row and the points move
 * together. No-op for ordinary discounts.
 */
export async function refundLoyaltyForOrderDiscount(
  tx: Prisma.TransactionClient,
  venueId: string,
  row: { id: string; loyaltyTransactionId: string | null },
  staffId?: string,
): Promise<{ pointsRefunded: number; customerId: string } | null> {
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

  await tx.loyaltyTransaction.create({
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

  return { pointsRefunded, customerId: original.customerId }
}
