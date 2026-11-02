// src/services/online-ordering/card/refund.service.ts
/**
 * Fase 2 (T10) — devolver a la tarjeta un pedido en línea cobrado, desde el panel. Cada devolución es una fila
 * (`OnlineOrderCardRefund`) cuyos estados sólo avanzan, con CAS sobre el estado leído:
 *
 *   REQUESTED ─► SENDING ─► PENDING ─► SUCCEEDED ─► RECORDED ─► REVERSED ─► RESOLVED
 *                   │          │
 *                   └──────────┴─► FAILED | CANCELED      (sólo con evidencia de Stripe)
 *
 * Stripe es la fuente de verdad: se le pregunta, nunca se adivina (un aviso sólo dispara una relectura). El renglón REFUND del libro
 * nace sólo con `succeeded`, por `issueRefund` (llave `oocr_<id>`, para conservar sus efectos), y nunca se edita. Un fallo tardío
 * (`RECORDED` → Stripe dice failed/canceled) se anota en `OnlineOrderCardRefundReversal` (sólo agregar) y el negocio lo resuelve
 * pagándole al cliente por otro medio (`resolveReversedCardRefund`). `advanceCardRefund` es el ÚNICO paso que habla con Stripe y
 * nunca corre con una transacción abierta (r4 #5). Siempre la cuenta Stripe de la foto del cargo (`chargeMerchant`).
 */
import {
  OnlineOrderCardRefundStatus as R,
  OnlineOrderChargeStatus,
  OnlineOrderPaymentMode,
  PaymentType,
  Prisma,
  type OnlineOrderCardRefund,
} from '@prisma/client'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { operationHash } from '@/utils/operationHash'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import { bloquearCobroParaReembolso, issueRefund, type RefundReason } from '@/services/dashboard/refund.dashboard.service'
import { getProvider } from '@/services/payments/provider-registry'
import { fromStripeAmount, toStripeAmount } from '@/services/payments/providers/money'
import type { RefundState, VerifiedWebhookEvent } from '@/services/payments/providers/provider.interface'
import { postPayOutInTx } from '@/services/shared/cashDrawerPosting'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { chargeMerchant, isForeignStripeEvent } from './merchant'

/** Los motivos que el panel puede escoger (el de las apps de reparto no aplica aquí). */
export const CARD_REFUND_REASONS = ['RETURNED_GOODS', 'ACCIDENTAL_CHARGE', 'CANCELLED_ORDER', 'FRAUDULENT_CHARGE', 'OTHER'] as const
/** Sin renglón del libro todavía: su monto sigue reservado y bloquea otra devolución del mismo cargo. */
const NO_LEDGER_YET: R[] = [R.REQUESTED, R.SENDING, R.PENDING, R.SUCCEEDED]
/** Lo que el recorrido vuelve a mirar. */
export const SWEPT_CARD_REFUND_STATUSES: R[] = [...NO_LEDGER_YET, R.RECORDED]
/** Ya con renglón: su comisión devuelta ya la contó Stripe. */
const WITH_LEDGER: R[] = [R.RECORDED, R.REVERSED, R.RESOLVED]

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const FAST_WINDOW_MS = 15 * MIN
/** Stripe: el fallo de una devolución puede llegar hasta 30 días después. */
const LATE_CHECKS_MS = [HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY]
/** «Ya no se revisa»: fuera de toda pasada del recorrido. */
export const NEVER_AGAIN = new Date('9999-12-31T00:00:00.000Z')
const PAYOUT_REASON = 'Devolución de pedido en línea (falló la tarjeta)'
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** `SENDING`/`PENDING`: cada minuto los primeros 15, luego cada 15. */
const nextPendingCheck = (createdAt: Date, now: Date) =>
  new Date(now.getTime() + (now.getTime() - createdAt.getTime() < FAST_WINDOW_MS ? MIN : FAST_WINDOW_MS))
/** `RECORDED`: a 1 h, 1 día, 3, 7 y 30 días desde que quedó anotada (fix r1 M3); luego nunca. */
const nextLateCheck = (recordedAt: Date, now: Date) => {
  const due = LATE_CHECKS_MS.map(ms => recordedAt.getTime() + ms).find(t => t > now.getTime())
  return due === undefined ? NEVER_AGAIN : new Date(due)
}
/** Desde cuándo cuenta la revisión tardía: el renglón del libro (filas viejas sin la marca: su creación). */
const ledgerBase = (row: Row) => row.recordedAt ?? row.createdAt
/** Margen tras los 30 días durante el que un error todavía se reintenta (después, la fila se deja). */
const LATE_GRACE_MS = DAY
/** Un SENDING que Stripe confirma que no tiene se re-envía con la MISMA clave si su último envío pasó de esto (ruling r1). */
const RESEND_AFTER_MS = 5 * MIN

/** Cuándo se vuelve a mirar una fila tras un error: nunca más tarde que su calendario ni que 15 min (fix r1 M3). */
function nextCheckAfterError(row: Row, now: Date): Date {
  if (!WITH_LEDGER.includes(row.status)) return nextPendingCheck(row.createdAt, now)
  if (now.getTime() >= ledgerBase(row).getTime() + LATE_CHECKS_MS[LATE_CHECKS_MS.length - 1] + LATE_GRACE_MS) return NEVER_AGAIN
  const soon = new Date(now.getTime() + FAST_WINDOW_MS)
  if (row.status !== R.RECORDED) return soon // REVERSED/RESOLVED: sólo queda el sello
  const late = nextLateCheck(ledgerBase(row), now)
  return late < soon ? late : soon
}
const pesos = (cents: number) => fromStripeAmount(cents).toFixed(2)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)
/**
 * Stripe contestó «no» a la solicitud: la devolución NO existe (evidencia, no silencio). Sólo un 400/404: un 409
 * (`idempotency_key_in_use` tras los reintentos del SDK) dice «hay otra con esta clave en vuelo», no «no existe» (fix r1 M1).
 */
const stripeRejected = (error: unknown) => {
  const e = error as { type?: string; statusCode?: number } | null
  return e?.type === 'StripeInvalidRequestError' && (e.statusCode === 400 || e.statusCode === 404)
}

type Row = OnlineOrderCardRefund
type Cur = { row: Row; alerted: boolean }

const load = (id: string) => prisma.onlineOrderCardRefund.findUnique({ where: { id } })

/** El cargo de la fila con su pedido (la foto del comercio va en el cargo). */
async function chargeOf(row: Row) {
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { id: row.chargeId },
    include: { onlineOrder: { select: { orderId: true } } },
  })
  if (!charge?.onlineOrder || !charge.paymentIntentId) throw new Error(`cargo ${row.chargeId} sin pedido o sin PaymentIntent`)
  return { charge, orderId: charge.onlineOrder.orderId, paymentIntentId: charge.paymentIntentId, merchant: chargeMerchant(charge) }
}

/** CAS al estado siguiente; deja la bitácora de los desenlaces sin renglón. Relee la fila; `true` si ESTE llamador ganó el CAS. */
async function moveTo(cur: Cur, to: R, data: Prisma.OnlineOrderCardRefundUpdateManyMutationInput = {}): Promise<boolean> {
  const from = cur.row.status
  const won = await prisma.onlineOrderCardRefund.updateMany({ where: { id: cur.row.id, status: from }, data: { ...data, status: to } })
  if (won.count === 1 && (to === R.FAILED || to === R.CANCELED)) {
    logger.warn('⚠️ [OnlineOrderCardRefund] Stripe no devolvió: ningún renglón', { cardRefundId: cur.row.id, status: to })
    void logAction({
      staffId: cur.row.staffId,
      venueId: cur.row.venueId,
      action: 'ONLINE_ORDER_CARD_REFUND_FAILED',
      entity: 'OnlineOrderCardRefund',
      entityId: cur.row.id,
      data: {
        status: to,
        amount: pesos(cur.row.amountCents),
        stripeRefundId: data.stripeRefundId ?? cur.row.stripeRefundId,
        why: data.lastError,
      },
    })
  }
  cur.row = (await load(cur.row.id))!
  return won.count === 1
}

/** La fila no cambió de estado: se mueve su próxima revisión (así una que no cambia no tapa a las de atrás). */
async function touch(cur: Cur, nextCheckAt: Date): Promise<void> {
  await prisma.onlineOrderCardRefund.updateMany({ where: { id: cur.row.id, status: cur.row.status }, data: { nextCheckAt } })
  cur.row = { ...cur.row, nextCheckAt }
}

/** 🚨 una sola vez: un envío sin id o un `succeeded` sin renglón de más de 15 min necesita a una persona. Su monto sigue reservado. */
async function maybeAlertStuck(cur: Cur, now: Date, why: string): Promise<void> {
  const { row } = cur
  if (row.status !== R.SENDING && row.status !== R.SUCCEEDED) return
  if (row.alertedAt || now.getTime() - row.createdAt.getTime() < FAST_WINDOW_MS) return
  const won = await prisma.onlineOrderCardRefund.updateMany({
    where: { id: row.id, status: row.status, alertedAt: null },
    data: { alertedAt: now },
  })
  if (won.count !== 1) return
  cur.row = { ...cur.row, alertedAt: now }
  cur.alerted = true
  logger.error('🚨 [OnlineOrderCardRefund] devolución atorada: necesita a una persona', {
    cardRefundId: row.id,
    venueId: row.venueId,
    status: row.status,
    why,
  })
  await logAction({
    staffId: row.staffId,
    venueId: row.venueId,
    action: 'ONLINE_ORDER_CARD_REFUND_STUCK',
    entity: 'OnlineOrderCardRefund',
    entityId: row.id,
    data: { status: row.status, why, amount: pesos(row.amountCents), stripeRefundId: row.stripeRefundId },
  })
}

const STATUS_OF: Record<RefundState['status'], R> = {
  PENDING: R.PENDING,
  SUCCEEDED: R.SUCCEEDED,
  FAILED: R.FAILED,
  CANCELED: R.CANCELED,
}
/** Tras saber el estado de Stripe: `succeeded` sigue de inmediato; `pending` espera; los fallos terminan. */
const afterStripe = (to: R, row: Row, now: Date) => ({ nextCheckAt: to === R.PENDING ? nextPendingCheck(row.createdAt, now) : now })

/** `REQUESTED` → `SENDING` (sólo quien gana el CAS llama a Stripe) → lo que Stripe conteste. */
async function send(cur: Cur, now: Date): Promise<void> {
  const won = await prisma.onlineOrderCardRefund.updateMany({
    where: { id: cur.row.id, status: R.REQUESTED },
    data: { status: R.SENDING, nextCheckAt: nextPendingCheck(cur.row.createdAt, now), lastSentAt: now },
  })
  if (won.count !== 1) {
    cur.row = (await load(cur.row.id))!
    return
  }
  cur.row = { ...cur.row, status: R.SENDING, nextCheckAt: nextPendingCheck(cur.row.createdAt, now), lastSentAt: now }
  await callStripeRefund(cur, now)
}

/** El envío a Stripe de una fila ya `SENDING`, con la MISMA clave siempre (Stripe repite o crea exactamente una). */
async function callStripeRefund(cur: Cur, now: Date): Promise<void> {
  const { orderId, paymentIntentId, merchant } = await chargeOf(cur.row)
  // Codex r3 #3: un cobro hecho a mano en Stripe no trae comisión de la plataforma; no se pide devolver una que no existe.
  const cobro = await prisma.payment.findFirst({
    where: { venueId: cur.row.venueId, orderId, processorId: paymentIntentId, type: PaymentType.REGULAR },
    select: { feeAmount: true },
  })
  let result
  try {
    result = await getProvider(merchant).refund(merchant, {
      paymentIntentId,
      amount: cur.row.amountCents,
      refundApplicationFee: !cobro?.feeAmount || new Prisma.Decimal(cobro.feeAmount).gt(0),
      idempotencyKey: `online-order:${orderId}:refund:${cur.row.id}`,
      metadata: { type: 'online_order_refund', cardRefundId: cur.row.id, orderId, venueId: cur.row.venueId },
    })
  } catch (error) {
    // Stripe rechazó la solicitud (p. ej. un cobro en disputa): la devolución no existe; nada se movió.
    if (stripeRejected(error)) {
      await moveTo(cur, R.FAILED, { lastError: errorText(error) })
      return
    }
    throw error // respuesta perdida: queda SENDING (desconocido) y se busca por metadata
  }
  const to = STATUS_OF[result.status]
  await moveTo(cur, to, { stripeRefundId: result.refundId, lastError: null, ...afterStripe(to, cur.row, now) })
}

/** `SENDING` sin id = desconocido: se busca en Stripe por `metadata.cardRefundId`; si no aparece, sigue SENDING (nunca FAILED por tiempo). */
async function findSent(cur: Cur, now: Date): Promise<void> {
  const { paymentIntentId, merchant } = await chargeOf(cur.row)
  const found = (await getProvider(merchant).listRefunds(merchant, paymentIntentId)).find(r => r.metadata?.cardRefundId === cur.row.id)
  if (found) {
    const to = STATUS_OF[found.status]
    await moveTo(cur, to, { stripeRefundId: found.refundId, lastError: null, ...afterStripe(to, cur.row, now) })
    return
  }
  // Ruling r1: Stripe confirmó (todas las páginas) que no la tiene y el último envío ya tiene más de 5 min → se re-envía con la
  // MISMA clave. El CAS sobre `lastSentAt` deja un solo re-envío por pasada aunque dos ejecutores lleguen a la vez.
  const lastSent = cur.row.lastSentAt ?? cur.row.createdAt
  if (now.getTime() - lastSent.getTime() > RESEND_AFTER_MS) {
    const won = await prisma.onlineOrderCardRefund.updateMany({
      where: { id: cur.row.id, status: R.SENDING, stripeRefundId: null, lastSentAt: cur.row.lastSentAt },
      data: { lastSentAt: now, nextCheckAt: nextPendingCheck(cur.row.createdAt, now) },
    })
    if (won.count === 1) {
      cur.row = { ...cur.row, lastSentAt: now, nextCheckAt: nextPendingCheck(cur.row.createdAt, now) }
      logger.warn('⚠️ [OnlineOrderCardRefund] Stripe no tiene la devolución: se re-envía con la misma clave', { cardRefundId: cur.row.id })
      await callStripeRefund(cur, now)
      if (cur.row.status === R.SENDING) await maybeAlertStuck(cur, now, 'SENDING_RESENT')
      return
    }
    cur.row = (await load(cur.row.id))!
    return
  }
  await touch(cur, nextPendingCheck(cur.row.createdAt, now))
  await maybeAlertStuck(cur, now, 'SENDING_NOT_FOUND_IN_STRIPE')
}

/** `PENDING` → lo que diga Stripe. */
async function poll(cur: Cur, now: Date): Promise<void> {
  const { merchant } = await chargeOf(cur.row)
  const state = await getProvider(merchant).getRefund(merchant, cur.row.stripeRefundId!)
  if (state.status === 'PENDING') return touch(cur, nextPendingCheck(cur.row.createdAt, now))
  const to = STATUS_OF[state.status]
  await moveTo(cur, to, { lastError: state.failureReason, ...afterStripe(to, cur.row, now) })
}

/**
 * `SUCCEEDED` → el renglón del libro. La comisión devuelta se LEE de Stripe (no documenta el redondeo; r4 #3) y se guarda antes de
 * escribir: con una sola devolución activa por cargo, el total devuelto menos lo ya guardado es exactamente la de ésta. Luego
 * `issueRefund` (el envoltorio completo: sello, comisiones y referidos encolados; r5 #3) con la llave `oocr_<id>`: si el proceso
 * muere antes del CAS, la siguiente pasada recupera el MISMO renglón.
 */
async function record(cur: Cur, now: Date): Promise<void> {
  const { orderId, paymentIntentId, merchant } = await chargeOf(cur.row)
  if (cur.row.feeRefundedCents == null) {
    const total = await getProvider(merchant).getApplicationFeeRefundedCents(merchant, paymentIntentId)
    const prior = await prisma.onlineOrderCardRefund.aggregate({
      where: { chargeId: cur.row.chargeId, status: { in: WITH_LEDGER }, id: { not: cur.row.id } },
      _sum: { feeRefundedCents: true },
    })
    let fee = total - (prior._sum.feeRefundedCents ?? 0)
    if (fee < 0 || fee > cur.row.amountCents) {
      logger.error('🚨 [OnlineOrderCardRefund] la comisión devuelta por Stripe no cuadra con lo ya anotado', {
        cardRefundId: cur.row.id,
        total,
        prior: prior._sum.feeRefundedCents ?? 0,
      })
      fee = Math.min(Math.max(fee, 0), cur.row.amountCents)
    }
    await prisma.onlineOrderCardRefund.updateMany({
      where: { id: cur.row.id, status: R.SUCCEEDED, feeRefundedCents: null },
      data: { feeRefundedCents: fee },
    })
    cur.row = (await load(cur.row.id))!
    if (cur.row.status !== R.SUCCEEDED) return
  }
  const payment = await prisma.payment.findFirst({
    where: { venueId: cur.row.venueId, orderId, processorId: paymentIntentId, type: PaymentType.REGULAR },
    select: { id: true },
  })
  if (!payment) throw new Error(`no se encontró el cobro de Stripe ${paymentIntentId} del pedido ${orderId}`)
  const ledger = await issueRefund({
    venueId: cur.row.venueId,
    paymentId: payment.id,
    amount: cur.row.amountCents,
    reason: cur.row.reason as RefundReason,
    staffId: cur.row.staffId,
    note: `Stripe ${cur.row.stripeRefundId}`,
    idempotencyKey: `oocr_${cur.row.id}`,
    viaOnlineOrders: true,
    platformFeeRefundCents: cur.row.feeRefundedCents!,
    // Fix r1: su propio monto ya está apartado en el candado compartido; sin esto se rechazaría a sí misma.
    excludeCardRefundId: cur.row.id,
  })
  // Corto: la reversa del sello va enseguida; si falla, el recorrido la retoma al minuto. Sólo quien gana el CAS anota (el otro
  // ejecutor recibió el MISMO renglón por la llave).
  const won = await moveTo(cur, R.RECORDED, {
    refundPaymentId: ledger.refundId,
    recordedAt: now,
    lastError: null,
    nextCheckAt: new Date(now.getTime() + MIN),
  })
  if (won) {
    void logAction({
      staffId: cur.row.staffId,
      venueId: cur.row.venueId,
      action: 'ONLINE_ORDER_CARD_REFUNDED',
      entity: 'OnlineOrderCardRefund',
      entityId: cur.row.id,
      data: {
        orderId,
        amount: pesos(cur.row.amountCents),
        feeRefunded: pesos(cur.row.feeRefundedCents ?? 0),
        stripeRefundId: cur.row.stripeRefundId,
        refundPaymentId: ledger.refundId,
        reason: cur.row.reason,
      },
    })
  }
}

/** El sello no confía en `issueRefund` (su repetición regresa antes del sello y su llamada no es durable; Codex r6). */
async function reverseStamp(cur: Cur, now: Date): Promise<void> {
  const { orderId } = await chargeOf(cur.row)
  await reverseStampForOrder(cur.row.venueId, orderId)
  // También en REVERSED/RESOLVED: la venta sigue devuelta. Ésas ya no se revisan después.
  await prisma.onlineOrderCardRefund.updateMany({
    where: { id: cur.row.id, status: cur.row.status, stampReversedAt: null },
    data: {
      stampReversedAt: now,
      nextCheckAt: cur.row.status === R.RECORDED ? nextLateCheck(ledgerBase(cur.row), now) : NEVER_AGAIN,
      lastError: null,
    },
  })
  cur.row = (await load(cur.row.id))!
}

/** `RECORDED` (revisión tardía): si Stripe dice failed o canceled (el negocio puede cancelarla desde su Stripe; r5 #1) → reversa. */
async function reviewLate(cur: Cur, now: Date): Promise<void> {
  const { orderId, paymentIntentId, merchant } = await chargeOf(cur.row)
  const state = await getProvider(merchant).getRefund(merchant, cur.row.stripeRefundId!)
  if (state.status !== 'FAILED' && state.status !== 'CANCELED') return touch(cur, nextLateCheck(ledgerBase(cur.row), now))
  await reverseRecordedRefund(cur, { orderId, paymentIntentId, failureReason: state.failureReason ?? state.status.toLowerCase() }, now)
}

/**
 * La reversa, en UNA transacción: CAS `RECORDED → REVERSED`, la fila de reversa (única por `stripeRefundId`), `refundReversals[]`
 * en la caché del cobro original (mismo patrón que `refunds[]`) y la `MoneyAnomaly`. El renglón REFUND NO se toca y la orden no se
 * reabre: el cliente recibirá su dinero por otro medio. Fuera: bitácora y aviso al negocio.
 */
async function reverseRecordedRefund(cur: Cur, s: { orderId: string; paymentIntentId: string; failureReason: string | null }, now: Date) {
  const row = cur.row
  const amount = pesos(row.amountCents)
  const won = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: row.venueId, orderId: s.orderId }))) {
      throw new Error(`la orden ${s.orderId} ya no es de este negocio`)
    }
    const moved = await tx.onlineOrderCardRefund.updateMany({
      where: { id: row.id, status: R.RECORDED },
      data: { status: R.REVERSED, lastError: s.failureReason, nextCheckAt: row.stampReversedAt ? NEVER_AGAIN : now },
    })
    if (moved.count !== 1) return false
    await tx.onlineOrderCardRefundReversal.create({
      data: {
        venueId: row.venueId,
        cardRefundId: row.id,
        stripeRefundId: row.stripeRefundId!,
        amountCents: row.amountCents,
        feeCents: row.feeRefundedCents ?? 0,
        failureReason: s.failureReason,
        detectedAt: now,
      },
    })
    const [original] = await tx.$queryRaw<Array<{ id: string; processorData: Prisma.JsonValue }>>`
      SELECT id, "processorData" FROM "Payment"
      WHERE "venueId" = ${row.venueId} AND "orderId" = ${s.orderId} AND "processorId" = ${s.paymentIntentId}
        AND type = CAST(${PaymentType.REGULAR} AS "PaymentType")
      FOR UPDATE`
    if (original) {
      const data = (
        original.processorData && typeof original.processorData === 'object' && !Array.isArray(original.processorData)
          ? original.processorData
          : {}
      ) as Record<string, unknown>
      const previas = Array.isArray(data.refundReversals) ? data.refundReversals : []
      await tx.payment.update({
        where: { id: original.id },
        data: {
          processorData: {
            ...data,
            refundReversals: [
              ...previas,
              {
                cardRefundId: row.id,
                refundPaymentId: row.refundPaymentId,
                stripeRefundId: row.stripeRefundId,
                amountCents: row.amountCents,
                amount: row.amountCents / 100,
                failureReason: s.failureReason,
                at: now.toISOString(),
              },
            ],
          } as Prisma.InputJsonValue,
        },
      })
    }
    await tx.moneyAnomaly.createMany({
      data: [
        {
          category: 'ONLINE_ORDER_CARD_REFUND_REVERSED',
          stripeEventId: `oocr:REVERSED:${row.stripeRefundId}`,
          expectedState: { venueId: row.venueId, orderId: s.orderId, cardRefundId: row.id, refundPaymentId: row.refundPaymentId },
          observedState: { stripeRefundId: row.stripeRefundId, amount, failureReason: s.failureReason },
        },
      ],
      skipDuplicates: true,
    })
    return true
  }, ORDER_LOCK_WAIT_BUDGET)
  cur.row = (await load(row.id))!
  if (!won) return
  logger.error('🚨 [OnlineOrderCardRefund] la devolución a la tarjeta falló después de anotarla: hay que devolver por otro medio', {
    cardRefundId: row.id,
    venueId: row.venueId,
    orderId: s.orderId,
    amount,
  })
  void logAction({
    staffId: row.staffId,
    venueId: row.venueId,
    action: 'ONLINE_ORDER_CARD_REFUND_REVERSED',
    entity: 'OnlineOrderCardRefund',
    entityId: row.id,
    data: {
      orderId: s.orderId,
      amount,
      stripeRefundId: row.stripeRefundId,
      refundPaymentId: row.refundPaymentId,
      failureReason: s.failureReason,
    },
  })
  void sendVenueNotification(
    row.venueId,
    {
      type: 'PAYMENT_FAILED',
      title: 'Falló una devolución a tarjeta',
      message: `La devolución de $${amount} a la tarjeta del cliente falló en el banco. El dinero regresó a tu cuenta de Stripe. Devuélvelo por otro medio.`,
      entityType: 'OnlineOrderCardRefund',
      entityId: row.id,
      priority: 'HIGH',
      metadata: { orderId: s.orderId, cardRefundId: row.id },
    },
    ['OWNER', 'ADMIN', 'MANAGER'],
  ).catch(error => logger.error('[OnlineOrderCardRefund] no se pudo avisar al negocio', { cardRefundId: row.id, error: errorText(error) }))
}

/**
 * El ÚNICO paso que habla con Stripe (la petición, el aviso de Stripe y el recorrido). Nunca con una transacción abierta. Cualquier
 * error no cambia el estado financiero: anota `lastError`, mueve `nextCheckAt` (r5 #4) y se re-lanza.
 */
async function advance(id: string, now: Date): Promise<{ status: R; alerted: boolean }> {
  const row = await load(id)
  if (!row) throw new NotFoundError('Devolución no encontrada')
  const cur: Cur = { row, alerted: false }
  try {
    switch (cur.row.status) {
      case R.REQUESTED:
        await send(cur, now)
        break
      case R.SENDING:
        await findSent(cur, now)
        break
      case R.PENDING:
        await poll(cur, now)
        break
      case R.SUCCEEDED:
        break
      case R.RECORDED:
        // Fix r1 M2: la revisión tardía PRIMERO; un sello que falla siempre nunca tapa la detección de un fallo de Stripe.
        await reviewLate(cur, now)
        break
      case R.REVERSED:
      case R.RESOLVED:
        if (cur.row.stampReversedAt) return { status: cur.row.status, alerted: false }
        break // sólo queda la reversa del sello
      default:
        return { status: cur.row.status, alerted: false } // FAILED, CANCELED: ya terminó
    }
    if (cur.row.status === R.SUCCEEDED) await record(cur, now)
    if (WITH_LEDGER.includes(cur.row.status) && !cur.row.stampReversedAt) await reverseStamp(cur, now)
    return { status: cur.row.status, alerted: cur.alerted }
  } catch (error) {
    const lastError = errorText(error)
    const nextCheckAt = nextCheckAfterError(cur.row, now)
    await prisma.onlineOrderCardRefund
      .updateMany({ where: { id: cur.row.id, status: cur.row.status }, data: { lastError, nextCheckAt } })
      .catch(() => undefined)
    cur.row = { ...cur.row, lastError }
    await maybeAlertStuck(cur, now, lastError).catch(() => undefined)
    if (nextCheckAt === NEVER_AGAIN && WITH_LEDGER.includes(cur.row.status) && !cur.row.stampReversedAt) {
      await alertStampGivenUp(cur, lastError).catch(() => undefined)
    }
    throw error
  }
}

/**
 * M4: la reversa del sello de la venta devuelta falló todos los días hasta el final de la revisión (30 días + margen): ya no se
 * reintenta. `MoneyAnomaly`, 🚨 y bitácora UNA vez para que alguien quite el sello a mano.
 */
async function alertStampGivenUp(cur: Cur, why: string): Promise<void> {
  const { row } = cur
  // La anomalía (llave única por devolución) es la marca de «una sola vez», también con dos ejecutores a la vez.
  const inserted = await prisma.moneyAnomaly.createMany({
    data: [
      {
        category: 'ONLINE_ORDER_CARD_REFUND_STAMP_STUCK',
        stripeEventId: `oocr:STAMP_STUCK:${row.id}`,
        expectedState: { venueId: row.venueId, cardRefundId: row.id, stampReversed: true },
        observedState: { status: row.status, stampReversedAt: null, why },
      },
    ],
    skipDuplicates: true,
  })
  if (inserted.count === 0) return
  logger.error('🚨 [OnlineOrderCardRefund] la reversa del sello de una venta devuelta no se pudo hacer: quítalo a mano', {
    cardRefundId: row.id,
    venueId: row.venueId,
    status: row.status,
    why,
  })
  await logAction({
    staffId: row.staffId,
    venueId: row.venueId,
    action: 'ONLINE_ORDER_CARD_REFUND_STAMP_STUCK',
    entity: 'OnlineOrderCardRefund',
    entityId: row.id,
    data: { status: row.status, why, amount: pesos(row.amountCents) },
  })
}

export async function advanceCardRefund(id: string, now: Date = new Date()): Promise<R> {
  return (await advance(id, now)).status
}

/** Para el recorrido: además del estado, si esta pasada levantó la alerta. */
export async function advanceCardRefundForSweep(id: string, now: Date) {
  return advance(id, now)
}

export type CardRefundOutcome = 'RECORDED' | 'PENDING' | 'FAILED' | 'UNKNOWN'
const OUTCOME_OF: Record<R, CardRefundOutcome> = {
  REQUESTED: 'UNKNOWN',
  SENDING: 'UNKNOWN',
  SUCCEEDED: 'UNKNOWN',
  PENDING: 'PENDING',
  RECORDED: 'RECORDED',
  REVERSED: 'RECORDED',
  RESOLVED: 'RECORDED',
  FAILED: 'FAILED',
  CANCELED: 'FAILED',
}

/**
 * Devolver a la tarjeta, bajo el candado de la orden: 1) la repetición primero (misma llave del cliente en este cargo; otra
 * solicitud con la misma llave → 409, sin avanzar nada); 2) otra devolución en curso del cargo → 409; 3) cargo `CAPTURED` y el
 * importe cabe en lo que queda por devolver del cobro de Stripe según el cálculo de siempre (cuenta todo REFUND del libro, también
 * un «Cambio» con saldo a favor) menos lo reservado por las filas sin renglón (ruling 2); 4) la fila `REQUESTED`. Commit y DESPUÉS
 * avanza (r4 #5). Si avanzar truena, la fila queda para el recorrido y se contesta `UNKNOWN`.
 */
export async function refundCardOnlineOrder(i: {
  venueId: string
  orderId: string
  amount: Prisma.Decimal
  reason: RefundReason
  staffId: string
  idempotencyKey: string
  note?: string | null
}): Promise<{
  status: CardRefundOutcome
  cardRefundStatus: R
  cardRefundId: string
  refundId: string | null
  replay: boolean
}> {
  if (!KEY_PATTERN.test(i.idempotencyKey)) {
    throw new BadRequestError('La llave de idempotencia debe tener de 8 a 64 caracteres alfanuméricos, guiones o guiones bajos')
  }
  if (!(CARD_REFUND_REASONS as readonly string[]).includes(i.reason)) throw new BadRequestError('Motivo inválido')
  const amount = new Prisma.Decimal(i.amount)
  if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) {
    throw new BadRequestError('El monto a devolver debe ser mayor que cero, en pesos con hasta dos decimales')
  }
  const amountCents = toStripeAmount(amount)
  const note = i.note?.trim() || null
  const requestHash = operationHash({ amountCents, reason: i.reason, note })

  const decided = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: i.venueId, orderId: i.orderId }))) {
      throw new NotFoundError('Pedido no encontrado')
    }
    const online = await tx.onlineOrder.findFirst({
      where: { orderId: i.orderId, venueId: i.venueId },
      select: { paymentMode: true, charge: true },
    })
    const charge = online?.paymentMode === OnlineOrderPaymentMode.CARD_ONLINE ? online.charge : null
    if (!charge) throw new BadRequestError('Este pedido no se pagó con tarjeta en línea.', 'NOT_A_CARD_ONLINE_ORDER')

    const previa = await tx.onlineOrderCardRefund.findUnique({
      where: { chargeId_key: { chargeId: charge.id, key: i.idempotencyKey } },
    })
    if (previa) {
      if (previa.requestHash !== requestHash) {
        throw new ConflictError('La llave de idempotencia ya pertenece a otra devolución', 'IDEMPOTENCY_KEY_REUSED')
      }
      return { id: previa.id, replay: true }
    }
    const enCurso = await tx.onlineOrderCardRefund.findFirst({
      where: { chargeId: charge.id, status: { in: NO_LEDGER_YET } },
      select: { id: true },
    })
    if (enCurso) {
      throw new ConflictError('Ya hay una devolución en curso de este pedido; espera a que termine.', 'CARD_REFUND_IN_PROGRESS')
    }
    if (charge.status !== OnlineOrderChargeStatus.CAPTURED || !charge.paymentIntentId) {
      throw new BadRequestError('Este pedido todavía no se cobró con tarjeta; no hay nada que devolver.', 'CARD_NOT_CAPTURED')
    }
    const payment = await tx.payment.findFirst({
      where: { venueId: i.venueId, orderId: i.orderId, processorId: charge.paymentIntentId, type: PaymentType.REGULAR },
      select: { id: true },
    })
    if (!payment) throw new ConflictError('No se encontró el cobro de la tarjeta de este pedido.', 'CARD_PAYMENT_NOT_FOUND')
    // Ruling 2 + fix r1: lo que queda por devolver del cobro de Stripe YA descuenta todo REFUND del libro (también un «Cambio») y
    // lo apartado por devoluciones a la tarjeta sin renglón todavía: el candado compartido lo calcula para todos los caminos.
    const cobro = await bloquearCobroParaReembolso(tx, { venueId: i.venueId, paymentId: payment.id, expectedOrderId: i.orderId })
    const disponible = cobro.remainingBeforeCents
    if (amountCents > disponible) {
      throw new BadRequestError(
        `No se puede devolver $${pesos(amountCents)}: de este pedido sólo quedan $${pesos(Math.max(0, disponible))} por devolver.`,
        'CARD_REFUND_EXCEEDS_REMAINING',
      )
    }
    const row = await tx.onlineOrderCardRefund.create({
      data: {
        venueId: i.venueId,
        chargeId: charge.id,
        key: i.idempotencyKey,
        amountCents,
        reason: i.reason,
        staffId: i.staffId,
        note,
        requestHash,
      },
      select: { id: true },
    })
    return { id: row.id, replay: false }
  }, ORDER_LOCK_WAIT_BUDGET)

  try {
    await advanceCardRefund(decided.id)
  } catch (error) {
    logger.warn('⚠️ [OnlineOrderCardRefund] la devolución quedó en duda; el recorrido la termina', {
      cardRefundId: decided.id,
      error: errorText(error),
    })
  }
  const row = (await load(decided.id))!
  return {
    status: OUTCOME_OF[row.status],
    cardRefundStatus: row.status,
    cardRefundId: row.id,
    refundId: row.refundPaymentId,
    replay: decided.replay,
  }
}

/**
 * «Devolver por otro medio» (decisión del founder «a»): sólo una devolución `REVERSED` con su reversa sin resolver; repetir es
 * idempotente por `cardRefundId`. En efectivo, la salida de caja va en la MISMA transacción (r5 #2): sin caja abierta, 409 y no se
 * resuelve nada. El REFUND de Stripe no se toca. Ningún otro camino devuelve en efectivo un cobro de tarjeta.
 */
export async function resolveReversedCardRefund(i: {
  venueId: string
  orderId: string
  cardRefundId: string
  method: 'CASH' | 'BANK_TRANSFER'
  staffId: string
  note?: string | null
}): Promise<{ status: 'RESOLVED'; replay: boolean }> {
  if (i.method !== 'CASH' && i.method !== 'BANK_TRANSFER') throw new BadRequestError('El método debe ser CASH o BANK_TRANSFER')
  const note = i.note?.trim() || null
  const now = new Date()
  const out = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: i.venueId, orderId: i.orderId }))) {
      throw new NotFoundError('Pedido no encontrado')
    }
    const row = await tx.onlineOrderCardRefund.findFirst({
      where: { id: i.cardRefundId, venueId: i.venueId, charge: { onlineOrder: { orderId: i.orderId } } },
    })
    if (!row) throw new NotFoundError('Devolución no encontrada')
    if (row.status === R.RESOLVED) return { replay: true, row }
    const reversa = await tx.onlineOrderCardRefundReversal.findUnique({ where: { cardRefundId: row.id } })
    if (row.status !== R.REVERSED || !reversa || reversa.resolvedAt) {
      throw new ConflictError('Esta devolución no está pendiente de pagarse por otro medio.', 'CARD_REFUND_NOT_REVERSED')
    }
    const cashDrawerEventId =
      i.method === 'CASH'
        ? await postPayOutInTx(tx, {
            venueId: i.venueId,
            amount: fromStripeAmount(row.amountCents),
            reason: PAYOUT_REASON,
            idempotencyKey: `oocr-payout:${row.id}`,
            staffId: i.staffId,
            orderId: i.orderId,
          })
        : null
    const moved = await tx.onlineOrderCardRefund.updateMany({ where: { id: row.id, status: R.REVERSED }, data: { status: R.RESOLVED } })
    const resolved = await tx.onlineOrderCardRefundReversal.updateMany({
      where: { cardRefundId: row.id, resolvedAt: null },
      data: { resolvedMethod: i.method, resolvedByStaffId: i.staffId, resolvedAt: now, resolvedNote: note, cashDrawerEventId },
    })
    // Bajo el candado de la orden nadie más resuelve; si aun así cambió, se revierte todo (también la salida de caja).
    if (moved.count !== 1 || resolved.count !== 1)
      throw new ConflictError('La devolución cambió mientras se resolvía.', 'CARD_REFUND_CHANGED')
    return { replay: false, row, cashDrawerEventId }
  }, ORDER_LOCK_WAIT_BUDGET)

  if (!out.replay) {
    void logAction({
      staffId: i.staffId,
      venueId: i.venueId,
      action: 'ONLINE_ORDER_CARD_REFUND_RESOLVED',
      entity: 'OnlineOrderCardRefund',
      entityId: i.cardRefundId,
      data: {
        orderId: i.orderId,
        method: i.method,
        amount: pesos(out.row.amountCents),
        note,
        cashDrawerEventId: 'cashDrawerEventId' in out ? out.cashDrawerEventId : null,
      },
    })
  }
  return { status: 'RESOLVED', replay: out.replay }
}

/** Las devoluciones a la tarjeta de un pedido (para el panel y el MCP), la más reciente primero; un pedido real trae un puñado. */
export async function listCardRefunds(venueId: string, orderId: string) {
  const rows = await prisma.onlineOrderCardRefund.findMany({
    where: { venueId, charge: { onlineOrder: { orderId } } },
    include: { reversal: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  })
  return rows.map(r => ({
    id: r.id,
    /** La llave con la que nació: el panel concilia EXACTO su intento pendiente, nunca por monto ni fecha. */
    key: r.key,
    status: r.status,
    amount: pesos(r.amountCents),
    reason: r.reason,
    note: r.note,
    stripeRefundId: r.stripeRefundId,
    refundPaymentId: r.refundPaymentId,
    feeRefunded: r.feeRefundedCents == null ? null : pesos(r.feeRefundedCents),
    createdAt: r.createdAt.toISOString(),
    /** Sólo con `REVERSED`/`RESOLVED`: el panel ofrece «Devolver por otro medio» mientras `resolvedAt` sea null. */
    reversal: r.reversal
      ? {
          failureReason: r.reversal.failureReason,
          detectedAt: r.reversal.detectedAt.toISOString(),
          resolvedMethod: r.reversal.resolvedMethod,
          resolvedAt: r.reversal.resolvedAt?.toISOString() ?? null,
          resolvedNote: r.reversal.resolvedNote,
        }
      : null,
  }))
}

/**
 * Aviso del endpoint Connect (`refund.created|updated|failed`). Nunca se confía en su contenido: con nuestra metadata sólo dispara
 * `advanceCardRefund` (que relee Stripe). Sin ella, si el PaymentIntent es de un cargo de pedido en línea y la devolución no es
 * nuestra, se hizo a mano en el Stripe del negocio: `MoneyAnomaly` y 🚨, sin escribir dinero.
 */
export async function handleStripeRefundEvent(event: VerifiedWebhookEvent): Promise<void> {
  const refund = (event.data ?? {}) as {
    id?: string
    amount?: number
    status?: string
    payment_intent?: string | { id?: string } | null
    metadata?: Record<string, string> | null
  }
  if (!refund.id) return
  if (refund.metadata?.type === 'online_order_refund') {
    const id = refund.metadata.cardRefundId
    const row = id
      ? await prisma.onlineOrderCardRefund.findUnique({
          where: { id },
          select: { id: true, charge: { select: { id: true, venueId: true, merchantSnapshot: true } } },
        })
      : null
    if (!row) {
      logger.warn('⚠️ [OnlineOrderCardRefund] aviso de una devolución que no está aquí', { eventId: event.id, refundId: refund.id, id })
      return
    }
    // Codex r1 C2: de otra cuenta o de otro modo no se avanza nada; `advanceCardRefund` relee Stripe con los ids de la FILA.
    if (await isForeignStripeEvent(event, row.charge)) return
    await advanceCardRefund(row.id)
    return
  }
  const paymentIntentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent?.id ?? null)
  if (!paymentIntentId) return
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { paymentIntentId },
    select: { id: true, venueId: true, onlineOrderId: true, merchantSnapshot: true },
  })
  if (!charge) return
  if (await isForeignStripeEvent(event, charge)) return
  const ours = await prisma.onlineOrderCardRefund.findUnique({ where: { stripeRefundId: refund.id }, select: { id: true } })
  if (ours) return
  const inserted = await prisma.moneyAnomaly.createMany({
    data: [
      {
        category: 'ONLINE_ORDER_REFUND_OUTSIDE_AVOQADO',
        stripeEventId: `oocr:OUTSIDE:${refund.id}`,
        expectedState: { venueId: charge.venueId, chargeId: charge.id, onlineOrderId: charge.onlineOrderId },
        observedState: {
          refundId: refund.id,
          paymentIntentId,
          amount: typeof refund.amount === 'number' ? pesos(refund.amount) : null,
          status: refund.status ?? null,
          eventType: event.type,
        },
      },
    ],
    skipDuplicates: true,
  })
  if (inserted.count > 0) {
    logger.error('🚨 [OnlineOrderCardRefund] devolución hecha fuera de Avoqado sobre un pedido en línea', {
      venueId: charge.venueId,
      chargeId: charge.id,
      refundId: refund.id,
    })
  }
}
