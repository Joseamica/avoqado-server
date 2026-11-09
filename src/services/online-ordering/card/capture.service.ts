// src/services/online-ordering/card/capture.service.ts
/**
 * Fase 2 — aceptar un pedido pagado con tarjeta en línea COBRA la tarjeta apartada, una sola vez:
 *   1. transacción corta bajo el candado de la orden: cargo `AUTHORIZED → CAPTURING` (sólo uno gana);
 *   2. `capture` con Stripe FUERA de toda transacción, con la clave `online-order:<orderId>:capture` y la comisión congelada;
 *   3. `finishCapture`: en UNA transacción el cargo `CAPTURED`, el `Payment`, la cuenta pagada y la aceptación.
 * Si la respuesta se pierde, el cargo se queda `CAPTURING` («Confirmando el pago») y nada más mueve el pedido hasta que esto o el
 * conciliador (tarea 7) sepan el desenlace. Nunca hay un `Payment` sobre un pedido que no quedó aceptado.
 */
import {
  OnlineOrderChargeStatus,
  OnlineOrderRejectReason,
  OnlineOrderStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  type OnlineOrderCharge,
} from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { activarSobresDeCuentaPagadaEnTx } from '@/services/giftCards/giftCardLedger'
import { applySalePosting, createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import { debeMarcarCocina } from '@/services/kds/kitchenDisplayStations'
import { getProvider } from '@/services/payments/provider-registry'
import type { AuthorizationState } from '@/services/payments/providers/provider.interface'
import { fromStripeAmount, toStripeAmount } from '@/services/payments/providers/money'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import {
  acceptWithoutCapture,
  announceAccepted,
  casTransitionInTx,
  expireOnlineOrder,
  prepMinutes,
  rejectOnlineOrder,
  type AcceptInput,
  type CasResult,
  type TransitionResult,
} from '../transitions.service'
import { captureKey, cardPaymentData } from './capturedPayment'
import { chargeMerchant } from './merchant'
import { releaseCharge } from './release.service'

type Plan =
  | { do: 'ANSWER'; result: TransitionResult }
  | { do: 'ACCEPT_WITHOUT_CAPTURE'; releaseChargeId?: string }
  | { do: 'REJECT_PAYMENT_FAILED'; releaseChargeId?: string }
  | { do: 'EXPIRE'; now: Date }
  | { do: 'CAPTURE'; charge: OnlineOrderCharge; now: Date }

const rejectedForPayment = async (i: AcceptInput): Promise<TransitionResult> => {
  const r = await rejectOnlineOrder({ ...i, reason: OnlineOrderRejectReason.PAYMENT_FAILED })
  return r.outcome === 'OK' ? { outcome: 'STALE', status: OnlineOrderStatus.REJECTED } : r
}

export async function acceptCardOnlineOrder(i: AcceptInput): Promise<TransitionResult> {
  const minutes = await prepMinutes(i.venueId, i.estimatedMinutes)

  const plan = await prisma.$transaction(async (tx): Promise<Plan> => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: i.venueId, orderId: i.orderId }))) {
      return { do: 'ANSWER', result: { outcome: 'NOT_FOUND' } }
    }
    const now = i.now ?? new Date() // R1: el reloj, después del candado
    const row = await tx.onlineOrder.findFirst({
      where: { orderId: i.orderId, venueId: i.venueId },
      select: {
        status: true,
        acceptDeadlineAt: true,
        charge: true,
        order: { select: { status: true, total: true, paymentStatus: true, paidAmount: true } },
      },
    })
    if (!row) return { do: 'ANSWER', result: { outcome: 'NOT_FOUND' } }
    const charge = row.charge
    if (charge?.status === OnlineOrderChargeStatus.CAPTURING) return { do: 'ANSWER', result: { outcome: 'CONFIRMING_PAYMENT' } }
    if (row.status !== OnlineOrderStatus.PENDING_ACCEPTANCE) return { do: 'ANSWER', result: { outcome: 'STALE', status: row.status } }
    // La cuenta cancelada por otra vía (R2): la aceptación de siempre lo sincroniza (no acepta nada).
    if (row.order.status === OrderStatus.CANCELLED || row.order.status === OrderStatus.DELETED) return { do: 'ACCEPT_WITHOUT_CAPTURE' }
    // Fix r1 I1: un pedido de tarjeta nunca se acepta sin cobrar (entregarlo no pide cobro). Sin cargo no hay con qué cobrar.
    if (!charge) {
      logger.error('🚨 [OnlineOrderCard] pedido con tarjeta sin cargo: se rechaza', { venueId: i.venueId, orderId: i.orderId })
      return { do: 'REJECT_PAYMENT_FAILED' }
    }

    // La cuenta ya trae dinero de otro camino: no se cobra la tarjeta otra vez; se suelta. Sólo si ya está PAGADA se acepta como
    // hoy; con un pago parcial no se acepta (quedaría sin cobrar el resto): se rechaza.
    const hasMoney = row.order.paymentStatus !== PaymentStatus.PENDING || new Prisma.Decimal(row.order.paidAmount).gt(0)
    if (hasMoney) {
      const moved = await tx.onlineOrderCharge.updateMany({
        where: { id: charge.id, status: OnlineOrderChargeStatus.AUTHORIZED },
        data: { status: OnlineOrderChargeStatus.RELEASING },
      })
      const release = moved.count === 1 ? { releaseChargeId: charge.id } : {}
      if (row.order.paymentStatus === PaymentStatus.PAID) return { do: 'ACCEPT_WITHOUT_CAPTURE', ...release }
      logger.error('🚨 [OnlineOrderCard] pedido con tarjeta con un pago parcial de otro camino: no se cobra ni se acepta', {
        chargeId: charge.id,
        venueId: i.venueId,
        orderId: i.orderId,
        paidAmount: new Prisma.Decimal(row.order.paidAmount).toFixed(2),
      })
      return { do: 'REJECT_PAYMENT_FAILED', ...release }
    }
    // Ruling T6: sin tarjeta apartada (Stripe la soltó o el cobro ya falló) no hay con qué cobrar.
    if (charge.status !== OnlineOrderChargeStatus.AUTHORIZED) return { do: 'REJECT_PAYMENT_FAILED' }
    if (row.acceptDeadlineAt.getTime() <= now.getTime()) return { do: 'EXPIRE', now }
    // Codex r1 #2: el total de la cuenta es el del cargo; si alguien lo cambió, no se cobra otra cosa.
    if (!new Prisma.Decimal(row.order.total).equals(new Prisma.Decimal(charge.amount))) {
      logger.error('🚨 [OnlineOrderCard] el total de la cuenta no es el de la tarjeta apartada: se rechaza y se libera', {
        chargeId: charge.id,
        venueId: i.venueId,
        orderId: i.orderId,
        orderTotal: new Prisma.Decimal(row.order.total).toFixed(2),
        chargeAmount: new Prisma.Decimal(charge.amount).toFixed(2),
      })
      return { do: 'REJECT_PAYMENT_FAILED' }
    }

    const won = await tx.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.AUTHORIZED },
      data: { status: OnlineOrderChargeStatus.CAPTURING, attempts: { increment: 1 } },
    })
    if (won.count !== 1) return { do: 'ANSWER', result: { outcome: 'CONFIRMING_PAYMENT' } }
    return { do: 'CAPTURE', charge, now }
  }, ORDER_LOCK_WAIT_BUDGET)

  switch (plan.do) {
    case 'ANSWER':
      return plan.result
    case 'ACCEPT_WITHOUT_CAPTURE': {
      const r = await acceptWithoutCapture(i)
      if (plan.releaseChargeId) await releaseCharge(plan.releaseChargeId)
      return r
    }
    case 'REJECT_PAYMENT_FAILED': {
      const r = await rejectedForPayment(i)
      if (plan.releaseChargeId) await releaseCharge(plan.releaseChargeId)
      return r
    }
    case 'EXPIRE': {
      // El camino de hoy: aceptar tarde vence aquí mismo (y la transición del vencimiento suelta la tarjeta).
      const expired = await expireOnlineOrder({ venueId: i.venueId, orderId: i.orderId, now: plan.now })
      if (expired.outcome === 'OK') return { outcome: 'STALE', status: OnlineOrderStatus.EXPIRED }
      return expired
    }
    case 'CAPTURE':
      return captureCharge(plan.charge, i.orderId, { staffId: i.staffId, estimatedMinutes: minutes, now: plan.now })
  }
}

/**
 * Cobra con Stripe (fuera de toda transacción) un cargo que ya está en `CAPTURING`, y termina según el desenlace. La usa también el
 * conciliador (tarea 7) para reintentar con la MISMA clave.
 */
export async function captureCharge(
  charge: OnlineOrderCharge,
  orderId: string,
  meta: { staffId: string | null; estimatedMinutes: number; now: Date },
): Promise<TransitionResult> {
  const merchant = chargeMerchant(charge) // Codex r2 #3: la cuenta Stripe de la foto, nunca el comercio vivo
  const provider = getProvider(merchant)
  let state: AuthorizationState | null = null
  let failure: unknown = null
  try {
    state = await provider.capture(merchant, {
      paymentIntentId: charge.paymentIntentId!,
      amountCents: toStripeAmount(new Prisma.Decimal(charge.amount)),
      applicationFeeCents: charge.applicationFeeCents, // Codex r1 #8: congelada en el borrador, nunca se recalcula
      idempotencyKey: captureKey(orderId),
    })
  } catch (error) {
    failure = error
    try {
      state = await provider.getAuthorization(merchant, { paymentIntentId: charge.paymentIntentId! })
    } catch {
      state = null // Stripe no contesta: queda en duda
    }
  }

  if (state?.piStatus === 'succeeded') return finishCapture(charge.id, state, meta)
  if (state?.piStatus === 'canceled' || state?.piStatus === 'requires_payment_method') {
    return failCapture(charge.id, { staffId: meta.staffId, now: meta.now })
  }

  // Fix r1 M5: cualquier error de `capture` (de Stripe o no) queda escrito para la alerta del conciliador.
  const why =
    failure != null
      ? failure instanceof Error
        ? failure.message
        : String(failure)
      : `Stripe dejó el PaymentIntent en ${state?.piStatus ?? 'desconocido'}`
  await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, status: OnlineOrderChargeStatus.CAPTURING },
    data: { lastError: why.slice(0, 500) },
  })
  logger.warn('⚠️ [OnlineOrderCard] cobro en duda: queda CAPTURING para el conciliador', { chargeId: charge.id, orderId, why })
  return { outcome: 'CONFIRMING_PAYMENT' }
}

/** El cobro con la tarjeta ya se hizo, pero la cuenta no se pudo aceptar: se revierte TODO y el cargo queda `CAPTURING`. */
class CaptureNotAccepted extends Error {}

/**
 * Stripe ya cobró: en UNA transacción, cargo `CAPTURED`, el `Payment`, la cuenta pagada, su vale de inventario y la aceptación.
 * La aceptación DEBE ganar; si no, se lanza para revertir todo (nunca un `Payment` sobre un pedido no aceptado) y el cargo queda
 * `CAPTURING`: el conciliador alerta 🚨 a los 15 min. La usa también el conciliador (tarea 7).
 */
export async function finishCapture(
  chargeId: string,
  state: AuthorizationState,
  meta: { staffId: string | null; estimatedMinutes: number; now: Date },
): Promise<TransitionResult> {
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { id: chargeId },
    include: { onlineOrder: { select: { orderId: true } } },
  })
  if (!charge?.onlineOrder) return { outcome: 'NOT_FOUND' }
  const { venueId } = charge
  const orderId = charge.onlineOrder.orderId
  const capturedAmount = fromStripeAmount(state.amountReceivedCents)
  if (!capturedAmount.equals(new Prisma.Decimal(charge.amount))) {
    // Otro cobro con otro monto no es el nuestro: no se registra nada; lo ve una persona por la alerta del conciliador.
    logger.error('🚨 [OnlineOrderCard] Stripe cobró un monto distinto al del cargo: queda CAPTURING', {
      chargeId,
      venueId,
      capturedCents: state.amountReceivedCents,
      expected: new Prisma.Decimal(charge.amount).toFixed(2),
    })
    await prisma.onlineOrderCharge.updateMany({
      where: { id: chargeId, status: OnlineOrderChargeStatus.CAPTURING },
      data: { lastError: 'CAPTURED_AMOUNT_MISMATCH' },
    })
    return { outcome: 'CONFIRMING_PAYMENT' }
  }

  const marcarCocina = await debeMarcarCocina(venueId, { orderId })
  const minutes = meta.estimatedMinutes
  // r2 R1: el mismo armado que la liberación que encuentra el cobro hecho a mano (`capturedPayment.ts`).
  const paymentData = cardPaymentData(charge, state, orderId, capturedAmount)
  const feeAmount = new Prisma.Decimal(paymentData.feeAmount as Prisma.Decimal)

  let done: { r: Extract<CasResult, { r: 'OK' }>; paymentId: string; postingId: string | null; cobroDoble: boolean } | null
  try {
    done = await withDeadlockRetry(
      async tx => {
        if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new CaptureNotAccepted('ORDER_NOT_FOUND')
        const won = await tx.onlineOrderCharge.updateMany({
          where: { id: chargeId, status: OnlineOrderChargeStatus.CAPTURING },
          data: { status: OnlineOrderChargeStatus.CAPTURED, capturedAt: meta.now, capturedAmount, lastError: null },
        })
        if (won.count !== 1) return null // alguien ya terminó este cobro

        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: {
            total: true,
            paidAmount: true,
            paymentStatus: true,
            items: { include: { modifiers: { include: { modifier: true } } } },
          },
        })
        // Fix r1 I2: bajo el candado, la cuenta debe valer lo cobrado; si cambió desde la primera transacción, se revierte todo.
        if (!new Prisma.Decimal(order.total).equals(capturedAmount)) throw new CaptureNotAccepted('TOTAL_CHANGED')
        // T8 fix r1 (ruling): otro camino ya metió dinero (p. ej. la TPV registró un cobro hecho) mientras Stripe cobraba. Stripe ya
        // cobró, así que no se rechaza: se registra el de tarjeta, lo cobrado suma los dos y, tras el commit, 🚨 + bitácora para que
        // el negocio devuelva uno.
        const yaCobrado = new Prisma.Decimal(order.paidAmount)
        const cobroDoble = yaCobrado.gt(0)
        const payment = await tx.payment.create({
          data: paymentData,
          select: { id: true },
        })
        await tx.order.update({
          where: { id: orderId },
          data: {
            paymentStatus: PaymentStatus.PAID,
            paidAmount: yaCobrado.plus(capturedAmount),
            remainingBalance: 0,
            ...(order.paymentStatus !== PaymentStatus.PAID ? { loyaltyEligibleAt: new Date(), loyaltyStaffId: meta.staffId } : {}),
          },
        })
        const posting = await createSalePostingInTx(tx, { venueId, orderId, items: order.items as any, staffId: meta.staffId })
        // R8: como cada vale de una venta saldada (la tienda en línea hoy no vende tarjetas de regalo: no encuentra sobres).
        await activarSobresDeCuentaPagadaEnTx(tx, { venueId, orderId, staffId: meta.staffId, items: order.items })

        // La cuenta ya está pagada, así que la aceptación no mira la hora límite: el cobro empezó a tiempo.
        const r = await casTransitionInTx(tx, {
          kind: 'ACCEPT',
          venueId,
          orderId,
          now: meta.now,
          allowCapturing: true,
          onlineData: now => ({ acceptedAt: now, estimatedReadyAt: new Date(now.getTime() + minutes * 60_000) }),
          orderExtra: now => (marcarCocina ? { kitchenPendingAt: now } : {}),
        })
        // Nunca un Payment sobre un pedido no aceptado: se revierte todo.
        if (r.r !== 'OK') throw new CaptureNotAccepted(`ACCEPT_${r.r}`)
        return { r, paymentId: payment.id, postingId: posting?.id ?? null, cobroDoble }
      },
      { etiqueta: 'finishCapture', ...ORDER_LOCK_WAIT_BUDGET },
    )
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    logger.error('🚨 [OnlineOrderCard] Stripe cobró pero la cuenta no quedó aceptada: queda CAPTURING', { chargeId, venueId, why })
    await prisma.onlineOrderCharge
      .updateMany({ where: { id: chargeId, status: OnlineOrderChargeStatus.CAPTURING }, data: { lastError: why.slice(0, 500) } })
      .catch(() => undefined)
    return { outcome: 'CONFIRMING_PAYMENT' }
  }

  if (!done) {
    const current = await prisma.onlineOrder.findFirst({ where: { orderId, venueId }, select: { status: true } })
    return { outcome: 'STALE', status: current?.status ?? null }
  }

  // Ya cobrado y comprometido: el vale de inventario es reintentable y su barrido lo retoma si esto falla.
  if (done.postingId) {
    void applySalePosting(done.postingId, meta.staffId).catch(error =>
      logger.error('Failed to apply inventory posting for online order card capture', {
        postingId: done!.postingId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  if (done.cobroDoble) {
    logger.error('🚨 [OnlineOrderCard] la tarjeta se cobró sobre una cuenta que ya tenía dinero: el cliente pagó dos veces', {
      venueId,
      orderId,
      paymentId: done.paymentId,
      chargeId,
    })
    void logAction({
      staffId: meta.staffId,
      venueId,
      action: 'ONLINE_ORDER_CARD_DOUBLE_PAYMENT',
      entity: 'Order',
      entityId: orderId,
      data: { paymentId: done.paymentId, chargeId, source: 'ONLINE_CAPTURE' },
    })
  }
  const result = announceAccepted({ venueId, orderId, staffId: meta.staffId, minutes, marcarCocina }, done.r)
  void logAction({
    staffId: meta.staffId,
    venueId,
    action: 'ONLINE_ORDER_CARD_CAPTURED',
    entity: 'OnlineOrder',
    entityId: done.r.onlineOrderId,
    data: {
      orderNumber: done.r.orderNumber,
      chargeId,
      paymentId: done.paymentId,
      amount: capturedAmount.toFixed(2),
      feeAmount: feeAmount.toFixed(2),
    },
  })
  return result
}

/** El rechazo de la captura no debe correr si el cargo ya no está `CAPTURING`: se revierte. */
class ChargeNoLongerCapturing extends Error {}

/**
 * Stripe no cobró (el PaymentIntent quedó cancelado o sin tarjeta): el cargo `CAPTURE_FAILED` y el pedido rechazado con
 * `PAYMENT_FAILED`, en la MISMA transacción. La usa también el conciliador (tarea 7).
 */
export async function failCapture(chargeId: string, meta: { staffId: string | null; now?: Date }): Promise<TransitionResult> {
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { id: chargeId },
    select: { venueId: true, onlineOrderId: true, onlineOrder: { select: { orderId: true } } },
  })
  const markFailed = (db: Prisma.TransactionClient) =>
    db.onlineOrderCharge.updateMany({
      where: { id: chargeId, status: OnlineOrderChargeStatus.CAPTURING },
      data: { status: OnlineOrderChargeStatus.CAPTURE_FAILED, lastError: 'CAPTURE_FAILED' },
    })

  let result: TransitionResult = { outcome: 'NOT_FOUND' }
  if (charge?.onlineOrder) {
    try {
      const r = await rejectOnlineOrder({
        venueId: charge.venueId,
        orderId: charge.onlineOrder.orderId,
        staffId: meta.staffId,
        reason: OnlineOrderRejectReason.PAYMENT_FAILED,
        now: meta.now,
        allowCapturing: true,
        afterCas: async (tx, cas) => {
          const failed = await markFailed(tx)
          if (cas.r === 'OK' && failed.count !== 1) throw new ChargeNoLongerCapturing()
        },
      })
      result = r.outcome === 'OK' ? { outcome: 'STALE', status: OnlineOrderStatus.REJECTED } : r
    } catch (error) {
      if (!(error instanceof ChargeNoLongerCapturing)) throw error
      const current = await prisma.onlineOrder.findFirst({ where: { id: charge.onlineOrderId! }, select: { status: true } })
      return { outcome: 'STALE', status: current?.status ?? null }
    }
  }
  // Si la cuenta no se pudo cancelar (la transición se revirtió entera), el cargo igual dice la verdad: no se cobró.
  await markFailed(prisma)
  logger.warn('⚠️ [OnlineOrderCard] Stripe no cobró la tarjeta: pedido rechazado', { chargeId, outcome: result.outcome })
  if (charge) {
    void logAction({
      staffId: meta.staffId,
      venueId: charge.venueId,
      action: 'ONLINE_ORDER_CARD_CAPTURE_FAILED',
      entity: charge.onlineOrderId ? 'OnlineOrder' : 'OnlineOrderCharge',
      entityId: charge.onlineOrderId ?? chargeId,
      data: { chargeId, outcome: result.outcome },
    })
  }
  return result
}
