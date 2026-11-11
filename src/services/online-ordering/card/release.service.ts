// src/services/online-ordering/card/release.service.ts
/**
 * Fase 2 — soltar la tarjeta apartada de un cargo en `RELEASING` (lo dejó ahí la transición que rechazó, venció o canceló el
 * pedido, o la liberación tardía de la tarea 5). Nunca lanza: si Stripe falla, el cargo se queda `RELEASING` con `lastError` y el
 * conciliador (tarea 7) lo retoma con la MISMA clave.
 *
 * r2 R1: si Stripe no la suelta porque el negocio ya la COBRÓ a mano (PaymentIntent `succeeded`), no se reintenta para siempre ni
 * se devuelve el dinero solo: se registra el cobro que ya pasó (`recordCapturedOutsideOnRelease`) y se avisa una vez.
 */
import { OnlineOrderChargeStatus, OnlineOrderStatus, OrderStatus, PaymentStatus, Prisma, type OnlineOrderCharge } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import type { AuthorizationState } from '@/services/payments/providers/provider.interface'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { cardPaymentData } from './capturedPayment'
import { chargeMerchant } from './merchant'

/** `lastError` del cargo cuyo dinero ya cobró el negocio a mano en Stripe (C3 y r2 R1: misma familia, misma anomalía). */
export const CAPTURED_OUTSIDE = 'CAPTURED_OUTSIDE'

type ReleasableCharge = OnlineOrderCharge & { onlineOrder: { orderId: string } | null }
const LIVE_ONLINE: OnlineOrderStatus[] = [
  OnlineOrderStatus.PENDING_ACCEPTANCE,
  OnlineOrderStatus.ACCEPTED,
  OnlineOrderStatus.READY,
  OnlineOrderStatus.COMPLETED,
]

export async function releaseCharge(chargeId: string): Promise<'RELEASED' | 'STUCK' | 'CAPTURED_OUTSIDE'> {
  try {
    const charge = await prisma.onlineOrderCharge.findUnique({
      where: { id: chargeId },
      include: { onlineOrder: { select: { orderId: true } } },
    })
    if (charge?.status === OnlineOrderChargeStatus.RELEASED) return 'RELEASED'
    if (charge?.status !== OnlineOrderChargeStatus.RELEASING) return 'STUCK'
    if (!charge.paymentIntentId) throw new Error('cargo RELEASING sin PaymentIntent')

    // Con pedido, la clave del pedido; sin él (liberación tardía de la tarea 5), la del cargo, la misma que ya usó ese camino.
    const idempotencyKey = charge.onlineOrder
      ? `online-order:${charge.onlineOrder.orderId}:release`
      : `online-order-charge:${charge.id}:release`
    const merchant = chargeMerchant(charge)
    const provider = getProvider(merchant)
    let state: AuthorizationState | null = null
    let failure: unknown = null
    try {
      state = await provider.voidAuthorization(merchant, { paymentIntentId: charge.paymentIntentId, idempotencyKey })
    } catch (error) {
      failure = error
    }
    if (state?.piStatus !== 'canceled') {
      // r2 R1: Stripe no la soltó. Se relee con el PaymentIntent PROPIO: ¿ya la cobraron a mano?
      let now: AuthorizationState | null = null
      try {
        now = await provider.getAuthorization(merchant, { paymentIntentId: charge.paymentIntentId })
      } catch {
        now = null // sin respuesta: queda en duda (el error original) y el conciliador repite
      }
      if (now?.piStatus === 'succeeded') {
        await recordCapturedOutsideOnRelease(charge, now)
        return 'CAPTURED_OUTSIDE'
      }
      if (now?.piStatus !== 'canceled') {
        throw failure ?? new Error(`Stripe dejó el PaymentIntent en ${state?.piStatus ?? now?.piStatus ?? 'desconocido'}`)
      }
    }

    const done = await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.RELEASING },
      data: { status: OnlineOrderChargeStatus.RELEASED, releasedAt: new Date(), lastError: null },
    })
    if (done.count === 1) {
      void logAction({
        venueId: charge.venueId,
        action: 'ONLINE_ORDER_CARD_RELEASED',
        entity: charge.onlineOrderId ? 'OnlineOrder' : 'OnlineOrderCharge',
        entityId: charge.onlineOrderId ?? charge.id,
        data: { chargeId: charge.id, amount: new Prisma.Decimal(charge.amount).toFixed(2) },
      })
    }
    return 'RELEASED'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('⚠️ [OnlineOrderCard] no se pudo liberar la tarjeta; el conciliador lo reintenta', { chargeId, error: message })
    await prisma.onlineOrderCharge
      .updateMany({ where: { id: chargeId, status: OnlineOrderChargeStatus.RELEASING }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined)
    return 'STUCK'
  }
}

/**
 * r2 R1 (decisión del founder: no devolver el dinero solo). Se libera un cargo cuyo PaymentIntent ya está `succeeded`: el negocio lo
 * cobró a mano en su Stripe. En UNA transacción, bajo el candado de la orden: cargo `RELEASING → CAPTURED` (CAS, con lo cobrado de
 * verdad), el `Payment` de tarjeta como en `finishCapture` (misma llave: uno por pedido) y lo cobrado en la cuenta, que se queda como
 * esté (rechazada, vencida o cancelada: no se acepta ni se descuenta inventario), y la `MoneyAnomaly` de la misma familia que C3
 * (llave única por cargo = la marca de «una vez»). Así «Devolver a la tarjeta» la puede devolver. Sin pedido (liberación tardía de
 * un borrador): sólo el cargo y la anomalía. Después, 🚨 y bitácora sólo si la anomalía es nueva.
 */
async function recordCapturedOutsideOnRelease(charge: ReleasableCharge, state: AuthorizationState): Promise<void> {
  const capturedAmount = fromStripeAmount(state.amountReceivedCents)
  const orderId = charge.onlineOrder?.orderId ?? null
  const result = await prisma.$transaction(async tx => {
    if (orderId && !(await lockExistingOrderForPayment(tx, { venueId: charge.venueId, orderId }))) {
      throw new Error(`la orden ${orderId} ya no es de este negocio`)
    }
    const won = await tx.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.RELEASING },
      data: { status: OnlineOrderChargeStatus.CAPTURED, capturedAt: new Date(), capturedAmount, lastError: CAPTURED_OUTSIDE },
    })
    if (won.count !== 1) return null // otro liberador ya lo registró
    let paymentId: string | null = null
    if (orderId) {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          total: true,
          paidAmount: true,
          status: true,
          paymentStatus: true,
          onlineOrder: { select: { venueId: true, status: true } },
        },
      })
      const payment = await tx.payment.create({
        data: cardPaymentData(charge, state, orderId, capturedAmount),
        select: { id: true, processedById: true },
      })
      paymentId = payment.id
      await tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paidAmount: new Prisma.Decimal(order.paidAmount).plus(capturedAmount),
          remainingBalance: 0,
          ...(order.paymentStatus !== PaymentStatus.PAID &&
          new Prisma.Decimal(order.total).gt(0) &&
          order.status !== OrderStatus.CANCELLED &&
          order.status !== OrderStatus.DELETED &&
          order.onlineOrder?.venueId === charge.venueId &&
          LIVE_ONLINE.includes(order.onlineOrder.status)
            ? { loyaltyEligibleAt: new Date(), loyaltyStaffId: payment.processedById }
            : {}),
        },
      })
    }
    const inserted = await tx.moneyAnomaly.createMany({
      data: [
        {
          category: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE',
          stripeEventId: `ooc:CAPTURED_OUTSIDE:${charge.id}`,
          expectedState: {
            venueId: charge.venueId,
            chargeId: charge.id,
            orderId,
            status: 'RELEASING',
            amount: new Prisma.Decimal(charge.amount).toFixed(2),
          },
          observedState: {
            paymentIntentId: state.paymentIntentId,
            piStatus: state.piStatus,
            amountReceived: capturedAmount.toFixed(2),
            paymentId,
          },
        },
      ],
      skipDuplicates: true,
    })
    return { paymentId, alert: inserted.count > 0 }
  }, ORDER_LOCK_WAIT_BUDGET)
  if (!result?.alert) return
  logger.error('🚨 [OnlineOrderCard] la tarjeta que se iba a liberar ya se cobró a mano en Stripe: se registró el cobro, devuélvelo', {
    chargeId: charge.id,
    venueId: charge.venueId,
    orderId,
    paymentId: result.paymentId,
    amount: capturedAmount.toFixed(2),
  })
  void logAction({
    venueId: charge.venueId,
    action: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE',
    entity: charge.onlineOrderId ? 'OnlineOrder' : 'OnlineOrderCharge',
    entityId: charge.onlineOrderId ?? charge.id,
    data: { chargeId: charge.id, paymentIntentId: state.paymentIntentId, amount: capturedAmount.toFixed(2), paymentId: result.paymentId },
  })
}
